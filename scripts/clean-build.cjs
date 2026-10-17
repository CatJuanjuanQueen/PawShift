const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.resolve(root, 'dist');
if (output !== path.join(root, 'dist')) throw Error('Unsafe build output path');
fs.rmSync(output, { recursive: true, force: true });
