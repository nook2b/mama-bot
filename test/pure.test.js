import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAllowed, sanitizeFilename, formatProgressBar, parseCallbackData } from '../src/pure.js'

test('sanitizeFilename: / \\ : заменяются на -', () => {
  assert.equal(sanitizeFilename('до/после\\потом:сейчас'), 'до-после-потом-сейчас')
})

test('sanitizeFilename: ? « » " * < > | удаляются', () => {
  assert.equal(sanitizeFilename('во?прос «в» кавычках "и" *звёздах* <тегах> |палках|'), 'вопрос в кавычках и звёздах тегах палках')
})

test('sanitizeFilename: перенос строки заменяется на пробел, края обрезаются trim()', () => {
  assert.equal(sanitizeFilename('  первая строка\nвторая строка  '), 'первая строка вторая строка')
})

test('sanitizeFilename: короткий текст не обрезается', () => {
  assert.equal(sanitizeFilename('Короткий вопрос'), 'Короткий вопрос')
})

test('sanitizeFilename: длинный текст обрезается по последнему пробелу на границе 80', () => {
  // ровно один пробел за пределами 80-го символа, чтобы граница была однозначной
  const text = 'а'.repeat(75) + ' ' + 'б'.repeat(20)
  const result = sanitizeFilename(text)
  assert.equal(result, 'а'.repeat(75))
})

test('sanitizeFilename: без единого пробела в первых 80 символах отдаёт ровно 80 символов', () => {
  // rsplit(" ", 1) в Python на строке без пробелов возвращает список из одного
  // элемента (саму строку) — обрезки по слову не происходит вовсе
  const text = 'а'.repeat(120)
  const result = sanitizeFilename(text)
  assert.equal(result.length, 80)
  assert.equal(result, 'а'.repeat(80))
})

test('formatProgressBar: 0%', () => {
  const { pct, bar } = formatProgressBar(0, 222)
  assert.equal(pct, 0)
  assert.equal(bar.length, 20)
  assert.equal(bar, '░'.repeat(20))
})

test('formatProgressBar: 50%', () => {
  const { pct, bar } = formatProgressBar(111, 222)
  assert.equal(pct, 50)
  assert.equal(bar.length, 20)
  assert.equal(bar, '█'.repeat(10) + '░'.repeat(10))
})

test('formatProgressBar: 100%', () => {
  const { pct, bar } = formatProgressBar(222, 222)
  assert.equal(pct, 100)
  assert.equal(bar.length, 20)
  assert.equal(bar, '█'.repeat(20))
})

test('isAllowed: число из Telegram против строки из env.vars — должно совпадать', () => {
  const env = { MAMA_CHAT_ID: '1219919762', VANYA_CHAT_ID: '411340432' }
  assert.equal(isAllowed(env, 1219919762), true)
  assert.equal(isAllowed(env, 411340432), true)
})

test('isAllowed: чужой ID', () => {
  const env = { MAMA_CHAT_ID: '1219919762', VANYA_CHAT_ID: '411340432' }
  assert.equal(isAllowed(env, 999999999), false)
})

test('isAllowed: undefined/null ID', () => {
  const env = { MAMA_CHAT_ID: '1219919762', VANYA_CHAT_ID: '411340432' }
  assert.equal(isAllowed(env, undefined), false)
  assert.equal(isAllowed(env, null), false)
})

test('parseCallbackData: без аргумента', () => {
  assert.deepEqual(parseCallbackData('more'), { action: 'more', arg: null })
  assert.deepEqual(parseCallbackData('next'), { action: 'next', arg: null })
})

test('parseCallbackData: с индексом вопроса', () => {
  assert.deepEqual(parseCallbackData('next:41'), { action: 'next', arg: '41' })
  assert.deepEqual(parseCallbackData('next:0'), { action: 'next', arg: '0' })
})

test('parseCallbackData: мусор вместо строки', () => {
  assert.deepEqual(parseCallbackData(undefined), { action: '', arg: null })
})
