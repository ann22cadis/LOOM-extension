/**
 * Импорт персонажей и лорбуков из самой Таверны в черновики LOOM.
 *
 * Ключевое правило всего модуля: оригинал в Таверне не трогаем напрямую и не
 * перезаписываем без следа. Перед тем как LOOM вообще коснётся данных, делаем
 * настоящую резервную копию силами самой Таверны — не своим форматом внутри
 * settings.json, а обычным файлом персонажа/лорбука, который переживёт любое
 * количество последующих правок в LOOM и найдётся в интерфейсе Таверны как есть,
 * даже если LOOM однажды удалят.
 */

import { uid, presetEntryDelivery } from './drafts.js';
import { activeFormat } from './settings.js';
import { uploadPersonaAvatar } from './export.js';
// world_names — ЖИВАЯ переменная модуля (let, не константа): st-context.js прокидывает
// в extension-контекст только функции (loadWorldInfo/saveWorldInfo/updateWorldInfoList),
// а сам список имён — нет. Импорт ES-модуля даёт живую привязку: значение, прочитанное
// в момент вызова listTavernWorlds(), будет актуальным после updateWorldInfoList().
import { world_names } from '../../../../world-info.js';

const LOG = '[LOOM]';

/**
 * @returns {Array<{avatar: string, name: string, thumb: string}>} персонажи Таверны для пикера
 *
 * thumb нужен не для красоты: у пользователя может быть несколько версий одного и того
 * же героя (разные карточки одного «Ло», например) с одинаковым именем — различить их
 * в списке можно только по портрету, имя тут не помощник.
 */
export function listTavernCharacters() {
    const ctx = SillyTavern.getContext();
    return (ctx.characters || [])
        .filter(c => c?.avatar)
        .map(c => ({
            avatar: c.avatar,
            name: c.name || c.avatar,
            thumb: c.avatar !== 'none' ? ctx.getThumbnailUrl('avatar', c.avatar) : '',
        }));
}

/** @returns {Promise<string[]>} имена лорбуков Таверны для пикера */
export async function listTavernWorlds() {
    const ctx = SillyTavern.getContext();
    await ctx.updateWorldInfoList();
    return [...(world_names || [])];
}

/**
 * @returns {Array<{avatarId: string, name: string, thumb: string}>} персоны Таверны для пикера
 *
 * thumb по той же причине, что и у персонажей (см. listTavernCharacters выше): несколько
 * персон легко назвать одинаково или похоже, различить их в списке помогает только портрет.
 */
export function listTavernPersonas() {
    const ctx = SillyTavern.getContext();
    const personas = ctx.powerUserSettings?.personas || {};
    return Object.keys(personas).map(avatarId => ({
        avatarId,
        name: personas[avatarId] || avatarId,
        thumb: ctx.getThumbnailUrl('persona', avatarId),
    }));
}

/** @returns {string[]} имена сохранённых Chat Completion пресетов Таверны, для анализа пресета */
export function listTavernPresets() {
    const ctx = SillyTavern.getContext();
    const { preset_names } = ctx.getPresetManager('openai').getPresetList();
    return Object.keys(preset_names).sort((a, b) => a.localeCompare(b, 'ru'));
}

/**
 * Сырой объект пресета по имени — тот же, что Таверна хранит в openai_settings
 * и пишет в файл OpenAI Settings/<имя>.json. Три-четыре десятка полей внутри
 * (ключи моделей, прокси, лимиты…) для анализа не нужны — см. buildPresetDigestFromRaw,
 * которая берёт из этого объекта только то, что решает содержимое запроса.
 * @returns {object|null} null, если пресета с таким именем уже нет
 */
export function readTavernPresetRaw(name) {
    const ctx = SillyTavern.getContext();
    const { presets, preset_names } = ctx.getPresetManager('openai').getPresetList();
    const index = preset_names[name];
    return index !== undefined ? (presets[index] || null) : null;
}

/**
 * Порядок блоков, по которому Таверна РЕАЛЬНО собирает запрос.
 *
 * prompt_order — массив по «персонажам»: 100000 — заводской список из ~11 стандартных
 * пунктов, 100001 — тот, что Chat Completion использует всегда (стратегия 'global',
 * dummyId в openai.js). Первым в файле почти всегда лежит 100000, и раньше LOOM брал
 * именно его: все пользовательские блоки выглядели «не подключёнными», а вкл/выкл
 * остальных читался из чужого списка. Если 100001 нет — берём самый длинный список.
 */
function activePromptOrder(raw) {
    const orders = Array.isArray(raw?.prompt_order) ? raw.prompt_order.filter(o => Array.isArray(o?.order)) : [];
    const active = orders.find(o => Number(o.character_id) === 100001)
        || [...orders].sort((a, b) => b.order.length - a.order.length)[0];
    return active?.order || [];
}

/**
 * Именованные блоки сырого пресета (из Таверны или распарсенного JSON-файла — сам файл
 * «Export preset» отдаёт РОВНО этот объект, см. onExportPresetClick в openai.js) → записи
 * черновика режима «Пресет». Роль и место вставки переносятся как есть.
 *
 * @param {object} raw сырой объект пресета
 * @param {{keepUid?: boolean}} [options] keepUid — проставлять importedUid (identifier
 *   блока в пресете Таверны). По умолчанию false: у файла с диска нет связи с конкретным
 *   пресетом, куда его потом решат экспортировать, а у встроенных блоков Таверны (Main
 *   Prompt, NSFW, Jailbreak…) identifier — фиксированная строка, ОДНА И ТА ЖЕ в любом
 *   пресете; сохранить её значило бы рискнуть молча переписать чужой встроенный блок
 *   в пресете назначения вместо того чтобы завести новый (тот же риск, что и у importedUid
 *   записи лорбука — см. entriesFromWorldData). importPresetFromTavern берёт true: там
 *   источник — тот самый пресет, куда и вернётся при следующем экспорте.
 * @returns {object[]} записи черновика; пустой массив, если в пресете нет ни одного
 *   блока с текстом — сообщить об этом с уместной формулировкой решает вызывающий код
 */
export function presetEntriesFromRaw(raw, { keepUid = false } = {}) {
    const item = activeFormat('preset')[0] || { id: 'rule', label: 'Текст блока' };
    const order = activePromptOrder(raw);
    const orderIndex = new Map(order.map((o, i) => [o.identifier, i]));
    const prompts = (Array.isArray(raw?.prompts) ? raw.prompts : [])
        .filter(p => !p.marker && String(p?.content || '').trim())
        .sort((a, b) => (orderIndex.get(a.identifier) ?? 1e9) - (orderIndex.get(b.identifier) ?? 1e9));

    return prompts.map(p => {
        const content = String(p.content).trim();
        const words = content.split(/\s+/).filter(Boolean).length;
        return {
            id: uid(),
            title: String(p.name || p.identifier || 'Без названия'),
            category: '',
            seed: '',
            note: '',
            // Ползунок — потолок длины при переписывании: ставим по реальному объёму
            // блока (с шагом ползунка), иначе переписывание урезало бы длинный блок
            wordCount: Math.min(2000, Math.max(20, Math.ceil(words / 20) * 20)),
            keys: [],
            finalKeys: [],
            sections: [{
                id: item.id,
                label: item.label,
                blocks: content.split(/\n\s*\n/).map(t => t.trim()).filter(Boolean)
                    .map(text => ({ text, rating: 0, comment: '' })),
            }],
            history: [],
            future: [],
            images: [],
            constant: false,
            importedUid: keepUid ? p.identifier : null,
            ...presetEntryDelivery({
                role: p.role,
                injectionPosition: p.injection_position,
                injectionDepth: p.injection_depth,
            }),
        };
    });
}

/**
 * Пресет Таверны → черновик режима «Пресет». importedUid = identifier блока в пресете —
 * экспорт обратно в пресет с тем же именем обновит ИМЕННО эти блоки на месте (см.
 * buildOpenAiPreset), а не добавит копии. Сам пресет при импорте не меняется — поэтому,
 * в отличие от персонажей и лорбуков, резервная копия тут не нужна.
 *
 * @param {string} name имя пресета Chat Completion
 * @returns {{name: string, brief: string, entries: object[]}}
 */
export function importPresetFromTavern(name) {
    const raw = readTavernPresetRaw(name);
    if (!raw) throw new Error(`Пресет «${name}» не найден.`);

    const entries = presetEntriesFromRaw(raw, { keepUid: true });
    if (!entries.length) throw new Error(`В пресете «${name}» нет ни одного блока с текстом.`);

    return { name, brief: '', entries };
}

/**
 * Пресет Chat Completion (сырой объект — из Таверны или распарсенный JSON-файл)
 * → компактный дайджест для промпта разбора: именованные блоки с текстом,
 * ролью и тем, включены ли они в реально работающий порядок, плюс горстка
 * сэмплер-настроек. Всё остальное в сыром объекте — служебные поля, влияющие
 * не на содержание ответа модели, а на то, КАК до неё долетает запрос
 * (какое API, прокси, лимиты) — разбору формулировок это не нужно.
 *
 * marker-пункты (charDescription, chatHistory и т.п.) пропускаются: это не
 * текст, а место вставки чужого контента (карточки персонажа, истории чата),
 * сам по себе пустой слот ничего не говорит о проблеме пользователя.
 *
 * @param {object} raw
 * @returns {{model: string, temperature?: number, top_p?: number, top_k?: number,
 *   frequency_penalty?: number, presence_penalty?: number, repetition_penalty?: number,
 *   blocks: Array<{name: string, content: string, role: string, enabled: boolean|null, order: number|null}>}}
 *   enabled: true/false — в активном порядке промпта и включён/выключен там; null — в
 *   этот порядок вообще не добавлен (лежит в пресете как заготовка, ни на что не влияет)
 */
export function buildPresetDigestFromRaw(raw) {
    const prompts = Array.isArray(raw?.prompts) ? raw.prompts : [];
    const order = activePromptOrder(raw);
    const enabledById = new Map(order.map(o => [o.identifier, !!o.enabled]));
    const orderIndex = new Map(order.map((o, i) => [o.identifier, i]));

    const blocks = prompts
        .filter(p => !p.marker && String(p?.content || '').trim())
        .map(p => ({
            name: String(p.name || p.identifier || 'Без названия'),
            content: String(p.content).trim(),
            role: p.role || 'system',
            enabled: enabledById.has(p.identifier) ? enabledById.get(p.identifier) : null,
            order: orderIndex.has(p.identifier) ? orderIndex.get(p.identifier) : null,
        }))
        .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

    return {
        model: String(raw?.openai_model || raw?.claude_model || raw?.custom_model
            || raw?.google_model || raw?.vertexai_model || raw?.openrouter_model || ''),
        temperature: raw?.temperature,
        top_p: raw?.top_p,
        top_k: raw?.top_k,
        frequency_penalty: raw?.frequency_penalty,
        presence_penalty: raw?.presence_penalty,
        repetition_penalty: raw?.repetition_penalty,
        blocks,
    };
}

export function splitParagraphs(text) {
    return String(text || '').split(/\n{2,}/).map(t => t.trim()).filter(Boolean);
}

export function makeBlock(text) {
    return { text, rating: 0, comment: '' };
}

/**
 * Текст без готовой структуры (описание персоны, старая карточка без полей V2) → одна
 * секция «Импортированный текст», разбитая на абзацы. Общая часть importPersonaFromTavern
 * и импорта персоны из файла (src/file-import.js) — у обоих один и тот же вход: голый текст.
 * @returns {object[]} одна секция, или пустой массив, если текста нет
 */
export function personaSectionsFromDescription(description) {
    const blocks = splitParagraphs(description).map(makeBlock);
    return blocks.length ? [{ id: 'imported', label: 'Импортированный текст', blocks }] : [];
}

/** Поле V2-карточки → секция черновика. Пустое поле — пустая секция, отсеивается снаружи. */
function fieldSection(id, label, text) {
    const blocks = splitParagraphs(text).map(makeBlock);
    return blocks.length ? { id, label, blocks } : null;
}

/**
 * Поле «Examples of dialogue» → блоки: по одному на каждый <START>. Раньше весь текст шёл
 * одним абзацем (примеры в поле идут подряд, без пустых строк), и оценить или переписать
 * можно было только все примеры сразу.
 */
export function splitExamples(text) {
    const source = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!source) return [];
    const parts = source.split(/^[ \t]*<START>[ \t]*$/im).map(part => part.trim());
    // Текст до первого <START> (если он есть) — тоже пример, просто без метки
    const blocks = parts.filter(Boolean).map(part => '<START>\n' + part);
    return blocks.length ? blocks : [source];
}

/**
 * Карточка V2/V3 → секции черновика. Источник — что угодно, лишь бы поля были V2-формы
 * (description/personality/scenario/first_mes/mes_example/creator_notes): и character.data
 * персонажа из Таверны (importCharacterFromTavern), и карточка, прочитанная прямо из PNG
 * или .json-файла в обход Таверны (src/file-import.js) — второй путь через ЭТУ же функцию,
 * чтобы результат выглядел и вёл себя одинаково независимо от источника.
 *
 * Не пытаемся раскидать текст по тонким пунктам активного формата (внешность,
 * характер: ядро, характер: триггеры…) — у произвольной готовой карточки нет для
 * этого естественных границ, гадать значило бы резать текст посередине мысли.
 * Берём поля V2 как есть, с их собственными именами: у scenario/first_mes они и так
 * совпадают с id пунктов сценария в любом формате LOOM (и подхватят флаг «сцена»
 * автоматически), у остальных — используют подпись активного формата, если там
 * найдётся пункт с таким же id (typично для компактного формата), иначе — свою.
 * Раздел с непонятным формату id не потеряется: см. mergeSections в drafts.js.
 *
 * @param {Map<string, object>} formatById id пункта → пункт активного формата персонажа
 * @param {object} data карточка в форме V2 (character.data из Таверны или уже нормализованный
 *   файл — см. normalizeCardData в src/file-import.js)
 */
export function sectionsFromCard(formatById, data) {
    const labelFor = (id, fallback) => formatById.get(id)?.label || fallback;
    // Пункт формата, чьё содержимое уходит в поле mes_example: раздел импорта должен носить его id,
    // иначе «Заново»/«С оценками» считали бы импортированные примеры чужим разделом и не трогали
    const examplesItem = [...formatById.values()].find(item => item.target === 'mes_example');
    const examplesId = examplesItem?.id || 'mes_example';
    const examples = splitExamples(data.mes_example).map(makeBlock);
    return [
        fieldSection('description', labelFor('description', 'Описание'), data.description),
        fieldSection('personality', labelFor('personality', 'Личность'), data.personality),
        fieldSection('scenario', labelFor('scenario', 'Сценарий'), data.scenario),
        fieldSection('first_mes', labelFor('first_mes', 'Первое сообщение'), data.first_mes),
        examples.length ? { id: examplesId, label: examplesItem?.label || 'Примеры диалогов', blocks: examples } : null,
        fieldSection('creator_notes', labelFor('creator_notes', 'Заметки автора'), data.creator_notes),
    ].filter(Boolean);
}

/**
 * Другие варианты первого сообщения (data.alternate_greetings, V2) → draft.altGreetings.
 * {text, idea}[] — та же форма, в которой их потом держит и экспортирует черновик
 * (см. draft.altGreetings в src/drafts.js); idea пустая — карточка не хранит задумку,
 * с которой вариант был написан, только сам текст.
 */
export function altGreetingsFromCard(data) {
    const list = Array.isArray(data?.alternate_greetings) ? data.alternate_greetings : [];
    return list.map(text => String(text || '').trim()).filter(Boolean).map(text => ({ text, idea: '' }));
}

/**
 * Импортирует персонажа из Таверны.
 *
 * @param {string} avatar имя файла аватара (то же, что у character.avatar в Таверне)
 * @param {Map<string, object>} formatById активный формат персонажа, id → пункт
 * @returns {Promise<{name: string, sections: object[], altGreetings: {text: string, idea: string}[], importedAvatar: string, importBackupAvatar: string|null}>}
 */
export async function importCharacterFromTavern(avatar, formatById) {
    const ctx = SillyTavern.getContext();
    const character = ctx.characters.find(c => c.avatar === avatar);
    if (!character) throw new Error(`Персонаж «${avatar}» не найден в Таверне.`);

    // Бэкап ДО того, как LOOM вообще прочитает данные в черновик — дубликат Таверны
    // переживёт любое число последующих переписываний внутри LOOM.
    let importBackupAvatar = null;
    try {
        const res = await fetch('/api/characters/duplicate', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar }),
        });
        const result = await res.json().catch(() => null);
        if (res.ok && result?.path) importBackupAvatar = result.path;
        else console.warn(LOG, `Резервная копия «${avatar}» не создана`, result);
    } catch (e) {
        console.warn(LOG, `Резервная копия «${avatar}» не создана`, e);
    }
    await ctx.getCharacters();

    const data = character.data || character;
    const sections = sectionsFromCard(formatById, data);
    if (!sections.length) throw new Error(`У персонажа «${character.name}» нет текста ни в одном поле.`);

    return {
        name: character.name || '',
        sections,
        altGreetings: altGreetingsFromCard(data),
        importedAvatar: avatar,
        importBackupAvatar,
    };
}

/** Свободное имя для бэкапа лорбука: «Имя (бэкап)», при коллизии — «Имя (бэкап 2)» и т.д. */
async function uniqueWorldName(base) {
    const ctx = SillyTavern.getContext();
    await ctx.updateWorldInfoList();
    const existing = new Set(world_names || []);
    if (!existing.has(base)) return base;
    let n = 2;
    while (existing.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
}

/**
 * Записи World Info → записи черновика лорбука. { entries: {uid: {key, content, comment,
 * constant, uid, …}, …} } — тот же JSON, что возвращает loadWorldInfo и что скачивает
 * кнопка «Export World Info» самой Таверны (см. world-info.js), поэтому годится и для
 * импорта из Таверны (importWorldFromTavern), и для файла с диска (src/file-import.js).
 *
 * Существующие записи попадают в черновик каждая своим блоком «Импортированный
 * текст» — не разбираем их на суть/детали/связи/крючки формата LOOM, это разрушило
 * бы уже написанный текст без всякой необходимости. Разобрать на пункты формата
 * можно вручную через «Заново» у конкретной записи, если понадобится.
 *
 * @param {object} data {entries: {...}}
 * @param {{keepUid?: boolean}} [options] keepUid — проставлять importedUid (см. ниже).
 *   По умолчанию false: у файла с диска нет связи с конкретным лорбуком Таверны,
 *   и её числовой uid (обычно 0, 1, 2…) мог бы случайно совпасть с чужой записью
 *   в лорбуке, куда потом решат экспортировать, — тогда экспорт молча переписал бы
 *   чужую запись вместо того чтобы завести новую.
 * @returns {object[]} записи черновика
 */
export function entriesFromWorldData(data, { keepUid = false } = {}) {
    return Object.values(data.entries || {}).map(raw => {
        const keys = Array.isArray(raw.key) ? raw.key.map(String) : [];
        const content = splitParagraphs(raw.content).map(makeBlock);
        return {
            id: uid(),
            title: String(raw.comment || keys[0] || 'Без названия'),
            category: '',
            seed: '',
            keys,
            // Ключи уже готовы к работе как есть — не пересобираем их заново,
            // чтобы не потерять регулярки, которые пользователь мог настроить руками
            finalKeys: keys,
            sections: content.length ? [{ id: 'imported', label: 'Импортированный текст', blocks: content }] : [],
            history: [],
            images: [],
            constant: !!raw.constant,
            // uid ЭТОЙ ЖЕ записи в оригинальном лорбуке Таверны — экспорт обновит именно
            // её на месте (см. exportLorebook), а не создаст рядом дубликат. Только когда
            // источник действительно тот же лорбук Таверны, см. комментарий у keepUid выше.
            importedUid: keepUid ? raw.uid : null,
        };
    });
}

/**
 * Импортирует лорбук из Таверны.
 *
 * @param {string} name имя лорбука в Таверне
 * @returns {Promise<{name: string, entries: object[], importedWorld: string, importBackupWorld: string|null}>}
 */
export async function importWorldFromTavern(name) {
    const ctx = SillyTavern.getContext();
    const data = await ctx.loadWorldInfo(name);
    if (!data?.entries) throw new Error(`Лорбук «${name}» пуст или не найден.`);

    let importBackupWorld = null;
    try {
        const backupName = await uniqueWorldName(`${name} (бэкап)`);
        await ctx.saveWorldInfo(backupName, structuredClone(data), true);
        importBackupWorld = backupName;
    } catch (e) {
        console.warn(LOG, `Резервная копия лорбука «${name}» не создана`, e);
    }
    await ctx.updateWorldInfoList();

    const entries = entriesFromWorldData(data, { keepUid: true });
    if (!entries.length) throw new Error(`В лорбуке «${name}» нет ни одной записи.`);
    return { name, entries, importedWorld: name, importBackupWorld };
}

/** Свободное имя для бэкапа персоны: «Имя (бэкап)», при коллизии — «Имя (бэкап 2)» и т.д. */
function uniquePersonaName(base, ctx) {
    const existing = new Set(Object.values(ctx.powerUserSettings?.personas || {}));
    if (!existing.has(base)) return base;
    let n = 2;
    while (existing.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
}

/**
 * Импортирует персону из Таверны.
 *
 * У персоны, в отличие от персонажа и лорбука, нет собственного файла — только запись
 * в powerUserSettings и файл аватара. Бэкап здесь — не дубликат файла на диске (как
 * у персонажа), а вторая, независимая персона с тем же портретом и тем же текстом:
 * при экспорте LOOM обновит именно оригинал (importedAvatar), а бэкап останется рядом
 * нетронутым и найдётся в Управлении персонами Таверны как есть.
 *
 * Описание не пытаемся раскидать по пунктам активного формата персоны (внешность,
 * характер…) — у готовой персоны нет для этого естественных границ, как и у записи
 * лорбука (см. importWorldFromTavern). Текст целиком попадает в один блок «Импортированный
 * текст», который можно разобрать на пункты формата вручную через «Заново».
 *
 * @param {string} avatarId имя файла аватара персоны (ключ в powerUserSettings.personas)
 * @returns {Promise<{name: string, sections: object[], importedAvatar: string, importBackupAvatar: string|null}>}
 */
export async function importPersonaFromTavern(avatarId) {
    const ctx = SillyTavern.getContext();
    const name = ctx.powerUserSettings?.personas?.[avatarId];
    if (name === undefined) throw new Error(`Персона «${avatarId}» не найдена в Таверне.`);

    const info = ctx.powerUserSettings?.persona_descriptions?.[avatarId] || {};
    const description = String(info.description || '').trim();
    if (!description) throw new Error(`У персоны «${name || avatarId}» нет описания.`);

    let importBackupAvatar = null;
    try {
        const res = await fetch(`/User Avatars/${encodeURIComponent(avatarId)}`, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const backupId = await uploadPersonaAvatar(ctx, bytes);
        ctx.powerUserSettings.personas[backupId] = uniquePersonaName(`${name || avatarId} (бэкап)`, ctx);
        ctx.powerUserSettings.persona_descriptions[backupId] = { ...info };
        ctx.saveSettingsDebounced();
        importBackupAvatar = backupId;
    } catch (e) {
        console.warn(LOG, `Резервная копия персоны «${avatarId}» не создана`, e);
    }

    const sections = personaSectionsFromDescription(description);
    return {
        name: name || '', sections, importedAvatar: avatarId, importBackupAvatar,
        // Заголовок мог быть выставлен раньше прямо в Таверне (Rename Persona → Persona
        // Title) — подтягиваем, чтобы первый же экспорт из LOOM его не затёр пустотой
        personaTitle: String(info.title || ''),
    };
}
