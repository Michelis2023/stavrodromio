'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('node:http');
const { randomBytes, createHash } = require('node:crypto');
const { render, sections, statuses, articleUrl, rich, safeUrl } = require('./pages.cjs');
const original = require('./original.json');
const baseline = require('./baseline.json');
const repo = 'Michelis2023/stavrodromio';
const branch = 'stavrodromio-content';
const legacy = 'https://michelis2023.github.io/stavrodromio';
const raw = 'https://raw.githubusercontent.com/' + repo + '/' + branch;
const repoApi = '/repos/' + repo;
const sourceRoot = path.resolve(__dirname, '..');
const local = process.env.STAVRODROMIO_TEST_FILE;
const secure = !!process.env.RENDER || process.env.PUBLIC_ORIGIN?.startsWith('https:');
const sessions = new Map();
const attempts = new Map();
const maxAge = 6 * 3600;
let cache = { state: baseline, until: 0 };
let pending;
const hash = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
const validId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,95}$/.test(value);
const failure = (status, message) => Object.assign(new Error(message), { status });
const known = (obj, key) => typeof key === 'string' && Object.hasOwn(obj, key);
const merged = state => {
  const all = { ...original };
  for (const [id, item] of Object.entries(state.articles)) {
    all[id] = { ...all[id], ...item, id };
    if (item.blocks) all[id].body = rich(item.blocks);
  }
  return all;
};

async function gh(resource, token, method = 'GET', body) {
  const response = await fetch('https://api.github.com' + resource, {
    method, redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Stavrodromio-CMS', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.ok) return response.json();
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw failure(response.status, 'Έλεγξε την πρόσβαση GitHub και την άδεια εγγραφής στο αποθετήριο.');
  }
  if (response.status === 409 || response.status === 422) throw failure(409, 'Η αποθήκευση συγκρούστηκε με άλλη αλλαγή. Φόρτωσε ξανά το άρθρο.');
  throw failure(502, 'Το GitHub δεν ολοκλήρωσε την αποθήκευση. Δοκίμασε ξανά.');
}

function readLocal() {
  try { return JSON.parse(fs.readFileSync(local, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return baseline; throw error; }
}

async function publicState() {
  if (local) return readLocal();
  if (Date.now() < cache.until) return cache.state;
  if (!pending) {
    const previous = cache;
    pending = (async () => {
      try {
        const result = await fetch(raw + '/dynamic-content.json?v=' + Math.floor(Date.now() / 45000), {
          signal: AbortSignal.timeout(2600),
        });
        if (!result.ok) throw Error('Unavailable');
        const state = await result.json();
        if (!state.articles || !Array.isArray(state.issues)) throw Error('Invalid content');
        if (cache === previous) cache = { state, until: Date.now() + 45000 };
      } catch {
        if (cache === previous) cache = { state: cache.state, until: Date.now() + 8000 };
      }
      return cache.state;
    })().finally(() => { pending = null; });
  }
  return pending;
}

async function head(token) {
  const ref = await gh(repoApi + '/git/ref/heads/' + branch, token);
  const sha = ref.object.sha;
  const [file, commit] = await Promise.all([
    gh(repoApi + '/contents/dynamic-content.json?ref=' + sha, token),
    gh(repoApi + '/git/commits/' + sha, token),
  ]);
  return { sha, tree: commit.tree.sha, state: JSON.parse(Buffer.from(file.content, 'base64')) };
}

const adminState = async token => local ? readLocal() : (await head(token)).state;

async function save(token, update, message, image) {
  if (local) {
    const state = update(readLocal());
    if (image) {
      const destination = path.join(path.dirname(local), image.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, image.bytes);
    }
    fs.writeFileSync(local + '.tmp', JSON.stringify(state));
    fs.renameSync(local + '.tmp', local);
    return state;
  }
  const current = await head(token);
  const state = update(current.state);
  const data = JSON.stringify(state, null, 2);
  if (Buffer.byteLength(data) > 900000) throw failure(413, 'Το αρχείο δημοσιεύσεων έφτασε στο όριο αποθήκευσης.');
  const tree = [{ path: 'dynamic-content.json', mode: '100644', type: 'blob', content: data }];
  if (image) {
    const blob = await gh(repoApi + '/git/blobs', token, 'POST', { content: image.bytes.toString('base64'), encoding: 'base64' });
    tree.push({ path: image.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const nextTree = await gh(repoApi + '/git/trees', token, 'POST', { base_tree: current.tree, tree });
  const commit = await gh(repoApi + '/git/commits', token, 'POST', { message, tree: nextTree.sha, parents: [current.sha] });
  await gh(repoApi + '/git/refs/heads/' + branch, token, 'PATCH', { sha: commit.sha, force: false });
  cache = { state, until: Date.now() + 45000 };
  return state;
}

function cover(value) {
  if (!value) return null;
  const match = typeof value === 'string' && /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw failure(400, 'Διάλεξε εικόνα JPG, PNG ή WebP.');
  const [, format, base64] = match;
  const bytes = Buffer.from(base64, 'base64');
  const valid = format === 'jpeg' ? bytes.subarray(0, 3).toString('hex') === 'ffd8ff'
    : format === 'png' ? bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
    : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  if (!valid || bytes.length > 3 * 1024 * 1024) throw failure(400, 'Διάλεξε έγκυρη εικόνα έως 3 MB.');
  return { bytes, path: 'uploads/' + createHash('sha256').update(bytes).digest('hex') + '.' + (format === 'jpeg' ? 'jpg' : format) };
}

function field(value, limit, required = false) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > limit || (required && !text)) throw failure(400, 'Έλεγξε τα υποχρεωτικά πεδία και το μήκος τους.');
  return text;
}
function date(value) {
  const d = typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) && new Date(value + 'T12:00:00Z');
  if (!d || !Number.isFinite(+d) || d.toISOString().slice(0, 10) !== value) throw failure(400, 'Συμπλήρωσε έγκυρη ημερομηνία.');
  return value;
}
function articleInput(input, existing, image, id) {
  const title = field(input.title, 240, true);
  if (!known(sections, input.category)) throw failure(400, 'Διάλεξε ενότητα.');
  const imageUrl = field(input.image, 1600);
  if (!image && imageUrl && !safeUrl(imageUrl)) throw failure(400, 'Έλεγξε τη διεύθυνση της εικόνας.');
  const fields = { title, date: date(input.date), author: field(input.author, 120), summary: field(input.summary, 800, true),
    deck: field(input.deck, 2400), image: image ? '/' + image.path : imageUrl,
    sections: existing?.sections[0] === input.category ? existing.sections : [input.category],
    hero: input.hero === true, alt: field(input.alt, 300), caption: field(input.caption, 500) };
  if (input.blocks !== undefined) {
    if (!Array.isArray(input.blocks) || JSON.stringify(input.blocks).length > 300000) throw failure(400, 'Το κείμενο ξεπερνά το όριο.');
    fields.blocks = input.blocks;
  }
  const body = fields.blocks ? rich(fields.blocks) : existing?.body;
  if (!body?.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').trim()) throw failure(400, 'Συμπλήρωσε το κείμενο του άρθρου.');
  return { fields, item: { ...existing, ...fields, id, body } };
}
const dashboard = state => ({ featured: state.featured,
  articles: Object.values(merged(state)).map(({ blocks, ...item }) => ({ ...item, rev: hash(state.articles[item.id]) })),
  issues: state.issues.map(item => ({ ...item, rev: hash(item) })),
});

function respond(res, code, body, type, headers = {}) {
  res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin', ...headers });
  res.end(body);
}
const js = (res, code, value, headers) => respond(res, code, JSON.stringify(value), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store', ...headers });
const html = (res, code, value, extra) => respond(res, code, value, 'text/html; charset=utf-8', {
  'Cache-Control': 'no-cache',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https: data:; frame-src 'self' blob:; frame-ancestors 'self'; form-action 'self' https://formspree.io; base-uri 'none'; object-src 'none'",
  ...extra,
});
const cookie = (id, age) => 'stavrodromio=' + id + '; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=' + age + (secure ? '; Secure' : '');
async function requestBody(req, max = 5000000) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw failure(415, 'Μη υποστηριζόμενη μορφή αιτήματος.');
  if (Number(req.headers['content-length']) > max) throw failure(413, 'Το αίτημα ξεπερνά το όριο.');
  const parts = [];
  let bytes = 0;
  for await (const part of req) {
    bytes += part.length;
    if (bytes > max) throw failure(413, 'Το αίτημα ξεπερνά το όριο.');
    parts.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* invalid JSON */ }
  throw failure(400, 'Το αίτημα δεν διαβάστηκε.');
}
async function admin(req, res, p, origin) {
  const post = req.method === 'POST';
  if (!post && req.method !== 'GET') throw failure(405, 'Μη επιτρεπτό αίτημα.');
  if (post && req.headers.origin !== origin) throw failure(403, 'Μη επιτρεπτή προέλευση.');
  const id = req.headers.cookie?.match(/(?:^|;\s*)stavrodromio=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (p === 'login' && post) {
    const address = process.env.RENDER ? (req.headers['x-forwarded-for'] || '').split(',').at(-1).trim() : req.socket.remoteAddress;
    const previous = attempts.get(address);
    const entry = previous?.until > Date.now() ? previous : { count: 0, until: Date.now() + 600000 };
    if (++entry.count > 10) throw failure(429, 'Πολλές προσπάθειες. Δοκίμασε σε λίγα λεπτά.');
    attempts.set(address, entry);
    const { token } = await requestBody(req, 1024);
    if (local) {
      if (!process.env.STAVRODROMIO_TEST_PASSWORD || token !== process.env.STAVRODROMIO_TEST_PASSWORD) throw failure(401, 'Ο κωδικός δεν έγινε δεκτός.');
    } else {
      if (typeof token !== 'string' || !/^github_pat_[A-Za-z0-9_]{40,250}$/.test(token)) throw failure(401, 'Χρειάζεται κλειδί περιορισμένης πρόσβασης GitHub.');
      const owner = await gh('/user', token);
      if (owner.id !== 131882462) throw failure(401, 'Η σύνδεση επιτρέπεται μόνο στον ιδιοκτήτη.');
      await gh(repoApi + '/git/ref/heads/' + branch, token);
    }
    const key = randomBytes(32).toString('hex');
    sessions.delete(id);
    sessions.set(key, { token, until: Date.now() + maxAge * 1000 });
    return js(res, 200, { ok: true }, { 'Set-Cookie': cookie(key, maxAge) });
  }
  if (p === 'logout' && post) {
    sessions.delete(id);
    return js(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  }
  const session = sessions.get(id);
  if (!session || session.until < Date.now()) throw failure(401, 'Χρειάζεται σύνδεση διαχειριστή.');
  const { token } = session;
  if (p === 'state' && !post) return js(res, 200, dashboard(await adminState(token)));
  if (!post) throw failure(404, 'Η διεύθυνση δεν βρέθηκε.');
  const input = await requestBody(req);
  if (p === 'article' || p === 'preview') {
    const image = cover(input.upload);
    const id = input.id || 'keimeno-' + randomBytes(8).toString('hex');
    if (!validId(id)) throw failure(400, 'Μη έγκυρη διεύθυνση άρθρου.');
    if (p === 'preview') {
      const all = merged(await adminState(token));
      const { item } = articleInput(input, known(all, id) ? all[id] : null, image, id);
      if (image) item.image = input.upload;
      return html(res, 200, render('article', { origin, article: item, all: {}, preview: true }), { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    }
    const state = await save(token, state => {
      const all = merged(state);
      const existing = known(all, id) ? all[id] : null;
      if (input.id && (!existing || input.rev !== hash(state.articles[id]))) throw failure(409, 'Το άρθρο έχει ήδη αλλάξει. Άνοιξέ το ξανά.');
      if (!input.id && existing) throw failure(409, 'Η διεύθυνση υπάρχει ήδη.');
      if (input.featured && existing?.archived) throw failure(400, 'Η προγενέστερη εκδοχή δεν γίνεται κύριο θέμα.');
      const { fields } = articleInput(input, existing, image, id);
      return { ...state, articles: { ...state.articles, [id]: { ...state.articles[id], ...fields } },
        featured: input.featured ? id : state.featured === id ? null : state.featured };
    }, 'Publish article: ' + id, image);
    return js(res, 200, { ...dashboard(state), id, path: articleUrl(id) });
  }
  if (p === 'issue') {
    const id = input.id || randomBytes(8).toString('hex');
    const state = await save(token, state => {
      const index = state.issues.findIndex(item => item.id === id);
      if (input.id && (index < 0 || input.rev !== hash(state.issues[index]))) throw failure(409, 'Η υπόθεση έχει ήδη αλλάξει.');
      if (!known(statuses, input.status)) throw failure(400, 'Διάλεξε κατάσταση.');
      const article = field(input.article, 96);
      if (article && !known(merged(state), article)) throw failure(400, 'Διάλεξε υπαρκτό άρθρο.');
      const item = { id, title: field(input.title, 240, true), date: date(input.date), status: input.status, article, update: field(input.update, 2000) };
      const issues = state.issues.slice();
      if (index < 0) issues.unshift(item);
      else issues[index] = item;
      return { ...state, issues };
    }, 'Update observatory');
    return js(res, 200, { ...dashboard(state), id });
  }
  throw failure(404, 'Η διεύθυνση δεν βρέθηκε.');
}
const mimes = { '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg', '.png':'image/png', '.webp':'image/webp', '.gif':'image/gif', '.svg':'image/svg+xml', '.pdf':'application/pdf' };
function asset(res, p, directory, age = 3600) {
  const filename = path.resolve(directory, '.' + p);
  const type = mimes[path.extname(filename).toLowerCase()];
  if (!type || !filename.startsWith(directory + path.sep)) return false;
  try {
    if (!fs.statSync(filename).isFile()) return false;
    respond(res, 200, fs.readFileSync(filename), type, { 'Cache-Control': 'public, max-age=' + age });
    return true;
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}
const route = async (req, res) => {
  let p = '/';
  const origin = new URL(process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + (req.socket.localPort || 4173)).origin;
  try {
    const url = new URL(req.url, origin);
    p = decodeURIComponent(url.pathname);
    if (p.startsWith('/api/admin/')) return await admin(req, res, p.slice('/api/admin/'.length), origin);
    if (!['GET','HEAD'].includes(req.method)) throw failure(405, 'Μη επιτρεπτό αίτημα.');
    if (p === '/healthz') return js(res, 200, { ok: true });
    if (p === '/robots.txt') return respond(res, 200, 'User-agent: *\nDisallow: /admin\nDisallow: /api/admin/\n', 'text/plain; charset=utf-8');
    if (p === '/index.html' || p === '/stavrodromio' || p.startsWith('/stavrodromio/')) {
      const next = p === '/index.html' ? '/' : p.slice('/stavrodromio'.length) || '/';
      if (next.startsWith('//') || next.includes('\\')) throw failure(404, 'Η σελίδα δεν βρέθηκε.');
      res.writeHead(308, { Location: encodeURI(next) + url.search }); return res.end();
    }
    if (p === '/site.css' || p === '/editor.js') return asset(res, p, __dirname);
    if ((p === '/og-image.png' || /^\/images\/[A-Za-z0-9._% /()-]+$/.test(p)) && !p.split('/').includes('..')) {
      if (asset(res, p, sourceRoot)) return;
      res.writeHead(302, { Location: legacy + encodeURI(p) }); return res.end();
    }
    if (/^\/uploads\/[a-f0-9]{64}\.(jpg|png|webp)$/.test(p)) {
      if (local && asset(res, p, path.resolve(path.dirname(local)), 31536000)) return;
      if (!local) {
        const image = await fetch(raw + p, { signal: AbortSignal.timeout(8000) });
        if (image.ok) return respond(res, 200, Buffer.from(await image.arrayBuffer()), mimes[path.extname(p)], { 'Cache-Control': 'public, max-age=31536000, immutable' });
      }
    }
    if (p === '/admin') return html(res, 200, render('admin', { origin, local }), { 'Cache-Control': 'no-store' });
    const legacyName = /^\/(sxetika|epikoinonia|masthead)\.html$/.exec(p)?.[1]
      || /^\/afieroma\/(history|laografia|autodioikisi)$/.exec(p)?.[1];
    if (legacyName) {
      const content = fs.readFileSync(path.join(sourceRoot, legacyName + '.html'), 'utf8')
        .replace(/\b(href|src)=(["'])([^"']*)\2/g, (old, attr, q, value) => /^(?:images\/|article-|[a-z]+\.html$|og-image\.png$)/.test(value) ? attr + '=' + q + '/' + value + q : old)
        .replace("fetch('masthead.html')", "fetch('/masthead.html')")
        .replace(/<link rel="canonical"[^>]*>|<meta property="og:url"[^>]*>/g, '')
        .replace('</head>', '<link rel="canonical" href="' + origin + p + '"><meta property="og:url" content="' + origin + p + '"></head>');
      return html(res, 200, content, {
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https: data:; frame-ancestors 'self'; form-action 'self' https://formspree.io; object-src 'none'",
      });
    }
    const state = await publicState();
    const all = merged(state);
    const params = { origin, all, state, p };
    if (p === '/') return html(res, 200, render('home', params));
    if (p === '/paratiritirio') return html(res, 200, render('issues', params));
    const category = /^\/(reportaz|history|laografia|autodioikisi)\.html$/.exec(p)?.[1];
    if (category || p === '/arxeio') return html(res, 200, render('archive', { ...params, category, q: (url.searchParams.get('q') || '').slice(0, 100) }));
    const id = /^\/article-([a-z0-9-]+)\.html$/.exec(p)?.[1];
    if (known(all, id)) return html(res, 200, render('article', { ...params, article: all[id] }));
    return html(res, 404, render('missing', { origin }));
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500 && !error.status) console.error('Request failed:', error.name, error.code || '');
    const message = error.status ? error.message : 'Παρουσιάστηκε πρόβλημα. Δοκίμασε ξανά.';
    if (p.startsWith('/api/admin/')) return js(res, status, { error: message });
    return html(res, status, render('missing', { origin }));
  }
};
const sweep = setInterval(() => {
  for (const collection of [sessions, attempts]) {
    for (const [key, entry] of collection) if (entry.until < Date.now()) collection.delete(key);
  }
}, 60000);
sweep.unref();
if (require.main === module) createServer(route).listen(Number(process.env.PORT || 4173), '0.0.0.0', () => console.log('Stavrodromio ready'));
module.exports = { route, cover };
