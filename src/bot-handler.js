import { getState, mutateState, incrementPartSeq, DEFAULT_STATE } from './state.js'
import { getQuestionText, getTotalQuestions } from './questions.js'
import { tgApi, getFile, getFileDownloadUrl, downloadFile } from './telegram.js'
import { transcribe } from './whisper.js'
import { uploadAudio, uploadDoc } from './drive.js'
import { notifyVanya } from './admin.js'
import { isAllowed, sanitizeFilename, formatProgressBar, parseCallbackData } from './pure.js'

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

// В callback_data кнопки «Следующий вопрос» зашит индекс вопроса, для
// которого показана клавиатура. Если мама прислала два голосовых подряд,
// на экране две клавиатуры; без индекса второе нажатие «Следующий вопрос»
// продвинуло бы прогресс ещё раз и вопрос остался бы без ответа.
async function sendContinueKeyboard(env, chatId, questionIndex) {
  await tgApi(env, 'sendMessage', {
    chat_id: chatId,
    text: 'Хочешь добавить ещё что-то к этому ответу?',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🎤 Ещё не всё', callback_data: 'more' },
          { text: '➡️ Следующий вопрос', callback_data: `next:${questionIndex}` },
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
    return { fileId: message.voice.file_id, mimeType: 'audio/ogg', fileName: `voice.${ext}`, ext }
  }
  if (message.audio) {
    return {
      fileId: message.audio.file_id,
      mimeType: message.audio.mime_type || `audio/${ext}`,
      fileName: message.audio.file_name || `audio.${ext}`,
      ext, // не из file_name — он может быть без расширения («Запись 3»)
    }
  }
  // video_note — всегда mp4, у Telegram нет mime_type в самом объекте
  return { fileId: message.video_note.file_id, mimeType: 'video/mp4', fileName: `video_note.${ext}`, ext }
}

async function uploadImmediately(env, questionIndex, descriptor, arrayBuffer, text) {
  const questionText = getQuestionText(questionIndex)
  const safe = sanitizeFilename(questionText)
  const prefix = `${String(questionIndex + 1).padStart(3, '0')}. ${safe}`
  const partNum = await incrementPartSeq(env) // атомарно, см. И3
  const suffix = partNum > 1 ? ` (часть ${partNum})` : ''
  const ext = descriptor.ext

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
  const questionIndex = state.current_question

  // getFile отдаёт не больше 20 МБ (лимит Bot API) — длинный аудиофайл
  // или обрыв скачивания раньше уходили в глобальный catch: Ване ошибка,
  // маме — тишина. Теперь маме понятная просьба повторить.
  let descriptor, arrayBuffer
  try {
    const tgFile = await getFile(env, fileId)
    descriptor = resolveAudioDescriptor(message, tgFile)
    arrayBuffer = await downloadFile(getFileDownloadUrl(env, tgFile.file_path))
  } catch (e) {
    await tgApi(env, 'sendMessage', {
      chat_id: message.chat.id,
      text: 'Ой, не получилось скачать запись 😔 Попробуй, пожалуйста, отправить её ещё раз — можно частями покороче.',
    })
    await notifyVanya(env, `🔴 Не удалось скачать файл из Telegram (вопрос ${questionIndex + 1}):\n${e}`)
    return
  }

  await tgApi(env, 'sendMessage', { chat_id: message.chat.id, text: '⏳ Расшифровываю...' })

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
    await sendContinueKeyboard(env, message.chat.id, questionIndex)
    return
  }

  await mutateState(env, (s) => ({ ...s, waiting_for_voice: true, last_activity: Date.now() }))
  await uploadImmediately(env, questionIndex, descriptor, arrayBuffer, text)
  await tgApi(env, 'sendMessage', { chat_id: message.chat.id, text: '✅ Получено!' })
  await sendContinueKeyboard(env, message.chat.id, questionIndex)
}

// ── Кнопки (Часть I §8) ──────────────────────────────────────────────

export async function handleCallback(env, callbackQuery) {
  // Первым делом — безусловный answer, и только потом проверка доступа.
  // Именно в этом порядке в bot.py:490-492, см. docs/PLAN.md §8.
  await tgApi(env, 'answerCallbackQuery', { callback_query_id: callbackQuery.id })
  if (!isAllowed(env, callbackQuery.from?.id)) return

  const chatId = callbackQuery.message.chat.id
  const messageId = callbackQuery.message.message_id

  // Двойной тап по кнопке приходит двумя callback_query с разными update_id,
  // так что идемпотентность в worker.js его не ловит. Первый тап убирает
  // клавиатуру и меняет текст; второй пытается записать тот же текст, и
  // Telegram отвечает «message is not modified». Считаем это признаком
  // повтора: возвращаем false, а не роняем обработчик с тревогой Ване.
  const edit = async (text) => {
    try {
      await tgApi(env, 'editMessageText', { chat_id: chatId, message_id: messageId, text })
      return true
    } catch (e) {
      if (String(e).includes('message is not modified')) return false
      throw e
    }
  }

  const { action, arg } = parseCallbackData(callbackQuery.data)

  switch (action) {
    case 'more':
      await edit('Записывай, я слушаю! 🎤')
      return

    case 'next': {
      // arg — индекс вопроса, для которого была показана клавиатура (см.
      // sendContinueKeyboard). Старые кнопки без индекса (arg === null)
      // работают как раньше.
      const shownFor = arg === null ? null : Number(arg)
      const { value: current } = await getState(env)
      if (shownFor !== null && shownFor !== current.current_question) {
        await edit('✅ Этот вопрос уже пройден')
        return
      }
      if (!(await edit('✅ Идём дальше ❤️'))) return // повторное нажатие
      let advanced = false
      const next = await mutateState(env, (s) => {
        if (shownFor !== null && s.current_question !== shownFor) {
          advanced = false
          return s // кто-то успел продвинуть прогресс между getState и записью
        }
        advanced = true
        return {
          ...s,
          current_question: s.current_question + 1,
          part_seq: 0,
          waiting_for_voice: true,
          last_activity: Date.now(),
        }
      })
      if (advanced) await sendQuestion(env, chatId, next.current_question)
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
      if (!(await edit('Отлично! Продолжаем! 🚀'))) return // повторное нажатие — вопрос уже отправлен
      const next = await mutateState(env, (s) => ({ ...s, waiting_for_voice: true, last_activity: Date.now() }))
      await sendQuestion(env, chatId, next.current_question)
      return
    }

    case 'reminder_later':
      await edit('Хорошо, напомню позже! 😊')
      return
  }
}
