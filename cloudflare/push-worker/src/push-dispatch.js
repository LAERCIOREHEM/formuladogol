import { buildPushPayload } from '@block65/webcrypto-web-push';

const DELIVERY_BATCH_SIZE = 5;
const TARGET_PAGE_SIZE = 400;
const MAX_QUEUE_RETRY_DELAY = 300;

function text(value) { return String(value == null ? '' : value).trim(); }
function num(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }

export function teamSlug(value) {
  return text(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function chunkArray(items, size = DELIVERY_BATCH_SIZE) {
  const out = [];
  const step = Math.max(1, Math.floor(Number(size) || DELIVERY_BATCH_SIZE));
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

function singletonState(env) {
  const id = env.PUSH_STATE.idFromName('global');
  return env.PUSH_STATE.get(id);
}

async function vapidKeys(env) {
  const response = await singletonState(env).fetch('https://internal/vapid');
  if (!response.ok) throw new Error('vapid_unavailable');
  return response.json();
}

export function preferenceColumnForEvent(type) {
  const map = {
    goal: 'p.goals',
    goal_overturned: 'p.overturned_goals',
    prematch_15: 'p.prematch_15',
    final_whistle: 'p.final_whistle',
    schedule_changed: 'p.schedule_changes',
    match_postponed: 'p.schedule_changes',
    shootout_start: 'p.shootout_alerts',
    qualification: 'p.qualification_alerts'
  };
  return map[text(type)] || '';
}

function defaultTitle(type) {
  return ({
    goal: '⚽ GOL!', goal_overturned: '🚫 GOL ANULADO', prematch_15: '⏰ Jogo começa em 15 minutos',
    final_whistle: '🏁 Fim de jogo', schedule_changed: '🕒 Horário alterado', match_postponed: '🚨 Jogo adiado',
    shootout_start: '⚡ DECISÃO NOS PÊNALTIS!', qualification: '🏆 Classificado!'
  })[text(type)] || 'Fórmula do Gol';
}

function notificationUrl(type, eventId) {
  if (['prematch_15', 'schedule_changed', 'match_postponed'].includes(text(type))) return '/agenda.html';
  return eventId ? `/aovivo.html?event=${encodeURIComponent(eventId)}` : '/aovivo.html';
}

export function buildSportsPushPayload(event) {
  const item = event || {};
  const draft = item.notificationDraft || {};
  const eventId = text(item.eventId);
  const type = text(item.type);
  const sourcePlayKey = text(item.sourcePlayKey || item.eventKey);
  const goalFamily = type === 'goal' || type === 'goal_overturned';
  const tagSeed = goalFamily ? `goal-${sourcePlayKey}` : `${type}-${eventId || sourcePlayKey}`;
  return {
    title: text(draft.title || defaultTitle(type)),
    body: text(draft.body || 'Atualização do Fórmula do Gol.'),
    tag: `fdg-${tagSeed}`.slice(0, 120),
    renotify: true,
    badgeIncrement: 1,
    timestamp: Number.isFinite(Date.parse(item.confirmedAt || '')) ? Date.parse(item.confirmedAt) : Date.now(),
    data: {
      url: notificationUrl(type, eventId),
      eventId,
      eventKey: text(item.eventKey),
      type,
      sourcePlayKey
    }
  };
}

function deliveryOptions(type) {
  const value = text(type);
  if (value === 'prematch_15') return { ttl: 900, urgency: 'high' };
  if (value === 'schedule_changed' || value === 'match_postponed') return { ttl: 21600, urgency: 'normal' };
  if (value === 'final_whistle' || value === 'qualification') return { ttl: 3600, urgency: 'high' };
  if (value === 'shootout_start') return { ttl: 600, urgency: 'high' };
  return { ttl: 180, urgency: 'high' };
}

async function sendToSubscription(env, row, payload, eventType = '') {
  const keys = await vapidKeys(env);
  const subscription = {
    endpoint: row.endpoint,
    expirationTime: row.expiration_time ?? null,
    keys: { p256dh: row.p256dh, auth: row.auth }
  };
  const requestInit = await buildPushPayload(
    { data: payload, options: deliveryOptions(eventType) },
    subscription,
    { subject: keys.subject, publicKey: keys.publicKey, privateKey: keys.privateKey }
  );
  return fetch(subscription.endpoint, requestInit);
}

function parseEventRow(row) {
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payload_json || '{}');
    if (!payload || typeof payload !== 'object') return null;
    return payload;
  } catch (_) {
    return null;
  }
}

async function getEvent(env, eventKey) {
  let row = await env.DB.prepare(`
    SELECT event_key, event_type, payload_json
    FROM sports_events
    WHERE event_key=?
  `).bind(eventKey).first();
  if (!row) {
    row = await env.DB.prepare(`
      SELECT event_key, event_type, payload_json
      FROM match_events
      WHERE event_key=?
    `).bind(eventKey).first();
  }
  return row ? { row, payload: parseEventRow(row) } : null;
}

export async function enqueueSportsEvent(env, eventKey) {
  const key = text(eventKey);
  if (!key || !env.PUSH_QUEUE) return false;
  await env.DB.prepare(`
    INSERT OR IGNORE INTO push_event_dispatch (event_key, status)
    VALUES (?, 'pending')
  `).bind(key).run();
  try {
    await env.PUSH_QUEUE.send({ kind: 'event_dispatch', eventKey: key, afterSubscriptionId: '' });
    await env.DB.prepare(`
      UPDATE push_event_dispatch
      SET status='enqueued', enqueued_at=CURRENT_TIMESTAMP, last_error=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE event_key=?
    `).bind(key).run();
    return true;
  } catch (error) {
    await env.DB.prepare(`
      UPDATE push_event_dispatch
      SET status='pending', last_error=?, updated_at=CURRENT_TIMESTAMP
      WHERE event_key=?
    `).bind(text(error?.message || error).slice(0, 1000), key).run();
    throw error;
  }
}

export async function recoverPendingDispatches(env, limit = 20) {
  if (!env.PUSH_QUEUE) return 0;
  const result = await env.DB.prepare(`
    SELECT event_key
    FROM push_event_dispatch
    WHERE status='pending'
       OR (status='enqueued' AND expanded_at IS NULL AND updated_at < datetime('now','-5 minutes'))
    ORDER BY created_at ASC
    LIMIT ?
  `).bind(Math.max(1, Math.min(100, Number(limit) || 20))).all();
  let recovered = 0;
  for (const row of result.results || []) {
    try {
      await env.PUSH_QUEUE.send({ kind: 'event_dispatch', eventKey: row.event_key, afterSubscriptionId: '' });
      await env.DB.prepare(`
        UPDATE push_event_dispatch
        SET status='enqueued', enqueued_at=CURRENT_TIMESTAMP, last_error=NULL, updated_at=CURRENT_TIMESTAMP
        WHERE event_key=?
      `).bind(row.event_key).run();
      recovered += 1;
    } catch (error) {
      await env.DB.prepare(`UPDATE push_event_dispatch SET last_error=?, updated_at=CURRENT_TIMESTAMP WHERE event_key=?`)
        .bind(text(error?.message || error).slice(0, 1000), row.event_key).run();
    }
  }
  return recovered;
}


export async function recoverStuckDeliveries(env, limit = 50) {
  if (!env.PUSH_QUEUE) return 0;
  const result = await env.DB.prepare(`
    SELECT d.event_key, d.subscription_id
    FROM push_deliveries d
    JOIN push_subscriptions s ON s.subscription_id=d.subscription_id AND s.active=1
    WHERE d.status IN ('sending','retry')
      AND d.updated_at < datetime('now','-3 minutes')
      AND d.attempts < 12
    ORDER BY d.updated_at ASC
    LIMIT ?
  `).bind(Math.max(1, Math.min(200, Number(limit) || 50))).all();

  const grouped = new Map();
  for (const row of result.results || []) {
    const eventKey = text(row.event_key);
    const subscriptionId = text(row.subscription_id);
    if (!eventKey || !subscriptionId) continue;
    if (!grouped.has(eventKey)) grouped.set(eventKey, []);
    grouped.get(eventKey).push(subscriptionId);
  }

  let recovered = 0;
  for (const [eventKey, ids] of grouped.entries()) {
    for (const subscriptionIds of chunkArray(ids, DELIVERY_BATCH_SIZE)) {
      await env.PUSH_QUEUE.send({ kind: 'delivery_batch', eventKey, subscriptionIds, recovered: true });
      recovered += subscriptionIds.length;
    }
  }
  return recovered;
}

async function eligibleTargets(env, event, afterSubscriptionId = '') {
  const flagColumn = preferenceColumnForEvent(event.type);
  if (!flagColumn) return [];
  const homeSlug = teamSlug(event.home?.name);
  const awaySlug = teamSlug(event.away?.name);
  const homeEspn = text(event.home?.id) ? `espn:${text(event.home.id)}` : '';
  const awayEspn = text(event.away?.id) ? `espn:${text(event.away.id)}` : '';
  const homeLegacy = homeSlug;
  const awayLegacy = awaySlug;
  const homeNamed = homeSlug ? `team:${homeSlug}` : '';
  const awayNamed = awaySlug ? `team:${awaySlug}` : '';
  const homeAbbr = text(event.home?.abbreviation).toUpperCase();
  const awayAbbr = text(event.away?.abbreviation).toUpperCase();
  const homeAbbrToken = homeAbbr ? `abbr:${homeAbbr}` : '';
  const awayAbbrToken = awayAbbr ? `abbr:${awayAbbr}` : '';
  const eventId = text(event.eventId);
  const result = await env.DB.prepare(`
    SELECT s.subscription_id, s.installation_id
    FROM push_subscriptions s
    JOIN push_preferences_v2 p ON p.installation_id=s.installation_id
    WHERE s.active=1
      AND s.subscription_id > ?
      AND ${flagColumn}=1
      AND (
        p.all_games=1
        OR EXISTS (
          SELECT 1 FROM json_each(CASE WHEN json_valid(p.games_json) THEN p.games_json ELSE '[]' END)
          WHERE CAST(value AS TEXT)=?
        )
        OR EXISTS (
          SELECT 1 FROM json_each(CASE WHEN json_valid(p.teams_json) THEN p.teams_json ELSE '[]' END)
          WHERE CAST(value AS TEXT) IN (?, ?, ?, ?, ?, ?, ?, ?)
        )
      )
    ORDER BY s.subscription_id ASC
    LIMIT ?
  `).bind(
    text(afterSubscriptionId), eventId,
    homeEspn, awayEspn, homeAbbrToken, awayAbbrToken, homeNamed, awayNamed, homeLegacy, awayLegacy,
    TARGET_PAGE_SIZE + 1
  ).all();
  return result.results || [];
}

async function expandSportsEvent(messageBody, env) {
  const eventKey = text(messageBody?.eventKey);
  const afterSubscriptionId = text(messageBody?.afterSubscriptionId);
  const loaded = await getEvent(env, eventKey);
  if (!loaded?.payload) {
    await env.DB.prepare(`UPDATE push_event_dispatch SET status='failed', last_error='event_not_found', updated_at=CURRENT_TIMESTAMP WHERE event_key=?`)
      .bind(eventKey).run();
    return { kind: 'event_dispatch', eventKey, targetCount: 0, batchCount: 0, complete: true };
  }

  const rows = await eligibleTargets(env, loaded.payload, afterSubscriptionId);
  const hasMore = rows.length > TARGET_PAGE_SIZE;
  const page = hasMore ? rows.slice(0, TARGET_PAGE_SIZE) : rows;
  const ids = page.map((row) => text(row.subscription_id)).filter(Boolean);
  const batches = chunkArray(ids, DELIVERY_BATCH_SIZE);
  for (const subscriptionIds of batches) {
    await env.PUSH_QUEUE.send({ kind: 'delivery_batch', eventKey, subscriptionIds });
  }

  await env.DB.prepare(`
    UPDATE push_event_dispatch
    SET target_count=target_count+?, batch_count=batch_count+?, updated_at=CURRENT_TIMESTAMP,
        status=?, expanded_at=CASE WHEN ?=1 THEN CURRENT_TIMESTAMP ELSE expanded_at END,
        last_error=NULL
    WHERE event_key=?
  `).bind(page.length, batches.length, hasMore ? 'enqueued' : 'expanded', hasMore ? 0 : 1, eventKey).run();

  if (hasMore && page.length) {
    await env.PUSH_QUEUE.send({
      kind: 'event_dispatch',
      eventKey,
      afterSubscriptionId: page[page.length - 1].subscription_id
    });
  }
  return { kind: 'event_dispatch', eventKey, targetCount: page.length, batchCount: batches.length, complete: !hasMore };
}

async function loadSubscriptions(env, subscriptionIds) {
  if (!subscriptionIds.length) return [];
  const result = await env.DB.prepare(`
    SELECT subscription_id, installation_id, endpoint, p256dh, auth, expiration_time
    FROM push_subscriptions
    WHERE active=1
      AND subscription_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
  `).bind(JSON.stringify(subscriptionIds)).all();
  return result.results || [];
}

async function acquireDelivery(env, eventKey, row) {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO push_deliveries (event_key, subscription_id, installation_id, status)
    VALUES (?, ?, ?, 'queued')
  `).bind(eventKey, row.subscription_id, row.installation_id).run();

  const lock = await env.DB.prepare(`
    UPDATE push_deliveries
    SET status='sending', attempts=attempts+1, updated_at=CURRENT_TIMESTAMP
    WHERE event_key=? AND subscription_id=?
      AND (
        status IN ('queued','retry')
        OR (status='sending' AND updated_at < datetime('now','-2 minutes'))
      )
  `).bind(eventKey, row.subscription_id).run();
  return num(lock?.meta?.changes, 0) > 0;
}

async function deliverOne(env, eventKey, eventPayload, row) {
  if (!(await acquireDelivery(env, eventKey, row))) return { skipped: true, transient: false };
  const payload = buildSportsPushPayload(eventPayload);
  let response;
  try {
    response = await sendToSubscription(env, row, payload, eventPayload?.type);
  } catch (error) {
    await env.DB.prepare(`
      UPDATE push_deliveries
      SET status='retry', last_error=?, updated_at=CURRENT_TIMESTAMP
      WHERE event_key=? AND subscription_id=?
    `).bind(text(error?.message || error).slice(0, 1000), eventKey, row.subscription_id).run();
    return { skipped: false, transient: true };
  }

  if (response.ok) {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE push_deliveries SET status='sent', last_status=?, last_error=NULL, sent_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
        WHERE event_key=? AND subscription_id=?
      `).bind(response.status, eventKey, row.subscription_id),
      env.DB.prepare(`
        UPDATE push_subscriptions SET last_success_at=CURRENT_TIMESTAMP, last_failure_status=NULL, updated_at=CURRENT_TIMESTAMP
        WHERE subscription_id=?
      `).bind(row.subscription_id)
    ]);
    return { skipped: false, transient: false, status: response.status };
  }

  if (response.status === 404 || response.status === 410) {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE push_deliveries SET status='gone', last_status=?, last_error='subscription_gone', updated_at=CURRENT_TIMESTAMP
        WHERE event_key=? AND subscription_id=?
      `).bind(response.status, eventKey, row.subscription_id),
      env.DB.prepare(`
        UPDATE push_subscriptions SET active=0, last_failure_at=CURRENT_TIMESTAMP, last_failure_status=?, updated_at=CURRENT_TIMESTAMP
        WHERE subscription_id=?
      `).bind(response.status, row.subscription_id)
    ]);
    return { skipped: false, transient: false, status: response.status };
  }

  const transient = response.status === 408 || response.status === 429 || response.status >= 500;
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE push_deliveries SET status=?, last_status=?, last_error=?, updated_at=CURRENT_TIMESTAMP
      WHERE event_key=? AND subscription_id=?
    `).bind(transient ? 'retry' : 'failed', response.status, `HTTP ${response.status}`, eventKey, row.subscription_id),
    env.DB.prepare(`
      UPDATE push_subscriptions SET last_failure_at=CURRENT_TIMESTAMP, last_failure_status=?, updated_at=CURRENT_TIMESTAMP
      WHERE subscription_id=?
    `).bind(response.status, row.subscription_id)
  ]);
  return { skipped: false, transient, status: response.status };
}

async function deliverSportsBatch(messageBody, env) {
  const eventKey = text(messageBody?.eventKey);
  const ids = Array.isArray(messageBody?.subscriptionIds)
    ? [...new Set(messageBody.subscriptionIds.map((id) => text(id)).filter(Boolean))].slice(0, DELIVERY_BATCH_SIZE)
    : [];
  if (!eventKey || !ids.length) return { kind: 'delivery_batch', delivered: 0, transient: false };
  const loaded = await getEvent(env, eventKey);
  if (!loaded?.payload) return { kind: 'delivery_batch', delivered: 0, transient: false };
  const rows = await loadSubscriptions(env, ids);
  const results = await Promise.all(rows.map((row) => deliverOne(env, eventKey, loaded.payload, row)));
  return {
    kind: 'delivery_batch',
    delivered: results.filter((x) => !x.skipped && !x.transient && x.status >= 200 && x.status < 300).length,
    transient: results.some((x) => x.transient)
  };
}

async function directQueueTest(messageBody, env) {
  const installationId = text(messageBody?.installationId);
  if (!installationId) return { kind: 'direct_test', delivered: 0, transient: false };
  const result = await env.DB.prepare(`
    SELECT subscription_id, installation_id, endpoint, p256dh, auth, expiration_time
    FROM push_subscriptions
    WHERE installation_id=? AND active=1
    ORDER BY updated_at DESC LIMIT 1
  `).bind(installationId).all();
  const row = (result.results || [])[0];
  if (!row) return { kind: 'direct_test', delivered: 0, transient: false };
  try {
    const response = await sendToSubscription(env, row, {
      title: 'Fórmula do Gol — fila de alertas',
      body: 'Teste da Cloudflare Queue concluído. O próximo passo é o alerta automático de gol.',
      tag: `fdg-queue-test-${Date.now()}`,
      renotify: true,
      badgeCount: 1,
      data: { url: '/alertas.html', type: 'queue_test' }
    });
    if (response.status === 404 || response.status === 410) {
      await env.DB.prepare(`UPDATE push_subscriptions SET active=0, last_failure_at=CURRENT_TIMESTAMP, last_failure_status=?, updated_at=CURRENT_TIMESTAMP WHERE subscription_id=?`)
        .bind(response.status, row.subscription_id).run();
    } else if (response.ok) {
      await env.DB.prepare(`UPDATE push_subscriptions SET last_success_at=CURRENT_TIMESTAMP, last_failure_status=NULL, updated_at=CURRENT_TIMESTAMP WHERE subscription_id=?`)
        .bind(row.subscription_id).run();
    }
    return { kind: 'direct_test', delivered: response.ok ? 1 : 0, transient: response.status === 408 || response.status === 429 || response.status >= 500 };
  } catch (_) {
    return { kind: 'direct_test', delivered: 0, transient: true };
  }
}

export async function processQueueBody(body, env) {
  const kind = text(body?.kind);
  if (kind === 'event_dispatch') return expandSportsEvent(body, env);
  if (kind === 'delivery_batch') return deliverSportsBatch(body, env);
  if (kind === 'direct_test') return directQueueTest(body, env);
  return { kind: kind || 'unknown', ignored: true, transient: false };
}

export async function handleQueueBatch(batch, env) {
  for (const message of batch.messages || []) {
    try {
      const result = await processQueueBody(message.body || {}, env);
      if (result?.transient) {
        const attempts = Math.max(1, Number(message.attempts) || 1);
        const delaySeconds = Math.min(MAX_QUEUE_RETRY_DELAY, 15 * (2 ** Math.min(4, attempts - 1)));
        message.retry({ delaySeconds });
      } else {
        message.ack();
      }
    } catch (error) {
      console.error('queue-message-error', error);
      const attempts = Math.max(1, Number(message.attempts) || 1);
      const delaySeconds = Math.min(MAX_QUEUE_RETRY_DELAY, 15 * (2 ** Math.min(4, attempts - 1)));
      message.retry({ delaySeconds });
    }
  }
}

export async function dispatchStatus(env) {
  const [subscriptions, pending, deliveries] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM push_subscriptions WHERE active=1`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM push_event_dispatch WHERE status IN ('pending','enqueued')`).first(),
    env.DB.prepare(`
      SELECT
        SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN status='retry' THEN 1 ELSE 0 END) AS retry,
        SUM(CASE WHEN status='gone' THEN 1 ELSE 0 END) AS gone,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
      FROM push_deliveries
    `).first()
  ]);
  return {
    ok: true,
    dispatchVersion: 5,
    activeSubscriptions: num(subscriptions?.count, 0),
    pendingEvents: num(pending?.count, 0),
    deliveries: {
      sent: num(deliveries?.sent, 0),
      retry: num(deliveries?.retry, 0),
      gone: num(deliveries?.gone, 0),
      failed: num(deliveries?.failed, 0)
    }
  };
}

export const PUSH_DISPATCH_CONSTANTS = Object.freeze({ DELIVERY_BATCH_SIZE, TARGET_PAGE_SIZE });
