import assert from 'node:assert/strict';
import { normalizeLiveFacts, chooseBestKnownLiveFacts, LIVE_FACTS_CONSTANTS } from '../src/live-facts.js';
function summary(eventId,home,away,homeScore,awayScore,goal){return{header:{id:eventId,competitions:[{competitors:[{homeAway:'home',score:String(homeScore),team:home},{homeAway:'away',score:String(awayScore),team:away}]}]},scoringPlays:[goal]};}
const flu={id:'3445',displayName:'Fluminense'},cor={id:'874',displayName:'Corinthians'};
const h=normalizeLiveFacts(summary('hulk',flu,cor,1,0,{id:'g1',scoringPlay:true,teamId:'3445',homeScore:1,awayScore:0,clock:{displayValue:"23'"},athletesInvolved:[{id:'hulk',displayName:'Hulk'},{id:'jk',displayName:'John Kennedy',type:{text:'assist'}}],text:'Goal! Hulk. Assisted by John Kennedy.'}),{eventId:'hulk',expectedGoals:1});
assert.equal(h.contractVersion,LIVE_FACTS_CONSTANTS.LIVE_FACTS_CONTRACT_VERSION); assert.equal(h.integrity.complete,true); assert.equal(h.goals[0].team,'Fluminense'); assert.equal(h.goals[0].scorer,'Hulk'); assert.deepEqual(h.goals[0].assists,['John Kennedy']);
const vit={id:'3456',displayName:'Vitória'},cru={id:'2022',displayName:'Cruzeiro'};
const r=normalizeLiveFacts(summary('rene',vit,cru,1,0,{id:'v1',scoringPlay:true,teamId:'3456',homeScore:1,awayScore:0,clock:{displayValue:"7'"},athletesInvolved:[{id:'rene',displayName:'Renê'}],text:'Gol! Renê.'}),{eventId:'rene',expectedGoals:1}); assert.equal(r.integrity.complete,true); assert.equal(r.goals[0].team,'Vitória'); assert.equal(r.goals[0].scorer,'Renê');
const incomplete=normalizeLiveFacts(summary('incomplete',flu,cor,1,0,{id:'x',scoringPlay:true,teamId:'3445',homeScore:1,awayScore:0,clock:{displayValue:"9'"},text:'Goal'}),{eventId:'incomplete',expectedGoals:1}); assert.equal(incomplete.integrity.scoreComplete,true); assert.equal(incomplete.integrity.identityComplete,false); assert.equal(incomplete.integrity.status,'identity-pending');
const regressed=structuredClone(incomplete); regressed.eventId=h.eventId; const chosen=chooseBestKnownLiveFacts(regressed,h); assert.equal(chosen.applied,true); assert.equal(chosen.facts.goals[0].scorer,'Hulk');
console.log('PASS live-facts v1');
