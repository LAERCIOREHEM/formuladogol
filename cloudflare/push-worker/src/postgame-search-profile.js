export const POSTGAME_SEARCH_PROFILE_VERSION = 8;

function text(value) { return String(value ?? '').trim(); }
function normalizeText(value) {
  return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function sourceHostname(value) {
  try { return new URL(text(value)).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return ''; }
}
function unique(values) { return [...new Set((values || []).map((v) => text(v)).filter(Boolean))]; }

// Um único cadastro serve às buscas de público/renda e à validação de identidade.
// Os domínios oficiais reproduzem a allowlist que já existia no coletor Python
// scripts/completar_publicos_ia.py; no Worker eles só são aceitos quando o clube
// é participante da partida consultada.
export const TEAM_SEARCH_PROFILES = Object.freeze({
  'Athletico-PR': Object.freeze({ aliases: ['Athletico-PR','Athletico PR','Athletico Paranaense','Atlético-PR'], officialDomains: ['athleticoparanaense.com'] }),
  'Atlético-MG': Object.freeze({ aliases: ['Atlético-MG','Atlético MG','Atlético Mineiro','Galo'], officialDomains: ['atletico.com.br'] }),
  'Bahia': Object.freeze({ aliases: ['Bahia','EC Bahia','Esporte Clube Bahia'], officialDomains: ['esporteclubebahia.com.br'] }),
  'Botafogo': Object.freeze({ aliases: ['Botafogo','Botafogo-RJ'], officialDomains: ['botafogo.com.br'] }),
  'Bragantino': Object.freeze({ aliases: ['Bragantino','RB Bragantino','Red Bull Bragantino','Red Bull Braga','Braga'], officialDomains: ['redbullbragantino.com.br'] }),
  'Chapecoense': Object.freeze({ aliases: ['Chapecoense','Chape'], officialDomains: ['chapecoense.com'] }),
  'Corinthians': Object.freeze({ aliases: ['Corinthians','Sport Club Corinthians','Timão'], officialDomains: ['corinthians.com.br'] }),
  'Coritiba': Object.freeze({ aliases: ['Coritiba','Coritiba FC','Coxa','Coxa-Branca'], officialDomains: ['coritiba.com.br'] }),
  'Cruzeiro': Object.freeze({ aliases: ['Cruzeiro','Cruzeiro EC'], officialDomains: ['cruzeiro.com.br'] }),
  'Flamengo': Object.freeze({ aliases: ['Flamengo','CR Flamengo','Fla'], officialDomains: ['flamengo.com.br'] }),
  'Fluminense': Object.freeze({ aliases: ['Fluminense','Flu'], officialDomains: ['fluminense.com.br'] }),
  'Grêmio': Object.freeze({ aliases: ['Grêmio','Gremio','Grêmio FBPA'], officialDomains: ['gremio.net'] }),
  'Internacional': Object.freeze({ aliases: ['Internacional','SC Internacional','Inter'], officialDomains: ['internacional.com.br'] }),
  'Mirassol': Object.freeze({ aliases: ['Mirassol','Mirassol FC','Mirassol Futebol Clube'], officialDomains: ['mirassolfc.com.br'] }),
  'Palmeiras': Object.freeze({ aliases: ['Palmeiras','SE Palmeiras','Verdão'], officialDomains: ['palmeiras.com.br'] }),
  'Remo': Object.freeze({ aliases: ['Remo','Clube do Remo'], officialDomains: ['remo.com.br'] }),
  'Santos': Object.freeze({ aliases: ['Santos','Santos FC','Peixe'], officialDomains: ['santosfc.com.br'] }),
  'São Paulo': Object.freeze({ aliases: ['São Paulo','Sao Paulo','São Paulo FC','SPFC'], officialDomains: ['saopaulofc.net'] }),
  'Vasco da Gama': Object.freeze({ aliases: ['Vasco da Gama','Vasco','CR Vasco da Gama'], officialDomains: ['vasco.com.br'] }),
  'Vitória': Object.freeze({ aliases: ['Vitória','Vitoria','EC Vitória','EC Vitoria'], officialDomains: ['ecvitoria.com.br'] }),
});

export const PREFERRED_EDITORIAL_SOURCE_SUFFIXES = Object.freeze([
  'cbf.com.br',
  'ge.globo.com', 'globoesporte.globo.com', 'sportv.globo.com', 'oglobo.globo.com',
  'espn.com.br', 'uol.com.br', 'folha.uol.com.br', 'band.uol.com.br',
  'lance.com.br', 'gazetaesportiva.com', 'terra.com.br', 'r7.com', 'estadao.com.br',
  'metropoles.com', 'cnnbrasil.com.br', 'correiobraziliense.com.br',
  // imprensa regional — frequentemente publica a ficha técnica antes dos portais nacionais
  'bahianoticias.com.br', 'itatiaia.com.br', 'otempo.com.br', 'em.com.br',
  'gauchazh.clicrbs.com.br', 'nsctotal.com.br', 'diariodonordeste.verdesmares.com.br',
  'opovo.com.br', 'gp1.com.br', 'oliberal.com', 'acritica.com',
]);

const REJECTED_SOURCE_HOST_RE = /(facebook|instagram|twitter|x\.com$|tiktok|youtube|reddit|forum|foro|blogspot|wordpress|bet|bets|aposta|torcida)/i;

function lookupProfile(team) {
  const exact = TEAM_SEARCH_PROFILES[text(team)];
  if (exact) return exact;
  const wanted = normalizeText(team);
  if (!wanted) return null;
  for (const profile of Object.values(TEAM_SEARCH_PROFILES)) {
    if (profile.aliases.some((alias) => normalizeText(alias) === wanted)) return profile;
  }
  return null;
}

export function teamSearchVariants(team, limit = 5) {
  const canonical = text(team);
  const profile = lookupProfile(canonical);
  const values = unique([canonical, ...(profile?.aliases || [])]);
  // Nomes mais informativos primeiro; apelidos continuam presentes como fallback.
  values.sort((a, b) => {
    if (a === canonical) return -1;
    if (b === canonical) return 1;
    const aw = a.includes(' ') ? 1 : 0, bw = b.includes(' ') ? 1 : 0;
    if (aw !== bw) return bw - aw;
    return b.length - a.length;
  });
  return values.slice(0, Math.max(1, Number(limit) || 5));
}

export function teamSearchAliasesNormalized(team) {
  return teamSearchVariants(team, 8).map(normalizeText).filter((v) => v.length >= 2);
}

export function officialClubDomainsForTask(task) {
  const out = [];
  for (const team of [task?.home, task?.away]) {
    const profile = lookupProfile(team);
    for (const domain of profile?.officialDomains || []) if (!out.includes(domain)) out.push(domain);
  }
  return out;
}

export function attendanceSourceQuality(value, task = null) {
  const host = sourceHostname(value);
  if (!host || REJECTED_SOURCE_HOST_RE.test(host)) return 'rejected';
  if (PREFERRED_EDITORIAL_SOURCE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return 'robust';
  const official = officialClubDomainsForTask(task);
  if (official.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return 'club_official';
  return 'unverified';
}

export function isAcceptedAttendanceSource(value, task = null) {
  const quality = attendanceSourceQuality(value, task);
  return quality === 'robust' || quality === 'club_official';
}

export const AMBIGUOUS_IDENTITY_ALIASES = Object.freeze(new Set(['vitoria', 'internacional', 'santos', 'bahia', 'remo']));
// Apelidos curtos continuam excelentes para DESCOBERTA, mas não são prova de
// identidade por si só. A etapa de validação privilegia nomes canônicos/fortes.
const SEARCH_ONLY_WEAK_IDENTITY_ALIASES = new Set(['galo','fla','flu','inter','timao','coxa','peixe','verdao','braga','chape']);
const IDENTITY_PAIR_MAX_CHARS = 420;
const IDENTITY_CONTEXT_RADIUS = 900;
const IDENTITY_EXTRACTION_SUFFIX = 1800;

function urlDate(value) {
  const raw = text(value);
  const m = raw.match(/\/(20\d{2})\/(\d{1,2})\/(\d{1,2})(?:\/|$)/);
  if (!m) return '';
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
  return `${String(y).padStart(4,'0')}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function daysBetweenIso(a, b) {
  const x = Date.parse(`${a}T12:00:00Z`), y = Date.parse(`${b}T12:00:00Z`);
  return Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) / 86400000 : null;
}
function identityAliases(team) {
  const aliases = teamSearchAliasesNormalized(team).filter(Boolean);
  const strong = aliases.filter((alias) => !SEARCH_ONLY_WEAK_IDENTITY_ALIASES.has(alias));
  return (strong.length ? strong : aliases).sort((a,b) => b.length - a.length);
}
function aliasOccurrences(normalized, alias) {
  const out = [];
  const needle = ` ${alias} `;
  let from = 0;
  while (from < normalized.length) {
    const idx = normalized.indexOf(needle, from);
    if (idx < 0) break;
    const start = idx + 1;
    if (AMBIGUOUS_IDENTITY_ALIASES.has(alias)) {
      const previous = normalized.slice(Math.max(0, start - 24), start).trim().split(/\s+/).at(-1) || '';
      if (/^(?:uma|a|da|na|pela|para|sua|essa|esta|primeira|segunda|terceira)$/.test(previous)) {
        from = idx + needle.length;
        continue;
      }
    }
    out.push({ alias, start, end: start + alias.length });
    from = idx + needle.length;
  }
  return out;
}
function bestPair(normalized, homeAliases, awayAliases) {
  const homes = homeAliases.flatMap((a) => aliasOccurrences(normalized, a));
  const aways = awayAliases.flatMap((a) => aliasOccurrences(normalized, a));
  let best = null;
  for (const h of homes) for (const a of aways) {
    const distance = Math.max(0, Math.max(h.start, a.start) - Math.min(h.end, a.end));
    if (!best || distance < best.distance) best = { home: h, away: a, distance };
  }
  return best;
}
function taskScoreRegex(task) {
  const h = Number(task?.home_score), a = Number(task?.away_score);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
  return new RegExp(`\\b${h}\\s*[x×-]\\s*${a}\\b`,'i');
}
function taskRoundRegex(task) {
  const round = Number(task?.round ?? task?.rodada);
  return Number.isFinite(round) && round > 0 ? new RegExp(`(?:\\b${round}\\s*[ªaºo]?\\s*rodada\\b|\\brodada\\s*${round}\\b)`,'i') : null;
}
function matchRelationEvidence(normWindow, homeAlias, awayAlias) {
  const h = homeAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const a = awayAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const relation = '(?:enfrent(?:a|am|ou|aram|ando)|jog(?:a|am|ou|aram)|receb(?:e|eu)|gole(?:ia|ou)|bate(?:u)?|vence(?:u)?|venceu|perdeu\\s+para|empata(?:ram|ou)?|classico)';
  const patterns = [
    new RegExp(`\\b${h}\\s+\\d{1,2}\\s*[x×-]\\s*\\d{1,2}\\s+${a}\\b`,'i'),
    new RegExp(`\\b${h}\\s*(?:x|vs|versus|contra)\\s*${a}\\b`,'i'),
    new RegExp(`\\b${h}\\b.{0,90}\\b${relation}\\b.{0,90}\\b${a}\\b`,'i'),
    new RegExp(`\\b${a}\\b.{0,90}\\b${relation}\\b.{0,90}\\b${h}\\b`,'i'),
    new RegExp(`\\b${h}\\s+e\\s+${a}\\b.{0,90}\\b(?:enfrent|jog|duel|classico)`,'i'),
    new RegExp(`\\bentre\\s+${h}\\s+e\\s+${a}\\b`,'i'),
  ];
  return patterns.some((re) => re.test(normWindow));
}

// R10R15: Match Identity Gate. Descobrir uma URL e provar que ela pertence ao
// event_id são etapas distintas. O gate exige os DOIS clubes no mesmo bloco
// contextual e rejeita conflitos objetivos, sobretudo data incompatível na URL.
export function evaluateSourceMatchIdentity(task, sourceText, sourceUrl = '') {
  const raw = text(sourceText).replace(/\s+/g, ' ');
  const normalized = ` ${normalizeText(raw)} `;
  const result = { accepted:false, score:0, reasons:[], conflicts:[], homeAlias:'', awayAlias:'', pairDistance:null, window:'' };
  if (!normalized.trim()) { result.reasons.push('empty_source_text'); return result; }

  const gameDate = text(task?.kickoff || task?.data_iso).slice(0,10);
  const sourceDate = urlDate(sourceUrl);
  let dateProof = false;
  if (gameDate && sourceDate) {
    const delta = daysBetweenIso(gameDate, sourceDate);
    if (delta != null && delta > 3) result.conflicts.push(`url_date_mismatch:${sourceDate}:${gameDate}`);
    else { result.score += 4; dateProof = true; }
  }

  const pair = bestPair(normalized, identityAliases(task?.home), identityAliases(task?.away));
  if (!pair) { result.reasons.push('teams_not_both_found'); return result; }
  result.homeAlias = pair.home.alias; result.awayAlias = pair.away.alias; result.pairDistance = pair.distance;
  if (pair.distance > IDENTITY_PAIR_MAX_CHARS) { result.reasons.push(`teams_too_far:${pair.distance}`); return result; }

  const pairStart = Math.min(pair.home.start,pair.away.start);
  const pairEnd = Math.max(pair.home.end,pair.away.end);
  const center = Math.floor((pairStart + pairEnd) / 2);
  const contextStart = Math.max(0, center - IDENTITY_CONTEXT_RADIUS);
  const contextEnd = Math.min(raw.length, center + IDENTITY_CONTEXT_RADIUS);
  const contextWindow = raw.slice(contextStart, contextEnd).trim();
  const normWindow = ` ${normalizeText(contextWindow)} `;
  if (!matchRelationEvidence(normWindow, pair.home.alias, pair.away.alias)) {
    result.reasons.push('teams_without_match_relation');
    return result;
  }
  result.score += 5;

  // Extração começa NO confronto identificado e segue adiante. Em páginas com
  // vários jogos isto impede que o primeiro "Público/Renda" do bloco anterior
  // seja capturado para a partida-alvo (incidente Botafogo x Vasco).
  const extractionStart = Math.max(0, pairStart - 8);
  const extractionEnd = Math.min(raw.length, pairEnd + IDENTITY_EXTRACTION_SUFFIX);
  result.window = raw.slice(extractionStart, extractionEnd).trim();

  const scoreRe = taskScoreRegex(task); if (scoreRe && scoreRe.test(normWindow)) result.score += 2;
  const roundRe = taskRoundRegex(task); if (roundRe && roundRe.test(normWindow)) result.score += 2;
  if (/\b(?:brasileirao|brasileiro|campeonato brasileiro)\b/i.test(normWindow)) result.score += 1;

  const stadium = normalizeText(task?.stadium || task?.estadio);
  if (stadium) {
    const compact = stadium.replace(/^estadio\s+/,'');
    if ((stadium.length >= 5 && normWindow.includes(` ${stadium} `)) || (compact.length >= 7 && normWindow.includes(` ${compact} `))) result.score += 2;
  }

  if (result.conflicts.length) return result;
  const contextualExtras = result.score - 5 - (dateProof ? 4 : 0);
  if (!dateProof && contextualExtras < 1) { result.reasons.push('insufficient_match_context'); return result; }
  result.accepted = true; result.reasons.push('match_identity_confirmed');
  return result;
}

export function sourceTextMatchesTask(task, sourceText, sourceUrl = '') {
  return evaluateSourceMatchIdentity(task, sourceText, sourceUrl).accepted;
}

export function sourceTextWindowForTask(task, sourceText, sourceUrl = '') {
  const gate = evaluateSourceMatchIdentity(task, sourceText, sourceUrl);
  return gate.accepted ? gate.window : '';
}

function pairVariants(home, away) {
  const h = teamSearchVariants(home, 4);
  const a = teamSearchVariants(away, 4);
  const pairs = [[h[0], a[0]], [h[1] || h[0], a[1] || a[0]], [h[2] || h[0], a[2] || a[0]], [h[1] || h[0], a[0]]];
  return unique(pairs.map(([x, y]) => `${x}\u0000${y}`)).map((row) => row.split('\u0000'));
}

export function buildAttendanceSearchQueries(task) {
  const home = text(task?.home), away = text(task?.away);
  const date = text(task?.kickoff).slice(0, 10);
  const score = task?.home_score != null && task?.away_score != null ? `${task.home_score} x ${task.away_score}` : '';
  const stadium = text(task?.stadium || task?.estadio);
  const round = text(task?.round || task?.rodada);
  const queries = [];
  const add = (q) => { q = text(q); if (q && !queries.includes(q)) queries.push(q); };

  for (const [h, a] of pairVariants(home, away)) {
    add(`"${h}" "${a}" público renda`);
  }
  const homeVariants = teamSearchVariants(home, 8);
  const awayVariants = teamSearchVariants(away, 8);
  const homeNickname = homeVariants.find((v) => v !== home && !v.includes(' ') && v.length >= 3);
  const awayNickname = awayVariants.find((v) => v !== away && !v.includes(' ') && v.length >= 3);
  if (homeNickname) add(`"${homeNickname}" "${away}" público renda`);
  if (awayNickname) add(`"${home}" "${awayNickname}" público renda`);
  add(`"${home}" "${away}" "ficha técnica" público renda`);
  if (score) add(`"${home}" "${away}" "${score}" público renda`);
  if (stadium) add(`"${home}" "${away}" "${stadium}" público renda`);
  if (date) add(`"${home}" "${away}" "${date}" público renda`);
  if (round) add(`"${home}" "${away}" "rodada ${round}" público renda`);

  // Buscas direcionadas em portais que costumam publicar ficha técnica cedo.
  for (const domain of ['uol.com.br', 'ge.globo.com', 'estadao.com.br', 'r7.com', 'itatiaia.com.br']) {
    add(`site:${domain} "${home}" "${away}" público renda`);
  }

  // Os sites oficiais dos DOIS participantes são aceitos somente para fatos
  // documentais (público/renda/estádio/ficha técnica), jamais para opinião.
  for (const domain of officialClubDomainsForTask(task)) {
    add(`site:${domain} "${home}" "${away}" público renda`);
  }
  return queries.slice(0, 18);
}

export function attendanceSourcePolicyText(task) {
  const official = officialClubDomainsForTask(task);
  const officialText = official.length ? official.join(', ') : 'nenhum domínio oficial cadastrado';
  return `Priorize imprensa esportiva/jornalística robusta e regional, além de fontes institucionais da competição. Para fatos documentais de ficha técnica (público, pagantes, renda e estádio), também são aceitos EXCLUSIVAMENTE os sites oficiais dos clubes participantes desta partida: ${officialText}. Sites oficiais de outros clubes não são válidos. Não use blogs de torcida, fóruns, redes sociais, casas de apostas ou agregadores sem origem editorial.`;
}
