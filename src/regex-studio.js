/**
 * Инфоблок с регексом: промпт + регекс-скрипт Таверны + живой предпросмотр.
 *
 * Идея: модель в конце ответа пишет служебный блок строго заданного вида
 * (<status>Время: …; Место: …</status>), а регекс-скрипт Таверны превращает его в чате
 * в оформленную HTML-карточку. Сам блок при этом остаётся в тексте сообщения — модель
 * видит его в истории и продолжает в том же формате.
 *
 * Здесь пишется всё сразу: инструкция модели (идёт в пресет или промпт), выражение и
 * замена для скрипта, пример ответа. Предпросмотр — тем же runRegexScript, что и в
 * Таверне, плюс messageFormatting, то есть ровно так, как сообщение будет выглядеть в чате.
 *
 * Состояние — в draft.regexStudio черновика, из которого открыли (пресет или промпт).
 */

import { runRegexScript } from '../../../regex/engine.js';
import { callAI, parseJsonLoose } from './api.js';

const LOG = '[LOOM]';
const ctx = () => SillyTavern.getContext();
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));

let overlay = null;
let current = null;  // { draft, onSave(draft), onAddPrompt(draft, studio) }
let busy = '';
let status = '';
let previewTimer = 0;

function studio() {
    const d = current.draft;
    d.regexStudio ||= {};
    const s = d.regexStudio;
    s.idea ??= '';
    s.look ??= '';
    s.fix ??= '';
    s.name ??= '';
    s.prompt ??= '';
    s.find ??= '';
    s.replace ??= '';
    s.sample ??= '';
    s.hideOld ??= true;
    return s;
}

function save() {
    current.onSave?.(current.draft);
}

// ─── Модель ─────────────────────────────────────────────────────────────────

const RULES = `Rules for the parts:
- "prompt": an instruction for the roleplay model, written in second person imperative. It tells the model to end EVERY reply
  with the block in EXACTLY this format (show the template with placeholders), on its own lines, after the prose. The block is
  data, not prose: short values, no commentary, values update to the current moment of the scene. Mention that the block
  is hidden/rendered by the interface, so the model must not refer to it in the story.
- "find": a JavaScript regex in the form /pattern/flags that matches the WHOLE block in a message. Use the "s" flag; tolerate
  extra spaces and line breaks between fields (\\s*); capture each value in a numbered group ($1, $2…). The tag names must be
  unusual enough to never appear in normal prose. Escape forward slashes inside the pattern as \\/.
- "replace": the HTML that replaces the block in the chat. ONE line, no blank lines, no markdown, no <style> or <script> -
  inline style="" only. Use $1, $2… for the captured values. Use theme variables so it fits light and dark themes:
  var(--SmartThemeBodyColor) for text, var(--SmartThemeQuoteColor) for accents,
  var(--SmartThemeBorderColor) for borders, color-mix(in srgb, var(--SmartThemeBodyColor) 6%, transparent) for panel
  backgrounds. Keep it compact and readable on a phone (max-width:100%, flex-wrap, small font). Font Awesome icons are
  available as <i class="fa-solid fa-…"></i>.
- "sample": a realistic example of ONE full model reply (2 short paragraphs of prose) that ends with a filled block.
- "name": a short script name, 2-4 words.`;

async function generate() {
    const s = studio();
    if (!s.idea.trim()) throw new Error('Опишите, какой инфоблок нужен.');
    const prompt = [
        'TASK: design an "info block" for SillyTavern roleplay chats: a structured block the model appends to each reply, '
            + 'plus a regex script that renders it as pretty HTML in the chat.',
        '',
        `WHAT THE USER WANTS IN THE BLOCK:\n${s.idea.trim()}`,
        s.look.trim() ? `\nHOW IT SHOULD LOOK:\n${s.look.trim()}` : '',
        '',
        RULES,
        '',
        'Write prompt, sample and labels in the same language as the user\'s request.',
        'Respond with JSON only: {"name": string, "prompt": string, "find": string, "replace": string, "sample": string}',
    ].join('\n');
    return ask(prompt);
}

async function refine() {
    const s = studio();
    if (!s.fix.trim()) throw new Error('Напишите, что поменять.');
    const prompt = [
        'TASK: revise this SillyTavern info block (prompt + regex + HTML) according to the user\'s request.',
        '',
        `USER REQUEST (OOC): ${s.fix.trim()}`,
        '',
        'CURRENT VERSION:',
        JSON.stringify({ name: s.name, prompt: s.prompt, find: s.find, replace: s.replace, sample: s.sample }, null, 2),
        '',
        'Change only what the request asks; keep the rest. If the block format changes, update prompt, find and sample together '
            + 'so they still match each other.',
        '',
        RULES,
        '',
        'Respond with JSON only: {"name": string, "prompt": string, "find": string, "replace": string, "sample": string}',
    ].join('\n');
    return ask(prompt);
}

async function ask(prompt) {
    const reply = await callAI(prompt, {
        system: 'You design SillyTavern prompts and regex scripts. You write valid JavaScript regex and compact HTML. Answer with JSON only.',
        maxTokens: 4000,
    });
    const parsed = parseJsonLoose(reply, 'find');
    if (!parsed?.find) throw new Error('Модель не вернула регекс.');
    const s = studio();
    for (const key of ['name', 'prompt', 'find', 'replace', 'sample']) {
        if (typeof parsed[key] === 'string' && parsed[key].trim()) s[key] = parsed[key].trim();
    }
    s.replace = s.replace.replace(/\s*\n\s*/g, ' ');
    save();
    const check = applyRegex(s);
    return check.error ? `Готово, но регекс с ошибкой: ${check.error}` : check.matched ? 'Готово.' : 'Готово, но регекс не нашёл блок в примере — поправьте выражение или пример.';
}

// ─── Регекс и предпросмотр ──────────────────────────────────────────────────

function script(s, extra = {}) {
    return {
        id: ctx().uuidv4?.() || String(Date.now()),
        scriptName: s.name || 'LOOM инфоблок',
        findRegex: s.find,
        replaceString: s.replace,
        trimStrings: [],
        placement: [2],
        disabled: false,
        markdownOnly: true,
        promptOnly: false,
        runOnEdit: true,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
        ...extra,
    };
}

/** @returns {{html: string, matched: boolean, error: string}} */
function applyRegex(s) {
    const pattern = String(s.find || '').trim();
    if (!pattern) return { html: '', matched: false, error: '' };
    const parts = pattern.match(/^\/([\s\S]+)\/([dgimsuvy]*)$/);
    try {
        // eslint-disable-next-line no-new
        new RegExp(parts ? parts[1] : pattern, parts ? parts[2] : '');
    } catch (e) {
        return { html: '', matched: false, error: e.message };
    }
    const out = runRegexScript(script(s), s.sample || '');
    return { html: out, matched: out !== (s.sample || ''), error: '' };
}

function renderPreview() {
    const box = overlay?.querySelector('.loom-rx-preview');
    const info = overlay?.querySelector('.loom-rx-check');
    if (!box) return;
    const s = studio();
    const { html, matched, error } = applyRegex(s);
    if (info) {
        info.textContent = error ? `Ошибка в выражении: ${error}` : !s.find ? '' : matched ? 'Блок найден и заменён' : 'Выражение не нашло блок в примере';
        info.className = `loom-rx-check ${error || (s.find && !matched) ? 'bad' : 'ok'}`;
    }
    const text = html || s.sample || '';
    let rendered;
    try {
        rendered = ctx().messageFormatting(text, ctx().name2 || 'Character', false, false, null);
    } catch (e) {
        console.warn(LOG, 'предпросмотр', e);
        rendered = esc(text).replace(/\n/g, '<br>');
    }
    box.innerHTML = `<div class="mes_text">${rendered}</div>`;
}

function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 150);
}

// ─── Сохранение в Таверну ───────────────────────────────────────────────────

function saveToTavern() {
    const s = studio();
    const check = applyRegex(s);
    if (check.error) throw new Error(`Ошибка в выражении: ${check.error}`);
    if (!s.find || !s.replace) throw new Error('Нужны выражение и замена.');
    const c = ctx();
    c.extensionSettings.regex ||= [];
    const list = c.extensionSettings.regex;
    const name = s.name || 'LOOM инфоблок';
    const upsert = (scriptName, data) => {
        const i = list.findIndex(x => x.scriptName === scriptName);
        if (i === -1) list.push(script(s, { scriptName, ...data }));
        else list[i] = { ...list[i], ...script(s, { scriptName, ...data }), id: list[i].id };
    };
    upsert(name, {});
    const hideName = `${name} — скрыть старые`;
    if (s.hideOld) {
        // Старые блоки модели не нужны: в промпт уходит только последний, остальные вырезаются
        upsert(hideName, { replaceString: '', markdownOnly: false, promptOnly: true, minDepth: 2 });
    } else {
        const i = list.findIndex(x => x.scriptName === hideName);
        if (i !== -1) list.splice(i, 1);
    }
    c.saveSettingsDebounced();
    return `Скрипт «${name}» сохранён в глобальные регексы Таверны.${s.hideOld ? ' Старые блоки не уйдут модели.' : ''}`;
}

// ─── Окно ───────────────────────────────────────────────────────────────────

function render() {
    if (!overlay) return;
    const s = studio();
    const scroll = overlay.querySelector('.loom-mem-body')?.scrollTop || 0;
    overlay.innerHTML = `
        <div class="loom-mem-panel ${busy ? 'busy' : ''}">
            <header class="loom-mem-top">
                <i class="fa-solid fa-code"></i>
                <div class="loom-mem-titles"><b>Инфоблок с регексом</b><span>${esc(current.draft.name || '')}</span></div>
                <button type="button" class="loom-icon-btn" data-rx="close" title="Закрыть"><i class="fa-solid fa-xmark"></i></button>
            </header>
            ${busy || status ? `<div class="loom-mem-status">${busy ? '<i class="fa-solid fa-spinner fa-spin"></i> ' : ''}${esc(busy || status)}</div>` : ''}
            <div class="loom-mem-body">
                <section class="loom-mem-card">
                    <h4><i class="fa-solid fa-lightbulb"></i> Что показывать</h4>
                    <textarea class="text_pole" data-field="idea" rows="3" placeholder="Например: статус-бар — дата, время, место, погода, настроение {{char}}, что на нём надето">${esc(s.idea)}</textarea>
                    <textarea class="text_pole" data-field="look" rows="2" placeholder="Как выглядит (необязательно): тёмная карточка с иконками, как HUD в игре…">${esc(s.look)}</textarea>
                    <button type="button" class="loom-btn loom-btn-primary loom-mem-wide" data-rx="generate">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> ${s.find ? 'Сделать заново' : 'Сделать'}
                    </button>
                </section>

                <section class="loom-mem-card">
                    <h4><i class="fa-solid fa-eye"></i> Как будет в чате <span class="loom-rx-check"></span></h4>
                    <div class="loom-rx-preview"></div>
                    <textarea class="text_pole loom-rx-code" data-field="sample" rows="5" placeholder="Пример ответа модели с блоком — меняйте, предпросмотр обновится">${esc(s.sample)}</textarea>
                </section>

                ${s.find || s.prompt ? `
                <section class="loom-mem-card">
                    <h4><i class="fa-solid fa-comment-dots"></i> OOC: доработать</h4>
                    <textarea class="text_pole" data-field="fix" rows="2" placeholder="Например: добавь поле «Деньги», сделай компактнее, иконки вместо подписей">${esc(s.fix)}</textarea>
                    <button type="button" class="loom-btn loom-btn-accent loom-mem-wide" data-rx="refine"><i class="fa-solid fa-pen-nib"></i> Доработать</button>
                </section>` : ''}

                <section class="loom-mem-card">
                    <h4><i class="fa-solid fa-terminal"></i> Промпт для модели</h4>
                    <textarea class="text_pole" data-field="prompt" rows="6" placeholder="Инструкция: в конце каждого ответа выводи блок…">${esc(s.prompt)}</textarea>
                    <div class="loom-mem-row">
                        <button type="button" class="loom-btn loom-btn-primary" data-rx="add-prompt"><i class="fa-solid fa-plus"></i> ${esc(current.addLabel)}</button>
                        <button type="button" class="loom-btn loom-btn-ghost" data-rx="copy-prompt"><i class="fa-solid fa-copy"></i> Копировать</button>
                    </div>
                </section>

                <section class="loom-mem-card">
                    <h4><i class="fa-solid fa-code"></i> Регекс-скрипт</h4>
                    <input type="text" class="text_pole" data-field="name" value="${esc(s.name)}" placeholder="Название скрипта">
                    <input type="text" class="text_pole loom-rx-code" data-field="find" value="${esc(s.find)}" placeholder="/<status>([\\s\\S]*?)<\\/status>/s">
                    <textarea class="text_pole loom-rx-code" data-field="replace" rows="5" placeholder="HTML замены, $1 $2 — найденные значения">${esc(s.replace)}</textarea>
                    <label class="loom-mem-switch"><input type="checkbox" data-field="hideOld" ${s.hideOld ? 'checked' : ''}>
                        <span>Не слать модели старые блоки (экономит токены, последний остаётся)</span></label>
                    <button type="button" class="loom-btn loom-btn-accent loom-mem-wide" data-rx="save-regex"><i class="fa-solid fa-floppy-disk"></i> Сохранить регекс в Таверну</button>
                    <div class="loom-mem-dim">В глобальные регексы, только для отображения. Повторное сохранение обновит тот же скрипт по названию.</div>
                </section>
            </div>
        </div>`;
    const body = overlay.querySelector('.loom-mem-body');
    if (body) body.scrollTop = scroll;
    renderPreview();
}

async function run(label, fn) {
    if (busy) return;
    busy = label;
    status = '';
    render();
    try {
        status = await fn();
    } catch (error) {
        console.error(LOG, 'Инфоблок', error);
        status = error?.message || String(error);
    } finally {
        busy = '';
    }
    render();
}

function onInput(event) {
    const field = event.target.dataset?.field;
    if (!field) return;
    const s = studio();
    s[field] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    save();
    if (['find', 'replace', 'sample', 'name'].includes(field)) schedulePreview();
}

async function onClick(event) {
    const t = event.target.closest('[data-rx]');
    if (!t || (busy && t.dataset.rx !== 'close')) return;
    const s = studio();
    switch (t.dataset.rx) {
        case 'close': return closeRegexStudio();
        case 'generate': return run('Придумываю блок и регекс…', generate);
        case 'refine': return run('Дорабатываю…', async () => { const r = await refine(); s.fix = ''; save(); return r; });
        case 'save-regex': return run('Сохраняю…', async () => saveToTavern());
        case 'copy-prompt':
            try { await navigator.clipboard.writeText(s.prompt); status = 'Промпт скопирован.'; } catch { status = 'Браузер не дал скопировать.'; }
            return render();
        case 'add-prompt':
            if (!s.prompt.trim()) { status = 'Промпт пустой.'; return render(); }
            status = current.onAddPrompt(current.draft, s) || 'Добавлено.';
            return render();
    }
}

/**
 * @param {object} draft черновик пресета или промпта
 * @param {{addLabel: string, onAddPrompt: Function, onSave: Function}} options
 */
export function openRegexStudio(draft, options) {
    current = { draft, ...options };
    status = '';
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'loom-rx';
        overlay.addEventListener('input', onInput);
        overlay.addEventListener('change', onInput);
        overlay.addEventListener('click', onClick);
        document.body.appendChild(overlay);
    }
    render();
}

export function closeRegexStudio() {
    overlay?.remove();
    overlay = null;
    current?.onClose?.();
    current = null;
}
