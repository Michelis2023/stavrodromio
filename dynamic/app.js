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
