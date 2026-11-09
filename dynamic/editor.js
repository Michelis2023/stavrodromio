'use strict';
(function editor() {
const $ = id => document.getElementById(id);
const form = $('article-form');
const editor = $('body-editor');
const issueForm = $('issue-form');
const dialog = $('preview-dialog');
let state;
let selected;
let initialHtml = '';
let dirty = false;
let busy = false;
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
function showLogin() {
  $('desk').hidden = true;
  $('login-panel').hidden = false;
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
    b.addEventListener('click', () => { if (!busy && confirmChange()) openArticle(item); });
    return b;
  }));
}
function confirmChange() { return !dirty || window.confirm('Υπάρχουν αλλαγές χωρίς αποθήκευση. Θέλεις να αλλάξεις άρθρο;'); }
function openArticle(item = null) {
  selected = item;
  form.reset();
  for (const key of ['title','summary','author','deck','image','alt','caption']) form.elements[key].value = item?.[key] ?? '';
  if (!item) form.elements.author.value = 'Μιχαήλ Σωτηρίου Μιχαλακόπουλος';
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
  state = data;
  $('login-panel').hidden = true;
  $('desk').hidden = false;
  openArticle();
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
async function payload() {
  const fields = form.elements;
  const data = Object.fromEntries(new FormData(form));
  delete data.cover;
  data.id = selected?.id;
  data.rev = selected?.rev;
  data.hero = fields.hero.checked;
  data.featured = fields.featured.checked;
  if (!selected || editor.innerHTML !== initialHtml) data.blocks = Array.from(editor.childNodes).flatMap(blocks);
  const cover = fields.cover.files[0];
  if (cover) {
    if (cover.size > 3 * 1024 * 1024) throw Error('Διάλεξε εικόνα έως 3 MB.');
    data.upload = await new Promise((resolve,reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Η εικόνα δεν διαβάστηκε.'));
      reader.readAsDataURL(cover);
    });
  }
  return data;
}
$('login').addEventListener('submit', event => {
  event.preventDefault();
  const token = $('key').value;
  $('key').value = '';
  run(async () => { await api('login',{token}); activate(await api('state')); }, event.submitter);
});
$('logout').addEventListener('click', event => {
  if (!confirmChange()) return;
  run(async () => {
    await api('logout',{});
    editor.replaceChildren();
    state = null;
    selected = null;
    dirty = false;
    showLogin();
  }, event.currentTarget);
});
$('new-article').addEventListener('click', () => { if (!busy && confirmChange()) openArticle(); });
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
    $('preview-frame').srcdoc = await api('preview',await payload());
    dialog.showModal();
  }, event.currentTarget);
});
$('close-preview').addEventListener('click', () => dialog.close());
form.addEventListener('submit', event => {
  event.preventDefault();
  run(async () => {
    const selectedIssue = $('issue-select').value;
    state = await api('article',await payload());
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
run(async () => activate(await api('state')), null, false);
})();
