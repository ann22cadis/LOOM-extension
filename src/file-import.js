/**
 * Импорт персонажа, лорбука, персоны или пресета прямо из файла — в обход Таверны
 * совсем: ни временного файла на сервере, ни записи в её списках. Файл читается
 * и разбирается тут же, в браузере, результат идёт в обычный черновик LOOM. От
 * импорта из Таверны (src/tavern-import.js) отличается только источником — секции
 * строят те же общие функции (sectionsFromCard/entriesFromWorldData/
 * personaSectionsFromDescription/presetEntriesFromRaw), поэтому результат неотличим
 * от импортированного штатным путём.
 *
 * Персонаж — PNG-карта (Character Card V2/V3, вшита в чанк tEXt) или голый .json
 * с теми же полями; понимает и V1 без обёртки {spec, data} — поля лежат прямо в корне.
 * Лорбук — .json вида {entries: {...}}: то же самое, что отдаёт «Export World Info»
 * Таверны или loadWorldInfo. Персона — .json: либо свой формат {name, description}
 * (см. download-persona в index.js), либо бэкап ВСЕХ персон разом из самой Таверны
 * (Backup Personas в её настройках) — она не умеет экспортировать одну персону
 * отдельно, поэтому такой файл разбирается на несколько черновиков. Пресет — .json,
 * тот же объект, что скачивает экспорт пресета в самой Таверне.
 */

import { extractCardFromPng } from './png.js';
import {
    sectionsFromCard, entriesFromWorldData, personaSectionsFromDescription, presetEntriesFromRaw, altGreetingsFromCard,
} from './tavern-import.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

function looksLikePng(bytes) {
    return PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
}

/** @returns {Promise<any>} разобранный JSON @throws {Error} «Это не корректный JSON.» */
async function readJsonFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new Error('Это не корректный JSON.');
    }
}

/**
 * V2/V3 оборачивают поля в {spec, data: {...}}, V1 — нет, поля лежат в корне объекта.
 * @returns {object} объект вида character.data, который понимает sectionsFromCard
 */
function normalizeCardData(raw) {
    if (raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object') return raw.data;
    return raw || {};
}

/**
 * Разбирает один файл карточки.
 * @param {File} file
 * @param {Map<string, object>} formatById активный формат персонажа, id → пункт
 * @returns {Promise<{name: string, sections: object[], altGreetings: {text: string, idea: string}[], avatarFile: File|null, sourceFileName: string}>}
 *   avatarFile — сама PNG-карта как картинка (её и кладём в draft.avatar через storeImage),
 *   null для .json — там портрета нет
 * @throws {Error} файл не PNG/JSON, PNG без карточки внутри, битый JSON или пустая карточка
 */
export async function parseCharacterFile(file, formatById) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const isPng = looksLikePng(bytes) || /\.png$/i.test(file.name);
    const isJson = !isPng && (/\.json$/i.test(file.name) || /^[\s{]/.test(new TextDecoder().decode(bytes.subarray(0, 16))));

    let raw;
    if (isPng) {
        if (!looksLikePng(bytes)) throw new Error('Файл называется PNG, но им не является.');
        raw = extractCardFromPng(bytes);
        if (!raw) throw new Error('В этом PNG нет вшитой карточки персонажа.');
    } else if (isJson) {
        raw = await readJsonFile(file);
    } else {
        throw new Error('Неизвестный формат — ожидается PNG-карта или .json.');
    }

    const data = normalizeCardData(raw);
    const sections = sectionsFromCard(formatById, data);
    if (!sections.length) throw new Error('В карточке нет текста ни в одном поле.');

    // Тип файла из ОС бывает пустым (некоторые файловые менеджеры отдают ''
    // для .png) — storeImage в src/images.js требует image/*, поэтому чиним
    // на месте, а не полагаемся на то, что прислала система.
    const avatarFile = isPng
        ? (/^image\//.test(file.type) ? file : new File([bytes], file.name, { type: 'image/png' }))
        : null;

    return {
        name: String(raw.name ?? data.name ?? '').trim(),
        sections,
        altGreetings: altGreetingsFromCard(data),
        avatarFile,
        sourceFileName: file.name,
    };
}

/**
 * Разбирает файл лорбука — {entries: {...}}, тот же JSON, что отдаёт «Export World Info»
 * самой Таверны или что возвращает loadWorldInfo. Имени лорбука внутри файла нет —
 * берётся из имени файла.
 * @param {File} file
 * @returns {Promise<{name: string, entries: object[], sourceFileName: string}>}
 * @throws {Error} битый JSON, нет поля entries, или в нём нет ни одной записи
 */
export async function parseLorebookFile(file) {
    const raw = await readJsonFile(file);
    if (!raw || typeof raw !== 'object' || !raw.entries || typeof raw.entries !== 'object') {
        throw new Error('В файле нет поля entries — это не лорбук Таверны.');
    }

    const entries = entriesFromWorldData(raw);
    if (!entries.length) throw new Error('В лорбуке нет ни одной записи.');

    return { name: file.name.replace(/\.json$/i, ''), entries, sourceFileName: file.name };
}

/**
 * Разбирает файл персоны(-он). Понимает два формата:
 *  - свой, из «Экспорт → Скачать JSON» персоны (см. download-persona в index.js):
 *    {name, description} — ровно одна персона;
 *  - бэкап ВСЕХ персон разом из самой Таверны (кнопка «Backup Personas» в её настройках,
 *    onBackupPersonas в personas.js): {personas: {id: имя}, persona_descriptions:
 *    {id: {description, …}}} — своего экспорта одной персоны у Таверны нет, поэтому
 *    файл оттуда всегда со всеми сразу; заводим черновик на каждую с непустым описанием.
 * @param {File} file
 * @returns {Promise<{name: string, sections: object[]}[]>} одна персона — один элемент
 * @throws {Error} битый JSON, неизвестный формат, или ни у одной персоны нет описания
 */
export async function parsePersonaFile(file) {
    const raw = await readJsonFile(file);

    if (raw?.persona_descriptions && typeof raw.persona_descriptions === 'object') {
        const names = raw.personas && typeof raw.personas === 'object' ? raw.personas : {};
        const result = [];
        for (const [avatarId, info] of Object.entries(raw.persona_descriptions)) {
            const sections = personaSectionsFromDescription(info?.description);
            if (sections.length) result.push({ name: String(names[avatarId] || avatarId), sections });
        }
        if (!result.length) throw new Error('В файле нет ни одной персоны с описанием.');
        return result;
    }

    if (raw && typeof raw === 'object' && typeof raw.description === 'string') {
        const sections = personaSectionsFromDescription(raw.description);
        if (!sections.length) throw new Error('В файле нет описания.');
        return [{ name: String(raw.name || '').trim(), sections }];
    }

    throw new Error('Неизвестный формат — ожидается файл персоны LOOM или бэкап персон Таверны.');
}

/**
 * Разбирает файл пресета Chat Completion — тот же объект, что скачивает кнопка экспорта
 * пресета в самой Таверне (onExportPresetClick в openai.js) или что хранит она сама
 * в OpenAI Settings/<имя>.json. Имени пресета внутри файла нет — берётся из имени файла.
 * @param {File} file
 * @returns {Promise<{name: string, brief: string, entries: object[], sourceFileName: string}>}
 * @throws {Error} битый JSON, файл не похож на пресет, или в нём нет ни одного блока с текстом
 */
export async function parsePresetFile(file) {
    const raw = await readJsonFile(file);
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.prompts)) {
        throw new Error('В файле нет поля prompts — это не пресет Chat Completion.');
    }

    const entries = presetEntriesFromRaw(raw);
    if (!entries.length) throw new Error('В пресете нет ни одного блока с текстом.');

    return { name: file.name.replace(/\.json$/i, ''), brief: '', entries, sourceFileName: file.name };
}
