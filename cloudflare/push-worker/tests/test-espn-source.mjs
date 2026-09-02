import assert from 'node:assert/strict';
import { fetchEspnLivePlays, fetchEspnScoreboard, fetchEspnScoreboardFresh, fetchEspnSummary, probeEspnSources, summaryGoalCount, unwrapScoreboard, unwrapSummary } from '../src/espn-source.js';

const event = {
  id: '401909112',
  status: { type: { state: 'pre', completed: false } },
  competitions: [{ competitors: [] }]
};

assert.equal(unwrapScoreboard({ events: [event] }).events.length, 1);
assert.equal(unwrapScoreboard({ content: { events: [event] } }).events[0].id, event.id);
assert.ok(unwrapSummary({ gamepackageJSON: { plays: [{ id: 'p1' }] } }).plays);
assert.throws(() => unwrapSummary({ gamepackageJSON: { header: {}, boxscore: {} } }), /sem plays\/scoringPlays/);
assert.equal(summaryGoalCount({ plays: [{ scoringPlay: true, text: 'Goal' }, { text: 'Yellow Card' }] }), 1);

{
  const calls = [];
  const fakeFetch = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('/core/soccer/scoreboard')) return new Response('blocked', { status: 403, headers: { 'content-type': 'text/plain' } });
    if (href.includes('/core/bra.copa_do_brazil/scoreboard')) return Response.json({ content: { events: [event] } });
    throw new Error(`não deveria chegar em ${href}`);
  };
  const result = await fetchEspnScoreboard('bra.copa_do_brazil', '20260901', fakeFetch);
  assert.equal(result.source, 'espn_cdn_league');
  assert.equal(result.data.events[0].id, event.id);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].ok, false);
  assert.equal(result.attempts[1].ok, true);
  assert.equal(calls.length, 2);
}

{
  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('cdn.espn.com')) return new Response('blocked', { status: 403, headers: { 'content-type': 'text/plain' } });
    if (href.includes('site.api.espn.com')) return Response.json({ events: [event] });
    throw new Error(`URL inesperada ${href}`);
  };
  const result = await fetchEspnScoreboard('bra.1', '20260901', fakeFetch);
  assert.equal(result.source, 'espn_site_api');
  assert.equal(result.data.events.length, 1);
  assert.equal(result.attempts.length, 3);
}

{
  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('/core/bra.copa_do_brazil/game')) {
      return Response.json({ gamepackageJSON: { plays: [{ id: 'g1', scoringPlay: true, text: 'Goal' }] } });
    }
    throw new Error(`não deveria chegar em ${href}`);
  };
  const result = await fetchEspnSummary('bra.copa_do_brazil', event.id, fakeFetch, 1);
  assert.equal(result.source, 'espn_cdn_league_game');
  assert.equal(result.data.plays[0].id, 'g1');
}

// Regressão do primeiro gol real: um endpoint CDN pode responder 200 com header/boxscore,
// mas sem play-by-play. Isso NÃO pode encerrar o fallback como "summary válido".
{
  const calls = [];
  const fakeFetch = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('/core/bra.copa_do_brazil/game')) {
      return Response.json({ gamepackageJSON: { header: { id: event.id }, boxscore: { teams: [] } } });
    }
    if (href.includes('/core/bra.copa_do_brazil/playbyplay')) {
      return Response.json({ gamepackageJSON: { plays: [{
        id: 'kaio-30', scoringPlay: true, text: 'Goal',
        team: { id: '2022' }, athletesInvolved: [{ id: '19', displayName: 'Kaio Jorge' }],
        clock: { displayValue: "30'" }, homeScore: 0, awayScore: 1
      }] } });
    }
    throw new Error(`não deveria chegar em ${href}`);
  };
  const result = await fetchEspnSummary('bra.copa_do_brazil', event.id, fakeFetch, 1);
  assert.equal(result.source, 'espn_cdn_league_playbyplay');
  assert.equal(summaryGoalCount(result.data), 1);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].ok, false);
  assert.match(result.attempts[0].error, /sem plays\/scoringPlays/);
  assert.equal(result.attempts[1].ok, true);
  assert.equal(calls.length, 2);
}

// Mesmo com plays, uma resposta sem o número de gols que o placar exige é incompleta.
{
  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('/core/bra.copa_do_brazil/game')) {
      return Response.json({ gamepackageJSON: { plays: [{ id: 'card', text: 'Yellow Card' }] } });
    }
    if (href.includes('/core/bra.copa_do_brazil/playbyplay')) {
      return Response.json({ gamepackageJSON: { plays: [{ id: 'g1', scoringPlay: true, text: 'Goal' }] } });
    }
    throw new Error(`URL inesperada ${href}`);
  };
  const result = await fetchEspnSummary('bra.copa_do_brazil', event.id, fakeFetch, 1);
  assert.equal(result.source, 'espn_cdn_league_playbyplay');
  assert.match(result.attempts[0].error, /summary incompleto/);
}

{
  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('/core/soccer/scoreboard')) return Response.json({ events: [] });
    throw new Error(`não deveria usar fallback no probe: ${href}`);
  };
  const probe = await probeEspnSources(fakeFetch, '20260901');
  assert.equal(probe.ok, true);
  assert.equal(probe.sourceLayerVersion, '6-R3');
  assert.equal(Object.keys(probe.leagues).length, 4);
  assert.deepEqual(probe.failed, []);
  assert.ok(Object.values(probe.leagues).every((row) => row.source === 'espn_cdn_soccer'));
}


// R5: durante jogo, consulta múltiplos scoreboards e escolhe o evento mais recente.
{
  const stale = {
    ...event,
    status: { type: { state: 'in', completed: false, shortDetail: "50'" }, displayClock: "50'", period: 2 },
    competitions: [{ competitors: [
      { homeAway: 'home', score: '0', team: { id: '7632', displayName: 'Atlético-MG' } },
      { homeAway: 'away', score: '1', team: { id: '2022', displayName: 'Cruzeiro' } }
    ] }]
  };
  const fresh = structuredClone(stale);
  fresh.status.type.shortDetail = "53'";
  fresh.status.displayClock = "53'";
  fresh.competitions[0].competitors[0].score = '1';
  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('/core/bra.copa_do_brazil/scoreboard')) return Response.json({ content: { events: [fresh] } });
    if (href.includes('/core/soccer/scoreboard')) return Response.json({ content: { events: [stale] } });
    if (href.includes('site.web.api.espn.com')) return Response.json({ events: [stale] });
    throw new Error(`URL inesperada ${href}`);
  };
  const result = await fetchEspnScoreboardFresh('bra.copa_do_brazil', '20260901', fakeFetch);
  assert.equal(result.source, 'espn_freshest_merge');
  assert.equal(result.selectedSources[event.id], 'espn_cdn_league');
  const chosen = result.data.events[0];
  assert.equal(chosen.status.displayClock, "53'");
  assert.equal(chosen.competitions[0].competitors[0].score, '1');
}

// R5: play-by-play ao vivo é independente do scoreboard e escolhe o feed com mais gols.
{
  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('/core/bra.copa_do_brazil/playbyplay')) {
      return Response.json({ gamepackageJSON: { plays: [{ id: 'g1', scoringPlay: true, text: 'Goal', homeScore: 0, awayScore: 1 }] } });
    }
    if (href.includes('/core/soccer/playbyplay')) {
      return Response.json({ gamepackageJSON: { plays: [
        { id: 'g1', scoringPlay: true, text: 'Goal', homeScore: 0, awayScore: 1 },
        { id: 'g2', scoringPlay: true, text: 'Goal', homeScore: 1, awayScore: 1 }
      ] } });
    }
    throw new Error(`não deveria chegar em ${href}`);
  };
  const result = await fetchEspnLivePlays('bra.copa_do_brazil', event.id, fakeFetch);
  assert.equal(result.source, 'espn_cdn_soccer_playbyplay');
  assert.equal(summaryGoalCount(result.data), 2);
}

console.log('espn-source: PASS');
