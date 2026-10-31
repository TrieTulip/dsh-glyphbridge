/**
 * Evidence vocabulary and its single textual presentation.
 *
 * Every path that reaches a model — the adapter's request rewrite and the
 * `glyphbridge_read_image` tool — renders through {@link formatEvidence}, so the
 * two surfaces cannot drift into different shapes.
 */

/** One detected layout region. `bbox` is `[x, y, width, height]` in pixels. */
export interface EvidenceRegion {
  /** Verbatim text inside the region, when the engine supplies it. */
  text: string
  /** Region kind: `title`, `paragraph`, `figure`, `formula`, `header`, `footer`, `table`, … */
  type: string
  /** Pixel bounding box, when the engine supplies one. */
  bbox?: readonly [number, number, number, number]
}

/** One table recovered from the image. */
export interface EvidenceTable {
  /** Optional caption recovered with the table. */
  title?: string
  /** Whether {@link body} is GitHub-flavored Markdown or raw HTML. */
  format: 'markdown' | 'html'
  /** The table itself. */
  body: string
}

/** Everything one engine recovered from one image. */
export interface Evidence {
  /** Full page text, reading order. */
  ocr: string
  /** Layout regions in reading order. */
  regions: readonly EvidenceRegion[]
  /** Recovered tables in reading order. */
  tables: readonly EvidenceTable[]
  /** Slot-qualified engine identity that actually produced this evidence. */
  engine: string
  /** Engine-attributable diagnostics worth showing the model (fallbacks, partial parses). */
  notes: readonly string[]
}

/** A degraded result: no engine produced evidence. */
export function emptyEvidence(engine: string, note: string): Evidence {
  return { ocr: '', regions: [], tables: [], engine, notes: [note] }
}

function formatBbox(bbox: readonly [number, number, number, number] | undefined): string {
  return bbox === undefined ? '' : ` (${bbox.map((n) => Math.round(n)).join(',')})`
}

function formatRegion(region: EvidenceRegion): string {
  const head = `- [${region.type}]${formatBbox(region.bbox)}`
  return region.text.length === 0 ? head : `${head}: ${oneLine(region.text)}`
}

/** Collapse newlines so one region stays one list item. */
function oneLine(text: string): string {
  return text.replace(/\r?\n/g, ' ⏎ ').trim()
}

/**
 * Render one evidence block.
 *
 * The first line is the contract other code and the model both key on:
 * `[图片 #N | 引擎: <slot>:<model>]`. Sections follow only when non-empty, so a
 * screenshot with no tables costs no empty table heading.
 *
 * @param index - 1-based position of this image within the request (or within the tool call).
 * @param evidence - what the winning engine recovered.
 * @returns the compact text block replacing (or standing in for) one image.
 */
export function formatEvidence(index: number, evidence: Evidence): string {
  const lines: string[] = [`[图片 #${index} | 引擎: ${evidence.engine}]`]

  if (evidence.ocr.trim().length > 0) {
    lines.push('## OCR 全文', evidence.ocr.trim())
  } else {
    lines.push('## OCR 全文', '(该引擎未返回可读文字)')
  }

  if (evidence.regions.length > 0) {
    lines.push('## 版面摘要', ...evidence.regions.map(formatRegion))
  }

  evidence.tables.forEach((table, tableIndex) => {
    lines.push(`## 表格 ${tableIndex + 1}${table.title === undefined ? '' : ` — ${table.title}`}`, table.body.trim())
  })

  if (evidence.notes.length > 0) {
    lines.push('## 引擎备注', ...evidence.notes.map((note) => `- ${note}`))
  }

  return lines.join('\n')
}
