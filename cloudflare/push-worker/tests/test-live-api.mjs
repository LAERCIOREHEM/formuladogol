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
  assert.equal(first.body.data.events[0].status.displayClock, "53'");
  assert.equal(first.body.selectedSources['401999001'], 'espn_cdn_league');
  assert.equal(calls, 4);

  const second = await resolveLiveScoreboard(url, { cache, fetchImpl: async () => { throw new Error('não deveria consultar upstream'); }, now: () => 1_003_000 });
  assert.equal(second.status, 200);
  assert.equal(second.body.cacheStatus, 'hot');
  assert.equal(second.body.data.events[0].status.displayClock, "53'");

  cache.dropTier('hot');
  const degraded = await resolveLiveScoreboard(url, {
    cache,
    fetchImpl: async () => new Response('offline', { status: 503, headers: { 'content-type': 'text/plain' } }),
    now: () => 1_090_000
  });
  assert.equal(degraded.status, 200);
  assert.equal(degraded.body.stale, true);
  assert.equal(degraded.body.cacheStatus, 'stale-fallback');
  assert.equal(degraded.body.data.events[0].status.displayClock, "53'");
  assert.match(degraded.body.upstreamError, /503/);
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
      return Response.json({ gamepackageJSON: { plays: [{ id: 'g1', scoringPlay: true, text: 'Goal scored by A' }] } });
    }
    if (href.includes('/core/conmebol.sudamericana/playbyplay')) {
      return Response.json({ gamepackageJSON: { plays: [
        { id: 'g1', scoringPlay: true, text: 'Goal scored by A' },
        { id: 'g2', scoringPlay: true, text: 'Goal scored by B' }
      ] } });
    }
    if (href.includes('/core/soccer/game') || href.includes('/core/soccer/playbyplay')) {
      return new Response('blocked', { status: 503, headers: { 'content-type': 'text/plain' } });
    }
    if (href.includes('site.api.espn.com')) {
      return Response.json({
        header: { id: '401999001' },
        gameInfo: { venue: { fullName: 'Estádio teste' } },
        boxscore: { teams: [{ team: { id: '1' }, statistics: [{ name: 'possessionPct', displayValue: '55%' }] }] },
        rosters: [{ team: { id: '1' }, roster: [{ athlete: { id: '10', displayName: 'Jogador A' } }] }],
        plays: [{ id: 'g1', scoringPlay: true, text: 'Goal scored by A' }]
      });
    }
    if (href.includes('sports.core.api.espn.com')) {
      return Response.json({ items: [{ id: 'g1', scoringPlay: true, text: 'Goal scored by A' }] });
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
  const fakeFetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes('v3.football.api-sports.io')) {
      apiCalls += 1;
      assert.equal(options?.headers?.['x-apisports-key'], 'api-key-test');
      if (href.includes('/fixtures?live=all')) {
        return Response.json({ errors: [], response: [{
          fixture: { id: 880001 },
          teams: { home: { id: 10, name: 'Sao Paulo' }, away: { id: 20, name: 'Boca Juniors' } }
        }] });
      }
      if (href.includes('/fixtures?ids=880001')) {
        return Response.json({ errors: [], response: [{
          fixture: { id: 880001 },
          teams: { home: { id: 10, name: 'Sao Paulo' }, away: { id: 20, name: 'Boca Juniors' } },
          statistics: [
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
          ],
          players: [
            { team: { id: 10, name: 'Sao Paulo' }, players: [
              { player: { id: 100 }, statistics: [{ tackles: { total: 6, interceptions: 2 } }] }
            ] },
            { team: { id: 20, name: 'Boca Juniors' }, players: [
              { player: { id: 200 }, statistics: [{ tackles: { total: 7, interceptions: 3 } }] }
            ] }
          ]
        }] });
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
    cache, fetchImpl: fakeFetch, apiFootballKey: 'api-key-test', now: () => 9_000_000
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.statsProvider, 'espn+api-football');
  assert.equal(result.body.statsFallback.fixtureId, 880001);
  assert.ok(result.body.statsCoverage.minPerTeam >= 14, 'fallback deve elevar cobertura para muito além do feed ESPN reduzido');
  const home = result.body.data.boxscore.teams.find((row) => row.team.id === '1');
  const homeStats = new Map(home.statistics.map((row) => [row.name, row.displayValue]));
  assert.equal(homeStats.get('possessionPct'), '57.4%', 'valor ESPN já presente deve ter precedência');
  assert.equal(homeStats.get('blockedShots'), '2', 'métrica ausente deve vir da API-Football');
  assert.equal(homeStats.get('totalPasses'), '211');
  assert.equal(homeStats.get('tackles'), '6');
  assert.equal(homeStats.get('interceptions'), '2');
  assert.equal(apiCalls, 2, 'lookup live + details enriquecido devem bastar');
}

console.log('live-api tests: ok');
