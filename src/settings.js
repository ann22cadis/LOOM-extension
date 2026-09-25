/**
 * Настройки LOOM: хранение, значения по умолчанию и форматы карточек.
 *
 * Всё живёт в extension_settings.LOOM — то есть в settings.json Таверны, а не в
 * localStorage: так настройки переезжают вместе с профилем пользователя.
 *
 * Этот файл нарочно ничего не импортирует из ДРУГИХ модулей LOOM — иначе
 * keys.js → prompts.js → settings.js замкнулся бы циклом, там уже есть обратный
 * путь. Импорт из script.js САМОЙ ТАВЕРНЫ (ниже, только ради немедленного
 * сохранения) циклом не грозит — это внешняя зависимость, не своя.
 */

import { saveSettings as saveSettingsToServer } from '../../../../../script.js';

export const SETTINGS_KEY = 'LOOM';

/**
 * Формат карточки — это СПИСОК ПУНКТОВ, из которых состоит результат.
 * Пользователь правит его в настройках: добавляет, убирает, переименовывает,
 * дописывает подсказку для модели. Промпт собирается из этого списка,
 * а не из захардкоженной простыни, поэтому формат можно менять без правки кода.
 *
 * id      — ключ в JSON-ответе модели, латиницей;
 * label   — заголовок пункта в интерфейсе;
 * hint    — что именно должно быть в пункте (уходит модели);
 * target  — в какое поле карточки персонажа V2 пункт попадёт при экспорте;
 * enabled — участвует ли пункт в генерации;
 * scene   — пункт сценария (обычно scenario/first_mes): не входит в «Сгенерировать»/
 *           «Переписать с оценками» карточки, у него своя кнопка «Сценарий» — карточка
 *           и сцена пишутся раздельно, каждая своим запросом.
 */
/**
 * Пункт «Примеры диалогов» — поле mes_example карточки Таверны («Examples of dialogue»).
 *
 * У этого поля свой строгий формат, поэтому пункт не похож на остальные: каждый пример —
 * ОДИН элемент массива, целиком (первая строка <START>, дальше реплики по одной на строку).
 * formatContract в src/prompts.js узнаёт такой пункт по target: 'mes_example' и снимает для
 * него общее правило «3-5 абзацев по 3-6 предложений».
 */
export const EXAMPLES_ITEM = {
    id: 'examples', label: 'Примеры диалогов', target: 'mes_example', enabled: true,
    hint: 'Example dialogues that show how the character talks in action - the content of the \'Examples of '
        + 'dialogue\' field of a Tavern card. Write 2-3 SEPARATE examples, each a short exchange of 3-6 messages in '
        + 'a different mood or situation that this card really has (an ordinary chat, stress or irritation, '
        + 'closeness or a conflict - not a menu of moods it never shows). '
        + 'FORMAT of one example: the first line is exactly <START>, then one message per line; every line begins '
        + 'with {{user}}: or {{char}}: (always the macros, never real names). Inside the *actions* too: '
        + 'write {{char}} and {{user}}, never the real name - the same card is reused with any name. '
        + '{{char}} lines: *actions in italics* and "speech in quotes", written like the first message, in the '
        + 'voice from the Speech item - its tics, vocabulary, sentence length, humour, swearing or lack of it. '
        + '{{user}} lines: a short, plain prompt of one or two sentences - no long actions, and never decide '
        + 'anything for {{user}}. '
        + 'Do not copy lines from the first message or restate facts from the other items: the examples exist to '
        + 'show the voice, not to repeat the card.',
};

/**
 * Полная карточка — 14 пунктов, собранных из подробного пользовательского промпта
 * (базовые данные, внешность, уникальные детали, характер отдельно от триггеров,
 * речь, соцдинамика, деньги, окружение, сексуальность, биография). Это ДЕФОЛТ:
 * то, что получает свежая установка и что возвращает кнопка «Сбросить».
 */
export const DEFAULT_CHARACTER_FORMAT = [
    { id: 'basics', label: 'Базовые данные', target: 'description', enabled: true,
        hint: 'First name and surname. Nicknames or aliases used by friends, family or coworkers. A social-media handle (a real-looking one, or a decoy account for stalking someone, if that fits the concept). Exact age or birth date, with a zodiac sign only if the character actually believes in that. Occupation and how they feel about it.' },
    { id: 'appearance', label: 'Внешность', target: 'description', enabled: true,
        hint: 'Exact height, weight and build, described through concrete shape (a soft belly, broad shoulders, angular knees) rather than adjectives. Hair: colour, texture, usual style, how much effort they put into it. Eyes: colour, shape, eyesight quirks (glasses, contacts, squinting, -3 vision). Face and skin: features, moles, acne scars, texture. Clothing style: favourite brands and colours, tidiness level, what they wear at home versus going out. Scent: their natural body scent PLUS a specific named perfume or product, plus one incidental smell (cigarettes on a jacket, a shower gel). No "ozone", no generic "musk".' },
    { id: 'unique_details', label: 'Уникальные детали', target: 'description', enabled: true,
        hint: 'Exactly 5-10 tiny, specific details of appearance or habit that only show up close - the kind a reader notices, not a narrator announces. Calibration examples: a faded beaded bracelet made by a little sister; a plaster on the left heel from uncomfortable shoes; a slightly protruding right canine; light freckles on the collarbones; checking the door is locked exactly three times.' },
    { id: 'personality_core', label: 'Характер: ядро', target: 'personality', enabled: true,
        hint: 'Behavioural instructions, not narrated prose - short, dense statements the model can read as rules for how the character thinks and acts. Worldview (cynical but hopeful, chronically anxious, aggressively optimistic). Daily motivation - what drives them minute to minute (need for approval, avoiding conflict, chasing comfort). Moral compass: what they would never do versus what they easily justify for themselves. 3-5 key traits. Real strengths. Real flaws that actually cause them problems (can\'t say no, forgetful, vindictive) - not humble-brag flaws.' },
    { id: 'personality_triggers', label: 'Характер: триггеры и реакции', target: 'personality', enabled: true,
        hint: 'Concrete behaviour under specific triggers, as actions, not adjectives. In stress or anxiety: e.g. bites nails until they bleed, avoids eye contact, cleans manically, goes silent. In anger: e.g. caustic sarcasm, throws things, cries from helplessness, completely shuts the other person out - never the cliche "their anger is quiet, the air goes cold". In joy or affection: e.g. gets overly tactile, buys ridiculous gifts, teases as affection, cooks for people. Their default defence mechanism against emotional pain (intellectualises problems, deflects with jokes, slams the door and leaves). Ban list for this whole item: no "smirks darkly", "eyes darken", "analyses", "processes the information", "alpha instincts" - write rules a model can follow, not literary flourishes.' },
    { id: 'speech', label: 'Речь и манеры', target: 'description', enabled: true,
        hint: 'Tone (monotone, overly enthusiastic, tired, passive-aggressive). Vocabulary - do they swear, use big words wrong, talk in short clipped sentences, use specific slang. Verbal tics (stutters when lying, starts sentences with a filler word, drawls vowels). Sense of humour (dark humour, dad jokes, biting sarcasm, doesn\'t get jokes at all). Texting habits: emoji use, typos, memes, capitalisation quirks. Give 2-3 sample lines that show the voice in action.' },
    { id: 'social_dynamics', label: 'Социальная динамика', target: 'personality', enabled: true,
        hint: 'How they act with strangers versus with close people versus in conflict. Strangers: e.g. polite but distant, overly trusting, suspicious. Close people: e.g. clingy, fiercely protective, can\'t say "I love you" so proves it through actions instead. In conflict: e.g. gaslights, apologises first even when not at fault, holds a grudge forever.' },
    { id: 'money', label: 'Отношение к деньгам', target: 'description', enabled: true,
        hint: 'Spender or hoarder - spends everything on a hobby versus saves every coin. Anxiety around money, or none at all. Property and assets if relevant to the concept (owns nothing, inherited an apartment, drowning in debt).' },
    { id: 'relations', label: 'Связи и окружение', target: 'description', enabled: true,
        hint: 'List 5 to 10 key people (parents, siblings, friends, coworkers) and the relationship with each, briefly. Pets, if any: name, species/breed, personality (a fat ginger cat named Barsik who hates everyone). What they do day to day, where they live, what they live on.' },
    { id: 'sexuality', label: 'Сексуальность', target: 'description', enabled: true,
        hint: 'Orientation and their actual, realistic libido level. Turn-ons: specific, concrete details, words or actions - cut every cliche and surface-level trope. Turn-offs and hard limits: what they will never do.' },
    { id: 'background', label: 'Биография', target: 'description', enabled: true,
        hint: 'A short, 2-3 sentence origin: where they come from and the events that made them who they are. Not a full life story - only what still drives their behaviour now.' },
    { id: 'scenario', label: 'Сценарий', target: 'scenario', enabled: true, scene: true,
        hint: 'The situation the scene opens in: place, time, what already happened, why {{user}} and the character are together.' },
    { id: 'first_mes', label: 'Первое сообщение', target: 'first_mes', enabled: true, scene: true,
        hint: 'The character\'s opening line of the scene. In character, *actions in italics*, addressed to {{user}}. Never describe {{user}}\'s actions.' },
    { ...EXAMPLES_ITEM },
];

/** Прежний короткий формат — доступен как встроенный пресет «Компактная» в настройках. */
export const COMPACT_CHARACTER_FORMAT = [
    { id: 'appearance', label: 'Внешность', target: 'description', enabled: true,
        hint: 'Height, build, face, hair, eyes, distinguishing marks (scars, tattoos, piercings), usual clothes. Concrete details instead of epithets.' },
    { id: 'personality', label: 'Характер', target: 'personality', enabled: true,
        hint: 'Core of the personality, strengths and weaknesses, fears, what they want and what they avoid. Shown through behaviour, not labels.' },
    { id: 'background', label: 'Биография', target: 'description', enabled: true,
        hint: 'Where they come from and the events that made them who they are. Not a full life story - only what still drives their behaviour.' },
    { id: 'speech', label: 'Речь и манеры', target: 'description', enabled: true,
        hint: 'How they talk: sentence length, vocabulary, accent, verbal tics, gestures, what their hands do. Give 2-3 sample lines.' },
    { id: 'relations', label: 'Связи и окружение', target: 'description', enabled: true,
        hint: 'Who is around them: family, friends, enemies, superiors. What they do every day, where they live, what they live on.' },
    { id: 'scenario', label: 'Сценарий', target: 'scenario', enabled: true, scene: true,
        hint: 'The situation the scene opens in: place, time, what already happened, why {{user}} and the character are together.' },
    { id: 'first_mes', label: 'Первое сообщение', target: 'first_mes', enabled: true, scene: true,
        hint: 'The character\'s opening line of the scene. In character, *actions in italics*, addressed to {{user}}. Never describe {{user}}\'s actions.' },
    { ...EXAMPLES_ITEM, enabled: false },
];

/**
 * Пункты персоны ({{user}}) — в отличие от карточки персонажа, у персоны в Таверне
 * нет отдельных полей personality/scenario/first_mes: всё уходит в одно текстовое
 * поле «description». Поэтому у пунктов персоны нет ни target, ни scene — все они
 * при экспорте просто склеиваются в одно описание (см. exportPersona в src/export.js).
 */
export const DEFAULT_PERSONA_FORMAT = [
    { id: 'appearance', label: 'Внешность', enabled: true,
        hint: 'Exact height, build, face, hair, eyes, clothing style. Concrete details instead of epithets - the kind {{char}} could actually notice and react to.' },
    { id: 'personality', label: 'Характер', enabled: true,
        hint: 'Core traits, strengths and weaknesses, what they want, what they avoid, how they act under stress. Shown through behaviour, not labels.' },
    { id: 'background', label: 'Кто это и чем живёт', enabled: true,
        hint: 'Occupation or role, current life situation, why they are here. Not a full biography - only what shapes how they act right now.' },
    { id: 'speech', label: 'Манера речи', enabled: false,
        hint: 'Tone, vocabulary, verbal tics - useful only if something (impersonate, auto-mode) ever writes lines in this persona\'s voice.' },
];

/**
 * Пункт промпта для ролевой.
 *
 * Это ОДНА ситуативная инструкция МОДЕЛИ, не целый пресет — LOOM здесь не пытается
 * заменить собой Prompt Manager или готовый джейлбрейк, а пишет частный кусок под
 * конкретную задачу, которую пользователь описывает в задумке («как NPC должны
 * реагировать на насилие», «темп для медленного сближения», «правило для одной
 * сцены»). Раньше формат по умолчанию состоял из семи разделов (роль, стиль,
 * ведение персонажа, темп, форматирование, бан-лист, интенсивность) — то есть
 * навязывал структуру целого системного промпта каждой мелкой задаче. Дефолт —
 * один пункт; кто хочет несколько прицельных инструкций в одном черновике,
 * добавляет свои пункты в настройках → Форматы.
 *
 * Текст пишется во втором лице («ты делаешь X»), а язык результата по умолчанию
 * английский: промпт уходит в контекст каждого сообщения, и кириллица там стоит
 * в разы дороже.
 *
 * Готовый текст никуда в Таверну не пишется — его копируют кнопкой и вставляют
 * руками, куда решат сами: отдельной инструкцией в Prompt Manager, строкой в
 * Author's Note, куском System Prompt — LOOM не решает это за них.
 */
export const DEFAULT_PROMPT_FORMAT = [
    { id: 'rule', label: 'Промпт', enabled: true,
        hint: 'Exactly the instruction the brief asks for - nothing more. Second person, addressed to the '
            + 'model ("Never let {{char}} apologise unprompted", "Escalate tension for three replies before '
            + 'any resolution"). Do not pad it into a general house style, a full role description, or a list '
            + 'of unrelated rules the brief never mentioned - one situational instruction, done well, beats '
            + 'ten generic ones nobody asked for.' },
];

/**
 * Пункт одного именованного блока пресета (режим «Пресет») — один, как и у «Промпта»:
 * блок пишется как единая инструкция, а не как карточка с разными гранями. Разница
 * с «Промптом» не в том, ЧТО пишется (та же ситуативная инструкция моделью), а в том,
 * КУДА это уходит: не в буфер обмена, а именованным prompts[]-блоком прямо в Чат
 * Комплишен-пресет Таверны — заготовкой, которую там же включают и ставят в очередь
 * (см. exportPreset в src/export.js).
 */
export const DEFAULT_PRESET_FORMAT = [
    { id: 'rule', label: 'Текст блока', enabled: true,
        hint: 'Exactly the instruction this named block is for - nothing more. Second person, addressed to the '
            + 'model. Do not pad it into unrelated rules the brief never mentioned, and do not restate what '
            + 'other blocks in this preset already cover.' },
];

/**
 * Пункт разбора чужого пресета (режим «Анализ») — один, как у «Промпта»/«Пресета»:
 * это не карточка с гранями, а связный разбор, который сам решает, сколько в нём
 * абзацев (один на находку — см. ANALYSIS_SPLIT_RULE в src/prompts.js).
 */
export const DEFAULT_ANALYSIS_FORMAT = [
    { id: 'findings', label: 'Разбор', enabled: true,
        hint: 'A diagnosis of the given preset against the problem the user described - which named block causes '
            + 'or contributes to it, why, and a concrete fix (a block to add or replace, an order/enabled change, a '
            + 'sampler value). New prompt text is written in full, ready to paste. Not a summary of the preset, '
            + 'not generic prompting advice.' },
];

/**
 * Пункты полного сценария (режим «Сценарий») — три, сознательно немного: сценарий
 * привязан к персонажу и персоне (см. renderCharacterLinkSelect в index.js), которые
 * уже несут внешность/характер/предысторию, — здесь нужна только завязка РОЛЕВОЙ,
 * а не пересказ карточки. Идеи (draft.ideas) сюда не входят — это отдельный,
 * неструктурированный черновой список коротких питчей до того, как один из них
 * прорабатывается в эти три пункта.
 */
export const DEFAULT_SCENARIO_FORMAT = [
    { id: 'goals', label: 'Цели персонажа', enabled: true,
        hint: 'The character\'s goals at two scales: the big underlying want that shapes their choices across '
            + 'the whole story, and the immediate, scene-level want that opens the roleplay - what they are '
            + 'actively after right now. Concrete and actionable, not a mood.' },
    { id: 'plot', label: 'Сюжет и другие NPC', enabled: true,
        hint: 'What keeps the story moving independent of {{user}}: which side characters are involved, what '
            + 'they want, what complications or escalations are already in motion. The engine that keeps the '
            + 'scenario alive even when {{user}} is not driving it.' },
    { id: 'user_relation', label: 'Отношения с {{user}}', enabled: true,
        hint: 'How {{char}}\'s dynamic with {{user}} starts and where it is pulled to go: the initial stance '
            + '(trust, suspicion, attraction, rivalry - whatever fits), the tension or draw between them, and '
            + 'a plausible arc if the roleplay continues. Specific to THIS scenario, not a generic personality '
            + 'description.' },
];

/** Пункты одной записи лорбука. Собираются в поле content записи. */
export const DEFAULT_LOREBOOK_FORMAT = [
    { id: 'summary', label: 'Суть', enabled: true,
        hint: 'One or two sentences: what this is. The first line must work as a definition.' },
    { id: 'details', label: 'Детали', enabled: true,
        hint: 'How it is built, how it looks, how it works, how it smells and sounds. Concrete details usable in a scene.' },
    { id: 'links', label: 'Связи', enabled: true,
        hint: 'What and who it connects to: other entries, factions, characters, places. Name them exactly as the other entries do.' },
    { id: 'hooks', label: 'Крючки', enabled: false,
        hint: 'Conflicts, secrets and hooks that can be woven into the plot.' },
];

/**
 * Русские падежные, числовые и родовые окончания — существительных и прилагательных.
 *
 * Нужны, чтобы regex-ключ лорбука ловил склонения, НЕ хватая чужие слова с тем же
 * началом. Открытый хвост вида «меч[А-Яа-яЁё]*» (так LOOM просил у модели раньше)
 * ловит и «мечта», и «мечтал», и «мечеть»; «кот» — «котёл», «котлета», «который»;
 * «род» — «родина», «родители». В чате такой ключ подсовывает запись в каждое второе
 * сообщение. Закрытый список окончаний плюс обязательная граница слова решают это:
 * на проверочном наборе ложных срабатываний не осталось ни одного, при этом ни один
 * падеж не потерян.
 *
 * Живёт здесь, а не в keys.js, чтобы им пользовались и сборщик ключей (buildRegexKey),
 * и промпт к модели (keyRegexPrompt в prompts.js) — из keys.js импорт в prompts.js
 * замкнул бы цикл, там уже есть обратный.
 */
export const RU_ENDINGS = [
    'ами', 'ями', 'ыми', 'ими', 'ого', 'его', 'ому', 'ему',
    'ах', 'ях', 'ам', 'ям', 'ов', 'ев', 'ёв', 'ей', 'ой', 'ою', 'ый', 'ий',
    'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ом', 'ем', 'ём', 'ым', 'им', 'ую', 'юю', 'ых', 'их', 'ью',
    'а', 'я', 'у', 'ю', 'е', 'и', 'ы', 'о', 'ь', 'й',
].sort((a, b) => b.length - a.length);

/** Старая форма хвоста — простое перечисление. Нужна только миграции уже собранных ключей. */
export const LEGACY_RU_ENDINGS_ALT = RU_ENDINGS.join('|');

/**
 * Тот же список окончаний, но свёрнутый в классы символов — втрое короче, и ключ в
 * лорбуке читается глазами. Покрывает всё из RU_ENDINGS (плюс пару безвредных сочетаний
 * вроде «ав», «ье»), а открытым хвостом не становится: после основы допускается максимум
 * три буквы строго из этих наборов, поэтому «меч» по-прежнему не ловит «мечта» и «мечеть».
 */
export const RU_ENDINGS_ALT = '[аяыи]ми|[ое](?:го|му)|[аяоеёиыуюьй][вейхмюя]?';

/**
 * Хвосты окончаний ПО ТИПУ СЛОВА. Общий хвост (RU_ENDINGS_ALT) смешивал окончания
 * существительных и прилагательных, и ключ ловил однокоренные слова другой части речи:
 * «лев» + «ый» = «левый», «друг» + «ой» = «другой», «дом» + «ой» = «домой». У каждого
 * типа только его собственные окончания — такого пересечения больше нет.
 *
 * m    — мужской род на согласную: меч, друг, отец (+ «-ья» у друзья/братья/стулья)
 * f    — на -а/-я: больница, операция, Эннеада
 * n    — средний на -о/-е: окно, поле
 * soft — на -ь/-й: госпиталь, день, Андрей, герой
 * adj  — прилагательное: врачебная, чёрный
 * surname — фамилия или город на -ов/-ев/-ин: Громов, Ковалёв, Орлов (Громова, Громовым, в Орлове)
 * pl   — только множественное или неясно: татуировки, родители — общий хвост
 */
export const RU_TAILS = {
    m: '[ауеыи]|[оеё][мв]|ей|[ая]ми?|[ая]х|ь(?:ям|ями|ях|я|ев)',
    f: '[аяыиеуюьй]|[ое][йю]|[ая]ми?|[ая]х',
    n: '[оеаяуюиы]|[оеё]м|ей|[ая]ми?|[ая]х',
    soft: '[ьйяюеи]|[её][мвй]|[еь]ю|ями?|ях',
    adj: '[ыио]й|[ая]я|[оеыи]е|[ое](?:го|му|й|ю|м)|[ыи](?:ми?|х)|[ую]ю',
    surname: '[ауеы]|[оы]м|ой|ых|ыми',
    pl: RU_ENDINGS_ALT,
};

/** Тип слова → что приклеивать. fixed — несклоняемое (Энни, пальто, Ян): без хвоста. */
export const KEY_DECLENSIONS = ['m', 'f', 'n', 'soft', 'adj', 'surname', 'pl', 'fixed', 'en'];

/**
 * Что считается «буквой» на границе ключа.
 *
 * \b тут не годится: она определена через \w = [A-Za-z0-9_], поэтому на кириллице
 * срабатывает в середине слова и не срабатывает по краям — это известная особенность
 * JS, решается ровно так, своим классом с ретроспективной и опережающей проверкой.
 *
 * Диапазоны шире «русский плюс латиница» намеренно:
 *   À-ÖØ-öø-ÿ и Ā-ſ — латиница с диакритикой. Без них ключ «Charit» ловил «Charité»:
 *   é не считалась буквой, и граница слова ошибочно срабатывала прямо перед ней.
 *   Ѐ-ӿ — вся кириллица целиком, а не только А-Яа-яЁё: сюда попадают і, ї, є, ґ, ў.
 *
 * Один класс на всё расширение: и на локальную сборку ключа (buildRegexKey в keys.js),
 * и на примеры в промпте к модели (keyRegexPrompt в prompts.js). Раньше их было три
 * разных, и ключ от модели вёл себя на границах не так, как собранный на месте.
 */
export const LEGACY_KEY_LETTER_CLASS = '\\wÀ-ÖØ-öø-ÿĀ-ſЀ-ӿ';
// \p{L} — любая буква любого алфавита (с диакритикой, кириллица целиком). Работает только
// с флагом u — его keys.js добавляет к каждому собранному ключу сам.
export const KEY_LETTER_CLASS = '\\p{L}\\p{N}_';
export const KEY_BOUNDARY_BEFORE = `(?<![${KEY_LETTER_CLASS}])`;
export const KEY_BOUNDARY_AFTER = `(?![${KEY_LETTER_CLASS}])`;

/**
 * Ключ, собранный старой версией LOOM (длинный класс границ, перечисление окончаний,
 * [еёЕЁ]) → та же логика в короткой записи. Чужие регулярки не трогает: узнаёт свои
 * по старому классу границ. Если после замены выражение вдруг не компилируется —
 * возвращает ключ как был.
 */
export function modernizeRegexKey(key) {
    const value = String(key ?? '');
    const match = value.match(/^\/([\s\S]+)\/([gimsuy]*)$/);
    const ours = match && [LEGACY_KEY_LETTER_CLASS, KEY_LETTER_CLASS].some(cls => match[1].includes(`[${cls}]`));
    if (!ours) return value;
    let body = match[1]
        .split(`[${LEGACY_KEY_LETTER_CLASS}]`).join(`[${KEY_LETTER_CLASS}]`)
        .split(`(?:${LEGACY_RU_ENDINGS_ALT})`).join(`(?:${RU_ENDINGS_ALT})`)
        // Промежуточная версия хвоста, без одиночной «й», — успела сохраниться в пару лорбуков
        .split('(?:[аяыи]ми|[ое](?:го|му)|[аяоеёиыуюь][вейхмюя]?)').join(`(?:${RU_ENDINGS_ALT})`)
        .split('[еёЕЁ]').join('[её]');
    // «(?:больница|больниц)» — первая ветка длиннее второй на одну букву, хвост её и так вернёт
    body = body.replace(/\(\?:([^()|]+)\|([^()|]+)\)/g, (whole, long, short) => {
        const plain = value => value.split('[её]').join('е');
        const extra = plain(long).slice(plain(short).length);
        return extra.length === 1 && /[аяоеёиыуюьй]/i.test(extra) && plain(long).startsWith(plain(short)) ? short : whole;
    });
    // Внешняя группа вокруг единственной формы между границами слова — лишняя
    const before = `(?<![${KEY_LETTER_CLASS}])`;
    const after = `(?![${KEY_LETTER_CLASS}])`;
    if (body.startsWith(before + '(?:') && body.endsWith(')' + after)) {
        const inner = body.slice(before.length + 3, body.length - after.length - 1);
        let depth = 0;
        let balanced = true;
        let pipe = false;
        for (let i = 0; i < inner.length; i++) {
            const ch = inner[i];
            if (ch === '\\') { i++; continue; }
            if (ch === '(') depth++;
            else if (ch === ')') { depth--; if (depth < 0) { balanced = false; break; } }
            else if (ch === '|' && depth === 0) pipe = true;
        }
        if (balanced && depth === 0 && !pipe) body = before + inner + after;
    }
    const flags = [...new Set((match[2] + 'u').split(''))].join('');
    try {
        new RegExp(body, flags);
    } catch {
        return value;
    }
    return `/${body}/${flags}`;
}

/**
 * То же для английского. Словоизменение там куда беднее русского: у имён собственных
 * и терминов это множественное число и притяжательный падеж, больше ничего.
 *
 * Без 's' ключ «Heart» не поймает «Hearts»: голое слово упрётся в границу, потому что
 * следующая буква s входит в \w. Притяжательные формы («Law's») ловятся и так — апостроф
 * границу не ломает, — но в списке они дают более аккуратное совпадение целиком.
 */
const EN_ENDINGS = ['es', "'s", '’s', 's'];

export const EN_ENDINGS_ALT = EN_ENDINGS.join('|');

/** Режимы настройки «Язык ключей лорбука» — на каком языке ждём текст чата. */
export const KEY_LANGUAGES = [
    { id: 'auto', label: 'Автоматически — по алфавиту ключа' },
    { id: 'ru', label: 'Русский — падежи и числа' },
    { id: 'en', label: 'Английский — множественное число' },
];

/**
 * Фиксированные типы записи лорбука — вместо свободного «place | faction | person | …»,
 * которое модель предлагала как попало. Каждый тип даёт своё пояснение в промпте
 * написания записи (lorebookCategoryGuidance в prompts.js), чтобы «Персонаж» и «Место»
 * не писались по одному и тому же общему шаблону. label — для интерфейса (селект
 * категории у записи), hint — уходит в промпт, поэтому по-английски, как и остальные
 * инструкции модели.
 */
export const LOREBOOK_CATEGORIES = [
    { id: 'person', label: 'Персонаж',
        hint: 'physical appearance and distinguishing features, core personality traits and how they typically '
            + 'behave, their role or relevance in the world, and their relationships to other named entries in '
            + 'this lorebook. Do not write a full character sheet - only what a reader needs to recognise and '
            + 'place them.' },
    { id: 'place', label: 'Место',
        hint: 'geography and physical layout, atmosphere and sensory details (sounds, smells, lighting), who or '
            + 'what can typically be found there, and its role or significance in the world. Avoid generic '
            + 'scenery description - ground it in specifics.' },
    { id: 'event', label: 'Событие',
        hint: 'what happened, when (relative to the story\'s present), who was involved, and the lasting '
            + 'consequences or current state of things because of it. Write it as established fact, not as a '
            + 'scene to roleplay.' },
    { id: 'flashback', label: 'Флэшбэк',
        hint: 'a PAST memory or incident distinct from the story\'s present continuity - something a character '
            + 'remembers, not something currently unfolding. What happened, who experienced it, the emotional '
            + 'weight it carries, and how it still shapes present behaviour or relationships. Frame it clearly '
            + 'as backstory, not as an ongoing situation.' },
    { id: 'faction', label: 'Фракция',
        hint: 'its purpose or goals, internal structure or hierarchy, notable members if any, symbols or '
            + 'distinguishing traits, and its relationship to other factions or forces in the world (allies, '
            + 'rivals, neutral).' },
    { id: 'item_concept', label: 'Предмет-понятие',
        hint: 'what it is or how it works, its significance or why it matters in this world, who uses or is '
            + 'affected by it, and any limitations or costs involved.' },
];

/**
 * Встроенные пресеты форматов — готовые наборы пунктов на выбор в настройках.
 * В отличие от пользовательских (settings.character_format_presets /
 * lorebook_format_presets), эти не хранятся в settings.json и не удаляются:
 * они всегда под рукой как отправная точка или запасной вариант.
 */
export const BUILTIN_CHARACTER_PRESETS = [
    { id: 'builtin-full', name: 'Полная карточка (по умолчанию)', items: DEFAULT_CHARACTER_FORMAT },
    { id: 'builtin-compact', name: 'Компактная', items: COMPACT_CHARACTER_FORMAT },
];
export const BUILTIN_LOREBOOK_PRESETS = [
    { id: 'builtin-default', name: 'Стандартная (по умолчанию)', items: DEFAULT_LOREBOOK_FORMAT },
];
export const BUILTIN_PERSONA_PRESETS = [
    { id: 'builtin-default', name: 'Стандартная (по умолчанию)', items: DEFAULT_PERSONA_FORMAT },
];
export const BUILTIN_PROMPT_PRESETS = [
    { id: 'builtin-default', name: 'Стандартная (по умолчанию)', items: DEFAULT_PROMPT_FORMAT },
];
export const BUILTIN_PRESET_PRESETS = [
    { id: 'builtin-default', name: 'Стандартная (по умолчанию)', items: DEFAULT_PRESET_FORMAT },
];
export const BUILTIN_ANALYSIS_PRESETS = [
    { id: 'builtin-default', name: 'Стандартная (по умолчанию)', items: DEFAULT_ANALYSIS_FORMAT },
];
export const BUILTIN_SCENARIO_PRESETS = [
    { id: 'builtin-default', name: 'Стандартная (по умолчанию)', items: DEFAULT_SCENARIO_FORMAT },
];

/** Поля карточки персонажа V2, в которые можно направить пункт формата. */
export const CARD_TARGETS = [
    { value: 'description', label: 'Описание (description)' },
    { value: 'personality', label: 'Личность (personality)' },
    { value: 'scenario', label: 'Сценарий (scenario)' },
    { value: 'first_mes', label: 'Первое сообщение (first_mes)' },
    { value: 'mes_example', label: 'Примеры диалогов (mes_example)' },
    { value: 'creator_notes', label: 'Заметки автора (creator_notes)' },
    { value: 'skip', label: 'Не экспортировать' },
];

/**
 * Промпты пунктов сцены в карточке персонажа и ключей лорбука — правятся в
 * Настройки → Форматы, прямо под родительским списком пунктов. Пункты формата хранят
 * только короткую подсказку «что в пункте», а КАК писать художественный текст —
 * отдельная, длинная инструкция: без неё модель пишет первое сообщение как анкету.
 * Пишутся по-английски (см. шапку prompts.js): результат идёт на output_language.
 */
export const DEFAULT_PROMPT_SCENARIO_CARD = [
    'You are writing the SCENARIO field of a character card: a compact, neutral description of the situation the '
        + 'roleplay starts in. The model re-reads it on every single message, so every sentence must earn its place '
        + 'and stay true for the whole session, not just for the opening beat.',
    '',
    'WHAT IT MUST COVER',
    '- Setting: where and when, with only the details that will matter in scenes - not a tour of the world.',
    '- Why {{char}} and {{user}} are in the same place: the concrete circumstance that put them together.',
    '- The live tension: what is unresolved between them or around them (a need, a conflict, a secret, a deadline, '
        + 'an obligation) - the engine that keeps scenes going.',
    '- Where the relationship stands right now (strangers, rivals, colleagues, ...), stated as a situation, not as '
        + 'feelings.',
    '',
    'HOW TO WRITE IT',
    '- Neutral narrator, third person, present tense. Name the characters as {{char}} and {{user}}. No dialogue, no '
        + '*asterisk actions*, no second person.',
    '- Concrete over general: names of places, roles, objects, stakes. Not "a dangerous world" - the specific thing '
        + 'that is dangerous and why it matters here.',
    '- Set up, never resolve: describe what is true at the start and what is at stake, not how it ends. Leave '
        + 'several directions open so {{user}} can steer.',
    '- Do not decide {{user}}\'s feelings, choices or backstory beyond what the situation needs. Do not narrate the '
        + 'first scene beat by beat - that is the first message\'s job.',
    '- Do not repeat the character\'s description or personality from the card; use them only to keep the situation '
        + 'consistent with who {{char}} is.',
    '- Avoid facts that go stale after the first message ("this morning", "just arrived") unless the whole '
        + 'roleplay is tied to that moment.',
    '- Length: roughly 60-150 words in 1-3 short paragraphs. No headers, no lists, no meta commentary.',
].join('\n');

export const DEFAULT_PROMPT_FIRST_MES = [
    'You are writing the OPENING MESSAGE of a roleplay: the first thing the player reads when a new chat starts. It '
        + 'sets the tone of the entire session, so it must read like a scene from good fiction - not like a '
        + 'character sheet, a summary or an introduction.',
    '',
    'STRUCTURE',
    '- Start in the middle of a moment: {{char}} is already doing something specific, somewhere specific, when the '
        + 'scene begins. No "You are...", no waking-up / weather / mirror openers, no presenting who {{char}} is.',
    '- Anchor the scene fast - where we are, roughly when, what {{char}} wants or is dealing with right now - '
        + 'through action and detail, never by announcing it.',
    '- Leave a door open for {{user}}: end on a concrete beat that invites a reply (a question, a demand, an '
        + 'interrupted action, a choice, something odd to react to). Not a wrap-up, not a staged cliffhanger, not a '
        + 'menu of options.',
    '- Length: about 120-300 words. Shorter only when the idea is one sharp moment; never padded.',
    '',
    'CRAFT',
    '- Show, do not tell. Personality comes through what {{char}} does, how they talk and what they notice - not '
        + 'through adjectives about them. Backstory only as one passing detail (an object, a scar, a habit) that '
        + 'hints at it, never as exposition.',
    '- Ground it in the senses: 2-3 precise details chosen for THIS scene (a sound, a smell, a texture, the light). '
        + 'Not a catalogue and not generic "atmosphere".',
    '- Give {{char}} a real voice: dialogue must sound like this character - their register, vocabulary, tics and '
        + 'rhythm from the card. Let dialogue carry subtext: people rarely say exactly what they feel.',
    '- Vary the rhythm: mix short and long sentences, use one-line paragraphs for beats. Prefer plain exact verbs '
        + 'over adverbs and stacked similes.',
    '- Feelings through behaviour and subtext. Do not label them ("she felt sad", "tension filled the air").',
    '',
    'HARD RULES',
    '- Never write {{user}}\'s actions, words, thoughts, feelings or reactions, and do not decide what {{user}} '
        + 'looks like or wears beyond what the card states. {{user}} may appear only as someone {{char}} observes '
        + 'or addresses.',
    '- Stay consistent with the card: name, appearance, personality, speech, setting. Invent nothing that '
        + 'contradicts it.',
    '- Formatting: narration and actions in *asterisks*, spoken dialogue in quotation marks. Third person, present '
        + 'tense - unless the card or an existing opening message clearly uses another, then match it.',
    '- No meta text, no OOC notes, no titles, no summary, no moral.',
    '- Banned cliches: ozone, orbs, "a shiver ran down (anyone\'s) spine", "a breath they didn\'t know they were '
        + 'holding", "the air was thick with tension", smirks, eyes that "darken", anything "predatory", "mine", '
        + '"little one", "barely above a whisper", "the world narrowed to". No purple stacks of adjectives.',
].join('\n');

/** Правила составления шагов сюжета — правятся в Настройки → Форматы. */
export const DEFAULT_PROMPT_PLOT = [
        'HOW TO WRITE A STEP:',
        '- "title": 2-6 words, the milestone as a label ("The forged letter surfaces").',
        '- "goal": 1-2 sentences - what the story is drifting toward at this point and why it matters to the '
            + 'characters. Written so a model can steer toward it without being told the outcome.',
        '- "condition": ONE observable event that either has visibly happened in the roleplay text or has not - '
            + 'a concrete action, revelation, decision or arrival. Never a mood, a feeling or a vague state '
            + '("they grow closer" is unusable; "{{char}} tells {{user}} the real reason for the debt" is usable). '
            + 'It must be possible to check by reading the last few messages.',
        '- "complication": optional (empty string if none) - an obstacle, twist or pressure the model may introduce '
            + 'while the step is active.',
        '- "substeps": OPTIONAL array of 2-4 stages ({ "title", "goal", "condition", "complication" }, no further '
            + 'nesting) - only for a broad step that genuinely breaks into stages which follow one another. Then the '
            + 'step\'s own "condition" describes the whole step being finished, and each stage has its own checkable '
            + 'condition. Do not split a small step just for the sake of it; leave [] for most steps.',
        '- "goals": OPTIONAL array of personal goals { "who": "exact character name", "text": "…" } - use it when '
            + 'several characters take part (a group chat) and what each of them wants in this step differs: what THAT '
            + 'character privately pursues while the step is active. It is the character\'s own drive, not shared '
            + 'knowledge. Leave [] when there is one character or they all want the same thing.',
        '- A step is a milestone that takes MANY messages to reach, not one scene beat: it must be something that '
            + 'can only arrive after the story has spent time on the way there. Never write a step that could '
            + 'be completed in a single reply.',
        '- Steps escalate: each raises stakes or changes the situation. Only the LAST step may resolve the arc.',
        '- Never script {{user}}\'s choices, feelings or words. A step is something that can happen through '
            + 'several different paths of play; do not write "if X then Y" branches.',
        '- Steps must be independent of a specific scene layout: do not rely on exact wording or a particular '
            + 'sequence of messages.',
    ].join('\n');

/** Напоминание модели в чате: шаг — долгосрочное направление, а не действие сейчас. */
export const DEFAULT_PROMPT_PLOT_PACING = 'PACING - IMPORTANT: this step is a LONG-TERM direction that plays out over MANY replies and scenes. '
        + 'It is NOT an action to perform now or in the next reply. Do not rush toward it, do not steer every reply '
        + 'at it, do not make the characters act on it immediately, and do not skip time or jump ahead to reach it. '
        + 'Keep playing the moment {{user}} is actually in; let events drift toward the step only as the story '
        + 'organically allows, as quiet background pressure. Never resolve it on {{user}}\'s behalf.';

/**
 * Промпт разбора ключей лорбука (keyRegexPrompt в prompts.js). {{KEYWORDS}} — список
 * ключей, {{EN_DECL}} — строка про латиницу (зависит от языка чата в настройках).
 * Формат ответа в конце править нельзя: по нему LOOM разбирает JSON.
 */
export const DEFAULT_PROMPT_KEYS = [
    'TASK: for every lorebook keyword below, describe how each of its words inflects, so a matcher can '
        + 'find the keyword in any grammatical form in a roleplay chat.',
    '',
    'KEYWORDS:',
    '{{KEYWORDS}}',
    '',
    'For EACH word of a keyword (in order) give:',
    '- "stems": the unchanging part(s) of the word, WITHOUT the case ending. If the stem itself changes '
        + 'when the word declines, list every variant.',
    '- "decl": how it declines:',
    '    "m"     - masculine noun ending in a consonant (меч, друг, отец, замок)',
    '    "f"     - noun ending in -а/-я (больница, операция, Эннеада)',
    '    "n"     - neuter noun ending in -о/-е (окно, поле)',
    '    "soft"  - noun ending in -ь/-й (госпиталь, день, герой, Андрей)',
    '    "adj"   - adjective or participle (врачебная, чёрный, красного)',
    '    "surname" - surname or town name ending in -ов/-ев/-ёв/-ин/-ын (Громов, Ковалёв, Орлов, Пушкин); '
        + 'stem is the whole word',
    '    "pl"    - noun used only in plural (ножницы, родители, татуировки)',
    '    "fixed" - does not decline: foreign names ending in a vowel (Энни, Бепо, Джереми, Шарите), '
        + 'words like пальто/кофе/такси, any 1-2 letter word (Ло, Ян), abbreviations',
    '{{EN_DECL}}',
    '',
    'RULES:',
    '- Stems are plain letters only - no regex, no brackets, no endings. Keep ё as ё.',
    '- Cut ONLY the case ending. Too short a stem fires on unrelated words; never cut into the root.',
    '- Fleeting vowels and root changes are the whole point - list every stem the word really uses:',
    '    Лев -> ["лев", "льв"] (Льва),  отец -> ["отец", "отц"] (отца),  пёс -> ["пёс", "пс"] (пса),',
    '    друг -> ["друг", "друз"] (друзья),  замок -> ["замок", "замк"] (замка),  день -> ["ден", "дн"] (дня)',
    '- Only stems of this word\'s OWN case forms. Not roots of related words: "друж" (дружба, дружить) is '
        + 'not a form of "друг" and would fire on the verb "дружу".',
    '- For a foreign name ending in a vowel, NEVER cut the last letter: "Энни" cut to "Энн" would fire '
        + 'on a different name. Use "fixed".',
    '- One object per word, in the same order and number as the words of the keyword.',
    '',
    'EXAMPLES:',
    '  "Меч": [{"stems":["меч"],"decl":"m"}]',
    '  "Больница": [{"stems":["больниц"],"decl":"f"}]',
    '  "Операция": [{"stems":["операци"],"decl":"f"}]',
    '  "Госпиталь": [{"stems":["госпитал"],"decl":"soft"}]',
    '  "Врачебная этика": [{"stems":["врачебн"],"decl":"adj"},{"stems":["этик"],"decl":"f"}]',
    '  "Дом Ло": [{"stems":["дом"],"decl":"m"},{"stems":["Ло"],"decl":"fixed"}]',
    '  "Лев Громов": [{"stems":["лев","льв"],"decl":"m"},{"stems":["Громов"],"decl":"surname"}]',
    '  "Энни": [{"stems":["Энни"],"decl":"fixed"}]',
    '  "Wolf": [{"stems":["Wolf","Wolves"],"decl":"en"}]',
    '',
    'RESPONSE FORMAT: valid JSON only, no text around it, no code fences.',
    '{ "keys": { "<keyword exactly as given>": [ { "stems": [ ... ], "decl": "..." } ] } }',
].join('\n');

/**
 * Думалка персонажа: план разбора ДО того, как модель начнёт писать карточку.
 *
 * Текст хранится вместе с тегами и уходит в промпт как образец: модель повторяет
 * эту разметку, а вырезание размышлений (stripReasoningBlocks) потом снимает блок
 * целиком, поэтому в JSON он не попадает. Пункты намеренно требуют РЕШЕНИЙ
 * («выбери», «назови»), а не пересказа задания — иначе модель тратит бюджет на воду.
 */
export const THINKING_PLAN_CHARACTER = `<thinking>
1. Core: in one phrase, who this is and what makes them interesting. Everything else obeys that phrase.
2. Contradiction: which two traits pull the character in opposite directions. Without one you get a function, not a person.
3. Details: name 5-7 concrete markers (an object, a habit, a scar, a smell, a gesture) that can be touched in a scene.
4. Voice: sentence length, vocabulary, how they swear, what they would never say.
5. Scene: where and when the first message starts, what happened right before it, what the character wants from {{user}} now.
6. Bans: list the cliches this premise invites that you will NOT use.
7. If user ratings are present: what to keep verbatim, and which angle failed in the low-rated paragraphs.
</thinking>`;

/** Думалка лорбука: та же идея, но запись оценивается по пригодности в контексте. */
export const THINKING_PLAN_LOREBOOK = `<thinking>
1. Place in the world: which layer this entry covers and why it is needed at all.
2. Boundaries: how it differs from neighbouring entries, what belongs in them rather than here.
3. Details: 3-5 concrete facts usable in a scene (how it looks, how it works, how it smells, who uses it).
4. Links: which entries and characters it connects to, and the exact names to call them by.
5. Keys: what people actually call this thing in chat - synonyms, abbreviations, slang.
6. Bans: which generic phrasing and encyclopedia tone you will cut.
7. If user ratings are present: what to keep verbatim and what to rewrite from scratch.
</thinking>`;

/** Думалка персоны: тот же разбор, что у персонажа, но короче — персона проще карточки. */
export const THINKING_PLAN_PERSONA = `<thinking>
1. Core: in one phrase, who {{user}} is playing and what makes them worth inhabiting.
2. Texture: a trait tension or a flaw that keeps them from reading as a blank self-insert.
3. Details: 3-5 concrete markers (appearance, habit, object) {{char}} could actually notice and react to.
4. Situation: what they are doing here, why this story, what they want right now.
5. Bans: cliches this concept invites that you will NOT use.
6. If user ratings are present: what to keep verbatim and which angle failed in the low-rated paragraphs.
</thinking>`;

/**
 * Думалка системного промпта. Разбор тут не про героя, а про то, ЧЕМ этот промпт
 * будет отличаться от дефолтного — иначе модель выдаёт общие слова про «живое
 * повествование», которые ничего не меняют в поведении.
 */
export const THINKING_PLAN_PROMPT = `<thinking>
1. Genre and register: what kind of roleplay this prompt serves, and how its prose should differ from a generic one.
2. Failure modes: which specific bad habits this genre invites (and which the user complained about) - name them as concrete phrases, not as "avoid cliches".
3. Leverage: which two or three rules will actually change the model's output, versus filler everyone ignores.
4. Conflicts: any rules that fight each other (short replies vs rich description) - decide which wins and say so.
5. Wording: every rule must be an instruction the model can follow, not a description of good writing.
6. If user ratings are present: what to keep verbatim and which rule failed in the low-rated paragraphs.
</thinking>`;

/**
 * Думалка разбора пресета (режим «Анализ»). Разбор тут не про то, что писать,
 * а про то, что реально ПРОИСХОДИТ в запросе: порядок и enabled решают, какой
 * блок победит при противоречии, а не то, какой звучит убедительнее на слух.
 */
export const THINKING_PLAN_ANALYSIS = `<thinking>
1. Symptom -> mechanism: the complaint is often a one-line gut reaction ("dry", "robotic", "boring"), not a spec - translate it into the concrete writing symptoms it means, THEN say what actually reaches the request for those symptoms - order and enabled state decide that, not a block's stated intent, and samplers (temperature, penalties) matter here as much as prompt text.
2. Suspects: which named blocks (or sampler values) plausibly cause or contribute to it - quote the actual line, not a summary of the block's purpose.
3. Verdict: among suspects, which one is the real cause given order/enabled/role - and rule out the others explicitly if they don't survive that check.
4. Fix: the smallest concrete change that removes the cause - a rewritten line, an order/enabled flip, a new block, a sampler value - not a rewrite of the whole preset.
5. If user ratings are present: what to keep verbatim and which finding was wrong or unconvincing in the low-rated paragraphs.
</thinking>`;

/** Думалка сценария: разбор строится вокруг движка сцены — цель, сюжет, динамика с {{user}} — а не вокруг героя целиком. */
export const THINKING_PLAN_SCENARIO = `<thinking>
1. Character's want: the big goal behind everything, and the immediate one that opens this scenario - one line each.
2. Engine: what keeps the plot moving even when {{user}} is not driving it - which NPCs, which complication.
3. {{user}} dynamic: the starting stance between {{char}} and {{user}}, and where it is pulled to go.
4. Distinctness: if this came from a generated idea, what makes it different from a generic premise - keep that edge.
5. Bans: which generic scenario tropes this premise invites that you will NOT lean on.
6. If user ratings are present: what to keep verbatim and which angle failed in the low-rated paragraphs.
</thinking>`;

/**
 * Сколько токенов ответа нужно набору пунктов: ~1200 на включённый пункт (3–5 абзацев
 * каждый — formatContract в prompts.js требует эту разбивку по умолчанию, иначе модель
 * норовит сдать один абзац на пункт вместо отдельно оцениваемых фактов). Формат по
 * умолчанию — «Полная карточка» из 13 включённых пунктов, и старый дефолт в 4000
 * токенов рвал бы её JSON на полуслове ещё до первой генерации.
 */
function estimateMaxTokens(items) {
    const enabled = items.filter(item => item.enabled !== false).length;
    return Math.min(16000, Math.max(4000, enabled * 1200));
}

export const DEFAULTS = {
    // ─── Подключение ────────────────────────────────────────────────────────
    connection_profile: '',
    connection_profile_id: '',
    max_tokens: estimateMaxTokens(DEFAULT_CHARACTER_FORMAT),

    // ─── Рассуждения ────────────────────────────────────────────────────────
    // Своя копия системы рассуждений Таверны, чтобы LOOM не зависел от настроек чата.
    thinking_budget: 'min',
    reasoning_auto_parse: true,
    reasoning_prefix: '<thinking>',
    reasoning_suffix: '</thinking>',
    start_reply_with: '',
    thinking_hint_enabled: true,
    // Английский в размышлениях заметно дешевле: кириллица жрёт в разы больше токенов на символ.
    thinking_hint: 'Think in English only — this saves tokens. Keep your reasoning to a single short paragraph, '
        + 'STRICTLY within 200 tokens. This limit applies to your thinking ONLY: the content you generate must '
        + 'still follow the language rules stated above.',

    // ─── Думалка ────────────────────────────────────────────────────────────
    // Отдельно от thinking_hint: тот говорит КАК думать (коротко, по-английски),
    // а это — О ЧЁМ. Блок уходит в промпт и просит модель разобрать задачу по
    // пунктам внутри тегов размышлений, которые потом вырезаются из ответа.
    thinking_plan_enabled: true,
    thinking_plan_character: THINKING_PLAN_CHARACTER,
    thinking_plan_lorebook: THINKING_PLAN_LOREBOOK,
    thinking_plan_persona: THINKING_PLAN_PERSONA,
    thinking_plan_prompt: THINKING_PLAN_PROMPT,
    thinking_plan_scenario: THINKING_PLAN_SCENARIO,
    thinking_plan_analysis: THINKING_PLAN_ANALYSIS,

    // ─── Промпты пунктов сцены и ключей (Настройки → Форматы) ───────────────
    prompt_scenario_card: DEFAULT_PROMPT_SCENARIO_CARD,
    prompt_first_mes: DEFAULT_PROMPT_FIRST_MES,
    prompt_keys: DEFAULT_PROMPT_KEYS,
    prompt_plot: DEFAULT_PROMPT_PLOT,
    prompt_plot_pacing: DEFAULT_PROMPT_PLOT_PACING,

    // ─── Сюжет: слежение за ходом ролевой (src/plot.js) ─────────────────────
    // inline — просьба дописать метку в САМ ответ раз в plot_every ответов (доп. запроса нет);
    // request — отдельный запрос-проверка после каждого plot_every-го ответа; manual — только руками.
    plot_mode: 'inline',
    plot_every: 3,
    // Напоминать модели текущий шаг в КАЖДОМ ответе (коротко), а не только когда просят метку
    plot_remind: true,
    // Роль вставки на нулевой глубине: system или user (некоторым моделям хвост от system мешает)
    plot_role: 'system',
    // Глубина вставки в чат: 0 — после последнего сообщения (самый конец запроса), 1 — перед ним и т. д.
    plot_depth: 0,
    plot_float: true,
    plot_float_pos: null,
    plot_panel_pos: null,
    plot_float_size: 'compact',  // compact | big | dot
    plot_bar: false,
    plot_chatbtn: false,
    plot_wand: true,
    launcher_place: 'wand',  // wand | list

    // ─── Общие правила письма ───────────────────────────────────────────────
    output_language: 'русский',
    // Инструкция по-английски, а результат — на output_language: латиница дешевле в токенах
    style_prompt: 'Write dense and concrete. No filler, no bureaucratic phrasing, no vague summaries like '
        + '"a mysterious person with a tragic past". Every paragraph must add a fact that can be used in a scene. '
        + 'Do not moralise and do not wrap things up with a conclusion.',
    // При переводе на английский дублировать имена собственные оригиналом в скобках
    // при первом упоминании («Trafalgar Law (Трафальгар Ло)») — без этого модель в
    // ролевой переводит имена как попало, но кому-то дубли в тексте только мешают.
    translate_keep_original_names: true,

    // ─── Форматы ────────────────────────────────────────────────────────────
    character_format: DEFAULT_CHARACTER_FORMAT,
    lorebook_format: DEFAULT_LOREBOOK_FORMAT,
    persona_format: DEFAULT_PERSONA_FORMAT,
    prompt_format: DEFAULT_PROMPT_FORMAT,
    scenario_format: DEFAULT_SCENARIO_FORMAT,
    preset_format: DEFAULT_PRESET_FORMAT,
    analysis_format: DEFAULT_ANALYSIS_FORMAT,
    // Пользовательские пресеты: [{ id, name, items }]. Встроенные (BUILTIN_*_PRESETS)
    // сюда не попадают — они не хранятся, а вычисляются из констант выше.
    // (Не путать с режимом «Пресет» — тут «пресет» это сохранённый набор ПУНКТОВ
    // формата, для любого режима LOOM; ниже preset_format_presets — те же пресеты
    // форматов, но для полей самого режима «Пресет».)
    character_format_presets: [],
    lorebook_format_presets: [],
    persona_format_presets: [],
    prompt_format_presets: [],
    scenario_format_presets: [],
    preset_format_presets: [],
    analysis_format_presets: [],

    // ─── Лорбук ─────────────────────────────────────────────────────────────
    // Ключи с морфологией: русские слова склоняются, и голый keyword ловит
    // только именительный падеж. Regex решает это, поэтому включён по умолчанию.
    lorebook_regex_keys: true,
    lorebook_regex_flags: 'i',
    // На каком языке ждём текст чата — от этого зависит, какие окончания навешивать
    // на ключ. 'auto' решает по алфавиту самого ключа (см. KEY_LANGUAGES).
    lorebook_key_language: 'auto',
    lorebook_default_word_count: 300,

    // ─── Оценки ─────────────────────────────────────────────────────────────
    // Ниже этого порога абзац считается неудачным и переписывается целиком.
    rating_rewrite_threshold: 6,
    // От этого и выше абзац считается удачным: модели велят его сохранить.
    rating_keep_threshold: 8,

    // ─── Папки ──────────────────────────────────────────────────────────────
    // Трогает не только панель LOOM, но и нативный список персонажей Таверны
    // (долгое нажатие на её кнопку «показать только папки» открывает раскладку
    // LOOM, плюс своё оформление превью-аватарок папки) — поэтому выключено
    // по умолчанию, а не включено, как большинство настроек. См. src/folders.js.
    folders_tool_enabled: false,
    // Действует только вместе с folders_tool_enabled. По умолчанию клик по папке
    // в списке Таверны заходит внутрь неё (её родная сетка карточек) — эта
    // настройка меняет клик на раскрытие списка персонажей папки на месте,
    // без захода. См. initFolderDropdownIntercept в src/folders.js.
    folders_dropdown_view: false,
    // Отдельная настройка поверх folders_dropdown_view: развёрнутая папка показывает
    // персонажей не строками, а кружками-аватарками с подписью под каждым. Сама по себе
    // ничего не включает — раскрывать папку на месте должна folders_dropdown_view.
    folders_circles_view: false,

    // ─── Тема панели (см. src/appearance.js) ────────────────────────────────
    // 'tavern' — цвета берутся из активной темы Таверны (так панель выглядела всегда);
    // id готовой темы; 'custom' — свой набор theme_custom {bg, text, accent, border, field}.
    theme: 'tavern',
    theme_custom: null,

    drafts: [],
};

const CYRILLIC = /[а-яё]/i;

/**
 * Разовый перевод сохранённых промптов на английский.
 *
 * Промпты уходят в КАЖДЫЙ запрос, а кириллица токенизируется в разы дороже латиницы —
 * поэтому дефолты стали англоязычными. Но дефолт применяется только к пустому полю, и
 * у тех, кто уже открывал настройки, в settings.json остались русские тексты.
 *
 * Меняем только то, в чём есть кириллица, и только один раз (флаг prompts_lang):
 * англоязычная правка пользователя миграцию не переживёт лишь в одном случае — если он
 * специально написал промпт по-русски. Тогда его придётся вернуть руками, зато молчаливой
 * переплаты за токены не будет. Язык РЕЗУЛЬТАТА (output_language) не трогаем вовсе.
 */
function migratePromptsToEnglish(settings) {
    if (settings.prompts_lang === 'en') return;
    settings.prompts_lang = 'en';

    const replaced = [];
    for (const key of ['style_prompt', 'thinking_plan_character', 'thinking_plan_lorebook', 'thinking_plan_persona', 'thinking_plan_prompt', 'thinking_plan_scenario']) {
        if (CYRILLIC.test(String(settings[key] || ''))) {
            settings[key] = DEFAULTS[key];
            replaced.push(key);
        }
    }

    // Подсказки пунктов формата тоже идут в промпт. Подписи (label) — нет: они только
    // для интерфейса и остаются русскими.
    const formats = [
        ['character_format', DEFAULT_CHARACTER_FORMAT],
        ['lorebook_format', DEFAULT_LOREBOOK_FORMAT],
        ['persona_format', DEFAULT_PERSONA_FORMAT],
        ['prompt_format', DEFAULT_PROMPT_FORMAT],
        ['scenario_format', DEFAULT_SCENARIO_FORMAT],
    ];
    for (const [key, defaults] of formats) {
        for (const item of Array.isArray(settings[key]) ? settings[key] : []) {
            const fallback = defaults.find(d => d.id === item.id);
            if (fallback && CYRILLIC.test(String(item.hint || ''))) {
                item.hint = fallback.hint;
                replaced.push(`${key}/${item.id}`);
            }
        }
    }

    if (replaced.length) console.log('[LOOM] Промпты переведены на английский:', replaced.join(', '));
}

/** id-шники старого 7-пунктового дефолта режима «Промпт» — до упрощения до одного ситуативного пункта. */
const OLD_PROMPT_FORMAT_IDS = ['role', 'style', 'character', 'pacing', 'formatting', 'bans', 'intensity'];

/**
 * Разовая замена старого формата режима «Промпт» (роль и задача / стиль повествования /
 * ведение персонажа / темп / форматирование ответа / бан-лист / интенсивность — семь
 * разделов целого пресета) на новый: один ситуативный пункт вместо навязанной структуры
 * системного промпта (см. DEFAULT_PROMPT_FORMAT выше).
 *
 * Заменяем, только если пользователь не трогал список пунктов — набор id совпадает
 * один в один со старым дефолтом. Добавила, убрала или переименовала пункт сама —
 * это уже её работа, миграция её не тронет.
 */
function migratePromptFormatToSituational(settings) {
    if (settings.prompt_format_gen === 2) return;
    settings.prompt_format_gen = 2;

    const ids = Array.isArray(settings.prompt_format) ? settings.prompt_format.map(item => item.id) : [];
    const isUntouchedOldDefault = ids.length === OLD_PROMPT_FORMAT_IDS.length
        && OLD_PROMPT_FORMAT_IDS.every(id => ids.includes(id));
    if (isUntouchedOldDefault) {
        settings.prompt_format = structuredClone(DEFAULT_PROMPT_FORMAT);
        console.log('[LOOM] Формат промпта упрощён: один ситуативный пункт вместо старых семи разделов.');
    }
}

/** Подсказка пункта примеров до переработки — по ней узнаём, что пользователь её не трогал. */
const OLD_EXAMPLES_HINT = 'Two or three short exchanges in the format <START> / {{user}}: … / {{char}}: … to set the tone for the model.';

/**
 * Разовая замена старого пункта «Примеры диалогов» (выключен, подсказка в одну строку) на
 * новый — включённый, с описанием формата поля. Заменяем только если подсказку не правили;
 * своё описание пользователь оставляет, а удалённый пункт не возвращаем.
 */
function migrateExamplesItem(settings) {
    if (settings.examples_item_gen === 3) return;
    settings.examples_item_gen = 3;

    const list = Array.isArray(settings.character_format) ? settings.character_format : [];
    // Заменяем нетронутое: и прежнюю однострочную подсказку, и первую версию нового описания
    // (без правила про имена внутри действий) — по тому, что оно ровно повторяет её начало
    const isStock = hint => hint === OLD_EXAMPLES_HINT
        || (typeof hint === 'string' && hint.startsWith("Example dialogues that show how the character talks in action")
            && !hint.includes('Inside the *actions* too'));
    const index = list.findIndex(item => item?.id === 'examples' && isStock(item.hint));
    if (index === -1) return;
    list[index] = structuredClone(EXAMPLES_ITEM);
    console.log('[LOOM] Пункт «Примеры диалогов» обновлён: теперь включён и описывает формат <START> / {{user}}: / {{char}}:.');
}

/**
 * Объекты настроек, по которым разовая починка данных с диска уже прошла.
 *
 * getSettings() — самая горячая функция расширения: её зовёт listDrafts(), а его —
 * currentDraft() из каждого обработчика ввода, то есть на каждое нажатие клавиши.
 * Раскладка дефолтов и миграции чинят то, что пришло с диска, и после первого прохода
 * ничего не находят — гонять их дальше незачем.
 *
 * WeakSet по той же причине, что и в drafts.js: флаг внутри самого объекта осел бы
 * в settings.json, а так корректно обрабатывается и перечитывание настроек с диска —
 * новый объект в наборе не значится и чинится заново.
 */
const repairedSettings = new WeakSet();

const FORMAT_DEFAULTS = [
    ['character_format', DEFAULT_CHARACTER_FORMAT],
    ['lorebook_format', DEFAULT_LOREBOOK_FORMAT],
    ['persona_format', DEFAULT_PERSONA_FORMAT],
    ['prompt_format', DEFAULT_PROMPT_FORMAT],
    ['scenario_format', DEFAULT_SCENARIO_FORMAT],
    ['preset_format', DEFAULT_PRESET_FORMAT],
];

/** @returns {object} живой объект настроек LOOM (мутируется на месте) */
export function getSettings() {
    const ctx = SillyTavern.getContext();
    const all = ctx.extensionSettings;
    if (!all[SETTINGS_KEY]) all[SETTINGS_KEY] = {};
    const settings = all[SETTINGS_KEY];

    if (!repairedSettings.has(settings)) {
        repairedSettings.add(settings);
        const snapshot = JSON.stringify(settings);

        for (const [key, value] of Object.entries(DEFAULTS)) {
            if (settings[key] === undefined) {
                settings[key] = (value && typeof value === 'object') ? structuredClone(value) : value;
            }
        }

        // Теги размышлений переехали с <think> на <thinking>. Дефолты применяются только
        // к пустым полям, поэтому у старых установок остался бы <think> — подменяем его,
        // но лишь если пользователь не вписал туда что-то своё.
        if (settings.reasoning_prefix === '<think>' && settings.reasoning_suffix === '</think>') {
            settings.reasoning_prefix = DEFAULTS.reasoning_prefix;
            settings.reasoning_suffix = DEFAULTS.reasoning_suffix;
        }

        migratePromptsToEnglish(settings);
        migratePromptFormatToSituational(settings);
        migrateExamplesItem(settings);

        // На диск пишем только если дефолты или миграции реально что-то изменили: раньше
        // каждая загрузка страницы перезаписывала весь settings.json (у пользователя ~2 МБ)
        if (JSON.stringify(settings) !== snapshot) saveSettings();
    }

    // А это — не разовая починка данных с диска, а инвариант: пустой формат нечем
    // генерировать. Опустошить список можно и в самом редакторе форматов (кнопка
    // «Удалить» у последнего пункта), поэтому проверка живёт ВНЕ кэша выше и работает
    // на каждый вызов. Три сравнения длины — на фоне остального ничто.
    for (const [key, defaults] of FORMAT_DEFAULTS) {
        if (!Array.isArray(settings[key]) || !settings[key].length) {
            settings[key] = structuredClone(defaults);
        }
    }

    return settings;
}

export function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

/**
 * Сохраняет НЕМЕДЛЕННО, а не через saveSettingsDebounced (у него 1 секунда
 * задержки — DEFAULT_SAVE_EDIT_TIMEOUT в constants.js Таверны). Для текстовых
 * полей это правильное поведение: незачем слать запрос на каждую напечатанную
 * букву. Но для галочек — не так: клик редкий и осознанный, а если следом
 * сразу перезагрузить страницу или закрыть вкладку (на телефоне это обычное
 * дело), отложенное сохранение просто не успевает долететь до диска, и после
 * перезагрузки настройка выглядит «сброшенной», хотя на самом деле никогда
 * не сохранялась. Импорт прямо из script.js Таверны, а не через её контекст —
 * SillyTavern.getContext() немедленного сохранения не отдаёт вовсе, только
 * отложенное.
 */
export async function saveSettingsImmediate() {
    await saveSettingsToServer();
}

const FORMAT_KEY_BY_KIND = {
    lorebook: 'lorebook_format',
    persona: 'persona_format',
    prompt: 'prompt_format',
    scenario: 'scenario_format',
    character: 'character_format',
    preset: 'preset_format',
    analysis: 'analysis_format',
};

/** Только включённые пункты формата — по ним строится и промпт, и разметка. */
export function activeFormat(kind) {
    const settings = getSettings();
    const list = settings[FORMAT_KEY_BY_KIND[kind] || 'character_format'];
    return list.filter(item => item.enabled !== false && String(item.id || '').trim());
}
