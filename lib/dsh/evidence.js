/**
 * Evidence vocabulary and its single textual presentation.
 *
 * Every path that reaches a model — the adapter's request rewrite and the
 * `glyphbridge_read_image` tool — renders through {@link formatEvidence}, so the
 * two surfaces cannot drift into different shapes.
 */
/** A degraded result: no engine produced evidence. */
export function emptyEvidence(engine, note) {
    return { ocr: '', regions: [], tables: [], engine, notes: [note] };
}
function formatBbox(bbox) {
    return bbox === undefined ? '' : ` (${bbox.map((n) => Math.round(n)).join(',')})`;
}
function formatRegion(region) {
    const head = `- [${region.type}]${formatBbox(region.bbox)}`;
    return region.text.length === 0 ? head : `${head}: ${oneLine(region.text)}`;
}
/** Collapse newlines so one region stays one list item. */
function oneLine(text) {
    return text.replace(/\r?\n/g, ' ⏎ ').trim();
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
export function formatEvidence(index, evidence) {
    const lines = [`[图片 #${index} | 引擎: ${evidence.engine}]`];
    if (evidence.ocr.trim().length > 0) {
        lines.push('## OCR 全文', evidence.ocr.trim());
    }
    else {
        lines.push('## OCR 全文', '(该引擎未返回可读文字)');
    }
    if (evidence.regions.length > 0) {
        lines.push('## 版面摘要', ...evidence.regions.map(formatRegion));
    }
    evidence.tables.forEach((table, tableIndex) => {
        lines.push(`## 表格 ${tableIndex + 1}${table.title === undefined ? '' : ` — ${table.title}`}`, table.body.trim());
    });
    if (evidence.notes.length > 0) {
        lines.push('## 引擎备注', ...evidence.notes.map((note) => `- ${note}`));
    }
    return lines.join('\n');
}
