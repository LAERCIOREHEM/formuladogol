import { espnDay } from './logic.js';

const DEFAULT_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(base, path, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
  url.searchParams.set('orch', String(Math.floor(Date.now() / 60000)));
  const response = await fetchWithTimeout(url.toString(), {
    headers: {
      'Accept': 'application/json,text/plain,*/*',
      'Cache-Control': 'no-cache',
      'User-Agent': 'FormulaDoGol-Orchestrator/1.0',
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  }, timeoutMs);
  if (!response.ok) throw new Error(`HTTP ${response.status} em ${path}`);
  return response.json();
}

export async function fetchSiteBundle(env, paths) {
  const base = String(env.SITE_BASE || 'https://formuladogol.com.br');
  const entries = await Promise.all(paths.map(async (path) => {
    try {
      return [path, await fetchJson(base, path), ''];
    } catch (error) {
      return [path, null, `${error?.name || 'Error'}: ${error?.message || error}`];
    }
  }));
  return Object.fromEntries(entries.map(([path, data, error]) => [path, { data, error }]));
}

function scoreValue(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export async function probeEspn(games) {
  const groups = new Map();
  for (const game of games) {
    const key = `${game.league}|${espnDay(game.kickoff)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(game);
  }
  const states = new Map();
  const errors = [];
  await Promise.all([...groups.entries()].map(async ([key, group]) => {
    const [league, day] = key.split('|');
    const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${encodeURIComponent(league).replaceAll('%2E', '.')}/scoreboard?dates=${day}&limit=100`;
    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          'Accept': 'application/json,text/plain,*/*',
          'Cache-Control': 'no-cache',
          'User-Agent': 'Mozilla/5.0 (compatible; FormulaDoGol-Orchestrator/1.0)',
        },
        cf: { cacheTtl: 0, cacheEverything: false },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const wanted = new Set(group.map((g) => g.eventId));
      const seen = new Set();
      for (const event of payload?.events || []) {
        const eventId = String(event?.id || '');
        if (!wanted.has(eventId)) continue;
        seen.add(eventId);
        const statusType = event?.status?.type || {};
        let state = String(statusType?.state || '').toLowerCase();
        if (statusType?.completed === true) state = 'post';
        if (!['pre', 'in', 'post'].includes(state)) state = '';
        let homeScore = null;
        let awayScore = null;
        const competition = event?.competitions?.[0] || {};
        for (const competitor of competition?.competitors || []) {
          if (String(competitor?.homeAway || '').toLowerCase() === 'home') homeScore = scoreValue(competitor?.score);
          if (String(competitor?.homeAway || '').toLowerCase() === 'away') awayScore = scoreValue(competitor?.score);
        }
        states.set(eventId, {
          state,
          homeScore,
          awayScore,
          detail: String(statusType?.shortDetail || statusType?.detail || ''),
        });
      }
      const missing = [...wanted].filter((id) => !seen.has(id));
      if (missing.length) errors.push(`${league}/${day}: event_id ausente no scoreboard: ${missing.join(',')}`);
    } catch (error) {
      errors.push(`${league}/${day}: ${error?.name || 'Error'}: ${error?.message || error}`);
    }
  }));
  return { states, errors };
}
