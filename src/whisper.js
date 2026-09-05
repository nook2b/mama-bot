// mimeType/fileName приходят из resolveAudioDescriptor (bot-handler.js) —
// Whisper выбирает декодер по расширению имени файла, поэтому нельзя
// хардкодить 'voice.ogg' для audio/video_note вложений. См. docs/PLAN.md §8-9.
export async function transcribe(env, audioArrayBuffer, { mimeType, fileName }) {
  const form = new FormData()
  form.append('file', new Blob([audioArrayBuffer], { type: mimeType }), fileName)
  form.append('model', 'whisper-1')
  form.append('language', 'ru')
  form.append('prompt', 'Транскрибация голосового сообщения на русском языке')
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
  })
  if (!res.ok) throw new Error(`Whisper HTTP ${res.status}: ${await res.text()}`)
  return (await res.json()).text
}
