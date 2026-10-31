import z from '@deepseek-ai/schemastery'

/**
 * Vision engine kinds.
 *
 * - `vlm` — an OpenAI-compatible `/chat/completions` endpoint that accepts an
 *   `image_url` data URL and answers with structured JSON (ocr / layout / tables).
 * - `ocr` — an OCR API that accepts `{ image, media_type, model? }` as JSON and
 *   answers with `{ text, layout?, tables? }`.
 */
export const ENGINE_KINDS = ['vlm', 'ocr'] as const
export type EngineKind = (typeof ENGINE_KINDS)[number]

/**
 * How an image is handled when the target model can see images itself.
 *
 * - `auto` — defer to the target: forward the request untouched and make no
 *   engine call. The bridge only steps in where it is needed.
 * - `always` — translate anyway: the model receives structured evidence
 *   (OCR text, layout boxes, tables) instead of pixels, even though it could
 *   have read the image. Useful when the evidence — cacheable, quotable,
 *   cheap to replay — is worth more than the raw image.
 */
export const TRANSLATE_MODES = ['auto', 'always'] as const
export type TranslateMode = (typeof TRANSLATE_MODES)[number]

/** One engine slot. Credentials are named, never inlined. */
export interface EngineConfig {
  /** Wire protocol of the endpoint. */
  kind: EngineKind
  /** Endpoint base URL. Empty means "this slot is not configured". */
  baseUrl: string
  /** Model id sent to the endpoint. Empty means "this slot is not configured". */
  model: string
  /** Environment variable holding the bearer token. Empty means "no credential". */
  apiKeyEnv: string
  /** Per-attempt timeout for this engine, in milliseconds. */
  timeoutMs: number
}

/** Plugin configuration, declared whole and replaced whole by a patch entry. */
export interface PluginConfig {
  /** Provider route GlyphBridge delegates to. Must be a real, already-registered route. */
  targetProvider: string
  /** Whether a target that can see images itself is bypassed (`auto`) or translated anyway (`always`). */
  translate: TranslateMode
  /** Primary vision engine. */
  primary: EngineConfig
  /** Backup vision engine, used when the primary fails or is unconfigured. */
  fallback: EngineConfig
  /** Evidence memo, shared by the request rewrite and the tool. */
  cache: {
    /** Remember translations so a repeated image costs no engine call. */
    enabled: boolean
    /** Hard ceiling on retained translations; `0` disables retention. */
    maxEntries: number
  }
  /** Tool surface switch and hard read limits. */
  tool: {
    /** Register `glyphbridge_read_image`. */
    enabled: boolean
    /** Largest image the tool will read from disk or fetch over HTTP. */
    maxImageBytes: number
  }
}

const Engine = z.object({
  kind: z.union(ENGINE_KINDS).default('vlm'),
  baseUrl: z.string().default(''),
  model: z.string().default(''),
  apiKeyEnv: z.string().default(''),
  timeoutMs: z.number().step(1).min(1).default(20_000),
})

/**
 * The loader resolves this schema before `apply()` runs, so every default below
 * is the value a profile sees when its patch entry omits the field. No secret is
 * ever defaulted here: `apiKeyEnv` names a variable, and both engine slots start
 * unconfigured so a bare install registers the route without pretending to see.
 */
export const Config = z.object({
  targetProvider: z.string().default('deepseek-official'),
  translate: z.union(TRANSLATE_MODES).default('auto'),
  primary: Engine.default({ kind: 'vlm', baseUrl: '', model: '', apiKeyEnv: '', timeoutMs: 20_000 }),
  fallback: Engine.default({ kind: 'vlm', baseUrl: '', model: '', apiKeyEnv: '', timeoutMs: 20_000 }),
  cache: z
    .object({
      enabled: z.boolean().default(true),
      maxEntries: z.number().step(1).min(0).default(64),
    })
    .default({ enabled: true, maxEntries: 64 }),
  tool: z
    .object({
      enabled: z.boolean().default(true),
      maxImageBytes: z.number().step(1).min(1).default(16 * 1024 * 1024),
    })
    .default({ enabled: true, maxImageBytes: 16 * 1024 * 1024 }),
})
