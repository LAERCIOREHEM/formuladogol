(function () {
  'use strict';

  const VERSION = '20260903-pwa-onboarding-v3';
  const ONBOARDING_DISMISS_KEY = 'fdg_pwa_install_dismissed_until_v1';
  const ONBOARDING_DISMISS_MS = 7 * 24 * 60 * 60 * 1000;
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

  function getDismissedUntil() {
    try {
      const value = Number(localStorage.getItem(ONBOARDING_DISMISS_KEY) || 0);
      return Number.isFinite(value) ? value : 0;
    } catch (_) {
      return 0;
    }
  }

  function onboardingIsDismissed() {
    return !isStandalone() && getDismissedUntil() > Date.now();
  }

  function dismissOnboarding() {
    try {
      localStorage.setItem(ONBOARDING_DISMISS_KEY, String(Date.now() + ONBOARDING_DISMISS_MS));
    } catch (_) {}
    updateInstallOnboarding();
  }

  function clearOnboardingDismissal() {
    try { localStorage.removeItem(ONBOARDING_DISMISS_KEY); } catch (_) {}
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
      '  <div class="br-pwa-dialog-icon" aria-hidden="true">📲</div>',
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
        '<p><strong>No iPhone/iPad, faça a instalação pelo Safari.</strong></p>',
        '<p>Se esta página estiver aberta no <strong>Google Chrome</strong>, abra o <strong>Safari</strong> e acesse <strong>formuladogol.com.br/alertas.html</strong>.</p>',
        '<ol>',
        '  <li>No Safari, toque em <strong>Compartilhar</strong> (quadrado com seta para cima).</li>',
        '  <li>Role a lista e toque em <strong>Adicionar à Tela de Início</strong>.</li>',
        '  <li>Se essa opção não aparecer, role até o fim, toque em <strong>Editar Ações</strong> e habilite <strong>Adicionar à Tela de Início</strong>.</li>',
        '  <li>Confirme em <strong>Adicionar</strong>.</li>',
        '  <li>Depois, abra o <strong>Fórmula do Gol pelo novo ícone</strong>, volte a <strong>Alertas</strong> e permita as notificações.</li>',
        '</ol>',
        '<p class="br-pwa-note"><strong>Safari é o caminho recomendado no iPhone.</strong> Alguns navegadores podem também oferecer “Adicionar à Tela de Início”, mas a orientação do Fórmula do Gol usa o Safari para evitar diferenças entre versões do iOS e do navegador.</p>'
      ].join('');
      install.hidden = true;
    } else if (deferredPrompt) {
      copy.innerHTML = '<p>Instale o Fórmula do Gol como aplicativo. Depois, escolha seus alertas e receba gols mesmo com o site fechado.</p>';
      install.hidden = false;
    } else if (isStandalone()) {
      copy.innerHTML = '<p>O Fórmula do Gol já está aberto como aplicativo neste aparelho.</p>';
      install.hidden = true;
    } else {
      copy.innerHTML = '<p>Abra o menu do navegador e escolha <strong>Instalar aplicativo</strong> ou <strong>Adicionar à Tela de Início</strong>. Depois, abra o Fórmula do Gol pelo ícone criado.</p>';
      install.hidden = true;
    }

    node.hidden = false;
    document.documentElement.classList.add('br-pwa-modal-open');
    const focusTarget = install.hidden ? node.querySelector('.br-pwa-secondary') : install;
    setTimeout(() => focusTarget && focusTarget.focus(), 0);
  }

  async function runInstallPrompt() {
    if (!deferredPrompt) {
      openModal();
      return;
    }

    const prompt = deferredPrompt;
    deferredPrompt = null;

    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice && choice.outcome === 'accepted') clearOnboardingDismissal();
    } catch (_) {
      // O navegador continua sendo a autoridade do fluxo de instalação.
    }

    closeModal();
    updateInstallEntry();
    updateInstallOnboarding();
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
    // A página de Alertas possui um onboarding próprio e mais claro; evita CTA duplicado no rodapé.
    if (document.querySelector('[data-pwa-onboarding]')) {
      if (installRoot) installRoot.remove();
      installRoot = null;
      return;
    }

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

  function updateInstallOnboarding() {
    const root = document.querySelector('[data-pwa-onboarding]');
    if (!root) return;

    const kicker = root.querySelector('[data-pwa-onboarding-kicker]');
    const title = root.querySelector('[data-pwa-onboarding-title]');
    const copy = root.querySelector('[data-pwa-onboarding-copy]');
    const actions = root.querySelector('[data-pwa-onboarding-actions]');
    const install = root.querySelector('[data-pwa-onboarding-install]');
    const dismiss = root.querySelector('[data-pwa-onboarding-dismiss]');
    const help = root.querySelector('[data-pwa-onboarding-help]');

    if (!title || !copy || !actions || !install || !dismiss || !help) return;

    root.classList.toggle('is-installed', isStandalone());
    root.classList.toggle('is-ios', isIOS() && !isStandalone());

    if (isStandalone()) {
      root.hidden = false;
      if (kicker) kicker.textContent = 'APP INSTALADO';
      title.textContent = '✅ Fórmula do Gol instalado neste aparelho';
      copy.textContent = 'Agora escolha abaixo seu time, uma partida específica ou todos os jogos para receber os alertas.';
      actions.hidden = true;
      help.hidden = true;
      return;
    }

    if (onboardingIsDismissed()) {
      root.hidden = true;
      return;
    }

    root.hidden = false;
    actions.hidden = false;
    help.hidden = false;
    if (kicker) kicker.textContent = 'APP FÓRMULA DO GOL';
    title.textContent = 'Instale o Fórmula do Gol';
    copy.textContent = 'Receba gols mesmo com o site fechado no celular ou computador.';

    if (isIOS()) {
      install.textContent = 'COMO INSTALAR NO IPHONE';
      help.textContent = 'No iPhone, use preferencialmente o Safari: Compartilhar → Adicionar à Tela de Início. Se estiver no Chrome, abra esta página no Safari. Se a opção não aparecer no Safari, use Editar Ações para habilitá-la.';
    } else if (deferredPrompt) {
      install.textContent = 'INSTALAR AGORA';
      help.textContent = 'Depois de instalar, escolha abaixo seu time, um jogo específico ou todos os jogos e permita as notificações.';
    } else {
      install.textContent = 'COMO INSTALAR';
      help.textContent = 'Se o botão nativo ainda não estiver disponível, use “Instalar aplicativo” ou “Adicionar à Tela de Início” no menu do navegador.';
    }
  }

  function bindInstallOnboarding() {
    const root = document.querySelector('[data-pwa-onboarding]');
    if (!root || root.dataset.pwaBound === '1') return;
    root.dataset.pwaBound = '1';

    const install = root.querySelector('[data-pwa-onboarding-install]');
    const dismiss = root.querySelector('[data-pwa-onboarding-dismiss]');

    install?.addEventListener('click', () => {
      if (deferredPrompt && !isIOS()) runInstallPrompt();
      else openModal();
    });
    dismiss?.addEventListener('click', dismissOnboarding);
    updateInstallOnboarding();
  }

  function refreshInstallUi() {
    updateInstallEntry();
    updateInstallOnboarding();
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    refreshInstallUi();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    clearOnboardingDismissal();
    closeModal();
    refreshInstallUi();
  });

  window.addEventListener('pageshow', refreshInstallUi);

  try {
    const standaloneMedia = window.matchMedia('(display-mode: standalone)');
    if (typeof standaloneMedia.addEventListener === 'function') {
      standaloneMedia.addEventListener('change', refreshInstallUi);
    }
  } catch (_) {}

  document.addEventListener('DOMContentLoaded', () => {
    registerServiceWorker();
    bindInstallOnboarding();
    refreshInstallUi();
  }, { once: true });

  window.FormulaDoGolPWA = Object.freeze({
    version: VERSION,
    isStandalone,
    isIOS,
    registerServiceWorker,
    openInstallHelp: openModal,
    refreshInstallUi
  });
})();
