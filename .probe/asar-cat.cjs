// Print one file from an Electron asar archive to stdout, without extracting it.
// Usage: node asar-cat.cjs <app.asar> <path-inside-archive>
const fs = require('fs')

const [asarPath, want] = process.argv.slice(2)
if (!asarPath || !want) {
  console.error('usage: node asar-cat.cjs <app.asar> <path-inside-archive>')
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

let found
function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix + '/' + name
    if (entry.files) walk(entry, p)
    else if (p === want) found = entry
  }
}
walk(header, '')

if (!found) {
  console.error(`not in archive: ${want}`)
  process.exit(1)
}
const buf = Buffer.alloc(Number(found.size))
if (buf.length) fs.readSync(fd, buf, 0, buf.length, 8 + headerPickleSize + Number(found.offset))
fs.closeSync(fd)
process.stdout.write(buf)
