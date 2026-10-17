/* Rasterize the editable brand mark for the Windows host. No network needed. */
const { chromium } = require('playwright');
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const path = require('node:path');
(async () => {
  const edge = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].find(existsSync);
  const browser = await chromium.launch({
    headless: true,
    ...(edge ? { executablePath: edge } : {}),
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 256, height: 256 },
      deviceScaleFactor: 1,
    });
    const svg = readFileSync(path.join(__dirname, '../ui/brand.svg'), 'utf8');
    await page.setContent(
      '<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>' +
        svg,
    );
    const images = [];
    for (const size of [16, 24, 32, 48, 64, 128, 256]) {
      await page.setViewportSize({ width: size, height: size });
      const png = await page.screenshot({ omitBackground: true });
      images.push({ size, png });
      if (size === 256) writeFileSync(path.join(__dirname, '../ui/icon.png'), png);
    }
    const header = Buffer.alloc(6 + 16 * images.length);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);
    let offset = header.length;
    images.forEach(({ size, png }, i) => {
      const entry = 6 + i * 16;
      header[entry] = size === 256 ? 0 : size;
      header[entry + 1] = size === 256 ? 0 : size;
      header.writeUInt16LE(1, entry + 4);
      header.writeUInt16LE(32, entry + 6);
      header.writeUInt32LE(png.length, entry + 8);
      header.writeUInt32LE(offset, entry + 12);
      offset += png.length;
    });
    writeFileSync(
      path.join(__dirname, '../ui/icon.ico'),
      Buffer.concat([header, ...images.map((i) => i.png)]),
    );
    console.log('Exported icon.png and seven Windows icon sizes from brand.svg');
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
