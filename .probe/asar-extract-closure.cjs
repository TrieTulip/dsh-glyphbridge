// Extract only the runtime dependency closure of a set of package roots from an
// Electron asar archive — enough to run the probes without unpacking the whole
// 236 MB shipped tree.
//
// Usage:
//   node asar-extract-closure.cjs <app.asar> <outDir> <pkg> [<pkg> ...]
//
// Layout written under <outDir>: node_modules/<pkg>/** so that a sibling script
// importing the roots by bare specifier resolves them exactly as the harness does.
const fs = require('fs')
const nodePath = require('path')

const [asarPath, outDir, ...roots] = process.argv.slice(2)
if (!asarPath || !outDir || roots.length === 0) {
  console.error('usage: node asar-extract-closure.cjs <app.asar> <outDir> <pkg> [<pkg> ...]')
  process.exit(2)
}

const fd = fs.openSync(asarPath, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerPickleSize = head.readUInt32LE(4)
const jsonLen = head.readUInt32LE(12)
const jsonBuffer = Buffer.alloc(jsonLen)
fs.readSync(fd, jsonBuffer, 0, jsonLen, 16)
const header = JSON.parse(jsonBuffer.toString('utf8'))
const baseOffset = 8 + headerPickleSize

/** path -> { size, offset } */
const files = new Map()
function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix + '/' + name
    if (entry.files) walk(entry, p)
    else files.set(p, { size: Number(entry.size || 0), offset: baseOffset + Number(entry.offset || 0) })
  }
}
walk(header, '')

function readFile(asarEntryPath) {
  const entry = files.get(asarEntryPath)
  if (!entry) throw new Error(`not in archive: ${asarEntryPath}`)
  const buf = Buffer.alloc(entry.size)
  if (entry.size) fs.readSync(fd, buf, 0, entry.size, entry.offset)
  return buf
}

/** name -> candidate package directories, shortest first (hoisted wins). */
const packages = new Map()
for (const p of files.keys()) {
  if (!p.endsWith('/package.json')) continue
  const dir = p.slice(0, -'/package.json'.length)
  if (!dir.includes('/node_modules/')) continue
  const at = dir.lastIndexOf('/node_modules/')
  const name = dir.slice(at + '/node_modules/'.length)
  if (!name || name.includes('/node_modules/')) continue
  const bucket = packages.get(name) ?? []
  bucket.push(dir)
  packages.set(name, bucket)
}
for (const bucket of packages.values()) bucket.sort((a, b) => a.length - b.length)

function resolvePackage(name) {
  const bucket = packages.get(name)
  return bucket && bucket.length > 0 ? bucket[0] : undefined
}

const closure = new Map()
const queue = [...roots]
while (queue.length > 0) {
  const name = queue.shift()
  if (closure.has(name)) continue
  const dir = resolvePackage(name)
  if (!dir) {
    console.warn('missing package:', name)
    continue
  }
  const manifest = JSON.parse(readFile(`${dir}/package.json`).toString('utf8'))
  closure.set(name, { dir, manifest })
  const deps = {
    ...(manifest.dependencies || {}),
    ...(manifest.peerDependencies || {}),
    ...(manifest.optionalDependencies || {}),
  }
  for (const dep of Object.keys(deps)) {
    if (!closure.has(dep) && resolvePackage(dep)) queue.push(dep)
  }
}

let written = 0
let bytes = 0
for (const { dir } of closure.values()) {
  const prefix = dir + '/'
  for (const [p, entry] of files) {
    if (!p.startsWith(prefix)) continue
    const rel = p.slice(prefix.length)
    const dest = nodePath.join(outDir, 'node_modules', dir.slice(dir.lastIndexOf('/node_modules/') + '/node_modules/'.length), rel)
    fs.mkdirSync(nodePath.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, readFile(p))
    written += 1
    bytes += entry.size
  }
}
fs.closeSync(fd)
console.log(`packages: ${closure.size}, files: ${written}, bytes: ${bytes} (${(bytes / 1048576).toFixed(1)} MB)`)
console.log('roots:', [...closure.keys()].sort().join(' '))
