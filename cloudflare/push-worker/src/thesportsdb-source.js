const THESPORTSDB_ROOT = 'https://www.thesportsdb.com/api/v1/json/123';
const FETCH_TIMEOUT_MS = 4_000;
const MAX_EVENT_DISTANCE_MS = 36 * 60 * 60 * 1000;

function text(value) { return String(value == null ? '' : value).trim(); }

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

  return {
    timestamp,
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

function requestHeaders() {
  return {
    accept: 'application/json',
    'user-agent': 'FormulaDoGol/1.0 (+https://formuladogol.com.br/)'
  };
}

async function fetchSportsDbJson(path, fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || FETCH_TIMEOUT_MS));
  try {
    const response = await fetchImpl(`${THESPORTSDB_ROOT}${path}`, {
      headers: requestHeaders(),
      signal: controller.signal,
      cf: { cacheTtl: 0, cacheEverything: false }
    });
    if (!response.ok) throw new Error(`TheSportsDB HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function eventTimestamp(row) {
  const raw = text(row?.strTimestamp);
  if (raw) {
    const parsed = Date.parse(raw.endsWith('Z') || /[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw}Z`);
    if (Number.isFinite(parsed)) return parsed;
  }
  const date = text(row?.dateEvent);
  const time = text(row?.strTime || '00:00:00');
  if (!date) return NaN;
  return Date.parse(`${date}T${time || '00:00:00'}Z`);
}

function pairScore(row, identity) {
  const direct = nameSimilarity(row?.strHomeTeam, identity.home.name) + nameSimilarity(row?.strAwayTeam, identity.away.name);
  const swapped = nameSimilarity(row?.strHomeTeam, identity.away.name) + nameSimilarity(row?.strAwayTeam, identity.home.name);
  const when = eventTimestamp(row);
  const distance = Number.isFinite(when) ? Math.abs(when - identity.timestamp) : 0;
  const timeBonus = Number.isFinite(when) && distance <= 6 * 60 * 60 * 1000 ? 0.2 : 0;
  const timePenalty = Number.isFinite(when) && distance > MAX_EVENT_DISTANCE_MS ? 1 : 0;
  return { direct: direct + timeBonus - timePenalty, swapped, distance };
}

function selectEvent(rows, identity) {
  const candidates = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const eventId = Number(row?.idEvent);
    if (!Number.isFinite(eventId)) continue;
    if (text(row?.strSport) && text(row?.strSport).toLowerCase() !== 'soccer') continue;
    const score = pairScore(row, identity);
    candidates.push({ row, ...score });
  }
  candidates.sort((a, b) => b.direct - a.direct);
  const best = candidates[0];
  if (!best || best.direct < 1.55 || best.direct <= best.swapped) return null;
  if (Number.isFinite(best.distance) && best.distance > MAX_EVENT_DISTANCE_MS) return null;
  if (candidates[1] && Math.abs(best.direct - candidates[1].direct) < 0.08) return null;
  return best.row;
}

function eventQuery(home, away) {
  return `${text(home).replace(/\s+/g, '_')}_vs_${text(away).replace(/\s+/g, '_')}`;
}

async function resolveSportsDbEvent(identity, fetchImpl) {
  const attempts = [];
  const queries = [
    eventQuery(identity.home.name, identity.away.name),
    eventQuery(normalizeToken(identity.home.name), normalizeToken(identity.away.name))
  ].filter((value, index, list) => value && list.indexOf(value) === index);

  for (const query of queries) {
    try {
      const payload = await fetchSportsDbJson(`/searchevents.php?e=${encodeURIComponent(query)}`, fetchImpl);
      attempts.push({ source: 'thesportsdb_event_search', ok: true, query });
      const match = selectEvent(payload?.event, identity);
      if (match) return { event: match, attempts };
    } catch (error) {
      attempts.push({ source: 'thesportsdb_event_search', ok: false, query, error: text(error?.message || error) });
    }
  }
  throw Object.assign(new Error(`TheSportsDB não encontrou ${identity.home.name} x ${identity.away.name}`), { attempts });
}

function normalizeStatType(value) {
  return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const STAT_MAP = new Map([
  ['ball possession', 'possessionPct'], ['possession', 'possessionPct'],
  ['total shots', 'totalShots'], ['goal attempts', 'totalShots'],
  ['shots on goal', 'shotsOnTarget'], ['shots on target', 'shotsOnTarget'],
  ['blocked shots', 'blockedShots'],
  ['fouls', 'foulsCommitted'], ['fouls committed', 'foulsCommitted'],
  ['goalkeeper saves', 'saves'], ['saves', 'saves'],
  ['total passes', 'totalPasses'], ['passes', 'totalPasses'],
  ['passes accurate', 'accuratePasses'], ['accurate passes', 'accuratePasses'], ['completed passes', 'accuratePasses'],
  ['passes %', 'passCompletionPct'], ['pass accuracy', 'passCompletionPct'], ['passing accuracy', 'passCompletionPct'],
  ['tackles', 'tackles'], ['tackles won', 'tackles'],
  ['interceptions', 'interceptions'],
  ['crosses', 'crosses'], ['total crosses', 'crosses'],
  ['clearances', 'clearances'],
  ['corner kicks', 'wonCorners'], ['corners', 'wonCorners'],
  ['yellow cards', 'yellowCards'], ['red cards', 'redCards'],
  ['offsides', 'offsides'], ['offside', 'offsides']
]);

function displayValue(name, value) {
  const raw = text(value);
  if (!raw) return '';
  if ((name === 'possessionPct' || name === 'passCompletionPct') && !raw.includes('%')) return `${raw}%`;
  return raw;
}

function eventNamesFromStatRows(rows) {
  for (const row of Array.isArray(rows) ? rows : []) {
    const event = text(row?.strEvent);
    const match = event.match(/^(.+?)\s+vs\s+(.+)$/i);
    if (match) return { home: text(match[1]), away: text(match[2]) };
  }
  return null;
}

function validateStatRowsMatch(rows, identity) {
  const names = eventNamesFromStatRows(rows);
  if (!names) return true;
  const direct = nameSimilarity(names.home, identity.home.name) + nameSimilarity(names.away, identity.away.name);
  const swapped = nameSimilarity(names.home, identity.away.name) + nameSimilarity(names.away, identity.home.name);
  return direct >= 1.55 && direct > swapped;
}

function normalizeStats(rows, identity) {
  const homeStats = [];
  const awayStats = [];
  const seenHome = new Set();
  const seenAway = new Set();

  for (const row of Array.isArray(rows) ? rows : []) {
    const name = STAT_MAP.get(normalizeStatType(row?.strStat));
    if (!name) continue;
    const home = displayValue(name, row?.intHome);
    const away = displayValue(name, row?.intAway);
    if (home && !seenHome.has(name)) {
      homeStats.push({ name, displayValue: home, source: 'thesportsdb' });
      seenHome.add(name);
    }
    if (away && !seenAway.has(name)) {
      awayStats.push({ name, displayValue: away, source: 'thesportsdb' });
      seenAway.add(name);
    }
  }

  const out = [];
  if (homeStats.length) out.push({
    homeAway: 'home',
    team: { id: identity.home.id, displayName: identity.home.name, abbreviation: identity.home.abbreviation },
    statistics: homeStats
  });
  if (awayStats.length) out.push({
    homeAway: 'away',
    team: { id: identity.away.id, displayName: identity.away.name, abbreviation: identity.away.abbreviation },
    statistics: awayStats
  });
  return out;
}

export async function fetchTheSportsDbStatsFallback(summary, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = Number(options.now || Date.now());
  const identity = extractEspnIdentity(summary, now);
  if (!identity) throw new Error('summary ESPN sem identidade suficiente para casar TheSportsDB');

  const providedEventId = Number(options.eventId || 0);
  const resolved = providedEventId > 0
    ? { event: { idEvent: providedEventId }, attempts: [{ source: 'thesportsdb_event_cache', ok: true }] }
    : await resolveSportsDbEvent(identity, fetchImpl);
  const eventId = Number(resolved.event?.idEvent);
  if (!Number.isFinite(eventId)) throw new Error('TheSportsDB retornou evento sem ID');
  const attempts = [...resolved.attempts];

  const payload = await fetchSportsDbJson(`/lookupeventstats.php?id=${eventId}`, fetchImpl);
  attempts.push({ source: 'thesportsdb_event_stats', ok: true });
  const rows = Array.isArray(payload?.eventstats) ? payload.eventstats : [];
  if (!rows.length) throw Object.assign(new Error('TheSportsDB ainda não forneceu estatísticas para a partida'), { attempts });
  if (!validateStatRowsMatch(rows, identity)) {
    throw Object.assign(new Error('TheSportsDB retornou estatísticas de outra partida'), { attempts });
  }

  const normalized = normalizeStats(rows, identity);
  const metricNames = [...new Set(normalized.flatMap((row) => (row.statistics || []).map((stat) => stat.name)))];
  if (!normalized.length || !metricNames.length) {
    throw Object.assign(new Error('TheSportsDB não forneceu métricas compatíveis com o painel'), { attempts });
  }

  return {
    ok: true,
    source: 'thesportsdb',
    eventId,
    identity,
    attempts,
    metricNames,
    data: { boxscore: { teams: normalized } }
  };
}

export const THESPORTSDB_CONSTANTS = Object.freeze({
  THESPORTSDB_ROOT,
  FETCH_TIMEOUT_MS,
  MAX_EVENT_DISTANCE_MS
});
