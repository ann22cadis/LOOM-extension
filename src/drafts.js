/**
 * Черновики LOOM: модель данных и хранение.
 *
 * Черновик — это карточка персонажа или лорбук в работе: текст, разбитый на абзацы,
 * плюс оценка и комментарий к каждому абзацу. Оценки живут ВМЕСТЕ с текстом и
 * переживают переписывание — из них строится история того, что пользователю зашло.
 */

import { getSettings, saveSettings, activeFormat, modernizeRegexKey } from './settings.js';

/** @typedef {{ text: string, rating: number, comment: string }} Block */
/** @typedef {{ id: string, label: string, blocks: Block[] }} Section */

export function uid() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeBlock(text) {
    return { text: String(text || '').trim(), rating: 0, comment: '' };
}

/**
 * Ответ модели → секции черновика.
 *
 * Порядок и подписи берём из ФОРМАТА, а не из ответа: модель может переставить ключи
 * местами или придумать лишний, а интерфейс должен показывать то, что настроил пользователь.
 *
 * @param {object} card объект вида { section_id: [абзац, …] }
 * @param {'character'|'lorebook'} kind
 * @param {string[]} [itemIds] если задано — строит секции только для этих id формата
 *   (частичное переписывание, см. splitApprovedSections); иначе берёт все активные пункты
 * @returns {Section[]}
 */
export function sectionsFromResponse(card, kind, itemIds = null) {
    const items = itemIds ? activeFormat(kind).filter(item => itemIds.includes(item.id)) : activeFormat(kind);
    return items.map(item => {
        const raw = card?.[item.id];
        // Модель нет-нет да и вернёт строку вместо массива — режем по пустой строке
        const paragraphs = Array.isArray(raw)
            ? raw
            : String(raw || '').split(/\n{2,}/);
        const blocks = paragraphs.map(makeBlock).filter(b => b.text);
        return { id: item.id, label: item.label, blocks };
    }).filter(section => section.blocks.length);
}

/**
 * Делит секции на «одобренные» (все абзацы набрали ≥ keepThreshold и без комментариев —
 * менять нечего) и «на переписывание» (всё остальное, включая пустые и никогда не
 * писавшиеся пункты). Одобренные в запрос к модели не попадают вовсе: пересказывать то,
 * что и так хорошо, — чистый расход токенов на самой дорогой части генерации, на ответе.
 *
 * @param {Section[]} sections
 * @param {number} keepThreshold порог «сохранить» (settings.rating_keep_threshold)
 * @returns {{ approved: Section[], toRewrite: Section[] }}
 */
export function splitApprovedSections(sections, keepThreshold) {
    const approved = [];
    const toRewrite = [];
    for (const section of sections || []) {
        const isApproved = section.blocks.length > 0 && section.blocks.every(block =>
            Number(block.rating) >= keepThreshold && !String(block.comment || '').trim());
        (isApproved ? approved : toRewrite).push(section);
    }
    return { approved, toRewrite };
}

/**
 * Собирает секции обратно в порядке ФОРМАТА: одобренные как есть + свежепереписанные.
 * Порядок важен для интерфейса — пункты не должны прыгать местами после переписывания.
 *
 * Секции с id, которого в текущем формате нет вовсе (например, импортированные из
 * готовой карточки Таверны — там поля вроде «description» не обязаны совпадать ни
 * с одним пунктом активного формата), не выбрасываются, а остаются в хвосте списка:
 * иначе любое переписывание тихо стирало бы всё, что формат не знает.
 */
export function mergeSections(kind, approved, rewritten) {
    const order = activeFormat(kind).map(item => item.id);
    const byId = new Map([...approved, ...rewritten].map(section => [section.id, section]));
    const known = order.map(id => byId.get(id)).filter(Boolean);
    const orderSet = new Set(order);
    const unknown = [...byId.values()].filter(section => !orderSet.has(section.id));
    return [...known, ...unknown];
}

/**
 * Переносит оценки со старой версии секций на новую.
 *
 * Абзацы после переписывания другие, поэтому по индексу переносить нельзя — это
 * приписало бы новому тексту чужую оценку. Сохраняем только то, что пользователь
 * подтвердил дословно: совпал текст — совпала и оценка.
 */
export function carryOverRatings(oldSections, newSections) {
    const byText = new Map();
    for (const section of oldSections || []) {
        for (const block of section.blocks) {
            if (block.rating || block.comment) byText.set(block.text.trim(), block);
        }
    }
    for (const section of newSections) {
        for (const block of section.blocks) {
            const previous = byText.get(block.text.trim());
            if (previous) {
                block.rating = previous.rating;
                block.comment = previous.comment;
            }
        }
    }
    return newSections;
}

/**
 * Снимок текущей версии — чтобы можно было откатиться после неудачного переписывания.
 *
 * Вызывается ПЕРЕД новой генерацией, то есть каждый вызов — это осознанный шаг вперёд,
 * а не откат. Поэтому он же чистит future (см. popHistory/redoHistory): пользователь
 * только что породил новую ветку из текущей версии, и «откатанные вперёд» версии,
 * которые вели бы в другую ветку, дальше не имеют смысла — как redo после нового
 * действия в любом текстовом редакторе.
 */
export function pushHistory(target) {
    if (!Array.isArray(target.history)) target.history = [];
    target.history.push({
        at: Date.now(),
        sections: structuredClone(target.sections || []),
    });
    // Больше пяти версий никто не отматывает, а settings.json растёт на каждую
    if (target.history.length > 5) target.history.shift();
    target.future = [];
}

/**
 * Снимок СПИСКА записей лорбука/пресета перед тем, как «Пересобрать план» стирает его
 * целиком вместе со всем написанным. Отдельно от pushHistory: та хранит секции одного
 * объекта, а тут снимается сразу весь draft.entries (записи со своими историями и
 * ссылками importedUid — при откате возвращается ровно то, что было).
 * Три снимка, а не пять: каждый — весь лорбук, settings.json растёт быстрее.
 */
export function pushEntriesHistory(draft) {
    if (!draft.entries?.length) return;
    if (!Array.isArray(draft.entriesHistory)) draft.entriesHistory = [];
    draft.entriesHistory.push({ at: Date.now(), entries: structuredClone(draft.entries) });
    if (draft.entriesHistory.length > 3) draft.entriesHistory.shift();
    draft.entriesFuture = [];
}

/** Откат плана на снимок назад; текущий список уходит в entriesFuture — как popHistory. */
export function popEntriesHistory(draft) {
    if (!Array.isArray(draft.entriesHistory) || !draft.entriesHistory.length) return false;
    if (!Array.isArray(draft.entriesFuture)) draft.entriesFuture = [];
    draft.entriesFuture.push({ at: Date.now(), entries: structuredClone(draft.entries || []) });
    draft.entries = draft.entriesHistory.pop().entries;
    return true;
}

export function redoEntriesHistory(draft) {
    if (!Array.isArray(draft.entriesFuture) || !draft.entriesFuture.length) return false;
    if (!Array.isArray(draft.entriesHistory)) draft.entriesHistory = [];
    draft.entriesHistory.push({ at: Date.now(), entries: structuredClone(draft.entries || []) });
    draft.entries = draft.entriesFuture.pop().entries;
    return true;
}

/**
 * История ШАГОВ сюжета (draft.steps) — тот же принцип, что у pushHistory/popHistory, но для
 * списка шагов, а не секций: «Составить заново», переписывание, удаление и перестановка шагов
 * стирают или меняют то, что уже правилось руками. Десять снимков — шаги короткие, места мало.
 */
export function pushStepsHistory(draft) {
    if (!draft.steps?.length) return;
    if (!Array.isArray(draft.stepsHistory)) draft.stepsHistory = [];
    draft.stepsHistory.push({ at: Date.now(), steps: structuredClone(draft.steps) });
    if (draft.stepsHistory.length > 10) draft.stepsHistory.shift();
    draft.stepsFuture = [];
}

export function popStepsHistory(draft) {
    if (!Array.isArray(draft.stepsHistory) || !draft.stepsHistory.length) return false;
    if (!Array.isArray(draft.stepsFuture)) draft.stepsFuture = [];
    draft.stepsFuture.push({ at: Date.now(), steps: structuredClone(draft.steps || []) });
    draft.steps = draft.stepsHistory.pop().steps;
    return true;
}

export function redoStepsHistory(draft) {
    if (!Array.isArray(draft.stepsFuture) || !draft.stepsFuture.length) return false;
    if (!Array.isArray(draft.stepsHistory)) draft.stepsHistory = [];
    draft.stepsHistory.push({ at: Date.now(), steps: structuredClone(draft.steps || []) });
    draft.steps = draft.stepsFuture.pop().steps;
    return true;
}

/**
 * Откат на версию назад. В отличие от старой реализации, ТЕКУЩАЯ версия перед
 * откатом не выбрасывается, а уходит в future — иначе «Откатить» дважды подряд
 * необратимо стирал самую свежую генерацию: пользователь откатывался, понимал,
 * что хотел как раз ту версию, а вернуться было уже некуда.
 */
export function popHistory(target) {
    if (!Array.isArray(target.history) || !target.history.length) return false;
    if (!Array.isArray(target.future)) target.future = [];
    target.future.push({ at: Date.now(), sections: structuredClone(target.sections || []) });
    target.sections = target.history.pop().sections;
    return true;
}

/** Шаг вперёд после отката — симметрично popHistory, тем же принципом «текущее не теряем». */
export function redoHistory(target) {
    if (!Array.isArray(target.future) || !target.future.length) return false;
    if (!Array.isArray(target.history)) target.history = [];
    target.history.push({ at: Date.now(), sections: structuredClone(target.sections || []) });
    target.sections = target.future.pop().sections;
    return true;
}

// ─── Хранилище ──────────────────────────────────────────────────────────────

/**
 * Черновики и записи, по которым миграция полей ниже уже прошла.
 *
 * listDrafts() зовут из currentDraft(), а его — из каждого обработчика ввода, то есть
 * на каждое нажатие клавиши в абзаце. Прогонять там два десятка проверок по всем
 * черновикам и всем записям каждого — работа, которая нужна ровно один раз на объект.
 *
 * WeakSet, а не флаг в самом объекте: поле осело бы в settings.json как мусор и уехало
 * бы в экспорт. И, в отличие от разового флага на модуль, здесь корректно мигрируют
 * объекты, появившиеся позже, — новый черновик, импорт из Таверны, перечитанные с диска
 * настройки: любой объект, которого в наборе ещё нет.
 */
const migrated = new WeakSet();

/**
 * Разбор пресета по жалобе («сухо», «как бот») — живёт внутри черновика пресета.
 * source — откуда взят разбираемый пресет: {kind: 'self'|'tavern'|'draft'|'file', label,
 * presetName (tavern), draftId (draft), digestId (file, id в IndexedDB — см. storeJson
 * в src/images.js)}. Сам пресет не копируется: источник перечитывается при каждой генерации.
 * Остальные поля — та же форма, что у черновика, чтобы работали pushHistory/feedbackDigest.
 */
export function emptyReview() {
    return { source: null, brief: '', notes: '', sections: [], history: [], future: [], iteration: 0, backups: [] };
}

export function listDrafts() {
    const settings = getSettings();
    if (!Array.isArray(settings.drafts)) settings.drafts = [];
    // Черновики, созданные до появления референсов, привязки персонажа и импорта
    // из Таверны, приходят без этих полей
    for (const draft of settings.drafts) {
        if (!migrated.has(draft)) {
            migrated.add(draft);
            if (!Array.isArray(draft.images)) draft.images = [];
            // К лорбуку можно привязать нескольких персонажей: раньше был один (characterId)
            if (!Array.isArray(draft.characterIds)) draft.characterIds = draft.characterId ? [draft.characterId] : [];
            delete draft.characterId;
            if (draft.memo === undefined) draft.memo = '';
            if (draft.personaId === undefined) draft.personaId = null;
            if (draft.importedAvatar === undefined) draft.importedAvatar = null;
            if (draft.importBackupAvatar === undefined) draft.importBackupAvatar = null;
            if (draft.importedWorld === undefined) draft.importedWorld = null;
            if (draft.importBackupWorld === undefined) draft.importBackupWorld = null;
            if (draft.wiPosition === undefined) draft.wiPosition = 0;
            if (draft.wiOrder === undefined) draft.wiOrder = 100;
            if (draft.wiDepth === undefined) draft.wiDepth = 4;
            if (draft.wiRole === undefined) draft.wiRole = 0;
            if (draft.wiFilterToCharacter === undefined) draft.wiFilterToCharacter = false;
            if (draft.mode === 'lorebook' && draft.wiPreventRecursion === undefined) draft.wiPreventRecursion = true;
            if (!Array.isArray(draft.future)) draft.future = [];
            if (!Array.isArray(draft.steps)) draft.steps = [];
            if (!Array.isArray(draft.stepsHistory)) draft.stepsHistory = [];
            if (!Array.isArray(draft.stepsFuture)) draft.stepsFuture = [];
            if (!Array.isArray(draft.entriesHistory)) draft.entriesHistory = [];
            if (!Array.isArray(draft.entriesFuture)) draft.entriesFuture = [];
            if (!Array.isArray(draft.ideas)) draft.ideas = [];
            if (draft.personaTitle === undefined) draft.personaTitle = '';
            // Анализ был отдельным режимом — теперь это разбор внутри черновика пресета
            if (draft.mode === 'analysis') {
                draft.mode = 'preset';
                draft.review = {
                    ...emptyReview(),
                    source: draft.reviewSource || null,
                    brief: draft.brief || '',
                    notes: draft.notes || '',
                    sections: draft.sections || [],
                    history: draft.history || [],
                    iteration: draft.iteration || 0,
                };
                draft.brief = '';
                draft.notes = '';
                draft.sections = [];
                draft.history = [];
                draft.future = [];
                draft.iteration = 0;
            }
            delete draft.reviewSource;
            if (draft.mode !== 'preset') delete draft.review;
            else if (!draft.review || typeof draft.review !== 'object') draft.review = emptyReview();
            // Флага раньше не было — восстанавливаем по следам, которые оставляет ТОЛЬКО
            // импорт: резервная копия и имя исходного лорбука. importedAvatar сюда не
            // годится — его выставляет и экспорт (см. importedFromTavern в createDraft).
            if (draft.importedFromTavern === undefined) {
                draft.importedFromTavern = !!(draft.importedWorld || draft.importBackupAvatar || draft.importBackupWorld);
            }
            // Импорт карточки из файла (src/file-import.js) — в обход Таверны совсем,
            // поэтому не пересекается с importedFromTavern: имя исходного файла тут,
            // а не имя аватара/бэкапа в Таверне, которых для такого черновика не было.
            if (draft.importedFromFile === undefined) draft.importedFromFile = null;
            // Другие варианты первого сообщения (alternate_greetings V2) — появились
            // позже основного поля, у старых черновиков персонажа массива вообще нет.
            // Сперва это были голые строки; каждый вариант получил свою идею и свою
            // кнопку «Написать» — старую строку заворачиваем в {text, idea: ''}.
            if (!Array.isArray(draft.altGreetings)) draft.altGreetings = [];
            draft.altGreetings = draft.altGreetings.map(g => (typeof g === 'string' ? { text: g, idea: '' } : g));
            // Идея для отдельного пункта сцены (id пункта формата → текст) — своя, более
            // конкретная, чем общая «Задумка» карточки. См. sceneBriefs в renderSceneItemBlock.
            if (!draft.sceneBriefs || typeof draft.sceneBriefs !== 'object') draft.sceneBriefs = {};
        }
        // Записи проверяем отдельно от родителя: в уже мигрированный лорбук
        // добавляют новые записи, и они тоже приходят без этих полей
        for (const entry of draft.entries || []) {
            if (migrated.has(entry)) continue;
            migrated.add(entry);
            if (!Array.isArray(entry.images)) entry.images = [];
            if (entry.importedUid === undefined) entry.importedUid = null;
            if (!Array.isArray(entry.future)) entry.future = [];
            if (entry.note === undefined) entry.note = '';
            if (!entry.wordCount) entry.wordCount = getSettings().lorebook_default_word_count || 300;
            if (draft.mode === 'preset' && entry.role === undefined) Object.assign(entry, presetEntryDelivery(entry));
            // Ключи, собранные старой версией, — в короткую запись (см. modernizeRegexKey)
            if (Array.isArray(entry.finalKeys)) entry.finalKeys = entry.finalKeys.map(modernizeRegexKey);
            if (Array.isArray(entry.keys)) entry.keys = entry.keys.map(modernizeRegexKey);
        }
    }
    return settings.drafts;
}

/**
 * Заменяет тексты абзацев переводом, сохраняя оценки.
 *
 * Перевод — это тот же абзац на другом языке, поэтому оценка к нему по-прежнему
 * относится; сопоставляем по позиции. Если модель изменила число абзацев, оценки
 * этого пункта сбрасываются: приписать их наугад хуже, чем потерять.
 *
 * @param {Array<{id: string, blocks: Array<object>}>} sections секции черновика (мутируются)
 * @param {Record<string, string[]>} translated ответ модели: id пункта → абзацы
 * @returns {number} сколько абзацев заменено
 */
export function applyTranslation(sections, translated) {
    let replaced = 0;

    for (const section of sections) {
        const texts = translated?.[section.id];
        if (!Array.isArray(texts) || !texts.length) continue;

        if (texts.length === section.blocks.length) {
            section.blocks.forEach((block, i) => {
                block.text = String(texts[i] ?? block.text).trim();
                replaced++;
            });
        } else {
            section.blocks = texts.map(makeBlock).filter(b => b.text);
            replaced += section.blocks.length;
        }
    }

    return replaced;
}

export function getDraft(id) {
    return listDrafts().find(d => d.id === id) || null;
}

/**
 * @param {'character'|'persona'|'lorebook'|'prompt'|'scenario'|'preset'} mode
 * @returns {object} новый черновик, уже добавленный в список
 */
export function createDraft(mode) {
    const draft = {
        id: uid(),
        mode,
        name: '',
        brief: '',
        notes: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        iteration: 0,
        // Персонаж: секции карточки. Лорбук: секции не используются, работают entries.
        sections: [],
        history: [],
        // Версии, от которых откатились — «Вперёд» возвращает отсюда (см. redoHistory)
        future: [],
        // Референсы: {id, name, thumb, note}. Сама картинка лежит в IndexedDB (src/images.js),
        // здесь только ссылка и превью — settings.json не место для мегабайтов base64.
        images: [],
        // Аватар будущей карточки: та же ссылка, но одна
        avatar: null,
        // Персона: подпись под именем в списке персон Таверны (её собственное поле
        // persona_descriptions[avatarId].title) — свободный текст вроде «AU» или
        // «не путать с основной», чтобы отличать похожие персоны в списке. В промпт
        // не идёт и на имя не влияет — см. exportPersona в src/export.js.
        personaTitle: '',
        // Лорбук: записи. У каждой — свои ключи, свои секции и своя история.
        entries: [],
        // Сценарий: черновой список коротких идей до проработки — {id, text}. Не пункты
        // формата: пользователь выбирает ОДНУ и переносит её текст в задумку (brief),
        // дальше она прорабатывается обычным путём в draft.sections. См. renderScenario
        // и generateScenarioIdeas в index.js.
        ideas: [],
        // Личная заметка к черновику — видна в списке, чтобы отличать похожие карточки.
        // Только для себя: в промпт и в Таверну не уходит.
        memo: '',
        // Персонажи и персона (id черновиков), для которых пишется этот лорбук — уходят
        // в промпт, чтобы модель не путала факты и не изобретала героев (или {{user}})
        // заново в каждой записи. Независимы: лорбук может быть привязан к нескольким
        // персонажам и персоне сразу, или ни к кому.
        characterIds: [],
        personaId: null,
        // Черновик импортирован из Таверны — см. src/tavern-import.js. importedAvatar/
        // importedWorld отмечают, ЧТО именно обновлять на месте при экспорте (вместо
        // создания дубликата); importBackup* — имя резервной копии оригинала, которую
        // Таверна сделала ДО первой правки в LOOM.
        importedAvatar: null,
        importBackupAvatar: null,
        importedWorld: null,
        importBackupWorld: null,
        // Черновик пришёл ИЗ Таверны (runTavernImport в index.js) — для метки в списке
        // и плашки в редакторе. Отдельный флаг, а не importedAvatar: тот выставляет и
        // экспорт (после первой выгрузки черновик привязан к файлу в Таверне), и по нему
        // созданный в LOOM персонаж ошибочно подписывался как импортированный.
        importedFromTavern: false,
        // Карточка пришла из файла — PNG или .json, в обход Таверны (src/file-import.js).
        // Имя исходного файла, для плашки в списке и редакторе; null — обычный черновик.
        importedFromFile: null,
        // Персонаж: другие варианты первого сообщения (alternate_greetings V2) —
        // {text, idea}[]: idea — необязательная задумка именно для этого варианта
        // (см. alternateGreetingPrompt в src/prompts.js), text — сам вариант, обычно
        // одна реплика, а не пункт формата с абзацами и оценками.
        altGreetings: [],
        // Сюжет: шаги арки — {id, title, goal, condition, complication}. stepCount — сколько
        // шагов просить у модели (0 — на её усмотрение). См. src/plot.js.
        steps: [],
        stepCount: 6,
        // Сюжет: сколько подпунктов просить у модели в каждом шаге (0 — на её усмотрение).
        subCount: 0,
        // Персонаж: идея для отдельного пункта сцены (id пункта формата → текст) — сценарий
        // и первое сообщение пишутся своим запросом, отдельно от общей «Задумки» карточки,
        // и им может понадобиться своя, более конкретная завязка (время, место, повод).
        sceneBriefs: {},
        // Лорбук: технические поля записи Таверны (world_info_position/order/depth/role) —
        // одни на весь лорбук, а не за каждую запись: в реальности весь лорбук почти всегда
        // живёт по одним правилам, а плодить пять одинаковых настроек на запись — только
        // загромождать интерфейс. См. exportLorebook в src/export.js.
        wiPosition: 0, // world_info_position: before(0) | after(1) | atDepth(4)
        wiOrder: 100,
        wiDepth: 4,
        wiRole: 0, // extension_prompt_roles: system(0) | user(1) | assistant(2), только для atDepth
        // Ограничить лорбук привязанными персонажами (draft.characterIds) — сработает только
        // в их чатах. Имеет смысл, только пока хоть один персонаж привязан.
        wiFilterToCharacter: false,
        // Лорбук: записи не включают друг друга — текст сработавшей записи не сканируется на
        // ключи других (preventRecursion Таверны). Иначе одна запись о кузнеце тянет князя,
        // князь — город, город — стражу, и в любой сцене активен весь лорбук.
        wiPreventRecursion: mode === 'lorebook',
        // Пресет: разбор по жалобе пользователя — см. emptyReview.
        ...(mode === 'preset' ? { review: emptyReview() } : {}),
    };
    listDrafts().unshift(draft);
    saveSettings();
    return draft;
}

/**
 * В черновике ничего не написано и ничего не выбрано — такой удаляется сам, как только
 * из него уходят (см. dropIfEmpty в index.js). Иначе каждый случайный клик по режиму
 * оставлял в списке «Без имени · 0 абз.».
 */
export function isDraftEmpty(draft) {
    if (!draft) return false;
    const filled = value => String(value ?? '').trim() !== '';
    const review = draft.review;
    return !filled(draft.name) && !filled(draft.brief) && !filled(draft.notes) && !filled(draft.personaTitle)
        && !filled(draft.memo)
        && !draft.sections?.length && !draft.entries?.length && !draft.ideas?.length
        && !draft.altGreetings?.some(g => filled(g?.text) || filled(g?.idea))
        && !draft.steps?.length
        && !Object.values(draft.sceneBriefs || {}).some(filled)
        && !draft.images?.length && !draft.avatar
        && !draft.characterIds?.length && !draft.personaId
        && !draft.importedFromTavern && !draft.importedFromFile && !draft.importedAvatar && !draft.importedWorld
        && (!review || (!filled(review.brief) && !filled(review.notes) && !review.sections?.length
            && !review.source?.presetName && !review.source?.draftId && !review.source?.digestId));
}

/**
 * Копия черновика — только данные, без картинок (их дублирует вызывающий код, см.
 * duplicateDraft в index.js: IndexedDB асинхронный).
 *
 * Что НЕ переносится и почему:
 * - привязка к файлу/лорбуку/пресету в Таверне (importedAvatar, importedWorld, importBackup*,
 *   importedUid записей) — иначе экспорт копии обновил бы на месте оригинал в Таверне;
 * - метка «Таверна»: копия сделана в LOOM;
 * - история версий («Откатить»): раздула бы settings.json вдвое ради отката, который
 *   у копии начинается с чистого листа.
 * @returns {object} новый черновик, ещё НЕ добавленный в список
 */
export function cloneDraftData(source) {
    const copy = structuredClone(source);
    const now = Date.now();
    copy.id = uid();
    copy.name = String(source.name || '').trim() ? `${String(source.name).trim()} (копия)` : '';
    copy.createdAt = now;
    copy.updatedAt = now;
    copy.importedAvatar = null;
    copy.importBackupAvatar = null;
    copy.importedWorld = null;
    copy.importBackupWorld = null;
    copy.importedFromTavern = false;
    copy.importedFromFile = null;
    copy.history = [];
    copy.future = [];
    // Снимки плана несут старые importedUid записей — копия не должна их унаследовать
    copy.entriesHistory = [];
    copy.entriesFuture = [];
    copy.stepsHistory = [];
    copy.stepsFuture = [];
    for (const entry of copy.entries || []) {
        entry.id = uid();
        entry.importedUid = null;
        entry.history = [];
        entry.future = [];
    }
    if (copy.review) {
        copy.review.history = [];
        copy.review.future = [];
        copy.review.backups = [];
    }
    return copy;
}

/** Вставляет копию сразу после оригинала — рядом её проще найти, чем в начале списка. */
export function insertDraftAfter(sourceId, draft) {
    const drafts = listDrafts();
    const index = drafts.findIndex(d => d.id === sourceId);
    drafts.splice(index === -1 ? 0 : index + 1, 0, draft);
    saveSettings();
    return draft;
}

export function touchDraft(draft) {
    draft.updatedAt = Date.now();
    saveSettings();
}

export function deleteDraft(id) {
    const drafts = listDrafts();
    const idx = drafts.findIndex(d => d.id === id);
    if (idx !== -1) drafts.splice(idx, 1);
    // Не оставляем лорбуки привязанными к персонажу или персоне, которых больше нет
    for (const draft of drafts) {
        if (draft.characterIds?.includes(id)) draft.characterIds = draft.characterIds.filter(x => x !== id);
        if (draft.personaId === id) draft.personaId = null;
    }
    saveSettings();
}

/** @returns {object} новая запись лорбука */
export function createEntry(draft, data = {}) {
    const entry = {
        id: uid(),
        title: String(data.title || 'Без названия'),
        // Один из id LOREBOOK_CATEGORIES (settings.js) — но поле остаётся свободной
        // строкой, а не проверяется по списку: старое/нераспознанное значение просто
        // не получит категорийную подсказку в промпте, без падений (см. prompts.js).
        category: String(data.category || ''),
        seed: String(data.seed || ''),
        // Комментарий пользователя к ЭТОЙ записи — задаётся на этапе плана или позже,
        // уходит в промпт при написании/переписывании (см. lorebookEntryPrompt и рядом).
        note: String(data.note || ''),
        // Целевой объём записи в словах — ползунок в интерфейсе, по умолчанию из
        // настройки, ту же величину модель получает как длину/распорядок абзацев.
        wordCount: Number(data.wordCount) || getSettings().lorebook_default_word_count || 300,
        keys: Array.isArray(data.keys) ? data.keys.map(String) : [],
        // Готовые ключи для лорбука: сюда попадают и regex-варианты, собранные из keys
        finalKeys: [],
        sections: [],
        history: [],
        future: [],
        images: [],
        constant: false,
        // Запись, созданная в LOOM, — не импортирована ниоткуда. Импортированные
        // записи получают свой uid в src/tavern-import.js — export.js обновляет
        // ту же запись Таверны на месте вместо создания дубликата.
        importedUid: null,
    };
    if (draft.mode === 'preset') Object.assign(entry, presetEntryDelivery(data));
    draft.entries.push(entry);
    return entry;
}

/**
 * Как блок пресета уходит в запрос — те же поля, что у prompts[] Таверны:
 * role — от чьего имени сообщение (system/user/assistant);
 * injectionPosition — 0: на своём месте в списке Prompt Manager, 1: внутрь чата на глубину;
 * injectionDepth — на сколько сообщений от конца чата (только для позиции 1).
 */
export function presetEntryDelivery(data = {}) {
    const role = ['system', 'user', 'assistant'].includes(data.role) ? data.role : 'system';
    const depth = Number(data.injectionDepth);
    return {
        role,
        injectionPosition: Number(data.injectionPosition) === 1 ? 1 : 0,
        injectionDepth: Number.isFinite(depth) && depth >= 0 ? Math.round(depth) : 4,
    };
}

/** Средняя оценка по всем оценённым абзацам — показатель «на сколько карточка готова». */
export function averageRating(sections) {
    const rated = [];
    for (const section of sections || []) {
        for (const block of section.blocks) {
            if (block.rating) rated.push(block.rating);
        }
    }
    if (!rated.length) return null;
    return rated.reduce((a, b) => a + b, 0) / rated.length;
}

export function countBlocks(sections) {
    return (sections || []).reduce((sum, s) => sum + s.blocks.length, 0);
}
