// Статический JSON-импорт: esbuild (Wrangler всегда через него бандлит)
// инлайнит questions.json на этапе сборки. Атрибут `with { type: 'json' }`
// нужен голому Node (node --test): без него импорт JSON падает с
// ERR_IMPORT_ATTRIBUTE_MISSING, и модули, зависящие от вопросов, нельзя
// было бы прогнать в тестах. esbuild атрибут понимает и просто инлайнит файл.
import questions from '../questions.json' with { type: 'json' }

export function getQuestionText(idx) {
  return questions[idx] ?? null
}

export function getTotalQuestions() {
  return questions.length // 222
}
