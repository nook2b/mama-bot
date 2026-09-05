import { getGoogleToken, saveGoogleToken } from './state.js'

const RESUMABLE_THRESHOLD = 5 * 1024 * 1024 // см. docs/PLAN.md §10 — граница ориентировочная

// Секрет GOOGLE_CREDENTIALS_JSON остаётся «сидом»: сверяем refresh_token из
// D1 с тем, что сейчас в секрете, при каждом обращении. Если Ваня вручную
// обновил secret (после GOOGLE_TOKEN_DEAD) — расхождение обнаружится само,
// без ручных правок в D1. См. docs/PLAN.md §10.
async function getValidAccessToken(env) {
  let token = await getGoogleToken(env)
  const seed = JSON.parse(env.GOOGLE_CREDENTIALS_JSON)
  if (!token || token.refresh_token !== seed.refresh_token) {
    token = {
      ...seed,
      access_token: seed.access_token ?? seed.token, // в секрете поле называется `token`
      token_uri: seed.token_uri ?? 'https://oauth2.googleapis.com/token',
      expires_at: 0, // форсируем refresh при первом обращении
    }
    await saveGoogleToken(env, token)
  }
  if (Date.now() >= token.expires_at - 60_000) {
    const res = await fetch(token.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: token.client_id,
        client_secret: token.client_secret,
        refresh_token: token.refresh_token,
        grant_type: 'refresh_token',
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      if (body.includes('invalid_grant')) {
        throw new Error(
          'GOOGLE_TOKEN_DEAD: refresh_token отозван или протух — получите новый через OAuth ' +
            'consent flow в браузере и обновите secret GOOGLE_CREDENTIALS_JSON (wrangler secret put); ' +
            'новый refresh_token подхватится автоматически'
        )
      }
      throw new Error(`Google token refresh failed: ${body}`)
    }
    const fresh = await res.json()
    token.access_token = fresh.access_token
    token.expires_at = Date.now() + fresh.expires_in * 1000
    await saveGoogleToken(env, token)
  }
  return token.access_token
}

function buildMultipartBody(metadata, mediaBytes, mediaMimeType) {
  const boundary = `mama_bot_${crypto.randomUUID()}`
  const preamble =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${mediaMimeType}\r\n\r\n`
  const closing = `\r\n--${boundary}--`
  // Тело собираем только через Blob — конкатенация строк испортила бы бинарь. См. docs/PLAN.md §10.
  const body = new Blob([preamble, mediaBytes, closing])
  return { body, contentType: `multipart/related; boundary=${boundary}` }
}

async function uploadMultipart(env, metadata, mediaBytes, mediaMimeType) {
  const accessToken = await getValidAccessToken(env)
  const { body, contentType } = buildMultipartBody(metadata, mediaBytes, mediaMimeType)
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': contentType },
    body,
  })
  if (!res.ok) throw new Error(`Drive multipart upload HTTP ${res.status}: ${await res.text()}`)
  return (await res.json()).id
}

async function uploadResumable(env, metadata, mediaBytes, mediaMimeType) {
  const accessToken = await getValidAccessToken(env)
  const initRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mediaMimeType,
    },
    body: JSON.stringify(metadata),
  })
  if (!initRes.ok) throw new Error(`Drive resumable init HTTP ${initRes.status}: ${await initRes.text()}`)
  const uploadUrl = initRes.headers.get('Location')
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mediaMimeType },
    body: mediaBytes,
  })
  if (!putRes.ok) throw new Error(`Drive resumable upload HTTP ${putRes.status}: ${await putRes.text()}`)
  return (await putRes.json()).id
}

// Multipart до ~5 МБ (рекомендация Google для файлов, которые не жалко
// перезалить целиком при обрыве), крупные голосовые — resumable, чтобы
// не терять длинные записи на обрыве соединения. См. docs/PLAN.md §10.
export async function uploadAudio(env, filename, arrayBuffer, mimeType, folderId) {
  const metadata = { name: filename, parents: folderId ? [folderId] : undefined }
  if (arrayBuffer.byteLength > RESUMABLE_THRESHOLD) {
    return uploadResumable(env, metadata, arrayBuffer, mimeType)
  }
  return uploadMultipart(env, metadata, new Uint8Array(arrayBuffer), mimeType)
}

// media-часть — text/plain, но mimeType в метаданных — Google Doc, это
// заставляет Drive сконвертировать текст в документ при загрузке.
export async function uploadDoc(env, filename, text, folderId) {
  const metadata = {
    name: filename,
    mimeType: 'application/vnd.google-apps.document',
    parents: folderId ? [folderId] : undefined,
  }
  const bytes = new TextEncoder().encode(text)
  return uploadMultipart(env, metadata, bytes, 'text/plain')
}
