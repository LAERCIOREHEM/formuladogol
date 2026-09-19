import {
  ESPN_SOURCE_CONSTANTS,
  fetchEspnScoreboardGateway,
  fetchEspnSummaryGateway,
  mergeExternalStatisticsIntoSummary,
  summaryGoalCount,
  summaryTeamMetricCoverage
} from './espn-source.js';
import { fetchApiFootballPlayerDefenseFallback, fetchApiFootballStatsFallback } from './api-football-source.js';
import { fetchTheSportsDbStatsFallback } from './thesportsdb-source.js';

const LIVE_GATEWAY_VERSION = '4';
const LIVE_STATE_CONTRACT_VERSION = 1;
const SCOREBOARD_HOT_TTL_SECONDS = 8;
const SCOREBOARD_FALLBACK_TTL_SECONDS = 180;
const SUMMARY_HOT_TTL_SECONDS = 8;
const SUMMARY_FALLBACK_TTL_SECONDS = 900;
const STATS_FALLBACK_TTL_SECONDS = 120;
const API_FOOTBALL_STATS_TTL_SECONDS = 300;
const API_FOOTBALL_PLAYER_TTL_SECONDS = 1_200;
const STATS_FIXTURE_MAP_TTL_SECONDS = 86_400;
const STATS_BEST_KNOWN_TTL_SECONDS = 28_800;
const STATS_FALLBACK_THRESHOLD = 10;
const CONTINENTAL_STATS_TARGET = 15;
const CONTINENTAL_STATS_COMPLETE = 17;
const API_FOOTBALL_DAILY_PLAN_BUDGET = 100;
const API_FOOTBALL_BUDGET_RESERVE = 12;
const CONTINENTAL_LEAGUES = new Set(['conmebol.libertadores', 'conmebol.sudamericana']);
const INTERNAL_CACHE_ORIGIN = 'https://push.formuladogol.com.br/__fdg_live_cache';
const ALLOWED_LEAGUES = new Set(ESPN_SOURCE_CONSTANTS.ALLOWED_LEAGUES);

function text(value) { return String(value == null ? '' : value).trim(); }
function optionalNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function summaryState(data) {
  const competition = data?.header?.competitions?.[0] || data?.competitions?.[0] || data?.competition || {};
  const status = competition?.status || data?.header?.status || {};
  const type = status?.type || status || {};
  const state = text(type?.state).toLowerCase();
  if (type?.completed === true || state === 'post') return 'post';
  if (state === 'in') return 'in';
  if (state === 'pre') return 'pre';
  return '';
}


function coverageBelow(coverage, target) {
  return !coverage || coverage.teams < 2 || coverage.minPerTeam < target;
}

function statsQuality(coverage) {
  const min = Number(coverage?.minPerTeam || 0);
  if (min >= CONTINENTAL_STATS_COMPLETE) return 'COMPLETE';
  if (min >= CONTINENTAL_STATS_TARGET) return 'GOOD';
  if (min >= STATS_FALLBACK_THRESHOLD) return 'DEGRADED';
  return 'CRITICAL';
}

function utcDayKey(now) {
  return new Date(Number(now) || Date.now()).toISOString().slice(0, 10);
}

function budgetAllows(state, reserve = API_FOOTBALL_BUDGET_RESERVE) {
  const remaining = optionalNumber(state?.remaining);
  const reserved = optionalNumber(state?.reservedCalls);
  if (remaining != null && remaining <= reserve) return false;
  if (reserved != null && reserved >= API_FOOTBALL_DAILY_PLAN_BUDGET - reserve) return false;
  return true;
}

function quotaFromFallback(fallback, previous = null) {
  const remaining = optionalNumber(fallback?.rateLimit?.dailyRemaining);
  const limit = optionalNumber(fallback?.rateLimit?.dailyLimit);
  return {
    remaining: remaining != null ? remaining : optionalNumber(previous?.remaining),
    limit: limit != null ? limit : (optionalNumber(previous?.limit) ?? API_FOOTBALL_DAILY_PLAN_BUDGET),
    reservedCalls: optionalNumber(previous?.reservedCalls),
    updatedAt: Date.now()
  };
}

function statisticsSnapshot(data) {
  const teams = Array.isArray(data?.boxscore?.teams) ? data.boxscore.teams : [];
  return { boxscore: { teams } };
}

function pushProvider(providers, value) {
  const provider = text(value);
  if (provider && !providers.includes(provider)) providers.push(provider);
}

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

function scoreboardState(data) {
  const events = Array.isArray(data?.events) ? data.events : [];
  let hasPost = false;
  for (const event of events) {
    const competition = event?.competitions?.[0] || event?.competition || {};
    const status = competition?.status || event?.status || {};
    const type = status?.type || {};
    const state = text(type?.state).toLowerCase();
    if (state === 'in') return 'in';
    if (type?.completed === true || state === 'post') hasPost = true;
  }
  return hasPost ? 'post' : 'pre';
}

function scoreboardFallbackAcceptable(cached, now) {
  if (!cached || !Array.isArray(cached?.data?.events)) return false;
  const fetchedAt = Number(cached?.fetchedAt || 0);
  if (!fetchedAt) return false;
  const ageMs = Math.max(0, now - fetchedAt);
  const state = scoreboardState(cached.data);
  const maxAgeMs = state === 'in' ? 90_000 : state === 'post' ? 180_000 : 45_000;
  return ageMs <= maxAgeMs;
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


async function readLayeredCache(cache, localKey, statsStore, sharedKey, ttlSeconds) {
  const local = await readCached(cache, localKey);
  if (local) return local;
  if (!statsStore || typeof statsStore.get !== 'function') return null;
  try {
    const shared = await statsStore.get(sharedKey);
    if (!shared) return null;
    await writeCached(cache, localKey, shared, ttlSeconds);
    return shared;
  } catch (_) {
    return null;
  }
}

async function writeLayeredCache(cache, localKey, statsStore, sharedKey, value, ttlSeconds, now) {
  const tasks = [writeCached(cache, localKey, value, ttlSeconds)];
  if (statsStore && typeof statsStore.put === 'function') {
    tasks.push(statsStore.put(sharedKey, value, ttlSeconds, now).catch(() => null));
  }
  await Promise.all(tasks);
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
  const forceFresh = url.searchParams.get('fresh') === '1';
  if (!ALLOWED_LEAGUES.has(league)) return { status: 400, body: { ok: false, error: 'invalid_league' } };
  if (!validDates(dates)) return { status: 400, body: { ok: false, error: 'invalid_dates' } };

  const nowFn = deps.now || Date.now;
  const now = Number(nowFn());
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const cache = cacheFromDeps(deps);
  const hotKey = cacheKey('scoreboard', [league, dates], 'hot');
  const fallbackKey = cacheKey('scoreboard', [league, dates], 'fallback');

  const hot = forceFresh ? null : await readCached(cache, hotKey);
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
      stateContractVersion: LIVE_STATE_CONTRACT_VERSION,
      transport: 'worker-espn',
      scoreboardState: scoreboardState(result.data),
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
    if (scoreboardFallbackAcceptable(cached, now)) {
      return {
        status: 200,
        body: {
          ...staleEnvelope(cached, now, error),
          cacheStatus: 'stale-fallback',
          stateContractVersion: LIVE_STATE_CONTRACT_VERSION,
          transport: 'worker-espn',
          scoreboardState: scoreboardState(cached.data)
        }
      };
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
            stateContractVersion: LIVE_STATE_CONTRACT_VERSION,
            transport: 'worker-espn-monitor',
            scoreboardState: scoreboardState(fallback.data),
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
  const requestedStateRaw = text(url.searchParams.get('state')).toLowerCase();
  const requestedState = ['pre', 'in', 'post'].includes(requestedStateRaw) ? requestedStateRaw : '';
  if (!ALLOWED_LEAGUES.has(league)) return { status: 400, body: { ok: false, error: 'invalid_league' } };
  if (!validEventId(eventId)) return { status: 400, body: { ok: false, error: 'invalid_event' } };

  const nowFn = deps.now || Date.now;
  const now = Number(nowFn());
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const cache = cacheFromDeps(deps);
  const hotKey = cacheKey('summary', [league, eventId], 'hot');
  const fallbackKey = cacheKey('summary', [league, eventId], 'fallback');
  const isContinental = CONTINENTAL_LEAGUES.has(league);
  const isBrasileirao = league === 'bra.1';
  const preserveBestStats = isContinental || isBrasileirao;
  const target = isContinental ? CONTINENTAL_STATS_TARGET : STATS_FALLBACK_THRESHOLD;

  const acceptable = (entry) => {
    if (!entry || !entry.data || typeof entry.data !== 'object') return false;
    const cachedState = summaryState(entry.data);
    // Nunca servir snapshot PRE como se fosse jogo em andamento. Esse era o
    // caminho que mantinha os cinco zeros pré-jogo quando o edge ESPN oscilava.
    if (requestedState === 'in' && cachedState === 'pre') return false;
    if (requestedState === 'post' && cachedState === 'pre') return false;
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
    let data = result.data || {};
    const beforeCoverage = summaryTeamMetricCoverage(data);
    const providers = ['espn'];
    const statsFallbacks = [];
    const statsFallbackErrors = {};
    const gameState = summaryState(data);
    const shouldTryStatsFallback = coverageBelow(beforeCoverage, target)
      && (beforeCoverage.maxPerTeam > 0 || expectedGoals > 0 || gameState === 'in' || gameState === 'post');

    const statsStore = deps.statsStore || null;
    const dayKey = utcDayKey(now);
    const bestKey = preserveBestStats ? cacheKey('summary-stats-best', [league, eventId], 'best') : null;
    const bestSharedKey = `best:${league}:${eventId}`;
    const previousBest = bestKey
      ? await readLayeredCache(cache, bestKey, statsStore, bestSharedKey, STATS_BEST_KNOWN_TTL_SECONDS)
      : null;
    const apiFootballKey = text(deps.apiFootballKey);
    const budgetKey = cacheKey('api-football-budget', [dayKey], 'daily');
    let budgetState = isContinental
      ? (statsStore?.getApiBudget ? await statsStore.getApiBudget(dayKey).catch(() => null) : await readCached(cache, budgetKey))
      : null;
    let apiFixtureId = 0;

    // Nas competições continentais, API-Football tem prioridade sobre TheSportsDB,
    // mas só quando a ESPN está abaixo do alvo e respeitando o orçamento de 100/dia.
    if (isContinental && shouldTryStatsFallback && apiFootballKey && budgetAllows(budgetState)) {
      const statsKey = cacheKey('summary-stats', [league, eventId], 'api-football');
      const mapKey = cacheKey('summary-stats-map', [league, eventId], 'api-football');
      const statsSharedKey = `api:${league}:${eventId}`;
      const mapSharedKey = `api-map:${league}:${eventId}`;
      let fallback = null;
      let fallbackError = '';
      const cachedStats = await readLayeredCache(cache, statsKey, statsStore, statsSharedKey, API_FOOTBALL_STATS_TTL_SECONDS);
      if (cachedStats?.unavailable === true) fallbackError = text(cachedStats.error).slice(0, 500);
      else if (cachedStats?.data) fallback = cachedStats;

      const fixtureMap = await readLayeredCache(cache, mapKey, statsStore, mapSharedKey, STATS_FIXTURE_MAP_TTL_SECONDS);
      apiFixtureId = Number(fixtureMap?.fixtureId || fallback?.fixtureId || 0) || 0;
      if (!fallback && !fallbackError) {
        let allowedToCall = true;
        if (statsStore?.acquireLease) {
          allowedToCall = await statsStore.acquireLease(`lease:${statsSharedKey}`, 30, now).catch(() => true);
          if (!allowedToCall) fallbackError = 'atualização API-Football já em andamento em outro edge';
        }
        if (allowedToCall && statsStore?.reserveApiCalls) {
          const estimate = apiFixtureId ? 1 : 3;
          const reservation = await statsStore.reserveApiCalls(
            dayKey, estimate, API_FOOTBALL_DAILY_PLAN_BUDGET - API_FOOTBALL_BUDGET_RESERVE, now
          ).catch(() => ({ allowed: true }));
          budgetState = reservation || budgetState;
          allowedToCall = reservation?.allowed !== false && budgetAllows(budgetState);
          if (!allowedToCall) fallbackError = 'orçamento diário global da API-Football protegido';
        }
        if (allowedToCall) {
          try {
            fallback = await fetchApiFootballStatsFallback(data, {
              apiKey: apiFootballKey,
              fetchImpl,
              now,
              fixtureId: apiFixtureId || undefined
            });
            apiFixtureId = Number(fallback.fixtureId || 0) || apiFixtureId;
            if (statsStore?.updateApiBudget) {
              budgetState = await statsStore.updateApiBudget(dayKey, fallback.rateLimit, now).catch(() => quotaFromFallback(fallback, budgetState));
            } else {
              budgetState = quotaFromFallback(fallback, budgetState);
              await writeCached(cache, budgetKey, budgetState, 93_600);
            }
            await Promise.all([
              writeLayeredCache(cache, statsKey, statsStore, statsSharedKey, fallback, API_FOOTBALL_STATS_TTL_SECONDS, now),
              writeLayeredCache(cache, mapKey, statsStore, mapSharedKey, { fixtureId: apiFixtureId }, STATS_FIXTURE_MAP_TTL_SECONDS, now)
            ]);
          } catch (error) {
            fallbackError = text(error?.message || error).slice(0, 500);
            await writeLayeredCache(
              cache, statsKey, statsStore, statsSharedKey,
              { unavailable: true, error: fallbackError }, API_FOOTBALL_STATS_TTL_SECONDS, now
            );
          }
        }
      }

      if (fallback?.data) {
        const previous = summaryTeamMetricCoverage(data);
        const enriched = mergeExternalStatisticsIntoSummary(data, fallback.data);
        const after = summaryTeamMetricCoverage(enriched);
        if (after.totalUnique > previous.totalUnique) {
          data = enriched;
          pushProvider(providers, 'api-football');
          statsFallbacks.push({
            source: 'api-football',
            fixtureId: Number(fallback.fixtureId || 0) || null,
            metricNames: Array.isArray(fallback.metricNames) ? fallback.metricNames : [],
            rateLimit: fallback.rateLimit || null
          });
        }
      }
      if (fallbackError) statsFallbackErrors.apiFootball = fallbackError;
    } else if (isContinental && shouldTryStatsFallback && !apiFootballKey) {
      statsFallbackErrors.apiFootball = 'API_FOOTBALL_KEY ausente';
    } else if (isContinental && shouldTryStatsFallback && apiFootballKey && !budgetAllows(budgetState)) {
      statsFallbackErrors.apiFootball = `orçamento diário protegido: ${Number(budgetState?.remaining)} requisições restantes`;
    }

    // TheSportsDB fica restrito às competições continentais. No Brasileirão
    // a cadeia volta a ser ESPN-only: múltiplas superfícies ESPN + preservação
    // best-known, sem misturar fornecedores externos.
    if (isContinental && shouldTryStatsFallback && coverageBelow(summaryTeamMetricCoverage(data), target)) {
      const statsKey = cacheKey('summary-stats', [league, eventId], 'thesportsdb');
      const mapKey = cacheKey('summary-stats-map', [league, eventId], 'thesportsdb');
      const statsSharedKey = `tsdb:${league}:${eventId}`;
      const mapSharedKey = `tsdb-map:${league}:${eventId}`;
      let fallback = null;
      let fallbackError = '';
      const cachedStats = await readLayeredCache(cache, statsKey, statsStore, statsSharedKey, STATS_FALLBACK_TTL_SECONDS);
      if (cachedStats?.unavailable === true) fallbackError = text(cachedStats.error).slice(0, 500);
      else if (cachedStats?.data) fallback = cachedStats;

      if (!fallback && !fallbackError) {
        const eventMap = await readLayeredCache(cache, mapKey, statsStore, mapSharedKey, STATS_FIXTURE_MAP_TTL_SECONDS);
        try {
          fallback = await fetchTheSportsDbStatsFallback(data, {
            fetchImpl,
            now,
            eventId: Number(eventMap?.eventId || 0) || undefined
          });
          await Promise.all([
            writeLayeredCache(cache, statsKey, statsStore, statsSharedKey, fallback, STATS_FALLBACK_TTL_SECONDS, now),
            writeLayeredCache(cache, mapKey, statsStore, mapSharedKey, { eventId: fallback.eventId }, STATS_FIXTURE_MAP_TTL_SECONDS, now)
          ]);
        } catch (error) {
          fallbackError = text(error?.message || error).slice(0, 500);
          await writeLayeredCache(
            cache, statsKey, statsStore, statsSharedKey,
            { unavailable: true, error: fallbackError }, STATS_FALLBACK_TTL_SECONDS, now
          );
        }
      }

      if (fallback?.data) {
        const previous = summaryTeamMetricCoverage(data);
        const enriched = mergeExternalStatisticsIntoSummary(data, fallback.data);
        const after = summaryTeamMetricCoverage(enriched);
        if (after.totalUnique > previous.totalUnique) {
          data = enriched;
          pushProvider(providers, 'thesportsdb');
          statsFallbacks.push({
            source: 'thesportsdb',
            eventId: Number(fallback.eventId || 0) || null,
            metricNames: Array.isArray(fallback.metricNames) ? fallback.metricNames : []
          });
        }
      }
      if (fallbackError) statsFallbackErrors.thesportsdb = fallbackError;
    }

    // Desarmes/interceptações dependem do endpoint de jogadores. Para caber no
    // plano Free, essa consulta tem TTL de 20 minutos e só ocorre se o painel
    // continental ainda estiver abaixo do alvo depois das fontes de equipe.
    if (isContinental && shouldTryStatsFallback && apiFootballKey && apiFixtureId
        && coverageBelow(summaryTeamMetricCoverage(data), target) && budgetAllows(budgetState, API_FOOTBALL_BUDGET_RESERVE + 1)) {
      const playersKey = cacheKey('summary-stats', [league, eventId], 'api-football-players');
      const playersSharedKey = `api-players:${league}:${eventId}`;
      let playerFallback = null;
      let playerError = '';
      const cachedPlayers = await readLayeredCache(
        cache, playersKey, statsStore, playersSharedKey, API_FOOTBALL_PLAYER_TTL_SECONDS
      );
      if (cachedPlayers?.unavailable === true) playerError = text(cachedPlayers.error).slice(0, 500);
      else if (cachedPlayers?.data) playerFallback = cachedPlayers;

      if (!playerFallback && !playerError) {
        let allowedToCall = true;
        if (statsStore?.acquireLease) {
          allowedToCall = await statsStore.acquireLease(`lease:${playersSharedKey}`, 30, now).catch(() => true);
          if (!allowedToCall) playerError = 'atualização API-Football players já em andamento em outro edge';
        }
        if (allowedToCall && statsStore?.reserveApiCalls) {
          const reservation = await statsStore.reserveApiCalls(
            dayKey, 1, API_FOOTBALL_DAILY_PLAN_BUDGET - API_FOOTBALL_BUDGET_RESERVE, now
          ).catch(() => ({ allowed: true }));
          budgetState = reservation || budgetState;
          allowedToCall = reservation?.allowed !== false && budgetAllows(budgetState, API_FOOTBALL_BUDGET_RESERVE + 1);
          if (!allowedToCall) playerError = 'orçamento diário global protegido antes de consultar players';
        }
        if (allowedToCall) {
          try {
            playerFallback = await fetchApiFootballPlayerDefenseFallback(data, {
              apiKey: apiFootballKey, fetchImpl, now, fixtureId: apiFixtureId
            });
            if (statsStore?.updateApiBudget) {
              budgetState = await statsStore.updateApiBudget(dayKey, playerFallback.rateLimit, now)
                .catch(() => quotaFromFallback(playerFallback, budgetState));
            } else {
              budgetState = quotaFromFallback(playerFallback, budgetState);
              await writeCached(cache, budgetKey, budgetState, 93_600);
            }
            await writeLayeredCache(
              cache, playersKey, statsStore, playersSharedKey,
              playerFallback, API_FOOTBALL_PLAYER_TTL_SECONDS, now
            );
          } catch (error) {
            playerError = text(error?.message || error).slice(0, 500);
            await writeLayeredCache(
              cache, playersKey, statsStore, playersSharedKey,
              { unavailable: true, error: playerError }, API_FOOTBALL_PLAYER_TTL_SECONDS, now
            );
          }
        }
      }

      if (playerFallback?.data) {
        const previous = summaryTeamMetricCoverage(data);
        const enriched = mergeExternalStatisticsIntoSummary(data, playerFallback.data);
        const after = summaryTeamMetricCoverage(enriched);
        if (after.totalUnique > previous.totalUnique) {
          data = enriched;
          pushProvider(providers, 'api-football');
          statsFallbacks.push({
            source: 'api-football-players', fixtureId: apiFixtureId,
            metricNames: Array.isArray(playerFallback.metricNames) ? playerFallback.metricNames : [],
            rateLimit: playerFallback.rateLimit || null
          });
        }
      }
      if (playerError) statsFallbackErrors.apiFootballPlayers = playerError;
    }

    // Best-known state no servidor: resposta ESPN temporariamente pobre nunca
    // pode apagar métricas factuais já vistas para o mesmo jogo. Vale também
    // para o Brasileirão, mas sem acrescentar qualquer fornecedor externo.
    let bestKnownApplied = false;
    if (preserveBestStats && previousBest?.data) {
      const previous = summaryTeamMetricCoverage(data);
      const preserved = mergeExternalStatisticsIntoSummary(data, previousBest.data);
      const after = summaryTeamMetricCoverage(preserved);
      if (after.totalUnique > previous.totalUnique) {
        data = preserved;
        bestKnownApplied = true;
        for (const provider of (Array.isArray(previousBest.providers) ? previousBest.providers : [])) pushProvider(providers, provider);
      }
    }

    const finalCoverage = summaryTeamMetricCoverage(data);
    if (preserveBestStats && bestKey && finalCoverage.maxPerTeam > 0) {
      await writeLayeredCache(cache, bestKey, statsStore, bestSharedKey, {
        data: statisticsSnapshot(data),
        providers: providers.filter((provider) => provider !== 'espn'),
        coverage: finalCoverage,
        updatedAt: now
      }, STATS_BEST_KNOWN_TTL_SECONDS, now);
    }

    const mergedResult = { ...result, data };
    const envelope = publicEnvelope(mergedResult, now, {
      cacheStatus: 'miss',
      expectedGoals,
      goalCount: Number(result.goalCount || 0),
      complete: result.complete !== false,
      attempts: result.attempts || [],
      statsProvider: providers.join('+'),
      statsCoverage: finalCoverage,
      statsQuality: statsQuality(finalCoverage),
      statsTargetMinPerTeam: target,
      statsBestKnownApplied: bestKnownApplied,
      requestedState: requestedState || null,
      observedState: summaryState(data) || null,
      espnOnly: isBrasileirao,
      statsFallback: statsFallbacks.length ? statsFallbacks[statsFallbacks.length - 1] : null,
      statsFallbacks,
      statsFallbackError: Object.values(statsFallbackErrors).filter(Boolean).join(' | '),
      statsFallbackErrors,
      apiFootballBudget: isContinental ? {
        policyDailyBudget: API_FOOTBALL_DAILY_PLAN_BUDGET,
        reserve: API_FOOTBALL_BUDGET_RESERVE,
        knownRemaining: optionalNumber(budgetState?.remaining),
        reservedCalls: optionalNumber(budgetState?.reservedCalls),
        protected: !budgetAllows(budgetState)
      } : null
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
  LIVE_STATE_CONTRACT_VERSION,
  SCOREBOARD_HOT_TTL_SECONDS,
  SCOREBOARD_FALLBACK_TTL_SECONDS,
  SUMMARY_HOT_TTL_SECONDS,
  SUMMARY_FALLBACK_TTL_SECONDS,
  STATS_FALLBACK_TTL_SECONDS,
  API_FOOTBALL_STATS_TTL_SECONDS,
  API_FOOTBALL_PLAYER_TTL_SECONDS,
  STATS_FIXTURE_MAP_TTL_SECONDS,
  STATS_BEST_KNOWN_TTL_SECONDS,
  STATS_FALLBACK_THRESHOLD,
  CONTINENTAL_STATS_TARGET,
  CONTINENTAL_STATS_COMPLETE,
  API_FOOTBALL_DAILY_PLAN_BUDGET,
  API_FOOTBALL_BUDGET_RESERVE
});
