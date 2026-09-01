const SITE_ROOT = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const CDN_ROOT = 'https://cdn.espn.com/core';
const CORE_ROOT = 'https://sports.core.api.espn.com/v2/sports/soccer/leagues';
const FETCH_TIMEOUT_MS = 10_000;
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

async function fetchJson(url, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
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
    if (
      Array.isArray(candidate?.scoringPlays) || Array.isArray(candidate?.plays) ||
      Array.isArray(candidate?.rosters) || candidate?.boxscore || candidate?.header
    ) return candidate;
  }
  for (const candidate of walkObjects(payload, 4)) {
    if (Array.isArray(candidate?.scoringPlays) || Array.isArray(candidate?.plays)) return candidate;
  }
  throw new Error('payload de jogo sem dados utilizáveis');
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

function summaryCandidates(league, eventId) {
  const qLeague = encodeURIComponent(league);
  const qEvent = encodeURIComponent(eventId);
  return [
    {
      name: 'espn_cdn_soccer_game',
      url: `${CDN_ROOT}/soccer/game?xhr=1&league=${qLeague}&gameId=${qEvent}`,
      transform: unwrapSummary
    },
    {
      name: 'espn_cdn_league_game',
      url: `${CDN_ROOT}/${qLeague}/game?xhr=1&gameId=${qEvent}`,
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

async function firstSuccessful(candidates, transform, fetchImpl = globalThis.fetch) {
  const attempts = [];
  for (const candidate of candidates) {
    const startedAt = Date.now();
    try {
      const raw = await fetchJson(withBust(candidate.url), fetchImpl);
      const data = (candidate.transform || transform)(raw);
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

export async function fetchEspnSummary(league, eventId, fetchImpl = globalThis.fetch) {
  if (!ALLOWED_LEAGUES.includes(league)) throw new Error(`liga ESPN não permitida: ${league}`);
  if (!text(eventId)) throw new Error('eventId ausente');
  return firstSuccessful(summaryCandidates(league, eventId), unwrapSummary, fetchImpl);
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
    sourceLayerVersion: '6-R1',
    checkedAt: new Date().toISOString(),
    failed,
    leagues
  };
}

export const ESPN_SOURCE_CONSTANTS = Object.freeze({
  SITE_ROOT,
  CDN_ROOT,
  CORE_ROOT,
  FETCH_TIMEOUT_MS,
  ALLOWED_LEAGUES
});
