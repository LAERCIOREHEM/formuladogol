import assert from 'node:assert/strict';
import { aiGatewayId, gatewayBase, aiGatewayAuthHeaders, aiGatewayAuthConfigured, geminiConfigured, geminiGroundingSources, geminiSearchCount, isAiGatewayPreProviderFailure, fetchOpenAiResponses, publicSchemaInstruction } from '../src/ai-router.js';
import { POSTGAME_SEARCH_PROFILE_VERSION, TEAM_SEARCH_PROFILES, buildAttendanceSearchQueries, officialClubDomainsForTask, attendanceSourceQuality } from '../src/postgame-search-profile.js';

assert.equal(aiGatewayId({}), 'default');
assert.equal(gatewayBase({AI_GATEWAY_ACCOUNT_ID:'abc',AI_GATEWAY_ID:'default'},'openai'),'https://gateway.ai.cloudflare.com/v1/abc/default/openai');
assert.equal(geminiConfigured({GEMINI_API_KEY:'x'}),true);
assert.equal(aiGatewayAuthConfigured({AI_GATEWAY_TOKEN:'tok'}),true);
assert.equal(aiGatewayAuthHeaders({AI_GATEWAY_TOKEN:'tok'})['cf-aig-authorization'],'Bearer tok');
assert.equal(isAiGatewayPreProviderFailure(401,'{"name":"AiGatewayError","internalCode":2009}'),true);
assert.equal(isAiGatewayPreProviderFailure(401,'{"error":"invalid_api_key"}'),false);
assert.equal(isAiGatewayPreProviderFailure(403,'error code: 1010'),true);

const raw={candidates:[{groundingMetadata:{webSearchQueries:['q1','q2'],groundingChunks:[{web:{uri:'https://example.com/a'}},{web:{uri:'https://example.com/b'}}]}}]};
assert.equal(geminiSearchCount(raw),2);
assert.deepEqual(geminiGroundingSources(raw),['https://example.com/a','https://example.com/b']);

// Hunter v7: o confronto real que motivou o hotfix precisa gerar consultas com
// nomes alternativos, fontes direcionadas e domínios oficiais dos participantes.
const hunterTask={event_id:'401841168',home:'Atlético-MG',away:'Bragantino',kickoff:'2026-10-03T21:30:00.000Z',home_score:1,away_score:0,round:21,stadium:'Arena MRV'};
const hunterQueries=buildAttendanceSearchQueries(hunterTask);
assert.equal(POSTGAME_SEARCH_PROFILE_VERSION,7);
assert.equal(Object.keys(TEAM_SEARCH_PROFILES).length,20);
for (const [club,profile] of Object.entries(TEAM_SEARCH_PROFILES)) {
  assert.ok(profile.aliases.length >= 1, `${club}: aliases ausentes`);
  assert.ok(profile.officialDomains.length >= 1, `${club}: domínio oficial ausente`);
}
assert.ok(hunterQueries.some((q)=>q.includes('Red Bull Bragantino')));
assert.ok(hunterQueries.some((q)=>q.includes('Galo')));
assert.ok(hunterQueries.some((q)=>q.includes('Atlético Mineiro')));
assert.ok(hunterQueries.some((q)=>q.includes('site:uol.com.br')));
assert.ok(hunterQueries.some((q)=>q.includes('site:atletico.com.br')));
assert.ok(hunterQueries.some((q)=>q.includes('site:redbullbragantino.com.br')));
assert.deepEqual(officialClubDomainsForTask(hunterTask),['atletico.com.br','redbullbragantino.com.br']);
assert.equal(attendanceSourceQuality('https://atletico.com.br/noticias/x',hunterTask),'club_official');
assert.equal(attendanceSourceQuality('https://atletico.com.br/noticias/x',{home:'Flamengo',away:'Santos'}),'unverified');
const prompt=publicSchemaInstruction(hunterTask,['público presente','renda']);
assert.match(prompt,/Red Bull Bragantino/);
assert.match(prompt,/site:uol\.com\.br/);
assert.match(prompt,/atletico\.com\.br/);
assert.doesNotMatch(prompt,/NÃO use sites oficiais de clubes/);

const originalFetch=globalThis.fetch;
try {
  const calls=[];
  globalThis.fetch=async (url,opts={})=>{
    calls.push({url:String(url),headers:opts.headers||{}});
    if(calls.length===1){
      return new Response(JSON.stringify({success:false,error:[{code:2009,message:'Unauthorized'}],name:'AiGatewayError',internalCode:2009}),{status:401,headers:{'content-type':'application/json'}});
    }
    return new Response(JSON.stringify({id:'resp_test',usage:{input_tokens:1,output_tokens:1,total_tokens:2}}),{status:200,headers:{'content-type':'application/json'}});
  };
  const routed=await fetchOpenAiResponses({AI_GATEWAY_ACCOUNT_ID:'abc',AI_GATEWAY_ID:'default',AI_GATEWAY_TOKEN:'cf-token',OPENAI_API_KEY:'sk-test'},{model:'gpt-test',input:'x'});
  assert.equal(routed.route,'direct_fallback_gateway_preprovider');
  assert.equal(routed.gatewayFallback,true);
  assert.equal(calls.length,2);
  assert.equal(calls[0].headers['cf-aig-authorization'],'Bearer cf-token');
  assert.equal(calls[0].headers.authorization,'Bearer sk-test');
  assert.equal(calls[1].headers['cf-aig-authorization'],undefined);
  assert.equal(calls[1].headers.authorization,'Bearer sk-test');
} finally {
  globalThis.fetch=originalFetch;
}

console.log('ai-router tests: PASS');
