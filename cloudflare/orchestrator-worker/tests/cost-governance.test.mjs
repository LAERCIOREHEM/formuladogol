import assert from 'node:assert/strict';
import { orchestratorCostDecision } from '../src/cost-governance.js';
import {
  COST_SHIELD_CLIENT_VERSION, validateShieldStatus,
  checkCostShield, setCostShieldTransportForTests, clearShieldCacheForTest
} from '../src/cost-shield-client.js';

assert.equal(COST_SHIELD_CLIENT_VERSION,2);
const essential={optionalAllowed:false,secondaryAllowed:false,mode:'secondary_paused'};
for (const action of ['atualizar_brasileirao','refresh_continentais','editorial_rodada','deploy_editorial']) {
  assert.equal(orchestratorCostDecision(action,essential).allowed,true,action);
}
for (const action of ['transmissao_aovivo','transmissoes_tv']) {
  assert.equal(orchestratorCostDecision(action,essential).allowed,false,action);
  assert.equal(orchestratorCostDecision(action,{
    optionalAllowed:false,secondaryAllowed:true,mode:'optional_paused'
  }).allowed,true,action);
}
for (const action of ['publicos','melhores_momentos','transmissoes_guardian',
  'melhores_momentos_continentais','editorial_continentais']) {
  assert.equal(orchestratorCostDecision(action,{
    optionalAllowed:false,secondaryAllowed:true,mode:'optional_paused'
  }).allowed,false,action);
  assert.equal(orchestratorCostDecision(action,{
    optionalAllowed:true,secondaryAllowed:true,mode:'normal'
  }).allowed,true,action);
}
const status={
  version:2,mode:'unverified',reason:'billing_cycle_unavailable',
  halted:false,essentialSportsAllowed:true,optionalAllowed:true,
  secondaryAllowed:true,costUnverified:true,billingVerified:false
};
assert.equal(validateShieldStatus(status).essentialSportsAllowed,true);
assert.throws(()=>validateShieldStatus({...status,version:1}));
const timestamp=Date.parse('2026-11-19T22:00:00Z');
setCostShieldTransportForTests(async()=>Response.json(status));
let result=await checkCostShield(undefined,timestamp);
assert.equal(result.mode,'unverified');
assert.equal(result.halted,false);
clearShieldCacheForTest();
setCostShieldTransportForTests(async()=>{throw new Error('unreachable')});
result=await checkCostShield(undefined,timestamp);
assert.equal(result.mode,'unverified');
assert.equal(result.essentialSportsAllowed,true);
assert.equal(result.optionalAllowed,true);
clearShieldCacheForTest();
console.log('Orchestrator R2 sports-first governance verified');
