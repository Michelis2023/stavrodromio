'use strict';

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
  const data = { title: panel.dataset.title, url: address.value };
  if (typeof navigator.share === 'function' && (typeof navigator.canShare !== 'function' || navigator.canShare(data))) {
    share.hidden = false;
    share.addEventListener('click', async () => {
      status.textContent = '';
      try {
        await navigator.share(data);
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
