// Decisive probe: send a REAL photograph to the DeepSeek chat endpoint and ask what it shows.
// If the answer describes the picture, the endpoint can actually see images.
// Usage: node deepseek-image-probe.mjs <imagePath> "<question>"
import { readFileSync } from 'node:fs'

const key = process.env.DEEPSEEK_API_KEY
if (!key) {
  console.log('NO KEY IN ENV')
  process.exit(1)
}

const imagePath = process.argv[2]
const question = process.argv[3] ?? '用一句话描述这张图片里有什么。'
if (!imagePath) {
  console.log('usage: node deepseek-image-probe.mjs <imagePath> [question]')
  process.exit(2)
}

const bytes = readFileSync(imagePath)
const mediaType = bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : 'image/jpeg'
const b64 = bytes.toString('base64')
console.log(`image: ${imagePath} (${bytes.length} bytes, ${mediaType})`)

const body = {
  model: 'deepseek-flash',
  temperature: 0,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: question },
        { type: 'image_url', image_url: { url: `data:${mediaType};base64,${b64}` } },
      ],
    },
  ],
}

try {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await response.text()
  console.log('HTTP', response.status, response.statusText)
  try {
    const json = JSON.parse(text)
    const message = json.choices?.[0]?.message
    console.log('answer:', message?.content)
    if (message?.reasoning_content) console.log('reasoning:', String(message.reasoning_content).slice(0, 400))
    console.log('usage:', JSON.stringify(json.usage))
  } catch {
    console.log('BODY:', text.slice(0, 800))
  }
} catch (error) {
  console.log('FETCH FAILED:', error.name, error.message)
}
