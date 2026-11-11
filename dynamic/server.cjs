'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('node:http');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { randomBytes, createHash } = require('node:crypto');
const { render, rss, sections, statuses, articleUrl, articleVideos, rich, safeUrl, stylesheetVersion } = require('./pages.cjs');
const { createTeam } = require('./team.cjs');
const original = require('./original.json');
const baseline = require('./baseline.json');
const repo = 'Michelis2023/stavrodromio';
const branch = 'stavrodromio-content';
const raw = 'https://raw.githubusercontent.com/' + repo + '/' + branch;
const repoApi = '/repos/' + repo;
const sourceRoot = path.resolve(__dirname, '..');
const local = process.env.STAVRODROMIO_TEST_FILE;
const newsletterConfig = process.env.STAVRODROMIO_NEWSLETTER_ACTION || '';
const newsletterAction = /^https:\/\/api\.follow\.it\/subscription-form\/[A-Za-z0-9+\/_=-]+\/\d+$/.test(newsletterConfig) ? newsletterConfig : '';
const secure = !!process.env.RENDER || process.env.PUBLIC_ORIGIN?.startsWith('https:');
const team = createTeam({ repoApi, repository: 'stavrodromio', local });
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

async function gh(resource, token, method = 'GET', body, timeout = 15000) {
  const response = await fetch('https://api.github.com' + resource, {
    method, redirect: 'error', signal: AbortSignal.timeout(timeout),
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Stavrodromio-CMS', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.ok) return response.json();
  if (response.status === 429 || (response.status === 403 &&
      (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'))) {
    throw failure(429, 'Το GitHub περιόρισε προσωρινά τα αιτήματα. Δοκίμασε ξανά σε λίγα λεπτά.');
  }
  if (response.status === 401) {
    throw failure(401, 'Το GitHub δεν δέχτηκε το κλειδί πρόσβασης. Συνδέσου ξανά με ενεργό κλειδί.');
  }
  if (response.status === 403 || response.status === 404) {
    const message = method === 'GET'
      ? 'Έλεγξε ότι το κλειδί GitHub έχει πρόσβαση στο αποθετήριο stavrodromio.'
      : 'Το GitHub δεν επέτρεψε την εγγραφή στο αποθετήριο stavrodromio. Αν συνδέεσαι ως ιδιοκτήτης, έλεγξε ότι το κλειδί σου έχει άδεια Contents → Read and write για το συγκεκριμένο αποθετήριο.';
    throw failure(response.status, message);
  }
  if ([409, 413, 422].includes(response.status)) {
    const blob = method === 'POST' && resource === repoApi + '/git/blobs';
    const ref = method === 'PATCH' && resource === repoApi + '/git/refs/heads/' + branch;
    const details = await response.json().catch(() => null);
    const fields = Array.isArray(details?.errors) ? details.errors : [];
    const tooLarge = blob && (response.status === 413 || fields.some(item => item?.code === 'too_large') ||
      /too large|exceeds?.{0,40}(?:size|limit|bytes)|maximum.{0,20}(?:size|bytes)/i.test(details?.message || '') ||
      fields.some(item => /too large|size limit|exceeds?.{0,20}bytes/i.test(item?.message || '')));
    console.warn('GitHub storage rejected:', blob ? 'file' : ref ? 'branch' : 'publication', response.status, tooLarge ? 'size' : 'validation');
    if (tooLarge) throw failure(413, 'Το GitHub απέρριψε το αρχείο λόγω μεγέθους. Δοκίμασε μικρότερο αρχείο.');
    if (blob) throw failure(422, 'Το GitHub απέρριψε την αποθήκευση του αρχείου. Το άρθρο παραμένει ανοιχτό με τις αλλαγές σου.');
    if (ref) throw Object.assign(failure(409, 'Το GitHub δεν δέχτηκε την ενημέρωση του αποθετηρίου. Οι αλλαγές σου παραμένουν στη φόρμα.'), { refRejected: true });
    throw failure(422, 'Το GitHub απέρριψε την αποθήκευση της δημοσίευσης. Οι αλλαγές σου παραμένουν στη φόρμα.');
  }
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

async function save(token, update, message, files = []) {
  const uploads = new Map(files.map(file => [file.path, file]));
  if (local) {
    const state = update(readLocal());
    for (const file of uploads.values()) {
      const destination = path.join(path.dirname(local), file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.bytes);
    }
    fs.writeFileSync(local + '.tmp', JSON.stringify(state));
    fs.renameSync(local + '.tmp', local);
    return state;
  }
  let current = await head(token);
  for (let attempt = 0; ; attempt++) {
    const state = update(current.state);
    const data = JSON.stringify(state, null, 2);
    if (Buffer.byteLength(data) > 900000) throw failure(413, 'Το αρχείο δημοσιεύσεων έφτασε στο όριο αποθήκευσης.');
    const tree = [{ path: 'dynamic-content.json', mode: '100644', type: 'blob', content: data }];
    for (const file of uploads.values()) {
      file.sha ??= (await gh(repoApi + '/git/blobs', token, 'POST', { content: file.bytes.toString('base64'), encoding: 'base64' })).sha;
      tree.push({ path: file.path, mode: '100644', type: 'blob', sha: file.sha });
    }
    const nextTree = await gh(repoApi + '/git/trees', token, 'POST', { base_tree: current.tree, tree });
    const commit = await gh(repoApi + '/git/commits', token, 'POST', { message, tree: nextTree.sha, parents: [current.sha] });
    try {
      await gh(repoApi + '/git/refs/heads/' + branch, token, 'PATCH', { sha: commit.sha, force: false });
    } catch (error) {
      if (!error.refRejected || attempt) throw error;
      const latest = await head(token);
      if (latest.sha === current.sha) throw error;
      current = latest;
      continue;
    }
    cache = { state, until: Date.now() + 45000 };
    return state;
  }
}

function cover(value) {
  if (!value) return null;
  const match = typeof value === 'string' && /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw failure(400, 'Διάλεξε εικόνα JPG, PNG ή WebP.');
  const [, format, base64] = match;
  const bytes = Buffer.from(base64, 'base64');
  if (!validPhoto(format, bytes) || bytes.length > 3 * 1024 * 1024) throw failure(400, 'Διάλεξε έγκυρη εικόνα έως 3 MB.');
  return mediaFile(format === 'jpeg' ? 'jpg' : format, bytes);
}
function validPhoto(format, bytes) {
  return format === 'jpeg' ? bytes.subarray(0, 3).toString('hex') === 'ffd8ff'
    : format === 'png' ? bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
    : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
}
function mediaFile(extension, bytes) {
  return { bytes, path: 'uploads/' + createHash('sha256').update(bytes).digest('hex') + '.' + extension };
}
function validVideo(bytes) {
  return bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp';
}

const maxPhotoBytes = 10 * 1024 * 1024;
const maxVideoBytes = 48 * 1024 * 1024;
let activeUploads = 0;
async function stageMedia(req, token, session) {
  const formats = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4' };
  const type = req.headers['content-type'];
  if (!known(formats, type)) throw failure(415, 'Διάλεξε εικόνα JPG, PNG, WebP ή βίντεο MP4.');
  const format = formats[type];
  const video = format === 'mp4';
  const limit = video ? maxVideoBytes : maxPhotoBytes;
  if (Number(req.headers['content-length']) > limit) throw failure(413, video ? 'Το βίντεο ξεπερνά τα 48 MB.' : 'Η φωτογραφία ξεπερνά τα 10 MB.');
  if (activeUploads) throw failure(429, 'Η μεταφόρτωση είναι προσωρινά απασχολημένη. Δοκίμασε ξανά σε λίγο.');
  activeUploads++;
  try {
    const bytes = await requestBytes(req, limit);
    if (!(video ? validVideo(bytes) : validPhoto(format, bytes))) throw failure(400, 'Το αρχείο δεν ταιριάζει με τον τύπο που επέλεξες.');
    const file = mediaFile(format === 'jpeg' ? 'jpg' : format, bytes);
    const uploadId = randomBytes(16).toString('hex');
    const blob = local ? file : { path: file.path, sha: (await gh(repoApi + '/git/blobs', token, 'POST',
      { content: bytes.toString('base64'), encoding: 'base64' }, 90000)).sha };
    (session.uploads ??= new Map()).set(uploadId, { ...blob, video });
    return { uploadId };
  } finally {
    activeUploads--;
  }
}

function referencedMedia(input, resolve) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.gallery)) throw failure(400, 'Έλεγξε τα αρχεία της δημοσίευσης.');
  const image = input.cover ? resolve(input.cover, false) : null;
  const poster = input.poster ? resolve(input.poster, false) : null;
  const gallery = input.gallery.map(value => resolve(value, false));
  const appendVideos = Object.hasOwn(input, 'videos');
  const videoRefs = appendVideos ? input.videos : input.video ? [input.video] : [];
  if (!Array.isArray(videoRefs)) throw failure(400, 'Έλεγξε τα βίντεο της δημοσίευσης.');
  const videos = videoRefs.map(value => resolve(value, true));
  return { image, poster, gallery, videos, appendVideos, files: [image, poster, ...gallery, ...videos].filter(Boolean) };
}
function previewFile(value, origin) {
  const prefix = 'blob:' + origin + '/';
  if (typeof value !== 'string' || !value.startsWith(prefix) || !/^[a-f0-9-]{36}$/i.test(value.slice(prefix.length))) {
    throw failure(400, 'Η προεπισκόπηση του αρχείου δεν είναι διαθέσιμη.');
  }
  return { src: value };
}

const maxUploadBytes = 20 * 1024 * 1024;
function articleUploads(input) {
  const image = cover(input.upload);
  const uploads = input.galleryUploads ?? [];
  if (!Array.isArray(uploads) || uploads.some(value => !value)) {
    throw failure(400, 'Έλεγξε τις φωτογραφίες της συλλογής.');
  }
  const gallery = uploads.map(cover);
  let video = null;
  if (input.videoUpload) {
    const match = typeof input.videoUpload === 'string' && /^data:video\/mp4;base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.videoUpload);
    const bytes = match && Buffer.from(match[1], 'base64');
    if (!bytes || bytes.length > 15 * 1024 * 1024 || !validVideo(bytes)) {
      throw failure(400, 'Διάλεξε έγκυρο βίντεο MP4 έως 15 MB.');
    }
    video = mediaFile('mp4', bytes);
  }
  const files = [image, ...gallery, video].filter(Boolean);
  if (files.reduce((size, file) => size + file.bytes.length, 0) > maxUploadBytes) {
    throw failure(413, 'Τα νέα αρχεία της δημοσίευσης ξεπερνούν συνολικά τα 20 MB.');
  }
  return { image, gallery, videos: video ? [video] : [], files };
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
function videoLink(value) {
  const source = field(value, 1600);
  if (!source) return '';
  let url;
  try { url = new URL(source); } catch { /* reported below */ }
  if (safeUrl(source) && url?.protocol === 'https:' && !url.username && !url.password && !url.port) return url.href;
  throw failure(400, 'Βάλε έγκυρο σύνδεσμο βίντεο με https://.');
}
function articleInput(input, existing, uploads, id) {
  const { image, poster, gallery, videos, appendVideos } = uploads;
  const title = field(input.title, 240, true);
  if (!known(sections, input.category)) throw failure(400, 'Διάλεξε ενότητα.');
  const imageUrl = field(input.image, 1600);
  if (!image && imageUrl && !safeUrl(imageUrl)) throw failure(400, 'Έλεγξε τη διεύθυνση της εικόνας.');
  const removed = new Set(Array.isArray(input.removeGallery) ? input.removeGallery : []);
  const source = file => file.src ?? '/' + file.path;
  const photos = [...new Set([...(existing?.gallery ?? []).filter(src => !removed.has(src)), ...gallery.map(source)])];
  const newVideos = videos.map(source);
  const externalVideo = !appendVideos && newVideos.length ? '' : input.videoLink === undefined ? existing?.videoLink || '' : videoLink(input.videoLink);
  const removedVideos = new Set(Array.isArray(input.removeVideos) ? input.removeVideos : []);
  const keepExisting = input.removeVideo !== true && (appendVideos || (!newVideos.length && !externalVideo));
  const keptVideos = keepExisting ? articleVideos(existing).filter(src => !removedVideos.has(src)) : [];
  const allVideos = [...new Set([...keptVideos, ...newVideos])];
  const firstVideo = allVideos[0];
  const previousPoster = firstVideo && firstVideo === articleVideos(existing)[0] ? existing.videoPoster : '';
  const videoPoster = firstVideo && poster ? source(poster) : previousPoster || '';
  const fields = { title, date: date(input.date), author: field(input.author, 120), summary: field(input.summary, 800),
    deck: field(input.deck, 2400), image: image ? source(image) : imageUrl,
    gallery: photos, videos: allVideos, video: firstVideo || '', videoLink: externalVideo, videoPoster,
    sections: existing?.sections[0] === input.category ? existing.sections : [input.category],
    hero: input.hero === true, alt: field(input.alt, 300), caption: field(input.caption, 500) };
  if (input.blocks !== undefined) {
    if (!Array.isArray(input.blocks) || JSON.stringify(input.blocks).length > 300000) throw failure(400, 'Το κείμενο ξεπερνά το όριο.');
    fields.blocks = input.blocks;
  }
  const body = fields.blocks ? rich(fields.blocks) : existing?.body || '';
  const hasBody = /<img\b[^>]*\bsrc=/i.test(body) || !!body.replace(/<[^>]*>/g, '').replace(/&nbsp;|\u00a0/g, ' ').trim();
  const hasPhotos = fields.image || photos.length > 0;
  const hasVideo = allVideos.length > 0 || externalVideo;
  if (!hasBody && !fields.deck && !hasPhotos && !hasVideo) {
    throw failure(400, 'Πρόσθεσε κείμενο, φωτογραφία ή βίντεο για να δημοσιεύσεις.');
  }
  if (!hasBody && !fields.deck && fields.image && !photos.length && !hasVideo) fields.hero = true;
  if (!fields.summary) {
    fields.summary = fields.deck.slice(0, 300) || (hasBody ? title : hasVideo
      ? hasPhotos ? 'Φωτογραφίες και βίντεο από το Σταυροδρόμι.' : 'Βίντεο από το Σταυροδρόμι.'
      : 'Φωτογραφίες από το Σταυροδρόμι.');
  }
  return { fields, item: { ...existing, ...fields, id, body } };
}
const dashboard = (state, user) => ({ featured: state.featured, user,
  mobileHelp: 'Άνοιξε το Σταυροδρόμι από το εικονίδιο της εφαρμογής και μπες στη Διαχείριση. Πάτησε «Νέο άρθρο» για να γράψεις, να επιλέξεις φωτογραφίες και βίντεο από το κινητό ή να επικολλήσεις σύνδεσμο βίντεο. Η δημοσίευση χρειάζεται σύνδεση στο διαδίκτυο.',
  articles: Object.values(merged(state)).map(({ blocks, sourceNotes, ...item }) => ({ ...item, rev: hash(state.articles[item.id]) })),
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
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' https: data: blob:; media-src 'self' data: blob:; frame-src 'self' blob: https://www.youtube-nocookie.com https://www.facebook.com https://player.vimeo.com https://www.tiktok.com; frame-ancestors 'self'; form-action 'self' https://formspree.io" +
    (newsletterAction ? ' https://api.follow.it https://follow.it' : '') + "; base-uri 'none'; object-src 'none'",
  ...extra,
});
const cookie = (id, age) => 'stavrodromio=' + id + '; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=' + age + (secure ? '; Secure' : '');
async function requestBody(req, max = 5000000) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw failure(415, 'Μη υποστηριζόμενη μορφή αιτήματος.');
  const body = await requestBytes(req, max);
  try {
    const value = JSON.parse(body);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* invalid JSON */ }
  throw failure(400, 'Το αίτημα δεν διαβάστηκε.');
}
async function requestBytes(req, max) {
  if (Number(req.headers['content-length']) > max) throw failure(413, 'Το αίτημα ξεπερνά το όριο.');
  const parts = [];
  let bytes = 0;
  for await (const part of req) {
    bytes += part.length;
    if (bytes > max) throw failure(413, 'Το αίτημα ξεπερνά το όριο.');
    parts.push(part);
  }
  return Buffer.concat(parts, bytes);
}

function limitSignIn(req) {
  const address = process.env.RENDER ? (req.headers['x-forwarded-for'] || '').split(',').at(-1).trim() : req.socket.remoteAddress;
  const previous = attempts.get(address);
  const entry = previous?.until > Date.now() ? previous : { count: 0, until: Date.now() + 600000 };
  if (++entry.count > 10) throw failure(429, 'Πολλές προσπάθειες. Δοκίμασε σε λίγα λεπτά.');
  attempts.set(address, entry);
}
function newSession(res, previous, session) {
  const key = randomBytes(32).toString('hex');
  sessions.delete(previous);
  sessions.set(key, { ...session, until: Date.now() + maxAge * 1000 });
  return js(res, 200, { ok: true }, { 'Set-Cookie': cookie(key, maxAge) });
}
const ownerUser = { role: 'owner', name: 'Μιχαήλ Σωτηρίου Μιχαλακόπουλος' };

async function admin(req, res, p, origin) {
  const post = req.method === 'POST';
  if (!post && req.method !== 'GET') throw failure(405, 'Μη επιτρεπτό αίτημα.');
  if (post && req.headers.origin !== origin) throw failure(403, 'Μη επιτρεπτή προέλευση.');
  const id = req.headers.cookie?.match(/(?:^|;\s*)stavrodromio=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (p === 'login' && post) {
    limitSignIn(req);
    const { token } = await requestBody(req, 1024);
    if (local) {
      if (!process.env.STAVRODROMIO_TEST_PASSWORD || token !== process.env.STAVRODROMIO_TEST_PASSWORD) throw failure(401, 'Ο κωδικός δεν έγινε δεκτός.');
    } else {
      if (typeof token !== 'string' || !/^github_pat_[A-Za-z0-9_]{40,250}$/.test(token)) throw failure(401, 'Χρειάζεται κλειδί περιορισμένης πρόσβασης GitHub.');
      const owner = await gh('/user', token);
      if (owner.id !== 131882462) throw failure(401, 'Η σύνδεση επιτρέπεται μόνο στον ιδιοκτήτη.');
      await gh(repoApi + '/git/ref/heads/' + branch, token);
    }
    return newSession(res, id, { token, user: ownerUser });
  }
  if ((p === 'team-login' || p === 'team-accept') && post) {
    limitSignIn(req);
    const input = await requestBody(req, 2048);
    const token = await team.serviceToken();
    const state = await adminState(token);
    if (p === 'team-login') {
      const user = await team.signIn(state, input);
      return newSession(res, id, { user });
    }
    team.checkInvite(state, input);
    const verifier = await team.newPassword(input.password);
    const accountId = randomBytes(16).toString('hex');
    const saved = await save(token, current => team.redeem(current, input, verifier, accountId), 'Activate an editorial invitation');
    return newSession(res, id, { user: team.requireMember(saved, accountId) });
  }
  if (p === 'logout' && post) {
    sessions.delete(id);
    return js(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  }
  const session = sessions.get(id);
  if (!session || session.until < Date.now()) throw failure(401, 'Χρειάζεται σύνδεση διαχειριστή.');
  const owner = session.user.role === 'owner';
  if (['team','team-invite','team-remove'].includes(p)) {
    if (!owner) throw failure(403, 'Μόνο ο ιδιοκτήτης διαχειρίζεται συνεργάτες.');
    if (p === 'team' && !post) {
      if (!team.enabled) return js(res, 200, { enabled: false });
      return js(res, 200, { enabled: true, ...team.ownerView(await adminState(session.token)) });
    }
    if (!post || p === 'team') throw failure(405, 'Μη επιτρεπτό αίτημα.');
    const input = await requestBody(req, 2048);
    if (p === 'team-invite') {
      await team.serviceToken();
      const secret = randomBytes(32).toString('base64url');
      const state = await save(session.token, current => team.newInvite(current, input, secret), 'Create an editorial invitation');
      return js(res, 200, { enabled: true, ...team.ownerView(state), link: origin + '/admin#invite=' + secret });
    }
    const state = await save(session.token, current => team.remove(current, input.id), 'Revoke editorial access');
    for (const [key, value] of sessions) {
      if (value.user.id && value.user.id === input.id) sessions.delete(key);
    }
    return js(res, 200, { enabled: true, ...team.ownerView(state) });
  }
  const token = owner ? session.token : await team.serviceToken();
  const currentUser = state => owner ? session.user : team.requireMember(state, session.user.id);
  const articleData = (input, existing, uploads, id, state) => {
    const user = currentUser(state);
    const data = user.role === 'owner' ? input : { ...input, author: existing ? existing.author : user.name };
    return articleInput(data, existing, uploads, id);
  };
  if (p === 'state' && !post) {
    const state = await adminState(token);
    return js(res, 200, dashboard(state, currentUser(state)));
  }
  if (!post) throw failure(404, 'Η διεύθυνση δεν βρέθηκε.');
  if (p === 'stage-media') return js(res, 200, await stageMedia(req, token, session));
  const input = await requestBody(req, p === 'article' || p === 'preview' ? 29 * 1024 * 1024 : undefined);
  if (p === 'article' || p === 'preview') {
    const used = [];
    const uploads = p === 'preview' && input.previewMedia
      ? referencedMedia(input.previewMedia, value => previewFile(value, origin))
      : p === 'article' && input.stagedMedia
        ? referencedMedia(input.stagedMedia, (uploadId, video) => {
          const file = session.uploads?.get(uploadId);
          if (!file || file.video !== video) throw failure(410, 'Η μεταφόρτωση έληξε. Τα αρχεία θα σταλούν ξανά.');
          used.push(uploadId);
          return file;
        })
        : articleUploads(input);
    const id = input.id || 'keimeno-' + randomBytes(8).toString('hex');
    if (!validId(id)) throw failure(400, 'Μη έγκυρη διεύθυνση άρθρου.');
    if (p === 'preview') {
      const state = await adminState(token);
      const all = merged(state);
      const { item } = articleData(input, known(all, id) ? all[id] : null, uploads, id, state);
      if (!input.previewMedia) {
        if (uploads.image) item.image = input.upload;
        const inlinePhotos = new Map(uploads.gallery.map((file, index) => ['/' + file.path, input.galleryUploads[index]]));
        item.gallery = item.gallery.map(src => inlinePhotos.get(src) ?? src);
        if (uploads.videos.length) item.videos = [input.videoUpload];
      }
      return html(res, 200, render('article', { origin, article: item, all: {}, preview: true }), { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    }
    const state = await save(token, state => {
      const all = merged(state);
      const existing = known(all, id) ? all[id] : null;
      if (input.id && (!existing || input.rev !== hash(state.articles[id]))) throw failure(409, 'Το άρθρο έχει ήδη αλλάξει. Άνοιξέ το ξανά.');
      if (!input.id && existing) throw failure(409, 'Η διεύθυνση υπάρχει ήδη.');
      if (input.featured && existing?.archived) throw failure(400, 'Η προγενέστερη εκδοχή δεν γίνεται κύριο θέμα.');
      const { fields } = articleData(input, existing, uploads, id, state);
      if (!existing) fields.publishedAt = new Date().toISOString();
      return { ...state, articles: { ...state.articles, [id]: { ...state.articles[id], ...fields } },
        featured: input.featured ? id : state.featured === id ? null : state.featured };
    }, 'Publish article: ' + id, uploads.files);
    for (const uploadId of used) session.uploads.delete(uploadId);
    return js(res, 200, { ...dashboard(state, currentUser(state)), id, path: articleUrl(id) });
  }
  if (p === 'issue') {
    const id = input.id || randomBytes(8).toString('hex');
    const state = await save(token, state => {
      currentUser(state);
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
    return js(res, 200, { ...dashboard(state, currentUser(state)), id });
  }
  throw failure(404, 'Η διεύθυνση δεν βρέθηκε.');
}
const mimes = { '.webmanifest':'application/manifest+json; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.jpg':'image/jpeg',
  '.woff2':'font/woff2', '.jpeg':'image/jpeg', '.png':'image/png', '.webp':'image/webp', '.gif':'image/gif', '.svg':'image/svg+xml', '.pdf':'application/pdf' };
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

const videoHeaders = { 'Content-Type': 'video/mp4', 'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'public, max-age=31536000, immutable', 'Accept-Ranges': 'bytes' };
function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !size || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return start <= end ? { start, end } : null;
}
function videoResponse(req, res, size, open) {
  const range = req.method === 'GET' && req.headers.range ? byteRange(req.headers.range, size) : undefined;
  if (range === null) {
    res.writeHead(416, { ...videoHeaders, 'Content-Range': 'bytes */' + size });
    return res.end();
  }
  const headers = { ...videoHeaders, 'Content-Length': range ? range.end - range.start + 1 : size };
  if (range) headers['Content-Range'] = 'bytes ' + range.start + '-' + range.end + '/' + size;
  res.writeHead(range ? 206 : 200, headers);
  return req.method === 'HEAD' ? res.end() : pipeline(open(range), res);
}
async function* sliceVideo(body, range) {
  let offset = 0;
  for await (const chunk of body) {
    const next = offset + chunk.length;
    if (next > range.start) {
      yield chunk.subarray(Math.max(0, range.start - offset), range.end + 1 - offset);
    }
    if (next > range.end) return;
    offset = next;
  }
}
async function uploadedVideo(req, res, p) {
  if (local) {
    const filename = path.join(path.dirname(local), p);
    const file = await fs.promises.stat(filename).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!file?.isFile()) return respond(res, 404, 'Not found', 'text/plain; charset=utf-8');
    return videoResponse(req, res, file.size, range => fs.createReadStream(filename, range));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  res.once('close', () => controller.abort());
  const range = req.method === 'GET' ? req.headers.range : undefined;
  const upstream = await fetch(raw + p, {
    method: req.method, headers: { 'Accept-Encoding': 'identity', ...(range ? { Range: range } : {}) }, signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
  if (upstream.status === 404) {
    await upstream.body?.cancel();
    return respond(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
  if (upstream.status === 416) {
    await upstream.body?.cancel();
    const headers = { ...videoHeaders };
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) headers['Content-Range'] = contentRange;
    res.writeHead(416, headers);
    return res.end();
  }
  if (!upstream.ok) {
    await upstream.body?.cancel();
    throw failure(502, 'Το βίντεο δεν είναι διαθέσιμο προσωρινά.');
  }
  if (range && upstream.status === 200) {
    const length = Number(upstream.headers.get('content-length'));
    const encoding = upstream.headers.get('content-encoding');
    if (upstream.body && length > 0 && (!encoding || encoding === 'identity')) {
      if (!byteRange(range, length)) await upstream.body.cancel();
      return videoResponse(req, res, length, part => Readable.from(sliceVideo(upstream.body, part)));
    }
    const bytes = Buffer.from(await upstream.arrayBuffer());
    return videoResponse(req, res, bytes.length, part => Readable.from(part ? bytes.subarray(part.start, part.end + 1) : bytes));
  }
  const headers = { ...videoHeaders };
  for (const key of ['content-range', 'content-length']) {
    const value = upstream.headers.get(key);
    if (value) headers[key] = value;
  }
  res.writeHead(upstream.status, headers);
  return upstream.body ? pipeline(Readable.fromWeb(upstream.body), res) : res.end();
}

function informationPage(source) {
  const main = source.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)[1];
  const sidebar = source.match(/<aside class="right-col">([\s\S]*?)<\/aside>/i)?.[1];
  // The contact and civic pages put their right column inside <main>.
  const split = /<\/section>\s*(?:<!--[^>]*-->\s*)?<section>\s*(?=<div class="right-col-section">)/.exec(main);
  const right = sidebar || (split && main.slice(split.index + split[0].length).replace(/<\/section>\s*$/, ''));
  const left = (split ? main.slice(0, split.index) : main)
    .replace(/^\s*(?:<!--[^>]*-->\s*)?<section>\s*/, '');
  const header = left.match(/<div class="section-header">([\s\S]*?<\/p>)\s*<\/div>/);
  const title = header[1].match(/<h2 class="section-title">([^<]+)<\/h2>/)[1];
  const summary = source.match(/<meta name="description" content="([^"]*)"/)?.[1];
  const content = markup => markup
    .replace(/\sstyle="[^"]*"/g, '')
    .replace(/\b(href|src)="((?:images\/[^"]+)|(?:[a-z0-9-]+\.html(?:#[^"]*)?))"/g, '$1="/$2"');
  return {
    title, summary,
    heading: header[1].replace('class="section-kicker"', 'class="eyebrow"')
      .replace('<h2 class="section-title">', '<h1>').replace('</h2>', '</h1>'),
    body: content(left.replace(header[0], '')).replace(/<(\/?)h([34])\b/g, (_, closing, level) => '<' + closing + 'h' + (Number(level) - 1)),
    sidebar: right ? content(right) : '',
  };
}

const route = async (req, res) => {
  let p = '/';
  const origin = new URL(process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + (req.socket.localPort || 4173)).origin;
  try {
    const url = new URL(req.url, origin);
    try { p = decodeURIComponent(url.pathname); }
    catch { throw failure(400, 'Μη έγκυρη διεύθυνση.'); }
    if (p.startsWith('/api/admin/')) return await admin(req, res, p.slice('/api/admin/'.length), origin);
    if (!['GET','HEAD'].includes(req.method)) throw failure(405, 'Μη επιτρεπτό αίτημα.');
    if (p === '/healthz') return js(res, 200, { ok: true });
    if (p === '/robots.txt') return respond(res, 200, 'User-agent: *\nDisallow: /admin\nDisallow: /api/admin/\nSitemap: ' + origin + '/sitemap.xml\n', 'text/plain; charset=utf-8');
    if (p === '/index.html' || p === '/masthead.html' || p === '/stavrodromio' || p.startsWith('/stavrodromio/')) {
      const next = p === '/index.html' || p === '/masthead.html' ? '/' : p.slice('/stavrodromio'.length) || '/';
      if (next.startsWith('//') || next.includes('\\')) throw failure(404, 'Η σελίδα δεν βρέθηκε.');
      res.writeHead(308, { Location: encodeURI(next) + url.search }); return res.end();
    }
    if (p === '/site.css') return asset(res, p, __dirname, url.searchParams.get('v') === stylesheetVersion ? 31536000 : 0);
    if (['/editor.js', '/favicon.svg', '/app.js', '/app.webmanifest', '/app-192.png', '/app-512.png'].includes(p)) return asset(res, p, __dirname);
    if (/^\/fonts\/source-serif-4-005-(?:roman|italic)\.woff2$/.test(p) && asset(res, p, __dirname, 31536000)) return;
    if (p === '/images/history/stavrodromi-plateia.jpg' || p === '/images/laografia/plateia-kai-giorti.jpg') {
      res.writeHead(308, { Location: '/og-image.png' }); return res.end();
    }
    if (p === '/og-image.png' || /^\/images\/[A-Za-z0-9._% /()-]+$/.test(p)) {
      if (!p.split('/').includes('..') && asset(res, p, sourceRoot)) return;
      return respond(res, 404, 'Not found', 'text/plain; charset=utf-8');
    }
    if (/^\/uploads\/[a-f0-9]{64}\.mp4$/.test(p)) return await uploadedVideo(req, res, p);
    if (/^\/uploads\/[a-f0-9]{64}\.(jpg|png|webp)$/.test(p)) {
      if (local && asset(res, p, path.resolve(path.dirname(local)), 31536000)) return;
      if (!local) {
        try {
          const image = await fetch(raw + p, { signal: AbortSignal.timeout(8000) });
          if (image.ok) return respond(res, 200, Buffer.from(await image.arrayBuffer()), mimes[path.extname(p)], { 'Cache-Control': 'public, max-age=31536000, immutable' });
          if (image.status !== 404) return respond(res, 502, 'Image unavailable', 'text/plain; charset=utf-8');
        } catch {
          return respond(res, 502, 'Image unavailable', 'text/plain; charset=utf-8');
        }
      }
      return respond(res, 404, 'Not found', 'text/plain; charset=utf-8');
    }
    if (p === '/admin') return html(res, 200, render('admin', { origin, local, teamEnabled: team.enabled }), { 'Cache-Control': 'no-store' });
    if (p === '/egkatastasi') return html(res, 200, render('install', { origin }));
    const informationName = /^\/(sxetika|epikoinonia)\.html$/.exec(p)?.[1]
      || /^\/afieroma\/(history|laografia|autodioikisi)$/.exec(p)?.[1];
    if (informationName) {
      const source = fs.readFileSync(path.join(sourceRoot, informationName + '.html'), 'utf8');
      return html(res, 200, render('information', { origin, p, information: informationPage(source) }));
    }
    const state = await publicState();
    const all = merged(state);
    if (p === '/rss.xml') {
      return respond(res, 200, rss(origin, all), 'application/rss+xml; charset=utf-8', { 'Cache-Control': 'public, max-age=45' });
    }
    if (p === '/sitemap.xml') {
      const paths = ['/', '/arxeio', '/paratiritirio', '/egkatastasi', '/sxetika.html', '/epikoinonia.html',
        ...Object.keys(sections).map(key => '/' + key + '.html'),
        '/afieroma/history', '/afieroma/laografia', '/afieroma/autodioikisi',
        ...Object.keys(all).filter(id => !all[id].archived).map(articleUrl)];
      const urls = paths.map(path => '<url><loc>' + origin + path + '</loc></url>').join('');
      return respond(res, 200, '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + urls + '</urlset>', 'application/xml; charset=utf-8');
    }
    const params = { origin, all, state, p, newsletterAction };
    if (p === '/') return html(res, 200, render('home', params));
    if (p === '/paratiritirio') return html(res, 200, render('issues', params));
    const category = /^\/(reportaz|history|laografia|autodioikisi)\.html$/.exec(p)?.[1];
    if (category || p === '/arxeio') return html(res, 200, render('archive', { ...params, category, q: (url.searchParams.get('q') || '').slice(0, 100) }));
    const id = /^\/article-([a-z0-9-]+)\.html$/.exec(p)?.[1];
    if (known(all, id)) return html(res, 200, render('article', { ...params, article: all[id] }));
    return html(res, 404, render('missing', { origin }));
  } catch (error) {
    if (res.headersSent || res.destroyed) return res.destroy();
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
