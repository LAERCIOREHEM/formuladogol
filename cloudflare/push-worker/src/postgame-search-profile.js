export const POSTGAME_SEARCH_PROFILE_VERSION = 10;

function text(value) { return String(value ?? '').trim(); }
function normalizeText(value) {
  return text(value).replace(/×/g, ' x ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
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

// R10R20: consulta GRATUITA da página da própria partida antes de buscas com IA.
// Região e slugs são conhecidos; a URL é apenas uma CANDIDATA, não prova de
// público ou renda. Nenhum campo é aceito sem Match Identity Gate + parser.
const GE_MATCH_HOME_STATE = Object.freeze({
  'Athletico-PR':'pr','Atlético-MG':'mg','Bahia':'ba','Botafogo':'rj',
  'Bragantino':'sp','Chapecoense':'sc','Corinthians':'sp','Coritiba':'pr',
  'Cruzeiro':'mg','Flamengo':'rj','Fluminense':'rj','Grêmio':'rs',
  'Internacional':'rs','Mirassol':'sp','Palmeiras':'sp','Remo':'pa',
  'Santos':'sp','São Paulo':'sp','Vasco da Gama':'rj','Vitória':'ba'
});
const GE_MATCH_SLUG = Object.freeze({
  'Athletico-PR':'athletico-pr','Atlético-MG':'atletico-mg',
  'Bragantino':'bragantino','Grêmio':'gremio','São Paulo':'sao-paulo',
  'Vasco da Gama':'vasco','Vitória':'vitoria'
});
function brazilKickoffDate(value) {
  const raw=text(value);
  if (/^20\d{2}-\d{2}-\d{2}T/.test(raw) && /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)) {
    const instant=new Date(raw);
    if(!Number.isNaN(instant.getTime())){
      const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(instant);
      const get=(kind)=>parts.find(part=>part.type===kind)?.value||'';
      return `${get('year')}-${get('month')}-${get('day')}`;
    }
  }
  return /^20\d{2}-\d{2}-\d{2}/.test(raw)?raw.slice(0,10):'';
}
function geMatchSlug(value){
  const profile=lookupProfile(value);
  const canonical=Object.keys(TEAM_SEARCH_PROFILES).find(name=>TEAM_SEARCH_PROFILES[name]===profile);
  if(!canonical)return '';
  return GE_MATCH_SLUG[canonical]||normalizeText(canonical).replace(/ /g,'-');
}
export function matchDayEditorialSources(task={}) {
  const homeProfile=lookupProfile(task.home), awayProfile=lookupProfile(task.away);
  const homeName=Object.keys(TEAM_SEARCH_PROFILES).find(name=>TEAM_SEARCH_PROFILES[name]===homeProfile);
  if(!homeName||!awayProfile)return [];
  const dt=brazilKickoffDate(task.kickoff||task.data_iso);
  if(!dt)return [];
  const [year,month,day]=dt.split('-');
  const home=geMatchSlug(task.home),away=geMatchSlug(task.away);
  if(!home||!away)return [];
  const state=GE_MATCH_HOME_STATE[homeName];
  if(!state)return [];
  return [`https://ge.globo.com/${state}/futebol/brasileirao-serie-a/jogo/${day}-${month}-${year}/${home}-${away}.ghtml`];
}

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

// Fontes não cadastradas podem ser candidatas DOCUMENTAIS; a descoberta é
// aberta, mas não equivale a autorização para publicar valores do modelo.
// Requer HTTPS, domínio público, página jornalística, Match Identity Gate,
// placar exato e extração determinística. Clubes de terceiros são excluídos.
export function isCandidateEditorialAttendanceSource(value, task = null) {
  if (attendanceSourceQuality(value, task) !== 'unverified') return false;
  let url;
  try { url=new URL(text(value)); } catch (_) { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host=url.hostname.toLowerCase().replace(/^www\./,'');
  if (!host.includes('.') || host.length>180 || host.includes('..')) return false;
  if (/^\d+(?:\.\d+){3}$/.test(host) || host.includes(':')) return false;
  if (/(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host)) return false;
  if (/(?:^|\.)(?:example\.com|bit\.ly|tinyurl\.com|t\.co|pastebin\.com|wikipedia\.org|google\.com|bing\.com)$/.test(host)) return false;
  if (Object.values(TEAM_SEARCH_PROFILES).some((profile)=>(profile.officialDomains||[]).some((domain)=>host===domain||host.endsWith('.'+domain)))) return false;
  let path='';
  try { path=decodeURIComponent(url.pathname).toLowerCase(); } catch (_) { return false; }
  // Jornal local pode publicar ficha técnica num slug da raiz sem /noticias/.
  // O slug do confronto, junto ao Match Identity Gate posterior, é evidência
  // mais forte que impor caminhos ou uma lista fechada de domínios.
  const slug=(name)=>teamSearchVariants(name,8)
    .map((alias)=>normalizeText(alias).replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''))
    .filter((alias)=>alias.length>=4);
  const hasTeams=(name)=>slug(name).some((alias)=>path.includes(alias));
  const explicitNewsPath=/(?:\/20\d{2}\/\d{1,2}\/\d{1,2}\/|\/(?:noticias?|esportes?|futebol|sports|news|brasileirao|jogos?|partida|materia)(?:\/|-))/i.test(path);
  if (path.length<15 || (!explicitNewsPath && !(hasTeams(task?.home)&&hasTeams(task?.away)))) return false;
  return true;
}

export const AMBIGUOUS_IDENTITY_ALIASES = Object.freeze(new Set(['vitoria', 'internacional', 'santos', 'bahia', 'remo']));
// Apelidos curtos continuam excelentes para DESCOBERTA, mas não são prova de
// identidade por si só. A etapa de validação privilegia nomes canônicos/fortes.
const SEARCH_ONLY_WEAK_IDENTITY_ALIASES = new Set(['galo','fla','flu','inter','timao','coxa','peixe','verdao','braga','chape']);
const IDENTITY_PAIR_MAX_CHARS = 420;
const IDENTITY_CONTEXT_RADIUS = 900;
const IDENTITY_EXTRACTION_SUFFIX = 5500;

// Mantém a correspondência entre os índices do texto normalizado e o HTML limpo.
// Índices de uma string sem acentos/pontuação não podem recortar diretamente a original.
function normalizeWithSourceOffsets(value) {
  const raw = text(value);
  let normalized = '';
  const offsets = [];
  for (let i = 0; i < raw.length; i++) {
    const decomposed = (raw[i] === '×' ? ' x ' : raw[i]).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    for (const unit of decomposed) {
      const char = /[a-z0-9]/.test(unit) ? unit : ' ';
      if (char === ' ' && (!normalized || normalized.endsWith(' '))) continue;
      normalized += char;
      offsets.push(i);
    }
  }
  if (normalized.endsWith(' ')) { normalized = normalized.slice(0, -1); offsets.pop(); }
  return {normalized, offsets};
}

// R10R17-HF6: estes endereços publicam uma LISTA de partidas.
// O parser Python de rodada separa cada bloco por confronto; o Worker NÃO
// pode extrair um número dessa lista usando uma janela textual arbitrária.
export function isMultiMatchRoundupSource(sourceUrl = '') {
  let pathname = '';
  try { pathname = decodeURIComponent(new URL(text(sourceUrl)).pathname).toLowerCase(); } catch (_) { return false; }
  return /\/gato-mestre\//.test(pathname) || /(?:publicos?-d[aeo]s?-\d+[ao]?-rodada|veja-os-publicos-da-rodada)/.test(pathname);
}

// A capacidade se refere ao ESTÁDIO efetivo, nunca apenas ao mandante:
// não bloqueia jogos transferidos para outro estádio. Lista deliberadamente
// restrita a estádios cuja capacidade foi confirmada.
export const VERIFIED_STADIUM_CAPACITY = Object.freeze({
  'arena conda': 20089,
});
// Extração estruturada de matérias multijogo (GE/Gato Mestre), sem IA.
// O gate genérico continua rejeitando roundups: somente este caminho pode
// separar campos por placar, clubes, data, rodada e próximo cabeçalho.
export function extractRoundupMatchBlock(task, sourceText, sourceUrl = '') {
  const deny = (reason) => ({ accepted:false, reason, window:'' });
  if (!isMultiMatchRoundupSource(sourceUrl)) return deny('not_roundup_source');
  if (sourceCompetitionConflict(task, sourceUrl)) return deny('competition_mismatch');
  const hs=Number(task?.home_score), as=Number(task?.away_score);
  if (!Number.isInteger(hs)||!Number.isInteger(as)||hs<0||as<0||hs>20||as>20)
    return deny('score_not_confirmed');
  const gameDate=text(task?.kickoff||task?.data_iso).slice(0,10);
  const sourceDate=urlDate(sourceUrl);
  if(!gameDate||!sourceDate||daysBetweenIso(gameDate,sourceDate)>3)
    return deny('roundup_date_mismatch');
  let path='';
  try { path=decodeURIComponent(new URL(text(sourceUrl)).pathname); } catch (_) { return deny('bad_url'); }
  const roundSlug=path.match(/(?:^|[-/])(\d{1,2})[aoªº]?-rodada/i);
  const expectedRound=Number(task?.round??task?.rodada);
  if(roundSlug&&expectedRound>0&&Number(roundSlug[1])!==expectedRound)
    return deny('roundup_round_mismatch');
  const raw=text(sourceText).replace(/\s+/g,' ');
  const escapePattern=(value)=>text(value).split('').map((c)=>'.*+?^$()|[]{}\\'.includes(c)?'\\'+c:c).join('').replace(/\s+/g,'\\s+');
  const strongAliases=(value)=>teamSearchVariants(value,8).filter((a)=>!SEARCH_ONLY_WEAK_IDENTITY_ALIASES.has(normalizeText(a))&&a.length>=3);
  const variants=(value)=>[...new Set(strongAliases(value))].sort((a,b)=>b.length-a.length).map(escapePattern).join('|');
  const home=variants(task?.home), away=variants(task?.away);
  if(!home||!away) return deny('missing_teams');
  const target=new RegExp('(?:^|[^\\p{L}])((?:'+home+')\\s+'+hs+'\\s*[x×]\\s*'+as+'\\s+(?:'+away+'))(?=\\s|$|[,(])','giu');
  const clubs=[...new Set(Object.keys(TEAM_SEARCH_PROFILES).flatMap(strongAliases))].sort((a,b)=>b.length-a.length).map(escapePattern).join('|');
  const headers=new RegExp('(?:^|[^\\p{L}])(?:'+clubs+')\\s+\\d{1,2}\\s*[x×]\\s*\\d{1,2}\\s+(?:'+clubs+')(?=\\s|$|[,(])','giu');
  const boundaries=[...raw.matchAll(headers)].map((m)=>m.index);
  for(const match of raw.matchAll(target)){
    const begin=match.index+match[0].indexOf(match[1]);
    const after=begin+match[1].length;
    const next=boundaries.find((index)=>index>=after);
    const end=Math.min(next??raw.length,after+850);
    const window=raw.slice(begin,end).trim();
    if(/\b(?:p[úu]blico\s+(?:presente|total|pagante)|renda(?:\s+bruta)?)\s*:/i.test(window))
      return {accepted:true,reason:'roundup_match_scoped',window};
  }
  return deny('roundup_match_or_labeled_data_not_found');
}

export function verifiedStadiumCapacity(task) {
  const name = normalizeText(task?.stadium || task?.estadio).replace(/^estadio\s+/, '');
  return VERIFIED_STADIUM_CAPACITY[name] || null;
}


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
function bestPair(normalized, homeAliases, awayAliases, raw = '', offsets = [], task = null) {
  const homes = homeAliases.flatMap((a) => aliasOccurrences(normalized, a));
  const aways = awayAliases.flatMap((a) => aliasOccurrences(normalized, a));
  let nearest = null;
  let documented = null;
  const exactScore = task ? taskScoreRegex(task) : null;
  // A dupla mais próxima pode estar no rodapé ("assuntos relacionados"), DEPOIS
  // da ficha. Classificar todas as ocorrências próximas do confronto, priorizando
  // o bloco cuja ficha documental venha DEPOIS de clubes/placar, nunca o rodapé.
  for (const h of homes) for (const a of aways) {
    const distance = Math.max(0, Math.max(h.start, a.start) - Math.min(h.end, a.end));
    if (!nearest || distance < nearest.distance) nearest = { home:h, away:a, distance };
    if (!raw || distance > IDENTITY_PAIR_MAX_CHARS) continue;
    const startNorm = Math.min(h.start, a.start), endNorm = Math.max(h.end, a.end);
    const first = offsets[Math.max(0, startNorm - 1)] ?? 0;
    const last = (offsets[Math.max(0, endNorm - 2)] ?? first) + 1;
    const context = raw.slice(Math.max(0,first-200),Math.min(raw.length,last+550));
    if (!matchRelationEvidence(' '+normalizeText(context)+' ',h.alias,a.alias)) continue;
    const after = raw.slice(last,Math.min(raw.length,last+IDENTITY_EXTRACTION_SUFFIX));
    const marker = /\b(?:p[úu]blico(?:\s+(?:presente|total|geral|pagante))?|pagantes?|renda(?:\s+(?:bruta|total))?|bilheteria)\s*[:\-–—]\s*(?:R\$\s*)?[0-9]/i.exec(after);
    const nearScore = exactScore ? exactScore.test(context) : false;
    const rank = (marker ? 120-Math.min(65,marker.index/80) : 0) +
      (nearScore ? 35 : 0) + (distance<=100 ? 10 : 0) - distance/1000;
    if (!documented || rank > documented.rank ||
       (rank===documented.rank && distance<documented.distance)) {
      documented={home:h,away:a,distance,rank};
    }
  }
  return documented || nearest;
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

// R10R17-HF2: a mesma dupla pode disputar clássicos em competições diferentes.
// Uma URL na seção editorial de Copa do Brasil/Carioca/etc. NÃO é prova do
// Brasileirão, mesmo que contenha os dois clubes e o estádio correto.
// Só segmentos de diretório são avaliados: "eliminado-na-copa-do-brasil.htm"
// no título de uma matéria do Brasileirão não constitui conflito.
export function sourceCompetitionConflict(task, sourceUrl = '') {
  const league = text(task?.league || task?.espn_league || 'bra.1').toLowerCase();
  if (league !== 'bra.1') return '';
  let path = '';
  try { path = decodeURIComponent(new URL(text(sourceUrl)).pathname).toLowerCase().replace(/_/g, '-'); }
  catch (_) { return ''; }
  const match = path.match(/(?:^|\/)(copa-do-brasil|campeonato-carioca|campeonato-paulista|libertadores|sul-americana)(?:\/|$)/);
  return match ? `url_competition_mismatch:${match[1]}` : '';
}

// R10R15: Match Identity Gate. Descobrir uma URL e provar que ela pertence ao
// event_id são etapas distintas. O gate exige os DOIS clubes no mesmo bloco
// contextual e rejeita conflitos objetivos, sobretudo data incompatível na URL.
export function evaluateSourceMatchIdentity(task, sourceText, sourceUrl = '') {
  const raw = text(sourceText).replace(/\s+/g, ' ');
  const offsetMap = normalizeWithSourceOffsets(raw);
  const normalized = ` ${offsetMap.normalized} `;
  const result = { accepted:false, score:0, reasons:[], conflicts:[], homeAlias:'', awayAlias:'', pairDistance:null, window:'' };
  if (!normalized.trim()) { result.reasons.push('empty_source_text'); return result; }
  const competitionConflict = sourceCompetitionConflict(task, sourceUrl);
  if (competitionConflict) { result.conflicts.push(competitionConflict); return result; }
  if (isMultiMatchRoundupSource(sourceUrl)) {
    result.conflicts.push('multi_match_roundup_requires_structured_parser');
    return result;
  }

  const gameDate = text(task?.kickoff || task?.data_iso).slice(0,10);
  const sourceDate = urlDate(sourceUrl);
  let dateProof = false;
  if (gameDate && sourceDate) {
    const delta = daysBetweenIso(gameDate, sourceDate);
    if (delta != null && delta > 3) result.conflicts.push(`url_date_mismatch:${sourceDate}:${gameDate}`);
    else { result.score += 4; dateProof = true; }
  }

  const pair = bestPair(normalized, identityAliases(task?.home), identityAliases(task?.away), raw, offsetMap.offsets, task);
  if (!pair) { result.reasons.push('teams_not_both_found'); return result; }
  result.homeAlias = pair.home.alias; result.awayAlias = pair.away.alias; result.pairDistance = pair.distance;
  if (pair.distance > IDENTITY_PAIR_MAX_CHARS) { result.reasons.push(`teams_too_far:${pair.distance}`); return result; }

  const pairStart = Math.min(pair.home.start,pair.away.start);
  const pairEnd = Math.max(pair.home.end,pair.away.end);
  // bestPair trabalha sobre texto normalizado; converter ambos os offsets
  // antes de montar janelas no texto real (acentos, pontuação, placares etc.).
  const realPairStart = offsetMap.offsets[Math.max(0, pairStart - 1)] ?? 0;
  const realPairEnd = (offsetMap.offsets[Math.max(0, pairEnd - 2)] ?? realPairStart) + 1;
  const center = Math.floor((realPairStart + realPairEnd) / 2);
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
  const extractionStart = Math.max(0, realPairStart - 8);
  const extractionEnd = Math.min(raw.length, realPairEnd + IDENTITY_EXTRACTION_SUFFIX);
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
  const date = text(task?.kickoff || task?.data_iso).slice(0, 10);
  const year = /^20\d{2}/.test(date) ? date.slice(0, 4) : '';
  const dayBR = /^20\d{2}-\d{2}-\d{2}$/.test(date) ? `${date.slice(8,10)}/${date.slice(5,7)}/${year}` : '';
  const score = task?.home_score != null && task?.away_score != null ? `${task.home_score} x ${task.away_score}` : '';
  const stadium = text(task?.stadium || task?.estadio);
  const queries = [];
  const add = (q) => { q = text(q); if (q && !queries.includes(q)) queries.push(q); };

  // Primeiro imitar as buscas simples que encontram a ficha técnica logo após o FINAL.
  // NENHUMA consulta restringe o domínio: portais conhecidos são preferência, não cerca.
  add(`${home} ${away} público renda ${dayBR || year}`);
  add(`"${home}" "${away}" público presente renda ${year}`);
  add(`"${home}" "${away}" público pagante renda ${year}`);
  if (score) add(`${home} ${score} ${away} público renda ${year}`);
  add(`"${home}" "${away}" ficha técnica renda ${year}`);

  // Fallbacks sem amarrar a pesquisa a sites: título invertido, apelidos e estádio.
  if (stadium) add(`"${home}" "${away}" "${stadium}" público renda`);
  const pairs = pairVariants(home, away);
  for (const [h, a] of pairs.slice(1, 4)) add(`"${h}" "${a}" público renda ${year}`);
  const informalHome = teamSearchVariants(home,8).find((alias)=>SEARCH_ONLY_WEAK_IDENTITY_ALIASES.has(normalizeText(alias)));
  if (informalHome) add(`"${informalHome}" "${away}" público renda ${year}`);
  add(`"${away}" "${home}" público renda ${year}`);
  return queries.slice(0, 10);
}

export function attendanceSourcePolicyText(task) {
  const official = officialClubDomainsForTask(task);
  const officialText = official.length ? official.join(', ') : 'nenhum domínio oficial cadastrado';
  return `Priorize imprensa esportiva/jornalística robusta e regional, além de fontes institucionais da competição. Para fatos documentais de ficha técnica (público, pagantes, renda e estádio), também são aceitos EXCLUSIVAMENTE os sites oficiais dos clubes participantes desta partida: ${officialText}. Sites oficiais de outros clubes não são válidos. Não use blogs de torcida, fóruns, redes sociais, casas de apostas ou agregadores sem origem editorial.`;
}
