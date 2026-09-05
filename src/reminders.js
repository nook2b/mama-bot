import { getState, mutateState } from './state.js'
import { getTotalQuestions } from './questions.js'
import { tgApi } from './telegram.js'

export async function checkReminder(env) {
  const { value: state } = await getState(env)
  if (!state.started) return
  if (state.current_question >= getTotalQuestions()) return
  if (!state.last_activity) return

  const hoursSince = (Date.now() - state.last_activity) / 3_600_000 // И1: last_activity — число, не ISO-строка
  if (hoursSince < Number(env.REMINDER_INTERVAL_HOURS || 72)) return

  try {
    await tgApi(env, 'sendMessage', {
      chat_id: env.MAMA_CHAT_ID,
      text: `Мам, привет! 😊 Ты остановилась на вопросе ${state.current_question + 1} из ${getTotalQuestions()}. Продолжим, когда будет настроение?`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Давай продолжим! ❤️', callback_data: 'reminder_continue' },
            { text: 'Попозже', callback_data: 'reminder_later' },
          ],
        ],
      },
    })
    // сразу — иначе следующая проверка через час пришлёт ещё одно напоминание
    await mutateState(env, (s) => ({ ...s, last_activity: Date.now() }))
  } catch (e) {
    console.error('reminder send failed:', e) // в bot.py тоже не эскалируется Ване
  }
}
