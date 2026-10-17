const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.resolve(
  process.argv[2] ||
    path.join(root, 'release-webview2/PawShift-' + require('../package.json').version),
);
const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
let checked = 0;
function compare(source, packaged) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const a = path.join(source, entry.name),
      b = path.join(packaged, entry.name);
    if (entry.isDirectory()) compare(a, b);
    else {
      assert.equal(hash(a), hash(b), b);
      checked++;
    }
  }
}
compare(path.join(root, 'dist/src'), path.join(output, 'backend'));
compare(path.join(root, 'dist/media'), path.join(output, 'media'));
assert.equal(hash(path.join(root, 'ui/icon.ico')), hash(path.join(output, 'media/icon.ico')));
for (const file of ['LICENSE', 'NOTICE']) {
  assert.equal(hash(path.join(root, file)), hash(path.join(output, file)), file);
  checked++;
}
for (const file of ['runtime/LICENSE.txt', 'WebView2-LICENSE.txt', 'WebView2-NOTICE.txt']) {
  assert.ok(fs.statSync(path.join(output, file)).size > 0, file);
  checked++;
}
assert.ok(fs.statSync(path.join(output, 'PawShift.exe')).size > 0);
console.log(
  JSON.stringify({ passed: true, checked, executable: path.join(output, 'PawShift.exe') }),
);
