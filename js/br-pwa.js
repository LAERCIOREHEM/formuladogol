(function () {
  'use strict';

  const VERSION = '20260901-pwa-v1';
  let deferredPrompt = null;
  let installRoot = null;
  let modal = null;
  let previouslyFocused = null;

  function isStandalone() {
    return Boolean(
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true
    );
  }

  function isIOS() {
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    const touchMac = platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    return /iPad|iPhone|iPod/.test(ua) || touchMac;
  }

  function supportsServiceWorker() {
    return window.isSecureContext && 'serviceWorker' in navigator;
  }

  async function registerServiceWorker() {
    if (!supportsServiceWorker()) return null;
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', {
        scope: '/',
        updateViaCache: 'none'
      });
      registration.update().catch(() => {});
      return registration;
    } catch (error) {
      console.error('[FDG PWA] Falha ao registrar Service Worker:', error);
      return null;
    }
  }

  function ensureModal() {
    if (modal) return modal;

    modal = document.createElement('div');
    modal.className = 'br-pwa-modal';
    modal.hidden = true;
    modal.innerHTML = [
      '<div class="br-pwa-modal-backdrop" data-pwa-close></div>',
      '<section class="br-pwa-dialog" role="dialog" aria-modal="true" aria-labelledby="br-pwa-title">',
      '  <button type="button" class="br-pwa-close" data-pwa-close aria-label="Fechar">×</button>',
      '  <div class="br-pwa-dialog-icon" aria-hidden="true">⚽</div>',
      '  <h2 id="br-pwa-title">Instalar o Fórmula do Gol</h2>',
      '  <div class="br-pwa-dialog-copy" data-pwa-copy></div>',
      '  <div class="br-pwa-dialog-actions">',
      '    <button type="button" class="br-pwa-primary" data-pwa-install hidden>Instalar agora</button>',
      '    <button type="button" class="br-pwa-secondary" data-pwa-close>Fechar</button>',
      '  </div>',
      '</section>'
    ].join('');

    document.body.appendChild(modal);
    modal.addEventListener('click', (event) => {
      const close = event.target.closest('[data-pwa-close]');
      if (close) closeModal();
    });

    const install = modal.querySelector('[data-pwa-install]');
    install.addEventListener('click', runInstallPrompt);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && modal && !modal.hidden) closeModal();
    });

    return modal;
  }

  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    document.documentElement.classList.remove('br-pwa-modal-open');
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
    previouslyFocused = null;
  }

  function openModal() {
    const node = ensureModal();
    const copy = node.querySelector('[data-pwa-copy]');
    const install = node.querySelector('[data-pwa-install]');
    previouslyFocused = document.activeElement;

    if (isIOS() && !isStandalone()) {
      copy.innerHTML = [
        '<p>No iPhone/iPad, a instalação é feita pelo menu do navegador:</p>',
        '<ol>',
        '  <li>Toque em <strong>Compartilhar</strong>.</li>',
        '  <li>Escolha <strong>Adicionar à Tela de Início</strong>.</li>',
        '  <li>Confirme em <strong>Adicionar</strong>.</li>',
        '</ol>',
        '<p class="br-pwa-note">Depois, abra o Fórmula do Gol pelo novo ícone da Tela de Início.</p>'
      ].join('');
      install.hidden = true;
    } else if (deferredPrompt) {
      copy.innerHTML = '<p>Instale o Fórmula do Gol como aplicativo para abrir mais rápido e preparar o aparelho para os alertas esportivos.</p>';
      install.hidden = false;
    } else {
      copy.innerHTML = '<p>Use a opção <strong>Instalar aplicativo</strong> ou <strong>Adicionar à Tela de Início</strong> no menu do seu navegador.</p>';
      install.hidden = true;
    }

    node.hidden = false;
    document.documentElement.classList.add('br-pwa-modal-open');
    const focusTarget = install.hidden ? node.querySelector('.br-pwa-secondary') : install;
    setTimeout(() => focusTarget && focusTarget.focus(), 0);
  }

  async function runInstallPrompt() {
    if (!deferredPrompt) return;
    const prompt = deferredPrompt;
    deferredPrompt = null;

    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch (_) {
      // O navegador continua sendo a autoridade do fluxo de instalação.
    }

    closeModal();
    updateInstallEntry();
  }

  function ensureInstallEntry() {
    if (installRoot || isStandalone()) return installRoot;

    const footer = document.querySelector('.site-footer');
    if (!footer) return null;

    installRoot = document.createElement('div');
    installRoot.className = 'br-pwa-install-entry';
    installRoot.innerHTML = '<button type="button" class="br-pwa-install-button" data-pwa-open><span aria-hidden="true">⬇</span> Instalar Fórmula do Gol</button>';
    footer.insertBefore(installRoot, footer.firstChild);
    installRoot.querySelector('[data-pwa-open]').addEventListener('click', openModal);
    return installRoot;
  }

  function updateInstallEntry() {
    if (isStandalone()) {
      if (installRoot) installRoot.remove();
      installRoot = null;
      return;
    }

    const eligible = Boolean(deferredPrompt || isIOS());
    if (!eligible) {
      if (installRoot) installRoot.hidden = true;
      return;
    }

    const root = ensureInstallEntry();
    if (root) root.hidden = false;
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    updateInstallEntry();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    closeModal();
    updateInstallEntry();
  });

  window.addEventListener('pageshow', () => {
    updateInstallEntry();
  });

  document.addEventListener('DOMContentLoaded', () => {
    registerServiceWorker();
    updateInstallEntry();
  }, { once: true });

  window.FormulaDoGolPWA = Object.freeze({
    version: VERSION,
    isStandalone,
    isIOS,
    registerServiceWorker,
    openInstallHelp: openModal
  });
})();
