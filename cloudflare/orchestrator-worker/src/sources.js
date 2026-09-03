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

function githubRepoParts(env) {
  const [owner, repo] = String(env.GITHUB_REPOSITORY || '').split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY inválido para leitura de conteúdo');
  return { owner, repo };
}

function githubHeaders(env) {
  const token = String(env.GITHUB_TOKEN || '').trim();
  if (!token) throw new Error('secret GITHUB_TOKEN ausente para fallback de conteúdo');
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.raw+json',
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': 'FormulaDoGol-Orchestrator/1.0',
    'Cache-Control': 'no-cache',
  };
}

function encodeRepoPath(path) {
  return String(path || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
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

// Alguns artefatos operacionais existem no repositório, mas deliberadamente
// não fazem parte do site publicado. O Worker tenta o site primeiro (fonte mais
// barata e alinhada ao público) e, se não estiver disponível, lê o MESMO path
// diretamente do branch configurado via GitHub Contents API. Assim não é
// necessário publicar auditorias/configurações internas apenas para o
// orquestrador consumi-las.
export async function fetchRepositoryJson(env, path, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { owner, repo } = githubRepoParts(env);
  const branch = String(env.GITHUB_BRANCH || 'main');
  const encodedPath = encodeRepoPath(path);
  if (!encodedPath) throw new Error('path vazio no fallback GitHub');
  const url = new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`);
  url.searchParams.set('ref', branch);
  const response = await fetchWithTimeout(url.toString(), {
    headers: githubHeaders(env),
  }, timeoutMs);
  if (!response.ok) throw new Error(`GitHub contents HTTP ${response.status} em ${path}`);
  return response.json();
}

export async function fetchSiteBundle(env, paths) {
  const base = String(env.SITE_BASE || 'https://formuladogol.com.br');
  const entries = await Promise.all(paths.map(async (path) => {
    let siteError = '';
    try {
      const payload = await fetchJson(base, path);
      return [path, { data: payload, error: '', origin: 'site', siteError: '' }];
    } catch (error) {
      siteError = `${error?.name || 'Error'}: ${error?.message || error}`;
    }

    try {
      const payload = await fetchRepositoryJson(env, path);
      return [path, { data: payload, error: '', origin: 'github', siteError }];
    } catch (repoError) {
      const githubError = `${repoError?.name || 'Error'}: ${repoError?.message || repoError}`;
      return [path, {
        data: null,
        error: `site=[${siteError}] github=[${githubError}]`,
        origin: 'none',
        siteError,
        githubError,
      }];
    }
  }));
  return Object.fromEntries(entries);
}

export function repositoryFallbacks(bundle) {
  return Object.entries(bundle || {})
    .filter(([, row]) => row?.origin === 'github')
    .map(([path, row]) => `${path}: GitHub fallback após ${row.siteError || 'fonte pública indisponível'}`);
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
