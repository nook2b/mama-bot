import { tgApi } from './telegram.js'

// Три места вызова: ошибка транскрибации, ошибка аплоада аудио, ошибка
// аплоада текста — см. docs/PLAN.md §12. Глобальный catch в worker.js
// НЕ использует notifyVanya (иначе двойной префикс) — шлёт tgApi напрямую.
export async function notifyVanya(env, text) {
  await sendToVanya(env, `⚠️ Ошибка в боте:\n\n${text.slice(0, 500)}`)
}

// Информационное сообщение Ване без префикса ошибки — например, уведомление
// о новом ответе мамы. Ошибка отправки не должна ломать сценарий мамы.
export async function sendToVanya(env, text) {
  try {
    await tgApi(env, 'sendMessage', {
      chat_id: env.VANYA_CHAT_ID,
      text,
      disable_web_page_preview: true,
    })
  } catch {
    // нет смысла эскалировать ошибку самой эскалации
  }
}
