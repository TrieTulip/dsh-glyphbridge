/**
 * Local checks for the two pieces that are hard to see through the integration
 * probe: the memo's eviction/coalescing/negative rules, and the entry guards.
 */
import { EvidenceCache } from '../lib/dsh/cache.js'
import { apply, PROVIDER } from '../lib/dsh/index.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `   ${detail}` : ''}`)
  if (!ok) failures += 1
}

const evidence = (ocr) => ({ ocr, regions: [], tables: [], engine: 'primary:mock', notes: [] })
const degraded = () => ({ ocr: '', regions: [], tables: [], engine: 'none', notes: ['no engine'] })

/* ---------------------------------------------------------------- eviction */

{
  const cache = new EvidenceCache(true, 2)
  const calls = []
  const produce = (key) => async () => {
    calls.push(key)
    return evidence(key)
  }
  await cache.remember('a', produce('a'))
  await cache.remember('b', produce('b'))
  await cache.remember('a', produce('a')) // hit -> 'a' becomes most recent
  await cache.remember('c', produce('c')) // evicts 'b', the least recent
  await cache.remember('b', produce('b')) // must miss again
  check('LRU 保留最近使用、淘汰最久未用', calls.join(',') === 'a,b,c,b', `produce 顺序 = ${calls.join(',')}`)
  check('LRU 容量上限生效', cache.stats.size <= 2, `size = ${cache.stats.size}`)
}

/* -------------------------------------------------------------- coalescing */

{
  const cache = new EvidenceCache(true, 4)
  let produced = 0
  const slow = async () => {
    produced += 1
    await new Promise((resolve) => setTimeout(resolve, 30))
    return evidence('shared')
  }
  const [first, second] = await Promise.all([cache.remember('k', slow), cache.remember('k', slow)])
  check('同键并发只生产一次', produced === 1, `produce 次数 = ${produced}`)
  check('并发调用拿到同一份证据', first.evidence === second.evidence)
}

/* ------------------------------------------------------ degraded is retried */

{
  const cache = new EvidenceCache(true, 4)
  let produced = 0
  const fail = async () => {
    produced += 1
    return degraded()
  }
  await cache.remember('k', fail)
  await cache.remember('k', fail)
  check('降级记录不缓存，下一轮会重试', produced === 2, `produce 次数 = ${produced}`)
  check('降级记录不占容量', cache.stats.size === 0, `size = ${cache.stats.size}`)
}

/* ------------------------------------------------------------- disabled mode */

{
  const cache = new EvidenceCache(false, 64)
  let produced = 0
  const produce = async () => {
    produced += 1
    return evidence('x')
  }
  await cache.remember('k', produce)
  await cache.remember('k', produce)
  check('cache.enabled=false 时每次都生产', produced === 2, `produce 次数 = ${produced}`)
  check('cache.enabled=false 时不占容量', cache.stats.size === 0)
}

/* ---------------------------------------------------------------- the guards */

const config = {
  targetProvider: 'deepseek-official',
  primary: { kind: 'vlm', baseUrl: '', model: '', apiKeyEnv: '', timeoutMs: 1000 },
  fallback: { kind: 'vlm', baseUrl: '', model: '', apiKeyEnv: '', timeoutMs: 1000 },
  cache: { enabled: true, maxEntries: 4 },
  tool: { enabled: false, maxImageBytes: 1 << 20 },
}

{
  const ctx = {
    logger: {},
    llm: { registerAdapter: () => { throw new Error('registerAdapter 不该被调用') } },
    tools: { register: () => {} },
  }
  let message = ''
  try {
    apply(ctx, { ...config, targetProvider: PROVIDER })
  } catch (error) {
    message = error.message
  }
  check('拒绝对自己委托（自环）', message.includes('自环'), message)
  console.log(`      PROVIDER = ${PROVIDER}`)
}

{
  const ctx = {
    logger: {},
    llm: { registerAdapter: () => { throw new Error('registerAdapter 不该被调用') } },
    tools: { register: () => {} },
  }
  let message = ''
  try {
    apply(ctx, { ...config, targetProvider: '   ' })
  } catch (error) {
    message = error.message
  }
  check('拒绝空 targetProvider', message.length > 0, message)
}

/* ------------------------------------------------------------------ verdict */

console.log(failures === 0 ? '\nALL LOCAL CHECKS PASSED' : `\n${failures} LOCAL CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
