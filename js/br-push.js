(function () {
  'use strict';

  const STORAGE_KEY = 'fdg_push_installation_id_v1';
  const DEFAULT_API_BASE = 'https://push.formuladogol.com.br';
  const state = {
    registration: null,
    config: { apiBase: DEFAULT_API_BASE, vapidPublicKey: '' },
    configPromise: null
  };

  function supported() {
    return Boolean(window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);
  }

  function installationId() {
    let current = '';
    try { current = localStorage.getItem(STORAGE_KEY) || ''; } catch (_) {}
    if (/^[A-Za-z0-9._:-]{8,128}$/.test(current)) return current;
    current = (crypto && typeof crypto.randomUUID === 'function')
      ? `fdg-${crypto.randomUUID()}`
      : `fdg-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
    try { localStorage.setItem(STORAGE_KEY, current); } catch (_) {}
    return current;
  }

  async function getRegistration() {
    if (!('serviceWorker' in navigator)) return null;
    if (state.registration) return state.registration;
    const existing = await navigator.serviceWorker.getRegistration('/');
    if (existing) { state.registration = existing; return existing; }
    state.registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    return state.registration;
  }

  function configure(options) {
    const input = options || {};
    if (typeof input.apiBase === 'string' && input.apiBase.trim()) state.config.apiBase = input.apiBase.replace(/\/+$/, '');
    if (typeof input.vapidPublicKey === 'string') state.config.vapidPublicKey = input.vapidPublicKey.trim();
    return Object.assign({}, state.config);
  }

  async function loadRemoteConfig(force) {
    if (state.config.vapidPublicKey && !force) return Object.assign({}, state.config);
    if (state.configPromise && !force) return state.configPromise;
    state.configPromise = (async () => {
      const response = await fetch(`${state.config.apiBase}/v1/config`, { cache: 'no-store', mode: 'cors' });
      if (!response.ok) throw new Error(`Backend de notificações indisponível (${response.status}).`);
      const data = await response.json();
      if (!data || !data.vapidPublicKey) throw new Error('Backend não retornou VAPID_PUBLIC_KEY.');
      state.config.vapidPublicKey = String(data.vapidPublicKey);
      return Object.assign({}, state.config);
    })().finally(() => { state.configPromise = null; });
    return state.configPromise;
  }

  function base64UrlToUint8Array(value) {
    const padding = '='.repeat((4 - (value.length % 4)) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64); const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
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

  function serializeSubscription(subscription) {
    const json = subscription.toJSON();
    return {
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime ?? json.expirationTime ?? null,
      keys: { p256dh: json.keys?.p256dh || '', auth: json.keys?.auth || '' }
    };
  }

  async function api(path, options) {
    const response = await fetch(`${state.config.apiBase}${path}`, Object.assign({
      mode: 'cors', cache: 'no-store', headers: { 'Content-Type': 'application/json' }
    }, options || {}));
    let data = null;
    try { data = await response.json(); } catch (_) {}
    if (!response.ok || !data || data.ok === false) {
      const error = new Error((data && data.error) ? String(data.error) : `HTTP ${response.status}`);
      error.status = response.status; throw error;
    }
    return data;
  }

  async function subscribe(options) {
    if (!supported()) throw new Error('Web Push indisponível neste navegador ou fora de HTTPS.');
    const input = options || {};
    await loadRemoteConfig(false);
    const result = await requestPermission();
    if (result !== 'granted') throw new Error('Permissão de notificações não concedida.');
    const registration = await getRegistration();
    let current = await registration.pushManager.getSubscription();
    if (!current) {
      current = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8Array(state.config.vapidPublicKey)
      });
    }
    const payload = {
      installationId: installationId(),
      subscription: serializeSubscription(current)
    };
    if (Object.prototype.hasOwnProperty.call(input, 'preferences')) payload.preferences = input.preferences || {};
    await api('/v1/subscribe', { method: 'POST', body: JSON.stringify(payload) });
    return current;
  }

  async function unsubscribe() {
    const current = await getSubscription();
    if (!current) return false;
    try {
      await api('/v1/unsubscribe', {
        method: 'POST',
        body: JSON.stringify({ installationId: installationId(), endpoint: current.endpoint })
      });
    } finally {
      await current.unsubscribe();
    }
    return true;
  }

  async function sendRemoteTest() {
    await subscribe();
    return api('/v1/test', { method: 'POST', body: JSON.stringify({ installationId: installationId() }) });
  }

  async function sendQueueTest() {
    await subscribe();
    return api('/v1/queue-test', { method: 'POST', body: JSON.stringify({ installationId: installationId() }) });
  }

  async function dispatchStatus() {
    return api('/v1/dispatch/status', { method: 'GET' });
  }

  async function getPreferences() {
    return api(`/v1/preferences?installationId=${encodeURIComponent(installationId())}`, { method: 'GET' });
  }

  async function savePreferences(preferences) {
    return api('/v1/preferences', {
      method: 'PUT',
      body: JSON.stringify({ installationId: installationId(), preferences: preferences || {} })
    });
  }


  async function monitorStatus() {
    return api('/v1/monitor/status', { method: 'GET' });
  }

  async function monitorEvents() {
    return api('/v1/monitor/events', { method: 'GET' });
  }

  async function showTestNotification() {
    if (!window.isSecureContext) throw new Error('O teste exige HTTPS.');
    const result = await requestPermission();
    if (result !== 'granted') throw new Error('Permissão de notificações não concedida.');
    const registration = await getRegistration();
    await registration.showNotification('Fórmula do Gol — teste local', {
      body: 'Notificação local funcionando neste aparelho.',
      icon: '/favicon-formula-do-gol-192.png', badge: '/favicon-formula-do-gol-96.png',
      tag: 'fdg-pwa-test', renotify: false, data: { url: '/pwa-teste.html' }
    });
    await setBadge(1); return true;
  }

  async function setBadge(count) {
    const value = Number(count);
    if ('setAppBadge' in navigator) {
      if (Number.isFinite(value) && value >= 0) await navigator.setAppBadge(Math.floor(value)); else await navigator.setAppBadge();
      return true;
    }
    return false;
  }

  async function clearBadge() {
    try {
      const registration = await getRegistration();
      const target = navigator.serviceWorker.controller || registration?.active;
      if (target) target.postMessage({ type: 'FDG_CLEAR_BADGE' });
    } catch (_) {}
    if ('clearAppBadge' in navigator) { await navigator.clearAppBadge(); return true; }
    if ('setAppBadge' in navigator) { await navigator.setAppBadge(0); return true; }
    return false;
  }

  async function diagnostics() {
    const registration = await getRegistration().catch(() => null);
    const subscription = registration?.pushManager ? await registration.pushManager.getSubscription().catch(() => null) : null;
    let backend = null;
    try { backend = await loadRemoteConfig(false); } catch (_) {}
    return {
      secureContext: window.isSecureContext,
      serviceWorker: 'serviceWorker' in navigator,
      pushManager: 'PushManager' in window,
      notifications: 'Notification' in window,
      permission: 'Notification' in window ? Notification.permission : 'unsupported',
      badging: 'setAppBadge' in navigator,
      registration: Boolean(registration),
      subscription: Boolean(subscription),
      installationId: installationId(),
      backendConfigured: Boolean(backend?.apiBase),
      vapidConfigured: Boolean(backend?.vapidPublicKey)
    };
  }

  window.FormulaDoGolPush = Object.freeze({
    supported, configure, loadRemoteConfig, getRegistration, requestPermission, getSubscription,
    subscribe, unsubscribe, sendRemoteTest, sendQueueTest, dispatchStatus, getPreferences, savePreferences, monitorStatus, monitorEvents,
    showTestNotification, setBadge, clearBadge, diagnostics, installationId
  });
})();
