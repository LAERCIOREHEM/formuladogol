import assert from 'node:assert/strict';
import { fetchEspnLivePlays, fetchEspnScorerEnrichment, fetchEspnScoreboard, fetchEspnScoreboardFresh, fetchEspnScoreboardGateway, fetchEspnSummary, fetchEspnSummaryGateway, fetchEspnTechnicalHotTestPlays, fetchEspnTechnicalLivePlays, fetchEspnTechnicalScoreboard, probeEspnSources, summaryGoalCount, summaryNamedScorerHintCount, unwrapScoreboard, unwrapSummary } from '../src/espn-source.js';

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
assert.equal(summaryNamedScorerHintCount({ plays: [{ scoringPlay: true, text: 'Goal scored by Kaio Jorge' }] }), 1);

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
  assert.equal(probe.sourceLayerVersion, '6-R9');
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
  assert.equal(result.variants.length, 2, 'R9 preserva todos os feeds ao-vivo bem-sucedidos para fusão');
}

// R9: CORE é consultado mesmo quando ambos os CDNs respondem. É justamente essa
// superfície que pode trazer o atleta antes dos CDNs sem atrasar a confirmação.
{
  const calls = [];
  const fakeFetch = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('/core/bra.copa_do_brazil/playbyplay')) {
      return Response.json({ gamepackageJSON: { plays: [{ id: 'g1', scoringPlay: true, text: 'Goal', team: { id: '2022' }, homeScore: 0, awayScore: 1 }] } });
    }
    if (href.includes('/core/soccer/playbyplay')) {
      return Response.json({ gamepackageJSON: { plays: [{ id: 'g1b', scoringPlay: true, text: 'Goal', team: { id: '2022' }, homeScore: 0, awayScore: 1 }] } });
    }
    if (href.includes('/leagues/bra.copa_do_brazil/events/401909112/competitions/401909112/plays')) {
      return Response.json({ items: [{ id: 'core-g1', scoringPlay: true, text: 'Goal', team: { id: '2022' }, athletesInvolved: [{ id: '19', displayName: 'Kaio Jorge' }], homeScore: 0, awayScore: 1 }] });
    }
    throw new Error(`URL inesperada ${href}`);
  };
  const result = await fetchEspnLivePlays('bra.copa_do_brazil', event.id, fakeFetch);
  assert.equal(result.variants.length, 3);
  assert.ok(result.variants.some((row) => row.source === 'espn_core_plays'));
  assert.ok(calls.some((href) => href.includes('/competitions/401909112/plays')));
  const core = result.variants.find((row) => row.source === 'espn_core_plays');
  assert.equal(summaryNamedScorerHintCount(core.data), 1);
}

// R9: microcamada final usa apenas superfícies complementares (game/site summary),
// com execução paralela e sem exigir que uma única fonte tenha toda a partida.
{
  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('/core/bra.copa_do_brazil/game')) {
      return Response.json({ gamepackageJSON: { plays: [{ id: 'g1', scoringPlay: true, text: 'Goal scored by Kaio Jorge', team: { id: '2022' }, homeScore: 0, awayScore: 1 }] } });
    }
    if (href.includes('/core/soccer/game')) return new Response('blocked', { status: 503, headers: { 'content-type': 'text/plain' } });
    if (href.includes('site.api.espn.com')) return Response.json({ plays: [{ id: 'g1-site', scoringPlay: true, text: 'Goal', team: { id: '2022' }, homeScore: 0, awayScore: 1 }] });
    throw new Error(`URL inesperada ${href}`);
  };
  const result = await fetchEspnScorerEnrichment('bra.copa_do_brazil', event.id, fakeFetch, 1);
  assert.ok(result.variants.length >= 1);
  assert.equal(result.source, 'espn_cdn_league_game');
  assert.equal(summaryNamedScorerHintCount(result.data), 1);
}


// 6-H1: o teste quente usa o play-by-play real da Coppa Italia, sem ampliar o probe de produção.
{
  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('/leagues/ita.coppa_italia/events/401911806/competitions/401911806/plays')) {
      return Response.json({ items: [
        { id: 'hot-1', text: 'Shot saved', clock: { displayValue: "46'" } },
        { id: 'hot-2', text: 'Corner', clock: { displayValue: "47'" } }
      ] });
    }
    throw new Error(`não deveria chegar em ${href}`);
  };
  const result = await fetchEspnTechnicalHotTestPlays('401911806', fakeFetch);
  assert.equal(result.source, 'espn_core_plays');
  assert.equal(result.data.plays.length, 2);
}


// 6-H2: scoreboard técnico da Coppa Italia pode ser consultado sem ampliar as ligas de produção.
{
  const target = {
    id: '999001', date: '2026-09-02T16:00:00Z',
    status: { type: { state: 'pre', completed: false } },
    competitions: [{ competitors: [
      { homeAway: 'home', score: '0', team: { id: '118', displayName: 'Udinese' } },
      { homeAway: 'away', score: '0', team: { id: '175', displayName: 'Venezia' } }
    ] }]
  };
  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('/core/ita.coppa_italia/scoreboard')) return Response.json({ content: { events: [target] } });
    if (href.includes('/core/soccer/scoreboard')) return Response.json({ content: { events: [target] } });
    if (href.includes('site.web.api.espn.com')) return Response.json({ events: [target] });
    throw new Error(`URL inesperada ${href}`);
  };
  const result = await fetchEspnTechnicalScoreboard('ita.coppa_italia', '20260902', fakeFetch);
  assert.equal(result.data.events[0].id, '999001');
  assert.equal(result.source, 'espn_freshest_merge');
}

// 6-H2: play-by-play técnico usa a mesma seleção pela fonte mais avançada do R5.
{
  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('/core/ita.coppa_italia/playbyplay')) {
      return Response.json({ gamepackageJSON: { plays: [{ id: 'u1', scoringPlay: true, text: 'Goal', homeScore: 1, awayScore: 0 }] } });
    }
    if (href.includes('/core/soccer/playbyplay')) {
      return Response.json({ gamepackageJSON: { plays: [
        { id: 'u1', scoringPlay: true, text: 'Goal', homeScore: 1, awayScore: 0 },
        { id: 'v1', scoringPlay: true, text: 'Goal', homeScore: 1, awayScore: 1 }
      ] } });
    }
    if (href.includes('/leagues/ita.coppa_italia/')) return new Response('blocked', { status: 404, headers: { 'content-type': 'text/plain' } });
    throw new Error(`URL inesperada ${href}`);
  };
  const result = await fetchEspnTechnicalLivePlays('ita.coppa_italia', '999001', fakeFetch);
  assert.equal(result.source, 'espn_cdn_soccer_playbyplay');
  assert.equal(summaryGoalCount(result.data), 2);
}

console.log('espn-source: PASS');


// R10: no Brasileirão, um boxscore ESPN ainda preso nos placeholders 0/0
// não pode bloquear a mesma métrica já atualizada em outra superfície ESPN.
{
  const team = (id, name) => ({ id, displayName: name });
  const stat = (name, value) => ({ name, displayValue: String(value) });
  const preZero = {
    header: { competitions: [{ status: { type: { state: 'in', completed: false } } }] },
    boxscore: { teams: [
      { team: team('1', 'Atlético-MG'), statistics: [stat('possessionPct', '0%'), stat('totalShots', 0), stat('shotsOnTarget', 0), stat('foulsCommitted', 0), stat('wonCorners', 0)] },
      { team: team('2', 'Chapecoense'), statistics: [stat('possessionPct', '0%'), stat('totalShots', 0), stat('shotsOnTarget', 0), stat('foulsCommitted', 0), stat('wonCorners', 0)] }
    ] },
    plays: [{ id: 'kickoff', text: 'Kickoff' }]
  };
  const live = structuredClone(preZero);
  live.boxscore.teams[0].statistics = [stat('possessionPct', '61.2%'), stat('totalShots', 2), stat('shotsOnTarget', 1), stat('foulsCommitted', 1), stat('wonCorners', 1)];
  live.boxscore.teams[1].statistics = [stat('possessionPct', '38.8%'), stat('totalShots', 1), stat('shotsOnTarget', 0), stat('foulsCommitted', 2), stat('wonCorners', 0)];

  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('/core/bra.1/game')) return Response.json({ gamepackageJSON: preZero });
    if (href.includes('site.api.espn.com')) return Response.json(live);
    if (href.includes('/core/bra.1/boxscore')) return Response.json({ gamepackageJSON: { boxscore: preZero.boxscore } });
    if (href.includes('/playbyplay') || href.includes('/core/soccer/') || href.includes('/apis/site/v3/') || href.includes('sports.core.api.espn.com')) {
      return new Response('offline', { status: 503, headers: { 'content-type': 'text/plain' } });
    }
    throw new Error(`URL inesperada ${href}`);
  };
  const result = await fetchEspnSummaryGateway('bra.1', '401841239', fakeFetch, 0);
  const home = result.data.boxscore.teams.find((row) => row.team.id === '1');
  const values = new Map(home.statistics.map((row) => [row.name, row.displayValue]));
  assert.equal(values.get('possessionPct'), '61.2%');
  assert.equal(values.get('totalShots'), '2');
  assert.equal(values.get('shotsOnTarget'), '1');
}


// LiveState v4: state=post sem completed=true não pode vencer um feed IN real.
{
  const falsePost = {
    id: '401841245',
    date: '2026-09-19T20:00:00Z',
    competitions: [{
      id: '401841245',
      status: { displayClock: "0'", period: 0, type: { state: 'post', completed: false, shortDetail: 'Post' } },
      competitors: [
        { homeAway: 'home', score: '0', team: { id: '1', displayName: 'Mirassol' } },
        { homeAway: 'away', score: '0', team: { id: '2', displayName: 'Botafogo' } },
      ],
    }],
  };
  const liveEvent = structuredClone(falsePost);
  liveEvent.competitions[0].status = { displayClock: "44'", period: 1, type: { state: 'in', completed: false, shortDetail: "44'" } };
  liveEvent.competitions[0].competitors[0].score = '1';
  liveEvent.competitions[0].competitors[1].score = '1';

  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('/core/bra.1/scoreboard')) return Response.json({ content: { events: [liveEvent] } });
    if (href.includes('/core/soccer/scoreboard')) return Response.json({ content: { events: [falsePost] } });
    if (href.includes('site.web.api.espn.com')) return Response.json({ events: [falsePost] });
    if (href.includes('site.api.espn.com')) return Response.json({ events: [falsePost] });
    throw new Error(`URL inesperada ${href}`);
  };
  const result = await fetchEspnScoreboardGateway('bra.1', '20260919', fakeFetch);
  assert.equal(result.data.events[0].competitions[0].status.type.state, 'in');
  assert.equal(result.data.events[0].competitions[0].status.displayClock, "44'");
  assert.equal(result.selectedSources['401841245'], 'espn_cdn_league');
}

console.log('espn-source live-state legacy regressions: PASS');

// LiveState v6: um feed com relógio maior NÃO pode regredir um gol já visto
// em outra superfície. Caso real: 1x3 em 90+6 contra 1x2 em 90+7.
{
  const mk = (scoreAway, clock, sourceState = 'in', completed = false) => ({
    id: '401841241',
    date: '2026-09-20T18:30:00Z',
    status: { type: { state: sourceState, completed, shortDetail: clock }, displayClock: clock, period: 2 },
    competitions: [{
      id: '401841241',
      status: { type: { state: sourceState, completed, shortDetail: clock }, displayClock: clock, period: 2 },
      competitors: [
        { homeAway: 'home', score: '1', team: { id: '3456', displayName: 'Vitória' } },
        { homeAway: 'away', score: String(scoreAway), team: { id: '2022', displayName: 'Cruzeiro' } }
      ]
    }]
  });
  const score13 = mk(3, "90+6'");
  const stale12 = mk(2, "90+7'");
  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('/core/bra.1/scoreboard')) return Response.json({ content: { events: [score13] } });
    if (href.includes('/core/soccer/scoreboard')) return Response.json({ content: { events: [stale12] } });
    if (href.includes('site.web.api.espn.com')) return Response.json({ events: [stale12] });
    if (href.includes('site.api.espn.com')) return Response.json({ events: [stale12] });
    throw new Error(`URL inesperada ${href}`);
  };
  const result = await fetchEspnScoreboardGateway('bra.1', '20260920', fakeFetch);
  const chosen = result.data.events[0];
  assert.equal(chosen.competitions[0].competitors[1].score, '3');
  assert.equal(chosen.competitions[0].status.displayClock, "90+6'");
  assert.equal(result.selectedSources['401841241'], 'espn_cdn_league');
}

// Mesmo se a superfície atrasada marcar completed=true, ela não pode consolidar
// FINAL com placar menor do que um feed IN que já observou mais gols.
{
  const live13 = {
    id: 'v-final-guard', date: '2026-09-20T18:30:00Z',
    competitions: [{ status: { type: { state: 'in', completed: false }, displayClock: "90+6'", period: 2 }, competitors: [
      { homeAway: 'home', score: '1', team: { id: 'h', displayName: 'Vitória' } },
      { homeAway: 'away', score: '3', team: { id: 'a', displayName: 'Cruzeiro' } }
    ] }]
  };
  const final12 = structuredClone(live13);
  final12.competitions[0].status = { type: { state: 'post', completed: true }, displayClock: "90+7'", period: 2 };
  final12.competitions[0].competitors[1].score = '2';
  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.includes('/core/bra.1/scoreboard')) return Response.json({ content: { events: [live13] } });
    if (href.includes('/core/soccer/scoreboard')) return Response.json({ content: { events: [final12] } });
    if (href.includes('site.web.api.espn.com')) return Response.json({ events: [final12] });
    if (href.includes('site.api.espn.com')) return Response.json({ events: [final12] });
    throw new Error(`URL inesperada ${href}`);
  };
  const result = await fetchEspnScoreboardGateway('bra.1', '20260920', fakeFetch);
  assert.equal(result.data.events[0].competitions[0].competitors[1].score, '3');
  assert.equal(result.data.events[0].competitions[0].status.type.state, 'in');
}

console.log('espn-source live-state-v6 anti-regression: PASS');
