import { tgApi } from './telegram.js'

// Три места вызова: ошибка транскрибации, ошибка аплоада аудио, ошибка
// аплоада текста — см. docs/PLAN.md §12. Глобальный catch в worker.js
// НЕ использует notifyVanya (иначе двойной префикс) — шлёт tgApi напрямую.
export async function notifyVanya(env, text) {
  try {
    await tgApi(env, 'sendMessage', {
      chat_id: env.VANYA_CHAT_ID,
      text: `⚠️ Ошибка в боте:\n\n${text.slice(0, 500)}`,
    })
  } catch {
    // нет смысла эскалировать ошибку самой эскалации
  }
}
