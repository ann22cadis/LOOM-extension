/**
 * Папки Таверны — надстройка над её собственными тегами с типом «папка»
 * (TAG_FOLDER_TYPES в tags.js), а не своя система хранения. Раскладка работает
 * через штатные tags/tag_map: результат виден и переживёт удаление LOOM, потому
 * что для самой Таверны это обычные, ничем не отличающиеся от ручных, папки.
 *
 * Куски, все — под настройкой folders_tool_enabled:
 *  - initFolderLongPress() — долгое нажатие на нативную кнопку «показать только
 *    папки» (.filterByFolder) ИЛИ на саму карточку папки в списке открывает
 *    раскладку LOOM; обычный тап по любой из них работает как раньше —
 *    фильтрует список или заходит в папку/раскрывает её.
 *  - applyFoldersCssClass() — переключает класс на <body>, включающий своё
 *    оформление превью-аватарок у нативных папок Таверны (см. style.css).
 *  - initFolderDropdownIntercept() — под ДОПОЛНИТЕЛЬНОЙ настройкой
 *    folders_dropdown_view: клик по самой папке (не по кнопке-фильтру, а по
 *    её карточке в списке) вместо захода внутрь раскрывает список персонажей
 *    папки на месте, выпадающим списком.
 *  - applyFolderCirclesCssClass() — ещё одна отдельная настройка folders_circles_view:
 *    тот же раскрытый список, но кружками-аватарками вместо строк.
 *
 * Это единственное место в LOOM, которое трогает интерфейс Таверны за пределами
 * собственной панели, поэтому выключено по умолчанию (см. DEFAULTS в settings.js).
 */

import { getSettings } from './settings.js';
import { fileToDataUrl, storeFolderAvatarImage, loadImage, deleteImage } from './images.js';
import {
    tags, tag_map, getTagsList, addTagsToEntity, removeTagFromEntity,
} from '../../../../tags.js';
import { selectCharacterById } from '../../../../../script.js';
import { openGroupById } from '../../../../group-chats.js';

const LOG = '[LOOM]';

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(type, message) {
    if (typeof toastr !== 'undefined') toastr[type](message, 'LOOM');
}

async function promptAction(message, defaultValue = '') {
    const ctx = SillyTavern.getContext();
    if (ctx?.Popup?.show?.input) {
        const value = await ctx.Popup.show.input('LOOM', message, defaultValue);
        return value === null ? null : String(value).trim();
    }
    const value = window.prompt(message, defaultValue);
    return value === null ? null : value.trim();
}

/** Класс на <body>, включающий оформление превью-аватарок у нативных папок Таверны. */
export function applyFoldersCssClass(enabled) {
    document.body.classList.toggle('loom-folders-style', !!enabled);
    // Включили посреди сессии — папки, уже отрисованные до этого момента, патчим
    // сразу, не дожидаясь следующей перерисовки списка персонажей.
    if (enabled) patchAllFolderIcons();
}

/**
 * Класс на <body>, включающий широкую растянутую плашку папки (см. style.css).
 * Отдельно от applyFoldersCssClass: без выпадающего списка (folders_dropdown_view)
 * растягивать папку незачем — разворачивать внутри неё нечего, клик заходит
 * внутрь папки как обычно, и выключенная настройка должна вернуть папке
 * обычный вид, как до этой правки, а не просто уменьшенную растянутую плашку.
 */
export function applyFolderDropdownCssClass(enabled) {
    document.body.classList.toggle('loom-folders-dropdown-style', !!enabled);
}

/**
 * Класс на <body>: развёрнутая папка показывает персонажей кружками (см. style.css).
 * Класс, а не флаг внутри toggleFolderInline: тогда переключатель в настройках действует
 * и на уже раскрытую папку, без повторного клика по ней.
 */
export function applyFolderCirclesCssClass(enabled) {
    document.body.classList.toggle('loom-folders-circles', !!enabled);
}

// ─── Данные: теги-папки и сущности, которые можно в них разложить ──────────

function isFolderTag(tag) {
    return !!tag && tag.folder_type !== undefined && tag.folder_type !== 'NONE';
}

/**
 * Групповые чаты не проходят через характерный для персонажей путь самоинициализации
 * в getTagKeyForEntity (там id группы по ошибке пытается стать индексом в массиве
 * персонажей, мимо) — если на группу ещё ни разу не вешали тег, addTagsToEntity
 * молча не сработает. Заводим пустую запись в tag_map заранее, той же формы,
 * что и для персонажа: дальше все штатные функции Таверны работают с группой
 * так же надёжно, как с персонажем.
 */
function ensureTagMapKey(key) {
    if (!Array.isArray(tag_map[key])) tag_map[key] = [];
}

function groupKey(group) {
    const key = String(group.id);
    ensureTagMapKey(key);
    return key;
}

/** Все теги-папки, висящие на сущности — персонаж или группа может состоять
 *  в нескольких сразу, это штатная возможность Таверны (см. addTagsToEntity
 *  в tags.js — она не ограничивает число тегов), LOOM её не отменяет. */
function currentFolderTags(key) {
    return getTagsList(key).filter(isFolderTag);
}

function characterAvatarUrl(ctx, character) {
    if (!character.avatar || character.avatar === 'none') return null;
    return ctx.getThumbnailUrl('avatar', character.avatar);
}

/** Не пытаемся воспроизвести коллаж из 4 аватаров участников, как это делает сама
 *  Таверна (getGroupAvatar в group-chats.js, приватная функция, не экспортирована) —
 *  для строки в списке хватает своей картинки группы или аватара первого участника. */
function groupAvatarUrl(ctx, group) {
    if (group.avatar_url) return group.avatar_url;
    const firstMember = (group.members || [])
        .map(avatar => ctx.characters.find(c => c.avatar === avatar))
        .find(Boolean);
    return firstMember ? characterAvatarUrl(ctx, firstMember) : null;
}

/** @returns {{type: 'character'|'group', key: string, name: string, avatarUrl: string|null, folders: object[]}[]} */
function listEntities() {
    const ctx = SillyTavern.getContext();
    const list = [];

    for (const character of ctx.characters || []) {
        if (!character.avatar || character.avatar === 'none') continue;
        const key = character.avatar;
        list.push({
            type: 'character', key, name: character.name,
            avatarUrl: characterAvatarUrl(ctx, character),
            folders: currentFolderTags(key),
        });
    }

    for (const group of ctx.groups || []) {
        const key = groupKey(group);
        list.push({
            type: 'group', key, name: group.name,
            avatarUrl: groupAvatarUrl(ctx, group),
            folders: currentFolderTags(key),
        });
    }

    return list;
}

/** true, если ВСЕ переданные сущности уже состоят в этой папке — определяет,
 *  снимет клик по опции папку или добавит (см. обработчик loom-folder-option-main). */
function allHaveFolder(entities, tagId) {
    return entities.length > 0 && entities.every(e => e.folders.some(t => t.id === tagId));
}

/**
 * Переключает папку у сущностей — добавляет тег тем, у кого его ещё нет,
 * снимает у тех, у кого уже есть, не трогая остальные их теги-папки.
 * Персонаж или группа может состоять сразу в нескольких папках — это
 * штатная возможность Таверны, а не ограничение, которое стоило бы имитировать.
 *
 * @param {{key: string}[]} entities
 * @param {string} tagId
 * @param {boolean} add true — добавить тег, false — снять
 */
function toggleFolder(entities, tagId, add) {
    const tag = tags.find(t => t.id === tagId);
    if (!tag) return;
    for (const entity of entities) {
        if (add) addTagsToEntity(tag, entity.key);
        else removeTagFromEntity(tag, entity.key);
    }
}

/** «Без папки» — убрать сущности из ВСЕХ папок разом, а не переключить одну. */
function clearFolders(entities) {
    for (const entity of entities) {
        for (const oldTag of getTagsList(entity.key).filter(isFolderTag)) {
            removeTagFromEntity(oldTag, entity.key);
        }
    }
}

/**
 * Заводит новую папку — тот же тег, что создала бы сама Таверна (см. newTag
 * в tags.js, не экспортирована), сразу с folder_type: 'OPEN'. Именующийся тег
 * уже существует — просто помечаем его папкой, а не плодим дубликат по имени.
 * @returns {object|null} null, если имя пустое
 */
function createFolder(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return null;

    const existing = tags.find(t => t.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) {
        if (!isFolderTag(existing)) existing.folder_type = 'OPEN';
        return existing;
    }

    const tag = {
        id: crypto.randomUUID(),
        name: trimmed,
        folder_type: 'OPEN',
        filter_state: undefined,
        sort_order: Math.max(0, ...tags.map(t => t.sort_order || 0)) + 1,
        is_hidden_on_character_card: false,
        color: '',
        color2: '',
        create_date: Date.now(),
    };
    tags.push(tag);
    SillyTavern.getContext().saveSettingsDebounced();
    return tag;
}

// ─── Своя аватарка папки в нативном списке персонажей Таверны ──────────────

/**
 * Заменяет стандартную иконку папки (font-awesome «folder») на картинку, если
 * пользователь её задал (tag.loomAvatarId — id в IndexedDB, своё поле на теге,
 * Таверна о нём не знает и не трогает при переименовании/перекраске, потому что
 * все её функции правки тега мутируют объект на месте, а не пересобирают его заново).
 *
 * Асинхронна из-за чтения IndexedDB — вызывающий код (patchAllFolderIcons,
 * MutationObserver) не ждёт результата, просто запускает и забывает: элемент
 * получит картинку чуть позже, максимум на кадр-другой позже своей отрисовки.
 */
async function patchFolderIcon(el) {
    const tagId = el.getAttribute('tagid');
    const tag = tags.find(t => t.id === tagId);
    const avatarBox = el.querySelector(':scope > .avatar');
    if (!avatarBox) return;

    const already = avatarBox.querySelector('.loom-folder-native-avatar');
    if (!tag?.loomAvatarId) {
        // Аватарку убрали (или это чужая, не-LOOM'овская папка) — возвращаем иконку,
        // если до этого стоял патч. Сам fa-иконка-элемент никуда не девался, скрыт.
        if (already) { already.remove(); avatarBox.querySelector('.bogus_folder_icon')?.classList.remove('loom-hidden'); }
        return;
    }

    const dataUrl = await loadImage(tag.loomAvatarId);
    if (!dataUrl) return; // картинку успели удалить, пока грузили

    if (already) { already.src = dataUrl; return; }
    avatarBox.querySelector('.bogus_folder_icon')?.classList.add('loom-hidden');
    avatarBox.insertAdjacentHTML('afterbegin', `<img class="loom-folder-native-avatar" src="${dataUrl}">`);
}

function patchAllFolderIcons() {
    document.querySelectorAll('.bogus_folder_select[tagid]').forEach(patchFolderIcon);
}

let folderIconObserver = null;

/**
 * MutationObserver, а не патч printCharacters/getTagBlock: они не экспортированы
 * из tags.js, и переопределять чужую функцию через монки-патчинг модуля куда
 * рискованнее, чем просто реагировать на то, что она уже отрисовала. Смотрим
 * именно #rm_print_characters_block, а не document целиком — иначе каждое
 * сообщение в чате (тоже меняющее DOM) гоняло бы этот колбэк без всякой пользы.
 */
export function initFolderIconObserver() {
    if (folderIconObserver) return;

    const attach = () => {
        const root = document.getElementById('rm_print_characters_block');
        if (!root) { setTimeout(attach, 500); return; }

        folderIconObserver = new MutationObserver((mutations) => {
            if (!getSettings().folders_tool_enabled) return;
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (!(node instanceof HTMLElement)) continue;
                    if (node.matches?.('.bogus_folder_select[tagid]')) patchFolderIcon(node);
                    node.querySelectorAll?.('.bogus_folder_select[tagid]').forEach(patchFolderIcon);
                }
            }
        });
        folderIconObserver.observe(root, { childList: true, subtree: true });
        patchAllFolderIcons();
    };
    attach();
}

// ─── Модалка раскладки ──────────────────────────────────────────────────────

let modalBuilt = false;
const selectedKeys = new Set();
let allEntities = [];
let allEntitiesByKey = new Map();

function ensureModal() {
    if (modalBuilt) return;
    modalBuilt = true;

    $('body').append(`
        <div id="loom-folders-backdrop" class="loom-folders-backdrop">
            <div class="loom-folders-modal">
                <header class="loom-folders-head">
                    <span><i class="fa-solid fa-folder-tree"></i> Разложить по папкам</span>
                    <button id="loom-folders-close" class="loom-icon-btn" title="Закрыть">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </header>

                <div class="loom-folder-select" id="loom-folder-select">
                    <button type="button" class="loom-folder-select-trigger" id="loom-folder-select-trigger">
                        <i class="fa-solid fa-folder-tree loom-folder-option-avatar loom-folder-option-avatar-empty"></i>
                        <span class="loom-folder-select-label">Папки</span>
                        <i class="fa-solid fa-chevron-down loom-folder-select-caret"></i>
                    </button>
                    <div id="loom-folders-chips" class="loom-folder-select-list"></div>
                </div>

                <div class="loom-folders-toolbar">
                    <input type="text" id="loom-folders-search" placeholder="Поиск по имени…">
                    <label class="loom-check compact">
                        <input type="checkbox" id="loom-folders-unsorted-only">
                        <span>Только без папки</span>
                    </label>
                </div>

                <div id="loom-folders-items" class="loom-folders-items"></div>

                <div class="loom-folders-foot">
                    <span id="loom-folders-selected">Выбрано: 0</span>
                    <span class="loom-hint">Отметьте персонажей, затем тапайте папки.</span>
                </div>
            </div>
        </div>`);

    $('#loom-folders-close').on('click', closeFolderSorter);
    $('#loom-folders-backdrop').on('click', function (event) {
        if (event.target === this) closeFolderSorter();
    });
    $('#loom-folders-search, #loom-folders-unsorted-only').on('input change', renderFolderItems);

    $('#loom-folders-items').on('change', '.loom-folder-item-check', function () {
        const key = $(this).closest('.loom-folder-item').data('key');
        if ($(this).is(':checked')) selectedKeys.add(String(key));
        else selectedKeys.delete(String(key));
        updateSelectedCount();
        renderFolderChips();
    });

    // Папка — не ряд отдельных кнопок, а обычный выпадающий список: закрытая
    // шторка с аватаркой и именем текущего выбора, разворачивается в список опций.
    $('#loom-folder-select-trigger').on('click', function (event) {
        event.stopPropagation();
        $('#loom-folder-select').toggleClass('open');
    });
    $(document).on('click.loomFolderSelect', function (event) {
        if (!$(event.target).closest('#loom-folder-select').length) $('#loom-folder-select').removeClass('open');
    });

    $('#loom-folders-chips').on('click', '.loom-folder-option-main', async function () {
        const option = $(this).closest('.loom-folder-option');
        if (option.hasClass('loom-folder-option-new')) {
            const name = await promptAction('Название новой папки:');
            const tag = createFolder(name);
            if (tag) { refreshEntities(); renderFolderChips(); renderFolderItems(); }
            return;
        }

        if (!selectedKeys.size) return toast('info', 'Сначала отметьте персонажей или групповые чаты.');

        const tagId = option.data('tag-id') === 'none' ? null : String(option.data('tag-id'));
        const entities = [...selectedKeys].map(key => allEntitiesByKey.get(key)).filter(Boolean);
        const count = entities.length;

        if (tagId === null) {
            clearFolders(entities);
            toast('success', `Убрано из всех папок: ${count}.`);
        } else {
            const targetName = tags.find(t => t.id === tagId)?.name;
            const removing = allHaveFolder(entities, tagId);
            toggleFolder(entities, tagId, !removing);
            toast('success', removing ? `Убрано из «${targetName}»: ${count}.` : `Добавлено в «${targetName}»: ${count}.`);
        }

        // Выбор и список НЕ закрываем и не сбрасываем — так же тем же составом
        // сразу можно ткнуть вторую папку и получить сущность сразу в двух.
        refreshEntities();
        renderFolderChips();
        renderFolderItems();
    });

    // Своя картинка папки — отдельный элемент рядом с кнопкой, а не внутри неё:
    // <input type=file> и вложенный <button> вместе невалидны и путают клики
    $('#loom-folders-chips').on('click change', '.loom-folder-avatar-btn, .loom-folder-avatar-input', function (event) {
        event.stopPropagation();
    });
    $('#loom-folders-chips').on('change', '.loom-folder-avatar-input', async function () {
        const file = this.files[0];
        this.value = '';
        if (!file) return;

        const tagId = String($(this).closest('.loom-folder-option').data('tag-id'));
        const tag = tags.find(t => t.id === tagId);
        if (!tag) return;

        const oldId = tag.loomAvatarId;
        try {
            const dataUrl = await fileToDataUrl(file);
            tag.loomAvatarId = await storeFolderAvatarImage(dataUrl);
        } catch (e) {
            return toast('error', e.message || 'Не удалось загрузить картинку.');
        }
        // Старую картинку убираем ПОСЛЕ того, как новая уже точно сохранилась и
        // тег указывает на неё — иначе неудачная запись новой оставила бы тег
        // без картинки вовсе, хотя старая ещё была жива.
        if (oldId) deleteImage(oldId).catch(() => {});

        SillyTavern.getContext().saveSettingsDebounced();
        renderFolderChips();
        patchAllFolderIcons();
        toast('success', `Картинка папки «${tag.name}» обновлена.`);
    });

    $('#loom-folders-chips').on('click', '.loom-folder-option-avatar-remove', function (event) {
        event.stopPropagation();
        const tagId = String($(this).closest('.loom-folder-option').data('tag-id'));
        const tag = tags.find(t => t.id === tagId);
        if (!tag) return;

        const oldId = tag.loomAvatarId;
        delete tag.loomAvatarId;
        if (oldId) deleteImage(oldId).catch(() => {});
        SillyTavern.getContext().saveSettingsDebounced();
        renderFolderChips();
        // Патч, а не просто ждём следующего рендера: Таверна переиспользует DOM-узел
        // папки, если структура списка не поменялась, и без явного вызова здесь
        // старая картинка осталась бы висеть в нативном списке до перезагрузки.
        patchAllFolderIcons();
        toast('info', `Картинка папки «${tag.name}» убрана.`);
    });
}

function refreshEntities() {
    allEntities = listEntities();
    allEntitiesByKey = new Map(allEntities.map(e => [e.key, e]));
}

/** Аватар одной опции: своя картинка (уже прочитанная из IndexedDB), иначе —
 *  нейтральная иконка-заглушка (своя для каждого места — ластик/папка/плюс). */
function folderOptionAvatarHtml(avatarUrl, fallbackIcon) {
    return avatarUrl
        ? `<img class="loom-folder-option-avatar" src="${escapeHtml(avatarUrl)}" alt="">`
        : `<i class="fa-solid ${fallbackIcon} loom-folder-option-avatar loom-folder-option-avatar-empty"></i>`;
}

/**
 * Асинхронна: картинки папок лежат в IndexedDB (см. storeFolderAvatarImage
 * в src/images.js), их надо прочитать ДО того, как собирать HTML целиком —
 * дробить сборку строки на синхронную разметку и отдельные <img>, которые сами
 * догружаются, не стоило: мельтешение при каждой перерисовке (открыли дропдаун,
 * отметили чекбокс — рендерится заново) заметнее одного лишнего await на старте.
 */
async function renderFolderChips() {
    const folders = tags.filter(isFolderTag).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const avatarUrls = new Map(await Promise.all(
        folders.filter(t => t.loomAvatarId).map(async t => [t.id, await loadImage(t.loomAvatarId)]),
    ));
    const countFor = (tagId) => allEntities.filter(e => e.folders.some(t => t.id === tagId)).length;
    const selected = [...selectedKeys].map(key => allEntitiesByKey.get(key)).filter(Boolean);
    // Галочка на опции — не «выбрано в дропдауне», а «все отмеченные слева уже
    // в этой папке»: следующий клик по ней снимет, а не добавит (см. allHaveFolder).
    const activeHtml = (tagId) => (selected.length && allHaveFolder(selected, tagId))
        ? '<i class="fa-solid fa-check loom-folder-option-check"></i>' : '';

    const html = [
        `<div class="loom-folder-option loom-folder-option-none" data-tag-id="none">
            <button class="loom-folder-option-main" type="button">
                ${folderOptionAvatarHtml(null, 'fa-eraser')}
                <span class="loom-folder-option-name">Без папки</span>
            </button>
        </div>`,
        ...folders.map(tag => `
            <div class="loom-folder-option" data-tag-id="${escapeHtml(tag.id)}"
                style="--folder-color:${escapeHtml(tag.color || '')}">
                <button class="loom-folder-option-main" type="button">
                    ${folderOptionAvatarHtml(avatarUrls.get(tag.id), 'fa-folder')}
                    <span class="loom-folder-option-name">${escapeHtml(tag.name)}</span>
                    ${activeHtml(tag.id)}
                    <span class="loom-folder-option-count">${countFor(tag.id)}</span>
                </button>
                <label class="loom-folder-avatar-btn" title="Своя картинка для папки">
                    <i class="fa-solid fa-camera"></i>
                    <input type="file" accept="image/*" class="loom-folder-avatar-input" hidden>
                </label>
                ${tag.loomAvatarId ? `
                <button type="button" class="loom-folder-option-avatar-remove" title="Убрать картинку папки">
                    <i class="fa-solid fa-xmark"></i>
                </button>` : ''}
            </div>`),
        `<div class="loom-folder-option loom-folder-option-new">
            <button class="loom-folder-option-main" type="button">
                ${folderOptionAvatarHtml(null, 'fa-plus')}
                <span class="loom-folder-option-name">Новая папка</span>
            </button>
        </div>`,
    ];
    $('#loom-folders-chips').html(html.join(''));
}

function renderFolderItems() {
    const search = String($('#loom-folders-search').val() || '').trim().toLowerCase();
    const onlyUnsorted = $('#loom-folders-unsorted-only').is(':checked');

    const filtered = allEntities.filter(e => {
        if (onlyUnsorted && e.folders.length) return false;
        if (search && !e.name.toLowerCase().includes(search)) return false;
        return true;
    });

    const html = filtered.map(e => `
        <label class="loom-folder-item" data-key="${escapeHtml(e.key)}">
            <input type="checkbox" class="loom-folder-item-check" ${selectedKeys.has(e.key) ? 'checked' : ''}>
            ${e.avatarUrl
                ? `<img class="loom-folder-item-avatar" src="${escapeHtml(e.avatarUrl)}" alt="">`
                : `<span class="loom-folder-item-avatar loom-folder-item-avatar-empty">
                       <i class="fa-solid ${e.type === 'group' ? 'fa-people-group' : 'fa-user'}"></i>
                   </span>`}
            <span class="loom-folder-item-name">${escapeHtml(e.name)}</span>
            ${e.folders.map(folder => `
                <span class="loom-folder-item-tag" style="--folder-color:${escapeHtml(folder.color || '')}">
                    ${escapeHtml(folder.name)}
                </span>`).join('')}
        </label>`).join('');

    $('#loom-folders-items').html(html || '<div class="loom-empty-note">Ничего не найдено.</div>');
    updateSelectedCount();
}

function updateSelectedCount() {
    $('#loom-folders-selected').text(`Выбрано: ${selectedKeys.size}`);
}

function openFolderSorter() {
    ensureModal();
    selectedKeys.clear();
    refreshEntities();
    renderFolderChips();
    renderFolderItems();
    $('#loom-folders-backdrop').addClass('open');
}

function closeFolderSorter() {
    $('#loom-folders-backdrop').removeClass('open');
    $('#loom-folder-select').removeClass('open');
}

// ─── Долгое нажатие открывает раскладку по папкам ───────────────────────────

const LONG_PRESS_MS = 550;
// Больше этого в пикселях — попытка проскроллить список, а не долгое нажатие
const MOVE_TOLERANCE = 10;

let pressTimer = null;
let pressStart = null;
let suppressNextClick = false;

function clearPressTimer() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    pressStart = null;
}

/**
 * Цель долгого нажатия — сама кнопка-фильтр «показать только папки»
 * (.filterByFolder) ИЛИ карточка папки в списке (.bogus_folder_select[tagid],
 * кроме кнопки «Назад» — она про выход из папки, не про её раскладку).
 *
 * Кнопка была первой и единственной целью, пока папка в списке была обычной
 * узкой плиткой — тогда «зажать саму папку» не читалось как естественное
 * действие. С тех пор папка стала широкой заметной плашкой (см. style.css),
 * и жать на неё саму — как раз то, что напрашивается; кнопка-фильтр в
 * тулбаре рядом с ней теперь маленькая и незаметная. Оставлена как
 * дополнительная цель, а не убрана — старая привычка не должна ломаться.
 */
function isLongPressTarget(target) {
    if (target.closest('.filterByFolder')) return true;
    const folderEl = target.closest('.bogus_folder_select[tagid]');
    return !!folderEl && !folderEl.classList.contains('bogus_folder_select_back');
}

/**
 * Вешается на document через делегирование, а не на сами элементы: и кнопка-
 * фильтр, и карточки папок пересобираются Таверной при каждой перерисовке
 * списка (getTagBlock / printCharacters строят новые узлы) — обработчик на
 * конкретном узле пережил бы максимум до следующей перерисовки. document же
 * никуда не девается.
 *
 * Идемпотентна — можно звать сколько угодно раз при перезагрузке расширения.
 */
export function initFolderLongPress() {
    if (document.__loomFolderLongPressInit) return;
    document.__loomFolderLongPressInit = true;

    document.addEventListener('pointerdown', (event) => {
        if (!getSettings().folders_tool_enabled) return;
        if (!isLongPressTarget(event.target)) return;
        pressStart = { x: event.clientX, y: event.clientY };
        pressTimer = setTimeout(() => {
            pressTimer = null;
            suppressNextClick = true;
            openFolderSorter();
        }, LONG_PRESS_MS);
    });

    document.addEventListener('pointermove', (event) => {
        if (!pressStart) return;
        if (Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > MOVE_TOLERANCE) {
            clearPressTimer();
        }
    });

    document.addEventListener('pointerup', clearPressTimer);
    document.addEventListener('pointercancel', clearPressTimer);

    // Перехват в фазе погружения (capture) — раньше, чем клик доберётся до
    // обработчика самой Таверны: тот висит на кнопке-фильтре в фазе всплытия
    // (см. printTagList в tags.js), а на карточке папки — до initFolderDropdownIntercept
    // ниже (тоже погружение, но регистрируется в index.js позже этой функции,
    // так что при том же клике сработает вторым). Погружение всегда отрабатывает
    // первым и в порядке регистрации — то есть здесь надёжно раньше обоих.
    document.addEventListener('click', (event) => {
        if (!suppressNextClick) return;
        suppressNextClick = false;
        if (!isLongPressTarget(event.target)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    }, true);

    // На телефоне долгое нажатие иначе вызывает системное контекстное меню
    // (а над своей картинкой папки — ещё и колбэк «Сохранить изображение»)
    document.addEventListener('contextmenu', (event) => {
        if (getSettings().folders_tool_enabled && isLongPressTarget(event.target)) {
            event.preventDefault();
        }
    });

    console.log(LOG, 'Долгое нажатие на папки готово.');
}

// ─── Список содержимого папки раскрывается ВНУТРИ её же карточки ───────────
//
// Не отдельный плавающий список под папкой (так было в первой версии) —
// список членов дописывается ПОСЛЕДНИМ ребёнком в саму .bogus_folder_select,
// и та же карточка, с той же рамкой и скруглением, просто становится выше.
// Технически — flex-wrap: wrap на карточке (сама она flex-row: иконка +
// колонка с именем) плюс flex-basis: 100% у списка, чтобы он ушёл на новую
// строку внутри той же рамки, а не встал в конец текущей.

/** Убирает раскрытый список из карточки папки, если он был. */
function collapseFolderInline(folderEl) {
    folderEl.classList.remove('loom-folder-expanded');
    folderEl.querySelector(':scope > .loom-folder-inline-list')?.remove();
}

/** Раскрывает или сворачивает список персонажей и групп внутри карточки. */
function toggleFolderInline(folderEl) {
    const wasOpen = folderEl.classList.contains('loom-folder-expanded');

    // Одновременно раскрыта только одна папка — иначе список быстро раздувает
    // всю страницу, если потыкать по нескольким подряд
    document.querySelectorAll('.bogus_folder_select.loom-folder-expanded').forEach(el => {
        if (el !== folderEl) collapseFolderInline(el);
    });

    if (wasOpen) { collapseFolderInline(folderEl); return; }

    const tagId = folderEl.getAttribute('tagid');
    const members = listEntities().filter(e => e.folders.some(t => t.id === tagId));

    const rowsHtml = members.length
        ? members.map(e => `
            <div class="loom-folder-inline-row" data-type="${e.type}" data-key="${escapeHtml(e.key)}">
                ${e.avatarUrl
                    ? `<img class="loom-folder-inline-avatar" src="${escapeHtml(e.avatarUrl)}" alt="">`
                    : `<i class="fa-solid ${e.type === 'group' ? 'fa-people-group' : 'fa-user'} loom-folder-inline-avatar loom-folder-inline-avatar-empty"></i>`}
                <span class="loom-folder-inline-name">${escapeHtml(e.name)}</span>
            </div>`).join('')
        : '<div class="loom-folder-inline-empty">Папка пуста.</div>';

    folderEl.insertAdjacentHTML('beforeend', `<div class="loom-folder-inline-list">${rowsHtml}</div>`);
    folderEl.classList.add('loom-folder-expanded');
}

/** Клик по строке персонажа/группы внутри раскрытого списка — открывает её и сворачивает список. */
function openFolderInlineMember(row) {
    const folderEl = row.closest('.bogus_folder_select');
    const type = row.getAttribute('data-type');
    const key = String(row.getAttribute('data-key'));
    if (folderEl) collapseFolderInline(folderEl);

    if (type === 'group') { openGroupById(key); return; }
    const ctx = SillyTavern.getContext();
    const index = ctx.characters.findIndex(c => c.avatar === key);
    if (index !== -1) selectCharacterById(index);
}

/**
 * Перехватывает клик по самой папке (не по кнопке-фильтру папок — это отдельный
 * долгий-нажатие путь выше) и, если включена настройка folders_dropdown_view,
 * раскрывает список персонажей внутри её же карточки вместо штатного захода внутрь.
 *
 * Погружение (capture), а не всплытие — родной обработчик Таверны
 * ($(document).on('click', '.bogus_folder_select', …) в script.js) висит на
 * всплытии и сработал бы первым, а stopImmediatePropagation после него уже
 * ничего не остановит.
 *
 * Кнопка «Назад» (id=BogusFolderBack, tagid="back") не трогается — это не вход
 * в папку, а выход из неё, штатное поведение для неё нужно как есть.
 */
export function initFolderDropdownIntercept() {
    if (document.__loomFolderDropdownInit) return;
    document.__loomFolderDropdownInit = true;

    document.addEventListener('click', (event) => {
        if (!getSettings().folders_tool_enabled || !getSettings().folders_dropdown_view) return;

        const memberRow = event.target.closest('.loom-folder-inline-row');
        if (memberRow) {
            event.preventDefault();
            event.stopImmediatePropagation();
            openFolderInlineMember(memberRow);
            return;
        }

        const folderEl = event.target.closest('.bogus_folder_select[tagid]');
        if (folderEl && !folderEl.classList.contains('bogus_folder_select_back')) {
            event.preventDefault();
            event.stopImmediatePropagation();
            toggleFolderInline(folderEl);
            return;
        }

        // Клик где-то ещё в списке (или вовсе мимо) — сворачиваем уже раскрытую папку,
        // если есть: список живёт внутри общего потока страницы, а не поверх него,
        // так что закрывать его по скроллу, как плавающее окно, не нужно вовсе
        const expanded = document.querySelector('.bogus_folder_select.loom-folder-expanded');
        if (expanded) collapseFolderInline(expanded);
    }, true);

    console.log(LOG, 'Перехват клика по папке (список внутри карточки) готов.');
}
