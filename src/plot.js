/**
 * Сюжет: слежение за ходом ролевой прямо в чате.
 *
 * Черновик режима «Сюжет» (draft.steps) — цепочка шагов. Здесь — то, что происходит,
 * когда черновик ПРИВЯЗАН К ЧАТУ: состояние (какой шаг сейчас, какие ответы его двигали)
 * лежит в chat_metadata.loom_plot, то есть едет вместе с самим чатом и у каждого чата своё.
 *
 * Как узнаём, что шаг выполнен (plot_mode в настройках):
 *  - inline — раз в plot_every ответов в промпт чата на нулевой глубине вставляется просьба
 *    дописать в конец ответа метку <plot>done|continue</plot>. Ответ приходит вместе с
 *    постом, дополнительного запроса нет. Метку LOOM вырезает из сообщения сразу после
 *    получения, игрок её не читает;
 *  - request — после каждого plot_every-го ответа уходит отдельный короткий запрос-проверка;
 *  - manual — только кнопками (плавающая панель или редактор).
 *
 * Свайп и удаление: каждый ответ, двинувший сюжет, записывается в marks[номер сообщения]
 * = {base, swipes: {номер свайпа: шаг после}}. Свайп «отменяет» продвижение (шаг возвращается
 * к base), а возврат на уже сохранённый свайп применяет его продвижение обратно. Промпт
 * вставляется заново сам: решение «просить ли метку» считается по номеру ответа, а он у
 * пересозданного сообщения тот же.
 */

import { getSettings, saveSettings } from './settings.js';
import { getDraft } from './drafts.js';
import { callAI, parseJsonLoose } from './api.js';
import { plotTrackerText, plotCheckPrompt } from './prompts.js';

const LOG = '[LOOM]';
const PROMPT_KEY = 'LOOM_PLOT';
const META_KEY = 'loom_plot';
// extension_prompt_types.IN_CHAT и extension_prompt_roles — в контекст расширений не отдаются
const IN_CHAT = 1;
const ROLES = { system: 0, user: 1 };

const TAG_RE = /<plot>\s*(done|continue)\s*<\/plot>/gi;
const STRIP_RE = /[ \t]*\n?[ \t]*<plot>[\s\S]*?(?:<\/plot>|$)/gi;

/** {tag: просили ли метку в этом запросе} — между началом генерации и получением ответа. */
let pending = null;
let inited = false;

const ctx = () => SillyTavern.getContext();

// ─── Состояние чата ─────────────────────────────────────────────────────────

/** @returns {{draftId: string, step: number, marks: object}|null} состояние сюжета ТЕКУЩЕГО чата */
export function getPlotState() {
    const state = ctx().chatMetadata?.[META_KEY];
    return state && typeof state === 'object' ? state : null;
}

/** @returns {{state: object, draft: object}|null} null — чат без сюжета или черновик удалён */
export function currentPlot() {
    const state = getPlotState();
    if (!state) return null;
    const draft = getDraft(state.draftId);
    return draft && draft.mode === 'plot' ? { state, draft } : null;
}

/** Открыт ли чат, к которому вообще можно что-то привязать. */
export function isChatOpen() {
    const c = ctx();
    return !!c.chatId && (c.characterId !== undefined || !!c.groupId);
}

export const boundDraftId = () => getPlotState()?.draftId ?? null;

function commit() {
    ctx().saveMetadataDebounced?.();
    notify();
}

function notify() {
    document.dispatchEvent(new CustomEvent('loom:plot-changed'));
    renderWidget();
}

export function bindPlot(draftId) {
    const meta = ctx().chatMetadata;
    if (!meta) return false;
    meta[META_KEY] = { draftId, step: 0, marks: {} };
    commit();
    return true;
}

export function unbindPlot() {
    const meta = ctx().chatMetadata;
    if (meta) delete meta[META_KEY];
    commit();
}

/** Ручной переход — метки свайпов теряют смысл (шаг уже не «база плюс продвижение»), сбрасываем. */
export function setPlotStep(index) {
    const cp = currentPlot();
    if (!cp) return;
    cp.state.step = Math.max(0, Math.min(plotLeaves(cp.draft).length, index));
    cp.state.marks = {};
    commit();
}

export const advancePlot = () => { const cp = currentPlot(); if (cp) setPlotStep(cp.state.step + 1); };
export const backPlot = () => { const cp = currentPlot(); if (cp) setPlotStep(cp.state.step - 1); };

/**
 * Сюжет — дерево (шаг → подпункты), но ход в чате считается по ЛИСТЬЯМ: шаг без подпунктов —
 * один лист, шаг с подпунктами — по листу на каждый подпункт. state.step — сколько листьев
 * уже пройдено, а не номер шага верхнего уровня: так метки свайпов и ручные переходы остаются
 * одной арифметикой «база + продвижение», а у сюжета без подпунктов число не меняется вовсе.
 * @returns {Array<{step: object, stepIndex: number, node: object, subIndex: number|null}>}
 */
export function plotLeaves(draft) {
    const leaves = [];
    (draft.steps || []).forEach((step, stepIndex) => {
        const subs = Array.isArray(step.substeps) ? step.substeps : [];
        if (subs.length) subs.forEach((node, subIndex) => leaves.push({ step, stepIndex, node, subIndex }));
        else leaves.push({ step, stepIndex, node: step, subIndex: null });
    });
    return leaves;
}

/** Диапазон листьев [от, до) шага верхнего уровня — по нему видно, пройден он, идёт или впереди. */
export function stepRange(leaves, stepIndex) {
    const first = leaves.findIndex(l => l.stepIndex === stepIndex);
    if (first < 0) return [0, 0];
    let end = first;
    while (end < leaves.length && leaves[end].stepIndex === stepIndex) end++;
    return [first, end];
}

/** «3 из 8» (по листьям), текущий лист и признак, что арка пройдена. */
export function plotProgress(draft, state) {
    const leaves = plotLeaves(draft);
    const total = leaves.length;
    const step = Math.min(Number(state.step) || 0, total);
    const leaf = leaves[step] || null;
    // Для человека число — по шагам верхнего уровня, а не по листьям (подпункты не раздувают счёт)
    const stepTotal = (draft.steps || []).length;
    const finished = total > 0 && step >= total;
    const stepNo = finished ? stepTotal : (leaf ? leaf.stepIndex + 1 : 0);
    const stepsDone = finished ? stepTotal : (leaf ? leaf.stepIndex : 0);
    return { step, total, finished, leaves, leaf, stepTotal, stepNo, stepsDone };
}

// ─── Персонажи и персона из самого чата ─────────────────────────────────────

/**
 * Кто участвует в открытом чате — по данным САМОЙ Таверны (карточка персонажа, участники группы,
 * активная персона), а не по черновикам LOOM: привязывать сюжет к персонажам и персоне в LOOM
 * не нужно, чат уже знает, кто в нём.
 * @returns {{isGroup: boolean, characters: Array<{name: string, text: string}>, persona: {name: string, text: string}|null}}
 */
export function chatCast() {
    const c = ctx();
    const cardText = card => {
        const data = card?.data || card || {};
        return [data.description, data.personality, data.scenario]
            .map(x => String(x || '').trim()).filter(Boolean).join('\n').slice(0, 1500);
    };
    const list = [];
    if (c.groupId) {
        const group = c.groups?.find(g => String(g.id) === String(c.groupId));
        for (const avatar of group?.members || []) {
            const card = c.characters.find(x => x.avatar === avatar);
            if (card) list.push(card);
        }
    } else if (c.characterId !== undefined && c.characters?.[c.characterId]) {
        list.push(c.characters[c.characterId]);
    }
    const personaName = String(c.name1 || '').trim();
    const personaText = String(c.powerUserSettings?.persona_description || '').trim().slice(0, 1500);
    return {
        isGroup: !!c.groupId,
        characters: list.map(card => ({ name: String(card.name || '').trim(), text: cardText(card) })).filter(x => x.name),
        persona: personaName ? { name: personaName, text: personaText } : null,
    };
}

// ─── Вставка в промпт ───────────────────────────────────────────────────────

function assistantNumber(type) {
    const { chat } = ctx();
    const last = chat.length - 1;
    let count = 0;
    chat.forEach((m, i) => {
        if (i === 0 || m.is_user || m.is_system) return;
        // Свайп/перегенерация заменяют последнее сообщение — новый ответ получит его же номер
        if ((type === 'swipe' || type === 'regenerate') && i === last) return;
        count++;
    });
    return count + 1;
}

function clearPrompt() {
    ctx().setExtensionPrompt(PROMPT_KEY, '', IN_CHAT, 0);
}

function onGenerationStarted(type, _params, dryRun) {
    pending = null;
    clearPrompt();
    if (dryRun || ['quiet', 'impersonate', 'continue'].includes(type)) return;

    const cp = currentPlot();
    if (!cp) return;
    const { state, draft } = cp;
    const { step, total, finished, leaf } = plotProgress(draft, state);
    if (finished || !total || !leaf) return;

    const settings = getSettings();
    const every = Math.max(1, Number(settings.plot_every) || 3);
    const askTag = settings.plot_mode === 'inline' && assistantNumber(type) % every === 0;
    // pending отмечает «этот ответ — часть слежения» и без вставки (режим request проверяет по нему)
    pending = { askTag };
    if (!askTag && settings.plot_remind === false) return;

    // Кто сейчас говорит: в групповом чате Таверна перед каждой репликой выставляет name2 на того, чей ход
    const text = plotTrackerText(
        { ...leaf, subTotal: leaf.subIndex === null ? 0 : leaf.step.substeps.length },
        { index: leaf.stepIndex, total: draft.steps.length, askTag, speaker: String(ctx().name2 || '').trim() },
    );
    const depth = Math.max(0, Math.floor(Number(settings.plot_depth)) || 0);
    ctx().setExtensionPrompt(PROMPT_KEY, text, IN_CHAT, depth, false, ROLES[settings.plot_role] ?? 0);
}

// ─── Ответ модели ───────────────────────────────────────────────────────────

/** Продвижение шага ответом mesId: записывается в marks, чтобы свайп мог его отменить. */
function applyDone(mesId) {
    const cp = currentPlot();
    const message = ctx().chat[mesId];
    if (!cp || !message) return;
    const { state, draft } = cp;
    if (state.step >= plotLeaves(draft).length) return;

    state.marks ||= {};
    const mark = state.marks[mesId] ||= { base: state.step, swipes: {} };
    mark.swipes[message.swipe_id ?? 0] = mark.base + 1;
    state.step = mark.base + 1;
    commit();
}

async function onMessageReceived(mesId, type) {
    const wasPending = pending;
    pending = null;
    if (['first_message', 'impersonate', 'quiet'].includes(type)) return;

    const cp = currentPlot();
    const message = ctx().chat[mesId];
    if (!cp || !message || message.is_user || message.is_system) return;

    const original = String(message.mes || '');
    const tags = [...original.matchAll(TAG_RE)];
    const settings = getSettings();
    const every = Math.max(1, Number(settings.plot_every) || 3);

    // Сначала решение по сюжету, потом чистка текста: сбой при сохранении чата не должен
    // терять уже прочитанную метку
    if (wasPending?.askTag && tags.length && tags.at(-1)[1].toLowerCase() === 'done') applyDone(mesId);

    // Метку вырезаем всегда, пока сюжет привязан: даже не запрошенная, она игроку не нужна
    if (/<plot>/i.test(original)) {
        try {
            const clean = original.replace(STRIP_RE, '').trimEnd();
            message.mes = clean;
            if (Array.isArray(message.swipes) && message.swipes[message.swipe_id] != null) message.swipes[message.swipe_id] = clean;
            // MESSAGE_RECEIVED приходит ДО того, как Таверна нарисует сообщение: тогда текст уже
            // чистый и перерисовывать нечего (а updateMessageBlock по несуществующему элементу падает).
            // Элемент есть при стриминге — там метка уже успела показаться, обновляем.
            if (document.querySelector(`#chat .mes[mesid="${mesId}"]`)) ctx().updateMessageBlock(mesId, message);
            await ctx().saveChat();
        } catch (error) {
            console.warn(LOG, 'Не удалось вырезать метку сюжета из сообщения', error);
        }
    }

    if (settings.plot_mode === 'request' && mesId === ctx().chat.length - 1 && wasPending !== null) {
        const number = ctx().chat.filter((m, i) => i > 0 && i <= mesId && !m.is_user && !m.is_system).length;
        if (number % every === 0) runCheck(mesId).catch(e => console.warn(LOG, 'Проверка сюжета не удалась', e));
    }
}

/** Режим request: отдельный запрос «выполнен ли шаг» по последним сообщениям. */
async function runCheck(mesId) {
    const cp = currentPlot();
    if (!cp) return;
    const { chat } = ctx();
    const step = plotProgress(cp.draft, cp.state).leaf?.node;
    if (!step) return;

    const snapshot = chat[mesId].mes;
    const transcript = chat.slice(Math.max(0, mesId - 5), mesId + 1)
        .filter(m => !m.is_system)
        .map(m => `${m.name}: ${String(m.mes || '').slice(0, 1500)}`)
        .join('\n\n');
    const reply = await callAI(plotCheckPrompt(step, transcript), {
        system: 'You judge how far a roleplay has progressed along a plot. Answer with JSON only.',
        maxTokens: 300,
    });
    const parsed = parseJsonLoose(reply, 'done');
    // Пока ждали ответ, сообщение могли свайпнуть или удалить — тогда вердикт уже ни о чём
    if (parsed?.done === true && chat[mesId]?.mes === snapshot) applyDone(mesId);
}

// ─── Свайп и удаление ───────────────────────────────────────────────────────

function onSwiped(mesId) {
    const cp = currentPlot();
    const mark = cp?.state.marks?.[mesId];
    if (!mark) return;
    const swipeId = ctx().chat[mesId]?.swipe_id ?? 0;
    // Свайп с продвижением — применяем его; без — шаг как до этого сообщения («вернули назад»)
    cp.state.step = mark.swipes[swipeId] ?? mark.base;
    commit();
}

function onDeleted(newLength) {
    const cp = currentPlot();
    if (!cp?.state.marks) return;
    const bases = [];
    for (const key of Object.keys(cp.state.marks)) {
        if (Number(key) >= newLength) {
            bases.push(cp.state.marks[key].base);
            delete cp.state.marks[key];
        }
    }
    if (!bases.length) return;
    cp.state.step = Math.min(...bases);
    commit();
}

// ─── Плавающая панель ───────────────────────────────────────────────────────

let widget = null;
let widgetOpen = false;
// Список всех шагов в панели свёрнут по умолчанию: на телефоне он съедал весь экран
let listOpen = false;

function ensureWidget() {
    if (widget) return widget;
    widget = document.createElement('div');
    widget.id = 'loom-plot-float';
    widget.hidden = true;
    document.body.appendChild(widget);

    // Тянуть можно кнопку (двигается она) и шапку панели (двигается панель) — они независимы
    let drag = null;
    widget.addEventListener('pointerdown', (event) => {
        if (event.target.closest('button')) return;
        const pill = event.target.closest('.loom-plot-pill');
        const head = event.target.closest('.loom-pp-head');
        const target = pill ? widget : head ? widget.querySelector('.loom-pp') : null;
        if (!target) return;
        const rect = target.getBoundingClientRect();
        drag = { panel: !pill, dx: event.clientX - rect.left, dy: event.clientY - rect.top, x: event.clientX, y: event.clientY, moved: false };
        try { (pill || head).setPointerCapture(event.pointerId); } catch { /* синтетическое событие — без захвата */ }
    });
    widget.addEventListener('pointermove', (event) => {
        if (!drag) return;
        if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
        drag.moved = true;
        const x = event.clientX - drag.dx;
        const y = event.clientY - drag.dy;
        if (drag.panel) placePanel(x, y);
        else placeWidget(x, y);
    });
    widget.addEventListener('pointerup', () => {
        if (!drag) return;
        const { moved, panel } = drag;
        drag = null;
        if (moved) {
            const rect = (panel ? widget.querySelector('.loom-pp') : widget).getBoundingClientRect();
            getSettings()[panel ? 'plot_panel_pos' : 'plot_float_pos'] = { x: Math.round(rect.left), y: Math.round(rect.top) };
            saveSettings();
        } else if (!panel) {
            widgetOpen = !widgetOpen;
            renderWidget();
        }
    });

    widget.addEventListener('click', (event) => {
        const action = event.target.closest('[data-plot]')?.getAttribute('data-plot');
        if (!action) return;
        if (action === 'next') advancePlot();
        else if (action === 'back') backPlot();
        else if (action === 'close') togglePlotPanel(false);
        else if (action === 'list') {
            listOpen = !listOpen;
            renderWidget();
        }
        else if (action === 'open') {
            const draftId = boundDraftId();
            widgetOpen = false;
            renderWidget();
            document.dispatchEvent(new CustomEvent('loom:open-plot', { detail: { draftId } }));
        }
    });

    window.addEventListener('resize', () => {
        placeWidget();
        placePanel();
    });
    return widget;
}

/** Ставит панель в точку (в пределах окна); без аргументов — по сохранённой позиции или правый низ. */
/** Отступы безопасной зоны (вырез, статус-бар, полоска «домой»): кнопку и окно туда не ставим. */
let insetProbe = null;
function safeInsets() {
    if (!insetProbe) {
        insetProbe = document.createElement('div');
        insetProbe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;'
            + 'padding-top:var(--tt-inset-top, env(safe-area-inset-top, 0px));'
            + 'padding-right:var(--tt-inset-right, env(safe-area-inset-right, 0px));'
            + 'padding-bottom:var(--tt-viewport-bottom-inset, env(safe-area-inset-bottom, 0px));'
            + 'padding-left:var(--tt-inset-left, env(safe-area-inset-left, 0px));';
        document.body.appendChild(insetProbe);
    }
    const cs = getComputedStyle(insetProbe);
    return {
        top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0,
        bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0,
    };
}

/** Прижимает прямоугольник к экрану с учётом безопасной зоны. */
function clampToScreen(left, top, width, height) {
    const s = safeInsets();
    return [
        Math.max(4 + s.left, Math.min(window.innerWidth - width - 4 - s.right, left)),
        Math.max(4 + s.top, Math.min(window.innerHeight - height - 4 - s.bottom, top)),
    ];
}

function placeWidget(x, y) {
    if (!widget) return;
    if (widget.classList.contains('panel-only')) return;
    const saved = getSettings().plot_float_pos;
    const rect = widget.getBoundingClientRect();
    const width = rect.width || 60;
    const height = rect.height || 36;
    let left = x ?? saved?.x;
    let top = y ?? saved?.y;
    if (left === undefined || top === undefined) {
        left = window.innerWidth - width - 14;
        top = window.innerHeight - height - 110;
    }
    [left, top] = clampToScreen(left, top, width, height);
    widget.style.left = `${left}px`;
    widget.style.top = `${top}px`;
}

/** {{user}}/{{char}} → имена из чата: в панели читает человек, а не модель. */
function readable(text) {
    const value = String(text ?? '');
    try {
        return ctx().substituteParams?.(value) ?? value;
    } catch {
        return value;
    }
}

/**
 * Панель — отдельный fixed-слой: по умолчанию по центру экрана, после перетаскивания за шапку —
 * там, куда её поставили (plot_panel_pos). Кнопка при этом остаётся на своём месте.
 */
function placePanel(x, y) {
    const panel = widget?.querySelector('.loom-pp');
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const saved = getSettings().plot_panel_pos;
    let left = x ?? saved?.x;
    let top = y ?? saved?.y;
    if (left === undefined || top === undefined) {
        left = (window.innerWidth - rect.width) / 2;
        top = (window.innerHeight - rect.height) / 2;
    }
    [left, top] = clampToScreen(left, top, rect.width, rect.height);
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
}

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));

/** Цвета темы LOOM (--loom-*) живут на #loom-backdrop, а панель — вне него: переносим значения. */
function syncWidgetTheme(el) {
    const root = document.getElementById('loom-backdrop');
    if (!root) return;
    const computed = getComputedStyle(root);
    for (const name of ['--loom-bg', '--loom-text', '--loom-border', '--loom-accent']) {
        const value = computed.getPropertyValue(name).trim();
        if (value) el.style.setProperty(name, value);
    }
}

/** Открыть/закрыть панель шагов — из кнопки, полоски, значка у строки ввода и пункта меню. */
export function togglePlotPanel(force) {
    widgetOpen = force === undefined ? !widgetOpen : !!force;
    renderWidget();
}

/** Создаёт (или обновляет) вспомогательный элемент в чужом контейнере Таверны; html === null — убрать. */
function mountExtra(id, parentSelector, html, { tag = 'div', className = '', prepend = false, before = '' } = {}) {
    let el = document.getElementById(id);
    if (html === null) {
        el?.remove();
        return;
    }
    const parent = document.querySelector(parentSelector);
    if (!parent) return;
    if (!el) {
        el = document.createElement(tag);
        el.id = id;
        el.className = className;
        const ref = before ? parent.querySelector(before) : null;
        if (ref) parent.insertBefore(el, ref);
        else if (prepend) parent.prepend(el);
        else parent.appendChild(el);
    }
    if (el.innerHTML !== html) el.innerHTML = html;
}

export function renderWidget() {
    const el = ensureWidget();
    const settings = getSettings();
    const cp = currentPlot();
    const visible = !!cp && isChatOpen();
    const wantPill = visible && settings.plot_float !== false;

    if (!visible) widgetOpen = false;
    if (!(visible && settings.plot_bar)) mountExtra('loom-plot-bar', '#form_sheld', null);
    if (!(visible && settings.plot_chatbtn)) mountExtra('loom-plot-chatbtn', '#leftSendForm', null);
    if (!(visible && settings.plot_wand !== false)) mountExtra('loom-plot-wand', '#extensionsMenu', null);
    if (!visible) {
        el.hidden = true;
        return;
    }

    const { state, draft } = cp;
    const { step, total, finished, leaves, leaf, stepTotal, stepNo } = plotProgress(draft, state);
    const current = leaf?.node;
    const currentLabel = leaf ? (leaf.subIndex === null ? leaf.step.title : `${leaf.step.title} › ${leaf.node.title}`) : '';
    const shown = stepNo;
    const percent = total ? Math.round((step / total) * 100) : 0;

    // Вспомогательные места показа
    if (settings.plot_bar) {
        mountExtra('loom-plot-bar', '#form_sheld', `
            <span class="loom-plot-bar-main" data-plot-toggle title="Показать шаги сюжета">
                <i class="fa-solid fa-route"></i>
                <b>${finished ? 'Сюжет пройден' : `Сюжет ${shown}/${stepTotal}`}</b>
                <span>${finished ? '' : esc(currentLabel)}</span>
            </span>
            <button type="button" class="loom-plot-bar-next" data-plot-next ${finished ? 'disabled' : ''} title="Отметить пункт выполненным">
                <i class="fa-solid fa-check"></i></button>`,
        { className: 'loom-plot-bar', before: '#send_form' });
    }
    if (settings.plot_chatbtn) {
        mountExtra('loom-plot-chatbtn', '#leftSendForm', '<i class="fa-solid fa-route"></i>',
            { className: 'interactable loom-plot-chatbtn', prepend: false });
        const btn = document.getElementById('loom-plot-chatbtn');
        btn?.setAttribute('data-plot-toggle', '');
        btn?.setAttribute('title', finished ? 'Сюжет пройден' : `Сюжет ${shown}/${stepTotal}`);
        btn?.setAttribute('tabindex', '0');
    }
    if (settings.plot_wand !== false) {
        mountExtra('loom-plot-wand', '#extensionsMenu', `<i class="fa-solid fa-route"></i><span>Сюжет ${finished ? '— пройден' : `${shown}/${stepTotal}`}</span>`,
            { className: 'list-group-item flex-container flexGap5 interactable' });
        const wand = document.getElementById('loom-plot-wand');
        wand?.setAttribute('data-plot-toggle', '');
        wand?.setAttribute('tabindex', '0');
    }

    if (!wantPill && !widgetOpen) {
        el.hidden = true;
        return;
    }

    const state_ = (from, to) => (to <= step ? 'done' : from <= step ? 'current' : '');
    const icon = cls => (cls === 'done' ? 'fa-circle-check' : cls === 'current' ? 'fa-circle-play' : 'fa-circle');
    const list = draft.steps.map((s, i) => {
        const [from, to] = stepRange(leaves, i);
        const cls = state_(from, to);
        const subs = Array.isArray(s.substeps) && s.substeps.length
            ? `<ul class="loom-plot-sublist">${s.substeps.map((sub, j) => {
                const sc = state_(from + j, from + j + 1);
                return `<li class="${sc}"><i class="fa-solid ${icon(sc)}"></i><span>${esc(readable(sub.title) || `Подпункт ${j + 1}`)}</span></li>`;
            }).join('')}</ul>` : '';
        return `<li class="${cls}"><i class="fa-solid ${icon(cls)}"></i><span>${esc(readable(s.title) || `Шаг ${i + 1}`)}</span>${subs}</li>`;
    }).join('');

    const size = ['compact', 'big', 'dot'].includes(settings.plot_float_size) ? settings.plot_float_size : 'compact';
    el.hidden = false;
    el.className = `size-${size}${wantPill ? '' : ' panel-only'}${widgetOpen ? ' is-open' : ''}`;

    const pillTitle = `Сюжет: ${esc(currentLabel || 'пройден')}`;
    const pill = !wantPill ? '' : size === 'dot' ? `
        <div class="loom-plot-pill" title="${pillTitle}">
            <span class="loom-plot-pill-icon"><i class="fa-solid fa-route"></i></span>
            <span class="loom-plot-pill-badge">${finished ? '✓' : `${shown}/${stepTotal}`}</span>
        </div>` : `
        <div class="loom-plot-pill" title="${pillTitle}">
            <span class="loom-plot-pill-icon"><i class="fa-solid fa-route"></i></span>
            <span class="loom-plot-pill-text">
                <b>Сюжет ${finished ? "пройден" : `${shown}/${stepTotal}`}</b>
                <span>${esc(currentLabel || 'пройден')}</span>
                ${size === 'big' ? `<span class="loom-plot-pill-bar"><i style="width:${percent}%"></i></span>` : ''}
            </span>
        </div>`;

    const nowTitle = leaf ? (leaf.subIndex === null ? leaf.step.title : leaf.node.title) : '';
    const crumb = leaf && leaf.subIndex !== null
        ? `Шаг ${leaf.stepIndex + 1} · ${esc(readable(leaf.step.title))} · этап ${leaf.subIndex + 1}/${leaf.step.substeps.length}`
        : leaf ? `Шаг ${leaf.stepIndex + 1} из ${draft.steps.length}` : '';

    el.innerHTML = `
        ${widgetOpen ? `
        <div class="loom-pp">
            <div class="loom-pp-head">
                <span class="loom-pp-name">${esc(draft.name || 'Сюжет')}</span>
                <span class="loom-pp-count">${finished ? 'пройден' : `${shown}/${stepTotal}`}</span>
                <button type="button" class="loom-pp-x" data-plot="close" title="Закрыть"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="loom-pp-progress"><i style="width:${percent}%"></i></div>
            <div class="loom-pp-body">
                ${current ? `
                <div class="loom-pp-now">
                    <div class="loom-pp-crumb">${crumb}</div>
                    <div class="loom-pp-title">${esc(readable(nowTitle))}</div>
                    ${String(current.goal || leaf.step.goal || '').trim() ? `<div class="loom-pp-goal">${esc(readable(current.goal || leaf.step.goal))}</div>` : ''}
                    ${String(current.condition || '').trim() ? `
                    <div class="loom-pp-cond"><i class="fa-solid fa-flag-checkered"></i><span>${esc(readable(current.condition))}</span></div>` : ''}
                </div>` : '<div class="loom-pp-now"><div class="loom-pp-title">Сюжет пройден</div></div>'}
                <button type="button" class="loom-pp-listbtn" data-plot="list">
                    <i class="fa-solid fa-chevron-${listOpen ? 'up' : 'down'}"></i> ${listOpen ? 'Скрыть шаги' : 'Все шаги'}
                </button>
                ${listOpen ? `<ol class="loom-plot-list">${list}</ol>` : ''}
            </div>
            <div class="loom-pp-foot">
                <button type="button" data-plot="back" ${step <= 0 ? 'disabled' : ''} title="Шаг назад"><i class="fa-solid fa-rotate-left"></i></button>
                <button type="button" data-plot="open" title="Открыть в LOOM"><i class="fa-solid fa-pen"></i></button>
                <button type="button" class="loom-pp-done" data-plot="next" ${finished ? 'disabled' : ''} title="Отметить выполненным"><i class="fa-solid fa-check"></i> Выполнено</button>
            </div>
        </div>` : ''}${pill}`;
    syncWidgetTheme(el);
    placeWidget();
    placePanel();
}

// ─── Запуск ─────────────────────────────────────────────────────────────────

/** Идемпотентна: подписывается на события Таверны один раз. */
export function initPlot() {
    if (inited) return;
    inited = true;
    const { eventSource, eventTypes } = ctx();

    eventSource.on(eventTypes.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(eventTypes.GENERATION_STOPPED, () => { pending = null; clearPrompt(); });
    eventSource.on(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(eventTypes.MESSAGE_SWIPED, onSwiped);
    eventSource.on(eventTypes.MESSAGE_DELETED, onDeleted);
    eventSource.on(eventTypes.CHAT_CHANGED, () => { pending = null; clearPrompt(); widgetOpen = false; notify(); });

    // Полоска, значок у строки ввода и пункт меню живут в чужих контейнерах — ловим клики на документе
    document.addEventListener('click', (event) => {
        if (event.target.closest('[data-plot-next]')) {
            advancePlot();
            return;
        }
        if (event.target.closest('[data-plot-toggle]')) {
            togglePlotPanel();
            if (document.getElementById('extensionsMenu')?.contains(event.target)) $('#extensionsMenu').hide();
        }
    });
    // Панель без плавающей кнопки закрывается нажатием мимо неё
    document.addEventListener('pointerdown', (event) => {
        if (!widgetOpen || !widget?.classList.contains('panel-only')) return;
        if (event.target.closest('#loom-plot-float, [data-plot-toggle]')) return;
        togglePlotPanel(false);
    });

    renderWidget();
    console.log(LOG, 'Слежение за сюжетом готово.');
}
