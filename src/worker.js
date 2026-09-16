import { isAllowed } from './pure.js'
import { tgApi } from './telegram.js'
import { handleCommand, handleVoice, handleCallback, handleOther, handleUnauthorized } from './bot-handler.js'
import { checkReminder } from './reminders.js'

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
    ctx.waitUntil(pruneSeenUpdates(env))
  },
}

// seen_updates растёт с каждым апдейтом; Telegram ретраит вебхук не дольше
// суток, так что строки старше недели для идемпотентности уже не нужны.
// Чистим тем же часовым кроном, что и напоминания. См. docs/PLAN.md §7.
const SEEN_UPDATES_TTL_MS = 7 * 24 * 3_600_000

export async function pruneSeenUpdates(env) {
  try {
    await env.DB.prepare('DELETE FROM seen_updates WHERE seen_at < ?')
      .bind(Date.now() - SEEN_UPDATES_TTL_MS)
      .run()
  } catch (e) {
    console.error('pruneSeenUpdates failed:', e)
  }
}

export async function handleBotWebhook(request, env, ctx) {
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
    return new Response('unauthorized', { status: 401 })
  }
  const update = await request.json()

  // Идемпотентность: атомарный INSERT в fetch(), до ctx.waitUntil — не читаем-
  // и-пишем массив id, а полагаемся на UNIQUE PRIMARY KEY. См. docs/PLAN.md §7.
  const { meta } = await env.DB.prepare(
    'INSERT INTO seen_updates (update_id, seen_at) VALUES (?, ?) ON CONFLICT(update_id) DO NOTHING'
  )
    .bind(update.update_id, Date.now())
    .run()

  if (meta.changes === 1) {
    ctx.waitUntil(processUpdate(env, update)) // вся тяжёлая работа — в фоне
  }
  return new Response('ok') // Telegram доволен немедленно, независимо от того, был ли это дубликат
}

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
    // Намеренно НЕ notifyVanya() — она сама оборачивает в «⚠️ Ошибка в боте:»,
    // получился бы двойной префикс. Шлём напрямую, как bot.py:629-637.
    await tgApi(env, 'sendMessage', {
      chat_id: env.VANYA_CHAT_ID,
      text: `🔴 Необработанная ошибка в боте:\n\n${String(e).slice(0, 500)}`,
    })
  }
}
