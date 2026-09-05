// Состояние — единая CAS-запись через mutateState(). Один атомарный
// INSERT ... ON CONFLICT ... WHERE version = ? одновременно создаёт строку
// при самом первом обращении (WHERE не участвует в ветке INSERT) и защищает
// обновление через optimistic concurrency при всех последующих. Это проще
// и надёжнее, чем отдельные saveState()/saveStateIfUnchanged() из плана —
// один путь записи, а не два. См. docs/PLAN.md §4, §7.

export const DEFAULT_STATE = {
  current_question: 0,
  waiting_for_voice: false,
  part_seq: 0,
  last_activity: null,
  started: false,
}

export async function getState(env) {
  const row = await env.DB.prepare('SELECT value, version FROM kv WHERE key = ?').bind('state').first()
  if (!row) return { value: { ...DEFAULT_STATE }, version: null }
  return { value: JSON.parse(row.value), version: row.version }
}

async function saveStateIfUnchanged(env, value, expectedVersion) {
  const { meta } = await env.DB.prepare(
    `INSERT INTO kv (key, value, version, updated_at) VALUES ('state', ?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = kv.version + 1, updated_at = excluded.updated_at
     WHERE kv.version = ?`
  ).bind(JSON.stringify(value), Date.now(), expectedVersion).run()
  return meta.changes === 1
}

// mutator(currentValue) -> newValue. При проигрыше гонки перечитывает
// свежее состояние и применяет mutator заново — а не переиспользует старое
// значение из памяти (см. «Гонка за состоянием», docs/PLAN.md §7).
export async function mutateState(env, mutator, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const { value, version } = await getState(env)
    const nextValue = mutator(value)
    const ok = await saveStateIfUnchanged(env, nextValue, version)
    if (ok) return nextValue
  }
  throw new Error('mutateState: конфликт записи состояния не удалось разрешить за несколько попыток')
}

// Атомарный инкремент счётчика части ответа — не читает-изменяет-пишет JS,
// а один SQL-стейтмент, поэтому корректен при любом параллелизме
// ctx.waitUntil-задач. См. И3 в docs/PLAN.md §1.
export async function incrementPartSeq(env) {
  const row = await env.DB.prepare(
    `UPDATE kv
     SET value = json_set(value, '$.part_seq', json_extract(value, '$.part_seq') + 1),
         version = version + 1,
         updated_at = ?
     WHERE key = 'state'
     RETURNING json_extract(value, '$.part_seq') AS part_seq`
  ).bind(Date.now()).first()
  return row.part_seq
}

export async function getGoogleToken(env) {
  const row = await env.DB.prepare('SELECT value FROM kv WHERE key = ?').bind('google_token').first()
  return row ? JSON.parse(row.value) : null
}

export async function saveGoogleToken(env, token) {
  await env.DB.prepare(
    `INSERT INTO kv (key, value, version, updated_at) VALUES ('google_token', ?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = kv.version + 1, updated_at = excluded.updated_at`
  ).bind(JSON.stringify(token), Date.now()).run()
}
