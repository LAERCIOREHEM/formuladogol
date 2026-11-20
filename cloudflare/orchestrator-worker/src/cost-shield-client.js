// CF-COST-SHIELD R2 — read-only governance view.
// The coordinator can be unreachable without stopping sport or FINAL.
export const COST_SHIELD_STATUS_URL='https://push.formuladogol.com.br/v1/cost-shield/status';
export const COST_SHIELD_CLIENT_VERSION=2;
const CACHE_MS=15_000;
let cached=null,cachedAt=0,testTransport=null;
export function setCostShieldTransportForTests(transport) {
  if(typeof transport!=='function')throw new TypeError('transport must be a function');
  testTransport=transport;cached=null;cachedAt=0;
}
export function clearShieldCacheForTest(){cached=null;cachedAt=0;}
const unavailable=reason=>({
  version:2,mode:'unverified',reason,halted:false,billingVerified:false,
  essentialSportsAllowed:true,optionalAllowed:true,secondaryAllowed:true,
  costUnverified:true
});
export function validateShieldStatus(value) {
  if(!value||value.version!==2||value.essentialSportsAllowed!==true||
    typeof value.optionalAllowed!=='boolean'||typeof value.secondaryAllowed!=='boolean'||
    typeof value.mode!=='string')
    throw new Error('invalid_cost_shield_status');
  return {version:2,mode:value.mode,reason:String(value.reason||''),
    halted:false,essentialSportsAllowed:true,optionalAllowed:value.optionalAllowed,
    secondaryAllowed:value.secondaryAllowed,costUnverified:value.costUnverified===true,
    billingVerified:value.billingVerified===true,
    lastSuccessAt:value.lastSuccessAt??null};
}
export async function checkCostShield(fetcher=fetch,now=Date.now()) {
  if(cached&&now-cachedAt>=0&&now-cachedAt<CACHE_MS)return cached;
  try{
    const response=await (testTransport||fetcher)(COST_SHIELD_STATUS_URL,{
      method:'GET',headers:{accept:'application/json'},
      cache:'no-store',signal:AbortSignal.timeout(2500)
    });
    if(!response.ok)throw new Error('coordinator_http_'+response.status);
    cached=validateShieldStatus(await response.json());
  }catch(error){
    // The orchestrator already caps GitHub dispatch frequency and respects
    // per-workflow idempotency. Never make live FINAL fail-closed.
    cached=unavailable('coordinator_unavailable');
  }
  cachedAt=now;
  return cached;
}
