import assert from 'node:assert/strict';
import {
  applyObservation,
  extractScoringPlays,
  initialMatchState,
  needsSummary,
  normalizeScoreboardEvent,
  SPORTS_ENGINE_CONSTANTS
} from '../src/sports-engine.js';
import { selectAgendaCandidates } from '../src/sports-monitor.js';

const t0 = Date.parse('2026-09-01T23:55:00Z');
const game = {
  eventId: '401909112', league: 'bra.copa_do_brazil', competitionKey: 'copa_do_brasil', competitionName: 'Copa do Brasil',
  kickoff: '2026-09-01T21:00:00-03:00',
  home: { id: '7632', name: 'Atlético-MG' }, away: { id: '2022', name: 'Cruzeiro' }
};

function rawScore(home, away, clock = "38'", state = 'in') {
  return {
    id: game.eventId, date: game.kickoff,
    status: { type: { state, completed: state === 'post', shortDetail: clock }, displayClock: clock, period: 2 },
    competitions: [{ competitors: [
      { homeAway: 'home', score: String(home), team: { id: game.home.id, displayName: game.home.name } },
      { homeAway: 'away', score: String(away), team: { id: game.away.id, displayName: game.away.name } }
    ] }]
  };
}

function summary(...plays) {
  return {
    rosters: [
      { roster: [{ athlete: { id: 'p1', displayName: 'João Pedro da Silva' } }, { athlete: { id: 'p2', displayName: 'Carlos Souza Junior' } }] },
      { roster: [{ athlete: { id: 'p3', displayName: 'Lucas Lima' } }] }
    ],
    scoringPlays: plays
  };
}

function goal(id, teamId, athleteId, minute, homeScore, awayScore, description = 'Goal') {
  return {
    id, scoringPlay: true, team: { id: teamId }, athletesInvolved: [{ id: athleteId }],
    clock: { displayValue: minute }, homeScore, awayScore, text: description, type: { text: description }
  };
}

const obs22 = normalizeScoreboardEvent(rawScore(1, 0, "22'"), game.league, game);
let state = initialMatchState(obs22);
assert.equal(needsSummary(state, obs22), true);
let plays = extractScoringPlays(summary(goal('g1', '7632', 'p1', "12'", 1, 0)), obs22);
let step = applyObservation(state, obs22, plays, t0);
state = step.match;
assert.equal(step.emitted.length, 0, 'gol anterior ao monitor vira baseline');
assert.equal(state.baselineComplete, true);
assert.equal(state.plays[`${game.eventId}:g1`].status, 'baseline');

const obs38 = normalizeScoreboardEvent(rawScore(2, 0, "38'"), game.league, game);
assert.equal(needsSummary(state, obs38), true);
plays = extractScoringPlays(summary(
  goal('g1', '7632', 'p1', "12'", 1, 0),
  goal('g2', '7632', 'p2', "37'", 2, 0, 'Penalty Goal')
), obs38);
step = applyObservation(state, obs38, plays, t0 + 5_000);
state = step.match;
assert.equal(step.emitted.length, 0);
assert.equal(state.plays[`${game.eventId}:g2`].status, 'pending');
assert.equal(state.plays[`${game.eventId}:g2`].penalty, true);

step = applyObservation(state, obs38, plays, t0 + 35_000);
state = step.match;
assert.equal(step.emitted.length, 0, '30 s ainda não confirma');
step = applyObservation(state, obs38, plays, t0 + 66_000);
state = step.match;
assert.equal(step.emitted.length, 1, 'gol estável confirma após janela anti-VAR');
assert.equal(step.emitted[0].type, 'goal');
assert.equal(step.emitted[0].athlete.name, 'Carlos Souza');
assert.equal(step.emitted[0].penalty, true);
assert.equal(step.emitted[0].scoreAfter.home, 2);
assert.match(step.emitted[0].notificationDraft.title, /ATLÉTICO-MG/);

step = applyObservation(state, obs38, plays, t0 + 96_000);
state = step.match;
assert.equal(step.emitted.length, 0, 'não duplica gol confirmado');

const reverted = normalizeScoreboardEvent(rawScore(1, 0, "40'"), game.league, game);
const revertedPlays = extractScoringPlays(summary(goal('g1', '7632', 'p1', "12'", 1, 0)), reverted);
step = applyObservation(state, reverted, revertedPlays, t0 + 126_000);
state = step.match;
assert.equal(step.emitted.length, 0, 'primeira evidência de reversão não dispara correção');
step = applyObservation(state, reverted, revertedPlays, t0 + 156_000);
state = step.match;
assert.equal(step.emitted.length, 1, 'segunda evidência confirma gol anulado');
assert.equal(step.emitted[0].type, 'goal_overturned');

// Dois gols entre polls: ambos são preservados como eventos independentes.
const zero = normalizeScoreboardEvent(rawScore(0, 0, "5'"), game.league, game);
let doubleState = applyObservation(initialMatchState(zero), zero, null, t0).match;
const two = normalizeScoreboardEvent(rawScore(1, 1, "20'"), game.league, game);
const twoPlays = extractScoringPlays(summary(
  goal('d1', '7632', 'p1', "11'", 1, 0),
  goal('d2', '2022', 'p3', "19'", 1, 1)
), two);
doubleState = applyObservation(doubleState, two, twoPlays, t0 + 10_000).match;
doubleState = applyObservation(doubleState, two, twoPlays, t0 + 40_000).match;
const doubleConfirmed = applyObservation(doubleState, two, twoPlays, t0 + 71_000);
assert.equal(doubleConfirmed.emitted.filter((e) => e.type === 'goal').length, 2);
assert.deepEqual(doubleConfirmed.emitted.map((e) => [e.scoreAfter.home, e.scoreAfter.away]), [[1,0],[1,1]]);

// Gol contra e disputa de pênaltis são classificados separadamente.
const special = extractScoringPlays(summary(
  goal('og', '2022', 'p1', "50'", 1, 1, 'Own Goal'),
  { ...goal('sho', '2022', 'p3', "PEN", 1, 1, 'Penalty Shootout'), penaltyShootout: true }
), two);
assert.equal(special.find((p) => p.sourceId === 'og').ownGoal, true);
assert.equal(special.find((p) => p.sourceId === 'sho').shootout, true);

// Agenda: inclui apenas janela operacional e ligas autorizadas.
const agenda = { jogos: [
  { event_id: game.eventId, espn_league: game.league, data_iso: game.kickoff, competicao_chave: 'copa_do_brasil', mandante: { espn_id: '7632', nome: 'Atlético-MG' }, visitante: { espn_id: '2022', nome: 'Cruzeiro' } },
  { event_id: 'far', espn_league: 'bra.1', data_iso: '2026-09-10T20:00:00-03:00', mandante: {}, visitante: {} },
  { event_id: 'bad', espn_league: 'eng.1', data_iso: game.kickoff, mandante: {}, visitante: {} }
] };
assert.deepEqual(selectAgendaCandidates(agenda, Date.parse('2026-09-01T23:50:00Z')).map((x) => x.eventId), [game.eventId]);
assert.equal(SPORTS_ENGINE_CONSTANTS.GOAL_CONFIRM_MS, 45_000);

// ESPN às vezes publica state=post sem completed; relógio ao vivo não pode virar final fantasma.
const phantom = rawScore(0, 0, "22'", 'post');
phantom.status.type.completed = false;
const phantomObs = normalizeScoreboardEvent(phantom, game.league, game);
assert.equal(phantomObs.state, 'in');

console.log('sports-engine: PASS');
