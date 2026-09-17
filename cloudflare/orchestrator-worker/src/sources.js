import { espnDay } from './logic.js';

const DEFAULT_TIMEOUT_MS = 8000;
const REPOSITORY_AUTHORITATIVE_PATHS = new Set([
  'dados-br/estado-editorial-continentais.json',
  'dados-br/status-atualizacao.json',
  // O fechamento continental acontece logo após writers esportivos atualizarem
  // a main. Para não esperar o Pages propagar um snapshot antigo, a decisão
  // editorial lê o conjunto continental diretamente do repositório.
  'dados-br/competicoes-af-previsao/libertadores.json',
  'dados-br/competicoes-af-previsao/sul-americana.json',
  'dados-br/historico-probabilidades-continentais.json',
  'dados-br/analises.json',
]);

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
    // Locks operacionais precisam refletir o commit de main imediatamente.
    // Pages pode continuar servindo uma cópia antiga após uma falha justamente
    // porque o workflow interrompido não dispara deploy do site.
    if (REPOSITORY_AUTHORITATIVE_PATHS.has(path)) {
      try {
        const payload = await fetchRepositoryJson(env, path);
        return [path, { data: payload, error: '', origin: 'github_authoritative', siteError: '' }];
      } catch (repoError) {
        const githubError = `${repoError?.name || 'Error'}: ${repoError?.message || repoError}`;
        return [path, { data: null, error: `github=[${githubError}]`, origin: 'none', siteError: '', githubError }];
      }
    }

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

function requestHeaders() {
  return {
    'Accept': 'application/json,text/plain,*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': 'https://www.espn.com/',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  };
}

function walkObjects(root, maxDepth = 4) {
  const out = [];
  const queue = [{ value: root, depth: 0 }];
  const seen = new Set();
  while (queue.length) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (depth >= maxDepth) continue;
    const children = Array.isArray(value) ? value.slice(0, 50) : Object.values(value);
    for (const child of children) if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
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

function scoreboardCandidates(league, day) {
  const qLeague = encodeURIComponent(league).replaceAll('%2E', '.');
  const qDay = encodeURIComponent(day);
  return [
    { name: 'espn_cdn_league', url: `https://cdn.espn.com/core/${qLeague}/scoreboard?xhr=1&dates=${qDay}&limit=100` },
    { name: 'espn_cdn_soccer', url: `https://cdn.espn.com/core/soccer/scoreboard?xhr=1&league=${qLeague}&dates=${qDay}&limit=100` },
    { name: 'espn_site_web_api', url: `https://site.web.api.espn.com/apis/site/v2/sports/soccer/${qLeague}/scoreboard?dates=${qDay}&limit=100` },
    { name: 'espn_site_api', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/${qLeague}/scoreboard?dates=${qDay}&limit=100` },
  ];
}

async function fetchScoreboardCandidate(candidate) {
  const sep = candidate.url.includes('?') ? '&' : '?';
  const url = `${candidate.url}${sep}_fdg=${Date.now()}`;
  const response = await fetchWithTimeout(url, {
    headers: requestHeaders(),
    cf: { cacheTtl: 0, cacheEverything: false },
  }, 5000);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  return unwrapScoreboard(payload);
}

async function fetchScoreboardGateway(league, day, wantedIds = new Set()) {
  const attempts = [];
  let best = null;
  for (const candidate of scoreboardCandidates(league, day)) {
    const started = Date.now();
    try {
      const data = await fetchScoreboardCandidate(candidate);
      const ids = new Set((data?.events || []).map((event) => String(event?.id || '')).filter(Boolean));
      const missing = [...wantedIds].filter((id) => !ids.has(id));
      attempts.push({ source: candidate.name, ok: true, durationMs: Date.now() - started, missing });
      if (!best || (data?.events || []).length > (best.data?.events || []).length) best = { source: candidate.name, data };
      if (!missing.length) return { ok: true, source: candidate.name, data, attempts };
    } catch (error) {
      attempts.push({ source: candidate.name, ok: false, durationMs: Date.now() - started, error: `${error?.name || 'Error'}: ${error?.message || error}` });
    }
  }
  if (best && !wantedIds.size) return { ok: true, ...best, attempts };
  const missing = best ? [...wantedIds].filter((id) => !(best.data?.events || []).some((event) => String(event?.id || '') === id)) : [...wantedIds];
  const detail = attempts.map((item) => `${item.source}:${item.ok ? (item.missing?.length ? `missing=${item.missing.join(',')}` : 'ok') : item.error}`).join(' | ');
  const error = new Error(`${missing.length ? `event_id ausente no gateway: ${missing.join(',')} | ` : ''}${detail || 'scoreboard ESPN indisponível'}`);
  error.attempts = attempts;
  throw error;
}

export async function probeEspnAvailability({ league = 'bra.1', day } = {}) {
  const targetDay = String(day || '').trim();
  if (!targetDay) throw new Error('day obrigatório no probe ESPN');
  try {
    const result = await fetchScoreboardGateway(league, targetDay, new Set());
    return { ok: true, source: result.source, attempts: result.attempts, error: '' };
  } catch (error) {
    return { ok: false, source: '', attempts: error?.attempts || [], error: `${error?.name || 'Error'}: ${error?.message || error}` };
  }
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
  const sources = {};
  const attempts = [];
  await Promise.all([...groups.entries()].map(async ([key, group]) => {
    const [league, day] = key.split('|');
    const wanted = new Set(group.map((g) => g.eventId));
    try {
      const gateway = await fetchScoreboardGateway(league, day, wanted);
      sources[key] = gateway.source;
      attempts.push(...gateway.attempts.map((item) => ({ group: key, ...item })));
      for (const event of gateway.data?.events || []) {
        const eventId = String(event?.id || '');
        if (!wanted.has(eventId)) continue;
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
          source: gateway.source,
        });
      }
      const missing = [...wanted].filter((id) => !states.has(id));
      if (missing.length) errors.push(`${league}/${day}: event_id ausente no scoreboard resiliente: ${missing.join(',')}`);
    } catch (error) {
      errors.push(`${league}/${day}: ${error?.name || 'Error'}: ${error?.message || error}`);
    }
  }));
  return { states, errors, sources, attempts };
}

