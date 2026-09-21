const DEFAULT_SITE_BASE = 'https://formuladogol.com.br';
const DEFAULT_MODEL = 'gpt-5.6-sol';
const MAX_API_EVENT_IDS = 40;
const STATIC_SEED_INTERVAL_MS = 10 * 60_000;
const RECENT_RESULT_WINDOW_MS = 48 * 60 * 60_000;
const CLEANUP_WINDOW_DAYS = 30;
const POSTGAME_POLICY_VERSION = 2;

const CHANNELS = Object.freeze([
  { id: 'UCgCKagVhzGnZcuP9bSMgMCg', name: 'GE TV', source: 'GE TV / YouTube', embed: true, minAgeHours: 0 },
  { id: 'UCZiYbVptd3PVPf4f6eR6UaQ', name: 'CazéTV', source: 'CazéTV / YouTube', embed: false, minAgeHours: 0 },
  { id: 'UC6RD83p2Hlum9aURp3pASeQ', name: 'Prime Video Sport Brasil', source: 'Prime Video Sport Brasil / YouTube', embed: true, minAgeHours: 0 },
  { id: 'UC3KHYFWeB0WimMBfm3NEahQ', name: 'UOL Esporte', source: 'UOL Esporte / YouTube', embed: true, minAgeHours: 48 },
]);

const TEAM_ALIASES = Object.freeze({
  'Athletico-PR': ['athletico-pr','athletico pr','athletico','athletico paranaense','atletico-pr'],
  'Atlético-MG': ['atlético-mg','atletico-mg','atlético mg','atletico mg','atlético mineiro','atletico mineiro','galo'],
  'Bahia': ['bahia','ec bahia','esporte clube bahia'],
  'Botafogo': ['botafogo','botafogo-rj'],
  'Bragantino': ['bragantino','rb bragantino','red bull bragantino','red bull braga','braga'],
  'Chapecoense': ['chapecoense','chape'],
  'Corinthians': ['corinthians','sport club corinthians','timão','timao'],
  'Coritiba': ['coritiba','coxa','coxa-branca','coxabranca'],
  'Cruzeiro': ['cruzeiro','cruzeiro ec'],
  'Flamengo': ['flamengo','fla','cr flamengo'],
  'Fluminense': ['fluminense','flu'],
  'Grêmio': ['grêmio','gremio','grêmio fbpa','gremio fbpa'],
  'Internacional': ['internacional','inter','sc internacional'],
  'Mirassol': ['mirassol','mirassol fc'],
  'Palmeiras': ['palmeiras','se palmeiras','verdão','verdao'],
  'Remo': ['remo','clube do remo'],
  'Santos': ['santos','santos fc','peixe'],
  'São Paulo': ['são paulo','sao paulo','são paulo fc','sao paulo fc','spfc'],
  'Vasco da Gama': ['vasco','vasco da gama','cr vasco da gama'],
  'Vitória': ['vitória','vitoria','ec vitória','ec vitoria'],
});

const POSITIVE_HIGHLIGHT_RE = /\b(melhores momentos|gols e melhores momentos|gols do jogo|todos os gols|highlights?)\b/i;
const NEGATIVE_HIGHLIGHT_RE = /\b(aquecimento|esquenta|pre[- ]?jogo|pré[- ]?jogo|pos[- ]?jogo|pós[- ]?jogo|sem imagens|audio apenas|áudio apenas|narra[cç][aã]o|radio|rádio|tempo real|lance a lance|lances ao vivo|watchalong|watch party|react|podcast)\b/i;

const HIGHLIGHT_RETRY_MINUTES = [1, 2, 2, 5, 5, 5, 10, 15, 15, 30, 30, 60, 60, 120];
const PUBLIC_RETRY_MINUTES = [1, 2, 4, 7, 10, 15, 20, 30, 45, 60, 90, 120];

const channelCache = new Map();

function text(value) { return String(value ?? '').trim(); }
function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function nowIso(now = Date.now()) { return new Date(now).toISOString(); }
function normalizeText(value) {
  return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function safeJson(value, fallback = null) { try { return JSON.parse(value); } catch (_) { return fallback; } }
function clampInt(value, min, max) { const n = Math.round(Number(value)); return Number.isFinite(n) && n >= min && n <= max ? n : null; }
function clampMoney(value, min = 1000, max = 50_000_000) { const n = Number(value); return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 100) / 100 : null; }

function teamAliases(team) {
  const direct = TEAM_ALIASES[text(team)] || [];
  return [...new Set([text(team), ...direct].map(normalizeText).filter((v) => v.length >= 2))];
}
function titleHasTeam(title, team) {
  const normalized = ` ${normalizeText(title)} `;
  return teamAliases(team).some((alias) => alias && normalized.includes(` ${alias} `));
}

export function highlightTitleValid(title, home, away) {
  const raw = text(title);
  if (!raw || NEGATIVE_HIGHLIGHT_RE.test(raw) || !POSITIVE_HIGHLIGHT_RE.test(raw)) return false;
  return titleHasTeam(raw, home) && titleHasTeam(raw, away);
}

export function retryMinutes(kind, attempt, ageHours = 0) {
  const list = kind === 'highlight' ? HIGHLIGHT_RETRY_MINUTES : PUBLIC_RETRY_MINUTES;
  const idx = Math.max(0, Number(attempt || 1) - 1);
  if (idx < list.length) return list[idx];
  if (ageHours < 12) return kind === 'highlight' ? 60 : 120;
  if (ageHours < 24) return 120;
  return 1440;
}

function normalizeUrl(value) {
  try {
    const u = new URL(text(value));
    if (!/^https?:$/.test(u.protocol)) return '';
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|srsltid|gclid|fbclid)/i.test(key)) u.searchParams.delete(key);
    }
    const out = u.toString().replace(/\/$/, '');
    return out;
  } catch (_) { return ''; }
}

function sourceUrlKey(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) return '';
  try {
    const u = new URL(normalized);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    let path = decodeURIComponent(u.pathname || '/').replace(/\/{2,}/g, '/');
    path = path.replace(/^\/google\/amp\//i, '/');
    path = path.replace(/\.amp\.(ghtml|html?)$/i, '.$1');
    path = path.replace(/\/amp\/?$/i, '');
    path = path.replace(/\/$/, '') || '/';
    return `${host}${path}`.toLowerCase();
  } catch (_) { return ''; }
}

function verifiedSource(rawUrl, sourceUrls) {
  const candidate = normalizeUrl(rawUrl);
  const key = sourceUrlKey(candidate);
  if (!candidate || !key) return '';
  for (const raw of sourceUrls || []) {
    const actual = normalizeUrl(raw);
    if (actual && sourceUrlKey(actual) === key) return actual;
  }
  return '';
}

function extractOpenAIText(response) {
  const parts = [];
  for (const item of response?.output || []) {
    for (const block of item?.content || []) {
      if (block?.type === 'output_text' && block?.text) parts.push(String(block.text));
    }
  }
  return parts.join('');
}

function extractOpenAISources(response) {
  const urls = new Set();
  for (const item of response?.output || []) {
    if (item?.type === 'web_search_call') {
      for (const source of item?.action?.sources || []) {
        const u = normalizeUrl(source?.url);
        if (u) urls.add(u);
      }
    }
    for (const block of item?.content || []) {
      for (const annotation of block?.annotations || []) {
        const u = normalizeUrl(annotation?.url || annotation?.url_citation?.url);
        if (u) urls.add(u);
      }
    }
  }
  return urls;
}

export function validatePublicPayload(payload, sourceUrls) {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (p.encontrado !== true) return { accepted: false, reason: 'not_found' };
  const confidence = Number(p.confianca || 0);
  if (!(confidence >= 0.90 && confidence <= 1)) return { accepted: false, reason: 'low_confidence' };
  const publicValue = clampInt(p.publico, 500, 150000);
  const paidValue = clampInt(p.publico_pagante, 0, 150000);
  const revenueValue = clampMoney(p.renda);
  if (publicValue == null && paidValue == null && revenueValue == null) return { accepted: false, reason: 'no_values' };
  if (publicValue != null && paidValue != null && paidValue > publicValue) return { accepted: false, reason: 'paid_gt_present' };
  const sources = new Set([...sourceUrls].map(normalizeUrl).filter(Boolean));
  const fields = [
    ['publico', publicValue, p.fonte_publico],
    ['publico_pagante', paidValue, p.fonte_publico_pagante],
    ['renda', revenueValue, p.fonte_renda],
  ];
  const accepted = {};
  const usedSources = {};
  for (const [key, value, rawUrl] of fields) {
    if (value == null) continue;
    const url = verifiedSource(rawUrl, sources);
    if (!url) continue;
    accepted[key] = value;
    usedSources[key] = url;
  }
  if (!Object.keys(accepted).length) return { accepted: false, reason: 'source_not_verified' };
  return { accepted: true, values: accepted, sources: usedSources, confidence, note: text(p.observacao) };
}

async function fetchJson(url, init = {}, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

async function youtubeUploadsPlaylist(apiKey, channelId) {
  const cached = channelCache.get(channelId);
  if (cached && cached.expiresAt > Date.now()) return cached.uploads;
  const url = new URL('https://www.googleapis.com/youtube/v3/channels');
  url.searchParams.set('part', 'contentDetails,snippet');
  url.searchParams.set('id', channelId);
  url.searchParams.set('key', apiKey);
  const data = await fetchJson(url.toString(), {}, 10_000);
  const uploads = text(data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads);
  if (!uploads) throw new Error(`youtube_uploads_missing:${channelId}`);
  channelCache.set(channelId, { uploads, expiresAt: Date.now() + 60 * 60_000 });
  return uploads;
}

async function youtubeRecentUploads(apiKey, channelId) {
  const uploads = await youtubeUploadsPlaylist(apiKey, channelId);
  const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
  url.searchParams.set('part', 'snippet,contentDetails');
  url.searchParams.set('playlistId', uploads);
  url.searchParams.set('maxResults', '35');
  url.searchParams.set('key', apiKey);
  const data = await fetchJson(url.toString(), {}, 10_000);
  return Array.isArray(data?.items) ? data.items : [];
}

export async function findOfficialHighlight(env, task, now = Date.now()) {
  const apiKey = text(env?.YOUTUBE_API_KEY);
  if (!apiKey) return { found: false, reason: 'youtube_key_missing' };
  const finalAt = Date.parse(task?.final_at || '') || now;
  const ageHours = Math.max(0, (now - finalAt) / 3_600_000);
  const minPublished = finalAt - 4 * 3_600_000;
  const errors = [];
  for (const channel of CHANNELS) {
    if (ageHours < channel.minAgeHours) continue;
    try {
      const items = await youtubeRecentUploads(apiKey, channel.id);
      const candidates = items.map((item) => {
        const videoId = text(item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId);
        const title = text(item?.snippet?.title);
        const publishedAt = text(item?.contentDetails?.videoPublishedAt || item?.snippet?.publishedAt);
        const publishedMs = Date.parse(publishedAt || '');
        return { videoId, title, publishedAt, publishedMs };
      }).filter((row) => row.videoId && row.title && (!Number.isFinite(row.publishedMs) || row.publishedMs >= minPublished) && highlightTitleValid(row.title, task.home, task.away));
      candidates.sort((a, b) => (b.publishedMs || 0) - (a.publishedMs || 0));
      if (candidates.length) {
        const hit = candidates[0];
        return {
          found: true,
          value: {
            event_id: text(task.event_id),
            video_id: hit.videoId,
            titulo: hit.title,
            url: `https://www.youtube.com/watch?v=${encodeURIComponent(hit.videoId)}`,
            thumbnail: `https://i.ytimg.com/vi/${encodeURIComponent(hit.videoId)}/hqdefault.jpg`,
            published_at: hit.publishedAt || '',
            fonte: channel.source,
            channel_title: channel.name,
            channel_id: channel.id,
            embed: channel.embed,
            confianca: 1.0,
            origem: 'cloudflare-fastlane-youtube-uploads',
          }
        };
      }
    } catch (error) {
      errors.push(`${channel.name}:${text(error?.message || error)}`);
    }
  }
  return { found: false, reason: errors.length ? errors.join('; ').slice(0, 1000) : 'not_found' };
}

function publicSearchRequest(task, missing, env) {
  const model = text(env?.POSTGAME_OPENAI_MODEL || env?.OPENAI_MODEL || DEFAULT_MODEL) || DEFAULT_MODEL;
  const matchup = `${text(task.home)} x ${text(task.away)}`;
  const date = text(task.kickoff).slice(0, 10);
  const missingText = missing.join(', ');
  return {
    model,
    reasoning: { effort: 'medium' },
    input: [{
      role: 'user',
      content: [{
        type: 'input_text',
        text: `Pesquise na web dados documentais da partida ${matchup}, data ${date}, event_id ${text(task.event_id)}. Preciso exclusivamente de: ${missingText}. NÃO use memória e NÃO estime. Faça várias consultas independentes, em especial: \"${matchup} público renda\", \"${matchup} PÚBLICO RENDA\", \"${matchup} ficha técnica\", e procure também matérias de fechamento da rodada/Gato Mestre. Priorize clube/CBF/federação, ge, UOL/Estadão e imprensa regional confiável, mas não descarte outra ficha técnica documental. Se um campo não estiver publicado, retorne null. Público significa público presente/total; pagantes é campo separado. Confirme confronto, data e placar antes de usar a fonte. Cada número retornado precisa ter sua própria URL que tenha sido efetivamente lida pelo web_search.`,
      }]
    }],
    text: {
      format: {
        type: 'json_schema',
        name: 'postgame_publico_renda',
        strict: true,
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            encontrado: { type: 'boolean' },
            publico: { type: ['integer','null'] },
            publico_pagante: { type: ['integer','null'] },
            renda: { type: ['number','null'] },
            fonte_publico: { type: ['string','null'] },
            fonte_publico_pagante: { type: ['string','null'] },
            fonte_renda: { type: ['string','null'] },
            confianca: { type: 'number' },
            observacao: { type: 'string' }
          },
          required: ['encontrado','publico','publico_pagante','renda','fonte_publico','fonte_publico_pagante','fonte_renda','confianca','observacao']
        }
      }
    },
    tools: [{
      type: 'web_search', search_context_size: 'high',
      user_location: { type: 'approximate', country: 'BR', timezone: 'America/Sao_Paulo' }
    }],
    tool_choice: 'required',
    max_tool_calls: 14,
    include: ['web_search_call.action.sources']
  };
}

export async function searchPublicWithOpenAI(env, task) {
  const apiKey = text(env?.OPENAI_API_KEY);
  if (!apiKey) return { found: false, reason: 'openai_key_missing' };
  const missing = [];
  if (!(Number(task.publico) > 0)) missing.push('público presente');
  if (!(Number(task.publico_pagante) > 0)) missing.push('público pagante');
  if (!(Number(task.renda) > 0)) missing.push('renda');
  if (!missing.length) return { found: true, complete: true, values: {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55_000);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', signal: controller.signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(publicSearchRequest(task, missing, env))
    });
    if (!response.ok) return { found: false, reason: `openai_http_${response.status}` };
    const raw = await response.json();
    const output = extractOpenAIText(raw);
    if (!output) return { found: false, reason: 'openai_empty_output' };
    const parsed = safeJson(output, null);
    if (!parsed) return { found: false, reason: 'openai_invalid_json' };
    const verified = validatePublicPayload(parsed, extractOpenAISources(raw));
    if (!verified.accepted) return { found: false, reason: verified.reason };
    return { found: true, ...verified };
  } catch (error) {
    return { found: false, reason: `openai_error:${text(error?.message || error).slice(0, 240)}` };
  } finally { clearTimeout(timer); }
}

async function metaGet(env, key) {
  const row = await env.DB.prepare('SELECT value FROM postgame_meta WHERE key=?').bind(key).first();
  return row ? text(row.value) : '';
}
async function metaPut(env, key, value) {
  await env.DB.prepare(`INSERT INTO postgame_meta(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).bind(key, text(value)).run();
}

async function upsertTask(env, row, staticData = {}) {
  const eventId = text(row.event_id || row.eventId || row.id);
  if (!eventId) return false;
  const score = text(row.score || '');
  const parts = score.match(/^(\d+)\s*[-x×]\s*(\d+)$/i);
  const homeScore = num(row.home_score ?? row.placar_mandante ?? (parts ? parts[1] : null));
  const awayScore = num(row.away_score ?? row.placar_visitante ?? (parts ? parts[2] : null));
  const publico = clampInt(staticData.publico, 500, 150000);
  const pagantes = clampInt(staticData.publico_pagante ?? staticData.pagantes, 0, 150000);
  const renda = clampMoney(staticData.renda);
  const highlight = staticData.highlight && typeof staticData.highlight === 'object' ? staticData.highlight : null;
  const publicComplete = publico != null && renda != null;
  const highlightResolved = Boolean(highlight?.url && highlight?.video_id);
  const finalAt = text(row.final_at || row.finalAt || row.finalizado_em) || nowIso();
  const now = nowIso();
  await env.DB.prepare(`
    INSERT INTO postgame_fastlane (
      event_id,league,home,away,kickoff,final_at,home_score,away_score,
      publico,publico_pagante,renda,public_sources_json,public_status,public_next_at,
      highlight_json,highlight_status,highlight_next_at,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(event_id) DO UPDATE SET
      league=CASE WHEN excluded.league<>'' THEN excluded.league ELSE postgame_fastlane.league END,
      home=CASE WHEN excluded.home<>'' THEN excluded.home ELSE postgame_fastlane.home END,
      away=CASE WHEN excluded.away<>'' THEN excluded.away ELSE postgame_fastlane.away END,
      kickoff=CASE WHEN excluded.kickoff<>'' THEN excluded.kickoff ELSE postgame_fastlane.kickoff END,
      final_at=CASE WHEN postgame_fastlane.final_at='' THEN excluded.final_at ELSE postgame_fastlane.final_at END,
      home_score=COALESCE(excluded.home_score,postgame_fastlane.home_score),
      away_score=COALESCE(excluded.away_score,postgame_fastlane.away_score),
      publico=COALESCE(postgame_fastlane.publico,excluded.publico),
      publico_pagante=COALESCE(postgame_fastlane.publico_pagante,excluded.publico_pagante),
      renda=COALESCE(postgame_fastlane.renda,excluded.renda),
      public_sources_json=CASE WHEN postgame_fastlane.public_sources_json IS NULL OR postgame_fastlane.public_sources_json='' THEN excluded.public_sources_json ELSE postgame_fastlane.public_sources_json END,
      public_status=CASE WHEN postgame_fastlane.public_status='resolved' OR excluded.public_status<>'resolved' THEN postgame_fastlane.public_status ELSE 'resolved' END,
      public_next_at=CASE WHEN postgame_fastlane.public_status='resolved' OR excluded.public_status='resolved' THEN NULL ELSE COALESCE(postgame_fastlane.public_next_at,excluded.public_next_at) END,
      highlight_json=COALESCE(postgame_fastlane.highlight_json,excluded.highlight_json),
      highlight_status=CASE WHEN postgame_fastlane.highlight_status='resolved' OR excluded.highlight_status<>'resolved' THEN postgame_fastlane.highlight_status ELSE 'resolved' END,
      highlight_next_at=CASE WHEN postgame_fastlane.highlight_status='resolved' OR excluded.highlight_status='resolved' THEN NULL ELSE COALESCE(postgame_fastlane.highlight_next_at,excluded.highlight_next_at) END,
      updated_at=CURRENT_TIMESTAMP
  `).bind(
    eventId, text(row.league || row.espn_league || 'bra.1'), text(row.home || row.mandante?.nome || row.mandante), text(row.away || row.visitante?.nome || row.visitante),
    text(row.kickoff || row.data_iso), finalAt, homeScore, awayScore,
    publico, pagantes, renda, staticData.public_sources ? JSON.stringify(staticData.public_sources) : null, publicComplete ? 'resolved' : 'pending', publicComplete ? null : now,
    highlightResolved ? JSON.stringify(highlight) : null, highlightResolved ? 'resolved' : 'pending', highlightResolved ? null : now,
    now, now
  ).run();
  return true;
}

export async function recordPostgameFinal(env, game, observation = null, detectedAt = Date.now()) {
  const row = {
    event_id: text(game?.eventId || observation?.eventId),
    league: text(game?.league || observation?.league || 'bra.1'),
    home: text(game?.home?.name || game?.home || observation?.home?.name),
    away: text(game?.away?.name || game?.away || observation?.away?.name),
    kickoff: text(game?.kickoff || observation?.kickoff),
    final_at: nowIso(detectedAt),
    home_score: num(observation?.home?.score),
    away_score: num(observation?.away?.score),
  };
  return upsertTask(env, row);
}

async function seedFromMonitor(env, monitor) {
  try {
    const response = await monitor.fetch('https://internal/status');
    if (!response.ok) return 0;
    const status = await response.json();
    let count = 0;
    for (const match of status?.matches || []) {
      if (text(match?.state) !== 'post') continue;
      await upsertTask(env, {
        event_id: match.eventId, league: match.league, home: match.home, away: match.away,
        kickoff: match.kickoff, final_at: nowIso(Number(match.lastObservedAt || Date.now())), score: match.score
      });
      count += 1;
    }
    return count;
  } catch (_) { return 0; }
}

async function seedFromStatic(env, now = Date.now()) {
  const last = Date.parse(await metaGet(env, 'static_seed_at')) || 0;
  if (now - last < STATIC_SEED_INTERVAL_MS) return 0;
  await metaPut(env, 'static_seed_at', nowIso(now));
  const base = text(env?.SITE_BASE || DEFAULT_SITE_BASE).replace(/\/$/, '');
  try {
    const stamp = now;
    const [results, publicData, verifiedData, mmAuto, mmManual] = await Promise.all([
      fetchJson(`${base}/resultados.json?t=${stamp}`, { cache: 'no-store' }, 10_000),
      fetchJson(`${base}/dados-br/publicos-complementares.json?t=${stamp}`, { cache: 'no-store' }, 10_000).catch(() => ({ jogos: {} })),
      fetchJson(`${base}/dados-br/correcoes/publicos-verificados.json?t=${stamp}`, { cache: 'no-store' }, 10_000).catch(() => ({ jogos: {} })),
      fetchJson(`${base}/dados-br/melhores-momentos.json?t=${stamp}`, { cache: 'no-store' }, 10_000).catch(() => ({ jogos: {} })),
      fetchJson(`${base}/dados-br/melhores-momentos-manual.json?t=${stamp}`, { cache: 'no-store' }, 10_000).catch(() => ({ jogos: {} })),
    ]);
    const publicMap = publicData?.jogos && typeof publicData.jogos === 'object' ? publicData.jogos : {};
    const verifiedMap = verifiedData?.jogos && typeof verifiedData.jogos === 'object' ? verifiedData.jogos : {};
    const mmMap = { ...(mmAuto?.jogos || {}), ...(mmManual?.jogos || {}) };
    let count = 0;
    for (const result of results?.resultados || []) {
      const eventId = text(result?.event_id || result?.id);
      if (!eventId) continue;
      const concluded = result?.concluido === true || text(result?.estado).toLowerCase() === 'post' || /encerr|final/i.test(text(result?.status));
      if (!concluded) continue;
      const kickoffMs = Date.parse(result?.data_iso || '');
      if (Number.isFinite(kickoffMs) && kickoffMs < now - RECENT_RESULT_WINDOW_MS) continue;
      const basePub = publicMap[eventId] || {};
      const verifiedPub = verifiedMap[eventId] || {};
      const pub = { ...basePub, ...verifiedPub };
      const mm = mmMap[eventId] || null;
      await upsertTask(env, result, {
        publico: pub.publico,
        publico_pagante: pub.pagantes ?? pub.publico_pagante,
        renda: pub.renda,
        public_sources: (pub.fonte || pub.fonte_publico || pub.fonte_pagantes || pub.fonte_renda) ? { publico: pub.fonte_publico || pub.fonte, publico_pagante: pub.fonte_pagantes || pub.fonte_publico || pub.fonte, renda: pub.fonte_renda || pub.fonte_publico || pub.fonte } : null,
        highlight: mm,
      });
      count += 1;
    }
    return count;
  } catch (error) {
    await metaPut(env, 'static_seed_error', text(error?.message || error).slice(0, 500));
    return 0;
  }
}

function taskAgeHours(task, now = Date.now()) {
  const finalAt = Date.parse(task?.final_at || task?.kickoff || '') || now;
  return Math.max(0, (now - finalAt) / 3_600_000);
}

async function claimDue(env, kind, now = Date.now()) {
  const prefix = kind === 'highlight' ? 'highlight' : 'public';
  const iso = nowIso(now);
  const row = await env.DB.prepare(`SELECT * FROM postgame_fastlane WHERE ${prefix}_status<>'resolved' AND COALESCE(${prefix}_next_at,'1970-01-01T00:00:00.000Z')<=? ORDER BY COALESCE(${prefix}_last_at,'1970-01-01T00:00:00.000Z') ASC, final_at DESC LIMIT 1`).bind(iso).first();
  if (!row) return null;
  const currentNext = text(row[`${prefix}_next_at`]);
  const lockUntil = nowIso(now + 10 * 60_000);
  const result = await env.DB.prepare(`UPDATE postgame_fastlane SET ${prefix}_next_at=?, updated_at=CURRENT_TIMESTAMP WHERE event_id=? AND ${prefix}_status<>'resolved' AND COALESCE(${prefix}_next_at,'')=?`).bind(lockUntil, row.event_id, currentNext).run();
  if (Number(result?.meta?.changes || 0) < 1) return null;
  return row;
}

async function processHighlight(env, now = Date.now()) {
  const task = await claimDue(env, 'highlight', now);
  if (!task) return { attempted: false };
  const attempt = Number(task.highlight_attempts || 0) + 1;
  const found = await findOfficialHighlight(env, task, now);
  if (found.found) {
    await env.DB.prepare(`UPDATE postgame_fastlane SET highlight_json=?,highlight_status='resolved',highlight_attempts=?,highlight_last_at=?,highlight_next_at=NULL,highlight_last_error='',updated_at=CURRENT_TIMESTAMP WHERE event_id=?`)
      .bind(JSON.stringify(found.value), attempt, nowIso(now), task.event_id).run();
    return { attempted: true, resolved: true, eventId: task.event_id, value: found.value };
  }
  const delay = retryMinutes('highlight', attempt, taskAgeHours(task, now));
  await env.DB.prepare(`UPDATE postgame_fastlane SET highlight_attempts=?,highlight_last_at=?,highlight_next_at=?,highlight_last_error=?,updated_at=CURRENT_TIMESTAMP WHERE event_id=?`)
    .bind(attempt, nowIso(now), nowIso(now + delay * 60_000), text(found.reason).slice(0, 1000), task.event_id).run();
  return { attempted: true, resolved: false, eventId: task.event_id, retryMinutes: delay, reason: found.reason };
}

async function processPublic(env, now = Date.now()) {
  const task = await claimDue(env, 'public', now);
  if (!task) return { attempted: false };
  const attempt = Number(task.public_attempts || 0) + 1;
  const found = await searchPublicWithOpenAI(env, task);
  let nextTask = { ...task };
  let sources = safeJson(task.public_sources_json, {}) || {};
  if (found.found && found.values) {
    if (found.values.publico != null) nextTask.publico = found.values.publico;
    if (found.values.publico_pagante != null) nextTask.publico_pagante = found.values.publico_pagante;
    if (found.values.renda != null) nextTask.renda = found.values.renda;
    sources = { ...sources, ...(found.sources || {}) };
  }
  const complete = Number(nextTask.publico) > 0 && Number(nextTask.renda) > 0;
  const delay = complete ? null : retryMinutes('public', attempt, taskAgeHours(task, now));
  await env.DB.prepare(`UPDATE postgame_fastlane SET publico=?,publico_pagante=?,renda=?,public_sources_json=?,public_status=?,public_attempts=?,public_last_at=?,public_next_at=?,public_last_error=?,updated_at=CURRENT_TIMESTAMP WHERE event_id=?`)
    .bind(
      num(nextTask.publico), num(nextTask.publico_pagante), num(nextTask.renda), JSON.stringify(sources), complete ? 'resolved' : 'pending',
      attempt, nowIso(now), delay == null ? null : nowIso(now + delay * 60_000), found.found ? '' : text(found.reason).slice(0, 1000), task.event_id
    ).run();
  return { attempted: true, resolved: complete, partial: found.found && !complete, eventId: task.event_id, retryMinutes: delay, reason: found.reason || '' };
}

async function ensurePolicyVersion(env, now = Date.now()) {
  const current = Number(await metaGet(env, 'policy_version') || 0);
  if (current >= POSTGAME_POLICY_VERSION) return false;
  const iso = nowIso(now);
  // Reabre imediatamente apenas tarefas ainda pendentes. Isso evita que o
  // backoff antigo de horas sobreviva ao deploy da política nova.
  await env.DB.prepare(`UPDATE postgame_fastlane SET public_next_at=?, updated_at=CURRENT_TIMESTAMP WHERE public_status<>'resolved'`).bind(iso).run();
  await metaPut(env, 'static_seed_at', '1970-01-01T00:00:00.000Z');
  await metaPut(env, 'policy_version', String(POSTGAME_POLICY_VERSION));
  return true;
}

async function cleanup(env, now = Date.now()) {
  const cutoff = nowIso(now - CLEANUP_WINDOW_DAYS * 86400000);
  await env.DB.prepare(`DELETE FROM postgame_fastlane WHERE final_at<?`).bind(cutoff).run();
}

export async function runPostgameMaintenance(env, monitor, now = Date.now()) {
  const policyMigrated = await ensurePolicyVersion(env, now);
  const seededMonitor = await seedFromMonitor(env, monitor);
  const seededStatic = await seedFromStatic(env, now);
  const [highlight, publico] = await Promise.all([processHighlight(env, now), processPublic(env, now)]);
  const lastCleanup = Date.parse(await metaGet(env, 'cleanup_at')) || 0;
  if (now - lastCleanup > 24 * 60 * 60_000) {
    await cleanup(env, now);
    await metaPut(env, 'cleanup_at', nowIso(now));
  }
  const summary = { at: nowIso(now), policyVersion: POSTGAME_POLICY_VERSION, policyMigrated, seededMonitor, seededStatic, highlight, publico };
  await metaPut(env, 'last_run', JSON.stringify(summary));
  return summary;
}

function publicRow(row) {
  const highlight = safeJson(row.highlight_json, null);
  return {
    event_id: text(row.event_id), home: text(row.home), away: text(row.away), kickoff: text(row.kickoff), final_at: text(row.final_at),
    publico: num(row.publico), publico_pagante: num(row.publico_pagante), renda: num(row.renda),
    public_status: text(row.public_status), public_attempts: Number(row.public_attempts || 0), public_next_at: text(row.public_next_at),
    public_sources: safeJson(row.public_sources_json, {}) || {},
    highlight: highlight && highlight.url ? highlight : null,
    highlight_status: text(row.highlight_status), highlight_attempts: Number(row.highlight_attempts || 0), highlight_next_at: text(row.highlight_next_at),
    updated_at: text(row.updated_at)
  };
}

export async function readPostgameFastlane(env, eventIds = []) {
  const ids = [...new Set((eventIds || []).map((v) => text(v)).filter((v) => /^[A-Za-z0-9._:-]{1,128}$/.test(v)))].slice(0, MAX_API_EVENT_IDS);
  let result;
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    result = await env.DB.prepare(`SELECT * FROM postgame_fastlane WHERE event_id IN (${placeholders}) ORDER BY final_at DESC`).bind(...ids).all();
  } else {
    result = await env.DB.prepare(`SELECT * FROM postgame_fastlane ORDER BY final_at DESC LIMIT 20`).all();
  }
  return (result?.results || []).map(publicRow);
}

export async function postgameStatus(env) {
  const counts = await env.DB.prepare(`SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN public_status<>'resolved' THEN 1 ELSE 0 END) AS public_pending,
    SUM(CASE WHEN highlight_status<>'resolved' THEN 1 ELSE 0 END) AS highlight_pending
    FROM postgame_fastlane`).first();
  return {
    ok: true,
    engine: 'cloudflare-postgame-fastlane',
    version: 2,
    total: Number(counts?.total || 0),
    publicPending: Number(counts?.public_pending || 0),
    highlightPending: Number(counts?.highlight_pending || 0),
    lastRun: safeJson(await metaGet(env, 'last_run'), null),
    staticSeedError: await metaGet(env, 'static_seed_error')
  };
}
