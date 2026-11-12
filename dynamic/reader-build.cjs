'use strict';

const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

const content = resolve(process.argv[2] || '.');
const output = resolve(process.argv[3] || 'reader-public');
const source = resolve(__dirname, '..');
const backend = 'https://stavrodromio-koinotita.onrender.com';
const origin = new URL(process.env.RENDER_EXTERNAL_URL || process.env.STAVRODROMIO_READER_ORIGIN).origin;
const stateFile = join(content, 'dynamic-content.json');
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
process.env.STAVRODROMIO_TEST_FILE = stateFile;
process.env.STAVRODROMIO_READER_BACKEND = backend;
process.env.PUBLIC_ORIGIN = origin;
const { route } = require('./server.cjs');
const original = require('./original.json');
const { articleUrl } = require('./pages.cjs');

function write(file, body) {
  const target = join(output, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}

function copy(file, root) {
  const target = join(output, file);
  if (existsSync(target)) return;
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(root, file), target);
}

async function build() {
  const server = createServer(route).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  async function get(path, status = 200) {
    const response = await fetch(base + path, { redirect: 'error' });
    assert.equal(response.status, status, path);
    return response;
  }
  try {
    const sitemap = await (await get('/sitemap.xml')).text();
    const paths = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => new URL(match[1]).pathname));
    for (const id of Object.keys({ ...original, ...state.articles })) paths.add(articleUrl(id));
    const assets = new Set();
    for (const path of paths) {
      const response = await get(path);
      const policy = response.headers.get('content-security-policy').replace(/; frame-ancestors 'self'/, '')
        .replace('form-action ', 'form-action ' + backend + ' ');
      const html = (await response.text())
        .replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="' + policy + '">')
        .replaceAll('href="/admin"', 'href="' + backend + '/admin"')
        .replaceAll('/images/history/stavrodromi-plateia.jpg', '/og-image.png')
        .replaceAll('/images/laografia/plateia-kai-giorti.jpg', '/og-image.png');
      for (const match of html.matchAll(/(?:\/uploads\/|\/images\/)[^"'<>\s,]+/g)) {
        const path = decodeURIComponent(match[0].split(/[?#]/)[0]);
        if (/\.(?:jpg|jpeg|webp|png|gif|svg|mp4)$/i.test(path) && !path.split('/').includes('..')) assets.add(path.slice(1));
      }
      const file = path.endsWith('.html') ? path.slice(1) : path.slice(1) + '/index.html';
      write(file.replace(/^\//, ''), html);
    }
    for (const asset of assets) copy(asset, asset.startsWith('uploads/') ? content : source);
    copy('og-image.png', source);
    for (const asset of ['app.js', 'site.css', 'favicon.svg', 'app-192.png', 'app-512.png',
      'fonts/source-serif-4-005-roman.woff2', 'fonts/source-serif-4-005-italic.woff2']) {
      copy(asset, __dirname);
    }
    const manifest = JSON.parse(readFileSync(join(__dirname, 'app.webmanifest'), 'utf8'));
    manifest.shortcuts = manifest.shortcuts.filter(shortcut => shortcut.url !== '/admin');
    write('app.webmanifest', JSON.stringify(manifest));
    write('rss.xml', await (await get('/rss.xml')).text());
    write('sitemap.xml', sitemap);
    write('robots.txt', 'User-agent: *\nSitemap: ' + origin + '/sitemap.xml\n');
    write('404.html', (await (await get('/reader-missing-page', 404)).text())
      .replaceAll('href="/admin"', 'href="' + backend + '/admin"'));
    console.log('Built', paths.size, 'reader pages and', assets.size, 'article assets.');
  } finally {
    server.close();
  }
}

build().catch(error => { console.error(error); process.exitCode = 1; });
