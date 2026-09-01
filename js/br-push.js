(function () {
  'use strict';

  const state = {
    registration: null,
    config: {
      apiBase: '',
      vapidPublicKey: ''
    }
  };

  function supported() {
    return Boolean(
      window.isSecureContext &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window
    );
  }

  async function getRegistration() {
    if (!('serviceWorker' in navigator)) return null;
    if (state.registration) return state.registration;

    const existing = await navigator.serviceWorker.getRegistration('/');
    if (existing) {
      state.registration = existing;
      return existing;
    }

    state.registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none'
    });
    return state.registration;
  }

  function configure(options) {
    const input = options || {};
    if (typeof input.apiBase === 'string') state.config.apiBase = input.apiBase.replace(/\/+$/, '');
    if (typeof input.vapidPublicKey === 'string') state.config.vapidPublicKey = input.vapidPublicKey.trim();
    return Object.assign({}, state.config);
  }

  function base64UrlToUint8Array(value) {
    const padding = '='.repeat((4 - (value.length % 4)) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function permission() {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission;
  }

  async function requestPermission() {
    if (!('Notification' in window)) throw new Error('Notifications API indisponível neste navegador.');
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    return Notification.requestPermission();
  }

  async function getSubscription() {
    if (!supported()) return null;
    const registration = await getRegistration();
    return registration.pushManager.getSubscription();
  }

  async function subscribe(options) {
    if (!supported()) throw new Error('Web Push indisponível neste navegador ou fora de HTTPS.');

    const input = options || {};
    const key = String(input.vapidPublicKey || state.config.vapidPublicKey || '').trim();
    if (!key) throw new Error('VAPID_PUBLIC_KEY ainda não configurada. Ela será conectada ao backend na Execução 3.');

    const result = await requestPermission();
    if (result !== 'granted') throw new Error('Permissão de notificações não concedida.');

    const registration = await getRegistration();
    const current = await registration.pushManager.getSubscription();
    if (current) return current;

    return registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(key)
    });
  }

  async function unsubscribe() {
    const current = await getSubscription();
    if (!current) return false;
    return current.unsubscribe();
  }

  async function showTestNotification() {
    if (!window.isSecureContext) throw new Error('O teste exige HTTPS.');
    const result = await requestPermission();
    if (result !== 'granted') throw new Error('Permissão de notificações não concedida.');

    const registration = await getRegistration();
    await registration.showNotification('Fórmula do Gol — teste', {
      body: 'Notificação local funcionando. O envio automático de gols será conectado ao backend na Execução 3.',
      icon: '/favicon-formula-do-gol-192.png',
      badge: '/favicon-formula-do-gol-96.png',
      tag: 'fdg-pwa-test',
      renotify: false,
      data: { url: '/pwa-teste.html' }
    });

    await setBadge(1);
    return true;
  }

  async function setBadge(count) {
    const value = Number(count);
    if ('setAppBadge' in navigator) {
      if (Number.isFinite(value) && value >= 0) await navigator.setAppBadge(Math.floor(value));
      else await navigator.setAppBadge();
      return true;
    }
    return false;
  }

  async function clearBadge() {
    if ('clearAppBadge' in navigator) {
      await navigator.clearAppBadge();
      return true;
    }
    if ('setAppBadge' in navigator) {
      await navigator.setAppBadge(0);
      return true;
    }
    return false;
  }

  async function diagnostics() {
    const registration = await getRegistration().catch(() => null);
    const subscription = registration && registration.pushManager
      ? await registration.pushManager.getSubscription().catch(() => null)
      : null;

    return {
      secureContext: window.isSecureContext,
      serviceWorker: 'serviceWorker' in navigator,
      pushManager: 'PushManager' in window,
      notifications: 'Notification' in window,
      permission: 'Notification' in window ? Notification.permission : 'unsupported',
      badging: 'setAppBadge' in navigator,
      registration: Boolean(registration),
      subscription: Boolean(subscription),
      backendConfigured: Boolean(state.config.apiBase),
      vapidConfigured: Boolean(state.config.vapidPublicKey)
    };
  }

  window.FormulaDoGolPush = Object.freeze({
    supported,
    configure,
    getRegistration,
    permission,
    requestPermission,
    getSubscription,
    subscribe,
    unsubscribe,
    showTestNotification,
    setBadge,
    clearBadge,
    diagnostics
  });
})();
