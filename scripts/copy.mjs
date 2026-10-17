import { mkdirSync, copyFileSync } from 'node:fs';
mkdirSync('dist/media', { recursive: true });
for (const f of [
  'index.html',
  'bridge.js',
  'app.js',
  'style.css',
  'theme.css',
  'brand.svg',
  'dog.svg',
  'icon.png',
])
  copyFileSync('ui/' + f, 'dist/media/' + f);
