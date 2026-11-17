/**
 * Память чата: долгий контекст ТЕКУЩЕГО чата.
 *
 * Хранится в chat_metadata.loom_memory — едет вместе с чатом, у каждого чата своя.
 * Открывается пунктом «Память чата» в меню расширений (виден только при открытом чате)
 * во весь экран, с отступами под вырез и TauriTavern (--tt-inset-*).
 *
 * Из чего состоит и куда идёт:
 *  - Сводка — пересказ всей истории, который каждый анализ переписывает целиком (прошлая
 *    сводка + новые сообщения). Растёт медленно, поэтому годится и для коротких, и для
 *    длинных чатов. Идёт в промпт или константной записью в лорбук чата.
 *  - Факты по категориям (сейчас, отношения, цели, тайны, мир, предметы, события) —
 *    короткие установленные вещи. Анализ может пометить старые устаревшими (герой ушёл
 *    из таверны — факт «в таверне» уходит). Включённые идут в промпт одним блоком.
 *  - Записи лорбука разных типов (персонаж, место, предмет…) — для длинных чатов: с
 *    regex-ключами (падежи) всплывают только когда о них речь. Пишутся анализом, по
 *    OOC-запросу («запиши всё про кулон») или вручную. Выгрузка обновляет на месте.
 *  - Заметки — только для игрока, модели не уходят.
 */

import { createWorldInfoEntry, world_names } from '../../../../world-info.js';
import { callAI, parseJsonLoose } from './api.js';
import { buildRegexKey, isRegexKey, validateKey } from './keys.js';

const LOG = '[LOOM]';
const META_KEY = 'loom_memory';
const PROMPT_KEY = 'LOOM_MEMORY';
const WORLD_KEY = 'world_info'; // METADATA_KEY Таверны: лорбук, привязанный к чату
const IN_CHAT = 1;
const MAX_TRANSCRIPT = 60000;
const MAX_MESSAGE = 4000;
const SUMMARY_TITLE = 'Сводка чата (LOOM)';

export const FACT_CATS = [
    { id: 'state', label: 'Сейчас', hint: 'где, когда, кто рядом, состояние героев', en: 'Current situation (place, time, who is present, injuries, clothing, condition)' },
    { id: 'relations', label: 'Отношения', hint: 'кто к кому как относится', en: 'Relationships and attitudes between characters' },
    { id: 'goals', label: 'Цели и обещания', hint: 'планы, договорённости, долги', en: 'Goals, plans, promises, deals, debts' },
    { id: 'secrets', label: 'Тайны', hint: 'кто что знает и скрывает', en: 'Secrets (who knows what, who hides what from whom)' },
    { id: 'world', label: 'Мир', hint: 'правила, законы, магия', en: 'World rules, laws, magic, customs established in play' },
    { id: 'items', label: 'Предметы', hint: 'важные вещи, у кого они', en: 'Important items and who holds them' },
    { id: 'events', label: 'События', hint: 'ключевые повороты', en: 'Key events and turning points that already happened' },
];
export const ENTRY_TYPES = [
    { id: 'character', label: 'Персонаж' },
    { id: 'place', label: 'Место' },
    { id: 'item', label: 'Предмет' },
    { id: 'faction', label: 'Фракция' },
    { id: 'event', label: 'Событие' },
    { id: 'concept', label: 'Понятие' },
    { id: 'other', label: 'Другое' },
];
const typeLabel = id => ENTRY_TYPES.find(t => t.id === id)?.label || 'Другое';

const ctx = () => SillyTavern.getContext();
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
const newId = () => Math.random().toString(36).slice(2, 10);

let inited = false;
let busy = false;
let tab = 'overview';
let status = '';
let entryFilter = 'all';
let openEntry = null; // id раскрытой записи
let overlay = null;
// Поля окна, которые не хранятся в памяти чата, — чтобы перерисовка их не сбрасывала
const form = { range: 'new', from: '', to: '', usePrev: true, showText: false, want: { summary: true, facts: true, entries: true, notes: true }, ooc: '', oocType: 'auto' };

// ─── Состояние ──────────────────────────────────────────────────────────────

function isChatOpen() {
    const c = ctx();
    return !!c.chatId && (c.characterId !== undefined || !!c.groupId);
}

/** Память текущего чата (создаёт пустую). null — чат не открыт. */
function memory() {
    const meta = ctx().chatMetadata;
    if (!meta || !isChatOpen()) return null;
    const m = meta[META_KEY] && typeof meta[META_KEY] === 'object' ? meta[META_KEY] : (meta[META_KEY] = {});
    m.summary ||= { text: '', to: 'prompt' };
    m.facts ||= [];
    m.notes ||= [];
    m.entries ||= [];
    m.opts ||= {};
    // Первая версия хранила inject/depth в корне и факты без категорий
    if (m.inject !== undefined) { m.opts.inject = m.inject; delete m.inject; }
    if (m.depth !== undefined) { m.opts.depth = m.depth; delete m.depth; }
    m.opts.inject ??= true;
    m.opts.depth ??= 4;
    m.opts.regex ??= true;
    m.opts.world ??= ''; // '' — лорбук чата (или новый); иначе имя выбранного лорбука
    for (const f of m.facts) f.cat ||= 'events';
    for (const e of m.entries) { e.type ||= 'other'; e.keys ||= []; }
    if (m.analyzedUpTo === undefined) m.analyzedUpTo = -1;
    // Сообщения удалили — «прочитано до» не может указывать дальше конца чата
    const last = (ctx().chat?.length || 0) - 1;
    if (m.analyzedUpTo > last) m.analyzedUpTo = last;
    return m;
}

/*
 * Сохранение. saveMetadataDebounced Таверны при смене чата ОТМЕНЯЕТСЯ (clearChat →
 * cancelDebouncedMetadataSave): правка за секунду до переключения терялась бы. Поэтому
 * помним, в каком чате есть несохранённое, и при закрытии окна сохраняем сразу —
 * сменить чат, не закрыв окно на весь экран, нельзя.
 */
let unsavedChat = null;

function commit() {
    unsavedChat = ctx().chatId;
    ctx().saveMetadataDebounced?.();
    syncPrompt();
}

function flush() {
    const c = ctx();
    if (unsavedChat && unsavedChat === c.chatId) c.saveMetadata?.().catch?.(e => console.warn(LOG, 'Память чата не сохранилась', e));
    unsavedChat = null;
}

/** Сводка и включённые факты — одним блоком в промпт чата. */
function syncPrompt() {
    const c = ctx();
    const m = isChatOpen() ? c.chatMetadata?.[META_KEY] : null;
    let text = '';
    if (m && (m.opts?.inject ?? m.inject ?? true)) {
        const parts = [];
        const summary = String(m.summary?.text || '').trim();
        if (summary && (m.summary.to || 'prompt') === 'prompt') parts.push(`Story so far:\n${summary}`);
        for (const cat of FACT_CATS) {
            const facts = (m.facts || []).filter(f => (f.cat || 'events') === cat.id && f.on !== false && String(f.text || '').trim());
            if (facts.length) parts.push(`${cat.en}:\n${facts.map(f => `- ${f.text.trim()}`).join('\n')}`);
        }
        if (parts.length) text = `[Memory of this chat — stay consistent with it]\n${parts.join('\n\n')}`;
    }
    const depth = Math.max(0, Math.floor(Number(m?.opts?.depth ?? m?.depth ?? 4)) || 0);
    c.setExtensionPrompt(PROMPT_KEY, text, IN_CHAT, depth, false, 0);
}

// ─── Чат как текст ──────────────────────────────────────────────────────────

/**
 * Текст сообщения без HTML-разметки: цвета, <center>, <br> и прочее оформление модели не
 * нужны для памяти, а в длинных ролевых съедали заметную часть лимита.
 */
function plainText(mes) {
    return String(mes || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|center|li|h\d)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Сообщения [from…to] без системных, с потолком по символам. Потолок режет с начала, если
 * диапазон задан руками (keepStart: человек выбрал начало — оно и должно прочитаться),
 * иначе с конца (свежее важнее). Сколько не влезло — в list.skipped.
 */
function transcript(from = 0, filter = null, { to = Infinity, keepStart = false } = {}) {
    const { chat } = ctx();
    const first = Math.max(0, from);
    const last = Math.min(chat.length - 1, to);
    const all = [];
    for (let i = first; i <= last; i++) {
        const msg = chat[i];
        if (!msg || msg.is_system) continue;
        const text = plainText(msg.mes).slice(0, MAX_MESSAGE);
        if (!text || (filter && !filter(text, i))) continue;
        all.push({ index: i, name: msg.name || (msg.is_user ? 'User' : 'Character'), text });
    }
    const list = [];
    let total = 0;
    for (const item of keepStart ? all : [...all].reverse()) {
        total += item.text.length;
        if (total > MAX_TRANSCRIPT && list.length) break;
        list.push(item);
    }
    if (!keepStart) list.reverse();
    list.skipped = all.length - list.length;
    return list;
}

/** Выбранный диапазон → {from, to, keepStart, label}; бросает понятную ошибку, если задан криво. */
function resolveRange(m, range = form.range) {
    const last = ctx().chat.length - 1;
    if (last < 0) throw new Error('В чате нет сообщений.');
    if (range === 'new') return { from: m.analyzedUpTo + 1, to: last, keepStart: false, label: 'новые' };
    if (range === 'last') return { from: Math.max(0, last - 29), to: last, keepStart: false, label: 'последние 30' };
    if (range === 'all') return { from: 0, to: last, keepStart: false, label: 'весь чат' };
    let from = Math.floor(Number(form.from));
    let to = Math.floor(Number(form.to));
    if (!Number.isFinite(from) || !Number.isFinite(to) || form.from === '' || form.to === '') {
        throw new Error('Укажите, с какого и по какое сообщение (номера #N как в чате).');
    }
    if (from > to) [from, to] = [to, from];
    if (from > last) throw new Error(`В чате сообщения только до #${last}.`);
    if (to < 0) throw new Error('Номера сообщений начинаются с #0.');
    return { from: Math.max(0, from), to: Math.min(last, to), keepStart: true, label: 'свой диапазон' };
}

const asText = list => list.map(x => `[#${x.index}] ${x.name}: ${x.text}`).join('\n\n');
const strings = list => (Array.isArray(list) ? list : []).map(x => String(x ?? '').trim()).filter(Boolean);

function castLine() {
    const c = ctx();
    return `Character(s): ${String(c.name2 || '').trim() || '(unknown)'}; player: ${String(c.name1 || '').trim() || '(unknown)'}.`;
}

/** Имена тех, кто говорит в чате: Таверна ищет ключи и в подписи говорящего, такой ключ сработает на КАЖДОМ сообщении. */
function speakerNames() {
    const c = ctx();
    const names = [c.name1, c.name2];
    // Подписи в самих сообщениях: персону могли сменить, а старые реплики подписаны прежним именем
    for (const m of (c.chat || []).slice(-300)) if (!m.is_system && m.name) names.push(m.name);
    return [...new Set(names.map(n => String(n || '').trim()).filter(Boolean))];
}

function isSpeakerKey(key) {
    const k = String(key || '').trim().toLowerCase();
    if (!k) return false;
    return speakerNames().some(name => {
        const n = name.toLowerCase();
        return k === n || n.split(/\s+/).includes(k);
    });
}

function entryRules() {
    const names = speakerNames();
    return 'Keys: 1-4 names or words that appear in chat whenever the thing is mentioned (names, nicknames, the noun itself) - '
        + 'in the chat language, base form (nominative singular): the interface adds case endings itself. '
        + (names.length ? `NEVER use these names or their parts as keys: ${names.map(n => `"${n}"`).join(', ')} - every message is `
            + 'signed with the speaker name, so such a key fires on every message. An entry about them is keyed by its topic. ' : '')
        + 'Content: 60-200 words, full name in the first sentence, only what the chat established, written as reference facts '
        + '(not a retelling of scenes).';
}

// ─── Анализ ─────────────────────────────────────────────────────────────────

function analysisPrompt(messages, want, m, usePrev = true) {
    const parts = [
        'TASK: read a fragment of a roleplay chat and update the long-term memory of this story.',
        castLine(),
        '',
        'CHAT FRAGMENT:',
        asText(messages),
        '',
    ];
    if (usePrev && want.summary) parts.push('CURRENT SUMMARY:', String(m.summary.text || '').trim() || '(none yet)', '');
    if (usePrev && m.facts.length) {
        parts.push('KNOWN FACTS (numbered):', m.facts.map((f, i) => `${i + 1}. [${f.cat}] ${f.text}`).join('\n'), '');
    }
    if (usePrev && m.entries.length) parts.push('EXISTING LOREBOOK ENTRIES:', m.entries.map(e => `- ${e.title} (${e.type})`).join('\n'), '');
    if (!usePrev) parts.push('Work ONLY from this fragment: there is no earlier memory to build on.', '');

    const fields = [];
    if (want.summary) fields.push(usePrev
        ? '  "summary": string - the CURRENT SUMMARY rewritten to include this fragment: the whole story so far in '
            + 'past tense, key turns and their consequences, no dialogue. Keep it under 250 words; compress older parts harder than recent ones.'
        : '  "summary": string - a summary of THIS fragment: what happens in it, in past tense, key turns and their '
            + 'consequences, no dialogue. Keep it under 250 words.');
    if (want.facts) {
        fields.push('  "facts": [{"cat": string, "text": string}] - NEW durable facts from this fragment. cat is one of: '
            + FACT_CATS.map(c => `"${c.id}" (${c.en})`).join(', ') + '. One short concrete sentence with names. '
            + 'Skip fleeting actions and mood. Do not repeat known facts.');
        if (usePrev) fields.push('  "outdated": [number] - numbers of KNOWN FACTS that this fragment made false or obsolete '
            + '(the hero left the place, the item was lost, the promise was kept). Empty if none.');
    }
    if (want.notes) fields.push('  "notes": [string] - notes for the player, not for the model: unresolved threads, hooks worth '
        + 'returning to, contradictions noticed. One sentence each.');
    if (want.entries) fields.push('  "entries": [{"type": string, "title": string, "keys": [string], "content": string}] - lorebook entries '
        + 'for NEW persistent things introduced in the chat that will matter again. type is one of: '
        + ENTRY_TYPES.map(t => `"${t.id}"`).join(', ') + '. To update an existing entry use its exact title and give full new content. '
        + entryRules());

    parts.push(
        'Write in the same language as the chat. Return empty arrays where there is nothing worth keeping - empty is better than padding.',
        '',
        'Respond with JSON only:',
        '{',
        fields.join(',\n'),
        '}',
    );
    return parts.join('\n');
}

function upsertEntry(m, raw) {
    const title = String(raw?.title || '').trim();
    const content = String(raw?.content || '').trim();
    if (!title || !content) return null;
    const type = ENTRY_TYPES.some(t => t.id === raw.type) ? raw.type : 'other';
    const keys = strings(raw.keys).filter(k => !isSpeakerKey(k));
    const existing = m.entries.find(e => e.title.trim().toLowerCase() === title.toLowerCase());
    if (existing) {
        existing.content = content;
        existing.keys = [...new Set([...existing.keys, ...keys])];
        existing.dirty = true;
        return { entry: existing, added: false };
    }
    const entry = { id: newId(), type, title, keys, content, constant: false, uid: null, dirty: true };
    m.entries.push(entry);
    return { entry, added: true };
}

async function analyze(range, want) {
    const m = memory();
    if (!m) throw new Error('Откройте чат.');
    const usePrev = form.usePrev;
    const sel = resolveRange(m, range);
    const messages = transcript(sel.from, null, sel);
    if (!messages.length) throw new Error(range === 'new' ? 'Новых сообщений с прошлого анализа нет.' : 'В выбранных сообщениях нет текста.');

    const reply = await callAI(analysisPrompt(messages, want, m, usePrev), {
        system: 'You keep the long-term memory of a roleplay. Answer with JSON only.',
        maxTokens: 5000,
    });
    const parsed = parseJsonLoose(reply);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Модель не вернула JSON.');
    if (memory() !== m) throw new Error('Чат сменился во время анализа — результат отброшен.');

    const r = { count: messages.length, skipped: messages.skipped || 0, facts: 0, outdated: 0, notes: 0, added: 0, updated: 0, summary: false };
    if (want.summary && String(parsed.summary || '').trim()) {
        m.summary.text = String(parsed.summary).trim();
        m.summary.dirty = true;
        r.summary = true;
    }
    if (want.facts) {
        const drop = new Set(!usePrev ? [] : (Array.isArray(parsed.outdated) ? parsed.outdated : []).map(n => Number(n) - 1));
        const before = m.facts.length;
        m.facts = m.facts.filter((_, i) => !drop.has(i));
        r.outdated = before - m.facts.length;
        const known = new Set(m.facts.map(f => f.text.trim().toLowerCase()));
        for (const raw of Array.isArray(parsed.facts) ? parsed.facts : []) {
            const text = String(typeof raw === 'string' ? raw : raw?.text || '').trim();
            if (!text || known.has(text.toLowerCase())) continue;
            known.add(text.toLowerCase());
            const cat = FACT_CATS.some(c => c.id === raw?.cat) ? raw.cat : 'events';
            m.facts.push({ id: newId(), cat, text, on: true });
            r.facts++;
        }
    }
    if (want.notes) for (const text of strings(parsed.notes)) { m.notes.push({ id: newId(), text }); r.notes++; }
    if (want.entries) for (const raw of Array.isArray(parsed.entries) ? parsed.entries : []) {
        const res = upsertEntry(m, raw);
        if (res) res.added ? r.added++ : r.updated++;
    }
    // Выбранный руками диапазон «прочитано до» не двигает: человек сам решает, что читать
    if (range !== 'range') m.analyzedUpTo = Math.max(m.analyzedUpTo, messages.at(-1).index);
    commit();
    return r;
}

/** OOC: запись о том, что попросил игрок, по всему чату (сообщения с упоминаниями — в первую очередь). */
async function oocEntry(request, type) {
    const m = memory();
    if (!m) throw new Error('Откройте чат.');
    const ask = String(request || '').trim();
    if (!ask) throw new Error('Напишите, о чём нужна запись.');

    // Грубые основы слов запроса: «кулоне» найдёт и «кулон», и «кулона»
    const words = (ask.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []).map(w => w.slice(0, Math.max(4, w.length - 2)));
    const { chat } = ctx();
    const tail = chat.length - 20;
    let messages = transcript(0, (text, i) => i >= tail || words.some(w => text.toLowerCase().includes(w)));
    if (!messages.length) messages = transcript(Math.max(0, tail));
    if (!messages.length) throw new Error('В чате нет сообщений.');

    const fixedType = type && type !== 'auto' ? type : null;
    const prompt = [
        'TASK: OOC request from the player - write ONE lorebook entry about what they ask, using only what the chat established.',
        castLine(),
        '',
        `PLAYER REQUEST (OOC): ${ask}`,
        fixedType ? `Entry type: "${fixedType}".` : `Pick the type, one of: ${ENTRY_TYPES.map(t => `"${t.id}"`).join(', ')}.`,
        '',
        'CHAT (messages that mention it, plus the latest ones):',
        asText(messages),
        '',
        m.entries.length ? `EXISTING ENTRIES (reuse the exact title to update one): ${m.entries.map(e => e.title).join('; ')}` : '',
        '',
        entryRules(),
        'If the chat says little about it, write what there is - do not invent. Same language as the chat.',
        '',
        'Respond with JSON only: {"entry": {"type": string, "title": string, "keys": [string], "content": string}}',
    ].join('\n');

    const reply = await callAI(prompt, { system: 'You write lorebook entries from roleplay chats. Answer with JSON only.', maxTokens: 2000 });
    const parsed = parseJsonLoose(reply, 'entry');
    if (memory() !== m) throw new Error('Чат сменился — результат отброшен.');
    const res = upsertEntry(m, { ...parsed?.entry, type: fixedType || parsed?.entry?.type });
    if (!res) throw new Error('Модель не вернула запись.');
    commit();
    return res;
}

// ─── Лорбук чата ────────────────────────────────────────────────────────────

/** Лорбук, привязанный к чату, — если он действительно есть в Таверне (его могли удалить). */
function boundWorld() {
    const name = ctx().chatMetadata?.[WORLD_KEY];
    return name && (world_names || []).includes(name) ? name : '';
}

/** Куда пишет память: выбранный лорбук, иначе лорбук чата, иначе новый (тогда он же и привязывается). */
async function targetWorld(m) {
    const chosen = String(m.opts.world || '');
    if (chosen && (world_names || []).includes(chosen)) return chosen;
    if (chosen) throw new Error(`Лорбука «${chosen}» больше нет в Таверне — выберите другой.`);
    return ensureChatWorld();
}

/** Свободное имя лорбука: «база», при занятом — «база 2», «база 3»… */
function freeWorldName(base) {
    const names = new Set(world_names || []);
    let name = base;
    for (let n = 2; names.has(name); n++) name = `${base} ${n}`;
    return name;
}

async function bindToChat(name) {
    const c = ctx();
    c.chatMetadata[WORLD_KEY] = name;
    await c.saveMetadata();
    $('.chat_lorebook_button').addClass('world_set');
}

/**
 * Дубль лорбука: копия целиком под новым именем, дальше память пишет в неё — оригинал не
 * меняется. Если копировали лорбук этого чата, копия встаёт на его место в ЭТОМ чате
 * (другие чаты и карточка не трогаются), иначе записи памяти не попадали бы в контекст.
 */
async function duplicateWorld(m) {
    const c = ctx();
    const source = String(m.opts.world || '') || boundWorld();
    if (!source) throw new Error('Дублировать нечего: у чата нет лорбука (или его удалили) и другой не выбран.');
    const data = await c.loadWorldInfo(source);
    if (!data?.entries) throw new Error(`Не удалось прочитать «${source}».`);
    const name = freeWorldName(`${source} + память`);
    const chatId = c.chatId;
    await c.saveWorldInfo(name, structuredClone(data), true);
    await c.updateWorldInfoList?.();
    if (ctx().chatId !== chatId) throw new Error('Чат сменился — дубль создан, но не выбран.');
    // Записи памяти, уже выгруженные в оригинал, в копии лежат под теми же номерами
    if (m.world === source) m.world = name;
    m.opts.world = name;
    const wasChatWorld = ctx().chatMetadata?.[WORLD_KEY] === source;
    if (wasChatWorld) await bindToChat(name);
    commit();
    return `Дубль «${name}» создан, память пишет в него.${wasChatWorld ? ' В этом чате он заменил оригинал, сам оригинал не изменён.' : ' Чтобы записи работали, привяжите его к чату.'}`;
}

async function ensureChatWorld() {
    const c = ctx();
    const bound = boundWorld();
    if (bound) return bound;
    const base = `LOOM память — ${String(c.name2 || 'чат').trim()}`;
    const names = new Set(world_names || []);
    let name = base;
    for (let n = 2; names.has(name); n++) name = `${base} ${n}`;
    const chatId = c.chatId;
    await c.saveWorldInfo(name, { entries: {} }, true);
    // Пока создавали лорбук, чат могли сменить — привязывать к чужому чату нельзя
    if (ctx().chatId !== chatId) throw new Error('Чат сменился — выгрузка отменена.');
    ctx().chatMetadata[WORLD_KEY] = name;
    await ctx().saveMetadata();
    await c.updateWorldInfoList?.();
    $('.chat_lorebook_button').addClass('world_set');
    return name;
}

/** Ключи записи → то, что уйдёт в лорбук: с regex — падежные выражения, готовые регулярки как есть. */
function finalKeys(keys, regex) {
    const out = [];
    for (const raw of keys) {
        const key = String(raw || '').trim();
        if (!key) continue;
        if (!regex || isRegexKey(key)) { out.push(key); continue; }
        const built = buildRegexKey([key]);
        out.push(built && validateKey(built).ok ? built : key);
    }
    return [...new Set(out)];
}

async function exportToWorld() {
    const m = memory();
    if (!m) throw new Error('Откройте чат.');
    const list = m.entries.filter(e => e.title.trim() && e.content.trim());
    const summary = String(m.summary.text || '').trim();
    const withSummary = summary && m.summary.to === 'lorebook';
    if (!list.length && !withSummary) throw new Error('Нечего выгружать: нет записей с текстом.');

    const c = ctx();
    const name = await targetWorld(m);
    let data = null;
    try { data = await c.loadWorldInfo(name); } catch { /* создадим */ }
    if (!data?.entries) data = { entries: {} };

    // uid свои только в том лорбуке, куда уже писали
    const same = m.world === name;
    const links = [];
    const put = (item, fill) => {
        const existing = same && item.uid != null ? data.entries[item.uid] : null;
        const wi = existing || createWorldInfoEntry(name, data);
        if (!wi) throw new Error('Не удалось создать запись лорбука.');
        fill(wi);
        links.push([item, wi.uid]);
    };
    for (const entry of list) {
        put(entry, wi => {
            wi.comment = entry.title.trim();
            wi.key = finalKeys(entry.keys, m.opts.regex);
            wi.content = entry.content.trim();
            wi.constant = !!entry.constant;
        });
    }
    if (withSummary) {
        put(m.summary, wi => {
            wi.comment = SUMMARY_TITLE;
            wi.key = [];
            wi.content = summary;
            wi.constant = true;
            wi.order = 1;
        });
    }
    await c.saveWorldInfo(name, data, true);
    if (memory() !== m) throw new Error('Чат сменился во время выгрузки — записи в лорбуке есть, но память чата их не запомнила.');
    for (const [item, uid] of links) { item.uid = uid; item.dirty = false; }
    m.world = name;
    commit();
    c.reloadWorldInfoEditor?.(name);
    return { name, count: links.length };
}

// ─── Панель ─────────────────────────────────────────────────────────────────

const TABS = [
    { id: 'overview', icon: 'fa-wand-magic-sparkles', label: 'Обзор' },
    { id: 'facts', icon: 'fa-list-check', label: 'Факты' },
    { id: 'entries', icon: 'fa-book', label: 'Записи' },
    { id: 'notes', icon: 'fa-note-sticky', label: 'Заметки' },
];

function typeOptions(selected, withAuto = false) {
    return (withAuto ? [{ id: 'auto', label: 'Тип: сама решит' }] : []).concat(ENTRY_TYPES)
        .map(t => `<option value="${t.id}" ${t.id === selected ? 'selected' : ''}>${esc(t.label)}</option>`).join('');
}

/** Что реально прочитается при выбранном диапазоне — для живого показа под полями. */
function selectionHtml(m) {
    let sel;
    let list;
    try {
        sel = resolveRange(m);
        list = transcript(sel.from, null, sel);
    } catch (error) {
        return `<div class="loom-mem-dim">${esc(error.message)}</div>`;
    }
    if (!list.length) return '<div class="loom-mem-dim">В этом диапазоне нет сообщений с текстом.</div>';
    const chars = list.reduce((n, x) => n + x.text.length, 0);
    const snip = x => `#${x.index} ${x.name}: ${x.text.replace(/\s+/g, ' ').slice(0, 90)}${x.text.length > 90 ? '…' : ''}`;
    return `
        <div class="loom-mem-selinfo"><b>#${list[0].index} – #${list.at(-1).index}</b> · сообщений ${list.length} · ~${chars.toLocaleString('ru-RU')} симв.
            ${list.skipped ? `<span class="loom-mem-warn">не влезло ${list.skipped} — лимит ${MAX_TRANSCRIPT.toLocaleString('ru-RU')} симв., сузьте диапазон</span>` : ''}</div>
        ${form.showText
        ? `<div class="loom-mem-seltext">${list.map(x => `<div>${esc(snip(x))}</div>`).join('')}</div>`
        : `<div class="loom-mem-dim">${esc(snip(list[0]))}${list.length > 1 ? `<br>${esc(snip(list.at(-1)))}` : ''}</div>`}
        <button type="button" class="loom-btn loom-btn-ghost loom-btn-small" data-mem="sel-text">${form.showText ? 'Свернуть текст' : 'Показать, что выбрано'}</button>`;
}

function renderOverview(m) {
    const { chat } = ctx();
    const fresh = chat.slice(m.analyzedUpTo + 1).filter(x => !x.is_system).length;
    const world = boundWorld();
    // Предупреждение нужно, только когда память и правда пошла бы в лорбук чата
    const lostWorld = !world && !m.opts.world && ctx().chatMetadata?.[WORLD_KEY];
    return `
        <section class="loom-mem-card">
            <h4><i class="fa-solid fa-magnifying-glass"></i> Анализ чата</h4>
            <select class="text_pole loom-mem-range">
                <option value="new" ${form.range === 'new' ? 'selected' : ''}>Новое с прошлого анализа — ${fresh}</option>
                <option value="last" ${form.range === 'last' ? 'selected' : ''}>Последние 30 сообщений</option>
                <option value="all" ${form.range === 'all' ? 'selected' : ''}>Весь чат — ${chat.length}</option>
                <option value="range" ${form.range === 'range' ? 'selected' : ''}>Свой диапазон сообщений…</option>
            </select>
            ${form.range === 'range' ? `
            <div class="loom-mem-row">
                <label class="loom-mem-dim">с #</label>
                <input type="number" class="text_pole loom-mem-from" min="0" max="${chat.length - 1}" value="${esc(form.from)}" placeholder="0">
                <label class="loom-mem-dim">по #</label>
                <input type="number" class="text_pole loom-mem-to" min="0" max="${chat.length - 1}" value="${esc(form.to)}" placeholder="${chat.length - 1}">
                <button type="button" class="loom-btn loom-btn-accent" data-mem="pick-chat"><i class="fa-solid fa-hand-pointer"></i> Выбрать в чате</button>
            </div>
            <div class="loom-mem-dim">Номера как у сообщений в чате (#0 — первое, всего до #${chat.length - 1}).</div>` : ''}
            <div class="loom-mem-sel">${selectionHtml(m)}</div>
            <label class="loom-mem-switch" title="Выключено — память строится только по выбранным сообщениям, как с чистого листа">
                <input type="checkbox" class="loom-mem-useprev" ${form.usePrev ? 'checked' : ''}>
                <span>Учитывать прошлую память (сводку, факты, записи)</span></label>
            ${form.usePrev ? '' : '<div class="loom-mem-dim">Прошлая память модели не показывается. Сводка будет заново по этим сообщениям и заменит старую; устаревшие факты не вычёркиваются.</div>'}
            <div class="loom-mem-chips">
                ${[['summary', 'Сводка'], ['facts', 'Факты'], ['entries', 'Записи'], ['notes', 'Заметки']].map(([v, l]) => `
                <label class="loom-mem-chip"><input type="checkbox" class="loom-mem-want" value="${v}" ${form.want[v] ? 'checked' : ''}><span>${l}</span></label>`).join('')}
            </div>
            <button type="button" class="loom-btn loom-btn-primary loom-mem-wide" data-mem="analyze">
                <i class="fa-solid fa-magnifying-glass"></i> Анализировать
            </button>
        </section>

        <section class="loom-mem-card">
            <h4><i class="fa-solid fa-comment-dots"></i> OOC: запись о чём-то</h4>
            <textarea class="text_pole loom-mem-ooc" rows="2" placeholder="Например: всё, что известно о серебряном кулоне">${esc(form.ooc)}</textarea>
            <div class="loom-mem-row">
                <select class="text_pole loom-mem-ooc-type">${typeOptions(form.oocType, true)}</select>
                <button type="button" class="loom-btn loom-btn-accent" data-mem="ooc"><i class="fa-solid fa-pen-nib"></i> Написать</button>
            </div>
        </section>

        <section class="loom-mem-card">
            <h4><i class="fa-solid fa-scroll"></i> Сводка</h4>
            <textarea class="text_pole loom-mem-summary" rows="7" placeholder="Пересказ истории. Пишется анализом, можно править.">${esc(m.summary.text)}</textarea>
            <div class="loom-mem-row">
                <span class="loom-mem-dim">Куда:</span>
                <select class="text_pole loom-mem-summary-to">
                    <option value="prompt" ${m.summary.to === 'prompt' ? 'selected' : ''}>в промпт</option>
                    <option value="lorebook" ${m.summary.to === 'lorebook' ? 'selected' : ''}>в лорбук (const)</option>
                    <option value="off" ${m.summary.to === 'off' ? 'selected' : ''}>никуда</option>
                </select>
            </div>
        </section>

        <section class="loom-mem-card">
            <h4><i class="fa-solid fa-sliders"></i> Настройки</h4>
            <label class="loom-mem-switch"><input type="checkbox" class="loom-mem-opt" data-opt="inject" ${m.opts.inject ? 'checked' : ''}>
                <span>Сводка и факты в промпт, глубина</span></label>
            <input type="number" class="text_pole loom-mem-depth" min="0" max="99" value="${Number(m.opts.depth) || 0}">
            <label class="loom-mem-switch"><input type="checkbox" class="loom-mem-opt" data-opt="regex" ${m.opts.regex ? 'checked' : ''}>
                <span>Regex-ключи в лорбуке (ловят падежи)</span></label>
        </section>

        <section class="loom-mem-card">
            <h4><i class="fa-solid fa-book-atlas"></i> Лорбук для записей</h4>
            ${renderWorldPicker(m, world)}
            ${lostWorld ? `<div class="loom-mem-warn">К чату привязан «${esc(lostWorld)}», но такого лорбука в Таверне нет — при выгрузке будет создан новый.</div>` : ''}
            <div class="loom-mem-dim">Короткий чат — хватит сводки и фактов. Длинный — записи в лорбук: всплывают по ключам, только когда о них речь.</div>
        </section>`;
}

function renderWorldPicker(m, bound) {
    const chosen = String(m.opts.world || '');
    const names = [...(world_names || [])].sort((a, b) => a.localeCompare(b));
    const target = chosen || bound || '';
    const active = target && target === bound;
    return `
        <select class="text_pole loom-mem-world">
            <option value="" ${!chosen ? 'selected' : ''}>${bound ? `Лорбук этого чата — ${esc(bound)}` : 'Новый «LOOM память» — создастся и привяжется к чату'}</option>
            <optgroup label="Другой лорбук">
                ${names.filter(n => n !== bound).map(n => `<option value="${esc(n)}" ${n === chosen ? 'selected' : ''}>${esc(n)}</option>`).join('')}
            </optgroup>
        </select>
        <div class="loom-mem-row">
            <button type="button" class="loom-btn loom-btn-ghost" data-mem="dup-world" ${target ? '' : 'disabled'}
                title="Копия лорбука, в которую пишется память; оригинал не меняется"><i class="fa-solid fa-clone"></i> Сделать дубль</button>
            ${target && !active ? `<button type="button" class="loom-btn loom-btn-ghost" data-mem="bind-world"
                title="Сделать лорбуком этого чата"><i class="fa-solid fa-link"></i> Привязать к чату</button>` : ''}
        </div>
        <div class="loom-mem-dim">${!target ? 'При первой выгрузке создастся отдельный лорбук и привяжется к чату.'
            : active ? `Записи пишутся в «${esc(target)}» — он подключён к этому чату.`
                : `Записи пишутся в «${esc(target)}». Он не привязан к чату — сработает, только если включён иначе (глобально или у карточки).${bound ? ` Привязка заменит в этом чате «${esc(bound)}».` : ''}`}</div>
        <div class="loom-mem-dim">Пишутся только записи памяти; чужие записи лорбука не трогаются, свои обновляются на месте.</div>`;
}

function renderFacts(m) {
    return FACT_CATS.map(cat => {
        const facts = m.facts.map((f, i) => ({ f, i })).filter(x => x.f.cat === cat.id);
        return `
        <section class="loom-mem-card">
            <h4>${esc(cat.label)} <span class="loom-mem-count">${facts.length}</span>
                <button type="button" class="loom-icon-btn loom-mem-push" data-mem="add-fact" data-cat="${cat.id}" title="Добавить"><i class="fa-solid fa-plus"></i></button></h4>
            <div class="loom-mem-dim">${esc(cat.hint)}</div>
            ${facts.map(({ f, i }) => `
            <div class="loom-mem-item" data-list="facts" data-index="${i}">
                <input type="checkbox" class="loom-mem-on" title="В промпт" ${f.on !== false ? 'checked' : ''}>
                <textarea class="text_pole loom-mem-text" rows="1">${esc(f.text)}</textarea>
                <button type="button" class="loom-icon-btn" data-mem="del" title="Удалить"><i class="fa-solid fa-trash"></i></button>
            </div>`).join('')}
        </section>`;
    }).join('');
}

function renderEntries(m) {
    const shown = m.entries.map((e, i) => ({ e, i })).filter(x => entryFilter === 'all' || x.e.type === entryFilter);
    const counts = Object.fromEntries(ENTRY_TYPES.map(t => [t.id, m.entries.filter(e => e.type === t.id).length]));
    const pending = m.entries.filter(e => e.dirty).length + (m.summary.to === 'lorebook' && m.summary.dirty ? 1 : 0);
    return `
        <div class="loom-mem-row loom-mem-sticky">
            <button type="button" class="loom-btn loom-btn-primary" data-mem="new-entry"><i class="fa-solid fa-plus"></i> Создать запись</button>
            <button type="button" class="loom-btn loom-btn-accent" data-mem="export"><i class="fa-solid fa-file-import"></i> В лорбук чата${pending ? ` (${pending})` : ''}</button>
        </div>
        <div class="loom-mem-chips">
            <button type="button" class="loom-mem-chip ${entryFilter === 'all' ? 'on' : ''}" data-mem="filter" data-type="all">Все ${m.entries.length}</button>
            ${ENTRY_TYPES.filter(t => counts[t.id]).map(t => `
            <button type="button" class="loom-mem-chip ${entryFilter === t.id ? 'on' : ''}" data-mem="filter" data-type="${t.id}">${esc(t.label)} ${counts[t.id]}</button>`).join('')}
        </div>
        ${shown.map(({ e, i }) => {
            const open = openEntry === e.id;
            const state = e.uid == null ? 'не выгружена' : e.dirty ? 'изменена' : 'в лорбуке';
            return `
            <section class="loom-mem-card loom-mem-entry ${open ? 'open' : ''}" data-list="entries" data-index="${i}">
                <div class="loom-mem-entry-head" data-mem="toggle-entry">
                    <span class="loom-mem-badge">${esc(typeLabel(e.type))}</span>
                    <b>${esc(e.title || 'Без названия')}</b>
                    <span class="loom-mem-dim">${state}</span>
                    <i class="fa-solid fa-chevron-${open ? 'up' : 'down'}"></i>
                </div>
                ${open ? `
                <div class="loom-mem-row">
                    <select class="text_pole loom-mem-type">${typeOptions(e.type)}</select>
                    <label class="loom-mem-switch"><input type="checkbox" class="loom-mem-const" ${e.constant ? 'checked' : ''}><span>const</span></label>
                </div>
                <input type="text" class="text_pole loom-mem-title" value="${esc(e.title)}" placeholder="Название">
                <input type="text" class="text_pole loom-mem-keys" value="${esc(e.keys.join(', '))}" placeholder="Ключи через запятую">
                <textarea class="text_pole loom-mem-content" rows="6" placeholder="Текст записи">${esc(e.content)}</textarea>
                <div class="loom-mem-row">
                    <button type="button" class="loom-btn loom-btn-ghost" data-mem="del"><i class="fa-solid fa-trash"></i> Удалить из памяти</button>
                    <span class="loom-mem-dim">в лорбуке останется</span>
                </div>` : `<div class="loom-mem-dim loom-mem-preview">${esc(e.content.slice(0, 140))}</div>`}
            </section>`;
        }).join('') || '<div class="loom-mem-empty">Записей нет. Их пишет анализ, OOC-запрос или «Создать запись».</div>'}`;
}

function renderNotes(m) {
    return `
        <div class="loom-mem-row loom-mem-sticky">
            <button type="button" class="loom-btn loom-btn-primary" data-mem="add-note"><i class="fa-solid fa-plus"></i> Заметка</button>
            <span class="loom-mem-dim">только для вас, модели не уходят</span>
        </div>
        ${m.notes.map((n, i) => `
        <div class="loom-mem-item" data-list="notes" data-index="${i}">
            <textarea class="text_pole loom-mem-text" rows="2">${esc(n.text)}</textarea>
            <button type="button" class="loom-icon-btn" data-mem="del" title="Удалить"><i class="fa-solid fa-trash"></i></button>
        </div>`).join('') || '<div class="loom-mem-empty">Пусто</div>'}`;
}

function render() {
    if (!overlay) return;
    const m = memory();
    if (!m) { closeMemory(); return; }
    const scroll = overlay.querySelector('.loom-mem-body')?.scrollTop || 0;
    const counts = { facts: m.facts.length, entries: m.entries.length, notes: m.notes.length };
    overlay.innerHTML = `
        <div class="loom-mem-panel ${busy ? 'busy' : ''}">
            <header class="loom-mem-top">
                <i class="fa-solid fa-brain"></i>
                <div class="loom-mem-titles"><b>Память чата</b><span>${esc(ctx().name2 || '')}</span></div>
                <button type="button" class="loom-icon-btn" data-mem="close" title="Закрыть"><i class="fa-solid fa-xmark"></i></button>
            </header>
            <nav class="loom-mem-tabs">
                ${TABS.map(t => `<button type="button" class="${t.id === tab ? 'on' : ''}" data-mem="tab" data-tab="${t.id}">
                    <i class="fa-solid ${t.icon}"></i><span>${t.label}${counts[t.id] ? ` ${counts[t.id]}` : ''}</span></button>`).join('')}
            </nav>
            ${busy || status ? `<div class="loom-mem-status">${busy ? '<i class="fa-solid fa-spinner fa-spin"></i> ' : ''}${esc(busy || status)}</div>` : ''}
            <div class="loom-mem-body">
                ${tab === 'facts' ? renderFacts(m) : tab === 'entries' ? renderEntries(m) : tab === 'notes' ? renderNotes(m) : renderOverview(m)}
            </div>
        </div>`;
    const body = overlay.querySelector('.loom-mem-body');
    if (body) body.scrollTop = scroll;
}

function itemOf(el) {
    const row = el.closest('[data-list][data-index]');
    const m = memory();
    if (!row || !m) return null;
    const list = m[row.dataset.list];
    const index = Number(row.dataset.index);
    return list?.[index] ? { m, list, item: list[index], index } : null;
}

async function run(label, fn) {
    if (busy) return;
    busy = label;
    status = '';
    render();
    try {
        status = await fn();
    } catch (error) {
        console.error(LOG, 'Память чата', error);
        status = error?.message || String(error);
    } finally {
        busy = false;
    }
    render();
}

function onInput(event) {
    const t = event.target;
    const m = memory();
    if (!m) return;
    if (t.classList.contains('loom-mem-ooc')) { form.ooc = t.value; return; }
    if (t.classList.contains('loom-mem-from') || t.classList.contains('loom-mem-to')) {
        form[t.classList.contains('loom-mem-from') ? 'from' : 'to'] = t.value;
        const box = overlay?.querySelector('.loom-mem-sel');
        if (box) box.innerHTML = selectionHtml(m);
        return;
    }
    if (t.classList.contains('loom-mem-summary')) { m.summary.text = t.value; m.summary.dirty = true; return commit(); }
    if (t.classList.contains('loom-mem-depth')) { m.opts.depth = Math.max(0, Math.floor(Number(t.value)) || 0); return commit(); }
    const found = itemOf(t);
    if (!found) return;
    const { item } = found;
    if (t.classList.contains('loom-mem-text')) item.text = t.value;
    else if (t.classList.contains('loom-mem-title')) { item.title = t.value; item.dirty = true; }
    else if (t.classList.contains('loom-mem-keys')) { item.keys = t.value.split(',').map(k => k.trim()).filter(Boolean); item.dirty = true; }
    else if (t.classList.contains('loom-mem-content')) { item.content = t.value; item.dirty = true; }
    else return;
    commit();
}

function onChange(event) {
    const t = event.target;
    const m = memory();
    if (!m) return;
    if (t.classList.contains('loom-mem-range')) { form.range = t.value; return render(); }
    if (t.classList.contains('loom-mem-useprev')) { form.usePrev = t.checked; return render(); }
    if (t.classList.contains('loom-mem-want')) { form.want[t.value] = t.checked; return; }
    if (t.classList.contains('loom-mem-ooc-type')) { form.oocType = t.value; return; }
    if (t.classList.contains('loom-mem-world')) { m.opts.world = t.value; commit(); return render(); }
    if (t.classList.contains('loom-mem-opt')) { m.opts[t.dataset.opt] = t.checked; return commit(); }
    if (t.classList.contains('loom-mem-summary-to')) { m.summary.to = t.value; m.summary.dirty = true; return commit(); }
    const found = itemOf(t);
    if (!found) return;
    if (t.classList.contains('loom-mem-on')) found.item.on = t.checked;
    else if (t.classList.contains('loom-mem-const')) { found.item.constant = t.checked; found.item.dirty = true; }
    else if (t.classList.contains('loom-mem-type')) { found.item.type = t.value; found.item.dirty = true; commit(); return render(); }
    else return;
    commit();
}

async function onClick(event) {
    const t = event.target.closest('[data-mem]');
    if (!t) return;
    const action = t.dataset.mem;
    if (busy && action !== 'close' && action !== 'tab') return;
    const m = memory();
    if (!m) return;
    switch (action) {
        case 'close': return closeMemory();
        case 'tab': tab = t.dataset.tab; status = ''; return render();
        case 'filter': entryFilter = t.dataset.type; return render();
        case 'toggle-entry': {
            const found = itemOf(t);
            if (found) openEntry = openEntry === found.item.id ? null : found.item.id;
            return render();
        }
        case 'del': {
            const found = itemOf(t);
            if (found) { found.list.splice(found.index, 1); commit(); render(); }
            return;
        }
        case 'add-fact':
            m.facts.push({ id: newId(), cat: t.dataset.cat, text: '', on: true });
            commit();
            render();
            overlay.querySelector(`[data-list="facts"][data-index="${m.facts.length - 1}"] textarea`)?.focus();
            return;
        case 'add-note':
            m.notes.unshift({ id: newId(), text: '' });
            commit();
            render();
            overlay.querySelector('[data-list="notes"][data-index="0"] textarea')?.focus();
            return;
        case 'new-entry': {
            const type = entryFilter !== 'all' ? entryFilter : 'other';
            const entry = { id: newId(), type, title: '', keys: [], content: '', constant: false, uid: null, dirty: true };
            m.entries.unshift(entry);
            openEntry = entry.id;
            commit();
            render();
            overlay.querySelector('.loom-mem-entry.open .loom-mem-title')?.focus();
            return;
        }
        case 'sel-text': form.showText = !form.showText; return render();
        case 'pick-chat': return startPick();
        case 'analyze': {
            const range = form.range;
            const want = { ...form.want };
            if (!Object.values(want).some(Boolean)) { status = 'Отметьте, что обновлять.'; return render(); }
            return run('Анализирую чат…', async () => {
                const r = await analyze(range, want);
                return [`Прочитано сообщений: ${r.count}${r.skipped ? ` (не влезло ${r.skipped})` : ''}.`,
                    r.summary ? 'Сводка обновлена.' : '',
                    want.facts ? `Фактов +${r.facts}${r.outdated ? `, устарело ${r.outdated}` : ''}.` : '',
                    want.entries ? `Записей +${r.added}${r.updated ? `, обновлено ${r.updated}` : ''}.` : '',
                    want.notes ? `Заметок +${r.notes}.` : ''].filter(Boolean).join(' ');
            });
        }
        case 'ooc': {
            return run('Пишу запись…', async () => {
                const { entry, added } = await oocEntry(form.ooc, form.oocType);
                form.ooc = '';
                openEntry = entry.id;
                entryFilter = 'all';
                tab = 'entries';
                return `${added ? 'Запись создана' : 'Запись обновлена'}: «${entry.title}».`;
            });
        }
        case 'dup-world':
            return run('Создаю дубль…', async () => duplicateWorld(m));
        case 'bind-world':
            return run('Привязываю…', async () => {
                const name = String(m.opts.world || '');
                if (!name) throw new Error('Сначала выберите лорбук.');
                const old = ctx().chatMetadata?.[WORLD_KEY];
                await bindToChat(name);
                return `«${name}» — теперь лорбук этого чата.${old ? ` «${old}» в этом чате отключён (сам не изменён).` : ''}`;
            });
        case 'export':
            return run('Выгружаю в лорбук…', async () => {
                const r = await exportToWorld();
                return `Выгружено в «${r.name}»: ${r.count}.`;
            });
    }
}

// ─── Выбор диапазона прямо в чате ───────────────────────────────────────────
//
// Окно памяти прячется, внизу появляется плашка; нажатия по сообщениям чата ловятся
// (ничего другого они в этот момент не делают): первое нажатие — начало, второе — конец,
// сообщения между ними подсвечиваются. Старые сообщения, которых нет на экране
// (Таверна рисует только последние), задаются числами в самом окне.

let pick = null; // {a, b, bar, observer}

function pickRange() {
    const { a, b } = pick;
    if (a == null) return null;
    return b == null ? [a, a] : [Math.min(a, b), Math.max(a, b)];
}

function paintPick() {
    const range = pickRange();
    document.querySelectorAll('#chat .mes').forEach(el => {
        const id = Number(el.getAttribute('mesid'));
        const inside = range && id >= range[0] && id <= range[1];
        el.classList.toggle('loom-pick-in', !!inside);
        el.classList.toggle('loom-pick-edge', !!inside && (id === range[0] || id === range[1]));
    });
    const text = !range ? 'Нажмите на первое сообщение диапазона'
        : pick.b == null ? `С #${range[0]} — нажмите на последнее сообщение`
            : `Выбрано #${range[0]} – #${range[1]} (сообщений ${range[1] - range[0] + 1})`;
    pick.bar.querySelector('.loom-pick-text').textContent = text;
    pick.bar.querySelector('[data-pick="done"]').disabled = !range || pick.b == null;
}

function onPickClick(event) {
    if (!pick) return;
    if (event.target.closest('#loom-pickbar')) return;
    const mes = event.target.closest('#chat .mes');
    if (!mes) return;
    event.preventDefault();
    event.stopPropagation();
    const id = Number(mes.getAttribute('mesid'));
    if (!Number.isFinite(id)) return;
    if (pick.a == null || pick.b != null) { pick.a = id; pick.b = null; } else pick.b = id;
    paintPick();
}

function endPick(apply) {
    if (!pick) return;
    const range = apply ? pickRange() : null;
    document.removeEventListener('click', onPickClick, true);
    pick.observer?.disconnect();
    document.querySelectorAll('#chat .mes').forEach(el => el.classList.remove('loom-pick-in', 'loom-pick-edge'));
    pick.bar.remove();
    pick = null;
    if (!overlay) return;
    overlay.style.display = '';
    if (range) { form.from = String(range[0]); form.to = String(range[1]); form.range = 'range'; }
    render();
}

function startPick() {
    if (!overlay || pick) return;
    const bar = document.createElement('div');
    bar.id = 'loom-pickbar';
    bar.innerHTML = `
        <span class="loom-pick-text"></span>
        <button type="button" class="loom-btn loom-btn-primary loom-btn-small" data-pick="done">Готово</button>
        <button type="button" class="loom-btn loom-btn-ghost loom-btn-small" data-pick="reset">Сбросить</button>
        <button type="button" class="loom-btn loom-btn-ghost loom-btn-small" data-pick="cancel">Отмена</button>`;
    bar.addEventListener('click', (event) => {
        const kind = event.target.closest('[data-pick]')?.dataset.pick;
        if (kind === 'done') endPick(true);
        else if (kind === 'cancel') endPick(false);
        else if (kind === 'reset') { pick.a = null; pick.b = null; paintPick(); }
    });
    document.body.appendChild(bar);
    pick = { a: null, b: null, bar };
    const from = Math.floor(Number(form.from));
    const to = Math.floor(Number(form.to));
    if (form.from !== '' && form.to !== '' && Number.isFinite(from) && Number.isFinite(to)) { pick.a = Math.min(from, to); pick.b = Math.max(from, to); }
    overlay.style.display = 'none';
    document.addEventListener('click', onPickClick, true);
    // «Показать ещё сообщения» дорисовывает старые — подсветка должна лечь и на них
    const chatEl = document.getElementById('chat');
    if (chatEl) {
        let frame = 0;
        pick.observer = new MutationObserver(() => {
            if (frame) return;
            frame = requestAnimationFrame(() => { frame = 0; if (pick) paintPick(); });
        });
        pick.observer.observe(chatEl, { childList: true });
    }
    paintPick();
}

export function openMemory() {
    if (!isChatOpen()) {
        toastr.info('Память чата работает только в открытом чате.');
        return;
    }
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'loom-memory';
        overlay.addEventListener('input', onInput);
        overlay.addEventListener('change', onChange);
        overlay.addEventListener('click', onClick);
        document.body.appendChild(overlay);
    }
    status = '';
    render();
}

export function closeMemory() {
    if (pick) endPick(false);
    if (overlay) flush();
    overlay?.remove();
    overlay = null;
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
    item.title = 'Сводка, факты, записи лорбука и заметки этого чата';
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
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        unsavedChat = null; // никогда не сохраняем в НОВЫЙ чат то, что правили в старом
        closeMemory();
        renderMenuItem();
        syncPrompt();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (pick) endPick(false);
        else if (overlay && !busy) closeMemory();
    });
    renderMenuItem();
    syncPrompt();
}
