const SITE_ROOT = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const SITE_V3_ROOT = 'https://site.api.espn.com/apis/site/v3/sports/soccer';
const SITE_WEB_ROOT = 'https://site.web.api.espn.com/apis/site/v2/sports/soccer';
const CDN_ROOT = 'https://cdn.espn.com/core';
const CORE_ROOT = 'https://sports.core.api.espn.com/v2/sports/soccer/leagues';
const FETCH_TIMEOUT_MS = 10_000;
const LIVE_FETCH_TIMEOUT_MS = 3_500;
const SCORER_ENRICH_TIMEOUT_MS = 2_500;
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

function scorerNameHint(item) {
  const involved = Array.isArray(item?.athletesInvolved) ? item.athletesInvolved : [];
  const participants = Array.isArray(item?.participants) ? item.participants : [];
  const participant = participants.find((entry) => entry?.athlete || entry?.player) || participants[0] || null;
  const athlete = involved[0] || item?.athlete || item?.player || participant?.athlete || participant?.player || participant || null;
  const structured = text(athlete?.shortName || athlete?.displayName || athlete?.fullName || athlete?.name);
  if (structured) return structured;
  const narrative = text([item?.text, item?.description, item?.shortText, item?.headline, item?.title].filter(Boolean).join(' '));
  if (!narrative) return '';
  const match = narrative.match(/(?:goal scored by|scored by|goal by|gol de|gol do|gol da|marcado por)\s+([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,4})/iu)
    || narrative.match(/(?:^|[.!?]\s+)([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,4})\s*\([^)]{1,80}\)/u);
  return text(match?.[1]);
}

export function summaryNamedScorerHintCount(summary) {
  if (!summary || typeof summary !== 'object') return 0;
  const primary = Array.isArray(summary.scoringPlays) ? summary.scoringPlays : [];
  const source = primary.length ? primary : (Array.isArray(summary.plays) ? summary.plays.filter(looksLikeGoal) : []);
  return source.filter((item) => looksLikeGoal(item) && scorerNameHint(item)).length;
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
  // A ESPN ocasionalmente publica state=post antes da conclusão efetiva.
  // completed=true é o único sinal que pode superar um feed concorrente IN.
  if (type?.completed === true) return 3;
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

function unwrapSummaryLoose(payload) {
  const candidates = [
    payload?.gamepackageJSON,
    payload?.content?.gamepackageJSON,
    payload?.content,
    payload
  ].filter(Boolean);
  const useful = (candidate) => Boolean(
    candidate && typeof candidate === 'object' && (
      candidate.header || candidate.gameInfo || candidate.boxscore || candidate.rosters || candidate.lineups ||
      Array.isArray(candidate.plays) || Array.isArray(candidate.scoringPlays)
    )
  );
  for (const candidate of candidates) if (useful(candidate)) return candidate;
  for (const candidate of walkObjects(payload, 5)) if (useful(candidate)) return candidate;
  throw new Error('payload de jogo sem conteúdo útil');
}

function summaryGatewayCandidates(league, eventId) {
  const qLeague = encodeURIComponent(league);
  const qEvent = encodeURIComponent(eventId);
  return [
    {
      name: 'espn_cdn_league_game',
      url: `${CDN_ROOT}/${qLeague}/game?xhr=1&gameId=${qEvent}`,
      transform: unwrapSummaryLoose
    },
    {
      name: 'espn_cdn_league_boxscore',
      url: `${CDN_ROOT}/${qLeague}/boxscore?xhr=1&gameId=${qEvent}`,
      transform: unwrapSummaryLoose
    },
    {
      name: 'espn_cdn_league_playbyplay',
      url: `${CDN_ROOT}/${qLeague}/playbyplay?xhr=1&gameId=${qEvent}`,
      transform: unwrapSummary
    },
    {
      name: 'espn_cdn_soccer_game',
      url: `${CDN_ROOT}/soccer/game?xhr=1&league=${qLeague}&gameId=${qEvent}`,
      transform: unwrapSummaryLoose
    },
    {
      name: 'espn_cdn_soccer_boxscore',
      url: `${CDN_ROOT}/soccer/boxscore?xhr=1&league=${qLeague}&gameId=${qEvent}`,
      transform: unwrapSummaryLoose
    },
    {
      name: 'espn_cdn_soccer_playbyplay',
      url: `${CDN_ROOT}/soccer/playbyplay?xhr=1&league=${qLeague}&gameId=${qEvent}`,
      transform: unwrapSummary
    },
    {
      name: 'espn_site_api_summary',
      url: `${SITE_ROOT}/${qLeague}/summary?event=${qEvent}`,
      transform: unwrapSummaryLoose
    },
    {
      name: 'espn_site_api_v3_summary',
      url: `${SITE_V3_ROOT}/${qLeague}/summary?event=${qEvent}`,
      transform: unwrapSummaryLoose
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

function scorerEnrichmentCandidates(league, eventId) {
  const qLeague = encodeURIComponent(league);
  const qEvent = encodeURIComponent(eventId);
  // Os três feeds abaixo complementam os feeds ao-vivo já consultados
  // (league play-by-play, soccer play-by-play e CORE plays). Assim evitamos
  // repetir requests e ganhamos novas superfícies onde a ESPN costuma publicar
  // o atleta antes/de forma mais completa.
  return [
    {
      name: 'espn_cdn_league_game',
      url: `${CDN_ROOT}/${qLeague}/game?xhr=1&gameId=${qEvent}`,
      transform: unwrapSummary
    },
    {
      name: 'espn_cdn_soccer_game',
      url: `${CDN_ROOT}/soccer/game?xhr=1&league=${qLeague}&gameId=${qEvent}`,
      transform: unwrapSummary
    },
    {
      name: 'espn_site_api_summary',
      url: `${SITE_ROOT}/${qLeague}/summary?event=${qEvent}`,
      transform: unwrapSummary
    }
  ];
}

async function parallelSuccessful(candidates, fetchImpl = globalThis.fetch, timeoutMs = LIVE_FETCH_TIMEOUT_MS) {
  const attempts = [];
  const successful = [];
  await Promise.all(candidates.map(async (candidate) => {
    const startedAt = Date.now();
    try {
      const raw = await fetchJson(withBust(candidate.url), fetchImpl, timeoutMs);
      const data = (candidate.transform || unwrapSummary)(raw);
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
  attempts.sort((a, b) => candidates.findIndex((c) => c.name === a.source) - candidates.findIndex((c) => c.name === b.source));
  successful.sort((a, b) => {
    const goalDiff = summaryGoalCount(b.data) - summaryGoalCount(a.data);
    if (goalDiff) return goalDiff;
    const scorerDiff = summaryNamedScorerHintCount(b.data) - summaryNamedScorerHintCount(a.data);
    if (scorerDiff) return scorerDiff;
    const ac = Array.isArray(a.data?.plays) ? a.data.plays.length : Array.isArray(a.data?.scoringPlays) ? a.data.scoringPlays.length : 0;
    const bc = Array.isArray(b.data?.plays) ? b.data.plays.length : Array.isArray(b.data?.scoringPlays) ? b.data.scoringPlays.length : 0;
    if (bc !== ac) return bc - ac;
    return candidates.findIndex((c) => c.name === a.source) - candidates.findIndex((c) => c.name === b.source);
  });
  return { successful, attempts };
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


export async function fetchEspnScoreboardGateway(league, dates, fetchImpl = globalThis.fetch) {
  if (!ALLOWED_LEAGUES.includes(league)) throw new Error(`liga ESPN não permitida: ${league}`);
  const qLeague = encodeURIComponent(league);
  const qDates = encodeURIComponent(dates);
  const candidates = [
    ...scoreboardFreshCandidates(league, dates),
    {
      name: 'espn_site_api',
      url: `${SITE_ROOT}/${qLeague}/scoreboard?dates=${qDates}&limit=100`
    }
  ];
  const attempts = [];
  const successful = [];

  await Promise.all(candidates.map(async (candidate) => {
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

  attempts.sort((a, b) => candidates.findIndex((c) => c.name === a.source) - candidates.findIndex((c) => c.name === b.source));
  if (!successful.length) {
    const error = new Error(attempts.map((item) => `${item.source}: ${item.error}`).join(' | ') || 'scoreboard ESPN indisponível');
    error.attempts = attempts;
    throw error;
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
    source: successful.length > 1 ? 'espn_gateway_merge' : successful[0].source,
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
  // R9: consulta os dois CDNs e o CORE em paralelo. Antes o CORE só era usado
  // quando ambos os CDNs falhavam, embora frequentemente seja justamente ele
  // quem traga athletesInvolved/nome do marcador primeiro.
  const { successful, attempts } = await parallelSuccessful(candidates, fetchImpl, LIVE_FETCH_TIMEOUT_MS);
  if (!successful.length) {
    const error = new Error(attempts.map((item) => `${item.source}: ${item.error}`).join(' | ') || 'play-by-play ao vivo indisponível');
    error.attempts = attempts;
    throw error;
  }
  return {
    ok: true,
    source: successful[0].source,
    data: successful[0].data,
    variants: successful.map((item) => ({ source: item.source, data: item.data })),
    attempts
  };
}

export async function fetchEspnScorerEnrichment(league, eventId, fetchImpl = globalThis.fetch, expectedGoals = 0) {
  if (!ALLOWED_LEAGUES.includes(league)) throw new Error(`liga ESPN não permitida: ${league}`);
  if (!text(eventId)) throw new Error('eventId ausente');
  const minimumGoals = Math.max(0, Number(expectedGoals) || 0);
  const candidates = scorerEnrichmentCandidates(league, eventId);
  const { successful, attempts } = await parallelSuccessful(candidates, fetchImpl, SCORER_ENRICH_TIMEOUT_MS);
  const usable = successful.filter((item) => summaryGoalCount(item.data) > 0);
  if (!usable.length) {
    const error = new Error(attempts.map((item) => `${item.source}: ${item.error || 'sem gols'}`).join(' | ') || 'enriquecimento de autoria indisponível');
    error.attempts = attempts;
    throw error;
  }
  // Não exigimos que uma fonte isolada tenha TODOS os gols: o objetivo desta
  // chamada é complementar os feeds ao vivo e a fusão semântica é feita depois.
  // Ainda assim, priorizamos feeds com cobertura de placar e autoria mais completas.
  usable.sort((a, b) => {
    const aGoals = summaryGoalCount(a.data);
    const bGoals = summaryGoalCount(b.data);
    const aCoverage = minimumGoals > 0 && aGoals >= minimumGoals ? 1 : 0;
    const bCoverage = minimumGoals > 0 && bGoals >= minimumGoals ? 1 : 0;
    if (bCoverage !== aCoverage) return bCoverage - aCoverage;
    const scorerDiff = summaryNamedScorerHintCount(b.data) - summaryNamedScorerHintCount(a.data);
    if (scorerDiff) return scorerDiff;
    return bGoals - aGoals;
  });
  return {
    ok: true,
    source: usable[0].source,
    data: usable[0].data,
    variants: usable.map((item) => ({ source: item.source, data: item.data })),
    attempts
  };
}

export async function fetchEspnTechnicalScoreboard(league, dates, fetchImpl = globalThis.fetch) {
  const qLeague = text(league);
  const qDates = text(dates);
  if (!qLeague || !qDates) throw new Error('liga/data técnica ausente');
  const attempts = [];
  const successful = [];
  await Promise.all(scoreboardFreshCandidates(qLeague, qDates).map(async (candidate) => {
    const startedAt = Date.now();
    try {
      const raw = await fetchJson(withBust(candidate.url), fetchImpl, LIVE_FETCH_TIMEOUT_MS);
      const data = unwrapScoreboard(raw);
      successful.push({ source: candidate.name, data });
      attempts.push({ source: candidate.name, ok: true, durationMs: Date.now() - startedAt });
    } catch (error) {
      attempts.push({ source: candidate.name, ok: false, durationMs: Date.now() - startedAt, error: text(error?.message || error).slice(0, 240) });
    }
  }));
  if (!successful.length) {
    const fallback = await firstSuccessful(scoreboardCandidates(qLeague, qDates), unwrapScoreboard, fetchImpl);
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

export async function fetchEspnTechnicalLivePlays(league, eventId, fetchImpl = globalThis.fetch) {
  const qLeague = text(league);
  const qEvent = text(eventId);
  if (!qLeague || !qEvent) throw new Error('liga/eventId técnico ausente');
  const candidates = livePlayCandidates(qLeague, qEvent);
  const attempts = [];
  const successful = [];
  await Promise.all(candidates.slice(0, 3).map(async (candidate) => {
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
  if (!successful.length) {
    const error = new Error(attempts.map((item) => `${item.source}: ${item.error}`).join(' | ') || 'play-by-play técnico indisponível');
    error.attempts = attempts;
    throw error;
  }
  successful.sort((a, b) => {
    const goalDiff = summaryGoalCount(b.data) - summaryGoalCount(a.data);
    if (goalDiff) return goalDiff;
    const ac = Array.isArray(a.data?.plays) ? a.data.plays.length : Array.isArray(a.data?.scoringPlays) ? a.data.scoringPlays.length : 0;
    const bc = Array.isArray(b.data?.plays) ? b.data.plays.length : Array.isArray(b.data?.scoringPlays) ? b.data.scoringPlays.length : 0;
    return bc - ac;
  });
  return { ok: true, source: successful[0].source, data: successful[0].data, attempts };
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


function normalizeStatToken(value) {
  return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const STAT_TOKEN_ALIASES = new Map([
  ['possessionpct', 'possessionpct'], ['possessionpercent', 'possessionpct'], ['possessionpercentage', 'possessionpct'],
  ['totalshots', 'totalshots'], ['shots', 'totalshots'], ['shotattempts', 'totalshots'],
  ['shotsontarget', 'shotsontarget'], ['shotsongoal', 'shotsontarget'],
  ['blockedshots', 'blockedshots'],
  ['foulscommitted', 'foulscommitted'], ['fouls', 'foulscommitted'],
  ['saves', 'saves'], ['goalkeepersaves', 'saves'],
  ['woncorners', 'corners'], ['cornerkicks', 'corners'], ['corners', 'corners'],
  ['yellowcards', 'yellowcards'], ['redcards', 'redcards'], ['offsides', 'offsides'], ['offside', 'offsides'],
  ['totalpasses', 'totalpasses'], ['passes', 'totalpasses'],
  ['accuratepasses', 'accuratepasses'], ['completedpasses', 'accuratepasses'],
  ['passcompletionpct', 'passcompletionpct'], ['passpct', 'passcompletionpct'], ['passaccuracy', 'passcompletionpct'],
  ['clearances', 'clearances'], ['clearance', 'clearances'],
  ['tackleswon', 'tackleswon'], ['tackles', 'tackleswon'],
  ['interceptions', 'interceptions'], ['crosses', 'crosses'], ['totalcrosses', 'crosses']
]);

function rawStatToken(stat) {
  return normalizeStatToken(stat?.name || stat?.label || stat?.displayName || stat?.shortDisplayName || stat?.abbreviation);
}

function statToken(stat) {
  const raw = rawStatToken(stat);
  return STAT_TOKEN_ALIASES.get(raw) || raw;
}

function teamToken(entry) {
  const team = entry?.team || entry || {};
  const id = text(team?.id || entry?.teamId || entry?.id);
  if (id) return `id:${id}`;
  const name = normalizeStatToken(team?.displayName || team?.shortDisplayName || team?.name || team?.abbreviation || entry?.displayName || entry?.name);
  return name ? `name:${name}` : '';
}

function statValuePresent(stat) {
  return stat && (stat.displayValue != null || stat.value != null || stat.rawValue != null);
}

function statNumericValue(stat) {
  if (!statValuePresent(stat)) return NaN;
  const raw = stat.displayValue ?? stat.value ?? stat.rawValue;
  const match = text(raw).replace(',', '.').replace('%', '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : NaN;
}

function shouldReplaceStat(current, incoming) {
  if (!statValuePresent(current)) return statValuePresent(incoming);
  if (!statValuePresent(incoming)) return false;
  // Durante a transição pré-jogo -> ao vivo algumas superfícies ESPN mantêm
  // placeholders 0/0 enquanto outra superfície já publicou o valor real.
  // Zero nunca deve bloquear um valor ESPN não-zero do MESMO eventId/métrica.
  const currentValue = statNumericValue(current);
  const incomingValue = statNumericValue(incoming);
  if (Number.isFinite(currentValue) && Number.isFinite(incomingValue)) {
    // Só promovemos 0 -> não-zero quando a ESPN usa o MESMO identificador
    // de métrica. Aliases diferentes (ex.: wonCorners vs cornerKicks) podem
    // representar superfícies com semântica/atualização distintas e mantêm a
    // precedência da variante estatisticamente mais rica.
    const sameRawMetric = rawStatToken(current) === rawStatToken(incoming);
    if (sameRawMetric && currentValue === 0 && incomingValue !== 0) return true;
    if (currentValue !== 0 && incomingValue === 0) return false;
  }
  return false;
}

function mergeStatLists(primary = [], extras = []) {
  const out = [];
  const byKey = new Map();
  const absorb = (stat) => {
    if (!stat || typeof stat !== 'object') return;
    const key = statToken(stat);
    if (!key) return;
    const current = byKey.get(key);
    if (!current) {
      const copy = { ...stat };
      byKey.set(key, copy);
      out.push(copy);
      return;
    }
    if (shouldReplaceStat(current, stat)) Object.assign(current, stat);
  };
  for (const stat of Array.isArray(primary) ? primary : []) absorb(stat);
  for (const stat of Array.isArray(extras) ? extras : []) absorb(stat);
  return out;
}

function summaryTeamStatContainers(data) {
  const rows = [];
  const add = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    const statistics = Array.isArray(entry.statistics) ? entry.statistics : Array.isArray(entry.stats) ? entry.stats : [];
    if (!statistics.length) return;
    rows.push({ ...entry, statistics });
  };
  for (const entry of (Array.isArray(data?.boxscore?.teams) ? data.boxscore.teams : [])) add(entry);
  for (const competition of (Array.isArray(data?.header?.competitions) ? data.header.competitions : [])) {
    for (const competitor of (Array.isArray(competition?.competitors) ? competition.competitors : [])) add(competitor);
  }
  for (const competition of (Array.isArray(data?.competitions) ? data.competitions : [])) {
    for (const competitor of (Array.isArray(competition?.competitors) ? competition.competitors : [])) add(competitor);
  }
  return rows;
}

function summaryTeamStatCount(data) {
  const unique = new Set();
  let valued = 0;
  for (const entry of summaryTeamStatContainers(data)) {
    const team = teamToken(entry) || 'unknown';
    for (const stat of entry.statistics || []) {
      const key = statToken(stat);
      if (!key) continue;
      unique.add(`${team}:${key}`);
      if (statValuePresent(stat)) valued += 1;
    }
  }
  return { unique: unique.size, valued };
}

export function summaryTeamMetricCoverage(data) {
  const byTeam = new Map();
  for (const entry of summaryTeamStatContainers(data)) {
    const team = teamToken(entry) || `unknown:${byTeam.size}`;
    let row = byTeam.get(team);
    if (!row) {
      row = new Set();
      byTeam.set(team, row);
    }
    for (const stat of entry.statistics || []) {
      const key = statToken(stat);
      if (key && statValuePresent(stat)) row.add(key);
    }
  }
  const counts = [...byTeam.values()].map((row) => row.size);
  return {
    teams: counts.length,
    minPerTeam: counts.length ? Math.min(...counts) : 0,
    maxPerTeam: counts.length ? Math.max(...counts) : 0,
    totalUnique: counts.reduce((sum, count) => sum + count, 0)
  };
}

function mergeTeamStatisticsForPresentation(baseBoxscore, successful) {
  const base = baseBoxscore && typeof baseBoxscore === 'object' ? { ...baseBoxscore } : {};
  const teams = Array.isArray(baseBoxscore?.teams)
    ? baseBoxscore.teams.map((entry) => ({ ...entry, statistics: mergeStatLists(entry?.statistics || entry?.stats || [], []) }))
    : [];
  const byTeam = new Map();
  for (const entry of teams) {
    const key = teamToken(entry);
    if (key) byTeam.set(key, entry);
  }

  const ranked = [...successful].sort((a, b) => summaryPresentationScore(b.data) - summaryPresentationScore(a.data));
  for (const variant of ranked) {
    for (const entry of summaryTeamStatContainers(variant.data)) {
      const key = teamToken(entry);
      if (!key) continue;
      let target = byTeam.get(key);
      if (!target) {
        target = { ...entry, statistics: [] };
        delete target.stats;
        teams.push(target);
        byTeam.set(key, target);
      }
      target.statistics = mergeStatLists(target.statistics || target.stats || [], entry.statistics || entry.stats || []);
      if (!target.team && entry.team) target.team = entry.team;
      if (!target.homeAway && entry.homeAway) target.homeAway = entry.homeAway;
    }
  }
  if (teams.length) base.teams = teams;
  return base;
}

function summaryPresentationScore(data) {
  if (!data || typeof data !== 'object') return 0;
  let score = 0;
  const boxscoreTeams = Array.isArray(data?.boxscore?.teams) ? data.boxscore.teams.length : 0;
  const boxscorePlayers = Array.isArray(data?.boxscore?.players) ? data.boxscore.players.length : 0;
  const rosters = Array.isArray(data?.rosters) ? data.rosters.length : 0;
  const lineups = Array.isArray(data?.lineups) ? data.lineups.length : 0;
  const plays = Array.isArray(data?.plays) ? data.plays.length : 0;
  const scoring = Array.isArray(data?.scoringPlays) ? data.scoringPlays.length : 0;
  const statCoverage = summaryTeamStatCount(data);
  if (data.header && typeof data.header === 'object') score += 80;
  if (data.gameInfo && typeof data.gameInfo === 'object') score += 60;
  score += boxscoreTeams * 120;
  score += boxscorePlayers * 80;
  score += rosters * 80;
  score += lineups * 80;
  // A cardinalidade de estatísticas precisa pesar mais que a mera presença de
  // boxscore/rosters. Sem isso, um feed com escalações + 6 métricas podia vencer
  // outro feed ESPN com o boxscore estatístico muito mais completo.
  score += statCoverage.unique * 35;
  score += statCoverage.valued * 5;
  score += Math.min(plays, 200);
  score += Math.min(scoring * 4, 80);
  return score;
}

export function mergeExternalStatisticsIntoSummary(summary, externalData) {
  const merged = { ...(summary || {}) };
  merged.boxscore = mergeTeamStatisticsForPresentation(merged.boxscore, [{
    source: 'external_statistics',
    data: externalData || {}
  }]);
  return merged;
}

function mergeSummaryForPresentation(successful) {
  if (!Array.isArray(successful) || !successful.length) return {};
  const playBest = successful[0];
  const richBest = [...successful].sort((a, b) => summaryPresentationScore(b.data) - summaryPresentationScore(a.data))[0] || playBest;
  const merged = { ...(richBest.data || {}) };
  const playData = playBest.data || {};

  // O feed mais rápido/avançado de play-by-play é usado apenas para campos de
  // eventos. As demais seções partem do payload mais rico.
  for (const key of ['plays', 'scoringPlays', 'commentary', 'keyEvents']) {
    if (Array.isArray(playData[key]) && playData[key].length) merged[key] = playData[key];
  }
  if (!merged.header && playData.header) merged.header = playData.header;
  if (!merged.gameInfo && playData.gameInfo) merged.gameInfo = playData.gameInfo;
  if (!merged.rosters && playData.rosters) merged.rosters = playData.rosters;
  if (!merged.lineups && playData.lineups) merged.lineups = playData.lineups;

  // A identidade da partida (times/data/status) é necessária também para o
  // fallback estatístico. Se a variante mais rica for um boxscore puro, busca
  // o header em qualquer outra superfície ESPN bem-sucedida.
  if (!merged.header) {
    const withHeader = successful.find((item) => item?.data?.header);
    if (withHeader) merged.header = withHeader.data.header;
  }
  if (!merged.gameInfo) {
    const withGameInfo = successful.find((item) => item?.data?.gameInfo);
    if (withGameInfo) merged.gameInfo = withGameInfo.data.gameInfo;
  }

  // Estatísticas não pertencem a uma única superfície ESPN. O CDN de "game",
  // o endpoint dedicado de boxscore e o Site API podem ficar defasados entre si
  // durante a partida. Fundimos por time + nome canônico da métrica, sem inventar
  // valores e sem apagar uma estatística válida só porque outra fonte veio menor.
  merged.boxscore = mergeTeamStatisticsForPresentation(merged.boxscore, successful);
  return merged;
}

export async function fetchEspnSummaryGateway(league, eventId, fetchImpl = globalThis.fetch, expectedGoals = 0) {
  if (!ALLOWED_LEAGUES.includes(league)) throw new Error(`liga ESPN não permitida: ${league}`);
  if (!text(eventId)) throw new Error('eventId ausente');
  const minimumGoals = Math.max(0, Number(expectedGoals) || 0);
  const candidates = summaryGatewayCandidates(league, eventId);
  const { successful, attempts } = await parallelSuccessful(candidates, fetchImpl, LIVE_FETCH_TIMEOUT_MS);
  if (!successful.length) {
    const error = new Error(attempts.map((item) => `${item.source}: ${item.error}`).join(' | ') || 'summary ESPN indisponível');
    error.attempts = attempts;
    throw error;
  }
  const best = successful[0];
  const data = mergeSummaryForPresentation(successful);
  const goals = summaryGoalCount(data);
  return {
    ok: true,
    source: best.source,
    sources: successful.map((item) => item.source),
    data,
    variants: successful.map((item) => ({ source: item.source, data: item.data })),
    attempts,
    expectedGoals: minimumGoals,
    goalCount: goals,
    complete: minimumGoals <= 0 || goals >= minimumGoals
  };
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
    sourceLayerVersion: '6-R9',
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
  SCORER_ENRICH_TIMEOUT_MS,
  ALLOWED_LEAGUES
});
