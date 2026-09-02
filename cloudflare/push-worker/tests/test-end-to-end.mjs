import assert from 'node:assert/strict';
import { applyObservation, initialMatchState } from '../src/sports-engine.js';
import { buildSportsPushPayload } from '../src/push-dispatch.js';

const eventId = '401909112';
const base = {
  eventId,
  league: 'bra.copa_do_brazil',
  competitionKey: 'copa_do_brasil',
  competitionName: 'Copa do Brasil',
  kickoff: '2026-09-01T21:00:00-03:00',
  state: 'in', completed: false, clock: "10'", period: 1,
  home: { id: '7632', name: 'Atlético-MG', abbreviation: 'CAM', score: 0 },
  away: { id: '2022', name: 'Cruzeiro', abbreviation: 'CRU', score: 0 }
};
const t0 = Date.parse('2026-09-02T00:10:00Z');
let state = applyObservation(initialMatchState(base), base, null, t0).match;

const goalObs = structuredClone(base);
goalObs.clock = "14'";
goalObs.away.score = 1;
const play = {
  key: `${eventId}:g1`, sourceId: 'g1', teamId: '2022', side: 'away', athleteId: '10', athleteName: 'Kaio Jorge',
  minute: "13'", ownGoal: false, penalty: false, shootout: false, homeScoreAfter: 0, awayScoreAfter: 1
};

state = applyObservation(state, goalObs, [play], t0 + 5_000).match;
state = applyObservation(state, goalObs, [play], t0 + 15_000).match;
const confirmed = applyObservation(state, goalObs, [play], t0 + 26_000);
assert.equal(confirmed.emitted.length, 1);
const event = confirmed.emitted[0];
assert.equal(event.type, 'goal');
assert.equal(event.athlete.name, 'Kaio Jorge');
assert.equal(event.scoringTeam.name, 'Cruzeiro');

const push = buildSportsPushPayload(event);
assert.equal(push.title, '⚽ GOL DO CRUZEIRO!');
assert.match(push.body, /Kaio Jorge/);
assert.match(push.body, /Atlético-MG 0 × 1 Cruzeiro/);
assert.equal(push.data.url, `/aovivo.html?event=${eventId}`);
assert.equal(push.badgeIncrement, 1);

const next = applyObservation(confirmed.match, goalObs, [play], t0 + 36_000);
assert.equal(next.emitted.length, 0, 'poll repetido não pode duplicar o push');

// O feed detalhado pode oscilar ou trocar de origem após deploy. Sem rollback do placar, isso nunca é gol anulado.
let feedGap = applyObservation(next.match, goalObs, [], t0 + 46_000);
assert.equal(feedGap.emitted.length, 0);
feedGap = applyObservation(feedGap.match, goalObs, [], t0 + 56_000);
assert.equal(feedGap.emitted.length, 0, 'placar 0x1 mantido impede falso GOL ANULADO');
assert.equal(feedGap.match.plays[`${eventId}:g1`].status, 'confirmed');

const revertedObs = structuredClone(base);
revertedObs.clock = "16'";
let reverted = applyObservation(feedGap.match, revertedObs, [], t0 + 66_000);
assert.equal(reverted.emitted.length, 0);
reverted = applyObservation(reverted.match, revertedObs, [], t0 + 76_000);
assert.equal(reverted.emitted.length, 1);
assert.equal(reverted.emitted[0].type, 'goal_overturned');
const correction = buildSportsPushPayload(reverted.emitted[0]);
assert.equal(correction.title, '🚫 GOL ANULADO');
assert.equal(correction.tag, push.tag, 'a correção deve atualizar a mesma família de notificação');

console.log('end-to-end-synthetic: PASS');
