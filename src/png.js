/**
 * Карточка персонажа внутри PNG.
 *
 * Формат карточек (Character Card V2) прячет JSON в текстовом чанке PNG с именем tEXt
 * и ключом «chara»: значение — base64 от JSON. Так делают и Таверна, и все остальные,
 * поэтому такой файл открывается где угодно, а не только у нас.
 *
 * Читать PNG умеет сама Таверна (extractDataFromPng в utils.js), а вот записывать —
 * только сервер, при импорте. Здесь минимальный писатель чанков: разобрать PNG,
 * выкинуть старые chara/ccv3, вставить свои и собрать файл обратно.
 */

/** Таблица CRC32 из спецификации PNG. Считается один раз при первом обращении. */
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

function isPng(bytes) {
    return PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
}

/** @returns {Array<{name: string, data: Uint8Array}>} чанки в порядке следования */
function readChunks(bytes) {
    if (!isPng(bytes)) throw new Error('Это не PNG: файл не начинается сигнатурой PNG.');

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks = [];
    let offset = 8;

    while (offset < bytes.length) {
        const length = view.getUint32(offset);
        const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        const data = bytes.subarray(offset + 8, offset + 8 + length);
        chunks.push({ name, data });
        // 4 длина + 4 имя + данные + 4 CRC
        offset += 12 + length;
        if (name === 'IEND') break;
    }

    if (!chunks.length || chunks.at(-1).name !== 'IEND') throw new Error('PNG повреждён: не найден конец файла.');
    return chunks;
}

/** Текстовый чанк tEXt: ключ, нулевой байт, значение — всё в latin1. */
function makeTextChunk(keyword, value) {
    const key = new TextEncoder().encode(keyword);
    // base64 — чистый ASCII, поэтому latin1-кодирование значения безопасно
    const text = Uint8Array.from(value, ch => ch.charCodeAt(0) & 0xFF);
    const data = new Uint8Array(key.length + 1 + text.length);
    data.set(key, 0);
    data[key.length] = 0;
    data.set(text, key.length + 1);
    return { name: 'tEXt', data };
}

function chunkKeyword(chunk) {
    if (chunk.name !== 'tEXt') return '';
    const zero = chunk.data.indexOf(0);
    return zero === -1 ? '' : String.fromCharCode(...chunk.data.subarray(0, zero));
}

function writeChunks(chunks) {
    const total = 8 + chunks.reduce((sum, chunk) => sum + 12 + chunk.data.length, 0);
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    out.set(PNG_SIGNATURE, 0);

    let offset = 8;
    for (const chunk of chunks) {
        const name = Uint8Array.from(chunk.name, ch => ch.charCodeAt(0));
        view.setUint32(offset, chunk.data.length);
        out.set(name, offset + 4);
        out.set(chunk.data, offset + 8);

        // CRC считается по имени вместе с данными
        const crcSource = new Uint8Array(4 + chunk.data.length);
        crcSource.set(name, 0);
        crcSource.set(chunk.data, 4);
        view.setUint32(offset + 8 + chunk.data.length, crc32(crcSource));

        offset += 12 + chunk.data.length;
    }
    return out;
}

/** JSON → base64 без потери кириллицы (btoa сам по себе умеет только latin1). */
function jsonToBase64(value) {
    const utf8 = new TextEncoder().encode(JSON.stringify(value));
    let binary = '';
    for (const byte of utf8) binary += String.fromCharCode(byte);
    return btoa(binary);
}

/** Обратное к jsonToBase64: base64 → байты UTF-8 → строка → JSON. Без этого шага
 *  кириллица в карточке превратилась бы в мусор — обычный atob() отдаёт только байты. */
function base64ToJson(base64) {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Достаёт карточку персонажа из PNG: ищет текстовый чанк tEXt с ключом chara (Character
 * Card V2) или, за неимением, ccv3 (V3) — именно так, без сжатия, карточку кладёт сама
 * Таверна (см. character-card-parser.js) и подавляющее большинство карточек в сети.
 * Сжатый чанк zTXt не читаем — на практике почти не встречается для карточек персонажей.
 *
 * @param {Uint8Array} pngBytes
 * @returns {object|null} разобранная карточка (V1/V2/V3, как есть) или null, если чанка нет
 * @throws {Error} PNG повреждён, или найденный чанк не удалось разобрать как JSON
 */
export function extractCardFromPng(pngBytes) {
    const chunks = readChunks(pngBytes);
    for (const keyword of ['chara', 'ccv3']) {
        const chunk = chunks.find(c => chunkKeyword(c) === keyword);
        if (!chunk) continue;
        const zero = chunk.data.indexOf(0);
        const base64 = new TextDecoder('latin1').decode(chunk.data.subarray(zero + 1));
        try {
            return base64ToJson(base64);
        } catch (error) {
            throw new Error(`Не удалось прочитать карточку из PNG (чанк «${keyword}»): ${error.message}`);
        }
    }
    return null;
}

/**
 * Вписывает карточку в PNG.
 *
 * @param {Uint8Array} pngBytes исходная картинка
 * @param {object} card карточка Character Card V2
 * @returns {Uint8Array} PNG с карточкой внутри
 */
export function embedCardInPng(pngBytes, card) {
    const chunks = readChunks(pngBytes);
    const payload = jsonToBase64(card);

    // Старые chara/ccv3 выкидываем: два разных описания в одном файле — верный способ
    // получить в чужом редакторе не ту версию карточки
    const clean = chunks.filter(chunk => !['chara', 'ccv3'].includes(chunkKeyword(chunk)));

    const iendIdx = clean.findIndex(chunk => chunk.name === 'IEND');
    clean.splice(iendIdx, 0, makeTextChunk('chara', payload));

    return writeChunks(clean);
}

/** Скачивание готовой карточки-картинки. */
export function downloadPng(bytes, fileName) {
    const blob = new Blob([bytes], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}
