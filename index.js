/**
 * LOOM — мастерская миров для SillyTavern.
 *
 * Расширение собирает карточки персонажей и лорбуки в диалоге с моделью. Ключевая
 * механика: модель пишет текст АБЗАЦАМИ, пользователь оценивает каждый абзац по шкале
 * 0–10 и может оставить к нему комментарий, после чего оценки уходят обратно в промпт —
 * модель переписывает карточку, зная, что именно зашло, а что нет.
 *
 * Файлы:
 *   src/settings.js — настройки и форматы карточек
 *   src/api.js      — слой генерации (профили подключения, рассуждения, разбор JSON)
 *   src/prompts.js  — сборка промптов из формата
 *   src/drafts.js   — модель черновика и хранение
 *   src/keys.js     — ключевые слова лорбука и регулярные выражения
 *   src/export.js   — выгрузка в Таверну
 *   src/tavern-import.js — импорт персонажей и лорбуков ИЗ Таверны, с резервной копией
 */

import {
    getSettings, saveSettings, saveSettingsImmediate, CARD_TARGETS, DEFAULT_CHARACTER_FORMAT, DEFAULT_LOREBOOK_FORMAT,
    DEFAULT_PERSONA_FORMAT, BUILTIN_CHARACTER_PRESETS, BUILTIN_LOREBOOK_PRESETS, BUILTIN_PERSONA_PRESETS, activeFormat,
    LOREBOOK_CATEGORIES, KEY_LANGUAGES, DEFAULT_PROMPT_FORMAT, BUILTIN_PROMPT_PRESETS, DEFAULT_SCENARIO_FORMAT,
    BUILTIN_SCENARIO_PRESETS, DEFAULT_PRESET_FORMAT, BUILTIN_PRESET_PRESETS, DEFAULT_ANALYSIS_FORMAT, BUILTIN_ANALYSIS_PRESETS,
    DEFAULT_PROMPT_SCENARIO_CARD, DEFAULT_PROMPT_FIRST_MES, DEFAULT_PROMPT_KEYS, DEFAULT_PROMPT_PLOT, DEFAULT_PROMPT_PLOT_PACING,
} from './src/settings.js';
import { callAI, parseJsonLoose, listConnectionProfiles, setAbortSignal } from './src/api.js';
import {
    characterSystemPrompt, characterCreatePrompt, characterRewritePrompt, alternateGreetingPrompt, alternateGreetingsBatchPrompt,
    lorebookSystemPrompt, lorebookPlanPrompt, lorebookEntryPrompt, lorebookEntriesBatchPrompt, lorebookRewritePrompt,
    personaSystemPrompt, personaCreatePrompt, personaRewritePrompt,
    promptSystemPrompt, promptCreatePrompt, promptRewritePrompt,
    plotSystemPrompt, plotCreatePrompt, plotStepPrompt,
    scenarioSystemPrompt, scenarioIdeasPrompt, scenarioCreatePrompt, scenarioRewritePrompt, SCENARIO_IDEA_COUNT,
    presetSystemPrompt, presetPlanPrompt, presetEntryPrompt, presetEntriesBatchPrompt, presetRewritePrompt,
    analysisSystemPrompt, analysisCreatePrompt, analysisRewritePrompt, splitPromptFix,
    speakerNames,
    translatePrompt, translateEntriesPrompt,
} from './src/prompts.js';
import {
    listDrafts, getDraft, createDraft, deleteDraft, touchDraft, isDraftEmpty, createEntry,
    cloneDraftData, insertDraftAfter,
    sectionsFromResponse, carryOverRatings, pushHistory, popHistory, redoHistory,
    pushEntriesHistory, popEntriesHistory, redoEntriesHistory,
    pushStepsHistory, popStepsHistory, redoStepsHistory,
    averageRating, countBlocks, applyTranslation, uid,
    splitApprovedSections, mergeSections,
} from './src/drafts.js';
import {
    buildFormatPresetFile, parseFormatPresetFile, formatPresetFileName, uniquePresetName,
    FORMAT_KIND_LABELS,
} from './src/format-presets.js';
import { buildKeyRegexes, compileKeys, validateKey, testKey, isRegexKey, repairIndeclinableKeys } from './src/keys.js';
import {
    exportCharacter, exportLorebook, exportPersona, exportPreset, buildCharacterCard, downloadJson,
    buildSectionsText, copyToClipboard, downloadText, listPresetBlocks, putPresetBlock,
} from './src/export.js';
import {
    storeImage, deleteImage, loadImages, loadImage, loadThumb, toAvatarPng, toPersonaAvatarPng,
    storeJson, loadJson, cloneStoredRecord,
} from './src/images.js';
import { embedCardInPng, downloadPng } from './src/png.js';
import {
    listTavernCharacters, listTavernWorlds, listTavernPersonas,
    importCharacterFromTavern, importWorldFromTavern, importPersonaFromTavern,
    listTavernPresets, readTavernPresetRaw, buildPresetDigestFromRaw, importPresetFromTavern,
} from './src/tavern-import.js';
import { parseCharacterFile, parseLorebookFile, parsePersonaFile, parsePresetFile } from './src/file-import.js';
import {
    initFolderLongPress, initFolderIconObserver, initFolderDropdownIntercept, applyFoldersCssClass,
    applyFolderDropdownCssClass, applyFolderCirclesCssClass,
} from './src/folders.js';
import {
    initPlot, renderWidget, currentPlot, getPlotState, isChatOpen, boundDraftId, bindPlot, unbindPlot,
    setPlotStep, advancePlot, backPlot, plotProgress, plotLeaves, stepRange, chatCast,
} from './src/plot.js';
import { applyAppearance, renderThemePicker, bindThemePicker, initCustomSelects } from './src/appearance.js';

const LOG = '[LOOM]';

// Имя папки берём из URL модуля, а не хардкодим: расширение должно работать
// и после переименования папки пользователем.
const EXTENSION_PATH = (() => {
    const m = /\/scripts\/extensions\/(.+)\/index\.js/.exec(import.meta.url);
    return m ? m[1] : 'third-party/LOOM';
})();
const TEMPLATES_PATH = `${EXTENSION_PATH}/templates`;

/** Что сейчас открыто в главной области. */
const state = {
    draftId: null,
    busy: false,
    abortController: null,
    // Вес в токенах — id черновика ИЛИ id записи лорбука → { tokens }. Не в самом
    // черновике и не в settings.json: это производная величина, которую дёшево
    // посчитать заново, а держать в постоянном хранилище незачем. Живёт только
    // до перезагрузки страницы.
    weights: new Map(),
};

// ─── Утилиты ────────────────────────────────────────────────────────────────

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(type, message) {
    if (typeof toastr !== 'undefined') toastr[type](message, 'LOOM');
    else console.log(LOG, type, message);
}

/**
 * Обёртка вокруг долгой операции: гасит кнопки, показывает статус и превращает
 * любую ошибку в один тост. Без неё двойной клик по «Сгенерировать» запускает
 * две генерации и вторая затирает первую.
 */
async function withBusy(label, fn) {
    if (state.busy) {
        toast('info', 'Дождитесь окончания текущей генерации.');
        return null;
    }
    showError('');
    state.busy = true;
    state.abortController = new AbortController();
    setAbortSignal(state.abortController.signal);
    setStatus(label);
    $('#loom-panel').addClass('loom-busy');
    try {
        return await fn();
    } catch (error) {
        if (error?.aborted) {
            toast('info', 'Генерация остановлена.');
            return null;
        }
        console.error(LOG, label, error);
        const message = error?.message || String(error);
        // Тост Таверны про сбой API легко пропустить (исчезает, скрыт панелью) — поэтому текст
        // ошибки остаётся и внутри LOOM, пока его не закроют. Свой тост нужен, только если Таверна молчит.
        showError(message);
        if (!error?.reportedByTavern) toast('error', message);
        return null;
    } finally {
        state.busy = false;
        state.abortController = null;
        setAbortSignal(null);
        setStatus('');
        $('#loom-panel').removeClass('loom-busy');
    }
}

/** Кнопка «Стоп» рядом со статусом: гасит текущий запрос к модели, каким бы он ни был. */
function stopBusy() {
    if (!state.busy || !state.abortController) return;
    state.abortController.abort();
    // generateRaw (главный API Таверны) сигнала не принимает — она слушает это событие,
    // так же, как обычная кнопка «Стоп» в чате (см. api.js).
    const ctx = SillyTavern.getContext();
    ctx.eventSource?.emit?.(ctx.event_types?.GENERATION_STOPPED);
    setStatus('Останавливаю…');
}

/** Ошибка внутри панели LOOM: не пропадает сама, закрывается крестиком или новым запросом. */
function showError(text) {
    const $error = $('#loom-error');
    if (!$error.length) return;
    $error.toggleClass('visible', !!text).find('.loom-error-text').text(text || '');
}

function setStatus(text) {
    const $status = $('#loom-status');
    if (!$status.length) return;
    $status.toggleClass('visible', !!text).find('.loom-status-text').text(text || '');
}

function currentDraft() {
    return state.draftId ? getDraft(state.draftId) : null;
}

// ─── Панель ─────────────────────────────────────────────────────────────────

/**
 * Уходим из черновика — и если в нём так ничего и не появилось, удаляем его молча.
 * Пока идёт генерация, не трогаем: ответ модели ещё может в него записаться.
 */
function dropIfEmpty(id) {
    if (!id || state.busy) return;
    const draft = getDraft(id);
    if (!isDraftEmpty(draft)) return;
    deleteDraft(id);
    if (state.draftId === id) state.draftId = null;
}

/** Все пустые черновики, кроме открытого, — хвосты от случайных кликов до появления автоудаления. */
function dropEmptyDrafts() {
    if (state.busy) return;
    for (const draft of [...listDrafts()]) {
        if (draft.id !== state.draftId && isDraftEmpty(draft)) deleteDraft(draft.id);
    }
}

async function openPanel() {
    if ($('#loom-backdrop').length === 0) {
        const { renderExtensionTemplateAsync } = SillyTavern.getContext();
        try {
            const html = await renderExtensionTemplateAsync(TEMPLATES_PATH, 'panel');
            $('body').append(html);
            $('#loom-panel').append(
                '<div id="loom-status" class="loom-status">'
                + '<i class="fa-solid fa-spinner fa-spin"></i> <span class="loom-status-text"></span>'
                + '<button type="button" id="loom-stop-btn" class="loom-stop-btn" title="Остановить генерацию"><i class="fa-solid fa-stop"></i></button>'
                + '</div>'
                + '<div id="loom-error" class="loom-error" role="alert">'
                + '<i class="fa-solid fa-triangle-exclamation"></i><span class="loom-error-text"></span>'
                + '<button type="button" id="loom-error-close" class="loom-stop-btn" title="Закрыть"><i class="fa-solid fa-xmark"></i></button>'
                + '</div>',
            );
            $('#loom-error-close').on('click', () => showError(''));
            bindPanelEvents();
            bindSettingsEvents();
        } catch (error) {
            console.error(LOG, 'Не удалось загрузить шаблон панели', error);
            toast('error', 'Не удалось загрузить интерфейс LOOM.');
            return;
        }
    }

    // Показываем панель ДО отрисовки содержимого: раньше сбой в любом из
    // рендеров (например, битый формат в настройках) обрывал функцию до fadeIn,
    // и по кнопке внешне не происходило ничего.
    $('#loom-backdrop').css('display', 'flex').hide().fadeIn(150);

    try {
        dropIfEmpty(state.draftId);
        dropEmptyDrafts();
        // Разовая починка ключей вида «Энни» → «Энн» (см. repairIndeclinableKeys)
        let repairedKeys = 0;
        for (const draft of listDrafts()) {
            for (const entry of draft.entries || []) repairedKeys += repairIndeclinableKeys(entry);
        }
        if (repairedKeys) saveSettings();
        loadSettingsUi();
        // Тема Таверны могла смениться, пока панель была закрыта — перечитываем её цвета
        applyAppearance();
        renderDraftList();
        renderMain();
    } catch (error) {
        console.error(LOG, 'Ошибка отрисовки панели', error);
        toast('error', 'LOOM открылся с ошибкой отрисовки — подробности в консоли.');
    }
}

function closePanel() {
    dropIfEmpty(state.draftId);
    $('#loom-backdrop').fadeOut(150);
}

function bindPanelEvents() {
    $('#loom-close-btn').on('click', closePanel);
    $('#loom-stop-btn').on('click', stopBusy);
    // .loom-overlay — общий класс у #loom-settings и #loom-import: оба рисуются
    // поверх всей панели, оба открываются классом .open, и раньше ничто не мешало
    // открыть их одновременно — тогда более поздний в разметке (#loom-import)
    // просто перекрывал первый целиком, и клик по шестерёнке настроек выглядел
    // так, будто ничего не происходит.
    $('#loom-settings-btn').on('click', () => {
        $('.loom-overlay').removeClass('open');
        loadSettingsUi();
        $('#loom-settings').addClass('open');
    });
    $('#loom-settings-close').on('click', () => $('#loom-settings').removeClass('open'));

    $('#loom-import-btn').on('click', () => {
        $('.loom-overlay').removeClass('open');
        renderImportLists();
        $('#loom-import').addClass('open');
    });
    $('#loom-import-close').on('click', () => $('#loom-import').removeClass('open'));
    $('#loom-import-go').on('click', runTavernImport);

    // Общая кнопка «Импорт» → маленькое меню «что импортируем» → системный выбор файла.
    // Один <input type=file> на все четыре типа: accept и «что с этим делать потом»
    // переставляются перед открытием, а не четыре разных поля как раньше.
    $('#loom-import').on('click', '.loom-menu-toggle', function (event) {
        event.stopPropagation();
        const $menu = $(this).closest('.loom-menu');
        const wasOpen = $menu.hasClass('open');
        $('#loom-import .loom-menu').removeClass('open');
        if (!wasOpen) $menu.addClass('open');
    });
    $(document).on('click.loomImportMenu', () => $('#loom-import .loom-menu').removeClass('open'));

    $('#loom-import').on('click', '.loom-menu-item[data-import-file]', function () {
        const kind = $(this).data('import-file');
        const config = FILE_IMPORT_KINDS[kind];
        if (!config) return;
        const input = document.getElementById('loom-import-file-input');
        input.accept = config.accept;
        input.dataset.kind = kind;
        input.click();
    });

    $('#loom-import-file-input').on('change', function () {
        // Копия массивом, а не ссылка на this.files: FileList живая и опустошается тем же
        // сбросом value ниже — без копии обработчик увидел бы уже пустой список
        const files = [...this.files];
        const kind = this.dataset.kind;
        this.value = '';
        FILE_IMPORT_KINDS[kind]?.run(files);
    });

    $('#loom-backdrop').on('click', '.loom-new', function () {
        const requested = $(this).data('mode');
        const mode = ['lorebook', 'persona', 'prompt', 'scenario', 'preset', 'plot'].includes(requested) ? requested : 'character';
        dropIfEmpty(state.draftId);
        const draft = createDraft(mode);
        state.draftId = draft.id;
        renderDraftList();
        renderMain();
    });

    // «Создать» на мобильной раскладке: сеткой 3×2 там не помещается на один экран,
    // вместо неё одна кнопка и шторка со списком (см. #loom-new-sheet в panel.html).
    // Пункты шторки — те же .loom-new, обработчик выше их уже создаёт; здесь только
    // открытие/закрытие самой шторки.
    $('#loom-new-toggle').on('click', () => $('#loom-new-sheet').addClass('open'));
    $('#loom-new-sheet-cancel').on('click', () => $('#loom-new-sheet').removeClass('open'));
    // Клик мимо шторки (по затемнению) — тот же жест, что и «Отмена»
    $('#loom-new-sheet').on('click', function (event) {
        if (event.target === this) $(this).removeClass('open');
    });
    // Выбор пункта — закрыть шторку, само создание уже сделал делегированный .loom-new выше
    $('#loom-new-sheet').on('click', '.loom-sheet-item', () => $('#loom-new-sheet').removeClass('open'));

    bindSheetDrag();

    $('#loom-draft-list').on('click', '.loom-draft-group-head', function () {
        const $group = $(this).closest('.loom-draft-group');
        const open = $group.hasClass('collapsed');
        $group.toggleClass('collapsed', !open);
        $(this).attr('aria-expanded', String(open));
        // Пока идёт поиск, все найденные группы раскрыты принудительно — выбор не запоминаем
        if (!String($('#loom-draft-search').val() || '').trim()) writeGroupState($group.data('mode'), open);
    });

    $('#loom-draft-search').on('input', renderDraftList);

    $('#loom-draft-search-clear').on('click', function () {
        $('#loom-draft-search').val('').trigger('input').trigger('focus');
    });

    $('#loom-draft-list').on('click', '.loom-draft-item', function () {
        const nextId = $(this).data('id');
        if (nextId !== state.draftId) dropIfEmpty(state.draftId);
        state.draftId = nextId;
        renderDraftList();
        renderMain();
    });

    $('#loom-draft-list').on('click', '.loom-draft-delete', async function (event) {
        event.stopPropagation();
        const id = $(this).closest('.loom-draft-item').data('id');
        const draft = getDraft(id);
        if (!draft) return;
        const ok = await confirmAction(`Удалить черновик «${draft.name || 'без имени'}»? Это необратимо.`);
        if (!ok) return;
        // Картинки в IndexedDB не привязаны к settings.json — сами не удалятся
        await forgetDraftImages(draft);
        deleteDraft(id);
        if (state.draftId === id) state.draftId = null;
        renderDraftList();
        renderMain();
    });

    $('#loom-draft-list').on('click', '.loom-draft-copy', function (event) {
        event.stopPropagation();
        duplicateDraft($(this).closest('.loom-draft-item').data('id'));
    });

    bindEditorEvents();
}

/**
 * Протяжка шторки «Создать» вниз за ручку — закрывает, как и положено нативной шторке.
 * Pointer Events с захватом указателя: тот же приём, что и у попапа цвета в
 * src/appearance.js (см. комментарий там про setPointerCapture и try/catch).
 * Только за ручку, а не за всю шторку — иначе случайное касание фона списка
 * (сам список не скроллится, но палец на нём — обычный жест листания) сдвигало бы её.
 */
function bindSheetDrag() {
    const overlay = document.getElementById('loom-new-sheet');
    const sheet = overlay?.querySelector('.loom-sheet');
    const handle = overlay?.querySelector('.loom-sheet-handle');
    if (!overlay || !sheet || !handle) return;

    // Ниже этой доли высоты шторки (или на любом заметном рывке) — досвайпали, закрываем
    const CLOSE_RATIO = 0.28;
    const CLOSE_PX = 120;

    handle.addEventListener('pointerdown', event => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        event.preventDefault();
        try { handle.setPointerCapture(event.pointerId); } catch { /* нет активного указателя с этим id — редкое старое окружение */ }

        const startY = event.clientY;
        sheet.classList.add('loom-sheet-dragging');

        const move = e => {
            const dy = Math.max(0, e.clientY - startY);
            sheet.style.transform = `translateY(${dy}px)`;
        };
        const up = e => {
            handle.removeEventListener('pointermove', move);
            sheet.classList.remove('loom-sheet-dragging');
            sheet.style.transform = '';
            const dy = Math.max(0, e.clientY - startY);
            if (dy > sheet.offsetHeight * CLOSE_RATIO || dy > CLOSE_PX) $(overlay).removeClass('open');
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up, { once: true });
        handle.addEventListener('pointercancel', up, { once: true });
    });
}

/**
 * Дубль черновика: те же тексты, оценки и настройки, но собственные картинки и без привязки
 * к файлу в Таверне (см. cloneDraftData). Открывается сразу — обычно копируют, чтобы править.
 */
async function duplicateDraft(id) {
    const source = getDraft(id);
    if (!source) return;
    // Копия удваивает и тексты, и картинки в настройках — случайный тап по значку не должен её плодить
    const ok = await confirmAction(`Создать копию «${source.name || 'без имени'}»?`);
    if (!ok) return;
    dropIfEmpty(state.draftId === id ? null : state.draftId);

    const copy = cloneDraftData(source);
    // Картинки — свои записи в IndexedDB. Пропавшая из хранилища ссылка просто отбрасывается.
    const cloneRefs = async refs => (await Promise.all((refs || []).map(async ref => {
        const newId = await cloneStoredRecord(ref.id);
        return newId ? { ...ref, id: newId } : null;
    }))).filter(Boolean);

    try {
        copy.images = await cloneRefs(copy.images);
        if (copy.avatar) copy.avatar = (await cloneRefs([copy.avatar]))[0] || null;
        for (const entry of copy.entries || []) entry.images = await cloneRefs(entry.images);
        if (copy.review?.source?.kind === 'file' && copy.review.source.digestId) {
            const digestId = await cloneStoredRecord(copy.review.source.digestId);
            copy.review.source = digestId ? { ...copy.review.source, digestId } : { kind: 'file', label: '' };
        }
    } catch (error) {
        console.error(LOG, 'Не удалось скопировать картинки черновика', error);
        await forgetDraftImages(copy);
        toast('error', 'Не удалось скопировать картинки — дубль не создан.');
        return;
    }

    insertDraftAfter(id, copy);
    state.draftId = copy.id;
    renderDraftList();
    renderMain();
    toast('success', `Дубль создан: «${copy.name || 'без имени'}».`);
}

/**
 * Окно «Вставить в пресет»: пресет + блок (или новый). Возвращает выбор или null.
 * Блок угадывается по названию, упомянутому в тексте замечания.
 */
async function pickPresetTarget(defaultPreset, hintText, newText = '') {
    const ctx = SillyTavern.getContext();
    const presets = listTavernPresets();
    if (!presets.length) throw new Error('В Таверне нет пресетов Chat Completion.');
    const wrap = document.createElement('div');
    wrap.className = 'loom-apply-dialog';
    wrap.innerHTML = `
        <h3>Вставить в пресет</h3>
        <label>Пресет<select class="loom-apply-preset">${presets.map(n =>
        `<option value="${escapeHtml(n)}" ${n === defaultPreset ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}</select></label>
        <label>Блок<select class="loom-apply-block"></select></label>
        <label class="loom-apply-newname-wrap" hidden>Название нового блока<input type="text" class="loom-apply-newname" value="Из анализа LOOM"></label>
        <small>Старый текст блока сохранится в LOOM.</small>`;
    const $preset = $(wrap).find('.loom-apply-preset');
    const $block = $(wrap).find('.loom-apply-block');
    const fill = () => {
        const blocks = listPresetBlocks(String($preset.val()));
        const haystack = String(hintText || '').toLowerCase();
        // Сначала по названию из замечания, иначе — самый похожий по словам блок; новый — только если ничего похожего
        const words = text => new Set(String(text).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []);
        const mine = words(newText);
        const similarity = b => {
            const other = words(b.content);
            let common = 0;
            for (const w of mine) if (other.has(w)) common++;
            return common / Math.max(1, Math.min(mine.size, other.size));
        };
        const byName = blocks
            .filter(b => b.name.trim().length > 2 && haystack.includes(b.name.trim().toLowerCase()))
            .sort((a, b) => b.name.length - a.name.length)[0];
        const bySimilarity = blocks.map(b => ({ b, score: similarity(b) })).sort((a, b) => b.score - a.score)[0];
        const guess = byName || (bySimilarity?.score >= 0.25 ? bySimilarity.b : null);
        $block.html(`${blocks.map(b =>
            `<option value="${escapeHtml(b.identifier)}" ${guess?.identifier === b.identifier ? 'selected' : ''}>${escapeHtml(b.name)}</option>`).join('')}
            <option value="" ${guess ? '' : 'selected'}>+ Новый блок</option>`);
        $(wrap).find('.loom-apply-newname-wrap').prop('hidden', !!$block.val());
    };
    $preset.on('change', fill);
    $block.on('change', () => $(wrap).find('.loom-apply-newname-wrap').prop('hidden', !!$block.val()));
    fill();

    const popup = new ctx.Popup(wrap, ctx.POPUP_TYPE.CONFIRM, '', { okButton: 'Вставить', cancelButton: 'Отмена' });
    if (await popup.show() !== ctx.POPUP_RESULT.AFFIRMATIVE) return null;
    return {
        preset: String($preset.val()),
        identifier: String($block.val() || ''),
        name: String($(wrap).find('.loom-apply-newname').val() || '').trim(),
    };
}

/** «В пресет»: готовый текст из разбора → блок пресета Таверны, старый текст — в копии. */
async function applyPromptToPreset(draft, block) {
    const text = String(block.prompt || '').trim();
    if (!text) return toast('error', 'Поле пустое.');
    const source = draft.review.source;
    let target;
    try {
        target = await pickPresetTarget(source?.kind === 'tavern' ? source.presetName : '', block.text, text);
    } catch (error) {
        return toast('error', error.message);
    }
    if (!target) return;

    await withBusy('Вставляю в пресет…', async () => {
        const result = await putPresetBlock(target.preset, target.identifier, text, target.name);
        if (result.old?.trim()) {
            const review = draft.review;
            review.backups = [{
                id: uid(), at: Date.now(), preset: target.preset, identifier: result.identifier,
                blockName: result.name, old: result.old,
            }, ...(review.backups || [])].slice(0, 30);
        }
        touchDraft(draft);
        renderMain();
        toast('success', result.old === null
            ? `Новый блок «${result.name}» добавлен в «${target.preset}» (выключенным).`
            : `Блок «${result.name}» заменён. Старый текст — в копиях.`);
    });
}

/** Подтверждение через Popup Таверны, с откатом на нативный confirm. */
async function confirmAction(message) {
    const ctx = SillyTavern.getContext();
    if (ctx?.Popup?.show?.confirm) {
        return await ctx.Popup.show.confirm('LOOM', message);
    }
    return window.confirm(message);
}

/** Запрос строки через попап Таверны, с откатом на нативный prompt. @returns {Promise<string|null>} */
async function promptAction(message, defaultValue = '') {
    const ctx = SillyTavern.getContext();
    if (ctx?.Popup?.show?.input) {
        const value = await ctx.Popup.show.input('LOOM', message, defaultValue);
        return value === null ? null : String(value).trim();
    }
    const value = window.prompt(message, defaultValue);
    return value === null ? null : value.trim();
}

// ─── Список черновиков ──────────────────────────────────────────────────────

/** Группы списка черновиков: персонажи и лорбуки — разные вещи, вперемешку их не читать. */
const DRAFT_GROUPS = [
    { mode: 'character', label: 'Персонажи', icon: 'fa-user-pen' },
    { mode: 'persona', label: 'Персоны', icon: 'fa-user-tag' },
    { mode: 'lorebook', label: 'Лорбуки', icon: 'fa-book-open' },
    { mode: 'plot', label: 'Сюжеты', icon: 'fa-route' },
    // Прежний режим «Сценарий» из меню убран (его место занял «Сюжет»), но старые черновики открываются
    { mode: 'scenario', label: 'Сценарии', icon: 'fa-scroll' },
    { mode: 'prompt', label: 'Промпты', icon: 'fa-terminal' },
    { mode: 'preset', label: 'Пресеты', icon: 'fa-layer-group' },
];

// Режимы, у которых своих «абзацев верхнего уровня» нет — вместо draft.sections
// работают draft.entries (именованные записи/блоки, каждая — свой набор абзацев).
const ENTRY_BASED_MODES = new Set(['lorebook', 'preset']);

/** Заметка под именем в списке: своя, а у персоны — ещё и её подпись из списка персон Таверны. */
function draftMemo(draft) {
    return String(draft.memo || '').trim() || (draft.mode === 'persona' ? String(draft.personaTitle || '').trim() : '');
}

function draftIcon(draft) {
    return (DRAFT_GROUPS.find(group => group.mode === draft.mode) || DRAFT_GROUPS[0]).icon;
}

function renderDraftItem(draft, icon) {
    // Сценарий до проработки (нет ни одного пункта) показывает число идей, а не
    // абзацев — иначе черновик с готовыми идеями, но без проработки, выглядел бы
    // как пустой рядом с полноценными карточками.
    const bound = boundDraftId() === draft.id ? currentPlot() : null;
    const boundProgress = bound ? plotProgress(bound.draft, bound.state) : null;
    const blocks = ENTRY_BASED_MODES.has(draft.mode)
        ? `${draft.entries.length} ${draft.mode === 'preset' ? 'блок.' : 'зап.'}`
        : draft.mode === 'plot'
            ? `${(draft.steps || []).length} шаг.`
            : draft.mode === 'scenario' && !draft.sections.length
            ? `${(draft.ideas || []).length} ид.`
            : `${countBlocks(draft.sections)} абз.`;
    const average = ENTRY_BASED_MODES.has(draft.mode) || draft.mode === 'plot' ? null : averageRating(draft.sections);
    return `
        <div class="loom-draft-item ${draft.id === state.draftId ? 'active' : ''} ${bound ? 'loom-draft-bound' : ''}" data-id="${escapeHtml(draft.id)}">
            <i class="fa-solid ${icon}"></i>
            <div class="loom-draft-meta">
                <div class="loom-draft-name">${escapeHtml(draft.name || 'Без имени')}</div>
                <div class="loom-draft-sub">${blocks}${average ? ` · ${average.toFixed(1)}/10` : ''}${boundProgress
                    ? ` <span class="loom-draft-tag loom-draft-tag-live" title="Этот сюжет привязан к текущему чату"><i class="fa-solid fa-link"></i> В чате ${boundProgress.stepsDone}/${boundProgress.stepTotal}</span>`
                    : ''}${draft.importedFromTavern
                    ? ' <span class="loom-draft-tag" title="Импортировано из Таверны"><i class="fa-solid fa-file-import"></i> Таверна</span>'
                    : draft.importedFromFile
                        ? ` <span class="loom-draft-tag" title="Импортировано из файла «${escapeHtml(draft.importedFromFile)}»"><i class="fa-solid fa-file-arrow-up"></i> Файл</span>`
                        : ''}</div>
                ${draftMemo(draft) ? `<div class="loom-draft-memo">${escapeHtml(draftMemo(draft))}</div>` : ''}
            </div>
            <button class="loom-icon-btn loom-draft-copy" title="Дублировать"><i class="fa-solid fa-copy"></i></button>
            <button class="loom-icon-btn loom-draft-delete" title="Удалить"><i class="fa-solid fa-trash"></i></button>
        </div>`;
}

// Какие группы списка свёрнуты — на устройство, а не в настройки Таверны: телефону и ПК нужно
// разное, и общий флаг сворачивал бы на компьютере то, что удобно на телефоне.
const GROUP_STATE_KEY = 'loom_draft_groups';

function readGroupState() {
    try {
        const stored = JSON.parse(localStorage.getItem(GROUP_STATE_KEY) || '{}');
        return stored && typeof stored === 'object' ? stored : {};
    } catch {
        return {};
    }
}

function writeGroupState(mode, open) {
    try {
        localStorage.setItem(GROUP_STATE_KEY, JSON.stringify({ ...readGroupState(), [mode]: open }));
    } catch { /* приватный режим или заблокированное хранилище — группа просто не запомнится */ }
}

/**
 * Развёрнута ли группа. Явный выбор пользователя главнее всего. Иначе: короткая группа и группа
 * с открытым сейчас черновиком — открыты, длинная на телефоне — свёрнута (десяток карточек
 * подряд, через которые надо долистать до нужной, — ровно то, от чего страдал список).
 */
function isGroupOpen(mode, count, holdsActive) {
    const stored = readGroupState()[mode];
    if (typeof stored === 'boolean') return stored;
    if (holdsActive || count <= 3) return true;
    return !window.matchMedia?.('(max-width: 800px)').matches;
}

function renderDraftList() {
    const drafts = listDrafts();
    const $list = $('#loom-draft-list');

    // Поиск нужен, когда есть что искать; на пустом списке он только занимает место
    $('.loom-draft-search-box').prop('hidden', drafts.length < 6);
    const searchText = String($('#loom-draft-search').val() || '').trim();
    const query = drafts.length >= 6 ? searchText.toLowerCase() : '';
    // Крестик виден, только пока есть что стирать — иначе торчит без дела в пустом поле
    $('#loom-draft-search-clear').prop('hidden', !searchText);

    if (!drafts.length) {
        $list.html('<div class="loom-empty-note">Пока пусто. Создайте персонажа или лорбук.</div>');
        return;
    }

    const matches = draft => !query
        || `${draft.name || ''} ${draftMemo(draft)}`.toLowerCase().includes(query);

    const html = DRAFT_GROUPS.map(group => {
        const all = drafts.filter(d => d.mode === group.mode);
        const items = all.filter(matches);
        if (!items.length) return '';
        // При поиске раскрываем всё найденное: свёрнутая группа с совпадением выглядела бы как «ничего нет»
        const open = query ? true : isGroupOpen(group.mode, all.length, all.some(d => d.id === state.draftId || d.id === boundDraftId()));
        return `
            <div class="loom-draft-group ${open ? '' : 'collapsed'}" data-mode="${group.mode}">
                <button class="loom-draft-group-head" aria-expanded="${open}">
                    <i class="fa-solid fa-chevron-down loom-group-chevron"></i>
                    <i class="fa-solid ${group.icon}"></i>
                    <span class="loom-draft-group-title">${group.label}</span>
                    <span class="loom-draft-group-count">${query ? `${items.length} из ${all.length}` : all.length}</span>
                </button>
                <div class="loom-draft-group-items">
                    ${items.map(draft => renderDraftItem(draft, group.icon)).join('')}
                </div>
            </div>`;
    }).join('');

    $list.html(html || '<div class="loom-empty-note">Ничего не найдено.</div>');
}

/** Заметка личная: показывается в списке рядом с именем — обновляем только строку этого черновика. */
function refreshDraftItem(draft) {
    const $item = $(`#loom-draft-list .loom-draft-item[data-id="${draft.id}"]`);
    if ($item.length) $item.replaceWith(renderDraftItem(draft, draftIcon(draft)));
}

/** Личная заметка к черновику: видна в списке, в промпт и в Таверну не уходит. */
function renderMemo(draft) {
    return `
        <label class="loom-memo">
            <i class="fa-solid fa-note-sticky"></i>
            <input type="text" class="loom-memo-input" maxlength="200"
                placeholder="Заметка для себя (видна в списке)"
                title="Только для вас: показывается в списке черновиков, в промпт и в Таверну не уходит"
                value="${escapeHtml(draft.memo || '')}">
        </label>`;
}

// ─── Импорт из Таверны ──────────────────────────────────────────────────────

async function renderImportLists() {
    const chars = listTavernCharacters();
    $('#loom-import-character-list').html(chars.length
        ? chars.map(c => `
            <label class="loom-check loom-import-item">
                <input type="checkbox" class="loom-import-check" value="${escapeHtml(c.avatar)}">
                ${c.thumb
                    ? `<img class="loom-import-thumb" src="${escapeHtml(c.thumb)}" alt="">`
                    : '<span class="loom-import-thumb loom-import-thumb-empty"><i class="fa-solid fa-user"></i></span>'}
                <span>${escapeHtml(c.name)}</span>
            </label>`).join('')
        : '<div class="loom-empty-note">В Таверне нет персонажей.</div>');

    const worlds = await listTavernWorlds();
    $('#loom-import-lorebook-list').html(worlds.length
        ? worlds.map(w => `
            <label class="loom-check loom-import-item">
                <input type="checkbox" class="loom-import-check" value="${escapeHtml(w)}">
                <span>${escapeHtml(w)}</span>
            </label>`).join('')
        : '<div class="loom-empty-note">В Таверне нет лорбуков.</div>');

    const personas = listTavernPersonas();
    $('#loom-import-persona-list').html(personas.length
        ? personas.map(p => `
            <label class="loom-check loom-import-item">
                <input type="checkbox" class="loom-import-check" value="${escapeHtml(p.avatarId)}">
                ${p.thumb
                    ? `<img class="loom-import-thumb" src="${escapeHtml(p.thumb)}" alt="">`
                    : '<span class="loom-import-thumb loom-import-thumb-empty"><i class="fa-solid fa-user-tag"></i></span>'}
                <span>${escapeHtml(p.name)}</span>
            </label>`).join('')
        : '<div class="loom-empty-note">В Таверне нет персон.</div>');

    const presetNames = listTavernPresets();
    $('#loom-import-preset-list').html(presetNames.length
        ? presetNames.map(name => `
            <label class="loom-check loom-import-item">
                <input type="checkbox" class="loom-import-check" value="${escapeHtml(name)}">
                <span>${escapeHtml(name)}</span>
            </label>`).join('')
        : '<div class="loom-empty-note">В Таверне нет пресетов Chat Completion.</div>');
}

/**
 * Импортирует всё отмеченное — персонажей и лорбуки разом, одним проходом.
 * Каждый импорт независим: если один упал (например, лорбук пуст), остальные
 * всё равно доходят до конца, а не обрываются на первой ошибке.
 */
async function runTavernImport() {
    const checkedChars = [...document.querySelectorAll('#loom-import-character-list .loom-import-check:checked')].map(el => el.value);
    const checkedWorlds = [...document.querySelectorAll('#loom-import-lorebook-list .loom-import-check:checked')].map(el => el.value);
    const checkedPersonas = [...document.querySelectorAll('#loom-import-persona-list .loom-import-check:checked')].map(el => el.value);
    const checkedPresets = [...document.querySelectorAll('#loom-import-preset-list .loom-import-check:checked')].map(el => el.value);
    const total = checkedChars.length + checkedWorlds.length + checkedPersonas.length + checkedPresets.length;
    if (!total) return toast('info', 'Отметьте хотя бы один пункт.');

    await withBusy(`Импортирую (0/${total})…`, async () => {
        let done = 0;
        const failed = [];
        const formatById = new Map(getSettings().character_format.map(item => [item.id, item]));

        for (const avatar of checkedChars) {
            setStatus(`Импортирую (${done + 1}/${total})…`);
            try {
                const data = await importCharacterFromTavern(avatar, formatById);
                const draft = createDraft('character');
                Object.assign(draft, data);
                draft.importedFromTavern = true;
                touchDraft(draft);
            } catch (e) {
                console.error(LOG, `Импорт персонажа «${avatar}» не удался`, e);
                failed.push(avatar);
            }
            done++;
        }

        for (const worldName of checkedWorlds) {
            setStatus(`Импортирую (${done + 1}/${total})…`);
            try {
                const data = await importWorldFromTavern(worldName);
                const draft = createDraft('lorebook');
                Object.assign(draft, data);
                draft.importedFromTavern = true;
                touchDraft(draft);
            } catch (e) {
                console.error(LOG, `Импорт лорбука «${worldName}» не удался`, e);
                failed.push(worldName);
            }
            done++;
        }

        for (const avatarId of checkedPersonas) {
            setStatus(`Импортирую (${done + 1}/${total})…`);
            try {
                const data = await importPersonaFromTavern(avatarId);
                const draft = createDraft('persona');
                Object.assign(draft, data);
                draft.importedFromTavern = true;
                touchDraft(draft);
            } catch (e) {
                console.error(LOG, `Импорт персоны «${avatarId}» не удался`, e);
                failed.push(avatarId);
            }
            done++;
        }

        for (const presetName of checkedPresets) {
            setStatus(`Импортирую (${done + 1}/${total})…`);
            try {
                const data = importPresetFromTavern(presetName);
                const draft = createDraft('preset');
                Object.assign(draft, data);
                draft.importedFromTavern = true;
                touchDraft(draft);
            } catch (e) {
                console.error(LOG, `Импорт пресета «${presetName}» не удался`, e);
                failed.push(presetName);
            }
            done++;
        }

        renderDraftList();
        // Открытый редактор (лорбук, сценарий) мог остаться со старым списком персонажей
        // для привязки — без перерисовки новые импортированные там не появлялись до перезахода
        renderMain();
        $('#loom-import').removeClass('open');
        toast(failed.length ? 'warning' : 'success', failed.length
            ? `Импортировано ${total - failed.length} из ${total}. Не удалось: ${failed.join(', ')}.`
            : `Импортировано: ${total}.`);
    });
}

/**
 * Общий хвост импорта из файла (для всех трёх типов ниже): закрыть окно импорта,
 * перерисовать список, открыть результат, если он ровно один, и отчитаться тостом.
 * @param {string[]} sourceNames имена файлов, которые обрабатывали (для счёта «X из Y»)
 * @param {string[]} createdIds id заведённых черновиков — их может быть БОЛЬШЕ, чем
 *   файлов (бэкап персон Таверны разбирается на несколько черновиков из одного файла)
 * @param {string[]} failed уже готовые строки «имя (причина)» для неудавшихся файлов
 */
function finishFileImport(sourceNames, createdIds, failed) {
    renderDraftList();
    $('#loom-import').removeClass('open');
    // Один файл — сразу открыть результат, а не заставлять искать его в списке.
    // Несколько (или файл персон Таверны с несколькими персонами внутри) — просто
    // список: открывать всё подряд смысла нет.
    if (createdIds.length === 1 && sourceNames.length === 1) {
        dropIfEmpty(state.draftId);
        state.draftId = createdIds[0];
    }
    renderMain();
    toast(failed.length ? 'warning' : 'success', failed.length
        ? `Импортировано ${createdIds.length}. Не удалось: ${failed.join('; ')}.`
        : `Импортировано: ${createdIds.length}.`);
}

/**
 * Импорт карточки персонажа прямо из файла — PNG или .json, в обход Таверны совсем
 * (см. src/file-import.js). Каждый файл — свой черновик; один упавший не останавливает
 * остальные, как и в runTavernImport выше.
 * @param {File[]} files
 */
async function runCharacterFileImport(files) {
    if (!files.length) return;

    await withBusy(`Читаю (0/${files.length})…`, async () => {
        let done = 0;
        const failed = [];
        const created = [];
        const formatById = new Map(getSettings().character_format.map(item => [item.id, item]));

        for (const file of files) {
            setStatus(`Читаю (${done + 1}/${files.length})…`);
            try {
                const data = await parseCharacterFile(file, formatById);
                const draft = createDraft('character');
                draft.name = data.name;
                draft.sections = data.sections;
                draft.altGreetings = data.altGreetings;
                if (data.avatarFile) draft.avatar = await storeImage(data.avatarFile);
                draft.importedFromFile = data.sourceFileName;
                touchDraft(draft);
                created.push(draft.id);
            } catch (e) {
                console.error(LOG, `Импорт файла «${file.name}» не удался`, e);
                failed.push(`${file.name} (${e.message || e})`);
            }
            done++;
        }

        finishFileImport(files.map(f => f.name), created, failed);
    });
}

/**
 * Импорт лорбука прямо из файла .json — в обход Таверны совсем (см. src/file-import.js).
 * @param {File[]} files
 */
async function runLorebookFileImport(files) {
    if (!files.length) return;

    await withBusy(`Читаю (0/${files.length})…`, async () => {
        let done = 0;
        const failed = [];
        const created = [];

        for (const file of files) {
            setStatus(`Читаю (${done + 1}/${files.length})…`);
            try {
                const data = await parseLorebookFile(file);
                const draft = createDraft('lorebook');
                draft.name = data.name;
                draft.entries = data.entries;
                draft.importedFromFile = data.sourceFileName;
                touchDraft(draft);
                created.push(draft.id);
            } catch (e) {
                console.error(LOG, `Импорт файла «${file.name}» не удался`, e);
                failed.push(`${file.name} (${e.message || e})`);
            }
            done++;
        }

        finishFileImport(files.map(f => f.name), created, failed);
    });
}

/**
 * Импорт персоны(-он) прямо из файла .json — в обход Таверны совсем (см. src/file-import.js).
 * Один файл может развернуться в НЕСКОЛЬКО черновиков — бэкап персон Таверны хранит их
 * все разом, своего экспорта одной персоны у неё нет.
 * @param {File[]} files
 */
async function runPersonaFileImport(files) {
    if (!files.length) return;

    await withBusy(`Читаю (0/${files.length})…`, async () => {
        let done = 0;
        const failed = [];
        const created = [];

        for (const file of files) {
            setStatus(`Читаю (${done + 1}/${files.length})…`);
            try {
                const personas = await parsePersonaFile(file);
                for (const data of personas) {
                    const draft = createDraft('persona');
                    draft.name = data.name;
                    draft.sections = data.sections;
                    draft.importedFromFile = file.name;
                    touchDraft(draft);
                    created.push(draft.id);
                }
            } catch (e) {
                console.error(LOG, `Импорт файла «${file.name}» не удался`, e);
                failed.push(`${file.name} (${e.message || e})`);
            }
            done++;
        }

        finishFileImport(files.map(f => f.name), created, failed);
    });
}

/**
 * Импорт пресета прямо из файла .json — в обход Таверны совсем (см. src/file-import.js).
 * @param {File[]} files
 */
async function runPresetFileImport(files) {
    if (!files.length) return;

    await withBusy(`Читаю (0/${files.length})…`, async () => {
        let done = 0;
        const failed = [];
        const created = [];

        for (const file of files) {
            setStatus(`Читаю (${done + 1}/${files.length})…`);
            try {
                const data = await parsePresetFile(file);
                const draft = createDraft('preset');
                draft.name = data.name;
                draft.entries = data.entries;
                draft.importedFromFile = data.sourceFileName;
                touchDraft(draft);
                created.push(draft.id);
            } catch (e) {
                console.error(LOG, `Импорт файла «${file.name}» не удался`, e);
                failed.push(`${file.name} (${e.message || e})`);
            }
            done++;
        }

        finishFileImport(files.map(f => f.name), created, failed);
    });
}

/** Кнопка «Импорт» в окне импорта: что за тип файла ждать и куда передать выбранное. */
const FILE_IMPORT_KINDS = {
    character: { accept: '.png,.json,image/png,application/json', run: files => runCharacterFileImport(files) },
    lorebook: { accept: '.json,application/json', run: files => runLorebookFileImport(files) },
    persona: { accept: '.json,application/json', run: files => runPersonaFileImport(files) },
    preset: { accept: '.json,application/json', run: files => runPresetFileImport(files) },
};

// ─── Главная область ────────────────────────────────────────────────────────

/**
 * Какой черновик показан прямо сейчас — чтобы отличить «открыли другой черновик»
 * от «перерисовали тот же». В первом случае прокрутку сбрасываем, во втором
 * возвращаем: renderMain() зовут из четырёх десятков мест, и почти все они —
 * мелкая правка внутри уже открытого черновика (удалили абзац, сменили позицию
 * записи). Сбрасывать там прокрутку значит отбрасывать к началу с сорокового абзаца.
 */
let renderedDraftId = null;

/**
 * Состояние всех сворачиваемых <details> внутри $scope, по атрибуту data-details-key.
 * Ключ должен быть стабильным между перерисовками — у записей лорбука это id записи,
 * а не индекс в массиве (индекс съезжает при удалении записи из середины списка).
 */
function captureDetailsState($scope) {
    const state = new Map();
    $scope.find('details[data-details-key]').each(function () {
        state.set(this.getAttribute('data-details-key'), this.open);
    });
    return state;
}

/** Безусловно проставляет open туда, где для ключа есть сохранённое значение (true И false). */
function restoreDetailsState($scope, state) {
    $scope.find('details[data-details-key]').each(function () {
        const key = this.getAttribute('data-details-key');
        if (state.has(key)) this.open = state.get(key);
    });
}

function renderMain() {
    const draft = currentDraft();
    const $main = $('#loom-main');

    // На мобильной раскладке список черновиков и редактор — разные «экраны»
    // (см. CSS), а не колонки рядом: класс решает, какой из них сейчас показан.
    $('#loom-panel').toggleClass('loom-has-draft', !!draft);

    if (!draft) {
        renderedDraftId = null;
        $main.html(renderHome());
        return;
    }

    const sameDraft = renderedDraftId === draft.id;
    const scroll = sameDraft ? $main.scrollTop() : 0;
    // Сворачиваемые блоки (задумка, референсы черновика и КАЖДОЙ записи лорбука) —
    // этот HTML-атрибут перерисовка не помнит сама. Добавили референс, поправили
    // задумку — и панель, которую пользователь только что открыл руками, схлопывается
    // обратно к дефолту разметки. Запоминаем фактическое состояние DOM и возвращаем его.
    const detailsState = sameDraft ? captureDetailsState($main) : null;
    renderedDraftId = draft.id;

    const renderers = {
        lorebook: renderLorebook, persona: renderPersona, prompt: renderPrompt, scenario: renderScenario, plot: renderPlot,
        preset: renderPreset,
    };
    $main.html((renderers[draft.mode] || renderCharacter)(draft));
    if (detailsState) restoreDetailsState($main, detailsState);
    // Абзац виден целиком, а не двумя строками: textarea не тянется сама, а читать
    // и оценивать обрезанный текст невозможно — ради этого весь экран и существует.
    // Высоты нужно проставить ДО возврата прокрутки: пока поля схлопнуты, вся страница
    // короче, и scrollTop молча обрежется до её текущей высоты.
    growAll($main);
    $main.scrollTop(scroll);
    hydrateThumbs($main);
}

/**
 * Дозаполняет превью референсов и аватарки картинкой из IndexedDB — сам шаблон
 * (renderRefs/renderAvatar) синхронный и оставляет <img> без src, только с
 * data-thumb-id, потому что чтение IndexedDB асинхронное, а перестраивать
 * весь renderMain под async ради этого не стоит: он вызывается на каждый чих
 * (ввод текста, оценка абзаца), и картинки — редкое исключение, а не общий случай.
 * Запускается и забывается — картинка появится на кадр-другой позже разметки,
 * это не заметнее обычной загрузки <img> с сервера.
 */
function hydrateThumbs($scope) {
    $scope.find('img[data-thumb-id]').each(function () {
        const id = this.getAttribute('data-thumb-id');
        if (!id) return;
        loadThumb(id).then(thumb => { if (thumb) this.src = thumb; });
    });
}

/**
 * Подгоняет высоту всех текстовых полей под содержимое.
 *
 * Три прохода вместо одного цикла с autoGrow — намеренно. Чтение scrollHeight сразу
 * после записи style.height заставляет браузер пересчитать раскладку СИНХРОННО, и так
 * на каждом поле: у карточки на полсотни абзацев это полсотни пересчётов вместо двух.
 * Здесь сначала все записи, потом все чтения, потом снова все записи.
 */
const NATIVE_GROW = typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content');

function growAll($scope) {
    if (NATIVE_GROW) return; // высоту держит CSS (field-sizing), без принудительной раскладки
    const elements = $scope.find('.loom-block-text, .loom-block-prompt-text, .loom-block-comment.open, .loom-altgreet-text, .loom-plot-textarea').get();
    if (!elements.length) return;
    for (const element of elements) element.style.height = 'auto';
    const heights = elements.map(element => element.scrollHeight);
    elements.forEach((element, i) => { element.style.height = `${heights[i]}px`; });
}

function renderHome() {
    return `
        <div class="loom-home">
            <h1>С чего начнём?</h1>
            <p class="loom-home-sub">Модель пишет черновик абзацами. Оцените их от 1 до 10, оставьте комментарии —
                и она перепишет текст по вашим оценкам.</p>
            <div class="loom-mode-cards">
                <button class="loom-mode-card loom-new" data-mode="character">
                    <i class="fa-solid fa-user-pen"></i>
                    <b>Персонаж</b>
                    <span>Карточка персонажа: внешность, характер, сценарий и первое сообщение.</span>
                </button>
                <button class="loom-mode-card loom-new" data-mode="persona">
                    <i class="fa-solid fa-user-tag"></i>
                    <b>Персона</b>
                    <span>Ваш {{user}}: внешность, характер и чем живёт.</span>
                </button>
                <button class="loom-mode-card loom-new" data-mode="lorebook">
                    <i class="fa-solid fa-book-open"></i>
                    <b>Лорбук</b>
                    <span>Записи о мире с ключами, которые ловят любые падежи.</span>
                </button>
                <button class="loom-mode-card loom-new" data-mode="plot">
                    <i class="fa-solid fa-route"></i>
                    <b>Сюжет</b>
                    <span>Арка из шагов, которую LOOM отслеживает в самой ролевой.</span>
                </button>
                <button class="loom-mode-card loom-new" data-mode="prompt">
                    <i class="fa-solid fa-terminal"></i>
                    <b>Промпт</b>
                    <span>Отдельная инструкция под конкретную ситуацию в ролевой.</span>
                </button>
                <button class="loom-mode-card loom-new" data-mode="preset">
                    <i class="fa-solid fa-layer-group"></i>
                    <b>Пресет</b>
                    <span>Блоки для пресета Chat Completion и разбор готового пресета.</span>
                </button>
            </div>
        </div>`;
}

// ─── Абзацы и оценки ────────────────────────────────────────────────────────

/**
 * Один абзац: текст, десять сердечек и комментарий.
 *
 * data-путь до абзаца (draft / entry / section / block) кладём прямо в разметку —
 * так все обработчики делегированные и переживают перерисовку любой части панели.
 */
function renderBlock(block, path, index) {
    const rating = Number(block.rating) || 0;
    // Иконки только из fa-solid: в Таверне подключены solid и brands, регулярное
    // начертание (fa-regular) не загружено, и такие иконки просто не отрисуются.
    // «Пустое» сердечко делаем цветом, а не другим начертанием.
    const hearts = Array.from({ length: 10 }, (_, i) => {
        const value = i + 1;
        return `<button class="loom-heart ${value <= rating ? 'on' : ''}" data-value="${value}" title="${value} из 10">
                    <i class="fa-solid fa-heart"></i>
                </button>`;
    }).join('');

    const hasComment = !!String(block.comment || '').trim();

    return `
        <div class="loom-block" data-block="${index}" ${path}>
            <textarea class="loom-block-text" rows="1">${escapeHtml(block.text)}</textarea>
            ${block.prompt ? `
            <div class="loom-block-prompt">
                <div class="loom-block-prompt-head">
                    <span><i class="fa-solid fa-terminal"></i> Готовый текст для пресета</span>
                    <span class="loom-block-prompt-tools">
                        ${path.includes('data-scope="review"') ? `
                        <button class="loom-btn loom-btn-small loom-btn-accent loom-block-prompt-apply" title="Вставить в блок пресета Таверны, старый текст сохранится">
                            <i class="fa-solid fa-file-arrow-up"></i> В пресет
                        </button>` : ''}
                        <button class="loom-btn loom-btn-small loom-btn-ghost loom-block-prompt-copy">
                            <i class="fa-solid fa-copy"></i> Копировать
                        </button>
                    </span>
                </div>
                <textarea class="loom-block-prompt-text" rows="1">${escapeHtml(block.prompt)}</textarea>
            </div>` : ''}
            <div class="loom-block-bar">
                <div class="loom-hearts">${hearts}</div>
                <div class="loom-block-rating ${rating ? '' : 'empty'}">${rating ? `${rating}/10` : 'без оценки'}</div>
                <button class="loom-icon-btn loom-block-comment-toggle ${hasComment ? 'has' : ''}" title="Комментарий к абзацу">
                    <i class="fa-solid fa-comment-dots"></i>
                </button>
                <button class="loom-icon-btn loom-danger loom-block-delete" title="Удалить абзац">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
            <textarea class="loom-block-comment ${hasComment ? 'open' : ''}" rows="2"
                placeholder="Что не так с этим абзацем? Модель прочитает это при переписывании.">${escapeHtml(block.comment)}</textarea>
        </div>`;
}

// По id пункта, не по позиции в массиве: карточка теперь рендерится двумя отдельными
// списками (сама карточка и сценарий), и позиция внутри КАЖДОГО из них — не то же самое,
// что позиция в draft.sections целиком, откуда resolveBlock достаёт секцию.
//
// Каждый пункт — сворачиваемый <details>: у карточки на дюжину пунктов по 3-5 абзацев
// в каждом список на экране растягивается на пару тысяч пикселей, и одобренный пункт
// занимает столько же места, сколько тот, который ещё не тронут. Открыт по умолчанию —
// то, что пользователь свернул вручную, помнит data-details-key (restoreDetailsState
// в renderMain), а не эта функция.
//
// keyPrefix различает секции с ОДНИМ И ТЕМ ЖЕ id, когда их на экране несколько разом —
// у каждой записи лорбука/пресета есть свой пункт «summary»/«details», и без разбивки
// по записям они все сворачивались бы синхронно, одной кнопкой на все сразу.
function renderSections(sections, pathPrefix, keyPrefix = '') {
    if (!sections?.length) return '';
    return sections.map(section => `
        <details class="loom-section" data-section-id="${escapeHtml(section.id)}"
            data-details-key="${escapeHtml(keyPrefix)}sec-${escapeHtml(section.id)}" open>
            <summary class="loom-section-title">
                <span><i class="fa-solid fa-chevron-right loom-section-chevron"></i> ${escapeHtml(section.label)}</span>
                <button class="loom-icon-btn loom-section-regen" title="Переписать только этот пункт"
                    ${pathPrefix} data-section-id="${escapeHtml(section.id)}">
                    <i class="fa-solid fa-arrows-rotate"></i>
                </button>
            </summary>
            ${section.blocks.map((block, blockIndex) =>
                renderBlock(block, `${pathPrefix} data-section-id="${escapeHtml(section.id)}"`, blockIndex)).join('')}
        </details>`).join('');
}

/** Сколько абзацев оценено — чтобы было видно, готов ли черновик к переписыванию. */
function ratingSummary(sections) {
    const total = countBlocks(sections);
    let rated = 0;
    let commented = 0;
    for (const section of sections || []) {
        for (const block of section.blocks) {
            if (block.rating) rated++;
            if (String(block.comment || '').trim()) commented++;
        }
    }
    const average = averageRating(sections);
    if (!total) return '';
    return `Оценено ${rated} из ${total}${commented ? `, комментариев: ${commented}` : ''}`
        + `${average ? ` · средняя ${average.toFixed(1)}/10` : ''}`;
}

// ─── Картинки ─────────────────────────────────────────────────────

/**
 * Полоса референсов. Владелец — черновик или запись лорбука; кто именно, определяется
 * по месту в разметке (см. resolveImageOwner), поэтому разметка у обоих одинаковая.
 *
 * Всегда компактная плашка — сворачивается независимо от того, есть картинки или нет
 * (иначе лорбук на десяток записей превращается в стену пустых блоков с подсказкой,
 * которую и так все уже прочитали один раз). detailsKey — стабильный на перерисовках
 * идентификатор для сохранения открыт/закрыт (см. captureDetailsState в renderMain).
 *
 * @param {object} owner черновик или запись лорбука
 * @param {string} label подпись плашки
 * @param {string} detailsKey уникальный ключ (`refs-draft`, `refs-entry-<id>`)
 */
function renderRefs(owner, label, detailsKey) {
    const refs = owner.images || [];
    // src не заполняем сразу — картинки лежат в IndexedDB (см. src/images.js),
    // а этот шаблон собирается синхронно. data-thumb-id забирает hydrateThumbs()
    // отдельным проходом сразу после того, как разметка окажется в DOM.
    const items = refs.map((ref, index) => `
        <div class="loom-ref" data-ref="${index}">
            <img class="loom-ref-thumb" data-thumb-id="${escapeHtml(ref.id)}" title="${escapeHtml(ref.name)}" alt="">
            <input type="text" class="loom-ref-note" placeholder="что здесь важно"
                value="${escapeHtml(ref.note || '')}">
            <button class="loom-icon-btn loom-ref-remove" title="Убрать"><i class="fa-solid fa-xmark"></i></button>
        </div>`).join('');

    return `
        <details class="loom-refs" data-details-key="${escapeHtml(detailsKey)}">
            <summary><i class="fa-solid fa-image"></i> ${escapeHtml(label)}${refs.length ? ` · ${refs.length}` : ''}</summary>
            <div class="loom-refs-body">
                <div class="loom-refs-head">
                    <label class="loom-btn loom-btn-ghost loom-btn-small loom-file-btn">
                        <i class="fa-solid fa-image"></i> Добавить
                        <input type="file" class="loom-ref-input" accept="image/*" multiple>
                    </label>
                </div>
                ${items
                    ? `<div class="loom-ref-list">${items}</div>`
                    : '<span class="loom-hint">Нужен профиль с поддержкой картинок.</span>'}
            </div>
        </details>`;
}

/** Картинка будущей карточки: в PNG-карту уходит именно она. */
function renderAvatar(draft, label = 'Картинка карточки', hint = 'Уйдёт в карту и в Таверну.') {
    const avatar = draft.avatar;
    return `
        <div class="loom-avatar-box">
            ${avatar
                ? `<img class="loom-avatar-thumb" data-thumb-id="${escapeHtml(avatar.id)}" alt="">`
                : '<div class="loom-avatar-empty"><i class="fa-solid fa-user-large"></i></div>'}
            <div class="loom-avatar-side">
                <span class="loom-label">${escapeHtml(label)}</span>
                <span class="loom-hint">${escapeHtml(hint)}</span>
                <div class="loom-avatar-actions">
                    <label class="loom-btn loom-btn-ghost loom-btn-small loom-file-btn">
                        <i class="fa-solid fa-portrait"></i> ${avatar ? 'Заменить' : 'Выбрать'}
                        <input type="file" class="loom-avatar-input" accept="image/*">
                    </label>
                    ${avatar ? `<button class="loom-btn loom-btn-ghost loom-btn-small" data-action="avatar-remove">
                        <i class="fa-solid fa-xmark"></i> Убрать</button>` : ''}
                </div>
            </div>
        </div>`;
}

// ─── Режим: персонаж ────────────────────────────────────────────────────────

/**
 * Подпись кнопки с короткой заменой для телефона (переключает CSS, см. .loom-label-short).
 *
 * «Сгенерировать заново» и «Переписать с оценками» занимают по 190 пикселей — вдвоём
 * не влезают в 362 доступных, и каждая забирает целую строку. Короткие подписи в той
 * же строке ужимают их до пары, не трогая десктоп, где места хватает на полные.
 */
function btnLabel(long, short) {
    return `<span class="loom-label-long">${escapeHtml(long)}</span>`
        + `<span class="loom-label-short">${escapeHtml(short)}</span>`;
}

/**
 * «Откатить» и «Вперёд» одной слитной парой.
 *
 * Это одно действие в двух направлениях, и разрывать их переносом строки нельзя:
 * на узком экране они разъезжались по разным строкам и читались как две несвязанные
 * кнопки. Группа не переносится внутри себя (см. .loom-btn-group в CSS).
 */
function renderHistoryPair(draft) {
    return `
        <div class="loom-btn-group">
            <button class="loom-btn loom-btn-ghost" data-action="undo" ${draft.history.length ? '' : 'disabled'}
                title="Вернуться к предыдущей версии">
                <i class="fa-solid fa-clock-rotate-left"></i> Откатить
            </button>
            <button class="loom-btn loom-btn-ghost" data-action="redo" ${draft.future?.length ? '' : 'disabled'}
                title="Вернуться вперёд к версии, от которой откатились">
                <i class="fa-solid fa-clock-rotate-left fa-flip-horizontal"></i> Вперёд
            </button>
        </div>`;
}

/**
 * «Откатить»/«Вперёд» для ПЛАНА лорбука/пресета — возвращает список записей, который
 * стёрла «Пересобрать план» (вместе со всем уже написанным в них). Пока снимков нет —
 * не показывается вовсе: пара нужна только тому, кто пересобирал план.
 */
function renderPlanHistoryPair(draft) {
    if (!draft.entriesHistory?.length && !draft.entriesFuture?.length) return '';
    return `
        <div class="loom-btn-group">
            <button class="loom-btn loom-btn-ghost" data-action="plan-undo" ${draft.entriesHistory?.length ? '' : 'disabled'}
                title="Вернуть прежний план вместе со всеми записями, которые стёрла пересборка">
                <i class="fa-solid fa-clock-rotate-left"></i> План
            </button>
            <button class="loom-btn loom-btn-ghost" data-action="plan-redo" ${draft.entriesFuture?.length ? '' : 'disabled'}
                title="Вернуться вперёд к пересобранному плану">
                <i class="fa-solid fa-clock-rotate-left fa-flip-horizontal"></i> План
            </button>
        </div>`;
}

/**
 * «Откатить»/«Вперёд» для одной записи лорбука или блока пресета — у каждой своя
 * история версий (entry.history/future, её пишет pushHistory при каждой перезаписи),
 * в отличие от черновиков-карточек, где история одна на весь черновик. Значки без
 * подписи: в шапке записи и так тесно, а смысл стрелок часов очевиден по подсказке.
 */
function renderEntryHistoryPair(entry) {
    return `
        <div class="loom-btn-group">
            <button class="loom-btn loom-btn-small loom-btn-ghost" data-action="entry-undo" ${entry.history?.length ? '' : 'disabled'}
                title="Вернуться к предыдущей версии этой записи">
                <i class="fa-solid fa-clock-rotate-left"></i>
            </button>
            <button class="loom-btn loom-btn-small loom-btn-ghost" data-action="entry-redo" ${entry.future?.length ? '' : 'disabled'}
                title="Вернуться вперёд к версии, от которой откатились">
                <i class="fa-solid fa-clock-rotate-left fa-flip-horizontal"></i>
            </button>
        </div>`;
}

/**
 * Кнопка с выпадающим списком — для экспорта, где вариантов несколько, но нужны
 * они редко и по одному за раз. Раньше «В Таверну», «JSON» и «PNG» лежали в панели
 * тремя отдельными кнопками и занимали целую строку на телефоне.
 *
 * @param {{icon: string, label: string, items: Array<{action: string, icon: string,
 *   label: string, title?: string}>}} config
 */
function renderMenu({ icon, label, items }) {
    const list = items.map(item => `
        <button type="button" class="loom-menu-item" data-action="${escapeHtml(item.action)}"
            ${item.title ? `title="${escapeHtml(item.title)}"` : ''}>
            <i class="fa-solid ${escapeHtml(item.icon)}"></i> ${escapeHtml(item.label)}
        </button>`).join('');

    return `
        <div class="loom-menu">
            <button type="button" class="loom-btn loom-btn-ghost loom-menu-toggle">
                <i class="fa-solid ${escapeHtml(icon)}"></i> ${escapeHtml(label)}
                <i class="fa-solid fa-caret-down loom-menu-caret"></i>
            </button>
            <div class="loom-menu-list">${list}</div>
        </div>`;
}

/**
 * Кнопка возврата к списку черновиков. Видна только на мобильной раскладке (CSS):
 * там список и редактор — это два разных «экрана», а не колонки рядом.
 */
function renderBackButton() {
    return `
        <button class="loom-icon-btn loom-back-btn" data-action="close-draft" title="К списку черновиков">
            <i class="fa-solid fa-arrow-left"></i>
        </button>`;
}

/** Заметка «импортировано из Таверны» с ссылкой на резервную копию, если она есть. */
function renderImportBadge(draft) {
    // Из файла — в обход Таверны совсем, бэкапа и привязки к её файлу нет и не будет
    if (draft.importedFromFile) {
        return `
            <div class="loom-import-badge">
                <i class="fa-solid fa-file-arrow-up"></i>
                Импортировано из файла «${escapeHtml(draft.importedFromFile)}» — в Таверне этого черновика нет,
                появится только после экспорта отсюда
            </div>`;
    }
    // По флагу, а не по importedAvatar: тот выставляет и экспорт, и созданный в LOOM
    // персонаж после первой выгрузки ошибочно подписывался «импортированным»
    // Созданный в LOOM и уже выгруженный: показываем, КАКОЙ файл обновится — у одноимённых
    // карточек («Ло.png», «Ло1.png»…) по имени персонажа их не различить
    if (!draft.importedFromTavern) {
        return draft.importedAvatar
            ? `<div class="loom-import-badge"><i class="fa-solid fa-link"></i> В Таверне: ${escapeHtml(draft.importedAvatar)}</div>`
            : '';
    }
    const source = draft.importedAvatar || draft.importedWorld;
    if (!source) return '';
    const backup = draft.importBackupAvatar || draft.importBackupWorld;
    return `
        <div class="loom-import-badge">
            <i class="fa-solid fa-file-import"></i>
            Импортировано из Таверны (${escapeHtml(source)})
            ${backup ? ` · резервная копия: <code>${escapeHtml(backup)}</code>` : ''}
        </div>`;
}

/** Карточка и сценарий — отдельные шаги, отдельные блоки на экране. */
function splitSceneSections(draft) {
    const sceneIds = sceneItemIds();
    return {
        cardSections: draft.sections.filter(s => !sceneIds.includes(s.id)),
        sceneSections: draft.sections.filter(s => sceneIds.includes(s.id)),
    };
}

/**
 * Другие варианты первого сообщения (alternate_greetings V2) — их может быть сколько
 * угодно, автор карточки обычно пишет несколько на выбор игроку при новом чате.
 * Каждый вариант — {text, idea}: idea необязательная и своя для ЭТОГО варианта (время,
 * место, другая завязка), кнопка рядом с ней шлёт отдельный запрос именно на него —
 * так же, как «Написать»/«Заново» у самого пункта сцены (см. renderSceneItemBlock),
 * только per-вариант, а не per-пункт. Текст можно и просто вписать руками, ИИ не
 * обязателен: он нужен, только когда своих идей на все варианты сразу не хватает.
 */
function renderAltGreetings(draft) {
    const list = draft.altGreetings || [];
    // Порог 2, не 1: для одного пустого варианта «Написать всё разом» дублирует его же
    // собственную кнопку «Написать» — смысл есть только когда впиши идеи сразу в несколько
    // полей и не хочешь жать «Написать» под каждым по отдельности.
    const emptyCount = list.filter(g => !String(g.text || '').trim()).length;
    return `
        <div class="loom-altgreet-wrap">
            <div class="loom-hint">Игрок выберет вариант при новом чате.</div>
            ${emptyCount >= 2 ? `
            <button class="loom-btn loom-btn-accent loom-btn-small" data-action="generate-all-altgreets">
                <i class="fa-solid fa-wand-magic-sparkles"></i> Написать все пустые (${emptyCount})
            </button>` : ''}
            ${list.map((g, i) => `
                <div class="loom-altgreet" data-altgreet="${i}">
                    <div class="loom-altgreet-idea-row">
                        <input type="text" class="loom-altgreet-idea" placeholder="Идея для этого варианта (необязательно)" value="${escapeHtml(g.idea || '')}">
                        <button class="loom-btn loom-btn-primary loom-btn-small" data-action="generate-altgreet" data-altgreet="${i}">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> ${g.text ? 'Заново' : 'Написать'}
                        </button>
                        <div class="loom-btn-group">
                            <button class="loom-btn loom-btn-small loom-btn-ghost" data-action="altgreet-undo" data-altgreet="${i}"
                                ${g.history?.length ? '' : 'disabled'} title="Вернуться к предыдущему тексту этого варианта">
                                <i class="fa-solid fa-clock-rotate-left"></i>
                            </button>
                            <button class="loom-btn loom-btn-small loom-btn-ghost" data-action="altgreet-redo" data-altgreet="${i}"
                                ${g.future?.length ? '' : 'disabled'} title="Вернуться вперёд к тексту, от которого откатились">
                                <i class="fa-solid fa-clock-rotate-left fa-flip-horizontal"></i>
                            </button>
                        </div>
                    </div>
                    <div class="loom-altgreet-text-row">
                        <textarea class="loom-altgreet-text" rows="1"
                            placeholder="Текст варианта — впишите руками или нажмите «Написать» выше">${escapeHtml(g.text || '')}</textarea>
                        <button class="loom-icon-btn loom-danger loom-altgreet-delete" title="Удалить вариант">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>`).join('')}
            <button class="loom-btn loom-btn-ghost loom-btn-small" data-action="add-altgreet">
                <i class="fa-solid fa-plus"></i> Добавить вариант
            </button>
        </div>`;
}

/** Пункты формата, помеченные как «сцена» (обычно сценарий и первое сообщение), с их пунктами формата. */
function sceneItems() {
    return activeFormat('character').filter(item => item.scene);
}

/**
 * Один пункт сцены — своя карточка со своей кнопкой «Написать»/«Заново», отдельно от
 * остальных пунктов сцены (раньше сценарий и первое сообщение писались и рисовались
 * одним общим блоком с одной кнопкой на двоих — неудобно, если нужно поправить
 * только один из них, и визуально сваливало в кучу два разных по природе текста).
 * Первое сообщение вдобавок получает список других вариантов (см. renderAltGreetings) —
 * у него, в отличие от сценария, есть смысл держать несколько готовых версий сразу.
 */
function renderSceneItemBlock(draft, item) {
    const section = draft.sections.find(s => s.id === item.id);
    const hasContent = !!section?.blocks?.length;
    const idea = draft.sceneBriefs?.[item.id] || '';
    return `
        <div class="loom-scene-block">
            <div class="loom-section-divider">
                <span>${escapeHtml(item.label)}</span>
                <div class="loom-editor-actions">
                    <button class="loom-btn loom-btn-primary loom-btn-small" data-action="generate-scene" data-scene-item="${escapeHtml(item.id)}">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> ${hasContent ? 'Заново' : 'Написать'}
                    </button>
                    ${hasContent ? `
                    <button class="loom-btn loom-btn-accent loom-btn-small" data-action="rewrite-scene" data-scene-item="${escapeHtml(item.id)}">
                        <i class="fa-solid fa-arrows-rotate"></i> ${btnLabel('Переписать с оценками', 'С оценками')}
                    </button>` : ''}
                </div>
            </div>
            <textarea class="loom-scene-idea" rows="2" data-scene-item="${escapeHtml(item.id)}" placeholder="Идея для пункта (необязательно): время, место, завязка">${escapeHtml(idea)}</textarea>
            ${hasContent
                ? `<div class="loom-rating-summary"><span class="loom-rating-text" data-summary="scene-${escapeHtml(item.id)}">${escapeHtml(ratingSummary([section]))}</span></div>
                   ${renderSections([section], `data-scope="character"`)}`
                : `<div class="loom-empty-note">Впишите идею и нажмите «Написать».</div>`}
            ${item.target === 'first_mes' ? renderAltGreetings(draft) : ''}
        </div>`;
}

function renderCharacter(draft) {
    const { cardSections } = splitSceneSections(draft);
    const hasCard = !!cardSections.length;
    return `
        <div class="loom-editor" data-draft="${escapeHtml(draft.id)}">
            <div class="loom-editor-head">
                ${renderBackButton()}
                <input type="text" class="loom-title-input loom-draft-name-input"
                    placeholder="Имя персонажа" value="${escapeHtml(draft.name)}">
                <button class="loom-icon-btn loom-head-copy" data-action="duplicate-draft" title="Дублировать черновик">
                    <i class="fa-solid fa-copy"></i>
                </button>
                <button class="loom-icon-btn loom-danger loom-head-delete" data-action="delete-draft" title="Удалить черновик">
                    <i class="fa-solid fa-trash"></i>
                </button>
                <div class="loom-editor-actions">
                    <button class="loom-btn loom-btn-primary" data-action="generate">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> ${hasCard ? btnLabel('Сгенерировать заново', 'Заново') : 'Сгенерировать'}
                    </button>
                    ${hasCard ? `
                    <button class="loom-btn loom-btn-accent" data-action="rewrite">
                        <i class="fa-solid fa-arrows-rotate"></i> ${btnLabel('Переписать с оценками', 'С оценками')}
                    </button>
                    ${renderHistoryPair(draft)}
                    ${renderMenu({
                        icon: draft.importedAvatar ? 'fa-rotate' : 'fa-file-export',
                        label: 'Экспорт',
                        items: [
                            { action: 'export-character',
                                icon: draft.importedAvatar ? 'fa-rotate' : 'fa-file-import',
                                label: draft.importedAvatar ? 'Обновить в Таверне' : 'В Таверну',
                                title: draft.importedAvatar
                                    ? 'Обновит существующего персонажа в Таверне на месте'
                                    : 'Создаст нового персонажа в Таверне' },
                            { action: 'download-png', icon: 'fa-file-image', label: 'Скачать PNG',
                                title: 'Карточка картинкой, как в Таверне' },
                            { action: 'download-character', icon: 'fa-download', label: 'Скачать JSON' },
                        ],
                    })}
                    <button class="loom-btn loom-btn-ghost" data-action="translate-character" title="Перевести карточку на английский">
                        <i class="fa-solid fa-language"></i> На английский
                    </button>` : ''}
                </div>
            </div>

            ${renderMemo(draft)}

            ${renderImportBadge(draft)}

            <details class="loom-brief" data-details-key="brief" ${hasCard ? '' : 'open'}>
                <summary>Задумка ${hasCard ? '<span class="loom-brief-peek"></span>' : ''}</summary>
                <textarea class="loom-brief-text" rows="5"
                    placeholder="Кто это? Мир, роль, возраст, что с ним происходит, чем цепляет. Чем конкретнее — тем меньше придётся переписывать.">${escapeHtml(draft.brief)}</textarea>
                <textarea class="loom-notes-text" rows="3"
                    placeholder="Доп. требования">${escapeHtml(draft.notes)}</textarea>
                ${renderRefs(draft, 'Референсы: внешность, детали, вещи', 'refs-draft')}
                ${renderAvatar(draft)}
            </details>

            ${hasCard ? `<div class="loom-rating-summary">
                <div class="loom-rating-left">
                    <span class="loom-rating-text" data-summary="card">${escapeHtml(ratingSummary(cardSections))}</span>
                    ${renderWeight(draft.id, 'weigh-draft')}
                </div>
                <span class="loom-iteration">версия ${draft.iteration}</span></div>` : ''}

            ${hasCard
                ? renderSections(cardSections, `data-scope="character"`)
                : '<div class="loom-empty-note big">Опишите задумку и нажмите «Сгенерировать».</div>'}

            ${hasCard ? sceneItems().map(item => renderSceneItemBlock(draft, item)).join('') : ''}
        </div>`;
}

/**
 * Почему ответ не разобрался. Обрыв по лимиту токенов и «модель написала не то» —
 * разные беды с разным лечением, а один совет «увеличьте лимит» врёт в половине случаев.
 * @param {string} response сырой ответ модели
 * @param {string} what что мы в нём искали
 */
function parseFailure(response, what) {
    const text = String(response || '').trim();
    if (!text) return 'Модель вернула пустой ответ.';

    const opens = (text.match(/[{[]/g) || []).length;
    const closes = (text.match(/[}\]]/g) || []).length;
    if (opens > closes) {
        return `Ответ оборвался на полуслове (${what} не дописан) — увеличьте лимит токенов в настройках.`;
    }
    return `Не удалось разобрать ответ модели: ${what} в нём не нашёлся. Начало ответа — в консоли (F12).`;
}

/**
 * id пунктов, помеченных как «сцена» (scenario/first_mes по умолчанию).
 * Они не входят в «Сгенерировать»/«Переписать с оценками» карточки — своя кнопка,
 * свой запрос на каждый пункт, но зато и обычная генерация карточки не тянет их
 * за собой каждый раз. См. sceneItems() — та же выборка, но пункты формата целиком,
 * а не только их id (нужны и там, и там: id для фильтрации секций, label для кнопок).
 */
function sceneItemIds() {
    return sceneItems().map(item => item.id);
}

/**
 * Делит секции персонажа на «известные формату, не сцена» (кандидаты на переписывание
 * этим шагом) и «пройти насквозь» (сцена — свой шаг, ИЛИ id вообще не из активного
 * формата — например, поле «description» из карточки, импортированной из Таверны,
 * см. src/tavern-import.js). Пройти насквозь значит остаться нетронутым и не потеряться:
 * mergeSections сохранит их в хвосте, даже если формат про них не знает.
 */
function splitKnownCardSections(draft) {
    const sceneIds = sceneItemIds();
    const knownIds = new Set(activeFormat('character').map(item => item.id));
    const known = draft.sections.filter(s => !sceneIds.includes(s.id) && knownIds.has(s.id));
    const passthrough = draft.sections.filter(s => sceneIds.includes(s.id) || !knownIds.has(s.id));
    return { known, passthrough };
}

async function generateCharacter(draft) {
    // Сценарий и первое сообщение пишутся отдельным шагом каждый (см. generateSceneItem) —
    // карточка их не запрашивает
    const itemIds = activeFormat('character').filter(item => !item.scene).map(item => item.id);

    await withBusy('Пишу карточку…', async () => {
        const response = await callAI(
            characterCreatePrompt({ brief: draft.brief, name: draft.name, notes: draft.notes, images: draft.images }, itemIds),
            { system: characterSystemPrompt(), images: await loadImages(draft.images) },
        );
        const parsed = parseJsonLoose(response, 'card');
        if (!parsed?.card) throw new Error(parseFailure(response, 'объект карточки'));

        const sections = sectionsFromResponse(parsed.card, 'character', itemIds);
        if (!sections.length) throw new Error('В ответе модели не нашлось ни одного пункта формата.');

        if (draft.sections.length) pushHistory(draft);
        // Сценарий (свой шаг) и импортированные из Таверны поля (formatу неизвестны)
        // переживают перегенерацию карточки — «Сгенерировать заново» их не касается
        const { passthrough } = splitKnownCardSections(draft);
        draft.sections = mergeSections('character', passthrough, sections);
        if (!draft.name && parsed.name) draft.name = String(parsed.name).trim();
        draft.iteration = (draft.iteration || 0) + 1;
        touchDraft(draft);

        renderDraftList();
        renderMain();
        toast('success', 'Карточка готова. Оцените абзацы — и переписывайте.');
    });
}

async function rewriteCharacter(draft) {
    const keepThreshold = Number(getSettings().rating_keep_threshold) || 8;
    // Сценарий и первое сообщение переписываются каждый своей кнопкой (rewriteSceneItem), а поля, импортированные из
    // готовой карточки Таверны, могут не совпадать ни с одним пунктом активного формата —
    // ни то ни другое сюда не пускаем ни при какой оценке, чтобы не смешать шаги и не потерять
    // то, что формат просто не узнаёт
    const { known: cardSections, passthrough } = splitKnownCardSections(draft);

    // Пункты, где ВСЕ абзацы уже набрали порог «сохранить» и без комментариев, модель
    // не видит в контракте ответа вовсе — только в тексте текущей карточки для контекста.
    // Просить переписать то, что и так одобрено, — чистый расход токенов на ответе.
    const { approved, toRewrite } = splitApprovedSections(cardSections, keepThreshold);
    if (!toRewrite.length) {
        return toast('info', `Все пункты уже одобрены (оценка ≥ ${keepThreshold}) — переписывать нечего.`);
    }

    await withBusy('Переписываю с учётом оценок…', async () => {
        const itemIds = toRewrite.map(s => s.id);
        const response = await callAI(characterRewritePrompt(draft, itemIds), {
            system: characterSystemPrompt(),
            images: await loadImages(draft.images),
        });
        const parsed = parseJsonLoose(response, 'card');
        if (!parsed?.card) throw new Error(parseFailure(response, 'объект карточки'));

        const rewritten = sectionsFromResponse(parsed.card, 'character', itemIds);
        if (!rewritten.length) throw new Error('В ответе модели не нашлось ни одного пункта формата.');

        pushHistory(draft);
        // Оценки переносим только на дословно совпавший текст: у нового абзаца
        // не может быть чужой оценки, иначе следующая итерация пойдёт по ложному следу
        const rated = carryOverRatings(draft.history.at(-1).sections, rewritten);
        draft.sections = mergeSections('character', [...approved, ...passthrough], rated);
        if (parsed.name) draft.name = String(parsed.name).trim() || draft.name;
        draft.iteration = (draft.iteration || 0) + 1;
        touchDraft(draft);

        renderDraftList();
        renderMain();
        toast('success', `Версия ${draft.iteration} готова. Переписано пунктов: ${rewritten.length} из ${cardSections.length}.`);
    });
}

/**
 * Один пункт сцены (сценарий ИЛИ первое сообщение — но не оба разом, см. renderSceneItemBlock) —
 * с нуля или заново, без учёта прежних оценок абзацев. По сути то же самое, что и
 * regenerateSection, только показывает другой busy-текст и другой тост: тот привязан
 * к иконке рядом с уже написанным пунктом, а этот — к отдельной кнопке над ним,
 * которая должна работать и когда пункта в черновике ещё вообще нет.
 */
async function generateSceneItem(draft, itemId) {
    const item = activeFormat('character').find(i => i.id === itemId);
    if (!item) return;

    await withBusy(`Пишу «${item.label}»…`, async () => {
        const response = await callAI(characterRewritePrompt(draft, [itemId], draft.sceneBriefs?.[itemId]), {
            system: characterSystemPrompt(),
            images: await loadImages(draft.images),
        });
        const parsed = parseJsonLoose(response, 'card');
        if (!parsed?.card) throw new Error(parseFailure(response, 'объект карточки'));

        const rewritten = sectionsFromResponse(parsed.card, 'character', [itemId]);
        if (!rewritten.length) throw new Error(`В ответе модели не нашёлся пункт «${item.label}».`);

        if (draft.sections.some(s => s.id === itemId)) pushHistory(draft);
        const otherSections = draft.sections.filter(s => s.id !== itemId);
        draft.sections = mergeSections('character', otherSections, rewritten);
        touchDraft(draft);

        renderDraftList();
        renderMain();
        toast('success', `Пункт «${item.label}» готов.`);
    });
}

/** Переписывание одного пункта сцены с учётом оценок — та же логика «одобрено — не трогаем», что и у карточки. */
async function rewriteSceneItem(draft, itemId) {
    const item = activeFormat('character').find(i => i.id === itemId);
    if (!item) return;

    const keepThreshold = Number(getSettings().rating_keep_threshold) || 8;
    const sections = draft.sections.filter(s => s.id === itemId);
    const { approved, toRewrite } = splitApprovedSections(sections, keepThreshold);
    if (!toRewrite.length) {
        return toast('info', `Пункт «${item.label}» уже одобрен (оценка ≥ ${keepThreshold}) — переписывать нечего.`);
    }

    await withBusy(`Переписываю «${item.label}»…`, async () => {
        const response = await callAI(characterRewritePrompt(draft, [itemId], draft.sceneBriefs?.[itemId]), {
            system: characterSystemPrompt(),
            images: await loadImages(draft.images),
        });
        const parsed = parseJsonLoose(response, 'card');
        if (!parsed?.card) throw new Error(parseFailure(response, 'объект карточки'));

        const rewritten = sectionsFromResponse(parsed.card, 'character', [itemId]);
        if (!rewritten.length) throw new Error(`В ответе модели не нашёлся пункт «${item.label}».`);

        pushHistory(draft);
        const rated = carryOverRatings(draft.history.at(-1).sections, rewritten);
        const otherSections = draft.sections.filter(s => s.id !== itemId);
        draft.sections = mergeSections('character', [...otherSections, ...approved], rated);
        touchDraft(draft);

        renderMain();
        toast('success', `Пункт «${item.label}» переписан.`);
    });
}

/**
 * Пишет/переписывает ОДИН вариант из «Других вариантов первого сообщения»
 * (draft.altGreetings, см. renderAltGreetings) — своя идея (greeting.idea, необязательная)
 * и остальные уже написанные варианты (основной first_mes + другие altGreetings) идут
 * в промпт, чтобы модель не повторила то, что уже есть, а не изобретала в вакууме.
 */
/** Тексты уже написанных первых сообщений (основное + непустые варианты, кроме excludeIndex) — контекст «не повтори». */
function writtenGreetings(draft, excludeIndex = -1) {
    const primary = draft.sections.find(s => s.id === 'first_mes');
    return [
        ...(primary?.blocks?.length ? [primary.blocks.map(b => b.text).join(' ')] : []),
        ...draft.altGreetings.map((g, i) => (i !== excludeIndex ? String(g.text || '').trim() : '')).filter(Boolean),
    ];
}

/** Прежний текст варианта — в историю перед перезаписью (пустой не сохраняем: откатываться не к чему). */
function pushGreetingHistory(greeting) {
    const previous = String(greeting.text || '').trim();
    if (!previous) return;
    if (!Array.isArray(greeting.history)) greeting.history = [];
    greeting.history.push(previous);
    if (greeting.history.length > 5) greeting.history.shift();
    greeting.future = [];
}

/** Шаг назад/вперёд по тексту варианта; direction 'undo' | 'redo'. @returns {boolean} сдвинулось ли */
function stepGreetingHistory(greeting, direction) {
    const from = direction === 'undo' ? 'history' : 'future';
    const to = direction === 'undo' ? 'future' : 'history';
    if (!greeting?.[from]?.length) return false;
    if (!Array.isArray(greeting[to])) greeting[to] = [];
    greeting[to].push(String(greeting.text || ''));
    greeting.text = greeting[from].pop();
    return true;
}

async function generateAltGreeting(draft, index) {
    const greeting = draft.altGreetings?.[index];
    if (!greeting) return;

    await withBusy('Пишу вариант…', async () => {
        const response = await callAI(alternateGreetingPrompt(draft, greeting.idea, writtenGreetings(draft, index)), {
            system: characterSystemPrompt(),
            images: await loadImages(draft.images),
        });
        const parsed = parseJsonLoose(response, 'text');
        const text = String(parsed?.text || '').trim();
        if (!text) throw new Error(parseFailure(response, 'текст варианта'));

        pushGreetingHistory(greeting);
        greeting.text = text;
        touchDraft(draft);
        renderMain();
        toast('success', 'Вариант готов.');
    });
}

/**
 * «Написать все пустые» — одним запросом дописывает текст КАЖДОМУ варианту без текста
 * (идея уже могла быть вписана заранее в каждый). Варианты с текстом не трогает —
 * это ручная точечная «Заново» у конкретного варианта, а не то, что просят разом.
 */
async function generateAllAltGreetings(draft) {
    const targets = (draft.altGreetings || [])
        .map((g, i) => ({ g, i }))
        .filter(({ g }) => !String(g.text || '').trim());
    if (!targets.length) return toast('info', 'Пустых вариантов нет — писать нечего.');

    const siblings = writtenGreetings(draft);
    const items = targets.map(({ g, i }) => ({ id: String(i), idea: g.idea }));

    await withBusy(`Пишу варианты (${targets.length})…`, async () => {
        const response = await callAI(alternateGreetingsBatchPrompt(draft, items, siblings), {
            system: characterSystemPrompt(),
            images: await loadImages(draft.images),
        });
        const parsed = parseJsonLoose(response, 'greetings');
        if (!parsed?.greetings) throw new Error(parseFailure(response, 'варианты'));

        let written = 0;
        for (const { g, i } of targets) {
            const text = String(parsed.greetings[String(i)] || '').trim();
            if (text) { g.text = text; written++; }
        }
        if (!written) throw new Error('Модель не вернула ни одного варианта.');

        touchDraft(draft);
        renderMain();
        toast(written === targets.length ? 'success' : 'info',
            `Написано ${written} из ${targets.length}.`);
    });
}

/**
 * Точечная перегенерация ОДНОГО пункта карточки — кнопка со стрелкой рядом с его
 * заголовком. В отличие от «Переписать с оценками» не смотрит на оценки вообще:
 * это ручной «перекинь кубик ещё раз», а не следствие разбора отзывов.
 */
async function regenerateSection(draft, sectionId) {
    const item = activeFormat('character').find(i => i.id === sectionId);
    if (!item) return;

    await withBusy(`Переписываю «${item.label}»…`, async () => {
        const response = await callAI(characterRewritePrompt(draft, [sectionId], draft.sceneBriefs?.[sectionId]), {
            system: characterSystemPrompt(),
            images: await loadImages(draft.images),
        });
        const parsed = parseJsonLoose(response, 'card');
        if (!parsed?.card) throw new Error(parseFailure(response, 'объект карточки'));

        const rewritten = sectionsFromResponse(parsed.card, 'character', [sectionId]);
        if (!rewritten.length) throw new Error(`Модель не вернула пункт «${item.label}».`);

        pushHistory(draft);
        const rated = carryOverRatings(draft.history.at(-1).sections, rewritten);
        const otherSections = draft.sections.filter(s => s.id !== sectionId);
        draft.sections = mergeSections('character', otherSections, rated);
        touchDraft(draft);

        renderMain();
        toast('success', `«${item.label}» переписан.`);
    });
}

// ─── Режим: персона ({{user}}) ──────────────────────────────────────────────

function renderPersona(draft) {
    const hasCard = !!draft.sections.length;
    return `
        <div class="loom-editor" data-draft="${escapeHtml(draft.id)}">
            <div class="loom-editor-head">
                ${renderBackButton()}
                <input type="text" class="loom-title-input loom-draft-name-input"
                    placeholder="Имя персоны" value="${escapeHtml(draft.name)}">
                <button class="loom-icon-btn loom-head-copy" data-action="duplicate-draft" title="Дублировать черновик">
                    <i class="fa-solid fa-copy"></i>
                </button>
                <button class="loom-icon-btn loom-danger loom-head-delete" data-action="delete-draft" title="Удалить черновик">
                    <i class="fa-solid fa-trash"></i>
                </button>
                <div class="loom-editor-actions">
                    <button class="loom-btn loom-btn-primary" data-action="generate-persona">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> ${hasCard ? btnLabel('Сгенерировать заново', 'Заново') : 'Сгенерировать'}
                    </button>
                    ${hasCard ? `
                    <button class="loom-btn loom-btn-accent" data-action="rewrite-persona">
                        <i class="fa-solid fa-arrows-rotate"></i> ${btnLabel('Переписать с оценками', 'С оценками')}
                    </button>
                    ${renderHistoryPair(draft)}
                    ${renderMenu({
                        icon: draft.importedAvatar ? 'fa-rotate' : 'fa-file-export',
                        label: 'Экспорт',
                        items: [
                            { action: 'export-persona',
                                icon: draft.importedAvatar ? 'fa-rotate' : 'fa-file-import',
                                label: draft.importedAvatar ? 'Обновить в Таверне' : 'В Таверну' },
                            { action: 'download-persona', icon: 'fa-download', label: 'Скачать JSON' },
                        ],
                    })}
                    <button class="loom-btn loom-btn-ghost" data-action="translate-persona" title="Перевести на английский">
                        <i class="fa-solid fa-language"></i> На английский
                    </button>` : ''}
                </div>
            </div>

            ${renderMemo(draft)}

            ${renderImportBadge(draft)}

            <label class="loom-field compact loom-persona-title-field">
                <span class="loom-label">Заметка для списка Таверны</span>
                <input type="text" class="loom-persona-title-input"
                    placeholder="Например: AU — не путать с основной"
                    value="${escapeHtml(draft.personaTitle || '')}">
            </label>
            <span class="loom-hint">Подпись в списке персон Таверны. В промпт не идёт.</span>

            <details class="loom-brief" data-details-key="brief" ${hasCard ? '' : 'open'}>
                <summary>Задумка ${hasCard ? '<span class="loom-brief-peek"></span>' : ''}</summary>
                <textarea class="loom-brief-text" rows="5"
                    placeholder="Кто это? Возраст, роль, чем занимается, чем цепляет. Чем конкретнее — тем меньше придётся переписывать.">${escapeHtml(draft.brief)}</textarea>
                <textarea class="loom-notes-text" rows="3"
                    placeholder="Доп. требования">${escapeHtml(draft.notes)}</textarea>
                ${renderRefs(draft, 'Референсы: внешность, детали', 'refs-draft')}
                ${renderAvatar(draft, 'Картинка персоны', 'Обрезается до 2:3.')}
            </details>

            ${hasCard ? `<div class="loom-rating-summary">
                <div class="loom-rating-left">
                    <span class="loom-rating-text" data-summary="card">${escapeHtml(ratingSummary(draft.sections))}</span>
                    ${renderWeight(draft.id, 'weigh-draft')}
                </div>
                <span class="loom-iteration">версия ${draft.iteration}</span></div>` : ''}

            ${hasCard
                ? renderSections(draft.sections, `data-scope="character"`)
                : '<div class="loom-empty-note big">Опишите задумку и нажмите «Сгенерировать».</div>'}
        </div>`;
}

async function generatePersona(draft) {
    await withBusy('Пишу персону…', async () => {
        const response = await callAI(
            personaCreatePrompt({ brief: draft.brief, name: draft.name, notes: draft.notes, images: draft.images }),
            { system: personaSystemPrompt(), images: await loadImages(draft.images) },
        );
        const parsed = parseJsonLoose(response, 'card');
        if (!parsed?.card) throw new Error(parseFailure(response, 'объект персоны'));

        const sections = sectionsFromResponse(parsed.card, 'persona');
        if (!sections.length) throw new Error('В ответе модели не нашлось ни одного пункта формата.');

        if (draft.sections.length) pushHistory(draft);
        draft.sections = sections;
        if (!draft.name && parsed.name) draft.name = String(parsed.name).trim();
        draft.iteration = (draft.iteration || 0) + 1;
        touchDraft(draft);

        renderDraftList();
        renderMain();
        toast('success', 'Персона готова. Оцените абзацы — и переписывайте.');
    });
}

async function rewritePersona(draft) {
    const keepThreshold = Number(getSettings().rating_keep_threshold) || 8;
    const { approved, toRewrite } = splitApprovedSections(draft.sections, keepThreshold);
    if (!toRewrite.length) {
        return toast('info', `Все пункты уже одобрены (оценка ≥ ${keepThreshold}) — переписывать нечего.`);
    }

    await withBusy('Переписываю с учётом оценок…', async () => {
        const itemIds = toRewrite.map(s => s.id);
        const response = await callAI(personaRewritePrompt(draft, itemIds), {
            system: personaSystemPrompt(),
            images: await loadImages(draft.images),
        });
        const parsed = parseJsonLoose(response, 'card');
        if (!parsed?.card) throw new Error(parseFailure(response, 'объект персоны'));

        const rewritten = sectionsFromResponse(parsed.card, 'persona', itemIds);
        if (!rewritten.length) throw new Error('В ответе модели не нашлось ни одного пункта формата.');

        pushHistory(draft);
        const rated = carryOverRatings(draft.history.at(-1).sections, rewritten);
        draft.sections = mergeSections('persona', approved, rated);
        if (parsed.name) draft.name = String(parsed.name).trim() || draft.name;
        draft.iteration = (draft.iteration || 0) + 1;
        touchDraft(draft);

        renderDraftList();
        renderMain();
        toast('success', `Версия ${draft.iteration} готова. Переписано пунктов: ${rewritten.length} из ${draft.sections.length}.`);
    });
}

/** Точечная перегенерация одного пункта персоны — та же логика, что у карточки персонажа. */
async function regeneratePersonaSection(draft, sectionId) {
    const item = activeFormat('persona').find(i => i.id === sectionId);
    if (!item) return;

    await withBusy(`Переписываю «${item.label}»…`, async () => {
        const response = await callAI(personaRewritePrompt(draft, [sectionId]), {
            system: personaSystemPrompt(),
            images: await loadImages(draft.images),
        });
        const parsed = parseJsonLoose(response, 'card');
        if (!parsed?.card) throw new Error(parseFailure(response, 'объект персоны'));

        const rewritten = sectionsFromResponse(parsed.card, 'persona', [sectionId]);
        if (!rewritten.length) throw new Error(`Модель не вернула пункт «${item.label}».`);

        pushHistory(draft);
        const rated = carryOverRatings(draft.history.at(-1).sections, rewritten);
        const otherSections = draft.sections.filter(s => s.id !== sectionId);
        draft.sections = mergeSections('persona', otherSections, rated);
        touchDraft(draft);

        renderMain();
        toast('success', `«${item.label}» переписан.`);
    });
}

// ─── Режим: системный промпт ────────────────────────────────────────────────

/**
 * Системный промпт для ролевой.
 *
 * Отличий от персоны два. Первое: результат никуда не экспортируется — его копируют
 * кнопкой и вставляют руками (в Chat Completion это Prompt Manager → Main Prompt,
 * в Text Completion — Advanced Formatting → System Prompt; куда именно, зависит от
 * подключения, и решать за пользователя не стоит). Второе: нет ни аватара, ни имени
 * как поля карточки — имя тут только подпись черновика в списке.
 */
function renderPrompt(draft) {
    const hasCard = !!draft.sections.length;
    return `
        <div class="loom-editor" data-draft="${escapeHtml(draft.id)}">
            <div class="loom-editor-head">
                ${renderBackButton()}
                <input type="text" class="loom-title-input loom-draft-name-input"
                    placeholder="Название промпта" value="${escapeHtml(draft.name)}">
                <button class="loom-icon-btn loom-head-copy" data-action="duplicate-draft" title="Дублировать черновик">
                    <i class="fa-solid fa-copy"></i>
                </button>
                <button class="loom-icon-btn loom-danger loom-head-delete" data-action="delete-draft" title="Удалить черновик">
                    <i class="fa-solid fa-trash"></i>
                </button>
                <div class="loom-editor-actions">
                    <button class="loom-btn loom-btn-primary" data-action="generate-prompt">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> ${hasCard ? btnLabel('Сгенерировать заново', 'Заново') : 'Сгенерировать'}
                    </button>
                    ${hasCard ? `
                    <button class="loom-btn loom-btn-accent" data-action="rewrite-prompt">
                        <i class="fa-solid fa-arrows-rotate"></i> ${btnLabel('Переписать с оценками', 'С оценками')}
                    </button>
                    <button class="loom-btn loom-btn-accent" data-action="copy-prompt"
                        title="Скопировать готовый текст — вставить в Prompt Manager или System Prompt Таверны">
                        <i class="fa-solid fa-copy"></i> Копировать
                    </button>
                    ${renderHistoryPair(draft)}
                    <button class="loom-btn loom-btn-ghost" data-action="translate-prompt" title="Перевести на английский">
                        <i class="fa-solid fa-language"></i> На английский
                    </button>
                    <button class="loom-btn loom-btn-ghost" data-action="download-prompt" title="Скачать текстовым файлом">
                        <i class="fa-solid fa-download"></i> TXT
                    </button>` : ''}
                </div>
            </div>

            ${renderMemo(draft)}

            <details class="loom-brief" data-details-key="brief" ${hasCard ? '' : 'open'}>
                <summary>Задумка ${hasCard ? '<span class="loom-brief-peek"></span>' : ''}</summary>
                <textarea class="loom-brief-text" rows="5"
                    placeholder="Какая это ролевая: жанр, тон, темп, от какого лица. Что бесит в дефолтных ответах модели — то и опишите.">${escapeHtml(draft.brief)}</textarea>
                <textarea class="loom-notes-text" rows="3"
                    placeholder="Доп. требования">${escapeHtml(draft.notes)}</textarea>
            </details>

            ${hasCard ? `<div class="loom-rating-summary">
                <div class="loom-rating-left">
                    <span class="loom-rating-text" data-summary="card">${escapeHtml(ratingSummary(draft.sections))}</span>
                    ${renderWeight(draft.id, 'weigh-draft')}
                </div>
                <span class="loom-iteration">версия ${draft.iteration}</span></div>` : ''}

            ${hasCard
                ? renderSections(draft.sections, `data-scope="character"`)
                : '<div class="loom-empty-note big">Опишите ролевую и нажмите «Сгенерировать».</div>'}
        </div>`;
}

async function generatePrompt(draft) {
    await withBusy('Пишу промпт…', async () => {
        const response = await callAI(
            promptCreatePrompt({ brief: draft.brief, notes: draft.notes }),
            { system: promptSystemPrompt() },
        );
        const parsed = parseJsonLoose(response, 'card');
        if (!parsed?.card) throw new Error(parseFailure(response, 'объект промпта'));

        const sections = sectionsFromResponse(parsed.card, 'prompt');
        if (!sections.length) throw new Error('В ответе модели не нашлось ни одного пункта формата.');

        if (draft.sections.length) pushHistory(draft);
        draft.sections = sections;
        draft.iteration = (draft.iteration || 0) + 1;
        touchDraft(draft);

        renderDraftList();
        renderMain();
        toast('success', 'Промпт готов. Оцените абзацы — и переписывайте.');
    });
}

async function rewritePrompt(draft) {
    const keepThreshold = Number(getSettings().rating_keep_threshold) || 8;
    const { approved, toRewrite } = splitApprovedSections(draft.sections, keepThreshold);
    if (!toRewrite.length) {
        return toast('info', `Все пункты уже одобрены (оценка ≥ ${keepThreshold}) — переписывать нечего.`);
    }

    await withBusy('Переписываю с учётом оценок…', async () => {
        const itemIds = toRewrite.map(s => s.id);
        const response = await callAI(promptRewritePrompt(draft, itemIds), { system: promptSystemPrompt() });
        const parsed = parseJsonLoose(response, 'card');
        if (!parsed?.card) throw new Error(parseFailure(response, 'объект промпта'));

        const rewritten = sectionsFromResponse(parsed.card, 'prompt', itemIds);
        if (!rewritten.length) throw new Error('В ответе модели не нашлось ни одного пункта формата.');

        pushHistory(draft);
        const rated = carryOverRatings(draft.history.at(-1).sections, rewritten);
        draft.sections = mergeSections('prompt', approved, rated);
        draft.iteration = (draft.iteration || 0) + 1;
        touchDraft(draft);

        renderDraftList();
        renderMain();
        toast('success', `Версия ${draft.iteration} готова. Переписано пунктов: ${rewritten.length} из ${draft.sections.length}.`);
    });
}

/** Точечная перегенерация одного пункта промпта — та же логика, что у карточки. */
async function regeneratePromptSection(draft, sectionId) {
    const item = activeFormat('prompt').find(i => i.id === sectionId);
    if (!item) return;

    await withBusy(`Переписываю «${item.label}»…`, async () => {
        const response = await callAI(promptRewritePrompt(draft, [sectionId]), { system: promptSystemPrompt() });
        const parsed = parseJsonLoose(response, 'card');
        if (!parsed?.card) throw new Error(parseFailure(response, 'объект промпта'));

        const rewritten = sectionsFromResponse(parsed.card, 'prompt', [sectionId]);
        if (!rewritten.length) throw new Error(`Модель не вернула пункт «${item.label}».`);

        pushHistory(draft);
        const rated = carryOverRatings(draft.history.at(-1).sections, rewritten);
        const otherSections = draft.sections.filter(s => s.id !== sectionId);
        draft.sections = mergeSections('prompt', otherSections, rated);
        touchDraft(draft);

        renderMain();
        toast('success', `«${item.label}» переписан.`);
    });
}

// ─── Режим: сценарий ────────────────────────────────────────────────────────

/**
 * Идеи (draft.ideas) — черновой список коротких питчей, не пункты формата: показывается,
 * только пока хоть одна есть. Каждая карточка предлагает забрать текст идеи в задумку
 * (data-action="pick-idea") — дальше её можно поправить руками и проработать обычной
 * кнопкой «Проработать сценарий», один и тот же путь что для идеи, что для придуманной
 * с нуля задумки.
 */
function renderScenarioIdeas(draft) {
    if (!draft.ideas?.length) return '';
    return `
        <div class="loom-scenario-ideas">
            <span class="loom-label">Идеи — заберите одну в задумку и проработайте</span>
            ${draft.ideas.map((idea, index) => `
                <div class="loom-idea" data-idea="${index}">
                    <p class="loom-idea-text">${escapeHtml(idea.text)}</p>
                    <div class="loom-idea-actions">
                        <button class="loom-btn loom-btn-small loom-btn-ghost" data-action="pick-idea">
                            <i class="fa-solid fa-arrow-turn-down"></i> В задумку
                        </button>
                        <button class="loom-icon-btn loom-danger" data-action="delete-idea" title="Удалить идею">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>`).join('')}
        </div>`;
}

function renderScenario(draft) {
    const hasCard = !!draft.sections.length;
    return `
        <div class="loom-editor" data-draft="${escapeHtml(draft.id)}">
            <div class="loom-editor-head">
                ${renderBackButton()}
                <input type="text" class="loom-title-input loom-draft-name-input"
                    placeholder="Название сценария" value="${escapeHtml(draft.name)}">
                <button class="loom-icon-btn loom-head-copy" data-action="duplicate-draft" title="Дублировать черновик">
                    <i class="fa-solid fa-copy"></i>
                </button>
                <button class="loom-icon-btn loom-danger loom-head-delete" data-action="delete-draft" title="Удалить черновик">
                    <i class="fa-solid fa-trash"></i>
                </button>
                <div class="loom-editor-actions">
                    <button class="loom-btn loom-btn-ghost" data-action="scenario-ideas">
                        <i class="fa-solid fa-lightbulb"></i> ${btnLabel('Придумать идеи', 'Идеи')}
                    </button>
                    <button class="loom-btn loom-btn-primary" data-action="scenario-develop">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> ${hasCard ? btnLabel('Проработать заново', 'Заново') : btnLabel('Проработать сценарий', 'Проработать')}
                    </button>
                    ${hasCard ? `
                    <button class="loom-btn loom-btn-accent" data-action="rewrite-scenario">
                        <i class="fa-solid fa-arrows-rotate"></i> ${btnLabel('Переписать с оценками', 'С оценками')}
                    </button>
                    <button class="loom-btn loom-btn-accent" data-action="copy-scenario" title="Скопировать готовый текст">
                        <i class="fa-solid fa-copy"></i> Копировать
                    </button>
                    ${renderHistoryPair(draft)}
                    <button class="loom-btn loom-btn-ghost" data-action="translate-scenario" title="Перевести на английский">
                        <i class="fa-solid fa-language"></i> На английский
                    </button>
                    <button class="loom-btn loom-btn-ghost" data-action="download-scenario" title="Скачать текстовым файлом">
                        <i class="fa-solid fa-download"></i> TXT
                    </button>` : ''}
                </div>
            </div>

            ${renderMemo(draft)}

            <details class="loom-brief" data-details-key="brief" ${hasCard ? '' : 'open'}>
                <summary>Задумка ${hasCard ? '<span class="loom-brief-peek"></span>' : ''}</summary>
                <textarea class="loom-brief-text" rows="5"
                    placeholder="Премиса сценария — или направление для идей: жанр, завязка, что должно случиться.">${escapeHtml(draft.brief)}</textarea>
                <textarea class="loom-notes-text" rows="3"
                    placeholder="Доп. требования">${escapeHtml(draft.notes)}</textarea>
                ${renderCharacterLinkSelect(draft, 'Персонажи сценария')}
                ${renderRefs(draft, 'Референсы', 'refs-draft')}
            </details>

            ${renderScenarioIdeas(draft)}

            ${hasCard ? `<div class="loom-rating-summary">
                <div class="loom-rating-left">
                    <span class="loom-rating-text" data-summary="card">${escapeHtml(ratingSummary(draft.sections))}</span>
                    ${renderWeight(draft.id, 'weigh-draft')}
                </div>
                <span class="loom-iteration">версия ${draft.iteration}</span></div>` : ''}

            ${hasCard
                ? renderSections(draft.sections, `data-scope="character"`)
                : '<div class="loom-empty-note big">Опишите сценарий и нажмите «Проработать сценарий».</div>'}
        </div>`;
}

// ─── Режим: сюжет ───────────────────────────────────────────────────────────

/** Привязка сюжета к ЧАТУ: какое состояние показать в редакторе (см. src/plot.js). */
function renderPlotStatus(draft) {
    const total = plotLeaves(draft).length;
    if (!isChatOpen()) {
        return `<div class="loom-plot-status idle"><i class="fa-solid fa-link-slash"></i>
            Откройте чат, чтобы привязать сюжет.</div>`;
    }
    const cast = chatCast();
    const castLine = `<div class="loom-plot-cast-note"><i class="fa-solid fa-users"></i> Из чата${cast.characters.length ? `: ${escapeHtml(cast.characters.map(c => c.name).join(', '))}` : ''}${cast.persona ? ` · вы — ${escapeHtml(cast.persona.name)}` : ''}.</div>`;
    const chatState = getPlotState();
    if (chatState?.draftId === draft.id) {
        const { step, finished, leaf, stepNo, stepTotal } = plotProgress(draft, chatState);
        const label = leaf ? (leaf.subIndex === null ? leaf.step.title : `${leaf.step.title} › ${leaf.node.title}`) : '';
        return `
            <div class="loom-plot-status live">
                <div class="loom-plot-status-text">
                    <i class="fa-solid fa-link"></i> <b>Активен в этом чате</b> ·
                    ${finished ? 'сюжет пройден' : `пункт ${stepNo} из ${stepTotal}: ${escapeHtml(label)}`}
                </div>
                <div class="loom-plot-status-actions">
                    <button class="loom-btn loom-btn-small loom-btn-ghost" data-action="plot-back" ${step <= 0 ? 'disabled' : ''}
                        title="Вернуться на пункт назад"><i class="fa-solid fa-backward-step"></i></button>
                    <button class="loom-btn loom-btn-small loom-btn-accent" data-action="plot-next" ${finished ? 'disabled' : ''}
                        title="Отметить текущий пункт выполненным"><i class="fa-solid fa-check"></i> Пункт выполнен</button>
                    <button class="loom-btn loom-btn-small loom-btn-ghost" data-action="plot-reset" title="Начать с первого пункта">
                        <i class="fa-solid fa-rotate-left"></i> Сначала</button>
                    <button class="loom-btn loom-btn-small loom-btn-ghost" data-action="plot-unbind">
                        <i class="fa-solid fa-link-slash"></i> Отвязать</button>
                </div>
            </div>${castLine}`;
    }
    const other = chatState ? getDraft(chatState.draftId) : null;
    return `
        <div class="loom-plot-status">
            <div class="loom-plot-status-text">
                ${other ? `В этом чате уже следим за «${escapeHtml(other.name || 'Без имени')}».` : 'Не привязан к чату.'}
                ${total ? '' : '<div class="loom-hint">Сначала нужны шаги.</div>'}
            </div>
            <div class="loom-plot-status-actions">
                <button class="loom-btn loom-btn-small loom-btn-primary" data-action="plot-bind" ${total ? '' : 'disabled'}
                    title="${total ? 'Следить за этим сюжетом в открытом сейчас чате' : 'Сначала составьте шаги'}">
                    <i class="fa-solid fa-link"></i> ${other ? 'Привязать вместо него' : 'Привязать к этому чату'}</button>
            </div>
        </div>${castLine}`;
}

/**
 * Значок и подсказка кнопки «выполнен» у шага или подпункта. range — его диапазон листьев [от, до),
 * pos — сколько листьев пройдено. Пройден — нажатие вернёт прогресс на его начало, иначе отметит
 * выполненными все пункты до него включительно.
 */
function plotMark(range, pos, bound) {
    const icon = 'fa-circle-check';
    if (!bound) return { icon, done: false, title: 'Привяжите сюжет к чату, чтобы отмечать пункты' };
    const [from, to] = range;
    if (pos >= to) return { icon, done: true, title: 'Выполнено — нажмите, чтобы вернуть прогресс сюда' };
    return { icon, done: false, title: pos >= from ? 'Отметить выполненным' : 'Отметить выполненными все пункты до этого включительно' };
}

/** Общие поля шага и подпункта: название (только у подпункта — у шага оно в шапке), цель, условие, осложнение. */
function renderPlotFields(node, { hasSubs = false } = {}) {
    return `
            <label class="loom-plot-label">Цель — к чему идёт история</label>
            <textarea class="loom-plot-field loom-plot-textarea" data-field="goal" rows="2">${escapeHtml(node.goal)}</textarea>
            <label class="loom-plot-label">${hasSubs
                ? 'Весь пункт выполнен, когда — общее описание (ход отслеживается по подпунктам)'
                : 'Выполнено, когда — событие, которое можно проверить по тексту'}</label>
            <textarea class="loom-plot-field loom-plot-textarea" data-field="condition" rows="2">${escapeHtml(node.condition)}</textarea>
            <label class="loom-plot-label">Осложнение (необязательно)</label>
            <textarea class="loom-plot-field loom-plot-textarea" data-field="complication" rows="1">${escapeHtml(node.complication || '')}</textarea>`;
}

/** Личные цели персонажей (для групповых чатов): кто — что он ТАЙНО преследует, пока пункт активен. */
function renderPlotGoals(node) {
    const goals = node.goals || [];
    return `
            <div class="loom-plot-goals">
                <label class="loom-plot-label">Личные цели персонажей (для групповых чатов)</label>
                ${goals.map((g, k) => `
                <div class="loom-plot-goal" data-goal="${k}">
                    <input type="text" class="loom-plot-goal-who" list="loom-plot-cast" placeholder="Кто (имя персонажа)" value="${escapeHtml(g.who)}">
                    <textarea class="loom-plot-goal-text loom-plot-textarea" rows="1" placeholder="Что он хочет в этом пункте">${escapeHtml(g.text)}</textarea>
                    <button class="loom-icon-btn loom-danger" data-action="plot-goal-delete" title="Убрать цель"><i class="fa-solid fa-xmark"></i></button>
                </div>`).join('')}
                <button class="loom-btn loom-btn-ghost loom-btn-small" data-action="plot-goal-add"><i class="fa-solid fa-plus"></i> Цель персонажа</button>
            </div>`;
}

function renderPlotSub(draft, s, sub, i, j, leafStart, pos, bound) {
    const mark = plotMark([leafStart + j, leafStart + j + 1], pos, bound);
    const done = bound && pos >= leafStart + j + 1;
    const current = bound && pos === leafStart + j;
    return `
            <div class="loom-plot-sub ${current ? 'current' : ''} ${done ? 'done' : ''}" data-step="${i}" data-sub="${j}">
                <div class="loom-plot-sub-head">
                    <span class="loom-plot-num loom-plot-subnum">${done ? '<i class="fa-solid fa-check"></i>' : `${i + 1}.${j + 1}`}</span>
                    <input type="text" class="loom-plot-field loom-plot-title" data-field="title"
                        placeholder="Название подпункта" value="${escapeHtml(sub.title)}">
                    <span class="loom-plot-step-tools">
                        <button class="loom-icon-btn loom-plot-done-btn ${mark.done ? 'is-done' : ''}" data-action="plot-step-done" ${bound ? '' : 'disabled'}
                            title="${escapeHtml(mark.title)}"><i class="fa-solid ${mark.icon}"></i></button>
                        <button class="loom-icon-btn" data-action="plot-step-up" title="Выше" ${j === 0 ? 'disabled' : ''}><i class="fa-solid fa-chevron-up"></i></button>
                        <button class="loom-icon-btn" data-action="plot-step-down" title="Ниже" ${j === s.substeps.length - 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-down"></i></button>
                        <button class="loom-icon-btn loom-danger" data-action="plot-step-delete" title="Удалить подпункт"><i class="fa-solid fa-trash"></i></button>
                    </span>
                </div>
                ${renderPlotFields(sub)}
                ${renderPlotGoals(sub)}
            </div>`;
}

function renderPlot(draft) {
    const hasSteps = !!draft.steps.length;
    const chatState = getPlotState();
    const bound = chatState?.draftId === draft.id;
    const pos = bound ? plotProgress(draft, chatState).step : -1;
    const leaves = plotLeaves(draft);

    const steps = draft.steps.map((s, i) => {
        const range = stepRange(leaves, i);
        const mark = plotMark(range, pos, bound);
        const done = bound && pos >= range[1];
        const current = bound && pos >= range[0] && pos < range[1];
        const subs = Array.isArray(s.substeps) ? s.substeps : [];
        return `
        <details class="loom-plot-step ${current ? 'current' : ''} ${done ? 'done' : ''}" data-step="${i}"
            data-details-key="plot-step-${escapeHtml(s.id)}" open>
            <summary class="loom-plot-step-head">
                <i class="fa-solid fa-chevron-right loom-plot-chevron"></i>
                <span class="loom-plot-num">${done ? '<i class="fa-solid fa-check"></i>' : i + 1}</span>
                <span class="loom-plot-step-name">${escapeHtml(s.title || 'Без названия')}</span>
                <span class="loom-plot-step-tools">
                    <button class="loom-icon-btn loom-plot-done-btn ${mark.done ? 'is-done' : ''}" data-action="plot-step-done" ${bound ? '' : 'disabled'}
                        title="${escapeHtml(mark.title)}"><i class="fa-solid ${mark.icon}"></i></button>
                    <button class="loom-icon-btn" data-action="plot-step-up" title="Выше" ${i === 0 ? 'disabled' : ''}><i class="fa-solid fa-chevron-up"></i></button>
                    <button class="loom-icon-btn" data-action="plot-step-down" title="Ниже" ${i === draft.steps.length - 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-down"></i></button>
                    <button class="loom-icon-btn" data-action="plot-step-rewrite" title="Переписать этот шаг"><i class="fa-solid fa-arrows-rotate"></i></button>
                    <button class="loom-icon-btn loom-danger" data-action="plot-step-delete" title="Удалить шаг"><i class="fa-solid fa-trash"></i></button>
                </span>
            </summary>
            <label class="loom-plot-label">Название</label>
            <input type="text" class="loom-plot-field loom-plot-title" data-field="title"
                placeholder="Название шага" value="${escapeHtml(s.title)}">
            ${renderPlotFields(s, { hasSubs: subs.length > 0 })}
            ${renderPlotGoals(s)}
            <div class="loom-plot-subs">
                ${subs.length ? '<label class="loom-plot-label">Подпункты — этапы этого шага, идут по порядку</label>' : ''}
                ${subs.map((sub, j) => renderPlotSub(draft, s, sub, i, j, range[0], pos, bound)).join('')}
                <button class="loom-btn loom-btn-ghost loom-btn-small" data-action="plot-add-sub"><i class="fa-solid fa-plus"></i> Подпункт</button>
                <button class="loom-btn loom-btn-ghost loom-btn-small" data-action="plot-sub-generate"
                    title="Модель разобьёт шаг на подпункты"><i class="fa-solid fa-wand-magic-sparkles"></i> Расписать подпунктами</button>
            </div>
        </details>`;
    }).join('');

    const castNames = [...new Set([
        ...(draft.characterIds || []).map(id => getDraft(id)?.name).filter(Boolean),
        ...(isChatOpen() ? chatCast().characters.map(c => c.name) : []),
    ])];

    return `
        <div class="loom-editor" data-draft="${escapeHtml(draft.id)}">
            <div class="loom-editor-head">
                ${renderBackButton()}
                <input type="text" class="loom-title-input loom-draft-name-input"
                    placeholder="Название сюжета" value="${escapeHtml(draft.name)}">
                <button class="loom-icon-btn loom-head-copy" data-action="duplicate-draft" title="Дублировать черновик">
                    <i class="fa-solid fa-copy"></i>
                </button>
                <button class="loom-icon-btn loom-danger loom-head-delete" data-action="delete-draft" title="Удалить черновик">
                    <i class="fa-solid fa-trash"></i>
                </button>
                <div class="loom-editor-actions">
                    <button class="loom-btn loom-btn-primary" data-action="plot-generate">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> ${hasSteps ? btnLabel('Составить заново', 'Заново') : btnLabel('Составить сюжет', 'Составить')}
                    </button>
                    <button class="loom-btn loom-btn-ghost" data-action="plot-add-step" title="Добавить шаг в конец">
                        <i class="fa-solid fa-plus"></i> Шаг
                    </button>
                    ${hasSteps || draft.stepsHistory?.length || draft.stepsFuture?.length ? `
                    <div class="loom-btn-group">
                        <button class="loom-btn loom-btn-ghost" data-action="plot-undo" ${draft.stepsHistory?.length ? '' : 'disabled'}
                            title="Вернуться к предыдущей версии шагов"><i class="fa-solid fa-clock-rotate-left"></i> Откатить</button>
                        <button class="loom-btn loom-btn-ghost" data-action="plot-redo" ${draft.stepsFuture?.length ? '' : 'disabled'}
                            title="Вернуться вперёд к версии, от которой откатились"><i class="fa-solid fa-clock-rotate-left fa-flip-horizontal"></i> Вперёд</button>
                    </div>` : ''}
                    ${hasSteps ? `
                    <button class="loom-btn loom-btn-ghost" data-action="plot-toggle-steps" title="Свернуть или развернуть все шаги">
                        <i class="fa-solid fa-angles-up"></i>
                    </button>` : ''}
                </div>
            </div>

            ${renderMemo(draft)}

            <details class="loom-brief" data-details-key="brief" ${hasSteps ? '' : 'open'}>
                <summary>Задумка ${hasSteps ? '<span class="loom-brief-peek"></span>' : ''}</summary>
                <textarea class="loom-brief-text" rows="5"
                    placeholder="О чём арка: жанр, главный конфликт, чем всё должно закончиться (или оставьте пустым — модель придумает сама).">${escapeHtml(draft.brief)}</textarea>
                <textarea class="loom-notes-text" rows="3"
                    placeholder="Доп. требования">${escapeHtml(draft.notes)}</textarea>
                <label class="loom-field compact">
                    <span class="loom-label">Сколько шагов (0 — на усмотрение модели)</span>
                    <input type="number" class="loom-plot-count" min="0" max="20" step="1" value="${Number(draft.stepCount) || 0}">
                </label>
                <label class="loom-field compact">
                    <span class="loom-label">Подпунктов в шаге (0 — на усмотрение модели)</span>
                    <input type="number" class="loom-plot-subcount" min="0" max="8" step="1" value="${Number(draft.subCount) || 0}">
                </label>
                <label class="loom-check">
                    <input type="checkbox" class="loom-plot-usecast" ${draft.useChatCast === false ? '' : 'checked'}>
                    <span>Брать персонажей и персону из открытого чата автоматически</span>
                </label>
                <span class="loom-hint">Таверна сама знает, кто в чате.</span>
                ${renderCharacterLinkSelect(draft, 'Персонажи сюжета (необязательно, из LOOM)')}
            </details>

            <datalist id="loom-plot-cast">${castNames.map(n => `<option value="${escapeHtml(n)}"></option>`).join('')}</datalist>

            <div class="loom-plot-status-wrap">${renderPlotStatus(draft)}</div>

            ${hasSteps
                ? `<div class="loom-plot-steps">${steps}</div>`
                : '<div class="loom-empty-note big">Опишите задумку и нажмите «Составить сюжет».</div>'}
        </div>`;
}

function normalizeNode(item) {
    return {
        id: uid(),
        title: String(item?.title || '').trim(),
        goal: String(item?.goal || '').trim(),
        condition: String(item?.condition || '').trim(),
        complication: String(item?.complication || '').trim(),
        goals: normalizeGoals(item?.goals),
    };
}

function normalizeGoals(list) {
    return (Array.isArray(list) ? list : [])
        .map(g => ({ id: uid(), who: String(g?.who || '').trim(), text: String(g?.text || '').trim() }))
        .filter(g => g.who && g.text);
}

function normalizeSteps(list) {
    return (Array.isArray(list) ? list : []).map(item => ({
        ...normalizeNode(item),
        substeps: (Array.isArray(item?.substeps) ? item.substeps : []).map(normalizeNode).filter(x => x.title || x.goal),
    })).filter(step => step.title || step.goal);
}

/** Кто в открытом чате — если это разрешено черновиком и чат вообще открыт. */
function plotChatCast(draft) {
    return draft.useChatCast !== false && isChatOpen() ? chatCast() : null;
}

async function generatePlot(draft) {
    if (draft.steps.length && !await confirmAction('Составить сюжет заново? Текущие шаги будут заменены.')) return;

    await withBusy('Составляю сюжет…', async () => {
        const response = await callAI(
            plotCreatePrompt({
                brief: draft.brief, notes: draft.notes, stepCount: draft.stepCount, subCount: draft.subCount,
                characterIds: draft.characterIds, personaId: draft.personaId, chatCast: plotChatCast(draft),
            }),
            { system: plotSystemPrompt() },
        );
        const parsed = parseJsonLoose(response, 'steps');
        const steps = normalizeSteps(parsed?.steps);
        if (!steps.length) throw new Error(parseFailure(response, 'шаги сюжета'));

        pushStepsHistory(draft);
        draft.steps = steps;
        if (!draft.name && parsed?.name) draft.name = String(parsed.name).trim();
        touchDraft(draft);
        renderDraftList();
        renderMain();
        toast('success', `Сюжет готов: шагов — ${steps.length}.`);
    });
}

async function rewritePlotStep(draft, index, presetNote = null) {
    const step = draft.steps[index];
    if (!step) return;
    const note = presetNote ?? await promptAction('Что изменить в этом шаге? (можно оставить пустым — модель просто переработает)');
    if (note === null) return;

    await withBusy(`Переписываю шаг ${index + 1}…`, async () => {
        const response = await callAI(plotStepPrompt(draft, index, note, plotChatCast(draft)), { system: plotSystemPrompt() });
        const parsed = parseJsonLoose(response, 'step');
        const [rewritten] = normalizeSteps([parsed?.step]);
        if (!rewritten) throw new Error(parseFailure(response, 'шаг сюжета'));

        pushStepsHistory(draft);
        draft.steps[index] = { ...rewritten, id: step.id };
        touchDraft(draft);
        renderMain();
        toast('success', `Шаг ${index + 1} переписан.`);
    });
}

/**
 * Узел сюжета (шаг верхнего уровня или подпункт) по элементу внутри его карточки.
 * closest('.loom-plot-sub, .loom-plot-step') берёт БЛИЖАЙШУЮ — подпункт, если элемент внутри него.
 */
function plotNodeFrom(draft, element) {
    const $node = $(element).closest('.loom-plot-sub, .loom-plot-step');
    const stepIndex = Number($node.data('step'));
    const step = draft.steps[stepIndex];
    if (!step) return null;
    if (!$node.hasClass('loom-plot-sub')) return { step, stepIndex, node: step, list: draft.steps, index: stepIndex, isSub: false };
    const subIndex = Number($node.data('sub'));
    const node = step.substeps?.[subIndex];
    return node ? { step, stepIndex, node, list: step.substeps, index: subIndex, isSub: true, subIndex } : null;
}

async function generateScenarioIdeas(draft) {
    await withBusy('Придумываю идеи…', async () => {
        const response = await callAI(
            scenarioIdeasPrompt({
                brief: draft.brief, notes: draft.notes,
                characterIds: draft.characterIds, personaId: draft.personaId,
            }, SCENARIO_IDEA_COUNT),
            { system: scenarioSystemPrompt() },
        );
        const parsed = parseJsonLoose(response, 'ideas');
        const ideas = Array.isArray(parsed?.ideas) ? parsed.ideas : null;
        if (!ideas?.length) throw new Error(parseFailure(response, 'список идей'));

        // Список идей заменяется целиком, а не дополняется: это черновая подборка для
        // выбора одной, а не накопительный список — плодить идеи прошлых заходов рядом
        // с новыми только загромождало бы экран.
        draft.ideas = ideas.map(text => ({ id: uid(), text: String(text || '').trim() })).filter(i => i.text);
        if (!draft.ideas.length) throw new Error(parseFailure(response, 'список идей'));
        touchDraft(draft);

        renderDraftList();
        renderMain();
        toast('success', `Готово: ${draft.ideas.length} идей. Выберите одну — кнопка «В задумку».`);
    });
}

/**
 * Проработка сценария в полный набор пунктов — из текущей задумки (написанной руками
 * или подставленной из идеи, см. renderScenarioIdeas). Первая проработка и «Проработать
 * заново» — один и тот же путь: разница только в том, есть ли что откатывать.
 */
async function developScenario(draft) {
    await withBusy('Прорабатываю сценарий…', async () => {
        const response = await callAI(
            scenarioCreatePrompt({
                brief: draft.brief, notes: draft.notes, images: draft.images,
                characterIds: draft.characterIds, personaId: draft.personaId,
            }),
            { system: scenarioSystemPrompt(), images: await loadImages(draft.images) },
        );
        const parsed = parseJsonLoose(response, 'card');
        if (!parsed?.card) throw new Error(parseFailure(response, 'объект сценария'));

        const sections = sectionsFromResponse(parsed.card, 'scenario');
        if (!sections.length) throw new Error('В ответе модели не нашлось ни одного пункта формата.');

        if (draft.sections.length) pushHistory(draft);
        draft.sections = sections;
        draft.iteration = (draft.iteration || 0) + 1;
        touchDraft(draft);

        renderDraftList();
        renderMain();
        toast('success', 'Сценарий проработан. Оцените абзацы — и переписывайте.');
    });
}

async function rewriteScenario(draft) {
    const keepThreshold = Number(getSettings().rating_keep_threshold) || 8;
    const { approved, toRewrite } = splitApprovedSections(draft.sections, keepThreshold);
    if (!toRewrite.length) {
        return toast('info', `Все пункты уже одобрены (оценка ≥ ${keepThreshold}) — переписывать нечего.`);
    }

    await withBusy('Переписываю с учётом оценок…', async () => {
        const itemIds = toRewrite.map(s => s.id);
        const response = await callAI(scenarioRewritePrompt(draft, itemIds), {
            system: scenarioSystemPrompt(),
            images: await loadImages(draft.images),
        });
        const parsed = parseJsonLoose(response, 'card');
        if (!parsed?.card) throw new Error(parseFailure(response, 'объект сценария'));

        const rewritten = sectionsFromResponse(parsed.card, 'scenario', itemIds);
        if (!rewritten.length) throw new Error('В ответе модели не нашлось ни одного пункта формата.');

        pushHistory(draft);
        const rated = carryOverRatings(draft.history.at(-1).sections, rewritten);
        draft.sections = mergeSections('scenario', approved, rated);
        draft.iteration = (draft.iteration || 0) + 1;
        touchDraft(draft);

        renderDraftList();
        renderMain();
        toast('success', `Версия ${draft.iteration} готова. Переписано пунктов: ${rewritten.length} из ${draft.sections.length}.`);
    });
}

/** Точечная перегенерация одного пункта сценария — та же логика, что у персоны и промпта. */
async function regenerateScenarioSection(draft, sectionId) {
    const item = activeFormat('scenario').find(i => i.id === sectionId);
    if (!item) return;

    await withBusy(`Переписываю «${item.label}»…`, async () => {
        const response = await callAI(scenarioRewritePrompt(draft, [sectionId]), {
            system: scenarioSystemPrompt(),
            images: await loadImages(draft.images),
        });
        const parsed = parseJsonLoose(response, 'card');
        if (!parsed?.card) throw new Error(parseFailure(response, 'объект сценария'));

        const rewritten = sectionsFromResponse(parsed.card, 'scenario', [sectionId]);
        if (!rewritten.length) throw new Error(`Модель не вернула пункт «${item.label}».`);

        pushHistory(draft);
        const rated = carryOverRatings(draft.history.at(-1).sections, rewritten);
        const otherSections = draft.sections.filter(s => s.id !== sectionId);
        draft.sections = mergeSections('scenario', otherSections, rated);
        touchDraft(draft);

        renderMain();
        toast('success', `«${item.label}» переписан.`);
    });
}

// ─── Режим: лорбук ──────────────────────────────────────────────────────────

/**
 * Список персонажей и персон для привязки — независимо друг от друга, можно и оба
 * сразу: например, лорбук про мир, где важны факты и о герое, и о {{user}}, или
 * сценарий, который пишется именно для этой пары. Опция «не привязан» первой,
 * дальше — черновики в порядке listDrafts() (последние правки — сверху).
 *
 * Используется и лорбуком, и сценарием — второй параметр меняет только подпись
 * первого поля под контекст режима.
 */
function renderCharacterLinkSelect(draft, characterLabel = 'Персонажи, для которых пишем лорбук') {
    const characters = listDrafts().filter(d => d.mode === 'character');
    const linkedIds = new Set(draft.characterIds || []);
    const linked = characters.filter(c => linkedIds.has(c.id));
    const free = characters.filter(c => !linkedIds.has(c.id));
    const characterOptions = free.map(c => `
        <option value="${escapeHtml(c.id)}">${escapeHtml(c.name || 'Без имени')}</option>`).join('');
    const chips = linked.map(c => `
        <span class="loom-linked-char" data-id="${escapeHtml(c.id)}">
            <span class="loom-linked-char-name">${escapeHtml(c.name || 'Без имени')}</span>
            <button class="loom-linked-char-remove" title="Отвязать"><i class="fa-solid fa-xmark"></i></button>
        </span>`).join('');
    const placeholder = !characters.length ? 'Нет персонажей в LOOM'
        : free.length ? (linked.length ? '+ Ещё персонаж…' : '+ Добавить персонажа…')
            : 'Все персонажи привязаны';

    const personas = listDrafts().filter(d => d.mode === 'persona');
    const personaOptions = personas.map(p => `
        <option value="${escapeHtml(p.id)}" ${p.id === draft.personaId ? 'selected' : ''}>
            ${escapeHtml(p.name || 'Без имени')}
        </option>`).join('');

    return `
        <div class="loom-row">
            <label class="loom-field">
                <span class="loom-label">${escapeHtml(characterLabel)}</span>
                ${chips ? `<div class="loom-linked-chars">${chips}</div>` : ''}
                <select class="loom-character-link" ${free.length ? '' : 'disabled'}>
                    <option value="">${placeholder}</option>
                    ${characterOptions}
                </select>
            </label>
            <label class="loom-field">
                <span class="loom-label">Персона ({{user}})</span>
                <select class="loom-persona-link">
                    <option value="">Не привязана</option>
                    ${personaOptions}
                </select>
            </label>
        </div>
        <span class="loom-hint">Модель видит текст привязанных черновиков.</span>`;
}

/**
 * Технические поля записи Таверны (позиция вставки, приоритет, фильтр по персонажу) —
 * одни на весь лорбук, задаются здесь и применяются ко всем записям при экспорте
 * (см. exportLorebook в src/export.js). За каждую запись отдельно их не спрашиваем:
 * в реальности весь лорбук почти всегда живёт по одним правилам.
 */
function renderWiSettings(draft) {
    const atDepth = Number(draft.wiPosition) === 4;
    return `
        <div class="loom-wi-settings">
            <div class="loom-row">
                <label class="loom-field">
                    <span class="loom-label">Куда вставлять записи</span>
                    <select class="loom-wi-position">
                        <option value="0" ${!atDepth && draft.wiPosition == 0 ? 'selected' : ''}>До описания персонажа</option>
                        <option value="1" ${draft.wiPosition == 1 ? 'selected' : ''}>После описания персонажа</option>
                        <option value="4" ${atDepth ? 'selected' : ''}>На глубину чата</option>
                    </select>
                </label>
                <label class="loom-field">
                    <span class="loom-label">Приоритет: <b class="loom-wi-order-val">${escapeHtml(String(draft.wiOrder))}</b></span>
                    <input type="range" class="loom-wi-order" min="0" max="1000" step="10" value="${escapeHtml(String(draft.wiOrder))}">
                </label>
            </div>
            ${atDepth ? `
            <div class="loom-row">
                <label class="loom-field">
                    <span class="loom-label">Глубина</span>
                    <input type="number" class="loom-wi-depth" min="0" max="999" value="${escapeHtml(String(draft.wiDepth))}">
                </label>
                <label class="loom-field">
                    <span class="loom-label">Роль сообщения</span>
                    <select class="loom-wi-role">
                        <option value="0" ${draft.wiRole == 0 ? 'selected' : ''}>System</option>
                        <option value="1" ${draft.wiRole == 1 ? 'selected' : ''}>User</option>
                        <option value="2" ${draft.wiRole == 2 ? 'selected' : ''}>Assistant</option>
                    </select>
                </label>
            </div>` : ''}
            <label class="loom-check">
                <input type="checkbox" class="loom-wi-no-recursion" ${draft.wiPreventRecursion !== false ? 'checked' : ''}>
                <span>Записи не включают друг друга — сработавшая запись не тянет за собой остальные</span>
            </label>
            ${draft.characterIds?.length ? `
            <label class="loom-check">
                <input type="checkbox" class="loom-wi-filter-char" ${draft.wiFilterToCharacter ? 'checked' : ''}>
                <span>Ограничить привязанными персонажами — сработает только в их чатах</span>
            </label>` : ''}
            ${renderWiHelp()}
        </div>`;
}

/**
 * Шпаргалка по World Info Таверны. Здесь, а не в настройках расширения: вопрос
 * «что это за кружочек» возникает ровно в тот момент, когда человек смотрит на
 * эти поля. Закрыта по умолчанию, состояние помнится через data-details-key.
 * Описываем и то, чего LOOM не выставляет (векторизация, ПС/АЗ, Outlet) —
 * лорбук всё равно потом правят руками в самой Таверне.
 */
function renderWiHelp() {
    return `
        <details class="loom-wi-help" data-details-key="wi-help">
            <summary><i class="fa-solid fa-circle-question"></i> Что эти настройки значат в Таверне</summary>
            <div class="loom-wi-help-body">
                <p class="loom-wi-help-title">Статус записи — кружок слева от её названия в World Info</p>
                <ul>
                    <li><b>🔵 Constant</b> — всегда в промпте, ключи не проверяются. Это галочка
                        <b>const</b> на записи. Ест контекст постоянно, поэтому только для того,
                        что должно быть верно всегда.</li>
                    <li><b>🟢 Normal</b> — вставляется, только если в последних сообщениях нашёлся
                        ключ. Обычный режим, так уходит запись без галочки const.</li>
                    <li><b>🔗 Vectorized</b> — достаётся по смыслу, а не по ключам. Требует
                        расширения Vector Storage, без него просто не срабатывает. LOOM такие
                        записи не создаёт.</li>
                </ul>
                <p class="loom-wi-help-title">Куда вставлять — второй список</p>
                <ul>
                    <li><b>↑Перс. / ↓Перс.</b> — до или после описания персонажа. Обычный выбор.</li>
                    <li><b>↑ПС / ↓ПС</b> — до или после примеров диалогов.</li>
                    <li><b>↑АЗ / ↓АЗ</b> — до или после авторской заметки.</li>
                    <li><b>На глуб. ⚙ / 👤 / 🤖</b> — прямо в переписку, за N сообщений от конца,
                        от лица системы, пользователя или ассистента. Чем меньше глубина, тем ближе
                        к концу и тем сильнее модель это учитывает.</li>
                    <li><b>➡️ Outlet</b> — никуда не вставляется сама: текст копится в именованном
                        кармане, который вы подставляете макросом <code>{{outlet::имя}}</code>
                        там, где нужно.</li>
                </ul>
                <p class="loom-hint">LOOM выставляет первые три, остальные — в Таверне.</p>
                <p class="loom-wi-help-title">Приоритет (в Таверне — «Порядок»)</p>
                <p class="loom-hint">Чем больше число, тем дольше запись держится, когда контекст не влезает.</p>
                <p class="loom-wi-help-title">Почему запись не срабатывает, хотя ключ верный</p>
                <p class="loom-hint">Обычно дело в <b>глубине сканирования</b> (World Info → «Глубина сканирования»):
                    по умолчанию 2 — ключи ищутся только в двух последних сообщениях. Поставьте 3–5.</p>
            </div>
        </details>`;
}

/** Текст секций, каким он уходит в Таверну при экспорте (см. exportLorebook/exportCharacter/exportPersona). */
function sectionsText(sections) {
    return (sections || [])
        .map(section => section.blocks.map(b => b.text).join('\n\n'))
        .filter(text => text.trim())
        .join('\n\n');
}

/** Тот же текст записи лорбука, что уходит в Таверну при экспорте. */
function entryContentText(entry) {
    return sectionsText(entry.sections);
}

/**
 * Компактный счётчик веса в токенах активного токенайзера — ПО КЛИКУ, не на каждый
 * рендер: getTokenCountAsync ходит либо в локальный tokenizer.js, либо к провайдеру
 * (для Chat Completion), и гонять его при каждой правке абзаца было бы расточительно.
 * Значение живёт в state.weights (index.js), не в самом черновике/записи — это
 * производная величина, пересчитать которую дешевле, чем таскать в settings.json.
 *
 * @param {string} key id черновика (карточка/персона/лорбук целиком) или записи лорбука
 * @param {string} action 'weigh-draft' или 'weigh-entry' — какой обработчик дёрнуть
 */
function renderWeight(key, action) {
    const cached = state.weights.get(key);
    return `
        <span class="loom-weight">
            <button class="loom-icon-btn" data-action="${action}" title="Посчитать в токенах активного токенайзера">
                <i class="fa-solid fa-scale-balanced"></i>
            </button>
            ${cached ? `<span class="loom-weight-value">≈ ${cached.tokens.toLocaleString('ru-RU')}</span>` : ''}
        </span>`;
}

function renderLorebook(draft) {
    const hasPlan = !!draft.entries.length;
    return `
        <div class="loom-editor" data-draft="${escapeHtml(draft.id)}">
            <div class="loom-editor-head">
                ${renderBackButton()}
                <input type="text" class="loom-title-input loom-draft-name-input"
                    placeholder="Название лорбука" value="${escapeHtml(draft.name)}">
                <button class="loom-icon-btn loom-head-copy" data-action="duplicate-draft" title="Дублировать черновик">
                    <i class="fa-solid fa-copy"></i>
                </button>
                <button class="loom-icon-btn loom-danger loom-head-delete" data-action="delete-draft" title="Удалить черновик">
                    <i class="fa-solid fa-trash"></i>
                </button>
                <div class="loom-editor-actions">
                    <button class="loom-btn loom-btn-primary" data-action="plan">
                        <i class="fa-solid fa-list-check"></i> ${hasPlan ? 'Пересобрать план' : 'Составить план'}
                    </button>
                    ${renderPlanHistoryPair(draft)}
                    ${hasPlan ? '' : `
                    <button class="loom-btn loom-btn-accent" data-action="write-whole"
                        title="Составить план и сразу написать все записи, не останавливаясь на плане">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> Написать целиком
                    </button>`}
                    <button class="loom-btn loom-btn-ghost" data-action="entry-add"
                        title="${hasPlan ? 'Добавить запись' : 'Начать без плана — завести первую запись вручную'}">
                        <i class="fa-solid fa-plus"></i> Запись
                    </button>
                    ${hasPlan ? `
                    <button class="loom-btn loom-btn-accent" data-action="write-all">
                        <i class="fa-solid fa-pen-nib"></i> Написать пустые
                    </button>
                    <button class="loom-btn loom-btn-accent" data-action="rewrite-all"
                        title="Переписать все написанные записи по оценкам и комментариям">
                        <i class="fa-solid fa-arrows-rotate"></i> Все с оценками
                    </button>
                    <button class="loom-btn loom-btn-ghost" data-action="keys-all" title="Собрать regex-ключи для всех записей одним запросом">
                        <i class="fa-solid fa-key"></i> Собрать ключи
                    </button>
                    <button class="loom-btn loom-btn-ghost" data-action="export-lorebook">
                        <i class="fa-solid fa-file-import"></i> В лорбук Таверны
                    </button>
                    <button class="loom-btn loom-btn-ghost" data-action="translate-all" title="Перевести все написанные записи; ключи останутся русскими">
                        <i class="fa-solid fa-language"></i> На английский
                    </button>
                    ${renderWeight(draft.id, 'weigh-draft')}` : ''}
                </div>
            </div>

            ${renderMemo(draft)}

            ${renderImportBadge(draft)}

            <details class="loom-brief" data-details-key="brief" ${hasPlan ? '' : 'open'}>
                <summary>Описание мира</summary>
                <textarea class="loom-brief-text" rows="5"
                    placeholder="Что за мир: время, место, законы, конфликты, чем он отличается от нашего.">${escapeHtml(draft.brief)}</textarea>
                <textarea class="loom-notes-text" rows="2"
                    placeholder="Доп. требования">${escapeHtml(draft.notes)}</textarea>
                ${renderCharacterLinkSelect(draft)}
                ${renderWiSettings(draft)}
                ${renderRefs(draft, 'Референсы мира', 'refs-draft')}
            </details>

            ${hasPlan
                ? draft.entries.map((entry, index) => renderEntry(entry, index)).join('')
                : `<div class="loom-empty-note big">Опишите мир и нажмите «Составить план».</div>`}
        </div>`;
}

function renderEntry(entry, index) {
    const written = !!entry.sections.length;
    const keysHtml = entry.keys.map((key, keyIndex) => {
        const check = validateKey(key);
        return `<span class="loom-key ${isRegexKey(key) ? 'regex' : ''} ${check.ok ? '' : 'invalid'}"
                    title="${escapeHtml(check.ok ? key : check.error)}">
                    ${escapeHtml(key)}
                    <button class="loom-key-remove" data-key="${keyIndex}"><i class="fa-solid fa-xmark"></i></button>
                </span>`;
    }).join('');

    // Собранные ключи — это регулярные выражения по паре сотен символов каждое, и
    // развёрнутыми они занимали больше места, чем сама запись. Прячем под сворачиваемую
    // строку: смотреть их нужно изредка, а мешают они постоянно. Состояние помнится
    // между перерисовками через data-details-key (см. captureDetailsState).
    const finalKeysHtml = entry.finalKeys?.length
        ? `<details class="loom-final-keys" data-details-key="final-keys-${escapeHtml(entry.id)}">
               <summary>
                   <span class="loom-label">Уйдёт в лорбук</span>
                   <span class="loom-final-keys-count">${entry.finalKeys.length}</span>
               </summary>
               <div class="loom-final-keys-body">
                   ${entry.finalKeys.map(k => `<code>${escapeHtml(k)}</code>`).join('')}
               </div>
           </details>`
        : '';

    return `
        <div class="loom-entry ${written ? '' : 'empty'}" data-entry="${index}">
            <div class="loom-entry-head">
                <input type="text" class="loom-entry-title" value="${escapeHtml(entry.title)}" placeholder="Название записи">
                <label class="loom-check compact" title="Всегда в контексте, без ключей">
                    <input type="checkbox" class="loom-entry-constant" ${entry.constant ? 'checked' : ''}>
                    <span>const</span>
                </label>
                <div class="loom-entry-actions">
                    <button class="loom-btn loom-btn-small loom-btn-primary" data-action="entry-write">
                        <i class="fa-solid fa-pen-nib"></i> ${written ? 'Заново' : 'Написать'}
                    </button>
                    ${written ? `
                    <button class="loom-btn loom-btn-small loom-btn-accent" data-action="entry-rewrite">
                        <i class="fa-solid fa-arrows-rotate"></i> С оценками
                    </button>` : ''}
                    ${written || entry.history?.length || entry.future?.length ? renderEntryHistoryPair(entry) : ''}
                    ${written ? `
                    <button class="loom-btn loom-btn-small loom-btn-ghost" data-action="entry-translate" title="Перевести запись на английский">
                        <i class="fa-solid fa-language"></i> EN
                    </button>` : ''}
                    <button class="loom-btn loom-btn-small loom-btn-ghost" data-action="entry-keys" title="Собрать regex-ключи">
                        <i class="fa-solid fa-key"></i> Ключи
                    </button>
                    <button class="loom-icon-btn" data-action="entry-delete" title="Удалить запись">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>

            ${entry.seed ? `<div class="loom-entry-seed">${escapeHtml(entry.seed)}</div>` : ''}

            <div class="loom-row loom-entry-meta">
                <label class="loom-field compact">
                    <span class="loom-label">Тип записи</span>
                    <select class="loom-entry-category">
                        <option value="">Не задано</option>
                        ${LOREBOOK_CATEGORIES.map(c => `
                            <option value="${c.id}" ${c.id === entry.category ? 'selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}
                    </select>
                </label>
                <label class="loom-field compact">
                    <span class="loom-label">Слов: <b class="loom-entry-wordcount-val">${entry.wordCount}</b></span>
                    <input type="range" class="loom-entry-wordcount" min="50" max="1000" step="25" value="${entry.wordCount}">
                </label>
            </div>
            <textarea class="loom-entry-note" rows="2"
                placeholder="Что важно учесть при написании этой записи">${escapeHtml(entry.note)}</textarea>

            ${renderRefs(entry, 'Референсы записи', `refs-entry-${entry.id}`)}

            <div class="loom-keys">
                ${keysHtml}
                <form class="loom-key-form">
                    <input type="text" class="loom-key-input" placeholder="+ ключ"
                        enterkeyhint="done" autocomplete="off" autocapitalize="off" spellcheck="false">
                    <button type="submit" class="loom-key-add" title="Добавить ключ">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                </form>
            </div>
            ${finalKeysHtml}

            ${written
                ? `<div class="loom-rating-summary">
                       <span class="loom-rating-text">${escapeHtml(ratingSummary(entry.sections))}</span>
                       ${renderWeight(entry.id, 'weigh-entry')}
                   </div>
                   ${renderSections(entry.sections, `data-scope="entry" data-entry="${index}"`, `entry-${entry.id}-`)}`
                : ''}
        </div>`;
}

/**
 * Бюджет токенов под запись лорбука от целевого числа слов — та же логика, что уже
 * применена в этой сессии к переводу и сборке ключей: множитель с запасом на кириллицу
 * (токенизируется гораздо дороже латиницы) и JSON-обвязку, а не фиксированное число.
 */
function entryMaxTokens(wordCount) {
    // Русский текст — около 2.5 токена на слово, плюс JSON вокруг него. И главное: модели с размышлениями
    // (gemini-*-r, thinking) тратят на них часть лимита — при старых «слов × 4, но не меньше 600» на блок
    // в 60 слов оставалось меньше, чем нужно, и ответ обрывался на полуслове. Запас щедрый: платится
    // только то, что модель реально написала, а не лимит.
    return Math.min(8000, Math.max(2500, (Number(wordCount) || 300) * 8));
}

async function planLorebook(draft) {
    // «Пересобрать план» стирает draft.entries целиком и создаёт новые объекты записей
    // (importedUid: null у всех) — если черновик уже экспортировался в Таверну, связь
    // со старыми записями там теряется. Повторный экспорт после пересборки не обновит
    // старые записи на месте, а добавит рядом целый новый набор — старые останутся
    // сиротами в лорбуке Таверны. Предупреждаем, только если реально есть что терять.
    const hasExportedLinks = draft.entries.some(e => e.importedUid != null);
    if (hasExportedLinks) {
        const ok = await confirmAction(
            'Часть записей уже сохранена в лорбуке Таверны. Пересборка плана создаст записи заново — '
            + 'связь со старыми потеряется, и следующий экспорт добавит новый набор рядом со старым, '
            + 'а не обновит его. Продолжить?',
        );
        if (!ok) return;
    }

    await withBusy('Составляю план лорбука…', async () => {
        const count = await requestPlan(draft);
        renderDraftList();
        renderMain();
        toast('success', `План на ${count} записей готов.`);
    });
}

/**
 * Сам запрос плана — без подтверждений, статусов и тостов: тем же шагом начинается
 * «Написать целиком», и дублировать там обвязку не хочется.
 * @returns {Promise<number>} сколько записей в новом плане
 */
async function requestPlan(draft) {
    const response = await callAI(
        lorebookPlanPrompt({
            brief: draft.brief,
            characterIds: draft.characterIds, personaId: draft.personaId, notes: draft.notes,
        }),
        { system: lorebookSystemPrompt() },
    );
    const parsed = parseJsonLoose(response, 'entries');
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : null;
    if (!entries?.length) throw new Error(parseFailure(response, 'список записей'));

    // Имя говорящего (персонаж, персона) как ключ срабатывает на КАЖДОМ сообщении: Таверна
    // подставляет его перед текстом. Модель про это знает (speakerNameRule), но страхуемся.
    const banned = new Set(speakerNames(draft.characterIds, draft.personaId)
        .flatMap(name => [name, ...name.split(/\s+/)]).map(n => n.toLowerCase()).filter(n => n.length > 1));
    let dropped = 0;
    for (const item of entries) {
        if (!Array.isArray(item?.keys)) continue;
        const before = item.keys.length;
        item.keys = item.keys.filter(k => !banned.has(String(k || '').trim().toLowerCase()));
        dropped += before - item.keys.length;
    }
    if (dropped) toast('info', `Убрано ключей с именем персонажа или персоны: ${dropped} — такой ключ срабатывал бы на каждом сообщении.`);

    // План пересобирается целиком: смешивать старые записи с новыми нельзя,
    // модель строит их как связный набор, а не как независимые куски.
    pushEntriesHistory(draft);
    draft.entries = [];
    entries.forEach(item => createEntry(draft, item));
    touchDraft(draft);
    return draft.entries.length;
}

/**
 * Пишет все ещё пустые записи черновика. Без withBusy и итогового тоста — вызывается
 * и кнопкой «Написать пустые», и вторым шагом «Написать целиком».
 * @returns {Promise<{written: number, pending: number}>}
 */
async function writePendingEntries(draft) {
    const pending = draft.entries.filter(e => !e.sections.length);
    if (!pending.length) return { written: 0, pending: 0 };

    // Записи со своими картинками не смешиваем в общий запрос — у них
    // персональный контекст референса (см. writeEntriesBatch)
    const withImages = pending.filter(e => e.images?.length);
    const batchable = pending.filter(e => !e.images?.length);

    let written = 0;
    if (batchable.length) {
        setStatus(`Пишу записи (${batchable.length})…`);
        written += await writeEntriesBatch(draft, batchable);
        touchDraft(draft);
        renderMain();
    }
    for (let i = 0; i < withImages.length; i++) {
        setStatus(`Пишу записи с картинками (${i + 1}/${withImages.length})…`);
        await writeEntry(draft, withImages[i], { silent: true });
        written++;
    }
    return { written, pending: pending.length };
}

/**
 * План и текст всех записей одним заходом — для случая, когда план как отдельный шаг
 * не нужен и хочется сразу получить готовый лорбук. Промежуточный рендер после плана
 * оставлен намеренно: список записей появляется сразу, и видно, что именно пишется.
 */
async function writeWholeLorebook(draft) {
    await withBusy('Составляю план лорбука…', async () => {
        const planned = await requestPlan(draft);
        renderDraftList();
        renderMain();

        const { written, pending } = await writePendingEntries(draft);
        renderMain();
        toast('success', `Лорбук готов: план на ${planned} записей, написано ${written} из ${pending}.`);
    });
}

async function writeEntry(draft, entry, { silent = false } = {}) {
    const siblings = draft.entries.filter(e => e !== entry).map(e => e.title);
    // Запись видит и свои референсы, и общие по миру
    const refs = [...(entry.images || []), ...(draft.images || [])];
    const response = await callAI(
        lorebookEntryPrompt({
            title: entry.title, category: entry.category, seed: entry.seed, note: entry.note,
            wordCount: entry.wordCount, brief: draft.brief, siblings, images: refs,
            characterIds: draft.characterIds, personaId: draft.personaId, notes: draft.notes,
        }),
        { system: lorebookSystemPrompt(), images: await loadImages(refs), maxTokens: entryMaxTokens(entry.wordCount) },
    );
    const parsed = parseJsonLoose(response, 'entry');
    if (!parsed?.entry) throw new Error(`Запись «${entry.title}»: ${parseFailure(response, 'объект записи')}`);

    const sections = sectionsFromResponse(parsed.entry, 'lorebook');
    if (!sections.length) throw new Error(`Запись «${entry.title}»: в ответе нет ни одного пункта формата.`);

    if (entry.sections.length) pushHistory(entry);
    entry.sections = sections;
    touchDraft(draft);
    if (!silent) { renderMain(); toast('success', `Запись «${entry.title}» написана.`); }
}

/**
 * Пишет НЕСКОЛЬКО записей лорбука одним запросом — см. lorebookEntriesBatchPrompt.
 * Записи со своими картинками сюда не попадают: их пишет writeEntry по одной (вызывающий
 * код в 'write-all' сам делит записи на «пакетные» и «с картинками»).
 *
 * @param {object} draft
 * @param {object[]} entries записи без картинок, которые нужно написать
 * @returns {Promise<number>} сколько записей реально получили текст
 */
async function writeEntriesBatch(draft, entries) {
    const siblings = draft.entries.map(e => e.title);
    const payload = entries.map(e => ({
        id: e.id, title: e.title, category: e.category, seed: e.seed, note: e.note, wordCount: e.wordCount,
    }));

    // Сумма индивидуальных бюджетов по каждой записи — раньше был плоский расчёт
    // на глазок, теперь у записей может быть очень разная целевая длина (50 или 1000 слов).
    const maxTokens = Math.min(16000, entries.reduce((sum, e) => sum + entryMaxTokens(e.wordCount), 0));

    const response = await callAI(
        lorebookEntriesBatchPrompt({
            entries: payload, brief: draft.brief, siblings, characterIds: draft.characterIds,
            personaId: draft.personaId, notes: draft.notes, images: draft.images,
        }),
        { system: lorebookSystemPrompt(), maxTokens, images: await loadImages(draft.images) },
    );
    const parsed = parseJsonLoose(response, 'entries');
    if (!parsed?.entries) throw new Error(parseFailure(response, 'записи'));

    let written = 0;
    for (const entry of entries) {
        const result = parsed.entries[entry.id];
        if (!result) continue;
        const sections = sectionsFromResponse(result, 'lorebook');
        if (!sections.length) continue;
        if (entry.sections.length) pushHistory(entry);
        entry.sections = sections;
        written++;
    }
    return written;
}

/**
 * Перезапись одной записи по оценкам и комментариям — без withBusy, рендера и тостов,
 * чтобы тем же кодом мог пройтись пакетный прогон по всем записям.
 *
 * @returns {Promise<number|null>} сколько пунктов переписано; null — переписывать нечего
 *   (все пункты уже одобрены), это не ошибка
 */
async function rewriteEntryCore(draft, entry) {
    const keepThreshold = Number(getSettings().rating_keep_threshold) || 8;
    // Записи, импортированные из лорбука Таверны, содержат общий пункт «imported»,
    // которого в формате LOOM нет, — его сюда не пускаем, чтобы не потерять при слиянии
    const knownIds = new Set(activeFormat('lorebook').map(item => item.id));
    const knownSections = entry.sections.filter(s => knownIds.has(s.id));
    const passthrough = entry.sections.filter(s => !knownIds.has(s.id));

    const { approved, toRewrite } = splitApprovedSections(knownSections, keepThreshold);
    if (!toRewrite.length) return null;

    const itemIds = toRewrite.map(s => s.id);
    const response = await callAI(lorebookRewritePrompt(draft, entry, itemIds), {
        system: lorebookSystemPrompt(),
        // Запись видит и свои референсы, и общие по миру
        images: await loadImages([...(entry.images || []), ...(draft.images || [])]),
        maxTokens: entryMaxTokens(entry.wordCount),
    });
    const parsed = parseJsonLoose(response, 'entry');
    if (!parsed?.entry) throw new Error(parseFailure(response, 'объект записи'));

    const rewritten = sectionsFromResponse(parsed.entry, 'lorebook', itemIds);
    if (!rewritten.length) throw new Error('В ответе нет ни одного пункта формата.');

    pushHistory(entry);
    const rated = carryOverRatings(entry.history.at(-1).sections, rewritten);
    entry.sections = mergeSections('lorebook', [...approved, ...passthrough], rated);
    touchDraft(draft);
    return rewritten.length;
}

async function rewriteEntry(draft, entry) {
    const keepThreshold = Number(getSettings().rating_keep_threshold) || 8;
    await withBusy(`Переписываю «${entry.title}»…`, async () => {
        const count = await rewriteEntryCore(draft, entry);
        if (count == null) {
            return toast('info', `«${entry.title}»: все пункты уже одобрены (оценка ≥ ${keepThreshold}) — переписывать нечего.`);
        }
        renderMain();
        toast('success', `«${entry.title}» переписана. Переписано пунктов: ${count} из ${entry.sections.length}.`);
    });
}

/**
 * «С оценками» сразу по всем написанным записям. Пакетным запросом это не сделать:
 * у каждой записи свой набор неодобренных пунктов и свои комментарии, промпт строится
 * под конкретную запись — поэтому идём по одной, показывая прогресс.
 *
 * Сбой на одной записи не роняет весь прогон: остальные всё равно нужно переписать,
 * а список неудачных уходит в итоговый тост. Остановка кнопкой «Стоп» — другое дело,
 * её пробрасываем наружу и прекращаем обход.
 */
async function rewriteAllEntries(draft) {
    const keepThreshold = Number(getSettings().rating_keep_threshold) || 8;
    const written = draft.entries.filter(entry => entry.sections.length);
    if (!written.length) return toast('info', 'Ни одной написанной записи.');

    await withBusy(`Переписываю записи (${written.length})…`, async () => {
        let done = 0;
        let approved = 0;
        const failed = [];

        for (let i = 0; i < written.length; i++) {
            const entry = written[i];
            setStatus(`Переписываю «${entry.title}» (${i + 1}/${written.length})…`);
            try {
                const count = await rewriteEntryCore(draft, entry);
                if (count == null) approved++; else done++;
            } catch (error) {
                if (error?.aborted) throw error;
                console.error(LOG, `перезапись «${entry.title}»`, error);
                failed.push(entry.title);
            }
        }

        renderMain();
        if (!done && !failed.length) {
            return toast('info', `Все пункты во всех записях уже одобрены (оценка ≥ ${keepThreshold}) — переписывать нечего.`);
        }
        const tail = [
            approved ? `уже одобрено — ${approved}` : '',
            failed.length ? `не удалось — ${failed.join(', ')}` : '',
        ].filter(Boolean).join('; ');
        toast(failed.length ? 'info' : 'success', `Переписано записей: ${done} из ${written.length}${tail ? `. ${tail}` : '.'}`);
    });
}

/** Точечная перегенерация одного пункта записи — та же кнопка, что и у карточки. */
async function regenerateEntrySection(draft, entry, sectionId) {
    const item = activeFormat('lorebook').find(i => i.id === sectionId);
    if (!item) return;

    await withBusy(`Переписываю «${item.label}»…`, async () => {
        const response = await callAI(lorebookRewritePrompt(draft, entry, [sectionId]), {
            system: lorebookSystemPrompt(),
            images: await loadImages([...(entry.images || []), ...(draft.images || [])]),
            maxTokens: entryMaxTokens(entry.wordCount),
        });
        const parsed = parseJsonLoose(response, 'entry');
        if (!parsed?.entry) throw new Error(parseFailure(response, 'объект записи'));

        const rewritten = sectionsFromResponse(parsed.entry, 'lorebook', [sectionId]);
        if (!rewritten.length) throw new Error(`Модель не вернула пункт «${item.label}».`);

        pushHistory(entry);
        const rated = carryOverRatings(entry.history.at(-1).sections, rewritten);
        const otherSections = entry.sections.filter(s => s.id !== sectionId);
        entry.sections = mergeSections('lorebook', otherSections, rated);
        touchDraft(draft);

        renderMain();
        toast('success', `«${item.label}» переписан.`);
    });
}

/** Ключевые слова → готовые regex-ключи для лорбука. */
async function buildEntryKeys(draft, entry) {
    await withBusy(`Собираю ключи для «${entry.title}»…`, async () => {
        const plain = entry.keys.filter(key => !isRegexKey(key));
        if (!entry.keys.length) throw new Error('У записи нет ни одного ключа.');

        const settings = getSettings();
        // Без regex собирать нечего — просто фиксируем ключи как есть
        const regexes = (settings.lorebook_regex_keys && plain.length) ? await buildKeyRegexes(plain) : {};
        entry.finalKeys = compileKeys(entry.keys, regexes);
        touchDraft(draft);
        renderMain();
        toast('success', `Ключи собраны: ${entry.finalKeys.length}.`);
    });
}

/**
 * Ключи для ВСЕХ записей лорбука одним запросом.
 *
 * Кнопка «Ключи» у записи дёргает модель по одной записи — при плане на восемь
 * записей это восемь запросов только ради ключей. Здесь один запрос на объединённый
 * список слов по всему лорбуку: совпадающие ключи (одно и то же имя в двух записях)
 * получают один и тот же regex, что как раз и нужно.
 */
async function buildAllEntryKeys(draft) {
    const targets = draft.entries.filter(entry => entry.keys.length);
    if (!targets.length) throw new Error('Ни у одной записи нет ключей.');

    await withBusy(`Собираю ключи для всех записей (${targets.length})…`, async () => {
        const settings = getSettings();
        const plainSet = new Set();
        for (const entry of targets) {
            for (const key of entry.keys) if (!isRegexKey(key)) plainSet.add(key);
        }

        const regexes = (settings.lorebook_regex_keys && plainSet.size)
            ? await buildKeyRegexes([...plainSet])
            : {};

        for (const entry of targets) entry.finalKeys = compileKeys(entry.keys, regexes);
        touchDraft(draft);
        renderMain();
        toast('success', `Ключи собраны для записей: ${targets.length}.`);
    });
}

// ─── Пресет ─────────────────────────────────────────────────────────────────
//
// Механика — план блоков, потом текст каждого по отдельности/пакетом, переписывание
// по оценкам, история версий — та же, что у лорбука выше: и там, и тут открытый список
// именованных записей со своими секциями. Дублируется, а не обобщается через параметр
// kind, по тому же принципу, что уже разводит generateCharacter/generatePersona/
// generatePrompt/generateScenarioIdeas по отдельным функциям: у каждого режима свой
// промпт, своя форма ответа и свой набор полей записи (лорбуку нужны ключи и категория,
// пресету — нет), и общий движок на двоих быстро оброс бы веткой if (kind === …) на
// каждом шагу. Разошлось только НАЗНАЧЕНИЕ функций-строителей промпта (lorebook*/preset*
// в src/prompts.js) и системный промпт — остальные утилиты (sectionsFromResponse,
// mergeSections, activeFormat, entryMaxTokens) уже параметризованы по kind и одинаково
// подходят обоим.

async function planPreset(draft) {
    // Та же ловушка, что и у «Пересобрать план» лорбука: пересборка заводит блоки
    // заново (importedUid: null), и уже экспортированные в Таверну сироты остаются там,
    // пока следующий экспорт не добавит рядом новый набор вместо обновления старого.
    const hasExportedLinks = draft.entries.some(e => e.importedUid != null);
    if (hasExportedLinks) {
        const ok = await confirmAction(
            'Часть блоков уже сохранена в пресете Таверны. Пересборка плана создаст блоки заново — '
            + 'связь со старыми потеряется, и следующий экспорт добавит новый набор рядом со старым, '
            + 'а не обновит его. Продолжить?',
        );
        if (!ok) return;
    }

    await withBusy('Составляю план пресета…', async () => {
        const count = await requestPresetPlan(draft);
        renderDraftList();
        renderMain();
        toast('success', `План на ${count} блоков готов.`);
    });
}

/** См. requestPlan (лорбук) — та же роль, без обвязки, чтобы использовать и в «Написать целиком». */
async function requestPresetPlan(draft) {
    const response = await callAI(
        presetPlanPrompt({ brief: draft.brief, notes: draft.notes }),
        { system: presetSystemPrompt() },
    );
    const parsed = parseJsonLoose(response, 'entries');
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : null;
    if (!entries?.length) throw new Error(parseFailure(response, 'список блоков'));

    pushEntriesHistory(draft);
    draft.entries = [];
    entries.forEach(item => createEntry(draft, item));
    touchDraft(draft);
    return draft.entries.length;
}

/** См. writePendingEntries (лорбук). @returns {Promise<{written: number, pending: number}>} */
async function writePendingPresetEntries(draft) {
    const pending = draft.entries.filter(e => !e.sections.length);
    if (!pending.length) return { written: 0, pending: 0 };

    const withImages = pending.filter(e => e.images?.length);
    const batchable = pending.filter(e => !e.images?.length);

    let written = 0;
    if (batchable.length) {
        setStatus(`Пишу блоки (${batchable.length})…`);
        written += await writePresetEntriesBatch(draft, batchable);
        touchDraft(draft);
        renderMain();
    }
    for (let i = 0; i < withImages.length; i++) {
        setStatus(`Пишу блоки с картинками (${i + 1}/${withImages.length})…`);
        await writePresetEntry(draft, withImages[i], { silent: true });
        written++;
    }
    return { written, pending: pending.length };
}

/** См. writeWholeLorebook. */
async function writeWholePreset(draft) {
    await withBusy('Составляю план пресета…', async () => {
        const planned = await requestPresetPlan(draft);
        renderDraftList();
        renderMain();

        const { written, pending } = await writePendingPresetEntries(draft);
        renderMain();
        toast('success', `Пресет готов: план на ${planned} блоков, написано ${written} из ${pending}.`);
    });
}

/** См. writeEntry (лорбук). */
async function writePresetEntry(draft, entry, { silent = false } = {}) {
    const siblings = draft.entries.filter(e => e !== entry).map(e => e.title);
    const response = await callAI(
        presetEntryPrompt({
            title: entry.title, seed: entry.seed, note: entry.note, brief: draft.brief, siblings,
            notes: draft.notes, wordCount: entry.wordCount,
            role: entry.role, injectionPosition: entry.injectionPosition, injectionDepth: entry.injectionDepth,
        }),
        { system: presetSystemPrompt(), maxTokens: entryMaxTokens(entry.wordCount) },
    );
    const parsed = parseJsonLoose(response, 'entry');
    if (!parsed?.entry) throw new Error(`Блок «${entry.title}»: ${parseFailure(response, 'объект блока')}`);

    const sections = sectionsFromResponse(parsed.entry, 'preset');
    if (!sections.length) throw new Error(`Блок «${entry.title}»: в ответе нет ни одного пункта формата.`);

    if (entry.sections.length) pushHistory(entry);
    entry.sections = sections;
    touchDraft(draft);
    if (!silent) { renderMain(); toast('success', `Блок «${entry.title}» написан.`); }
}

/** См. writeEntriesBatch (лорбук). @returns {Promise<number>} сколько блоков получили текст */
async function writePresetEntriesBatch(draft, entries) {
    const siblings = draft.entries.map(e => e.title);
    const payload = entries.map(e => ({
        id: e.id, title: e.title, seed: e.seed, note: e.note, wordCount: e.wordCount,
        role: e.role, injectionPosition: e.injectionPosition, injectionDepth: e.injectionDepth,
    }));
    const maxTokens = Math.min(16000, entries.reduce((sum, e) => sum + entryMaxTokens(e.wordCount), 0));

    const response = await callAI(
        presetEntriesBatchPrompt({ entries: payload, brief: draft.brief, siblings, notes: draft.notes }),
        { system: presetSystemPrompt(), maxTokens },
    );
    const parsed = parseJsonLoose(response, 'entries');
    if (!parsed?.entries) throw new Error(parseFailure(response, 'блоки'));

    let written = 0;
    for (const entry of entries) {
        const result = parsed.entries[entry.id];
        if (!result) continue;
        const sections = sectionsFromResponse(result, 'preset');
        if (!sections.length) continue;
        if (entry.sections.length) pushHistory(entry);
        entry.sections = sections;
        written++;
    }
    return written;
}

/** См. rewriteEntryCore (лорбук). @returns {Promise<number|null>} */
async function rewritePresetEntryCore(draft, entry) {
    const keepThreshold = Number(getSettings().rating_keep_threshold) || 8;
    const knownIds = new Set(activeFormat('preset').map(item => item.id));
    const knownSections = entry.sections.filter(s => knownIds.has(s.id));
    const passthrough = entry.sections.filter(s => !knownIds.has(s.id));

    const { approved, toRewrite } = splitApprovedSections(knownSections, keepThreshold);
    if (!toRewrite.length) return null;

    const itemIds = toRewrite.map(s => s.id);
    const response = await callAI(presetRewritePrompt(draft, entry, itemIds), {
        system: presetSystemPrompt(),
        maxTokens: entryMaxTokens(entry.wordCount),
    });
    const parsed = parseJsonLoose(response, 'entry');
    if (!parsed?.entry) throw new Error(parseFailure(response, 'объект блока'));

    const rewritten = sectionsFromResponse(parsed.entry, 'preset', itemIds);
    if (!rewritten.length) throw new Error('В ответе нет ни одного пункта формата.');

    pushHistory(entry);
    const rated = carryOverRatings(entry.history.at(-1).sections, rewritten);
    entry.sections = mergeSections('preset', [...approved, ...passthrough], rated);
    touchDraft(draft);
    return rewritten.length;
}

async function rewritePresetEntry(draft, entry) {
    const keepThreshold = Number(getSettings().rating_keep_threshold) || 8;
    await withBusy(`Переписываю «${entry.title}»…`, async () => {
        const count = await rewritePresetEntryCore(draft, entry);
        if (count == null) {
            return toast('info', `«${entry.title}»: все пункты уже одобрены (оценка ≥ ${keepThreshold}) — переписывать нечего.`);
        }
        renderMain();
        toast('success', `«${entry.title}» переписан. Переписано пунктов: ${count} из ${entry.sections.length}.`);
    });
}

/** См. rewriteAllEntries (лорбук). */
async function rewriteAllPresetEntries(draft) {
    const keepThreshold = Number(getSettings().rating_keep_threshold) || 8;
    const written = draft.entries.filter(entry => entry.sections.length);
    if (!written.length) return toast('info', 'Ни одного написанного блока.');

    await withBusy(`Переписываю блоки (${written.length})…`, async () => {
        let done = 0;
        let approved = 0;
        const failed = [];

        for (let i = 0; i < written.length; i++) {
            const entry = written[i];
            setStatus(`Переписываю «${entry.title}» (${i + 1}/${written.length})…`);
            try {
                const count = await rewritePresetEntryCore(draft, entry);
                if (count == null) approved++; else done++;
            } catch (error) {
                if (error?.aborted) throw error;
                console.error(LOG, `перезапись «${entry.title}»`, error);
                failed.push(entry.title);
            }
        }

        renderMain();
        if (!done && !failed.length) {
            return toast('info', `Все пункты во всех блоках уже одобрены (оценка ≥ ${keepThreshold}) — переписывать нечего.`);
        }
        const tail = [
            approved ? `уже одобрено — ${approved}` : '',
            failed.length ? `не удалось — ${failed.join(', ')}` : '',
        ].filter(Boolean).join('; ');
        toast(failed.length ? 'info' : 'success', `Переписано блоков: ${done} из ${written.length}${tail ? `. ${tail}` : '.'}`);
    });
}

/** Точечная перегенерация одного пункта блока — см. regenerateEntrySection (лорбук). */
async function regeneratePresetEntrySection(draft, entry, sectionId) {
    const item = activeFormat('preset').find(i => i.id === sectionId);
    if (!item) return;

    await withBusy(`Переписываю «${item.label}»…`, async () => {
        const response = await callAI(presetRewritePrompt(draft, entry, [sectionId]), {
            system: presetSystemPrompt(),
            maxTokens: entryMaxTokens(entry.wordCount),
        });
        const parsed = parseJsonLoose(response, 'entry');
        if (!parsed?.entry) throw new Error(parseFailure(response, 'объект блока'));

        const rewritten = sectionsFromResponse(parsed.entry, 'preset', [sectionId]);
        if (!rewritten.length) throw new Error(`Модель не вернула пункт «${item.label}».`);

        pushHistory(entry);
        const rated = carryOverRatings(entry.history.at(-1).sections, rewritten);
        const otherSections = entry.sections.filter(s => s.id !== sectionId);
        entry.sections = mergeSections('preset', otherSections, rated);
        touchDraft(draft);

        renderMain();
        toast('success', `«${item.label}» переписан.`);
    });
}

function renderPreset(draft) {
    const hasPlan = !!draft.entries.length;
    return `
        <div class="loom-editor" data-draft="${escapeHtml(draft.id)}">
            <div class="loom-editor-head">
                ${renderBackButton()}
                <input type="text" class="loom-title-input loom-draft-name-input"
                    placeholder="Имя пресета в Таверне" value="${escapeHtml(draft.name)}">
                <button class="loom-icon-btn loom-head-copy" data-action="duplicate-draft" title="Дублировать черновик">
                    <i class="fa-solid fa-copy"></i>
                </button>
                <button class="loom-icon-btn loom-danger loom-head-delete" data-action="delete-draft" title="Удалить черновик">
                    <i class="fa-solid fa-trash"></i>
                </button>
                <div class="loom-editor-actions">
                    <button class="loom-btn loom-btn-primary" data-action="preset-plan">
                        <i class="fa-solid fa-list-check"></i> ${hasPlan ? 'Пересобрать план' : 'Составить план'}
                    </button>
                    ${renderPlanHistoryPair(draft)}
                    ${hasPlan ? '' : `
                    <button class="loom-btn loom-btn-accent" data-action="preset-write-whole"
                        title="Составить план и сразу написать все блоки, не останавливаясь на плане">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> Написать целиком
                    </button>`}
                    <button class="loom-btn loom-btn-ghost" data-action="entry-add"
                        title="${hasPlan ? 'Добавить блок' : 'Начать без плана — завести первый блок вручную'}">
                        <i class="fa-solid fa-plus"></i> Блок
                    </button>
                    ${hasPlan ? `
                    <button class="loom-btn loom-btn-accent" data-action="preset-write-all">
                        <i class="fa-solid fa-pen-nib"></i> Написать пустые
                    </button>
                    <button class="loom-btn loom-btn-accent" data-action="preset-rewrite-all"
                        title="Переписать все написанные блоки по оценкам и комментариям">
                        <i class="fa-solid fa-arrows-rotate"></i> Все с оценками
                    </button>
                    <button class="loom-btn loom-btn-ghost" data-action="export-preset"
                        title="Добавит блоки в пресет Таверны — выключенными, включаете нужные сами">
                        <i class="fa-solid fa-file-import"></i> В пресет Таверны
                    </button>
                    <button class="loom-btn loom-btn-ghost" data-action="translate-all" title="Перевести все написанные блоки">
                        <i class="fa-solid fa-language"></i> На английский
                    </button>
                    ${renderWeight(draft.id, 'weigh-draft')}` : ''}
                </div>
            </div>

            ${renderMemo(draft)}

            ${renderImportBadge(draft)}

            <details class="loom-brief" data-details-key="brief" ${hasPlan ? '' : 'open'}>
                <summary>Для чего этот пресет</summary>
                <textarea class="loom-brief-text" rows="5"
                    placeholder="Что должны делать блоки: цензура, формат ответа, язык, инструкции по картинкам — что угодно.">${escapeHtml(draft.brief)}</textarea>
                <textarea class="loom-notes-text" rows="2"
                    placeholder="Доп. требования">${escapeHtml(draft.notes)}</textarea>
            </details>

            ${renderPresetReview(draft)}

            ${hasPlan
                ? draft.entries.map((entry, index) => renderPresetEntry(entry, index)).join('')
                : `<div class="loom-empty-note big">Опишите пресет и нажмите «Составить план».</div>`}
        </div>`;
}

/**
 * Карточка одного блока пресета — заметно проще loom-entry лорбука: у блока нет ни
 * ключей (в промпт ничего не «срабатывает» по словам чата — блок либо включён в
 * Prompt Manager, либо нет), ни категории, ни const, ни картинок-референсов (блок —
 * это инструкция про поведение модели, а не описание чего-то ВИДИМОГО — картинке
 * тут просто нечего было бы показать). Слов-ползунок остался: «сколько текста» —
 * осмысленный контрол и для инструкции, не только для факта о мире.
 */
function renderPresetEntry(entry, index) {
    const written = !!entry.sections.length;
    return `
        <div class="loom-entry ${written ? '' : 'empty'}" data-entry="${index}">
            <div class="loom-entry-head">
                <input type="text" class="loom-entry-title" value="${escapeHtml(entry.title)}" placeholder="Название блока">
                <div class="loom-entry-actions">
                    <button class="loom-btn loom-btn-small loom-btn-primary" data-action="preset-write">
                        <i class="fa-solid fa-pen-nib"></i> ${written ? 'Заново' : 'Написать'}
                    </button>
                    ${written ? `
                    <button class="loom-btn loom-btn-small loom-btn-accent" data-action="preset-rewrite">
                        <i class="fa-solid fa-arrows-rotate"></i> С оценками
                    </button>` : ''}
                    ${written || entry.history?.length || entry.future?.length ? renderEntryHistoryPair(entry) : ''}
                    ${written ? `
                    <button class="loom-btn loom-btn-small loom-btn-ghost" data-action="entry-translate" title="Перевести блок на английский">
                        <i class="fa-solid fa-language"></i> EN
                    </button>` : ''}
                    <button class="loom-icon-btn" data-action="entry-delete" title="Удалить блок">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>

            ${entry.seed ? `<div class="loom-entry-seed">${escapeHtml(entry.seed)}</div>` : ''}

            <div class="loom-row loom-entry-meta">
                <label class="loom-field compact">
                    <span class="loom-label">Роль</span>
                    <select class="loom-preset-role loom-entry-category">
                        ${[['system', 'System'], ['user', 'User'], ['assistant', 'AI Assistant']].map(([value, label]) =>
                            `<option value="${value}" ${entry.role === value ? 'selected' : ''}>${label}</option>`).join('')}
                    </select>
                </label>
                <label class="loom-field compact">
                    <span class="loom-label">Куда</span>
                    <select class="loom-preset-position loom-entry-category">
                        <option value="0" ${entry.injectionPosition === 1 ? '' : 'selected'}>На своё место в списке</option>
                        <option value="1" ${entry.injectionPosition === 1 ? 'selected' : ''}>В чат, на глубину</option>
                    </select>
                </label>
                ${entry.injectionPosition === 1 ? `
                <label class="loom-field compact loom-preset-depth-field">
                    <span class="loom-label">Глубина</span>
                    <input type="number" class="loom-preset-depth" min="0" max="999" value="${entry.injectionDepth}">
                </label>` : ''}
                <label class="loom-field compact">
                    <span class="loom-label">Слов: <b class="loom-entry-wordcount-val">${entry.wordCount}</b></span>
                    <input type="range" class="loom-entry-wordcount" min="20" max="2000" step="20" value="${entry.wordCount}">
                </label>
            </div>
            <textarea class="loom-entry-note" rows="2"
                placeholder="Что важно учесть при написании этого блока">${escapeHtml(entry.note)}</textarea>

            ${written
                ? `<div class="loom-rating-summary">
                       <span class="loom-rating-text">${escapeHtml(ratingSummary(entry.sections))}</span>
                       ${renderWeight(entry.id, 'weigh-entry')}
                   </div>
                   ${renderSections(entry.sections, `data-scope="entry" data-entry="${index}"`, `entry-${entry.id}-`)}`
                : ''}
        </div>`;
}

// ─── Разбор пресета (внутри режима «Пресет») ─────────────────────────

/**
 * Источник пресета для разбора: этот же черновик, пресет Таверны, другой черновик
 * LOOM или файл JSON. review.source хранит только ссылку, не копию пресета — см.
 * resolveReviewDigest, который перечитывает источник при каждой генерации.
 */
function renderReviewSourcePicker(draft) {
    const source = draft.review.source;
    const kind = source?.kind || 'self';

    const valueField = kind === 'self'
        ? ''
        : kind === 'tavern'
            ? `<select class="loom-review-source-value loom-entry-category" data-kind="tavern">
                   <option value="">— выбрать пресет —</option>
                   ${listTavernPresets().map(name => `
                       <option value="${escapeHtml(name)}" ${source?.presetName === name ? 'selected' : ''}>
                           ${escapeHtml(name)}
                       </option>`).join('')}
               </select>`
            : kind === 'draft'
                ? `<select class="loom-review-source-value loom-entry-category" data-kind="draft">
                       <option value="">— выбрать черновик —</option>
                       ${listDrafts().filter(d => d.mode === 'preset' && d.id !== draft.id).map(d => `
                           <option value="${escapeHtml(d.id)}" ${source?.draftId === d.id ? 'selected' : ''}>
                               ${escapeHtml(d.name || 'Без имени')}
                           </option>`).join('')}
                   </select>`
                : `<label class="loom-btn loom-btn-ghost loom-btn-small loom-file-btn">
                       <i class="fa-solid fa-file-import"></i> ${source?.digestId ? 'Заменить файл' : 'Выбрать файл'}
                       <input type="file" class="loom-review-source-file" accept="application/json,.json">
                   </label>`;

    const hint = kind === 'self' ? ''
        : source?.label ? `Выбрано: ${escapeHtml(source.label)}` : 'Пресет ещё не выбран.';

    return `
        <div class="loom-review-source">
            <div class="loom-row">
                <label class="loom-field compact">
                    <span class="loom-label">Что разбираем</span>
                    <select class="loom-review-source-kind loom-entry-category">
                        <option value="self" ${kind === 'self' ? 'selected' : ''}>Этот черновик</option>
                        <option value="tavern" ${kind === 'tavern' ? 'selected' : ''}>Пресет из Таверны</option>
                        <option value="draft" ${kind === 'draft' ? 'selected' : ''}>Другой черновик LOOM</option>
                        <option value="file" ${kind === 'file' ? 'selected' : ''}>Файл JSON</option>
                    </select>
                </label>
                ${valueField ? `
                <label class="loom-field compact">
                    ${valueField}
                </label>` : ''}
            </div>
            ${hint ? `<span class="loom-hint">${hint}</span>` : ''}
        </div>`;
}

/** Свёрнутая плашка «Анализ» в редакторе пресета. */
function renderPresetReview(draft) {
    const review = draft.review;
    const hasReview = !!review.sections.length;
    return `
        <details class="loom-brief loom-review" data-details-key="review">
            <summary><i class="fa-solid fa-magnifying-glass-chart"></i> Анализ пресета</summary>
            ${renderReviewSourcePicker(draft)}
            <textarea class="loom-review-brief" rows="3"
                placeholder="Что не так с ответами модели? Можно коротко — «сухо», «текст как у бота», «скатывается в одно и то же». Пример ответа только поможет.">${escapeHtml(review.brief)}</textarea>
            <textarea class="loom-review-notes" rows="2"
                placeholder="Что уже пробовали, что менять не хочется.">${escapeHtml(review.notes)}</textarea>
            <div class="loom-editor-actions loom-review-actions">
                <button class="loom-btn loom-btn-primary loom-btn-small" data-action="review-generate">
                    <i class="fa-solid fa-magnifying-glass-chart"></i> ${hasReview ? 'Разобрать заново' : 'Разобрать'}
                </button>
                ${hasReview ? `
                <button class="loom-btn loom-btn-accent loom-btn-small" data-action="review-rewrite">
                    <i class="fa-solid fa-arrows-rotate"></i> С оценками
                </button>
                <button class="loom-btn loom-btn-ghost loom-btn-small" data-action="review-copy" title="Скопировать текст разбора">
                    <i class="fa-solid fa-copy"></i> Копировать
                </button>
                <div class="loom-btn-group">
                    <button class="loom-btn loom-btn-ghost loom-btn-small" data-action="review-undo"
                        ${review.history.length ? '' : 'disabled'} title="Вернуться к предыдущей версии разбора">
                        <i class="fa-solid fa-clock-rotate-left"></i> Откатить
                    </button>
                    <button class="loom-btn loom-btn-ghost loom-btn-small" data-action="review-redo"
                        ${review.future?.length ? '' : 'disabled'} title="Вернуться вперёд к версии разбора, от которой откатились">
                        <i class="fa-solid fa-clock-rotate-left fa-flip-horizontal"></i> Вперёд
                    </button>
                </div>` : ''}
            </div>
            ${hasReview ? `
            <div class="loom-rating-summary">
                <span class="loom-rating-text" data-summary="review">${escapeHtml(ratingSummary(review.sections))}</span>
                <span class="loom-iteration">версия ${review.iteration}</span>
            </div>
            ${renderSections(review.sections, 'data-scope="review"', 'review-')}` : ''}
            ${review.backups?.length ? `
            <details class="loom-review-backups" data-details-key="review-backups">
                <summary><i class="fa-solid fa-box-archive"></i> Копии заменённых блоков (${review.backups.length})</summary>
                ${review.backups.map(item => `
                <div class="loom-review-backup" data-backup="${escapeHtml(item.id)}">
                    <div class="loom-review-backup-head">
                        <span><b>${escapeHtml(item.blockName)}</b> · ${escapeHtml(item.preset)} · ${new Date(item.at).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</span>
                        <span class="loom-review-backup-tools">
                            <button class="loom-btn loom-btn-small loom-btn-ghost" data-action="backup-restore" title="Вернуть этот текст в блок пресета">Вернуть</button>
                            <button class="loom-btn loom-btn-small loom-btn-ghost" data-action="backup-copy">Копировать</button>
                            <button class="loom-icon-btn loom-danger" data-action="backup-delete" title="Удалить копию"><i class="fa-solid fa-trash"></i></button>
                        </span>
                    </div>
                    <textarea readonly rows="3">${escapeHtml(item.old)}</textarea>
                </div>`).join('')}
            </details>` : ''}
        </details>`;
}

/** Готовый текст для вставки ([PROMPT]…[/PROMPT]) — из абзаца в отдельное поле block.prompt. */
function withPromptFixes(sections) {
    for (const section of sections) {
        for (const block of section.blocks) {
            const { text, prompt } = splitPromptFix(block.text);
            block.text = text;
            if (prompt) block.prompt = prompt;
        }
    }
    return sections;
}

/** Блоки черновика пресета LOOM → та же форма, что у buildPresetDigestFromRaw. */
function presetDraftDigest(presetDraft) {
    const blocks = presetDraft.entries
        .filter(entry => entry.sections.some(s => s.blocks.length))
        .map(entry => ({
            name: entry.title || 'Без названия',
            content: entry.sections.map(s => s.blocks.map(b => b.text).join('\n\n')).filter(Boolean).join('\n\n'),
            role: entry.role || 'system',
            enabled: null,
        }));
    return { model: '', blocks };
}

/** Источник разбора → дайджест для промпта + подпись. Перечитывается при каждом запуске. */
async function resolveReviewDigest(draft) {
    const source = draft.review.source;
    const kind = source?.kind || 'self';

    if (kind === 'self') {
        return { digest: presetDraftDigest(draft), sourceLabel: `Черновик LOOM: ${draft.name || 'без имени'}` };
    }
    if (kind === 'tavern') {
        if (!source.presetName) return { digest: null, sourceLabel: '' };
        const raw = readTavernPresetRaw(source.presetName);
        if (!raw) throw new Error(`Пресет «${source.presetName}» больше не найден в Таверне.`);
        return { digest: buildPresetDigestFromRaw(raw), sourceLabel: source.label };
    }
    if (kind === 'draft') {
        if (!source.draftId) return { digest: null, sourceLabel: '' };
        const other = getDraft(source.draftId);
        if (!other || other.mode !== 'preset') throw new Error('Черновик пресета LOOM больше не найден.');
        return { digest: presetDraftDigest(other), sourceLabel: `Черновик LOOM: ${other.name || 'без имени'}` };
    }
    if (kind === 'file') {
        if (!source.digestId) return { digest: null, sourceLabel: '' };
        const digest = await loadJson(source.digestId);
        if (!digest) throw new Error('Файл пресета больше не найден в хранилище — загрузите его заново.');
        return { digest, sourceLabel: source.label };
    }
    return { digest: null, sourceLabel: '' };
}

async function requireReviewDigest(draft) {
    const result = await resolveReviewDigest(draft);
    if (!result.digest) throw new Error('Сначала выберите, какой пресет разбираем.');
    if (!result.digest.blocks.length) {
        throw new Error((draft.review.source?.kind || 'self') === 'self'
            ? 'В черновике ещё нет написанных блоков — разбирать нечего.'
            : 'В выбранном источнике нет ни одного именованного блока с текстом.');
    }
    return result;
}

/** После генерации плашка должна остаться раскрытой — иначе результат не виден. */
function renderMainWithReviewOpen() {
    renderMain();
    $('#loom-main .loom-review').prop('open', true);
}

async function generateReview(draft) {
    const review = draft.review;
    await withBusy('Читаю пресет и ищу причину…', async () => {
        const { digest, sourceLabel } = await requireReviewDigest(draft);
        const response = await callAI(
            analysisCreatePrompt({ brief: review.brief, notes: review.notes, digest, sourceLabel }),
            { system: analysisSystemPrompt() },
        );
        const parsed = parseJsonLoose(response, 'card');
        if (!parsed?.card) throw new Error(parseFailure(response, 'объект разбора'));

        const sections = withPromptFixes(sectionsFromResponse(parsed.card, 'analysis'));
        if (!sections.length) throw new Error('В ответе модели не нашлось ни одного пункта формата.');

        if (review.sections.length) pushHistory(review);
        review.sections = sections;
        review.iteration = (review.iteration || 0) + 1;
        touchDraft(draft);

        renderMainWithReviewOpen();
        toast('success', 'Разбор готов. Оцените абзацы — и переписывайте.');
    });
}

async function rewriteReview(draft) {
    const review = draft.review;
    const keepThreshold = Number(getSettings().rating_keep_threshold) || 8;
    const { approved, toRewrite } = splitApprovedSections(review.sections, keepThreshold);
    if (!toRewrite.length) {
        return toast('info', `Все пункты разбора уже одобрены (оценка ≥ ${keepThreshold}) — переписывать нечего.`);
    }

    await withBusy('Переписываю разбор…', async () => {
        const { digest, sourceLabel } = await requireReviewDigest(draft);
        const itemIds = toRewrite.map(s => s.id);
        const response = await callAI(analysisRewritePrompt(review, digest, sourceLabel, itemIds), {
            system: analysisSystemPrompt(),
        });
        const parsed = parseJsonLoose(response, 'card');
        if (!parsed?.card) throw new Error(parseFailure(response, 'объект разбора'));

        const rewritten = withPromptFixes(sectionsFromResponse(parsed.card, 'analysis', itemIds));
        if (!rewritten.length) throw new Error('В ответе модели не нашлось ни одного пункта формата.');

        pushHistory(review);
        const rated = carryOverRatings(review.history.at(-1).sections, rewritten);
        review.sections = mergeSections('analysis', approved, rated);
        review.iteration = (review.iteration || 0) + 1;
        touchDraft(draft);

        renderMainWithReviewOpen();
        toast('success', `Разбор, версия ${review.iteration}. Переписано пунктов: ${rewritten.length} из ${review.sections.length}.`);
    });
}

async function regenerateReviewSection(draft, sectionId) {
    const review = draft.review;
    const item = activeFormat('analysis').find(i => i.id === sectionId);
    if (!item) return;

    await withBusy(`Переписываю «${item.label}»…`, async () => {
        const { digest, sourceLabel } = await requireReviewDigest(draft);
        const response = await callAI(analysisRewritePrompt(review, digest, sourceLabel, [sectionId]), {
            system: analysisSystemPrompt(),
        });
        const parsed = parseJsonLoose(response, 'card');
        if (!parsed?.card) throw new Error(parseFailure(response, 'объект разбора'));

        const rewritten = withPromptFixes(sectionsFromResponse(parsed.card, 'analysis', [sectionId]));
        if (!rewritten.length) throw new Error(`Модель не вернула пункт «${item.label}».`);

        pushHistory(review);
        const rated = carryOverRatings(review.history.at(-1).sections, rewritten);
        review.sections = mergeSections('analysis', review.sections.filter(s => s.id !== sectionId), rated);
        touchDraft(draft);
        renderMainWithReviewOpen();
    });
}

// ─── Обработчики редактора ──────────────────────────────────────────

/**
 * Перевод готового текста на английский.
 *
 * Ключи лорбука сюда не попадают вообще: они ищутся по русскому тексту чата
 * и от перевода перестали бы срабатывать. Старая версия уходит в историю — «Откатить» вернёт русский.
 *
 * @param {object} target черновик или запись лорбука
 */
async function translateSections(target) {
    const sections = (target.sections || []).map(section => ({
        id: section.id,
        blocks: section.blocks.map(block => block.text),
    })).filter(section => section.blocks.length);

    if (!sections.length) throw new Error('Переводить нечего — текста нет.');

    // Без явного maxTokens запрос берёт лимит по умолчанию (рассчитан на ОДИН пункт формата),
    // а у большой карточки перевод всех пунктов разом в него не влезает — модель обрывается
    // на полуслове, и JSON выходит битым. Считаем лимит от реального объёма текста,
    // как уже делает translateEntriesBatch для лорбука.
    const settings = getSettings();
    const estimate = sections.reduce((sum, s) => sum + s.blocks.length, 0) * 220;
    const maxTokens = Math.min(16000, Math.max(Number(settings.max_tokens) || 4000, estimate));

    const response = await callAI(translatePrompt(sections), { maxTokens });
    const parsed = parseJsonLoose(response, 'sections');
    if (!parsed?.sections) throw new Error(parseFailure(response, 'перевод'));

    pushHistory(target);
    return applyTranslation(target.sections, parsed.sections);
}

/**
 * Перевод НЕСКОЛЬКИХ записей лорбука одним запросом — а не по одному на запись.
 * По одному запросу на запись легко упереться в лимит запросов в минуту у провайдера
 * (сама Таверна уже показывала «Too Many Requests»), а перевод восьми записей —
 * это восемь запросов подряд без всякой причины: они не зависят друг от друга
 * ничем, кроме общего словаря имён, а его как раз проще держать в одном контексте.
 *
 * @param {object[]} entries записи с непустыми sections
 * @returns {Promise<number>} сколько записей реально получили перевод
 */
async function translateEntriesBatch(entries) {
    const payload = entries.map(entry => ({
        id: entry.id,
        sections: entry.sections.map(section => ({
            id: section.id,
            blocks: section.blocks.map(block => block.text),
        })).filter(section => section.blocks.length),
    })).filter(entry => entry.sections.length);

    if (!payload.length) throw new Error('Переводить нечего — текста нет.');

    // Хватает с запасом на все записи разом: 4000 токенов по умолчанию рассчитаны
    // на одну карточку, а тут в одном ответе весь лорбук
    const settings = getSettings();
    const estimate = payload.reduce((sum, e) => sum + e.sections.reduce((s, sec) => s + sec.blocks.length, 0), 0) * 220;
    const maxTokens = Math.min(16000, Math.max(Number(settings.max_tokens) || 4000, estimate));

    const response = await callAI(translateEntriesPrompt(payload), { maxTokens });
    const parsed = parseJsonLoose(response, 'entries');
    if (!parsed?.entries) throw new Error(parseFailure(response, 'перевод записей'));

    let translated = 0;
    for (const entry of entries) {
        const result = parsed.entries[entry.id];
        if (!result) continue;
        pushHistory(entry);
        if (applyTranslation(entry.sections, result) > 0) translated++;
    }
    return translated;
}

/** Карточка внутри PNG — её ждёт и Таверна, и любой другой фронтенд. */
async function buildCardPng(draft) {
    if (!draft.avatar) throw new Error('Сначала выберите картинку карточки — в блоке «Задумка».');

    const dataUrl = await loadImage(draft.avatar.id);
    if (!dataUrl) throw new Error('Картинка потерялась из хранилища — выберите её заново.');

    const png = await toAvatarPng(dataUrl);
    return embedCardInPng(png, buildCharacterCard(draft));
}

/** Чистим хранилище вслед за черновиком: без этого IndexedDB растёт вечно. */
async function forgetImages(refs) {
    for (const ref of refs || []) {
        try {
            await deleteImage(ref.id);
        } catch (error) {
            console.warn(LOG, 'Не удалось удалить картинку', ref.id, error);
        }
    }
}

async function forgetDraftImages(draft) {
    await forgetImages(draft.images);
    if (draft.avatar) await forgetImages([draft.avatar]);
    for (const entry of draft.entries || []) await forgetImages(entry.images);
    const reviewFile = draft.review?.source?.kind === 'file' ? draft.review.source.digestId : null;
    if (reviewFile) await forgetImages([{ id: reviewFile }]);
}

/** Кому принадлежит полоса референсов: записи лорбука или всему черновику. */
function resolveImageOwner($element) {
    const draft = currentDraft();
    if (!draft) return null;
    const $entry = $element.closest('.loom-entry');
    if ($entry.length) {
        const entry = draft.entries[Number($entry.data('entry'))];
        return entry ? { draft, owner: entry } : null;
    }
    return { draft, owner: draft };
}

/** Находит абзац по data-атрибутам элемента внутри .loom-block. */
function resolveBlock($element) {
    const draft = currentDraft();
    if (!draft) return null;
    const $block = $element.closest('.loom-block');
    const scope = $block.data('scope');
    const sectionId = String($block.data('sectionId'));
    const blockIndex = Number($block.data('block'));

    const sections = scope === 'entry'
        ? draft.entries[Number($block.data('entry'))]?.sections
        : scope === 'review' ? draft.review?.sections : draft.sections;

    const section = sections?.find(s => s.id === sectionId);
    const block = section?.blocks?.[blockIndex];
    return block ? { draft, section, block, blockIndex, $block } : null;
}

function resolveEntry($element) {
    const draft = currentDraft();
    if (!draft) return null;
    const index = Number($element.closest('.loom-entry').data('entry'));
    const entry = draft.entries[index];
    return entry ? { draft, entry, index } : null;
}

/** Тот же путь, что у resolveEntry, но для идеи сценария (draft.ideas). */
function resolveIdea($element) {
    const draft = currentDraft();
    if (!draft) return null;
    const index = Number($element.closest('.loom-idea').data('idea'));
    const idea = draft.ideas?.[index];
    return idea ? { draft, idea, index } : null;
}

/** Тот же путь, что у resolveBlock, но до секции целиком — для кнопки «переписать пункт». */
function resolveSection($element) {
    const draft = currentDraft();
    if (!draft) return null;
    const $btn = $element.closest('.loom-section-regen');
    const scope = $btn.data('scope');
    const sectionId = String($btn.data('sectionId'));

    if (scope === 'entry') {
        const entry = draft.entries[Number($btn.data('entry'))];
        const section = entry?.sections?.find(s => s.id === sectionId);
        return section ? { draft, entry, section } : null;
    }
    if (scope === 'review') {
        const section = draft.review?.sections?.find(s => s.id === sectionId);
        return section ? { draft, entry: null, review: true, section } : null;
    }
    const section = draft.sections?.find(s => s.id === sectionId);
    return section ? { draft, entry: null, section } : null;
}

function bindEditorEvents() {
    const $main = $('#loom-main');

    // ─ Поля черновика ─
    $main.on('input', '.loom-draft-name-input', function () {
        const draft = currentDraft();
        if (!draft) return;
        draft.name = $(this).val();
        touchDraft(draft);
        // В списке от имени зависит ровно одна подпись — правим её, а не пересобираем
        // весь список на каждую букву: полная пересборка ещё и сбрасывает его прокрутку
        $(`#loom-draft-list .loom-draft-item[data-id="${draft.id}"] .loom-draft-name`)
            .text(draft.name || 'Без имени');
    });

    $main.on('input', '.loom-memo-input', function () {
        const draft = currentDraft();
        if (!draft) return;
        draft.memo = $(this).val();
        touchDraft(draft);
        refreshDraftItem(draft);
    });

    $main.on('input', '.loom-brief-text', function () {
        const draft = currentDraft();
        if (draft) { draft.brief = $(this).val(); touchDraft(draft); }
    });

    $main.on('input', '.loom-notes-text', function () {
        const draft = currentDraft();
        if (draft) { draft.notes = $(this).val(); touchDraft(draft); }
    });

    $main.on('input', '.loom-plot-field', function () {
        const draft = currentDraft();
        const field = $(this).data('field');
        const found = draft && plotNodeFrom(draft, this);
        if (!found || !field) return;
        found.node[field] = $(this).val();
        // Название шага дублируется в его свёрнутой шапке
        if (field === 'title' && !found.isSub) {
            $(this).closest('.loom-plot-step').children('summary').find('.loom-plot-step-name').text($(this).val() || 'Без названия');
        }
        if (this.tagName === 'TEXTAREA') autoGrow(this);
        touchDraft(draft);
    });

    // Личные цели персонажей: {who, text} у шага или подпункта
    $main.on('input', '.loom-plot-goal-who, .loom-plot-goal-text', function () {
        const draft = currentDraft();
        const found = draft && plotNodeFrom(draft, this);
        const goal = found?.node.goals?.[Number($(this).closest('.loom-plot-goal').data('goal'))];
        if (!goal) return;
        goal[$(this).hasClass('loom-plot-goal-who') ? 'who' : 'text'] = $(this).val();
        if (this.tagName === 'TEXTAREA') autoGrow(this);
        touchDraft(draft);
    });

    $main.on('change', '.loom-plot-usecast', function () {
        const draft = currentDraft();
        if (!draft) return;
        draft.useChatCast = $(this).is(':checked');
        touchDraft(draft);
    });

    // Кнопки лежат внутри <summary> — без этого каждый клик по ним ещё и сворачивал бы шаг
    $main.on('click', '.loom-plot-step-tools button', event => event.preventDefault());

    $main.on('input change', '.loom-plot-subcount', function () {
        const draft = currentDraft();
        if (!draft) return;
        draft.subCount = Math.max(0, Math.min(8, Number($(this).val()) || 0));
        touchDraft(draft);
    });

    $main.on('input change', '.loom-plot-count', function () {
        const draft = currentDraft();
        if (!draft) return;
        draft.stepCount = Math.max(0, Math.min(20, Number($(this).val()) || 0));
        touchDraft(draft);
    });

    $main.on('input', '.loom-scene-idea', function () {
        const draft = currentDraft();
        const itemId = $(this).data('sceneItem');
        if (!draft || !itemId) return;
        if (!draft.sceneBriefs || typeof draft.sceneBriefs !== 'object') draft.sceneBriefs = {};
        draft.sceneBriefs[itemId] = $(this).val();
        touchDraft(draft);
    });

    $main.on('input', '.loom-persona-title-input', function () {
        const draft = currentDraft();
        if (!draft) return;
        draft.personaTitle = $(this).val();
        touchDraft(draft);
        // В списке слева эта подпись стоит под именем персоны — правим её сразу
        refreshDraftItem(draft);
    });

    $main.on('change', '.loom-character-link', function () {
        const draft = currentDraft();
        if (!draft) return;
        const id = $(this).val();
        if (!id) return;
        if (!Array.isArray(draft.characterIds)) draft.characterIds = [];
        if (!draft.characterIds.includes(id)) draft.characterIds.push(id);
        touchDraft(draft);
        renderMain();
    });

    $main.on('click', '.loom-linked-char-remove', function () {
        const draft = currentDraft();
        if (!draft) return;
        const id = $(this).closest('.loom-linked-char').data('id');
        draft.characterIds = (draft.characterIds || []).filter(x => x !== id);
        // Без персонажей фильтр по ним ставить не на что — прячем чекбокс и гасим флаг,
        // чтобы он молча не остался висеть на удалённой привязке
        if (!draft.characterIds.length) draft.wiFilterToCharacter = false;
        touchDraft(draft);
        renderMain();
    });

    $main.on('change', '.loom-persona-link', function () {
        const draft = currentDraft();
        if (!draft) return;
        draft.personaId = $(this).val() || null;
        touchDraft(draft);
        renderMain();
    });

    // ─ Настройки записи Таверны (позиция/приоритет/фильтр) ─
    $main.on('change', '.loom-wi-position', function () {
        const draft = currentDraft();
        if (!draft) return;
        draft.wiPosition = Number($(this).val());
        touchDraft(draft);
        renderMain(); // строка «глубина/роль» появляется только для position=4
    });

    $main.on('input', '.loom-wi-order', function () {
        const draft = currentDraft();
        if (!draft) return;
        draft.wiOrder = Number($(this).val());
        $(this).closest('.loom-wi-settings').find('.loom-wi-order-val').text(draft.wiOrder);
        touchDraft(draft);
    });

    $main.on('input change', '.loom-wi-depth', function () {
        const draft = currentDraft();
        if (!draft) return;
        draft.wiDepth = Math.max(0, Number($(this).val()) || 0);
        touchDraft(draft);
    });

    $main.on('change', '.loom-wi-role', function () {
        const draft = currentDraft();
        if (!draft) return;
        draft.wiRole = Number($(this).val());
        touchDraft(draft);
    });

    $main.on('change', '.loom-wi-no-recursion', function () {
        const draft = currentDraft();
        if (!draft) return;
        draft.wiPreventRecursion = $(this).is(':checked');
        touchDraft(draft);
    });

    $main.on('change', '.loom-wi-filter-char', function () {
        const draft = currentDraft();
        if (!draft) return;
        draft.wiFilterToCharacter = $(this).is(':checked');
        touchDraft(draft);
    });

    // ─ Абзацы ─
    $main.on('input', '.loom-block-text', function () {
        const found = resolveBlock($(this));
        if (!found) return;
        found.block.text = $(this).val();
        autoGrow(this);
        touchDraft(found.draft);
    });

    $main.on('input', '.loom-block-prompt-text', function () {
        const found = resolveBlock($(this));
        if (!found) return;
        found.block.prompt = $(this).val();
        autoGrow(this);
        touchDraft(found.draft);
    });

    $main.on('click', '.loom-block-prompt-apply', function () {
        const found = resolveBlock($(this));
        if (found) applyPromptToPreset(found.draft, found.block);
    });

    $main.on('click', '.loom-block-prompt-copy', async function () {
        const found = resolveBlock($(this));
        const text = String(found?.block?.prompt || '').trim();
        if (!text) return toast('error', 'Поле пустое.');
        const ok = await copyToClipboard(text);
        toast(ok ? 'success' : 'error', ok ? 'Текст скопирован — вставьте его в пресет.' : 'Браузер не дал скопировать.');
    });

    $main.on('input', '.loom-block-comment', function () {
        const found = resolveBlock($(this));
        if (!found) return;
        found.block.comment = $(this).val();
        found.$block.find('.loom-block-comment-toggle')
            .toggleClass('has', !!$(this).val().trim());
        touchDraft(found.draft);
    });

    $main.on('click', '.loom-block-comment-toggle', function () {
        const $comment = $(this).closest('.loom-block').find('.loom-block-comment');
        $comment.toggleClass('open');
        if ($comment.hasClass('open')) {
            autoGrow($comment.get(0));
            $comment.trigger('focus');
        }
    });

    $main.on('click', '.loom-block-delete', async function () {
        const found = resolveBlock($(this));
        if (!found) return;
        const ok = await confirmAction('Удалить этот абзац? Это необратимо.');
        if (!ok) return;
        found.section.blocks.splice(found.blockIndex, 1);
        touchDraft(found.draft);
        renderMain();
    });

    // ─ Другие варианты первого сообщения (alternate_greetings) ─
    $main.on('input', '.loom-altgreet-text', function () {
        const draft = currentDraft();
        const index = Number($(this).closest('.loom-altgreet').data('altgreet'));
        if (!draft?.altGreetings?.[index]) return;
        draft.altGreetings[index].text = $(this).val();
        autoGrow(this);
        touchDraft(draft);
    });

    $main.on('input', '.loom-altgreet-idea', function () {
        const draft = currentDraft();
        const index = Number($(this).closest('.loom-altgreet').data('altgreet'));
        if (!draft?.altGreetings?.[index]) return;
        draft.altGreetings[index].idea = $(this).val();
        touchDraft(draft);
    });

    $main.on('click', '.loom-altgreet-delete', async function () {
        const draft = currentDraft();
        const index = Number($(this).closest('.loom-altgreet').data('altgreet'));
        if (!draft?.altGreetings || Number.isNaN(index)) return;
        const ok = await confirmAction('Удалить этот вариант первого сообщения? Это необратимо.');
        if (!ok) return;
        draft.altGreetings.splice(index, 1);
        touchDraft(draft);
        renderMain();
    });


    // Выпадающий список (экспорт): открываем свой, закрываем остальные
    $main.on('click', '.loom-menu-toggle', function (event) {
        event.stopPropagation();
        const $menu = $(this).closest('.loom-menu');
        const open = $menu.hasClass('open');
        $main.find('.loom-menu').removeClass('open');
        $menu.toggleClass('open', !open);
    });

    // Клик по пункту списка закрывает его — само действие отработает
    // делегированным обработчиком [data-action] ниже
    $main.on('click', '.loom-menu-list [data-action]', function () {
        $(this).closest('.loom-menu').removeClass('open');
    });

    // Клик мимо списка закрывает его. На document, а не на $main: промахнуться
    // можно и за пределы редактора, а список остался бы висеть открытым.
    $(document).on('click.loomMenu', () => $('#loom-main .loom-menu').removeClass('open'));

    $main.on('click', '.loom-section-regen', function (event) {
        // Кнопка теперь внутри <summary> (см. renderSections) — без этого клик по ней
        // одновременно сворачивал бы/разворачивал секцию, ЛОВЯ клик как переключение
        // <details>, вместо (или вместе с) самим действием.
        event.preventDefault();
        const found = resolveSection($(this));
        if (!found) return;
        if (found.review) return regenerateReviewSection(found.draft, found.section.id);
        if (found.entry) {
            // Карта и здесь, не тернарник — тот же довод, что и у byMode ниже: лорбук
            // и пресет делят одну и ту же карточку записи/блока, но каждый пишется
            // своим промптом (мировой факт против инструкции модели), и перепутать
            // движок для нового entry-режима было бы легко, забудь эту строку.
            const byEntryMode = { preset: regeneratePresetEntrySection };
            return (byEntryMode[found.draft.mode] || regenerateEntrySection)(found.draft, found.entry, found.section.id);
        }
        // Карта, а не цепочка тернарников: новый режим, забытый здесь, молча
        // перегенерировал бы пункт по промпту персонажа
        const byMode = {
            persona: regeneratePersonaSection, prompt: regeneratePromptSection, scenario: regenerateScenarioSection,
        };
        return (byMode[found.draft.mode] || regenerateSection)(found.draft, found.section.id);
    });

    // Повторный клик по той же оценке снимает её: иначе поставленную случайно
    // десятку нечем убрать, а «без оценки» и «10» — принципиально разные сигналы модели
    $main.on('click', '.loom-heart', function () {
        const found = resolveBlock($(this));
        if (!found) return;
        const value = Number($(this).data('value'));
        found.block.rating = (found.block.rating === value) ? 0 : value;
        touchDraft(found.draft);
        repaintHearts(found.$block, found.block.rating);
        updateRatingSummary();
    });

    // ─ Кнопки редактора ─
    // ─ Картинки ─
    $main.on('change', '.loom-ref-input', async function () {
        const files = [...(this.files || [])];
        this.value = '';
        if (!files.length) return;

        const found = resolveImageOwner($(this));
        if (!found) return;

        await withBusy(`Гружу картинки (${files.length})…`, async () => {
            for (const file of files) {
                found.owner.images.push(await storeImage(file));
            }
            touchDraft(found.draft);
            renderMain();
        });
    });

    $main.on('input', '.loom-ref-note', function () {
        const found = resolveImageOwner($(this));
        const index = Number($(this).closest('.loom-ref').data('ref'));
        const ref = found?.owner?.images?.[index];
        if (!ref) return;
        ref.note = $(this).val();
        touchDraft(found.draft);
    });

    $main.on('click', '.loom-ref-remove', async function () {
        const found = resolveImageOwner($(this));
        const index = Number($(this).closest('.loom-ref').data('ref'));
        const ref = found?.owner?.images?.[index];
        if (!ref) return;
        await forgetImages([ref]);
        found.owner.images.splice(index, 1);
        touchDraft(found.draft);
        renderMain();
    });

    $main.on('change', '.loom-avatar-input', async function () {
        const file = this.files?.[0];
        this.value = '';
        const draft = currentDraft();
        if (!file || !draft) return;

        await withBusy('Гружу картинку карточки…', async () => {
            if (draft.avatar) await forgetImages([draft.avatar]);
            draft.avatar = await storeImage(file);
            touchDraft(draft);
            renderMain();
        });
    });

    // ─ Блок пресета: роль и место вставки (те же поля, что в Prompt Manager Таверны) ─
    $main.on('change', '.loom-preset-role', function () {
        const found = resolveEntry($(this));
        if (!found) return;
        found.entry.role = $(this).val();
        touchDraft(found.draft);
    });

    $main.on('change', '.loom-preset-position', function () {
        const found = resolveEntry($(this));
        if (!found) return;
        found.entry.injectionPosition = Number($(this).val()) === 1 ? 1 : 0;
        touchDraft(found.draft);
        renderMain(); // поле «Глубина» есть только у вставки в чат
    });

    $main.on('input change', '.loom-preset-depth', function () {
        const found = resolveEntry($(this));
        if (!found) return;
        found.entry.injectionDepth = Math.max(0, Math.round(Number($(this).val()) || 0));
        touchDraft(found.draft);
    });

    // ─ Разбор пресета: жалоба и источник ─
    $main.on('input', '.loom-review-brief', function () {
        const draft = currentDraft();
        if (draft?.review) { draft.review.brief = $(this).val(); touchDraft(draft); }
    });

    $main.on('input', '.loom-review-notes', function () {
        const draft = currentDraft();
        if (draft?.review) { draft.review.notes = $(this).val(); touchDraft(draft); }
    });

    // Смена типа источника сбрасывает конкретную ссылку — «Таверна» и «черновик»
    // выбраны быть не могут одновременно, а старая ссылка на другой тип источника
    // потеряла бы смысл (draftId для kind='file' ничего не значит).
    $main.on('change', '.loom-review-source-kind', function () {
        const draft = currentDraft();
        if (!draft) return;
        const old = draft.review.source;
        if (old?.kind === 'file' && old.digestId) deleteImage(old.digestId).catch(() => {});
        draft.review.source = { kind: $(this).val(), label: '' };
        touchDraft(draft);
        renderMain();
    });

    $main.on('change', '.loom-review-source-value', function () {
        const draft = currentDraft();
        if (!draft) return;
        const kind = $(this).data('kind');
        const value = $(this).val();

        if (!value) { draft.review.source = { kind, label: '' }; touchDraft(draft); return; }

        if (kind === 'tavern') {
            draft.review.source = { kind, presetName: value, label: `Таверна: ${value}` };
        } else if (kind === 'draft') {
            const other = getDraft(value);
            draft.review.source = { kind, draftId: value, label: `Черновик LOOM: ${other?.name || 'без имени'}` };
        }
        touchDraft(draft);
        // Полная перерисовка не нужна — сам селект уже показывает выбранное
        // значение, дальше меняется только строка-подсказка под ним
        $('.loom-review-source .loom-hint').text(`Выбрано: ${draft.review.source.label}`);
    });

    $main.on('change', '.loom-review-source-file', async function () {
        const file = this.files?.[0];
        this.value = '';
        const draft = currentDraft();
        if (!file || !draft) return;

        await withBusy(`Читаю «${file.name}»…`, async () => {
            let raw;
            try {
                raw = JSON.parse(await file.text());
            } catch (e) {
                return toast('error', `«${file.name}» — не похоже на JSON: ${e.message || e}`);
            }

            const digest = buildPresetDigestFromRaw(raw);
            if (!digest.blocks.length) {
                return toast('error', `В «${file.name}» не нашлось ни одного именованного блока с текстом — это точно пресет Chat Completion?`);
            }

            // Старую картинку/JSON под прежним id чистим ПОСЛЕ того, как новый уже
            // точно сохранился — тот же порядок, что и у аватарки папки (src/folders.js):
            // неудачная запись новой не должна оставить нас вовсе без файла.
            const oldId = draft.review.source?.kind === 'file' ? draft.review.source.digestId : null;
            const digestId = await storeJson(digest, file.name);
            if (oldId) deleteImage(oldId).catch(() => {});

            draft.review.source = { kind: 'file', digestId, label: `Файл: ${file.name}` };
            touchDraft(draft);
            renderMainWithReviewOpen();
            toast('success', `«${file.name}» прочитан: именованных блоков с текстом — ${digest.blocks.length}.`);
        });
    });

    $main.on('click', '[data-action]', async function () {
        const draft = currentDraft();
        if (!draft) return;
        const action = $(this).data('action');

        switch (action) {
            case 'close-draft': {
                dropIfEmpty(state.draftId);
                state.draftId = null;
                renderDraftList();
                renderMain();
                return;
            }
            case 'generate': return generateCharacter(draft);
            case 'rewrite': return rewriteCharacter(draft);
            case 'generate-scene': return generateSceneItem(draft, $(this).data('sceneItem'));
            case 'rewrite-scene': return rewriteSceneItem(draft, $(this).data('sceneItem'));
            case 'add-altgreet': {
                if (!Array.isArray(draft.altGreetings)) draft.altGreetings = [];
                draft.altGreetings.push({ text: '', idea: '' });
                touchDraft(draft);
                renderMain();
                // Сразу в новое поле — иначе после клика непонятно, что вообще произошло
                $main.find('.loom-altgreet-idea').last().trigger('focus');
                return;
            }
            case 'altgreet-undo':
            case 'altgreet-redo': {
                const greeting = draft.altGreetings?.[Number($(this).data('altgreet'))];
                if (!stepGreetingHistory(greeting, action === 'altgreet-undo' ? 'undo' : 'redo')) return;
                touchDraft(draft);
                return renderMain();
            }
            case 'generate-altgreet': return generateAltGreeting(draft, Number($(this).data('altgreet')));
            case 'generate-all-altgreets': return generateAllAltGreetings(draft);
            case 'plot-generate': return generatePlot(draft);
            case 'plot-undo':
            case 'plot-redo': {
                const moved = action === 'plot-undo' ? popStepsHistory(draft) : redoStepsHistory(draft);
                if (!moved) return;
                touchDraft(draft);
                return renderMain();
            }
            case 'plot-add-step': {
                pushStepsHistory(draft);
                draft.steps.push({ id: uid(), title: '', goal: '', condition: '', complication: '' });
                touchDraft(draft);
                renderMain();
                $main.find('.loom-plot-title').last().trigger('focus');
                return;
            }
            case 'plot-step-up':
            case 'plot-step-down':
            case 'plot-step-delete':
            case 'plot-step-rewrite': {
                const found = plotNodeFrom(draft, this);
                if (!found) return;
                if (action === 'plot-step-rewrite') return rewritePlotStep(draft, found.stepIndex);
                if (action === 'plot-step-delete') {
                    if (!await confirmAction(`Удалить ${found.isSub ? 'подпункт' : 'шаг'} «${found.node.title || 'Без названия'}»? Вернуть можно кнопкой «Откатить».`)) return;
                    pushStepsHistory(draft);
                    found.list.splice(found.index, 1);
                } else {
                    const to = action === 'plot-step-up' ? found.index - 1 : found.index + 1;
                    if (to < 0 || to >= found.list.length) return;
                    pushStepsHistory(draft);
                    [found.list[found.index], found.list[to]] = [found.list[to], found.list[found.index]];
                }
                touchDraft(draft);
                renderMain();
                return;
            }
            case 'plot-sub-generate': {
                const found = plotNodeFrom(draft, this);
                if (!found) return;
                if (found.step.substeps?.length && !await confirmAction('Подпункты этого шага будут заменены. Вернуть можно кнопкой «Откатить».')) return;
                const n = Number(draft.subCount) || 3;
                return rewritePlotStep(draft, found.stepIndex,
                    `Break this step into about ${n} substeps: fill "substeps" with ${n} stages that follow one another, `
                    + 'each with its own checkable condition; replace any existing substeps. The step\'s own condition '
                    + 'describes the whole step being finished.');
            }
            case 'plot-add-sub': {
                const found = plotNodeFrom(draft, this);
                if (!found) return;
                pushStepsHistory(draft);
                (found.step.substeps ||= []).push({ id: uid(), title: '', goal: '', condition: '', complication: '', goals: [] });
                touchDraft(draft);
                renderMain();
                $main.find(`.loom-plot-step[data-step="${found.stepIndex}"] .loom-plot-sub .loom-plot-title`).last().trigger('focus');
                return;
            }
            case 'plot-goal-add':
            case 'plot-goal-delete': {
                const found = plotNodeFrom(draft, this);
                if (!found) return;
                found.node.goals ||= [];
                if (action === 'plot-goal-add') found.node.goals.push({ id: uid(), who: '', text: '' });
                else found.node.goals.splice(Number($(this).closest('.loom-plot-goal').data('goal')), 1);
                touchDraft(draft);
                renderMain();
                return;
            }
            case 'plot-toggle-steps': {
                const $steps = $main.find('.loom-plot-step');
                const open = !$steps.filter('[open]').length;
                $steps.prop('open', open);
                return;
            }
            case 'plot-step-done': {
                const found = plotNodeFrom(draft, this);
                const chatState = getPlotState();
                if (!found || chatState?.draftId !== draft.id) return;
                const leaves = plotLeaves(draft);
                const [from, to] = found.isSub
                    ? (() => { const start = stepRange(leaves, found.stepIndex)[0] + found.subIndex; return [start, start + 1]; })()
                    : stepRange(leaves, found.stepIndex);
                // Пройден — возвращаем прогресс на его начало; иначе — отмечаем всё до его конца включительно
                return setPlotStep(chatState.step >= to ? from : to);
            }
            case 'plot-bind': {
                if (!bindPlot(draft.id)) return toast('error', 'Не удалось привязать: откройте чат.');
                toast('success', 'Сюжет привязан к этому чату.');
                return;
            }
            case 'plot-unbind': {
                if (!await confirmAction('Отвязать сюжет от этого чата? Прогресс по шагам в чате будет забыт.')) return;
                return unbindPlot();
            }
            case 'plot-next': return advancePlot();
            case 'plot-back': return backPlot();
            case 'plot-reset': {
                if (!await confirmAction('Начать сюжет в этом чате с первого шага?')) return;
                return setPlotStep(0);
            }
            case 'generate-prompt': return generatePrompt(draft);
            case 'rewrite-prompt': return rewritePrompt(draft);
            case 'copy-prompt': {
                const text = buildSectionsText(draft);
                if (!text) return toast('error', 'В черновике нет текста ни в одном пункте.');
                const ok = await copyToClipboard(text);
                return toast(ok ? 'success' : 'error', ok
                    ? 'Промпт скопирован. Вставьте в Prompt Manager (Chat Completion) или System Prompt (Text Completion).'
                    : 'Браузер не дал скопировать. Откройте «TXT» и скопируйте оттуда.');
            }
            case 'download-prompt': {
                const text = buildSectionsText(draft);
                if (!text) return toast('error', 'В черновике нет текста ни в одном пункте.');
                return downloadText(text, `${draft.name || 'prompt'}.txt`);
            }
            case 'translate-prompt':
                return withBusy('Перевожу промпт…', async () => {
                    const replaced = await translateSections(draft);
                    touchDraft(draft);
                    renderMain();
                    toast('success', `Переведено абзацев: ${replaced}. Прежняя версия — под кнопкой «Откатить».`);
                });
            case 'backup-restore':
            case 'backup-copy':
            case 'backup-delete': {
                const id = String($(this).closest('.loom-review-backup').data('backup'));
                const item = draft.review.backups?.find(b => b.id === id);
                if (!item) return;
                if (action === 'backup-copy') {
                    const ok = await copyToClipboard(item.old);
                    return toast(ok ? 'success' : 'error', ok ? 'Скопировано.' : 'Браузер не дал скопировать.');
                }
                if (action === 'backup-delete') {
                    draft.review.backups = draft.review.backups.filter(b => b.id !== id);
                    touchDraft(draft);
                    return renderMain();
                }
                if (!await confirmAction(`Вернуть старый текст в блок «${item.blockName}» пресета «${item.preset}»?`)) return;
                return withBusy('Возвращаю текст…', async () => {
                    await putPresetBlock(item.preset, item.identifier, item.old);
                    toast('success', 'Старый текст возвращён в пресет.');
                });
            }
            case 'review-generate': return generateReview(draft);
            case 'review-rewrite': return rewriteReview(draft);
            case 'review-copy': {
                const text = draft.review.sections.flatMap(s => s.blocks.map(b => b.prompt ? `${b.text}\n\n${b.prompt}` : b.text)).join('\n\n').trim();
                if (!text) return toast('error', 'В разборе нет текста.');
                const ok = await copyToClipboard(text);
                return toast(ok ? 'success' : 'error', ok ? 'Разбор скопирован.' : 'Браузер не дал скопировать.');
            }
            case 'review-undo': {
                if (!popHistory(draft.review)) return;
                touchDraft(draft);
                return renderMainWithReviewOpen();
            }
            case 'review-redo': {
                if (!redoHistory(draft.review)) return;
                touchDraft(draft);
                return renderMainWithReviewOpen();
            }
            case 'scenario-ideas': return generateScenarioIdeas(draft);
            case 'scenario-develop': return developScenario(draft);
            case 'rewrite-scenario': return rewriteScenario(draft);
            case 'pick-idea': {
                const found = resolveIdea($(this));
                if (!found) return;
                found.draft.brief = found.idea.text;
                touchDraft(found.draft);
                renderMain();
                // Задумка могла быть свёрнута (черновик уже проработан) — раскрываем,
                // иначе непонятно, что вообще произошло после клика
                $('#loom-main .loom-brief').prop('open', true);
                return;
            }
            case 'delete-idea': {
                const found = resolveIdea($(this));
                if (!found) return;
                const ok = await confirmAction('Удалить эту идею? Это необратимо.');
                if (!ok) return;
                found.draft.ideas.splice(found.index, 1);
                touchDraft(found.draft);
                renderMain();
                return;
            }
            case 'copy-scenario': {
                const text = buildSectionsText(draft);
                if (!text) return toast('error', 'В черновике нет текста ни в одном пункте.');
                const ok = await copyToClipboard(text);
                return toast(ok ? 'success' : 'error', ok
                    ? 'Сценарий скопирован.'
                    : 'Браузер не дал скопировать. Откройте «TXT» и скопируйте оттуда.');
            }
            case 'download-scenario': {
                const text = buildSectionsText(draft);
                if (!text) return toast('error', 'В черновике нет текста ни в одном пункте.');
                return downloadText(text, `${draft.name || 'scenario'}.txt`);
            }
            case 'translate-scenario':
                return withBusy('Перевожу сценарий…', async () => {
                    const replaced = await translateSections(draft);
                    touchDraft(draft);
                    renderMain();
                    toast('success', `Переведено абзацев: ${replaced}. Прежняя версия — под кнопкой «Откатить».`);
                });
            case 'generate-persona': return generatePersona(draft);
            case 'rewrite-persona': return rewritePersona(draft);
            case 'export-persona': {
                if (!draft.name?.trim()) return toast('error', 'Укажите имя персоны.');
                const hadLink = !!draft.importedAvatar;
                return withBusy(hadLink ? 'Обновляю персону в Таверне…' : 'Создаю персону в Таверне…', async () => {
                    const png = draft.avatar ? await toPersonaAvatarPng(await loadImage(draft.avatar.id)) : null;
                    const { avatar, created } = await exportPersona(draft, png);
                    // Переприсваиваем всегда, а не только при первом экспорте: если старая
                    // персона была удалена в Таверне, exportPersona тихо завела новую —
                    // без этого следующий экспорт снова пытался бы писать в удалённую.
                    draft.importedAvatar = avatar;
                    touchDraft(draft);
                    toast('success', created
                        ? (hadLink
                            ? `Персона «${draft.name}» была удалена в Таверне — создана заново.`
                            : `Персона «${draft.name}» создана.`)
                        : `Персона «${draft.name}» обновлена.`);
                });
            }
            case 'download-persona':
                return downloadJson({ name: draft.name, description: draft.sections.map(s => s.blocks.map(b => b.text).join('\n\n')).join('\n\n') }, `${draft.name || 'persona'}.json`);
            case 'translate-persona':
                return withBusy('Перевожу персону…', async () => {
                    const replaced = await translateSections(draft);
                    touchDraft(draft);
                    renderMain();
                    toast('success', `Переведено абзацев: ${replaced}. Русская версия — под кнопкой «Откатить».`);
                });
            case 'undo': {
                if (!popHistory(draft)) return toast('info', 'Откатывать нечего.');
                draft.iteration = Math.max(1, (draft.iteration || 1) - 1);
                touchDraft(draft);
                renderMain();
                return;
            }
            case 'redo': {
                if (!redoHistory(draft)) return toast('info', 'Идти вперёд некуда.');
                draft.iteration = (draft.iteration || 1) + 1;
                touchDraft(draft);
                renderMain();
                return;
            }
            case 'export-character': {
                if (!draft.name?.trim()) return toast('error', 'Укажите имя персонажа.');
                const hadLink = !!draft.importedAvatar;
                return withBusy(hadLink ? 'Обновляю персонажа в Таверне…' : 'Создаю персонажа в Таверне…', async () => {
                    // Есть картинка — импортируем PNG-картой, чтобы персонаж сразу был с портретом
                    const png = draft.avatar ? await buildCardPng(draft) : null;
                    const { avatar, created } = await exportCharacter(draft, png);
                    // Запоминаем, КУДА ушёл персонаж: следующий экспорт обновит его на месте
                    // вместо дубля, а лорбуки, привязанные к этому персонажу, смогут
                    // поставить фильтр по нему (см. resolveCharacterFilterName в export.js).
                    // Переприсваиваем всегда, а не только при первом экспорте: если карточка
                    // была удалена в Таверне, exportCharacter тихо завела новую — без этого
                    // следующий экспорт снова пытался бы обновлять удалённый файл.
                    draft.importedAvatar = avatar;
                    touchDraft(draft);
                    toast('success', created
                        ? (hadLink
                            ? `Персонаж «${draft.name}» был удалён в Таверне — создан заново.`
                            : `Персонаж «${draft.name}» создан.`)
                        : `Персонаж «${draft.name}» обновлён.`);
                });
            }
            case 'download-character':
                return downloadJson(buildCharacterCard(draft), `${draft.name || 'character'}.json`);

            case 'download-png':
                return withBusy('Собираю PNG-карту…', async () => {
                    const png = await buildCardPng(draft);
                    downloadPng(png, `${draft.name || 'character'}.png`);
                });

            case 'translate-character':
                return withBusy('Перевожу карточку…', async () => {
                    const replaced = await translateSections(draft);
                    touchDraft(draft);
                    renderMain();
                    toast('success', `Переведено абзацев: ${replaced}. Русская версия — под кнопкой «Откатить».`);
                });

            case 'avatar-remove': {
                if (!draft.avatar) return;
                await forgetImages([draft.avatar]);
                draft.avatar = null;
                touchDraft(draft);
                renderMain();
                return;
            }
            case 'duplicate-draft': return duplicateDraft(draft.id);
            case 'delete-draft': {
                const ok = await confirmAction(`Удалить черновик «${draft.name || 'без имени'}»? Это необратимо.`);
                if (!ok) return;
                await forgetDraftImages(draft);
                deleteDraft(draft.id);
                state.draftId = null;
                renderDraftList();
                renderMain();
                return;
            }

            case 'plan': return planLorebook(draft);
            case 'plan-undo': {
                if (!popEntriesHistory(draft)) return toast('info', 'Откатывать нечего.');
                touchDraft(draft);
                renderDraftList();
                return renderMain();
            }
            case 'plan-redo': {
                if (!redoEntriesHistory(draft)) return toast('info', 'Идти вперёд некуда.');
                touchDraft(draft);
                renderDraftList();
                return renderMain();
            }
            case 'entry-add': {
                const titleByMode = { preset: 'Новый блок' };
                createEntry(draft, { title: titleByMode[draft.mode] || 'Новая запись' });
                touchDraft(draft);
                renderMain();
                return;
            }
            case 'write-all': {
                const count = draft.entries.filter(e => !e.sections.length).length;
                if (!count) return toast('info', 'Все записи уже написаны.');
                return withBusy(`Пишу записи (${count})…`, async () => {
                    const { written, pending } = await writePendingEntries(draft);
                    renderMain();
                    toast('success', `Написано записей: ${written} из ${pending}.`);
                });
            }
            case 'write-whole': return writeWholeLorebook(draft);
            case 'rewrite-all': return rewriteAllEntries(draft);
            case 'keys-all': return buildAllEntryKeys(draft);
            case 'weigh-draft': {
                const text = ENTRY_BASED_MODES.has(draft.mode)
                    ? draft.entries.map(entryContentText).filter(Boolean).join('\n\n')
                    : sectionsText(draft.sections);
                if (!text.trim()) return toast('info', 'Пока нечего взвешивать.');
                return withBusy('Считаю…', async () => {
                    const ctx = SillyTavern.getContext();
                    const tokens = await ctx.getTokenCountAsync(text);
                    state.weights.set(draft.id, { tokens });
                    renderMain();
                });
            }
            case 'export-lorebook': {
                const name = draft.name?.trim();
                if (!name) return toast('error', 'Укажите название лорбука.');
                return withBusy('Сохраняю лорбук…', async () => {
                    const result = await exportLorebook(draft, name);
                    // exportLorebook запоминает uid новых записей прямо в draft.entries
                    // (см. src/export.js) — без сохранения это забудется при перезагрузке
                    // страницы, и следующий экспорт снова продублировал бы записи
                    touchDraft(draft);
                    const parts = [];
                    if (result.added) parts.push(`добавлено — ${result.added}`);
                    if (result.updated) parts.push(`обновлено — ${result.updated}`);
                    toast('success', `Лорбук «${result.name}»: ${parts.join(', ')}.`);
                    if (result.retargeted) toast('info', 'Это другой лорбук: записи добавлены новыми, чужие не тронуты.');
                    if (result.filterMissing.length) {
                        toast('info', 'Фильтр по персонажам не поставлен: в Таверне ещё нет — '
                            + `${result.filterMissing.join(', ')}.`);
                    }
                    // Без «Собрать ключи» выражения строятся локально по таблице окончаний.
                    // Обычные склонения она берёт, но чередование корня («пёс» → «пса»,
                    // «лев» → «льва») — нет: это умеет только модель. Молча отдавать
                    // заведомо более слабый вариант, не сказав, что есть лучше, — так себе.
                    const withoutKeys = draft.entries.filter(e => e.sections.length && !e.finalKeys?.length).length;
                    if (withoutKeys) {
                        toast('info', `Ключи собраны локально у записей: ${withoutKeys}. `
                            + 'Кнопка «Собрать ключи» соберёт их моделью — она ловит и чередование корня.');
                    }
                });
            }
            case 'translate-all': {
                const written = draft.entries.filter(entry => entry.sections.length);
                if (!written.length) return toast('info', ENTRY_BASED_MODES.has(draft.mode)
                    ? 'Ни одного написанного блока.' : 'Ни одной написанной записи.');
                return withBusy(`Перевожу ${draft.mode === 'preset' ? 'блоки' : 'записи'} (${written.length})…`, async () => {
                    const translated = await translateEntriesBatch(written);
                    touchDraft(draft);
                    renderMain();
                    toast('success', draft.mode === 'preset'
                        ? `Переведено блоков: ${translated} из ${written.length}.`
                        : `Переведено записей: ${translated} из ${written.length}. Ключи остались русскими.`);
                });
            }

            // ─ Пресет (см. лорбук выше — та же механика плана и записей, свой промпт-голос) ─
            case 'preset-plan': return planPreset(draft);
            case 'preset-write-whole': return writeWholePreset(draft);
            case 'preset-write-all': {
                const count = draft.entries.filter(e => !e.sections.length).length;
                if (!count) return toast('info', 'Все блоки уже написаны.');
                return withBusy(`Пишу блоки (${count})…`, async () => {
                    const { written, pending } = await writePendingPresetEntries(draft);
                    renderMain();
                    toast('success', `Написано блоков: ${written} из ${pending}.`);
                });
            }
            case 'preset-rewrite-all': return rewriteAllPresetEntries(draft);
            case 'export-preset': {
                const name = draft.name?.trim();
                if (!name) return toast('error', 'Укажите имя пресета.');
                return withBusy('Сохраняю пресет…', async () => {
                    const result = await exportPreset(draft, name);
                    // exportPreset запоминает identifier новых блоков прямо в draft.entries
                    // (см. src/export.js) — без сохранения это забудется при перезагрузке
                    // страницы, и следующий экспорт снова продублировал бы блоки.
                    touchDraft(draft);
                    toast('success', `Пресет «${result.name}»: блоков записано — ${result.written}.`);
                    if (result.retargeted) toast('info', 'Это другой пресет: блоки добавлены новыми, чужие не тронуты.');
                    toast('info', (result.isActive ? 'Пресет активен — изменения уже видны в Prompt Manager. ' : '')
                        + 'Новые блоки добавлены выключенными, уже существующие обновлены на месте — '
                        + 'их включение и порядок не менялись.');
                });
            }
        }

        // ─ Кнопки внутри записи лорбука/блока пресета ─
        const found = resolveEntry($(this));
        if (!found) return;

        switch (action) {
            case 'entry-write':
                return withBusy(`Пишу «${found.entry.title}»…`, () => writeEntry(draft, found.entry));
            case 'entry-rewrite': return rewriteEntry(draft, found.entry);
            case 'entry-keys': return buildEntryKeys(draft, found.entry);
            case 'entry-undo': {
                if (!popHistory(found.entry)) return toast('info', 'Откатывать нечего.');
                touchDraft(draft);
                return renderMain();
            }
            case 'entry-redo': {
                if (!redoHistory(found.entry)) return toast('info', 'Идти вперёд некуда.');
                touchDraft(draft);
                return renderMain();
            }
            case 'preset-write':
                return withBusy(`Пишу «${found.entry.title}»…`, () => writePresetEntry(draft, found.entry));
            case 'preset-rewrite': return rewritePresetEntry(draft, found.entry);
            case 'entry-translate':
                return withBusy(`Перевожу «${found.entry.title}»…`, async () => {
                    await translateSections(found.entry);
                    touchDraft(draft);
                    renderMain();
                });
            case 'entry-delete': {
                const ok = await confirmAction(`Удалить запись «${found.entry.title}»? Это необратимо.`);
                if (!ok) return;
                await forgetImages(found.entry.images);
                draft.entries.splice(found.index, 1);
                touchDraft(draft);
                renderMain();
                return;
            }
            case 'weigh-entry': {
                const text = entryContentText(found.entry);
                if (!text.trim()) return toast('info', 'Пока нечего взвешивать.');
                return withBusy('Считаю…', async () => {
                    const ctx = SillyTavern.getContext();
                    const tokens = await ctx.getTokenCountAsync(text);
                    state.weights.set(found.entry.id, { tokens });
                    renderMain();
                });
            }
        }
    });

    // ─ Записи лорбука: поля ─
    $main.on('input', '.loom-entry-title', function () {
        const found = resolveEntry($(this));
        if (found) { found.entry.title = $(this).val(); touchDraft(found.draft); }
    });

    $main.on('change', '.loom-entry-constant', function () {
        const found = resolveEntry($(this));
        if (found) { found.entry.constant = $(this).is(':checked'); touchDraft(found.draft); }
    });

    $main.on('change', '.loom-entry-category', function () {
        const found = resolveEntry($(this));
        if (found) { found.entry.category = $(this).val(); touchDraft(found.draft); }
    });

    $main.on('input', '.loom-entry-note', function () {
        const found = resolveEntry($(this));
        if (found) { found.entry.note = $(this).val(); touchDraft(found.draft); }
    });

    $main.on('input', '.loom-entry-wordcount', function () {
        const found = resolveEntry($(this));
        if (!found) return;
        found.entry.wordCount = Number($(this).val());
        // Правили руками — настройка «Слов в записи по умолчанию» такую запись больше не трогает
        found.entry.wordCountManual = true;
        touchDraft(found.draft);
        $(this).closest('.loom-entry-meta').find('.loom-entry-wordcount-val').text(found.entry.wordCount);
    });

    /*
     * Ключ добавляется по submit формы, а не по keydown c key === 'Enter': на телефоне
     * экранная клавиатура вместо Enter часто отдаёт «Далее» и просто перебрасывает фокус
     * на следующее поле (у нас — на название следующей записи), никакого keydown с Enter
     * при этом не приходит. Форма же submit'ится штатно, а кнопка «+» рядом остаётся
     * запасным путём для клавиатур, которые не делают и этого.
     */
    $main.on('submit', '.loom-key-form', function (event) {
        event.preventDefault();
        const $input = $(this).find('.loom-key-input');
        const found = resolveEntry($input);
        if (!found) return;
        const value = String($input.val()).trim();
        if (!value) return;

        const check = validateKey(value);
        if (!check.ok) return toast('error', check.error);

        // Тот же ключ дважды — лишняя работа для Таверны на каждом сообщении и мусор в списке.
        // Регистр не различаем: обычные ключи Таверна и так ищет без учёта регистра.
        if (found.entry.keys.some(key => key.trim().toLowerCase() === value.toLowerCase())) {
            $input.val('');
            return toast('info', `Ключ «${value}» у этой записи уже есть.`);
        }

        found.entry.keys.push(value);
        // Ключи изменились — ранее собранные regex к ним больше не относятся
        found.entry.finalKeys = [];
        touchDraft(found.draft);
        renderMain();
        // Ключи вводят пачкой, а renderMain отрисовывает поле заново — без возврата
        // фокуса пришлось бы после каждого ключа снова тыкать в поле и поднимать
        // экранную клавиатуру.
        $main.find(`.loom-entry[data-entry="${found.index}"] .loom-key-input`).trigger('focus');
    });

    $main.on('click', '.loom-key-remove', function () {
        const found = resolveEntry($(this));
        if (!found) return;
        found.entry.keys.splice(Number($(this).data('key')), 1);
        found.entry.finalKeys = [];
        touchDraft(found.draft);
        renderMain();
    });

    // Высота полей подгоняется под текст: карточку читают целиком, а не через скроллбары
    $main.on('focus', '.loom-block-text, .loom-altgreet-text', function () { autoGrow(this); });

    // Смена ширины (поворот телефона, изменение окна) перекладывает текст на другое
    // число строк — высоту, посчитанную при отрисовке, надо пересчитать. resize сыплет
    // событиями пачками (особенно пока тянут край окна), а пересчёт трогает все поля
    // сразу — поэтому не чаще раза на кадр.
    let resizeFrame = 0;
    $(window).on('resize.loom', () => {
        if (resizeFrame) return;
        resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; growAll($main); });
    });
}

function autoGrow(element) {
    if (NATIVE_GROW) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
}

function repaintHearts($block, rating) {
    $block.find('.loom-heart').each(function () {
        $(this).toggleClass('on', Number($(this).data('value')) <= rating);
    });
    $block.find('.loom-block-rating').text(rating ? `${rating}/10` : 'без оценки').toggleClass('empty', !rating);
}

/**
 * Пересчитывает счётчики «Оценено N из M» после клика по сердечку, не перерисовывая
 * редактор целиком.
 *
 * Счётчиков может быть несколько: у персонажа карточка и каждый пункт сцены (сценарий,
 * первое сообщение) считаются раздельно — ровно так же, как они раздельно рисуются
 * (см. renderCharacter/renderSceneItemBlock). Поэтому ищем их по data-summary, а не
 * по позиции: раньше здесь бралась .first(), и в счётчик карточки попадало число
 * абзацев ВМЕСТЕ со сценарием, а счётчик сценария не обновлялся вовсе. У персоны,
 * которая не попадала ни в одну ветку, счётчик не обновлялся тоже.
 */
function updateRatingSummary() {
    const draft = currentDraft();
    if (!draft) return;

    if (draft.review?.sections?.length) {
        $('#loom-main .loom-rating-text[data-summary="review"]').text(ratingSummary(draft.review.sections));
    }

    if (ENTRY_BASED_MODES.has(draft.mode)) {
        draft.entries.forEach((entry, index) => {
            $(`#loom-main .loom-entry[data-entry="${index}"] .loom-rating-text`).text(ratingSummary(entry.sections));
        });
        return;
    }

    // У персоны сценария нет — весь текст идёт одним счётчиком карточки
    const { cardSections } = draft.mode === 'persona'
        ? { cardSections: draft.sections }
        : splitSceneSections(draft);

    $('#loom-main .loom-rating-text[data-summary="card"]').text(ratingSummary(cardSections));
    if (draft.mode !== 'persona') {
        for (const item of sceneItems()) {
            const section = draft.sections.find(s => s.id === item.id);
            if (section) $(`#loom-main .loom-rating-text[data-summary="scene-${item.id}"]`).text(ratingSummary([section]));
        }
    }
}

// ─── Настройки ──────────────────────────────────────────────────────────────

function loadSettingsUi() {
    const settings = getSettings();

    // Профили подключения
    const $profile = $('#loom-profile');
    const profiles = listConnectionProfiles();
    $profile.html('<option value="">Главный API Таверны</option>'
        + profiles.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</option>`).join(''));

    // Профиль мог быть удалён или переименован — сверяемся по id, имя подтягиваем следом
    const known = profiles.find(p => p.id === settings.connection_profile_id)
        || profiles.find(p => p.name === settings.connection_profile);
    if (known) {
        settings.connection_profile_id = known.id;
        settings.connection_profile = known.name || known.id;
        $profile.val(known.id);
    } else {
        if (settings.connection_profile_id || settings.connection_profile) {
            console.warn(LOG, 'Сохранённый профиль подключения не найден — переключаемся на главный API.');
        }
        settings.connection_profile_id = '';
        settings.connection_profile = '';
        $profile.val('');
    }

    $('#loom-max-tokens').val(settings.max_tokens);
    $('#loom-max-tokens-val').text(settings.max_tokens || 'Авто');

    $('#loom-thinking-budget').val(settings.thinking_budget);
    $('#loom-reasoning-auto-parse').prop('checked', settings.reasoning_auto_parse !== false);
    $('#loom-reasoning-prefix').val(settings.reasoning_prefix);
    $('#loom-reasoning-suffix').val(settings.reasoning_suffix);
    $('#loom-start-reply-with').val(settings.start_reply_with);
    $('#loom-thinking-hint-enabled').prop('checked', settings.thinking_hint_enabled !== false);
    $('#loom-thinking-hint').val(settings.thinking_hint);
    $('#loom-thinking-plan-enabled').prop('checked', settings.thinking_plan_enabled !== false);
    $('#loom-thinking-plan-character').val(settings.thinking_plan_character);
    $('#loom-thinking-plan-lorebook').val(settings.thinking_plan_lorebook);
    $('#loom-thinking-plan-prompt').val(settings.thinking_plan_prompt);

    // Раньше язык был свободным текстом — сводим старые «russian»/«англ» к пунктам списка.
    const normalizeLanguage = (value, fallback) => {
        const v = String(value ?? '').trim().toLowerCase();
        if (!v) return fallback;
        if (/^(en|eng|english|англ)/.test(v)) return 'English';
        if (/^(ru|rus|russian|рус)/.test(v)) return 'русский';
        return fallback;
    };
    settings.output_language = normalizeLanguage(settings.output_language, 'русский');
    delete settings.prompt_output_language; // режим промпта теперь всегда пишет по-английски
    $('#loom-output-language').val(settings.output_language);
    $('#loom-style-prompt').val(settings.style_prompt);
    $('#loom-plot-mode').val(settings.plot_mode);
    $('#loom-plot-every').val(settings.plot_every);
    $('#loom-plot-remind').prop('checked', settings.plot_remind !== false);
    $('#loom-plot-role').val(settings.plot_role);
    $('#loom-plot-depth').val(settings.plot_depth ?? 0);
    $('#loom-plot-float-toggle').prop('checked', settings.plot_float !== false);
    $('#loom-launcher-place').val(settings.launcher_place === 'list' ? 'list' : 'wand');
    $('#loom-plot-float-size').val(settings.plot_float_size || 'compact');
    $('#loom-plot-bar-toggle').prop('checked', !!settings.plot_bar);
    $('#loom-plot-chatbtn-toggle').prop('checked', !!settings.plot_chatbtn);
    $('#loom-plot-wand-toggle').prop('checked', settings.plot_wand !== false);
    $('#loom-prompt-scenario-card').val(settings.prompt_scenario_card);
    $('#loom-prompt-first-mes').val(settings.prompt_first_mes);
    $('#loom-prompt-keys').val(settings.prompt_keys);
    $('#loom-prompt-plot').val(settings.prompt_plot);
    $('#loom-prompt-plot-pacing').val(settings.prompt_plot_pacing);
    $('#loom-translate-keep-names').prop('checked', settings.translate_keep_original_names !== false);
    $('#loom-rewrite-th').val(settings.rating_rewrite_threshold);
    $('#loom-rewrite-th-val').text(settings.rating_rewrite_threshold);
    $('#loom-keep-th').val(settings.rating_keep_threshold);
    $('#loom-keep-th-val').text(settings.rating_keep_threshold);

    $('#loom-regex-keys').prop('checked', settings.lorebook_regex_keys !== false);
    $('#loom-key-language').html(KEY_LANGUAGES.map(l =>
        `<option value="${l.id}">${escapeHtml(l.label)}</option>`).join(''))
        .val(settings.lorebook_key_language || 'auto');
    $('#loom-regex-flags').val(settings.lorebook_regex_flags);
    $('#loom-entry-word-count').val(settings.lorebook_default_word_count);
    $('#loom-entry-word-count-val').text(settings.lorebook_default_word_count);

    $('#loom-folders-enabled').prop('checked', settings.folders_tool_enabled === true);
    $('#loom-folders-dropdown-view').prop('checked', settings.folders_dropdown_view === true);
    $('#loom-folders-circles-view').prop('checked', settings.folders_circles_view === true);

    // Первая версия настройки цвета полей — заменена темами
    for (const key of ['field_tint', 'field_color', 'field_strength', 'custom_dropdowns']) delete settings[key];
    renderThemePicker();
    applyAppearance();

    renderFormatEditor('character');
    renderFormatEditor('persona');
    renderFormatEditor('lorebook');
    renderFormatEditor('prompt');
    renderFormatEditor('scenario');
    renderFormatEditor('preset');
    renderFormatEditor('analysis');
    saveSettings();
}

const FORMAT_KEY_BY_KIND = {
    lorebook: 'lorebook_format', persona: 'persona_format',
    prompt: 'prompt_format', scenario: 'scenario_format', character: 'character_format',
    preset: 'preset_format', analysis: 'analysis_format',
};
const FORMAT_PRESETS_KEY_BY_KIND = {
    lorebook: 'lorebook_format_presets', persona: 'persona_format_presets',
    prompt: 'prompt_format_presets', scenario: 'scenario_format_presets', character: 'character_format_presets',
    preset: 'preset_format_presets', analysis: 'analysis_format_presets',
};

function renderFormatEditor(kind) {
    const settings = getSettings();
    const list = settings[FORMAT_KEY_BY_KIND[kind]];

    const html = list.map((item, index) => `
        <div class="loom-format-item" data-kind="${kind}" data-index="${index}">
            <div class="loom-format-row">
                <label class="loom-check compact">
                    <input type="checkbox" class="loom-format-enabled" ${item.enabled !== false ? 'checked' : ''}>
                </label>
                <input type="text" class="loom-format-label" value="${escapeHtml(item.label)}" placeholder="Название пункта">
                <input type="text" class="loom-format-id" value="${escapeHtml(item.id)}" placeholder="ключ_json">
                ${kind === 'character' ? `
                <select class="loom-format-target">
                    ${CARD_TARGETS.map(t => `<option value="${t.value}" ${t.value === (item.target || 'description') ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('')}
                </select>
                <label class="loom-check compact" title="Не входит в «Сгенерировать»/«Переписать с оценками» карточки — у пункта своя кнопка «Написать» в отдельном блоке под карточкой">
                    <input type="checkbox" class="loom-format-scene" ${item.scene ? 'checked' : ''}>
                    <span>сцена</span>
                </label>` : ''}
                <button class="loom-icon-btn loom-format-up" title="Выше"><i class="fa-solid fa-chevron-up"></i></button>
                <button class="loom-icon-btn loom-format-down" title="Ниже"><i class="fa-solid fa-chevron-down"></i></button>
                <button class="loom-icon-btn loom-format-remove" title="Удалить"><i class="fa-solid fa-trash"></i></button>
            </div>
            <textarea class="loom-format-hint" rows="2" placeholder="Что должно быть в этом пункте — уходит модели">${escapeHtml(item.hint || '')}</textarea>
        </div>`).join('');

    $(`#loom-format-${kind}`).html(html || '<div class="loom-empty-note">Нет ни одного пункта.</div>');
    updateFormatCount(kind);
    renderPresetSelect(kind);
}

/** Число в заголовке блока формата: все пункты включены — «14», иначе «12 из 14». */
function updateFormatCount(kind) {
    const list = getSettings()[FORMAT_KEY_BY_KIND[kind]] || [];
    const enabled = list.filter(item => item.enabled !== false).length;
    $(`.loom-format-count[data-kind="${kind}"]`).text(
        enabled === list.length ? String(list.length) : `${enabled} из ${list.length}`);
}

function formatListOf(kind) {
    return getSettings()[FORMAT_KEY_BY_KIND[kind]];
}

// ─── Пресеты форматов ───────────────────────────────────────────────────────

const BUILTIN_PRESETS_BY_KIND = {
    lorebook: BUILTIN_LOREBOOK_PRESETS, persona: BUILTIN_PERSONA_PRESETS,
    prompt: BUILTIN_PROMPT_PRESETS, scenario: BUILTIN_SCENARIO_PRESETS, character: BUILTIN_CHARACTER_PRESETS,
    preset: BUILTIN_PRESET_PRESETS, analysis: BUILTIN_ANALYSIS_PRESETS,
};

function builtinPresetsOf(kind) {
    return BUILTIN_PRESETS_BY_KIND[kind];
}

function customPresetsOf(kind) {
    return getSettings()[FORMAT_PRESETS_KEY_BY_KIND[kind]];
}

/** Значение в списке, когда рабочие пункты не совпадают ни с одним пресетом. */
const CURRENT_OPTION = '__current__';

/** Пункты в сравнимом виде: только то, что влияет на генерацию и экспорт. */
function normalizedItems(list) {
    return JSON.stringify((list || []).map(item =>
        [item.id, item.label, item.hint || '', item.enabled !== false, item.target || '', !!item.scene]));
}

function allPresetsOf(kind) {
    return [...builtinPresetsOf(kind), ...customPresetsOf(kind)];
}

/**
 * Пресет, с которым рабочие пункты режима совпадают ровно, — или null, если они правлены и
 * не сохранены. Определяется сравнением, а не запоминанием «что выбрано»: так список пресетов
 * всегда показывает правду о том, что сейчас в редакторе, а не то, что нажималось последним.
 */
function activePresetOf(kind) {
    const current = normalizedItems(formatListOf(kind));
    return allPresetsOf(kind).find(preset => normalizedItems(preset.items) === current) || null;
}

/**
 * Список пресетов режима. Выбранный пункт — тот пресет, что сейчас открыт; если пункты
 * правили и не сохранили, первой строкой стоит «Текущие пункты» — встроенные пресеты от
 * правок не страдают, править можно только рабочую копию.
 */
function renderPresetSelect(kind) {
    const active = activePresetOf(kind);
    const options = [
        ...(active ? [] : [`<option value="${CURRENT_OPTION}">Текущие пункты (правили, не сохранены)</option>`]),
        ...builtinPresetsOf(kind).map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`),
        ...customPresetsOf(kind).map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (свой)</option>`),
    ];
    $(`.loom-preset-select[data-kind="${kind}"]`).html(options.join('')).val(active ? active.id : CURRENT_OPTION);

    // Встроенные пресеты не удаляются вовсе — кнопка неактивна, а не «нажала и получила ошибку»
    const deletable = !!active && !String(active.id).startsWith('builtin-');
    $(`.loom-preset-delete[data-kind="${kind}"]`)
        .prop('disabled', !deletable)
        .attr('title', deletable ? 'Удалить этот пресет'
            : active ? 'Встроенный пресет удалить нельзя' : 'Удалять нечего: пункты не сохранены как пресет');
}

/**
 * Сколько токенов ответа реально нужно набору пунктов.
 *
 * Формат влияет на объём ответа сильнее всего остального: «Полная карточка» — это
 * 14 пунктов по 3–5 абзацев каждый (formatContract требует эту разбивку по умолчанию),
 * дефолтные 4000 токенов её попросту обрежут (та же беда, что раньше рвала JSON на
 * полуслове). Оцениваем по числу включённых пунктов и поднимаем лимит, если текущий
 * заведомо мал для выбранного пресета.
 */
function suggestMaxTokens(items) {
    const enabled = items.filter(item => item.enabled !== false).length;
    return Math.min(16000, Math.max(4000, enabled * 1200));
}

function bindSettingsEvents() {
    const $settings = $('#loom-settings');

    $settings.on('click', '.loom-tab', function () {
        const tab = $(this).data('tab');
        $settings.find('.loom-tab').removeClass('active');
        $(this).addClass('active');
        $settings.find('.loom-tab-page').removeClass('active')
            .filter(`[data-page="${tab}"]`).addClass('active');
        // Вкладки — одна прокручиваемая строка: выбранную подводим в видимую область
        this.scrollIntoView?.({ inline: 'center', block: 'nearest' });
    });

    $('#loom-profile').on('change', function () {
        const settings = getSettings();
        const id = String($(this).val() || '');
        const profile = listConnectionProfiles().find(p => p.id === id);
        settings.connection_profile_id = profile ? profile.id : '';
        settings.connection_profile = profile ? (profile.name || profile.id) : '';
        saveSettings();
    });

    const bindValue = (selector, key, transform = v => v) => {
        $(selector).on('input change', function () {
            const settings = getSettings();
            settings[key] = transform($(this).is(':checkbox') ? $(this).is(':checked') : $(this).val());
            saveSettings();
        });
    };

    bindValue('#loom-thinking-budget', 'thinking_budget');
    bindValue('#loom-reasoning-auto-parse', 'reasoning_auto_parse');
    bindValue('#loom-reasoning-prefix', 'reasoning_prefix');
    bindValue('#loom-reasoning-suffix', 'reasoning_suffix');
    bindValue('#loom-start-reply-with', 'start_reply_with');
    bindValue('#loom-thinking-hint-enabled', 'thinking_hint_enabled');
    bindValue('#loom-thinking-hint', 'thinking_hint');
    bindValue('#loom-thinking-plan-enabled', 'thinking_plan_enabled');
    bindValue('#loom-thinking-plan-character', 'thinking_plan_character');
    bindValue('#loom-thinking-plan-lorebook', 'thinking_plan_lorebook');
    bindValue('#loom-thinking-plan-prompt', 'thinking_plan_prompt');
    bindValue('#loom-output-language', 'output_language');
    bindValue('#loom-style-prompt', 'style_prompt');
    bindValue('#loom-plot-mode', 'plot_mode');
    bindValue('#loom-plot-every', 'plot_every', v => Math.max(1, Math.min(50, Number(v) || 3)));
    bindValue('#loom-plot-remind', 'plot_remind');
    bindValue('#loom-plot-role', 'plot_role');
    bindValue('#loom-plot-depth', 'plot_depth', v => Math.max(0, Math.min(50, Math.floor(Number(v)) || 0)));
    bindValue('#loom-plot-float-toggle', 'plot_float');
    bindValue('#loom-launcher-place', 'launcher_place');
    $('#loom-launcher-place').on('change', () => injectLauncher());
    bindValue('#loom-plot-float-size', 'plot_float_size');
    bindValue('#loom-plot-bar-toggle', 'plot_bar');
    bindValue('#loom-plot-chatbtn-toggle', 'plot_chatbtn');
    bindValue('#loom-plot-wand-toggle', 'plot_wand');
    $('#loom-plot-float-toggle, #loom-plot-float-size, #loom-plot-bar-toggle, #loom-plot-chatbtn-toggle, #loom-plot-wand-toggle')
        .on('change', () => renderWidget());
    $('#loom-plot-float-reset').on('click', () => {
        getSettings().plot_float_pos = null;
        getSettings().plot_panel_pos = null;
        saveSettings();
        renderWidget();
        toast('success', 'Кнопка и окно сюжета на местах по умолчанию.');
    });
    bindValue('#loom-prompt-scenario-card', 'prompt_scenario_card');
    bindValue('#loom-prompt-first-mes', 'prompt_first_mes');
    bindValue('#loom-prompt-keys', 'prompt_keys');
    bindValue('#loom-prompt-plot', 'prompt_plot');
    bindValue('#loom-prompt-plot-pacing', 'prompt_plot_pacing');

    // «Вернуть по умолчанию» у длинных промптов (Форматы): исходный текст — из DEFAULT_SETTINGS
    const PROMPT_DEFAULTS = {
        'prompt-scenario-card': ['prompt_scenario_card', DEFAULT_PROMPT_SCENARIO_CARD],
        'prompt-first-mes': ['prompt_first_mes', DEFAULT_PROMPT_FIRST_MES],
        'prompt-keys': ['prompt_keys', DEFAULT_PROMPT_KEYS],
        'prompt-plot': ['prompt_plot', DEFAULT_PROMPT_PLOT],
        'prompt-plot-pacing': ['prompt_plot_pacing', DEFAULT_PROMPT_PLOT_PACING],
    };
    $('.loom-prompt-reset').on('click', async function () {
        const [key, fallback] = PROMPT_DEFAULTS[$(this).data('setting')] || [];
        if (!key) return;
        if (!await confirmAction('Вернуть исходный текст промпта? Ваши правки в нём пропадут.')) return;
        getSettings()[key] = fallback;
        saveSettings();
        $(`#loom-${$(this).data('setting')}`).val(fallback);
        toast('success', 'Промпт возвращён по умолчанию.');
    });
    bindValue('#loom-translate-keep-names', 'translate_keep_original_names');
    bindThemePicker();
    bindValue('#loom-regex-keys', 'lorebook_regex_keys');
    bindValue('#loom-key-language', 'lorebook_key_language');
    // Пустые флаги допустимы, мусорные — нет: RegExp упадёт уже на генерации
    // Повторы отсекаем здесь же, а не только при сборке ключа: new RegExp падает на
    // «ii», и тогда Таверна не распознаёт ни один ключ лорбука — молча и сразу все
    bindValue('#loom-regex-flags', 'lorebook_regex_flags',
        v => [...new Set(String(v).replace(/[^gimsuy]/g, ''))].join(''));

    // Немедленное сохранение, а не bindValue (там обычное отложенное, см.
    // saveSettingsImmediate в src/settings.js): галочка — редкое, осознанное
    // действие, и если сразу за ней перезагрузить страницу (на телефоне так и
    // делают), отложенное сохранение просто не успевает долететь до диска —
    // после перезагрузки настройка выглядит «сброшенной», хотя не сохранялась.
    $('#loom-folders-enabled').on('change', function () {
        const checked = $(this).is(':checked');
        getSettings().folders_tool_enabled = checked;
        applyFoldersCssClass(checked);
        saveSettingsImmediate();
    });
    $('#loom-folders-dropdown-view').on('change', function () {
        const checked = $(this).is(':checked');
        getSettings().folders_dropdown_view = checked;
        applyFolderDropdownCssClass(checked);
        saveSettingsImmediate();
    });

    $('#loom-folders-circles-view').on('change', function () {
        const checked = $(this).is(':checked');
        getSettings().folders_circles_view = checked;
        applyFolderCirclesCssClass(checked);
        saveSettingsImmediate();
    });

    $('#loom-max-tokens').on('input', function () {
        const settings = getSettings();
        settings.max_tokens = Number($(this).val());
        $('#loom-max-tokens-val').text(settings.max_tokens || 'Авто');
        saveSettings();
    });

    // Записи, которые идут за настройкой, — определяются ОДИН раз, в начале перетаскивания:
    // иначе ползунок, проходя через чужое значение (200 на пути от 300 к 150), захватил бы и его.
    let followers = null;
    $('#loom-entry-word-count').on('input', function () {
        const settings = getSettings();
        const next = Number($(this).val());
        if (!followers) {
            const base = Number(settings.lorebook_default_word_count) || 300;
            // Настройка — не только для НОВЫХ записей: за ней идут те, у кого ползунок стоит на прежнем
            // значении по умолчанию и кто не трогал его руками (wordCountManual).
            followers = listDrafts().flatMap(d => d.entries || [])
                .filter(e => !e.wordCountManual && Number(e.wordCount) === base);
        }
        settings.lorebook_default_word_count = next;
        followers.forEach(e => { e.wordCount = next; });
        $('#loom-entry-word-count-val').text(next);
        saveSettings();
    });

    // Отпустили ползунок — перерисовываем открытый черновик и говорим, что поменялось
    $('#loom-entry-word-count').on('change', function () {
        if (followers?.length) {
            const draft = currentDraft();
            if (draft && ENTRY_BASED_MODES.has(draft.mode)) renderMain();
            toast('info', `Объём записей по умолчанию: ${$(this).val()} слов. Обновлено записей: ${followers.length}. `
                + 'Записи с вручную выставленным объёмом не менялись.');
        }
        followers = null;
    });

    // Пороги не должны пересекаться: «сохранить» ниже «переписать» —
    // это состояние, в котором абзац одновременно эталон и брак
    $('#loom-rewrite-th').on('input', function () {
        const settings = getSettings();
        settings.rating_rewrite_threshold = Number($(this).val());
        if (settings.rating_keep_threshold <= settings.rating_rewrite_threshold) {
            settings.rating_keep_threshold = Math.min(10, settings.rating_rewrite_threshold + 1);
            $('#loom-keep-th').val(settings.rating_keep_threshold);
            $('#loom-keep-th-val').text(settings.rating_keep_threshold);
        }
        $('#loom-rewrite-th-val').text(settings.rating_rewrite_threshold);
        saveSettings();
    });

    $('#loom-keep-th').on('input', function () {
        const settings = getSettings();
        settings.rating_keep_threshold = Number($(this).val());
        if (settings.rating_keep_threshold <= settings.rating_rewrite_threshold) {
            settings.rating_rewrite_threshold = Math.max(1, settings.rating_keep_threshold - 1);
            $('#loom-rewrite-th').val(settings.rating_rewrite_threshold);
            $('#loom-rewrite-th-val').text(settings.rating_rewrite_threshold);
        }
        $('#loom-keep-th-val').text(settings.rating_keep_threshold);
        saveSettings();
    });

    // ─ Редактор форматов ─
    const formatItem = $element => {
        const $item = $element.closest('.loom-format-item');
        const kind = $item.data('kind');
        return { kind, index: Number($item.data('index')), list: formatListOf(kind) };
    };

    $settings.on('input change', '.loom-format-item input, .loom-format-item select, .loom-format-item textarea', function () {
        const { kind, list, index } = formatItem($(this));
        const item = list[index];
        if (!item) return;

        if ($(this).hasClass('loom-format-enabled')) {
            item.enabled = $(this).is(':checked');
            updateFormatCount(kind);   // список не перерисовывается — счётчик в заголовке обновляем сами
        }
        else if ($(this).hasClass('loom-format-label')) item.label = $(this).val();
        // Ключ уходит в JSON-контракт: пробелы и кириллица там регулярно ломают разбор
        else if ($(this).hasClass('loom-format-id')) item.id = String($(this).val()).trim().replace(/[^a-zA-Z0-9_]/g, '_');
        else if ($(this).hasClass('loom-format-target')) item.target = $(this).val();
        else if ($(this).hasClass('loom-format-scene')) item.scene = $(this).is(':checked');
        else if ($(this).hasClass('loom-format-hint')) item.hint = $(this).val();

        saveSettings();
        renderPresetSelect(kind);   // правка — значит, это уже не пресет, а «Текущие пункты»
    });

    $settings.on('click', '.loom-format-up, .loom-format-down, .loom-format-remove', function () {
        const { kind, index, list } = formatItem($(this));
        if ($(this).hasClass('loom-format-remove')) {
            list.splice(index, 1);
        } else {
            const target = $(this).hasClass('loom-format-up') ? index - 1 : index + 1;
            if (target < 0 || target >= list.length) return;
            [list[index], list[target]] = [list[target], list[index]];
        }
        saveSettings();
        renderFormatEditor(kind);
    });

    $settings.on('click', '.loom-format-add', function () {
        const kind = $(this).data('kind');
        formatListOf(kind).push({
            id: `field_${Date.now().toString(36).slice(-4)}`,
            label: 'Новый пункт',
            hint: '',
            target: 'description',
            enabled: true,
        });
        saveSettings();
        renderFormatEditor(kind);
    });

    // ─ Пресеты форматов ─
    // Пресет открывается сразу, как только выбран в списке. Рабочие пункты при этом
    // заменяются копией пресета: сам пресет (и встроенный тем более) при правках не меняется.
    function applyPreset(kind, preset) {
        const settings = getSettings();
        const items = structuredClone(preset.items);
        settings[FORMAT_KEY_BY_KIND[kind]] = items;

        // Тяжёлый пресет с дефолтным лимитом токенов рвёт JSON на полуслове —
        // та же беда, что мы уже чинили для ответов модели вообще
        const suggested = suggestMaxTokens(items);
        if (settings.max_tokens > 0 && settings.max_tokens < suggested) {
            settings.max_tokens = suggested;
            $('#loom-max-tokens').val(suggested);
            $('#loom-max-tokens-val').text(suggested);
            toast('info', `Лимит токенов ответа поднят до ${suggested} — у этого пресета много пунктов.`);
        }

        saveSettings();
        renderFormatEditor(kind);   // результат и так виден: выбран пресет, список пунктов сменился — без тоста
    }

    $settings.on('change', '.loom-preset-select', async function () {
        const kind = $(this).data('kind');
        const id = String($(this).val() || '');
        if (id === CURRENT_OPTION) return;

        const preset = allPresetsOf(kind).find(p => p.id === id);
        if (!preset) return renderPresetSelect(kind);

        // Правки, не сохранённые пресетом, при переключении потерялись бы — спрашиваем
        if (!activePresetOf(kind)) {
            const ok = await confirmAction(
                `Пункты правили и не сохраняли как пресет — при переключении они пропадут. Открыть «${preset.name}»?`);
            if (!ok) return renderPresetSelect(kind);
        }
        applyPreset(kind, preset);
    });

    $settings.on('click', '.loom-preset-save', async function () {
        const kind = $(this).data('kind');
        const name = String(await promptAction('Название пресета:', '') || '').trim();
        if (!name) return;

        if (builtinPresetsOf(kind).some(p => p.name.toLowerCase() === name.toLowerCase())) {
            return toast('error', 'Это имя занято встроенным пресетом — выберите другое.');
        }

        const settings = getSettings();
        const list = settings[FORMAT_PRESETS_KEY_BY_KIND[kind]];
        const items = structuredClone(formatListOf(kind));

        // Пресет с таким именем уже есть — обновляем его, а не плодим двойника
        const existing = list.find(p => p.name.toLowerCase() === name.toLowerCase());
        if (existing) {
            const ok = await confirmAction(`Пресет «${existing.name}» уже есть. Заменить его текущими пунктами?`);
            if (!ok) return;
            existing.items = items;
        } else {
            list.push({ id: uid(), name, items });
        }
        saveSettings();
        renderPresetSelect(kind);   // пункты теперь совпадают с сохранённым — он и выбран
        toast('success', `Пресет «${existing?.name || name}» сохранён.`);
    });

    $settings.on('click', '.loom-preset-delete', async function () {
        const kind = $(this).data('kind');
        const preset = activePresetOf(kind);
        if (!preset) return toast('info', 'Удалять нечего: пункты не сохранены как пресет.');
        if (String(preset.id).startsWith('builtin-')) return toast('error', 'Встроенный пресет удалить нельзя.');

        const settings = getSettings();
        const list = settings[FORMAT_PRESETS_KEY_BY_KIND[kind]];
        if (!list.includes(preset)) return;

        const ok = await confirmAction(`Удалить пресет «${preset.name}»? Пункты в списке останутся как есть.`);
        if (!ok) return;

        list.splice(list.indexOf(preset), 1);
        saveSettings();
        renderPresetSelect(kind);
        toast('success', `Пресет «${preset.name}» удалён.`);
    });

    // ─ Экспорт и импорт пресета — у каждого режима свои кнопки ─
    // Экспорт: ровно те пункты, что сейчас в списке. Открыт пресет — под его именем, правили —
    // «Текущие пункты». Режим и название зашиты в файл (см. src/format-presets.js).
    $settings.on('click', '.loom-preset-export', function () {
        const kind = $(this).data('kind');
        const active = activePresetOf(kind);
        const name = active ? active.name : `Текущие пункты — ${FORMAT_KIND_LABELS[kind]}`;
        downloadJson(buildFormatPresetFile([{ kind, name, items: formatListOf(kind) }]), formatPresetFileName(kind, name));
        toast('success', `Пресет «${name}» сохранён в файл (режим: ${FORMAT_KIND_LABELS[kind]}).`);
    });

    // Импорт: можно несколько файлов сразу. Пресет ложится в режим, записанный в файле, —
    // а если в файле режима нет, в тот, чья это кнопка.
    $settings.on('change', '.loom-preset-import', async function () {
        const blockKind = String($(this).data('kind'));
        const files = [...(this.files || [])];
        this.value = '';
        if (!files.length) return;

        const touched = new Map();   // режим → сколько пресетов добавлено
        const problems = [];
        for (const file of files) {
            try {
                const { presets, skipped } = parseFormatPresetFile(await file.text(), blockKind, file.name);
                for (const p of presets) {
                    const list = customPresetsOf(p.kind);
                    const taken = [...builtinPresetsOf(p.kind), ...list].map(x => x.name);
                    const added = { id: uid(), name: uniquePresetName(p.name, taken), items: p.items };
                    list.push(added);
                    touched.set(p.kind, (touched.get(p.kind) || 0) + 1);
                }
                skipped.forEach(text => problems.push(`${file.name}: ${text}`));
            } catch (error) {
                problems.push(`${file.name}: ${error.message || error}`);
            }
        }

        if (touched.size) {
            saveSettings();
            for (const kind of touched.keys()) renderPresetSelect(kind);
            const total = [...touched.values()].reduce((a, b) => a + b, 0);
            const other = [...touched.keys()].filter(kind => kind !== blockKind);
            const where = [...touched].map(([kind, n]) => `${FORMAT_KIND_LABELS[kind]}${n > 1 ? ` — ${n}` : ''}`).join(', ');
            toast('success', `Импортировано пресетов: ${total} (${where}).`
                + (other.length ? ' Часть легла в другой режим — так записано в файле.' : '')
                + ' Они в списках своих режимов — выберите нужный, и он откроется.');
        }
        if (problems.length) toast(touched.size ? 'warning' : 'error', `Не удалось прочитать: ${problems.join(' | ')}`);
    });

    $('#loom-format-reset').on('click', async () => {
        const ok = await confirmAction('Вернуть все форматы к значениям по умолчанию? Ваши правки пропадут.');
        if (!ok) return;
        const settings = getSettings();
        settings.character_format = structuredClone(DEFAULT_CHARACTER_FORMAT);
        settings.persona_format = structuredClone(DEFAULT_PERSONA_FORMAT);
        settings.lorebook_format = structuredClone(DEFAULT_LOREBOOK_FORMAT);
        settings.prompt_format = structuredClone(DEFAULT_PROMPT_FORMAT);
        settings.scenario_format = structuredClone(DEFAULT_SCENARIO_FORMAT);
        settings.preset_format = structuredClone(DEFAULT_PRESET_FORMAT);
        settings.analysis_format = structuredClone(DEFAULT_ANALYSIS_FORMAT);
        saveSettings();
        renderFormatEditor('character');
        renderFormatEditor('persona');
        renderFormatEditor('lorebook');
        // «Промпт» тут раньше не перерисовывался: сброс срабатывал в данных, но
        // видимая панель редактора обновлялась только при следующем открытии настроек.
        renderFormatEditor('prompt');
        renderFormatEditor('scenario');
        renderFormatEditor('preset');
        renderFormatEditor('analysis');
    });

    // ─ Проверка ключа ─
    const runKeyTest = () => {
        const key = String($('#loom-key-test-key').val()).trim();
        const text = String($('#loom-key-test-text').val());
        const $result = $('#loom-key-test-result');

        if (!key) return $result.removeClass('ok error').text('');

        const check = validateKey(key);
        if (!check.ok) return $result.removeClass('ok').addClass('error').text(check.error);

        if (!text) return $result.removeClass('error ok').text('Введите текст для проверки.');

        // Проверяем ровно тот ключ, что уйдёт в лорбук (compileKeys — тот же путь, что
        // и в exportLorebook), а не сырое слово. Раньше «больница» тут искалась голой
        // подстрокой и на «в больнице» отвечала «ни одного совпадения» — хотя собранный
        // из неё regex падежи ловит, и в Таверне ключ сработал бы.
        const compiled = compileKeys([key])[0] || key;
        const matches = testKey(compiled, text);
        // Сам шаблон не показываем — он в пару сотен символов и на телефоне только
        // забивает экран; хватает пометки, что проверено с учётом падежей
        const tested = compiled !== key ? ' (с учётом падежей — как уйдёт в лорбук)' : '';
        if (!matches.length) return $result.removeClass('ok').addClass('error').text(`Ни одного совпадения.${tested}`);
        $result.removeClass('error').addClass('ok')
            .text(`Совпадений: ${matches.length} — ${[...new Set(matches)].join(', ')}${tested}`);
    };
    $('#loom-key-test-key, #loom-key-test-text').on('input', runKeyTest);
}

// ─── Точка входа ────────────────────────────────────────────────────────────

function injectLauncher() {
    const place = getSettings().launcher_place === 'list' ? 'list' : 'wand';
    const open = () => {
        openPanel();
        $('#extensionsMenu').hide();
        $('#options').hide();
    };

    // «В списке расширений» — свой раздел в панели расширений Таверны, а не пункт палочки
    if (place === 'list') {
        $('#loom-launcher').remove();
        if ($('#loom-launcher-list').length) return;
        const $container = $('#extensions_settings2');
        if (!$container.length) return console.warn(LOG, 'Не нашлось списка расширений.');
        const $drawer = $(`
            <div id="loom-launcher-list" class="extension_container">
                <div class="inline-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header">
                        <b>LOOM</b>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down interactable" tabindex="0" role="button"></div>
                    </div>
                    <div class="inline-drawer-content">
                        <div class="menu_button menu_button_icon interactable" id="loom-launcher-list-btn" tabindex="0">
                            <i class="fa-solid fa-scroll"></i><span>Открыть LOOM</span>
                        </div>
                    </div>
                </div>
            </div>`);
        $drawer.find('#loom-launcher-list-btn').on('click', open);
        $container.append($drawer);
        return;
    }

    $('#loom-launcher-list').remove();
    if ($('#loom-launcher').length) return;

    const $button = $(`
        <div id="loom-launcher" class="list-group-item flex-container flexGap5 interactable" tabindex="0" title="Открыть LOOM">
            <i class="fa-solid fa-scroll"></i>
            <span>LOOM</span>
        </div>`);
    $button.on('click', open);

    // Меню волшебной палочки — каноничное место для расширений.
    // Если его нет (старая или урезанная сборка), падаем в общее меню опций.
    if ($('#extensionsMenu').length) $('#extensionsMenu').append($button);
    else if ($('#options .options-content').length) $('#options .options-content').append($button);
    else return console.warn(LOG, 'Не нашлось меню, куда встроить кнопку запуска.');

    console.log(LOG, 'Кнопка запуска встроена.');
}

/**
 * Таверна подключает style.css расширения статичной ссылкой без версии вовсе
 * (addExtensionStyle в scripts/extensions.js: link.href = url, без query-параметра)
 * и полагается на обычное HTTP-кэширование браузера. На части мобильных браузеров
 * и WebView-обёрток (запуск через лаунчер, не «чистый» Chrome) это означает, что
 * обновлённый CSS может не долетать до экрана даже после обычной перезагрузки
 * страницы — нужна полная чистка кэша сайта, о которой никто не подозревает,
 * когда правка «просто не подействовала». Раз в загрузку страницы принудительно
 * перезапрашиваем свой файл заново под новым URL (кэш по старому URL не помеха).
 */
async function bustOwnStyleCache() {
    const link = document.querySelector(`link[href*="/${EXTENSION_PATH}/style.css"]`);
    if (!link) return;
    const base = link.href.split('?')[0];
    // Версия — по отметке файла на сервере (ETag/Last-Modified): пока style.css не менялся, URL тот же
    // и браузер берёт его из кэша, а не качает заново при каждой загрузке страницы
    let version = '';
    try {
        const response = await fetch(base, { method: 'HEAD', cache: 'no-cache' });
        version = response.headers.get('etag') || response.headers.get('last-modified') || '';
    } catch { /* нет сети до сервера — ниже запасной вариант */ }
    link.href = `${base}?v=${version ? encodeURIComponent(version) : Date.now()}`;
}

/**
 * Связь с src/plot.js: он сам ничего про интерфейс LOOM не знает и только шлёт события.
 * Изменился прогресс — обновляем подсветку в списке и блок состояния открытого сюжета;
 * плавающая панель просит «открыть в LOOM» — открываем панель сразу на нужном черновике.
 */
function bindPlotEvents() {
    document.addEventListener('loom:plot-changed', () => {
        if (!$('#loom-backdrop').is(':visible')) return;
        renderDraftList();
        const draft = currentDraft();
        if (draft?.mode !== 'plot') return;
        $('#loom-main .loom-plot-status-wrap').html(renderPlotStatus(draft));
        const chatState = getPlotState();
        const bound = chatState?.draftId === draft.id;
        const pos = bound ? plotProgress(draft, chatState).step : -1;
        const leaves = plotLeaves(draft);
        const paint = ($el, range, numFallback) => {
            const mark = plotMark(range, pos, bound);
            const done = bound && pos >= range[1];
            $el.toggleClass('current', bound && pos >= range[0] && pos < range[1]).toggleClass('done', done);
            $el.find('> summary .loom-plot-num, > .loom-plot-sub-head .loom-plot-num').html(done ? '<i class="fa-solid fa-check"></i>' : numFallback);
            const $btn = $el.find('> summary .loom-plot-done-btn, > .loom-plot-sub-head .loom-plot-done-btn')
                .prop('disabled', !bound).attr('title', mark.title);
            $btn.toggleClass('is-done', mark.done).find('i').attr('class', `fa-solid ${mark.icon}`);
        };
        $('#loom-main .loom-plot-step').each(function () {
            const i = Number($(this).data('step'));
            const range = stepRange(leaves, i);
            paint($(this), range, String(i + 1));
            $(this).find('.loom-plot-sub').each(function () {
                const j = Number($(this).data('sub'));
                paint($(this), [range[0] + j, range[0] + j + 1], `${i + 1}.${j + 1}`);
            });
        });
    });

    document.addEventListener('loom:open-plot', async (event) => {
        await openPanel();
        const id = event.detail?.draftId;
        if (id && getDraft(id)) {
            state.draftId = id;
            renderDraftList();
            renderMain();
        }
    });
}

jQuery(async () => {
    bustOwnStyleCache();
    injectLauncher();
    // getSettings() докладывает недостающие дефолты и сам сохраняет их, если что-то добавилось
    const settings = getSettings();
    initCustomSelects();
    // Долгое нажатие вешается всегда — сама функция проверяет настройку в момент
    // нажатия, а не при старте, поэтому переключатель в настройках LOOM действует
    // сразу, без перезагрузки страницы.
    initFolderLongPress();
    initFolderIconObserver();
    initFolderDropdownIntercept();
    initPlot();
    bindPlotEvents();
    applyFoldersCssClass(settings.folders_tool_enabled === true);
    applyFolderDropdownCssClass(settings.folders_dropdown_view === true);
    applyFolderCirclesCssClass(settings.folders_circles_view === true);
    console.log(LOG, 'Расширение загружено.');
});
