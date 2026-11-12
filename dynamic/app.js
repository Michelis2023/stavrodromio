'use strict';

const connection = navigator.connection;
if (!connection?.saveData && !['slow-2g', '2g', '3g'].includes(connection?.effectiveType)) {
  const prefetched = new Set();
  const prefetch = event => {
    if (event.type === 'pointerover' && event.pointerType !== 'mouse') return;
    const anchor = event.target.closest('a[href]');
    if (!anchor || anchor.target || anchor.hasAttribute('download') || prefetched.size >= 6) return;
    const url = new URL(anchor.href);
    if (url.origin !== location.origin || url.search || url.hash || url.pathname === location.pathname ||
        !/^\/(?:arxeio|paratiritirio|(?:reportaz|history|laografia|autodioikisi|article-[a-z0-9-]+)\.html)?$/.test(url.pathname) ||
        prefetched.has(url.href)) return;
    prefetched.add(url.href);
    const hint = document.createElement('link');
    hint.rel = 'prefetch';
    hint.href = url.href;
    document.head.append(hint);
  };
  document.addEventListener('pointerover', prefetch);
  document.addEventListener('focusin', prefetch);
}

for (const button of document.querySelectorAll('[data-video-embed]')) {
  button.hidden = false;
  button.addEventListener('click', () => {
    const player = document.createElement('iframe');
    player.className = 'article-external-video';
    player.dataset.provider = button.dataset.provider;
    player.title = 'Βίντεο: ' + button.dataset.videoTitle;
    player.allow = 'encrypted-media; picture-in-picture; fullscreen';
    player.allowFullscreen = true;
    player.tabIndex = 0;
    player.src = button.dataset.videoEmbed;
    button.replaceWith(player);
    player.focus();
  });
}

for (const panel of document.querySelectorAll('[data-article-share]')) {
  const address = panel.querySelector('input');
  const share = panel.querySelector('[data-native-share]');
  const copy = panel.querySelector('[data-copy-link]');
  const retry = panel.querySelector('[data-retry-share]');
  const status = panel.querySelector('[role="status"]');
  const shareData = () => ({ title: panel.dataset.title, url: address.value });
  if (typeof navigator.share === 'function') {
    share.hidden = false;
    share.addEventListener('click', async () => {
      status.textContent = '';
      try {
        await navigator.share(shareData());
      } catch (error) {
        if (error.name !== 'AbortError') status.textContent = 'Χρησιμοποίησε την αντιγραφή συνδέσμου για κοινοποίηση.';
      }
    });
  }
  copy.hidden = false;
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(address.value);
      status.textContent = 'Ο σύνδεσμος αντιγράφηκε.';
    } catch {
      address.focus();
      address.select();
      status.textContent = 'Αντίγραψε τον επιλεγμένο σύνδεσμο.';
    }
  });
  let pending = false;
  async function prepareLink() {
    if (!panel.open || pending) return;
    pending = true;
    let ready = false;
    address.value = '';
    address.disabled = share.disabled = copy.disabled = true;
    if (retry) retry.hidden = true;
    status.textContent = 'Ετοιμάζεται η προεπισκόπηση του άρθρου…';
    try {
      for (let attempt = 0; attempt < 13 && panel.open; attempt++) {
        const result = await fetch(panel.dataset.shareEndpoint, { signal: AbortSignal.timeout?.(8000) });
        if (result.status === 202 || result.status >= 500) {
          if (attempt < 12) await new Promise(resolve => setTimeout(resolve, 4000));
          continue;
        }
        if (!result.ok) break;
        const { url } = await result.json();
        if (!url) break;
        address.value = url;
        ready = true;
        break;
      }
    } catch {
      // Keep sharing disabled until the preview service responds successfully.
    } finally {
      pending = false;
      address.disabled = share.disabled = copy.disabled = !ready || !panel.open;
      if (ready && typeof navigator.canShare === 'function') share.hidden = !navigator.canShare(shareData());
      if (retry) retry.hidden = ready;
      status.textContent = ready || !panel.open ? '' : 'Η προεπισκόπηση δεν είναι ακόμη έτοιμη.';
    }
  }
  panel.addEventListener('toggle', () => {
    if (panel.open) return prepareLink();
    address.disabled = share.disabled = copy.disabled = true;
    address.value = '';
  });
  retry?.addEventListener('click', prepareLink);
  prepareLink();
}

for (const section of document.querySelectorAll('[data-comments]')) {
  const form = section.querySelector('[data-comment-form]');
  const list = section.querySelector('[data-comment-list]');
  const status = section.querySelector('[data-comment-status]');
  const submit = form.querySelector('button');
  const login = section.querySelector('[data-comment-login]');
  const verify = section.querySelector('[data-comment-verify]');
  const readerLabel = section.querySelector('[data-comment-reader]');
  const google = section.querySelector('[data-comment-google]');
  const date = new Intl.DateTimeFormat('el-GR', { dateStyle: 'medium', timeZone: 'Europe/Athens' });
  let submissionId;

  function show(items) {
    list.replaceChildren();
    if (!items.length) list.textContent = 'Δεν υπάρχουν ακόμη σχόλια.';
    for (const item of items) {
      const row = document.createElement('article');
      row.className = 'comment-entry';
      const name = document.createElement('strong');
      name.textContent = item.name;
      const time = document.createElement('time');
      time.dateTime = item.created;
      time.textContent = date.format(new Date(item.created));
      const body = document.createElement('p');
      body.textContent = item.body;
      row.append(name, time, body);
      list.append(row);
    }
  }
  function reader(name) {
    form.hidden = !!readerLabel && !name;
    if (!readerLabel) return;
    if (google) google.hidden = !!name;
    if (login) login.hidden = !!name;
    if (verify) verify.hidden = true;
    readerLabel.hidden = !name;
    readerLabel.querySelector('span').textContent = name || '';
  }
  async function commentRequest(url, data) {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || 'Η αποστολή δεν ολοκληρώθηκε.'), { status: response.status });
    return result;
  }
  if (login) {
    let challenge;
    function authAction(form, action) {
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const button = event.submitter || form.querySelector('[type="submit"]');
        button.disabled = true;
        try {
          await action(Object.fromEntries(new FormData(form)));
        } catch (error) {
          status.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      });
    }
    authAction(login, async data => {
      status.textContent = 'Αποστολή κωδικού…';
      ({ challenge } = await commentRequest('/api/comments/auth/request', data));
      login.hidden = true;
      verify.hidden = false;
      verify.elements.code.focus();
      status.textContent = 'Έλεγξε το email σου και γράψε τον εξαψήφιο κωδικό.';
    });
    authAction(verify, async data => {
      const result = await commentRequest('/api/comments/auth/verify', { ...data, challenge });
      login.reset();
      verify.reset();
      reader(result.reader);
      form.elements.body.focus();
      status.textContent = 'Συνδέθηκες για να σχολιάσεις.';
    });
    verify.querySelector('[data-comment-back]').addEventListener('click', () => {
      verify.reset();
      reader(null);
      login.elements.email.focus();
      status.textContent = '';
    });
  }
  if (readerLabel) {
    readerLabel.querySelector('button').addEventListener('click', async () => {
      try {
        await commentRequest('/api/comments/auth/logout', {});
        reader(null);
        status.textContent = 'Αποσυνδέθηκες.';
      } catch (error) {
        status.textContent = error.message;
      }
    });
  }
  const endpoint = section.dataset.comments;
  if (!readerLabel) reader(null);
  status.textContent = 'Φόρτωση σχολίων…';
  const loaded = fetch(endpoint).then(async response => {
    if (!response.ok) throw new Error();
    const result = await response.json();
    show(result.items);
    reader(result.reader);
    status.textContent = google && new URLSearchParams(location.search).get('comment-login') === 'failed'
      ? 'Η σύνδεση Google δεν ολοκληρώθηκε. Δοκίμασε ξανά.' : '';
  }).catch(() => {
    reader(null);
    status.textContent = 'Τα σχόλια δεν φορτώθηκαν. Δοκίμασε ανανέωση της σελίδας.';
  });

  form.addEventListener('input', () => { submissionId = undefined; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    submit.disabled = true;
    const fields = new FormData(form);
    submissionId ??= crypto.randomUUID().replace(/-/g, '');
    const id = submissionId;
    status.textContent = 'Αποστολή σχολίου…';
    try {
      await loaded;
      const result = await commentRequest(endpoint, { ...Object.fromEntries(fields), id });
      show(result.items);
      if (submissionId === id) {
        form.elements.body.value = '';
        submissionId = undefined;
      }
      status.textContent = 'Το σχόλιό σου δημοσιεύτηκε.';
    } catch (error) {
      if (error.status === 401 && readerLabel) reader(null);
      status.textContent = error.message || 'Η αποστολή δεν ολοκληρώθηκε. Δοκίμασε ξανά.';
    } finally {
      submit.disabled = false;
    }
  });
}

const install = document.querySelector('#install-app');
const installed = document.querySelector('#installed-app');
if (install && installed) {
  let prompt;
  installed.hidden = !(matchMedia('(display-mode: standalone)').matches || navigator.standalone);
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    prompt = event;
    install.hidden = false;
  });
  install.addEventListener('click', async () => {
    const current = prompt;
    prompt = undefined;
    install.hidden = true;
    if (current) await current.prompt();
  });
  window.addEventListener('appinstalled', () => {
    install.hidden = true;
    installed.textContent = 'Η εφαρμογή προστέθηκε στην αρχική οθόνη.';
    installed.hidden = false;
  });
}
