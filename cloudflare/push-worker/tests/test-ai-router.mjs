import assert from 'node:assert/strict';
import { aiGatewayId, gatewayBase, aiGatewayAuthHeaders, aiGatewayAuthConfigured, geminiConfigured, geminiGroundingSources, geminiSearchCount, geminiInteractionSearchCount, geminiInteractionSources, geminiInteractionText, geminiInteractionRequest, searchPublicWithGemini, isAiGatewayPreProviderFailure, fetchOpenAiResponses, publicSchemaInstruction } from '../src/ai-router.js';
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



// Hunter v8: a Interactions API precisa expor busca real e URLs utilizáveis.
const interactionRaw={
  status:'completed',
  steps:[
    {type:'google_search_call',id:'search_1',arguments:{query:'Atlético-MG Red Bull Bragantino público renda'}},
    {type:'google_search_result',call_id:'search_1',result:[{title:'Ficha',url:'https://www.uol.com.br/esporte/ficha.htm',snippet:'PÚBLICO 22.159'}]},
    {type:'model_output',content:[{type:'text',text:'{"encontrado":true,"publico":22159,"publico_pagante":null,"renda":1002775.79,"fonte_publico":"https://www.uol.com.br/esporte/ficha.htm","fonte_publico_pagante":null,"fonte_renda":"https://www.uol.com.br/esporte/ficha.htm","confianca":1,"observacao":"ficha"}',annotations:[{type:'url_citation',uri:'https://www.uol.com.br/esporte/ficha.htm'}]}]},
  ],
  usage:{total_input_tokens:100,total_output_tokens:50,total_tokens:150,grounding_tool_count:[{type:'google_search',count:1}]}
};
assert.equal(geminiInteractionSearchCount(interactionRaw),1);
assert.deepEqual(geminiInteractionSources(interactionRaw),['https://www.uol.com.br/esporte/ficha.htm']);
assert.match(geminiInteractionText(interactionRaw),/22159/);
// Compatibilidade defensiva com o schema anterior `outputs`, caso um gateway
// ainda transcodifique a resposta da Interactions API dessa forma.
const interactionLegacy={outputs:[
  {type:'google_search_call',id:'gs_old',arguments:{queries:['q']}},
  {type:'google_search_result',call_id:'gs_old',result:[{url:'https://www.estadao.com.br/esportes/futebol/ficha'}]},
  {type:'text',text:'{"encontrado":false}',annotations:[{source:'https://www.estadao.com.br/esportes/futebol/ficha'}]}
]};
assert.equal(geminiInteractionSearchCount(interactionLegacy),1);
assert.deepEqual(geminiInteractionSources(interactionLegacy),['https://www.estadao.com.br/esportes/futebol/ficha']);
assert.match(geminiInteractionText(interactionLegacy),/encontrado/);
const interactionRequest=geminiInteractionRequest(hunterTask,['público presente','renda']);
assert.equal(interactionRequest.tools[0].type,'google_search');
assert.equal(interactionRequest.generation_config.tool_choice,'any');
assert.equal(interactionRequest.response_format.mime_type,'application/json');

// Se o AI Gateway responder 200 porém SEM google_search_call/fontes, o v8
// precisa repetir DIRETO no Google e retornar as fontes do retry.
{
  const previousFetch=globalThis.fetch;
  const calls=[];
  try{
    globalThis.fetch=async (url,opts={})=>{
      calls.push({url:String(url),body:JSON.parse(String(opts.body||'{}'))});
      if(calls.length===1){
        return new Response(JSON.stringify({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:'{"encontrado":false,"publico":null,"publico_pagante":null,"renda":null,"fonte_publico":null,"fonte_publico_pagante":null,"fonte_renda":null,"confianca":0,"observacao":"sem busca"}'}]}],usage:{total_input_tokens:10,total_output_tokens:10,total_tokens:20}}),{status:200,headers:{'content-type':'application/json'}});
      }
      return new Response(JSON.stringify(interactionRaw),{status:200,headers:{'content-type':'application/json'}});
    };
    const forced=await searchPublicWithGemini({AI_GATEWAY_ACCOUNT_ID:'abc',AI_GATEWAY_ID:'default',AI_GATEWAY_TOKEN:'cf',GEMINI_API_KEY:'gem-test'},hunterTask,['público presente','renda']);
    assert.equal(forced.forcedSearch,true);
    assert.equal(forced.searchCalls,1);
    assert.equal(forced.apiCalls,2);
    assert.equal(forced.found,true);
    assert.ok(forced.sources.includes('https://www.uol.com.br/esporte/ficha.htm'));
    assert.match(forced.route,/ai_gateway_interactions/);
    assert.match(forced.route,/direct_fallback_gateway_no_grounding/);
    assert.ok(calls[0].url.includes('/google-ai-studio/v1beta/interactions'));
    assert.equal(calls[0].body.generation_config.tool_choice,'any');
    assert.equal(calls[1].url,'https://generativelanguage.googleapis.com/v1beta/interactions');
  } finally { globalThis.fetch=previousFetch; }
}
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
