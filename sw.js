/* Fórmula do Gol — Service Worker PWA / Web Push
 * Execução 3 — 2026-09-01
 *
 * IMPORTANTE: este Service Worker NÃO intercepta fetch e NÃO mantém cache
 * de placares, agenda, probabilidades ou qualquer dado esportivo dinâmico.
 */

const SW_VERSION = '20260901-push-core-v1';
const DEFAULT_ICON = '/favicon-formula-do-gol-192.png';
const DEFAULT_BADGE = '/favicon-formula-do-gol-96.png';
const DEFAULT_URL = '/aovivo.html';

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
      if (typeof self.navigator.clearAppBadge === 'function') {
        await self.navigator.clearAppBadge();
      } else {
        await self.navigator.setAppBadge(0);
      }
      return;
    }

    const raw = payload && payload.badgeCount;
    const count = Number(raw);
    if (Number.isFinite(count) && count >= 0) {
      await self.navigator.setAppBadge(Math.floor(count));
      return;
    }

    // Sem contador explícito, mostra somente o indicador quando suportado.
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
        if (self.navigator && typeof self.navigator.clearAppBadge === 'function') {
          await self.navigator.clearAppBadge();
        } else if (self.navigator && typeof self.navigator.setAppBadge === 'function') {
          await self.navigator.setAppBadge(0);
        }
      } catch (_) {}
    })());
  }
});
