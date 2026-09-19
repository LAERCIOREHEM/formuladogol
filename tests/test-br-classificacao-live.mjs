import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const live = require('../js/br-classificacao-live.js');

function canon(value) {
  const raw = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const aliases = {
    'botafogo': 'Botafogo',
    'mirassol': 'Mirassol',
    'remo': 'Remo',
    'santos': 'Santos',
  };
  return aliases[raw] || String(value || '').trim();
}

function espnEvent(id, home, away, homeScore, awayScore, clock = "12'") {
  return {
    id,
    date: '2026-09-19T20:00:00Z',
    competitions: [{
      id,
      date: '2026-09-19T20:00:00Z',
      status: {
        displayClock: clock,
        period: 1,
        type: { state: 'in', completed: false, shortDetail: clock, description: 'Em andamento' },
      },
      competitors: [
        { homeAway: 'home', score: String(homeScore), team: { id: `${id}-h`, displayName: home } },
        { homeAway: 'away', score: String(awayScore), team: { id: `${id}-a`, displayName: away } },
      ],
    }],
  };
}

const workerPayload = {
  ok: true,
  source: 'espn_gateway_merge',
  sources: ['espn_cdn_league', 'espn_site_api'],
  fetchedAt: Date.parse('2026-09-19T21:43:00Z'),
  stateContractVersion: 1,
  transport: 'worker-espn',
  data: { events: [
    espnEvent('401841245', 'Mirassol', 'Botafogo', 1, 1, "43'"),
    espnEvent('401841244', 'Remo', 'Santos', 0, 1, "12'"),
  ] },
};

// Worker é a fonte primária e os dois jogos simultâneos entram no MESMO snapshot.
{
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    return Response.json(workerPayload);
  };
  const state = await live.fetchLiveState({
    canonicalize: canon,
    referenceDate: new Date('2026-09-19T21:43:05Z'),
    fetcher,
    storage: { getItem: () => null, setItem: () => {} },
  });
  assert.equal(state.meta.source, 'worker-espn');
  assert.equal(state.meta.liveStateVersion, '4');
  assert.equal(Object.keys(state.liveMap).length, 2);
  assert.ok(calls[0].includes('/v1/live/state?league=bra.1'));
  assert.ok(!calls[0].includes('fresh=1'), 'fluxo normal compartilha o hot snapshot do Worker');

  const byEvent = live.findLiveGame({ event_id: '401841245', mandante: { nome: 'X' }, visitante: { nome: 'Y' } }, state.liveMap, canon);
  assert.equal(byEvent.mandante, 'Mirassol');
  assert.equal(byEvent.visitante, 'Botafogo');
}

// Se o Worker falhar, a ESPN direta continua sendo uma contingência real.
{
  const directPayload = { events: [espnEvent('401841245', 'Mirassol', 'Botafogo', 2, 1, "51'")] };
  const fetcher = async (url) => {
    const href = String(url);
    if (href.includes('push.formuladogol.com.br')) return new Response('offline', { status: 503 });
    if (href.includes('site.api.espn.com')) return Response.json(directPayload);
    throw new Error(`URL inesperada: ${href}`);
  };
  const state = await live.fetchLiveState({
    canonicalize: canon,
    referenceDate: new Date('2026-09-19T21:51:00Z'),
    fetcher,
    storage: { getItem: () => null, setItem: () => {} },
  });
  assert.equal(state.meta.source, 'direct-espn');
  assert.equal(state.meta.fallback, true);
  assert.equal(state.liveMap['Mirassol|Botafogo'].placarMandante, '2');
}

// Diagnóstico pode exigir fresh=1 sem alterar o fluxo normal compartilhado.
{
  let seen = '';
  await live.fetchLiveState({
    canonicalize: canon,
    forceFresh: true,
    referenceDate: new Date('2026-09-19T21:43:05Z'),
    fetcher: async (url) => { seen = String(url); return Response.json(workerPayload); },
    storage: { getItem: () => null, setItem: () => {} },
  });
  assert.ok(seen.includes('fresh=1'));
}

// Worker degradado/stale não deve impedir uma ESPN direta mais fresca.
{
  const staleWorker = structuredClone(workerPayload);
  staleWorker.stale = true;
  staleWorker.cacheStatus = 'stale-fallback';
  staleWorker.fetchedAt = Date.parse('2026-09-19T21:40:00Z');
  staleWorker.data.events[0] = espnEvent('401841245', 'Mirassol', 'Botafogo', 0, 0, "39'");
  const directPayload = { events: [espnEvent('401841245', 'Mirassol', 'Botafogo', 2, 1, "52'")] };
  const fetcher = async (url) => {
    const href = String(url);
    if (href.includes('push.formuladogol.com.br')) return Response.json(staleWorker);
    if (href.includes('site.api.espn.com')) return Response.json(directPayload);
    throw new Error(`URL inesperada: ${href}`);
  };
  const state = await live.fetchLiveState({
    canonicalize: canon,
    referenceDate: new Date('2026-09-19T21:52:00Z'),
    fetcher,
    storage: { getItem: () => null, setItem: () => {} },
  });
  assert.equal(state.meta.source, 'direct-espn');
  assert.equal(state.liveMap['Mirassol|Botafogo'].placarMandante, '2');
  assert.equal(state.liveMap['Mirassol|Botafogo'].status, "52'");
}

// Regressão 19/09: Mirassol x Botafogo + Remo x Santos simultâneos devem
// projetar os quatro clubes como AO VIVO e acrescentar uma partida a cada um.
{
  const liveMap = live.normalizeScoreboard(workerPayload.data, {
    canonicalize: canon,
    referenceDate: new Date('2026-09-19T21:43:05Z'),
  });
  const table = [
    { time: 'Botafogo', pontos: 35, jogos: 27, vitorias: 9, empates: 8, derrotas: 10, gp: 33, gc: 30 },
    { time: 'Mirassol', pontos: 29, jogos: 27, vitorias: 7, empates: 8, derrotas: 12, gp: 28, gc: 36 },
    { time: 'Santos', pontos: 35, jogos: 26, vitorias: 9, empates: 8, derrotas: 9, gp: 31, gc: 30 },
    { time: 'Remo', pontos: 23, jogos: 27, vitorias: 5, empates: 8, derrotas: 14, gp: 24, gc: 39 },
  ];
  const projection = live.projectStandings({ table, results: [], liveMap, canonicalize: canon, referenceDate: new Date('2026-09-19T21:43:05Z') });
  assert.equal(projection.jogos.length, 2);
  const byTeam = Object.fromEntries(projection.tabela.map((row) => [row.time, row]));
  for (const team of ['Botafogo', 'Mirassol', 'Remo', 'Santos']) assert.equal(byTeam[team]._aoVivo, true, `${team} sem AO VIVO`);
  assert.equal(byTeam.Botafogo.jogos, 28);
  assert.equal(byTeam.Mirassol.jogos, 28);
  assert.equal(byTeam.Remo.jogos, 28);
  assert.equal(byTeam.Santos.jogos, 27);
  assert.equal(byTeam.Botafogo.pontos, 36, 'empate provisório adiciona 1 ponto ao Botafogo');
  assert.equal(byTeam.Mirassol.pontos, 30, 'empate provisório adiciona 1 ponto ao Mirassol');
  assert.equal(byTeam.Santos.pontos, 38, 'vitória provisória adiciona 3 pontos ao Santos');
  assert.equal(byTeam.Remo.pontos, 23, 'derrota provisória mantém pontos do Remo');
}

// A ESPN/CDN pode serializar score como objeto; isso não pode derrubar a projeção.
{
  const objectScore = espnEvent('obj-score', 'Mirassol', 'Botafogo', 0, 0, "7'");
  objectScore.competitions[0].competitors[0].score = { value: 1, displayValue: '1' };
  objectScore.competitions[0].competitors[1].score = { value: 0, displayValue: '0' };
  const map = live.normalizeScoreboard({ events: [objectScore] }, { canonicalize: canon, referenceDate: new Date('2026-09-19T21:07:00Z') });
  assert.equal(map['Mirassol|Botafogo'].placarMandante, 1);
  assert.equal(map['Mirassol|Botafogo'].placarVisitante, 0);
}

console.log('OK: LiveState v4 — Worker ESPN primário, fallback direto, eventId e dois jogos simultâneos.');
