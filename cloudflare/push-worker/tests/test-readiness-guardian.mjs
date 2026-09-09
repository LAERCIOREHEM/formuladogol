import assert from 'node:assert/strict';
import {
  CHECKPOINTS,
  READINESS_VERSION,
  resolveScoreboardEvent,
  dueReadinessCheckpoints,
  readinessSnapshot,
  extractRedCards,
  applyRedCardObservations,
  extractLineupSnapshot,
  applyLineupObservation,
  aiResolverRequest
} from '../src/readiness-guardian.js';
import { deriveScheduleEvents } from '../src/sports-monitor.js';

const kickoff = '2026-09-08T23:30:00.000Z';
const game = {
  eventId: '401912542',
  league: 'conmebol.sudamericana',
  competitionKey: 'sul_americana',
  competitionName: 'Sul-Americana',
  kickoff,
  home: { id: '5', name: 'Boca Juniors', abbreviation: 'BOC' },
  away: { id: '2026', name: 'São Paulo', abbreviation: 'SAO' }
};
function raw(id='401912542', state='pre') {
  return {
    id, date: kickoff, status: { type: { state } },
    competitions: [{ status: { type: { state } }, competitors: [
      { homeAway: 'home', team: { id: '5', displayName: 'Boca Juniors', abbreviation: 'BOC' }, score: '0' },
      { homeAway: 'away', team: { id: '2026', displayName: 'São Paulo', abbreviation: 'SAO' }, score: '0' }
    ] }]
  };
}

assert.equal(READINESS_VERSION, '6-R10');
assert.deepEqual(CHECKPOINTS.map((x) => x.key), ['t30','t10','tplus3']);
assert.deepEqual(deriveScheduleEvents({}, {}, Date.now(), true), [], 'alertas legados de agenda precisam permanecer desativados');

let resolved = resolveScoreboardEvent([raw()], game);
assert.equal(resolved.sourceEventId, game.eventId);
assert.equal(resolved.strategy, 'event_id');

// Regressão do tipo Boca x São Paulo: mesmo que a agenda carregue um event_id antigo,
// o confronto exato deve ser reconciliado deterministicamente antes de invocar IA.
const staleGame = { ...game, eventId: 'agenda-id-antigo', sourceEventId: '' };
resolved = resolveScoreboardEvent([raw('401912542')], staleGame);
assert.equal(resolved.sourceEventId, '401912542');
assert.equal(resolved.strategy, 'matchup');

const t30now = Date.parse(kickoff) - 29 * 60_000;
let due = dueReadinessCheckpoints(game, {}, t30now);
assert.deepEqual(due.map((x) => x.key), ['t30']);
due = dueReadinessCheckpoints(game, { t30: { completedAt: t30now } }, Date.parse(kickoff) - 9 * 60_000);
assert.deepEqual(due.map((x) => x.key), ['t10']);
due = dueReadinessCheckpoints(game, { t30:{completedAt:1}, t10:{completedAt:2} }, Date.parse(kickoff) + 3 * 60_000);
assert.deepEqual(due.map((x) => x.key), ['tplus3']);

const initialized = { initialized: true };
let readiness = readinessSnapshot(game, resolveScoreboardEvent([raw()], game), initialized, { goal:1, red_card:1, match_start:1, final_whistle:1 }, 't30', t30now);
assert.equal(readiness.ready, true);
assert.equal(readiness.readiness, 'green');
readiness = readinessSnapshot(game, resolveScoreboardEvent([raw('401912542','pre')], game), initialized, {}, 'tplus3', Date.parse(kickoff)+3*60_000);
assert.equal(readiness.ready, false);
assert.ok(readiness.reasons.includes('espn_still_pre_after_tplus3'));
readiness = readinessSnapshot(game, resolveScoreboardEvent([raw('401912542','in')], game), initialized, {}, 'tplus3', Date.parse(kickoff)+3*60_000);
assert.equal(readiness.ready, true);

// Cartão vermelho: precisa de duas observações e 60 s de estabilidade.
const redObservation = {
  eventId: game.eventId, league: game.league,
  home: { ...game.home, score: 1 }, away: { ...game.away, score: 0 }
};
const redPayload = { plays: [{
  id: 'red-1', redCard: true, type: { text: 'Red Card' },
  athlete: { id: '44', displayName: 'José Silva' }, team: { id: '2026', displayName: 'São Paulo' },
  clock: { displayValue: "63'" }, text: 'Red Card to José Silva (São Paulo)'
}] };
const cards = extractRedCards(redPayload, redObservation, 'espn_summary');
assert.equal(cards.length, 1);
let match = { ...game, initialized:true, home:{...game.home,score:1}, away:{...game.away,score:0} };
let redStep = applyRedCardObservations(match, cards, redObservation, 1_000_000);
assert.equal(redStep.emitted.length, 0);
redStep = applyRedCardObservations(redStep.match, cards, redObservation, 1_060_001);
assert.equal(redStep.emitted.length, 1);
assert.equal(redStep.emitted[0].type, 'red_card');
assert.equal(redStep.emitted[0].athlete.name, 'José Silva');

// Escalação: só Brasileirão, exatamente 11 titulares por lado, duas leituras estáveis.
const brObs = {
  eventId:'401999999', league:'bra.1', state:'pre',
  home:{ id:'1', name:'Flamengo', abbreviation:'FLA', score:0 },
  away:{ id:'2', name:'Palmeiras', abbreviation:'PAL', score:0 }
};
const starters = (prefix) => Array.from({length:11}, (_,i) => ({ starter:true, athlete:{ id:`${prefix}${i+1}`, displayName:`${prefix} Jogador ${i+1}` } }));
const summary = { rosters:[
  { team:{id:'1',displayName:'Flamengo',abbreviation:'FLA'}, roster:starters('F') },
  { team:{id:'2',displayName:'Palmeiras',abbreviation:'PAL'}, roster:starters('P') }
] };
const lineup = extractLineupSnapshot(summary, brObs);
assert.equal(lineup.home.length, 11);
assert.equal(lineup.away.length, 11);
assert.equal(extractLineupSnapshot(summary, { ...brObs, league:'conmebol.libertadores' }), null);
let lineupMatch = { eventId:brObs.eventId, league:'bra.1', competitionKey:'brasileirao', competitionName:'Brasileirão', kickoff, home:brObs.home, away:brObs.away };
let lineupStep = applyLineupObservation(lineupMatch, lineup, brObs, 2_000_000);
assert.equal(lineupStep.emitted.length, 0);
lineupStep = applyLineupObservation(lineupStep.match, lineup, brObs, 2_020_001);
assert.equal(lineupStep.emitted.length, 1);
assert.equal(lineupStep.emitted[0].type, 'lineup_confirmed');
assert.equal(applyLineupObservation(lineupStep.match, lineup, brObs, 2_040_001).emitted.length, 0, 'escalação não pode duplicar');

const ai = aiResolverRequest(game, 't10');
assert.equal(ai.model, 'gpt-5.6-sol');
assert.ok(ai.tools.some((tool) => tool.type === 'web_search'));
assert.match(ai.input[0].content, /Não invente IDs/);

console.log('readiness-guardian: PASS');
