import {
  ESPN_SOURCE_CONSTANTS,
  fetchEspnScoreboardGateway,
  fetchEspnSummaryGateway,
  summaryGoalCount
} from './espn-source.js';

const LIVE_GATEWAY_VERSION = '1';
const SCOREBOARD_HOT_TTL_SECONDS = 8;
const SCOREBOARD_FALLBACK_TTL_SECONDS = 600;
const SUMMARY_HOT_TTL_SECONDS = 8;
const SUMMARY_FALLBACK_TTL_SECONDS = 900;
const INTERNAL_CACHE_ORIGIN = 'https://push.formuladogol.com.br/__fdg_live_cache';
const ALLOWED_LEAGUES = new Set(ESPN_SOURCE_CONSTANTS.ALLOWED_LEAGUES);

function text(value) { return String(value == null ? '' : value).trim(); }

function parseCompactDate(value) {
  const raw = text(value);
  if (!/^\d{8}$/.test(raw)) return NaN;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const ts = Date.UTC(year, month - 1, day);
  const date = new Date(ts);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return NaN;
  return ts;
}

function validDates(value) {
  const raw = text(value);
  const parts = raw.split('-');
  if (parts.length < 1 || parts.length > 2) return false;
  const start = parseCompactDate(parts[0]);
  const end = parseCompactDate(parts[1] || parts[0]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return false;
  return end - start <= 7 * 24 * 60 * 60_000;
}

function validEventId(value) {
  return /^[A-Za-z0-9._:-]{1,96}$/.test(text(value));
}

function cacheKey(kind, parts, tier) {
  const path = parts.map((part) => encodeURIComponent(text(part))).join('/');
  return new Request(`${INTERNAL_CACHE_ORIGIN}/${kind}/${tier}/${path}`, { method: 'GET' });
}

function cacheFromDeps(deps) {
  if (deps && deps.cache) return deps.cache;
  return globalThis.caches && globalThis.caches.default ? globalThis.caches.default : null;
}

async function readCached(cache, key) {
  if (!cache || typeof cache.match !== 'function') return null;
  try {
    const response = await cache.match(key);
    if (!response || !response.ok) return null;
    return await response.json();
  } catch (_) {
    return null;
  }
}

async function writeCached(cache, key, value, ttlSeconds) {
  if (!cache || typeof cache.put !== 'function') return;
  try {
    const response = new Response(JSON.stringify(value), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': `public, max-age=${Math.max(1, Number(ttlSeconds) || 1)}`
      }
    });
    await cache.put(key, response);
  } catch (_) {
    // Cache é uma camada de resiliência; falha nele nunca bloqueia o dado fresco.
  }
}

function publicEnvelope(result, fetchedAt, extra = {}) {
  return {
    ok: true,
    gatewayVersion: LIVE_GATEWAY_VERSION,
    source: result?.source || '',
    sources: Array.isArray(result?.sources) ? result.sources : (result?.source ? [result.source] : []),
    fetchedAt,
    stale: false,
    ...extra,
    data: result?.data || {}
  };
}

function staleEnvelope(cached, now, error) {
  const fetchedAt = Number(cached?.fetchedAt || 0);
  return {
    ...cached,
    ok: true,
    gatewayVersion: LIVE_GATEWAY_VERSION,
    stale: true,
    ageMs: fetchedAt > 0 ? Math.max(0, now - fetchedAt) : null,
    upstreamError: text(error?.message || error).slice(0, 500)
  };
}

export async function resolveLiveScoreboard(url, deps = {}) {
  const league = text(url.searchParams.get('league'));
  const dates = text(url.searchParams.get('dates'));
  if (!ALLOWED_LEAGUES.has(league)) return { status: 400, body: { ok: false, error: 'invalid_league' } };
  if (!validDates(dates)) return { status: 400, body: { ok: false, error: 'invalid_dates' } };

  const nowFn = deps.now || Date.now;
  const now = Number(nowFn());
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const cache = cacheFromDeps(deps);
  const hotKey = cacheKey('scoreboard', [league, dates], 'hot');
  const fallbackKey = cacheKey('scoreboard', [league, dates], 'fallback');

  const hot = await readCached(cache, hotKey);
  if (hot && Array.isArray(hot?.data?.events)) {
    return {
      status: 200,
      body: { ...hot, cacheStatus: 'hot', ageMs: Math.max(0, now - Number(hot.fetchedAt || now)) }
    };
  }

  try {
    const result = await fetchEspnScoreboardGateway(league, dates, fetchImpl);
    const envelope = publicEnvelope(result, now, {
      cacheStatus: 'miss',
      selectedSources: result.selectedSources || {},
      attempts: result.attempts || []
    });
    await Promise.all([
      writeCached(cache, hotKey, envelope, SCOREBOARD_HOT_TTL_SECONDS),
      writeCached(cache, fallbackKey, envelope, SCOREBOARD_FALLBACK_TTL_SECONDS)
    ]);
    return { status: 200, body: envelope };
  } catch (error) {
    const cached = await readCached(cache, fallbackKey);
    if (cached && Array.isArray(cached?.data?.events)) {
      return { status: 200, body: { ...staleEnvelope(cached, now, error), cacheStatus: 'stale-fallback' } };
    }

    if (typeof deps.fallbackScoreboard === 'function') {
      try {
        const fallback = await deps.fallbackScoreboard({ league, dates, now });
        if (fallback && Array.isArray(fallback?.data?.events) && fallback.data.events.length) {
          const envelope = {
            ok: true,
            gatewayVersion: LIVE_GATEWAY_VERSION,
            source: text(fallback.source || 'monitor_snapshot'),
            sources: [text(fallback.source || 'monitor_snapshot')],
            fetchedAt: Number(fallback.fetchedAt || now),
            stale: true,
            cacheStatus: 'monitor-fallback',
            ageMs: Math.max(0, now - Number(fallback.fetchedAt || now)),
            upstreamError: text(error?.message || error).slice(0, 500),
            data: fallback.data
          };
          await writeCached(cache, fallbackKey, envelope, SCOREBOARD_FALLBACK_TTL_SECONDS);
          return { status: 200, body: envelope };
        }
      } catch (_) {
        // A contingência central do monitor é opcional; se ela falhar, mantém 503.
      }
    }

    return {
      status: 503,
      body: {
        ok: false,
        gatewayVersion: LIVE_GATEWAY_VERSION,
        error: 'espn_scoreboard_unavailable',
        detail: text(error?.message || error).slice(0, 700)
      }
    };
  }
}

export async function resolveLiveSummary(url, deps = {}) {
  const league = text(url.searchParams.get('league'));
  const eventId = text(url.searchParams.get('event'));
  const expectedGoals = Math.max(0, Math.min(30, Number(url.searchParams.get('expectedGoals') || 0) || 0));
  const forceFresh = url.searchParams.get('fresh') === '1';
  if (!ALLOWED_LEAGUES.has(league)) return { status: 400, body: { ok: false, error: 'invalid_league' } };
  if (!validEventId(eventId)) return { status: 400, body: { ok: false, error: 'invalid_event' } };

  const nowFn = deps.now || Date.now;
  const now = Number(nowFn());
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const cache = cacheFromDeps(deps);
  const hotKey = cacheKey('summary', [league, eventId], 'hot');
  const fallbackKey = cacheKey('summary', [league, eventId], 'fallback');

  const acceptable = (entry) => {
    if (!entry || !entry.data || typeof entry.data !== 'object') return false;
    if (expectedGoals <= 0) return true;
    return summaryGoalCount(entry.data) >= expectedGoals;
  };

  const hot = forceFresh ? null : await readCached(cache, hotKey);
  if (acceptable(hot)) {
    return {
      status: 200,
      body: { ...hot, cacheStatus: 'hot', ageMs: Math.max(0, now - Number(hot.fetchedAt || now)) }
    };
  }

  try {
    const result = await fetchEspnSummaryGateway(league, eventId, fetchImpl, expectedGoals);
    const envelope = publicEnvelope(result, now, {
      cacheStatus: 'miss',
      expectedGoals,
      goalCount: Number(result.goalCount || 0),
      complete: result.complete !== false,
      attempts: result.attempts || []
    });
    await Promise.all([
      writeCached(cache, hotKey, envelope, SUMMARY_HOT_TTL_SECONDS),
      writeCached(cache, fallbackKey, envelope, SUMMARY_FALLBACK_TTL_SECONDS)
    ]);
    return { status: 200, body: envelope };
  } catch (error) {
    const cached = await readCached(cache, fallbackKey);
    if (acceptable(cached)) {
      return { status: 200, body: { ...staleEnvelope(cached, now, error), cacheStatus: 'stale-fallback' } };
    }
    return {
      status: 503,
      body: {
        ok: false,
        gatewayVersion: LIVE_GATEWAY_VERSION,
        error: 'espn_summary_unavailable',
        detail: text(error?.message || error).slice(0, 700)
      }
    };
  }
}

export const LIVE_API_CONSTANTS = Object.freeze({
  LIVE_GATEWAY_VERSION,
  SCOREBOARD_HOT_TTL_SECONDS,
  SCOREBOARD_FALLBACK_TTL_SECONDS,
  SUMMARY_HOT_TTL_SECONDS,
  SUMMARY_FALLBACK_TTL_SECONDS
});
