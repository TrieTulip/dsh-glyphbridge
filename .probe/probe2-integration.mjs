/**
 * Probe 2 — integration on the real runtime.
 *
 * Mounts the real LlmRuntime / ToolRuntime / systemPrompt services, the compiled
 * GlyphBridge plugin, a mock target adapter (standing in for the DeepSeek
 * adapter) and a local OpenAI-compatible VLM server. It drives ctx.llm.stream()
 * through the companion route and reports what the *target adapter* received.
 */
import { createServer } from 'node:http'
import { deflateSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

// Import the frozen copy so the plugin and the runtime share one module tree.
const copy = (rel) => import(pathToFileURL(`./node_modules/dsh-glyphbridge/${rel}`).href)
const plugin = await copy('lib/dsh/index.js')
const { registerReadImageTool } = await copy('lib/dsh/tool.js')
const { VisionPipeline } = await copy('lib/dsh/pipeline.js')

/* ------------------------------------------------------------------ fixtures */

function tinyPng() {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(8, 0)
  ihdr.writeUInt32BE(8, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(8 * (1 + 8 * 3), 0x7f)
  for (let y = 0; y < 8; y += 1) raw[y * (1 + 24)] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const png = tinyPng()

const TABLE_ANSWER = {
  ocr: '季度营收\nQ1 120\nQ2 145\n合计 265',
  layout: [
    { text: '季度营收', type: 'title', bbox: [10, 8, 180, 24] },
    { text: 'Q1 120', type: 'paragraph', bbox: [10, 40, 90, 16] },
  ],
  tables: [
    { title: '营收表', format: 'markdown', body: '| 季度 | 营收 |\n| --- | --- |\n| Q1 | 120 |\n| Q2 | 145 |' },
  ],
}

let vlmCalls = 0
const vlm = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    vlmCalls += 1
    const { pathname } = new URL(req.url, 'http://localhost')
    if (pathname.startsWith('/slow/')) return // never answers -> timeout
    if (pathname.startsWith('/fail/')) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'boom' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(TABLE_ANSWER) } }] }))
  })
})
await new Promise((resolve) => vlm.listen(0, '127.0.0.1', resolve))
const vlmBase = `http://127.0.0.1:${vlm.address().port}`

/* --------------------------------------------------------------- fake services */

class FakeAttachments extends Service {
  constructor(ctx) {
    super(ctx, 'attachments')
  }
  imageHostPath() {
    return undefined
  }
  async readImageRequest(ref) {
    return { data: new Uint8Array(png), mediaType: 'image/png', width: 8, height: 8, variantId: `v-${ref.attachmentId}` }
  }
}

class FakeFs extends Service {
  constructor(ctx) {
    super(ctx, 'fs')
  }
  async resolve(path) {
    return { targetKey: path, displayPath: path }
  }
  async readBytes() {
    return new Uint8Array(png)
  }
  processPathFromHostPath(hostPath) {
    return hostPath
  }
}

class CapturingTools extends Service {
  constructor(ctx) {
    super(ctx, 'tools')
    this.definitions = []
  }
  register(definition) {
    this.definitions.push(definition)
    return () => {}
  }
}

class MockTarget extends LlmAdapter {
  constructor(modalities) {
    super()
    this.modalities = modalities
    this.received = []
  }
  providerInfo(provider) {
    return { id: provider, name: 'DeepSeek (mock)' }
  }
  async listModels(provider) {
    return [{ provider, id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', inputModalities: this.modalities }]
  }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, inputModalities: this.modalities, context: { contextWindow: 128000 } }
  }
  async *stream(options) {
    this.received.push(options)
    yield { type: 'text-delta', text: 'ok' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/* --------------------------------------------------------------------- harness */

const imageBlock = {
  type: 'image',
  attachment: { attachmentId: 'sha256-deadbeef', mediaType: 'image/png', bytes: png.length, width: 8, height: 8, name: 'shot.png' },
}
const userMessages = () => [{ role: 'user', content: [{ type: 'text', text: '这张截图里写了什么？' }, structuredClone(imageBlock)] }]

const drain = async (iterable) => {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}
const textOf = (message) => message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
const imagesOf = (message) => message.content.filter((b) => b.type === 'image').length

async function scenario(label, { primary, fallback, targetModalities, translate = 'auto', calls }, messages) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FakeAttachments)
  await ctx.plugin(FakeFs)

  const target = new MockTarget(targetModalities)
  ctx.llm.registerAdapter(['deepseek-official'], target)
  await ctx.plugin(plugin, {
    targetProvider: 'deepseek-official',
    translate,
    primary: { kind: 'vlm', apiKeyEnv: '', timeoutMs: 800, baseUrl: '', model: '', ...primary },
    fallback: { kind: 'vlm', apiKeyEnv: '', timeoutMs: 800, baseUrl: '', model: '', ...fallback },
    cache: { enabled: true, maxEntries: 64 },
    tool: { enabled: true, maxImageBytes: 1 << 24 },
  })

  const before = vlmCalls
  const chunks = await drain(ctx.llm.stream({ provider: 'glyphbridge', model: 'deepseek-v4-flash', messages: messages() }))
  if (calls === true) console.log(`  >>> VLM calls: ${vlmCalls - before}`)
  const finish = chunks.find((chunk) => chunk.type === 'finish')
  const forwarded = target.received[0]

  console.log(`\n=== ${label}`)
  console.log('  providers:', ctx.llm.listProviders().map((p) => `${p.id} [${p.name}]`).join(' | '))
  console.log('  catalog:', JSON.stringify(await ctx.llm.listModels('glyphbridge')))
  console.log('  finish:', JSON.stringify(finish))
  if (forwarded === undefined) {
    console.log('  target received: NOTHING')
    return
  }
  console.log('  forwarded provider:', forwarded.provider)
  console.log('  image blocks in forwarded message:', imagesOf(forwarded.messages[0]))
  console.log('  forwarded text:\n' + textOf(forwarded.messages[0]).split('\n').map((l) => '    ' + l).join('\n'))
}

await scenario('A. pure-text target, screenshot -> evidence text', {
  primary: { baseUrl: vlmBase, model: 'mock-vlm' },
  targetModalities: ['text'],
}, userMessages)

await scenario('B. primary HTTP 500 -> fallback engine', {
  primary: { baseUrl: `${vlmBase}/fail`, model: 'dead-vlm' },
  fallback: { baseUrl: vlmBase, model: 'backup-vlm' },
  targetModalities: ['text'],
}, userMessages)

await scenario('C. primary times out -> fallback engine', {
  primary: { baseUrl: `${vlmBase}/slow`, model: 'slow-vlm' },
  fallback: { baseUrl: vlmBase, model: 'backup-vlm' },
  targetModalities: ['text'],
}, userMessages)

const callsBefore = vlmCalls
await scenario('D. native-vision target -> pass-through, no VLM call (translate: auto)', {
  primary: { baseUrl: vlmBase, model: 'mock-vlm' },
  targetModalities: ['text', 'image'],
}, userMessages)
console.log('  >>> VLM calls during pass-through:', vlmCalls - callsBefore)

await scenario('I. native-vision target + translate: always -> evidence anyway', {
  primary: { baseUrl: vlmBase, model: 'mock-vlm' },
  targetModalities: ['text', 'image'],
  translate: 'always',
  calls: true,
}, userMessages)

await scenario('E. no engine configured -> explicit degraded block', {
  targetModalities: ['text'],
}, userMessages)

/* ------------------------------------------------------------------ the memo */

/** Mount one plugin instance whose memo is shared by every call it serves. */
async function mountPlugin({ primary, targetModalities }) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FakeAttachments)
  const target = new MockTarget(targetModalities)
  ctx.llm.registerAdapter(['deepseek-official'], target)
  await ctx.plugin(plugin, {
    targetProvider: 'deepseek-official',
    translate: 'auto',
    primary: { kind: 'vlm', apiKeyEnv: '', timeoutMs: 800, baseUrl: '', model: '', ...primary },
    fallback: { kind: 'vlm', apiKeyEnv: '', timeoutMs: 800, baseUrl: '', model: '' },
    cache: { enabled: true, maxEntries: 64 },
    tool: { enabled: true, maxImageBytes: 1 << 24 },
  })
  return { ctx, target }
}

const request = { provider: 'glyphbridge', model: 'deepseek-v4-flash' }

console.log('\n=== G. memo: the same image on a second turn costs no engine call')
{
  const mounted = await mountPlugin({ primary: { baseUrl: vlmBase, model: 'mock-vlm' }, targetModalities: ['text'] })
  const before = vlmCalls
  await drain(mounted.ctx.llm.stream({ ...request, messages: userMessages() }))
  const afterFirst = vlmCalls
  await drain(mounted.ctx.llm.stream({ ...request, messages: userMessages() }))
  const afterSecond = vlmCalls
  const [first, second] = mounted.target.received.map((received) => textOf(received.messages[0]))
  console.log('  engine calls: turn 1 =', afterFirst - before, '| turn 2 =', afterSecond - afterFirst)
  console.log('  target turns:', mounted.target.received.length)
  console.log('  evidence identical across turns:', first === second)
}

console.log('\n=== H. memo: one image twice in one request costs one engine call')
{
  const mounted = await mountPlugin({ primary: { baseUrl: vlmBase, model: 'mock-vlm' }, targetModalities: ['text'] })
  const before = vlmCalls
  await drain(
    mounted.ctx.llm.stream({
      ...request,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: '这两张一样吗？' }, structuredClone(imageBlock), structuredClone(imageBlock)],
        },
      ],
    }),
  )
  const forwarded = mounted.target.received[0]
  console.log('  engine calls:', vlmCalls - before)
  console.log('  image blocks left in forwarded message:', imagesOf(forwarded.messages[0]))
  console.log('  forwarded text:\n' + textOf(forwarded.messages[0]).split('\n').map((l) => '    ' + l).join('\n'))
}

/* ------------------------------------------------------------------- the tool */

const toolCtx = new Context()
await toolCtx.plugin(FakeFs)
const tools = await toolCtx.plugin(CapturingTools)
const toolConfig = {
  targetProvider: 'deepseek-official',
  primary: { kind: 'vlm', baseUrl: vlmBase, model: 'mock-vlm', apiKeyEnv: '', timeoutMs: 5000 },
  fallback: { kind: 'vlm', baseUrl: '', model: '', apiKeyEnv: '', timeoutMs: 5000 },
  cache: { enabled: true, maxEntries: 64 },
  tool: { enabled: true, maxImageBytes: 1 << 24 },
}
registerReadImageTool(toolCtx, { pipeline: new VisionPipeline(toolCtx, toolConfig), config: toolConfig })

const tool = toolCtx.tools.definitions[0]
console.log('\n=== F. glyphbridge_read_image')
console.log('  name:', tool?.name)
console.log('  parameters:', JSON.stringify(tool?.parameters))
const result = await tool.execute({ path: 'C:/fake/shot.png' }, { signal: undefined })
console.log('  engine:', result.engine, '| source:', result.source)
console.log('  output:\n' + result.text.split('\n').map((l) => '    ' + l).join('\n'))

vlm.close()
process.exit(0)
