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

console.log('live-api tests: ok');
