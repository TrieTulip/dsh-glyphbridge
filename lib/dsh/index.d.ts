import type { Context } from '@deepseek-ai/cordis';
import { Config, type PluginConfig } from './config.js';
/** Loader identity for this plugin entry. */
export declare const name = "glyphbridge";
/**
 * `llm` is where the companion route is registered; `tools` is where the
 * fallback read tool is registered. Both are hard dependencies — a GlyphBridge
 * without them has nothing it can honestly claim to do.
 */
export declare const inject: string[];
export { Config };
export type { PluginConfig };
/** The one provider route this plugin owns. */
export declare const PROVIDER = "glyphbridge";
/**
 * Mount GlyphBridge.
 *
 * Everything registered here is a reversible side effect of this plugin's fiber:
 * unmounting removes the companion route and the tool, and the pure-text
 * provider immediately returns to its original admission behaviour.
 *
 * @param ctx - plugin context carrying the `llm` and `tools` services.
 * @param config - resolved plugin configuration (whole-object, never deep-merged).
 */
export declare function apply(ctx: Context, config: PluginConfig): void;
