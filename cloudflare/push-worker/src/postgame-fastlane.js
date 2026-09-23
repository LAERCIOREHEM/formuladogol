import { fetchEspnSummary } from './espn-source.js';
import { sendMail, probeMail, mailConfig, maskAddress } from './mailer.js';
import { countWebSearchCalls, recordAiUsage, recordProviderUsage } from './ai-usage.js';
import { searchPublicWithGemini, fetchSourceText, extractPublicWithWorkersAI, openAiGatewayResponsesUrl, openAiUsage } from './ai-router.js';

const DEFAULT_SITE_BASE = 'https://formuladogol.com.br';
// Fase definitiva (uma única chamada por partida). O Sol é reservado a ela e aos editoriais.
const DEFAULT_MODEL = 'gpt-5.6-sol';
// Fase de varredura: o modelo mais barato com web_search.
const DEFAULT_MINI_MODEL = 'gemini-3.5-flash-lite';
const MAX_API_EVENT_IDS = 40;
const STATIC_SEED_INTERVAL_MS = 10 * 60_000;
const RECENT_RESULT_WINDOW_MS = 48 * 60 * 60_000;
const CLEANUP_WINDOW_DAYS = 30;
const POSTGAME_POLICY_VERSION = 5;

/*
 * Política de público/renda v5 — multi-provider, agressiva e econômica:
 *   0–45 min   ESPN/fonte determinística a cada 2 min.
 *   fontes já descobertas são revisitadas diretamente e extraídas por Workers AI.
 *   +5, +12, +22 e +35 min: Gemini + Google Search Grounding (máx. 4 buscas).
 *   +45 min    OpenAI GPT-5.6 Sol + web_search como fallback final.
 *   encontrou público + renda → encerra imediatamente e nunca reabre o event_id.
 */
export const PUBLIC_POLICY = Object.freeze({
  aiStartMinutes: 5,
  geminiScheduleMinutes: [5, 12, 22, 35],
  openaiFallbackAtMinutes: 45,
  deterministicEveryMinutes: 2,
  geminiMaxAttempts: 4,
  openaiMaxToolCalls: 6,
  openaiMaxAttempts: 3,
  openaiRetryMinutes: 5,
  batchPerRun: 6,
  legacyCutoffHours: 24,
});

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
// Legado: mantido apenas para retryMinutes('public') continuar compatível.
// A política de público vigente é PUBLIC_POLICY.
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

function isReasoningModel(model) {
  return /^(o\d|gpt-5)/i.test(text(model));
}

export function publicSearchRequest(task, missing, env, phase = 'openai') {
  const model = text(env?.POSTGAME_OPENAI_MODEL) || DEFAULT_MODEL;
  const matchup = `${text(task.home)} x ${text(task.away)}`;
  const date = text(task.kickoff).slice(0, 10);
  const missingText = missing.join(', ');
  const instruction = `Fallback final. Pesquise na web dados documentais da partida ${matchup}, data ${date}, event_id ${text(task.event_id)}. Preciso exclusivamente de: ${missingText}. NÃO use memória e NÃO estime. Priorize clube/CBF/federação, ge, UOL/Estadão e imprensa regional confiável. Se um campo não estiver publicado, retorne null. Público significa público presente/total; pagantes é campo separado. Confirme confronto, data e placar antes de usar a fonte. Cada número retornado precisa ter sua própria URL efetivamente lida pelo web_search.`;
  return {
    model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: instruction }] }],
    text: { format: { type: 'json_schema', name: 'postgame_publico_renda', strict: true, schema: {
      type:'object', additionalProperties:false,
      properties:{encontrado:{type:'boolean'},publico:{type:['integer','null']},publico_pagante:{type:['integer','null']},renda:{type:['number','null']},fonte_publico:{type:['string','null']},fonte_publico_pagante:{type:['string','null']},fonte_renda:{type:['string','null']},confianca:{type:'number'},observacao:{type:'string'}},
      required:['encontrado','publico','publico_pagante','renda','fonte_publico','fonte_publico_pagante','fonte_renda','confianca','observacao']
    } } },
    tools:[{type:'web_search',search_context_size:'medium',user_location:{type:'approximate',country:'BR',timezone:'America/Sao_Paulo'}}],
    tool_choice:'required', max_tool_calls:PUBLIC_POLICY.openaiMaxToolCalls, max_output_tokens:4000,
    include:['web_search_call.action.sources'], reasoning:{effort:'medium'}
  };
}

function missingPublicFields(values) {
  const missing = [];
  if (!(Number(values.publico) > 0)) missing.push('público presente');
  if (!(Number(values.publico_pagante) > 0)) missing.push('público pagante');
  if (!(Number(values.renda) > 0)) missing.push('renda');
  return missing;
}

export async function searchPublicWithOpenAI(env, task, phase = 'sol') {
  const apiKey = text(env?.OPENAI_API_KEY);
  const missing = missingPublicFields(task);
  if (!missing.length) return { found: true, responded: false, complete: true, values: {}, model: '' };
  const request = publicSearchRequest(task, missing, env, phase);
  const model = request.model;
  if (!apiKey) return { found: false, responded: false, reason: 'openai_key_missing', model };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55_000);
  const startedAt = Date.now();
  let httpStatus = null;
  try {
    const response = await fetch(openAiGatewayResponsesUrl(env), {
      method: 'POST', signal: controller.signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'cf-aig-metadata': JSON.stringify({project:'formula-do-gol',component:'postgame',purpose:'attendance-fallback',eventId:text(task.event_id),provider:'openai'}), 'cf-aig-collect-log-payload': 'false', 'cf-aig-no-wholesale': 'true' },
      body: JSON.stringify(request)
    });
    httpStatus = response.status;
    if (!response.ok) {
      const detail = text(await response.text().catch(() => '')).slice(0, 200);
      await recordAiUsage(env, { purpose:'postgame_public', eventId:task.event_id, model, phase, webSearchCalls:0, responded:false, ok:false, httpStatus:response.status, durationMs:Date.now()-startedAt, detail });
      return { found: false, responded: false, reason: `openai_http_${response.status}${detail ? `:${detail}` : ''}`, model };
    }
    const raw = await response.json();
    const webSearchCalls = countWebSearchCalls(raw);
    const providerUsage = openAiUsage(raw);
    const output = extractOpenAIText(raw);
    if (!output) { await recordAiUsage(env,{purpose:'postgame_public',eventId:task.event_id,model,phase,webSearchCalls,responded:true,ok:false,httpStatus,durationMs:Date.now()-startedAt,detail:'openai_empty_output'}); return { found:false,responded:true,reason:'openai_empty_output',model }; }
    const parsed = safeJson(output, null);
    if (!parsed) { await recordAiUsage(env,{purpose:'postgame_public',eventId:task.event_id,model,phase,webSearchCalls,responded:true,ok:false,httpStatus,durationMs:Date.now()-startedAt,detail:'openai_invalid_json'}); return { found:false,responded:true,reason:'openai_invalid_json',model }; }
    const verified = validatePublicPayload(parsed, extractOpenAISources(raw));
    if (!verified.accepted) { await recordAiUsage(env,{purpose:'postgame_public',eventId:task.event_id,model,phase,webSearchCalls,responded:true,ok:true,httpStatus,durationMs:Date.now()-startedAt,detail:verified.reason}); return { found:false,responded:true,reason:verified.reason,model }; }
    await recordAiUsage(env,{purpose:'postgame_public',eventId:task.event_id,model,phase,webSearchCalls,responded:true,ok:true,httpStatus,durationMs:Date.now()-startedAt,detail:'accepted'});
    await recordProviderUsage(env,{provider:'openai',purpose:'postgame_public',eventId:task.event_id,model,phase,searchCalls:webSearchCalls,inputTokens:providerUsage.input,outputTokens:providerUsage.output,totalTokens:providerUsage.total,responded:true,ok:true,httpStatus,durationMs:Date.now()-startedAt,detail:'accepted'});
    return { found: true, responded: true, model, ...verified };
  } catch (error) {
    const detail=text(error?.message||error).slice(0,240);
    await recordAiUsage(env,{purpose:'postgame_public',eventId:task.event_id,model,phase,webSearchCalls:0,responded:false,ok:false,httpStatus,durationMs:Date.now()-startedAt,detail});
    return { found: false, responded: false, reason: `openai_error:${detail}`, model };
  } finally { clearTimeout(timer); }
}

// ------------------------------------------------------------------------
// ESPN: fonte gratuita. Mesmo critério do coletor Python
// (buscar_detalhes_jogos_brasileirao.parse_publico): varre o summary atrás de
// chaves de público e fica com o maior valor plausível.
// ------------------------------------------------------------------------
function attendanceNumber(value) {
  if (value && typeof value === 'object') {
    for (const key of ['value', 'displayValue', 'formattedValue', 'text', 'shortText', 'name']) {
      const found = attendanceNumber(value[key]);
      if (found != null) return found;
    }
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return clampInt(value, 500, 150000);
  const digits = text(value).replace(/\D/g, '');
  if (!digits) return null;
  return clampInt(Number(digits), 500, 150000);
}

export function parseEspnAttendance(summary) {
  const found = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 12 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    for (const [key, value] of Object.entries(node)) {
      const k = normalizeText(key).replace(/\s+/g, '');
      if (k === 'attendance' || k === 'crowd' || k === 'publico' || k === 'spectators' || k.includes('attendance') || k.includes('spectator')) {
        const n = attendanceNumber(value);
        if (n != null) found.push(n);
      }
      if (value && typeof value === 'object') walk(value, depth + 1);
    }
  };
  walk(summary, 0);
  return found.length ? Math.max(...found) : null;
}

async function fetchEspnAttendance(task) {
  const league = text(task.league) || 'bra.1';
  const eventId = text(task.event_id);
  if (!eventId) return { publico: null, error: 'event_id_missing' };
  try {
    const summary = await fetchEspnSummary(league, eventId);
    const publico = parseEspnAttendance(summary?.data);
    if (publico == null) return { publico: null, error: '' };
    return { publico, source: `https://www.espn.com.br/futebol/partida/_/jogoId/${encodeURIComponent(eventId)}`, error: '' };
  } catch (error) {
    return { publico: null, error: `espn:${text(error?.message || error).slice(0, 160)}` };
  }
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
  const row = await env.DB.prepare(`SELECT * FROM postgame_fastlane WHERE ${prefix}_status NOT IN ('resolved','gave_up') AND COALESCE(${prefix}_next_at,'1970-01-01T00:00:00.000Z')<=? ORDER BY COALESCE(${prefix}_last_at,'1970-01-01T00:00:00.000Z') ASC, final_at DESC LIMIT 1`).bind(iso).first();
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


async function cacheDiscoveredSources(env, eventId, urls, provider='gemini') {
  for (const raw of urls || []) {
    const url = normalizeUrl(raw); if (!url) continue;
    await env.DB.prepare(`INSERT INTO postgame_source_cache(event_id,url,provider,discovered_at) VALUES(?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(event_id,url) DO UPDATE SET provider=excluded.provider`).bind(text(eventId),url,text(provider)).run();
  }
}
async function cachedSources(env,eventId){
  const r=await env.DB.prepare(`SELECT * FROM postgame_source_cache WHERE event_id=? ORDER BY COALESCE(last_checked_at,'') ASC,discovered_at DESC LIMIT 8`).bind(text(eventId)).all();
  return r?.results||[];
}
function validateGroundedValues(parsed, sourceUrl='') {
  if (!sourceUrl) return null;
  const p=parsed&&typeof parsed==='object'?parsed:{}; const confidence=Number(p.confianca||0);
  if(p.encontrado!==true||confidence<0.85)return null;
  const values={publico:clampInt(p.publico,500,150000),publico_pagante:clampInt(p.publico_pagante,0,150000),renda:clampMoney(p.renda)};
  if(values.publico!=null&&values.publico_pagante!=null&&values.publico_pagante>values.publico)return null;
  if(values.publico==null&&values.publico_pagante==null&&values.renda==null)return null;
  const sources={}; for(const k of Object.keys(values)) if(values[k]!=null&&sourceUrl)sources[k]=sourceUrl;
  return {values,sources,confidence};
}
async function refreshCachedPublicSources(env,task,values,sources){
  const rows=await cachedSources(env,task.event_id); let checked=0; let foundAny=false; let lastError='';
  for(const row of rows.slice(0,4)){
    const source=await fetchSourceText(row.url); checked++;
    if(!source.ok){lastError=source.reason;await env.DB.prepare(`UPDATE postgame_source_cache SET last_checked_at=CURRENT_TIMESTAMP,last_status=?,failures=failures+1 WHERE event_id=? AND url=?`).bind(source.reason,task.event_id,row.url).run();continue;}
    const extracted=await extractPublicWithWorkersAI(env,task,source); const valid=validateGroundedValues(extracted.parsed,source.url);
    await env.DB.prepare(`UPDATE postgame_source_cache SET last_checked_at=CURRENT_TIMESTAMP,last_status=?,failures=CASE WHEN ?='ok' THEN failures ELSE failures+1 END WHERE event_id=? AND url=?`).bind(valid?'ok':text(extracted.reason)||'no_data',valid?'ok':'fail',task.event_id,row.url).run();
    if(valid){foundAny=true;for(const key of ['publico','publico_pagante','renda']){if(valid.values[key]!=null&&!(Number(values[key])>0)){values[key]=valid.values[key];sources[key]=valid.sources[key];}}}
    if(isPublicComplete(values))break;
  }
  return {checked,foundAny,lastError};
}

// ------------------------------------------------------------------------
// Estado da busca por IA. Tabela lateral (migration 0010) porque o deploy
// reaplica todas as migrations a cada execução e ALTER TABLE não é idempotente.
// ------------------------------------------------------------------------
async function readPublicAiState(env, eventId) {
  const row = await env.DB.prepare('SELECT * FROM postgame_public_ai WHERE event_id=?').bind(eventId).first();
  return {
    deterministic_checks: Number(row?.deterministic_checks || 0),
    mini_attempts: Number(row?.mini_attempts || 0),
    sol_attempts: Number(row?.sol_attempts || 0),
    sol_completed: Number(row?.sol_completed || 0),
    last_phase: text(row?.last_phase),
    last_model: text(row?.last_model),
    mini_last_error: text(row?.mini_last_error),
    alert_at: text(row?.alert_at),
    alert_status: text(row?.alert_status),
  };
}

async function writePublicAiState(env, eventId, state) {
  await env.DB.prepare(`INSERT INTO postgame_public_ai (
      event_id,deterministic_checks,mini_attempts,sol_attempts,sol_completed,last_phase,last_model,mini_last_error,alert_at,alert_status,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT(event_id) DO UPDATE SET
      deterministic_checks=excluded.deterministic_checks, mini_attempts=excluded.mini_attempts,
      sol_attempts=excluded.sol_attempts, sol_completed=excluded.sol_completed,
      last_phase=excluded.last_phase, last_model=excluded.last_model, mini_last_error=excluded.mini_last_error,
      alert_at=excluded.alert_at, alert_status=excluded.alert_status, updated_at=CURRENT_TIMESTAMP`)
    .bind(
      eventId, Number(state.deterministic_checks || 0), Number(state.mini_attempts || 0), Number(state.sol_attempts || 0),
      Number(state.sol_completed || 0), text(state.last_phase), text(state.last_model), text(state.mini_last_error).slice(0, 500),
      text(state.alert_at) || null, text(state.alert_status)
    ).run();
}

export function taskEndMs(task, now = Date.now()) {
  const finalAt = Date.parse(task?.final_at || '');
  if (Number.isFinite(finalAt)) return finalAt;
  const kickoff = Date.parse(task?.kickoff || '');
  if (Number.isFinite(kickoff)) return kickoff + 115 * 60_000;
  return now;
}

export function isPublicComplete(values) {
  return Number(values?.publico) > 0 && Number(values?.renda) > 0;
}

// Decide a fase da PRÓXIMA ação para a partida. Função pura: testável sem D1.
export function planPublicStep(task, ai, now = Date.now()) {
  const P=PUBLIC_POLICY; const ageMinutes=(now-taskEndMs(task,now))/60_000;
  const gemini=Number(ai?.mini_attempts||0); const openai=Number(ai?.sol_attempts||0);
  if(Number(ai?.sol_completed||0)>0||openai>=P.openaiMaxAttempts)return{phase:'give_up',ageMinutes};
  if(ageMinutes<P.aiStartMinutes)return{phase:'deterministic',ageMinutes};
  if(gemini===0)return{phase:'gemini',ageMinutes};
  if(ageMinutes>=P.openaiFallbackAtMinutes&&gemini>0)return{phase:'openai',ageMinutes};
  if(gemini>=P.geminiMaxAttempts)return{phase:'deterministic',ageMinutes};
  const dueAt=P.geminiScheduleMinutes[Math.min(gemini,P.geminiScheduleMinutes.length-1)];
  if(ageMinutes>=dueAt)return{phase:'gemini',ageMinutes};
  return{phase:'deterministic',ageMinutes};
}

export function nextPublicAttemptMs(task, phaseDone, nextPlan, now=Date.now(), ai={}) {
  const P=PUBLIC_POLICY,end=taskEndMs(task,now),floor=now+60_000;
  if(phaseDone==='openai'&&nextPlan.phase==='openai')return now+P.openaiRetryMinutes*60_000;
  if(nextPlan.phase==='openai')return Math.max(floor,end+P.openaiFallbackAtMinutes*60_000);
  if(nextPlan.phase==='gemini'){const idx=Math.min(Number(ai?.mini_attempts||0),P.geminiScheduleMinutes.length-1);return Math.max(floor,end+P.geminiScheduleMinutes[idx]*60_000);}
  const g=Number(ai?.mini_attempts||0);const nextGemini=P.geminiScheduleMinutes[Math.min(g,P.geminiScheduleMinutes.length-1)];
  const boundary=g<P.geminiMaxAttempts?end+nextGemini*60_000:end+P.openaiFallbackAtMinutes*60_000;
  return Math.max(floor,Math.min(now+P.deterministicEveryMinutes*60_000,boundary));
}

function brDateTime(value) {
  const ms = Date.parse(text(value));
  if (!Number.isFinite(ms)) return text(value) || 'não informado';
  try {
    return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms)) + ' (Brasília)';
  } catch (_) { return new Date(ms).toISOString(); }
}

function fmtInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n).toLocaleString('pt-BR') : '';
}

export function publicAlertMessage(task, values, sources, ai, lastError, env = {}) {
  const home = text(task.home), away = text(task.away);
  const score = (task.home_score != null && task.away_score != null) ? ` ${task.home_score} x ${task.away_score} ` : ' x ';
  const line = (label, value, source, money = false) => {
    if (!(Number(value) > 0)) return `- ${label}: NÃO ENCONTRADO`;
    const shown = money ? `R$ ${Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : fmtInt(value);
    return `- ${label}: ${shown}${source ? ` (${source})` : ''}`;
  };
  const miniModel = text(env?.GEMINI_SEARCH_MODEL) || DEFAULT_MINI_MODEL;
  const solModel = text(env?.POSTGAME_OPENAI_MODEL) || DEFAULT_MODEL;
  const subject = `⚠️ Fórmula do Gol: público/renda não localizados — ${home} x ${away}`;
  const body = [
    'A busca automática terminou sem encontrar público e renda completos.',
    '',
    `Partida: ${home}${score}${away}`,
    `Início: ${brDateTime(task.kickoff)}`,
    `Fim registrado: ${brDateTime(task.final_at)}`,
    `event_id: ${text(task.event_id)}`,
    '',
    'O que foi encontrado:',
    line('Público', values.publico, sources?.publico),
    line('Pagantes', values.publico_pagante, sources?.publico_pagante),
    line('Renda', values.renda, sources?.renda, true),
    '',
    'Tentativas realizadas:',
    `- ESPN (gratuita): ${Number(ai.deterministic_checks || 0)} consulta(s)`,
    `- Gemini + Google Search (${miniModel}): ${Number(ai.mini_attempts || 0)} busca(s)`,
    `- OpenAI fallback (${solModel}): ${Number(ai.sol_attempts || 0)} chamada(s)`,
    `Último erro: ${text(lastError) || 'nenhum — a informação não foi publicada nas fontes consultadas'}`,
    ...(text(ai.mini_last_error) && /^(gemini_|openai_)(http|error)/.test(text(ai.mini_last_error))
      ? [`ATENÇÃO — a IA econômica falhou tecnicamente: ${text(ai.mini_last_error)}. Verifique GEMINI_API_KEY/GEMINI_SEARCH_MODEL.`]
      : []),
    '',
    'Nenhuma nova busca automática será feita para esta partida.',
    'Para completar manualmente, adicione a partida em dados-br/correcoes/publicos-verificados.json.',
    'O Worker aplica o valor em até 10 minutos.'
  ].join('\n');
  return { subject, body };
}

async function sendPublicNotFoundEmail(env, message) {
  return sendMail(env, message);
}

// Login SMTP sem envio, no máximo uma vez por dia e sempre que a configuração
// mudar. Mostra em /v1/postgame/status se o e-mail vai funcionar ANTES de o
// primeiro alerta real ser necessário.
async function configFingerprint(env) {
  const cfg = mailConfig(env);
  const raw = [cfg.transport, cfg.smtp.host, cfg.smtp.port, cfg.smtp.user, cfg.to, cfg.smtp.pass].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function maybeProbeMailer(env, now = Date.now()) {
  try {
    if (mailConfig(env).transport !== 'smtp') return null;
    const fingerprint = await configFingerprint(env);
    const previous = safeJson(await metaGet(env, 'mailer_probe'), null);
    const fresh = previous && previous.fingerprint === fingerprint && now - (Date.parse(previous.at) || 0) < 24 * 3_600_000;
    if (fresh) return null;
    const result = await probeMail(env);
    const record = { at: nowIso(now), fingerprint, ok: result.ok, status: result.status };
    await metaPut(env, 'mailer_probe', JSON.stringify(record));
    return record;
  } catch (error) {
    return { ok: false, status: `probe_error:${text(error?.message || error).slice(0, 160)}` };
  }
}

async function processPublicTask(env, task, now = Date.now()) {
  const eventId=text(task.event_id); const ai=await readPublicAiState(env,eventId); const plan=planPublicStep(task,ai,now);
  const values={publico:num(task.publico),publico_pagante:num(task.publico_pagante),renda:num(task.renda)};
  let sources=safeJson(task.public_sources_json,{})||{}; const next={...ai,last_phase:plan.phase}; let lastError='';

  if(plan.phase!=='give_up'&&!(Number(values.publico)>0)){
    const espn=await fetchEspnAttendance(task); next.deterministic_checks=Number(next.deterministic_checks||0)+1;
    if(espn.publico){values.publico=espn.publico;sources={...sources,publico:espn.source};}else if(espn.error)lastError=espn.error;
  }

  // Reconsulta barata das URLs já descobertas antes de fazer nova pesquisa paga/grounded.
  if(!isPublicComplete(values)){
    const cached=await refreshCachedPublicSources(env,task,values,sources);
    if(cached.lastError&&!lastError)lastError=cached.lastError;
  }

  if(!isPublicComplete(values)&&plan.phase==='gemini'){
    const missing=missingPublicFields(values); const found=await searchPublicWithGemini(env,{...task,...values},missing);
    next.last_model=text(found.model); next.mini_attempts=Number(next.mini_attempts||0)+1; next.mini_last_error=found.found?'':text(found.reason);
    await cacheDiscoveredSources(env,eventId,found.sources,'gemini');
    const valid=validateGroundedValues(found.parsed,(found.sources||[])[0]||'');
    if(valid){for(const key of ['publico','publico_pagante','renda'])if(valid.values[key]!=null&&!(Number(values[key])>0)){values[key]=valid.values[key];sources[key]=valid.sources[key];}}
    else if(!found.found)lastError=text(found.reason)||lastError;
  }

  if(!isPublicComplete(values)&&plan.phase==='openai'){
    const found=await searchPublicWithOpenAI(env,{...task,...values},'openai'); next.last_model=text(found.model); next.sol_attempts=Number(next.sol_attempts||0)+1;
    if(found.responded)next.sol_completed=1;
    if(found.found&&found.values){for(const key of ['publico','publico_pagante','renda'])if(found.values[key]!=null&&!(Number(values[key])>0))values[key]=found.values[key];sources={...sources,...(found.sources||{})};}
    else lastError=text(found.reason)||lastError;
  }

  const complete=isPublicComplete(values); let status=complete?'resolved':'pending'; let nextAt=null;
  if(!complete){const nextPlan=planPublicStep(task,next,now);if(nextPlan.phase==='give_up'){status='gave_up';if(!next.alert_at){next.alert_status=await sendPublicNotFoundEmail(env,publicAlertMessage(task,values,sources,next,lastError,env));next.alert_at=nowIso(now);}}else{let nextMs=nextPublicAttemptMs(task,plan.phase,nextPlan,now,next);nextAt=nowIso(nextMs);}}
  await env.DB.prepare(`UPDATE postgame_fastlane SET publico=?,publico_pagante=?,renda=?,public_sources_json=?,public_status=?,public_attempts=?,public_last_at=?,public_next_at=?,public_last_error=?,updated_at=CURRENT_TIMESTAMP WHERE event_id=?`).bind(num(values.publico),num(values.publico_pagante),num(values.renda),JSON.stringify(sources),status,Number(task.public_attempts||0)+1,nowIso(now),nextAt,complete?'':text(lastError).slice(0,1000),eventId).run();
  await writePublicAiState(env,eventId,next);
  return{eventId,phase:plan.phase,status,nextAt,model:next.last_model||'',alert:status==='gave_up'?next.alert_status:'',reason:complete?'':lastError};
}

async function processPublic(env, now = Date.now()) {
  const tasks = [];
  for (let i = 0; i < PUBLIC_POLICY.batchPerRun; i += 1) {
    const task = await claimDue(env, 'public', now);
    if (!task) break;
    tasks.push(task);
  }
  if (!tasks.length) return { attempted: false };
  const results = await Promise.all(tasks.map((task) => processPublicTask(env, task, now).catch((error) => ({
    eventId: text(task.event_id), status: 'error', reason: text(error?.message || error).slice(0, 300)
  }))));
  return { attempted: true, processed: results.length, results };
}

async function ensurePolicyVersion(env, now = Date.now()) {
  const current = Number(await metaGet(env, 'policy_version') || 0);
  if (current >= POSTGAME_POLICY_VERSION) return false;
  const iso = nowIso(now);
  const legacyCutoff = nowIso(now - PUBLIC_POLICY.legacyCutoffHours * 3_600_000);
  // Política v5: pendências com mais de 24h já foram pesquisadas muitas vezes
  // pela política antiga. Elas encerram em silêncio — sem nova IA e sem uma
  // rajada de e-mails no deploy. Correção manual continua entrando pelo seed.
  await env.DB.prepare(`UPDATE postgame_fastlane SET public_status='gave_up', public_next_at=NULL, public_last_error='encerrada_na_migracao_v3', updated_at=CURRENT_TIMESTAMP
    WHERE public_status NOT IN ('resolved','gave_up') AND final_at<>'' AND final_at<?`).bind(legacyCutoff).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO postgame_public_ai (event_id,last_phase,alert_at,alert_status)
    SELECT event_id,'legacy',?, 'suppressed_legacy' FROM postgame_fastlane WHERE public_status='gave_up'`).bind(iso).run();
  // As recentes entram na política nova imediatamente.
  await env.DB.prepare(`UPDATE postgame_fastlane SET public_next_at=?, updated_at=CURRENT_TIMESTAMP WHERE public_status NOT IN ('resolved','gave_up')`).bind(iso).run();
  await metaPut(env, 'static_seed_at', '1970-01-01T00:00:00.000Z');
  await metaPut(env, 'policy_version', String(POSTGAME_POLICY_VERSION));
  return true;
}

async function cleanup(env, now = Date.now()) {
  const cutoff = nowIso(now - CLEANUP_WINDOW_DAYS * 86400000);
  await env.DB.prepare(`DELETE FROM postgame_fastlane WHERE final_at<?`).bind(cutoff).run();
  await env.DB.prepare(`DELETE FROM postgame_public_ai WHERE event_id NOT IN (SELECT event_id FROM postgame_fastlane)`).run();
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
  const mailer = await maybeProbeMailer(env, now);
  const summary = { at: nowIso(now), policyVersion: POSTGAME_POLICY_VERSION, policyMigrated, seededMonitor, seededStatic, highlight, publico, mailerProbe: mailer };
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
    public_ai: {
      phase: text(row.ai_last_phase), model: text(row.ai_last_model),
      espn_checks: Number(row.ai_deterministic_checks || 0), mini_attempts: Number(row.ai_mini_attempts || 0),
      sol_attempts: Number(row.ai_sol_attempts || 0), alert_at: text(row.ai_alert_at), alert_status: text(row.ai_alert_status)
    },
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
    result = await env.DB.prepare(`SELECT p.*, a.last_phase AS ai_last_phase, a.last_model AS ai_last_model, a.deterministic_checks AS ai_deterministic_checks, a.mini_attempts AS ai_mini_attempts, a.sol_attempts AS ai_sol_attempts, a.alert_at AS ai_alert_at, a.alert_status AS ai_alert_status FROM postgame_fastlane p LEFT JOIN postgame_public_ai a ON a.event_id=p.event_id WHERE p.event_id IN (${placeholders}) ORDER BY p.final_at DESC`).bind(...ids).all();
  } else {
    result = await env.DB.prepare(`SELECT p.*, a.last_phase AS ai_last_phase, a.last_model AS ai_last_model, a.deterministic_checks AS ai_deterministic_checks, a.mini_attempts AS ai_mini_attempts, a.sol_attempts AS ai_sol_attempts, a.alert_at AS ai_alert_at, a.alert_status AS ai_alert_status FROM postgame_fastlane p LEFT JOIN postgame_public_ai a ON a.event_id=p.event_id ORDER BY p.final_at DESC LIMIT 20`).all();
  }
  return (result?.results || []).map(publicRow);
}

export async function postgameStatus(env) {
  const probeRaw = await metaGet(env, 'mailer_probe');
  const counts = await env.DB.prepare(`SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN public_status NOT IN ('resolved','gave_up') THEN 1 ELSE 0 END) AS public_pending,
    SUM(CASE WHEN public_status='gave_up' THEN 1 ELSE 0 END) AS public_gave_up,
    SUM(CASE WHEN highlight_status<>'resolved' THEN 1 ELSE 0 END) AS highlight_pending
    FROM postgame_fastlane`).first();
  return {
    ok: true,
    engine: 'cloudflare-postgame-fastlane',
    version: POSTGAME_POLICY_VERSION,
    publicPolicy: PUBLIC_POLICY,
    total: Number(counts?.total || 0),
    publicPending: Number(counts?.public_pending || 0),
    publicGaveUp: Number(counts?.public_gave_up || 0),
    highlightPending: Number(counts?.highlight_pending || 0),
    lastRun: safeJson(await metaGet(env, 'last_run'), null),
    mailer: (() => {
      const cfg = mailConfig(env);
      return { transport: cfg.transport, configured: cfg.configured, destino: maskAddress(cfg.to) };
    })(),
    mailerProbe: (() => { const p = safeJson(probeRaw, null); return p ? { at: p.at, ok: p.ok, status: p.status } : null; })(),
    staticSeedError: await metaGet(env, 'static_seed_error')
  };
}
