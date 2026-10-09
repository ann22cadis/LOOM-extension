/**
 * Экспорт черновиков LOOM в саму Таверну.
 *
 * Персонаж уходит как карточка V2 через /api/characters/import — тот же путь, которым
 * Таверна импортирует json-карточки, поэтому результат неотличим от обычного импорта.
 * Лорбук пишется через saveWorldInfo из контекста.
 */

import { createWorldInfoEntry } from '../../../../world-info.js';
import { getUserAvatars, getUserAvatar, setPersonaDescription, user_avatar } from '../../../../personas.js';
// Живой список пресетов Chat Completion и карта имя→индекс — то же самое, что
// preset-manager.js Таверны читает сам, только напрямую: ctx отдаёт лишь АКТИВНЫЙ
// пресет (chatCompletionSettings), а найти по имени произвольный, необязательно
// активный, можно только так же, как это делает сама Таверна. См. exportPreset ниже.
import { openai_settings, openai_setting_names } from '../../../../openai.js';
import { getThumbnailUrl } from '../../../../../script.js';
import { getSettings } from './settings.js';
import { compileKeys } from './keys.js';
import { getDraft } from './drafts.js';

/**
 * Заставляет браузер немедленно перечитать превью с сервера, а не отдать то, что уже
 * лежит в его собственном HTTP-кэше под тем же URL. Файл на диске сервер уже обновил
 * (см. invalidateThumbnail на бэкенде), но адрес превью не меняется — имя файла то же
 * самое, — и браузер годами показывает старые байты, пока что-нибудь не заставит его
 * перезапросить их явно. `cache: 'reload'` — тот же приём, которым сама Таверна
 * прогревает кэш после смены аватара персоны или персонажа (см. personas.js/script.js).
 * Ошибка здесь не критична: картинка на всех экранах просто обновится с опозданием,
 * до следующей перезагрузки страницы.
 */
async function warmThumbnail(type, file) {
    try {
        await fetch(getThumbnailUrl(type, file), { cache: 'reload' });
        // Персона отдаёт message.force_avatar как ссылку на ИСХОДНЫЙ файл, не превью
        // (см. force_avatar в script.js) — сообщения в чате читают этот адрес напрямую
        if (type === 'persona') await fetch(getUserAvatar(file), { cache: 'reload' });
    } catch (error) {
        console.warn('[LOOM] Не удалось прогреть кэш превью', type, file, error);
    }
}

/**
 * Один пример диалога → вид, который ждёт Таверна: первая строка <START>, реплики по одной
 * на строку, без пустых строк внутри. Модель иногда забывает <START> или пишет его строчными.
 */
export function normalizeExample(text) {
    let t = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!t) return '';
    t = t.replace(/\n\s*\n+/g, '\n');
    if (/^<start>/i.test(t)) return t.replace(/^<start>/i, '<START>');
    return `<START>\n${t}`;
}

/** Секции черновика → поля карточки V2, согласно target каждого пункта формата. */
function sectionsToCardFields(draft) {
    const settings = getSettings();
    const formatById = new Map(settings.character_format.map(item => [item.id, item]));
    const fields = {
        description: [],
        personality: [],
        scenario: [],
        first_mes: [],
        mes_example: [],
        creator_notes: [],
    };

    for (const section of draft.sections) {
        // Секция может быть импортирована из готовой карточки Таверны и не совпадать
        // ни с одним пунктом ТЕКУЩЕГО формата (см. src/tavern-import.js) — тогда её id
        // это и есть имя поля V2 (description/personality/scenario/…), берём как есть,
        // а не сваливаем по умолчанию в description.
        const target = formatById.get(section.id)?.target
            ?? (section.id in fields ? section.id : 'description');
        if (target === 'skip' || !fields[target]) continue;

        // «Examples of dialogue»: у поля свой формат, а не абзацы через пустую строку
        const body = target === 'mes_example'
            ? section.blocks.map(b => normalizeExample(b.text)).filter(Boolean).join('\n')
            : section.blocks.map(b => b.text).join('\n\n');
        if (!body.trim()) continue;

        // Заголовок нужен только там, где в одно поле сливается несколько пунктов.
        // В first_mes он бы просто испортил первую реплику.
        const needsHeading = target === 'description' || target === 'creator_notes';
        fields[target].push(needsHeading ? `[${section.label}]\n${body}` : body);
    }

    return {
        ...Object.fromEntries(Object.entries(fields).map(([key, parts]) => [key, parts.join('\n\n')])),
        // Другие варианты первого сообщения (draft.altGreetings, см. src/drafts.js) —
        // не пункт формата, отдельное поле черновика, поэтому не проходит через цикл
        // выше и не мешается с обычными секциями. idea (задумка для конкретного
        // варианта) — служебное поле интерфейса, в карточку не идёт, только text.
        alternate_greetings: (draft.altGreetings || []).map(g => String(g?.text || '').trim()).filter(Boolean),
    };
}

/** @returns {object} карточка персонажа в формате Character Card V2 */
export function buildCharacterCard(draft) {
    const fields = sectionsToCardFields(draft);
    const name = String(draft.name || 'Безымянный').trim();

    const data = {
        name,
        description: fields.description,
        personality: fields.personality,
        scenario: fields.scenario,
        first_mes: fields.first_mes,
        mes_example: fields.mes_example,
        creator_notes: [fields.creator_notes, draft.brief ? `Задумка:\n${draft.brief}` : '']
            .filter(Boolean).join('\n\n'),
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: fields.alternate_greetings,
        character_book: undefined,
        tags: ['LOOM'],
        creator: 'LOOM',
        character_version: String(draft.iteration || 1),
        extensions: {},
    };

    // V2 дублирует часть полей в корне — старые парсеры читают только их
    return {
        name: data.name,
        description: data.description,
        personality: data.personality,
        scenario: data.scenario,
        first_mes: data.first_mes,
        mes_example: data.mes_example,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data,
    };
}

/**
 * Обновляет УЖЕ СУЩЕСТВУЮЩЕГО персонажа Таверны на месте — тот же файл, тот же аватар,
 * только текстовые поля меняются. Резервная копия оригинала делается при импорте
 * (см. src/tavern-import.js: draft.importBackupAvatar), поэтому здесь можно спокойно
 * писать поверх — оригинал уже сохранён отдельным файлом ДО первого изменения.
 *
 * Картинку карточки эта ветка не трогает: merge-attributes меняет только JSON внутри
 * PNG, не сам портрет. Новый портрет — через «Скачать PNG» и ручной re-import.
 *
 * @param {object} draft
 * @returns {Promise<string>} имя файла аватара (то же, что было)
 */
/**
 * @param {object} draft
 * @param {Uint8Array|null} avatarPng новая картинка карточки, уже готовым PNG (см.
 *   src/png.js). Не передаётся в /api/characters/merge-attributes ниже — этот эндпоинт
 *   правит только текстовые поля внутри уже существующего файла и байты картинки
 *   в нём не трогает, поэтому картинку заливаем отдельным запросом.
 */
async function updateCharacterInPlace(draft, avatarPng) {
    const ctx = SillyTavern.getContext();
    const card = buildCharacterCard(draft);

    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({
            avatar: draft.importedAvatar,
            name: card.name,
            data: {
                name: card.data.name,
                description: card.data.description,
                personality: card.data.personality,
                scenario: card.data.scenario,
                first_mes: card.data.first_mes,
                mes_example: card.data.mes_example,
                creator_notes: card.data.creator_notes,
                alternate_greetings: card.data.alternate_greetings,
            },
        }),
    });

    if (!response.ok) {
        const message = await response.json().catch(() => null);
        throw new Error(message?.message || `Таверна отклонила обновление: ${response.statusText}`);
    }

    // Картинку меняем, только если в черновике она есть: нет своей — оставляем ту,
    // что у карточки уже есть в Таверне, а не стираем её заглушкой.
    if (avatarPng) {
        const file = new File([avatarPng], 'avatar.png', { type: 'image/png' });
        const formData = new FormData();
        formData.append('avatar', file);
        formData.append('avatar_url', draft.importedAvatar);

        const imgResponse = await fetch('/api/characters/edit-avatar', {
            method: 'POST',
            headers: ctx.getRequestHeaders({ omitContentType: true }),
            cache: 'no-cache',
            body: formData,
        });
        if (!imgResponse.ok) throw new Error(`Таверна отклонила загрузку картинки: ${imgResponse.statusText}`);
        await warmThumbnail('avatar', draft.importedAvatar);
    }

    await ctx.getCharacters();
    return draft.importedAvatar;
}

/**
 * Создаёт персонажа в Таверне — или, если черновик импортирован ОТТУДА
 * (draft.importedAvatar) и файл всё ещё существует, обновляет тот же файл на месте
 * вместо создания дубликата.
 *
 * Файла может и не быть: пользователь мог удалить карточку прямо в Таверне (например,
 * когда обновление на месте почему-то не проходило и карточку почистили руками, чтобы
 * начать заново). Долбиться обновлением в удалённый файл бессмысленно — Таверна просто
 * будет каждый раз отвечать ошибкой валидации, а второго способа экспортировать
 * («забыть» старую привязку) в интерфейсе нет. Поэтому перед обновлением проверяем,
 * жив ли файл, и если нет — заводим карточку заново, как при самом первом экспорте.
 *
 * @param {object} draft
 * @param {Uint8Array} [avatarPng] карточка, уже вписанная в PNG (см. src/png.js).
 *   Есть картинка — импортируем как png, и в Таверне карточка сразу с портретом;
 *   нет — уходит json, и Таверна подставит заглушку. Игнорируется при обновлении
 *   на месте — см. updateCharacterInPlace.
 * @returns {Promise<{avatar: string, created: boolean}>} имя файла аватара и признак,
 *   что это НОВЫЙ файл (а не обновление старого) — вызывающий код решает по нему,
 *   какой тост показать, и в любом случае обязан пере-записать draft.importedAvatar
 *   этим значением: при авто-пересоздании оно отличается от прежнего.
 */
/**
 * /api/characters/import отвечает именем файла БЕЗ расширения («Ло»), а в списке Таверны
 * аватар лежит с ним («Ло.png»). Без приведения привязка не находила персонажа, и каждое
 * «Обновить в Таверне» заводило нового — дубли. Старые черновики хранят имя без .png.
 */
export function characterAvatarFile(name) {
    const value = String(name || '').trim();
    if (!value) return '';
    return /\.(png|webp|jpe?g|gif)$/i.test(value) ? value : `${value}.png`;
}

export async function exportCharacter(draft, avatarPng = null) {
    const ctx = SillyTavern.getContext();

    if (draft.importedAvatar) {
        draft.importedAvatar = characterAvatarFile(draft.importedAvatar);
        await ctx.getCharacters();
        const stillExists = ctx.characters.some(c => c.avatar === draft.importedAvatar);
        if (stillExists) return { avatar: await updateCharacterInPlace(draft, avatarPng), created: false };
    }

    const card = buildCharacterCard(draft);

    const safeName = (card.name || 'character').replace(/[\\/:*?"<>|]/g, '_');
    const file = avatarPng
        ? new File([avatarPng], `${safeName}.png`, { type: 'image/png' })
        : new File([JSON.stringify(card, null, 2)], `${safeName}.json`, { type: 'application/json' });

    const formData = new FormData();
    formData.append('avatar', file);
    formData.append('file_type', avatarPng ? 'png' : 'json');
    formData.append('user_name', ctx.name1 || 'User');

    const response = await fetch('/api/characters/import', {
        method: 'POST',
        body: formData,
        headers: ctx.getRequestHeaders({ omitContentType: true }),
        cache: 'no-cache',
    });

    if (!response.ok) throw new Error(`Таверна отклонила импорт: ${response.statusText}`);
    const result = await response.json();
    if (result?.error) throw new Error('Таверна вернула ошибку при импорте карточки.');

    await ctx.getCharacters();
    return { avatar: characterAvatarFile(result.file_name), created: true };
}

/**
 * Аватар привязанного персонажа → имя для character_filter записи Таверны.
 * Таверна матчит фильтр по имени файла БЕЗ расширения (см. fillCharacterAndTagOptionsHelper
 * в world-info.js), не по отображаемому имени — поэтому нужен именно importedAvatar,
 * а не draft.name персонажа.
 * @returns {{names: string[], missing: string[]}} names — имена файлов для фильтра; missing —
 *   отображаемые имена привязанных персонажей, которых ещё нет в Таверне
 */
function resolveCharacterFilterNames(characterIds) {
    const names = [];
    const missing = [];
    for (const id of characterIds || []) {
        const character = getDraft(id);
        if (!character) continue;
        if (character.importedAvatar) names.push(characterAvatarFile(character.importedAvatar).replace(/\.[^/.]+$/, ''));
        else missing.push(character.name || 'Без имени');
    }
    return { names, missing };
}

/**
 * Записывает черновик лорбука в world info.
 * @param {object} draft
 * @param {string} worldName имя лорбука
 * @returns {Promise<{name: string, written: number, filterMissing: string[]}>}
 *   filterMissing — включена привязка к персонажам, но у кого-то из них ещё нет аватара
 *   в Таверне (не экспортирован и не импортирован оттуда): фильтр не к чему привязать.
 *   Тогда он не ставится совсем, а не только по остальным — иначе лорбук молчал бы
 *   в чатах с теми, кого в фильтр не попало.
 */
export async function exportLorebook(draft, worldName) {
    const ctx = SillyTavern.getContext();
    const name = String(worldName || draft.name || 'LOOM').trim();
    if (!name) throw new Error('Не указано имя лорбука.');

    // Существующий лорбук дополняем, а не затираем: пользователь мог дописать записи руками
    let data = null;
    try {
        data = await ctx.loadWorldInfo(name);
    } catch { /* нет такого лорбука — создадим */ }
    if (!data || typeof data !== 'object' || !data.entries) data = { entries: {} };

    const position = Number(draft.wiPosition) || 0;
    const order = Number(draft.wiOrder) || 100;
    const filter = draft.wiFilterToCharacter
        ? resolveCharacterFilterNames(draft.characterIds)
        : { names: [], missing: [] };
    const filterMissing = filter.missing;
    const characterFilterNames = filterMissing.length ? [] : filter.names;

    let written = 0;
    let updated = 0;
    const newLinks = [];      // [запись LOOM, uid новой записи Таверны] — запомним после подтверждённого сохранения
    const writtenUids = [];
    for (const entry of draft.entries) {
        const content = entry.sections
            .map(section => section.blocks.map(b => b.text).join('\n\n'))
            .filter(text => text.trim())
            .join('\n\n');
        if (!content.trim()) continue;

        // Запись уже писалась в ЭТОТ ЖЕ лорбук раньше (импортирована оттуда — importedUid
        // из src/tavern-import.js, — или уже экспортировалась отсюда LOOM'ом раньше, см.
        // присвоение ниже) — обновляем тот же uid на месте, а не создаём рядом дубликат.
        // Без этого повторный экспорт плодил бы копию КАЖДОЙ записи при каждом клике.
        const existing = entry.importedUid != null && data.entries[entry.importedUid];
        const wiEntry = existing || createWorldInfoEntry(name, data);
        if (!wiEntry) throw new Error('Не удалось создать запись лорбука.');
        // uid для следующего экспорта запоминаем ТОЛЬКО после того, как сервер подтвердил
        // сохранение (ниже): при сбое запись Таверны не появилась, а запомненный uid потом
        // указал бы на чужую запись, заведённую там позже, — и перезаписал бы её.
        // Актуален, пока цель экспорта (имя лорбука) не поменялась; смена имени целевого
        // лорбука — редкий ручной случай, тогда придётся один раз пережить дубликат.
        if (!existing) newLinks.push([entry, wiEntry.uid]); else updated++;
        writtenUids.push(wiEntry.uid);

        // finalKeys заполняются на шаге «Собрать ключи»; если туда не заходили,
        // компилируем на лету из простых ключей
        wiEntry.key = (entry.finalKeys?.length ? entry.finalKeys : compileKeys(entry.keys));
        wiEntry.comment = entry.title;
        wiEntry.content = content;
        wiEntry.constant = !!entry.constant;
        // Флаг Таверны «Prevent further recursion»: текст этой записи не ищется на ключи других
        wiEntry.preventRecursion = draft.wiPreventRecursion !== false;
        wiEntry.position = position;
        wiEntry.order = order;
        if (position === 4) {
            wiEntry.depth = Number(draft.wiDepth) || 4;
            wiEntry.role = Number(draft.wiRole) || 0;
        }
        if (characterFilterNames.length) {
            wiEntry.characterFilter = { isExclude: false, names: [...characterFilterNames], tags: [] };
        } else {
            delete wiEntry.characterFilter;
        }
        written++;
    }

    if (!written) throw new Error('В черновике нет ни одной записи с текстом.');

    // Собственный uid каждой записи (getFreeWorldEntryUid внутри createWorldInfoEntry) —
    // по нему проверяем, что запись реально долетела до диска, а не просто осталась
    // в локальном объекте, который мы сами держим в руках.
    const expectedUids = writtenUids;

    await ctx.saveWorldInfo(name, data, true);
    // saveWorldInfo(..., true) идёт через Таверну — а её собственный _save() шлёт fetch
    // без проверки response.ok: если запрос упадёт на сервере, ни Таверна, ни LOOM об
    // этом не узнают, и тост «сохранено» окажется неправдой. Перепроверяем не по кэшу
    // (loadWorldInfo вернул бы тот же объект, который мы только что держали в руках, —
    // это ничего не докажет), а прямым запросом к серверу, как это делает сама Таверна
    // при первой загрузке.
    await verifyLorebookSaved(ctx, name, expectedUids);
    for (const [entry, uid] of newLinks) entry.importedUid = uid;
    await ctx.updateWorldInfoList();
    // Записи на диске уже новые, но открытый редактор World Info рисует то, что прочитал
    // при открытии, — и повторный экспорт выглядит так, будто ничего не произошло.
    // Хуже того, дальнейшая правка в этом устаревшем редакторе сохранила бы поверх нас
    // старый текст. Перечитываем редактор, если открыт именно этот лорбук.
    ctx.reloadWorldInfoEditor?.(name);
    return { name, written, updated, added: written - updated, filterMissing };
}

/**
 * Прямой (не из кэша) запрос к серверу — подтверждает, что записи реально сохранились,
 * а не просто «не бросили исключение». См. комментарий в exportLorebook.
 * @throws {Error} если сервер не подтвердил сохранение хотя бы одной из записей
 */
async function verifyLorebookSaved(ctx, name, expectedUids) {
    if (!expectedUids.length) return;

    let response;
    try {
        response = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ name }),
            cache: 'no-cache',
        });
    } catch (e) {
        throw new Error(`Не удалось проверить, сохранился ли лорбук «${name}»: ${e.message || e}.`);
    }
    if (!response.ok) {
        throw new Error(`Таверна не подтвердила сохранение лорбука «${name}» (HTTP ${response.status}). `
            + 'Записи могли не сохраниться — проверьте лорбук в Таверне и повторите экспорт.');
    }

    const saved = await response.json().catch(() => null);
    const missing = expectedUids.filter(uid => !saved?.entries?.[uid]);
    if (missing.length) {
        throw new Error(`Таверна не сохранила ${missing.length} из ${expectedUids.length} записей лорбука «${name}». `
            + 'Похоже на сбой сохранения на её стороне — повторите экспорт.');
    }
}

/**
 * Основа для нового пресета: берём уже существующий пресет с ТЕМ ЖЕ именем — тот же
 * принцип, что и у лорбука (exportLorebook грузит существующий мир по имени, а не
 * создаёт поверх активного) — технические поля (сэмплеры, модель и всё остальное,
 * что LOOM не пишет и не выдумывает) остаются как в нём. Такого пресета ещё нет —
 * берём АКТИВНЫЙ сейчас пресет как разумную стартовую точку, ровно как делал бы
 * человек через «Сохранить как…» в самой Таверне.
 */
function baseOpenAiPreset(name, isActive = false) {
    // Целевой пресет сейчас выбран в Таверне — берём ЖИВЫЕ настройки, а не файл: после
    // сохранения Таверна перечитает пресет, и всё, что пользователь успел переключить в
    // Prompt Manager, но не сохранил («Обновить пресет»), иначе молча откатилось бы к файлу.
    const live = SillyTavern.getContext().chatCompletionSettings;
    if (isActive && live) return structuredClone(live);
    const index = openai_setting_names[name];
    const existing = index !== undefined ? openai_settings[index] : null;
    return structuredClone(existing || live || {});
}

/**
 * Черновик пресета → готовый объект для /api/presets/save (apiId: 'openai').
 *
 * НЕ трогает ничего, кроме своих же блоков: сэмплеры, модель, остальные prompts[]
 * (написанные не LOOM'ом) и порядок для уже существующих блоков остаются как были.
 * Каждый блок черновика — это ОДИН именованный prompts[]-элемент, найденный или
 * заведённый по entry.importedUid (тот же принцип «обновляем на месте», что и у
 * записи лорбука — см. exportLorebook), а не целый пресет с нуля.
 *
 * В prompt_order блок добавляется, но ВЫКЛЮЧЕННЫМ — так же, как в реальных пресетах
 * пользователя лежит библиотека написанных заранее блоков (цензура, NSFW, разные
 * инструкции), которые включают точечно под конкретную ситуацию, а не все разом.
 * Автоматически включать написанное LOOM'ом в промпт по умолчанию значило бы менять
 * поведение будущих чатов без явного решения пользователя — этого делать нельзя.
 *
 * @param {object} draft
 * @param {string} name имя целевого пресета
 * @returns {{preset: object, written: number}}
 */
/** Тот же текст с точностью до пустых строк между абзацами и пробелов по краям. */
function sameParagraphs(a, b) {
    const norm = text => String(text || '').trim().split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).join('\n\n');
    return norm(a) === norm(b);
}

export function buildOpenAiPreset(draft, name, isActive = false) {
    const preset = baseOpenAiPreset(name, isActive);
    if (!Array.isArray(preset.prompts)) preset.prompts = [];
    if (!Array.isArray(preset.prompt_order)) preset.prompt_order = [];

    let written = 0;
    for (const entry of draft.entries) {
        const content = entry.sections
            .map(section => section.blocks.map(b => b.text).join('\n\n'))
            .filter(text => text.trim())
            .join('\n\n');
        if (!content.trim()) continue;

        // importedUid тут — identifier prompts[]-блока в Таверне, тот же принцип,
        // что importedUid записи лорбука: раз выданный, переживает любой следующий
        // экспорт этого же черновика, старый блок обновляется на месте, а не дублируется.
        entry.importedUid = entry.importedUid || crypto.randomUUID();
        const identifier = entry.importedUid;

        const index = preset.prompts.findIndex(p => p.identifier === identifier);
        const inChat = Number(entry.injectionPosition) === 1;
        const wanted = {
            name: entry.title || 'Без названия',
            role: ['system', 'user', 'assistant'].includes(entry.role) ? entry.role : 'system',
            content,
            injection_position: inChat ? 1 : 0,
            injection_depth: inChat ? Math.max(0, Number(entry.injectionDepth) || 0) : 4,
        };

        if (index === -1) {
            // system_prompt: true — флаг ВСТРОЕННЫХ пунктов Таверны (Main Prompt, NSFW…),
            // таких не удалить из Prompt Manager. Свои блоки там создаются с false.
            const prompt = { identifier, ...wanted, system_prompt: false, marker: false };
            // В порядок (Prompt Manager) добавляем только НОВЫЕ блоки. Уже существующий блок мог
            // лежать в пресете «про запас», вне списка, — это решение пользователя, не наше.
            preset.prompts.push(prompt);
            for (const order of preset.prompt_order) {
                if (!Array.isArray(order.order)) order.order = [];
                if (!order.order.some(o => o.identifier === identifier)) {
                    order.order.push({ identifier, enabled: false });
                }
            }
        } else {
            // Существующий блок: меняем только то, что реально отличается, — иначе в файл
            // пресета попадали бы поля, которых там не было (marker, позиция по умолчанию),
            // а текст неправленого блока — с пустыми строками, склеенными по-нашему
            const prompt = preset.prompts[index];
            const current = {
                name: prompt.name,
                role: prompt.role || 'system',
                content: prompt.content,
                injection_position: Number(prompt.injection_position) === 1 ? 1 : 0,
                injection_depth: prompt.injection_depth ?? 4,
            };
            for (const [key, value] of Object.entries(wanted)) {
                if (key === 'content' && sameParagraphs(current.content, value)) continue;
                if (key === 'injection_depth' && !inChat) continue;
                if (current[key] !== value) prompt[key] = value;
            }
        }
        written++;
    }

    return { preset, written };
}

/**
 * Сохраняет черновик пресета в Таверну — через её же PresetManager (не голый fetch,
 * как у лорбука/персонажа): он и шлёт /api/presets/save, и сам обновляет выпадающий
 * список пресетов в интерфейсе — без этого новый пресет появился бы в списке только
 * после перезагрузки страницы (та же ловушка, что чинили для персон, см. exportPersona).
 *
 * @param {object} draft
 * @param {string} name имя целевого пресета — новый заводится, существующий дополняется
 * @returns {Promise<{name: string, written: number}>}
 */
export async function exportPreset(draft, name) {
    const targetName = String(name || draft.name || '').trim();
    if (!targetName) throw new Error('Не указано имя пресета.');

    const ctx = SillyTavern.getContext();
    const manager = ctx.getPresetManager?.('openai');
    if (!manager) throw new Error('В этой сборке Таверны недоступны пресеты Chat Completion.');

    const isActive = manager.getSelectedPresetName() === targetName;
    const { preset, written } = buildOpenAiPreset(draft, targetName, isActive);
    if (!written) throw new Error('В черновике нет ни одного блока с текстом.');

    await writePreset(manager, targetName, preset, isActive);
    return { name: targetName, written, isActive };
}

/**
 * Пишет объект пресета через PresetManager Таверны.
 *
 * savePreset() Таверны без skipUpdate ещё и ПЕРЕКЛЮЧАЕТ выпадающий список на
 * сохранённый пресет. Раньше LOOM переключал обратно — но каждое такое переключение
 * перечитывает пресет из файла, и несохранённые правки активного пресета (галочки
 * в Prompt Manager) молча пропадали. Поэтому пишем файл без переключения, а список
 * в памяти Таверны обновляем сами — тем же способом, что её updateList().
 */
async function writePreset(manager, targetName, preset, isActive) {
    await manager.savePreset(targetName, preset, { skipUpdate: true });
    const { presets, preset_names } = manager.getPresetList();
    if (Object.hasOwn(preset_names, targetName)) {
        presets[preset_names[targetName]] = preset;
    } else {
        presets.push(preset);
        preset_names[targetName] = presets.length - 1;
        $(manager.select).append($('<option></option>', { value: presets.length - 1, text: targetName }));
    }
    // Писали в активный пресет — перечитываем его, чтобы правка сразу появилась в
    // Prompt Manager. Основа была взята из живых настроек, так что ничего не теряется.
    if (isActive) manager.selectPreset(manager.getSelectedPreset());
}

/** Блоки пресета Таверны, в которые можно вставить текст (маркеры без текста не в счёт). */
export function listPresetBlocks(name) {
    const manager = SillyTavern.getContext().getPresetManager?.('openai');
    const preset = baseOpenAiPreset(name, manager?.getSelectedPresetName() === name);
    return (Array.isArray(preset.prompts) ? preset.prompts : [])
        .filter(p => !p.marker)
        .map(p => ({ identifier: p.identifier, name: String(p.name || p.identifier), content: String(p.content || '') }));
}

/**
 * Кладёт текст в блок пресета Таверны — вместо старого текста или новым блоком (identifier
 * пустой). Остальное в пресете не трогается; новый блок заводится ВЫКЛЮЧЕННЫМ, как в
 * buildOpenAiPreset. Прежний текст возвращается — вызывающий код кладёт его в резервную копию.
 * @returns {Promise<{identifier: string, name: string, old: string|null}>}
 */
export async function putPresetBlock(presetName, identifier, text, newName = '') {
    const manager = SillyTavern.getContext().getPresetManager?.('openai');
    if (!manager) throw new Error('В этой сборке Таверны недоступны пресеты Chat Completion.');
    const isActive = manager.getSelectedPresetName() === presetName;
    const preset = baseOpenAiPreset(presetName, isActive);
    if (!Array.isArray(preset.prompts)) preset.prompts = [];
    if (!Array.isArray(preset.prompt_order)) preset.prompt_order = [];

    let old = null;
    let name;
    if (identifier) {
        const prompt = preset.prompts.find(p => p.identifier === identifier);
        if (!prompt) throw new Error('Блок больше не найден в пресете.');
        old = String(prompt.content || '');
        name = String(prompt.name || identifier);
        prompt.content = text;
    } else {
        identifier = crypto.randomUUID();
        name = String(newName || 'Из анализа LOOM').trim();
        preset.prompts.push({
            identifier, name, role: 'system', content: text,
            injection_position: 0, injection_depth: 4, system_prompt: false, marker: false,
        });
        for (const order of preset.prompt_order) {
            if (!Array.isArray(order.order)) order.order = [];
            order.order.push({ identifier, enabled: false });
        }
    }
    await writePreset(manager, presetName, preset, isActive);
    return { identifier, name, old };
}

/** Заглушка Таверны для персон без своей картинки — тот же файл, что берёт её родная «создать без файла». */
const DEFAULT_PERSONA_AVATAR_URL = '/img/user-default.png';

/** Заливает файл как аватар персоны. @returns {Promise<string>} имя файла на сервере */
export async function uploadPersonaAvatar(ctx, pngBytes, overwriteName = null) {
    const file = new File([pngBytes], 'avatar.png', { type: 'image/png' });
    const formData = new FormData();
    formData.append('avatar', file);
    if (overwriteName) formData.append('overwrite_name', overwriteName);

    const response = await fetch('/api/avatars/upload', {
        method: 'POST',
        headers: ctx.getRequestHeaders({ omitContentType: true }),
        cache: 'no-cache',
        body: formData,
    });
    if (!response.ok) throw new Error(`Таверна отклонила загрузку аватара: ${response.statusText}`);
    if (overwriteName) return overwriteName;

    const result = await response.json();
    if (!result?.path) throw new Error('Таверна не вернула имя файла аватара.');
    return result.path;
}

/**
 * Экспортирует персону в Таверну — создаёт новую или обновляет существующую на месте
 * (если draft.importedAvatar уже указывает на персону, которую LOOM создал раньше,
 * И эта персона всё ещё существует — см. ниже).
 *
 * У персоны, в отличие от персонажа и лорбука, нет своего бэкенд-эндпоинта для сохранения:
 * это просто запись в powerUserSettings.personas / persona_descriptions — то же самое
 * состояние, что правит сама Таверна в Управлении персонами, отсюда и прямая мутация
 * плюс saveSettingsDebounced вместо отдельного fetch.
 *
 * @param {object} draft
 * @param {Uint8Array} [avatarPng] аватар персоны, уже обрезанный до 2:3
 *   (см. toPersonaAvatarPng в src/images.js). Нет своей картинки — используется
 *   заглушка Таверны, как и при создании персоны без файла в самой Таверне.
 * @returns {Promise<{avatar: string, created: boolean}>} имя файла аватара и признак,
 *   что это НОВАЯ персона (а не обновление старой) — см. exportCharacter, симметричная
 *   логика: вызывающий код обязан пере-записать draft.importedAvatar этим значением.
 */
export async function exportPersona(draft, avatarPng = null) {
    const ctx = SillyTavern.getContext();
    const settings = getSettings();
    const formatById = new Map(settings.persona_format.map(item => [item.id, item]));

    const description = draft.sections
        .filter(section => section.blocks.length)
        .map(section => `[${formatById.get(section.id)?.label || section.label}]\n${section.blocks.map(b => b.text).join('\n\n')}`)
        .join('\n\n');
    if (!description.trim()) throw new Error('В черновике нет текста ни в одном пункте.');

    const name = String(draft.name || 'Без имени').trim();
    let avatarId = draft.importedAvatar;

    // Персону могли удалить прямо в Таверне (Управление персонами → удалить) — тогда
    // powerUserSettings.personas больше не знает про этот avatarId, а вместе с записью
    // Таверна стирает и сам файл аватара. Писать поверх несуществующего файла нет
    // смысла — заводим персону заново, как при первом экспорте (см. exportCharacter).
    const created = !avatarId || !ctx.powerUserSettings.personas[avatarId];
    if (created) avatarId = null;

    if (!avatarId) {
        const bytes = avatarPng || new Uint8Array(await (await fetch(DEFAULT_PERSONA_AVATAR_URL)).arrayBuffer());
        avatarId = await uploadPersonaAvatar(ctx, bytes);
    } else if (avatarPng) {
        // Персона уже привязана к файлу — новую картинку кладём поверх того же имени,
        // а не заводим второй файл
        await uploadPersonaAvatar(ctx, avatarPng, avatarId);
        // Имя файла то же самое — без этого браузер показывал бы старую картинку
        // из своего кэша, пока страницу не перезагрузят вручную (см. warmThumbnail)
        await warmThumbnail('persona', avatarId);
    }

    const existing = ctx.powerUserSettings.persona_descriptions[avatarId] || {};
    ctx.powerUserSettings.personas[avatarId] = name;
    ctx.powerUserSettings.persona_descriptions[avatarId] = {
        ...existing,
        description,
        // IN_PROMPT и есть дефолт самой Таверны при создании персоны — ничего умнее не подставляем
        position: existing.position ?? 0,
        depth: existing.depth ?? 4,
        role: existing.role ?? 0,
        lorebook: existing.lorebook ?? '',
        // Заголовок Таверны (показывается под именем в списке персон, «Persona Title»
        // в её попапе переименования) — LOOM для него такой же источник правды, как
        // и для description: то, что в draft.personaTitle, полностью заменяет то,
        // что было раньше, а не только дополняет пустое.
        title: String(draft.personaTitle || '').trim(),
    };
    // Описание АКТИВНОЙ персоны Таверна держит отдельно от карты: в промпт идёт
    // power_user.persona_description (см. openai.js и script.js, там же макрос
    // {{persona}}), а persona_descriptions — только хранилище, откуда поля копируются
    // в момент ВЫБОРА персоны (selectCurrentPersona в personas.js). Обновив одну карту,
    // мы бы не изменили ничего в текущем чате: до промпта правка доехала бы только
    // после переключения персоны туда-обратно или перезагрузки страницы.
    //
    // Хуже того, видимое поле «Описание персоны» тоже осталось бы со старым текстом,
    // а любой ввод в него (onPersonaDescriptionInput) записывает содержимое поля
    // обратно в карту — то есть первое же касание молча откатило бы наш экспорт.
    if (avatarId === user_avatar) {
        ctx.powerUserSettings.persona_description = description;
        setPersonaDescription();
    }
    ctx.saveSettingsDebounced();

    // Мутация выше меняет только данные — список персон в интерфейсе Таверны
    // (#user_avatar_block) строится отдельно и сам себя не перерисовывает. Без этого
    // новая персона появлялась в списке только после перезагрузки страницы.
    await getUserAvatars(true, avatarId).catch(() => {});

    return { avatar: avatarId, created };
}

/**
 * Черновик (промпт или сценарий) → готовый текст для копирования/скачивания.
 *
 * Подписи пунктов сюда НЕ идут, в отличие от персоны: там «[Внешность]» помогает
 * модели разобрать описание, а здесь читатель — либо сама модель (промпт), либо
 * пользователь, вставляющий текст в заметку/чат (сценарий), и русские заголовки
 * посреди текста только сбивают. Пункты разделяются пустой строкой — этого достаточно.
 */
export function buildSectionsText(draft) {
    return (draft.sections || [])
        .filter(section => section.blocks.length)
        .map(section => section.blocks.map(b => b.text).join('\n\n'))
        .join('\n\n')
        .trim();
}

/**
 * Копирование в буфер обмена.
 *
 * navigator.clipboard есть не всегда: он требует защищённого контекста, а Таверну
 * открывают и по http с другого устройства в локальной сети — там его нет. Поэтому
 * запасной путь через execCommand, который работает и без него.
 *
 * @returns {Promise<boolean>} удалось ли скопировать
 */
export async function copyToClipboard(text) {
    const value = String(text || '');
    if (!value) return false;

    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
            return true;
        }
    } catch { /* нет прав или не защищённый контекст — пробуем запасной путь */ }

    try {
        const area = document.createElement('textarea');
        area.value = value;
        // Вне экрана, но в документе: execCommand не копирует из скрытого display:none
        area.style.cssText = 'position:fixed;top:-9999px;opacity:0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
    } catch {
        return false;
    }
}

/** Общая часть скачивания: блоб → клик по временной ссылке. */
function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

/** Скачивание карточки файлом — на случай, когда импортировать в Таверну не нужно. */
export function downloadJson(payload, fileName) {
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), fileName);
}

/**
 * Скачивание простым текстом — для системного промпта: он вставляется в Таверну
 * как есть, и JSON-обёртка тут только мешала бы. Заодно запасной путь, если
 * браузер не дал скопировать в буфер (см. copyToClipboard).
 */
export function downloadText(text, fileName) {
    downloadBlob(new Blob([String(text ?? '')], { type: 'text/plain;charset=utf-8' }), fileName);
}
