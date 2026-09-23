(function () {
  'use strict';

  const VERSION = '20260923-pwa-home-install-v5';
  const ONBOARDING_DISMISS_KEY = 'fdg_pwa_install_dismissed_until_v1';
  const INSTALL_COMPLETED_KEY = 'fdg_pwa_install_completed_v1';
  const ONBOARDING_DISMISS_MS = 30 * 24 * 60 * 60 * 1000;
  const HOME_INSTALL_DELAY_MS = 4 * 1000;

  let deferredPrompt = null;
  let installRoot = null;
  let modal = null;
  let modalSource = 'generic';
  let previouslyFocused = null;
  let homeInstallRoot = null;
  let homeInstallTimer = null;
  let homeInstallWasShown = false;

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

  function isIOSSafari() {
    if (!isIOS()) return false;
    const ua = navigator.userAgent || '';
    return /Safari/i.test(ua) && !/(CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo)/i.test(ua);
  }

  function isAndroid() {
    return /Android/i.test(navigator.userAgent || '');
  }

  function isMobileInstallContext() {
    if (isIOS() || isAndroid()) return true;
    return Boolean(navigator.maxTouchPoints > 0 && window.matchMedia('(max-width: 900px)').matches);
  }

  function isHomePage() {
    const path = String(window.location.pathname || '/').replace(/\/+$/, '') || '/';
    // A raiz do FDG redireciona imediatamente para /estatisticas.html.
    // Portanto, Estatísticas é também a landing page efetiva da Home e deve
    // receber o onboarding de instalação no primeiro acesso mobile.
    return path === '/' || path === '/index.html' || path === '/estatisticas.html';
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

  function readStorage(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value == null ? fallback : value;
    } catch (_) {
      return fallback;
    }
  }

  function writeStorage(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (_) {}
  }

  function removeStorage(key) {
    try { localStorage.removeItem(key); } catch (_) {}
  }

  function markInstallCompleted() {
    writeStorage(INSTALL_COMPLETED_KEY, '1');
    removeStorage(ONBOARDING_DISMISS_KEY);
  }

  function installationKnownComplete() {
    if (isStandalone()) {
      markInstallCompleted();
      return true;
    }
    return readStorage(INSTALL_COMPLETED_KEY, '') === '1';
  }

  function getDismissedUntil() {
    const value = Number(readStorage(ONBOARDING_DISMISS_KEY, '0'));
    return Number.isFinite(value) ? value : 0;
  }

  function onboardingIsDismissed() {
    return !installationKnownComplete() && getDismissedUntil() > Date.now();
  }

  function dismissOnboarding() {
    writeStorage(ONBOARDING_DISMISS_KEY, Date.now() + ONBOARDING_DISMISS_MS);
    hideHomeInstallPrompt();
    updateInstallOnboarding();
    updateInstallEntry();
  }

  function clearOnboardingDismissal() {
    removeStorage(ONBOARDING_DISMISS_KEY);
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
      if (close) {
        const dismissHome = modalSource === 'home';
        closeModal();
        if (dismissHome) dismissOnboarding();
      }
    });

    const install = modal.querySelector('[data-pwa-install]');
    install.addEventListener('click', () => runInstallPrompt(modalSource));

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

  function openModal(options) {
    const source = typeof options === 'string' ? options : String(options?.source || 'generic');
    modalSource = source;

    const node = ensureModal();
    const title = node.querySelector('#br-pwa-title');
    const copy = node.querySelector('[data-pwa-copy]');
    const install = node.querySelector('[data-pwa-install]');
    const secondary = node.querySelector('.br-pwa-secondary');
    previouslyFocused = document.activeElement;

    title.textContent = 'Instalar o Fórmula do Gol';
    secondary.textContent = isIOS() ? 'Entendi' : 'Fechar';

    if (isIOS() && !installationKnownComplete()) {
      const safariIntro = isIOSSafari()
        ? '<p><strong>No iPhone/iPad, são apenas dois passos:</strong></p>'
        : '<p><strong>No iPhone/iPad, abra o Fórmula do Gol no Safari para instalar.</strong></p>';
      const finalNote = source === 'alerts'
        ? '<p class="br-pwa-note">Depois, abra o Fórmula do Gol pelo novo ícone, volte a <strong>Alertas</strong> e permita as notificações que quiser receber.</p>'
        : '<p class="br-pwa-note">Depois, o Fórmula do Gol ficará disponível pela tela inicial como um aplicativo, sem precisar procurar o site no navegador.</p>';

      copy.innerHTML = [
        safariIntro,
        '<ol class="br-pwa-ios-steps">',
        '  <li><span class="br-pwa-step-number">1</span><span>Toque no ícone <strong>Compartilhar</strong> <span aria-hidden="true">⬆︎</span> na barra do Safari.</span></li>',
        '  <li><span class="br-pwa-step-number">2</span><span>Selecione <strong>“Adicionar à Tela de Início”</strong> e confirme em <strong>Adicionar</strong>.</span></li>',
        '</ol>',
        '<p class="br-pwa-note">Se “Adicionar à Tela de Início” não aparecer, role as ações do Safari e use <strong>Editar Ações</strong> para habilitá-la.</p>',
        finalNote
      ].join('');
      install.hidden = true;
    } else if (deferredPrompt && !installationKnownComplete()) {
      copy.innerHTML = source === 'alerts'
        ? '<p>Instale o Fórmula do Gol como aplicativo. Depois, escolha seus alertas e receba gols mesmo com o site fechado.</p>'
        : '<p>Instale o Fórmula do Gol direto na tela inicial. O navegador fará a instalação sem loja de aplicativos.</p>';
      install.textContent = 'Instalar agora';
      install.hidden = false;
    } else if (installationKnownComplete()) {
      copy.innerHTML = '<p>O Fórmula do Gol já está instalado neste aparelho.</p>';
      install.hidden = true;
    } else if (isAndroid()) {
      copy.innerHTML = [
        '<p><strong>No Android, a instalação é feita pelo próprio navegador.</strong></p>',
        '<ol>',
        '  <li>Abra o menu <strong>⋮</strong> do Chrome ou do navegador.</li>',
        '  <li>Escolha <strong>Instalar app</strong> ou <strong>Adicionar à tela inicial</strong>.</li>',
        '</ol>',
        '<p class="br-pwa-note">Quando o Chrome disponibilizar o prompt nativo, o botão “Instalar” do Fórmula do Gol abre a instalação diretamente.</p>'
      ].join('');
      install.hidden = true;
    } else {
      copy.innerHTML = '<p>Abra o menu do navegador e escolha <strong>Instalar aplicativo</strong> ou <strong>Adicionar à Tela de Início</strong>. Depois, abra o Fórmula do Gol pelo ícone criado.</p>';
      install.hidden = true;
    }

    node.hidden = false;
    document.documentElement.classList.add('br-pwa-modal-open');
    const focusTarget = install.hidden ? secondary : install;
    setTimeout(() => focusTarget && focusTarget.focus(), 0);
  }

  async function runInstallPrompt(source) {
    if (!deferredPrompt) {
      openModal({ source: source || 'generic' });
      return;
    }

    const prompt = deferredPrompt;
    deferredPrompt = null;

    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice && choice.outcome === 'accepted') {
        markInstallCompleted();
      } else if (choice && choice.outcome === 'dismissed') {
        dismissOnboarding();
      }
    } catch (_) {
      // O navegador continua sendo a autoridade do fluxo de instalação.
    }

    closeModal();
    hideHomeInstallPrompt();
    refreshInstallUi();
  }

  function requestInstall(source) {
    const origin = source || 'generic';
    if (installationKnownComplete()) {
      hideHomeInstallPrompt();
      return;
    }
    if (origin === 'home') hideHomeInstallPrompt();
    if (deferredPrompt && !isIOS()) runInstallPrompt(origin);
    else openModal({ source: origin });
  }

  function ensureInstallEntry() {
    if (installRoot || installationKnownComplete()) return installRoot;

    const footer = document.querySelector('.site-footer');
    if (!footer) return null;

    installRoot = document.createElement('div');
    installRoot.className = 'br-pwa-install-entry';
    installRoot.innerHTML = '<button type="button" class="br-pwa-install-button" data-pwa-open><span aria-hidden="true">⬇</span> Instalar Fórmula do Gol</button>';
    footer.insertBefore(installRoot, footer.firstChild);
    installRoot.querySelector('[data-pwa-open]').addEventListener('click', () => requestInstall('footer'));
    return installRoot;
  }

  function updateInstallEntry() {
    // A página de Alertas possui onboarding próprio e a Home possui prompt dedicado.
    if (document.querySelector('[data-pwa-onboarding]') || isHomePage()) {
      if (installRoot) installRoot.remove();
      installRoot = null;
      return;
    }

    if (installationKnownComplete()) {
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

    const installed = installationKnownComplete();
    root.classList.toggle('is-installed', installed);
    root.classList.toggle('is-ios', isIOS() && !installed);

    if (installed) {
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
      help.textContent = 'No iPhone, use preferencialmente o Safari: Compartilhar → Adicionar à Tela de Início.';
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

    install?.addEventListener('click', () => requestInstall('alerts'));
    dismiss?.addEventListener('click', dismissOnboarding);
    updateInstallOnboarding();
  }

  function ensureHomeInstallPrompt() {
    if (homeInstallRoot) return homeInstallRoot;

    homeInstallRoot = document.createElement('aside');
    homeInstallRoot.className = 'br-pwa-home-install';
    homeInstallRoot.hidden = true;
    homeInstallRoot.setAttribute('role', 'dialog');
    homeInstallRoot.setAttribute('aria-label', 'Instalar Fórmula do Gol');
    homeInstallRoot.innerHTML = [
      '<button type="button" class="br-pwa-home-install-close" data-home-pwa-dismiss aria-label="Agora não">×</button>',
      '<div class="br-pwa-home-install-icon" aria-hidden="true"><img src="/favicon-formula-do-gol-192.png" alt=""></div>',
      '<div class="br-pwa-home-install-copy">',
      '  <strong>Instalar Fórmula do Gol</strong>',
      '  <span>Acesso rápido, tela cheia e notificações. Direto na sua tela inicial.</span>',
      '</div>',
      '<div class="br-pwa-home-install-actions">',
      '  <button type="button" class="br-pwa-home-install-primary" data-home-pwa-install>Instalar</button>',
      '  <button type="button" class="br-pwa-home-install-secondary" data-home-pwa-dismiss>Agora não</button>',
      '</div>'
    ].join('');

    document.body.appendChild(homeInstallRoot);
    homeInstallRoot.querySelector('[data-home-pwa-install]').addEventListener('click', () => requestInstall('home'));
    homeInstallRoot.querySelectorAll('[data-home-pwa-dismiss]').forEach((button) => {
      button.addEventListener('click', dismissOnboarding);
    });
    return homeInstallRoot;
  }

  function updateHomeInstallPrompt() {
    if (!homeInstallRoot) return;

    const eligible = Boolean(
      isHomePage() &&
      isMobileInstallContext() &&
      !installationKnownComplete() &&
      !onboardingIsDismissed()
    );

    if (!eligible) {
      hideHomeInstallPrompt();
      return;
    }

    const button = homeInstallRoot.querySelector('[data-home-pwa-install]');
    if (button) {
      if (isIOS()) button.textContent = 'Como instalar';
      else if (deferredPrompt) button.textContent = 'Instalar';
      else button.textContent = 'Como instalar';
    }
  }

  function showHomeInstallPrompt() {
    if (!isHomePage() || !isMobileInstallContext() || installationKnownComplete() || onboardingIsDismissed()) return;
    const root = ensureHomeInstallPrompt();
    updateHomeInstallPrompt();
    root.hidden = false;
    homeInstallWasShown = true;
    requestAnimationFrame(() => root.classList.add('is-visible'));
  }

  function hideHomeInstallPrompt() {
    if (!homeInstallRoot) return;
    homeInstallRoot.classList.remove('is-visible');
    homeInstallRoot.hidden = true;
  }

  function scheduleHomeInstallPrompt() {
    if (homeInstallTimer || homeInstallWasShown) return;
    if (!isHomePage() || !isMobileInstallContext() || installationKnownComplete() || onboardingIsDismissed()) return;
    homeInstallTimer = window.setTimeout(() => {
      homeInstallTimer = null;
      showHomeInstallPrompt();
    }, HOME_INSTALL_DELAY_MS);
  }

  function refreshInstallUi() {
    updateInstallEntry();
    updateInstallOnboarding();
    updateHomeInstallPrompt();
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    refreshInstallUi();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    markInstallCompleted();
    closeModal();
    hideHomeInstallPrompt();
    refreshInstallUi();
  });

  window.addEventListener('pageshow', () => {
    refreshInstallUi();
    scheduleHomeInstallPrompt();
  });

  try {
    const standaloneMedia = window.matchMedia('(display-mode: standalone)');
    if (typeof standaloneMedia.addEventListener === 'function') {
      standaloneMedia.addEventListener('change', () => {
        if (isStandalone()) markInstallCompleted();
        refreshInstallUi();
      });
    }
  } catch (_) {}

  document.addEventListener('DOMContentLoaded', () => {
    if (isStandalone()) markInstallCompleted();
    registerServiceWorker();
    bindInstallOnboarding();
    refreshInstallUi();
    scheduleHomeInstallPrompt();
  }, { once: true });

  window.FormulaDoGolPWA = Object.freeze({
    version: VERSION,
    isStandalone,
    isIOS,
    isAndroid,
    isMobileInstallContext,
    registerServiceWorker,
    openInstallHelp: openModal,
    requestInstall,
    refreshInstallUi
  });
})();
