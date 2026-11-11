'use strict';

const { execFileSync } = require('node:child_process');
const { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');

const articleOrigin = 'https://stavrodromio-koinotita.onrender.com';
const shareOrigin = new URL(process.env.RENDER_EXTERNAL_URL || process.env.SHARE_ORIGIN || 'https://stavrodromio-koinotita-share.onrender.com').origin;
const source = 'https://raw.githubusercontent.com/Michelis2023/stavrodromio/stavrodromio-dynamic';
const output = 'share-public';
const temp = mkdtempSync(join(tmpdir(), 'stavrodromio-share-'));
const fallback = '/og-image.png';

function download(url, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', '--max-time', '20', '--retry', '2', '--output', destination, url]);
}

try {
  for (const file of ['pages.cjs', 'original.json', 'app.js', 'editor.js', 'site.css']) {
    download(source + '/dynamic/' + file, join(temp, file));
  }
  const { renderShare, articleUrl, thumbnail, rich, safeUrl } = require(join(temp, 'pages.cjs'));
  const original = require(join(temp, 'original.json'));
  const state = JSON.parse(readFileSync('dynamic-content.json', 'utf8'));
  const articles = { ...original, ...state.articles };
  const copied = new Map();
  mkdirSync(output, { recursive: true });
  download(source + fallback, join(output, fallback.slice(1)));

  for (const [id, updated] of Object.entries(articles)) {
    if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(id)) throw Error('Invalid article id');
    const item = { ...original[id], ...updated, id };
    if (item.blocks) item.body = rich(item.blocks);
    let image = thumbnail(item);
    if (!safeUrl(image)) image = fallback;
    if (image.startsWith('/') && image !== fallback) {
      const url = new URL(image, articleOrigin);
      const file = url.pathname.slice(1);
      if (!copied.has(file)) {
        const destination = join(output, file);
        let available = false;
        if (/^uploads\/[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(file) && existsSync(file)) {
          mkdirSync(dirname(destination), { recursive: true });
          copyFileSync(file, destination);
          available = true;
        } else if (/^images\/[\w.%/()-]+\.(?:jpe?g|png|webp)$/i.test(file)) {
          try {
            download(source + url.pathname, destination);
            available = true;
          } catch {
            console.warn('Using site image for ' + id);
          }
        }
        copied.set(file, available);
      }
      if (!copied.get(file)) image = fallback;
    }
    writeFileSync(join(output, articleUrl(id).slice(1)), renderShare(shareOrigin, articleOrigin, item, image));
  }

  writeFileSync(join(output, 'index.html'), '<!doctype html><html lang="el"><meta charset="utf-8"><title>Σταυροδρόμι Κοινότητα</title><a href="' + articleOrigin + '">Σταυροδρόμι Κοινότητα</a>');
  console.log('Built sharing pages for ' + Object.keys(articles).length + ' articles.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
