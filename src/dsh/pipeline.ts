import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { EvidenceCache, type CacheStats } from './cache.js'
import type { EngineConfig, PluginConfig } from './config.js'
import { emptyEvidence, type Evidence } from './evidence.js'
import { engineLabel, envSecret, isConfigured, runEngine, type ImageInput, type SecretResolver } from './engines.js'

interface Slot {
  name: 'primary' | 'fallback'
  engine: EngineConfig
}

/** Why one slot produced nothing. */
interface AttemptFailure {
  label: string
  reason: string
}

/** The subset of the harness credential seam this pipeline needs. */
interface CredentialReader {
  resolve(ref: string): Promise<{ value?: string; source?: string } | undefined> | { value?: string; source?: string } | undefined
}

/**
 * Resolve one `apiKeyEnv` name the way the rest of the harness does.
 *
 * The process environment is only one of the places a key lives: the app stores
 * keys in `$DSH_HOME/.credentials.yaml` and exposes them through `ctx.credentials`,
 * which itself layers the environment, the stored record, and `.env` files. A
 * plugin that read `process.env` alone would demand a second copy of the same
 * secret — and would refuse to work on a machine that already has one.
 *
 * @param ctx - plugin context; `credentials` is optional and tolerated absent.
 * @param name - the variable/ref name from configuration.
 * @returns the usable value, or `undefined` when nothing configured it.
 */
async function resolveSecret(ctx: Context, name: string): Promise<string | undefined> {
  const fromEnvironment = envSecret(name)
  if (fromEnvironment !== undefined) return fromEnvironment

  const credentials = ctx.get('credentials') as CredentialReader | undefined
  if (credentials === undefined) return undefined
  try {
    const hit = await credentials.resolve(name)
    const value = hit?.value
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
  } catch {
    // A seam that refuses the name (bad ref, unreadable store) is "not configured"
    // for this engine; the engine's own error names the variable for the user.
    return undefined
  }
}

/** Caller-supplied context for one translation. */
export interface DescribeOptions {
  /** Cancellation of the whole request. */
  signal?: AbortSignal
  /**
   * Stable identity of the image when the caller has one (an attachment id).
   *
   * When supplied, the memo can answer without the caller reading the image at
   * all, so a repeated turn costs neither a decode nor an engine call. When
   * omitted (a file path or URL, whose bytes may change), identity falls back to
   * a digest of the bytes that were actually translated.
   */
  identity?: string
}

function slotsOf(config: PluginConfig): Slot[] {
  return [
    { name: 'primary', engine: config.primary },
    { name: 'fallback', engine: config.fallback },
  ]
}

/** Short content digest used as an image identity when none is supplied. */
function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 32)
}

/**
 * The translation pipeline: one image in, one evidence record out.
 *
 * Both surfaces use this class and nothing else — the adapter's request rewrite
 * and the `glyphbridge_read_image` tool — so the memo, the fallback chain, the
 * attribution rule, and the evidence shape are identical wherever they are
 * produced.
 */
export class VisionPipeline {
  private readonly cache: EvidenceCache
  /**
   * Identity of the configured engine chain. Part of every memo key, so editing
   * `primary`/`fallback` can never serve text an engine that is no longer
   * configured would not have produced.
   */
  private readonly chainKey: string

  constructor(
    private readonly ctx: Context,
    private readonly config: PluginConfig,
  ) {
    this.cache = new EvidenceCache(config.cache.enabled, config.cache.maxEntries)
    this.chainKey = slotsOf(config)
      .map((slot) => {
        const engine = slot.engine
        return `${slot.name}=${engine.kind}:${engine.baseUrl.trim()}:${engine.model.trim()}:${engine.apiKeyEnv.trim()}`
      })
      .join(';')
  }

  /** Slots that can actually be attempted, in order, with exact duplicates dropped. */
  private candidates(): Slot[] {
    const seen = new Set<string>()
    const out: Slot[] = []
    for (const slot of slotsOf(this.config)) {
      if (!isConfigured(slot.engine)) continue
      const identity = `${slot.engine.kind}|${slot.engine.baseUrl}|${slot.engine.model}|${slot.engine.apiKeyEnv}`
      if (seen.has(identity)) continue
      seen.add(identity)
      out.push(slot)
    }
    return out
  }

  /** Whether at least one engine is configured. Used for honest diagnostics. */
  hasEngine(): boolean {
    return this.candidates().length > 0
  }

  /** Credential lookup shared by every engine attempt: environment first, then the seam. */
  private readonly secrets: SecretResolver = (name) => resolveSecret(this.ctx, name)

  /** Current memo counters, for diagnostics. */
  get cacheStats(): CacheStats {
    return this.cache.stats
  }

  /**
   * Transcribe one image, answering from the memo when this exact image was
   * already translated under this exact engine chain.
   *
   * @param load - reads the image bytes; not called when the memo answers.
   * @param options - cancellation and optional stable image identity.
   * @returns evidence, degraded (never thrown) when every slot fails.
   */
  async describe(load: () => Promise<ImageInput>, options: DescribeOptions = {}): Promise<Evidence> {
    const identity = options.identity?.trim()

    if (identity !== undefined && identity.length > 0) {
      const { evidence, cached } = await this.cache.remember(`${this.chainKey}|${identity}`, async () =>
        this.transcribe(await load(), options.signal),
      )
      this.note(cached, identity, evidence)
      return evidence
    }

    // No stable identity: the bytes decide it, so they are read before keying.
    const image = await load()
    const contentDigest = digest(image.data)
    const { evidence, cached } = await this.cache.remember(`${this.chainKey}|sha256:${contentDigest}`, async () =>
      this.transcribe(image, options.signal),
    )
    this.note(cached, `sha256:${contentDigest.slice(0, 8)}`, evidence)
    return evidence
  }

  /** One diagnostic line per translation, naming whether the memo answered. */
  private note(cached: boolean, identity: string, evidence: Evidence): void {
    this.ctx.logger?.debug?.(
      `glyphbridge: ${cached ? '缓存命中' : '缓存未命中'}（${identity}，${evidence.engine}，缓存 ${this.cache.stats.size} 条）`,
    )
  }

  /**
   * Run the chain, falling through on failure.
   *
   * A successful fallback keeps the failure of every slot before it as an engine
   * note, and the evidence header names the slot that actually answered — the
   * model is never told a primary engine produced text it did not produce.
   *
   * @param image - request-normalized bytes and media type.
   * @param signal - request cancellation.
   * @returns evidence, degraded (never thrown) when every slot fails.
   */
  private async transcribe(image: ImageInput, signal?: AbortSignal): Promise<Evidence> {
    const candidates = this.candidates()
    if (candidates.length === 0) {
      return emptyEvidence(
        'none',
        'GlyphBridge 没有配置可用的视觉引擎（primary.baseUrl / primary.model 与 fallback 均为空），图片内容无法转译。',
      )
    }

    const failures: AttemptFailure[] = []
    for (const slot of candidates) {
      signal?.throwIfAborted()
      try {
        const evidence = await runEngine(slot.name, slot.engine, image, signal, this.secrets)
        if (failures.length === 0) return evidence
        return {
          ...evidence,
          notes: [
            ...failures.map((failure) => `已降级：${failure.label} 失败（${failure.reason}）；本条由 ${evidence.engine} 产出`),
            ...evidence.notes,
          ],
        }
      } catch (error) {
        const label = engineLabel(slot.name, slot.engine)
        const reason = error instanceof Error ? error.message.replace(`${label}: `, '') : String(error)
        failures.push({ label, reason })
        this.ctx.logger?.warn?.(`glyphbridge: ${label} 失败，尝试下一引擎: ${reason}`)
      }
    }

    const last = failures[failures.length - 1]
    return emptyEvidence(
      last?.label ?? 'none',
      `所有视觉引擎均失败：${failures.map((failure) => `${failure.label} → ${failure.reason}`).join('；')}。图片内容无法转译，请勿猜测其中文字。`,
    )
  }
}
