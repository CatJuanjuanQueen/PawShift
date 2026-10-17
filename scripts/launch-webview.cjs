const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const version = require('../package.json').version;
const binary = join(__dirname, `../release-webview2/PawShift-${version}/PawShift.exe`);
if (!existsSync(binary)) {
  console.error('请先运行 npm run package:dir 构建 WebView2 版本。');
  process.exit(1);
}
const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit', windowsHide: true });
child.on('exit', (code) => process.exit(code || 0));
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
