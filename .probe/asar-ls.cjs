// Minimal asar header reader — prints the JSON file index without extracting payloads.
const fs = require('fs');
const path = process.argv[2];
const filter = process.argv[3] || null;
const fd = fs.openSync(path, 'r');
const b = Buffer.alloc(16);
fs.readSync(fd, b, 0, 16, 0);
const jsonLen = b.readUInt32LE(12);
const jb = Buffer.alloc(jsonLen);
fs.readSync(fd, jb, 0, jsonLen, 16);
const header = JSON.parse(jb.toString('utf8'));
function walk(node, prefix) {
  for (const [k, v] of Object.entries(node.files || {})) {
    const p = prefix + '/' + k;
    if (v.files) walk(v, p);
    else {
      if (!filter || p.includes(filter)) console.log(String(v.size).padStart(10), p);
    }
  }
}
walk(header, '');
