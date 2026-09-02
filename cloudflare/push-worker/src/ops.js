import { recoverPendingDispatches, recoverStuckDeliveries } from './push-dispatch.js';

const OPS_VERSION = 6;
const STALE_ACTIVE_POLL_MS = 120_000;
const STALE_BOOTSTRAP_MS = 5 * 60_000;
const STUCK_DISPATCH_MINUTES = 10;
const STUCK_DELIVERY_MINUTES = 5;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;

function text(value) { return String(value == null ? '' : value).trim(); }
function num(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function iso(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : text(value);
}

async function readState(env, key) {
  const row = await env.DB.prepare(`SELECT value FROM ops_state WHERE key=?`).bind(key).first();
  return text(row?.value);
}

async function writeState(env, key, value) {
  await env.DB.prepare(`
    INSERT INTO ops_state (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
  `).bind(key, String(value ?? '')).run();
}

async function cleanupOldRows(env) {
  const now = Date.now();
  const previous = Number(await readState(env, 'last_cleanup_ms')) || 0;
  if (previous && now - previous < CLEANUP_INTERVAL_MS) return { ran: false };

  const statements = [
    env.DB.prepare(`DELETE FROM push_audit WHERE created_at < datetime('now','-30 days')`),
    env.DB.prepare(`DELETE FROM push_deliveries WHERE updated_at < datetime('now','-90 days')`),
    env.DB.prepare(`DELETE FROM push_event_dispatch WHERE updated_at < datetime('now','-90 days')`),
    env.DB.prepare(`DELETE FROM sports_events WHERE created_at < datetime('now','-90 days')`),
    env.DB.prepare(`DELETE FROM match_events WHERE created_at < datetime('now','-90 days')`),
    env.DB.prepare(`DELETE FROM push_subscriptions WHERE active=0 AND updated_at < datetime('now','-180 days')`),
    env.DB.prepare(`
      DELETE FROM push_preferences_v2
      WHERE updated_at < datetime('now','-180 days')
        AND NOT EXISTS (
          SELECT 1 FROM push_subscriptions s
          WHERE s.installation_id=push_preferences_v2.installation_id AND s.active=1
        )
    `)
  ];
  const results = await env.DB.batch(statements);
  await writeState(env, 'last_cleanup_ms', now);
  return {
    ran: true,
    changes: (results || []).reduce((sum, item) => sum + num(item?.meta?.changes, 0), 0)
  };
}

export function assessOperationalHealth(input, nowMs = Date.now()) {
  const data = input || {};
  const monitor = data.monitor || {};
  const dispatch = data.dispatch || {};
  const warnings = [];
  const errors = [];
  const now = num(nowMs, Date.now());
  const watchCount = num(monitor.watchCount, 0);
  const activeGames = num(monitor.activeGames, 0);
  const lastPoll = num(monitor.lastPollCompletedAt || monitor.lastPollAt, 0);
  const lastBootstrap = num(monitor.lastBootstrapAt, 0);

  if (text(monitor.lastAgendaError)) warnings.push(`agenda: ${text(monitor.lastAgendaError).slice(0, 240)}`);
  if (text(monitor.lastPollError)) warnings.push(`espn: ${text(monitor.lastPollError).slice(0, 240)}`);
  if (activeGames > 0 && (!lastPoll || now - lastPoll > STALE_ACTIVE_POLL_MS)) {
    errors.push('monitor_ao_vivo_sem_poll_recente');
  } else if (watchCount > 0 && (!lastBootstrap || now - lastBootstrap > STALE_BOOTSTRAP_MS)) {
    warnings.push('watchlist_sem_bootstrap_recente');
  }

  if (num(dispatch.stuckDispatches, 0) > 0) errors.push('eventos_de_dispatch_travados');
  if (num(dispatch.stuckDeliveries, 0) > 0) errors.push('entregas_push_travadas');
  if (num(dispatch.retry, 0) > 0) warnings.push('entregas_em_retry');
  if (num(dispatch.failed24h, 0) > 0) warnings.push('falhas_permanentes_nas_ultimas_24h');

  const state = errors.length ? 'degraded' : warnings.length ? 'warning' : activeGames > 0 ? 'live' : 'healthy';
  return { ok: errors.length === 0, state, warnings, errors };
}

async function dbMetrics(env) {
  const [subs, events, matchEvents, dispatch, deliveries, recentDeliveries, latency, latest] = await Promise.all([
    env.DB.prepare(`
      SELECT
        SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN active=0 THEN 1 ELSE 0 END) AS inactive
      FROM push_subscriptions
    `).first(),
    env.DB.prepare(`
      SELECT
        SUM(CASE WHEN event_type='goal' AND created_at >= datetime('now','-24 hours') THEN 1 ELSE 0 END) AS goals24h,
        SUM(CASE WHEN event_type='goal_overturned' AND created_at >= datetime('now','-24 hours') THEN 1 ELSE 0 END) AS overturned24h,
        COUNT(*) AS total
      FROM sports_events
    `).first(),
    env.DB.prepare(`
      SELECT
        SUM(CASE WHEN event_type='prematch_15' AND created_at >= datetime('now','-24 hours') THEN 1 ELSE 0 END) AS prematch24h,
        SUM(CASE WHEN event_type='final_whistle' AND created_at >= datetime('now','-24 hours') THEN 1 ELSE 0 END) AS final24h,
        SUM(CASE WHEN event_type IN ('schedule_changed','match_postponed') AND created_at >= datetime('now','-24 hours') THEN 1 ELSE 0 END) AS schedule24h,
        SUM(CASE WHEN event_type='shootout_start' AND created_at >= datetime('now','-24 hours') THEN 1 ELSE 0 END) AS shootout24h,
        SUM(CASE WHEN event_type='qualification' AND created_at >= datetime('now','-24 hours') THEN 1 ELSE 0 END) AS qualification24h,
        COUNT(*) AS total
      FROM match_events
    `).first(),
    env.DB.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('pending','enqueued') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status IN ('pending','enqueued') AND updated_at < datetime('now','-${STUCK_DISPATCH_MINUTES} minutes') THEN 1 ELSE 0 END) AS stuck
      FROM push_event_dispatch
    `).first(),
    env.DB.prepare(`
      SELECT
        SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN status='retry' THEN 1 ELSE 0 END) AS retry,
        SUM(CASE WHEN status='gone' THEN 1 ELSE 0 END) AS gone,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status IN ('sending','retry') AND updated_at < datetime('now','-${STUCK_DELIVERY_MINUTES} minutes') THEN 1 ELSE 0 END) AS stuck
      FROM push_deliveries
    `).first(),
    env.DB.prepare(`
      SELECT
        SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent24h,
        SUM(CASE WHEN status='retry' THEN 1 ELSE 0 END) AS retry24h,
        SUM(CASE WHEN status='gone' THEN 1 ELSE 0 END) AS gone24h,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed24h
      FROM push_deliveries
      WHERE updated_at >= datetime('now','-24 hours')
    `).first(),
    env.DB.prepare(`
      SELECT
        AVG((julianday(d.sent_at)-julianday(e.confirmed_at))*86400000.0) AS avg_ms,
        MAX((julianday(d.sent_at)-julianday(e.confirmed_at))*86400000.0) AS max_ms,
        COUNT(*) AS samples
      FROM push_deliveries d
      JOIN sports_events e ON e.event_key=d.event_key
      WHERE d.status='sent' AND d.sent_at IS NOT NULL
        AND d.sent_at >= datetime('now','-24 hours')
    `).first(),
    env.DB.prepare(`
      SELECT
        (SELECT MAX(ts) FROM (
          SELECT MAX(confirmed_at) AS ts FROM sports_events
          UNION ALL SELECT MAX(confirmed_at) AS ts FROM match_events
        )) AS last_event_at,
        (SELECT MAX(sent_at) FROM push_deliveries WHERE status='sent') AS last_push_at
    `).first()
  ]);

  return {
    subscriptions: { active: num(subs?.active, 0), inactive: num(subs?.inactive, 0) },
    events: {
      total: num(events?.total, 0) + num(matchEvents?.total, 0),
      goals24h: num(events?.goals24h, 0), overturned24h: num(events?.overturned24h, 0),
      prematch24h: num(matchEvents?.prematch24h, 0), final24h: num(matchEvents?.final24h, 0),
      schedule24h: num(matchEvents?.schedule24h, 0), shootout24h: num(matchEvents?.shootout24h, 0),
      qualification24h: num(matchEvents?.qualification24h, 0),
      lastEventAt: iso(latest?.last_event_at)
    },
    dispatch: {
      pending: num(dispatch?.pending, 0), stuckDispatches: num(dispatch?.stuck, 0),
      sent: num(deliveries?.sent, 0), retry: num(deliveries?.retry, 0), gone: num(deliveries?.gone, 0), failed: num(deliveries?.failed, 0),
      stuckDeliveries: num(deliveries?.stuck, 0),
      sent24h: num(recentDeliveries?.sent24h, 0), retry24h: num(recentDeliveries?.retry24h, 0),
      gone24h: num(recentDeliveries?.gone24h, 0), failed24h: num(recentDeliveries?.failed24h, 0),
      lastPushAt: iso(latest?.last_push_at),
      latency24h: {
        samples: num(latency?.samples, 0),
        averageMs: Math.max(0, Math.round(num(latency?.avg_ms, 0))),
        maxMs: Math.max(0, Math.round(num(latency?.max_ms, 0)))
      }
    }
  };
}

export async function opsStatus(env, monitor) {
  const metrics = await dbMetrics(env);
  const heartbeat = await env.DB.prepare(`SELECT key,value,updated_at FROM ops_state WHERE key IN ('last_cron_ok_ms','last_cron_error','last_cleanup_ms')`).all();
  const stateMap = {};
  for (const row of heartbeat.results || []) stateMap[row.key] = { value: text(row.value), updatedAt: iso(row.updated_at) };
  const health = assessOperationalHealth({ monitor, dispatch: metrics.dispatch });
  return {
    ok: health.ok,
    opsVersion: OPS_VERSION,
    state: health.state,
    warnings: health.warnings,
    errors: health.errors,
    monitor: monitor || {},
    ...metrics,
    maintenance: {
      lastCronOkAt: stateMap.last_cron_ok_ms ? iso(Number(stateMap.last_cron_ok_ms.value)) : '',
      lastCronError: stateMap.last_cron_error?.value || '',
      lastCleanupAt: stateMap.last_cleanup_ms ? iso(Number(stateMap.last_cleanup_ms.value)) : ''
    }
  };
}

export async function runOperationalMaintenance(env, monitorStub) {
  const started = Date.now();
  let recoveredDispatches = 0;
  let recoveredDeliveries = 0;
  let cleanup = { ran: false };
  try {
    const tasks = await Promise.allSettled([
      monitorStub.fetch('https://internal/bootstrap', { method: 'POST' }),
      recoverPendingDispatches(env),
      recoverStuckDeliveries(env),
      cleanupOldRows(env)
    ]);
    const monitorResult = tasks[0];
    if (monitorResult.status === 'fulfilled') {
      if (!monitorResult.value.ok) throw new Error(`sports_monitor_bootstrap_${monitorResult.value.status}`);
      await monitorResult.value.arrayBuffer();
    }
    if (tasks[1].status === 'fulfilled') recoveredDispatches = num(tasks[1].value, 0);
    if (tasks[2].status === 'fulfilled') recoveredDeliveries = num(tasks[2].value, 0);
    if (tasks[3].status === 'fulfilled') cleanup = tasks[3].value || cleanup;

    const failures = tasks
      .map((item, index) => item.status === 'rejected' ? `${index}:${text(item.reason?.message || item.reason)}` : '')
      .filter(Boolean);
    if (failures.length) throw new Error(failures.join(' | '));

    await writeState(env, 'last_cron_ok_ms', Date.now());
    await writeState(env, 'last_cron_error', '');
    console.log(JSON.stringify({
      event: 'fdg_ops_cron_ok', durationMs: Date.now() - started,
      recoveredDispatches, recoveredDeliveries, cleanup
    }));
    return { ok: true, recoveredDispatches, recoveredDeliveries, cleanup };
  } catch (error) {
    const message = text(error?.message || error).slice(0, 1500);
    try { await writeState(env, 'last_cron_error', message); } catch (_) {}
    console.error(JSON.stringify({ event: 'fdg_ops_cron_error', durationMs: Date.now() - started, error: message }));
    throw error;
  }
}

export const OPS_CONSTANTS = Object.freeze({
  OPS_VERSION,
  STALE_ACTIVE_POLL_MS,
  STALE_BOOTSTRAP_MS,
  STUCK_DISPATCH_MINUTES,
  STUCK_DELIVERY_MINUTES,
  CLEANUP_INTERVAL_MS
});
