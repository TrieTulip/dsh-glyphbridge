import { defineTool } from '@deepseek-ai/dsh-tools';
import { formatEvidence } from './evidence.js';
/** Recognize the raster formats the attachment service also accepts. */
export function sniffMediaType(data, hint) {
    const declared = hint?.split(';')[0]?.trim().toLowerCase();
    if (declared !== undefined && /^image\/(png|jpeg|webp|gif)$/.test(declared))
        return declared;
    const png = data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
    if (png)
        return 'image/png';
    const jpeg = data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    if (jpeg)
        return 'image/jpeg';
    const gif = data.length > 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46;
    if (gif)
        return 'image/gif';
    const webp = data.length > 12 &&
        data[0] === 0x52 &&
        data[1] === 0x49 &&
        data[2] === 0x46 &&
        data[3] === 0x46 &&
        data[8] === 0x57 &&
        data[9] === 0x45 &&
        data[10] === 0x42 &&
        data[11] === 0x50;
    if (webp)
        return 'image/webp';
    throw new Error('无法识别图片格式（仅支持 PNG / JPEG / WebP / GIF）');
}
async function fetchImage(url, maxBytes, signal) {
    const response = await fetch(url, { signal });
    if (!response.ok)
        throw new Error(`下载图片失败：HTTP ${response.status}`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > maxBytes)
        throw new Error(`图片 ${data.byteLength} 字节，超过上限 ${maxBytes} 字节`);
    return { data, mediaType: sniffMediaType(data, response.headers.get('content-type') ?? undefined) };
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
export function registerReadImageTool(ctx, deps) {
    const maxBytes = deps.config.tool.maxImageBytes;
    ctx.tools.register(defineTool({
        name: 'glyphbridge_read_image',
        description: 'Transcribe one image into structured text evidence: full OCR text, layout regions with bounding boxes, and tables (Markdown or HTML). ' +
            'Accepts a local file path or an http(s) image URL. Use this when a message references an image you cannot see directly.',
        parameters: {
            path: {
                type: 'string',
                description: 'Local image path (resolved in this execution world). Provide this or `url`, not both.',
            },
            url: {
                type: 'string',
                description: 'http(s) URL of the image. Provide this or `path`, not both.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    text: { type: 'string', required: true },
                    engine: { type: 'string', required: true },
                    source: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        timeoutMs: 180_000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const path = typeof args.path === 'string' && args.path.length > 0 ? args.path : undefined;
            const url = typeof args.url === 'string' && args.url.length > 0 ? args.url : undefined;
            if ((path === undefined) === (url === undefined))
                throw new Error('必须且只能提供 `path` 或 `url` 之一');
            let image;
            let source;
            if (url !== undefined) {
                image = await fetchImage(url, maxBytes, exec.signal);
                source = url;
            }
            else {
                const fs = ctx.get('fs');
                if (fs === undefined)
                    throw new Error('文件系统服务（fs）未挂载，无法按路径读取图片');
                const target = await fs.resolve(path, { signal: exec.signal });
                const data = await fs.readBytes(target, exec.signal, maxBytes);
                image = { data, mediaType: sniffMediaType(data) };
                source = path;
            }
            if (!deps.pipeline.hasEngine()) {
                throw new Error('GlyphBridge 没有配置可用的视觉引擎（primary / fallback 的 baseUrl 与 model 均为空）');
            }
            // The bytes are already in hand, and a path or URL is not an identity
            // (the file behind it can change), so the pipeline keys by the content.
            const evidence = await deps.pipeline.describe(async () => image, { signal: exec.signal });
            return { text: formatEvidence(1, evidence), engine: evidence.engine, source };
        },
    }));
}
