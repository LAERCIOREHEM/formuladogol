// CBF 2026, Tabela Detalhada R36 (04/11), R37/R38 (06/11), Final Copa (23/11).
// Fail-closed: qualquer aviso T-15 divergente fica bloqueado, jamais remarcado
// por inferência de fuso horário ou por um snapshot antigo da ESPN/Pages.
// R36: https://stcbfsiteprdimgbrs.blob.core.windows.net/img-site/cdn/Tabela_Detalhada_BSA_2026_04_11_7e8eea9eb8.pdf
// R37/38: https://stcbfsiteprdimgbrs.blob.core.windows.net/img-site/cdn/Tabela_Detalhada_Brasileiro_Serie_A_2026_37_e_38_rodada_ca107fa561.pdf
// Copa: https://stcbfsiteprdimgbrs.blob.core.windows.net/img-site/cdn/Tabela_Detalhada_9_Fase_Copa_Betano_do_Brasil_2026_d4e3d895b0.pdf
export const CBF_FIXTURES_2026 = Object.freeze([
  ['bra.1','Internacional','Vitória','2026-11-23T19:30:00-03:00'],
  ['bra.1','Botafogo','São Paulo','2026-11-23T20:00:00-03:00'],
  ['bra.1','Santos','Grêmio','2026-11-23T21:00:00-03:00'],
  ['bra.1','Chapecoense','Palmeiras','2026-11-24T18:00:00-03:00'],
  ['bra.1','Atlético-MG','Corinthians','2026-11-25T20:00:00-03:00'],
  ['bra.1','São Paulo','Remo','2026-11-26T20:00:00-03:00'],
  ['bra.1','Fluminense','Cruzeiro','2026-11-27T20:00:00-03:00'],
  ['bra.1','Botafogo','Bahia','2026-11-28T21:00:00-03:00'],
  ['bra.1','Coritiba','Flamengo','2026-11-29T16:00:00-03:00'],
  ['bra.1','Vitória','Santos','2026-11-29T16:00:00-03:00'],
  ['bra.1','Corinthians','Grêmio','2026-11-29T18:30:00-03:00'],
  ['bra.1','Mirassol','Athletico-PR','2026-11-29T18:30:00-03:00'],
  ['bra.1','Internacional','Bragantino','2026-11-29T18:30:00-03:00'],
  ['bra.1','Atlético-MG','Vasco da Gama','2026-11-29T19:30:00-03:00'],
  ['bra.1','Flamengo','Chapecoense','2026-12-02T21:30:00-03:00'],
  ['bra.1','Vasco da Gama','Vitória','2026-12-02T21:30:00-03:00'],
  ['bra.1','Santos','Botafogo','2026-12-02T21:30:00-03:00'],
  ['bra.1','Palmeiras','Coritiba','2026-12-02T21:30:00-03:00'],
  ['bra.1','Bragantino','Fluminense','2026-12-02T21:30:00-03:00'],
  ['bra.1','Cruzeiro','Internacional','2026-12-02T21:30:00-03:00'],
  ['bra.1','Grêmio','Mirassol','2026-12-02T21:30:00-03:00'],
  ['bra.1','Athletico-PR','São Paulo','2026-12-02T21:30:00-03:00'],
  ['bra.1','Bahia','Atlético-MG','2026-12-02T21:30:00-03:00'],
  ['bra.1','Remo','Corinthians','2026-12-02T21:30:00-03:00'],
  ['bra.copa_do_brazil','Grêmio','Palmeiras','2026-12-06T16:00:00-03:00']
]);

function canonicalName(value) {
  const base = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const aliases = {
    'atletico': 'atletico mg',
    'atletico mineiro': 'atletico mg',
    'athletico': 'athletico pr',
    'athletico paranaense': 'athletico pr',
    'red bull bragantino': 'bragantino',
    'rb bragantino': 'bragantino'
  };
  return aliases[base] || base;
}
const KEY = (league, home, away) =>
  [String(league || ''), canonicalName(home), canonicalName(away)].join('|');
const FIXTURE_BY_KEY = new Map(CBF_FIXTURES_2026.map(([league,home,away,time]) => [KEY(league,home,away),time]));
const FIRST_BRT = Date.parse('2026-11-23T00:00:00-03:00');
const LAST_BRT = Date.parse('2026-12-07T00:00:00-03:00');

/**
 * Guardião T-15: não gera alertas com kickoff obsoleto, eventos que não existem
 * na grade oficial nem eventos cuja hora não contenha offset explícito.
 * Outro tipo de push (gol, início, final) não é bloqueado.
 */
export function officialPrematchCheck(event) {
  if (event?.type && event.type !== 'prematch_15') {
    return { checked: false, allowed: true, reason: 'not_prematch' };
  }
  const league = String(event?.league || '');
  if (league !== 'bra.1' && league !== 'bra.copa_do_brazil') {
    return { checked: false, allowed: true, reason: 'outside_cbf_competitions' };
  }
  const raw = String(event?.kickoff || '');
  const kickoff = Date.parse(raw);
  const home = event?.home?.name || event?.home?.nome || '';
  const away = event?.away?.name || event?.away?.nome || '';
  const expected = FIXTURE_BY_KEY.get(KEY(league,home,away));
  if (expected) {
    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(raw) || !Number.isFinite(kickoff)) {
      return { checked: true, allowed: false, reason: 'kickoff_missing_timezone', expected };
    }
    const allowed = kickoff === Date.parse(expected);
    return { checked: true, allowed, reason: allowed ? 'cbf_verified' : 'kickoff_mismatch', expected };
  }
  if (Number.isFinite(kickoff) && kickoff >= FIRST_BRT && kickoff < LAST_BRT) {
    return { checked: true, allowed: false, reason: 'unknown_cbf_fixture' };
  }
  return { checked: false, allowed: true, reason: 'outside_certified_window' };
}
