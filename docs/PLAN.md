# Бот «Интервью с мамой» — контекст и план переноса на Cloudflare Workers

Репозиторий: `nook2b/mama-bot`
Текущая реализация: Python (`bot.py`, python-telegram-bot, long polling, состояние в `state.json` на диске).
Целевая реализация: Cloudflare Workers + D1, webhook, деплой через Cloudflare Workers Builds по push в GitHub.

Документ состоит из двух частей:
- **Часть I** — как бот работает сейчас (бизнес-логика, сверенная с `bot.py`). Это источник истины по поведению.
- **Часть II** — план переноса на Workers, с исправлениями ошибок, найденных при ревью.

---
---

# ЧАСТЬ I. Как работает бот

## 1. Назначение

Бот последовательно задаёт 222 заранее заготовленных вопроса одному человеку (маме). Она отвечает **голосовыми сообщениями**. Бот транскрибирует голос через OpenAI Whisper и сохраняет и аудио, и текст на Google Диск — в две разные папки. Есть inline-кнопки для управления, напоминания при бездействии и уведомления об ошибках администратору (Ване).

Аудитория — два человека. Это не продукт, это семейный архив: главное требование — **никогда не терять записанный голос**. Всё остальное (красота, скорость, аналитика) вторично.

## 2. Пользователи и доступ

`ALLOWED_USERS` = `{MAMA_CHAT_ID, VANYA_CHAT_ID}`. Только эти два ID могут взаимодействовать с ботом.

- Чужой прислал `/start` → вежливый отказ: *«Извините, этот бот создан для конкретного человека. 🤗»*
- Чужой прислал что угодно другое (текст, голос, нажатие кнопки) → полное молчание, никакого ответа.

## 3. Состояние

Одна запись состояния на всё приложение (пользователь фактически один).

```json
{
  "current_question": 0,      // индекс текущего вопроса, 0-based
  "waiting_for_voice": false, // ждёт ли бот голосовое прямо сейчас
  "voice_parts": [],          // части текущего ответа — нужны ТОЛЬКО для нумерации
  "text_parts": [],           // расшифровки частей текущего ответа
  "last_activity": null,      // момент последней активности — для напоминаний
  "started": false            // проходил ли пользователь /start
}
```

**Важно:** `voice_parts` / `text_parts` не хранят данные надолго. Они существуют, чтобы посчитать, какая это по счёту «часть» ответа на текущий вопрос (для имени файла), и очищаются при переходе к следующему вопросу. Сами файлы улетают на Google Диск сразу при получении.

## 4. Банк вопросов

`questions.json` — плоский массив из **222 строк** на русском (проверено: файл в репозитории, `len == 222`, первый элемент — *«Какое твоё самое раннее воспоминание из детства — что ты видишь перед глазами?»*). Категорий нет, хотя внутри есть смысловые блоки (детство, работа, любовь).

`get_question_text(index)` → `questions[index]`, либо `null`, если индекс вне диапазона. `null` — это сигнал «все вопросы пройдены».

Количество вопросов берётся из длины массива, не из константы.

## 5. Команды

### `/start`
1. Проверка доступа. Не прошёл → отказ, выход.
2. Если `started === true` **и** `current_question > 0` — это повторный `/start`. Ответить *«👋 С возвращением! Вы остановились на вопросе X из 222. Нажмите /continue чтобы продолжить, или /reset чтобы начать сначала.»* и **больше ничего не делать**.
3. Иначе (первый запуск) — сбросить состояние: `started=true`, `current_question=0`, `waiting_for_voice=true`, part-массивы пустые, `last_activity=now`.
4. Отправить приветствие (§9).
5. Пауза **3 секунды** — чтобы человек успел прочитать приветствие до первого вопроса.
6. Отправить вопрос №1.

### `/continue`
Проверка доступа → `waiting_for_voice=true`, очистить part-массивы, `last_activity=now` → **повторно отправить текущий вопрос**. Прогресс не двигается.

### `/reset`
Проверка доступа → сообщение *«⚠️ Вы уверены? Прогресс будет сброшен (уже сохранённые файлы на Диске останутся).»* с кнопками **«Да, начать сначала»** (`confirm_reset`) и **«Нет, продолжить»** (`cancel_reset`).
Само обнуление происходит только в обработчике кнопки, не здесь.

### `/status`
`pct = round(current_question / 222 * 100)`, прогресс-бар из 20 символов (`round(pct/5)` штук `█`, остальное `░`):
```
📊 Прогресс:

{bar} {pct}%
Пройдено: X из 222 вопросов
Осталось: Y
```

### `/jump N`
1. Аргумента нет или не число → *«Укажите номер вопроса. Например: /jump 45»*
2. Вне диапазона [1, 222] → *«Номер должен быть от 1 до 222.»*
3. Иначе: `current_question = N-1`, `waiting_for_voice=true`, part-массивы очищены, `started=true`, `last_activity=now` → *«⏭ Переходим к вопросу N!»* → отправить сам вопрос.

## 6. Обработка голосового сообщения — ключевая логика

**Шаг 0.** Проверка доступа. Если `started === false` → *«Напиши /start чтобы начать!»*, выход.

**Шаг 0.5 — автоактивация.** Если `waiting_for_voice === false` — бот **не отказывает**, а молча ставит `true` и продолжает обработку.
*Это осознанное решение: раньше бот писал «нажмите /continue», из-за чего первое голосовое после паузы терялось. Голосовое принимается всегда, в любой момент.*

**Шаг 1 — скачивание.** `getFile` → скачать по ссылке в буфер. Формат — Ogg/Opus.

**Шаг 2 — уведомление.** Отправить *«⏳ Расшифровываю...»* (обычное сообщение, дальше не редактируется).

**Шаг 3 — транскрибация.** OpenAI Whisper: модель `whisper-1`, язык `ru`, prompt `"Транскрибация голосового сообщения на русском языке"`.

**Шаг 3a — если транскрибация упала:**
1. Всё равно `voice_parts.push(маркер)` и `text_parts.push("[Транскрибация не удалась]")`.
2. `last_activity=now`, сохранить состояние.
3. **Всё равно загрузить аудио на Диск** — с текстом-заглушкой `"[Транскрибация не удалась]"`. Это гарантирует, что 7-минутный рассказ не придётся перезаписывать: голос физически сохранён.
4. Маме — мягко, без технических деталей: *«Ой, что-то пошло не так с расшифровкой 😔 Но голосовое я сохранил! Не переживай, Ваня разберётся.»*
5. Ване — техническая ошибка с номером вопроса.
6. **Всё равно показать кнопки** «Ещё не всё» / «Следующий вопрос» — процесс не блокируется.
7. Выход.

**Шаг 4 — успех:**
1. `voice_parts.push(маркер)`, `text_parts.push(text)`.
2. `last_activity=now`, сохранить состояние.
3. `upload_immediately(...)` — залить аудио и текст на Диск **немедленно**, не дожидаясь нажатия «Следующий вопрос». *Раньше файлы копились до нажатия кнопки, что грозило потерей данных при перезапуске. Теперь каждое голосовое сразу улетает на Диск.*
4. Маме: *«✅ Получено!»*
5. Показать кнопки.

### `upload_immediately(state, audio, text)`

1. `question_text = questions[current_question]`
2. `safe = sanitize_filename(question_text)`
3. `prefix = "{номер с ведущими нулями, 3 цифры}. {safe}"` → например `"001. Какое твоё самое раннее воспоминание из детства"`
4. **`part_num` = длина `voice_parts` ПОСЛЕ push.** Первое голосовое на вопрос → 1, второе → 2.
5. `part_num > 1` → суффикс `" (часть {part_num})"`; при `part_num === 1` суффикса нет.
6. **Аудио:** имя `"{prefix}{suffix}.ogg"`, MIME `audio/ogg`, папка `GOOGLE_AUDIO_FOLDER_ID`.
7. **Текст:** имя `"{prefix}{suffix}"` (без расширения — конвертируется в Google Doc), содержимое `"Вопрос: {question_text}\n\nОтвет:\n{text}"`, папка `GOOGLE_TEXT_FOLDER_ID`.
8. Обе загрузки независимы, каждая в своём try/catch. Падение одной не блокирует другую; каждая ошибка уходит Ване с номером вопроса.

### `sanitize_filename(text, max_length=80)`
- `/`, `\`, `:` → `-`
- удалить `?`, `«`, `»`, `"`, `*`, `<`, `>`, `|`
- переносы строк → пробел, `trim()`
- если длиннее 80 — обрезать по последнему пробелу, чтобы не резать слово посередине

## 7. Вспомогательные отправки

### `send_question(chat_id, idx)`
Если вопроса с таким индексом нет — отправить финальное сообщение (§9) и выйти. Иначе:
```
📋 Вопрос {idx+1} из 222

❓ {текст вопроса}

🎤 Запиши голосовое сообщение с ответом.
```

### `send_continue_keyboard(chat_id)`
Текст *«Хочешь добавить ещё что-то к этому ответу?»*, две кнопки в один ряд:
- `"🎤 Ещё не всё"` → `more`
- `"➡️ Следующий вопрос"` → `next`

## 8. Кнопки (callback_query)

Единый обработчик. **Первым делом — проверка доступа по `callback_query.from.id`.** Каждая ветка обязана ответить `answerCallbackQuery`, иначе в клиенте останутся вечные «часики».

| `callback_data` | Действие |
|---|---|
| `more` | Отредактировать сообщение на *«Записывай, я слушаю! 🎤»*. Состояние не трогаем — следующее голосовое просто добавится к тому же вопросу. |
| `next` | Отредактировать на *«✅ Идём дальше ❤️»*; `current_question += 1`; очистить part-массивы; `waiting_for_voice=true`; `last_activity=now`; сохранить; отправить новый вопрос (если вопросы кончились — сработает финальное сообщение). **На Диск здесь ничего не сохраняется — это уже произошло при получении каждого голосового.** |
| `confirm_reset` | Полностью пересоздать состояние (`current_question=0`, `waiting_for_voice=true`, пустые массивы, `last_activity=now`, `started=true`) → *«🔄 Начинаем сначала!»* → вопрос №1. |
| `cancel_reset` | *«👍 Продолжаем с того же места!»*, состояние не трогаем. |
| `reminder_continue` | `waiting_for_voice=true`, `last_activity=now` → *«Отлично! Продолжаем! 🚀»* → повторно отправить текущий вопрос. |
| `reminder_later` | *«Хорошо, напомню позже! 😊»*, состояние не трогаем. Спама не будет: `last_activity` уже обновлён в момент отправки самого напоминания (§10). |

## 9. Тексты (verbatim — тон важен)

**Приветствие (`/start`, первый запуск):**
```
Привет, мама! ❤️

Это бот, который я сделал специально для тебя. Я хочу сохранить твои истории, воспоминания и мудрость — чтобы они остались в нашей семье навсегда.

Бот будет задавать тебе вопросы — по одному за раз. Всё что нужно — записать голосовое сообщение с ответом. Не торопись, отвечай как чувствуешь.

Можно отправить несколько голосовых на один вопрос, если хочешь рассказать подробнее.

Всего вопросов 222, но нет никакой спешки. Хоть по одному в неделю. Главное — твои истории.

С любовью, Ваня ❤️
```

**Финальное сообщение (после 222-го вопроса):**
```
🎉 Мама, все 222 вопроса пройдены!

Спасибо тебе огромное за каждый ответ, за каждую историю, за каждое воспоминание. Это самый ценный подарок, который ты могла мне дать.

Теперь эти истории останутся в нашей семье навсегда. ❤️

С любовью и благодарностью, Ваня
```

**Напоминание:**
```
Мам, привет! 😊 Ты остановилась на вопросе {N} из 222. Продолжим, когда будет настроение?
```
Кнопки: «Давай продолжим! ❤️» / «Попозже».

## 10. Напоминания

Проверка **раз в час**. Логика:
1. `started === false` → выход.
2. `current_question >= 222` → выход (всё пройдено).
3. `last_activity` не задан → выход.
4. Прошло **< 72 часов** → выход.
5. Иначе: отправить напоминание маме с кнопками (`current_question + 1` в тексте) → **сразу обновить `last_activity` на now** → сохранить. Обновление обязательно: иначе следующая проверка через час пришлёт ещё одно напоминание. При ошибке отправки — только лог, Ване не эскалируется.

## 11. Прочие сообщения (не голос, не команда)

- `waiting_for_voice === true` → *«🎤 Запиши голосовое сообщение!\n\nЗажми иконку микрофона и запиши свой ответ.»*
- иначе → *«Нажми /continue чтобы продолжить отвечать на вопросы.\nИли /status чтобы посмотреть прогресс.»*

## 12. Уведомления Ване

`notify_vanya(errorText)` шлёт **только** на `VANYA_CHAT_ID`:
```
⚠️ Ошибка в боте:

{текст ошибки, обрезанный до 500 символов}
```
Вызывается в трёх местах: ошибка транскрибации (с 🔴 и номером вопроса + «Аудио сохранено, но текст не расшифрован. Нужно разобраться!»), ошибка загрузки аудио, ошибка загрузки текста.

Плюс **глобальный обработчик необработанных исключений** — всё остальное уходит Ване с префиксом:
```
🔴 Необработанная ошибка в боте:

{текст ошибки, обрезанный до 500 символов}
```

## 13. Google Drive (OAuth)

OAuth 2.0 с refresh-токеном (offline access), **не** сервисный аккаунт. Структура секрета:
```json
{
  "token": "access_token (~1 час)",
  "refresh_token": "долгоживущий",
  "client_id": "...",
  "client_secret": "...",
  "token_uri": "https://oauth2.googleapis.com/token"
}
```
Обратите внимание: поле называется **`token`**, а не `access_token`.

Вызовы Drive API v3:
- `files.create` с media — аудио, MIME `audio/ogg`, `parents: [folder_id]`.
- `files.create` с media `text/plain`, но `mimeType: application/vnd.google-apps.document` в метаданных — это заставляет Drive сконвертировать текст в Google Doc при загрузке.

**Грабли, на которые уже наступали:** если приложение в Google Cloud в статусе **Testing** (а не **Production**), `refresh_token` живёт **7 дней**, потом `invalid_grant`. Перед постоянной эксплуатацией обязательно перевести в **Production**. Даже в Production токен протухает при очень долгом простое (реально случилось после ~4 месяцев) — тогда токен получается заново вручную через OAuth consent flow в браузере.

## 14. Жизненный цикл одного вопроса

```
[Вопрос отправлен]
        ↓
[Мама записывает голосовое]
        ↓
[Бот скачивает файл] → [Транскрибирует через Whisper]
        ↓                        ↓ (если ошибка)
    [Успех]              [Сохраняет аудио с заглушкой,
        ↓                 уведомляет Ваню, всё равно кнопки]
[Сразу заливает аудио + текст на Google Диск]
        ↓
[Кнопки «Ещё не всё» / «Следующий вопрос»]
        ↓                                ↓
 [Ещё не всё]                    [Следующий вопрос]
        ↓                                ↓
[Ждёт ещё голосовое              [current_question += 1,
 на тот же вопрос,                очищает part-счётчики,
 part_num растёт]                 отправляет новый вопрос]
```

## 15. Известные баги, унаследованные из Python-версии

Переносим осознанно, чинить — отдельным решением:

1. **`/continue` сбрасывает счётчик частей.** Если мама записала 2 части, нажала `/continue` и записала третью — она уйдёт на Диск как «часть 1», с именем, совпадающим с самым первым файлом. Drive дубли имён разрешает, так что два файла с одинаковым названием просто лягут рядом. Чинится, если хранить не длину массива, а отдельный не сбрасываемый `/continue` счётчик.
2. **`/status` считает `current_question` как «пройдено»,** хотя текущий вопрос ещё не отвечен — off-by-one по смыслу. Поведение привычное, оставляем.
3. **Напоминания бесконечны:** если не реагировать, они приходят каждые 72 часа до конца времён.

---
---

# ЧАСТЬ II. План переноса на Cloudflare Workers

> Этот план — исправленная версия. Все места, помеченные **[ИСПРАВЛЕНО]**, содержали ошибку в первой редакции; правки объяснены, чтобы их случайно не откатили обратно.

## 1. Инварианты — прочитать до написания первой строки кода

Три ошибки первой редакции плана были ошибками типов и порядка. Фиксируем правила, из которых они не воспроизводятся:

**И1. `last_activity` — всегда `Date.now()`, число, epoch-миллисекунды.** **[ИСПРАВЛЕНО]**
В Python это ISO-строка. Если сохранить строку, а в напоминаниях считать `Date.now() - state.last_activity`, получится `NaN`; условие `NaN < 72` ложно, ранний выход не сработает, и **напоминание уйдёт при каждом срабатывании крона, то есть каждый час**. Число — везде: `/start`, `/continue`, `/jump`, `handleVoice`, все коллбэки, `reminders.js`.

**И2. ID пользователей сравниваем строками.** **[ИСПРАВЛЕНО]**
`vars` из `wrangler.json` всегда приходят строками (`"1219919762"`), а `message.from.id` — число. Прямое сравнение даёт `false` для всех, включая маму, — бот молчит на всё.
```js
const allowedIds = new Set([env.MAMA_CHAT_ID, env.VANYA_CHAT_ID].map(String))
export const isAllowed = (env, id) => id != null && allowedIds.has(String(id))
```

**И3. `partNum` считается ПОСЛЕ `push`.** **[ИСПРАВЛЕНО]**
`voice_parts.push(...)` → `saveState` → `uploadImmediately`, внутри которого `partNum = state.voice_parts.length`. Первое голосовое → 1 (без суффикса), второе → 2 → `" (часть 2)"`.
Если считать до push, получится 0 и 1, условие `partNum > 1` ложно в обоих случаях, и **два файла лягут на Диск с одинаковым именем**. Ошибки не будет — просто тихо два одинаково названных файла, и разобраться потом невозможно.

**И4. Число вопросов — только `questions.length`.** **[ИСПРАВЛЕНО]**
Убрана переменная `TOTAL_QUESTIONS` из `vars`: два источника истины разъедутся при первом же изменении банка вопросов. В `bot.py` сделано ровно так (`TOTAL_QUESTIONS = len(QUESTIONS)`).

**И5. Тяжёлая работа — в `ctx.waitUntil`, ответ Telegram — сразу.** См. §7.

## 2. Структура репозитория

```
mama-bot/
├── src/
│   ├── worker.js          # точка входа: fetch() + scheduled()
│   ├── bot-handler.js     # разбор апдейтов (команды, voice, callback_query)
│   ├── state.js           # чтение/запись состояния в D1
│   ├── questions.js       # загрузка вопросов, get/total
│   ├── whisper.js         # транскрибация через OpenAI
│   ├── drive.js           # Google OAuth refresh + загрузка на Диск
│   ├── reminders.js       # логика напоминаний (из scheduled)
│   ├── admin.js           # notifyVanya
│   └── telegram.js        # тонкая обёртка над Bot API
├── test/
│   └── pure.test.js       # тесты чистых функций (см. §13)
├── questions.json         # 222 вопроса, плоский массив строк — УЖЕ В РЕПО
├── schema.sql             # DDL для D1
├── wrangler.json
├── package.json
├── .gitignore             # ВНИМАНИЕ: сейчас в репо файл называется `gitignore`, без точки — не работает
└── README.md
```

Фронтенда нет. Wrangler всё равно прогоняет код через esbuild — это и позволяет `import questions from "../questions.json"`, отдельного шага сборки писать не нужно.

Python-файлы (`bot.py`, `requirements.txt`, `Dockerfile`) при переключении можно оставить как исторический референс либо убрать в `legacy/`. Решение за владельцем; на работу воркера они не влияют.

`.gitignore` должен содержать как минимум: `node_modules/`, `.wrangler/`, `.dev.vars`, `state.json`, `tmp/`.

## 3. Конфигурация

### `wrangler.json`
```json
{
  "name": "mama-bot",
  "main": "src/worker.js",
  "compatibility_date": "<дата создания воркера, ГГГГ-ММ-ДД>",
  "triggers": {
    "crons": ["0 * * * *"]
  },
  "vars": {
    "MAMA_CHAT_ID": "1219919762",
    "VANYA_CHAT_ID": "411340432",
    "GOOGLE_AUDIO_FOLDER_ID": "<folder_id>",
    "GOOGLE_TEXT_FOLDER_ID": "<folder_id>",
    "REMINDER_INTERVAL_HOURS": "72"
  },
  "d1_databases": [
    { "binding": "DB", "database_name": "mama-bot", "database_id": "<после создания>" }
  ]
}
```
`TOTAL_QUESTIONS` удалён намеренно — см. И4.

### Секреты (`wrangler secret put <name>`)
| Секрет | Назначение |
|---|---|
| `TELEGRAM_TOKEN` | токен от BotFather (существующий) |
| `OPENAI_API_KEY` | ключ для Whisper (существующий) |
| `GOOGLE_CREDENTIALS_JSON` | `{token, refresh_token, client_id, client_secret, token_uri}` (существующий) |
| `WEBHOOK_SECRET` | новая случайная строка: `openssl rand -hex 32` |

Секреты живут на стороне воркера и переживают редеплои через Workers Builds — задать их достаточно один раз.

### Тариф
**Заложиться на Workers Paid ($5/мес).** На free-плане очень маленький лимит CPU-времени на вызов. Ожидание `fetch` (Whisper, Drive) в CPU не считается, а вот сборка multipart-тела на несколько мегабайт — считается. Риск словить `Exceeded CPU limit` на длинных голосовых реален. Проверить лимиты актуального тарифа до продакшена.

## 4. Схема D1 (`schema.sql`)

Одна универсальная kv-таблица — никаких `ALTER TABLE` в будущем, гибкость через JSON:

```sql
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,      -- JSON-строка
  updated_at INTEGER NOT NULL
);
```

Ключи:

**`state`**
```json
{
  "current_question": 0,
  "waiting_for_voice": false,
  "voice_parts": [],
  "text_parts": [],
  "last_activity": null,
  "started": false
}
```
`voice_parts` хранит строковые маркеры (`"part"`), а не бинарь: в Workers нет диска, `ArrayBuffer` в JSON не сериализуется, а сам массив нужен только для длины.

**`google_token`**
```json
{
  "access_token": "...",
  "expires_at": 1735689600000,
  "refresh_token": "...",
  "client_id": "...",
  "client_secret": "...",
  "token_uri": "https://oauth2.googleapis.com/token"
}
```
Инициализируется один раз из `GOOGLE_CREDENTIALS_JSON`, дальше живёт и обновляется только в D1. Секрет остаётся неизменным «сидом», актуальный токен всегда в базе.

**`seen_updates`** — `{ "ids": [последние ~100 update_id] }`, для идемпотентности (§7).

`state.js` экспортирует:
```js
getState(env)                    // SELECT, JSON.parse, дефолт если пусто
saveState(env, state)            // INSERT ... ON CONFLICT DO UPDATE
saveStateIfUnchanged(env, state, expectedUpdatedAt)  // CAS, см. §7
getGoogleToken(env)
saveGoogleToken(env, token)
```

## 5. `questions.js`
```js
import questions from '../questions.json'
export const getQuestionText = (idx) => questions[idx] ?? null
export const getTotalQuestions = () => questions.length   // 222
```

## 6. `telegram.js`
```js
tgApi(env, method, body)   // POST https://api.telegram.org/bot{TOKEN}/{method}
getFileUrl(env, fileId)    // getFile → https://api.telegram.org/file/bot{TOKEN}/{file_path}
downloadFile(url)          // fetch → ArrayBuffer
```
Все модули ходят в Telegram только через эту обёртку — в Python-версии `fetch` был размазан по всем функциям, здесь централизуем сразу.

`getFile` отдаёт файлы **не больше 20 МБ** (лимит Bot API). Для Opus-голосового это больше двух часов, практически недостижимо, но ошибку скачивания надо обработать явным сообщением маме, а не ронять в глобальный catch — иначе она получит молчание и не поймёт, дошло ли.

## 7. `worker.js` — точка входа и модель выполнения

```js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (url.pathname === '/api/bot' && request.method === 'POST') {
      return handleBotWebhook(request, env, ctx)
    }
    return new Response('not found', { status: 404 })
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkReminder(env))
  },
}
```

### Отвечаем Telegram сразу **[ИСПРАВЛЕНО]**

В первой редакции весь конвейер (скачать → Whisper → два аплоада → три сообщения) выполнялся до возврата ответа. Для 7-минутного голосового это десятки секунд. **Telegram при отсутствии 2xx в свой таймаут повторно доставляет тот же апдейт** — и всё выполняется второй раз: второе «⏳ Расшифровываю…», второй платный вызов Whisper, второй комплект файлов на Диске, съехавший `partNum`. Параметр `ctx` в сигнатуре был, но не использовался.

```js
export async function handleBotWebhook(request, env, ctx) {
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
    return new Response('unauthorized', { status: 401 })
  }
  const update = await request.json()
  ctx.waitUntil(processUpdate(env, update))   // вся тяжёлая работа — в фоне
  return new Response('ok')                    // Telegram доволен немедленно
}
```

То же касается `/start`: 3-секундная пауза перед первым вопросом (`await new Promise(r => setTimeout(r, 3000))`) больше не держит HTTP-ответ.

### Идемпотентность **[ДОБАВЛЕНО]**

Ретрай Telegram (сеть, редеплой в момент обработки) не должен приводить к повторной обработке. В начале `processUpdate` — отбрасывать уже виденные `update_id`, храня последние ~100 в ключе `seen_updates`.

### Единый глобальный catch

```js
async function processUpdate(env, update) {
  try {
    if (update.callback_query) return await handleCallback(env, update.callback_query)
    const message = update.message
    if (!message) return
    if (!isAllowed(env, message.from?.id)) return await handleUnauthorized(env, message)
    if (message.voice || message.audio || message.video_note) return await handleVoice(env, message)
    if (message.text?.startsWith('/')) return await handleCommand(env, message)
    return await handleOther(env, message)
  } catch (e) {
    await notifyVanya(env, `🔴 Необработанная ошибка в боте:\n\n${String(e)}`)
  }
}
```

Заметки:
- **Catch ровно один.** В первой редакции глобальный try/catch был описан и в `worker.js`, и в `bot-handler.js` — при доработке легко получить два сообщения Ване на одну ошибку.
- **`handleUnauthorized`** сам разбирается: на `/start` — вежливый отказ, на всё остальное — молчание (`return` без ответа).
- **`message.audio` / `video_note` тоже принимаются** **[ДОБАВЛЕНО]**: если мама пришлёт не «кружок с микрофоном», а аудиофайл, в первой редакции она получала бы «запиши голосовое сообщение» и не поняла бы, что не так.

### Гонка за состоянием **[ДОБАВЛЕНО]**

`getState` → мутация → `saveState` не атомарна. В Python это было безопасно (один процесс, последовательная обработка). В Workers два голосовых подряд или голосовое плюс нажатие кнопки могут выполниться параллельно в разных изолятах → потеря обновления (например, `voice_parts` не вырастет, и часть 2 запишется как часть 1).

Меры, обе дешёвые, берём обе:
1. `max_connections=1` при `setWebhook` — Telegram по умолчанию открывает до 40 параллельных доставок; единица их сериализует.
2. `saveStateIfUnchanged` — условный `UPDATE ... WHERE updated_at = ?` с одним ретраем при промахе.

Durable Object был бы «правильным» решением, но для двух пользователей это лишняя сущность в архитектуре — не тащим.

## 8. `bot-handler.js`

Команды, кнопки и обработка голосового — ровно по Части I, §5–§8, с учётом инвариантов И1–И3.

Отдельно про парсер команд: брать `message.text.split(/\s+/)[0]` и **отрезать `@botname`** (`/jump@mama_bot 50`) — в личке не встретится, но стоит копейки.

`handleCallback` **первым делом проверяет `callback_query.from.id`** **[ИСПРАВЛЕНО]** — в первой редакции ветка `callback_query` стояла выше проверки доступа, а внутри проверки не было; в `bot.py:492` она есть. И каждая ветка обязана вызвать `answerCallbackQuery`.

## 9. `whisper.js`

```js
export async function transcribe(env, audioArrayBuffer) {
  const form = new FormData()
  form.append('file', new Blob([audioArrayBuffer], { type: 'audio/ogg' }), 'voice.ogg')
  form.append('model', 'whisper-1')
  form.append('language', 'ru')
  form.append('prompt', 'Транскрибация голосового сообщения на русском языке')
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
  })
  if (!res.ok) throw new Error(`Whisper HTTP ${res.status}: ${await res.text()}`)
  return (await res.json()).text
}
```
`FormData` / `Blob` / `fetch` в Workers нативны, диск не нужен. Лимит файла у Whisper — 25 МБ, он выше телеграмовских 20 МБ, так что упрёмся раньше в `getFile`.

## 10. `drive.js`

### Токен
```js
async function getValidAccessToken(env) {
  let token = await getGoogleToken(env)
  if (!token) {
    const seed = JSON.parse(env.GOOGLE_CREDENTIALS_JSON)
    token = {
      ...seed,
      access_token: seed.access_token ?? seed.token,   // [ИСПРАВЛЕНО] в секрете поле называется `token`
      token_uri: seed.token_uri ?? 'https://oauth2.googleapis.com/token',
      expires_at: 0,                                    // форсируем refresh при первом обращении
    }
    await saveGoogleToken(env, token)
  }
  if (Date.now() >= token.expires_at - 60_000) {
    const res = await fetch(token.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: token.client_id,
        client_secret: token.client_secret,
        refresh_token: token.refresh_token,
        grant_type: 'refresh_token',
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      if (body.includes('invalid_grant')) {
        throw new Error('GOOGLE_TOKEN_DEAD: refresh_token отозван или протух — нужна ручная переавторизация через OAuth consent flow')
      }
      throw new Error(`Google token refresh failed: ${body}`)
    }
    const fresh = await res.json()
    token.access_token = fresh.access_token
    token.expires_at = Date.now() + fresh.expires_in * 1000
    await saveGoogleToken(env, token)
  }
  return token.access_token
}
```

**Отдельное сообщение на `invalid_grant`** **[ДОБАВЛЕНО]**: Часть I §13 прямо предупреждает, что токен уже умирал. Если это уйдёт Ване общим текстом «ошибка загрузки», через полгода придётся вспоминать, что вообще произошло. Пусть в уведомлении прямо стоит «токен Google умер, нужна ручная переавторизация».

### Загрузка
```js
export async function uploadAudio(env, filename, arrayBuffer, folderId)
export async function uploadDoc(env, filename, text, folderId)
```
Обе — через `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`, тело `multipart/related` (часть с метаданными JSON + часть с media).

**Тело собирать только через `Blob`** **[ДОБАВЛЕНО]** — главная ловушка, которой в первой редакции не было:
```js
const body = new Blob([preamble, new Uint8Array(arrayBuffer), closing])
// Content-Type: multipart/related; boundary=...
```
Наивная конкатенация строк испортит бинарь необратимо, и это обнаружится только когда кто-то попробует послушать файл.

Для Google Doc: media-часть — `text/plain`, а в метаданных `mimeType: "application/vnd.google-apps.document"`.

## 11. `reminders.js`

```js
export async function checkReminder(env) {
  const state = await getState(env)
  if (!state.started) return
  if (state.current_question >= getTotalQuestions()) return
  if (!state.last_activity) return

  const hoursSince = (Date.now() - state.last_activity) / 3_600_000   // И1: число, не ISO
  if (hoursSince < Number(env.REMINDER_INTERVAL_HOURS || 72)) return

  try {
    await tgApi(env, 'sendMessage', {
      chat_id: env.MAMA_CHAT_ID,
      text: `Мам, привет! 😊 Ты остановилась на вопросе ${state.current_question + 1} из ${getTotalQuestions()}. Продолжим, когда будет настроение?`,
      reply_markup: { inline_keyboard: [[
        { text: 'Давай продолжим! ❤️', callback_data: 'reminder_continue' },
        { text: 'Попозже', callback_data: 'reminder_later' },
      ]] },
    })
    state.last_activity = Date.now()   // сразу — иначе спам каждый час
    await saveState(env, state)
  } catch (e) {
    console.error('reminder send failed:', e)   // в Python тоже не эскалируется Ване
  }
}
```

Триггерится Cron `0 * * * *`. Аналог `first=60` из Python не нужен — расписание само набежит в течение часа после деплоя.

## 12. `admin.js`

```js
export async function notifyVanya(env, text) {
  try {
    await tgApi(env, 'sendMessage', {
      chat_id: env.VANYA_CHAT_ID,
      text: `⚠️ Ошибка в боте:\n\n${text.slice(0, 500)}`,
    })
  } catch { /* нет смысла эскалировать ошибку самой эскалации */ }
}
```

Обёртка `⚠️ Ошибка в боте:` восстановлена — в первой редакции она потерялась, хотя в `bot.py:184` есть. Итоговое сообщение выглядит как в Python: `⚠️ Ошибка в боте:\n\n🔴 Ошибка транскрибации (вопрос N): ...`.
Обрезка `slice(0, 500)` применяется **к тексту ошибки**, не к готовому сообщению с префиксом — иначе от самой ошибки останется заметно меньше.

Три места вызова: ошибка транскрибации, ошибка аплоада аудио, ошибка аплоада текста — каждая с 🔴 и номером вопроса. Плюс глобальный catch в `processUpdate`.

## 13. Тесты **[ДОБАВЛЕНО]**

В первой редакции тестирование было целиком ручным и на проде — то есть за реальные деньги на Whisper и с записью мусора на семейный Диск.

Вынести чистые функции и покрыть их (`node --test`, без сети):
- `sanitizeFilename` — спецсимволы, обрезка по последнему пробелу на границе 80;
- расчёт прогресс-бара — 0%, 50%, 100%, длина всегда 20 символов;
- `partNum` → суффикс — 1 даёт пустую строку, 2 даёт `" (часть 2)"`;
- `isAllowed` — **число против строки** (И2), `undefined`, чужой ID.

`wrangler dev` + `.dev.vars` для локальной прогонки без деплоя.

## 14. Деплой

1. **D1:** `wrangler d1 create mama-bot` → вписать `database_id` в `wrangler.json` → `wrangler d1 execute mama-bot --remote --file=schema.sql`
2. **Секреты:** `wrangler secret put TELEGRAM_TOKEN`, `OPENAI_API_KEY`, `GOOGLE_CREDENTIALS_JSON`, `WEBHOOK_SECRET`
3. **Первый деплой:** разово `wrangler deploy` (единственный легитимный ручной деплой — до подключения CF Builds). Получаем `mama-bot.<subdomain>.workers.dev`
4. **Выключить старый Python-бот.** Делать это ДО регистрации вебхука: polling и webhook одновременно — гонка за апдейты
5. **Зарегистрировать вебхук:**
   ```bash
   curl -X POST "https://api.telegram.org/bot$TELEGRAM_TOKEN/setWebhook" \
     -d "url=https://mama-bot.<subdomain>.workers.dev/api/bot" \
     -d "secret_token=$WEBHOOK_SECRET" \
     -d "drop_pending_updates=true" \
     -d "max_connections=1" \
     -d 'allowed_updates=["message","callback_query"]'
   ```
   **[ИСПРАВЛЕНО]** `drop_pending_updates=true` — в Python было `run_polling(drop_pending_updates=True)`; без него прилетит вся накопившаяся очередь старых апдейтов. `max_connections=1` — сериализация доставки (§7). `allowed_updates` — чтобы не будить воркер на то, что он не обрабатывает.
6. **Подключить GitHub:** дашборд Cloudflare → Workers → mama-bot → Settings → Builds → Connect to `nook2b/mama-bot`. Дальше push в основную ветку = автодеплой

## 15. Чек-лист перед стартом реализации

- [x] ~~Прислать `questions.json`~~ — уже в репозитории, 222 строки, формат корректен
- [ ] Подтвердить `MAMA_CHAT_ID` = `1219919762`, `VANYA_CHAT_ID` = `411340432`
- [ ] Получить `GOOGLE_AUDIO_FOLDER_ID`, `GOOGLE_TEXT_FOLDER_ID`
- [ ] Google OAuth consent screen переведён в **Production** (иначе `refresh_token` живёт 7 дней — Часть I §13)
- [ ] Решение по тарифу Workers (§3)
- [ ] Переименовать `gitignore` → `.gitignore`

## 16. Тестирование после деплоя

- `/start` с чужого аккаунта → вежливый отказ. Любое другое сообщение с чужого → полное молчание
- `/start` первый раз → приветствие → вопрос 1 через 3 сек
- **`/start` от мамы вообще работает** — прямая проверка И2: если сравнение ID сломано, бот молчит на всё
- Голосовое → «Расшифровываю» → «Получено» → файлы реально появились на Диске (аудио + doc), **аудио открывается и слушается** (проверка сборки multipart, §10)
- «Ещё не всё» → второе голосовое → в имени файла суффикс «(часть 2)», **а не второй файл с тем же именем** (проверка И3)
- «Следующий вопрос» → вопрос 2
- `/status`, `/jump 50`, `/reset` (обе ветки confirm/cancel)
- Прислать аудиофайл вместо голосового → обрабатывается как ответ
- Искусственно сломать Whisper (временно испортить ключ) → аудио всё равно улетает на Диск с заглушкой, маме мягкое сообщение, Ване уведомление, кнопки показаны
- Занизить `REMINDER_INTERVAL_HOURS` → дождаться напоминания по крону. **Затем дождаться следующего часа и убедиться, что второе напоминание НЕ пришло** — прямая проверка И1
- Отправить два голосовых подряд, не дожидаясь ответа на первое → обе части сохранились, нумерация не съехала

## 17. Что осознанно не делаем

- **Durable Objects** — избыточно для двух пользователей; `max_connections=1` + CAS закрывают проблему
- **Ключевание состояния по `chat_id`** — пользователь один; схема `kv` позволяет добавить позже без миграции
- **i18n** — язык один, аудитория два человека, тексты живут инлайн в коде
- **Замена `whisper-1` на более новую модель транскрибации** — возможное улучшение качества по русскому, но это отдельное решение с отдельной проверкой, не часть переноса
- **Починка унаследованных багов из Части I §15** — переносим поведение как есть, чиним отдельно

## 18. Что стоит добавить после запуска

- **Бэкап состояния.** Одна строка в D1 — единственная точка правды по прогрессу. `wrangler d1 export` раз в месяц либо дублирование `current_question` в сообщении Ване
- Починка счётчика частей после `/continue` (Часть I §15, п. 1)
- `setMyCommands` — чтобы в клиенте у мамы был список команд, а не память
