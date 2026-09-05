(function () {
  'use strict';

  const STORAGE_KEY = 'fdg_push_installation_id_v1';
  const DEFAULT_API_BASE = 'https://push.formuladogol.com.br';
  const SW_STATE_DB = 'fdg-pwa-state-v1';
  const SW_STATE_STORE = 'state';
  const READY_TIMEOUT_MS = 10000;
  const RETRY_DELAY_MS = 1800;

  const state = {
    registration: null,
    config: { apiBase: DEFAULT_API_BASE, vapidPublicKey: '' },
    configPromise: null,
    subscribePromise: null,
    lastSubscribeError: null
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

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------------------
  // Espelho em IndexedDB: o Service Worker não enxerga localStorage e precisa de
  // installationId/apiBase/VAPID para reagir sozinho a pushsubscriptionchange.
  // ---------------------------------------------------------------------------
  function openStateDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB indisponível.')); return; }
      const request = indexedDB.open(SW_STATE_DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SW_STATE_STORE)) db.createObjectStore(SW_STATE_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function mirrorStateForServiceWorker() {
    let db = null;
    try {
      db = await openStateDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(SW_STATE_STORE, 'readwrite');
        const store = tx.objectStore(SW_STATE_STORE);
        store.put(installationId(), 'installationId');
        store.put(state.config.apiBase, 'apiBase');
        if (state.config.vapidPublicKey) store.put(state.config.vapidPublicKey, 'vapidPublicKey');
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch (_) {
      // Espelho é complemento: falha nunca deve impedir a inscrição.
    } finally {
      if (db) db.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Service Worker
  // ---------------------------------------------------------------------------
  async function waitForActivation(registration) {
    if (registration && registration.active) return registration;
    const ready = navigator.serviceWorker.ready;
    const guard = delay(READY_TIMEOUT_MS).then(() => null);
    const settled = await Promise.race([ready, guard]);
    if (settled && settled.active) return settled;
    if (registration && registration.active) return registration;
    throw new Error('O Service Worker ainda não está ativo neste aparelho. Recarregue a página e tente novamente.');
  }

  async function getRegistration() {
    if (!('serviceWorker' in navigator)) return null;
    if (state.registration && state.registration.active) return state.registration;
    let registration = await navigator.serviceWorker.getRegistration('/');
    if (!registration) {
      registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    }
    state.registration = await waitForActivation(registration);
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

  // ---------------------------------------------------------------------------
  // VAPID
  // ---------------------------------------------------------------------------
  function base64UrlToUint8Array(value) {
    const padding = '='.repeat((4 - (value.length % 4)) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  }

  function applicationServerKey() {
    const value = String(state.config.vapidPublicKey || '').trim();
    if (!value) throw new Error('Chave pública VAPID ausente. Recarregue a página.');
    let bytes = null;
    try { bytes = base64UrlToUint8Array(value); } catch (_) {
      throw new Error('Chave pública VAPID inválida (Base64URL).');
    }
    if (bytes.length !== 65 || bytes[0] !== 0x04) {
      throw new Error(`Chave pública VAPID inválida (${bytes.length} bytes, prefixo 0x${bytes[0]?.toString(16) || '??'}).`);
    }
    return bytes;
  }

  function sameServerKey(subscription) {
    try {
      const raw = subscription?.options?.applicationServerKey;
      if (!raw) return true; // Navegador não expõe: não força recriação.
      const current = new Uint8Array(raw);
      const expected = applicationServerKey();
      if (current.length !== expected.length) return false;
      for (let i = 0; i < expected.length; i += 1) if (current[i] !== expected[i]) return false;
      return true;
    } catch (_) {
      return true;
    }
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

  // ---------------------------------------------------------------------------
  // Inscrição
  // ---------------------------------------------------------------------------
  function describeSubscribeFailure(error) {
    const name = String(error?.name || 'Error');
    const message = String(error?.message || error || '');
    if (/push service error/i.test(message)) {
      return 'O serviço de push do navegador (Google/FCM) recusou o registro neste aparelho. Abra o Chrome, verifique se há conta Google ativa, desative VPN/DNS privado e libere o Chrome e o Google Play Services da economia de bateria; depois tente de novo.';
    }
    if (/no active Service Worker/i.test(message)) {
      return 'O Service Worker ainda não estava ativo. Recarregue a página e tente novamente.';
    }
    if (name === 'NotAllowedError') return 'Permissão de notificações não concedida.';
    if (name === 'InvalidStateError') return 'Havia uma inscrição antiga incompatível. Tente novamente.';
    return `Falha ao registrar as notificações (${name}): ${message}`;
  }

  async function createSubscription(registration) {
    return registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey()
    });
  }

  async function resolveSubscription(registration) {
    let current = await registration.pushManager.getSubscription();

    if (current && !sameServerKey(current)) {
      // Chave do servidor mudou: recriar é obrigatório, senão o Chrome lança InvalidStateError.
      try { await current.unsubscribe(); } catch (_) {}
      current = null;
    }
    if (current) return current;

    try {
      return await createSubscription(registration);
    } catch (error) {
      state.lastSubscribeError = {
        name: String(error?.name || 'Error'),
        message: String(error?.message || error || ''),
        at: new Date().toISOString(),
        attempt: 1
      };
      // Retentativa única e controlada: o registro no FCM falha de forma
      // transitória com frequência. Nunca troca a VAPID, nunca apaga o SW.
      try { await registration.update(); } catch (_) {}
      await delay(RETRY_DELAY_MS);
      const existing = await registration.pushManager.getSubscription();
      if (existing) return existing;
      try {
        const retried = await createSubscription(registration);
        state.lastSubscribeError = null;
        return retried;
      } catch (retryError) {
        state.lastSubscribeError = {
          name: String(retryError?.name || 'Error'),
          message: String(retryError?.message || retryError || ''),
          at: new Date().toISOString(),
          attempt: 2
        };
        const friendly = new Error(describeSubscribeFailure(retryError));
        friendly.name = String(retryError?.name || 'Error');
        friendly.cause = retryError;
        throw friendly;
      }
    }
  }

  async function subscribe(options) {
    if (!supported()) throw new Error('Web Push indisponível neste navegador ou fora de HTTPS.');
    if (state.subscribePromise) return state.subscribePromise; // single-flight
    const input = options || {};

    state.subscribePromise = (async () => {
      await loadRemoteConfig(false);
      const result = await requestPermission();
      if (result !== 'granted') throw new Error('Permissão de notificações não concedida.');

      const registration = await getRegistration();
      await mirrorStateForServiceWorker();

      let current = null;
      try {
        current = await resolveSubscription(registration);
      } catch (error) {
        // Sem PushSubscription local, qualquer endpoint que o backend guarde para
        // esta instalação está morto. Reconcilia para não inflar o público.
        await reconcile().catch(() => {});
        throw error;
      }

      state.lastSubscribeError = null;
      const payload = {
        installationId: installationId(),
        subscription: serializeSubscription(current)
      };
      if (Object.prototype.hasOwnProperty.call(input, 'preferences')) payload.preferences = input.preferences || {};
      await api('/v1/subscribe', { method: 'POST', body: JSON.stringify(payload) });
      await mirrorStateForServiceWorker();
      return current;
    })().finally(() => { state.subscribePromise = null; });

    return state.subscribePromise;
  }

  // Desativa no backend todos os endpoints desta instalação, mesmo quando o
  // navegador já perdeu a PushSubscription local (estado fantasma).
  async function reconcile() {
    return api('/v1/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ installationId: installationId() })
    });
  }

  async function unsubscribe() {
    const current = await getSubscription().catch(() => null);
    if (!current) {
      await reconcile();
      return false;
    }
    try {
      await api('/v1/unsubscribe', {
        method: 'POST',
        body: JSON.stringify({ installationId: installationId(), endpoint: current.endpoint })
      });
    } finally {
      try { await current.unsubscribe(); } catch (_) {}
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

  async function scheduleChapecoenseTest(delaySeconds = 120) {
    await subscribe();
    return api('/v1/segmented-team-test', {
      method: 'POST',
      body: JSON.stringify({ installationId: installationId(), delaySeconds: Number(delaySeconds) || 120 })
    });
  }

  async function armHotEspnTest() {
    await subscribe();
    return api('/v1/hot-espn-test', {
      method: 'POST',
      body: JSON.stringify({ installationId: installationId() })
    });
  }

  async function armHotMatchTest() {
    await subscribe();
    return api('/v1/hot-match-test', {
      method: 'POST',
      body: JSON.stringify({ installationId: installationId() })
    });
  }

  async function dispatchStatus() {
    return api('/v1/dispatch/status', { method: 'GET' });
  }

  async function opsStatus() {
    return api('/v1/ops/status', { method: 'GET' });
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
      icon: '/notification-fg-192.png', badge: '/notification-fg-96.png',
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

  function lastSubscribeError() {
    return state.lastSubscribeError ? Object.assign({}, state.lastSubscribeError) : null;
  }

  async function diagnostics() {
    const registration = await getRegistration().catch(() => null);
    const subscription = registration?.pushManager
      ? await registration.pushManager.getSubscription().catch(() => null)
      : null;
    let backend = null;
    try { backend = await loadRemoteConfig(false); } catch (_) {}

    let vapidBytes = 0;
    let vapidPrefix = '';
    try {
      const bytes = applicationServerKey();
      vapidBytes = bytes.length;
      vapidPrefix = `0x${bytes[0].toString(16)}`;
    } catch (_) {}

    return {
      secureContext: window.isSecureContext,
      serviceWorker: 'serviceWorker' in navigator,
      pushManager: 'PushManager' in window,
      notifications: 'Notification' in window,
      permission: 'Notification' in window ? Notification.permission : 'unsupported',
      badging: 'setAppBadge' in navigator,
      registration: Boolean(registration),
      swInstalling: Boolean(registration?.installing),
      swWaiting: Boolean(registration?.waiting),
      swActive: Boolean(registration?.active),
      swScope: registration?.scope || '',
      subscription: Boolean(subscription),
      subscriptionKeyMatches: subscription ? sameServerKey(subscription) : null,
      installationId: installationId(),
      backendConfigured: Boolean(backend?.apiBase),
      vapidConfigured: Boolean(backend?.vapidPublicKey),
      vapidBytes,
      vapidPrefix,
      standalone: Boolean(window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true),
      userAgent: navigator.userAgent,
      lastSubscribeError: lastSubscribeError()
    };
  }

  window.FormulaDoGolPush = Object.freeze({
    supported, configure, loadRemoteConfig, getRegistration, requestPermission, getSubscription,
    subscribe, unsubscribe, reconcile, sendRemoteTest, sendQueueTest, scheduleChapecoenseTest,
    armHotEspnTest, armHotMatchTest, dispatchStatus, opsStatus, getPreferences, savePreferences,
    monitorStatus, monitorEvents, showTestNotification, setBadge, clearBadge, diagnostics,
    lastSubscribeError, installationId
  });
})();
