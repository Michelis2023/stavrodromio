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
  const status = panel.querySelector('[role="status"]');
  const shareData = () => ({ title: panel.dataset.title, url: address.value });
  if (typeof navigator.share === 'function' && (typeof navigator.canShare !== 'function' || navigator.canShare(shareData()))) {
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
  let ready = false;
  async function prepareLink() {
    if (!panel.open || pending || ready) return;
    pending = true;
    address.disabled = share.disabled = copy.disabled = true;
    status.textContent = 'Ετοιμάζεται η προεπισκόπηση του άρθρου…';
    try {
      for (let attempt = 0; attempt < 13 && panel.open; attempt++) {
        const result = await fetch(panel.dataset.shareEndpoint);
        if (result.status === 202) {
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
      // The article's public address remains available if the preview service is unreachable.
    } finally {
      pending = false;
      address.disabled = share.disabled = copy.disabled = false;
      status.textContent = ready || !panel.open ? '' : 'Η προεπισκόπηση αργεί. Μπορείς να χρησιμοποιήσεις τον σύνδεσμο του άρθρου ή να ανοίξεις ξανά την κοινοποίηση.';
    }
  }
  panel.addEventListener('toggle', prepareLink);
  prepareLink();
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
