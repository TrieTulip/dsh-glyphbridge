import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { PluginConfig } from './config.js';
import type { VisionPipeline } from './pipeline.js';
export interface AdapterDeps {
    ctx: Context;
    config: PluginConfig;
    pipeline: VisionPipeline;
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
export declare class GlyphBridgeAdapter extends LlmAdapter {
    private readonly deps;
    constructor(deps: AdapterDeps);
    private get targetProvider();
    providerInfo(provider: string): {
        id: string;
        name: string;
    };
    /**
     * Mirror the target catalog so the GUI selector can offer every real model
     * through the twin route, with image input advertised.
     *
     * A target that is not mounted yet yields an empty catalog rather than a
     * throwing selector; `llm/adapters-updated` makes the GUI re-read once it is.
     */
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    /**
     * Mirror one exact model's capabilities. Resolution failure is deliberately
     * absorbed: an unreadable target must not turn into an admission rejection that
     * would hide the real problem behind `MODEL_DOES_NOT_SUPPORT_IMAGES`.
     */
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /** Exact capabilities of the real route, or `undefined` when it cannot answer. */
    private targetInfo;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /**
     * Delegate one prepared request to the real adapter.
     *
     * `toolHistory` is cleared because the request handed to this adapter already
     * carries the developer messages the runtime projected for it; passing the
     * history again would let the inner dispatch append the same updates twice.
     */
    private forward;
    /**
     * Replace every image block with one evidence block, keeping message identity.
     *
     * Numbering follows message order, not completion order: image `#1` is always
     * the first image in the request. Blocks are translated concurrently up to
     * {@link TRANSLATION_CONCURRENCY}; a duplicate attachment inside one request is
     * produced once and shared through the memo's in-flight coalescing.
     */
    private translate;
    /**
     * One image block to one evidence block. A per-image failure degrades to an
     * explicit "not translatable" text block instead of failing the whole turn:
     * the model must still answer, and it must not invent the contents.
     *
     * The bytes are read inside the pipeline's loader, so a memo hit costs no
     * attachment decode at all — the identity is known before the read.
     */
    private describeBlock;
}
