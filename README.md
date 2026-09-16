# 🤖 Бот «Интервью с мамой»

Телеграм-бот, который по одному задаёт маме 222 вопроса о её жизни, принимает
голосовые ответы, расшифровывает их через OpenAI Whisper и сохраняет аудио и
текст на Google Диск. Работает на Cloudflare Workers.

## Что умеет бот

- Задаёт 222 вопроса по очереди, с паузами — сколько угодно, без спешки
- Принимает голосовые ответы (можно несколько на один вопрос — «Ещё не всё»)
- Кроме `voice`, принимает `audio`-файлы и видео-кружки (`video_note`)
- Транскрибирует аудио в текст через OpenAI Whisper
- Сохраняет аудио и текст на Google Диск сразу после получения — файлы
  называются по тексту вопроса, например:
  `001. Какое твоё самое раннее воспоминание из детства.ogg`
- **Присылает Ване уведомление о каждом ответе** — номер вопроса, текст
  вопроса и ссылки на аудио и документ на Диске (саму расшифровку не
  прикладывает — если нужно, смотри по ссылке)
- Напоминает раз в 3 дня, если мама не отвечала
- Реагирует только на маму и Ваню (по Telegram ID), остальным — тишина
- Показывает прогресс (`/status`)
- При сбое (транскрибация, загрузка на Диск, что угодно необработанное)
  пишет Ване, а не молчит

## Команды бота

| Команда | Что делает |
|---------|------------|
| `/start` | Начать интервью (повторный `/start` — «С возвращением», без сброса прогресса) |
| `/continue` | Продолжить с места остановки |
| `/status` | Показать прогресс |
| `/jump N` | Перейти к вопросу номер N |
| `/reset` | Начать сначала (с подтверждением) |

## Как это устроено

Продакшен — на Cloudflare Workers (`src/`, `wrangler.json`, `schema.sql`):

- `src/worker.js` — вебхук от Telegram и часовой крон (напоминания + чистка старых записей)
- `src/bot-handler.js` — команды, голосовые сообщения, кнопки
- `src/state.js` — состояние в Cloudflare D1 (одна строка, атомарные обновления)
- `src/drive.js`, `src/whisper.js`, `src/telegram.js` — интеграции с Google Диском, OpenAI и Telegram
- `src/reminders.js`, `src/admin.js`, `src/pure.js`, `src/questions.js` — напоминания, уведомления Ване, чистые функции, список вопросов

Подробный план миграции и разбор всех решений — в [docs/PLAN.md](docs/PLAN.md)
(Часть II). Там же список известных, осознанно не тронутых мелочей (§15) и
чек-лист ручной проверки перед первым включением (§16).

Старая Python-версия (`bot.py`, деплой на Railway) больше не используется и
оставлена в репозитории только как архив — инструкция по ней в самом низу
этого файла.

## Как обновить и задеплоить бота

Секреты (`TELEGRAM_TOKEN`, `OPENAI_API_KEY`, `GOOGLE_CREDENTIALS_JSON`,
`WEBHOOK_SECRET`) и база D1 уже настроены на стороне Cloudflare — их вводить
заново не нужно, они не хранятся в этом репозитории.

1. Склонируй репозиторий (если делаешь это на новом компьютере):
   ```
   git clone https://github.com/nook2b/mama-bot.git
   cd mama-bot
   ```
   Если репозиторий уже есть локально — просто `git pull`.

2. Установи зависимости (один раз на машине, или после обновления `package.json`):
   ```
   npm install
   ```

3. Залогинься в Cloudflare (один раз на машине — откроется браузер):
   ```
   npx wrangler login
   ```

4. Задеплой:
   ```
   npx wrangler deploy
   ```

Готово — правки применяются сразу, вебхук Telegram уже указывает на этот
воркер и его перерегистрировать не нужно.

Локальный прогон тестов (без сети и без деплоя):
```
npm test
```

---

## Архив: старая Python-версия на Railway

Инструкция ниже относится к `bot.py` — версии бота, которая раньше работала
на Railway. Она не поддерживается, но оставлена как справка.

### Шаг 1. Подготовь данные

Тебе нужно заранее собрать 4 значения:

1. **TELEGRAM_TOKEN** — токен бота от BotFather (тот же, что ты уже используешь)
2. **OPENAI_API_KEY** — ключ API от OpenAI (тот же `sk-...`)
3. **MAMA_CHAT_ID** — Telegram ID мамы (пусть мама напишет боту @userinfobot — он покажет её ID, это число вроде `123456789`)
4. **GOOGLE_FOLDER_ID** — ID папки на Google Диске (открой папку в браузере, ID — это часть URL после `folders/`)

### Шаг 2. Загрузи код на GitHub

1. Зайди на **github.com**, создай аккаунт (если нет)
2. Нажми **«New repository»**, назови `mama-bot`, выбери **Private**
3. Загрузи туда все файлы из папки бота:
   - `bot.py`
   - `questions.json`
   - `requirements.txt`
   - `Dockerfile`
   - `.gitignore`

### Шаг 3. Создай проект на Railway

1. Зайди на **railway.app**, войди через GitHub
2. Нажми **«New Project»** → **«Deploy from GitHub repo»**
3. Выбери репозиторий `mama-bot`
4. Railway начнёт деплой — он пока упадёт, потому что нет переменных окружения

### Шаг 4. Добавь переменные окружения

В Railway открой свой проект → вкладка **Variables** → добавь:

```
TELEGRAM_TOKEN=твой_токен_бота
OPENAI_API_KEY=sk-твой_ключ
MAMA_CHAT_ID=123456789
GOOGLE_FOLDER_ID=id_папки_на_диске
GOOGLE_CREDENTIALS_JSON={"token":"...","refresh_token":"...","client_id":"...","client_secret":"...","token_uri":"https://oauth2.googleapis.com/token"}
```

### Шаг 5. Получи GOOGLE_CREDENTIALS_JSON

Это самый сложный шаг. Нужно получить refresh_token от Google:

1. У тебя уже есть Client ID и Client Secret из Google Cloud Console (ты их создавал для Make)
2. Перейди по ссылке (подставь свой CLIENT_ID):
   ```
   https://accounts.google.com/o/oauth2/v2/auth?client_id=ТВОЙ_CLIENT_ID&redirect_uri=http://localhost&response_type=code&scope=https://www.googleapis.com/auth/drive&access_type=offline&prompt=consent
   ```
3. Авторизуйся, Google перенаправит на `localhost?code=XXXXXX` — скопируй значение `code`
4. Выполни в терминале (или в онлайн-инструменте для HTTP-запросов):
   ```
   curl -X POST https://oauth2.googleapis.com/token \
     -d code=ТВОЙ_CODE \
     -d client_id=ТВОЙ_CLIENT_ID \
     -d client_secret=ТВОЙ_CLIENT_SECRET \
     -d redirect_uri=http://localhost \
     -d grant_type=authorization_code
   ```
5. В ответе будет JSON с `access_token` и `refresh_token`
6. Собери JSON для переменной:
   ```json
   {
     "token": "access_token из ответа",
     "refresh_token": "refresh_token из ответа",
     "client_id": "твой Client ID",
     "client_secret": "твой Client Secret",
     "token_uri": "https://oauth2.googleapis.com/token"
   }
   ```
7. Вставь эту JSON-строку (в одну строку, без переносов) в переменную `GOOGLE_CREDENTIALS_JSON` в Railway

### Шаг 6. Запуск

После добавления всех переменных Railway автоматически перезапустит бот. Проверь логи во вкладке **Deployments** — должно быть `Bot started!`

Попроси маму написать боту `/start` — и всё начнётся!

### Если не хочешь настраивать Google Drive

Бот будет работать и без Google Drive — просто убери переменную `GOOGLE_CREDENTIALS_JSON` и `GOOGLE_FOLDER_ID`. Транскрибация будет работать, но файлы не будут сохраняться на Диск (только локально на сервере).

### Важно: отключи webhook в Make

Если ты раньше использовал этого бота в Make (Watch Updates), нужно отключить тот сценарий в Make, иначе два сервиса будут «перехватывать» сообщения друг у друга. Просто выключи сценарий в Make (тумблер OFF).
