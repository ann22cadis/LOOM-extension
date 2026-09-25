/**
 * Внешний вид панели: темы и собственные выпадающие списки.
 *
 * Тема — это пять цветов: фон панели, текст, акцент, рамки и поля ввода. Остальные оттенки
 * (подложки, приглушённый текст, подсветка) панель считает от них сама. Помимо пяти готовых
 * тем есть «Как в Таверне» (цвета берутся из активной темы Таверны — так панель выглядела
 * всегда) и «Свой» набор.
 *
 * Обычный <select> раскрывается системным окном — его рисует браузер или ОС, и ни цвета
 * темы, ни скруглений в нём не задать (у Таверны те же острые прямоугольники). Поэтому
 * клик по <select> внутри панели перехватывается, а вместо системного списка показывается
 * свой. Сам <select> остаётся настоящим: значение пишется в него, а событие change
 * идёт как обычно, так что весь остальной код панели о подмене не знает.
 */

import { getSettings, saveSettings } from './settings.js';

/** Цвета темы: фон панели, текст, акцент (кнопки, подсветка), рамки, поля ввода, сердечки и удаление. */
const COLOR_KEYS = [
    { key: 'bg', label: 'Фон панели' },
    { key: 'text', label: 'Текст' },
    { key: 'accent', label: 'Акцент' },
    { key: 'border', label: 'Рамки' },
    { key: 'field', label: 'Поля ввода' },
    { key: 'heart', label: 'Сердечки и удаление' },
];

/** Готовые темы. Две светлые, три тёмные; акцент везде достаточно светлый для тёмной надписи на кнопках. */
export const THEMES = [
    { id: 'sakura', name: 'Сакура', colors: { bg: '#fff6f7', text: '#6b4e54', accent: '#f4a4a8', border: '#f8c8cb', field: '#f6e4e6', heart: '#e0566b' } },
    { id: 'lavender', name: 'Лаванда', colors: { bg: '#f7f4fc', text: '#453a5c', accent: '#a58ae0', border: '#dcd2f0', field: '#ebe5f7', heart: '#cf5fa0' } },
    { id: 'midnight', name: 'Полночь', colors: { bg: '#12141d', text: '#e4e7f2', accent: '#7fa6f8', border: '#2b3148', field: '#1e2233', heart: '#ff7b93' } },
    { id: 'graphite', name: 'Графит', colors: { bg: '#18181b', text: '#e8e8ea', accent: '#c9a86a', border: '#2f2f35', field: '#26262b', heart: '#e0776a' } },
    { id: 'forest', name: 'Лес', colors: { bg: '#0f1a14', text: '#e2ede6', accent: '#7fcaa0', border: '#254034', field: '#1a2b21', heart: '#e58a72' } },
];

const HEX = /^#[0-9a-f]{6}$/i;

/** Свой набор с проверкой каждого цвета: битое значение из настроек не должно ронять всю тему. */
function sanitizeColors(colors, fallback) {
    const result = {};
    for (const { key } of COLOR_KEYS) {
        result[key] = HEX.test(String(colors?.[key])) ? colors[key] : fallback[key];
    }
    return result;
}

/** @returns {{bg: string, text: string, accent: string, border: string, field: string, heart: string}|null} null — «Как в Таверне» */
function themeColors(settings) {
    if (settings.theme === 'custom') return sanitizeColors(settings.theme_custom, THEMES[0].colors);
    return THEMES.find(theme => theme.id === settings.theme)?.colors || null;
}

/** Относительная яркость цвета (0 — чёрный, 1 — белый): по ней выбирается тёмная или светлая надпись и схема. */
function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const THEME_PROPS = [
    '--loom-bg', '--loom-text', '--loom-accent', '--loom-border', '--loom-surface',
    '--loom-surface-hover', '--loom-surface-strong', '--loom-text-dim', '--loom-on-accent', '--loom-heart', '--loom-field', '--loom-field-border',
];

/** Любой CSS-цвет → [r, g, b, a] через вычисленный стиль браузера. */
function parseColor(value) {
    const probe = document.createElement('i');
    probe.style.color = value;
    if (!probe.style.color) return null;
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    const nums = computed.match(/[\d.]+/g)?.map(Number) || [];
    if (nums.length < 3) return null;
    return [nums[0], nums[1], nums[2], nums.length > 3 ? nums[3] : 1];
}

const toHex = ([r, g, b]) => '#' + [r, g, b].map(x => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
/** Смесь двух цветов: доля share второго. */
const mix = (a, b, share) => [0, 1, 2].map(i => a[i] * (1 - share) + b[i] * share);

/**
 * «Как в Таверне»: палитра из переменных её активной темы. Фон у Таверны часто полупрозрачный
 * (под ним размытие) — у LOOM размытия нет, поэтому делаем его плотным: накладываем на светлую
 * или тёмную основу в зависимости от цвета текста. Поля — лёгкая примесь текста к фону, без акцента.
 */
function tavernColors() {
    const css = getComputedStyle(document.documentElement);
    const read = (name) => parseColor(css.getPropertyValue(name).trim());
    const text = read('--SmartThemeBodyColor') || [232, 232, 234, 1];
    const darkText = luminance(toHex(text)) < 0.4;
    const base = darkText ? [250, 250, 250] : [22, 23, 28];
    const tint = read('--SmartThemeBlurTintColor');
    const bg = tint ? mix(base, tint, tint[3]) : base;
    let accent = read('--SmartThemeQuoteColor');
    if (!accent || accent[3] < 0.3) accent = read('--SmartThemeUnderlineColor') || [201, 168, 106, 1];
    const borderRaw = read('--SmartThemeBorderColor');
    let border = borderRaw ? mix(bg, borderRaw, Math.max(0.35, borderRaw[3])) : null;
    // Рамка темы почти сливается с фоном (часто чёрная на тёмном) — берём примесь текста
    if (!border || Math.abs(luminance(toHex(border)) - luminance(toHex(bg))) < 0.02) border = mix(bg, text, 0.16);
    return {
        bg: toHex(bg),
        text: toHex(text),
        accent: toHex(mix(bg, accent, accent[3])),
        border: toHex(border),
        field: toHex(mix(bg, text, darkText ? 0.05 : 0.07)),
        heart: '#e0566b',
    };
}

/** Применяет тему к панели — вызывается при открытии и при любом изменении настроек. */
export function applyAppearance() {
    const root = document.getElementById('loom-backdrop');
    if (!root) return;
    const settings = getSettings();
    const colors = themeColors(settings) || tavernColors();
    // Поля — нейтральные у всех тем: цвет темы у них давал розовые/цветные плашки. Только «Свой»
    // набор берёт поле как есть: там его выбрали руками
    const parse = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    const darkBg = luminance(colors.bg) < 0.4;
    const neutral = share => toHex(mix(parse(colors.bg), parse(colors.text), share));
    const field = settings.theme === 'custom' ? colors.field : neutral(darkBg ? 0.07 : 0.045);
    const fieldBorder = neutral(darkBg ? 0.16 : 0.13);

    const set = (prop, value) => root.style.setProperty(prop, value);
    set('--loom-bg', colors.bg);
    set('--loom-text', colors.text);
    set('--loom-accent', colors.accent);
    set('--loom-border', colors.border);
    // Подложки — примесь цвета текста, как и в теме Таверны: он контрастен фону в любую сторону
    set('--loom-surface', `color-mix(in srgb, ${colors.text} 4%, transparent)`);
    set('--loom-surface-hover', `color-mix(in srgb, ${colors.text} 8%, transparent)`);
    set('--loom-surface-strong', field);
    set('--loom-field', field);
    set('--loom-field-border', fieldBorder);
    set('--loom-heart', colors.heart);
    set('--loom-text-dim', `color-mix(in srgb, ${colors.text} 55%, transparent)`);
    // Надпись на акцентной кнопке: тёмная на светлом акценте и светлая на тёмном
    set('--loom-on-accent', luminance(colors.accent) > 0.4 ? `color-mix(in srgb, ${colors.accent} 28%, #000)` : '#fff');
    // Родные элементы (полосы прокрутки, поле выбора цвета) рисуются под схему фона
    root.style.setProperty('color-scheme', luminance(colors.bg) < 0.4 ? 'dark' : 'light');
    root.classList.add('loom-themed');
}

// ─── Настройки темы ─────────────────────────────────────────────────────────

/** Плитка темы: полоски фона, поля, акцента и текста — по ним видно, как она выглядит. */
function tileHtml(id, name, background, active) {
    return `
        <button type="button" class="loom-theme-tile ${active ? 'active' : ''}" data-theme="${id}">
            <span class="loom-theme-swatch" style="background: ${background}"></span>
            <span class="loom-theme-name">${name}</span>
        </button>`;
}

const swatchGradient = colors => `linear-gradient(90deg, ${colors.bg} 0 34%, ${colors.field} 34% 56%, ${colors.accent} 56% 78%, ${colors.text} 78%)`;

/** Рисует вкладку «Тема»: плитки и, для «Свой», выбор пяти цветов. */
export function renderThemePicker() {
    const $box = $('#loom-theme-picker');
    if (!$box.length) return;
    // Перерисовка убирает из DOM все кружки цвета — открытый над одним из них попап
    // остался бы висеть без хозяина
    closeColorPicker();
    const settings = getSettings();
    const current = settings.theme || 'tavern';

    const tiles = [
        tileHtml('tavern', 'Как в Таверне',
            'linear-gradient(135deg, var(--SmartThemeBlurTintColor, #16171c) 50%, var(--SmartThemeQuoteColor, #c9a86a) 50%)',
            current === 'tavern'),
        ...THEMES.map(theme => tileHtml(theme.id, theme.name, swatchGradient(theme.colors), current === theme.id)),
        tileHtml('custom', 'Свой', swatchGradient(sanitizeColors(settings.theme_custom, THEMES[0].colors)), current === 'custom'),
    ].join('');

    let custom = '';
    if (current === 'custom') {
        const colors = sanitizeColors(settings.theme_custom, THEMES[0].colors);
        custom = `
            <div class="loom-theme-custom">
                <div class="loom-theme-colors">
                    ${COLOR_KEYS.map(({ key, label }) => `
                    <div class="loom-theme-color">
                        <button type="button" class="loom-swatch-btn" data-key="${key}"
                            style="background: ${colors[key]}" aria-label="${label}: ${colors[key]}"></button>
                        <span>${label}</span>
                    </div>`).join('')}
                </div>
                <label class="loom-field">
                    <span class="loom-label">Взять за основу</span>
                    <select class="loom-theme-base">
                        <option value="">Выберите тему…</option>
                        ${THEMES.map(theme => `<option value="${theme.id}">${theme.name}</option>`).join('')}
                    </select>
                </label>
            </div>`;
    }

    $box.html(`<div class="loom-theme-grid">${tiles}</div>${custom}`);
}

/** Последняя выбранная готовая тема в этой сессии — от неё стартует «Свой» набор. */
let lastPreset = null;

function setTheme(id) {
    const settings = getSettings();
    settings.theme = id;
    // Первый раз «Свой» стартует не с пустоты, а с копии темы, которая была включена
    if (id === 'custom' && !settings.theme_custom) {
        settings.theme_custom = { ...(THEMES.find(theme => theme.id === lastPreset)?.colors || THEMES[0].colors) };
    }
    saveSettings();
    applyAppearance();
    renderThemePicker();
}

/** Вешает обработчики вкладки «Тема» — делегированно на контейнер, он перерисовывается целиком. */
export function bindThemePicker() {
    const $box = $('#loom-theme-picker');

    $box.on('click', '.loom-theme-tile', function () {
        const id = String($(this).data('theme'));
        if (THEMES.some(theme => theme.id === id)) lastPreset = id;
        setTheme(id);
    });

    $box.on('click', '.loom-swatch-btn', function () {
        // Повторный клик по уже открытому кружку — закрыть, как со своими списками
        if (picker?.anchor === this) return closeColorPicker();

        const key = this.dataset.key;
        const label = COLOR_KEYS.find(item => item.key === key)?.label || '';
        const settings = getSettings();
        const current = sanitizeColors(settings.theme_custom, THEMES[0].colors)[key];

        openColorPicker(this, label, current, hex => {
            const s = getSettings();
            s.theme_custom = { ...sanitizeColors(s.theme_custom, THEMES[0].colors), [key]: hex };
            saveSettings();
            applyAppearance();
            this.style.background = hex;
            this.setAttribute('aria-label', `${label}: ${hex}`);
            // Полоски на плитке «Свой» перекрашиваем на месте — полная перерисовка закрыла бы открытый попап
            $box.find('.loom-theme-tile[data-theme="custom"] .loom-theme-swatch').css('background', swatchGradient(s.theme_custom));
        });
    });

    $box.on('change', '.loom-theme-base', function () {
        const theme = THEMES.find(item => item.id === $(this).val());
        if (!theme) return;
        const settings = getSettings();
        settings.theme_custom = { ...theme.colors };
        saveSettings();
        applyAppearance();
        renderThemePicker();
    });
}

// ─── Свой попап выбора цвета ────────────────────────────────────────────────
//
// Замена системному <input type="color">: во встроенном WebView (в мобильных
// приложениях, не в самом браузере — ровно так открыт LOOM) он показывает не
// колёсико цвета, а восьмицветную заглушку без единого оттенка ни одной из тем.
// Здесь — свой SV-квадрат (насыщенность и яркость при текущем оттенке) плюс
// полоса оттенка, тот же принцип, что у большинства графических редакторов.

/** @param {string} hex "#rrggbb" @returns {[number, number, number]} r, g, b — 0..255 */
function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
    return `#${[r, g, b].map(c => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')}`;
}

/** @returns {[number, number, number]} оттенок 0..360, насыщенность и яркость 0..100 */
function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d !== 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return [h, max === 0 ? 0 : (d / max) * 100, max * 100];
}

/** @param {number} h 0..360 @param {number} s 0..100 @param {number} v 0..100 */
function hsvToRgb(h, s, v) {
    s /= 100; v /= 100;
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
        : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** @type {{el: HTMLElement, anchor: HTMLElement, h: number, s: number, v: number, onChange: Function, width: number}|null} */
let picker = null;

function closeColorPicker({ restoreFocus = false } = {}) {
    if (!picker) return;
    const { el, anchor } = picker;
    picker = null;
    el.remove();
    anchor.classList.remove('loom-cp-open');
    document.removeEventListener('pointerdown', onOutsidePickerPointer, true);
    document.removeEventListener('scroll', onPickerScrollOrResize, true);
    window.removeEventListener('resize', onPickerResize);
    document.removeEventListener('keydown', onPickerKey, true);
    if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
}

function onOutsidePickerPointer(event) {
    if (!picker) return;
    if (picker.el.contains(event.target) || picker.anchor.contains(event.target)) return;
    closeColorPicker();
}

function onPickerScrollOrResize(event) {
    if (picker && !(event.target instanceof Node && picker.el.contains(event.target))) closeColorPicker();
}

/** Как и у выпадающих списков: закрываем только на смену ШИРИНЫ (поворот экрана), не на любой resize. */
function onPickerResize() {
    if (picker && window.innerWidth !== picker.width) closeColorPicker();
}

function onPickerKey(event) {
    if (!picker) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeColorPicker({ restoreFocus: true });
    } else if (event.key === 'Enter' && event.target.classList.contains('loom-cp-hex')) {
        closeColorPicker({ restoreFocus: true });
    }
}

/** Перекрашивает SV-квадрат под текущий оттенок — вызывается только когда оттенок меняется. */
function redrawPickerSv(p) {
    const canvas = p.el.querySelector('.loom-cp-sv-canvas');
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const [r, g, b] = hsvToRgb(p.h, 100, 100);
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(0, 0, w, h);
    let grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 1)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
}

/** Сдвигает оба ползунка и хекс-поле под текущее h/s/v. @returns {string} итоговый "#rrggbb" */
function syncPickerUi(p) {
    const [r, g, b] = hsvToRgb(p.h, p.s, p.v);
    const hex = rgbToHex(r, g, b);
    const sv = p.el.querySelector('.loom-cp-sv');
    p.el.querySelector('.loom-cp-sv-thumb').style.left = `${(p.s / 100) * sv.clientWidth}px`;
    p.el.querySelector('.loom-cp-sv-thumb').style.top = `${(1 - p.v / 100) * sv.clientHeight}px`;
    p.el.querySelector('.loom-cp-hue-thumb').style.left = `${(p.h / 360) * p.el.querySelector('.loom-cp-hue').clientWidth}px`;
    p.el.querySelector('.loom-cp-preview').style.background = hex;
    if (document.activeElement !== p.el.querySelector('.loom-cp-hex')) p.el.querySelector('.loom-cp-hex').value = hex;
    return hex;
}

/**
 * Открывает попап выбора цвета над `anchor` (кружок-кнопка).
 * @param {HTMLElement} anchor кнопка, у которой открываем попап
 * @param {string} label подпись цвета — заголовок попапа
 * @param {string} hex стартовое значение "#rrggbb"
 * @param {(hex: string) => void} onChange зовётся при каждом изменении, включая перетаскивание
 */
export function openColorPicker(anchor, label, hex, onChange) {
    closeColorPicker();
    const root = document.getElementById('loom-backdrop');
    if (!root) return;

    const [r0, g0, b0] = hexToRgb(HEX.test(hex) ? hex : '#000000');
    const [h0, s0, v0] = rgbToHsv(r0, g0, b0);

    const el = document.createElement('div');
    el.className = 'loom-cp';
    el.innerHTML = `
        <div class="loom-cp-head">
            <span class="loom-cp-title">${label}</span>
            <button type="button" class="loom-icon-btn loom-cp-close" title="Закрыть">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
        <div class="loom-cp-sv">
            <canvas class="loom-cp-sv-canvas" width="220" height="130"></canvas>
            <div class="loom-cp-sv-thumb"></div>
        </div>
        <div class="loom-cp-hue"><div class="loom-cp-hue-thumb"></div></div>
        <div class="loom-cp-bottom">
            <span class="loom-cp-preview"></span>
            <input type="text" class="loom-cp-hex" maxlength="7" autocomplete="off" spellcheck="false">
        </div>`;
    root.append(el);
    anchor.classList.add('loom-cp-open');

    picker = { el, anchor, h: h0, s: s0, v: v0, onChange, width: window.innerWidth };
    redrawPickerSv(picker);
    syncPickerUi(picker);

    // Позиция: под кружком, а если снизу не влезает — над ним; по горизонтали — не за край экрана
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const elHeight = el.getBoundingClientRect().height;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const below = spaceBelow >= elHeight || spaceBelow >= spaceAbove;
    el.style.top = `${below ? rect.bottom + 6 : Math.max(margin, rect.top - elHeight - 6)}px`;
    el.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - el.offsetWidth - margin))}px`;

    const emit = () => onChange(syncPickerUi(picker));

    const svEl = el.querySelector('.loom-cp-sv');
    svEl.addEventListener('pointerdown', event => {
        event.preventDefault();
        // Без захвата палец/курсор, ушедший за край квадрата, перестал бы двигать точку —
        // но клик всё равно должен поставить цвет туда, куда нажали, а не бездействовать
        try { svEl.setPointerCapture(event.pointerId); } catch { /* нет активного указателя с этим id — редкое старое окружение */ }
        const move = e => {
            const r = svEl.getBoundingClientRect();
            picker.s = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
            picker.v = Math.max(0, Math.min(100, (1 - (e.clientY - r.top) / r.height) * 100));
            emit();
        };
        move(event);
        svEl.addEventListener('pointermove', move);
        svEl.addEventListener('pointerup', () => svEl.removeEventListener('pointermove', move), { once: true });
    });

    const hueEl = el.querySelector('.loom-cp-hue');
    hueEl.addEventListener('pointerdown', event => {
        event.preventDefault();
        try { hueEl.setPointerCapture(event.pointerId); } catch { /* см. комментарий у SV-квадрата выше */ }
        const move = e => {
            const r = hueEl.getBoundingClientRect();
            picker.h = Math.max(0, Math.min(360, ((e.clientX - r.left) / r.width) * 360));
            redrawPickerSv(picker);
            emit();
        };
        move(event);
        hueEl.addEventListener('pointermove', move);
        hueEl.addEventListener('pointerup', () => hueEl.removeEventListener('pointermove', move), { once: true });
    });

    el.querySelector('.loom-cp-hex').addEventListener('input', function () {
        const value = this.value.trim().replace(/^#?/, '#');
        if (!HEX.test(value)) return;
        const [r, g, b] = hexToRgb(value);
        [picker.h, picker.s, picker.v] = rgbToHsv(r, g, b);
        redrawPickerSv(picker);
        syncPickerUi(picker);
        onChange(value.toLowerCase());
    });

    el.querySelector('.loom-cp-close').addEventListener('click', () => closeColorPicker({ restoreFocus: true }));

    document.addEventListener('pointerdown', onOutsidePickerPointer, true);
    document.addEventListener('scroll', onPickerScrollOrResize, true);
    window.addEventListener('resize', onPickerResize);
    document.addEventListener('keydown', onPickerKey, true);
}

// ─── Свои выпадающие списки ─────────────────────────────────────────────────

/** @type {{el: HTMLElement, select: HTMLSelectElement, width: number}|null} */
let menu = null;
let initialized = false;

/** Наш ли это список: внутри панели, обычный (не multiple/listbox) и не заблокированный. */
function isCustomTarget(select) {
    const root = document.getElementById('loom-backdrop');
    return select instanceof HTMLSelectElement
        && !!root && root.contains(select)
        && !select.multiple && !(select.size > 1) && !select.disabled;
}

function closeMenu({ restoreFocus = false } = {}) {
    if (!menu) return;
    const { el, select } = menu;
    menu = null;
    el.remove();
    select.classList.remove('loom-dd-open');
    document.removeEventListener('pointerdown', onOutsidePointer, true);
    document.removeEventListener('scroll', onScrollOrResize, true);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onMenuKey, true);
    if (restoreFocus && select.isConnected) select.focus({ preventScroll: true });
}

function onOutsidePointer(event) {
    if (!menu) return;
    // Нажатие на сам select обрабатывает переключатель (закрыть/открыть) — здесь не мешаем
    if (menu.el.contains(event.target) || menu.select.contains(event.target)) return;
    closeMenu();
}

function onScrollOrResize(event) {
    // Прокрутка самого списка — не повод его закрывать; прокрутка страницы уводит его от поля
    if (menu && !(event.target instanceof Node && menu.el.contains(event.target))) closeMenu();
}

/**
 * Смена размера окна: на телефоне resize приходит и от скрытия адресной строки, и от
 * клавиатуры — закрывать список из-за этого нельзя. Закрываем, только если поменялась
 * ширина (поворот экрана, разворот окна): тогда поле уже не там, где мы список поставили.
 */
function onResize() {
    if (menu && window.innerWidth !== menu.width) closeMenu();
}

function onMenuKey(event) {
    if (!menu) return;
    const items = [...menu.el.querySelectorAll('.loom-dd-item:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    const focusAt = i => { items[Math.max(0, Math.min(items.length - 1, i))]?.focus(); };

    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeMenu({ restoreFocus: true });
    } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusAt(index + 1);
    } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusAt(index === -1 ? items.length - 1 : index - 1);
    } else if (event.key === 'Home') {
        event.preventDefault();
        focusAt(0);
    } else if (event.key === 'End') {
        event.preventDefault();
        focusAt(items.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
        // Явно, а не через «нажатие» кнопки: не везде оно срабатывает от клавиши одинаково
        if (index === -1) return;
        event.preventDefault();
        event.stopPropagation();
        choose(menu.select, Number(items[index].dataset.index));
    } else if (event.key === 'Tab') {
        closeMenu();
    }
}

function choose(select, index) {
    const changed = select.selectedIndex !== index;
    closeMenu({ restoreFocus: true });
    if (!changed || !select.isConnected) return;
    select.selectedIndex = index;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
}

function buildItem(select, option) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'loom-dd-item';
    item.setAttribute('role', 'option');
    item.dataset.index = String(option.index);
    item.disabled = option.disabled;

    const selected = option.index === select.selectedIndex;
    item.classList.toggle('selected', selected);
    item.setAttribute('aria-selected', String(selected));

    const label = document.createElement('span');
    // В разметке у option бывают переносы и отступы — без trim они попадали в строку списка
    label.textContent = option.textContent.trim() || ' ';
    item.append(label);
    if (selected) {
        const mark = document.createElement('i');
        mark.className = 'fa-solid fa-check';
        item.append(mark);
    }
    return item;
}

function openMenu(select) {
    closeMenu();
    const root = document.getElementById('loom-backdrop');
    if (!root) return;

    const el = document.createElement('div');
    el.className = 'loom-dd';
    el.setAttribute('role', 'listbox');

    for (const child of select.children) {
        if (child.tagName === 'OPTGROUP') {
            const title = document.createElement('div');
            title.className = 'loom-dd-group';
            title.textContent = child.label;
            el.append(title);
            for (const option of child.children) el.append(buildItem(select, option));
        } else if (child.tagName === 'OPTION') {
            el.append(buildItem(select, child));
        }
    }
    if (!el.children.length) return;

    el.addEventListener('click', event => {
        const item = event.target.closest?.('.loom-dd-item');
        if (item && !item.disabled) choose(select, Number(item.dataset.index));
    });

    root.append(el);
    menu = { el, select, width: window.innerWidth };
    select.classList.add('loom-dd-open');

    // Ширина не меньше поля, высота — сколько влезло: вниз, а если там тесно — вверх
    const rect = select.getBoundingClientRect();
    const margin = 8;
    el.style.minWidth = `${Math.min(rect.width, window.innerWidth - margin * 2)}px`;
    el.style.maxWidth = `${Math.min(window.innerWidth - margin * 2, 520)}px`;

    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const wanted = Math.min(el.scrollHeight, 360);
    const below = spaceBelow >= wanted || spaceBelow >= spaceAbove;
    const maxHeight = Math.max(120, Math.min(360, below ? spaceBelow : spaceAbove) - 4);
    el.style.maxHeight = `${maxHeight}px`;

    const height = Math.min(el.scrollHeight, maxHeight);
    el.style.top = `${below ? rect.bottom + 4 : Math.max(margin, rect.top - height - 4)}px`;
    el.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - el.offsetWidth - margin))}px`;

    const current = el.querySelector('.selected') || el.querySelector('.loom-dd-item:not(:disabled)');
    current?.scrollIntoView({ block: 'nearest' });
    current?.focus({ preventScroll: true });

    document.addEventListener('pointerdown', onOutsidePointer, true);
    document.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onMenuKey, true);
}

function toggleMenu(select) {
    if (menu?.select === select) closeMenu();
    else openMenu(select);
}

/**
 * Вешает перехват раз на весь документ (делегированно) — панель перерисовывается
 * постоянно, и вешать обработчики на каждый <select> пришлось бы после каждой перерисовки.
 * Настройка проверяется в момент нажатия, поэтому переключатель действует сразу.
 */
export function initCustomSelects() {
    if (initialized) return;
    initialized = true;

    const targetOf = event => {
        const select = event.target?.closest?.('select');
        return select && isCustomTarget(select) ? select : null;
    };

    // Мышь: preventDefault на mousedown не даёт браузеру открыть системный список
    document.addEventListener('mousedown', event => {
        if (event.button !== 0) return;
        const select = targetOf(event);
        if (!select) return;
        event.preventDefault();
        select.focus({ preventScroll: true });
        toggleMenu(select);
    }, true);

    // Тач: системный список на телефоне открывается по тапу, а не по mousedown, поэтому
    // тап (без сдвига пальца — иначе это прокрутка) перехватываем на touchend
    let touch = null;
    document.addEventListener('touchstart', event => {
        const select = event.touches.length === 1 ? targetOf(event) : null;
        touch = select ? { select, x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
    }, { capture: true, passive: true });
    document.addEventListener('touchend', event => {
        if (!touch) return;
        const { select, x, y } = touch;
        touch = null;
        const point = event.changedTouches[0];
        if (Math.hypot(point.clientX - x, point.clientY - y) > 10) return;
        if (event.cancelable) event.preventDefault();
        toggleMenu(select);
    }, { capture: true, passive: false });

    // Клавиатура: Enter / Пробел / Alt+↓ на поле открывают наш список; стрелки без открытия
    // меняют значение как обычно — их не трогаем
    document.addEventListener('keydown', event => {
        if (menu) return;
        const select = targetOf(event);
        if (!select) return;
        if (event.key === 'Enter' || event.key === ' ' || (event.key === 'ArrowDown' && event.altKey)) {
            event.preventDefault();
            openMenu(select);
        }
    }, true);
}
