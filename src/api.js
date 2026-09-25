/**
 * Слой генерации LOOM.
 *
 * Перенесён из NOVA: там этот код уже прошёл через грабли с профилями подключения,
 * пресетами, прокси и reasoning-моделями. Здесь он обобщён под настройки LOOM.
 *
 * Главное, что тут решается:
 *  1. Запрос уходит либо в главный API Таверны (generateRaw), либо в выбранный
 *     профиль подключения (ConnectionManagerRequestService) — второе предпочтительнее.
 *  2. Настройки подключения берутся из ЖИВЫХ настроек Таверны, а не из снимка в пресете
 *     профиля: пресет устаревает, и половина payload теряется.
 *  3. Рассуждения глушатся, потому что у reasoning-моделей они едят тот же бюджет
 *     токенов, что и ответ, и стабильно рвут JSON на полуслове.
 */

import { generateRaw } from '../../../../../script.js';
import { getSettings, DEFAULTS } from './settings.js';

const LOG = '[LOOM]';

// ─── Остановка генерации ────────────────────────────────────────────────────

/**
 * Текущий сигнал отмены — выставляется withBusy() в index.js на время операции.
 * Общий на весь модуль, а не параметр callAI(), потому что LOOM в моменте ведёт
 * только одну операцию (см. state.busy) и кнопке «Стоп» незачем знать, какой именно
 * вызов callAI() сейчас летит — она просто гасит текущий сигнал.
 */
let currentAbortSignal = null;

export function setAbortSignal(signal) {
    currentAbortSignal = signal || null;
}

function abortedError() {
    return Object.assign(new Error('Генерация остановлена.'), { aborted: true });
}

// ─── Разбор ответа ──────────────────────────────────────────────────────────

/** Достаёт текст из любого формата ответа бэкенда (OpenAI / Claude / Google / textgen). */
export function extractTextFromResponse(response) {
    if (response === null || response === undefined) return '';
    if (typeof response === 'string') return response;

    // ExtractedData из сервисов Таверны
    if (typeof response.content === 'string') return response.content;

    const choice = Array.isArray(response.choices) ? response.choices[0] : null;
    if (choice) {
        if (typeof choice.message?.content === 'string') return choice.message.content;
        if (Array.isArray(choice.message?.content)) {
            return choice.message.content.map(part => part?.text || '').join('');
        }
        if (typeof choice.text === 'string') return choice.text;
    }

    if (Array.isArray(response.content)) {
        return response.content.filter(p => p?.type !== 'thinking').map(p => p?.text || '').join('');
    }
    if (typeof response.text === 'string') return response.text;
    if (Array.isArray(response.candidates)) {
        return response.candidates[0]?.content?.parts?.map(p => p?.text || '').join('') || '';
    }
    if (Array.isArray(response.results)) {
        return response.results[0]?.text || '';
    }
    return '';
}

function describeApiError(error) {
    const raw = error?.message || String(error || '');
    // Таверна оборачивает всё в 'API request failed' — из такого текста пользователю ничего не понятно
    if (/API request failed/i.test(raw) && error?.cause) {
        return String(error.cause.message || error.cause);
    }
    return raw || 'Неизвестная ошибка запроса';
}

// ─── Рассуждения ────────────────────────────────────────────────────────────

// Словарь Таверны (REASONING_EFFORT в prompt-converters.js) плюс наши 'inherit' и 'disabled'
const REASONING_EFFORT_VALUES = ['inherit', 'disabled', 'auto', 'min', 'low', 'medium', 'high', 'max'];

/**
 * Единого значения «выключить рассуждения» в Таверне нет — каждый бэкенд гасит их по-своему.
 * Сверено с src/endpoints/backends/chat-completions.js и src/prompt-converters.js.
 */
const REASONING_OFF_BY_SOURCE = {
    makersuite: 'min',      // calculateGoogleBudgetTokens: 'min' → thinkingBudget 0
    vertexai: 'min',
    claude: 'auto',         // calculateClaudeBudgetTokens: 'auto' → блок thinking в запрос не попадает
    openrouter: 'none',     // reasoning.effort = 'none' + reasoning.exclude = true
};
const REASONING_OFF_FALLBACK = 'min';

function normalizeReasoningEffort(effort) {
    const value = String(effort ?? '').trim();
    if (value === '0') return 'disabled';
    return REASONING_EFFORT_VALUES.includes(value) ? value : DEFAULTS.thinking_budget;
}

/**
 * Поля payload для настройки «Рассуждения». Значение уходит СЫРЫМ, без клиентского
 * ремаппинга: ремаппинг из getReasoningEffort применяется к настройкам пресета,
 * а наш overridePayload идёт поверх.
 *
 * Поле должно присутствовать ВСЕГДА: createRequestData вычищает undefined ДО мержа
 * с пресетом, поэтому «не передать reasoning_effort» означает не «оставить по умолчанию»,
 * а «взять значение из пресета профиля».
 */
function buildReasoningPayload(effort, source) {
    const value = normalizeReasoningEffort(effort);
    // «Наследовать» — не кладём в payload ни одного поля про рассуждения
    if (value === 'inherit') return {};
    return {
        reasoning_effort: value === 'disabled'
            ? (REASONING_OFF_BY_SOURCE[source] ?? REASONING_OFF_FALLBACK)
            : value,
        // Сами рассуждения LOOM нигде не показывает, а в ответе они только жгут бюджет
        include_reasoning: false,
    };
}

/**
 * generateRaw не принимает оверрайды payload, поэтому для главного API настройку
 * рассуждений временно проставляем прямо в настройки Chat Completion.
 * @returns {() => void} функция отката
 */
function applyMainApiReasoning(ctx, effort) {
    const settings = ctx?.chatCompletionSettings;
    // Text Completion не умеет reasoning_effort — там настройка неприменима
    if (!settings || ctx.mainApi !== 'openai') return () => {};

    const payload = buildReasoningPayload(effort, settings.chat_completion_source);
    if (payload.reasoning_effort === undefined) return () => {};

    const prevEffort = settings.reasoning_effort;
    const prevShowThoughts = settings.show_thoughts;
    settings.reasoning_effort = payload.reasoning_effort;
    settings.show_thoughts = payload.include_reasoning;

    return () => {
        settings.reasoning_effort = prevEffort;
        settings.show_thoughts = prevShowThoughts;
    };
}

// Порядок важен: сначала наш рабочий тег (в нём приходит думалка), потом чужие варианты
const DEFAULT_REASONING_TAGS = [
    ['<thinking>', '</thinking>'],
    ['<think>', '</think>'],
    ['<reasoning>', '</reasoning>'],
];

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Пары тегов, по которым режем размышления. Приоритет:
 * настройки LOOM → шаблон рассуждений Таверны → общеизвестные теги.
 * Как и в Таверне, пара учитывается только если заполнены ОБА поля.
 */
function getReasoningTagPairs(ctx) {
    const settings = getSettings();
    const pairs = [];

    const ownPrefix = String(settings.reasoning_prefix ?? '').trim();
    const ownSuffix = String(settings.reasoning_suffix ?? '').trim();
    if (ownPrefix && ownSuffix) pairs.push([ownPrefix, ownSuffix]);

    const template = ctx?.powerUserSettings?.reasoning;
    if (template?.prefix && template?.suffix) pairs.push([template.prefix, template.suffix]);

    pairs.push(...DEFAULT_REASONING_TAGS);

    const seen = new Set();
    return pairs.filter(([prefix, suffix]) => {
        const key = `${prefix}::${suffix}`.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function stripReasoningBlocks(text) {
    const ctx = SillyTavern.getContext();
    const settings = getSettings();
    if (settings.reasoning_auto_parse === false) return String(text).trim();

    const pairs = getReasoningTagPairs(ctx);
    let result = String(text);

    // Если мы сами преднаполнили ответ открывающим тегом, настоящий ответ начинается
    // только ПОСЛЕ закрывающего. Нет закрывающего — модель не доехала дальше размышлений.
    const prefill = getStartReplyWith();
    if (prefill) {
        const suffix = pairs.find(([prefix]) => prefix.toLowerCase() === prefill.toLowerCase())?.[1];
        if (suffix && !result.toLowerCase().includes(suffix.toLowerCase())) {
            console.warn(LOG, 'Ответ оборвался внутри размышлений — ни закрывающего тега, ни ответа.');
            return '';
        }
    }

    for (const [prefix, suffix] of pairs) {
        result = result.replace(new RegExp(`${escapeRegex(prefix)}[\\s\\S]*?${escapeRegex(suffix)}`, 'gi'), '');

        // Осиротевший закрывающий тег: размышления есть, открывающего тега нет.
        // Так отвечают модели, которым думалку показали примером — они считают блок уже
        // открытым и начинают прямо с текста. Всё до последнего закрывающего тега —
        // размышления, ответ начинается после него.
        if (!result.toLowerCase().includes(prefix.toLowerCase())) {
            const idx = result.toLowerCase().lastIndexOf(suffix.toLowerCase());
            if (idx !== -1) result = result.slice(idx + suffix.length);
        }
    }
    return result.trim();
}

/**
 * Экспортирована для prompts.js (thinkingPlan) — думалка имеет смысл только вместе
 * с преднаполнением: без него модель не начинала блок и инструкция «закрой тег»
 * повисает в воздухе (см. thinkingPlan).
 */
export function getStartReplyWith() {
    const settings = getSettings();
    const own = String(settings.start_reply_with || '').trim();
    if (own) return own;
    // Своё поле пустое — берём «Начинать ответ с» из Таверны (Advanced Formatting → Разное)
    return String(SillyTavern.getContext()?.powerUserSettings?.user_prompt_bias || '').trim();
}

// ─── Профили подключения ────────────────────────────────────────────────────

// Ключи модели в настройках Chat Completion — почти везде `${source}_model`
const SOURCE_MODEL_KEYS = { makersuite: 'google_model' };

function getSourceModel(ctx, source) {
    if (!source) return '';
    const settings = ctx?.chatCompletionSettings || {};
    return settings[SOURCE_MODEL_KEYS[source] || `${source}_model`] || '';
}

/**
 * Поля payload, которые определяют, КУДА и КАК уходит запрос (эндпоинт, регион, режим
 * авторизации, заголовки прокси). Таверна собирает их по chat_completion_source ИЗ ПРЕСЕТА
 * профиля, а пресет — это снимок на момент сохранения: если он от другого источника или
 * устарел, часть полей не добавится вовсе. Поэтому берём из живых настроек и кладём в
 * overridePayload — он мержится последним.
 */
const CONNECTION_FIELDS_BY_SOURCE = {
    vertexai: {
        vertexai_auth_mode: 'vertexai_auth_mode',
        vertexai_region: 'vertexai_region',
        vertexai_express_project_id: 'vertexai_express_project_id',
        use_sysprompt: 'use_sysprompt',
    },
    makersuite: { use_sysprompt: 'use_sysprompt' },
    claude: { use_sysprompt: 'use_sysprompt' },
    custom: {
        custom_url: 'custom_url',
        custom_include_body: 'custom_include_body',
        custom_exclude_body: 'custom_exclude_body',
        custom_include_headers: 'custom_include_headers',
    },
    zai: { zai_endpoint: 'zai_endpoint' },
    siliconflow: { siliconflow_endpoint: 'siliconflow_endpoint' },
    azure_openai: {
        azure_base_url: 'azure_base_url',
        azure_deployment_name: 'azure_deployment_name',
        azure_api_version: 'azure_api_version',
    },
    // У OpenRouter имена в payload не совпадают с именами настроек
    openrouter: {
        provider: 'openrouter_providers',
        quantizations: 'openrouter_quantizations',
        allow_fallbacks: 'openrouter_allow_fallbacks',
        middleout: 'openrouter_middleout',
        use_fallback: 'openrouter_use_fallback',
    },
};

// В какое поле payload ложится `api-url` профиля. Профиль важнее живой настройки:
// он переопределяет её осознанно (см. setApiUrlCallback в slash-commands.js).
const PROFILE_URL_FIELD_BY_SOURCE = {
    custom: 'custom_url',
    vertexai: 'vertexai_region',
    zai: 'zai_endpoint',
    siliconflow: 'siliconflow_endpoint',
};

// Регион Vertex и алиасы эндпоинтов — не URL, слэши там резать нельзя
const URL_LIKE_FIELDS = ['custom_url'];

function buildConnectionOverrides(ctx, profile, source) {
    const payload = {};
    if (!source) return payload;

    const settings = ctx?.chatCompletionSettings || {};
    for (const [payloadKey, settingKey] of Object.entries(CONNECTION_FIELDS_BY_SOURCE[source] || {})) {
        const value = settings[settingKey];
        if (value === undefined || value === null || value === '') continue;
        payload[payloadKey] = value;
    }

    const profileUrl = profile?.['api-url'];
    const urlField = PROFILE_URL_FIELD_BY_SOURCE[source];
    if (profileUrl && urlField) {
        const trimmed = String(profileUrl).trim();
        payload[urlField] = URL_LIKE_FIELDS.includes(urlField) ? trimmed.replace(/\/+$/, '') : trimmed;
    }

    // Прокси-пресет профиля разруливает сама Таверна. Но если у профиля прокси нет,
    // из пресета может протечь чужой reverse_proxy — гасим его живым значением.
    if (!profile?.proxy) {
        payload.reverse_proxy = settings.reverse_proxy || '';
        payload.proxy_password = settings.proxy_password || '';
    }

    // Заголовки провайдера хранятся в самом профиле, в настройках Таверны их нет
    const rawHeaders = profile?.['custom-provider-headers'];
    if (rawHeaders) {
        const parsedHeaders = {};
        for (const line of String(rawHeaders).split('\n')) {
            const separatorIdx = line.indexOf(':');
            if (separatorIdx === -1) continue;
            const key = line.slice(0, separatorIdx).trim();
            if (key) parsedHeaders[key] = line.slice(separatorIdx + 1).trim();
        }
        if (Object.keys(parsedHeaders).length > 0) payload.custom_provider_headers = parsedHeaders;
    }

    if (profile?.['prompt-post-processing']) {
        payload.custom_prompt_post_processing = profile['prompt-post-processing'];
    }

    return payload;
}

/** Все профили подключения Таверны — для выпадающего списка в настройках. */
export function listConnectionProfiles() {
    return SillyTavern.getContext()?.extensionSettings?.connectionManager?.profiles || [];
}

/** Профиль по сохранённому id (приоритет) или имени. null — «главный API Таверны». */
function getSelectedConnectionProfile(ctx) {
    const settings = getSettings();
    const profileName = settings.connection_profile || '';
    const profileId = settings.connection_profile_id || '';
    if (!profileName && !profileId) return null;

    const profiles = listConnectionProfiles();
    const profile = (profileId && profiles.find(p => p.id === profileId))
        || profiles.find(p => p.name === profileName)
        || profiles.find(p => p.id === profileName);

    if (!profile) {
        throw new Error(`Профиль «${profileName || profileId}» не найден. Выберите профиль заново в настройках LOOM.`);
    }
    // Профиль могли переименовать — подтягиваем актуальное имя
    if (profile.name && profile.name !== profileName) {
        settings.connection_profile = profile.name;
        ctx.saveSettingsDebounced?.();
    }
    return profile;
}

// ─── Сборка запроса ─────────────────────────────────────────────────────────

function withThinkingHint(promptText) {
    const settings = getSettings();
    const parts = [promptText];
    // Просьба в промпте — единственный рычаг, который доезжает через прокси,
    // где Таверна не передаёт наверх ни reasoning_effort, ни include_reasoning.
    if (settings.thinking_hint_enabled !== false) {
        const hint = String(settings.thinking_hint || '').trim();
        if (hint) parts.push(hint);
    }
    // В конец: инструкции ближе к концу промпта модели выполняют охотнее
    return parts.join('\n\n');
}

/**
 * @param {string[]} images data URL'ы референсов
 * @returns {string|Array} content для сообщения пользователя: строка без картинок,
 *   массив частей — с ними. Формат частей общий для всех бэкендов: сервер Таверны
 *   переводит image_url в то, что понимает конкретный провайдер (src/prompt-converters.js).
 */
function buildUserContent(promptText, images) {
    if (!images?.length) return promptText;
    return [
        { type: 'text', text: promptText },
        ...images.map(url => ({ type: 'image_url', image_url: { url, detail: 'auto' } })),
    ];
}

function buildMessages(systemPrompt, promptText, startReplyWith, images) {
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: buildUserContent(promptText, images) });
    // Преднаполнение = последнее assistant-сообщение, с которого модель продолжает
    if (startReplyWith) messages.push({ role: 'assistant', content: startReplyWith });
    return messages;
}

/**
 * Ошибка, о которой Таверна уже сказала пользователю сама.
 * Нужна, чтобы не показывать поверх её тоста свой такой же (см. withBusy в index.js).
 */
function apiError(message) {
    const error = new Error(message);
    error.reportedByTavern = true;
    return error;
}

/**
 * Один запрос к модели.
 * @param {string} rawPromptText текст запроса
 * @param {{ system?: string, maxTokens?: number, images?: string[], signal?: AbortSignal,
 *   reasoningEffort?: string }} [options] reasoningEffort переопределяет глобальную настройку
 *   «Думалка» для ЭТОГО запроса — нужно задачам вроде сборки regex-ключей: промпт там уже
 *   даёт модели готовые правила с примерами, рассуждать не о чем, а thinking-модели всё равно
 *   жгут на это сотни токенов бюджета, из-за чего короткий JSON-ответ обрывается по лимиту
 *   раньше, чем модель успевает его дописать (см. buildKeyRegexes в src/keys.js).
 * @returns {Promise<string>} текст ответа (размышления уже вырезаны)
 */
export async function callAI(rawPromptText, options = {}) {
    const ctx = SillyTavern.getContext();
    const settings = getSettings();

    const maxTokensSetting = parseInt(options.maxTokens ?? settings.max_tokens, 10) || 0;
    // 0 = «Авто»: не переопределяем, берём значение из пресета
    const maxTokens = maxTokensSetting > 0 ? maxTokensSetting : undefined;
    const reasoningEffort = options.reasoningEffort ?? settings.thinking_budget;
    const promptText = withThinkingHint(rawPromptText);
    const systemPrompt = String(options.system || '').trim();
    const startReplyWith = getStartReplyWith();
    const images = Array.isArray(options.images) ? options.images.filter(Boolean) : [];
    const profile = getSelectedConnectionProfile(ctx);
    const signal = options.signal ?? currentAbortSignal ?? undefined;

    if (!profile) {
        console.log(LOG, 'Используем главный API Таверны');
        // generateRaw принимает только текст: у главного API нет пути для картинок
        if (images.length) console.warn(LOG, 'Референсы пропущены: главный API Таверны их не принимает. Выберите профиль подключения.');
        const restoreReasoning = applyMainApiReasoning(ctx, reasoningEffort);
        try {
            // generateRaw не принимает signal напрямую — она сама слушает событие
            // GENERATION_STOPPED (см. stopBusy() в index.js), поэтому abort() снаружи
            // прерывает её так же, как кнопка «Стоп» в обычном чате Таверны.
            const result = await generateRaw({
                prompt: promptText,
                systemPrompt,
                quietToLoud: false,
                instructOverride: true,
                responseLength: maxTokens ?? null,
                trimNames: false,
                prefill: startReplyWith,
            });
            return stripReasoningBlocks(extractTextFromResponse(result));
        } catch (e) {
            if (signal?.aborted) throw abortedError();
            console.error(LOG, 'generateRaw failed (главный API)', e);
            throw apiError(describeApiError(e));
        } finally {
            restoreReasoning();
        }
    }

    const profileName = profile.name || profile.id;
    if (!profile.api) throw new Error(`У профиля «${profileName}» не выбран API.`);

    const apiMap = ctx?.CONNECT_API_MAP?.[profile.api];
    if (!apiMap) throw new Error(`Неизвестный тип API «${profile.api}» в профиле «${profileName}».`);
    const isChatCompletion = apiMap.selected === 'openai';

    // Профиль хранит модель снимком. Если её там нет, запрос уходит без поля model
    // и провайдер отвечает 422 «model: Field required» — подставляем текущую модель источника.
    let model = profile.model;
    if (isChatCompletion && !model) {
        model = getSourceModel(ctx, apiMap.source);
        if (!model) {
            throw new Error(`В профиле «${profileName}» не сохранена модель. Откройте Connection Profiles, выберите модель и пересохраните профиль.`);
        }
        console.warn(LOG, `В профиле «${profileName}» нет модели — берём текущую модель источника ${apiMap.source}: ${model}`);
    }

    let overridePayload = isChatCompletion
        ? { model, ...buildReasoningPayload(reasoningEffort, apiMap.source), ...buildConnectionOverrides(ctx, profile, apiMap.source) }
        : {};

    const service = ctx?.ConnectionManagerRequestService;
    if (service && typeof service.sendRequest === 'function' && profile.id) {
        // Единый путь Таверны: сам разруливает CC/TC, пресет, инструкт-режим, прокси и URL профиля
        let result;
        try {
            result = await service.sendRequest(
                profile.id,
                buildMessages(systemPrompt, promptText, startReplyWith, images),
                maxTokens,
                { stream: false, extractData: true, includePreset: true, includeInstruct: true, signal },
                overridePayload,
            );
        } catch (e) {
            if (signal?.aborted) throw abortedError();
            console.error(LOG, `Запрос по профилю «${profileName}» (${apiMap.source || profile.api} / ${model || '—'}) не прошёл`, e);
            throw apiError(describeApiError(e));
        }
        const text = stripReasoningBlocks(extractTextFromResponse(result));
        if (!text) throw new Error('Модель вернула пустой ответ. Обычно это фильтр провайдера или слишком маленький лимит токенов.');
        return text;
    }

    // Фолбэк для старых версий Таверны без ConnectionManagerRequestService
    if (!isChatCompletion) {
        throw new Error(`Профиль «${profileName}» использует Text Completion, но эта версия SillyTavern не умеет отправлять такой запрос из расширения.`);
    }

    const generateData = {
        messages: buildMessages(systemPrompt, promptText, startReplyWith, images),
        model,
        temperature: 0.9,
        stream: false,
        chat_completion_source: apiMap.source || 'openai',
        ...overridePayload,
    };
    if (maxTokens) generateData.max_tokens = maxTokens;

    const headers = typeof ctx.getRequestHeaders === 'function'
        ? ctx.getRequestHeaders()
        : { 'Content-Type': 'application/json' };

    let res;
    try {
        res = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers,
            body: JSON.stringify(generateData),
            signal,
        });
    } catch (e) {
        if (signal?.aborted) throw abortedError();
        throw e;
    }
    const aiResponse = await res.json().catch(() => null);
    if (!res.ok || aiResponse?.error) {
        // Это сырой fetch мимо пайплайна Таверны (нет ConnectionManagerRequestService) —
        // здесь, в отличие от двух путей выше, сама Таверна тост не покажет
        throw new Error(aiResponse?.error?.message || res.statusText || `HTTP ${res.status}`);
    }
    const text = stripReasoningBlocks(extractTextFromResponse(aiResponse));
    if (!text) throw new Error('Модель вернула пустой ответ. Обычно это фильтр провайдера или слишком маленький лимит токенов.');
    return text;
}

// ─── Разбор JSON из ответа ──────────────────────────────────────────────────

function tryParseJson(str) {
    if (typeof str !== 'string') return null;
    const trimmed = str.trim();
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed);
    } catch { /* ignore */ }
    try {
        // Висящие запятые перед закрывающей скобкой — частый косяк моделей
        return JSON.parse(trimmed.replace(/,\s*([}\]])/g, '$1'));
    } catch { /* ignore */ }
    return null;
}

/** Сбалансированный JSON-объект/массив, начиная с указанной позиции. Скобки внутри строк игнорируются. */
function extractBalancedJson(text, from = 0) {
    const objIdx = text.indexOf('{', from);
    const arrIdx = text.indexOf('[', from);
    let openIdx;
    if (objIdx === -1) openIdx = arrIdx;
    else if (arrIdx === -1) openIdx = objIdx;
    else openIdx = Math.min(objIdx, arrIdx);
    if (openIdx === -1) return null;

    const openChar = text[openIdx];
    const closeChar = openChar === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = openIdx; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { if (inString) escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === openChar) depth++;
        else if (ch === closeChar) {
            depth--;
            if (depth === 0) return { json: text.slice(openIdx, i + 1), start: openIdx };
        }
    }
    return null;
}

/**
 * Все сбалансированные куски, а не только первый.
 *
 * Первая открывающая скобка в ответе — далеко не всегда начало JSON: размышления модели
 * полны и `{{user}}`, и фигурных скобок в примерах. Разбирать надо каждый кандидат,
 * пока один не окажется валидным.
 */
function extractJsonCandidates(text, limit = 12) {
    const out = [];
    let from = 0;
    while (out.length < limit) {
        const found = extractBalancedJson(text, from);
        if (!found) break;
        out.push(found.json);
        from = found.start + 1;
    }
    return out;
}

/**
 * Модель упёрлась в лимит токенов и оборвала JSON на полуслове: обрезаем до последнего
 * целого элемента и дозакрываем скобки, чтобы не терять всю генерацию целиком.
 */
function repairTruncatedJson(text) {
    const objIdx = text.indexOf('{');
    const arrIdx = text.indexOf('[');
    let start;
    if (objIdx === -1) start = arrIdx;
    else if (arrIdx === -1) start = objIdx;
    else start = Math.min(objIdx, arrIdx);
    if (start === -1) return null;

    const stack = [];
    let inString = false;
    let escaped = false;
    let safeCut = -1;
    let safeStack = null;

    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { if (inString) escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;

        if (ch === '{' || ch === '[') {
            stack.push(ch === '{' ? '}' : ']');
        } else if (ch === '}' || ch === ']') {
            stack.pop();
            if (stack.length === 0) return null; // структура целая — чинить нечего
            safeCut = i + 1;
            safeStack = stack.slice();
        } else if (ch === ',' && stack.length) {
            // Запятая между двумя завершёнными значениями — тоже безопасная точка среза,
            // даже если ни одна скобка ещё не закрылась. Нужно для плоской карты вида
            // {"a": "x", "b": "y", "c": [обрыв]} — там между записями нет ни одной } или ],
            // и без этой ветки предыдущие уже целые пары терялись бы все разом.
            safeCut = i + 1;
            safeStack = stack.slice();
        }
    }

    if (!stack.length || safeCut === -1) return null;
    const head = text.slice(start, safeCut).replace(/,\s*$/, '');
    return head + safeStack.reverse().join('');
}

// Модель иногда переусердствует с экранированием — чаще всего апостроф как \'.
// \' не валидный JSON escape, и JSON.parse падает целиком. Идём по каждой паре
// backslash+символ и убираем backslash только если символ НЕ входит в легальный набор,
// чтобы валидные \" \\ \n остались нетронутыми при любой вложенности.
const VALID_JSON_ESCAPE_CHARS = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);
function fixInvalidEscapes(text) {
    return text.replace(/\\(.)/gs, (match, ch) => (VALID_JSON_ESCAPE_CHARS.has(ch) ? match : ch));
}

const CONTROL_CHAR_ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/**
 * Некоторые провайдеры (замечено на gemini через некоторые прокси/шлюзы, особенно
 * на длинных многоабзацных полях вроде перевода целой карточки) кладут в значение
 * JSON-строки СЫРОЙ перенос строки вместо экранированного \n. Для JSON.parse это
 * «Bad control character in string literal», и весь ответ разваливается целиком
 * из-за одного абзаца. Экранируем управляющие символы, но только пока курсор внутри
 * строки — вне строк переносы это просто форматирование самого JSON, трогать их незачем.
 */
function fixRawControlCharsInStrings(text) {
    let result = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { result += ch; escaped = false; continue; }
        if (ch === '\\') { result += ch; if (inString) escaped = true; continue; }
        if (ch === '"') { inString = !inString; result += ch; continue; }
        if (inString && ch in CONTROL_CHAR_ESCAPES) { result += CONTROL_CHAR_ESCAPES[ch]; continue; }
        if (inString && ch.charCodeAt(0) < 0x20) { result += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`; continue; }
        result += ch;
    }
    return result;
}

/**
 * Разбирает JSON из ответа модели, переживая типовые поломки:
 * markdown-обёртку, текст вокруг, лишние escape-последовательности и обрыв по лимиту токенов.
 *
 * @param {string} rawText ответ модели
 * @param {string} [requiredKey] ключ, который должен быть в объекте («card», «entry»).
 *   Нужен, потому что валидных JSON в ответе может оказаться несколько: скобки попадаются
 *   и в размышлениях, и в примерах. Кандидат без этого ключа берётся только как запасной.
 * @returns {any|null} null — распарсить не удалось
 */
export function parseJsonLoose(rawText, requiredKey = '') {
    if (!rawText) return null;
    let text = String(rawText).trim();

    // ```json … ``` — модели упорно оборачивают ответ, сколько их ни проси
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

    const candidates = [text, ...extractJsonCandidates(text), repairTruncatedJson(text)].filter(Boolean);
    let fallback = null;

    for (const candidate of candidates) {
        // Порядок исправлений намеренный, от дешёвого к дорогому: обе поломки редко
        // встречаются вместе, но fixRawControlCharsInStrings проходит по каждому символу
        // и его стоит звать, только если более дешёвые попытки не сработали.
        const parsed = tryParseJson(candidate)
            ?? tryParseJson(fixInvalidEscapes(candidate))
            ?? tryParseJson(fixRawControlCharsInStrings(candidate))
            ?? tryParseJson(fixRawControlCharsInStrings(fixInvalidEscapes(candidate)));
        if (!parsed) continue;
        // hasOwnProperty, а не parsed[requiredKey] !== undefined: requiredKey у нас
        // бывает буквально 'entries' и 'keys' (см. вызовы ниже по коду) — оба имени
        // совпадают со встроенными методами Array.prototype. Если модель вернула
        // голый массив без обёртки, array['entries'] это не undefined, а самая
        // настоящая функция Array.prototype.entries — простая проверка приняла бы
        // её за «ключ нашёлся» и молча вернула бы бесполезный результат.
        if (!requiredKey || (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, requiredKey))) {
            return parsed;
        }
        fallback ??= parsed;
    }

    // Модель нередко игнорирует обёртку из промпта и отдаёт содержимое requiredKey
    // прямо на верхнем уровне: {"basics": […], "appearance": […]} вместо
    // {"sections": {"basics": […], "appearance": […]}}. Данные при этом абсолютно
    // рабочие — просто без ключа, который просили. Раньше в этом случае выше уже
    // лежал валидный fallback, но вызывающий код (translateSections и другие) ждал
    // именно requiredKey и выбрасывал «не нашёлся», хотя всё нужное было на руках.
    // Заворачиваем — это строго ШИРЕ старого поведения, а не замена: fallback как был,
    // так и остаётся кандидатом без ключа, просто теперь под ним есть смысл поискать.
    if (requiredKey && fallback && typeof fallback === 'object') return { [requiredKey]: fallback };

    if (fallback) return fallback;
    console.warn(LOG, 'Не удалось разобрать JSON из ответа модели:', text.slice(0, 400));
    return null;
}
