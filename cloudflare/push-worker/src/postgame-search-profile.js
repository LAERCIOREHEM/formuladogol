export const POSTGAME_SEARCH_PROFILE_VERSION = 7;

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

export function sourceTextMatchesTask(task, sourceText) {
  const normalized = ` ${normalizeText(sourceText)} `;
  if (!normalized.trim()) return false;
  const hasTeam = (team) => teamSearchAliasesNormalized(team).some((alias) => normalized.includes(` ${alias} `));
  if (!hasTeam(task?.home) || !hasTeam(task?.away)) return false;
  if (task?.home_score == null || task?.away_score == null) return true;
  const home = Number(task.home_score), away = Number(task.away_score);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return true;
  const scorePatterns = [
    new RegExp(`\\b${home}\\s*[x×-]\\s*${away}\\b`),
    new RegExp(`\\b${away}\\s*[x×-]\\s*${home}\\b`),
  ];
  // O placar é evidência adicional, não obrigatória: alguns textos de ficha
  // técnica usam os gols em prosa e não repetem o placar no corpo extraído.
  return scorePatterns.some((re) => re.test(normalized)) || (hasTeam(task?.home) && hasTeam(task?.away));
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
