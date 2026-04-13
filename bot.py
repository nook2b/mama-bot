"""
Telegram-бот «Интервью с мамой»
================================
Задаёт 222 вопроса по очереди, принимает голосовые ответы,
транскрибирует через OpenAI, сохраняет аудио + текст на Google Диск.
Напоминает раз в 3 дня, если мама не отвечала.
Реагирует только на одного пользователя (MAMA_CHAT_ID).
"""

import os
import json
import logging
import asyncio
from datetime import datetime, timezone
from pathlib import Path

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    filters,
    ContextTypes,
)
from openai import OpenAI
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload, MediaIoBaseUpload
import io

# ── Настройки (из переменных окружения) ──────────────────────────
TELEGRAM_TOKEN = os.environ["TELEGRAM_TOKEN"]
OPENAI_API_KEY = os.environ["OPENAI_API_KEY"]
MAMA_CHAT_ID = int(os.environ.get("MAMA_CHAT_ID", "1219919762"))
VANYA_CHAT_ID = int(os.environ.get("VANYA_CHAT_ID", "411340432"))
ALLOWED_USERS = {MAMA_CHAT_ID, VANYA_CHAT_ID}
GOOGLE_AUDIO_FOLDER_ID = os.environ.get("GOOGLE_AUDIO_FOLDER_ID", "")
GOOGLE_TEXT_FOLDER_ID = os.environ.get("GOOGLE_TEXT_FOLDER_ID", "")

# Google OAuth credentials (JSON строка из переменной окружения)
GOOGLE_CREDENTIALS_JSON = os.environ.get("GOOGLE_CREDENTIALS_JSON", "")

REMINDER_INTERVAL_HOURS = 72  # 3 дня

# ── Логирование ──────────────────────────────────────────────────
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# ── Загрузка вопросов ────────────────────────────────────────────
QUESTIONS_FILE = Path(__file__).parent / "questions.json"
with open(QUESTIONS_FILE, "r", encoding="utf-8") as f:
    QUESTIONS = json.load(f)

TOTAL_QUESTIONS = len(QUESTIONS)

# ── Состояние (хранится в файле для персистентности) ─────────────
STATE_FILE = Path(__file__).parent / "state.json"


def load_state() -> dict:
    """Загружает состояние из файла."""
    if STATE_FILE.exists():
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {
        "current_question": 0,
        "waiting_for_voice": False,
        "voice_parts": [],  # список путей к аудио-частям текущего вопроса
        "text_parts": [],   # список транскрибаций частей
        "last_activity": None,
        "started": False,
    }


def save_state(state: dict):
    """Сохраняет состояние в файл."""
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


# ── OpenAI клиент ────────────────────────────────────────────────
openai_client = OpenAI(api_key=OPENAI_API_KEY)


# ── Google Drive ─────────────────────────────────────────────────
def get_drive_service():
    """Создаёт сервис Google Drive API."""
    if not GOOGLE_CREDENTIALS_JSON:
        logger.warning("Google credentials not configured, skipping Drive upload")
        return None
    
    creds_data = json.loads(GOOGLE_CREDENTIALS_JSON)
    creds = Credentials(
        token=creds_data.get("token"),
        refresh_token=creds_data.get("refresh_token"),
        token_uri=creds_data.get("token_uri", "https://oauth2.googleapis.com/token"),
        client_id=creds_data.get("client_id"),
        client_secret=creds_data.get("client_secret"),
    )
    
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        # Обновляем сохранённые credentials
        creds_data["token"] = creds.token
        os.environ["GOOGLE_CREDENTIALS_JSON"] = json.dumps(creds_data)
    
    return build("drive", "v3", credentials=creds)


def upload_to_drive(file_path: str, filename: str, mime_type: str, folder_id: str = None):
    """Загружает файл на Google Диск."""
    service = get_drive_service()
    if not service:
        logger.info(f"Drive not configured, skipping upload of {filename}")
        return None

    file_metadata = {"name": filename}
    if folder_id:
        file_metadata["parents"] = [folder_id]
    
    media = MediaFileUpload(file_path, mimetype=mime_type)
    file = service.files().create(
        body=file_metadata, media_body=media, fields="id"
    ).execute()
    
    logger.info(f"Uploaded to Drive: {filename} (id: {file.get('id')})")
    return file.get("id")


def upload_text_to_drive(text: str, filename: str, folder_id: str = None):
    """Загружает текст как Google Doc на Диск."""
    service = get_drive_service()
    if not service:
        logger.info(f"Drive not configured, skipping upload of {filename}")
        return None

    file_metadata = {
        "name": filename,
        "mimeType": "application/vnd.google-apps.document",
    }
    if folder_id:
        file_metadata["parents"] = [folder_id]
    
    media = MediaIoBaseUpload(
        io.BytesIO(text.encode("utf-8")),
        mimetype="text/plain",
    )
    file = service.files().create(
        body=file_metadata, media_body=media, fields="id"
    ).execute()
    
    logger.info(f"Uploaded text to Drive: {filename} (id: {file.get('id')})")
    return file.get("id")


# ── Helpers ──────────────────────────────────────────────────────
def sanitize_filename(text: str, max_length: int = 80) -> str:
    """Делает безопасное имя файла из текста вопроса."""
    # Убираем спецсимволы
    safe = text.replace("/", "-").replace("\\", "-").replace(":", "-")
    safe = safe.replace("?", "").replace("«", "").replace("»", "")
    safe = safe.replace('"', "").replace("*", "").replace("<", "").replace(">", "")
    safe = safe.replace("|", "").replace("\n", " ").strip()
    if len(safe) > max_length:
        safe = safe[:max_length].rsplit(" ", 1)[0]
    return safe


def is_allowed(user_id: int) -> bool:
    """Проверяет, что сообщение от мамы или Вани."""
    return user_id in ALLOWED_USERS


async def notify_vanya(context: ContextTypes.DEFAULT_TYPE, error_text: str):
    """Отправляет Ване уведомление об ошибке в Telegram."""
    try:
        await context.bot.send_message(
            chat_id=VANYA_CHAT_ID,
            text=f"⚠️ Ошибка в боте:\n\n{error_text[:500]}",
        )
    except Exception:
        logger.error(f"Failed to notify Vanya about error: {error_text}")


def get_question_text(index: int) -> str:
    """Возвращает текст вопроса по индексу."""
    if 0 <= index < TOTAL_QUESTIONS:
        return QUESTIONS[index]
    return None


async def send_question(context: ContextTypes.DEFAULT_TYPE, chat_id: int, question_idx: int):
    """Отправляет вопрос маме."""
    question = get_question_text(question_idx)
    if question is None:
        await context.bot.send_message(
            chat_id=chat_id,
            text=(
                "🎉 Мама, все 222 вопроса пройдены!\n\n"
                "Спасибо тебе огромное за каждый ответ, за каждую историю, "
                "за каждое воспоминание. Это самый ценный подарок, который ты могла мне дать.\n\n"
                "Теперь эти истории останутся в нашей семье навсегда. ❤️\n\n"
                "С любовью и благодарностью, Ваня"
            ),
        )
        return

    progress = f"📋 Вопрос {question_idx + 1} из {TOTAL_QUESTIONS}\n\n"
    await context.bot.send_message(
        chat_id=chat_id,
        text=f"{progress}❓ {question}\n\n🎤 Запиши голосовое сообщение с ответом.",
    )


async def send_continue_keyboard(context: ContextTypes.DEFAULT_TYPE, chat_id: int):
    """Отправляет кнопки «ещё не всё» / «следующий вопрос»."""
    keyboard = [
        [
            InlineKeyboardButton("🎤 Ещё не всё", callback_data="more"),
            InlineKeyboardButton("➡️ Следующий вопрос", callback_data="next"),
        ]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    await context.bot.send_message(
        chat_id=chat_id,
        text="Хочешь добавить ещё что-то к этому ответу?",
        reply_markup=reply_markup,
    )


async def transcribe_audio(file_path: str) -> str:
    """Транскрибирует аудио через OpenAI."""
    with open(file_path, "rb") as audio_file:
        transcript = openai_client.audio.transcriptions.create(
            model="whisper-1",
            file=audio_file,
            language="ru",
            prompt="Транскрибация голосового сообщения на русском языке",
        )
    return transcript.text


async def save_answer(state: dict, question_idx: int):
    """Сохраняет ответ (аудио + текст) на Google Диск."""
    question_text = get_question_text(question_idx)
    safe_name = sanitize_filename(question_text)
    prefix = f"{question_idx + 1:03d}. {safe_name}"

    # Объединяем все текстовые части
    full_text = "\n\n".join(state["text_parts"])

    # Загружаем текст на Google Диск
    text_filename = f"{prefix}"
    try:
        upload_text_to_drive(
            text=f"Вопрос: {question_text}\n\nОтвет:\n{full_text}",
            filename=text_filename,
            folder_id=GOOGLE_TEXT_FOLDER_ID or None,
        )
    except Exception as e:
        logger.error(f"Failed to upload text to Drive: {e}")

    # Загружаем аудио-части на Google Диск
    for i, voice_path in enumerate(state["voice_parts"]):
        part_suffix = f" (часть {i+1})" if len(state["voice_parts"]) > 1 else ""
        audio_filename = f"{prefix}{part_suffix}.ogg"
        try:
            upload_to_drive(
                file_path=voice_path,
                filename=audio_filename,
                mime_type="audio/ogg",
                folder_id=GOOGLE_AUDIO_FOLDER_ID or None,
            )
        except Exception as e:
            logger.error(f"Failed to upload audio to Drive: {e}")

    # Удаляем временные файлы
    for voice_path in state["voice_parts"]:
        try:
            os.remove(voice_path)
        except OSError:
            pass


# ── Обработчики команд ──────────────────────────────────────────
async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик /start."""
    if not is_allowed(update.effective_user.id):
        await update.message.reply_text(
            "Извините, этот бот создан для конкретного человека. 🤗"
        )
        return

    state = load_state()
    
    if state["started"] and state["current_question"] > 0:
        await update.message.reply_text(
            f"👋 С возвращением! Вы остановились на вопросе {state['current_question'] + 1} из {TOTAL_QUESTIONS}.\n\n"
            "Нажмите /continue чтобы продолжить, или /reset чтобы начать сначала."
        )
        return

    state["started"] = True
    state["current_question"] = 0
    state["waiting_for_voice"] = True
    state["voice_parts"] = []
    state["text_parts"] = []
    state["last_activity"] = datetime.now(timezone.utc).isoformat()
    save_state(state)

    await update.message.reply_text(
        "Привет, мама! ❤️\n\n"
        "Это бот, который я сделал специально для тебя. "
        "Я хочу сохранить твои истории, воспоминания и мудрость — "
        "чтобы они остались в нашей семье навсегда.\n\n"
        "Бот будет задавать тебе вопросы — по одному за раз. "
        "Всё что нужно — записать голосовое сообщение с ответом. "
        "Не торопись, отвечай как чувствуешь.\n\n"
        "Можно отправить несколько голосовых на один вопрос, "
        "если хочешь рассказать подробнее.\n\n"
        "Всего вопросов 222, но нет никакой спешки. "
        "Хоть по одному в неделю. Главное — твои истории.\n\n"
        "С любовью, Ваня ❤️"
    )

    await asyncio.sleep(3)  # Пауза, чтобы мама успела прочитать приветствие

    await send_question(context, update.effective_chat.id, 0)


async def continue_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик /continue — продолжить с места остановки."""
    if not is_allowed(update.effective_user.id):
        return

    state = load_state()
    state["waiting_for_voice"] = True
    state["voice_parts"] = []
    state["text_parts"] = []
    state["last_activity"] = datetime.now(timezone.utc).isoformat()
    save_state(state)

    await send_question(context, update.effective_chat.id, state["current_question"])


async def reset_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик /reset — начать сначала."""
    if not is_allowed(update.effective_user.id):
        return

    keyboard = [
        [
            InlineKeyboardButton("Да, начать сначала", callback_data="confirm_reset"),
            InlineKeyboardButton("Нет, продолжить", callback_data="cancel_reset"),
        ]
    ]
    await update.message.reply_text(
        f"⚠️ Вы уверены? Прогресс будет сброшен (уже сохранённые файлы на Диске останутся).",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )


async def status_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик /status — показать прогресс."""
    if not is_allowed(update.effective_user.id):
        return

    state = load_state()
    q = state["current_question"]
    pct = round(q / TOTAL_QUESTIONS * 100)
    bar_filled = round(pct / 5)
    bar = "█" * bar_filled + "░" * (20 - bar_filled)

    await update.message.reply_text(
        f"📊 Прогресс:\n\n"
        f"{bar} {pct}%\n"
        f"Пройдено: {q} из {TOTAL_QUESTIONS} вопросов\n"
        f"Осталось: {TOTAL_QUESTIONS - q}"
    )


async def jump_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик /jump N — перейти к вопросу N."""
    if not is_allowed(update.effective_user.id):
        return

    if not context.args or not context.args[0].isdigit():
        await update.message.reply_text(
            "Укажите номер вопроса. Например: /jump 45"
        )
        return

    target = int(context.args[0])
    if target < 1 or target > TOTAL_QUESTIONS:
        await update.message.reply_text(
            f"Номер должен быть от 1 до {TOTAL_QUESTIONS}."
        )
        return

    state = load_state()
    state["current_question"] = target - 1  # внутри индексация с 0
    state["waiting_for_voice"] = True
    state["voice_parts"] = []
    state["text_parts"] = []
    state["last_activity"] = datetime.now(timezone.utc).isoformat()
    state["started"] = True
    save_state(state)

    await update.message.reply_text(f"⏭ Переходим к вопросу {target}!")
    await send_question(context, update.effective_chat.id, target - 1)


# ── Обработчик голосовых сообщений ──────────────────────────────
async def handle_voice(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Принимает голосовое сообщение."""
    if not is_allowed(update.effective_user.id):
        return

    state = load_state()

    if not state.get("waiting_for_voice"):
        await update.message.reply_text(
            "Нажми /continue чтобы продолжить отвечать на вопросы."
        )
        return

    # Скачиваем голосовое
    voice = update.message.voice
    file = await context.bot.get_file(voice.file_id)

    # Сохраняем временно
    tmp_dir = Path(__file__).parent / "tmp"
    tmp_dir.mkdir(exist_ok=True)
    
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    voice_path = str(tmp_dir / f"voice_{timestamp}.ogg")
    await file.download_to_drive(voice_path)

    # Транскрибируем
    await update.message.reply_text("⏳ Расшифровываю...")

    try:
        text = await transcribe_audio(voice_path)
    except Exception as e:
        logger.error(f"Transcription failed: {e}")
        
        # Аудио всё равно сохраняем — оно уже скачано
        state["voice_parts"].append(voice_path)
        state["text_parts"].append("[Транскрибация не удалась]")
        state["last_activity"] = datetime.now(timezone.utc).isoformat()
        save_state(state)
        
        await update.message.reply_text(
            "Ой, что-то пошло не так с расшифровкой 😔 Но голосовое я сохранил! Не переживай, Ваня разберётся."
        )
        await notify_vanya(context, f"🔴 Ошибка транскрибации (вопрос {state['current_question'] + 1}):\n{e}\n\nАудио сохранено, но текст не расшифрован. Нужно разобраться!")
        await send_continue_keyboard(context, update.effective_chat.id)
        return

    # Сохраняем в состояние
    state["voice_parts"].append(voice_path)
    state["text_parts"].append(text)
    state["last_activity"] = datetime.now(timezone.utc).isoformat()
    save_state(state)

    # Показываем кнопки
    await update.message.reply_text("✅ Получено!")
    await send_continue_keyboard(context, update.effective_chat.id)


# ── Обработчик кнопок ────────────────────────────────────────────
async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик нажатий на inline-кнопки."""
    query = update.callback_query
    await query.answer()

    if not is_allowed(query.from_user.id):
        return

    state = load_state()

    if query.data == "more":
        # Мама хочет добавить ещё
        await query.edit_message_text("Записывай, я слушаю! 🎤")

    elif query.data == "next":
        # Сохраняем ответ и переходим к следующему вопросу
        await query.edit_message_text("💾 Сохраняю...")

        if state["voice_parts"]:
            try:
                await save_answer(state, state["current_question"])
                await context.bot.send_message(
                    chat_id=query.message.chat_id,
                    text="✅ Сохранено! Идём дальше ❤️",
                )
            except Exception as e:
                logger.error(f"Save failed: {e}")
                await context.bot.send_message(
                    chat_id=query.message.chat_id,
                    text="Ой, что-то пошло не так с сохранением 😔 Не переживай, я уже написал Ване — он разберётся!",
                )
                await notify_vanya(context, f"Ошибка сохранения на Google Диск (вопрос {state['current_question'] + 1}):\n{e}")

        # Переходим к следующему
        state["current_question"] += 1
        state["voice_parts"] = []
        state["text_parts"] = []
        state["waiting_for_voice"] = True
        state["last_activity"] = datetime.now(timezone.utc).isoformat()
        save_state(state)

        await send_question(context, query.message.chat_id, state["current_question"])

    elif query.data == "confirm_reset":
        state = {
            "current_question": 0,
            "waiting_for_voice": True,
            "voice_parts": [],
            "text_parts": [],
            "last_activity": datetime.now(timezone.utc).isoformat(),
            "started": True,
        }
        save_state(state)
        await query.edit_message_text("🔄 Начинаем сначала!")
        await send_question(context, query.message.chat_id, 0)

    elif query.data == "cancel_reset":
        await query.edit_message_text("👍 Продолжаем с того же места!")

    elif query.data == "reminder_continue":
        state["waiting_for_voice"] = True
        state["last_activity"] = datetime.now(timezone.utc).isoformat()
        save_state(state)
        await query.edit_message_text("Отлично! Продолжаем! 🚀")
        await send_question(context, query.message.chat_id, state["current_question"])

    elif query.data == "reminder_later":
        await query.edit_message_text("Хорошо, напомню позже! 😊")


# ── Напоминания ──────────────────────────────────────────────────
async def check_reminder(context: ContextTypes.DEFAULT_TYPE):
    """Проверяет, нужно ли отправить напоминание."""
    state = load_state()

    if not state.get("started"):
        return

    if state["current_question"] >= TOTAL_QUESTIONS:
        return  # Все вопросы пройдены

    last = state.get("last_activity")
    if not last:
        return

    last_dt = datetime.fromisoformat(last)
    now = datetime.now(timezone.utc)
    hours_passed = (now - last_dt).total_seconds() / 3600

    if hours_passed >= REMINDER_INTERVAL_HOURS:
        keyboard = [
            [
                InlineKeyboardButton("Давай продолжим! ❤️", callback_data="reminder_continue"),
                InlineKeyboardButton("Попозже", callback_data="reminder_later"),
            ]
        ]
        try:
            await context.bot.send_message(
                chat_id=MAMA_CHAT_ID,
                text=(
                    f"Мам, привет! 😊 Ты остановилась на вопросе {state['current_question'] + 1} из {TOTAL_QUESTIONS}. "
                    "Продолжим, когда будет настроение?"
                ),
                reply_markup=InlineKeyboardMarkup(keyboard),
            )
            # Обновляем last_activity чтобы не спамить
            state["last_activity"] = now.isoformat()
            save_state(state)
        except Exception as e:
            logger.error(f"Failed to send reminder: {e}")


# ── Обработка непонятных сообщений ──────────────────────────────
async def handle_other(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик для текстовых и прочих сообщений."""
    if not is_allowed(update.effective_user.id):
        return

    state = load_state()
    if state.get("waiting_for_voice"):
        await update.message.reply_text(
            "🎤 Запиши голосовое сообщение!\n\n"
            "Зажми иконку микрофона и запиши свой ответ."
        )
    else:
        await update.message.reply_text(
            "Нажми /continue чтобы продолжить отвечать на вопросы.\n"
            "Или /status чтобы посмотреть прогресс."
        )


# ── Главная функция ──────────────────────────────────────────────
def main():
    """Запуск бота."""
    app = Application.builder().token(TELEGRAM_TOKEN).build()

    # Команды
    app.add_handler(CommandHandler("start", start_command))
    app.add_handler(CommandHandler("continue", continue_command))
    app.add_handler(CommandHandler("reset", reset_command))
    app.add_handler(CommandHandler("status", status_command))
    app.add_handler(CommandHandler("jump", jump_command))

    # Голосовые сообщения
    app.add_handler(MessageHandler(filters.VOICE, handle_voice))

    # Кнопки
    app.add_handler(CallbackQueryHandler(handle_callback))

    # Всё остальное
    app.add_handler(MessageHandler(filters.ALL & ~filters.COMMAND & ~filters.VOICE, handle_other))

    # Напоминания — проверяем каждый час
    job_queue = app.job_queue
    job_queue.run_repeating(check_reminder, interval=3600, first=60)

    # Глобальный обработчик ошибок — уведомляет Ваню
    async def error_handler(update: object, context: ContextTypes.DEFAULT_TYPE):
        logger.error(f"Unhandled exception: {context.error}")
        try:
            await context.bot.send_message(
                chat_id=VANYA_CHAT_ID,
                text=f"🔴 Необработанная ошибка в боте:\n\n{str(context.error)[:500]}",
            )
        except Exception:
            pass

    app.add_error_handler(error_handler)

    logger.info("Bot started!")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
