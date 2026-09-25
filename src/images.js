/**
 * Картинки LOOM: референсы для генерации и аватар карточки.
 *
 * Где лежат: в IndexedDB, а НЕ в настройках расширения. Настройки Таверны — это один
 * settings.json, который переписывается целиком при каждом изменении и попадает в бэкапы;
 * пара мегабайт base64 там означает мегабайты записи на каждый чих. В черновике остаётся
 * только id — ни полноразмерная картинка, ни превью для интерфейса там не хранятся,
 * оба лежат в одной и той же записи IndexedDB (см. storeImage/loadThumb) и читаются
 * по этому id, когда действительно нужны — при отрисовке или при запросе к модели.
 */

const DB_NAME = 'LOOM';
const DB_VERSION = 1;
const STORE = 'images';

/** Референс уходит в модель: больше 1024px не нужно ни одной vision-модели, а токены платные. */
const REFERENCE_MAX_SIDE = 1024;
/** Превью в интерфейсе — крошечное, но не потому что живёт в settings.json (не живёт,
 *  см. loadThumb), а чтобы не гонять через IndexedDB лишние килобайты на одну иконку. */
const THUMB_MAX_SIDE = 96;
/** Аватар карточки: пропорции 2:3, как у Таверны. */
const AVATAR_WIDTH = 512;
const AVATAR_HEIGHT = 768;

let dbPromise = null;

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    return dbPromise;
}

function transact(mode, action) {
    return openDb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = action(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    }));
}

function uid() {
    return `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Обработка картинок ─────────────────────────────────────────────────────

function loadImageElement(dataUrl) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Не удалось прочитать изображение.'));
        image.src = dataUrl;
    });
}

export function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
        reader.readAsDataURL(file);
    });
}

/** Вписывает картинку в квадрат maxSide, сохраняя пропорции. JPEG — ради размера. */
async function resizeToDataUrl(dataUrl, maxSide, mime = 'image/jpeg', quality = 0.85) {
    const image = await loadImageElement(dataUrl);
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL(mime, quality);
}

/** Кадрирует по центру под заданные пропорции — тянуть картинку нельзя, лицо поедет. */
async function cropToPng(dataUrl, width, height) {
    const image = await loadImageElement(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    const scale = Math.max(width / image.width, height / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Аватар карточки персонажа: 512×768, пропорции 2:3, как у Таверны.
 * @returns {Promise<Uint8Array>} PNG-байты
 */
export function toAvatarPng(dataUrl) {
    return cropToPng(dataUrl, AVATAR_WIDTH, AVATAR_HEIGHT);
}

/**
 * Аватар персоны: 512×768, пропорции 2:3 — ровно то, что делает сама Таверна при загрузке
 * аватара персоны (сервер приводит его к AVATAR_WIDTH × AVATAR_HEIGHT). Раньше здесь был
 * квадрат 512×512, и такие персоны выглядели в списке иначе, чем заведённые в самой Таверне.
 * @returns {Promise<Uint8Array>} PNG-байты
 */
export function toPersonaAvatarPng(dataUrl) {
    return cropToPng(dataUrl, AVATAR_WIDTH, AVATAR_HEIGHT);
}

/**
 * Как cropToPng, но отдаёт data URL сразу, JPEG — для маленьких превью, которые
 * хранятся не файлом, а прямо внутри объекта настроек (см. toFolderAvatarDataUrl).
 */
async function cropToDataUrl(dataUrl, width, height, mime = 'image/jpeg', quality = 0.85) {
    const image = await loadImageElement(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    const scale = Math.max(width / image.width, height / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);

    return canvas.toDataURL(mime, quality);
}

/** Аватар папки Таверны: маленький квадрат. */
const FOLDER_AVATAR_SIZE = 96;

/**
 * Аватар папки — в IndexedDB, как и всё остальное здесь; на самом теге Таверны
 * (src/folders.js) остаётся только id (tag.loomAvatarId). Раньше картинка лежала
 * прямо на теге data URL'ом — рассуждение было «тег и так живёт в settings.json
 * целиком, а тут всего 96×96», но settings.json и без того тяжёлый и переписывается
 * на диск целиком при каждом сохранении (saveSettingsDebounced) — держать в нём
 * хоть что-то похожее на картинку не хочется, сколько бы «мало» это ни было.
 * @returns {Promise<string>} id записи в IndexedDB — передать в loadImage/deleteImage
 */
export async function storeFolderAvatarImage(dataUrl) {
    const cropped = await cropToDataUrl(dataUrl, FOLDER_AVATAR_SIZE, FOLDER_AVATAR_SIZE);
    const id = uid();
    await transact('readwrite', store => store.put({ id, data: cropped, name: 'folder-avatar', at: Date.now() }));
    return id;
}

// ─── Хранилище ──────────────────────────────────────────────────────────────

/**
 * Кладёт файл в хранилище — и полноразмерную версию, и превью, ОБЕ в одной записи
 * IndexedDB. Наружу возвращается только id: ни thumb, ни тем более сама картинка
 * в объект, который осядет в черновике (а значит и в settings.json), не попадают.
 * @param {File} file
 * @returns {Promise<{id: string, name: string, note: string}>} ссылка для черновика
 */
export async function storeImage(file) {
    if (!/^image\//.test(file.type)) throw new Error(`«${file.name}» — не изображение.`);

    const original = await fileToDataUrl(file);
    const [full, thumb] = await Promise.all([
        resizeToDataUrl(original, REFERENCE_MAX_SIDE),
        resizeToDataUrl(original, THUMB_MAX_SIDE, 'image/jpeg', 0.6),
    ]);

    const id = uid();
    await transact('readwrite', store => store.put({ id, data: full, thumb, name: file.name, at: Date.now() }));
    return { id, name: file.name, note: '' };
}

/** @returns {Promise<string>} data URL или пустая строка, если картинки уже нет */
export async function loadImage(id) {
    const record = await transact('readonly', store => store.get(id));
    return record?.data || '';
}

/** Превью для интерфейса — та же запись, что и полноразмерная картинка, но лёгкое
 *  поле: рендер списка референсов не должен тащить 1024px картинку ради иконки. */
export async function loadThumb(id) {
    const record = await transact('readonly', store => store.get(id));
    return record?.thumb || '';
}

/**
 * Копия записи хранилища (картинка или JSON) под новым id — для дубля черновика: у копии
 * должны быть СВОИ записи, иначе удаление оригинала (forgetDraftImages) стёрло бы картинки
 * у копии.
 * @returns {Promise<string|null>} новый id; null, если исходной записи уже нет
 */
export async function cloneStoredRecord(id) {
    const record = await transact('readonly', store => store.get(id));
    if (!record) return null;
    const copy = { ...record, id: uid(), at: Date.now() };
    await transact('readwrite', store => store.put(copy));
    return copy.id;
}

export async function deleteImage(id) {
    await transact('readwrite', store => store.delete(id));
}

/**
 * Тот же object store, что и у картинок, но для непрозрачных JSON-объектов —
 * например, дайджеста пресета, загруженного файлом (режим «Анализ» в index.js,
 * см. buildPresetDigestFromRaw в src/tavern-import.js). Заводить отдельную БД
 * ради одного дополнительного типа записи, когда IndexedDB и так умеет хранить
 * структуры как есть (structured clone, без ручного JSON.stringify), незачем.
 * Ключи полей другие (json вместо data/thumb) — так что коллизии с картинкой
 * по тому же id исключены чисто по форме записи.
 */
export async function storeJson(data, name = '') {
    const id = uid();
    await transact('readwrite', store => store.put({ id, json: data, name, at: Date.now() }));
    return id;
}

/** @returns {Promise<*>} сохранённый объект, или null если записи уже нет */
export async function loadJson(id) {
    const record = await transact('readonly', store => store.get(id));
    return record?.json ?? null;
}

/**
 * Картинки для запроса к модели.
 * @param {Array<{id: string}>} refs ссылки из черновика
 * @returns {Promise<string[]>} data URL'ы; пропавшие из хранилища молча пропускаются
 */
export async function loadImages(refs) {
    const list = await Promise.all((refs || []).map(ref => loadImage(ref.id)));
    return list.filter(Boolean);
}
