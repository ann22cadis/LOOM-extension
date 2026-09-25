/**
 * Пресеты формата (наборы пунктов режима) — файл для обмена: экспорт и импорт.
 *
 * Файл — обычный JSON, его можно скинуть другому человеку:
 *   { "loom": "loom-format-presets", "version": 1,
 *     "presets": [ { "mode": "Лорбук", "kind": "lorebook", "name": "…", "items": [ {id, label, hint, enabled, …} ] } ] }
 *
 * Режим, в который пресет попадёт при импорте, зашит в каждом пресете дважды: читаемо
 * («mode») и машинно («kind»). Читается любой из двух — файл можно поправить руками.
 *
 * Импорт не верит файлу: пункты приводятся к нашей форме (id только латиницей и без
 * повторов, тексты обрезаются, лишние поля выбрасываются) — чужой файл не должен уметь
 * подложить в настройки что-то, кроме самих пунктов. Модуль без обращений к DOM и к Таверне.
 */

import { CARD_TARGETS } from './settings.js';

export const FORMAT_PRESET_FILE = 'loom-format-presets';

/** Режимы, у которых есть пресеты формата. */
export const FORMAT_KINDS = ['character', 'persona', 'lorebook', 'prompt', 'scenario', 'preset', 'analysis'];

/** Подписи режимов — для тостов и имён файлов. */
export const FORMAT_KIND_LABELS = {
    character: 'Персонаж', persona: 'Персона', lorebook: 'Лорбук', prompt: 'Промпт',
    scenario: 'Сценарий', preset: 'Пресет', analysis: 'Анализ пресета',
};

const MAX_PRESETS_PER_FILE = 40;
const MAX_ITEMS = 60;
const MAX_HINT = 6000;

/** Пункт → то, что кладём в файл: без служебных полей, которых нет в форме. */
function exportItem(item, kind) {
    const out = {
        id: String(item.id || ''),
        label: String(item.label || ''),
        hint: String(item.hint || ''),
        enabled: item.enabled !== false,
    };
    if (kind === 'character') {
        out.target = item.target || 'description';
        if (item.scene) out.scene = true;
    }
    return out;
}

/**
 * @param {Array<{kind: string, name: string, items: object[]}>} presets
 * @returns {object} готовый к записи в файл объект
 */
export function buildFormatPresetFile(presets) {
    return {
        loom: FORMAT_PRESET_FILE,
        version: 1,
        presets: presets.map(p => ({
            mode: FORMAT_KIND_LABELS[p.kind] || p.kind,
            kind: p.kind,
            name: String(p.name || '').trim() || 'Без названия',
            items: (p.items || []).map(item => exportItem(item, p.kind)),
        })),
    };
}

/**
 * Режим пресета по тому, что в файле: id («lorebook»), подпись («Лорбук») или её часть
 * без регистра. Не распознали — null, и вызывающий берёт режим по умолчанию.
 */
export function kindFromFile(raw) {
    for (const value of [raw?.kind, raw?.mode]) {
        const text = String(value ?? '').trim().toLowerCase();
        if (!text) continue;
        const byId = FORMAT_KINDS.find(kind => kind === text);
        if (byId) return byId;
        const byLabel = FORMAT_KINDS.find(kind => FORMAT_KIND_LABELS[kind].toLowerCase() === text);
        if (byLabel) return byLabel;
    }
    return null;
}

/** Безопасное имя файла из названия пресета. */
export function formatPresetFileName(kind, name) {
    const slug = String(name || 'preset').trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-').slice(0, 50) || 'preset';
    return `loom-format-${kind}-${slug}.json`;
}

/** Один пункт из чужого файла → пункт нашей формы, либо null, если из него ничего не выйдет. */
function sanitizeItem(raw, kind, usedIds) {
    if (!raw || typeof raw !== 'object') return null;
    const label = String(raw.label ?? raw.name ?? '').trim().slice(0, 120);
    const rawId = String(raw.id ?? '').trim();
    if (!label && !rawId) return null;

    // id — ключ в JSON-ответе модели: латиница, цифры, подчёркивание; пустой — из подписи нельзя
    // (она русская), поэтому нумеруем
    let id = rawId.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';
    let n = 2;
    const base = id;
    while (usedIds.has(id)) id = `${base}_${n++}`;
    usedIds.add(id);

    const item = {
        id,
        label: label || id,
        hint: String(raw.hint ?? '').slice(0, MAX_HINT),
        enabled: raw.enabled !== false,
    };
    if (kind === 'character') {
        item.target = CARD_TARGETS.some(t => t.value === raw.target) ? raw.target : 'description';
        item.scene = !!raw.scene;
    }
    return item;
}

/**
 * Файл пресетов → список готовых пресетов. Понимает три вида:
 * набор (`presets: […]`), один пресет (`kind`, `name`, `items`) и просто массив пунктов.
 *
 * @param {string} text содержимое файла
 * @param {string} fallbackKind режим, в который кладём то, у чего режим не указан или неверен
 * @param {string} [fileName] имя файла — как название, если в файле его нет
 * @returns {{presets: Array<{kind: string, name: string, items: object[]}>, skipped: string[]}}
 */
export function parseFormatPresetFile(text, fallbackKind, fileName = '') {
    let data;
    try {
        data = JSON.parse(text);
    } catch (error) {
        throw new Error(`не похоже на JSON: ${error.message || error}`);
    }

    let rawPresets;
    if (Array.isArray(data)) {
        rawPresets = [{ items: data }];
    } else if (data && typeof data === 'object' && Array.isArray(data.presets)) {
        rawPresets = data.presets;
    } else if (data && typeof data === 'object' && Array.isArray(data.items)) {
        rawPresets = [data];
    } else {
        throw new Error('в файле нет пресетов формата LOOM (ожидаются «presets» или «items»)');
    }
    if (!rawPresets.length) throw new Error('файл пуст — в нём нет ни одного пресета');

    const baseName = String(fileName || '').replace(/\.[^.]+$/, '').replace(/^loom-format-/, '').trim();
    const presets = [];
    const skipped = [];

    rawPresets.slice(0, MAX_PRESETS_PER_FILE).forEach((raw, index) => {
        const kind = kindFromFile(raw) || fallbackKind;
        const label = String(raw?.name || '').trim() || baseName || `Импортированный ${index + 1}`;
        const usedIds = new Set();
        const items = (Array.isArray(raw?.items) ? raw.items : [])
            .slice(0, MAX_ITEMS)
            .map(item => sanitizeItem(item, kind, usedIds))
            .filter(Boolean);

        if (!items.length) {
            skipped.push(`«${label}» — нет ни одного пункта`);
            return;
        }
        presets.push({ kind, name: label.slice(0, 80), items });
    });

    if (!presets.length) throw new Error(`ничего не удалось прочитать: ${skipped.join('; ')}`);
    return { presets, skipped };
}

/** Название, которого ещё нет среди занятых: «Имя», «Имя (импорт)», «Имя (импорт 2)». */
export function uniquePresetName(name, takenNames) {
    const taken = new Set(takenNames.map(n => String(n).toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    let candidate = `${name} (импорт)`;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name} (импорт ${n})`;
    return candidate;
}
