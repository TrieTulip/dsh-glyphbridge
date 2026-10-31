import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  contentHasImage,
  type ContentBlock,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type Message,
  type ModelModality,
  type RequestMessage,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { PluginConfig } from './config.js'
import { emptyEvidence, formatEvidence, type Evidence } from './evidence.js'
import type { VisionPipeline } from './pipeline.js'

/** The subset of the attachment service this adapter needs. */
interface AttachmentRef {
  attachmentId: string
  mediaType: string
  width: number
  height: number
}

interface AttachmentReader {
  readImageRequest(
    ref: AttachmentRef,
    target: { width: number; height: number; maxBytes: number },
    signal?: AbortSignal,
  ): Promise<{ data: Uint8Array; mediaType: string; width: number; height: number }>
}

export interface AdapterDeps {
  ctx: Context
  config: PluginConfig
  pipeline: VisionPipeline
}

/** Longest edge GlyphBridge asks the attachment service to derive for a VLM call. */
const REQUEST_IMAGE_MAX_EDGE = 2048
/** Ceiling on the encoded request image handed to a vision engine. */
const REQUEST_IMAGE_MAX_BYTES = 4 * 1024 * 1024
/**
 * Images translated concurrently within one request.
 *
 * A screenshot-bearing turn usually carries one image, but a pasted collage or a
 * replayed history can carry several. Translating them sequentially would make
 * the turn wait for the sum of every engine round trip; the memo already keeps
 * repeats from happening at all. The ceiling bounds the burst a single turn can
 * put on one endpoint.
 */
const TRANSLATION_CONCURRENCY = 3

/**
 * Run one job per item with at most `limit` running at any moment.
 *
 * Order of completion is irrelevant here because each job writes back into the
 * array position it was created for, so the evidence blocks keep message order
 * no matter which engine answers first.
 */
async function mapConcurrent<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      await run(item as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/**
 * Advertise `image` on top of whatever the target route declares.
 *
 * This is the whole point of the companion route: the admission gate reads
 * `resolveModel(provider, model).inputModalities`, and the dispatch layer uses
 * the same fact to decide whether to replace images with placeholders. A route
 * that does not say `image` here is rejected before any plugin hook runs.
 */
function withImage(modalities: readonly ModelModality[] | undefined): ModelModality[] {
  const base = modalities === undefined ? ['text' as const] : [...modalities]
  return base.includes('image') ? base : [...base, 'image']
}

/**
 * The companion ("twin") route adapter.
 *
 * It owns no protocol of its own. It resolves the real target route's
 * capabilities, rewrites images into text evidence, and hands the request to the
 * real adapter through `ctx.llm.stream()` — the harness's only supported path to
 * an adapter — so authentication, retries, attribution headers, and wire format
 * all stay with the adapter that was built for them.
 */
export class GlyphBridgeAdapter extends LlmAdapter {
  constructor(private readonly deps: AdapterDeps) {
    super()
  }

  private get targetProvider(): string {
    return this.deps.config.targetProvider
  }

  providerInfo(provider: string): { id: string; name: string } {
    const target = this.deps.ctx.llm.listProviders().find((entry) => entry.id === this.targetProvider)
    return { id: provider, name: `GlyphBridge · ${target?.name ?? this.targetProvider}` }
  }

  /**
   * Mirror the target catalog so the GUI selector can offer every real model
   * through the twin route, with image input advertised.
   *
   * A target that is not mounted yet yields an empty catalog rather than a
   * throwing selector; `llm/adapters-updated` makes the GUI re-read once it is.
   */
  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    let models: readonly LlmModelInfo[]
    try {
      models = await this.deps.ctx.llm.listModels(this.targetProvider)
    } catch (error) {
      this.deps.ctx.logger?.warn?.(
        `glyphbridge: 无法列出目标路由 ${this.targetProvider} 的模型，模型选择器暂不显示 GlyphBridge 条目: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return []
    }
    return models.map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      ...(model.description === undefined ? {} : { description: model.description }),
      inputModalities: withImage(model.inputModalities),
    }))
  }

  /**
   * Mirror one exact model's capabilities. Resolution failure is deliberately
   * absorbed: an unreadable target must not turn into an admission rejection that
   * would hide the real problem behind `MODEL_DOES_NOT_SUPPORT_IMAGES`.
   */
  async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const target = await this.targetInfo(model, signal)
    return {
      provider,
      id: model,
      name: target?.name ?? model,
      ...(target?.description === undefined ? {} : { description: target.description }),
      inputModalities: withImage(target?.inputModalities),
      ...(target?.context === undefined ? {} : { context: target.context }),
      ...(target?.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: target.defaultMaxTokens }),
      ...(target?.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: target.systemPromptUpdate }),
      ...(target?.toolUpdate === undefined ? {} : { toolUpdate: target.toolUpdate }),
      ...(target?.reasoning === undefined ? {} : { reasoning: target.reasoning }),
    }
  }

  /** Exact capabilities of the real route, or `undefined` when it cannot answer. */
  private async targetInfo(model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo | undefined> {
    try {
      return await this.deps.ctx.llm.resolveModelInfo(this.targetProvider, model, signal)
    } catch (error) {
      this.deps.ctx.logger?.warn?.(
        `glyphbridge: 无法解析目标路由 ${this.targetProvider}/${model} 的模型能力，将按纯文本处理: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return undefined
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    try {
      if (options.provider === this.targetProvider) {
        throw new Error(`GlyphBridge 路由不能委托给自己（${this.targetProvider}）`)
      }
      const target = await this.targetInfo(options.model, options.signal)

      // Native vision back-off (`translate: auto`): the real route already
      // accepts images, so the request goes through untouched and no engine call
      // is made. `translate: always` opts out — the model then receives
      // structured evidence even though it could have read the pixels, which is
      // worth it when the evidence is cacheable or has to be quotable.
      if (this.deps.config.translate === 'auto' && target?.inputModalities?.includes('image') === true) {
        this.deps.ctx.logger?.debug?.(
          `glyphbridge: 目标模型 ${options.model} 原生支持图片，auto 模式下原样转发（未调用视觉引擎）`,
        )
        yield* this.forward(options, options.messages)
        return
      }

      if (!options.messages.some((message) => contentHasImage(message.content))) {
        yield* this.forward(options, options.messages)
        return
      }

      const messages = await this.translate(options.messages, options.signal)
      yield* this.forward(options, messages)
    } catch (error) {
      if (options.signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'GlyphBridge 请求已取消', code: 'ABORTED' } } }
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      this.deps.ctx.logger?.warn?.(`glyphbridge: 转译失败: ${message}`)
      yield { type: 'finish', reason: { kind: 'error', failure: { message, code: 'GLYPHBRIDGE_FAILED' } } }
    }
  }

  /**
   * Delegate one prepared request to the real adapter.
   *
   * `toolHistory` is cleared because the request handed to this adapter already
   * carries the developer messages the runtime projected for it; passing the
   * history again would let the inner dispatch append the same updates twice.
   */
  private forward(options: GenerateOptions, messages: RequestMessage[]): AsyncIterable<StreamChunk> {
    return this.deps.ctx.llm.stream({
      ...options,
      provider: this.targetProvider,
      messages,
      toolHistory: undefined,
    })
  }

  /**
   * Replace every image block with one evidence block, keeping message identity.
   *
   * Numbering follows message order, not completion order: image `#1` is always
   * the first image in the request. Blocks are translated concurrently up to
   * {@link TRANSLATION_CONCURRENCY}; a duplicate attachment inside one request is
   * produced once and shared through the memo's in-flight coalescing.
   */
  private async translate(messages: RequestMessage[], signal?: AbortSignal): Promise<RequestMessage[]> {
    const translated: RequestMessage[] = []
    const jobs: { content: ContentBlock[]; slot: number; ref: AttachmentRef; index: number; offloaded: boolean }[] = []
    let index = 0

    for (const message of messages) {
      if (!contentHasImage(message.content)) {
        translated.push(message)
        continue
      }
      const content: ContentBlock[] = []
      for (const block of message.content) {
        if (block.type !== 'image') {
          content.push(block)
          continue
        }
        index += 1
        const slot = content.push({ type: 'text', text: '' }) - 1
        jobs.push({ content, slot, ref: block.attachment, index, offloaded: block.offloaded === true })
      }
      translated.push({ ...(message as Message), content } as RequestMessage)
    }

    await mapConcurrent(jobs, TRANSLATION_CONCURRENCY, async (job) => {
      const text = await this.describeBlock(job.ref, job.index, job.offloaded, signal)
      job.content[job.slot] = { type: 'text', text }
    })

    return translated
  }

  /**
   * One image block to one evidence block. A per-image failure degrades to an
   * explicit "not translatable" text block instead of failing the whole turn:
   * the model must still answer, and it must not invent the contents.
   *
   * The bytes are read inside the pipeline's loader, so a memo hit costs no
   * attachment decode at all — the identity is known before the read.
   */
  private async describeBlock(
    ref: AttachmentRef,
    index: number,
    offloaded: boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    if (offloaded) {
      return formatEvidence(index, emptyEvidence('none:已卸载', '该图片已按请求预算卸载，未转译。'))
    }

    const attachments = this.deps.ctx.get('attachments') as AttachmentReader | undefined
    if (attachments === undefined) {
      return formatEvidence(index, emptyEvidence('none', '附件服务（attachments）未挂载，无法读取图片字节。'))
    }

    let evidence: Evidence
    try {
      evidence = await this.deps.pipeline.describe(
        async () => {
          const longEdge = Math.max(ref.width, ref.height)
          const scale = longEdge > REQUEST_IMAGE_MAX_EDGE ? REQUEST_IMAGE_MAX_EDGE / longEdge : 1
          const version = await attachments.readImageRequest(
            ref,
            {
              width: Math.max(1, Math.round(ref.width * scale)),
              height: Math.max(1, Math.round(ref.height * scale)),
              maxBytes: REQUEST_IMAGE_MAX_BYTES,
            },
            signal,
          )
          return { data: version.data, mediaType: version.mediaType }
        },
        { signal, identity: `${ref.attachmentId}|${ref.mediaType}` },
      )
    } catch (error) {
      evidence = emptyEvidence(
        'none',
        `读取图片失败：${error instanceof Error ? error.message : String(error)}。图片内容无法转译，请勿猜测其中文字。`,
      )
    }

    this.deps.ctx.logger?.info?.(`glyphbridge: 图片 #${index} 由 ${evidence.engine} 转译（${evidence.ocr.length} 字符）`)
    return formatEvidence(index, evidence)
  }
}
