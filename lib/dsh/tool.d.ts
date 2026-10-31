import type { Context } from '@deepseek-ai/cordis';
import type { PluginConfig } from './config.js';
import type { VisionPipeline } from './pipeline.js';
/** Recognize the raster formats the attachment service also accepts. */
export declare function sniffMediaType(data: Uint8Array, hint?: string): string;
export interface ToolDeps {
    pipeline: VisionPipeline;
    config: PluginConfig;
}
/**
 * Register `glyphbridge_read_image`.
 *
 * The tool exists so the bridge keeps working when an image never entered the
 * session — a path the model was told about, a URL in a document — and so a
 * translation can be re-run without re-attaching. It renders through the same
 * `formatEvidence`, producing the identical block the adapter would have
 * produced inline.
 */
export declare function registerReadImageTool(ctx: Context, deps: ToolDeps): void;
