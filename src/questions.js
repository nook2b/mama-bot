// Статический JSON-импорт: esbuild (Wrangler всегда через него бандлит)
// инлайнит questions.json на этапе сборки. Этот модуль сознательно НЕ
// импортируется тестами (см. src/pure.js) — под голым node --test без
// бандлера статический JSON-импорт без import attribute не заработает.
import questions from '../questions.json'

export function getQuestionText(idx) {
  return questions[idx] ?? null
}

export function getTotalQuestions() {
  return questions.length // 222
}
