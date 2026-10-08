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

// Search profile v8: aliases/fontes continuam amplos na descoberta, enquanto o gate de identidade valida a fonte.
// O confronto real que motivou os hotfixes de busca precisa gerar consultas com
// nomes alternativos, fontes direcionadas e domínios oficiais dos participantes.
const hunterTask={event_id:'401841168',home:'Atlético-MG',away:'Bragantino',kickoff:'2026-10-03T21:30:00.000Z',home_score:1,away_score:0,round:21,stadium:'Arena MRV'};
const hunterQueries=buildAttendanceSearchQueries(hunterTask);
assert.equal(POSTGAME_SEARCH_PROFILE_VERSION,8);
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
assert.match(prompt,/NÃO são autoridade de gravação/);
assert.match(prompt,/Match Identity Gate/);



// Hunter v11 preserva a busca observável: Interactions direto precisa expor URLs utilizáveis.
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
assert.equal(interactionRequest.response_format,undefined);
assert.deepEqual(interactionRequest.tools,[{type:'google_search'}]);
assert.equal(interactionRequest.generation_config.tool_choice,'any');
assert.equal(interactionRequest.generation_config.max_output_tokens,600);
assert.equal('search_types' in interactionRequest.tools[0],false);

// R10R8: Interactions vai DIRETO ao Google. Se não houver busca real/fontes,
// o fallback generateContent direto usa google_search com payload sem sampling legado.
{
  const previousFetch=globalThis.fetch;
  const calls=[];
  const legacyRaw={
    candidates:[{
      content:{parts:[{text:'{"encontrado":true,"publico":22159,"publico_pagante":null,"renda":1002775.79,"fonte_publico":"https://www.uol.com.br/esporte/ficha.htm","fonte_publico_pagante":null,"fonte_renda":"https://www.uol.com.br/esporte/ficha.htm","confianca":1,"observacao":"ficha"}'}]},
      groundingMetadata:{webSearchQueries:['Atlético-MG Red Bull Bragantino público renda'],groundingChunks:[{web:{uri:'https://www.uol.com.br/esporte/ficha.htm'}}]}
    }],
    usageMetadata:{promptTokenCount:10,candidatesTokenCount:10,totalTokenCount:20}
  };
  try{
    globalThis.fetch=async (url,opts={})=>{
      calls.push({url:String(url),body:JSON.parse(String(opts.body||'{}'))});
      if(calls.length===1){
        return new Response(JSON.stringify({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:'{"encontrado":false,"publico":null,"publico_pagante":null,"renda":null,"fonte_publico":null,"fonte_publico_pagante":null,"fonte_renda":null,"confianca":0,"observacao":"sem busca"}'}]}],usage:{total_input_tokens:10,total_output_tokens:10,total_tokens:20}}),{status:200,headers:{'content-type':'application/json'}});
      }
      return new Response(JSON.stringify(legacyRaw),{status:200,headers:{'content-type':'application/json'}});
    };
    const routed=await searchPublicWithGemini({AI_GATEWAY_ACCOUNT_ID:'abc',AI_GATEWAY_ID:'default',AI_GATEWAY_TOKEN:'cf',GEMINI_API_KEY:'gem-test'},hunterTask,['público presente','renda']);
    assert.equal(routed.searchObserved,true);
    assert.equal(routed.searchCalls,1);
    assert.equal(routed.apiCalls,2);
    assert.equal(routed.found,true);
    assert.ok(routed.sources.includes('https://www.uol.com.br/esporte/ficha.htm'));
    assert.equal(routed.route,'direct_interactions_v10_discovery -> direct_generateContent_grounding_v10_discovery');
    assert.equal(calls[0].url,'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(calls[0].body.generation_config.tool_choice,'any');
    assert.equal(calls[0].body.response_format,undefined);
    assert.deepEqual(calls[0].body.tools,[{type:'google_search'}]);
    assert.ok(calls[1].url.includes(':generateContent'));
    assert.equal(calls[1].body.generationConfig.temperature,undefined);
    assert.equal(calls[1].body.generationConfig.responseSchema,undefined);
    assert.equal(calls[1].body.generationConfig.responseMimeType,undefined);
    assert.deepEqual(calls[1].body.tools,[{google_search:{}}]);
  } finally { globalThis.fetch=previousFetch; }
}

// R10R9: sucesso de descoberta NÃO depende de JSON estruturado. Texto livre +
// google_search_call + URL citada já é uma busca útil para o source recovery.
{
  const previousFetch=globalThis.fetch;
  try{
    globalThis.fetch=async ()=>new Response(JSON.stringify({
      status:'completed',
      steps:[
        {type:'google_search_call',arguments:{queries:['Atlético-MG Bragantino público renda']}},
        {type:'model_output',content:[{type:'text',text:'Encontrei a ficha técnica no UOL.',annotations:[{type:'url_citation',url:'https://www.uol.com.br/esporte/ficha-real.htm'}]}]}
      ],
      usage:{total_input_tokens:12,total_output_tokens:8,total_tokens:20}
    }),{status:200,headers:{'content-type':'application/json'}});
    const discovered=await searchPublicWithGemini({GEMINI_API_KEY:'gem-test'},hunterTask,['público presente','renda']);
    assert.equal(discovered.searchObserved,true);
    assert.equal(discovered.searchCalls,1);
    assert.equal(discovered.apiCalls,1);
    assert.equal(discovered.found,false);
    assert.equal(discovered.reason,'gemini_sources_discovered');
    assert.deepEqual(discovered.sources,['https://www.uol.com.br/esporte/ficha-real.htm']);
  } finally { globalThis.fetch=previousFetch; }
}

// Se os dois endpoints Gemini forem rejeitados, o motivo precisa carregar o
// HTTP real para a telemetria e permitir que o Fastlane acione OpenAI no ciclo.
{
  const previousFetch=globalThis.fetch;
  try{
    globalThis.fetch=async ()=>new Response(JSON.stringify({error:{code:400,message:'Invalid request payload'}}),{status:400,headers:{'content-type':'application/json'}});
    const failed=await searchPublicWithGemini({GEMINI_API_KEY:'gem-test'},hunterTask,['público presente','renda']);
    assert.equal(failed.searchCalls,0);
    assert.equal(failed.apiCalls,2);
    assert.match(failed.reason,/gemini_no_real_search:http_400:/);
    assert.equal(failed.attempts.length,2);
    assert.match(failed.attempts[1].error,/Invalid request payload/);
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

// Gateway 400 por incompatibilidade/proxy também deve repetir DIRETO no OpenAI.
{
  const previousFetch=globalThis.fetch;
  const calls=[];
  try {
    globalThis.fetch=async (url,opts={})=>{
      calls.push(String(url));
      if(calls.length===1) return new Response('{"error":{"message":"unsupported field at gateway"}}',{status:400});
      return new Response(JSON.stringify({id:'resp_direct',usage:{input_tokens:1,output_tokens:1,total_tokens:2}}),{status:200,headers:{'content-type':'application/json'}});
    };
    const routed=await fetchOpenAiResponses({AI_GATEWAY_ACCOUNT_ID:'abc',AI_GATEWAY_ID:'default',OPENAI_API_KEY:'sk-test'},{model:'gpt-test',input:'x'});
    assert.equal(routed.route,'direct_fallback_gateway_error');
    assert.equal(routed.apiCalls,2);
    assert.equal(calls[1],'https://api.openai.com/v1/responses');
  } finally { globalThis.fetch=previousFetch; }
}

// Gateway 429 também tenta direto: pode ser limite do próprio Gateway; se for
// rate limit do provedor, a resposta direta continuará 429 sem aceitar dado falso.
{
  const previousFetch=globalThis.fetch;
  const calls=[];
  try {
    globalThis.fetch=async (url,opts={})=>{
      calls.push(String(url));
      if(calls.length===1) return new Response('{"error":{"message":"gateway rate limit"}}',{status:429});
      return new Response(JSON.stringify({id:'resp_direct_429',usage:{input_tokens:1,output_tokens:1,total_tokens:2}}),{status:200,headers:{'content-type':'application/json'}});
    };
    const routed=await fetchOpenAiResponses({AI_GATEWAY_ACCOUNT_ID:'abc',AI_GATEWAY_ID:'default',OPENAI_API_KEY:'sk-test'},{model:'gpt-test',input:'x'});
    assert.equal(routed.route,'direct_fallback_gateway_error');
    assert.equal(routed.apiCalls,2);
    assert.equal(calls[1],'https://api.openai.com/v1/responses');
  } finally { globalThis.fetch=previousFetch; }
}

// Erro de rede no Gateway também cai diretamente no endpoint oficial.
{
  const previousFetch=globalThis.fetch;
  const calls=[];
  try {
    globalThis.fetch=async (url,opts={})=>{
      calls.push(String(url));
      if(calls.length===1) throw new Error('gateway transport failed');
      return new Response(JSON.stringify({id:'resp_direct_network',usage:{input_tokens:1,output_tokens:1,total_tokens:2}}),{status:200,headers:{'content-type':'application/json'}});
    };
    const routed=await fetchOpenAiResponses({AI_GATEWAY_ACCOUNT_ID:'abc',AI_GATEWAY_ID:'default',OPENAI_API_KEY:'sk-test'},{model:'gpt-test',input:'x'});
    assert.equal(routed.route,'direct_fallback_gateway_network');
    assert.equal(routed.apiCalls,2);
    assert.match(routed.detail,/gateway transport failed/);
  } finally { globalThis.fetch=previousFetch; }
}

console.log('ai-router tests: PASS');
