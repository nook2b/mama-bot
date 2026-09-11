// Чистые функции без внешних зависимостей — намеренно не импортируют ничего,
// в том числе questions.json, чтобы test/pure.test.js бежал под голым
// `node --test` без бандлера. См. docs/PLAN.md §5, §13.

export function isAllowed(env, id) {
  if (id == null) return false
  const allowedIds = new Set([env.MAMA_CHAT_ID, env.VANYA_CHAT_ID].map(String))
  return allowedIds.has(String(id))
}

// Порт sanitize_filename из bot.py:162-171 — порядок операций сохранён как есть.
export function sanitizeFilename(text, maxLength = 80) {
  let safe = text.replaceAll('/', '-').replaceAll('\\', '-').replaceAll(':', '-')
  safe = safe.replaceAll('?', '').replaceAll('«', '').replaceAll('»', '')
  safe = safe.replaceAll('"', '').replaceAll('*', '').replaceAll('<', '').replaceAll('>', '')
  safe = safe.replaceAll('|', '').replaceAll('\n', ' ').trim()
  if (safe.length > maxLength) {
    const cut = safe.slice(0, maxLength)
    const lastSpace = cut.lastIndexOf(' ')
    safe = lastSpace === -1 ? cut : cut.slice(0, lastSpace)
  }
  return safe
}

export function formatProgressBar(current, total) {
  const pct = Math.round((current / total) * 100)
  const filled = Math.round(pct / 5)
  const bar = '█'.repeat(filled) + '░'.repeat(20 - filled)
  return { pct, bar }
}

// callback_data кнопок: `action` или `action:arg` (напр. `next:41` — индекс
// вопроса, для которого была показана клавиатура; см. handleCallback).
export function parseCallbackData(data) {
  if (typeof data !== 'string') return { action: '', arg: null }
  const i = data.indexOf(':')
  if (i === -1) return { action: data, arg: null }
  return { action: data.slice(0, i), arg: data.slice(i + 1) }
}
