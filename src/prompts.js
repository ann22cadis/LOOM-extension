/**
 * Сборка промптов LOOM.
 *
 * ВСЕ ИНСТРУКЦИИ — НА АНГЛИЙСКОМ. Это не стилистика, а деньги: кириллица токенизируется
 * в разы дороже латиницы, а промпт уходит в каждый запрос. Язык РЕЗУЛЬТАТА задаётся
 * отдельно (настройка «Язык результата») и по умолчанию русский — карточки пишутся
 * на русском, инструкции к ним нет.
 *
 * Промпты строятся из ФОРМАТА карточки (настройки → Форматы), а не из захардкоженного
 * текста: пользователь добавляет пункт в настройках — и он сразу появляется и в промпте,
 * и в контракте JSON, и в разметке черновика.
 */

import {
    getSettings, activeFormat, LOREBOOK_CATEGORIES, DEFAULT_PROMPT_KEYS, DEFAULT_PROMPT_PLOT, DEFAULT_PROMPT_PLOT_PACING,
} from './settings.js';
import { getDraft } from './drafts.js';
import { getStartReplyWith } from './api.js';

/**
 * Общая шапка: язык результата, стиль, запрет на болтовню вокруг JSON.
 *
 * @param {{ language?: string, includeStyle?: boolean }} [options]
 *   language — переопределить язык результата (режим промпта всегда пишет по-английски);
 *   includeStyle — подмешивать ли «Правила письма». Они про художественный текст
 *     («каждый абзац добавляет факт, пригодный в сцене») и режиму промпта только
 *     вредят: там пишется инструкция модели, а не проза.
 */
function commonRules({ language = null, includeStyle = true } = {}) {
    const settings = getSettings();
    const lang = String(language || '').trim() || settings.output_language || 'русский';
    const isEnglish = /^english$/i.test(lang);
    return [
        `OUTPUT LANGUAGE: ${lang}. Every string inside the JSON must be written in that language`
            + (isEnglish
                ? ', even if the user\'s brief, notes or comments are written in another language.'
                : '. These instructions are in English; do not answer in English because of that.'),
        includeStyle ? String(settings.style_prompt || '').trim() : '',
        'RESPONSE FORMAT: valid JSON only. No text before or after it, no ``` fences, no comments.',
    ].filter(Boolean).join('\n\n');
}

const THINKING_PLAN_KEY_BY_KIND = {
    character: 'thinking_plan_character',
    lorebook: 'thinking_plan_lorebook',
    persona: 'thinking_plan_persona',
    prompt: 'thinking_plan_prompt',
    scenario: 'thinking_plan_scenario',
    // У «Пресета» нет своей думалки — каждый его блок пишется в том же ключе, что
    // и «Промпт» (ситуативная инструкция моделью), поэтому делит с ним и план разбора,
    // а не заводит для него ещё одну одинаковую по сути настройку.
    preset: 'thinking_plan_prompt',
    // «Анализ» — не про то, что писать, а про то, что происходит в чужом пресете,
    // так что своя думалка: суть/подозреваемые/вердикт/фикс, а не жанр/провалы/рычаги.
    analysis: 'thinking_plan_analysis',
};

/**
 * Думалка: план разбора, который модель проговаривает ДО JSON.
 *
 * Зачем отдельно от reasoning_effort: у моделей без нативных размышлений его нет вовсе,
 * а через прокси Таверна не передаёт наверх ни reasoning_effort, ни include_reasoning —
 * текст в промпте работает везде. Блок в теге размышлений, поэтому stripReasoningBlocks
 * снимает его до разбора JSON.
 *
 * ТРЕБУЕТ преднаполнения ответа (start_reply_with/«Начинать ответ с» в Таверне) —
 * тот же принцип, что в родственном расширении NOVA (тот же автор, тот же
 * stripReasoningBlocks/getStartReplyWith в api.js). Без преднаполнения инструкция
 * просила модель «сама открой тег, которым думалка уже размечена как пример» — тег
 * нигде явно не назывался, и получалось «закрой блок, который ты не открывала»:
 * либо думалка молча игнорировалась, либо модель оборачивала её во что попало и
 * это ломало разбор JSON. С преднаполнением ответ ФИЗИЧЕСКИ начинается с открывающего
 * тега (Таверна подставляет его как последнее assistant-сообщение) — модели больше
 * нечего угадывать, она просто продолжает то, что уже открыто.
 *
 * @param {'character'|'lorebook'|'persona'|'prompt'} kind
 * @returns {string} пустая строка, если думалка выключена, план пуст или преднаполнение не настроено
 */
export function thinkingPlan(kind) {
    const settings = getSettings();
    if (settings.thinking_plan_enabled === false) return '';
    if (!getStartReplyWith()) return '';

    // Карта, а не цепочка тернарников: с ней новый режим либо находит свой план,
    // либо честно падает в undefined ниже, а не подсовывает молча план персонажа
    const key = THINKING_PLAN_KEY_BY_KIND[kind] || 'thinking_plan_character';
    const plan = String(settings[key] || '').trim();
    if (!plan) return '';

    const suffix = String(settings.reasoning_suffix || '</thinking>').trim();

    return [
        // «Start your reply with» здесь не нужно — преднаполнение УЖЕ начало ответ
        // открывающим тегом, модель продолжает его, а не пишет заново.
        `CONTINUE the reasoning block you already opened. Work through the points below inside it, then close `
            + `it with ${suffix} and output the JSON right after — nothing between the closing tag and the JSON. `
            + 'The block is discarded before parsing, so it never reaches the user.',
        plan,
    ].join('\n\n');
}

/**
 * Блок про приложенные картинки.
 *
 * Сами картинки уходят отдельными частями сообщения (см. buildUserContent в api.js),
 * но модели надо сказать, ЧТО это и как с этим быть: без указания она либо пересказывает
 * картинку целиком, либо игнорирует её и выдумывает внешность заново.
 *
 * @param {Array<{note?: string, name?: string}>} refs
 */
export function imageNote(refs) {
    const list = (refs || []).filter(Boolean);
    if (!list.length) return '';

    const lines = list.map((ref, i) => {
        const note = String(ref.note || '').trim();
        return `${i + 1}. ${note || '(no comment from the user)'}`;
    });

    return [
        `REFERENCE IMAGES: the user attached ${list.length} image(s), in this order:`,
        lines.join('\n'),
        'They are the source of truth for looks and concrete details: take hair, clothes, objects, '
            + 'architecture and colours from what you actually see. Do not invent details that contradict them, '
            + 'and do not describe the image as an image ("in the picture", "the artwork shows").',
    ].join('\n');
}

/**
 * Персонаж, привязанный к лорбуку.
 *
 * Без этого блока модель в каждой записи придумывает героя заново: путает возраст,
 * характер, а то и имя целиком. Раньше сюда шёл только один абзац из двух пунктов
 * (внешность, характер) — для карточки с десятком пунктов формата (профессия, семья,
 * предыстория, окружение, связи) это было настолько тонким срезом, что модель просто
 * не видела большую часть фактов и лорбук расходился с карточкой. Теперь — весь текст
 * всех пунктов формата, КРОМЕ сцены (сценарий/первое сообщение — это завязка ролплея,
 * а не факты о персонаже: тащить её в лорбук незачем и может сбить с толку).
 *
 * Привязанных персонажей может быть несколько — тогда каждый описан отдельным блоком.
 *
 * @param {string[]|string|null} characterIds id черновиков персонажей (draft.characterIds)
 * @param {{purpose?: string}} [options] purpose — что именно пишется для этих персонажей
 *   (лорбук, сценарий, …), подставляется в первую строку блока. По умолчанию — лорбук,
 *   единственный вызывающий код на момент, когда у функции появился этот параметр.
 * @returns {string} пустая строка, если никто не привязан или все уже удалены
 */
export function linkedCharacterContext(characterIds, { purpose = 'this lorebook' } = {}) {
    const characters = linkedCharacters(characterIds);
    if (!characters.length) return '';

    const format = activeFormat('character');
    const sceneIds = new Set(format.filter(item => item.scene).map(item => item.id));
    const labelById = new Map(format.map(item => [item.id, item.label]));

    const describe = character => {
        const lines = [`Name: ${character.name || '(unnamed)'}`];
        const brief = String(character.brief || '').trim();
        if (brief) lines.push(`Premise: ${brief}`);

        for (const section of character.sections || []) {
            if (sceneIds.has(section.id) || !section.blocks?.length) continue;
            const label = labelById.get(section.id) || section.label || section.id;
            lines.push(`${label}: ${section.blocks.map(b => b.text).join(' ')}`);
        }
        return lines.join('\n');
    };

    if (characters.length === 1) {
        return [
            `LINKED CHARACTER: ${purpose} is written for the roleplay character below. Stay consistent with these `
                + 'facts - do not contradict them, and do not invent a different version of this character. Use '
                + 'their exact name and spelling everywhere they are mentioned.',
            describe(characters[0]),
        ].join('\n');
    }

    return [
        `LINKED CHARACTERS: ${purpose} is written for the roleplay characters below. Stay consistent with the `
            + 'facts about each of them - do not contradict them, do not mix one character up with another, and do '
            + 'not invent a different version of anyone. Use their exact names and spelling everywhere they are '
            + 'mentioned.',
        characters.map(describe).join('\n\n'),
    ].join('\n');
}

/** Черновики привязанных персонажей: id может быть одним, списком или пустым; удалённые пропускаются. */
function linkedCharacters(characterIds) {
    const ids = Array.isArray(characterIds) ? characterIds : (characterIds ? [characterIds] : []);
    return ids.map(id => getDraft(id)).filter(character => character?.mode === 'character');
}

/**
 * Персона ({{user}}), привязанная к лорбуку — тот же принцип, что и linkedCharacterContext,
 * но у формата персоны нет пункта со сценой (см. DEFAULT_PERSONA_FORMAT) — фильтровать
 * нечего, идёт весь текст.
 *
 * @param {string|null} personaId id черновика персоны (draft.personaId)
 * @param {{purpose?: string}} [options] см. linkedCharacterContext — здесь не используется
 *   в тексте (формулировка про {{user}} общая для любого purpose), но параметр сохранён
 *   для единообразия вызовов оттуда, где привязаны и персонаж, и персона разом.
 * @returns {string} пустая строка, если персона не привязана или уже удалена
 */
export function linkedPersonaContext(personaId) {
    if (!personaId) return '';
    const persona = getDraft(personaId);
    if (!persona || persona.mode !== 'persona') return '';

    const labelById = new Map(activeFormat('persona').map(item => [item.id, item.label]));
    const lines = [`Name: ${persona.name || '(unnamed)'}`];
    const brief = String(persona.brief || '').trim();
    if (brief) lines.push(`Premise: ${brief}`);

    for (const section of persona.sections || []) {
        if (!section.blocks?.length) continue;
        const label = labelById.get(section.id) || section.label || section.id;
        lines.push(`${label}: ${section.blocks.map(b => b.text).join(' ')}`);
    }

    return [
        'LINKED PERSONA: {{user}} in this roleplay plays the persona below. Stay consistent with these facts '
            + 'about them too - do not contradict them, and use their exact name and spelling everywhere '
            + 'they are mentioned.',
        lines.join('\n'),
    ].join('\n');
}

/**
 * Запрет на ключи, совпадающие с именем говорящего.
 *
 * Таверна ищет ключи не в голом тексте: при включённом «Always add character's name
 * to prompt» (world_info_include_names, включено по умолчанию) каждое сообщение
 * в буфере поиска выглядит как «Имя: текст» — см. chatForWI в script.js. Поэтому ключ,
 * совпадающий с именем персонажа или {{user}}, срабатывает от одной подписи, в КАЖДОМ
 * сообщении: запись превращается в постоянную и молча ест бюджет лорбука. То же
 * отмечает и World Info Encyclopedia в разделе про вторичные ключи.
 *
 * Имена подставляются в промпт буквально: обобщённое «не бери имя героя» модель
 * трактует вольно, а список конкретных строк — нет.
 *
 * @returns {string} пустая строка, если ничего не привязано — запрещать нечего
 */
/**
 * Имена, которые Таверна подставляет перед каждым сообщением («Энн Кадис: …»): привязанные
 * персонаж и персона LOOM плюс активная персона самой Таверны — её имя стоит в каждом
 * сообщении пользователя, в каком бы чате ни работал лорбук.
 * @returns {string[]}
 */
export function speakerNames(characterIds, personaId) {
    const names = [];
    const persona = personaId ? getDraft(personaId) : null;
    for (const character of linkedCharacters(characterIds)) {
        if (String(character.name || '').trim()) names.push(character.name.trim());
    }
    if (persona?.mode === 'persona' && String(persona.name || '').trim()) names.push(persona.name.trim());
    const activePersona = String(SillyTavern.getContext()?.name1 || '').trim();
    if (activePersona && activePersona !== 'User') names.push(activePersona);
    return [...new Set(names)];
}

function speakerNameRule(characterIds, personaId) {
    const names = speakerNames(characterIds, personaId);
    if (!names.length) return '';

    return `NEVER use these names, or their short forms, as a key: ${names.map(n => `"${n}"`).join(', ')}. `
        + 'Every message is prefixed with the speaker name before keys are searched, so such a key matches on '
        + 'EVERY message and turns the entry into a permanent one that quietly eats the lorebook budget. '
        + 'An entry about them is keyed by what is being discussed - a place, an object, an event, another '
        + 'person - not by their own name.';
}

/** Собирает промпт, добавляя думалку последней: инструкции в конце модель выполняет охотнее. */
function withPlan(parts, kind) {
    const plan = thinkingPlan(kind);
    return (plan ? [...parts, '', plan] : parts).join('\n');
}

/**
 * Контракт JSON по формату: список пунктов с подсказками.
 * Каждый пункт модель отдаёт как МАССИВ АБЗАЦЕВ — именно абзац является единицей,
 * которую пользователь потом оценивает, поэтому разбивку делает модель, а не regex.
 *
 * Подпись пункта (label) в промпт не идёт: она нужна интерфейсу и написана по-русски,
 * а модели хватает англоязычного id и подсказки.
 *
 * @param {'character'|'lorebook'} kind
 * @param {Array} [items] явный список пунктов формата (частичное переписывание);
 *   по умолчанию — все активные пункты (activeFormat(kind))
 * @param {string} [splitRuleOverride] заменяет вычисляемое ниже правило разбивки на
 *   абзацы — нужно записи лорбука с целевым числом слов (см. lorebookLengthRule):
 *   там правило не «3-5 абзацев», а «уложись в N слов суммарно»
 */
function formatContract(kind, items = null, splitRuleOverride = null) {
    const list = items || activeFormat(kind);
    const lines = list.map(item => `  "${item.id}": array of paragraphs. ${item.hint || ''}`.trimEnd());
    // Пункты сцены (scenario/first_mes) — цельная реплика или сцена, дробить их на 3-5
    // абзацев значит просто раздуть их водой. Обычные пункты карточки, наоборот,
    // описывают широкую тему (внешность, характер) — там 3-5 абзацев это НОРМА,
    // а не потолок, и именно на это жаловались: модель писала по одному абзацу
    // на пункт вместо разбивки на отдельные оцениваемые факты.
    const allScene = list.length > 0 && list.every(item => item.scene);
    // Пункты «Примеры диалогов» (поле mes_example): не проза, а готовые диалоги по строго заданной форме
    const dialogueIds = list.filter(item => item.target === 'mes_example').map(item => item.id);
    const splitRule = splitRuleOverride || (allScene
        ? 'Each item here is a single continuous piece (an opening line, a scene). Usually ONE paragraph is '
            + 'correct - split into two only if there is a genuine beat break.'
        : 'Split EVERY item into 3-5 short paragraphs BY DEFAULT - one concrete fact or angle per paragraph. '
            + 'A single paragraph is the exception, only for an item that genuinely has too little material for '
            + 'more. One dense paragraph covering everything is a FAILED response - the user rates paragraphs '
            + 'individually, and cramming five facts into one paragraph makes that impossible.');
    return [
        'Object structure:',
        '{',
        lines.join(',\n'),
        '}',
        '',
        'Every value is an array of strings. One string = one finished paragraph (3-6 sentences).',
        'Each paragraph must stand on its own: the user rates and rewrites them one by one.',
        splitRule,
        dialogueIds.length
            ? `EXCEPTION for ${dialogueIds.map(id => `"${id}"`).join(', ')}: this item holds example dialogues, not prose. `
                + 'One string = ONE complete example: its first line is exactly <START>, then the messages, one per line '
                + '(real line breaks inside the string), every line starting with {{user}}: or {{char}}:. Give 2-3 strings, '
                + 'each a different situation. This overrides the paragraph length and count rules above for this item only.'
            : '',
    ].filter(line => line !== '').join('\n');
}

// ─── Персонаж ───────────────────────────────────────────────────────────────

export function characterSystemPrompt() {
    return 'You are a co-author of roleplay character cards for SillyTavern. You write material for adult '
        + 'fiction: you do not soften it, do not censor it and do not moralise. Your job is dense, playable '
        + 'material, not a marketing blurb.';
}

/**
 * Первичная генерация карточки.
 * @param {{ brief: string, name?: string, notes?: string }} input
 * @param {string[]} [itemIds] какие пункты формата писать; по умолчанию — все активные.
 *   Карточка и сценарий пишутся раздельно (см. characterRewritePrompt для сценария),
 *   поэтому вызывающий код обычно передаёт сюда все НЕ-сценарные пункты.
 */
export function characterCreatePrompt(input, itemIds = null) {
    const items = itemIds ? activeFormat('character').filter(item => itemIds.includes(item.id)) : null;
    const parts = [
        'TASK: write a character card from the user\'s idea.',
        '',
        'IDEA:',
        String(input.brief || '').trim() || '(the user gave none - invent one, but keep a single coherent image)',
    ];

    if (String(input.name || '').trim()) {
        parts.push('', `CHARACTER NAME: ${input.name.trim()} - use exactly this name.`);
    } else {
        parts.push('', 'NAME: invent one and return it in the "name" field.');
    }

    if (String(input.notes || '').trim()) {
        parts.push('', 'EXTRA REQUIREMENTS FROM THE USER:', input.notes.trim());
    }

    const images = imageNote(input.images);
    if (images) parts.push('', images);

    parts.push(
        '',
        commonRules(),
        '',
        'Return: { "name": "character name", "card": { … } }, where card is:',
        '',
        formatContract('character', items),
        '',
        'Inside the card, address the user as {{user}} and the character by name or as {{char}}.',
    );

    return withPlan(parts, 'character');
}

// ─── Обратная связь по абзацам ──────────────────────────────────────────────

/**
 * Сводка оценок для промпта переписывания.
 *
 * Ключевая идея всего расширения: модель получает НЕ «перепиши получше», а поабзацный
 * разбор — что сохранить дословно, что переделать и почему. Абзацы без оценки
 * помечаются отдельно, иначе модель считает молчание одобрением и не трогает их вовсе.
 *
 * @param {Array<{id: string, label: string, blocks: Array<{text: string, rating: number, comment: string}>}>} sections
 */
export function feedbackDigest(sections) {
    const settings = getSettings();
    const keep = Number(settings.rating_keep_threshold) || 8;
    const rewrite = Number(settings.rating_rewrite_threshold) || 6;

    const lines = [];
    for (const section of sections) {
        for (let i = 0; i < section.blocks.length; i++) {
            const block = section.blocks[i];
            const rating = Number(block.rating) || 0;
            const comment = String(block.comment || '').trim();
            if (!rating && !comment) continue;

            let verdict;
            if (!rating) verdict = 'no score, but there is a note';
            else if (rating >= keep) verdict = `${rating}/10 - GOOD, keep its meaning and tone almost verbatim`;
            else if (rating >= rewrite) verdict = `${rating}/10 - acceptable, improve it without breaking it`;
            else verdict = `${rating}/10 - BAD, rewrite from scratch with a different angle`;

            lines.push([
                `- [${section.id} / paragraph ${i + 1}] ${verdict}`,
                `  Text: ${joinPromptFix(block)}`,
                comment ? `  User note: ${comment}` : null,
            ].filter(Boolean).join('\n'));
        }
    }

    if (!lines.length) return '';

    return [
        'USER RATINGS (scale 0-10, where 10 means "exactly right"):',
        lines.join('\n'),
        '',
        'HOW TO USE THEM:',
        `- Paragraphs rated ${keep} or higher are the benchmark. Keep their content and tone; rephrase only when a note asks for it.`,
        `- Paragraphs rated below ${rewrite} must be rewritten from scratch: same item, different angle, different details. Repeating a rejected move fails the task.`,
        '- A user note outranks the score. High score with a note still means: follow the note.',
        '- Infer from the high scores WHAT the user likes (tone, level of detail, type of detail) and carry that over to the rest.',
        '- Touch unrated paragraphs carefully: the user neither rejected nor confirmed them.',
        '- User notes may be in a different language than the output. Follow them as written; the output language does not change.',
    ].join('\n');
}

/**
 * Инструкция «как писать» для пунктов сцены (сценарий/первое сообщение) — из настроек
 * (Форматы → промпты под списком пунктов карточки). Подбирается по target пункта, а
 * не по id: пользователь может назвать пункты как угодно.
 * @param {Array<{id: string, target?: string}>} items
 * @returns {string} пустая строка, если среди пунктов нет сцены или промпт очищен
 */
function sceneWritingGuide(items) {
    const settings = getSettings();
    const byTarget = { scenario: settings.prompt_scenario_card, first_mes: settings.prompt_first_mes };
    return items
        .map(item => {
            const text = String(byTarget[item.target] || '').trim();
            return text ? `WRITING GUIDE for "${item.id}":\n${text}` : '';
        })
        .filter(Boolean)
        .join('\n\n');
}

/** Инструкция для варианта первого сообщения; запасной короткий текст, если промпт в настройках стёрт. */
function firstMessageGuide() {
    const text = String(getSettings().prompt_first_mes || '').trim();
    return text
        ? `WRITING GUIDE:\n${text}`
        : 'In character, *actions in italics*, addressed to {{user}}. Never describe {{user}}\'s actions.';
}

/**
 * Переписывание карточки с учётом оценок.
 *
 * @param {object} draft черновик целиком
 * @param {string[]} [itemIds] какие пункты реально переписываем (см. splitApprovedSections
 *   в drafts.js). Пункты вне этого списка уже одобрены пользователем (оценка ≥ порога
 *   «сохранить») — они всё равно видны модели в тексте текущей карточки и в оценках
 *   (для тона и калибровки), но не входят в контракт JSON, который модель обязана
 *   заполнить: просить её переписать то, что и так хорошо, — чистый расход токенов
 *   на ответе. По умолчанию (без itemIds) — старое поведение, переписывается всё.
 * @param {string} [extraNote] доп. идея именно для ЭТОГО запроса — например, для пункта
 *   сцены (сценарий/первое сообщение), который пишется отдельным шагом от общей
 *   «Задумки» и может нуждаться в своей, более конкретной завязке. См. draft.sceneBriefs
 *   в src/drafts.js и renderSceneItemBlock в index.js.
 */
export function characterRewritePrompt(draft, itemIds = null, extraNote = '') {
    const digest = feedbackDigest(draft.sections);
    const allItems = activeFormat('character');
    const items = itemIds ? allItems.filter(item => itemIds.includes(item.id)) : allItems;
    const hasSkipped = items.length < allItems.length;

    return withPlan([
        'TASK: rewrite the character card according to the user\'s ratings.',
        '',
        `CHARACTER NAME: ${draft.name || '(invent one)'}`,
        '',
        'ORIGINAL IDEA:',
        String(draft.brief || '').trim() || '(none given)',
        '',
        'CURRENT VERSION OF THE CARD:',
        renderDraftPlain(draft),
        '',
        digest || 'The user left no ratings - just improve the text without changing its substance.',
        '',
        String(extraNote || '').trim()
            ? `EXTRA IDEA FOR THIS STEP (follow it - it is more specific than the general idea above):\n${extraNote.trim()}`
            : '',
        '',
        sceneWritingGuide(items),
        '',
        imageNote(draft.images),
        '',
        commonRules(),
        '',
        hasSkipped
            ? 'SCOPE: some items above are NOT part of this response - either already approved by the user, or '
                + 'simply out of scope for this step. They are shown only as context, so what you write stays '
                + 'consistent with them. Do not include them in the JSON, do not summarise them, do not mention '
                + 'that you skipped them.'
            : '',
        '',
        'Return: { "name": "character name", "card": { … } }, where card contains ONLY these items:',
        '',
        formatContract('character', items),
        '',
        hasSkipped
            ? 'Return ONLY the items listed above - nothing else.'
            : 'Return the WHOLE card, including the items nobody complained about.',
    ], 'character');
}

/** Черновик в виде обычного текста — для показа модели её же предыдущей работы. */
export function renderDraftPlain(draft) {
    return draft.sections
        .map(section => `## ${section.id}\n` + section.blocks.map(b => b.text).join('\n\n'))
        .join('\n\n');
}

/**
 * Один «другой вариант первого сообщения» (alternate_greetings V2, draft.altGreetings
 * в src/drafts.js) — простая строка, не пункт формата, поэтому свой отдельный промпт,
 * а не formatContract: контракт ответа здесь ровно одно поле, без абзацев и оценок.
 *
 * @param {object} draft черновик персонажа целиком — контекст (карточка уже написана)
 * @param {string} [idea] идея именно для ЭТОГО варианта (draft.altGreetings[i].idea)
 * @param {string[]} [siblings] тексты уже существующих первых сообщений (основное +
 *   другие варианты), чтобы модель не повторила то, что уже написано
 */
export function alternateGreetingPrompt(draft, idea, siblings) {
    const parts = [
        'TASK: write ONE alternate opening line for this roleplay character - a different way to start a brand '
            + 'new chat, so the player can pick between several. Not the roleplay itself, just the opening line.',
        '',
        `CHARACTER: ${draft.name || '(unnamed)'}`,
        '',
        'ESTABLISHED CARD (context - stay consistent with it, do not repeat it verbatim):',
        renderDraftPlain(draft),
    ];

    if (siblings?.length) {
        parts.push(
            '',
            'OPENING LINES ALREADY WRITTEN (write something genuinely different from every one of these - a '
                + 'different scene, mood or hook, not a reskin of the same beat):',
            siblings.map((text, i) => `${i + 1}. ${text}`).join('\n'),
        );
    }

    if (String(idea || '').trim()) {
        parts.push('', 'IDEA FOR THIS ONE (follow it):', idea.trim());
    }

    parts.push(
        '',
        firstMessageGuide(),
        '',
        commonRules(),
        '',
        'Return: { "text": "the opening message" } - nothing else.',
    );

    return withPlan(parts, 'character');
}

/**
 * Несколько «других вариантов первого сообщения» ОДНИМ запросом — «Написать все пустые»
 * рядом со списком вариантов (см. renderAltGreetings в index.js). Та же экономия, что
 * и у lorebookEntriesBatchPrompt: N вариантов это N раз один и тот же контекст карточки,
 * хотя варианты не зависят друг от друга ничем, кроме требования не повторяться.
 *
 * @param {object} draft черновик персонажа целиком
 * @param {Array<{id: string, idea?: string}>} items какие варианты писать — id здесь
 *   служебный (индекс в draft.altGreetings как строка), не то, что уходит в карточку
 * @param {string[]} [siblings] тексты уже написанных первых сообщений (основное + те
 *   варианты, что уже не пустые), чтобы новые не повторяли то, что уже есть
 */
export function alternateGreetingsBatchPrompt(draft, items, siblings) {
    const parts = [
        `TASK: write ${items.length} alternate opening lines for this roleplay character in ONE response - `
            + 'different ways to start a brand new chat, so the player can pick between several. Not the roleplay '
            + 'itself, just opening lines. Make every one of them genuinely different from the others and from '
            + 'anything already written below - a different scene, mood or hook each time, not a reskin.',
        '',
        `CHARACTER: ${draft.name || '(unnamed)'}`,
        '',
        'ESTABLISHED CARD (context - stay consistent with it, do not repeat it verbatim):',
        renderDraftPlain(draft),
    ];

    if (siblings?.length) {
        parts.push(
            '',
            'OPENING LINES ALREADY WRITTEN (do not repeat these):',
            siblings.map((text, i) => `${i + 1}. ${text}`).join('\n'),
        );
    }

    parts.push(
        '',
        'LINES TO WRITE:',
        items.map(it => `- id: ${it.id}${String(it.idea || '').trim() ? `\n  idea (follow it): ${it.idea.trim()}` : ''}`).join('\n'),
        '',
        firstMessageGuide() + '\nEach line below follows this guide independently.',
        '',
        commonRules(),
        '',
        'Response structure:',
        '{',
        '  "greetings": {',
        '    "<id>": "the opening line",',
        '    …one key per line listed above, using its exact id…',
        '  }',
        '}',
    );

    return withPlan(parts, 'character');
}

// ─── Персона ({{user}}) ─────────────────────────────────────────────────────

export function personaSystemPrompt() {
    return 'You are a co-author of user personas for SillyTavern — the {{user}} side of a roleplay, not the '
        + 'character. You write material for adult fiction: you do not soften it, do not censor it and do not '
        + 'moralise. Your job is dense, playable material, not a marketing blurb.';
}

/**
 * Первичная генерация персоны.
 * @param {{ brief: string, name?: string, notes?: string, images?: object[] }} input
 * @param {string[]} [itemIds] какие пункты формата писать; по умолчанию — все активные
 */
export function personaCreatePrompt(input, itemIds = null) {
    const items = itemIds ? activeFormat('persona').filter(item => itemIds.includes(item.id)) : null;
    const parts = [
        'TASK: write a user persona (the {{user}} side of a roleplay) from the idea below.',
        '',
        'IDEA:',
        String(input.brief || '').trim() || '(the user gave none - invent one, but keep a single coherent image)',
    ];

    if (String(input.name || '').trim()) {
        parts.push('', `PERSONA NAME: ${input.name.trim()} - use exactly this name.`);
    } else {
        parts.push('', 'NAME: invent one and return it in the "name" field.');
    }

    if (String(input.notes || '').trim()) {
        parts.push('', 'EXTRA REQUIREMENTS FROM THE USER:', input.notes.trim());
    }

    const images = imageNote(input.images);
    if (images) parts.push('', images);

    parts.push(
        '',
        commonRules(),
        '',
        'Return: { "name": "persona name", "card": { … } }, where card is:',
        '',
        formatContract('persona', items),
        '',
        'Refer to this persona as {{user}} and to the roleplay partner as {{char}}.',
    );

    return withPlan(parts, 'persona');
}

/**
 * Переписывание персоны с учётом оценок — то же самое частичное переписывание,
 * что и у карточки персонажа (см. characterRewritePrompt), только короче: у персоны
 * нет ни сценария, ни target-полей, всё уходит в одно описание при экспорте.
 * @param {object} draft черновик целиком
 * @param {string[]} [itemIds] какие пункты реально переписываем
 */
export function personaRewritePrompt(draft, itemIds = null) {
    const digest = feedbackDigest(draft.sections);
    const allItems = activeFormat('persona');
    const items = itemIds ? allItems.filter(item => itemIds.includes(item.id)) : allItems;
    const hasSkipped = items.length < allItems.length;

    return withPlan([
        'TASK: rewrite the user persona according to the user\'s ratings.',
        '',
        `PERSONA NAME: ${draft.name || '(invent one)'}`,
        '',
        'ORIGINAL IDEA:',
        String(draft.brief || '').trim() || '(none given)',
        '',
        'CURRENT VERSION:',
        renderDraftPlain(draft),
        '',
        digest || 'The user left no ratings - just improve the text without changing its substance.',
        '',
        imageNote(draft.images),
        '',
        commonRules(),
        '',
        hasSkipped
            ? 'SCOPE: some items above are NOT part of this response - either already approved by the user, or '
                + 'simply out of scope for this step. They are shown only as context, so what you write stays '
                + 'consistent with them. Do not include them in the JSON, do not summarise them, do not mention '
                + 'that you skipped them.'
            : '',
        '',
        'Return: { "name": "persona name", "card": { … } }, where card contains ONLY these items:',
        '',
        formatContract('persona', items),
        '',
        hasSkipped
            ? 'Return ONLY the items listed above - nothing else.'
            : 'Return the WHOLE persona, including the items nobody complained about.',
    ], 'persona');
}

// ─── Системный промпт для ролевой ───────────────────────────────────────────

/** Режим промпта всегда пишет по-английски: промпт уходит в каждое сообщение, латиница дешевле в токенах. */
function promptLanguage() {
    return 'English';
}

/** Общие правила режима: инструкция модели, а не проза, — стиль письма сюда не подмешиваем. */
function promptCommonRules() {
    return commonRules({ language: promptLanguage(), includeStyle: false });
}

/**
 * Разбивка пунктов промпта. Дефолт formatContract («3-5 абзацев, один факт на абзац»)
 * тут не годится: у системного промпта нет «фактов», есть правила, и лить из них воду
 * ради числа абзацев — прямой вред. Абзац всё равно остаётся единицей оценки, поэтому
 * дробить надо, но по смыслу, а не до нормы.
 */
const PROMPT_SPLIT_RULE = 'Split each item into 2-4 short paragraphs - one cluster of related rules per '
    + 'paragraph, so the user can rate and rewrite them separately. Keep them tight: a system prompt is read '
    + 'by the model on every single message, so every wasted sentence is paid for again and again. Never pad '
    + 'an item to reach a paragraph count - if an item genuinely holds one rule, give it one paragraph.';

/**
 * Чем этот режим отличается от остальных: пишется не материал для ролевой, а
 * ИНСТРУКЦИЯ модели, которая эту ролевую ведёт. Отсюда второе лицо, императив и
 * требование проверяемости — «пиши живо» модель проигнорирует, «не описывай действия
 * {{user}}» выполнит.
 */
export function promptSystemPrompt() {
    return 'You write prompt snippets for SillyTavern roleplay - short, situational instructions addressed to '
        + 'the model that runs the scene, for whatever specific need the brief describes. You are not writing '
        + 'the roleplay itself, not describing a character, and not drafting a full house-style preset unless '
        + 'the brief explicitly asks for one - stay scoped to exactly what was asked. The roleplay is adult '
        + 'fiction, so nothing you write may tell the model to soften, censor or moralise. Every line must be '
        + 'an instruction that changes behaviour, never a description of what good writing feels like.';
}

/** Правила, общие для генерации и переписывания — чтобы не расходились. */
function promptCraftRules() {
    return [
        'HOW TO WRITE THE RULES:',
        '- Second person, imperative: "You play {{char}}", "Never write {{user}}\'s actions". Not "the model '
            + 'should" and not "the narrative is immersive".',
        '- Every rule must be checkable: a reader must be able to look at a reply and say whether it was '
            + 'followed. "Write vividly" is not checkable; "no more than one paragraph of scene-setting before '
            + '{{char}} speaks or acts" is.',
        '- Ban things by naming them. "Avoid cliches" does nothing; quoting the exact phrases to never use does.',
        '- Keep the macros {{char}} and {{user}} - SillyTavern substitutes them at runtime.',
        '- No meta-talk about the prompt itself, no headers like "## Style", no numbering. This text goes '
            + 'straight into the model\'s context as-is.',
        '- Do not contradict yourself across items: if one rule asks for short replies and another for lush '
            + 'description, decide which wins and say so.',
    ].join('\n');
}

/**
 * Первичная генерация системного промпта.
 * @param {{ brief: string, name?: string, notes?: string, images?: object[] }} input
 * @param {string[]} [itemIds] какие пункты формата писать; по умолчанию — все активные
 */
export function promptCreatePrompt(input, itemIds = null) {
    const items = itemIds ? activeFormat('prompt').filter(item => itemIds.includes(item.id)) : null;
    const parts = [
        'TASK: write a SillyTavern roleplay prompt for the specific situation described below. This is a '
            + 'situational, single-purpose instruction, not a full house-style preset - stay narrowly scoped '
            + 'to what the brief actually asks for.',
        '',
        'WHAT THIS PROMPT IS FOR:',
        String(input.brief || '').trim()
            || '(the user gave none - write one short, concrete, generally useful roleplay instruction; do '
                + 'not invent a whole framework of unrelated rules to fill the gap)',
    ];

    if (String(input.notes || '').trim()) {
        parts.push('', 'EXTRA REQUIREMENTS FROM THE USER:', input.notes.trim());
    }

    parts.push(
        '',
        promptCraftRules(),
        '',
        promptCommonRules(),
        '',
        'Return: { "card": { … } }, where card is:',
        '',
        formatContract('prompt', items, PROMPT_SPLIT_RULE),
    );

    return withPlan(parts, 'prompt');
}

/**
 * Переписывание системного промпта с учётом оценок — та же механика частичного
 * переписывания, что у карточки и персоны (см. characterRewritePrompt).
 * @param {object} draft черновик целиком
 * @param {string[]} [itemIds] какие пункты реально переписываем
 */
export function promptRewritePrompt(draft, itemIds = null) {
    const digest = feedbackDigest(draft.sections);
    const allItems = activeFormat('prompt');
    const items = itemIds ? allItems.filter(item => itemIds.includes(item.id)) : allItems;
    const hasSkipped = items.length < allItems.length;

    return withPlan([
        'TASK: rewrite this SillyTavern roleplay prompt according to the user\'s ratings. It is a situational, '
            + 'single-purpose instruction, not a full house-style preset - do not let it drift into one.',
        '',
        'WHAT THIS PROMPT IS FOR:',
        String(draft.brief || '').trim() || '(none given)',
        '',
        'CURRENT VERSION:',
        renderDraftPlain(draft),
        '',
        digest || 'The user left no ratings - just tighten the rules without changing what they require.',
        '',
        promptCraftRules(),
        '',
        promptCommonRules(),
        '',
        hasSkipped
            ? 'SCOPE: some items above are NOT part of this response - either already approved by the user, or '
                + 'simply out of scope for this step. They are shown only as context, so what you write stays '
                + 'consistent with them and does not contradict them. Do not include them in the JSON, do not '
                + 'summarise them, do not mention that you skipped them.'
            : '',
        '',
        'Return: { "card": { … } }, where card contains ONLY these items:',
        '',
        formatContract('prompt', items, PROMPT_SPLIT_RULE),
        '',
        hasSkipped
            ? 'Return ONLY the items listed above - nothing else.'
            : 'Return the WHOLE prompt, including the items nobody complained about.',
    ], 'prompt');
}

// ─── Сценарий ───────────────────────────────────────────────────────────────

/**
 * Сколько идей предлагать за один запрос «Придумать идеи» — фиксировано, не настройка:
 * это черновой список для выбора, а не то, что имеет смысл подкручивать. Живёт здесь,
 * а не в index.js, чтобы промпт и вызывающий код не могли разойтись по числу.
 */
export const SCENARIO_IDEA_COUNT = 4;

export function scenarioSystemPrompt() {
    return 'You are a co-author of roleplay scenario premises for SillyTavern: given a character (and, if '
        + 'linked, the persona {{user}} plays), you invent playable situations to start or continue a roleplay '
        + 'from - not the roleplay text itself, and not a character description. The material is adult fiction: '
        + 'do not soften it, do not censor it, do not moralise. Keep the {{char}} and {{user}} macros where '
        + 'they belong; do not resolve them into names yourself.';
}

/**
 * Список коротких питчей до того, как один из них прорабатывается в полный сценарий
 * (scenarioCreatePrompt). Отдельный контракт ({"ideas": [...]}, не {"card": {...}}) —
 * идеи не структурированы по пунктам формата, это черновой список альтернатив.
 *
 * @param {{brief?: string, notes?: string, characterIds?: string[], personaId?: string|null}} input
 * @param {number} count сколько идей запросить
 */
export function scenarioIdeasPrompt(input, count) {
    const parts = [
        `TASK: pitch ${count} distinct roleplay scenario ideas for the character below - short, self-contained `
            + 'premises the user can pick from and develop further.',
        '',
        linkedCharacterContext(input.characterIds, { purpose: 'these scenario ideas' }),
        linkedPersonaContext(input.personaId),
    ];

    if (String(input.brief || '').trim()) {
        parts.push('', 'DIRECTION FROM THE USER (genre, mood, constraints - follow it, do not ignore it):', input.brief.trim());
    }
    if (String(input.notes || '').trim()) {
        parts.push('', 'EXTRA REQUIREMENTS:', input.notes.trim());
    }

    parts.push(
        '',
        'Each idea is a self-contained pitch, 2-4 sentences: the hook, what is at stake, and the shape of the '
            + 'central tension - concrete enough to start writing from immediately, not a vague mood. Make the '
            + 'ideas genuinely different from each other: vary the setting, the conflict, and how {{user}} gets '
            + 'pulled in - do not just reskin the same premise several times.',
        '',
        commonRules(),
        '',
        `Return: { "ideas": ["pitch one", "pitch two", …] } - an array of exactly ${count} strings, nothing else.`,
    );

    return withPlan(parts, 'scenario');
}

/**
 * Первичная проработка сценария: из задумки (написанной руками или взятой из выбранной
 * идеи — index.js копирует текст идеи в draft.brief, отдельного пути в промпте для этого
 * нет) собирается полный сценарий по формату (DEFAULT_SCENARIO_FORMAT в settings.js).
 *
 * @param {{brief?: string, notes?: string, characterIds?: string[], personaId?: string|null, images?: object[]}} input
 * @param {string[]} [itemIds] какие пункты писать; по умолчанию — все активные
 */
export function scenarioCreatePrompt(input, itemIds = null) {
    const items = itemIds ? activeFormat('scenario').filter(item => itemIds.includes(item.id)) : null;
    const parts = [
        'TASK: develop a full roleplay scenario from the premise below - concrete enough to start playing from, '
            + 'not a vague direction.',
        '',
        linkedCharacterContext(input.characterIds, { purpose: 'this scenario' }),
        linkedPersonaContext(input.personaId),
        '',
        'PREMISE:',
        String(input.brief || '').trim()
            || '(none given - invent one consistent with the linked character, or a general-purpose hook if '
                + 'nothing is linked either)',
    ];

    if (String(input.notes || '').trim()) {
        parts.push('', 'EXTRA REQUIREMENTS FROM THE USER:', input.notes.trim());
    }

    const images = imageNote(input.images);
    if (images) parts.push('', images);

    parts.push(
        '',
        commonRules(),
        '',
        'Return: { "card": { … } }, where card is:',
        '',
        formatContract('scenario', items),
    );

    return withPlan(parts, 'scenario');
}

/**
 * Переписывание сценария с учётом оценок — та же механика частичного переписывания,
 * что у персоны и промпта (см. characterRewritePrompt).
 * @param {object} draft черновик целиком
 * @param {string[]} [itemIds] какие пункты реально переписываем
 */
export function scenarioRewritePrompt(draft, itemIds = null) {
    const digest = feedbackDigest(draft.sections);
    const allItems = activeFormat('scenario');
    const items = itemIds ? allItems.filter(item => itemIds.includes(item.id)) : allItems;
    const hasSkipped = items.length < allItems.length;

    return withPlan([
        'TASK: rewrite this roleplay scenario according to the user\'s ratings.',
        '',
        linkedCharacterContext(draft.characterIds, { purpose: 'this scenario' }),
        linkedPersonaContext(draft.personaId),
        '',
        'PREMISE:',
        String(draft.brief || '').trim() || '(none given)',
        '',
        'CURRENT VERSION:',
        renderDraftPlain(draft),
        '',
        digest || 'The user left no ratings - just improve the text without changing its substance.',
        '',
        imageNote(draft.images),
        '',
        commonRules(),
        '',
        hasSkipped
            ? 'SCOPE: some items above are NOT part of this response - either already approved by the user, or '
                + 'simply out of scope for this step. They are shown only as context, so what you write stays '
                + 'consistent with them and does not contradict them. Do not include them in the JSON, do not '
                + 'summarise them, do not mention that you skipped them.'
            : '',
        '',
        'Return: { "card": { … } }, where card contains ONLY these items:',
        '',
        formatContract('scenario', items),
        '',
        hasSkipped
            ? 'Return ONLY the items listed above - nothing else.'
            : 'Return the WHOLE scenario, including the items nobody complained about.',
    ], 'scenario');
}

// ─── Сюжет ──────────────────────────────────────────────────────────────────

export function plotSystemPrompt() {
    return 'You are a co-author of long-form roleplay plot arcs for SillyTavern: an ordered chain of story '
        + 'milestones that a roleplay drifts through over many sessions, driven by both {{user}} and {{char}}. '
        + 'The material is adult fiction: do not soften it, do not censor it, do not moralise. Keep the {{char}} '
        + 'and {{user}} macros where they belong; do not resolve them into names yourself.';
}

/** Как писать шаги — общие правила для создания и переписывания, чтобы не расходились. */
function plotCraftRules() {
    return String(getSettings().prompt_plot || '').trim() || DEFAULT_PROMPT_PLOT;
}

/** Участники открытого чата из самой Таверны (src/plot.js → chatCast): не обязаны быть в LOOM. */
export function chatCastBlock(cast) {
    if (!cast || (!cast.characters?.length && !cast.persona)) return '';
    const lines = [
        'CAST TAKEN AUTOMATICALLY FROM THE OPEN CHAT (SillyTavern data - these characters need not exist in LOOM; '
            + `stay consistent with them${cast.isGroup ? '; this is a GROUP chat with several characters' : ''}):`,
    ];
    for (const character of cast.characters || []) {
        lines.push(`- ${character.name}${character.text ? `: ${character.text.replace(/\s+/g, ' ')}` : ''}`);
    }
    if (cast.persona) {
        lines.push(`- {{user}} (the player) is ${cast.persona.name}${cast.persona.text ? `: ${cast.persona.text.replace(/\s+/g, ' ')}` : ''}`);
    }
    return lines.join('\n');
}

export function plotCreatePrompt(input) {
    const count = Number(input.stepCount) || 0;
    const subCount = Number(input.subCount) || 0;
    const parts = [
        `TASK: design a plot arc for a roleplay${count ? ` of about ${count} steps` : ' (as many steps as the story needs, usually 4-9)'}.`,
        '',
        linkedCharacterContext(input.characterIds, { purpose: 'this plot' }),
        linkedPersonaContext(input.personaId),
        chatCastBlock(input.chatCast),
        '',
        'PREMISE:',
        String(input.brief || '').trim() || '(none given - invent a coherent arc that suits the characters)',
    ];
    if (String(input.notes || '').trim()) parts.push('', 'EXTRA REQUIREMENTS FROM THE USER:', input.notes.trim());
    if (subCount) {
        parts.push('', `SUBSTEPS: break EVERY step into about ${subCount} substeps (stages that follow one another) - fill "substeps" `
            + 'for each step; the step\'s own "condition" then describes the whole step being finished.');
    }
    parts.push(
        '',
        plotCraftRules(),
        '',
        commonRules(),
        '',
        'Return: { "name": "short arc name", "steps": [ { "title": "…", "goal": "…", "condition": "…", "complication": "…", '
            + '"substeps": [ ], "goals": [ ] } ] } - "substeps" and "goals" only where they are really needed.',
    );
    return withPlan(parts, 'scenario');
}

/** Переписывание одного шага с учётом соседей — чтобы арка осталась связной. */
export function plotStepPrompt(draft, index, note, chatCast = null) {
    const steps = draft.steps || [];
    const step = steps[index];
    const show = (s, i) => `${i + 1}. ${s.title} - goal: ${s.goal} | condition: ${s.condition}`;
    const parts = [
        'TASK: rewrite ONE step of the plot arc below. Keep it consistent with the steps around it: it must '
            + 'still follow from the previous step and lead into the next one.',
        '',
        linkedCharacterContext(draft.characterIds, { purpose: 'this plot' }),
        linkedPersonaContext(draft.personaId),
        chatCastBlock(chatCast),
        '',
        'PREMISE:',
        String(draft.brief || '').trim() || '(none given)',
        '',
        'THE WHOLE ARC (step ' + (index + 1) + ' is the one to rewrite):',
        steps.map(show).join('\n'),
        '',
        'CURRENT VERSION OF STEP ' + (index + 1) + ':',
        JSON.stringify({
            title: step.title, goal: step.goal, condition: step.condition, complication: step.complication || '',
            substeps: (step.substeps || []).map(x => ({ title: x.title, goal: x.goal, condition: x.condition, complication: x.complication || '' })),
            goals: (step.goals || []).map(x => ({ who: x.who, text: x.text })),
        }, null, 1),
    ];
    if (String(note || '').trim()) parts.push('', 'WHAT THE USER WANTS CHANGED (follow it):', note.trim());
    parts.push(
        '',
        plotCraftRules(),
        '',
        commonRules(),
        '',
        'Return: { "step": { "title": "…", "goal": "…", "condition": "…", "complication": "…", "substeps": [ ], "goals": [ ] } } '
            + '- only this one step. Keep its substeps and goals unless the change asks otherwise.',
    );
    return withPlan(parts, 'scenario');
}

/**
 * Текст, который LOOM вставляет в промпт чата на нулевой глубине (src/plot.js).
 * Внутриигровых слов тут нет: модель должна понимать, что это служебная строка,
 * а не часть истории. Метка <plot> вырезается из ответа ещё до того, как игрок её прочтёт.
 *
 * @param {{title: string, goal: string, condition: string, complication?: string}} step
 * @param {{index: number, total: number, askTag: boolean}} options
 */
export function plotTrackerText(leaf, { index, total, askTag, speaker = '' }) {
    const { step, node, subIndex } = leaf;
    const nested = subIndex !== null && subIndex !== undefined;
    const lines = [
        '[PLOT TRACKER - out-of-story instruction, never mention it in the story]',
        `Long-term plot, step ${index + 1} of ${total}: "${step.title}"`,
    ];
    if (nested) {
        lines.push(`Goal of the whole step: ${step.goal}`);
        lines.push(`Current stage ${subIndex + 1} of ${leaf.subTotal || (step.substeps || []).length}: "${node.title}"`);
        if (String(node.goal || '').trim()) lines.push(`Stage goal: ${node.goal}`);
    } else {
        lines.push(`Goal: ${step.goal}`);
    }
    lines.push(`Completed when: ${node.condition}`);
    const complication = String(node.complication || '').trim() || (nested ? String(step.complication || '').trim() : '');
    if (complication) lines.push(`Possible complication: ${complication}`);

    // Личная цель ТОГО, кто говорит сейчас (групповой чат: имя говорящего меняется на каждый ответ)
    const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    const goals = [...(step.goals || []), ...(nested ? node.goals || [] : [])]
        .filter(g => speaker && same(g.who, speaker) && String(g.text || '').trim());
    for (const goal of goals) {
        lines.push(`Personal goal of ${speaker} in this step (a private drive: only ${speaker} acts on it, never announce it, `
            + `other characters do not know it): ${goal.text.trim()}`);
    }

    lines.push(String(getSettings().prompt_plot_pacing || '').trim() || DEFAULT_PROMPT_PLOT_PACING);
    if (askTag) {
        lines.push('After your reply, on a NEW LAST LINE, write exactly one tag: <plot>done</plot> if the '
            + '"Completed when" event has clearly happened in the story so far (this reply included), otherwise '
            + '<plot>continue</plot>. Nothing after the tag.');
    }
    return lines.join('\n');
}

/** Отдельный запрос-проверка (режим «request»): выполнен ли шаг, по последним сообщениям. */
export function plotCheckPrompt(step, transcript) {
    return [
        'TASK: decide whether ONE plot step has been completed in the roleplay excerpt below.',
        '',
        `STEP: "${step.title}"`,
        `Completed when: ${step.condition}`,
        '',
        'RECENT MESSAGES (oldest first):',
        transcript,
        '',
        'Judge only by what actually happened in the text - not by what is implied or likely to happen next. '
            + 'If the event is only hinted at, attempted or promised, it is NOT done.',
        '',
        'RESPONSE FORMAT: valid JSON only, no text around it, no ``` fences.',
        '{ "done": true | false }',
    ].join('\n');
}

// ─── Лорбук ─────────────────────────────────────────────────────────────────

export function lorebookSystemPrompt() {
    return 'You are a co-author of lorebooks (world info) for SillyTavern. Lorebook entries are injected into '
        + 'the context by keyword, so every entry must be short, self-contained and free of filler. '
        + 'The material is adult: do not soften it and do not censor it.';
}

/**
 * Пояснение под конкретный тип записи (LOREBOOK_CATEGORIES в settings.js) — раньше
 * все записи лорбука писались по одному общему шаблону («Суть/Детали/Связи»), и
 * «Персонаж» получал ту же структуру, что «Событие» или «Предмет». Теперь категория
 * тянет за собой конкретный список, что в неё должно попасть.
 *
 * @param {string} category id категории записи (entry.category)
 * @returns {string} пустая строка, если категория не задана или не распознана —
 *   тогда запись пишется по общим правилам формата, без доп. подсказки
 */
export function lorebookCategoryGuidance(category) {
    const found = LOREBOOK_CATEGORIES.find(c => c.id === category);
    if (!found) return '';
    return `ENTRY TYPE: ${found.label.toUpperCase()}. Cover: ${found.hint}`;
}

/**
 * Правило длины записи взамен фиксированного «3-5 абзацев» (см. formatContract) —
 * пользователь настраивает объём ползунком per-entry (entry.wordCount, 50-1000 слов),
 * а не получает одну и ту же структуру независимо от того, нужен короткий словарный
 * подзапись или разворачённая история.
 *
 * @param {number} wordCount
 */
export function lorebookLengthRule(wordCount) {
    return `Aim for about ${wordCount} words total across every item combined - not per item. Split naturally `
        + 'into paragraphs; do not force a fixed paragraph count per item, and do not pad the text just to hit '
        + 'the number.';
}

/** План лорбука: список записей до того, как писать их содержимое. */
export function lorebookPlanPrompt(input) {
    const parts = [
        'TASK: draft a plan for a lorebook from the world description.',
        '',
        'WORLD DESCRIPTION:',
        String(input.brief || '').trim() || '(none given - invent a coherent world yourself)',
    ];

    if (String(input.notes || '').trim()) {
        parts.push('', 'EXTRA REQUIREMENTS FROM THE USER:', input.notes.trim());
    }

    const categoryIds = LOREBOOK_CATEGORIES.map(c => c.id).join(' | ');
    const categoryList = LOREBOOK_CATEGORIES.map(c => `  - ${c.id}: ${c.label}`).join('\n');

    parts.push(
        '',
        linkedCharacterContext(input.characterIds),
        linkedPersonaContext(input.personaId),
        '',
        // Раньше здесь стояло «ровно N записей» — модель либо раздувала мир лишними
        // записями, чтобы добить число, либо ужимала его, если тот был скромнее счёта.
        'Propose as many entries as this world genuinely needs - do not pad with filler and do not skimp if '
            + 'the description implies more scope. A sparse one-line brief needs only a handful of entries; '
            + 'a richly detailed one needs more. They must not duplicate each other: cover different layers '
            + 'of the world - places, factions, people, technology or magic, customs, conflicts.',
        '',
        commonRules(),
        '',
        'Response structure:',
        '{',
        '  "entries": [',
        '    {',
        '      "title": "entry name, also used as its comment in the lorebook",',
        `      "category": "${categoryIds}",`,
        '      "keys": ["keywords that should trigger this entry"],',
        '      "seed": "one sentence - what the entry will be about"',
        '    }',
        '  ]',
        '}',
        '',
        'category must be exactly one of:',
        categoryList,
        '',
        'Give keywords in their DICTIONARY FORM (nominative singular) - the extension turns them into '
            + 'inflection-proof regular expressions itself.',
        '',
        'HOW TO CHOOSE KEYS - imagine a key firing in a random scene. Does the word actually get said there, and '
            + 'does this entry help that scene? Keep the key only if both answers are yes.',
        '- A key names what the entry is ABOUT (a person, a place, an object, a group), not something that merely '
            + 'happens near it. The FIRST key is the full name or title; then the other names the subject goes by: '
            + 'first name, surname and nickname, each as its own key.',
        '- NEVER use everyday words that appear in ordinary scenes of this setting: tavern, blacksmith, bell, '
            + 'guard, enemies, dog, fog, order, master, priest, fortress, weapon, city (and their Russian '
            + 'equivalents трактир, кузнец, колокол, стража, враги, пёс, туман, орден, мастер, священник, крепость). '
            + 'Such a key drags the entry into every scene where the word is merely mentioned.',
        '- A role word is allowed only if it points to exactly ONE subject in this world ("князь" when there is '
            + 'one prince) - never a role many people share.',
        '- Multi-word keys only for multi-word proper names ("Серебряный колокол") or when one word would be '
            + 'ambiguous; then the phrase, not its common part.',
        '- If a name is also a common word (a dog named "Туман" - fog), do not use it alone as a key; use a '
            + 'phrase or another name instead.',
        '- Never verbs, adjectives, pronouns. 1-5 keys per entry: fewer strong keys beat many weak ones.',
        speakerNameRule(input.characterIds, input.personaId),
    );

    return withPlan(parts, 'lorebook');
}

/** Содержимое одной записи лорбука. */
export function lorebookEntryPrompt(input) {
    const parts = [
        'TASK: write a single lorebook entry.',
        '',
        `ENTRY TITLE: ${input.title}`,
        input.seed ? `WHAT IT IS ABOUT: ${input.seed}` : '',
        '',
        'WORLD CONTEXT:',
        String(input.brief || '').trim() || '(none given)',
        input.siblings?.length ? `\nOTHER ENTRIES IN THIS LOREBOOK (do not retell them, but refer to them by the same names):\n- ${input.siblings.join('\n- ')}` : '',
    ];

    if (String(input.notes || '').trim()) {
        parts.push('', 'EXTRA REQUIREMENTS FROM THE USER:', input.notes.trim());
    }
    if (String(input.note || '').trim()) {
        parts.push('', 'NOTE FOR THIS ENTRY:', input.note.trim());
    }

    const categoryGuidance = lorebookCategoryGuidance(input.category);

    parts.push(
        '',
        linkedCharacterContext(input.characterIds),
        linkedPersonaContext(input.personaId),
        '',
        categoryGuidance,
        '',
        // Запись подставляется в контекст в отрыве от остальных: без имени в первой фразе
        // модель в чате приписывает эти факты не тому персонажу
        imageNote(input.images),
        '',
        'IDENTIFICATION RULE: the full name of the entry subject must appear in the very first sentence of '
            + 'the text, not only in the title. The entry is injected into the chat on its own, and without '
            + 'that name the model attributes its facts to the wrong character.',
        '',
        commonRules(),
        '',
        'Response structure:',
        '{',
        '  "entry": { … }',
        '}',
        '',
        'where entry is:',
        '',
        formatContract('lorebook', null, lorebookLengthRule(Number(input.wordCount) || 300)),
    );
    return withPlan(parts, 'lorebook');
}

/**
 * Пишет содержимое НЕСКОЛЬКИХ записей лорбука ОДНИМ запросом — вместо одного запроса
 * на каждую (как раньше делала «Написать все»). N записей это N раз один и тот же
 * WORLD CONTEXT/формат/думалка в промпте, хотя записи не зависят друг от друга ничем,
 * кроме списка соседей — а его как раз проще и дешевле держать в одном контексте.
 *
 * Записи со своими картинками-референсами сюда не идут (см. вызывающий код в index.js):
 * контекст картинки специфичен для записи, мешать его в общий запрос со всеми
 * остальными записями нельзя — модель не поймёт, к какой записи он относится.
 *
 * @param {{ entries: Array<{id: string, title: string, category?: string, seed?: string,
 *   note?: string, wordCount?: number}>, brief: string, siblings: string[],
 *   characterIds?: string[], personaId?: string, notes?: string, images?: Array }} input
 */
export function lorebookEntriesBatchPrompt(input) {
    const parts = [
        'TASK: write MULTIPLE lorebook entries in one response. There are several entries, listed below, each '
            + 'with its own id - keep them as separate, self-contained texts, do not let them drift into one story.',
        '',
        'ENTRIES TO WRITE:',
        input.entries.map(e => [
            `- id: ${e.id}`,
            `  title: ${e.title}`,
            e.category ? `  category: ${e.category}` : '',
            e.seed ? `  about: ${e.seed}` : '',
            e.note ? `  note: ${e.note}` : '',
            `  target length: about ${Number(e.wordCount) || 300} words total`,
        ].filter(Boolean).join('\n')).join('\n'),
        '',
        'WORLD CONTEXT:',
        String(input.brief || '').trim() || '(none given)',
        input.siblings?.length ? `\nALL ENTRIES IN THIS LOREBOOK (do not retell them, but refer to them by the same names):\n- ${input.siblings.join('\n- ')}` : '',
    ];

    if (String(input.notes || '').trim()) {
        parts.push('', 'EXTRA REQUIREMENTS FROM THE USER:', input.notes.trim());
    }

    // Только те категории, что реально встречаются в ЭТОМ запросе — а не все шесть
    // подряд, иначе на маленький батч из двух-трёх записей уйдёт больше промпта на
    // расшифровку категорий, чем на сами записи.
    const usedCategories = [...new Set(input.entries.map(e => e.category).filter(Boolean))];
    const categoryNotes = usedCategories
        .map(id => lorebookCategoryGuidance(id))
        .filter(Boolean);

    parts.push(
        '',
        linkedCharacterContext(input.characterIds),
        linkedPersonaContext(input.personaId),
        '',
        categoryNotes.length ? ['ENTRY TYPE NOTES (see category of each entry above):', ...categoryNotes].join('\n') : '',
        '',
        imageNote(input.images),
        '',
        'IDENTIFICATION RULE: the full name of an entry\'s subject must appear in the very first sentence of '
            + 'ITS OWN text, not only in the title. Each entry is injected into the chat on its own, and without '
            + 'that name the model attributes its facts to the wrong subject.',
        '',
        commonRules(),
        '',
        'Response structure:',
        '{',
        '  "entries": {',
        '    "<entry id>": { … same items as below … },',
        '    "<entry id>": { … },',
        '    …one key per entry listed above, using its exact id…',
        '  }',
        '}',
        '',
        'where each entry value is:',
        '',
        // Единая длина на все записи разом задать нельзя — у каждой свой word target
        // из списка выше (у них разная целевая длина), поэтому здесь общая формулировка,
        // а не formatContract() по умолчанию с фиксированным «3-5 абзацев».
        formatContract('lorebook', null, 'Follow the target length listed for EACH entry above individually - '
            + 'split into natural paragraphs, do not force a fixed paragraph count per item, and do not pad '
            + 'any entry just to hit its number.'),
    );
    return withPlan(parts, 'lorebook');
}

/**
 * Переписывание записи лорбука с учётом оценок абзацев.
 * @param {object} draft
 * @param {object} entry
 * @param {string[]} [itemIds] см. characterRewritePrompt — та же логика частичного
 *   переписывания, только для пунктов записи лорбука.
 */
export function lorebookRewritePrompt(draft, entry, itemIds = null) {
    const digest = feedbackDigest(entry.sections);
    const allItems = activeFormat('lorebook');
    const items = itemIds ? allItems.filter(item => itemIds.includes(item.id)) : allItems;
    const hasSkipped = items.length < allItems.length;
    const parts = [
        'TASK: rewrite a lorebook entry according to the user\'s ratings.',
        '',
        `ENTRY TITLE: ${entry.title}`,
        '',
        'WORLD CONTEXT:',
        String(draft.brief || '').trim() || '(none given)',
        '',
        'CURRENT VERSION OF THE ENTRY:',
        entry.sections.map(s => `## ${s.id}\n` + s.blocks.map(b => b.text).join('\n\n')).join('\n\n'),
        '',
        digest || 'The user left no ratings - just improve the text without changing its substance.',
    ];

    if (String(draft.notes || '').trim()) {
        parts.push('', 'EXTRA REQUIREMENTS FROM THE USER:', draft.notes.trim());
    }
    if (String(entry.note || '').trim()) {
        parts.push('', 'NOTE FOR THIS ENTRY:', entry.note.trim());
    }

    parts.push(
        '',
        linkedCharacterContext(draft.characterIds),
        linkedPersonaContext(draft.personaId),
        '',
        lorebookCategoryGuidance(entry.category),
        '',
        imageNote(entry.images),
        '',
        'IDENTIFICATION RULE: keep the full name of the entry subject in the very first sentence of the text.',
        '',
        commonRules(),
        '',
        hasSkipped
            ? 'SCOPE: some items above are NOT part of this response - either already approved by the user, or '
                + 'simply out of scope for this step. They are shown only as context, so what you write stays '
                + 'consistent with them. Do not include them in the JSON, do not summarise them, do not mention '
                + 'that you skipped them.'
            : '',
        '',
        'Response structure:',
        '{',
        '  "entry": { … }',
        '}',
        '',
        hasSkipped ? 'where entry contains ONLY these items:' : 'where entry is:',
        '',
        formatContract('lorebook', items, lorebookLengthRule(Number(entry.wordCount) || 300)),
        '',
        hasSkipped ? 'Return ONLY the items listed above - nothing else.' : '',
    );
    return withPlan(parts, 'lorebook');
}

// ─── Пресет ─────────────────────────────────────────────────────────────────
//
// Пресет Chat Completion Таверны — это набор ИМЕНОВАННЫХ блоков инструкции (её
// prompts[]), каждый из которых можно включить, выключить и переставить в её же
// Prompt Manager. Механика письма и оценки — та же, что у лорбука: план блоков,
// потом текст каждого по отдельности или все разом, переписывание по оценкам.
// А вот ГОЛОС письма — от «Промпта»: это инструкция модели, а не факт о мире,
// поэтому categoryGuidance/keys лорбука тут не нужны вовсе, зато нужны
// promptCraftRules (второе лицо, императив, проверяемость).

/**
 * Разбивка блока пресета — то же самое, что у «Промпта» (PROMPT_SPLIT_RULE): инструкция,
 * а не проза, лить абзацы ради счёта незачем. Отдельная константа, а не переиспользование
 * той же самой, — чтобы комментарий и смысл не расходились, если один из режимов
 * когда-нибудь изменится независимо от другого.
 */
const PRESET_SPLIT_RULE = 'Split each item into 2-4 short paragraphs - one cluster of related rules per '
    + 'paragraph, so the user can rate and rewrite them separately. Keep them tight: this block is read by the '
    + 'model on every single message, so every wasted sentence is paid for again and again. Never pad an item '
    + 'to reach a paragraph count - if it genuinely holds one rule, give it one paragraph.';

/**
 * Текст блока пресета — всегда по-английски, как и у режима «Промпт»: блок уходит в
 * контекст каждого сообщения, латиница там в разы дешевле. «Правила письма» (стиль прозы)
 * не подмешиваем — это инструкция модели, а не художественный текст.
 */
function presetTextRules() {
    return commonRules({ language: 'English', includeStyle: false });
}

/** Объём блока из ползунка «Слов» — раньше он менял только лимит токенов, а не саму длину. */
function presetLengthRule(wordCount) {
    const words = Number(wordCount) || 0;
    if (!words) return '';
    return `LENGTH: about ${words} words for the whole block. A hard ceiling, not a target to pad up to - a `
        + 'block that says everything in fewer words is better.';
}

/**
 * Как блок попадёт в запрос — от этого зависит, как его писать: system-блок в начале —
 * это общее правило; сообщение user/assistant глубоко в чате — напоминание, которое модель
 * видит прямо перед ответом, и оно должно читаться уместно на этом месте.
 */
function presetDeliveryNote(entry) {
    const role = entry?.role || 'system';
    const inChat = Number(entry?.injectionPosition) === 1;
    const where = inChat
        ? `injected INSIDE the chat history, ${Number(entry.injectionDepth) || 0} messages from the end - the model `
            + 'reads it right before writing its reply, so make it a short, direct reminder, not a manual'
        : 'placed at its own slot in the prompt list, before the chat history - a standing rule';
    return `DELIVERY: this block is sent as a "${role}" message, ${where}.`
        + (role === 'user' ? ' It will read as if the user said it - phrase it as an out-of-character note.' : '')
        + (role === 'assistant' ? ' It will read as the model\'s own words - phrase it as a note the model wrote to itself.' : '');
}

export function presetSystemPrompt() {
    return 'You are a co-author of named instruction blocks for a SillyTavern Chat Completion preset. Each '
        + 'block is a separate, independently toggled prompt in that preset\'s Prompt Manager - not a one-off '
        + 'snippet used once and discarded, but a reusable part of a library the user keeps assembling presets '
        + 'from. Write it so it stands on its own: it may be enabled next to any of the OTHER blocks in this '
        + 'same library, or alone, so it must not assume a specific set of neighbours is active. The roleplay '
        + 'this preset serves is adult fiction - nothing you write may tell the model to soften, censor or '
        + 'moralise. Every line must be an instruction that changes behaviour, never a description of what '
        + 'good writing feels like.';
}

/** План пресета: список именованных блоков до того, как писать их содержимое. */
export function presetPlanPrompt(input) {
    const parts = [
        'TASK: draft a plan for a SillyTavern preset - a set of separate, named instruction blocks - from the '
            + 'brief below.',
        '',
        'WHAT THIS PRESET IS FOR:',
        String(input.brief || '').trim()
            || '(the user gave none - propose a short, generally useful set of blocks; do not invent an '
                + 'unrelated framework to fill the gap)',
    ];

    if (String(input.notes || '').trim()) {
        parts.push('', 'EXTRA REQUIREMENTS FROM THE USER:', input.notes.trim());
    }

    parts.push(
        '',
        'Block titles and seeds are for the user to read - write them in the output language below. The block '
            + 'texts themselves will be written later, in English.',
        '',
        'Propose as many blocks as this brief genuinely needs - do not pad with filler and do not skimp if it '
            + 'implies more scope. A single narrow request needs only one or two blocks; a house-style preset '
            + 'needs more. They must not duplicate each other - each block owns ONE concern (a content rule, '
            + 'a formatting rule, a language rule, a reasoning instruction, and so on) and does not restate what '
            + 'another already covers.',
        '',
        commonRules({ includeStyle: false }),
        '',
        'Response structure:',
        '{',
        '  "entries": [',
        '    {',
        '      "title": "short block name, also its name in the preset\'s prompt list",',
        '      "seed": "one sentence - what this block will instruct"',
        '    }',
        '  ]',
        '}',
    );

    return withPlan(parts, 'preset');
}

/** Содержимое одного именованного блока пресета. */
export function presetEntryPrompt(input) {
    const parts = [
        'TASK: write the content of a single named instruction block for a SillyTavern preset.',
        '',
        `BLOCK NAME: ${input.title}`,
        input.seed ? `WHAT IT IS FOR: ${input.seed}` : '',
        '',
        'WHAT THIS PRESET IS FOR (overall):',
        String(input.brief || '').trim() || '(none given)',
        input.siblings?.length
            ? `\nOTHER BLOCKS IN THIS SAME PRESET (do not restate what they already cover; assume any of them `
                + `may or may not be enabled alongside this one):\n- ${input.siblings.join('\n- ')}`
            : '',
    ];

    if (String(input.notes || '').trim()) {
        parts.push('', 'EXTRA REQUIREMENTS FROM THE USER:', input.notes.trim());
    }
    if (String(input.note || '').trim()) {
        parts.push('', 'NOTE FOR THIS BLOCK:', input.note.trim());
    }

    parts.push(
        '',
        presetDeliveryNote(input),
        presetLengthRule(input.wordCount),
        '',
        promptCraftRules(),
        '',
        presetTextRules(),
        '',
        'Response structure:',
        '{',
        '  "entry": { … }',
        '}',
        '',
        'where entry is:',
        '',
        formatContract('preset', null, PRESET_SPLIT_RULE),
    );
    return withPlan(parts, 'preset');
}

/**
 * Пишет содержимое НЕСКОЛЬКИХ блоков пресета одним запросом — см. lorebookEntriesBatchPrompt,
 * та же экономия, тот же принцип.
 */
export function presetEntriesBatchPrompt(input) {
    const parts = [
        'TASK: write MULTIPLE named instruction blocks for a SillyTavern preset in one response. Each is listed '
            + 'below with its own id - keep them separate and self-contained, do not let them drift into one '
            + 'combined block.',
        '',
        'BLOCKS TO WRITE:',
        input.entries.map(e => [
            `- id: ${e.id}`,
            `  title: ${e.title}`,
            e.seed ? `  for: ${e.seed}` : '',
            e.note ? `  note: ${e.note}` : '',
            e.wordCount ? `  length: about ${e.wordCount} words (ceiling, not a target)` : '',
            `  ${presetDeliveryNote(e).toLowerCase()}`,
        ].filter(Boolean).join('\n')).join('\n'),
        '',
        'WHAT THIS PRESET IS FOR (overall):',
        String(input.brief || '').trim() || '(none given)',
        input.siblings?.length
            ? `\nALL BLOCKS IN THIS PRESET (do not let any of them restate another; assume any subset may end up `
                + `enabled together):\n- ${input.siblings.join('\n- ')}`
            : '',
    ];

    if (String(input.notes || '').trim()) {
        parts.push('', 'EXTRA REQUIREMENTS FROM THE USER:', input.notes.trim());
    }

    parts.push(
        '',
        promptCraftRules(),
        '',
        presetTextRules(),
        '',
        'Response structure:',
        '{',
        '  "entries": {',
        '    "<block id>": { … same items as below … },',
        '    "<block id>": { … },',
        '    …one key per block listed above, using its exact id…',
        '  }',
        '}',
        '',
        'where each block value is:',
        '',
        formatContract('preset', null, PRESET_SPLIT_RULE),
    );
    return withPlan(parts, 'preset');
}

/** Переписывание одного блока пресета с учётом оценок — та же механика, что у lorebookRewritePrompt. */
export function presetRewritePrompt(draft, entry, itemIds = null) {
    const digest = feedbackDigest(entry.sections);
    const allItems = activeFormat('preset');
    const items = itemIds ? allItems.filter(item => itemIds.includes(item.id)) : allItems;
    const hasSkipped = items.length < allItems.length;
    const siblings = draft.entries.filter(e => e !== entry).map(e => e.title);

    const parts = [
        'TASK: rewrite one named instruction block of a SillyTavern preset according to the user\'s ratings.',
        '',
        `BLOCK NAME: ${entry.title}`,
        '',
        'WHAT THIS PRESET IS FOR (overall):',
        String(draft.brief || '').trim() || '(none given)',
        siblings.length
            ? `\nOTHER BLOCKS IN THIS SAME PRESET (do not restate what they already cover):\n- ${siblings.join('\n- ')}`
            : '',
        '',
        'CURRENT VERSION OF THE BLOCK:',
        entry.sections.map(s => `## ${s.id}\n` + s.blocks.map(b => b.text).join('\n\n')).join('\n\n'),
        '',
        digest || 'The user left no ratings - just tighten the rules without changing what they require.',
    ];

    if (String(draft.notes || '').trim()) {
        parts.push('', 'EXTRA REQUIREMENTS FROM THE USER:', draft.notes.trim());
    }
    if (String(entry.note || '').trim()) {
        parts.push('', 'NOTE FOR THIS BLOCK:', entry.note.trim());
    }

    parts.push(
        '',
        presetDeliveryNote(entry),
        presetLengthRule(entry.wordCount),
        '',
        promptCraftRules(),
        '',
        presetTextRules(),
        '',
        hasSkipped
            ? 'SCOPE: some items above are NOT part of this response - either already approved by the user, or '
                + 'simply out of scope for this step. They are shown only as context, so what you write stays '
                + 'consistent with them. Do not include them in the JSON, do not summarise them, do not mention '
                + 'that you skipped them.'
            : '',
        '',
        'Response structure:',
        '{',
        '  "entry": { … }',
        '}',
        '',
        hasSkipped ? 'where entry contains ONLY these items:' : 'where entry is:',
        '',
        formatContract('preset', items, PRESET_SPLIT_RULE),
        '',
        hasSkipped ? 'Return ONLY the items listed above - nothing else.' : '',
    );
    return withPlan(parts, 'preset');
}

// ─── Анализ чужого пресета ───────────────────────────────────────────────────

const ANALYSIS_SPLIT_RULE = 'Split the diagnosis into one paragraph per finding - one problem cause and its fix '
    + 'per paragraph, so the user can rate and rewrite them separately. A preset with one clear cause needs only '
    + 'one paragraph; do not invent a second finding just to pad the count, and do not cram two unrelated causes '
    + 'into one paragraph either. Order findings by impact: the main cause first.';

/**
 * Готовый текст для вставки в пресет — между этими маркерами. index.js вырезает его
 * из абзаца (splitPromptFix) в отдельное поле с кнопкой «Копировать».
 */
export const PROMPT_FIX_OPEN = '[PROMPT]';
export const PROMPT_FIX_CLOSE = '[/PROMPT]';

const ANALYSIS_FINDING_RULES = [
    'HOW TO WRITE EACH FINDING (one JSON string):',
    '1. What is wrong: name the exact block (or sampler) and quote the line that causes the problem.',
    '2. Why it produces what the user complains about - the mechanism, in one or two sentences.',
    '3. What to do, as a concrete action: "turn on block X", "delete the line ...", "set temperature to 1.0", '
        + '"replace block X with the text below", "add a new block after X with the text below".',
    '',
    'PASTE-READY TEXT: whenever the fix involves writing or rewriting prompt text, you MUST write that text in '
        + 'full and put it at the very end of the finding between ' + PROMPT_FIX_OPEN + ' and ' + PROMPT_FIX_CLOSE
        + ' on their own lines. The user copies it with one click, so:',
    '- It is the complete, final text to paste - a whole block or a whole replacement line, never a fragment like '
        + '"add rule 4 ..." or an ellipsis. If it replaces an existing block, write the whole new block.',
    '- Only the text to paste goes inside the markers: no explanations, no quotes around it.',
    '- Write it in English, whatever the output language is - it goes into the preset, where English is cheaper.',
    '- Match the preset\'s own style: its tags, numbering, person ("you"/"{{char}}"), macros like {{char}} and {{user}}.',
    '- At most one such text per finding. The explanation before the markers says exactly where it goes.',
    '- A fix that needs no new text (toggle a block, change a sampler, move a block, delete a line) has no markers.',
    '',
    'Plain text only in the explanation: no markdown, no **bold**, no backticks. Refer to blocks by name in «guillemets».',
].join('\n');

/** Абзац разбора + его готовый текст обратно в одну строку с маркерами — для промпта переписывания. */
export function joinPromptFix(block) {
    const text = String(block.text || '').trim();
    const prompt = String(block.prompt || '').trim();
    return prompt ? text + '\n' + PROMPT_FIX_OPEN + '\n' + prompt + '\n' + PROMPT_FIX_CLOSE : text;
}

/**
 * Обратное: вырезает готовый текст из абзаца. Понимает и маркеры, и блок в тройных
 * обратных кавычках — модель иногда забывает маркеры и по привычке оборачивает текст в код.
 * @returns {{text: string, prompt: string}}
 */
export function splitPromptFix(raw) {
    const parts = [];
    let text = String(raw || '').replace(/\[PROMPT\]([\s\S]*?)(?:\[\/PROMPT\]|$)/g, (_, inner) => {
        parts.push(inner.trim());
        return '';
    });
    if (!parts.length) {
        text = text.replace(/```[\w-]*\n([\s\S]*?)```/g, (_, inner) => {
            parts.push(inner.trim());
            return '';
        });
    }
    return { text: text.replace(/\n{3,}/g, '\n\n').trim(), prompt: parts.filter(Boolean).join('\n\n') };
}


export function analysisSystemPrompt() {
    return 'You are a senior SillyTavern prompt engineer reviewing someone else\'s Chat Completion preset. You '
        + 'read what is actually there - the named blocks, their content, their order, whether they are even '
        + 'wired into the active request - and connect it to the specific problem the user describes. You are '
        + 'specific and actionable: name the exact block responsible, quote or paraphrase the exact line that '
        + 'causes the problem, and propose a concrete edit - never generic prompting advice that could apply to '
        + 'any preset. If two blocks contradict each other, say which one wins in practice (order and enabled '
        + 'state decide that, not which one sounds more emphatic) and why that does or does not explain the '
        + 'problem. You are not shy about saying a preset already handles something correctly if that turns out '
        + 'to be true - the point is an honest diagnosis, not finding fault for its own sake.'
        + '\n\n'
        + 'Most complaints arrive as a short, frustrated gut reaction, not a technical bug report - "it\'s dry", '
        + '"reads like a bot", "same three sentences every time", "boring". That vagueness is not a lack of '
        + 'information for you to ask about; it is the actual task. Translate the feeling into the concrete '
        + 'writing symptoms it usually means (flat/clinical word choice, no sensory or emotional texture, short '
        + 'generic sentences, repeated sentence structure, no distinct voice, over-hedging, listing actions '
        + 'instead of inhabiting them) and go find which of those the preset actually produces - missing or '
        + 'disabled anti-cliche/voice/prose-texture instructions, a block that quietly demands a flat or formal '
        + 'register, or samplers pushing the output toward the safest, most average continuation (temperature, '
        + 'frequency/presence penalty, top_p all matter here, not just prompt text). Never respond to a vague '
        + 'complaint by asking the user to elaborate - a vague complaint about prose quality is answered with a '
        + 'diagnosis, same as a precise one.'
        + '\n\n'
        + 'You do not stop at pointing at the problem. Every finding ends with a fix the user can apply right now, '
        + 'and when that fix is prompt text you write the actual text in full, ready to paste into the preset - '
        + 'not a description of what such text should say.';
}

/**
 * Дайджест пресета (см. buildPresetDigestFromRaw в src/tavern-import.js, или та же
 * форма, собранная вручную для источника «черновик LOOM» — там нет сэмплеров и
 * порядка, только именованные блоки) → читаемый текст для промпта.
 * @param {{model?: string, temperature?: number, top_p?: number, top_k?: number,
 *   frequency_penalty?: number, presence_penalty?: number, repetition_penalty?: number,
 *   blocks: Array<{name: string, content: string, role: string, enabled: boolean|null}>}} digest
 */
function presetDigestText(digest) {
    if (!digest || !Array.isArray(digest.blocks)) return '(источник не выбран, или не удалось его прочитать)';

    const lines = [];
    if (digest.model) lines.push(`Model: ${digest.model}`);
    const samplers = ['temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'repetition_penalty']
        .filter(key => digest[key] !== undefined && digest[key] !== null && digest[key] !== '')
        .map(key => `${key}=${digest[key]}`);
    if (samplers.length) lines.push(`Samplers: ${samplers.join(', ')}`);

    lines.push('', `Named prompt blocks (${digest.blocks.length}), in the order they run in the request:`);
    if (!digest.blocks.length) lines.push('(none with actual content)');
    for (const block of digest.blocks) {
        const state = block.enabled === true ? 'ON - part of the active request'
            : block.enabled === false ? 'OFF - saved but currently disabled, does not reach the model'
                : 'not wired into the request order at all - library only, does not reach the model';
        lines.push('', `## ${block.name} [role: ${block.role}; ${state}]`, block.content);
    }
    return lines.join('\n');
}

/**
 * Первичный разбор пресета.
 * @param {{brief: string, notes?: string, digest: object, sourceLabel: string}} input
 *   digest — см. presetDigestText; sourceLabel — откуда он взят («Таверна: <имя>»,
 *   «Черновик LOOM: <имя>», «Файл: <имя>»), для читаемости самого промпта.
 */
export function analysisCreatePrompt(input) {
    const parts = [
        'TASK: diagnose a SillyTavern Chat Completion preset against the problem described below, and propose '
            + 'concrete fixes.',
        '',
        'THE PROBLEM (in the user\'s own words):',
        String(input.brief || '').trim()
            || '(none given - do a general quality pass instead: contradictions between blocks, dead/unwired '
                + 'blocks that look like they were meant to be active, anything that looks like a leftover draft)',
    ];

    if (String(input.notes || '').trim()) {
        parts.push('', 'EXTRA CONTEXT FROM THE USER:', input.notes.trim());
    }

    parts.push(
        '',
        `THE PRESET (source: ${input.sourceLabel || 'unknown'}):`,
        presetDigestText(input.digest),
        '',
        commonRules(),
        '',
        'Response structure:',
        '{',
        '  "card": { … }',
        '}',
        '',
        'where card is:',
        '',
        formatContract('analysis', null, ANALYSIS_SPLIT_RULE),
        '',
        ANALYSIS_FINDING_RULES,
    );

    return withPlan(parts, 'analysis');
}

/**
 * Переписывание разбора с учётом оценок — та же механика частичного переписывания,
 * что и у промпта/пресета. Дайджест читается заново вызывающим кодом (index.js) и
 * передаётся сюда параметром: сам черновик хранит только ссылку на источник
 * (draft.reviewSource), не копию пресета — источник мог за это время измениться,
 * и разбор должен идти по актуальной версии, а не по слепку на момент первого запуска.
 * @param {object} draft
 * @param {object} digest свежепрочитанный дайджест источника
 * @param {string} sourceLabel
 * @param {string[]} [itemIds]
 */
export function analysisRewritePrompt(draft, digest, sourceLabel, itemIds = null) {
    const feedback = feedbackDigest(draft.sections);
    const allItems = activeFormat('analysis');
    const items = itemIds ? allItems.filter(item => itemIds.includes(item.id)) : allItems;
    const hasSkipped = items.length < allItems.length;

    const parts = [
        'TASK: rewrite this diagnosis of a SillyTavern preset according to the user\'s ratings.',
        '',
        'THE PROBLEM (in the user\'s own words):',
        String(draft.brief || '').trim() || '(none given)',
    ];

    if (String(draft.notes || '').trim()) {
        parts.push('', 'EXTRA CONTEXT FROM THE USER:', draft.notes.trim());
    }

    parts.push(
        '',
        `THE PRESET (source: ${sourceLabel || 'unknown'}):`,
        presetDigestText(digest),
        '',
        'CURRENT VERSION OF THE DIAGNOSIS:',
        draft.sections
            .map(section => `## ${section.id}\n` + section.blocks.map(joinPromptFix).join('\n\n'))
            .join('\n\n'),
        '',
        feedback || 'The user left no ratings - just tighten the diagnosis without changing what it claims.',
        '',
        commonRules(),
        '',
        hasSkipped
            ? 'SCOPE: some items above are NOT part of this response - either already approved by the user, or '
                + 'simply out of scope for this step. Shown only as context, so what you write stays consistent '
                + 'with them. Do not include them in the JSON, do not summarise them, do not mention that you '
                + 'skipped them.'
            : '',
        '',
        'Response structure:',
        '{',
        '  "card": { … }',
        '}',
        '',
        hasSkipped ? 'where card contains ONLY these items:' : 'where card is:',
        '',
        formatContract('analysis', items, ANALYSIS_SPLIT_RULE),
        '',
        ANALYSIS_FINDING_RULES,
        '',
        hasSkipped ? 'Return ONLY the items listed above - nothing else.' : '',
    );

    return withPlan(parts, 'analysis');
}

// ─── Перевод ────────────────────────────────────────────────────────────────

/**
 * Правило про имена собственные при переводе. По умолчанию — оригинал в скобках при
 * первом упоминании: модель в ролевой иначе переводит имена как попало, и «Трафальгар
 * Ло» превращается то в Law, то в Lo. Выключается настройкой translate_keep_original_names
 * — не всем нужны дубли прямо в тексте карточки/лорбука.
 *
 * @param {boolean} [crossEntries] добавить требование про единое написание МЕЖДУ
 *   записями — актуально только для батч-перевода лорбука, где записей несколько
 */
function properNounsRule(crossEntries = false) {
    const settings = getSettings();
    const tail = crossEntries ? ' Keep the same spelling for the same name across DIFFERENT entries.' : '';
    if (settings.translate_keep_original_names === false) {
        return '- Proper nouns (names, places, factions, artefacts, techniques): translate or transliterate them. '
            + 'Do not add the original spelling anywhere - use the translated/transliterated form only.' + tail;
    }
    return '- Proper nouns (names, places, factions, artefacts, techniques): translate or transliterate them, '
        + 'and add the original spelling in parentheses at the FIRST mention inside each paragraph array, '
        + 'e.g. "Trafalgar Law (Трафальгар Ло)". Later mentions use the English form alone.' + tail;
}

/**
 * Перевод готового текста на английский.
 *
 * Зачем: карточка живёт в контексте КАЖДОГО сообщения ролевой, а русский текст стоит
 * в разы больше токенов, чем тот же смысл на английском. Ключи лорбука при этом
 * остаются русскими — они ищутся по тексту чата, который пользователь пишет по-русски.
 *
 * @param {Array<{id: string, blocks: string[]}>} sections что переводим
 */
export function translatePrompt(sections) {
    const payload = Object.fromEntries(sections.map(section => [section.id, section.blocks]));

    return [
        'TASK: translate the text below into English.',
        '',
        'RULES:',
        '- Keep the JSON structure exactly: the same keys, the same number of strings in every array. '
            + 'One paragraph in, one paragraph out - never merge or split them.',
        properNounsRule(),
        '- Keep the macros {{user}} and {{char}} untouched.',
        '- Keep formatting as it is: *italics*, quotation marks, <START>, line breaks, dialogue markers.',
        '- Translate the meaning, not the words: the result must read as if written in English, but no detail '
            + 'may be added or dropped.',
        '- Do not soften or censor anything.',
        '',
        'TEXT:',
        JSON.stringify(payload, null, 1),
        '',
        'RESPONSE FORMAT: valid JSON only, no text around it, no ``` fences.',
        '{ "sections": { … same keys and array lengths, translated … } }',
    ].join('\n');
}

/**
 * Перевод НЕСКОЛЬКИХ записей лорбука одним запросом.
 *
 * Раньше «На английский» для лорбука дёргала модель по одному разу на запись —
 * при восьми записях это восемь запросов подряд, а у прокси/провайдера часто стоит
 * лимит запросов в минуту (пользователь уже ловил 429 Too Many Requests). Здесь тот же
 * перевод, но с записями, сгруппированными по их id в одном JSON — один запрос вместо N.
 *
 * @param {Array<{id: string, sections: Array<{id: string, blocks: string[]}>}>} entries
 */
export function translateEntriesPrompt(entries) {
    const payload = Object.fromEntries(entries.map(entry => [
        entry.id,
        Object.fromEntries(entry.sections.map(section => [section.id, section.blocks])),
    ]));

    return [
        'TASK: translate the lorebook entries below into English. There are multiple entries, grouped by id.',
        '',
        'RULES:',
        '- Keep the JSON structure exactly: the same entry ids, the same section keys inside each entry, '
            + 'the same number of strings in every array. One paragraph in, one paragraph out - never merge '
            + 'or split them, and never drop an entry.',
        properNounsRule(true),
        '- Keep the macros {{user}} and {{char}} untouched.',
        '- Keep formatting as it is: *italics*, quotation marks, <START>, line breaks, dialogue markers.',
        '- Translate the meaning, not the words: the result must read as if written in English, but no detail '
            + 'may be added or dropped.',
        '- Do not soften or censor anything.',
        '',
        'ENTRIES (grouped by entry id):',
        JSON.stringify(payload, null, 1),
        '',
        'RESPONSE FORMAT: valid JSON only, no text around it, no ``` fences.',
        '{ "entries": { "<entry id>": { … same section keys and array lengths, translated … } } }',
    ].join('\n');
}

/**
 * Ключи лорбука → разбор слов для регулярных выражений.
 *
 * Модель НЕ пишет регулярку: раньше она копировала длинный хвост окончаний и границы
 * слова, и любая её ошибка ломала ключ. Теперь она отдаёт по каждому слову ключа только
 * основы и тип склонения — это то, в чём она сильна (беглые гласные, чередования корня,
 * несклоняемые имена). Шаблон по ним собирает LOOM (buildKeyFromWords в keys.js), с
 * хвостом окончаний под тип слова (RU_TAILS в settings.js).
 */
export function keyRegexPrompt(keys) {
    const settings = getSettings();
    // Язык здесь — язык ТЕКСТА ЧАТА, по которому Таверна ищет ключи, а не язык карточки
    const mode = settings.lorebook_key_language || 'auto';
    const enDecl = mode === 'ru'
        ? '    "en"    - (not used: the chat is in Russian)'
        : '    "en"    - a Latin-script word (English plural/possessive is added automatically)';
    const list = keys.map(k => '- ' + k).join('\n');

    // Промпт правится в настройках (Форматы → Промпт ключей лорбука). Если плейсхолдер
    // {{KEYWORDS}} оттуда стёрли — ключи всё равно должны дойти до модели, дописываем в конец.
    let text = String(settings.prompt_keys || '').trim() || DEFAULT_PROMPT_KEYS;
    text = text.replace('{{EN_DECL}}', () => enDecl);
    return text.includes('{{KEYWORDS}}')
        ? text.replace('{{KEYWORDS}}', () => list)
        : `${text}\n\nKEYWORDS:\n${list}`;
}
