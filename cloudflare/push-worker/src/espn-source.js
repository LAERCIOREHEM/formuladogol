const SITE_ROOT = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const SITE_WEB_ROOT = 'https://site.web.api.espn.com/apis/site/v2/sports/soccer';
const CDN_ROOT = 'https://cdn.espn.com/core';
const CORE_ROOT = 'https://sports.core.api.espn.com/v2/sports/soccer/leagues';
const FETCH_TIMEOUT_MS = 10_000;
const LIVE_FETCH_TIMEOUT_MS = 3_500;
const ALLOWED_LEAGUES = Object.freeze([
  'bra.1',
  'bra.copa_do_brazil',
  'conmebol.libertadores',
  'conmebol.sudamericana'
]);

function text(value) { return String(value == null ? '' : value).trim(); }

function requestHeaders() {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    referer: 'https://www.espn.com/',
    'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
  };
}

async function fetchJson(url, fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || FETCH_TIMEOUT_MS));
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: requestHeaders(),
      cf: { cacheTtl: 0, cacheEverything: false }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} em ${new URL(url).hostname}`);
    const contentType = text(response.headers?.get?.('content-type')).toLowerCase();
    if (contentType && !contentType.includes('json') && !contentType.includes('javascript')) {
      throw new Error(`resposta não JSON de ${new URL(url).hostname}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function walkObjects(root, maxDepth = 5) {
  const out = [];
  const queue = [{ value: root, depth: 0 }];
  const seen = new Set();
  while (queue.length) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (depth >= maxDepth) continue;
    if (Array.isArray(value)) {
      for (const child of value.slice(0, 50)) queue.push({ value: child, depth: depth + 1 });
    } else {
      for (const child of Object.values(value)) {
        if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return out;
}

export function unwrapScoreboard(payload) {
  if (Array.isArray(payload?.events)) return { events: payload.events };
  const preferred = [payload?.content, payload?.scoreboard, payload?.gamepackageJSON, payload?.content?.scoreboard];
  for (const candidate of preferred) {
    if (Array.isArray(candidate?.events)) return { ...candidate, events: candidate.events };
  }
  for (const candidate of walkObjects(payload, 4)) {
    if (Array.isArray(candidate?.events)) return { ...candidate, events: candidate.events };
  }
  throw new Error('payload de scoreboard sem events[]');
}

export function unwrapSummary(payload) {
  const candidates = [
    payload?.gamepackageJSON,
    payload?.content?.gamepackageJSON,
    payload?.content,
    payload
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (Array.isArray(candidate?.scoringPlays) || Array.isArray(candidate?.plays)) return candidate;
  }
  for (const candidate of walkObjects(payload, 6)) {
    if (Array.isArray(candidate?.scoringPlays) || Array.isArray(candidate?.plays)) return candidate;
  }
  throw new Error('payload de jogo sem plays/scoringPlays');
}

function goalDescriptor(item) {
  return text([
    item?.type?.text, item?.type?.name, item?.type?.description,
    item?.text, item?.shortText, item?.description
  ].filter(Boolean).join(' ')).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function looksLikeGoal(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.scoringPlay === true) return true;
  return /(^|[^a-z])(goal|gol)([^a-z]|$)/.test(goalDescriptor(item));
}

export function summaryGoalCount(summary) {
  if (!summary || typeof summary !== 'object') return 0;
  const primary = Array.isArray(summary.scoringPlays) ? summary.scoringPlays : [];
  if (primary.length) return primary.filter(looksLikeGoal).length;
  const plays = Array.isArray(summary.plays) ? summary.plays : [];
  return plays.filter(looksLikeGoal).length;
}

function withBust(url) {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}_fdg=${Date.now()}`;
}

function scoreboardCandidates(league, dates) {
  const qLeague = encodeURIComponent(league);
  const qDates = encodeURIComponent(dates);
  return [
    {
      name: 'espn_cdn_soccer',
      url: `${CDN_ROOT}/soccer/scoreboard?xhr=1&league=${qLeague}&dates=${qDates}&limit=100`
    },
    {
      name: 'espn_cdn_league',
      url: `${CDN_ROOT}/${qLeague}/scoreboard?xhr=1&dates=${qDates}&limit=100`
    },
    {
      name: 'espn_site_api',
      url: `${SITE_ROOT}/${qLeague}/scoreboard?dates=${qDates}&limit=100`
    }
  ];
}

function scoreboardFreshCandidates(league, dates) {
  const qLeague = encodeURIComponent(league);
  const qDates = encodeURIComponent(dates);
  return [
    {
      name: 'espn_cdn_league',
      url: `${CDN_ROOT}/${qLeague}/scoreboard?xhr=1&dates=${qDates}&limit=100`
    },
    {
      name: 'espn_cdn_soccer',
      url: `${CDN_ROOT}/soccer/scoreboard?xhr=1&league=${qLeague}&dates=${qDates}&limit=100`
    },
    {
      name: 'espn_site_web_api',
      url: `${SITE_WEB_ROOT}/${qLeague}/scoreboard?dates=${qDates}&limit=100`
    }
  ];
}

function livePlayCandidates(league, eventId) {
  const qLeague = encodeURIComponent(league);
  const qEvent = encodeURIComponent(eventId);
  return [
    {
      name: 'espn_cdn_league_playbyplay',
      url: `${CDN_ROOT}/${qLeague}/playbyplay?xhr=1&gameId=${qEvent}`,
      transform: unwrapSummary
    },
    {
      name: 'espn_cdn_soccer_playbyplay',
      url: `${CDN_ROOT}/soccer/playbyplay?xhr=1&league=${qLeague}&gameId=${qEvent}`,
      transform: unwrapSummary
    },
    {
      name: 'espn_core_plays',
      url: `${CORE_ROOT}/${qLeague}/events/${qEvent}/competitions/${qEvent}/plays?limit=300&lang=pt&region=br`,
      transform: (payload) => {
        const plays = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.plays) ? payload.plays : [];
        if (!plays.length) throw new Error('core plays sem itens');
        return { plays };
      }
    }
  ];
}

function eventIdOf(event) {
  return text(event?.id || event?.competitions?.[0]?.id || event?.competition?.id);
}

function eventClockNumber(event) {
  const competition = event?.competitions?.[0] || event?.competition || {};
  const status = event?.status || competition?.status || {};
  const raw = text(status?.displayClock || status?.type?.shortDetail || status?.type?.detail);
  const match = raw.match(/(\d{1,3})(?:\s*\+\s*(\d+))?/);
  if (!match) return -1;
  return Number(match[1] || 0) * 100 + Number(match[2] || 0);
}

function eventPeriod(event) {
  const competition = event?.competitions?.[0] || event?.competition || {};
  const status = event?.status || competition?.status || {};
  return Number(status?.period || competition?.period || 0) || 0;
}

function eventStateRank(event) {
  const competition = event?.competitions?.[0] || event?.competition || {};
  const status = event?.status || competition?.status || {};
  const type = status?.type || {};
  const state = text(type?.state).toLowerCase();
  if (type?.completed === true || state === 'post') return 3;
  if (state === 'in') return 2;
  return 1;
}

function eventScoreTotal(event) {
  const competition = event?.competitions?.[0] || event?.competition || {};
  const competitors = Array.isArray(competition?.competitors) ? competition.competitors : [];
  return competitors.reduce((sum, competitor) => {
    const raw = competitor?.score?.value ?? competitor?.score?.displayValue ?? competitor?.score;
    const value = Number(raw);
    return sum + (Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
}

function fresherEvent(candidate, current) {
  if (!current) return true;
  const candidateState = eventStateRank(candidate);
  const currentState = eventStateRank(current);
  if (candidateState !== currentState) return candidateState > currentState;
  const candidatePeriod = eventPeriod(candidate);
  const currentPeriod = eventPeriod(current);
  if (candidatePeriod !== currentPeriod) return candidatePeriod > currentPeriod;
  const candidateClock = eventClockNumber(candidate);
  const currentClock = eventClockNumber(current);
  if (candidateClock !== currentClock) return candidateClock > currentClock;
  const candidateScore = eventScoreTotal(candidate);
  const currentScore = eventScoreTotal(current);
  if (candidateScore !== currentScore) return candidateScore > currentScore;
  return false;
}

function summaryCandidates(league, eventId) {
  const qLeague = encodeURIComponent(league);
  const qEvent = encodeURIComponent(eventId);
  return [
    {
      name: 'espn_cdn_league_game',
      url: `${CDN_ROOT}/${qLeague}/game?xhr=1&gameId=${qEvent}`,
      transform: unwrapSummary
    },
    {
      name: 'espn_cdn_league_playbyplay',
      url: `${CDN_ROOT}/${qLeague}/playbyplay?xhr=1&gameId=${qEvent}`,
      transform: unwrapSummary
    },
    {
      name: 'espn_cdn_soccer_game',
      url: `${CDN_ROOT}/soccer/game?xhr=1&league=${qLeague}&gameId=${qEvent}`,
      transform: unwrapSummary
    },
    {
      name: 'espn_cdn_soccer_playbyplay',
      url: `${CDN_ROOT}/soccer/playbyplay?xhr=1&league=${qLeague}&gameId=${qEvent}`,
      transform: unwrapSummary
    },
    {
      name: 'espn_site_api_summary',
      url: `${SITE_ROOT}/${qLeague}/summary?event=${qEvent}`,
      transform: unwrapSummary
    },
    {
      name: 'espn_core_plays',
      url: `${CORE_ROOT}/${qLeague}/events/${qEvent}/competitions/${qEvent}/plays?limit=300&lang=pt&region=br`,
      transform: (payload) => {
        const plays = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.plays) ? payload.plays : [];
        if (!plays.length) throw new Error('core plays sem itens');
        return { plays };
      }
    }
  ];
}

async function firstSuccessful(candidates, transform, fetchImpl = globalThis.fetch, validate = null) {
  const attempts = [];
  for (const candidate of candidates) {
    const startedAt = Date.now();
    try {
      const raw = await fetchJson(withBust(candidate.url), fetchImpl);
      const data = (candidate.transform || transform)(raw);
      if (validate) validate(data, candidate.name);
      return {
        ok: true,
        source: candidate.name,
        data,
        attempts: [...attempts, { source: candidate.name, ok: true, durationMs: Date.now() - startedAt }]
      };
    } catch (error) {
      attempts.push({
        source: candidate.name,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: text(error?.message || error).slice(0, 240)
      });
    }
  }
  const detail = attempts.map((item) => `${item.source}: ${item.error}`).join(' | ');
  const error = new Error(detail || 'nenhuma fonte ESPN respondeu');
  error.attempts = attempts;
  throw error;
}

export async function fetchEspnScoreboard(league, dates, fetchImpl = globalThis.fetch) {
  if (!ALLOWED_LEAGUES.includes(league)) throw new Error(`liga ESPN não permitida: ${league}`);
  return firstSuccessful(scoreboardCandidates(league, dates), unwrapScoreboard, fetchImpl);
}

export async function fetchEspnScoreboardFresh(league, dates, fetchImpl = globalThis.fetch) {
  if (!ALLOWED_LEAGUES.includes(league)) throw new Error(`liga ESPN não permitida: ${league}`);
  const attempts = [];
  const successful = [];
  await Promise.all(scoreboardFreshCandidates(league, dates).map(async (candidate) => {
    const startedAt = Date.now();
    try {
      const raw = await fetchJson(withBust(candidate.url), fetchImpl, LIVE_FETCH_TIMEOUT_MS);
      const data = unwrapScoreboard(raw);
      successful.push({ source: candidate.name, data });
      attempts.push({ source: candidate.name, ok: true, durationMs: Date.now() - startedAt });
    } catch (error) {
      attempts.push({
        source: candidate.name,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: text(error?.message || error).slice(0, 240)
      });
    }
  }));
  if (!successful.length) {
    const fallback = await fetchEspnScoreboard(league, dates, fetchImpl);
    return { ...fallback, selectedSources: {}, source: fallback.source };
  }

  const merged = new Map();
  const selectedSources = {};
  for (const result of successful) {
    for (const event of result.data?.events || []) {
      const id = eventIdOf(event);
      if (!id) continue;
      const current = merged.get(id);
      if (fresherEvent(event, current)) {
        merged.set(id, event);
        selectedSources[id] = result.source;
      }
    }
  }
  return {
    ok: true,
    source: successful.length > 1 ? 'espn_freshest_merge' : successful[0].source,
    sources: successful.map((item) => item.source),
    selectedSources,
    data: { events: [...merged.values()] },
    attempts
  };
}

export async function fetchEspnLivePlays(league, eventId, fetchImpl = globalThis.fetch) {
  if (!ALLOWED_LEAGUES.includes(league)) throw new Error(`liga ESPN não permitida: ${league}`);
  if (!text(eventId)) throw new Error('eventId ausente');
  const candidates = livePlayCandidates(league, eventId);
  const primary = candidates.slice(0, 2);
  const attempts = [];
  const successful = [];
  await Promise.all(primary.map(async (candidate) => {
    const startedAt = Date.now();
    try {
      const raw = await fetchJson(withBust(candidate.url), fetchImpl, LIVE_FETCH_TIMEOUT_MS);
      const data = (candidate.transform || unwrapSummary)(raw);
      successful.push({ source: candidate.name, data });
      attempts.push({ source: candidate.name, ok: true, durationMs: Date.now() - startedAt });
    } catch (error) {
      attempts.push({ source: candidate.name, ok: false, durationMs: Date.now() - startedAt, error: text(error?.message || error).slice(0, 240) });
    }
  }));
  if (successful.length) {
    successful.sort((a, b) => {
      const goalDiff = summaryGoalCount(b.data) - summaryGoalCount(a.data);
      if (goalDiff) return goalDiff;
      const aCount = (Array.isArray(a.data?.scoringPlays) ? a.data.scoringPlays.length : Array.isArray(a.data?.plays) ? a.data.plays.length : 0);
      const bCount = (Array.isArray(b.data?.scoringPlays) ? b.data.scoringPlays.length : Array.isArray(b.data?.plays) ? b.data.plays.length : 0);
      return bCount - aCount;
    });
    return { ok: true, source: successful[0].source, data: successful[0].data, attempts };
  }
  const fallback = await firstSuccessful(candidates.slice(2), unwrapSummary, fetchImpl);
  return { ...fallback, attempts: [...attempts, ...(fallback.attempts || [])] };
}

export async function fetchEspnTechnicalHotTestPlays(eventId, fetchImpl = globalThis.fetch) {
  const league = 'ita.coppa_italia';
  const qEvent = encodeURIComponent(text(eventId));
  if (!qEvent) throw new Error('eventId ausente');
  const candidates = [
    {
      name: 'espn_core_plays',
      url: `${CORE_ROOT}/${league}/events/${qEvent}/competitions/${qEvent}/plays?limit=300&lang=pt&region=br`,
      transform: (payload) => {
        const plays = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.plays) ? payload.plays : [];
        if (!plays.length) throw new Error('core plays sem itens');
        return { plays };
      }
    },
    {
      name: 'espn_cdn_league_playbyplay',
      url: `${CDN_ROOT}/${league}/playbyplay?xhr=1&gameId=${qEvent}`,
      transform: unwrapSummary
    },
    {
      name: 'espn_cdn_soccer_playbyplay',
      url: `${CDN_ROOT}/soccer/playbyplay?xhr=1&league=${league}&gameId=${qEvent}`,
      transform: unwrapSummary
    }
  ];
  return firstSuccessful(candidates, unwrapSummary, fetchImpl);
}

export async function fetchEspnSummary(league, eventId, fetchImpl = globalThis.fetch, expectedGoals = 0) {
  if (!ALLOWED_LEAGUES.includes(league)) throw new Error(`liga ESPN não permitida: ${league}`);
  if (!text(eventId)) throw new Error('eventId ausente');
  const minimumGoals = Math.max(0, Number(expectedGoals) || 0);
  return firstSuccessful(
    summaryCandidates(league, eventId),
    unwrapSummary,
    fetchImpl,
    (data, source) => {
      if (minimumGoals <= 0) return;
      const found = summaryGoalCount(data);
      if (found < minimumGoals) throw new Error(`${source}: summary incompleto (${found}/${minimumGoals} gols)`);
    }
  );
}

export async function probeEspnSources(fetchImpl = globalThis.fetch, dateKey = '') {
  const today = dateKey || new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date()).replaceAll('-', '');
  const leagues = {};
  for (const league of ALLOWED_LEAGUES) {
    try {
      const result = await fetchEspnScoreboard(league, today, fetchImpl);
      leagues[league] = {
        ok: true,
        source: result.source,
        eventCount: Array.isArray(result.data?.events) ? result.data.events.length : 0,
        attempts: result.attempts
      };
    } catch (error) {
      leagues[league] = { ok: false, source: '', eventCount: 0, attempts: error?.attempts || [], error: text(error?.message || error) };
    }
  }
  const failed = Object.entries(leagues).filter(([, item]) => !item.ok).map(([league]) => league);
  return {
    ok: failed.length === 0,
    sourceLayerVersion: '6-R3',
    checkedAt: new Date().toISOString(),
    failed,
    leagues
  };
}

export const ESPN_SOURCE_CONSTANTS = Object.freeze({
  SITE_ROOT,
  SITE_WEB_ROOT,
  CDN_ROOT,
  CORE_ROOT,
  FETCH_TIMEOUT_MS,
  LIVE_FETCH_TIMEOUT_MS,
  ALLOWED_LEAGUES
});
