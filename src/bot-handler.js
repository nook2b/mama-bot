import { getState, mutateState, incrementPartSeq, DEFAULT_STATE } from './state.js'
import { getQuestionText, getTotalQuestions } from './questions.js'
import { tgApi, getFile, getFileDownloadUrl, downloadFile } from './telegram.js'
import { transcribe } from './whisper.js'
import { uploadAudio, uploadDoc } from './drive.js'
import { notifyVanya } from './admin.js'
import { isAllowed, sanitizeFilename, formatProgressBar } from './pure.js'

// ── Вспомогательные отправки (docs/PLAN.md, Часть I §7) ────────────────

export async function sendQuestion(env, chatId, idx) {
  const question = getQuestionText(idx)
  if (question === null) {
    await tgApi(env, 'sendMessage', {
      chat_id: chatId,
      text:
        '🎉 Мама, все 222 вопроса пройдены!\n\n' +
        'Спасибо тебе огромное за каждый ответ, за каждую историю, за каждое воспоминание. ' +
        'Это самый ценный подарок, который ты могла мне дать.\n\n' +
        'Теперь эти истории останутся в нашей семье навсегда. ❤️\n\n' +
        'С любовью и благодарностью, Ваня',
    })
    return
  }
  await tgApi(env, 'sendMessage', {
    chat_id: chatId,
    text: `📋 Вопрос ${idx + 1} из ${getTotalQuestions()}\n\n❓ ${question}\n\n🎤 Запиши голосовое сообщение с ответом.`,
  })
}

async function sendContinueKeyboard(env, chatId) {
  await tgApi(env, 'sendMessage', {
    chat_id: chatId,
    text: 'Хочешь добавить ещё что-то к этому ответу?',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🎤 Ещё не всё', callback_data: 'more' },
          { text: '➡️ Следующий вопрос', callback_data: 'next' },
        ],
      ],
    },
  })
}

// ── Команды (docs/PLAN.md, Часть I §5) ──────────────────────────────────

export async function handleCommand(env, message) {
  const chatId = message.chat.id
  const [rawCmd, ...args] = message.text.trim().split(/\s+/)
  const command = rawCmd.split('@')[0] // отрезать @botname, напр. /jump@mama_bot 50

  switch (command) {
    case '/start':
      return handleStart(env, chatId)
    case '/continue':
      return handleContinue(env, chatId)
    case '/reset':
      return handleReset(env, chatId)
    case '/status':
      return handleStatus(env, chatId)
    case '/jump':
      return handleJump(env, chatId, args)
    default:
      return // неизвестная команда — молчание, как в bot.py (filters.ALL & ~filters.COMMAND)
  }
}

async function handleStart(env, chatId) {
  const { value: state } = await getState(env)

  if (state.started && state.current_question > 0) {
    await tgApi(env, 'sendMessage', {
      chat_id: chatId,
      text:
        `👋 С возвращением! Вы остановились на вопросе ${state.current_question + 1} из ${getTotalQuestions()}.\n\n` +
        'Нажмите /continue чтобы продолжить, или /reset чтобы начать сначала.',
    })
    return
  }

  await mutateState(env, () => ({
    ...DEFAULT_STATE,
    started: true,
    waiting_for_voice: true,
    last_activity: Date.now(),
  }))

  await tgApi(env, 'sendMessage', {
    chat_id: chatId,
    text:
      'Привет, мама! ❤️\n\n' +
      'Это бот, который я сделал специально для тебя. Я хочу сохранить твои истории, ' +
      'воспоминания и мудрость — чтобы они остались в нашей семье навсегда.\n\n' +
      'Бот будет задавать тебе вопросы — по одному за раз. Всё что нужно — записать голосовое ' +
      'сообщение с ответом. Не торопись, отвечай как чувствуешь.\n\n' +
      'Можно отправить несколько голосовых на один вопрос, если хочешь рассказать подробнее.\n\n' +
      'Всего вопросов 222, но нет никакой спешки. Хоть по одному в неделю. Главное — твои истории.\n\n' +
      'С любовью, Ваня ❤️',
  })

  await new Promise((resolve) => setTimeout(resolve, 3000))
  await sendQuestion(env, chatId, 0)
}

async function handleContinue(env, chatId) {
  const next = await mutateState(env, (s) => ({
    ...s,
    waiting_for_voice: true,
    part_seq: 0,
    last_activity: Date.now(),
  }))
  await sendQuestion(env, chatId, next.current_question)
}

async function handleReset(env, chatId) {
  await tgApi(env, 'sendMessage', {
    chat_id: chatId,
    text: '⚠️ Вы уверены? Прогресс будет сброшен (уже сохранённые файлы на Диске останутся).',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Да, начать сначала', callback_data: 'confirm_reset' },
          { text: 'Нет, продолжить', callback_data: 'cancel_reset' },
        ],
      ],
    },
  })
}

async function handleStatus(env, chatId) {
  const { value: state } = await getState(env)
  const total = getTotalQuestions()
  const { pct, bar } = formatProgressBar(state.current_question, total)
  await tgApi(env, 'sendMessage', {
    chat_id: chatId,
    text: `📊 Прогресс:\n\n${bar} ${pct}%\nПройдено: ${state.current_question} из ${total} вопросов\nОсталось: ${total - state.current_question}`,
  })
}

async function handleJump(env, chatId, args) {
  const total = getTotalQuestions()
  const arg = args[0]
  if (!arg || !/^\d+$/.test(arg)) {
    await tgApi(env, 'sendMessage', { chat_id: chatId, text: 'Укажите номер вопроса. Например: /jump 45' })
    return
  }
  const target = Number(arg)
  if (target < 1 || target > total) {
    await tgApi(env, 'sendMessage', { chat_id: chatId, text: `Номер должен быть от 1 до ${total}.` })
    return
  }
  await mutateState(env, (s) => ({
    ...s,
    current_question: target - 1,
    waiting_for_voice: true,
    part_seq: 0,
    started: true,
    last_activity: Date.now(),
  }))
  await tgApi(env, 'sendMessage', { chat_id: chatId, text: `⏭ Переходим к вопросу ${target}!` })
  await sendQuestion(env, chatId, target - 1)
}

// ── Неавторизованные и «прочие» сообщения (Часть I §2, §11) ────────────

export async function handleUnauthorized(env, message) {
  if (message.text?.startsWith('/start')) {
    await tgApi(env, 'sendMessage', {
      chat_id: message.chat.id,
      text: 'Извините, этот бот создан для конкретного человека. 🤗',
    })
  }
  // иначе — полное молчание
}

export async function handleOther(env, message) {
  const { value: state } = await getState(env)
  if (state.waiting_for_voice) {
    await tgApi(env, 'sendMessage', {
      chat_id: message.chat.id,
      text: '🎤 Запиши голосовое сообщение!\n\nЗажми иконку микрофона и запиши свой ответ.',
    })
  } else {
    await tgApi(env, 'sendMessage', {
      chat_id: message.chat.id,
      text: 'Нажми /continue чтобы продолжить отвечать на вопросы.\nИли /status чтобы посмотреть прогресс.',
    })
  }
}

// ── Голосовые/аудио/кружки (Часть I §6, Часть II §8-9) ──────────────────

// Расширение всегда берём из file_path (getFile) — это реальный формат
// байтов на серверах Telegram; mime_type/file_name из самого сообщения
// могут отсутствовать (у video_note их нет вовсе). См. docs/PLAN.md §8.
function resolveAudioDescriptor(message, tgFile) {
  const ext = tgFile.file_path.split('.').pop()
  if (message.voice) {
    return { fileId: message.voice.file_id, mimeType: 'audio/ogg', fileName: `voice.${ext}` }
  }
  if (message.audio) {
    return {
      fileId: message.audio.file_id,
      mimeType: message.audio.mime_type || `audio/${ext}`,
      fileName: message.audio.file_name || `audio.${ext}`,
    }
  }
  // video_note — всегда mp4, у Telegram нет mime_type в самом объекте
  return { fileId: message.video_note.file_id, mimeType: 'video/mp4', fileName: `video_note.${ext}` }
}

async function uploadImmediately(env, questionIndex, descriptor, arrayBuffer, text) {
  const questionText = getQuestionText(questionIndex)
  const safe = sanitizeFilename(questionText)
  const prefix = `${String(questionIndex + 1).padStart(3, '0')}. ${safe}`
  const partNum = await incrementPartSeq(env) // атомарно, см. И3
  const suffix = partNum > 1 ? ` (часть ${partNum})` : ''
  const ext = descriptor.fileName.split('.').pop()

  try {
    await uploadAudio(
      env,
      `${prefix}${suffix}.${ext}`,
      arrayBuffer,
      descriptor.mimeType,
      env.GOOGLE_AUDIO_FOLDER_ID || undefined
    )
  } catch (e) {
    await env.DB.prepare(
      'INSERT INTO failed_uploads (file_id, question_index, error, created_at) VALUES (?, ?, ?, ?)'
    )
      .bind(descriptor.fileId, questionIndex, String(e), Date.now())
      .run()
    await notifyVanya(
      env,
      `Ошибка загрузки аудио на Диск (вопрос ${questionIndex + 1}):\n${e}\n\n` +
        `Не потеряно: file_id для повторной попытки — ${descriptor.fileId}`
    )
  }

  try {
    await uploadDoc(
      env,
      `${prefix}${suffix}`,
      `Вопрос: ${questionText}\n\nОтвет:\n${text}`,
      env.GOOGLE_TEXT_FOLDER_ID || undefined
    )
  } catch (e) {
    await notifyVanya(env, `Ошибка загрузки текста на Диск (вопрос ${questionIndex + 1}):\n${e}`)
  }
}

export async function handleVoice(env, message) {
  const { value: state } = await getState(env)

  if (!state.started) {
    await tgApi(env, 'sendMessage', { chat_id: message.chat.id, text: 'Напиши /start чтобы начать!' })
    return
  }

  // Шаг 0.5 — автоактивация: бот не отказывает, а молча включает приём
  if (!state.waiting_for_voice) {
    await mutateState(env, (s) => ({ ...s, waiting_for_voice: true }))
  }

  const fileId = message.voice?.file_id ?? message.audio?.file_id ?? message.video_note?.file_id
  const tgFile = await getFile(env, fileId)
  const descriptor = resolveAudioDescriptor(message, tgFile)
  const arrayBuffer = await downloadFile(getFileDownloadUrl(env, tgFile.file_path))

  await tgApi(env, 'sendMessage', { chat_id: message.chat.id, text: '⏳ Расшифровываю...' })

  const questionIndex = state.current_question

  let text
  try {
    text = await transcribe(env, arrayBuffer, descriptor)
  } catch (e) {
    await mutateState(env, (s) => ({ ...s, waiting_for_voice: true, last_activity: Date.now() }))
    await uploadImmediately(env, questionIndex, descriptor, arrayBuffer, '[Транскрибация не удалась]')
    await tgApi(env, 'sendMessage', {
      chat_id: message.chat.id,
      text: 'Ой, что-то пошло не так с расшифровкой 😔 Но голосовое я сохранил! Не переживай, Ваня разберётся.',
    })
    await notifyVanya(
      env,
      `🔴 Ошибка транскрибации (вопрос ${questionIndex + 1}):\n${e}\n\n` +
        'Аудио сохранено, но текст не расшифрован. Нужно разобраться!'
    )
    await sendContinueKeyboard(env, message.chat.id)
    return
  }

  await mutateState(env, (s) => ({ ...s, waiting_for_voice: true, last_activity: Date.now() }))
  await uploadImmediately(env, questionIndex, descriptor, arrayBuffer, text)
  await tgApi(env, 'sendMessage', { chat_id: message.chat.id, text: '✅ Получено!' })
  await sendContinueKeyboard(env, message.chat.id)
}

// ── Кнопки (Часть I §8) ──────────────────────────────────────────────

export async function handleCallback(env, callbackQuery) {
  // Первым делом — безусловный answer, и только потом проверка доступа.
  // Именно в этом порядке в bot.py:490-492, см. docs/PLAN.md §8.
  await tgApi(env, 'answerCallbackQuery', { callback_query_id: callbackQuery.id })
  if (!isAllowed(env, callbackQuery.from?.id)) return

  const chatId = callbackQuery.message.chat.id
  const messageId = callbackQuery.message.message_id
  const edit = (text) => tgApi(env, 'editMessageText', { chat_id: chatId, message_id: messageId, text })

  switch (callbackQuery.data) {
    case 'more':
      await edit('Записывай, я слушаю! 🎤')
      return

    case 'next': {
      await edit('✅ Идём дальше ❤️')
      const next = await mutateState(env, (s) => ({
        ...s,
        current_question: s.current_question + 1,
        part_seq: 0,
        waiting_for_voice: true,
        last_activity: Date.now(),
      }))
      await sendQuestion(env, chatId, next.current_question)
      return
    }

    case 'confirm_reset': {
      await edit('🔄 Начинаем сначала!')
      await mutateState(env, () => ({
        ...DEFAULT_STATE,
        started: true,
        waiting_for_voice: true,
        last_activity: Date.now(),
      }))
      await sendQuestion(env, chatId, 0)
      return
    }

    case 'cancel_reset':
      await edit('👍 Продолжаем с того же места!')
      return

    case 'reminder_continue': {
      const next = await mutateState(env, (s) => ({ ...s, waiting_for_voice: true, last_activity: Date.now() }))
      await edit('Отлично! Продолжаем! 🚀')
      await sendQuestion(env, chatId, next.current_question)
      return
    }

    case 'reminder_later':
      await edit('Хорошо, напомню позже! 😊')
      return
  }
}
