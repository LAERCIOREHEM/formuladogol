import assert from 'node:assert/strict';
import { resolveLiveScoreboard, resolveLiveSummary } from '../src/live-api.js';

class MemoryCache {
  constructor() { this.rows = new Map(); }
  key(request) { return typeof request === 'string' ? request : request.url; }
  async match(request) {
    const row = this.rows.get(this.key(request));
    return row ? row.clone() : undefined;
  }
  async put(request, response) {
    this.rows.set(this.key(request), response.clone());
  }
  dropTier(tier) {
    for (const key of [...this.rows.keys()]) if (key.includes(`/${tier}/`)) this.rows.delete(key);
  }
}

class SharedStatsStore {
  constructor() { this.rows = new Map(); this.budgets = new Map(); }
  async get(key) { return this.rows.get(String(key)) || null; }
  async put(key, payload) { this.rows.set(String(key), structuredClone(payload)); return { ok: true }; }
  async acquireLease() { return true; }
  async getApiBudget(day) { return this.budgets.get(String(day)) || null; }
  async reserveApiCalls(day, calls, maxReservedCalls) {
    const key = String(day);
    const current = this.budgets.get(key) || { reservedCalls: 0, remaining: null, limit: null };
    const next = current.reservedCalls + Number(calls || 0);
    if (next > Number(maxReservedCalls)) return { allowed: false, ...current };
    const updated = { ...current, reservedCalls: next };
    this.budgets.set(key, updated);
    return { allowed: true, ...updated };
  }
  async updateApiBudget(day, rateLimit) {
    const key = String(day);
    const current = this.budgets.get(key) || { reservedCalls: 0, remaining: null, limit: null };
    const updated = {
      ...current,
      remaining: Number.isFinite(Number(rateLimit?.dailyRemaining)) ? Number(rateLimit.dailyRemaining) : current.remaining,
      limit: Number.isFinite(Number(rateLimit?.dailyLimit)) ? Number(rateLimit.dailyLimit) : current.limit
    };
    this.budgets.set(key, updated);
    return updated;
  }
}

function scoreboardEvent({ id = '401999001', clock = "50'", home = 0, away = 0, state = 'in' } = {}) {
  return {
    id,
    status: { type: { state, completed: state === 'post', shortDetail: clock }, displayClock: clock, period: state === 'pre' ? 0 : 2 },
    competitions: [{ id, competitors: [
      { homeAway: 'home', score: String(home), team: { id: '1', displayName: 'São Paulo' } },
      { homeAway: 'away', score: String(away), team: { id: '2', displayName: 'Boca Juniors' } }
    ] }]
  };
}

{
  const invalid = await resolveLiveScoreboard(new URL('https://x/v1/live/scoreboard?league=foo&dates=20260915'));
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, 'invalid_league');
}

// Gateway público: quatro superfícies em paralelo e escolha do evento mais avançado.
{
  const cache = new MemoryCache();
  let calls = 0;
  const stale = scoreboardEvent({ clock: "50'", home: 0, away: 1 });
  const fresh = scoreboardEvent({ clock: "53'", home: 1, away: 1 });
  const fakeFetch = async (url) => {
    calls += 1;
    const href = String(url);
    if (href.includes('/core/conmebol.sudamericana/scoreboard')) return Response.json({ content: { events: [fresh] } });
    if (href.includes('/core/soccer/scoreboard')) return Response.json({ content: { events: [stale] } });
    if (href.includes('site.web.api.espn.com')) return new Response('blocked', { status: 503, headers: { 'content-type': 'text/plain' } });
    if (href.includes('site.api.espn.com')) return Response.json({ events: [stale] });
    throw new Error(`URL inesperada ${href}`);
  };
  const url = new URL('https://x/v1/live/scoreboard?league=conmebol.sudamericana&dates=20260915-20260917');
  const first = await resolveLiveScoreboard(url, { cache, fetchImpl: fakeFetch, now: () => 1_000_000 });
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.stale, false);
  assert.equal(first.body.stateContractVersion, 1);
  assert.equal(first.body.transport, 'worker-espn');
  assert.equal(first.body.scoreboardState, 'in');
  assert.equal(first.body.data.events[0].status.displayClock, "53'");
  assert.equal(first.body.selectedSources['401999001'], 'espn_cdn_league');
  assert.equal(calls, 4);

  const second = await resolveLiveScoreboard(url, { cache, fetchImpl: async () => { throw new Error('não deveria consultar upstream'); }, now: () => 1_003_000 });
  assert.equal(second.status, 200);
  assert.equal(second.body.cacheStatus, 'hot');
  assert.equal(second.body.data.events[0].status.displayClock, "53'");

  // fresh=1 deve ignorar o hot cache para que Tabela/Estatísticas vejam o mesmo
  // estado ESPN recente que o módulo Ao Vivo.
  let freshCalls = 0;
  const forceFreshUrl = new URL('https://x/v1/live/state?league=conmebol.sudamericana&dates=20260915-20260917&fresh=1');
  const forced = await resolveLiveScoreboard(forceFreshUrl, {
    cache,
    fetchImpl: async (url) => {
      freshCalls += 1;
      const href = String(url);
      if (href.includes('/core/conmebol.sudamericana/scoreboard')) return Response.json({ content: { events: [scoreboardEvent({ clock: "54'", home: 1, away: 1 })] } });
      if (href.includes('/core/soccer/scoreboard')) return Response.json({ content: { events: [fresh] } });
      if (href.includes('site.web.api.espn.com')) return new Response('blocked', { status: 503, headers: { 'content-type': 'text/plain' } });
      if (href.includes('site.api.espn.com')) return Response.json({ events: [fresh] });
      throw new Error(`URL inesperada ${href}`);
    },
    now: () => 1_004_000
  });
  assert.equal(forced.status, 200);
  assert.equal(forced.body.cacheStatus, 'miss');
  assert.equal(forced.body.data.events[0].status.displayClock, "54'");
  assert.equal(freshCalls, 4);

  cache.dropTier('hot');
  const degraded = await resolveLiveScoreboard(url, {
    cache,
    fetchImpl: async () => new Response('offline', { status: 503, headers: { 'content-type': 'text/plain' } }),
    now: () => 1_090_000
  });
  assert.equal(degraded.status, 200);
  assert.equal(degraded.body.stale, true);
  assert.equal(degraded.body.cacheStatus, 'stale-fallback');
  assert.equal(degraded.body.data.events[0].status.displayClock, "54'");
  assert.match(degraded.body.upstreamError, /503/);

  // Estado IN com mais de 90 s não pode ser reciclado indefinidamente: um
  // visitante novo deve receber falha/fallback central, nunca placar congelado.
  cache.dropTier('hot');
  const tooOld = await resolveLiveScoreboard(url, {
    cache,
    fetchImpl: async () => new Response('offline', { status: 503, headers: { 'content-type': 'text/plain' } }),
    now: () => 1_181_000
  });
  assert.equal(tooOld.status, 503);
}


// Se todas as superfícies ESPN e o cache do POP falharem, o snapshot central
// do SportsMonitor ainda mantém o placar disponível para um primeiro visitante.
{
  const cache = new MemoryCache();
  const url = new URL('https://x/v1/live/scoreboard?league=conmebol.sudamericana&dates=20260915-20260917');
  const result = await resolveLiveScoreboard(url, {
    cache,
    fetchImpl: async () => new Response('offline', { status: 503, headers: { 'content-type': 'text/plain' } }),
    now: () => 4_000_000,
    fallbackScoreboard: async ({ league }) => ({
      source: 'sports_monitor_snapshot',
      fetchedAt: 3_995_000,
      data: { events: [scoreboardEvent({ id: '401999099', clock: "67'", home: 2, away: 1 })] },
      league
    })
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.source, 'sports_monitor_snapshot');
  assert.equal(result.body.cacheStatus, 'monitor-fallback');
  assert.equal(result.body.stale, true);
  assert.equal(result.body.data.events[0].status.displayClock, "67'");
}

// Summary: escolhe em paralelo a variante mais completa e só reutiliza cache
// quando ele já contém ao menos a quantidade de gols exigida pelo placar.
{
  const cache = new MemoryCache();
  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('/core/conmebol.sudamericana/game')) {
      return Response.json({ gamepackageJSON: { plays: [{ id: 'g1', scoringPlay: true, text: 'Goal scored by A', team: { id: '1' }, homeScore: 1, awayScore: 0, athletesInvolved: [{ id: '10', displayName: 'Jogador A' }] }] } });
    }
    if (href.includes('/core/conmebol.sudamericana/playbyplay')) {
      return Response.json({ gamepackageJSON: { plays: [
        { id: 'g1', scoringPlay: true, text: 'Goal scored by A', team: { id: '1' }, homeScore: 1, awayScore: 0, athletesInvolved: [{ id: '10', displayName: 'Jogador A' }] },
        { id: 'g2', scoringPlay: true, text: 'Goal scored by B', team: { id: '2' }, homeScore: 1, awayScore: 1, athletesInvolved: [{ id: '20', displayName: 'Jogador B' }] }
      ] } });
    }
    if (href.includes('/core/soccer/game') || href.includes('/core/soccer/playbyplay')) {
      return new Response('blocked', { status: 503, headers: { 'content-type': 'text/plain' } });
    }
    if (href.includes('site.api.espn.com')) {
      return Response.json({
        header: { id: '401999001', competitions: [{ competitors: [{ homeAway: 'home', score: '1', team: { id: '1', displayName: 'Time A' } }, { homeAway: 'away', score: '1', team: { id: '2', displayName: 'Time B' } }] }] },
        gameInfo: { venue: { fullName: 'Estádio teste' } },
        boxscore: { teams: [{ team: { id: '1' }, statistics: [{ name: 'possessionPct', displayValue: '55%' }] }] },
        rosters: [{ team: { id: '1' }, roster: [{ athlete: { id: '10', displayName: 'Jogador A' } }] }],
        plays: [{ id: 'g1', scoringPlay: true, text: 'Goal scored by A', team: { id: '1' }, homeScore: 1, awayScore: 0, athletesInvolved: [{ id: '10', displayName: 'Jogador A' }] }]
      });
    }
    if (href.includes('sports.core.api.espn.com')) {
      return Response.json({ items: [{ id: 'g1', scoringPlay: true, text: 'Goal scored by A', team: { id: '1' }, homeScore: 1, awayScore: 0, athletesInvolved: [{ id: '10', displayName: 'Jogador A' }] }] });
    }
    throw new Error(`URL inesperada ${href}`);
  };
  const url = new URL('https://x/v1/live/summary?league=conmebol.sudamericana&event=401999001&expectedGoals=2');
  const result = await resolveLiveSummary(url, { cache, fetchImpl: fakeFetch, now: () => 2_000_000 });
  assert.equal(result.status, 200);
  assert.equal(result.body.complete, true);
  assert.equal(result.body.goalCount, 2);
  assert.equal(result.body.source, 'espn_cdn_league_playbyplay');
  assert.equal(result.body.data.boxscore.teams.length, 1, 'gateway preserva boxscore da variante mais completa');
  assert.equal(result.body.data.rosters.length, 1, 'gateway preserva rosters/escalações');
  assert.equal(result.body.data.plays.length, 2, 'gateway usa play-by-play mais avançado');
}


// Pré-jogo: lineup/boxscore sem play-by-play ainda é conteúdo válido para a página.
{
  const cache = new MemoryCache();
  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('site.api.espn.com')) {
      return Response.json({
        header: { id: '401999002' },
        boxscore: { teams: [{ team: { id: '1' }, statistics: [] }] },
        rosters: [{ team: { id: '1' }, roster: [{ athlete: { id: '11', displayName: 'Titular' } }] }]
      });
    }
    return new Response('offline', { status: 503, headers: { 'content-type': 'text/plain' } });
  };
  const url = new URL('https://x/v1/live/summary?league=conmebol.sudamericana&event=401999002&expectedGoals=0');
  const result = await resolveLiveSummary(url, { cache, fetchImpl: fakeFetch, now: () => 3_000_000 });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.rosters[0].roster[0].athlete.displayName, 'Titular');
  assert.equal(result.body.complete, true);
}

// Estatísticas: o gateway deve fundir a cobertura das várias superfícies ESPN.
// Um payload com rosters não pode vencer e apagar um boxscore mais rico; métricas
// adicionais presentes apenas no endpoint dedicado/header também precisam entrar.
{
  const cache = new MemoryCache();
  const team = (id, name) => ({ id, displayName: name });
  const stat = (name, value) => ({ name, displayValue: String(value) });
  const sparse = [
    stat('possessionPct', '56.9%'), stat('totalShots', 1), stat('shotsOnTarget', 1),
    stat('foulsCommitted', 2), stat('wonCorners', 1), stat('saves', 0)
  ];
  const sparseAway = [
    stat('possessionPct', '43.1%'), stat('totalShots', 1), stat('shotsOnTarget', 0),
    stat('foulsCommitted', 5), stat('wonCorners', 0), stat('saves', 1)
  ];
  const boxExtraHome = [stat('yellowCards', 1), stat('redCards', 0), stat('offsides', 2), stat('totalPasses', 88)];
  const boxExtraAway = [stat('yellowCards', 0), stat('redCards', 0), stat('offsides', 1), stat('totalPasses', 73)];

  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('/core/conmebol.sudamericana/game')) {
      return Response.json({ gamepackageJSON: {
        plays: [{ id: 'p1', text: 'Kickoff' }],
        rosters: [{ team: team('1', 'São Paulo'), roster: [] }, { team: team('2', 'Boca Juniors'), roster: [] }],
        boxscore: { teams: [
          { team: team('1', 'São Paulo'), statistics: sparse },
          { team: team('2', 'Boca Juniors'), statistics: sparseAway }
        ] }
      } });
    }
    if (href.includes('/core/conmebol.sudamericana/boxscore')) {
      return Response.json({ gamepackageJSON: { boxscore: { teams: [
        { team: team('1', 'São Paulo'), statistics: [...sparse, ...boxExtraHome] },
        { team: team('2', 'Boca Juniors'), statistics: [...sparseAway, ...boxExtraAway] }
      ] } } });
    }
    if (href.includes('/apis/site/v3/')) {
      return Response.json({ header: { competitions: [{ competitors: [
        { team: team('1', 'São Paulo'), statistics: [stat('passCompletionPct', '81.8%'), stat('clearances', 3), stat('cornerKicks', 99)] },
        { team: team('2', 'Boca Juniors'), statistics: [stat('passCompletionPct', '78.1%'), stat('clearances', 5), stat('cornerKicks', 99)] }
      ] }] } });
    }
    if (href.includes('site.api.espn.com')) {
      return Response.json({
        header: { id: '401999003' },
        boxscore: { teams: [
          { team: team('1', 'São Paulo'), statistics: sparse },
          { team: team('2', 'Boca Juniors'), statistics: sparseAway }
        ] }
      });
    }
    if (href.includes('/playbyplay') || href.includes('/core/soccer/boxscore') || href.includes('/core/soccer/game') || href.includes('sports.core.api.espn.com')) {
      return new Response('offline', { status: 503, headers: { 'content-type': 'text/plain' } });
    }
    throw new Error(`URL inesperada ${href}`);
  };

  const url = new URL('https://x/v1/live/summary?league=conmebol.sudamericana&event=401999003&expectedGoals=0&fresh=1');
  const result = await resolveLiveSummary(url, { cache, fetchImpl: fakeFetch, now: () => 5_000_000 });
  assert.equal(result.status, 200);
  const teams = result.body.data.boxscore.teams;
  assert.equal(teams.length, 2);
  const homeStats = new Map(teams.find((row) => row.team.id === '1').statistics.map((row) => [row.name, row.displayValue]));
  const awayStats = new Map(teams.find((row) => row.team.id === '2').statistics.map((row) => [row.name, row.displayValue]));
  for (const key of ['possessionPct', 'totalShots', 'shotsOnTarget', 'foulsCommitted', 'wonCorners', 'saves', 'yellowCards', 'redCards', 'offsides', 'totalPasses', 'passCompletionPct', 'clearances']) {
    assert.ok(homeStats.has(key), `métrica ${key} ausente no mandante`);
    assert.ok(awayStats.has(key), `métrica ${key} ausente no visitante`);
  }
  assert.equal(homeStats.get('yellowCards'), '1');
  assert.equal(awayStats.get('saves'), '1');
  assert.equal(homeStats.get('passCompletionPct'), '81.8%');
  assert.equal(homeStats.get('wonCorners'), '1', 'alias cornerKicks mais pobre não pode sobrescrever wonCorners da fonte rica');
}


// Quando a ESPN ao vivo vem "capenga", a segunda fonte completa somente as
// métricas factuais ausentes, preservando IDs/valores ESPN como autoridade principal.
{
  const cache = new MemoryCache();
  const statsStore = new SharedStatsStore();
  const team = (id, name) => ({ id, displayName: name });
  const stat = (name, value) => ({ name, displayValue: String(value) });
  const espnSparse = {
    header: { competitions: [{
      date: '2026-09-16T00:30:00Z',
      status: { type: { state: 'in', completed: false } },
      competitors: [
        { homeAway: 'home', team: team('1', 'São Paulo') },
        { homeAway: 'away', team: team('2', 'Boca Juniors') }
      ]
    }] },
    boxscore: { teams: [
      { homeAway: 'home', team: team('1', 'São Paulo'), statistics: [
        stat('possessionPct', '57.4%'), stat('totalShots', 4), stat('shotsOnTarget', 2), stat('foulsCommitted', 7), stat('wonCorners', 2)
      ] },
      { homeAway: 'away', team: team('2', 'Boca Juniors'), statistics: [
        stat('possessionPct', '42.6%'), stat('totalShots', 3), stat('shotsOnTarget', 0), stat('foulsCommitted', 9), stat('wonCorners', 0)
      ] }
    ] },
    plays: [{ id: 'p1', text: 'Kickoff' }]
  };
  let apiCalls = 0;
  let providersOnline = true;
  const fakeFetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes('thesportsdb.com/api/v1/json/123/searchevents.php')) {
      if (!providersOnline) return new Response('offline', { status: 503 });
      return Response.json({ event: [{
        idEvent: '2579902', strTimestamp: '2026-09-16T00:30:00', strSport: 'Soccer',
        strHomeTeam: 'São Paulo', strAwayTeam: 'Boca Juniors'
      }] });
    }
    if (href.includes('thesportsdb.com/api/v1/json/123/lookupeventstats.php?id=2579902')) {
      if (!providersOnline) return new Response('offline', { status: 503 });
      return Response.json({ eventstats: [
        { strEvent: 'São Paulo vs Boca Juniors', strStat: 'Shots on Goal', intHome: '2', intAway: '0' },
        { strEvent: 'São Paulo vs Boca Juniors', strStat: 'Total Shots', intHome: '4', intAway: '3' },
        { strEvent: 'São Paulo vs Boca Juniors', strStat: 'Blocked Shots', intHome: '2', intAway: '1' },
        { strEvent: 'São Paulo vs Boca Juniors', strStat: 'Ball Possession', intHome: '57', intAway: '43' },
        { strEvent: 'São Paulo vs Boca Juniors', strStat: 'Corner Kicks', intHome: '2', intAway: '0' }
      ] });
    }
    if (href.includes('v3.football.api-sports.io')) {
      apiCalls += 1;
      if (!providersOnline) return new Response('offline', { status: 503 });
      assert.equal(options?.headers?.['x-apisports-key'], 'api-key-test');
      const headers = { 'x-ratelimit-requests-limit': '100', 'x-ratelimit-requests-remaining': String(100 - apiCalls) };
      if (href.includes('/fixtures?date=')) {
        return Response.json({ errors: [], response: [{
          fixture: { id: 880001 },
          teams: { home: { id: 10, name: 'Sao Paulo' }, away: { id: 20, name: 'Boca Juniors' } }
        }] }, { headers });
      }
      if (href.includes('/fixtures/statistics?fixture=880001')) {
        return Response.json({ errors: [], response: [
          { team: { id: 10, name: 'Sao Paulo' }, statistics: [
            { type: 'Ball Possession', value: '58%' }, { type: 'Total Shots', value: 8 },
            { type: 'Shots on Goal', value: 3 }, { type: 'Blocked Shots', value: 2 },
            { type: 'Fouls', value: 8 }, { type: 'Goalkeeper Saves', value: 1 },
            { type: 'Total passes', value: 211 }, { type: 'Passes accurate', value: 181 },
            { type: 'Passes %', value: '86%' }, { type: 'Corner Kicks', value: 4 },
            { type: 'Yellow Cards', value: 1 }, { type: 'Red Cards', value: 0 }, { type: 'Offsides', value: 2 }
          ] },
          { team: { id: 20, name: 'Boca Juniors' }, statistics: [
            { type: 'Ball Possession', value: '42%' }, { type: 'Total Shots', value: 5 },
            { type: 'Shots on Goal', value: 1 }, { type: 'Blocked Shots', value: 1 },
            { type: 'Fouls', value: 10 }, { type: 'Goalkeeper Saves', value: 2 },
            { type: 'Total passes', value: 162 }, { type: 'Passes accurate', value: 129 },
            { type: 'Passes %', value: '80%' }, { type: 'Corner Kicks', value: 2 },
            { type: 'Yellow Cards', value: 2 }, { type: 'Red Cards', value: 0 }, { type: 'Offsides', value: 1 }
          ] }
        ] }, { headers });
      }
      if (href.includes('/fixtures/players?fixture=880001')) {
        return Response.json({ errors: [], response: [
          { team: { id: 10, name: 'Sao Paulo' }, players: [{ statistics: [{ tackles: { total: 6, interceptions: 2 } }] }] },
          { team: { id: 20, name: 'Boca Juniors' }, players: [{ statistics: [{ tackles: { total: 7, interceptions: 3 } }] }] }
        ] }, { headers });
      }
      throw new Error(`API-Football URL inesperada ${href}`);
    }
    if (href.includes('sports.core.api.espn.com')) return Response.json({ items: [{ id: 'p1', text: 'Kickoff' }] });
    if (href.includes('/playbyplay')) return Response.json({ gamepackageJSON: espnSparse });
    if (href.includes('/boxscore') || href.includes('/game') || href.includes('site.api.espn.com')) return Response.json({ gamepackageJSON: espnSparse });
    throw new Error(`ESPN URL inesperada ${href}`);
  };

  const url = new URL('https://x/v1/live/summary?league=conmebol.sudamericana&event=401999777&expectedGoals=0&fresh=1');
  const result = await resolveLiveSummary(url, {
    cache, statsStore, fetchImpl: fakeFetch, apiFootballKey: 'api-key-test', now: () => 9_000_000
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.statsProvider, 'espn+api-football');
  assert.equal(result.body.statsFallback.fixtureId, 880001);
  assert.equal(result.body.statsQuality, 'GOOD');
  assert.equal(result.body.apiFootballBudget.knownRemaining, 97);
  assert.equal(result.body.statsFallbacks.length, 2);
  assert.equal(result.body.statsFallbacks[0].source, 'api-football');
  assert.equal(result.body.statsFallbacks[1].source, 'api-football-players');
  assert.ok(result.body.statsCoverage.minPerTeam >= 15, 'fallback continental deve chegar ao alvo GOOD quando a API fornece team stats + defense');
  const home = result.body.data.boxscore.teams.find((row) => row.team.id === '1');
  const homeStats = new Map(home.statistics.map((row) => [row.name, row.displayValue]));
  assert.equal(homeStats.get('possessionPct'), '57.4%', 'valor ESPN já presente deve ter precedência');
  assert.equal(homeStats.get('blockedShots'), '2', 'métrica ausente deve vir da API-Football');
  assert.equal(homeStats.get('totalPasses'), '211');
  assert.equal(homeStats.get('tackles'), '6');
  assert.equal(homeStats.get('interceptions'), '2');
  assert.equal(apiCalls, 3, 'primeiro uso: lookup por data + statistics + players; chamadas seguintes usam caches separados');

  const secondCache = new MemoryCache();
  const second = await resolveLiveSummary(url, {
    cache: secondCache, statsStore, fetchImpl: fakeFetch, apiFootballKey: 'api-key-test', now: () => 9_060_000
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.statsProvider, 'espn+api-football');
  assert.equal(apiCalls, 3, 'outro edge deve reutilizar o cache D1 global e não consumir nova chamada da API-Football');

  // Derruba os provedores e apaga somente seus caches compartilhados. O best-known
  // global precisa impedir regressão do painel para as cinco métricas da ESPN.
  providersOnline = false;
  for (const key of [...statsStore.rows.keys()]) {
    if (key.startsWith('api:') || key.startsWith('api-map:') || key.startsWith('api-players:') || key.startsWith('tsdb:') || key.startsWith('tsdb-map:')) {
      statsStore.rows.delete(key);
    }
  }
  const third = await resolveLiveSummary(url, {
    cache: new MemoryCache(), statsStore, fetchImpl: fakeFetch, apiFootballKey: 'api-key-test', now: () => 9_360_000
  });
  assert.equal(third.status, 200);
  assert.equal(third.body.statsBestKnownApplied, true);
  assert.ok(third.body.statsCoverage.minPerTeam >= 15, 'best-known global deve impedir regressão estatística durante falha temporária dos provedores');
  assert.ok(third.body.statsProvider.includes('api-football'));
}


// Sem API_FOOTBALL_KEY, TheSportsDB precisa funcionar sozinho e a ausência do
// secret opcional não pode derrubar o endpoint nem impedir enriquecimento.
{
  const cache = new MemoryCache();
  const team = (id, name) => ({ id, displayName: name });
  const stat = (name, value) => ({ name, displayValue: String(value) });
  const espnSparse = {
    header: { competitions: [{
      date: '2026-09-16T00:30:00Z',
      status: { type: { state: 'in', completed: false } },
      competitors: [
        { homeAway: 'home', team: team('1', 'São Paulo') },
        { homeAway: 'away', team: team('2', 'Boca Juniors') }
      ]
    }] },
    boxscore: { teams: [
      { homeAway: 'home', team: team('1', 'São Paulo'), statistics: [
        stat('possessionPct', '57.4%'), stat('totalShots', 4), stat('shotsOnTarget', 2), stat('foulsCommitted', 7), stat('wonCorners', 2)
      ] },
      { homeAway: 'away', team: team('2', 'Boca Juniors'), statistics: [
        stat('possessionPct', '42.6%'), stat('totalShots', 3), stat('shotsOnTarget', 0), stat('foulsCommitted', 9), stat('wonCorners', 0)
      ] }
    ] },
    plays: [{ id: 'p1', text: 'Kickoff' }]
  };
  let sportsDbCalls = 0;
  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('thesportsdb.com/api/v1/json/123/searchevents.php')) {
      sportsDbCalls += 1;
      return Response.json({ event: [{
        idEvent: '2579902', strTimestamp: '2026-09-16T00:30:00', strSport: 'Soccer',
        strHomeTeam: 'São Paulo', strAwayTeam: 'Boca Juniors'
      }] });
    }
    if (href.includes('thesportsdb.com/api/v1/json/123/lookupeventstats.php?id=2579902')) {
      sportsDbCalls += 1;
      return Response.json({ eventstats: [
        { strEvent: 'São Paulo vs Boca Juniors', strStat: 'Shots on Goal', intHome: '2', intAway: '0' },
        { strEvent: 'São Paulo vs Boca Juniors', strStat: 'Total Shots', intHome: '4', intAway: '3' },
        { strEvent: 'São Paulo vs Boca Juniors', strStat: 'Blocked Shots', intHome: '2', intAway: '1' },
        { strEvent: 'São Paulo vs Boca Juniors', strStat: 'Ball Possession', intHome: '57', intAway: '43' },
        { strEvent: 'São Paulo vs Boca Juniors', strStat: 'Corner Kicks', intHome: '2', intAway: '0' }
      ] });
    }
    if (href.includes('v3.football.api-sports.io')) throw new Error('API-Football não deve ser chamada sem chave');
    if (href.includes('sports.core.api.espn.com')) return Response.json({ items: [{ id: 'p1', text: 'Kickoff' }] });
    if (href.includes('/playbyplay')) return Response.json({ gamepackageJSON: espnSparse });
    if (href.includes('/boxscore') || href.includes('/game') || href.includes('site.api.espn.com')) return Response.json({ gamepackageJSON: espnSparse });
    throw new Error(`URL inesperada ${href}`);
  };

  const url = new URL('https://x/v1/live/summary?league=conmebol.sudamericana&event=401999778&expectedGoals=0&fresh=1');
  const result = await resolveLiveSummary(url, { cache, fetchImpl: fakeFetch, now: () => Date.parse('2026-09-16T01:00:00Z') });
  assert.equal(result.status, 200);
  assert.equal(result.body.statsProvider, 'espn+thesportsdb');
  assert.equal(result.body.statsFallbacks.length, 1);
  assert.equal(result.body.statsFallbacks[0].eventId, 2579902);
  const home = result.body.data.boxscore.teams.find((row) => row.team.id === '1');
  const homeStats = new Map(home.statistics.map((row) => [row.name, row.displayValue]));
  assert.equal(homeStats.get('possessionPct'), '57.4%', 'ESPN deve continuar com precedência');
  assert.equal(homeStats.get('blockedShots'), '2', 'TheSportsDB deve preencher métrica ausente');
  assert.equal(sportsDbCalls, 2);
}


// O orçamento diário é global: chegando à reserva de segurança, um novo edge
// continua servindo ESPN/TheSportsDB sem gastar mais API-Football.
{
  const cache = new MemoryCache();
  const statsStore = new SharedStatsStore();
  statsStore.budgets.set('2026-09-16', { reservedCalls: 70, remaining: 12, limit: 100 });
  const team = (id, name) => ({ id, displayName: name });
  const stat = (name, value) => ({ name, displayValue: String(value) });
  const espnSparse = {
    header: { competitions: [{
      date: '2026-09-16T00:30:00Z', status: { type: { state: 'in', completed: false } },
      competitors: [
        { homeAway: 'home', team: team('1', 'São Paulo') },
        { homeAway: 'away', team: team('2', 'Boca Juniors') }
      ]
    }] },
    boxscore: { teams: [
      { homeAway: 'home', team: team('1', 'São Paulo'), statistics: [stat('possessionPct', '55%'), stat('totalShots', 5), stat('shotsOnTarget', 2), stat('foulsCommitted', 6), stat('wonCorners', 2)] },
      { homeAway: 'away', team: team('2', 'Boca Juniors'), statistics: [stat('possessionPct', '45%'), stat('totalShots', 4), stat('shotsOnTarget', 1), stat('foulsCommitted', 8), stat('wonCorners', 1)] }
    ] }, plays: [{ id: 'p1', text: 'Kickoff' }]
  };
  let apiCalls = 0;
  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('v3.football.api-sports.io')) { apiCalls += 1; throw new Error('não deveria chamar API-Football'); }
    if (href.includes('thesportsdb.com/api/v1/json/123/searchevents.php')) return new Response('offline', { status: 503 });
    if (href.includes('sports.core.api.espn.com')) return Response.json({ items: [{ id: 'p1', text: 'Kickoff' }] });
    if (href.includes('/playbyplay')) return Response.json({ gamepackageJSON: espnSparse });
    if (href.includes('/boxscore') || href.includes('/game') || href.includes('site.api.espn.com')) return Response.json({ gamepackageJSON: espnSparse });
    throw new Error(`URL inesperada ${href}`);
  };
  const result = await resolveLiveSummary(
    new URL('https://x/v1/live/summary?league=conmebol.libertadores&event=401999779&fresh=1'),
    { cache, statsStore, fetchImpl: fakeFetch, apiFootballKey: 'api-key-test', now: () => Date.parse('2026-09-16T01:00:00Z') }
  );
  assert.equal(result.status, 200);
  assert.equal(apiCalls, 0);
  assert.equal(result.body.apiFootballBudget.protected, true);
  assert.match(result.body.statsFallbackErrors.apiFootball, /orçamento diário protegido/);
}

console.log('live-api tests: ok');


// R10: snapshot PRE em fallback/cache jamais pode ser servido como jogo IN.
// Se a ESPN do Worker estiver momentaneamente indisponível, o frontend precisa
// receber 503 e cair para a chamada ESPN direta, em vez de exibir 0/0 antigo.
{
  const cache = new MemoryCache();
  const team = (id, name) => ({ id, displayName: name });
  const stat = (name, value) => ({ name, displayValue: String(value) });
  const pre = {
    header: { competitions: [{ status: { type: { state: 'pre', completed: false } } }] },
    boxscore: { teams: [
      { team: team('1', 'Atlético-MG'), statistics: [stat('possessionPct', '0%'), stat('totalShots', 0)] },
      { team: team('2', 'Chapecoense'), statistics: [stat('possessionPct', '0%'), stat('totalShots', 0)] }
    ] }
  };
  const primeFetch = async (url) => {
    const href = String(url);
    if (href.includes('sports.core.api.espn.com')) return new Response('offline', { status: 503, headers: { 'content-type': 'text/plain' } });
    if (href.includes('cdn.espn.com') || href.includes('site.api.espn.com')) return Response.json({ gamepackageJSON: pre });
    throw new Error(`URL inesperada ${href}`);
  };
  let result = await resolveLiveSummary(new URL('https://x/v1/live/summary?league=bra.1&event=401841239&expectedGoals=0'), {
    cache, fetchImpl: primeFetch, now: () => 10_000
  });
  assert.equal(result.status, 200);

  const offline = async () => new Response('offline', { status: 503, headers: { 'content-type': 'text/plain' } });
  result = await resolveLiveSummary(new URL('https://x/v1/live/summary?league=bra.1&event=401841239&expectedGoals=0&state=in&fresh=1'), {
    cache, fetchImpl: offline, now: () => 20_000
  });
  assert.equal(result.status, 503, 'cache PRE não pode mascarar falha ESPN durante jogo IN');
}

// R10: Brasileirão é ESPN-only. Não chamar TheSportsDB/API-Football para
// completar estatísticas, mesmo quando a cobertura ESPN ainda está reduzida.
{
  const cache = new MemoryCache();
  const team = (id, name) => ({ id, displayName: name });
  const stat = (name, value) => ({ name, displayValue: String(value) });
  const live = {
    header: { competitions: [{ status: { type: { state: 'in', completed: false } }, competitors: [
      { homeAway: 'home', team: team('1', 'Atlético-MG') }, { homeAway: 'away', team: team('2', 'Chapecoense') }
    ] }] },
    boxscore: { teams: [
      { team: team('1', 'Atlético-MG'), statistics: [stat('possessionPct', '60%'), stat('totalShots', 2), stat('shotsOnTarget', 1), stat('foulsCommitted', 1), stat('wonCorners', 1)] },
      { team: team('2', 'Chapecoense'), statistics: [stat('possessionPct', '40%'), stat('totalShots', 1), stat('shotsOnTarget', 0), stat('foulsCommitted', 2), stat('wonCorners', 0)] }
    ] },
    plays: [{ id: 'kickoff', text: 'Kickoff' }]
  };
  let externalCalls = 0;
  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('thesportsdb.com') || href.includes('api-sports.io')) { externalCalls += 1; throw new Error('fonte externa proibida no Brasileirão'); }
    if (href.includes('sports.core.api.espn.com')) return Response.json({ items: [{ id: 'kickoff', text: 'Kickoff' }] });
    if (href.includes('cdn.espn.com') || href.includes('site.api.espn.com')) return Response.json({ gamepackageJSON: live });
    throw new Error(`URL inesperada ${href}`);
  };
  const result = await resolveLiveSummary(new URL('https://x/v1/live/summary?league=bra.1&event=401841239&expectedGoals=0&state=in&fresh=1'), {
    cache, fetchImpl: fakeFetch, now: () => 30_000, apiFootballKey: 'nao-usar'
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.statsProvider, 'espn');
  assert.equal(result.body.espnOnly, true);
  assert.equal(externalCalls, 0);
}

// Live Facts v6 integrado: 0x0 descarta scoringPlay fantasma e o hot-cache
// precisa ser invalidado assim que o placar canônico muda para 1x0.
{
  const cache = new MemoryCache();
  let phase = 0;
  const payload = () => {
    const homeScore = phase === 0 ? 0 : 1;
    const plays = phase === 0
      ? [
          { id: 'rogue-plata', scoringPlay: true, team: { id: '819' }, homeScore: 1, awayScore: 0, clock: { displayValue: "10'" }, athletesInvolved: [{ displayName: 'Gonzalo Plata' }], text: 'Goal! Gonzalo Plata.' },
          { id: 'rogue-varela', scoringPlay: true, team: { id: '819' }, homeScore: 2, awayScore: 0, clock: { displayValue: "13'" }, athletesInvolved: [{ displayName: 'Guillermo Varela' }], text: 'Goal! Guillermo Varela.' }
        ]
      : [{ id: 'real-goal', scoringPlay: true, team: { id: '819' }, homeScore: 1, awayScore: 0, clock: { displayValue: "21'" }, athletesInvolved: [{ displayName: 'Gonzalo Plata' }], text: 'Goal! Gonzalo Plata.' }];
    return {
      header: { id: '401841241', competitions: [{ status: { type: { state: 'in', completed: false } }, competitors: [
        { homeAway: 'home', score: String(homeScore), team: { id: '819', displayName: 'Flamengo' } },
        { homeAway: 'away', score: '0', team: { id: '6079', displayName: 'Bragantino' } }
      ] }] },
      plays
    };
  };
  const fakeFetch = async (url) => {
    const href = String(url);
    const data = payload();
    if (href.includes('sports.core.api.espn.com')) return Response.json({ items: data.plays });
    if (href.includes('cdn.espn.com')) return Response.json({ gamepackageJSON: data });
    if (href.includes('site.api.espn.com')) return Response.json(data);
    throw new Error(`URL inesperada ${href}`);
  };

  let result = await resolveLiveSummary(new URL('https://x/v1/live/summary?league=bra.1&event=401841241&state=in&expectedHome=0&expectedAway=0&expectedGoals=0&fresh=1'), { cache, fetchImpl: fakeFetch, now: () => 10_000_000 });
  assert.equal(result.status, 200);
  assert.equal(result.body.facts.integrity.expectedGoals, 0);
  assert.equal(result.body.facts.goals.length, 0);
  assert.equal(result.body.facts.integrity.rawGoalVariants >= 2, true);
  assert.equal(result.body.facts.integrity.complete, true);

  phase = 1;
  result = await resolveLiveSummary(new URL('https://x/v1/live/summary?league=bra.1&event=401841241&state=in&expectedHome=1&expectedAway=0&expectedGoals=1'), { cache, fetchImpl: fakeFetch, now: () => 10_001_000 });
  assert.equal(result.status, 200);
  assert.equal(result.body.cacheStatus, 'miss', 'facts 0x0 do hot-cache não podem servir ao placar 1x0');
  assert.equal(result.body.facts.integrity.expectedHome, 1);
  assert.equal(result.body.facts.integrity.expectedAway, 0);
  assert.equal(result.body.facts.goals.length, 1);
  assert.equal(result.body.facts.goals[0].scorer, 'Gonzalo Plata');
}

console.log('live-api Live Facts v6 integration: ok');
