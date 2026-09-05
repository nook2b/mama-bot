-- kv: универсальное хранилище состояния и токена Google (JSON в value).
-- version — для оптимистичной блокировки (CAS), см. docs/PLAN.md §4/§7.
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Идемпотентность доставки апдейтов от Telegram, см. docs/PLAN.md §7.
CREATE TABLE IF NOT EXISTS seen_updates (
  update_id INTEGER PRIMARY KEY,
  seen_at INTEGER NOT NULL
);

-- Учёт голосовых, чья загрузка на Google Диск упала — file_id остаётся
-- рабочим и позволяет забрать файл повторно позже. См. docs/PLAN.md §10.
CREATE TABLE IF NOT EXISTS failed_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT NOT NULL,
  question_index INTEGER NOT NULL,
  error TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
