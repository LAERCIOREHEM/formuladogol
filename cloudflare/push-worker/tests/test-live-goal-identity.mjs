import assert from 'node:assert/strict';
import { resolveTrackedLiveGoalMatch, LIVE_GOAL_IDENTITY_VERSION } from '../src/live-goal-identity.js';
import { buildSportsMonitorLiveFacts } from '../src/monitor-live-facts.js';

const documentary = 'fdg-conmebol-sul-americana-202610132130-boca-juniors-vasco-da-gama';
const monitored = { eventId: documentary, league: 'conmebol.sudamericana', kickoff:'2026-10-14T00:30:00Z',
  state:'post',home:{id:'boca',name:'Boca Juniors',score:0},away:{id:'vas',name:'Vasco da Gama',score:1},
  plays: { 'goal-vas': { key:'goal-vas',side:'away',teamId:'vas',homeScoreAfter:0,awayScoreAfter:1,
    status:'confirmed',athleteName:'Atacante confirmado',athleteId:'11',minute:"54'",scoreFallback:false } } };
const matches = {[documentary]:monitored};
const watchlist = {[documentary]:{sourceEventId:'401915436'}};
assert.equal(LIVE_GOAL_IDENTITY_VERSION, 1);
assert.equal(resolveTrackedLiveGoalMatch(matches,watchlist,documentary,'conmebol.sudamericana')?.strategy,'agenda-id');
const alias=resolveTrackedLiveGoalMatch(matches,watchlist,'401915436','conmebol.sudamericana');
assert.equal(alias?.key,documentary);
assert.equal(alias?.strategy,'validated-espn-alias');
const facts=buildSportsMonitorLiveFacts(alias.match);
assert.equal(facts.goals.length,1);
assert.equal(facts.goals[0].scorer,'Atacante confirmado');
assert.equal(facts.goals[0].side,'away');
assert.equal(facts.integrity.scoreComplete,true);
assert.equal(resolveTrackedLiveGoalMatch(matches,watchlist,'401915436','bra.1'),null, 'liga errada: bloquear');
assert.equal(resolveTrackedLiveGoalMatch(matches,watchlist,'401915437','conmebol.sudamericana'),null);
assert.equal(resolveTrackedLiveGoalMatch(matches,watchlist,'fdg-outra-partida','conmebol.sudamericana'),null);
assert.equal(resolveTrackedLiveGoalMatch(matches,watchlist,'401915436','conmebol.libertadores'),null);
const collision = {...matches,'fdg-outra-partida':{...monitored,eventId:'fdg-outra-partida'}};
assert.equal(resolveTrackedLiveGoalMatch(collision,{...watchlist,'fdg-outra-partida':{sourceEventId:'401915436'}},'401915436','conmebol.sudamericana'),null,'alias duplicado é ambíguo');
assert.equal(resolveTrackedLiveGoalMatch({other:{...monitored,league:'bra.1'}},{other:{sourceEventId:'401915436'}},'401915436','conmebol.sudamericana'),null);
console.log('live-goal-identity R10R17.2: PASS');
