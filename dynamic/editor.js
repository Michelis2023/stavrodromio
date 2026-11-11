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
const inviteCode = new URLSearchParams(window.location.hash.slice(1)).get('invite');
let loginMode = inviteCode ? 'accept' : 'owner';
let state;
let selected;
let initialHtml = '';
let dirty = false;
let busy = false;
let stagedFiles = new WeakMap();
let mediaRows = [];
const previewUrls = new Set();
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
async function run(action, button, showErrors = true) {
  if (busy) return;
  busy = true;
  if (button) button.disabled = true;
  feedback('');
  try { await action(); }
  catch (error) {
    if (error.status === 401 && $('desk').hidden && !showErrors) return;
    if (error.status === 401 && !$('desk').hidden) showLogin();
    feedback(error.message, true);
  } finally {
    busy = false;
    if (button) button.disabled = false;
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
  if (src && kind !== 'videos') {
    const image = document.createElement('img');
    image.src = src;
    image.alt = '';
    image.loading = 'lazy';
    label.append(image);
  }
  const status = document.createElement('small');
  element.append(label, status);
  if (kind === 'videos' && src?.startsWith('/uploads/')) {
    const preview = document.createElement('a');
    preview.href = src;
    preview.target = '_blank';
    preview.rel = 'noopener';
    preview.textContent = 'Προβολή βίντεο';
    preview.setAttribute('aria-label', 'Προβολή ' + title.toLocaleLowerCase('el'));
    element.append(preview);
  }
  return { element, checkbox, status, kind, title, src, file, removed: false };
}
function updateMediaActions() {
  const active = mediaRows.filter(row => !row.removed);
  const selectedRows = active.filter(row => row.checkbox.checked);
  const removed = mediaRows.length - active.length;
  $('editor-media-count').textContent = selectedRows.length + ' επιλεγμένα · ' + removed + ' προς αφαίρεση';
  const buttons = mediaPanel.querySelectorAll('[data-media-action]');
  for (const button of buttons) {
    const action = button.dataset.mediaAction;
    button.disabled = action === 'all' ? !active.length : action === 'undo' ? !removed
      : action === 'cover' ? selectedRows.length !== 1 || selectedRows[0].kind !== 'gallery'
      : !selectedRows.length;
  }
}
function renderMediaList() {
  mediaList.replaceChildren(...mediaRows.map(row => row.element));
  mediaPanel.hidden = !mediaRows.length;
  updateMediaActions();
}
function updateCoverRow() {
  const src = form.elements.image.value.trim();
  mediaRows = mediaRows.filter(row => row.kind !== 'cover' || row.file);
  if (/^(?:\/(?!\/)|https:\/\/)/i.test(src)) mediaRows.unshift(mediaRow('cover', 'Εξώφυλλο', { src }));
  renderMediaList();
}
function showArticleMedia(item) {
  const photos = item?.gallery ?? [];
  const videos = item?.videos ?? (item?.video ? [item.video] : []);
  mediaRows = [
    ...photos.map((src, index) => mediaRow('gallery', 'Φωτογραφία ' + (index + 1), { src })),
    ...videos.map((src, index) => mediaRow('videos', 'Βίντεο ' + (index + 1), { src })),
  ];
  updateCoverRow();
}
function addMediaFiles() {
  const added = [];
  const rejected = [];
  for (const file of mediaFiles.files) {
    try {
      const video = file.type === 'video/mp4' || /\.mp4$/i.test(file.name);
      if (!video) photoType(file);
      const limit = video ? 48 : 10;
      if (file.size > limit * 1024 * 1024) throw Error('μέγιστο μέγεθος ' + limit + ' MB');
      added.push(mediaRow(video ? 'videos' : 'gallery', file.name, { file }));
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
function setMediaRemoved(row, removed) {
  row.removed = removed;
  row.checkbox.checked = false;
  row.checkbox.disabled = removed;
  row.element.classList.toggle('media-removed', removed);
  row.status.textContent = removed ? 'Προς αφαίρεση' : '';
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
      for (const row of mediaRows) if (row.removed) setMediaRemoved(row, false);
      dirty = true;
      break;
    case 'cover': {
      if (checked.length !== 1 || checked[0].kind !== 'gallery') return;
      const photo = checked[0];
      form.elements.image.value = photo.src || '';
      mediaRows = mediaRows.flatMap(row => {
        if (row === photo) {
          return row.file ? [mediaRow('cover', 'Εξώφυλλο · ' + row.title, { file: row.file })] : [row];
        }
        if (row.kind !== 'cover') return [row];
        return row.file && !row.removed ? [mediaRow('gallery', row.file.name, { file: row.file })] : [];
      });
      photo.checkbox.checked = false;
      updateCoverRow();
      dirty = true;
      break;
    }
  }
  updateMediaActions();
});
mediaFiles.addEventListener('change', addMediaFiles);
form.elements.videoLink.addEventListener('invalid', () => { $('media-add').open = true; });
form.elements.image.addEventListener('change', updateCoverRow);
function openArticle(item = null) {
  selected = item;
  form.reset();
  uploadNotice('');
  $('media-add-error').textContent = '';
  $('media-add').open = Boolean(item?.videoLink);
  $('media-cover-options').open = false;
  for (const key of ['title','summary','author','deck','image','alt','caption']) form.elements[key].value = item?.[key] ?? '';
  showArticleMedia(item);
  form.elements.videoLink.value = item?.videoLink || '';
  if (!item) form.elements.author.value = state.user.name;
  form.elements.author.readOnly = state.user.role !== 'owner';
  form.elements.category.value = item?.sections[0] || 'reportaz';
  form.elements.date.value = item?.date || today();
  form.elements.hero.checked = item?.hero ?? true;
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
  const fields = form.elements;
  const formData = new FormData(form);
  const data = Object.fromEntries(formData);
  const removed = mediaRows.filter(row => row.removed);
  data.removeGallery = removed.filter(row => row.kind === 'gallery' && row.src).map(row => row.src);
  data.removeVideos = removed.filter(row => row.kind === 'videos' && row.src).map(row => row.src);
  if (removed.some(row => row.kind === 'cover' && row.src === data.image.trim())) data.image = '';
  data.id = selected?.id;
  data.rev = selected?.rev;
  data.hero = fields.hero.checked;
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
  return { data, files: { cover, gallery, videos } };
}
async function mapFiles(files, use) {
  const media = { gallery: [], videos: [] };
  if (files.cover) media.cover = await use(files.cover, photoType(files.cover));
  for (const file of files.gallery) media.gallery.push(await use(file, photoType(file)));
  for (const file of files.videos) media.videos.push(await use(file, 'video/mp4'));
  return media;
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
  const count = files.gallery.length + Number(!!files.cover) + files.videos.length;
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
  run(async () => {
    try {
      await api('login', { token });
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
    if (button.dataset.format === 'createLink') {
      value = window.prompt('Διεύθυνση συνδέσμου (https://)');
      if (!value || !/^(https:\/\/|\/(?!\/))/.test(value)) return;
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
      const previewMedia = await mapFiles(files, previewFile);
      $('preview-frame').srcdoc = await api('preview', { ...data, previewMedia });
      dialog.showModal();
    } catch (error) {
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
    $('feedback').append(a);
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
showLogin();
if (!inviteCode) run(async () => activate(await api('state')), null, false);
})();
