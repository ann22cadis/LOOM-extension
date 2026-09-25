/**
 * Ключевые слова лорбука и регулярные выражения.
 *
 * Проблема, которую это решает: Таверна ищет ключ подстрокой, а русские слова
 * склоняются. Ключ «Орден» не сработает на «Ордена», «Ордену», «Орденом», зато ключ
 * «орден» сработает внутри слова «ордена» — но и внутри «орденоносец» тоже.
 * Поэтому LOOM собирает из словоформ один regex с границами слова.
 *
 * Таверна распознаёт ключ вида /pattern/flags как регулярное выражение
 * (parseRegexFromString в world-info.js) — именно в этом формате мы ключи и отдаём.
 */

import { parseRegexFromString } from '../../../../world-info.js';
import { callAI, parseJsonLoose } from './api.js';
import { keyRegexPrompt } from './prompts.js';
import {
    getSettings, RU_ENDINGS_ALT, EN_ENDINGS_ALT, RU_TAILS, KEY_DECLENSIONS,
    KEY_BOUNDARY_BEFORE, KEY_BOUNDARY_AFTER,
} from './settings.js';

const LOG = '[LOOM]';

/** Ключ уже записан как регулярное выражение? */
export function isRegexKey(key) {
    return /^\/.*\/[gimsuy]*$/.test(String(key || '').trim());
}

/**
 * Проверка ключа. Обычное слово валидно всегда, regex — только если компилируется.
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateKey(key) {
    const value = String(key || '').trim();
    if (!value) return { ok: false, error: 'Пустой ключ' };
    if (!isRegexKey(value)) return { ok: true };
    try {
        // Тем же парсером, что и Таверна: иначе «валидно у нас» и «валидно у неё» разойдутся
        const regex = parseRegexFromString(value);
        if (!regex) return { ok: false, error: 'Не похоже на регулярное выражение' };
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message || 'Некорректное регулярное выражение' };
    }
}

/**
 * Экранирование для вставки текста внутрь шаблона.
 *
 * Слэш здесь наравне с метасимволами, хотя для самого движка регулярных выражений он
 * безобиден: у Таверны слэш — РАЗДЕЛИТЕЛЬ ключа (/шаблон/флаги), и неэкранированный
 * слэш внутри она считает концом выражения. parseRegexFromString в world-info.js на
 * таком шаблоне возвращает null, и ключ вроде «AC/DC» переставал быть регулярным
 * выражением вовсе — Таверна искала в тексте буквальную строку «/(?<!…)AC/DC…/i».
 * Обратно в слэш она его развернёт сама, там же.
 */
function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Флаги для собираемых ключей: только допустимые буквы и без повторов.
 *
 * Поле флагов в настройках пользователь заполняет руками, а new RegExp падает на
 * повторе («ii», «gg») — и тогда Таверна не распознаёт КАЖДЫЙ ключ лорбука, молча
 * превращая его в поиск подстроки, которая не встретится никогда.
 */
function regexFlags(override = null) {
    const raw = override ?? getSettings().lorebook_regex_flags ?? 'i';
    // u обязателен: границы слова записаны через \p{L}, без него это не буква, а «p{L}»
    return [...new Set(String(raw).replace(/[^gimsuy]/g, '') + 'u')].join('');
}

/**
 * Границы слова живут в settings.js — одним классом на локальную сборку и на промпт
 * к модели (см. KEY_LETTER_CLASS там же). Регистры в классе перечислены оба, а не
 * только строчный: он не должен зависеть от флага 'i', который пользователь волен
 * убрать в настройках.
 */
const BOUNDARY_BEFORE = KEY_BOUNDARY_BEFORE;
const BOUNDARY_AFTER = KEY_BOUNDARY_AFTER;

const HAS_CYRILLIC = /[А-Яа-яЁё]/;

/**
 * Латинский ли ключ. Настройка «Язык ключей» = en заставляет считать английскими все
 * слова (чат по-английски); иначе решает алфавит самого слова.
 */
function isLatinWord(word) {
    if ((getSettings().lorebook_key_language || 'auto') === 'en') return true;
    return !HAS_CYRILLIC.test(word);
}

/**
 * Имя собственное на -и/-о/-у/-ю/-е/-э — «Энни», «Лами», «Бепо», «Джереми», «Шарите».
 * Такие имена не склоняются, и последняя буква у них не окончание. Раньше её отрезали,
 * и ключ «Энни» превращался в «Энн» с необязательным хвостом — то есть срабатывал на
 * голое «Энн» (имя персоны) в каждом сообщении.
 */
const INDECLINABLE_NAME = /^[А-ЯЁ][а-яё]*[иоуюеэ]$/;

/** Несклоняемые нарицательные — самые частые в ролевых. */
const INDECLINABLE_WORDS = /^(кофе|пальто|такси|метро|кино|меню|радио|кафе|жюри|шоссе|пюре|кенгуру|виски|депо|бюро|шоу|хобби|кимоно|суши)$/i;

const VOWELS = 'аеёиоуыэюя';

/**
 * Беглая гласная в типовых суффиксах: отец → отца, замок → замка, котёл → котла, день → дня.
 * Только суффиксы -ец/-ок/-ёк/-ек/-ёл/-ел/-ен, где выпадение почти правило. Короткие корни
 * (пёс → пса, лев → льва) без модели не угадать: «меч» → «мч» ловил бы глагол «мчу».
 * @returns {string|null} основа без гласной
 */
function fleetingStem(stem, minLength = 4) {
    if (stem.length < minLength) return null;
    const match = stem.match(/^(.*[^аеёиоуыэюя])([еёо])([кцлн])$/i);
    return match ? match[1] + match[3] : null;
}

/**
 * Вставная гласная в родительном множественного: татуировка → татуировок, ложка → ложек.
 * Основа на согласную + «к» получает второй вариант с о/е перед «к».
 * @returns {string[]} основы
 */
function withInsertedVowel(stem) {
    const match = stem.match(/^(.*)([^аеёиоуыэюяьй])к$/i);
    if (!match) return [stem];
    const vowel = /[жчшщц]/i.test(match[2]) ? 'е' : 'о';
    return [stem, match[1] + match[2] + vowel + 'к'];
}

/**
 * Разбор слова без модели: основы и тип склонения (см. RU_TAILS).
 * @param {string} word
 * @param {boolean} [notLast] слово не последнее в составном ключе — перед существительным
 *   на -ой/-ий почти всегда стоит прилагательное («Красный замок», «другой берег»)
 * @returns {{stems: string[], decl: string}}
 */
export function inferWord(word, notLast = false) {
    const w = String(word || '').trim();
    if (isLatinWord(w)) return { stems: [w], decl: 'en' };
    if (w.length <= 2 || INDECLINABLE_NAME.test(w) || INDECLINABLE_WORDS.test(w)) return { stems: [w], decl: 'fixed' };

    const lower = w.toLowerCase();
    const cut = n => w.slice(0, w.length - n);

    // Фамилия/город на -ов/-ев/-ёв/-ин/-ын: Громова, Громовым, в Орлове
    if (/^[А-ЯЁ]/.test(w) && /(ов|ев|ёв|ин|ын)$/.test(lower) && w.length > 4) return { stems: [w], decl: 'surname' };

    // Прилагательное. -ой/-ий/-ей в конце ключа — скорее существительное (герой, Юрий, Андрей)
    if (/(ый|ая|яя|ое|ее|ые|ие)$/.test(lower) || (notLast && /(ой|ий)$/.test(lower))) {
        return { stems: [cut(2)], decl: 'adj' };
    }
    const last = lower.at(-1);
    if (last === 'а' || last === 'я') return { stems: withInsertedVowel(cut(1)), decl: 'f' };
    if (last === 'ь' || last === 'й') {
        const stem = cut(1);
        // У мягких беглая гласная и в коротких словах: день → дня, пень → пня
        const fleeting = fleetingStem(stem, 3);
        return { stems: fleeting ? [stem, fleeting] : [stem], decl: 'soft' };
    }
    if (last === 'о' || last === 'е') return { stems: [cut(1)], decl: 'n' };
    if (last === 'ы' || last === 'и') return { stems: withInsertedVowel(cut(1)), decl: 'pl' };
    if (VOWELS.includes(last)) return { stems: [w], decl: 'fixed' };

    const fleeting = fleetingStem(w);
    return { stems: fleeting ? [w, fleeting] : [w], decl: 'm' };
}

/**
 * Одно слово ключа → кусок шаблона: основы (длинные первыми) + хвост его типа.
 * @param {{stems: string[], decl: string}} word
 */
function wordToPattern({ stems, decl }) {
    const unique = [...new Set(stems.map(s => String(s || '').trim()).filter(Boolean))]
        .sort((a, b) => b.length - a.length)
        .map(stem => yoFlexible(escapeRegex(stem)));
    if (!unique.length) return '';
    const group = unique.length === 1 ? unique[0] : `(?:${unique.join('|')})`;
    if (decl === 'fixed') return group;
    if (decl === 'en') return `${group}(?:${EN_ENDINGS_ALT})?`;
    return `${group}(?:${RU_TAILS[decl] || RU_TAILS.pl})?`;
}

/**
 * Собирает ключ из разобранных слов (от модели или от inferWord).
 * @param {Array<{stems: string[], decl: string}>} words
 * @returns {string} /шаблон/флаги или '' если собрать не из чего
 */
export function buildKeyFromWords(words, options = {}) {
    const parts = (words || []).map(wordToPattern).filter(Boolean);
    if (!parts.length) return '';
    return `/${BOUNDARY_BEFORE}${parts.join('\\s+')}${BOUNDARY_AFTER}/${regexFlags(options.flags)}`;
}

/**
 * Чинит уже собранные ключи с отрезанной буквой у несклоняемого имени («Энни» → «Энн»):
 * ищет выражение, которое старая сборка дала бы из такого имени, и пересобирает его.
 * @returns {number} сколько ключей исправлено
 */
export function repairIndeclinableKeys(entry) {
    if (!Array.isArray(entry?.finalKeys) || !Array.isArray(entry?.keys)) return 0;
    let fixed = 0;
    for (const raw of entry.keys) {
        const name = String(raw || '').trim();
        if (!INDECLINABLE_NAME.test(name)) continue;
        const cut = escapeRegex(name.slice(0, -1));
        // Старая сборка ставила [её] на место КАЖДОЙ е, нынешняя — только на место ё
        const broken = [yoFlexible(cut), cut.replace(/[еёЕЁ]/g, '[её]')]
            .map(stem => `${BOUNDARY_BEFORE}${stem}(?:${RU_ENDINGS_ALT})?${BOUNDARY_AFTER}`);
        const index = entry.finalKeys.findIndex(key => {
            const match = String(key).match(/^\/([\s\S]+)\/([gimsuy]*)$/);
            return match && broken.includes(match[1]);
        });
        if (index === -1) continue;
        entry.finalKeys[index] = buildRegexKey([name]);
        fixed++;
    }
    return fixed;
}

/**
 * «е» и «ё» — одна и та же буква на практике.
 *
 * В чате их пишут вперемешку: «чёрный» и «черный», «пёс» и «пес», «Фёдор» и «Федор».
 * Для регулярного выражения это разные символы, и флаг 'i' не помогает — он про
 * регистр, а не про диакритику. Ключ «пёс» молча не срабатывал на «пес», и наоборот.
 *
 * Оба регистра в классе перечислены явно, чтобы шаблон не зависел от флага 'i',
 * который пользователь волен убрать в настройках — тот же принцип, что у границ слова.
 *
 * Подставляется в УЖЕ экранированную строку: экранирование добавляет только обратные
 * слэши перед метасимволами, кириллицу оно не трогает, так что замена безопасна.
 */
function yoFlexible(escaped) {
    // Только ё: в чате её часто пишут через е, а наоборот — почти никогда. Обратная
    // замена превращала в [еёЕЁ] каждую «е» в ключе, и регулярки становились нечитаемыми.
    // Регистр держит флаг i.
    return escaped.replace(/[ёЁ]/g, '[её]');
}

/**
 * Собирает один regex-ключ из списка словоформ — без модели, по форме слова (inferWord).
 *
 * @param {string[]} forms словоформы (сырые слова, не regex)
 * @param {{ flags?: string, boundaries?: boolean, inflect?: boolean }} [options]
 *   inflect: false — точное совпадение формы, без падежных хвостов
 * @returns {string} ключ вида /(?<![\p{L}\p{N}_])меч(?:…)?(?![\p{L}\p{N}_])/iu
 */
export function buildRegexKey(forms, options = {}) {
    const flags = regexFlags(options.flags);
    const boundaries = options.boundaries !== false;
    const inflect = options.inflect !== false;

    // Длинные формы вперёд: чередование в JS нежадное и остановится на первом совпадении
    const unique = [...new Set(forms.map(f => String(f || '').trim()).filter(Boolean))]
        .sort((a, b) => b.length - a.length)
        .map(form => {
            if (!inflect) return escapeRegex(form);
            // Составной ключ склоняем ПОСЛОВНО: в русском согласуется вся группа —
            // «чёрный кофе» → «чёрным кофе». Между словами \s+: в чате бывает и перенос строки.
            const words = form.split(/\s+/).filter(Boolean);
            return words.map((w, i) => wordToPattern(inferWord(w, i < words.length - 1))).join('\\s+');
        });

    if (!unique.length) return '';

    const body = unique.length === 1 ? unique[0] : `(?:${unique.join('|')})`;
    const pattern = boundaries ? `${BOUNDARY_BEFORE}${body}${BOUNDARY_AFTER}` : body;
    return `/${pattern}/${flags}`;
}

/**
 * Приводит выражение от модели к тому, что примет Таверна.
 * @returns {string} пустая строка, если это не компилируемый regex
 */
function normalizeModelRegex(raw) {
    const value = String(raw || '').trim();
    if (!isRegexKey(value)) return '';
    if (!validateKey(value).ok) return '';

    // Флаги задаёт пользователь в настройках: модель по привычке ставит /i, а кому-то
    // нужен, например, чистый регистрозависимый поиск
    const body = value.slice(1, value.lastIndexOf('/'));
    return `/${body}/${regexFlags()}`;
}

/**
 * Ключи → регулярные выражения, через модель.
 *
 * Почему не таблицей окончаний: чередования («друг → друзья»), беглые гласные
 * («отец → отца») и неизменяемые заимствования ломают любые правила. Модель же
 * выделяет неизменяемый корень и отдаёт готовый шаблон — см. keyRegexPrompt.
 *
 * @param {string[]} keys исходные ключи
 * @returns {Promise<Record<string, string>>} исходный ключ → выражение вида /…/i
 */
export async function buildKeyRegexes(keys) {
    const clean = [...new Set(keys.map(k => String(k || '').trim()).filter(Boolean))];
    if (!clean.length) return {};

    // Растёт с числом ключей: при сборе разом для всего лорбука (buildAllEntryKeys
    // в index.js) их может быть несколько десятков, а 2000 токенов рассчитаны на одну запись.
    // reasoningEffort: 'disabled' — промпт уже даёт готовые правила с примерами, думать
    // здесь не о чем, а thinking-модели всё равно тратят на «рассуждения» по несколько
    // сотен токенов НА КАЖДЫЙ ключ (замечено на живом ответе — reasoning_content длиннее
    // самого JSON), из-за чего короткий ответ обрывается по лимиту раньше, чем допишется.
    const maxTokens = Math.min(8000, Math.max(2000, clean.length * 120));
    const response = await callAI(keyRegexPrompt(clean), { maxTokens, reasoningEffort: 'disabled' });
    const parsed = parseJsonLoose(response, 'keys');
    const map = parsed?.keys;
    if (!map || typeof map !== 'object') {
        throw new Error('Модель не вернула регулярные выражения в ожидаемом формате.');
    }

    const result = {};
    for (const key of clean) {
        const built = keyFromModelAnswer(key, map[key]);
        if (built) result[key] = built;
        else console.warn(LOG, `Для ключа «${key}» модель не дала рабочего разбора:`, map[key]);
    }
    return result;
}

/**
 * Ответ модели по одному ключу → готовое выражение. Модель отдаёт не регулярку, а разбор:
 * по объекту на слово — основы и тип склонения. Регулярку собирает LOOM (buildKeyFromWords),
 * поэтому модель не может испортить хвост окончаний или скобки. Старый формат (готовая
 * регулярка строкой) тоже принимается.
 * @returns {string} '' если разбор негодный — тогда compileKeys соберёт ключ сам
 */
function keyFromModelAnswer(key, answer) {
    if (typeof answer === 'string') return normalizeModelRegex(answer);
    const words = Array.isArray(answer) ? answer : (answer && Array.isArray(answer.words) ? answer.words : null);
    if (!words?.length) return '';

    // Число слов должно совпасть с ключом — иначе модель что-то выкинула или придумала
    const keyWords = key.split(/\s+/).filter(Boolean);
    if (words.length !== keyWords.length) return '';

    const clean = [];
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const decl = KEY_DECLENSIONS.includes(word?.decl) ? word.decl : null;
        const stems = (Array.isArray(word?.stems) ? word.stems : [])
            .map(s => String(s || '').trim())
            // Основа — только буквы (и дефис/апостроф): никаких кусков регулярки от модели
            .filter(s => /^[\p{L}'’-]+$/u.test(s));
        if (!decl || !stems.length) return '';
        // Несклоняемое слово — это само слово целиком, основа тут не нужна. Вставную гласную
        // родительного множественного (татуировок, ложек) модель часто забывает — добавляем сами.
        if (decl === 'fixed') clean.push({ stems: [keyWords[i]], decl });
        else if (decl === 'f' || decl === 'pl') clean.push({ stems: stems.flatMap(withInsertedVowel), decl });
        else clean.push({ stems, decl });
    }
    const built = buildKeyFromWords(clean);
    return built && validateKey(built).ok ? built : '';
}

/**
 * Превращает простые ключи записи в то, что уйдёт в лорбук.
 * Regex-ключи и уже готовые выражения проходят насквозь.
 *
 * @param {string[]} keys
 * @param {Record<string, string>} [regexMap] результат buildKeyRegexes
 * @returns {string[]}
 */
export function compileKeys(keys, regexMap = null) {
    const settings = getSettings();
    const out = [];

    for (const raw of keys) {
        const key = String(raw || '').trim();
        if (!key) continue;

        // Пользователь написал regex руками — уважаем и не трогаем
        if (isRegexKey(key)) { out.push(key); continue; }

        if (!settings.lorebook_regex_keys) { out.push(key); continue; }

        // Модель не ответила или ответила мусором — собираем шаблон сами, по таблице
        // окончаний: она берёт обычные склонения без запроса к модели, а не поймает
        // только чередования корня («лев → льва») и беглые гласные («отец → отца»)
        const built = regexMap?.[key] || buildRegexKey([key]);

        // Предохранитель: наружу не уходит выражение, которого Таверна не понимает.
        // Нераспознанный шаблон она ищет в тексте БУКВАЛЬНО, вместе со слэшами и
        // скобками, то есть ключ не сработает никогда и молча. Обычное слово хуже
        // ловит падежи, но работает — это честный откат, а не тихая поломка.
        out.push(built && validateKey(built).ok ? built : key);
    }

    return [...new Set(out)];
}

/**
 * Что реально поймает ключ в тексте — для предпросмотра в интерфейсе.
 * @returns {string[]} совпадения
 */
export function testKey(key, sampleText) {
    const value = String(key || '').trim();
    if (!value || !sampleText) return [];

    if (!isRegexKey(value)) {
        // Таверна ищет обычный ключ подстрокой без учёта регистра
        const matches = [];
        const haystack = sampleText.toLowerCase();
        const needle = value.toLowerCase();
        let idx = haystack.indexOf(needle);
        while (idx !== -1) {
            matches.push(sampleText.slice(idx, idx + value.length));
            idx = haystack.indexOf(needle, idx + needle.length);
        }
        return matches;
    }

    const regex = parseRegexFromString(value);
    if (!regex) return [];
    // parseRegexFromString отдаёт выражение без 'g' — для перечисления всех совпадений он нужен
    const global = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    return [...sampleText.matchAll(global)].map(m => m[0]);
}
