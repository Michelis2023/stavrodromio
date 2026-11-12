'use strict';
(function editor() {
const $ = id => document.getElementById(id);
const form = $('article-form');
const editor = $('body-editor');
const issueForm = $('issue-form');
const dialog = $('preview-dialog');
const mediaPanel = $('editor-media-panel');
const mediaList = $('editor-media-items');
const mediaFiles = $('media-files');
const mediaReplace = $('media-replace');
const mediaLink = $('media-link-url');
const inviteCode = new URLSearchParams(window.location.hash.slice(1)).get('invite');
let loginMode = inviteCode ? 'accept' : 'owner';
let state;
let selected;
let initialHtml = '';
let dirty = false;
let busy = false;
let stagedFiles = new WeakMap();
let mediaRows = [];
let replacingMedia = null;
let editingMediaLink = null;
const previewUrls = new Set();
const mediaObjectUrls = new Map();
const capturedPosters = new Map();
let coverVideo = false;
const today = () => new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Athens'}).format(new Date());
function feedback(message, error = false) {
  $('feedback').textContent = message;
  $('feedback').classList.toggle('error', error);
}
function uploadNotice(message, progress, error = false) {
  const panel = $('upload-status');
  const bar = $('upload-progress');
  panel.hidden = !message;
  panel.classList.toggle('error', error);
  $('upload-message').textContent = message;
  bar.hidden = progress === undefined;
  uploadPercent(progress);
}
function uploadPercent(percent) {
  const bar = $('upload-progress');
  if (percent == null) bar.removeAttribute('value');
  else bar.value = percent;
  $('upload-percent').textContent = percent == null ? '' : percent + '%';
}
async function api(endpoint, data) {
  const response = await fetch('/api/admin/' + endpoint, data === undefined ? {} : {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw Object.assign(new Error(error.error || 'Το αίτημα δεν ολοκληρώθηκε.'), { status: response.status });
  }
  return endpoint === 'preview' ? response.text() : response.json();
}
async function uploadFile(file, type, label) {
  if (stagedFiles.has(file)) return stagedFiles.get(file);
  uploadNotice('Μεταφόρτωση αρχείου ' + label, 0);
  const uploadId = await new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.upload.addEventListener('progress', event => {
      if (event.lengthComputable && event.total > 0) uploadPercent(Math.floor(100 * event.loaded / event.total));
    });
    request.upload.addEventListener('load', () => {
      uploadNotice('Το αρχείο στάλθηκε. Αναμονή επιβεβαίωσης για το αρχείο ' + label, null);
    });
    request.addEventListener('load', () => {
      const result = request.response;
      if (request.status >= 200 && request.status < 300 && typeof result?.uploadId === 'string') {
        resolve(result.uploadId);
      } else {
        reject(Object.assign(new Error(result?.error || 'Η μεταφόρτωση δεν ολοκληρώθηκε.'), { status: request.status }));
      }
    });
    request.addEventListener('error', () => reject(new Error('Η σύνδεση διακόπηκε κατά τη μεταφόρτωση. Δοκίμασε ξανά.')));
    request.addEventListener('abort', () => reject(new Error('Η μεταφόρτωση διακόπηκε. Δοκίμασε ξανά.')));
    request.open('POST', '/api/admin/stage-media');
    request.responseType = 'json';
    request.setRequestHeader('Content-Type', type);
    request.send(file);
  });
  stagedFiles.set(file, uploadId);
  return uploadId;
}
function showLogin() {
  $('desk').hidden = true;
  $('mobile-publishing').hidden = true;
  $('mobile-publishing').open = false;
  $('mobile-publishing-text').textContent = '';
  $('login-panel').hidden = false;
  $('login').hidden = loginMode !== 'owner';
  $('team-login').hidden = loginMode !== 'team';
  $('team-accept').hidden = loginMode !== 'accept';
  $('login-heading').textContent = {
    owner: 'Σύνδεση ιδιοκτήτη', team: 'Σύνδεση συνδιαχειριστή', accept: 'Αποδοχή πρόσκλησης',
  }[loginMode];
  const switcher = $('login-switch');
  if (switcher) switcher.textContent = loginMode === 'owner' ? 'Σύνδεση συνδιαχειριστή' : 'Σύνδεση ιδιοκτήτη';
}
async function run(action, button) {
  if (busy) return;
  busy = true;
  if (button) button.disabled = true;
  feedback('');
  try { await action(); }
  catch (error) {
    if (error.status === 401 && !$('desk').hidden) showLogin();
    feedback(error.message, true);
  } finally {
    busy = false;
    if (button) button.disabled = false;
  }
}
async function restoreSession() {
  const retry = $('retry-session');
  retry.hidden = true;
  feedback('Έλεγχος αποθηκευμένης σύνδεσης…');
  try {
    activate(await api('state'));
    feedback('');
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      const needsLogin = error.message === 'Χρειάζεται σύνδεση διαχειριστή.';
      feedback(needsLogin ? '' : error.message, !needsLogin);
      return;
    }
    feedback('Ο έλεγχος σύνδεσης δεν ολοκληρώθηκε. Δοκίμασε ξανά σε λίγο.', true);
    retry.hidden = false;
  }
}
function sorted() { return state.articles.slice().sort((a,b) => b.date.localeCompare(a.date)); }
function articles() {
  const list = $('article-list');
  list.replaceChildren(...sorted().map(item => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = item.title;
    b.setAttribute('aria-pressed', String(selected?.id === item.id));
    b.addEventListener('click', () => {
      if (busy || !confirmChange()) return;
      openArticle(item);
      form.elements.title.focus();
    });
    return b;
  }));
}
function confirmChange() { return !dirty || window.confirm('Υπάρχουν αλλαγές χωρίς αποθήκευση. Θέλεις να αλλάξεις άρθρο;'); }
function mediaRow(kind, title, { src, file } = {}) {
  const element = document.createElement('li');
  const label = document.createElement('label');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'media-checkbox';
  label.append(checkbox, title);
  const photo = kind === 'cover' || kind === 'gallery';
  const preview = document.createElement('button');
  preview.type = 'button';
  preview.className = 'media-preview secondary';
  preview.setAttribute('aria-label', 'Προεπισκόπηση · ' + title);
  if (photo) {
    const image = document.createElement('img');
    image.src = src || mediaFileUrl(file);
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    preview.append(image);
  } else {
    preview.textContent = 'Προβολή';
  }
  const status = document.createElement('small');
  const header = document.createElement('div');
  header.className = 'media-row-heading';
  header.append(preview, label);
  element.append(header, status);
  const actions = document.createElement('details');
  actions.className = 'media-row-actions';
  const summary = document.createElement('summary');
  summary.textContent = 'Επεξεργασία';
  summary.setAttribute('aria-label', 'Επεξεργασία · ' + title);
  const controls = document.createElement('div');
  controls.className = 'toolbar';
  const row = { element, checkbox, status, actions, kind, title, src, file, removed: false };
  preview.addEventListener('click', () => {
    if (row.kind === 'link') window.open(row.src, '_blank', 'noopener,noreferrer');
    else showMediaPreview(row, photo);
  });
  const quick = document.createElement('div');
  quick.className = 'media-quick';
  row.quick = quick;
  const action = (title, handler, container = controls) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = title;
    button.addEventListener('click', () => { if (!busy) handler(); });
    container.append(button);
    return button;
  };
  if (kind !== 'cover') {
    row.up = action('↑ Πάνω', () => moveMediaRow(row, -1), quick);
    row.down = action('↓ Κάτω', () => moveMediaRow(row, 1), quick);
  }
  if (kind === 'gallery') row.cover = action('Εξώφυλλο', () => chooseCoverPhoto(row), quick);
  if (kind === 'videos') row.cover = action('Στην κορυφή', () => chooseCoverVideo(row), quick);
  action(kind === 'link' ? 'Αλλαγή συνδέσμου' : 'Αντικατάσταση', () => editMediaRow(row));
  action('Αφαίρεση', () => {
    setMediaRemoved(row, true);
    updateMediaActions();
    dirty = true;
  });
  actions.append(summary, controls);
  element.append(quick, actions);
  return row;
}
function mediaFileUrl(file) {
  if (!mediaObjectUrls.has(file)) mediaObjectUrls.set(file, URL.createObjectURL(file));
  return mediaObjectUrls.get(file);
}
function showMediaPreview(row, photo) {
  const item = document.createElement(photo ? 'img' : 'video');
  item.src = row.src || mediaFileUrl(row.file);
  if (photo) item.alt = row.title;
  else {
    const poster = selected?.videoPosters?.[row.src] ||
      (row.src === (selected?.videos?.[0] || selected?.video) ? selected?.videoPoster : '');
    if (poster) item.poster = poster;
    item.controls = true;
    item.playsInline = true;
    item.preload = 'metadata';
  }
  $('media-preview-title').textContent = row.title;
  $('media-preview-content').replaceChildren(item);
  $('media-preview-dialog').showModal();
}
$('close-media-preview').addEventListener('click', () => $('media-preview-dialog').close());
$('media-preview-dialog').addEventListener('close', () => $('media-preview-content').replaceChildren());
function updateMediaActions() {
  const active = mediaRows.filter(row => !row.removed);
  const cover = active.find(row => row.kind === 'cover') || active.find(row => row.src && row.src === form.elements.image.value.trim()) ||
    active.find(row => row.kind === 'gallery');
  const video = coverVideo && active.find(row => row.kind === 'videos');
  for (const row of mediaRows) {
    const peers = active.filter(item => item.kind === row.kind);
    const index = peers.indexOf(row);
    row.quick.hidden = row.removed || !row.quick.childElementCount;
    if (row.up) row.up.setAttribute('aria-disabled', String(index <= 0));
    if (row.down) row.down.setAttribute('aria-disabled', String(index < 0 || index === peers.length - 1));
    const chosen = row === cover || row === video;
    if (row.cover) row.cover.setAttribute('aria-pressed', String(chosen && (row.kind === 'videos' || form.elements.hero.checked)));
    row.status.textContent = row.removed ? 'Προς αφαίρεση'
      : chosen ? row === video ? 'Βίντεο στην κορυφή' : 'Εικόνα εξωφύλλου' : '';
  }
  const selectedRows = active.filter(row => row.checkbox.checked);
  const removed = mediaRows.length - active.length;
  $('editor-media-count').textContent = selectedRows.length + ' επιλεγμένα · ' + removed + ' προς αφαίρεση';
  const buttons = mediaPanel.querySelectorAll('[data-media-action]');
  for (const button of buttons) {
    const action = button.dataset.mediaAction;
    button.disabled = action === 'all' ? !active.length : action === 'undo' ? !removed
      : !selectedRows.length;
  }
}
function renderMediaList() {
  mediaList.replaceChildren(...['cover', 'gallery', 'videos', 'link'].flatMap(kind => mediaRows.filter(row => row.kind === kind).map(row => row.element)));
  mediaPanel.hidden = !mediaRows.length;
  updateMediaActions();
}
function updateCoverRow() {
  const src = form.elements.image.value.trim();
  mediaRows = mediaRows.filter(row => row.kind !== 'cover' || row.file);
  if (/^(?:\/(?!\/)|https:\/\/)/i.test(src) && !mediaRows.some(row => row.kind === 'gallery' && row.src === src && !row.removed)) {
    mediaRows.unshift(mediaRow('cover', 'Εξώφυλλο', { src }));
  }
  renderMediaList();
}
function showArticleMedia(item) {
  const photos = item?.gallery ?? [];
  const videos = item?.videos ?? (item?.video ? [item.video] : []);
  const links = item?.videoLinks ?? (item?.videoLink ? [item.videoLink] : []);
  mediaRows = [
    ...photos.map((src, index) => mediaRow('gallery', 'Φωτογραφία ' + (index + 1), { src })),
    ...videos.map((src, index) => mediaRow('videos', 'Βίντεο ' + (index + 1), { src })),
    ...links.map(src => mediaRow('link', src, { src })),
  ];
  updateCoverRow();
}
function mediaFileKind(file) {
  const video = file.type === 'video/mp4' || /\.mp4$/i.test(file.name);
  if (!video) photoType(file);
  const limit = video ? 48 : 10;
  if (file.size > limit * 1024 * 1024) throw Error('μέγιστο μέγεθος ' + limit + ' MB');
  return video ? 'videos' : 'gallery';
}
function addMediaFiles() {
  const added = [];
  const rejected = [];
  for (const file of mediaFiles.files) {
    try {
      added.push(mediaRow(mediaFileKind(file), file.name, { file }));
    } catch (error) {
      rejected.push(file.name + ' (' + error.message + ')');
    }
  }
  mediaFiles.value = '';
  if (added.length) {
    mediaRows.push(...added);
    dirty = true;
    renderMediaList();
  }
  $('media-add-error').textContent = rejected.length ? 'Αρχεία που δεν προστέθηκαν · ' + rejected.join(', ') : '';
}
function moveMediaRow(row, direction) {
  const peers = mediaRows.filter(item => !item.removed && item.kind === row.kind);
  const neighbor = peers[peers.indexOf(row) + direction];
  if (!neighbor) return;
  const from = mediaRows.indexOf(row);
  const to = mediaRows.indexOf(neighbor);
  [mediaRows[from], mediaRows[to]] = [mediaRows[to], mediaRows[from]];
  renderMediaList();
  (direction < 0 ? row.up : row.down).focus();
  dirty = true;
}
function chooseCoverPhoto(photo) {
  const current = form.elements.image.value.trim();
  const changed = current ? current !== photo.src : mediaRows.find(row => row.kind === 'gallery' && !row.removed) !== photo;
  if (current && current !== photo.src && !mediaRows.some(row => row.kind === 'gallery' && row.src === current && !row.removed)) {
    const oldCover = mediaRows.find(row => row.kind === 'cover' && row.src === current && !row.removed);
    if (oldCover) mediaRows.push(mediaRow('gallery', 'Προηγούμενο εξώφυλλο', { src: current }));
  }
  form.elements.image.value = '';
  form.elements.hero.checked = true;
  if (changed) {
    form.elements.alt.value = '';
    form.elements.caption.value = '';
  }
  mediaRows = mediaRows.flatMap(row => {
    if (row.kind !== 'cover') return [row];
    return row.file && !row.removed ? [mediaRow('gallery', row.file.name, { file: row.file })] : [];
  });
  mediaRows.splice(mediaRows.indexOf(photo), 1);
  mediaRows.unshift(photo);
  photo.checkbox.checked = false;
  updateCoverRow();
  photo.cover.focus();
  dirty = true;
}
function chooseCoverVideo(row) {
  const index = mediaRows.findIndex(item => item.kind === 'videos' && !item.removed);
  coverVideo = !coverVideo || mediaRows[index] !== row;
  if (coverVideo) {
    mediaRows.splice(mediaRows.indexOf(row), 1);
    mediaRows.splice(index, 0, row);
  }
  renderMediaList();
  row.cover.focus();
  dirty = true;
}
function editMediaRow(row) {
  if (row.kind === 'link') {
    editingMediaLink = row;
    mediaLink.value = row.src;
    mediaLink.setCustomValidity('');
    $('media-add').open = true;
    $('media-link-save').textContent = 'Αποθήκευση συνδέσμου';
    mediaLink.focus();
    return;
  }
  replacingMedia = row;
  mediaReplace.accept = row.kind === 'videos' ? 'video/mp4,.mp4' : 'image/jpeg,image/png,image/webp';
  mediaReplace.value = '';
  mediaReplace.click();
}
function saveMediaLink() {
  const value = mediaLink.value.trim();
  if (!value) return;
  let url;
  try { url = new URL(value); } catch { /* handled below */ }
  if (url?.protocol !== 'https:' || url.username || url.password || url.port) {
    const message = 'Βάλε έγκυρο σύνδεσμο βίντεο με https://.';
    mediaLink.setCustomValidity(message);
    $('media-add').open = true;
    mediaLink.reportValidity();
    throw Error(message);
  }
  const row = mediaRow('link', url.href, { src: url.href });
  const index = mediaRows.indexOf(editingMediaLink);
  if (index < 0) mediaRows.push(row);
  else mediaRows[index] = row;
  resetMediaLink();
  renderMediaList();
  dirty = true;
}
function resetMediaLink() {
  editingMediaLink = null;
  mediaLink.value = '';
  mediaLink.setCustomValidity('');
  $('media-link-save').textContent = 'Προσθήκη συνδέσμου';
}
function setMediaRemoved(row, removed) {
  row.removed = removed;
  row.checkbox.checked = false;
  row.checkbox.disabled = removed;
  row.actions.hidden = removed;
  row.element.classList.toggle('media-removed', removed);
  row.status.textContent = removed ? 'Προς αφαίρεση' : '';
  if (removed && editingMediaLink === row) resetMediaLink();
}
mediaPanel.addEventListener('click', event => {
  const button = event.target.closest('[data-media-action]');
  if (!button || busy) return;
  const active = mediaRows.filter(row => !row.removed);
  const checked = active.filter(row => row.checkbox.checked);
  switch (button.dataset.mediaAction) {
    case 'all':
    case 'none':
      for (const row of active) row.checkbox.checked = button.dataset.mediaAction === 'all';
      break;
    case 'remove':
    case 'keep':
      for (const row of active) {
        if (row.checkbox.checked === (button.dataset.mediaAction === 'remove')) setMediaRemoved(row, true);
      }
      dirty = true;
      break;
    case 'undo':
      mediaRows = mediaRows.filter(row => !row.replaces);
      for (const row of mediaRows) if (row.removed) setMediaRemoved(row, false);
      renderMediaList();
      dirty = true;
      break;
  }
  updateMediaActions();
});
mediaFiles.addEventListener('change', addMediaFiles);
mediaReplace.addEventListener('change', () => {
  const file = mediaReplace.files[0];
  const row = replacingMedia;
  replacingMedia = null;
  if (!file || !row || row.removed) return;
  try {
    const kind = mediaFileKind(file);
    if ((row.kind === 'videos') !== (kind === 'videos')) throw Error('Διάλεξε αρχείο του ίδιου τύπου.');
    const title = row.kind === 'cover' ? 'Εξώφυλλο · ' + file.name : file.name;
    const replacement = mediaRow(row.kind, title, { file });
    replacement.replaces = row.replaces || row;
    setMediaRemoved(row, true);
    mediaRows.splice(mediaRows.indexOf(row), row.replaces ? 1 : 0, replacement);
    renderMediaList();
    dirty = true;
    feedback('');
  } catch (error) {
    feedback(error.message, true);
  }
});
mediaLink.addEventListener('input', () => mediaLink.setCustomValidity(''));
mediaLink.addEventListener('invalid', () => { $('media-add').open = true; });
mediaLink.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  $('media-link-save').click();
});
$('media-link-save').addEventListener('click', event => run(async () => saveMediaLink(), event.currentTarget));
form.elements.image.addEventListener('change', updateCoverRow);
form.elements.hero.addEventListener('change', updateMediaActions);
function openArticle(item = null) {
  selected = item;
  form.reset();
  uploadNotice('');
  $('media-add-error').textContent = '';
  $('media-add').open = false;
  $('media-cover-options').open = false;
  replacingMedia = null;
  resetMediaLink();
  for (const url of mediaObjectUrls.values()) URL.revokeObjectURL(url);
  mediaObjectUrls.clear();
  capturedPosters.clear();
  coverVideo = item?.heroVideo === true;
  for (const key of ['title','summary','author','deck','image','alt','caption']) form.elements[key].value = item?.[key] ?? '';
  if (!item) form.elements.author.value = state.user.name;
  form.elements.author.readOnly = state.user.role !== 'owner';
  form.elements.category.value = item?.sections[0] || 'reportaz';
  form.elements.date.value = item?.date || today();
  form.elements.hero.checked = item?.hero ?? true;
  showArticleMedia(item);
  form.elements.featured.checked = state.featured === item?.id;
  form.elements.featured.disabled = !!item?.archived;
  editor.innerHTML = item?.body || '';
  initialHtml = editor.innerHTML;
  $('edit-title').textContent = item ? 'Επεξεργασία άρθρου' : 'Νέο άρθρο';
  $('publish').textContent = item ? 'Αποθήκευση αλλαγών' : 'Δημοσίευση';
  dirty = false;
  articles();
}
function options(element, title, entries, selected) {
  element.replaceChildren(new Option(title, ''), ...entries.map(item => new Option(item.title,item.id)));
  element.value = selected || '';
}
function openIssue(id) {
  const item = state.issues.find(i => i.id === id);
  const fields = issueForm.elements;
  fields.title.value = item?.title || '';
  fields.status.value = item?.status || 'pending';
  fields.date.value = item?.date || today();
  fields.article.value = item?.article || '';
  fields.update.value = item?.update || '';
}
function updateIssues(id) {
  options($('issue-select'), 'Νέα υπόθεση', state.issues, id);
  options($('issue-article'), 'Χωρίς σύνδεσμο', sorted());
  openIssue(id);
}
function activate(data) {
  const resume = dirty && state?.user.role === data.user.role && state.user.id === data.user.id;
  state = data;
  $('login-panel').hidden = true;
  $('desk').hidden = false;
  $('mobile-publishing-text').textContent = data.mobileHelp || '';
  $('mobile-publishing').hidden = !data.mobileHelp;
  $('editor-role').textContent = (data.user.role === 'owner' ? 'Ιδιοκτήτης' : 'Συνδιαχειριστής') + ' · ' + data.user.name;
  $('team-panel').hidden = data.user.role !== 'owner';
  $('team-panel').open = false;
  clearTeam();
  if (resume) {
    articles();
    feedback('Η σύνδεση ανανεώθηκε. Οι αλλαγές του άρθρου διατηρήθηκαν.');
    form.elements.title.focus();
  } else {
    openArticle();
  }
  updateIssues();
}
function blocks(node) {
  if (node.nodeType === Node.TEXT_NODE) return [node.textContent];
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const raw = node.tagName.toLowerCase();
  if (['script','style','iframe','object'].includes(raw)) return [];
  const tag = raw === 'h1' ? 'h2' : raw === 'font' ? 'span' : raw;
  const children = Array.from(node.childNodes).flatMap(blocks);
  if (!'p div span br hr h2 h3 h4 strong b em i u s ul ol li blockquote a img figure figcaption table thead tbody tr th td dl dt dd details summary sup sub'.split(' ').includes(tag)) return children;
  const block = { tag, children };
  if (tag === 'a') block.href = node.getAttribute('href');
  if (tag === 'img') { block.src = node.getAttribute('src'); block.alt = node.getAttribute('alt'); }
  return [block];
}
function photoType(file) {
  if (['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return file.type;
  const extension = file.name.split('.').at(-1).toLowerCase();
  const types = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  if (!Object.hasOwn(types, extension)) throw Error('Διάλεξε φωτογραφίες JPG, PNG ή WebP.');
  return types[extension];
}
function payload() {
  saveMediaLink();
  const fields = form.elements;
  const formData = new FormData(form);
  const data = Object.fromEntries(formData);
  const removed = mediaRows.filter(row => row.removed);
  data.removeGallery = removed.filter(row => row.kind === 'gallery' && row.src).map(row => row.src);
  data.removeVideos = removed.filter(row => row.kind === 'videos' && row.src).map(row => row.src);
  const active = mediaRows.filter(row => !row.removed);
  data.videoLinks = active.filter(row => row.kind === 'link').map(row => row.src);
  const orderFor = kind => {
    let index = 0;
    return active.filter(row => row.kind === kind).map(row => row.src || index++);
  };
  data.mediaOrder = { gallery: orderFor('gallery'), videos: orderFor('videos') };
  if (removed.some(row => (row.kind === 'cover' || row.kind === 'gallery') && row.src === data.image.trim())) data.image = '';
  data.id = selected?.id;
  data.rev = selected?.rev;
  data.hero = fields.hero.checked;
  data.heroVideo = coverVideo && active.some(row => row.kind === 'videos');
  data.featured = fields.featured.checked;
  if (!selected || editor.innerHTML !== initialHtml) data.blocks = Array.from(editor.childNodes).flatMap(blocks);
  const filesFor = kind => mediaRows.filter(row => row.kind === kind && row.file && !row.removed).map(row => row.file);
  const [cover] = filesFor('cover');
  const gallery = filesFor('gallery');
  const videos = filesFor('videos');
  const photos = cover ? [cover, ...gallery] : gallery;
  if (photos.some(file => file.size > 10 * 1024 * 1024)) throw Error('Κάθε φωτογραφία χωρά έως 10 MB.');
  if (videos.some(file => (!/\.mp4$/i.test(file.name) && file.type !== 'video/mp4') || file.size > 48 * 1024 * 1024)) {
    throw Error('Διάλεξε αρχεία MP4 έως 48 MB το καθένα.');
  }
  photos.forEach(photoType);
  return { data, files: { cover, gallery, videos, posters: [] } };
}
async function mapFiles(files, use) {
  const media = { gallery: [], videos: [] };
  if (files.cover) media.cover = await use(files.cover, photoType(files.cover));
  media.posters = [];
  for (const [reference, file] of files.posters) media.posters.push([reference, await use(file, 'image/jpeg')]);
  for (const file of files.gallery) media.gallery.push(await use(file, photoType(file)));
  for (const file of files.videos) media.videos.push(await use(file, 'video/mp4'));
  return media;
}
async function captureVideoPoster(source) {
  const objectUrl = typeof source === 'string' ? '' : URL.createObjectURL(source);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  let timer;
  let captured = false;
  try {
    return await new Promise(resolve => {
      timer = setTimeout(() => resolve(null), 6500);
      video.addEventListener('error', () => resolve(null), { once:true });
      const sample = document.createElement('canvas');
      sample.width = 32;
      sample.height = 18;
      const probe = sample.getContext('2d', { willReadFrequently: true });
      const times = [0.2, 0.65, 1.2, 2.4];
      let next = 0;
      const capture = () => {
        try {
          if (captured || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
          probe.drawImage(video, 0, 0, sample.width, sample.height);
          const pixels = probe.getImageData(0, 0, sample.width, sample.height).data;
          let lit = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) >= 26) lit++;
          }
          if (lit < sample.width * sample.height / 20) {
            const time = times[next++];
            if (time !== undefined && time < video.duration) video.currentTime = time;
            else resolve(null);
            return;
          }
          captured = true;
          const canvas = document.createElement('canvas');
          const scale = Math.min(1, 1200 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(blob => resolve(blob ? new File([blob], 'Καρέ βίντεο.jpg', { type:'image/jpeg' }) : null), 'image/jpeg', 0.85);
        } catch {
          resolve(null);
        }
      };
      video.addEventListener('seeked', capture);
      video.addEventListener('loadeddata', () => { if (!video.seeking) capture(); }, { once:true });
      video.src = objectUrl || source;
    });
  } finally {
    clearTimeout(timer);
    video.removeAttribute('src');
    video.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}
async function prepareArticleMedia(data, files) {
  const rows = mediaRows.filter(row => !row.removed && row.kind === 'videos');
  const pending = rows.flatMap((row, index) => {
    if (row.src && (selected?.videoPosters?.[row.src] ||
        (selected?.videoPoster && row.src === (selected.videos?.[0] || selected.video)))) return [];
    if (!row.file && !/^\/uploads\/[a-f0-9]{64}\.mp4$/.test(row.src || '')) return [];
    return [[data.mediaOrder.videos[index], row.src || row.file]];
  });
  if (pending.length) uploadNotice('Ετοιμάζονται οι εικόνες προεπισκόπησης των βίντεο…', null);
  for (let index = 0; index < pending.length; index += 3) {
    const batch = await Promise.all(pending.slice(index, index + 3).map(async ([reference, source]) => {
      const file = capturedPosters.get(source) || await captureVideoPoster(source).catch(() => null);
      if (file) capturedPosters.set(source, file);
      return [reference, file];
    }));
    files.posters.push(...batch.filter(([, file]) => file));
  }
}
function previewFile(file, type) {
  const url = URL.createObjectURL(type === file.type ? file : file.slice(0, file.size, type));
  previewUrls.add(url);
  return url;
}
function clearPreview() {
  for (const url of previewUrls) URL.revokeObjectURL(url);
  previewUrls.clear();
}
async function publishArticle(data, files) {
  await prepareArticleMedia(data, files);
  const count = files.gallery.length + Number(!!files.cover) + files.posters.length + files.videos.length;
  const submit = async () => {
    let index = 0;
    const stagedMedia = await mapFiles(files, async (file, type) => {
      const label = (++index) + ' από ' + count + ' (' + file.name + ')';
      const uploadId = await uploadFile(file, type, label);
      uploadNotice('Επιβεβαιώθηκαν ' + index + ' από ' + count + ' αρχεία.', 100);
      return uploadId;
    });
    uploadNotice((count ? 'Μεταφορτώθηκαν όλα τα αρχεία. ' : '') + 'Αποθήκευση δημοσίευσης…', null);
    return api('article', { ...data, stagedMedia });
  };
  try {
    return await submit();
  } catch (error) {
    if (error.status !== 410) throw error;
    stagedFiles = new WeakMap();
    return submit();
  }
}

function clearTeam() {
  $('team-controls').hidden = true;
  $('team-invite-result').hidden = true;
  $('team-invite-link').value = '';
  $('team-invite').reset();
  $('team-accounts').replaceChildren();
  $('team-pending').replaceChildren();
  $('team-status').textContent = '';
}
function showTeam(data) {
  $('team-controls').hidden = !data.enabled;
  $('team-status').textContent = data.enabled ? '' : 'Εκκρεμεί η σύνδεση της εφαρμογής GitHub για τις προσκλήσεις.';
  if (!data.enabled) return;
  const date = new Intl.DateTimeFormat('el-GR', { dateStyle: 'medium', timeZone: 'Europe/Athens' });
  function rows(list, pending) {
    if (!list.length) {
      const li = document.createElement('li');
      li.textContent = pending ? 'Καμία ενεργή πρόσκληση.' : 'Κανένας ενεργός συνεργάτης.';
      return [li];
    }
    return list.map(item => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = item.name + ' · ' + item.email + (pending ? ' · Λήγει ' + date.format(item.expires) : '');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = pending ? 'Ακύρωση πρόσκλησης' : 'Ανάκληση πρόσβασης';
      button.addEventListener('click', () => {
        if (!window.confirm((pending ? 'Να ακυρωθεί η πρόσκληση για ' : 'Να ανακληθεί η πρόσβαση του χρήστη ') + item.email + ';')) return;
        run(async () => {
          const next = await api('team-remove', { id: item.id });
          showTeam(next);
          $('team-invite-result').hidden = true;
          $('team-invite-link').value = '';
          $('team-status').textContent = pending ? 'Η πρόσκληση ακυρώθηκε.' : 'Η πρόσβαση ανακλήθηκε.';
        }, button);
      });
      li.append(label, button);
      return li;
    });
  }
  $('team-accounts').replaceChildren(...rows(data.accounts, false));
  $('team-pending').replaceChildren(...rows(data.invites, true));
}
$('team-panel').addEventListener('toggle', () => {
  if ($('team-panel').open) run(async () => showTeam(await api('team')));
});
$('team-invite').addEventListener('submit', event => {
  event.preventDefault();
  run(async () => {
    const data = await api('team-invite', Object.fromEntries(new FormData(event.target)));
    showTeam(data);
    event.target.reset();
    $('team-invite-link').value = data.link;
    $('team-invite-result').hidden = false;
  }, event.submitter);
});
$('team-copy').addEventListener('click', async () => {
  const link = $('team-invite-link');
  try {
    await navigator.clipboard.writeText(link.value);
    $('team-status').textContent = 'Ο σύνδεσμος αντιγράφηκε.';
  } catch {
    link.select();
    $('team-status').textContent = 'Αντίγραψε τον επιλεγμένο σύνδεσμο.';
  }
});
$('login-switch')?.addEventListener('click', () => {
  if (busy) return;
  loginMode = loginMode === 'owner' ? 'team' : 'owner';
  showLogin();
});
for (const mode of ['team-login', 'team-accept']) {
  $(mode).addEventListener('submit', event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    data.remember = event.target.elements.remember?.checked === true;
    if (mode === 'team-accept') data.code = inviteCode;
    event.target.elements.password.value = '';
    run(async () => {
      await api(mode, data);
      if (mode === 'team-accept') history.replaceState(null, '', location.pathname + location.search);
      loginMode = 'team';
      activate(await api('state'));
    }, event.submitter);
  });
}

$('login').addEventListener('submit', event => {
  event.preventDefault();
  const key = $('key');
  const token = key.value;
  const remember = event.target.elements.remember?.checked === true;
  run(async () => {
    try {
      await api('login', { token, remember });
      activate(await api('state'));
    } finally {
      key.value = '';
    }
  }, event.submitter);
});
$('logout').addEventListener('click', event => {
  if (!confirmChange()) return;
  run(async () => {
    await api('logout',{});
    editor.replaceChildren();
    state = null;
    selected = null;
    dirty = false;
    clearTeam();
    showLogin();
  }, event.currentTarget);
});
$('new-article').addEventListener('click', () => {
  if (busy || !confirmChange()) return;
  openArticle();
  form.elements.title.focus();
});
form.addEventListener('input', event => {
  if (event.target.matches('.media-checkbox')) updateMediaActions();
  else dirty = true;
});
editor.addEventListener('paste', event => {
  event.preventDefault();
  document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
});
editor.addEventListener('drop', event => event.preventDefault());
form.querySelectorAll('[data-format]').forEach(button => {
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', () => {
    editor.focus();
    let value = button.dataset.value;
    const selection = window.getSelection();
    const node = selection?.anchorNode;
    const link = (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest('a');
    const currentLink = link && editor.contains(link) ? link : null;
    if (button.dataset.format === 'createLink') {
      value = window.prompt('Διεύθυνση συνδέσμου (https://)', currentLink?.getAttribute('href') || '');
      if (!value || !/^(https:\/\/|\/(?!\/))/.test(value)) return;
      if (currentLink) {
        currentLink.setAttribute('href', value);
        dirty = true;
        return;
      }
    }
    if (currentLink && button.dataset.format === 'unlink') {
      const range = document.createRange();
      range.selectNodeContents(currentLink);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    document.execCommand(button.dataset.format, false, value);
    dirty = true;
  });
});
$('preview').addEventListener('click', event => {
  if (!form.reportValidity()) return;
  run(async () => {
    clearPreview();
    const { data, files } = payload();
    try {
      await prepareArticleMedia(data, files);
      const previewMedia = await mapFiles(files, previewFile);
      uploadNotice('');
      $('preview-frame').srcdoc = await api('preview', { ...data, previewMedia });
      dialog.showModal();
    } catch (error) {
      uploadNotice('');
      clearPreview();
      throw error;
    }
  }, event.currentTarget);
});
$('close-preview').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => {
  $('preview-frame').removeAttribute('srcdoc');
  clearPreview();
});
form.addEventListener('submit', event => {
  event.preventDefault();
  run(async () => {
    const selectedIssue = $('issue-select').value;
    try {
      const { data, files } = payload();
      state = await publishArticle(data, files);
    } catch (error) {
      uploadNotice(error.message, undefined, true);
      throw error;
    }
    openArticle(state.articles.find(a => a.id === state.id));
    updateIssues(selectedIssue);
    uploadNotice('Το άρθρο αποθηκεύτηκε.');
    feedback('Το άρθρο αποθηκεύτηκε. ');
    const a = document.createElement('a');
    a.href = state.path;
    a.textContent = 'Δες τη δημοσίευση';
    const share = document.createElement('a');
    share.href = '/koinopoiisi/facebook/' + encodeURIComponent(state.id);
    share.textContent = 'Κοινοποίηση στο Facebook';
    share.target = '_blank';
    share.rel = 'noopener';
    $('feedback').append(a, ' · ', share);
  }, event.submitter);
});
$('issue-select').addEventListener('change', event => openIssue(event.currentTarget.value));
issueForm.addEventListener('submit', event => {
  event.preventDefault();
  run(async () => {
    const data = Object.fromEntries(new FormData(issueForm));
    const issue = state.issues.find(i => i.id === $('issue-select').value);
    data.id = issue?.id;
    data.rev = issue?.rev;
    state = await api('issue',data);
    updateIssues(state.id);
    feedback('Η ενημέρωση αποθηκεύτηκε στο Παρατηρητήριο.');
  }, event.submitter);
});
window.addEventListener('beforeunload', event => {
  if (dirty) { event.preventDefault(); event.returnValue = true; }
});
$('retry-session').addEventListener('click', restoreSession);
if (inviteCode) showLogin();
else void restoreSession();
})();
