import assert from 'node:assert/strict';
import {
  applyObservation, initialMatchState, guardScoreRollback,
  SPORTS_ENGINE_CONSTANTS
} from '../src/sports-engine.js';

const t0 = Date.parse('2026-10-14T22:00:00Z');
const base = {
  eventId: 'fdg-conmebol-atletico-torque-20261014', league: 'conmebol.sudamericana',
  competitionKey: 'sul_americana', competitionName: 'CONMEBOL Sul-Americana',
  kickoff: '2026-10-14T22:00:00Z', state: 'in', completed: false,
  clock: "34'", period: 1,
  home: { id: '7632', name: 'Atlético-MG', score: 0 },
  away: { id: 'mct', name: 'Montevideo City Torque', score: 0 }
};
const obs = (h, a, clock = "38'") => ({
  ...structuredClone(base), home: { ...base.home, score: h },
  away: { ...base.away, score: a }, clock
});
const reiner = { key: 'g-reiner', teamId: '7632', side: 'home',
  athleteId: 'r19', athleteName: 'Reiner', minute: "37'", homeScoreAfter: 1,
  awayScoreAfter: 0, shootout: false, order: 3700 };
const bernard = { key: 'g-bernard', teamId: '7632', side: 'home',
  athleteId: 'b11', athleteName: 'Bernard', minute: "42'", homeScoreAfter: 2,
  awayScoreAfter: 0, shootout: false, order: 4200 };

function advance(state, observation, plays, offset) {
  return applyObservation(state, observation, plays, t0 + offset);
}

// Atlético-MG 0-0 -> 1-0 -> two stale zero snapshots -> 2-0.
// The stale snapshots must not emit a false VAR or erase Reiner; both legitimate
// goals must be emitted precisely once, even with ESPN source oscillation.
let state = advance(initialMatchState(obs(0, 0)), obs(0, 0), [], 0).match;
for (const offset of [5_000, 15_000]) state = advance(state, obs(1, 0), [reiner], offset).match;
let step = advance(state, obs(1, 0), [reiner], 26_000);
state = step.match;
assert.deepEqual(step.emitted.filter(e => e.type === 'goal').map(e => e.athlete.name), ['Reiner']);
for (const offset of [37_000, 47_000]) {
  step = advance(state, obs(0, 0, "40'"), [], offset);
  state = step.match;
  assert.equal(state.home.score, 1, 'transient regression cannot erase validated scoreboard');
  assert.equal(step.emitted.length, 0, 'no false VAR from stale ESPN snapshot');
  assert.ok(state.scoreRollback, 'rollback candidate is observable');
}
step = advance(state, obs(2, 0, "42'"), [reiner, bernard], 53_000);
state = step.match;
assert.equal(state.scoreRollback, null, 'new official score invalidates old rollback candidate');
assert.equal(state.home.score, 2);
assert.equal(step.emitted.filter(e => e.type === 'goal_overturned').length, 0);
for (const offset of [63_000, 79_000]) {
  step = advance(state, obs(2, 0, "44'"), [reiner, bernard], offset);
  state = step.match;
}
assert.deepEqual(step.emitted.filter(e => e.type === 'goal').map(e => e.athlete.name), ['Bernard']);
step = advance(state, obs(2, 0, "45'"), [reiner, bernard], 90_000);
assert.equal(step.emitted.length, 0, 'must not re-notify either goal');
assert.equal(Object.values(step.match.plays).filter(p => p.status === 'confirmed').length, 2);

// A real persistent correction can still be announced, but only after the
// candidate survives 90 seconds, four observations and two missing samples.
let corrected = advance(initialMatchState(obs(0, 0)), obs(0, 0), [], 0).match;
for (const offset of [5_000, 15_000, 26_000]) corrected = advance(corrected, obs(1, 0), [reiner], offset).match;
for (const offset of [40_000, 50_000, 60_000, 120_000]) {
  step = advance(corrected, obs(0, 0), [], offset);
  corrected = step.match;
  assert.equal(step.emitted.filter(e => e.type === 'goal_overturned').length, 0);
}
step = advance(corrected, obs(0, 0), [], 140_000);
corrected = step.match;
assert.equal(step.emitted.filter(e => e.type === 'goal_overturned').length, 0);
step = advance(corrected, obs(0, 0), [], 150_000);
assert.equal(step.emitted.filter(e => e.type === 'goal_overturned').length, 1,
  'persistent rollback must eventually notify correction of a previously announced goal');
assert.equal(step.match.home.score, 0);

// An unannounced (pending) goal cannot produce a standalone annulment push.
let pending = advance(initialMatchState(obs(0, 0)), obs(0, 0), [], 0).match;
pending = advance(pending, obs(1, 0), [reiner], 5_000).match;
for (const offset of [10_000, 20_000, 30_000, 100_000, 110_000, 120_000]) {
  step = advance(pending, obs(0, 0), [], offset);
  pending = step.match;
  assert.equal(step.emitted.filter(e => ['goal','goal_overturned'].includes(e.type)).length, 0);
}
assert.equal(Object.values(pending.plays).some(p => p.status === 'overturned'), true);

// 5-minute delayed but genuine live goal must be delivered instead of suppressed.
let delayed = advance(initialMatchState(obs(0, 0)), obs(0, 0), [], 0).match;
delayed = advance(delayed, obs(1, 0), [reiner], 5_000).match;
step = advance(delayed, obs(1, 0), [reiner], 5 * 60_000);
assert.equal(step.emitted.filter(e => e.type === 'goal').length, 1);
assert.equal(step.match.plays['g-reiner'].lateSuppressedAt || 0, 0);

// Long-expired historical state remains silent to avoid mass retrospective pushes.
let old = advance(initialMatchState(obs(0, 0)), obs(0, 0), [], 0).match;
old = advance(old, obs(1, 0), [reiner], 5_000).match;
step = advance(old, obs(1, 0), [reiner], 13 * 60_000);
assert.equal(step.emitted.filter(e => e.type === 'goal').length, 0);
assert.ok(step.match.plays['g-reiner'].lateSuppressedAt);

assert.equal(SPORTS_ENGINE_CONSTANTS.ROLLBACK_MIN_CONFIRM_MS, 90_000);
assert.equal(SPORTS_ENGINE_CONSTANTS.ROLLBACK_MIN_OBSERVATIONS, 4);
assert.equal(SPORTS_ENGINE_CONSTANTS.GOAL_LATE_SUPPRESS_MS, 12 * 60_000);
assert.equal(guardScoreRollback({initialized:true,home:{score:1},away:{score:0}},obs(0,0),t0).held,true);
console.log('R10R17.3 live goal event integrity: PASS');
