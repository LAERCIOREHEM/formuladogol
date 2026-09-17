const API_FOOTBALL_ROOT = 'https://v3.football.api-sports.io';
const FETCH_TIMEOUT_MS = 4_500;
const TIMEZONE = 'America/Sao_Paulo';

function text(value) { return String(value == null ? '' : value).trim(); }
function finiteNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeToken(value) {
  return text(value)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(football club|futebol clube|futbol club|club de futbol|clube de futebol)\b/g, ' ')
    .replace(/\b(fc|cf|sc|ac|ec|afc|cfc|cr|se)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameSimilarity(left, right) {
  const a = normalizeToken(left);
  const b = normalizeToken(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ac = a.replace(/\s+/g, '');
  const bc = b.replace(/\s+/g, '');
  if (ac === bc) return 1;
  if ((ac.length >= 5 && bc.includes(ac)) || (bc.length >= 5 && ac.includes(bc))) return 0.94;
  const aa = new Set(a.split(' ').filter((part) => part.length >= 2));
  const bb = new Set(b.split(' ').filter((part) => part.length >= 2));
  const union = new Set([...aa, ...bb]);
  let intersection = 0;
  for (const part of aa) if (bb.has(part)) intersection += 1;
  return union.size ? intersection / union.size : 0;
}

function competitionOf(summary) {
  return summary?.header?.competitions?.[0]
    || summary?.competitions?.[0]
    || summary?.competition
    || null;
}

function teamName(team) {
  return text(team?.displayName || team?.shortDisplayName || team?.name || team?.abbreviation || team?.location);
}

function extractEspnIdentity(summary, now = Date.now()) {
  const competition = competitionOf(summary) || {};
  const competitors = Array.isArray(competition?.competitors) ? competition.competitors : [];
  let home = competitors.find((entry) => text(entry?.homeAway).toLowerCase() === 'home') || null;
  let away = competitors.find((entry) => text(entry?.homeAway).toLowerCase() === 'away') || null;

  if (!home || !away) {
    const teams = Array.isArray(summary?.boxscore?.teams) ? summary.boxscore.teams : [];
    home ||= teams.find((entry) => text(entry?.homeAway).toLowerCase() === 'home') || teams[0] || null;
    away ||= teams.find((entry) => text(entry?.homeAway).toLowerCase() === 'away') || teams[1] || null;
  }

  const homeTeam = home?.team || home || {};
  const awayTeam = away?.team || away || {};
  const homeName = teamName(homeTeam);
  const awayName = teamName(awayTeam);
  if (!homeName || !awayName) return null;

  const rawDate = text(competition?.date || summary?.header?.date || summary?.gameInfo?.date);
  const parsed = rawDate ? Date.parse(rawDate) : NaN;
  const timestamp = Number.isFinite(parsed) ? parsed : Number(now) || Date.now();
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(timestamp));

  return {
    date,
    home: {
      id: text(homeTeam?.id || home?.teamId || home?.id),
      name: homeName,
      abbreviation: text(homeTeam?.abbreviation)
    },
    away: {
      id: text(awayTeam?.id || away?.teamId || away?.id),
      name: awayName,
      abbreviation: text(awayTeam?.abbreviation)
    }
  };
}

function apiHeaders(apiKey) {
  return { accept: 'application/json', 'x-apisports-key': text(apiKey) };
}

function rateLimitFromHeaders(headers) {
  return {
    dailyLimit: finiteNumber(headers?.get?.('x-ratelimit-requests-limit')),
    dailyRemaining: finiteNumber(headers?.get?.('x-ratelimit-requests-remaining')),
    minuteLimit: finiteNumber(headers?.get?.('x-ratelimit-limit')),
    minuteRemaining: finiteNumber(headers?.get?.('x-ratelimit-remaining'))
  };
}

async function fetchApiJson(path, apiKey, fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS) {
  if (!text(apiKey)) throw new Error('API_FOOTBALL_KEY ausente');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || FETCH_TIMEOUT_MS));
  try {
    const response = await fetchImpl(`${API_FOOTBALL_ROOT}${path}`, {
      headers: apiHeaders(apiKey),
      signal: controller.signal,
      cf: { cacheTtl: 0, cacheEverything: false }
    });
    if (!response.ok) throw new Error(`API-Football HTTP ${response.status}`);
    const payload = await response.json();
    const errors = payload?.errors;
    if (Array.isArray(errors) && errors.length) throw new Error(`API-Football: ${errors.join(' | ')}`);
    if (errors && typeof errors === 'object' && Object.keys(errors).length) {
      throw new Error(`API-Football: ${Object.values(errors).join(' | ')}`);
    }
    return { payload, rateLimit: rateLimitFromHeaders(response.headers) };
  } finally {
    clearTimeout(timer);
  }
}

function fixturePairScore(row, identity) {
  const home = row?.teams?.home?.name;
  const away = row?.teams?.away?.name;
  const direct = nameSimilarity(home, identity.home.name) + nameSimilarity(away, identity.away.name);
  const swapped = nameSimilarity(home, identity.away.name) + nameSimilarity(away, identity.home.name);
  return { direct, swapped };
}

function selectFixture(rows, identity) {
  const candidates = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const fixtureId = Number(row?.fixture?.id);
    if (!Number.isFinite(fixtureId)) continue;
    const score = fixturePairScore(row, identity);
    candidates.push({ row, score: score.direct, swapped: score.swapped });
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < 1.55 || best.score <= best.swapped) return null;
  if (candidates[1] && Math.abs(best.score - candidates[1].score) < 0.08) return null;
  return best.row;
}

function attemptRate(source, ok, rateLimit, extra = {}) {
  return { source, ok, ...extra, rateLimit: rateLimit || null };
}

async function resolveApiFixture(identity, apiKey, fetchImpl) {
  const attempts = [];

  // A data da partida já vem da ESPN. Procurar primeiro pelo dia custa uma
  // requisição e evita a antiga sequência live=all + detalhe do fixture.
  const byDate = await fetchApiJson(`/fixtures?date=${encodeURIComponent(identity.date)}&timezone=${encodeURIComponent(TIMEZONE)}`, apiKey, fetchImpl)
    .then((result) => {
      attempts.push(attemptRate('api_football_date', true, result.rateLimit));
      return result.payload?.response || [];
    })
    .catch((error) => {
      attempts.push(attemptRate('api_football_date', false, null, { error: text(error?.message || error) }));
      return [];
    });
  const dateMatch = selectFixture(byDate, identity);
  if (dateMatch) return { fixture: dateMatch, attempts };

  // Contingência para diferenças de timezone/data da fonte.
  const live = await fetchApiJson(`/fixtures?live=all&timezone=${encodeURIComponent(TIMEZONE)}`, apiKey, fetchImpl)
    .then((result) => {
      attempts.push(attemptRate('api_football_live', true, result.rateLimit));
      return result.payload?.response || [];
    });
  const liveMatch = selectFixture(live, identity);
  if (!liveMatch) throw Object.assign(new Error(`API-Football não encontrou ${identity.home.name} x ${identity.away.name}`), { attempts });
  return { fixture: liveMatch, attempts };
}

function normalizeStatType(value) {
  return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const API_STAT_MAP = new Map([
  ['ball possession', 'possessionPct'],
  ['total shots', 'totalShots'],
  ['goal attempts', 'totalShots'],
  ['shots on goal', 'shotsOnTarget'],
  ['shots on target', 'shotsOnTarget'],
  ['blocked shots', 'blockedShots'],
  ['fouls', 'foulsCommitted'],
  ['goalkeeper saves', 'saves'],
  ['total passes', 'totalPasses'],
  ['passes accurate', 'accuratePasses'],
  ['accurate passes', 'accuratePasses'],
  ['passes', 'totalPasses'],
  ['passes %', 'passCompletionPct'],
  ['pass accuracy', 'passCompletionPct'],
  ['corner kicks', 'wonCorners'],
  ['yellow cards', 'yellowCards'],
  ['red cards', 'redCards'],
  ['offsides', 'offsides'],
  ['tackles', 'tackles'],
  ['interceptions', 'interceptions'],
  ['crosses', 'crosses'],
  ['clearances', 'clearances']
]);

function apiStatToEspn(stat) {
  if (!stat || stat.value == null || stat.value === '') return null;
  const rawType = text(stat.type).toLowerCase();
  const normalizedType = normalizeStatType(stat.type);
  const name = (/pass(?:es)?\s*%/.test(rawType) || /pass.*(?:accuracy|percentage|percent)/.test(rawType))
    ? 'passCompletionPct'
    : API_STAT_MAP.get(normalizedType);
  if (!name) return null;
  return { name, displayValue: String(stat.value), source: 'api-football' };
}

function espnSideForApiTeam(apiTeam, identity) {
  const name = text(apiTeam?.name);
  const h = nameSimilarity(name, identity.home.name);
  const a = nameSimilarity(name, identity.away.name);
  if (h < 0.72 && a < 0.72) return null;
  return h >= a ? identity.home : identity.away;
}

function normalizeApiStatistics(rows, identity) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const side = espnSideForApiTeam(row?.team, identity);
    if (!side) continue;
    const statistics = (Array.isArray(row?.statistics) ? row.statistics : []).map(apiStatToEspn).filter(Boolean);
    if (!statistics.length) continue;
    out.push({
      homeAway: side === identity.home ? 'home' : 'away',
      team: { id: side.id, displayName: side.name, abbreviation: side.abbreviation },
      statistics
    });
  }
  return out;
}

function sumFinite(values) {
  let total = 0;
  let found = false;
  for (const value of values) {
    const number = Number(value);
    if (!Number.isFinite(number)) continue;
    total += number;
    found = true;
  }
  return found ? total : null;
}

function aggregatePlayerDefense(rows, identity) {
  const out = [];
  for (const teamRow of Array.isArray(rows) ? rows : []) {
    const side = espnSideForApiTeam(teamRow?.team, identity);
    if (!side) continue;
    const tackles = [];
    const interceptions = [];
    for (const player of (Array.isArray(teamRow?.players) ? teamRow.players : [])) {
      for (const stat of (Array.isArray(player?.statistics) ? player.statistics : [])) {
        tackles.push(stat?.tackles?.total);
        interceptions.push(stat?.tackles?.interceptions);
      }
    }
    const statistics = [];
    const tackleTotal = sumFinite(tackles);
    const interceptionTotal = sumFinite(interceptions);
    if (tackleTotal != null) statistics.push({ name: 'tackles', displayValue: String(tackleTotal), source: 'api-football-players' });
    if (interceptionTotal != null) statistics.push({ name: 'interceptions', displayValue: String(interceptionTotal), source: 'api-football-players' });
    if (!statistics.length) continue;
    out.push({
      homeAway: side === identity.home ? 'home' : 'away',
      team: { id: side.id, displayName: side.name, abbreviation: side.abbreviation },
      statistics
    });
  }
  return out;
}

function bestRateLimit(attempts) {
  const successful = (attempts || []).filter((item) => item?.ok && item?.rateLimit);
  const dailyRemaining = successful.map((item) => finiteNumber(item.rateLimit.dailyRemaining)).filter((v) => v != null);
  const dailyLimit = successful.map((item) => finiteNumber(item.rateLimit.dailyLimit)).filter((v) => v != null);
  const minuteRemaining = successful.map((item) => finiteNumber(item.rateLimit.minuteRemaining)).filter((v) => v != null);
  const minuteLimit = successful.map((item) => finiteNumber(item.rateLimit.minuteLimit)).filter((v) => v != null);
  return {
    dailyRemaining: dailyRemaining.length ? Math.min(...dailyRemaining) : null,
    dailyLimit: dailyLimit.length ? Math.max(...dailyLimit) : null,
    minuteRemaining: minuteRemaining.length ? Math.min(...minuteRemaining) : null,
    minuteLimit: minuteLimit.length ? Math.max(...minuteLimit) : null
  };
}

export async function fetchApiFootballStatsFallback(summary, options = {}) {
  const apiKey = text(options.apiKey);
  if (!apiKey) throw new Error('API_FOOTBALL_KEY ausente');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = Number(options.now || Date.now());
  const identity = extractEspnIdentity(summary, now);
  if (!identity) throw new Error('summary ESPN sem identidade suficiente para casar API-Football');

  const providedFixtureId = Number(options.fixtureId || 0);
  const resolved = providedFixtureId > 0
    ? { fixture: { fixture: { id: providedFixtureId } }, attempts: [{ source: 'api_football_fixture_cache', ok: true, rateLimit: null }] }
    : await resolveApiFixture(identity, apiKey, fetchImpl);
  const fixtureId = Number(resolved.fixture?.fixture?.id);
  if (!Number.isFinite(fixtureId)) throw new Error('API-Football retornou fixture sem ID');
  const attempts = [...resolved.attempts];

  let statistics = Array.isArray(resolved.fixture?.statistics) ? resolved.fixture.statistics : [];
  if (!statistics.length) {
    const statsResult = await fetchApiJson(`/fixtures/statistics?fixture=${fixtureId}`, apiKey, fetchImpl);
    attempts.push(attemptRate('api_football_statistics', true, statsResult.rateLimit));
    statistics = statsResult.payload?.response || [];
  }

  const normalized = normalizeApiStatistics(statistics, identity);
  const metricNames = new Set(normalized.flatMap((row) => (row.statistics || []).map((stat) => stat.name)));
  if (!normalized.length || metricNames.size < 2) {
    throw Object.assign(new Error('API-Football não forneceu estatísticas úteis para a partida'), { attempts });
  }

  return {
    ok: true,
    source: 'api-football',
    fixtureId,
    identity,
    attempts,
    rateLimit: bestRateLimit(attempts),
    metricNames: [...metricNames],
    data: { boxscore: { teams: normalized } }
  };
}

export async function fetchApiFootballPlayerDefenseFallback(summary, options = {}) {
  const apiKey = text(options.apiKey);
  if (!apiKey) throw new Error('API_FOOTBALL_KEY ausente');
  const fixtureId = Number(options.fixtureId || 0);
  if (!Number.isFinite(fixtureId) || fixtureId <= 0) throw new Error('fixtureId ausente para player defense');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = Number(options.now || Date.now());
  const identity = extractEspnIdentity(summary, now);
  if (!identity) throw new Error('summary ESPN sem identidade suficiente para casar API-Football players');

  const result = await fetchApiJson(`/fixtures/players?fixture=${fixtureId}`, apiKey, fetchImpl);
  const attempts = [attemptRate('api_football_players', true, result.rateLimit)];
  const normalized = aggregatePlayerDefense(result.payload?.response || [], identity);
  const metricNames = new Set(normalized.flatMap((row) => (row.statistics || []).map((stat) => stat.name)));
  if (!normalized.length || !metricNames.size) {
    throw Object.assign(new Error('API-Football players ainda não forneceu desarmes/interceptações úteis'), { attempts });
  }
  return {
    ok: true,
    source: 'api-football-players',
    fixtureId,
    identity,
    attempts,
    rateLimit: bestRateLimit(attempts),
    metricNames: [...metricNames],
    data: { boxscore: { teams: normalized } }
  };
}

export const API_FOOTBALL_CONSTANTS = Object.freeze({
  API_FOOTBALL_ROOT,
  FETCH_TIMEOUT_MS,
  TIMEZONE
});
