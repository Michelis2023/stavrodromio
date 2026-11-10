'use strict';
(function editor() {
const $ = id => document.getElementById(id);
const form = $('article-form');
const editor = $('body-editor');
const issueForm = $('issue-form');
const dialog = $('preview-dialog');
const inviteCode = new URLSearchParams(window.location.hash.slice(1)).get('invite');
let loginMode = inviteCode ? 'accept' : 'owner';
let state;
let selected;
let initialHtml = '';
let dirty = false;
let busy = false;
let stagedFiles = new WeakMap();
const previewUrls = new Set();
const today = () => new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Athens'}).format(new Date());
function feedback(message, error = false) {
  $('feedback').textContent = message;
  $('feedback').classList.toggle('error', error);
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
async function uploadFile(file, type) {
  if (stagedFiles.has(file)) return stagedFiles.get(file);
  const response = await fetch('/api/admin/stage-media', { method: 'POST', headers: { 'Content-Type': type }, body: file });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error || 'Η μεταφόρτωση δεν ολοκληρώθηκε.'), { status: response.status });
  stagedFiles.set(file, result.uploadId);
  return result.uploadId;
}
function showLogin() {
  $('desk').hidden = true;
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
function showArticleMedia(item) {
  const gallery = $('existing-gallery');
  const photos = item?.gallery ?? [];
  gallery.replaceChildren(...photos.map((src, index) => {
    const label = document.createElement('label');
    const image = document.createElement('img');
    image.src = src;
    image.alt = '';
    image.loading = 'lazy';
    const remove = document.createElement('input');
    remove.type = 'checkbox';
    remove.name = 'removeGallery';
    remove.value = src;
    label.append(image, remove, ' Αφαίρεση φωτογραφίας ' + (index + 1));
    return label;
  }));
  gallery.hidden = !photos.length;
  const videoList = $('existing-videos');
  const videos = item?.videos ?? (item?.video ? [item.video] : []);
  videoList.replaceChildren(...videos.map((src, index) => {
    const label = document.createElement('label');
    const remove = document.createElement('input');
    remove.type = 'checkbox';
    remove.name = 'removeVideos';
    remove.value = src;
    label.append(remove, ' Αφαίρεση βίντεο ' + (index + 1));
    return label;
  }));
  videoList.hidden = !videos.length;
}
function openArticle(item = null) {
  selected = item;
  form.reset();
  showArticleMedia(item);
  for (const key of ['title','summary','author','deck','image','alt','caption']) form.elements[key].value = item?.[key] ?? '';
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
  for (const key of ['cover', 'gallery', 'videos']) delete data[key];
  data.removeGallery = formData.getAll('removeGallery');
  data.removeVideos = formData.getAll('removeVideos');
  data.id = selected?.id;
  data.rev = selected?.rev;
  data.hero = fields.hero.checked;
  data.featured = fields.featured.checked;
  if (!selected || editor.innerHTML !== initialHtml) data.blocks = Array.from(editor.childNodes).flatMap(blocks);
  const cover = fields.cover.files[0];
  const gallery = [...fields.gallery.files];
  const videos = [...fields.videos.files];
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
    const stagedMedia = await mapFiles(files, (file, type) => {
      feedback('Μεταφόρτωση αρχείου ' + (++index) + ' από ' + count + '…');
      return uploadFile(file, type);
    });
    if (count) feedback('Αποθήκευση δημοσίευσης…');
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
form.addEventListener('input', () => { dirty = true; });
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
    const { data, files } = payload();
    state = await publishArticle(data, files);
    openArticle(state.articles.find(a => a.id === state.id));
    updateIssues(selectedIssue);
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
