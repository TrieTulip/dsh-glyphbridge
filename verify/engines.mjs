/**
 * Engine-protocol checks: the normalization tolerance the docs promise for
 * `kind: ocr`, the non-JSON rescue for `kind: vlm`, and the failure taxonomy the
 * fallback chain depends on.
 */
import { createServer } from 'node:http'
import { runEngine } from '../lib/dsh/engines.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `   ${detail}` : ''}`)
  if (!ok) failures += 1
}

const image = { data: Buffer.from('fake-bytes'), mediaType: 'image/png' }
const engine = (over) => ({ kind: 'vlm', baseUrl: '', model: 'm', apiKeyEnv: '', timeoutMs: 1500, ...over })

let mode = 'ocr'
let lastUrl = ''
let lastAuthorization = ''
const server = createServer((req, res) => {
  lastUrl = req.url
  lastAuthorization = req.headers.authorization ?? ''
  req.resume()
  req.on('end', () => {
    if (mode === 'slow') return // never answer
    if (mode === '401') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad key' }))
      return
    }
    if (mode === 'plain') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '就是一段普通文字，没有 JSON' } }] }))
      return
    }
    if (mode === 'alt') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          text: '另一家 OCR',
          lines: { text: '单条线', bbox: { x: 1, y: 2, width: 3, height: 4 } },
          table: { markdown: '| a | b |', title: '单表' },
        }),
      )
      return
    }
    // 'ocr': deliberately messy field names
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        result: { text: '发票号 12345' },
        regions: [
          { content: '增值税发票', label: 'title', bbox: [10, 12, 200, 30] },
          { text: '', bbox: [0, 0, 5, 5] }, // bbox only -> kept
          { type: 'figure' }, // no text, no bbox -> dropped
        ],
        table: [{ html: '<table><tr><td>1</td></tr></table>', title: '明细' }],
      }),
    )
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

/* ------------------------------------------------------- ocr normalization */

{
  mode = 'ocr'
  const evidence = await runEngine('fallback', engine({ kind: 'ocr', baseUrl: base, model: 'pp-ocr' }), image, undefined)
  check('ocr：result.text 被认作全文', evidence.ocr === '发票号 12345', JSON.stringify(evidence.ocr))
  check('ocr：regions → regions，label → type', evidence.regions[0]?.type === 'title', JSON.stringify(evidence.regions[0]))
  check('ocr：bbox 被保留', JSON.stringify(evidence.regions[0]?.bbox) === '[10,12,200,30]')
  check('ocr：空区域按规则取舍（有 bbox 留、全空弃）', evidence.regions.length === 2, `regions = ${evidence.regions.length}`)
  check('ocr：table → tables，format 从 html 推断', evidence.tables[0]?.format === 'html' && evidence.tables[0]?.title === '明细', JSON.stringify(evidence.tables[0]))
  check('ocr：引擎归属为 slot:model', evidence.engine === 'fallback:pp-ocr', evidence.engine)
  check('ocr：请求打到 baseUrl 原样', lastUrl === '/', `url = ${lastUrl}`)
}

/* ----------------------------------- single-object answers, object bbox */

{
  mode = 'alt'
  const evidence = await runEngine('fallback', engine({ kind: 'ocr', baseUrl: base, model: 'other-ocr' }), image, undefined)
  check('单条 regions/lines 对象被当作一条处理', evidence.regions.length === 1, `regions = ${evidence.regions.length}`)
  check('bbox 对象 {x,y,width,height} 被接受', JSON.stringify(evidence.regions[0]?.bbox) === '[1,2,3,4]', JSON.stringify(evidence.regions[0]?.bbox))
  check('单个 table 对象被当作一张表', evidence.tables.length === 1 && evidence.tables[0]?.title === '单表')
  check('markdown 正文推断为 markdown', evidence.tables[0]?.format === 'markdown', JSON.stringify(evidence.tables[0]?.format))
}

/* -------------------------------------------------- vlm non-JSON rescue path */

{
  mode = 'plain'
  const evidence = await runEngine('primary', engine({ baseUrl: base, model: 'mock-vlm' }), image, undefined)
  check('vlm：非 JSON 回答按纯文本采纳', evidence.ocr.includes('普通文字'))
  check('vlm：非 JSON 会留下引擎备注', evidence.notes.some((n) => n.includes('纯文本')), JSON.stringify(evidence.notes))
  check('vlm：引擎归属为 slot:model', evidence.engine === 'primary:mock-vlm', evidence.engine)
  check('vlm：baseUrl 自动补 /chat/completions', lastUrl === '/chat/completions', `url = ${lastUrl}`)
}

/* -------------------------------------------------------- failure taxonomy */

{
  mode = '401'
  let message = ''
  try {
    await runEngine('primary', engine({ baseUrl: base, model: 'denied' }), image, undefined)
  } catch (error) {
    message = error.message
  }
  check('HTTP 失败带状态码与响应摘要', message.startsWith('primary:denied: HTTP 401'), message)
}

{
  mode = 'slow'
  let message = ''
  const started = Date.now()
  try {
    await runEngine('primary', engine({ baseUrl: base, model: 'slow', timeoutMs: 300 }), image, undefined)
  } catch (error) {
    message = error.message
  }
  const elapsed = Date.now() - started
  check('超时按槽位 timeoutMs 截断', elapsed < 1500 && message.length > 0, `${elapsed}ms / ${message}`)
}

{
  let message = ''
  try {
    await runEngine('primary', engine({ baseUrl: base, model: 'x', apiKeyEnv: 'GLYPHBRIDGE_MISSING_KEY' }), image, undefined)
  } catch (error) {
    message = error.message
  }
  check('未配置的凭据名在请求前就失败并点名', message.includes('GLYPHBRIDGE_MISSING_KEY'), message)
}

/* ------------------------------------------------- credential seam (0.3.0) */

{
  mode = 'ocr'
  // The harness stores keys in `.credentials.yaml`, not in process.env; the
  // resolver is how a stored key reaches the engine.
  const stored = { DEEPSEEK_API_KEY: 'sk-from-credential-store' }
  const resolver = async (name) => stored[name]
  const evidence = await runEngine(
    'primary',
    engine({ kind: 'ocr', baseUrl: base, model: 'stored-key' , apiKeyEnv: 'DEEPSEEK_API_KEY' }),
    image,
    undefined,
    resolver,
  )
  check('凭据解析器提供的密钥进入 Authorization', lastAuthorization === 'Bearer sk-from-credential-store', lastAuthorization)
  check('有密钥时请求正常完成', evidence.ocr === '发票号 12345', JSON.stringify(evidence.ocr))
}

{
  // A resolver that knows nothing about the name must fail like an unset variable,
  // not send an unauthenticated request.
  let message = ''
  try {
    await runEngine(
      'primary',
      engine({ baseUrl: base, model: 'x', apiKeyEnv: 'NOT_STORED_ANYWHERE' }),
      image,
      undefined,
      async () => undefined,
    )
  } catch (error) {
    message = error.message
  }
  check('解析不到时不发请求，并点名凭据', message.includes('NOT_STORED_ANYWHERE'), message)
}

/* ------------------------------------------------------------- cancellation */

{
  mode = 'ocr'
  let message = ''
  try {
    await runEngine('primary', engine({ baseUrl: base, model: 'cancelled' }), image, AbortSignal.abort())
  } catch (error) {
    message = error.message
  }
  check('外部取消被识别为「已取消」而不是普通网络错误', message.includes('已取消'), message)
}

server.close()
console.log(failures === 0 ? '\nALL ENGINE CHECKS PASSED' : `\n${failures} ENGINE CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
