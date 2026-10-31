// Minimal asar extractor (single-file, no deps). Usage: node asar-extract.js <asar> <outDir> [pathPrefix]
const fs = require('fs');
const nodePath = require('path');

const asarPath = process.argv[2];
const outDir = process.argv[3];
const prefix = process.argv[4] || '';

const fd = fs.openSync(asarPath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerPickleSize = head.readUInt32LE(4); // size of the pickle payload after these 8 bytes
const jsonLen = head.readUInt32LE(12);
const jb = Buffer.alloc(jsonLen);
fs.readSync(fd, jb, 0, jsonLen, 16);
const header = JSON.parse(jb.toString('utf8'));

// Data section starts at 8 + headerPickleSize
const baseOffset = 8 + headerPickleSize;

let count = 0;
function walk(node, pathSoFar) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = pathSoFar + '/' + name;
    if (entry.files) {
      walk(entry, p);
      continue;
    }
    if (!p.startsWith(prefix)) continue;
    const rel = p.slice(prefix.length).replace(/^\/+/, '');
    const dest = nodePath.join(outDir, rel);
    fs.mkdirSync(nodePath.dirname(dest), { recursive: true });
    const size = Number(entry.size || 0);
    const offset = baseOffset + Number(entry.offset || 0);
    const buf = Buffer.alloc(size);
    if (size) fs.readSync(fd, buf, 0, size, offset);
    fs.writeFileSync(dest, buf);
    count++;
  }
}
fs.mkdirSync(outDir, { recursive: true });
walk(header, '');
fs.closeSync(fd);
console.log('extracted files:', count, '-> ', outDir);
