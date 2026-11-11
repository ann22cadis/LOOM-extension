/**
 * Память чата: факты, заметки и записи лорбука, собранные из ТЕКУЩЕГО чата.
 *
 * Живёт только в чате: всё хранится в chat_metadata.loom_memory и едет вместе с чатом,
 * у каждого чата своё. Открывается пунктом «Память чата» в меню расширений (там же,
 * где LOOM), пункт виден только при открытом чате.
 *
 *  - Факты — короткие установленные вещи (кто кому что обещал, раны, предметы, решения).
 *    По галочке подмешиваются в промпт чата на заданной глубине.
 *  - Заметки — для игрока (незакрытые линии, крючки, нестыковки). Модели чата не уходят.
 *  - Записи — новые постоянные сущности чата (места, NPC, предметы). Выгружаются в лорбук
 *    чата Таверны; запомненный uid обновляет ту же запись на месте, а не плодит копии.
 *
 * Анализ — один запрос к модели по выбранному куску чата (новое с прошлого анализа,
 * последние N сообщений или весь чат, с потолком по символам).
 */

import { createWorldInfoEntry, world_names } from '../../../../world-info.js';
import { callAI, parseJsonLoose } from './api.js';
import { compileKeys } from './keys.js';

const LOG = '[LOOM]';
const META_KEY = 'loom_memory';
const PROMPT_KEY = 'LOOM_MEMORY';
const WORLD_KEY = 'world_info'; // METADATA_KEY Таверны: лорбук, привязанный к чату
const IN_CHAT = 1;
const MAX_TRANSCRIPT = 60000;   // символов чата в одном анализе
const MAX_MESSAGE = 4000;       // символов одного сообщения

const ctx = () => SillyTavern.getContext();
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
const newId = () => Math.random().toString(36).slice(2, 10);

let inited = false;
let busy = false;

// ─── Состояние ──────────────────────────────────────────────────────────────

function isChatOpen() {
    const c = ctx();
    return !!c.chatId && (c.characterId !== undefined || !!c.groupId);
}

/** Память текущего чата; создаёт пустую, если её ещё нет. null — чат не открыт. */
function memory() {
    const meta = ctx().chatMetadata;
    if (!meta || !isChatOpen()) return null;
    const m = meta[META_KEY] && typeof meta[META_KEY] === 'object' ? meta[META_KEY] : (meta[META_KEY] = {});
    m.facts ||= [];
    m.notes ||= [];
    m.entries ||= [];
    if (m.analyzedUpTo === undefined) m.analyzedUpTo = -1;
    if (m.inject === undefined) m.inject = true;
    if (m.depth === undefined) m.depth = 4;
    return m;
}

function commit() {
    ctx().saveMetadataDebounced?.();
    syncPrompt();
}

/** Факты в промпт чата. Пусто — вставка снимается. */
function syncPrompt() {
    const c = ctx();
    const m = isChatOpen() ? c.chatMetadata?.[META_KEY] : null;
    const facts = (m?.inject ? m.facts || [] : []).filter(f => f.on !== false && String(f.text || '').trim());
    const text = facts.length
        ? `[Established facts of this story so far — keep them consistent:\n${facts.map(f => `- ${f.text.trim()}`).join('\n')}]`
        : '';
    c.setExtensionPrompt(PROMPT_KEY, text, IN_CHAT, Math.max(0, Math.floor(Number(m?.depth)) || 0), false, 0);
}

// ─── Анализ ─────────────────────────────────────────────────────────────────

/** Сообщения для анализа: [{index, name, text}] — без системных, с потолком по символам с конца. */
function pickMessages(range) {
    const { chat } = ctx();
    const m = memory();
    let from = 0;
    if (range === 'new') from = (m?.analyzedUpTo ?? -1) + 1;
    else if (range === 'last') from = Math.max(0, chat.length - 30);
    const list = [];
    let total = 0;
    for (let i = chat.length - 1; i >= from; i--) {
        const msg = chat[i];
        if (!msg || msg.is_system) continue;
        const text = String(msg.mes || '').trim().slice(0, MAX_MESSAGE);
        if (!text) continue;
        total += text.length;
        if (total > MAX_TRANSCRIPT && list.length) break;
        list.unshift({ index: i, name: msg.name || (msg.is_user ? 'User' : 'Character'), text });
    }
    return list;
}

function analysisPrompt(messages, want, m) {
    const parts = [
        'TASK: read a fragment of a roleplay chat and extract memory for the rest of the story.',
        `Characters: ${String(ctx().name2 || '').trim() || '(unknown)'}; player: ${String(ctx().name1 || '').trim() || '(unknown)'}.`,
        '',
        'CHAT FRAGMENT:',
        messages.map(x => `[#${x.index}] ${x.name}: ${x.text}`).join('\n\n'),
        '',
    ];
    if (m.facts.length) parts.push('ALREADY KNOWN FACTS (do not repeat them, only add new ones or changes):', m.facts.map(f => `- ${f.text}`).join('\n'), '');
    if (m.entries.length) parts.push('LOREBOOK ENTRIES THAT ALREADY EXIST (titles):', m.entries.map(e => `- ${e.title}`).join('\n'), '');

    const fields = [];
    if (want.facts) fields.push('  "facts": [string] - new durable facts established in this fragment: relationships, promises, injuries, '
        + 'items gained or lost, decisions, revealed secrets, changes of location or status. One short sentence each, concrete, '
        + 'with names. Skip fleeting actions and mood. A fact that CHANGES a known one is stated in its new form.');
    if (want.notes) fields.push('  "notes": [string] - notes for the player, not for the model: unresolved threads, hooks worth returning to, '
        + 'contradictions noticed. One sentence each.');
    if (want.entries) fields.push('  "entries": [{"title": string, "keys": [string], "content": string}] - lorebook entries for NEW persistent '
        + 'things introduced in the chat (named places, NPCs, items, factions, customs) that will matter again. Keys: 1-4 words or names '
        + 'that appear in chat when the thing is mentioned. Content: 60-200 words, the full name in the first sentence, only what the chat '
        + 'established. To update an existing entry, use its exact title and give the full new content.');

    parts.push(
        'Write in the same language as the chat. Return empty arrays where there is nothing worth keeping - '
            + 'an empty answer is better than padding.',
        '',
        'Respond with JSON only:',
        '{',
        fields.join(',\n'),
        '}',
    );
    return parts.join('\n');
}

async function analyze(range, want) {
    const m = memory();
    if (!m) throw new Error('Откройте чат.');
    const messages = pickMessages(range);
    if (!messages.length) throw new Error(range === 'new' ? 'Новых сообщений с прошлого анализа нет.' : 'В чате нет сообщений.');

    const reply = await callAI(analysisPrompt(messages, want, m), {
        system: 'You keep the memory of a long roleplay: you extract facts, notes and lorebook entries from chat. Answer with JSON only.',
        maxTokens: 4000,
    });
    const parsed = parseJsonLoose(reply);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Модель не вернула JSON.');

    // Пока ждали ответ, чат могли сменить — тогда результат не для этого чата
    const now = memory();
    if (now !== m) throw new Error('Чат сменился во время анализа — результат отброшен.');

    const strings = list => (Array.isArray(list) ? list : []).map(x => String(x ?? '').trim()).filter(Boolean);
    const known = new Set(m.facts.map(f => f.text.trim().toLowerCase()));
    let facts = 0;
    let notes = 0;
    let added = 0;
    let updated = 0;
    if (want.facts) for (const text of strings(parsed.facts)) {
        if (known.has(text.toLowerCase())) continue;
        known.add(text.toLowerCase());
        m.facts.push({ id: newId(), text, on: true, from: messages.at(-1).index });
        facts++;
    }
    if (want.notes) for (const text of strings(parsed.notes)) {
        m.notes.push({ id: newId(), text });
        notes++;
    }
    if (want.entries) for (const raw of Array.isArray(parsed.entries) ? parsed.entries : []) {
        const title = String(raw?.title || '').trim();
        const content = String(raw?.content || '').trim();
        if (!title || !content) continue;
        const keys = strings(raw.keys);
        const existing = m.entries.find(e => e.title.trim().toLowerCase() === title.toLowerCase());
        if (existing) {
            existing.content = content;
            existing.keys = [...new Set([...existing.keys, ...keys])];
            existing.dirty = true;
            updated++;
        } else {
            m.entries.push({ id: newId(), title, keys, content, uid: null, dirty: true });
            added++;
        }
    }
    m.analyzedUpTo = Math.max(m.analyzedUpTo, messages.at(-1).index);
    commit();
    return { facts, notes, added, updated, count: messages.length };
}

// ─── Лорбук чата ────────────────────────────────────────────────────────────

/** Лорбук, привязанный к чату; если его нет — заводит новый и привязывает. */
async function ensureChatWorld() {
    const c = ctx();
    const bound = c.chatMetadata?.[WORLD_KEY];
    if (bound) return bound;
    const base = `LOOM память — ${String(c.name2 || 'чат').trim()}`;
    let name = base;
    const names = new Set(world_names || []);
    for (let n = 2; names.has(name); n++) name = `${base} ${n}`;
    await c.saveWorldInfo(name, { entries: {} }, true);
    c.chatMetadata[WORLD_KEY] = name;
    await c.saveMetadata();
    await c.updateWorldInfoList?.();
    $('.chat_lorebook_button').addClass('world_set');
    return name;
}

async function exportEntries() {
    const m = memory();
    if (!m) throw new Error('Откройте чат.');
    const list = m.entries.filter(e => e.title.trim() && e.content.trim());
    if (!list.length) throw new Error('Нет записей с текстом.');

    const c = ctx();
    const name = await ensureChatWorld();
    let data = null;
    try { data = await c.loadWorldInfo(name); } catch { /* создадим */ }
    if (!data?.entries) data = { entries: {} };

    // uid свои только в том лорбуке, куда уже писали: другой лорбук — записи заводим новыми
    const sameWorld = m.world === name;
    const links = [];
    for (const entry of list) {
        const existing = sameWorld && entry.uid != null ? data.entries[entry.uid] : null;
        const wi = existing || createWorldInfoEntry(name, data);
        if (!wi) throw new Error('Не удалось создать запись лорбука.');
        wi.comment = entry.title.trim();
        wi.key = compileKeys(entry.keys);
        wi.content = entry.content.trim();
        links.push([entry, wi.uid]);
    }
    await c.saveWorldInfo(name, data, true);
    for (const [entry, uid] of links) { entry.uid = uid; entry.dirty = false; }
    m.world = name;
    commit();
    c.reloadWorldInfoEditor?.(name);
    return { name, count: links.length };
}

// ─── Окно ───────────────────────────────────────────────────────────────────

let root = null;

function listHtml(kind, items, placeholder, extra = () => '') {
    return items.map((item, i) => `
        <div class="loom-mem-row" data-kind="${kind}" data-index="${i}">
            ${extra(item)}
            <textarea class="text_pole loom-mem-text" rows="2" placeholder="${placeholder}">${esc(item.text)}</textarea>
            <button type="button" class="loom-icon-btn loom-mem-del" title="Удалить"><i class="fa-solid fa-trash"></i></button>
        </div>`).join('') || '<div class="loom-mem-empty">Пусто</div>';
}

function render(status = '') {
    if (!root) return;
    const m = memory();
    if (!m) {
        root.innerHTML = '<div class="loom-mem-empty">Откройте чат — память есть только у чата.</div>';
        return;
    }
    const { chat } = ctx();
    const fresh = chat.slice(m.analyzedUpTo + 1).filter(x => !x.is_system).length;
    const world = ctx().chatMetadata?.[WORLD_KEY];
    root.innerHTML = `
        <div class="loom-mem">
            <h3>Память чата</h3>
            <section class="loom-mem-box">
                <div class="loom-mem-line">
                    <select class="text_pole loom-mem-range">
                        <option value="new">Новое с прошлого анализа (${fresh})</option>
                        <option value="last">Последние 30 сообщений</option>
                        <option value="all">Весь чат</option>
                    </select>
                    <button type="button" class="loom-btn loom-btn-primary loom-mem-analyze" ${busy ? 'disabled' : ''}>
                        <i class="fa-solid fa-magnifying-glass"></i> Анализировать
                    </button>
                </div>
                <div class="loom-mem-line">
                    <label class="loom-check compact"><input type="checkbox" class="loom-mem-want" value="facts" checked><span>Факты</span></label>
                    <label class="loom-check compact"><input type="checkbox" class="loom-mem-want" value="notes" checked><span>Заметки</span></label>
                    <label class="loom-check compact"><input type="checkbox" class="loom-mem-want" value="entries" checked><span>Записи</span></label>
                </div>
                <div class="loom-mem-status">${esc(status || (busy ? 'Анализирую…' : ''))}</div>
            </section>

            <section class="loom-mem-box">
                <div class="loom-mem-head">
                    <b>Факты</b> <span class="loom-mem-count">${m.facts.length}</span>
                    <label class="loom-check compact" title="Включённые факты уходят в промпт чата">
                        <input type="checkbox" class="loom-mem-inject" ${m.inject ? 'checked' : ''}><span>в промпт, глубина</span>
                    </label>
                    <input type="number" class="text_pole loom-mem-depth" min="0" max="99" value="${Number(m.depth) || 0}">
                    <button type="button" class="loom-icon-btn loom-mem-add" data-kind="facts" title="Добавить факт"><i class="fa-solid fa-plus"></i></button>
                </div>
                ${listHtml('facts', m.facts, 'Факт', f => `<input type="checkbox" class="loom-mem-on" title="В промпт" ${f.on !== false ? 'checked' : ''}>`)}
            </section>

            <section class="loom-mem-box">
                <div class="loom-mem-head">
                    <b>Заметки</b> <span class="loom-mem-count">${m.notes.length}</span>
                    <span class="loom-mem-hint">только для вас</span>
                    <button type="button" class="loom-icon-btn loom-mem-add" data-kind="notes" title="Добавить заметку"><i class="fa-solid fa-plus"></i></button>
                </div>
                ${listHtml('notes', m.notes, 'Заметка')}
            </section>

            <section class="loom-mem-box">
                <div class="loom-mem-head">
                    <b>Записи</b> <span class="loom-mem-count">${m.entries.length}</span>
                    <button type="button" class="loom-icon-btn loom-mem-add" data-kind="entries" title="Добавить запись"><i class="fa-solid fa-plus"></i></button>
                </div>
                ${m.entries.map((e, i) => `
                <div class="loom-mem-entry" data-kind="entries" data-index="${i}">
                    <div class="loom-mem-line">
                        <input type="text" class="text_pole loom-mem-title" value="${esc(e.title)}" placeholder="Название">
                        <span class="loom-mem-hint">${e.uid != null && !e.dirty ? 'в лорбуке' : e.uid != null ? 'изменена' : 'не выгружена'}</span>
                        <button type="button" class="loom-icon-btn loom-mem-del" title="Удалить из памяти (в лорбуке останется)"><i class="fa-solid fa-trash"></i></button>
                    </div>
                    <input type="text" class="text_pole loom-mem-keys" value="${esc(e.keys.join(', '))}" placeholder="Ключи через запятую">
                    <textarea class="text_pole loom-mem-content" rows="4" placeholder="Текст записи">${esc(e.content)}</textarea>
                </div>`).join('') || '<div class="loom-mem-empty">Пусто</div>'}
                <div class="loom-mem-line">
                    <button type="button" class="loom-btn loom-btn-ghost loom-mem-export" ${busy || !m.entries.length ? 'disabled' : ''}>
                        <i class="fa-solid fa-file-import"></i> В лорбук чата
                    </button>
                    <span class="loom-mem-hint">${world ? `лорбук чата: ${esc(world)}` : 'лорбук чата будет создан'}</span>
                </div>
            </section>
        </div>`;
}

function itemOf(el) {
    const row = el.closest('[data-kind][data-index]');
    const m = memory();
    if (!row || !m) return null;
    const list = m[row.dataset.kind];
    const item = list?.[Number(row.dataset.index)];
    return item ? { m, list, item, index: Number(row.dataset.index) } : null;
}

function bind(el) {
    el.addEventListener('input', (event) => {
        const t = event.target;
        const found = itemOf(t);
        const m = memory();
        if (!m) return;
        if (t.classList.contains('loom-mem-depth')) { m.depth = Math.max(0, Math.floor(Number(t.value)) || 0); return commit(); }
        if (!found) return;
        if (t.classList.contains('loom-mem-text')) found.item.text = t.value;
        else if (t.classList.contains('loom-mem-title')) { found.item.title = t.value; found.item.dirty = true; }
        else if (t.classList.contains('loom-mem-keys')) { found.item.keys = t.value.split(',').map(k => k.trim()).filter(Boolean); found.item.dirty = true; }
        else if (t.classList.contains('loom-mem-content')) { found.item.content = t.value; found.item.dirty = true; }
        else return;
        commit();
    });
    el.addEventListener('change', (event) => {
        const t = event.target;
        const m = memory();
        if (!m) return;
        if (t.classList.contains('loom-mem-inject')) { m.inject = t.checked; commit(); }
        if (t.classList.contains('loom-mem-on')) {
            const found = itemOf(t);
            if (found) { found.item.on = t.checked; commit(); }
        }
    });
    el.addEventListener('click', async (event) => {
        const t = event.target.closest('button');
        if (!t) return;
        const m = memory();
        if (!m) return;
        if (t.classList.contains('loom-mem-del')) {
            const found = itemOf(t);
            if (found) { found.list.splice(found.index, 1); commit(); render(); }
        } else if (t.classList.contains('loom-mem-add')) {
            const kind = t.dataset.kind;
            m[kind].push(kind === 'entries'
                ? { id: newId(), title: '', keys: [], content: '', uid: null, dirty: true }
                : { id: newId(), text: '', on: true });
            commit();
            render();
        } else if (t.classList.contains('loom-mem-analyze')) {
            const range = el.querySelector('.loom-mem-range')?.value || 'new';
            const want = {};
            el.querySelectorAll('.loom-mem-want').forEach(box => { want[box.value] = box.checked; });
            if (!want.facts && !want.notes && !want.entries) return render('Отметьте, что искать.');
            await run(async () => {
                const r = await analyze(range, want);
                return `Прочитано сообщений: ${r.count}. Фактов +${r.facts}, заметок +${r.notes}, записей +${r.added}${r.updated ? `, обновлено ${r.updated}` : ''}.`;
            });
        } else if (t.classList.contains('loom-mem-export')) {
            await run(async () => {
                const r = await exportEntries();
                return `Выгружено в «${r.name}»: ${r.count}.`;
            });
        }
    });
}

async function run(fn) {
    if (busy) return;
    busy = true;
    render();
    let status;
    try {
        status = await fn();
    } catch (error) {
        console.error(LOG, 'Память чата', error);
        status = error?.message || String(error);
    } finally {
        busy = false;
    }
    render(status);
}

export async function openMemory() {
    if (!isChatOpen()) {
        toastr.info('Память чата работает только в открытом чате.');
        return;
    }
    const c = ctx();
    root = document.createElement('div');
    root.className = 'loom-mem-wrap';
    bind(root);
    render();
    try {
        await new c.Popup(root, c.POPUP_TYPE.TEXT, '', { okButton: 'Закрыть', wide: true, large: true, allowVerticalScrolling: true }).show();
    } finally {
        root = null;
    }
}

// ─── Пункт меню и запуск ────────────────────────────────────────────────────

function renderMenuItem() {
    const menu = document.getElementById('extensionsMenu');
    let item = document.getElementById('loom-memory-wand');
    if (!isChatOpen()) { item?.remove(); return; }
    if (!menu || item) return;
    item = document.createElement('div');
    item.id = 'loom-memory-wand';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.title = 'Факты, заметки и записи лорбука из этого чата';
    item.innerHTML = '<i class="fa-solid fa-brain"></i><span>Память чата</span>';
    item.addEventListener('click', () => {
        $('#extensionsMenu').hide();
        openMemory();
    });
    menu.appendChild(item);
}

/** Идемпотентна: подписывается на события Таверны один раз. */
export function initMemory() {
    if (inited) return;
    inited = true;
    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.CHAT_CHANGED, () => { renderMenuItem(); syncPrompt(); });
    renderMenuItem();
    syncPrompt();
}
