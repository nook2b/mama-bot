export async function tgApi(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!data.ok) {
    throw new Error(`Telegram API ${method} failed (${res.status}): ${JSON.stringify(data)}`)
  }
  return data.result
}

// getFile — до 20 МБ (лимит Bot API), см. docs/PLAN.md §6.
export async function getFile(env, fileId) {
  return tgApi(env, 'getFile', { file_id: fileId })
}

export function getFileDownloadUrl(env, filePath) {
  return `https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${filePath}`
}

export async function downloadFile(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to download file: HTTP ${res.status}`)
  return res.arrayBuffer()
}
