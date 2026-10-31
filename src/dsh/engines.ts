import type { EngineConfig } from './config.js'
import type { Evidence, EvidenceRegion, EvidenceTable } from './evidence.js'

/** Bytes plus the media type the endpoint should be told about. */
export interface ImageInput {
  data: Uint8Array
  mediaType: string
}

/** One engine attempt failed for a reason worth reporting to the next slot. */
export class EngineError extends Error {
  constructor(
    readonly slot: string,
    readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`${slot}: ${reason}`, options)
    this.name = 'EngineError'
  }
}

/** A configured slot: both endpoint and model must be present, otherwise it is skipped. */
export function isConfigured(engine: EngineConfig): boolean {
  return engine.baseUrl.trim().length > 0 && engine.model.trim().length > 0
}

/** Human label for the evidence header. */
export function engineLabel(slot: string, engine: EngineConfig): string {
  return `${slot}:${engine.model.trim() || engine.baseUrl.trim()}`
}

/** Compose the outer cancellation with this engine's own attempt timeout. */
function attemptSignal(engine: EngineConfig, signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(engine.timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** Resolve one credential name to its value; `undefined` when nothing has configured it. */
export type SecretResolver = (name: string) => Promise<string | undefined>

/** The process environment as a credential source, trimmed; an empty value counts as absent. */
export function envSecret(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined || value.trim().length === 0 ? undefined : value.trim()
}

/**
 * Read the bearer token named by `apiKeyEnv`.
 *
 * The value is never inlined in configuration: the name is resolved through the
 * caller's resolver, which layers the process environment over the harness's
 * credential store, so a key stored once in the app reaches this engine too.
 * A name that resolves nowhere fails here, before any request is built, and the
 * message carries the name — never a value.
 */
async function bearer(engine: EngineConfig, secret: SecretResolver | undefined): Promise<string | undefined> {
  const name = engine.apiKeyEnv.trim()
  if (name.length === 0) return undefined
  const value = secret === undefined ? envSecret(name) : await secret(name)
  if (value === undefined) {
    throw new Error(
      `credential ${name} is not configured: export it in the launching environment or store it in the credentials seam`,
    )
  }
  return value
}

function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`
}

const STRUCTURED_PROMPT = [
  'You are an OCR and document-layout engine. Transcribe the image exactly.',
  'Answer with one JSON object and nothing else, using this shape:',
  '{"ocr":"<full text, reading order, keep line breaks>",',
  '"layout":[{"text":"<text in region>","type":"title|paragraph|figure|formula|header|footer|table","bbox":[x,y,width,height]}],',
  '"tables":[{"title":"<caption or empty>","format":"markdown|html","body":"<the table>"}]}',
  'Rules: never translate; never summarize; keep numbers and identifiers verbatim;',
  'preserve table structure as a Markdown pipe table when possible, HTML otherwise;',
  'emit bbox in pixels with the origin at the top-left. Use empty arrays when a section is absent.',
].join(' ')

/** Strip a fenced code block and any prose the model wrapped around its JSON. */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = (fenced?.[1] ?? text).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return undefined
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Treat both `[a]` and `a` as one entry list; anything else is empty. */
function asEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value === null || typeof value !== 'object') return []
  return [value]
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Accept a bounding box as `[x, y, width, height]` or as the equivalent object
 * (`{x, y, width, height}` / `{x, y, w, h}`), because OCR services use both.
 */
function asBbox(value: unknown): readonly [number, number, number, number] | undefined {
  if (Array.isArray(value)) {
    if (value.length !== 4) return undefined
    if (!value.every((part) => typeof part === 'number' && Number.isFinite(part))) return undefined
    return [value[0], value[1], value[2], value[3]]
  }
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const x = asNumber(record.x)
  const y = asNumber(record.y)
  const width = asNumber(record.width) ?? asNumber(record.w)
  const height = asNumber(record.height) ?? asNumber(record.h)
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
  return [x, y, width, height]
}

function readRegions(value: unknown): EvidenceRegion[] {
  const regions: EvidenceRegion[] = []
  for (const entry of asEntries(value)) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const text = asString(record.text) ?? asString(record.content) ?? ''
    const bbox = asBbox(record.bbox)
    if (text.length === 0 && bbox === undefined) continue
    regions.push({
      text,
      type: asString(record.type) ?? asString(record.label) ?? 'region',
      ...(bbox === undefined ? {} : { bbox }),
    })
  }
  return regions
}

function readTables(value: unknown): EvidenceTable[] {
  const tables: EvidenceTable[] = []
  for (const entry of asEntries(value)) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    // Where the body came from is itself evidence of its markup: an endpoint
    // that answers `html` is not answering Markdown, so an undeclared `format`
    // is inferred from the field that supplied the body, not defaulted.
    const html = asString(record.html)
    const markdown = asString(record.markdown)
    const body = asString(record.body) ?? html ?? markdown ?? ''
    if (body.trim().length === 0) continue
    const declared = asString(record.format)
    const format: EvidenceTable['format'] =
      declared === 'html' || declared === 'markdown' ? declared : html !== undefined ? 'html' : 'markdown'
    const title = asString(record.title)
    tables.push({ format, body, ...(title === undefined || title.length === 0 ? {} : { title }) })
  }
  return tables
}

/** Normalize any endpoint answer into evidence, tolerant of extra or renamed fields. */
function normalize(payload: unknown, engine: string, notes: string[]): Evidence {
  const record = payload === null || typeof payload !== 'object' ? {} : (payload as Record<string, unknown>)
  const ocr =
    asString(record.ocr) ??
    asString(record.text) ??
    (record.result !== null && typeof record.result === 'object'
      ? asString((record.result as Record<string, unknown>).text)
      : undefined) ??
    ''
  const layout = record.layout ?? record.regions ?? record.lines
  const tables = record.tables ?? record.table
  return {
    ocr,
    regions: readRegions(layout),
    tables: readTables(tables),
    engine,
    notes,
  }
}

/** Pull the assistant text out of an OpenAI-compatible response. */
function assistantText(payload: unknown): string {
  const record = payload as { choices?: { message?: { content?: unknown } }[] } | null
  const content = record?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part !== null && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('')
  }
  return ''
}

/**
 * Run one engine attempt.
 *
 * @param slot - `primary` or `fallback`; only used for labeling and diagnostics.
 * @param engine - the configured slot.
 * @param image - request-normalized bytes.
 * @param signal - caller cancellation; combined with the slot's own timeout.
 * @param secret - resolves `apiKeyEnv` through the environment and the harness credential store.
 * @returns evidence attributed to this exact engine.
 * @throws {EngineError} on transport, HTTP, or shape failure so the caller can fall through.
 */
export async function runEngine(
  slot: string,
  engine: EngineConfig,
  image: ImageInput,
  signal: AbortSignal | undefined,
  secret?: SecretResolver,
): Promise<Evidence> {
  const label = engineLabel(slot, engine)
  const base64 = Buffer.from(image.data).toString('base64')
  let authorization: string | undefined
  try {
    const token = await bearer(engine, secret)
    authorization = token === undefined ? undefined : `Bearer ${token}`
  } catch (error) {
    throw new EngineError(label, error instanceof Error ? error.message : String(error), { cause: error })
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authorization !== undefined) headers.authorization = authorization

  const body =
    engine.kind === 'vlm'
      ? {
          model: engine.model,
          temperature: 0,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: STRUCTURED_PROMPT },
                { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${base64}` } },
              ],
            },
          ],
        }
      : { model: engine.model, image: base64, media_type: image.mediaType }

  const url = engine.kind === 'vlm' ? chatCompletionsUrl(engine.baseUrl) : engine.baseUrl.trim()

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: attemptSignal(engine, signal),
    })
  } catch (error) {
    const aborted = signal?.aborted === true
    throw new EngineError(label, aborted ? '已取消' : `请求失败: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new EngineError(label, `HTTP ${response.status}${detail.length > 0 ? `: ${detail.slice(0, 300)}` : ''}`)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    throw new EngineError(label, '响应不是合法 JSON', { cause: error })
  }

  if (engine.kind === 'vlm') {
    const text = assistantText(payload)
    if (text.trim().length === 0) throw new EngineError(label, '响应中没有文本内容')
    const parsed = extractJson(text)
    if (parsed === undefined) {
      return { ocr: text.trim(), regions: [], tables: [], engine: label, notes: ['引擎未返回结构化 JSON，已按纯文本采纳'] }
    }
    return normalize(parsed, label, [])
  }

  return normalize(payload, label, [])
}
