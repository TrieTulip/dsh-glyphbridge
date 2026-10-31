/**
 * Probe 1 — admission-layer verification on the real 0.2.0-rc.2 runtime.
 *
 * It mounts the shipped LlmRuntime, registers a companion ("twin") provider route
 * that advertises image input, and then applies the *exact* admission predicate
 * copied from @deepseek-ai/dsh-api-session-controller prompt() to show whether a
 * companion route passes the gate that a pure-text route fails.
 */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, projectImagesForTextModel } from '@deepseek-ai/dsh-llm'

const ctx = new Context()
await ctx.plugin(LlmRuntime)
console.log('[mount] ctx.llm present:', typeof ctx.llm?.registerAdapter === 'function')

/** A pure-text provider, mirroring a stock DeepSeek route. */
class TextOnly extends LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: 'DeepSeek' }
  }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, inputModalities: ['text'] }
  }
  async *stream() {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** A companion route that advertises image input while delegating to the text route. */
class Twin extends LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: 'GlyphBridge (DeepSeek)' }
  }
  async listModels(provider) {
    return [{ provider, id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', inputModalities: ['text', 'image'] }]
  }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
  }
  async *stream() {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

ctx.llm.registerAdapter(['deepseek-official'], new TextOnly())
ctx.llm.registerAdapter(['glyphbridge'], new Twin())
console.log('[routes]', JSON.stringify(ctx.llm.listProviders()))

// --- the exact predicate from dsh-api-session-controller/lib/types/commands.js ---
const admitGate = (info) =>
  info.inputModalities !== undefined && !info.inputModalities.includes('image')

for (const [provider, model] of [
  ['deepseek-official', 'deepseek-v4-flash'],
  ['glyphbridge', 'deepseek-v4-flash'],
]) {
  const info = await ctx.llm.resolveModelInfo(provider, model)
  const rejected = admitGate(info)
  console.log(
    `[admission] ${provider}/${model} inputModalities=${JSON.stringify(info.inputModalities)} -> ` +
      (rejected ? 'REJECTED (MODEL_DOES_NOT_SUPPORT_IMAGES)' : 'ADMITTED'),
  )
}

// --- the second gate: dispatch-time projection for text-only routes ---
const history = [
  { id: 'm1', role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256-x', mediaType: 'image/png', width: 10, height: 10 } }, { type: 'text', text: 'hi' }] },
]
const projected = projectImagesForTextModel(history)
console.log('[dispatch] text-only projection ->', JSON.stringify(projected[0].content))

console.log('[catalog] glyphbridge models:', JSON.stringify(await ctx.llm.listModels('glyphbridge')))
await ctx.stop?.()
