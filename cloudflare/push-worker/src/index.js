import { buildPushPayload } from '@block65/webcrypto-web-push';
import { PushState } from './push-state.js';
import { SportsMonitor } from './sports-monitor.js';
import { enrichSportsMonitorLiveFacts } from './monitor-live-facts.js';
import { dispatchStatus, enqueueSportsEvent, handleQueueBatch } from './push-dispatch.js';
import { opsStatus, runOperationalMaintenance } from './ops.js';
import { probeEspnSources } from './espn-source.js';
import { LIVE_API_CONSTANTS, resolveLiveScoreboard, resolveLiveSummary } from './live-api.js';
import { createLiveStatsStore } from './live-stats-store.js';
import { postgameStatus, readPostgameFastlane, runPostgameMaintenance } from './postgame-fastlane.js';
import { feedbackNotifierConfigured, runFeedbackNotifier } from './feedback-notifier.js';
import { healthMonitorStatus, runHealthMonitor } from './health-monitor.js';

export { PushState, SportsMonitor };

const ALLOWED_ORIGINS = new Set([
  'https://formuladogol.com.br',
  'https://www.formuladogol.com.br'
]);
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  if (!ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(request, data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(request), ...extra }
  });
}

function cleanId(value, max = 128) {
  const text = String(value || '').trim();
  if (!text || text.length > max || !/^[A-Za-z0-9._:-]+$/.test(text)) return '';
  return text;
}

function endpointIsValid(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch (_) {
    return false;
  }
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function readBody(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 32768) throw new Error('payload_too_large');
  return request.json();
}

async function rateLimit(request, env, installationId, route) {
  if (!env.PUBLIC_RATE_LIMITER) return true;
  const actor = cleanId(installationId) || 'anonymous';
  const result = await env.PUBLIC_RATE_LIMITER.limit({ key: `${actor}:${route}` });
  return Boolean(result && result.success);
}

async function allowStatusRead(request, env, route) {
  const actor = cleanId(request.headers.get('CF-Connecting-IP'), 128) || 'status-reader';
  return rateLimit(request, env, actor, route);
}

function singletonState(env) {
  const id = env.PUSH_STATE.idFromName('global');
  return env.PUSH_STATE.get(id);
}

function singletonMonitor(env) {
  const id = env.SPORTS_MONITOR.idFromName('global');
  return env.SPORTS_MONITOR.get(id);
}

function monitorScoreParts(value) {
  const match = String(value || '').match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

async function monitorLiveScoreboardFallback(env, league, now = Date.now()) {
  const response = await singletonMonitor(env).fetch('https://internal/status');
  if (!response.ok) return null;
  const status = await response.json();
  const matches = Array.isArray(status?.matches) ? status.matches.filter((row) => row?.league === league) : [];
  if (!matches.length) return null;

  const freshestMatchAt = matches.reduce((max, row) => Math.max(max, Number(row?.lastObservedAt || 0)), 0);
  const fetchedAt = Math.max(Number(status?.lastPollSuccessAt || 0), freshestMatchAt);
  if (!(fetchedAt > 0) || now - fetchedAt > 10 * 60_000) return null;

  const events = matches.map((row) => {
    const [homeScore, awayScore] = monitorScoreParts(row?.score);
    const state = String(row?.state || 'pre').toLowerCase();
    const completed = state === 'post';
    const clock = String(row?.clock || '');
    return {
      id: String(row?.eventId || ''),
      date: String(row?.kickoff || ''),
      status: {
        type: { state, completed, shortDetail: clock, detail: clock },
        displayClock: clock
      },
      competitions: [{
        id: String(row?.eventId || ''),
        date: String(row?.kickoff || ''),
        competitors: [
          { homeAway: 'home', score: String(homeScore), team: { displayName: String(row?.home || '') } },
          { homeAway: 'away', score: String(awayScore), team: { displayName: String(row?.away || '') } }
        ]
      }]
    };
  }).filter((event) => event.id && event.competitions[0].competitors.every((item) => item.team.displayName));

  if (!events.length) return null;
  return {
    source: 'sports_monitor_snapshot',
    fetchedAt,
    data: { events }
  };
}

async function vapidKeys(env) {
  const response = await singletonState(env).fetch('https://internal/vapid');
  if (!response.ok) throw new Error('vapid_unavailable');
  return response.json();
}

function normalizePreferences(input) {
  const src = input || {};
  const cleanList = (value, maxItems) => Array.isArray(value)
    ? [...new Set(value.map((item) => cleanId(item, 96)).filter(Boolean))].slice(0, maxItems)
    : [];
  return {
    prematch15: src.prematch15 !== false,
    goals: src.goals !== false,
    redCards: src.redCards !== false,
    lineups: src.lineups !== false,
    matchStart: src.matchStart !== false,
    finalWhistle: src.finalWhistle !== false,
    allGames: src.allGames === true,
    teams: cleanList(src.teams, 10),
    games: cleanList(src.games, 30)
  };
}

async function savePreferences(env, installationId, preferences) {
  const p = normalizePreferences(preferences);
  await env.DB.prepare(`
    INSERT INTO push_preferences_v3
      (installation_id, goals, red_cards, lineups, match_start, final_whistle, all_games, teams_json, games_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(installation_id) DO UPDATE SET
      goals=excluded.goals,
      red_cards=excluded.red_cards,
      lineups=excluded.lineups,
      match_start=excluded.match_start,
      final_whistle=excluded.final_whistle,
      all_games=excluded.all_games,
      teams_json=excluded.teams_json,
      games_json=excluded.games_json,
      updated_at=CURRENT_TIMESTAMP
  `).bind(
    installationId,
    p.goals ? 1 : 0,
    p.redCards ? 1 : 0,
    p.lineups ? 1 : 0,
    p.matchStart ? 1 : 0,
    p.finalWhistle ? 1 : 0,
    p.allGames ? 1 : 0,
    JSON.stringify(p.teams),
    JSON.stringify(p.games)
  ).run();

  // Clientes antigos em cache não conhecem prematch15. Nesse caso, preservar
  // a escolha já existente; para instalação sem linha, o default é ON.
  if (Object.prototype.hasOwnProperty.call(preferences || {}, 'prematch15')) {
    await env.DB.prepare(`
      INSERT INTO push_reminder_preferences (installation_id, prematch_15, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(installation_id) DO UPDATE SET
        prematch_15=excluded.prematch_15, updated_at=CURRENT_TIMESTAMP
    `).bind(installationId, p.prematch15 ? 1 : 0).run();
  }
  return p;
}

async function getPreferences(env, installationId) {
  const row = await env.DB.prepare(`
    SELECT p.goals, p.red_cards, p.lineups, p.match_start, p.final_whistle, p.all_games, p.teams_json, p.games_json,
           COALESCE(r.prematch_15, 1) AS prematch_15
    FROM push_preferences_v3 p
    LEFT JOIN push_reminder_preferences r ON r.installation_id=p.installation_id
    WHERE p.installation_id=?
  `).bind(installationId).first();
  if (!row) return normalizePreferences({});
  const parse = (raw) => { try { return JSON.parse(raw || '[]'); } catch (_) { return []; } };
  return normalizePreferences({
    prematch15: Boolean(row.prematch_15),
    goals: Boolean(row.goals),
    redCards: Boolean(row.red_cards),
    lineups: Boolean(row.lineups),
    matchStart: Boolean(row.match_start),
    finalWhistle: Boolean(row.final_whistle),
    allGames: Boolean(row.all_games),
    teams: parse(row.teams_json),
    games: parse(row.games_json)
  });
}

async function handleConfig(request, env) {
  const keys = await vapidKeys(env);
  return json(request, {
    ok: true,
    apiVersion: 2,
    vapidPublicKey: keys.publicKey,
    pushEnabled: true
  }, 200, { 'Cache-Control': 'public, max-age=300' });
}

async function handleSubscribe(request, env) {
  const body = await readBody(request);
  const installationId = cleanId(body.installationId);
  const sub = body.subscription || {};
  const endpoint = String(sub.endpoint || '').trim();
  const p256dh = String(sub.keys?.p256dh || '').trim();
  const auth = String(sub.keys?.auth || '').trim();
  if (!installationId || !endpointIsValid(endpoint) || !p256dh || !auth) {
    return json(request, { ok: false, error: 'invalid_subscription' }, 400);
  }
  if (!(await rateLimit(request, env, installationId, 'subscribe'))) {
    return json(request, { ok: false, error: 'rate_limited' }, 429);
  }

  const subscriptionId = await sha256Base64Url(endpoint);
  await env.DB.prepare(`
    INSERT INTO push_subscriptions
      (subscription_id, installation_id, endpoint, p256dh, auth, expiration_time, user_agent, active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(endpoint) DO UPDATE SET
      subscription_id=excluded.subscription_id,
      installation_id=excluded.installation_id,
      p256dh=excluded.p256dh,
      auth=excluded.auth,
      expiration_time=excluded.expiration_time,
      user_agent=excluded.user_agent,
      active=1,
      updated_at=CURRENT_TIMESTAMP
  `).bind(
    subscriptionId,
    installationId,
    endpoint,
    p256dh,
    auth,
    Number.isFinite(Number(sub.expirationTime)) ? Number(sub.expirationTime) : null,
    String(request.headers.get('User-Agent') || '').slice(0, 512)
  ).run();
  const preferences = Object.prototype.hasOwnProperty.call(body, 'preferences')
    ? await savePreferences(env, installationId, body.preferences || {})
    : await getPreferences(env, installationId);
  await env.DB.prepare(`INSERT INTO push_audit (installation_id, subscription_id, event_type, status) VALUES (?, ?, 'subscribe', 201)`)
    .bind(installationId, subscriptionId).run();

  return json(request, { ok: true, subscriptionId, preferences }, 201);
}

async function handleUnsubscribe(request, env) {
  const body = await readBody(request);
  const installationId = cleanId(body.installationId);
  const endpoint = String(body.endpoint || '').trim();
  if (!installationId) return json(request, { ok: false, error: 'invalid_request' }, 400);
  if (endpoint && !endpointIsValid(endpoint)) return json(request, { ok: false, error: 'invalid_request' }, 400);
  if (!(await rateLimit(request, env, installationId, 'unsubscribe'))) return json(request, { ok: false, error: 'rate_limited' }, 429);

  // Sem endpoint = reconciliação: o navegador desta instalação perdeu a
  // PushSubscription, então qualquer endpoint guardado aqui está morto.
  // O escopo é sempre a própria installation_id: nenhuma outra é afetada.
  const result = endpoint
    ? await env.DB.prepare(`UPDATE push_subscriptions SET active=0, updated_at=CURRENT_TIMESTAMP WHERE installation_id=? AND endpoint=?`)
      .bind(installationId, endpoint).run()
    : await env.DB.prepare(`UPDATE push_subscriptions SET active=0, updated_at=CURRENT_TIMESTAMP WHERE installation_id=? AND active=1`)
      .bind(installationId).run();

  await env.DB.prepare(`INSERT INTO push_audit (installation_id, event_type, status) VALUES (?, ?, 200)`)
    .bind(installationId, endpoint ? 'unsubscribe' : 'reconcile').run();
  return json(request, { ok: true, deactivated: Number(result?.meta?.changes || 0) });
}

async function handleGetPreferences(request, env) {
  const installationId = cleanId(new URL(request.url).searchParams.get('installationId'));
  if (!installationId) return json(request, { ok: false, error: 'invalid_installation' }, 400);
  return json(request, { ok: true, preferences: await getPreferences(env, installationId) });
}

async function handlePutPreferences(request, env) {
  const body = await readBody(request);
  const installationId = cleanId(body.installationId);
  if (!installationId) return json(request, { ok: false, error: 'invalid_installation' }, 400);
  if (!(await rateLimit(request, env, installationId, 'preferences'))) return json(request, { ok: false, error: 'rate_limited' }, 429);
  const preferences = await savePreferences(env, installationId, body.preferences || {});
  return json(request, { ok: true, preferences });
}

async function sendToSubscription(env, row, payload) {
  const keys = await vapidKeys(env);
  const subscription = {
    endpoint: row.endpoint,
    expirationTime: row.expiration_time ?? null,
    keys: { p256dh: row.p256dh, auth: row.auth }
  };
  const requestInit = await buildPushPayload(
    { data: payload, options: { ttl: 120, urgency: 'high', topic: 'fdg-test' } },
    subscription,
    { subject: keys.subject, publicKey: keys.publicKey, privateKey: keys.privateKey }
  );
  return fetch(subscription.endpoint, requestInit);
}

function chapecoensePreferenceMatch(preferences) {
  const p = preferences || {};
  if (p.allGames === true) return 'all_games';
  const teams = Array.isArray(p.teams) ? p.teams.map((value) => String(value || '').trim().toLowerCase()) : [];
  if (teams.some((value) => ['abbr:cha', 'team:chapecoense', 'chapecoense'].includes(value))) return 'chapecoense';
  return '';
}

function brClockLabel(timestamp) {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(new Date(timestamp));
  } catch (_) {
    return new Date(timestamp).toISOString();
  }
}

async function handleSegmentedTeamTest(request, env) {
  const body = await readBody(request);
  const installationId = cleanId(body.installationId);
  if (!installationId) return json(request, { ok: false, error: 'invalid_installation' }, 400);
  if (!(await rateLimit(request, env, installationId, 'segmented-team-test'))) {
    return json(request, { ok: false, error: 'rate_limited' }, 429);
  }

  const active = await env.DB.prepare(`
    SELECT subscription_id FROM push_subscriptions
    WHERE installation_id=? AND active=1
    ORDER BY updated_at DESC LIMIT 1
  `).bind(installationId).first();
  if (!active) return json(request, { ok: false, error: 'subscription_not_found' }, 404);

  const preferences = await getPreferences(env, installationId);
  const eligibleBy = chapecoensePreferenceMatch(preferences);
  if (!eligibleBy || preferences.matchStart === false) {
    return json(request, {
      ok: false, error: 'not_eligible_for_chapecoense_test',
      detail: 'Ative Todos os jogos ou Chapecoense e mantenha Início da partida habilitado.',
      preferences
    }, 409);
  }

  // Janela curta de propósito: mantém o teste abaixo do recovery threshold de
  // dispatch e permite repetir a prova em qualquer horário sem esperar jogo real.
  const delaySeconds = Math.max(30, Math.min(180, Math.floor(Number(body.delaySeconds) || 120)));
  const scheduledAtMs = Date.now() + delaySeconds * 1000;
  const scheduledAt = new Date(scheduledAtMs).toISOString();
  const eventKey = `match_start:fdg-segmented-test:${installationId}:${scheduledAtMs}`;
  const eventId = `fdg-segmented-test-${scheduledAtMs}`;
  const payload = {
    eventKey, eventId, type: 'match_start', confirmedAt: scheduledAt,
    league: 'fdg.test', competitionKey: 'fdg_test', competitionName: 'Teste técnico Fórmula do Gol',
    home: { id: '', name: 'Chapecoense', abbreviation: 'CHA', score: null },
    away: { id: '', name: 'Teste Fórmula do Gol', abbreviation: 'FDG', score: null },
    testInstallationId: installationId,
    notificationDraft: {
      title: '🧪 TESTE CHAPECOENSE',
      body: `Evento técnico previsto para ${brClockLabel(scheduledAtMs)} · filtro Chapecoense/Todos os jogos`
    }
  };

  await env.DB.prepare(`
    INSERT OR IGNORE INTO essential_match_events (event_key,event_id,event_type,confirmed_at,payload_json)
    VALUES (?,?,?,?,?)
  `).bind(eventKey, eventId, 'match_start', scheduledAt, JSON.stringify(payload)).run();
  await enqueueSportsEvent(env, eventKey, { delaySeconds });

  return json(request, {
    ok: true, queued: true, segmentedTestVersion: '6-T1', team: 'Chapecoense',
    eligibleBy, delaySeconds, scheduledAt, scheduledAtBrasilia: brClockLabel(scheduledAtMs),
    note: 'A página pode ser fechada. A entrega passa pela mesma Queue e pelo mesmo filtro de preferências dos alertas esportivos.'
  }, 202);
}

async function handleHotEspnTest(request, env) {
  const body = await readBody(request);
  const installationId = cleanId(body.installationId);
  if (!installationId) return json(request, { ok: false, error: 'invalid_installation' }, 400);
  if (!(await rateLimit(request, env, installationId, 'hot-espn-test'))) {
    return json(request, { ok: false, error: 'rate_limited' }, 429);
  }

  const active = await env.DB.prepare(`
    SELECT subscription_id FROM push_subscriptions
    WHERE installation_id=? AND active=1
    ORDER BY updated_at DESC LIMIT 1
  `).bind(installationId).first();
  if (!active) return json(request, { ok: false, error: 'subscription_not_found' }, 404);

  const preferences = await getPreferences(env, installationId);
  if (preferences.goals === false || preferences.allGames !== true) {
    return json(request, {
      ok: false, error: 'not_eligible_for_hot_espn_test',
      detail: 'Neste aparelho, mantenha Gols e Todos os jogos habilitados para reproduzir a seleção real do fan-out.',
      preferences
    }, 409);
  }

  const response = await singletonMonitor(env).fetch('https://internal/hot-test/arm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ installationId })
  });
  const result = await response.json();
  return json(request, {
    ...result,
    hotEspnTestVersion: '6-H1',
    note: 'Sem timer de disparo: a notificação só é criada quando o play-by-play da ESPN acrescentar uma nova jogada após o baseline.'
  }, response.status, { 'Cache-Control': 'no-store' });
}


async function handleHotMatchTest(request, env) {
  const body = await readBody(request);
  const installationId = cleanId(body.installationId);
  if (!installationId) return json(request, { ok: false, error: 'invalid_installation' }, 400);
  if (!(await rateLimit(request, env, installationId, 'hot-match-test'))) {
    return json(request, { ok: false, error: 'rate_limited' }, 429);
  }

  const active = await env.DB.prepare(`
    SELECT subscription_id FROM push_subscriptions
    WHERE installation_id=? AND active=1
    ORDER BY updated_at DESC LIMIT 1
  `).bind(installationId).first();
  if (!active) return json(request, { ok: false, error: 'subscription_not_found' }, 404);

  const preferences = await getPreferences(env, installationId);
  if (preferences.allGames !== true || preferences.goals === false) {
    return json(request, {
      ok: false,
      error: 'not_eligible_for_hot_match_test',
      detail: 'Neste aparelho, mantenha Todos os jogos e Gols habilitados para reproduzir o fluxo real.',
      preferences
    }, 409);
  }

  const response = await singletonMonitor(env).fetch('https://internal/hot-match-test/arm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ installationId })
  });
  const result = await response.json();
  return json(request, {
    ...result,
    hotMatchTestVersion: '6-H3',
    note: 'VfL Osnabrück × Bayern de Munique é apenas um observador técnico: não entra na agenda, Ao Vivo, jogos futuros ou qualquer página pública. O horário e os gols são lidos da ESPN.'
  }, response.status, { 'Cache-Control': 'no-store' });
}

async function handleQueueTest(request, env) {
  const body = await readBody(request);
  const installationId = cleanId(body.installationId);
  if (!installationId) return json(request, { ok: false, error: 'invalid_installation' }, 400);
  if (!(await rateLimit(request, env, installationId, 'queue-test'))) return json(request, { ok: false, error: 'rate_limited' }, 429);
  const row = await env.DB.prepare(`
    SELECT subscription_id FROM push_subscriptions
    WHERE installation_id=? AND active=1
    ORDER BY updated_at DESC LIMIT 1
  `).bind(installationId).first();
  if (!row) return json(request, { ok: false, error: 'subscription_not_found' }, 404);
  if (!env.PUSH_QUEUE) return json(request, { ok: false, error: 'queue_unavailable' }, 503);
  await env.PUSH_QUEUE.send({ kind: 'direct_test', installationId });
  return json(request, { ok: true, queued: true }, 202);
}

async function handleTest(request, env) {
  const body = await readBody(request);
  const installationId = cleanId(body.installationId);
  if (!installationId) return json(request, { ok: false, error: 'invalid_installation' }, 400);
  if (!(await rateLimit(request, env, installationId, 'test'))) return json(request, { ok: false, error: 'rate_limited' }, 429);

  const row = await env.DB.prepare(`
    SELECT subscription_id, endpoint, p256dh, auth, expiration_time
    FROM push_subscriptions
    WHERE installation_id=? AND active=1
    ORDER BY updated_at DESC LIMIT 1
  `).bind(installationId).first();
  if (!row) return json(request, { ok: false, error: 'subscription_not_found' }, 404);

  const payload = {
    title: 'Fórmula do Gol — Web Push',
    body: 'Teste real enviado pelo backend Cloudflare. O site pode estar fechado.',
    tag: `fdg-real-test-${Date.now()}`,
    renotify: true,
    badgeCount: 1,
    data: { url: '/pwa-teste.html' }
  };

  let response;
  try {
    response = await sendToSubscription(env, row, payload);
  } catch (error) {
    await env.DB.prepare(`UPDATE push_subscriptions SET last_failure_at=CURRENT_TIMESTAMP WHERE subscription_id=?`).bind(row.subscription_id).run();
    return json(request, { ok: false, error: 'push_transport_error', detail: String(error?.message || error) }, 502);
  }

  if (response.status === 404 || response.status === 410) {
    await env.DB.prepare(`UPDATE push_subscriptions SET active=0, last_failure_at=CURRENT_TIMESTAMP, last_failure_status=? WHERE subscription_id=?`)
      .bind(response.status, row.subscription_id).run();
  } else if (response.ok) {
    await env.DB.prepare(`UPDATE push_subscriptions SET last_success_at=CURRENT_TIMESTAMP, last_failure_status=NULL WHERE subscription_id=?`)
      .bind(row.subscription_id).run();
  } else {
    await env.DB.prepare(`UPDATE push_subscriptions SET last_failure_at=CURRENT_TIMESTAMP, last_failure_status=? WHERE subscription_id=?`)
      .bind(response.status, row.subscription_id).run();
  }
  await env.DB.prepare(`INSERT INTO push_audit (installation_id, subscription_id, event_type, status) VALUES (?, ?, 'test_push', ?)`)
    .bind(installationId, row.subscription_id, response.status).run();

  return json(request, { ok: response.ok, pushStatus: response.status }, response.ok ? 200 : 502);
}

export default {
  async scheduled(controller, env, ctx) {
    const monitor = singletonMonitor(env);
    // Isolamento operacional: uma falha de manutenção geral nunca pode impedir
    // a coleta pós-jogo (público/renda e melhores momentos) no mesmo minuto.
    ctx.waitUntil(runOperationalMaintenance(env, monitor).catch((error) => {
      console.error(`operational maintenance failed: ${String(error?.message || error).slice(0, 500)}`);
    }));
    ctx.waitUntil(runPostgameMaintenance(env, monitor).catch((error) => {
      console.error(`postgame fastlane failed: ${String(error?.message || error).slice(0, 500)}`);
    }));
    ctx.waitUntil(runFeedbackNotifier(env).catch((error) => {
      console.error(`feedback notifier failed: ${String(error?.message || error).slice(0, 500)}`);
    }));
    ctx.waitUntil((async()=>{
      let status=null; try { const r=await monitor.fetch('https://internal/status'); if(r.ok) status=await r.json(); } catch(_) {}
      return runHealthMonitor(env,status);
    })().catch((error)=>{ console.error(`health monitor failed: ${String(error?.message||error).slice(0,500)}`); }));
  },

  async queue(batch, env) {
    await handleQueueBatch(batch, env);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin') || '';
      if (!ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      const db = await env.DB.prepare('SELECT 1 AS ok').first();
      const [stateResponse, monitorResponse] = await Promise.all([
        singletonState(env).fetch('https://internal/health'),
        singletonMonitor(env).fetch('https://internal/status')
      ]);
      const state = await stateResponse.json();
      const monitor = await monitorResponse.json();
      const operational = await opsStatus(env, monitor);
      return json(request, {
        ok: Boolean(db?.ok) && Boolean(state?.vapidReady) && Boolean(monitor?.ok) && Boolean(operational?.ok),
        service: 'formula-do-gol-push',
        version: 9,
        revision: '6-R10R9-AI-GATEWAY-GEMINI-WAI-R2',
        liveGatewayVersion: LIVE_API_CONSTANTS.LIVE_GATEWAY_VERSION,
        liveStateContractVersion: LIVE_API_CONSTANTS.LIVE_STATE_CONTRACT_VERSION,
        liveFactsContractVersion: LIVE_API_CONSTANTS.LIVE_FACTS_CONTRACT_VERSION,
        canonicalLiveFacts: true,
        sportsMonitorFactsAuthority: true,
        sportsMonitorFactsVersion: 1,
        liveStatePrimary: 'worker-espn',
        liveStateDirectFallback: true,
        liveStatsFallbackVersion: 5,
        theSportsDbStatsReady: true,
        apiFootballStatsReady: Boolean(env.API_FOOTBALL_KEY),
        statsFallbackProviders: ['espn-multisurface-brasileirao', 'api-football-continental-budgeted', 'thesportsdb-continental-contingency'],
        apiFootballContinentalOnly: true,
        apiFootballDailyBudgetPolicy: LIVE_API_CONSTANTS.API_FOOTBALL_DAILY_PLAN_BUDGET,
        apiFootballBudgetReserve: LIVE_API_CONSTANTS.API_FOOTBALL_BUDGET_RESERVE,
        continentalStatsTargetMinPerTeam: LIVE_API_CONSTANTS.CONTINENTAL_STATS_TARGET,
        bestKnownStatsCache: true,
        postgameFastlane: true,
        postgameFastlaneVersion: 5,
          aiGateway: String(env.AI_GATEWAY_ID || 'default'),
          geminiSearch: Boolean(env.GEMINI_API_KEY),
          workersAiExtraction: Boolean(env.AI),
          postgameAiRouting: 'ESPN/direct-source -> Workers AI extraction -> Gemini Google Search -> OpenAI Sol fallback',
        feedbackNotifier: true,
        feedbackNotifierConfigured: feedbackNotifierConfigured(env),
        healthEmailMonitor: true,
        healthEmailDailyBrt: '08:00',
        healthEmailNoOpenAI: true,
        sportsMonitorReady: Boolean(monitor?.ok),
        operationalState: operational?.state || 'unknown',
        sports: {
          watchCount: Number(monitor?.watchCount || 0),
          activeGames: Number(monitor?.activeGames || 0),
          pendingGoals: Number(monitor?.pendingGoals || 0),
          readinessRed: Number(monitor?.readinessRed || 0),
          lastPollAt: Number(monitor?.lastPollAt || 0)
        }
      }, operational?.ok ? 200 : 503, { 'Cache-Control': 'no-store' });
    }

    const origin = request.headers.get('Origin') || '';
    if (origin && !ALLOWED_ORIGINS.has(origin)) return json(request, { ok: false, error: 'origin_not_allowed' }, 403);

    try {
      if ((url.pathname === '/v1/live/scoreboard' || url.pathname === '/v1/live/state') && request.method === 'GET') {
        if (!(await allowStatusRead(request, env, 'live-scoreboard'))) return json(request, { ok: false, error: 'rate_limited' }, 429);
        const result = await resolveLiveScoreboard(url, {
          fallbackScoreboard: ({ league, now }) => monitorLiveScoreboardFallback(env, league, now)
        });
        return json(request, result.body, result.status, { 'Cache-Control': 'no-store', 'X-FDG-Live-Gateway': LIVE_API_CONSTANTS.LIVE_GATEWAY_VERSION });
      }
      if (url.pathname === '/v1/postgame' && request.method === 'GET') {
        if (!(await allowStatusRead(request, env, 'postgame-fastlane'))) return json(request, { ok: false, error: 'rate_limited' }, 429);
        const ids = String(url.searchParams.get('event_ids') || '').split(',').map((v) => cleanId(v)).filter(Boolean);
        return json(request, { ok: true, version: 2, rows: await readPostgameFastlane(env, ids) }, 200, { 'Cache-Control': 'no-store' });
      }
      if (url.pathname === '/v1/health-monitor/status' && request.method === 'GET') {
        if (!(await allowStatusRead(request, env, 'health-monitor-status'))) return json(request, { ok:false, error:'rate_limited' }, 429);
        return json(request, await healthMonitorStatus(env), 200, { 'Cache-Control':'no-store' });
      }
      if (url.pathname === '/v1/postgame/status' && request.method === 'GET') {
        if (!(await allowStatusRead(request, env, 'postgame-status'))) return json(request, { ok: false, error: 'rate_limited' }, 429);
        return json(request, await postgameStatus(env), 200, { 'Cache-Control': 'no-store' });
      }
      if (url.pathname === '/v1/live/summary' && request.method === 'GET') {
        if (!(await allowStatusRead(request, env, 'live-summary'))) return json(request, { ok: false, error: 'rate_limited' }, 429);
        const eventId = cleanId(url.searchParams.get('event'));
        const monitorPromise = eventId
          ? singletonMonitor(env).fetch(`https://internal/live-facts?event=${encodeURIComponent(eventId)}`).catch(() => null)
          : Promise.resolve(null);
        const resultPromise = resolveLiveSummary(url, {
          apiFootballKey: env.API_FOOTBALL_KEY,
          statsStore: createLiveStatsStore(env.DB)
        });
        const [result, monitorResponse] = await Promise.all([resultPromise, monitorPromise]);
        let monitorFacts = null;
        if (monitorResponse && monitorResponse.ok) {
          try {
            const payload = await monitorResponse.json();
            monitorFacts = payload?.facts || null;
          } catch (_) { monitorFacts = null; }
        }
        const expectedHomeRaw = url.searchParams.get('expectedHome');
        const expectedAwayRaw = url.searchParams.get('expectedAway');
        const expectedHome = expectedHomeRaw != null && expectedHomeRaw !== '' && Number.isFinite(Number(expectedHomeRaw)) ? Number(expectedHomeRaw) : null;
        const expectedAway = expectedAwayRaw != null && expectedAwayRaw !== '' && Number.isFinite(Number(expectedAwayRaw)) ? Number(expectedAwayRaw) : null;
        const monitorMatchesRequest = monitorFacts && (expectedHome == null || expectedAway == null || (
          Number(monitorFacts?.integrity?.expectedHome) === expectedHome && Number(monitorFacts?.integrity?.expectedAway) === expectedAway
        ));
        if (monitorMatchesRequest) {
          const mergedFacts = enrichSportsMonitorLiveFacts(monitorFacts, result?.body?.facts || null);
          if (result.status === 200 && result.body && typeof result.body === 'object') {
            result.body = {
              ...result.body,
              factsContractVersion: LIVE_API_CONSTANTS.LIVE_FACTS_CONTRACT_VERSION,
              facts: mergedFacts,
              factsIntegrity: mergedFacts?.integrity || null,
              factsAuthority: 'sports-monitor-state',
              factsMonitorVersion: Number(mergedFacts?.monitorFactsVersion || 1),
              factsBestKnownApplied: false,
              goalCount: Number(mergedFacts?.integrity?.observedGoalCount || 0),
              complete: mergedFacts?.integrity?.scoreComplete === true
            };
          } else {
            const fetchedAt = Number(mergedFacts?.lastObservedAt || mergedFacts?.meta?.lastObservedAt || Date.now());
            result.status = 200;
            result.body = {
              ok: true,
              gatewayVersion: LIVE_API_CONSTANTS.LIVE_GATEWAY_VERSION,
              source: 'sports_monitor_state',
              sources: ['sports_monitor_state'],
              fetchedAt,
              stale: false,
              cacheStatus: 'monitor-only',
              factsContractVersion: LIVE_API_CONSTANTS.LIVE_FACTS_CONTRACT_VERSION,
              facts: mergedFacts,
              factsIntegrity: mergedFacts?.integrity || null,
              factsAuthority: 'sports-monitor-state',
              factsMonitorVersion: Number(mergedFacts?.monitorFactsVersion || 1),
              expectedHome: Number(mergedFacts?.integrity?.expectedHome || 0),
              expectedAway: Number(mergedFacts?.integrity?.expectedAway || 0),
              expectedGoals: Number(mergedFacts?.integrity?.expectedGoals || 0),
              goalCount: Number(mergedFacts?.integrity?.observedGoalCount || 0),
              complete: mergedFacts?.integrity?.scoreComplete === true,
              statsProvider: 'sports-monitor-state',
              statsCoverage: null,
              statsQuality: 'CRITICAL',
              statsBestKnownApplied: false,
              requestedState: String(url.searchParams.get('state') || ''),
              observedState: String(mergedFacts?.state || ''),
              espnOnly: String(url.searchParams.get('league') || '') === 'bra.1',
              data: {}
            };
          }
        }
        return json(request, result.body, result.status, { 'Cache-Control': 'no-store', 'X-FDG-Live-Gateway': LIVE_API_CONSTANTS.LIVE_GATEWAY_VERSION });
      }
      if (url.pathname === '/v1/config' && request.method === 'GET') return handleConfig(request, env);
      if (url.pathname === '/v1/subscribe' && request.method === 'POST') return handleSubscribe(request, env);
      if (url.pathname === '/v1/unsubscribe' && request.method === 'POST') return handleUnsubscribe(request, env);
      if (url.pathname === '/v1/preferences' && request.method === 'GET') return handleGetPreferences(request, env);
      if (url.pathname === '/v1/preferences' && request.method === 'PUT') return handlePutPreferences(request, env);
      if (url.pathname === '/v1/test' && request.method === 'POST') return handleTest(request, env);
      if (url.pathname === '/v1/segmented-team-test' && request.method === 'POST') return handleSegmentedTeamTest(request, env);
      if (url.pathname === '/v1/hot-espn-test' && request.method === 'POST') return handleHotEspnTest(request, env);
      if (url.pathname === '/v1/hot-match-test' && request.method === 'POST') return handleHotMatchTest(request, env);
      if (url.pathname === '/v1/queue-test' && request.method === 'POST') return handleQueueTest(request, env);
      if (url.pathname === '/v1/dispatch/status' && request.method === 'GET') {
        if (!(await allowStatusRead(request, env, 'dispatch-status'))) return json(request, { ok: false, error: 'rate_limited' }, 429);
        return json(request, await dispatchStatus(env), 200, { 'Cache-Control': 'no-store' });
      }
      if (url.pathname === '/v1/monitor/status' && request.method === 'GET') {
        if (!(await allowStatusRead(request, env, 'monitor-status'))) return json(request, { ok: false, error: 'rate_limited' }, 429);
        const response = await singletonMonitor(env).fetch('https://internal/status');
        return json(request, await response.json(), response.status, { 'Cache-Control': 'no-store' });
      }
      if (url.pathname === '/v1/monitor/source-probe' && request.method === 'GET') {
        if (!(await allowStatusRead(request, env, 'source-probe'))) return json(request, { ok: false, error: 'rate_limited' }, 429);
        const probe = await probeEspnSources();
        return json(request, probe, probe.ok ? 200 : 503, { 'Cache-Control': 'no-store' });
      }
      if (url.pathname === '/v1/monitor/events' && request.method === 'GET') {
        if (!(await allowStatusRead(request, env, 'monitor-events'))) return json(request, { ok: false, error: 'rate_limited' }, 429);
        const response = await singletonMonitor(env).fetch('https://internal/recent');
        return json(request, await response.json(), response.status, { 'Cache-Control': 'no-store' });
      }
      if (url.pathname === '/v1/ops/status' && request.method === 'GET') {
        if (!(await allowStatusRead(request, env, 'ops-status'))) return json(request, { ok: false, error: 'rate_limited' }, 429);
        const response = await singletonMonitor(env).fetch('https://internal/status');
        const monitor = await response.json();
        return json(request, await opsStatus(env, monitor), 200, { 'Cache-Control': 'no-store' });
      }
      return json(request, { ok: false, error: 'not_found' }, 404);
    } catch (error) {
      const code = error?.message === 'payload_too_large' ? 413 : 500;
      console.error('push-worker-error', error);
      return json(request, { ok: false, error: code === 413 ? 'payload_too_large' : 'internal_error' }, code);
    }
  }
};
