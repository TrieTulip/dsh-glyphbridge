import type { Context } from '@deepseek-ai/cordis';
import { type CacheStats } from './cache.js';
import type { PluginConfig } from './config.js';
import { type Evidence } from './evidence.js';
import { type ImageInput } from './engines.js';
/** Caller-supplied context for one translation. */
export interface DescribeOptions {
    /** Cancellation of the whole request. */
    signal?: AbortSignal;
    /**
     * Stable identity of the image when the caller has one (an attachment id).
     *
     * When supplied, the memo can answer without the caller reading the image at
     * all, so a repeated turn costs neither a decode nor an engine call. When
     * omitted (a file path or URL, whose bytes may change), identity falls back to
     * a digest of the bytes that were actually translated.
     */
    identity?: string;
}
/**
 * The translation pipeline: one image in, one evidence record out.
 *
 * Both surfaces use this class and nothing else — the adapter's request rewrite
 * and the `glyphbridge_read_image` tool — so the memo, the fallback chain, the
 * attribution rule, and the evidence shape are identical wherever they are
 * produced.
 */
export declare class VisionPipeline {
    private readonly ctx;
    private readonly config;
    private readonly cache;
    /**
     * Identity of the configured engine chain. Part of every memo key, so editing
     * `primary`/`fallback` can never serve text an engine that is no longer
     * configured would not have produced.
     */
    private readonly chainKey;
    constructor(ctx: Context, config: PluginConfig);
    /** Slots that can actually be attempted, in order, with exact duplicates dropped. */
    private candidates;
    /** Whether at least one engine is configured. Used for honest diagnostics. */
    hasEngine(): boolean;
    /** Credential lookup shared by every engine attempt: environment first, then the seam. */
    private readonly secrets;
    /** Current memo counters, for diagnostics. */
    get cacheStats(): CacheStats;
    /**
     * Transcribe one image, answering from the memo when this exact image was
     * already translated under this exact engine chain.
     *
     * @param load - reads the image bytes; not called when the memo answers.
     * @param options - cancellation and optional stable image identity.
     * @returns evidence, degraded (never thrown) when every slot fails.
     */
    describe(load: () => Promise<ImageInput>, options?: DescribeOptions): Promise<Evidence>;
    /** One diagnostic line per translation, naming whether the memo answered. */
    private note;
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
    private transcribe;
}
