// CF-COST-SHIELD R1 — shared fail-closed consumer of the account-level latch.
// The coordinator is independent of application D1/R2 and must be deployed
// before activating this client in production.
export const COST_SHIELD_STATUS_URL =
  'https://push.formuladogol.com.br/v1/cost-shield/status';
export const COST_SHIELD_CLIENT_VERSION = 1;
const CACHE_MS=15_000;
let cached=null;
let cachedAt=0;
// Explicit injection is used solely by unit tests. Production entrypoints
// never call this; it is not reachable through an HTTP route.
let testTransport=null;
export function setCostShieldTransportForTests(transport){
  if(typeof transport!=='function')throw new TypeError('transport must be a function');
  testTransport=transport;cached=null;cachedAt=0;
}

export function validateShieldStatus(value) {
  if(!value||value.version!==1||typeof value.halted!=='boolean' ||
    typeof value.reason!=='string')
    throw new Error('invalid_cost_shield_status');
  return {halted:value.halted,reason:value.reason,version:1,
    lastSuccessAt:value.lastSuccessAt??null};
}

export async function checkCostShield(fetcher=fetch, now=Date.now()) {
  if(cached&&now-cachedAt>=0&&now-cachedAt<CACHE_MS)return cached;
  try{
    const response=await (testTransport||fetcher)(COST_SHIELD_STATUS_URL,{
      method:'GET',headers:{accept:'application/json'},
      cache:'no-store',signal:AbortSignal.timeout(2500)
    });
    if(!response.ok)throw new Error('coordinator_http_'+response.status);
    const status=validateShieldStatus(await response.json());
    // The coordinator itself enforces billing freshness and persistently
    // latches a stop; never silently treat an unavailable response as green.
    cached=status;cachedAt=now;
    return status;
  }catch(error){
    // Do not permit unbounded work while the account governor is inaccessible.
    cached={version:1,halted:true,reason:'coordinator_unavailable'};
    cachedAt=now;
    return cached;
  }
}

export function shieldStoppedResponse(status) {
  return new Response(JSON.stringify({
    ok:false,error:'cost_shield_halted',reason:status.reason
  }),{status:503,headers:{'content-type':'application/json',
    'cache-control':'no-store','retry-after':'3600'}});
}

export function clearShieldCacheForTest(){cached=null;cachedAt=0;}
