import type { Context } from '@deepseek-ai/cordis'
import { GlyphBridgeAdapter } from './adapter.js'
import { Config, type PluginConfig } from './config.js'
import { VisionPipeline } from './pipeline.js'
import { registerReadImageTool } from './tool.js'

/** Loader identity for this plugin entry. */
export const name = 'glyphbridge'

/**
 * `llm` is where the companion route is registered; `tools` is where the
 * fallback read tool is registered. Both are hard dependencies — a GlyphBridge
 * without them has nothing it can honestly claim to do.
 */
export const inject = ['tools', 'llm']

export { Config }
export type { PluginConfig }

/** The one provider route this plugin owns. */
export const PROVIDER = 'glyphbridge'

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
export function apply(ctx: Context, config: PluginConfig): void {
  if (config.targetProvider.trim().length === 0) {
    throw new Error('glyphbridge: targetProvider 不能为空')
  }
  if (config.targetProvider.trim() === PROVIDER) {
    throw new Error(`glyphbridge: targetProvider 不能是伴生路由自身（${PROVIDER}），否则委托形成自环`)
  }

  const pipeline = new VisionPipeline(ctx, config)
  const adapter = new GlyphBridgeAdapter({ ctx, config, pipeline })

  ctx.llm.registerAdapter([PROVIDER], adapter)
  ctx.logger?.info?.(
    `glyphbridge: 伴生路由 "${PROVIDER}" 已注册，委托至 "${config.targetProvider}"；多模态策略 ${
      config.translate === 'always' ? 'always（一律转译为证据）' : 'auto（目标能看图则退让）'
    }；视觉引擎 ${pipeline.hasEngine() ? '已配置' : '未配置（图片将得到显式失败说明）'}；证据缓存 ${
      config.cache.enabled && config.cache.maxEntries > 0 ? `开启（上限 ${config.cache.maxEntries} 条）` : '关闭'
    }`,
  )

  if (config.tool.enabled) registerReadImageTool(ctx, { pipeline, config })
}
