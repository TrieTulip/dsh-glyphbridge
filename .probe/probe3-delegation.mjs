/**
 * Probe 3 — real delegation to the real DeepSeek adapter.
 *
 * Mounts the shipped account provider stack (credentials + DeepSeek account +
 * the DeepSeek adapter) and GlyphBridge pointed at it, then asks a plain text
 * question *through the GlyphBridge route* to prove the companion adapter really
 * delegates to the production adapter rather than reimplementing any protocol.
 */
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import DeepSeekAccount from '@deepseek-ai/dsh-deepseek-account'
import AccountPlatform from '@deepseek-ai/dsh-deepseek-account-platform'
import DeepSeekLlmAccount from '@deepseek-ai/dsh-llm-deepseek-account'

const copy = (rel) => import(pathToFileURL(`./node_modules/dsh-glyphbridge/${rel}`).href)
const plugin = await copy('lib/dsh/index.js')

const dshHome = `${homedir()}/.dsh`
const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(LlmRuntime)
await ctx.plugin(CredentialsLocal, { dshHome })
await ctx.plugin(AccountPlatform, {})
await ctx.plugin(DeepSeekAccount, {})
await ctx.plugin(DeepSeekLlmAccount, {})

console.log('providers:', JSON.stringify(ctx.llm.listProviders()))

const models = await ctx.llm.listModels('deepseek-account')
console.log('account models:', models.map((m) => `${m.id}${m.inputModalities ? `[${m.inputModalities}]` : ''}`).join(', '))
if (models.length === 0) {
  console.log('no models advertised — cannot run the delegation test')
  process.exit(2)
}
const model = models.find((m) => m.id.includes('flash'))?.id ?? models[0].id

await ctx.plugin(plugin, {
  targetProvider: 'deepseek-account',
  primary: { kind: 'vlm', baseUrl: '', model: '', apiKeyEnv: '', timeoutMs: 5000 },
  fallback: { kind: 'vlm', baseUrl: '', model: '', apiKeyEnv: '', timeoutMs: 5000 },
  tool: { enabled: true, maxImageBytes: 1 << 24 },
})

console.log('after plugin:', JSON.stringify(ctx.llm.listProviders()))
console.log('twin catalog:', JSON.stringify(await ctx.llm.listModels('glyphbridge')))

let text = ''
let finish
for await (const chunk of ctx.llm.stream({
  provider: 'glyphbridge',
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：收到' }] }],
  maxTokens: 32,
})) {
  if (chunk.type === 'text-delta') text += chunk.text
  if (chunk.type === 'finish') finish = chunk
}

console.log('---')
console.log('model:', model)
console.log('reply:', JSON.stringify(text))
console.log('finish:', JSON.stringify(finish))
process.exit(0)
