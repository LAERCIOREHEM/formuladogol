/* Fórmula do Gol — Service Worker PWA / Web Push
 * Execução 5 — 2026-09-01
 *
 * IMPORTANTE: este Service Worker NÃO intercepta fetch e NÃO mantém cache
 * de placares, agenda, probabilidades ou qualquer dado esportivo dinâmico.
 */

const SW_VERSION = '20260901-alertas-v2-notification-icon';
const DEFAULT_ICON = '/notification-fg-192.png';
const DEFAULT_BADGE = '/notification-fg-96.png';
const DEFAULT_URL = '/aovivo.html';
const BADGE_DB = 'fdg-pwa-state-v1';
const BADGE_STORE = 'state';

function openStateDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BADGE_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BADGE_STORE)) db.createObjectStore(BADGE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function badgeState(nextValue) {
  if (typeof indexedDB === 'undefined') return 0;
  const db = await openStateDb();
  try {
    if (nextValue === undefined) {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(BADGE_STORE, 'readonly');
        const req = tx.objectStore(BADGE_STORE).get('badgeCount');
        req.onsuccess = () => resolve(Number(req.result || 0));
        req.onerror = () => reject(req.error);
      });
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction(BADGE_STORE, 'readwrite');
      tx.objectStore(BADGE_STORE).put(Math.max(0, Math.floor(Number(nextValue) || 0)), 'badgeCount');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    return Math.max(0, Math.floor(Number(nextValue) || 0));
  } finally { db.close(); }
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function normalizePushPayload(event) {
  if (!event.data) return {};

  try {
    return event.data.json() || {};
  } catch (_) {
    try {
      return { body: event.data.text() };
    } catch (_) {
      return {};
    }
  }
}

async function setBadgeFromPayload(payload) {
  if (!self.navigator || typeof self.navigator.setAppBadge !== 'function') return;

  try {
    if (payload && payload.clearBadge) {
      await badgeState(0).catch(() => 0);
      if (typeof self.navigator.clearAppBadge === 'function') await self.navigator.clearAppBadge();
      else await self.navigator.setAppBadge(0);
      return;
    }

    const increment = Number(payload && payload.badgeIncrement);
    if (Number.isFinite(increment) && increment > 0) {
      const current = await badgeState().catch(() => 0);
      const next = Math.max(1, current + Math.floor(increment));
      await badgeState(next).catch(() => next);
      await self.navigator.setAppBadge(next);
      return;
    }

    const raw = payload && payload.badgeCount;
    const count = Number(raw);
    if (Number.isFinite(count) && count >= 0) {
      await badgeState(Math.floor(count)).catch(() => count);
      await self.navigator.setAppBadge(Math.floor(count));
      return;
    }

    await self.navigator.setAppBadge();
  } catch (_) {
    // Badge é complemento: falha nunca deve impedir a notificação.
  }
}

self.addEventListener('push', (event) => {
  const payload = normalizePushPayload(event);
  const title = String(payload.title || 'Fórmula do Gol');
  const data = Object.assign({}, payload.data || {});
  data.url = String(data.url || payload.url || DEFAULT_URL);

  const options = {
    body: String(payload.body || 'Há uma nova atualização no Fórmula do Gol.'),
    icon: String(payload.icon || DEFAULT_ICON),
    badge: String(payload.badge || DEFAULT_BADGE),
    tag: payload.tag ? String(payload.tag) : undefined,
    renotify: Boolean(payload.renotify),
    requireInteraction: Boolean(payload.requireInteraction),
    silent: Boolean(payload.silent),
    timestamp: Number.isFinite(Number(payload.timestamp)) ? Number(payload.timestamp) : Date.now(),
    data
  };

  if (Array.isArray(payload.actions)) {
    options.actions = payload.actions.slice(0, 2);
  }

  event.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    setBadgeFromPayload(payload)
  ]));
});

async function focusOrOpen(url) {
  const target = new URL(url || DEFAULT_URL, self.location.origin);
  if (target.origin !== self.location.origin) target.href = new URL(DEFAULT_URL, self.location.origin).href;

  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windows) {
    try {
      const current = new URL(client.url);
      if (current.origin !== self.location.origin) continue;
      if (typeof client.navigate === 'function') await client.navigate(target.href);
      if (typeof client.focus === 'function') return client.focus();
    } catch (_) {
      // Tenta a próxima janela; se nenhuma servir, abre uma nova.
    }
  }

  if (self.clients.openWindow) return self.clients.openWindow(target.href);
  return undefined;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(Promise.all([
    focusOrOpen(data.url || DEFAULT_URL),
    (async () => {
      try {
        await badgeState(0).catch(() => 0);
        if (self.navigator && typeof self.navigator.clearAppBadge === 'function') {
          await self.navigator.clearAppBadge();
        } else if (self.navigator && typeof self.navigator.setAppBadge === 'function') {
          await self.navigator.setAppBadge(0);
        }
      } catch (_) {}
    })()
  ]));
});

self.addEventListener('notificationclose', () => {
  // Reservado para telemetria de entrega na Execução 3/5.
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      client.postMessage({ type: 'FDG_PUSH_SUBSCRIPTION_CHANGED', swVersion: SW_VERSION });
    }
  })());
});

self.addEventListener('message', (event) => {
  const message = event.data || {};

  if (message.type === 'FDG_SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
    return;
  }

  if (message.type === 'FDG_CLEAR_BADGE') {
    event.waitUntil((async () => {
      try {
        await badgeState(0).catch(() => 0);
        if (self.navigator && typeof self.navigator.clearAppBadge === 'function') {
          await self.navigator.clearAppBadge();
        } else if (self.navigator && typeof self.navigator.setAppBadge === 'function') {
          await self.navigator.setAppBadge(0);
        }
      } catch (_) {}
    })());
  }
});
