/**
 * Probe 4 — the credential seam (0.3.0) end to end on the real runtime.
 *
 * The shipped app keeps API keys in `$DSH_HOME/.credentials.yaml` and exposes them
 * through `ctx.credentials`; `process.env` stays empty. This probe mounts the real
 * LlmRuntime with a faithful `credentials` service, points the primary engine at
 * the real DeepSeek endpoint, and prints the evidence the *target adapter* received.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

const copy = (rel) => import(pathToFileURL(`./node_modules/dsh-glyphbridge/${rel}`).href)
const plugin = await copy('lib/dsh/index.js')
const { LlmAdapter } = await import('@deepseek-ai/dsh-llm')

/* --------------------------------------------------------------- credentials */

function readStoredKey(name) {
  const file = join(homedir(), '.dsh', '.credentials.yaml')
  const text = readFileSync(file, 'utf8')
  const line = new RegExp(`^\\s*${name}:\\s*(\\S+)\\s*$`, 'm').exec(text)
  return line?.[1]
}

/** Stands in for `dsh-credentials-local`: same `resolve(ref)` answer shape. */
class StoredCredentials extends Service {
  constructor(ctx) {
    super(ctx, 'credentials')
  }
  async resolve(ref) {
    const value = readStoredKey(ref)
    return value === undefined ? undefined : { value, source: 'local' }
  }
}

/* ------------------------------------------------------------------ fixtures */

const fixtures = ['../verify/sample-text.png', './sample-text.png']
const fixture = fixtures.find((path) => existsSync(path))
if (fixture === undefined) {
  console.log('missing fixture: render verify/sample-text.png first (see .probe/README.md)')
  process.exit(2)
}
const image = readFileSync(fixture)
console.log('fixture:', fixture, image.length, 'bytes')

class FakeAttachments extends Service {
  constructor(ctx) {
    super(ctx, 'attachments')
  }
  imageHostPath() {
    return undefined
  }
  async readImageRequest() {
    return { data: new Uint8Array(image), mediaType: 'image/png', width: 900, height: 420 }
  }
}

class MockTarget extends LlmAdapter {
  constructor() {
    super()
    this.received = []
  }
  providerInfo(provider) {
    return { id: provider, name: 'DeepSeek (mock)' }
  }
  async listModels(provider) {
    return [{ provider, id: 'deepseek-flash', name: 'deepseek-flash', inputModalities: ['text'] }]
  }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, inputModalities: ['text'] }
  }
  async *stream(options) {
    this.received.push(options)
    yield { type: 'text-delta', text: 'ok' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/* -------------------------------------------------------------------- driver */

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(LlmRuntime)
await ctx.plugin(FakeAttachments)
await ctx.plugin(StoredCredentials)

const target = new MockTarget()
ctx.llm.registerAdapter(['deepseek-official'], target)

await ctx.plugin(plugin, {
  targetProvider: 'deepseek-official',
  primary: {
    kind: 'vlm',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    timeoutMs: 90000,
  },
  fallback: { kind: 'vlm', baseUrl: '', model: '', apiKeyEnv: '', timeoutMs: 20000 },
  cache: { enabled: true, maxEntries: 8 },
  tool: { enabled: true, maxImageBytes: 1 << 24 },
})

const imageBlock = {
  type: 'image',
  attachment: { attachmentId: 'fixture', mediaType: 'image/png', bytes: image.length, width: 900, height: 420, name: 'sample-text.png' },
}

const started = Date.now()
const chunks = []
for await (const chunk of ctx.llm.stream({
  provider: 'glyphbridge',
  model: 'deepseek-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: '这张图里写了什么？' }, imageBlock] }],
})) {
  chunks.push(chunk)
}
const elapsed = Date.now() - started
const finish = chunks.find((chunk) => chunk.type === 'finish')

console.log(`\nfinish: ${JSON.stringify(finish)}  (${elapsed} ms)`)
const forwarded = target.received[0]
if (forwarded === undefined) {
  console.log('target received: NOTHING')
  process.exit(1)
}
const images = forwarded.messages[0].content.filter((b) => b.type === 'image').length
const text = forwarded.messages[0].content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
console.log('image blocks in forwarded message:', images)
console.log('forwarded text:\n' + text.split('\n').map((line) => '    ' + line).join('\n'))

/* ------------------------------------------------------------------- second */

console.log('\n--- second turn (memo) ---')
await ctx.llm.stream({
  provider: 'glyphbridge',
  model: 'deepseek-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: '这张图里写了什么？' }, imageBlock] }],
}).next()
const again = target.received[1]
const same = JSON.stringify(again?.messages) === JSON.stringify(forwarded.messages)
console.log('second turn evidence identical (no new engine call expected):', same)

process.exit(0)
