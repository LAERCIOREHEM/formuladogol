import {
  ESPN_SOURCE_CONSTANTS,
  fetchEspnScoreboardGateway,
  fetchEspnSummaryGateway,
  mergeExternalStatisticsIntoSummary,
  summaryGoalCount,
  summaryTeamMetricCoverage,
  summaryHasMeaningfulStatistics,
  summaryHasEssentialStatistics,
  discardAllZeroStatistics
} from './espn-source.js';
import { fetchApiFootballPlayerDefenseFallback, fetchApiFootballStatsFallback } from './api-football-source.js';
import { fetchTheSportsDbStatsFallback } from './thesportsdb-source.js';
import { normalizeLiveFacts, chooseBestKnownLiveFacts, LIVE_FACTS_CONSTANTS } from './live-facts.js';

const LIVE_GATEWAY_VERSION = '7';
const LIVE_STATE_CONTRACT_VERSION = 1;
const SCOREBOARD_HOT_TTL_SECONDS = 8;
const SCOREBOARD_FALLBACK_TTL_SECONDS = 180;
const SUMMARY_HOT_TTL_SECONDS = 8;
const SUMMARY_FALLBACK_TTL_SECONDS = 900;
const STATS_FALLBACK_TTL_SECONDS = 120;
const API_FOOTBALL_STATS_TTL_SECONDS = 300;
const BR_API_STATS_TTL_SECONDS = 120;
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
    const remaining = shared._storeExpiresAt == null ? ttlSeconds : Math.floor((Number(shared._storeExpiresAt) - Date.now()) / 1000);
    if (remaining <= 0) return null;
    await writeCached(cache, localKey, shared, Math.min(ttlSeconds, remaining));
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
  const expectedHomeRaw = url.searchParams.get('expectedHome');
  const expectedAwayRaw = url.searchParams.get('expectedAway');
  const expectedHome = expectedHomeRaw != null && expectedHomeRaw !== '' && Number.isFinite(Number(expectedHomeRaw)) ? Math.max(0, Math.min(30, Number(expectedHomeRaw))) : null;
  const expectedAway = expectedAwayRaw != null && expectedAwayRaw !== '' && Number.isFinite(Number(expectedAwayRaw)) ? Math.max(0, Math.min(30, Number(expectedAwayRaw))) : null;
  const exactExpectedScore = expectedHome != null && expectedAway != null;
  const expectedGoalsParam = Math.max(0, Math.min(30, Number(url.searchParams.get('expectedGoals') || 0) || 0));
  const expectedGoals = exactExpectedScore ? expectedHome + expectedAway : expectedGoalsParam;
  const forceFresh = url.searchParams.get('fresh') === '1';
  const requestedStateRaw = text(url.searchParams.get('state')).toLowerCase();
  const requestedState = ['pre', 'in', 'post'].includes(requestedStateRaw) ? requestedStateRaw : '';
  if (!ALLOWED_LEAGUES.has(league)) return { status: 400, body: { ok: false, error: 'invalid_league' } };
  if (!validEventId(eventId)) return { status: 400, body: { ok: false, error: 'invalid_event' } };

  const nowFn = deps.now || Date.now;
  const now = Number(nowFn());
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const cache = cacheFromDeps(deps);
  const hotKey = cacheKey('summary', [LIVE_GATEWAY_VERSION, league, eventId], 'hot');
  const fallbackKey = cacheKey('summary', [LIVE_GATEWAY_VERSION, league, eventId], 'fallback');
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
    const facts = entry.facts;
    const integrity = facts?.integrity || {};
    if (Number(facts?.contractVersion || entry.factsContractVersion || 0) !== LIVE_FACTS_CONSTANTS.LIVE_FACTS_CONTRACT_VERSION) return false;
    if (exactExpectedScore) {
      if (Number(integrity.expectedHome) !== Number(expectedHome) || Number(integrity.expectedAway) !== Number(expectedAway)) return false;
    } else if (Number(integrity.expectedGoals) !== Number(expectedGoals)) {
      return false;
    }
    if (expectedGoals === 0) return Number(integrity.observedGoalCount || 0) === 0 && integrity.mathematicallyValid !== false;
    return integrity.scoreComplete === true && integrity.mathematicallyValid !== false;
  };

  const previousSummaryEnvelope = await readCached(cache, fallbackKey);
  const hot = forceFresh && !isBrasileirao ? null : await readCached(cache, hotKey);
  if (acceptable(hot)) {
    return {
      status: 200,
      body: { ...hot, cacheStatus: 'hot', ageMs: Math.max(0, now - Number(hot.fetchedAt || now)) }
    };
  }

  try {
    const result = await fetchEspnSummaryGateway(league, eventId, fetchImpl, expectedGoals);
    let data = result.data || {};
    const observedGameState = summaryState(data);
    if (isBrasileirao && ['in','post'].includes(observedGameState) && !summaryHasMeaningfulStatistics(data)) data=discardAllZeroStatistics(data);
    const beforeCoverage = summaryTeamMetricCoverage(data);
    let statsObservedAt = now;
    const providers = ['espn'];
    const statsFallbacks = [];
    const statsFallbackErrors = {};
    const gameState = summaryState(data);
    const competition = data?.header?.competitions?.[0] || data?.competitions?.[0] || data?.competition || {};
    const fixtureTime = Date.parse(competition.date || data?.header?.date || data?.gameInfo?.date || '');
    const brEligible = isBrasileirao && Number.isFinite(fixtureTime) && now >= fixtureTime - 15*60_000 && now <= fixtureTime + 5*60*60_000 && (gameState === 'in' || gameState === 'post');
    const shouldTryStatsFallback = (coverageBelow(beforeCoverage, target) || (isBrasileirao && (!summaryHasMeaningfulStatistics(data) || !summaryHasEssentialStatistics(data)))) && (isBrasileirao ? brEligible : (beforeCoverage.maxPerTeam > 0 || expectedGoals > 0 || gameState === 'in' || gameState === 'post'));

    const statsStore = deps.statsStore || null;
    const sharedReady = Boolean(statsStore?.get && statsStore?.put && statsStore?.acquireLease && statsStore?.reserveApiCalls && statsStore?.getApiBudget);
    const governed = typeof deps.allowExternalStats === 'function' || deps.externalStatsAllowed != null;
    let policyAllows = deps.externalStatsAllowed !== false;
    if (shouldTryStatsFallback && typeof deps.allowExternalStats === 'function') policyAllows = await Promise.resolve().then(() => deps.allowExternalStats()).then(v => v === true).catch(() => false);
    const externalEnabled = isContinental ? policyAllows : (isBrasileirao && governed && policyAllows && sharedReady);
    const apiLeagueId = isBrasileirao ? Number(deps.apiFootballLeagueId || 0) : 0;
    const apiAllowed = externalEnabled && (!isBrasileirao || apiLeagueId > 0) && (!governed || sharedReady);
    const apiStatsTtl = isBrasileirao ? BR_API_STATS_TTL_SECONDS : API_FOOTBALL_STATS_TTL_SECONDS;
    const dayKey = utcDayKey(now);
    const bestKey = preserveBestStats ? cacheKey('summary-stats-best', [league, eventId], 'best') : null;
    const bestSharedKey = `best:${league}:${eventId}`;
    const previousBest = bestKey
      ? await readLayeredCache(cache, bestKey, statsStore, bestSharedKey, STATS_BEST_KNOWN_TTL_SECONDS)
      : null;
    const apiFootballKey = text(deps.apiFootballKey);
    const budgetKey = cacheKey('api-football-budget', [dayKey], 'daily');
    let budgetFailed = false;
    let budgetState = apiAllowed && shouldTryStatsFallback ? (statsStore?.getApiBudget ? await statsStore.getApiBudget(dayKey).catch(() => { budgetFailed = true; return null; }) : await readCached(cache, budgetKey)) : null;
    let apiFixtureId = 0;

    // Nas competições continentais, API-Football tem prioridade sobre TheSportsDB,
    // mas só quando a ESPN está abaixo do alvo e respeitando o orçamento de 100/dia.
    if (apiAllowed && shouldTryStatsFallback && apiFootballKey && !budgetFailed && budgetAllows(budgetState)) {
      const statsKey = cacheKey('summary-stats', [league, eventId], 'api-football');
      const mapKey = cacheKey('summary-stats-map', [league, eventId], 'api-football');
      const statsSharedKey = `api:${league}:${eventId}`;
      const mapSharedKey = `api-map:${league}:${eventId}`;
      let fallback = null;
      let fallbackError = '';
      const cachedStats = await readLayeredCache(cache, statsKey, statsStore, statsSharedKey, apiStatsTtl);
      if (cachedStats?.unavailable === true) fallbackError = text(cachedStats.error).slice(0, 500);
      else if (cachedStats?.data) fallback = cachedStats;

      const fixtureMap = await readLayeredCache(cache, mapKey, statsStore, mapSharedKey, STATS_FIXTURE_MAP_TTL_SECONDS);
      apiFixtureId = Number(fixtureMap?.fixtureId || fallback?.fixtureId || 0) || 0;
      if (!fallback && !fallbackError) {
        let allowedToCall = true;
        if (statsStore?.acquireLease) {
          allowedToCall = await statsStore.acquireLease(`lease:${statsSharedKey}`, 30, now).catch(() => false);
          if (!allowedToCall) fallbackError = 'atualização API-Football já em andamento em outro edge';
        }
        if (allowedToCall && statsStore?.reserveApiCalls) {
          const estimate = apiFixtureId ? 1 : 3;
          const reservation = await statsStore.reserveApiCalls(
            dayKey, estimate, API_FOOTBALL_DAILY_PLAN_BUDGET - API_FOOTBALL_BUDGET_RESERVE, now
          ).catch(() => ({ allowed: false }));
          budgetState = reservation || budgetState;
          allowedToCall = reservation?.allowed === true && budgetAllows(budgetState);
          if (!allowedToCall) fallbackError = 'orçamento diário global da API-Football protegido';
        }
        if (allowedToCall) {
          try {
            fallback = await fetchApiFootballStatsFallback(data, {
              apiKey: apiFootballKey,
              fetchImpl,
              now,
              fixtureId: apiFixtureId || undefined,
              leagueId: apiLeagueId || undefined
            });
            fallback.observedAt=now;
            apiFixtureId = Number(fallback.fixtureId || 0) || apiFixtureId;
            if (statsStore?.updateApiBudget) {
              budgetState = await statsStore.updateApiBudget(dayKey, fallback.rateLimit, now).catch(() => quotaFromFallback(fallback, budgetState));
            } else {
              budgetState = quotaFromFallback(fallback, budgetState);
              await writeCached(cache, budgetKey, budgetState, 93_600);
            }
            await Promise.all([
              writeLayeredCache(cache, statsKey, statsStore, statsSharedKey, fallback, apiStatsTtl, now),
              writeLayeredCache(cache, mapKey, statsStore, mapSharedKey, { fixtureId: apiFixtureId }, STATS_FIXTURE_MAP_TTL_SECONDS, now)
            ]);
          } catch (error) {
            fallbackError = text(error?.message || error).slice(0, 500);
            await writeLayeredCache(
              cache, statsKey, statsStore, statsSharedKey,
              { unavailable: true, error: fallbackError }, apiStatsTtl, now
            );
          }
        }
      }

      if (fallback?.data) {
        const previous = summaryTeamMetricCoverage(data);
        const enriched = mergeExternalStatisticsIntoSummary(data, fallback.data);
        const after = summaryTeamMetricCoverage(enriched);
        if (after.totalUnique > previous.totalUnique || JSON.stringify(statisticsSnapshot(enriched)) !== JSON.stringify(statisticsSnapshot(data))) {
          data = enriched;
          statsObservedAt=Math.min(statsObservedAt,Number((fallback?.observedAt || fallback?._storeUpdatedAt) || now));
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
    } else if (externalEnabled && shouldTryStatsFallback && !apiFootballKey) {
      statsFallbackErrors.apiFootball = 'API_FOOTBALL_KEY ausente';
    } else if (externalEnabled && shouldTryStatsFallback && apiFootballKey && (budgetFailed || !budgetAllows(budgetState))) {
      statsFallbackErrors.apiFootball = `orçamento diário protegido: ${Number(budgetState?.remaining)} requisições restantes`;
    }

    // Secondary source: validated identity and no duplicate concurrent calls.
    if (externalEnabled && shouldTryStatsFallback && (coverageBelow(summaryTeamMetricCoverage(data), target) || (isBrasileirao && (!summaryHasMeaningfulStatistics(data) || !summaryHasEssentialStatistics(data))))) {
      const statsKey = cacheKey('summary-stats', [league, eventId], 'thesportsdb');
      const mapKey = cacheKey('summary-stats-map', [league, eventId], 'thesportsdb');
      const statsSharedKey = `tsdb:${league}:${eventId}`;
      const mapSharedKey = `tsdb-map:${league}:${eventId}`;
      let fallback = null;
      let fallbackError = '';
      const cachedStats = await readLayeredCache(cache, statsKey, statsStore, statsSharedKey, STATS_FALLBACK_TTL_SECONDS);
      if (cachedStats?.unavailable === true) fallbackError = text(cachedStats.error).slice(0, 500);
      else if (cachedStats?.data) fallback = cachedStats;

      if (!fallback && !fallbackError && (!statsStore?.acquireLease || await statsStore.acquireLease(`lease:${statsSharedKey}`, 30, now).catch(() => false))) {
        const eventMap = await readLayeredCache(cache, mapKey, statsStore, mapSharedKey, STATS_FIXTURE_MAP_TTL_SECONDS);
        try {
          fallback = await fetchTheSportsDbStatsFallback(data, {
            fetchImpl,
            now,
            eventId: Number(eventMap?.eventId || 0) || undefined,
            requireBrazil: isBrasileirao
          });
          fallback.observedAt=now;
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
        if (after.totalUnique > previous.totalUnique || JSON.stringify(statisticsSnapshot(enriched)) !== JSON.stringify(statisticsSnapshot(data))) {
          data = enriched;
          statsObservedAt=Math.min(statsObservedAt,Number((fallback?.observedAt || fallback?._storeUpdatedAt) || now));
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
    if (isContinental && apiAllowed && !budgetFailed && shouldTryStatsFallback && apiFootballKey && apiFixtureId
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
          allowedToCall = await statsStore.acquireLease(`lease:${playersSharedKey}`, 30, now).catch(() => false);
          if (!allowedToCall) playerError = 'atualização API-Football players já em andamento em outro edge';
        }
        if (allowedToCall && statsStore?.reserveApiCalls) {
          const reservation = await statsStore.reserveApiCalls(
            dayKey, 1, API_FOOTBALL_DAILY_PLAN_BUDGET - API_FOOTBALL_BUDGET_RESERVE, now
          ).catch(() => ({ allowed: false }));
          budgetState = reservation || budgetState;
          allowedToCall = reservation?.allowed === true && budgetAllows(budgetState, API_FOOTBALL_BUDGET_RESERVE + 1);
          if (!allowedToCall) playerError = 'orçamento diário global protegido antes de consultar players';
        }
        if (allowedToCall) {
          try {
            playerFallback = await fetchApiFootballPlayerDefenseFallback(data, {
              apiKey: apiFootballKey, fetchImpl, now, fixtureId: apiFixtureId
            });
            playerFallback.observedAt=now;
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
        if (after.totalUnique > previous.totalUnique || JSON.stringify(statisticsSnapshot(enriched)) !== JSON.stringify(statisticsSnapshot(data))) {
          data = enriched;
          statsObservedAt=Math.min(statsObservedAt,Number((playerFallback?.observedAt || playerFallback?._storeUpdatedAt) || now));
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
      if (after.totalUnique > previous.totalUnique || JSON.stringify(statisticsSnapshot(preserved)) !== JSON.stringify(statisticsSnapshot(data))) {
        data = preserved;
        bestKnownApplied = true;
        statsObservedAt=Math.min(statsObservedAt,Number(previousBest?.updatedAt || now));
        for (const provider of (Array.isArray(previousBest.providers) ? previousBest.providers : [])) pushProvider(providers, provider);
      }
    }

    const finalCoverage = summaryTeamMetricCoverage(data);
    if (preserveBestStats && bestKey && finalCoverage.maxPerTeam > 0 && summaryHasMeaningfulStatistics(data) && gameState !== 'pre') {
      await writeLayeredCache(cache, bestKey, statsStore, bestSharedKey, {
        data: statisticsSnapshot(data),
        providers: providers.filter((provider) => provider !== 'espn'),
        coverage: finalCoverage,
        updatedAt: statsObservedAt
      }, STATS_BEST_KNOWN_TTL_SECONDS, now);
    }

    const meaningful=summaryHasMeaningfulStatistics(data);
    const essential=summaryHasEssentialStatistics(data);
    const late=gameState==='post'||(Number.isFinite(fixtureTime)&&now-fixtureTime>=30*60_000);
    const statsHealth=!meaningful?(late?'RED':'YELLOW'):(coverageBelow(finalCoverage,target)||!essential||bestKnownApplied||providers.length>1?'YELLOW':'GREEN');
    // Small, bounded health evidence. No extra sports calls and no per-visitor writes.
    if (brEligible && statsStore?.put && statsStore?.acquireLease) {
      const healthKey=cacheKey('summary-stats-health',[league,eventId],'sample');
      if (!await readCached(cache,healthKey)) {
        await writeCached(cache,healthKey,{sampled:true},120);
        if(await statsStore.acquireLease(`lease:health:${league}:${eventId}`,120,now).catch(()=>false)) {
          await statsStore.put(`health:${league}:${eventId}`,{
            eventId,health:statsHealth,observedAt:now,statsObservedAt:meaningful?statsObservedAt:null,
            state:gameState,coverage:finalCoverage,providers
          },48*3600,now).catch(()=>null);
        }
      }
    }
    const currentFacts = normalizeLiveFacts(data, {
      eventId,
      expectedGoals,
      expectedHome,
      expectedAway,
      variants: result.variants || []
    });
    const chosenFacts = chooseBestKnownLiveFacts(currentFacts, previousSummaryEnvelope?.facts);
    const liveFacts = chosenFacts.facts;

    const mergedResult = { ...result, data };
    const envelope = publicEnvelope(mergedResult, now, {
      factsContractVersion: LIVE_FACTS_CONSTANTS.LIVE_FACTS_CONTRACT_VERSION,
      facts: liveFacts,
      factsIntegrity: liveFacts?.integrity || null,
      factsBestKnownApplied: chosenFacts.applied === true,
      cacheStatus: 'miss',
      expectedHome,
      expectedAway,
      expectedGoals,
      goalCount: Number(liveFacts?.integrity?.observedGoalCount || 0),
      complete: liveFacts?.integrity?.scoreComplete === true,
      attempts: result.attempts || [],
      statsProvider: providers.join('+'),
      statsCoverage: finalCoverage,
      statsQuality: statsQuality(finalCoverage),
      statsTargetMinPerTeam: target,
      statsBestKnownApplied: bestKnownApplied,
      requestedState: requestedState || null,
      observedState: summaryState(data) || null,
      espnOnly: isBrasileirao && !externalEnabled,
      statsObservedAt: meaningful ? statsObservedAt : null,
      statsHealth,
      statsFallback: statsFallbacks.length ? statsFallbacks[statsFallbacks.length - 1] : null,
      statsFallbacks,
      statsFallbackError: Object.values(statsFallbackErrors).filter(Boolean).join(' | '),
      statsFallbackErrors,
      apiFootballBudget: apiAllowed ? {
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
  LIVE_FACTS_CONTRACT_VERSION: LIVE_FACTS_CONSTANTS.LIVE_FACTS_CONTRACT_VERSION,
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
