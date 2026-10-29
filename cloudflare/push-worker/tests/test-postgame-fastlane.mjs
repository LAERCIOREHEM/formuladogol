import assert from 'node:assert/strict';
import { highlightTitleValid, highlightTaskValid, findOfficialHighlight, retryMinutes, validatePublicPayload, extractPublicFromTextDeterministic, extractOpenAISources, searchPublicWithOpenAI, geminiCircuitState, geminiStructuralFailure, staticSeedRefreshIntervalMs, hasLabeledFinancialEvidence, geRoundupSitemapUrls } from '../src/postgame-fastlane.js';

assert.equal(highlightTitleValid('FLAMENGO 1 X 0 BRAGANTINO | MELHORES MOMENTOS | BRASILEIRÃO 2026', 'Flamengo', 'Bragantino'), true);
assert.equal(highlightTitleValid('FLAMENGO X BRAGANTINO | AQUECIMENTO AO VIVO | BRASILEIRÃO', 'Flamengo', 'Bragantino'), false);
assert.equal(highlightTitleValid('CORINTHIANS 1 X 3 FLUMINENSE | GOLS E MELHORES MOMENTOS', 'Corinthians', 'Fluminense'), true);
assert.equal(highlightTitleValid('CORINTHIANS X FLUMINENSE | AO VIVO SEM IMAGENS', 'Corinthians', 'Fluminense'), false);
assert.equal(highlightTitleValid('SANTOS 2 X 1 REMO | MELHORES MOMENTOS', 'Remo', 'Santos'), true);
// R10R25: não repetir a vinculação indevida de retrospectiva 2009 ao FINAL 2026.
const gremio2026 = { home: 'Grêmio', away: 'Cruzeiro', kickoff: '2026-10-18T19:00:00Z', home_score: 2, away_score: 4 };
assert.equal(highlightTaskValid('GRÊMIO X CRUZEIRO | MELHORES MOMENTOS | BRASILEIRÃO 2009 | ge tv', gremio2026), false);
assert.equal(highlightTaskValid('GRÊMIO 2 X 4 CRUZEIRO | MELHORES MOMENTOS | 31ª RODADA | BRASILEIRÃO 2026', gremio2026), true);
assert.equal(highlightTaskValid('GRÊMIO 1 X 0 CRUZEIRO | MELHORES MOMENTOS | BRASILEIRÃO 2026', gremio2026), false);
assert.equal(highlightTaskValid('GRÊMIO X CRUZEIRO | MELHORES MOMENTOS', gremio2026), true);
assert.equal(highlightTaskValid('GRÊMIO X CRUZEIRO | AQUECIMENTO', gremio2026), false);

const fetchOriginalR10R25 = globalThis.fetch;
try {
  globalThis.fetch = async (url) => {
    const endpoint = new URL(String(url));
    if (endpoint.pathname.endsWith('/channels')) return { ok: true, json: async () => ({
      items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU-ge-uploads-test' } } }]
    }) };
    if (endpoint.pathname.endsWith('/playlistItems')) return { ok: true, json: async () => ({
      items: [
        { contentDetails: { videoId: 'u6sN9rau6c0', videoPublishedAt: '2026-10-18T22:55:00Z' }, snippet: { title: 'GRÊMIO X CRUZEIRO | MELHORES MOMENTOS | BRASILEIRÃO 2009' } },
        { contentDetails: { videoId: 'bMi5A-0h4so', videoPublishedAt: '2026-10-18T22:24:35Z' }, snippet: { title: 'GRÊMIO 2 X 4 CRUZEIRO | MELHORES MOMENTOS | 31ª RODADA | BRASILEIRÃO 2026' } }
      ]
    }) };
    throw Error('Unexpected URL: ' + endpoint);
  };
  const resolved = await findOfficialHighlight({ YOUTUBE_API_KEY: 'test-only' }, {
    ...gremio2026, event_id: '401841276', final_at: '2026-10-18T20:00:00Z'
  }, Date.parse('2026-10-18T23:00:00Z'));
  assert.equal(resolved.found, true);
  assert.equal(resolved.value.video_id, 'bMi5A-0h4so', 'video histórico mais recente não pode superar FINAL 2026');
} finally {
  globalThis.fetch = fetchOriginalR10R25;
}



// O dado curado do Pages não pode permanecer até 10 minutos sem chegar ao D1
// enquanto um budget_guard ainda desencadeia incidente CRÍTICO.
assert.equal(PUBLIC_POLICY.monthlyBudgetUsd,50);
assert.equal(PUBLIC_POLICY.eventBudgetUsd,1);
assert.equal(publicBudgetDecision({}, {month:{estimatedUsd:40},event:{estimatedUsd:0.5}}).allowOpenAI,true,'80% do teto mensal não bloqueia OpenAI');
assert.equal(publicBudgetDecision({}, {month:{estimatedUsd:49.9},event:{estimatedUsd:1}}).allowOpenAI,false,'US$ 1 por partida bloqueia OpenAI');
assert.equal(publicBudgetDecision({}, {month:{estimatedUsd:50},event:{estimatedUsd:0.1}}).hardStop,true,'US$ 50 bloqueia mensalmente');
assert.equal(staticSeedRefreshIntervalMs(), 10 * 60_000);
assert.equal(staticSeedRefreshIntervalMs({seedError:true}), 2 * 60_000);
assert.equal(staticSeedRefreshIntervalMs({hasBudgetGuard:true}), 60_000);
assert.equal(staticSeedRefreshIntervalMs({seedError:true,hasBudgetGuard:true}), 60_000);

assert.equal(retryMinutes('highlight', 1, 0), 1);
assert.equal(retryMinutes('highlight', 4, 0), 5);
assert.equal(retryMinutes('public', 1, 0), 1);
assert.equal(retryMinutes('public', 5, 1), 10);
assert.equal(retryMinutes('public', 99, 30), 1440);

const sources = new Set(['https://www.estadao.com.br/esportes/futebol/jogo?utm_source=x']);
const accepted = validatePublicPayload({
  encontrado: true,
  publico: 23760,
  publico_pagante: null,
  renda: 713080,
  fonte_publico: 'https://www.estadao.com.br/esportes/futebol/jogo',
  fonte_publico_pagante: null,
  fonte_renda: 'https://www.estadao.com.br/esportes/futebol/jogo',
  confianca: 0.98,
  observacao: 'ficha técnica'
}, sources);
assert.equal(accepted.accepted, true);
assert.equal(accepted.values.publico, 23760);
assert.equal(accepted.values.renda, 713080);

const rejected = validatePublicPayload({
  encontrado: true,
  publico: 99999,
  publico_pagante: null,
  renda: 100000,
  fonte_publico: 'https://example.com/inventado',
  fonte_publico_pagante: null,
  fonte_renda: 'https://example.com/inventado',
  confianca: 0.99,
  observacao: ''
}, sources);
assert.equal(rejected.accepted, false);
assert.equal(rejected.reason, 'source_not_verified');

// Normalização de fontes: web_search pode devolver URL AMP e o JSON canônico.
const geAmpSources = new Set(['https://ge.globo.com/google/amp/futebol/noticia/2026/09/20/exemplo.ghtml']);
const geCanonical = validatePublicPayload({
  encontrado: true, publico: 66053, publico_pagante: null, renda: null,
  fonte_publico: 'https://ge.globo.com/futebol/noticia/2026/09/20/exemplo.ghtml',
  fonte_publico_pagante: null, fonte_renda: null, confianca: 0.99, observacao: ''
}, geAmpSources);
assert.equal(geCanonical.accepted, true);
assert.equal(geCanonical.values.publico, 66053);

const ampUolSources = new Set(['https://www.uol.com.br/esporte/futebol/ultimas-noticias/2026/09/20/jogo.amp.htm']);
const canonicalUol = validatePublicPayload({
  encontrado: true, publico: null, publico_pagante: null, renda: 5752960,
  fonte_publico: null, fonte_publico_pagante: null,
  fonte_renda: 'https://uol.com.br/esporte/futebol/ultimas-noticias/2026/09/20/jogo.htm',
  confianca: 0.99, observacao: ''
}, ampUolSources);
assert.equal(canonicalUol.accepted, true);
assert.equal(canonicalUol.values.renda, 5752960);

// Regressão real 03/10/2026: uma ficha técnica rotulada deve ser suficiente para
// resolver o jogo sem depender da capacidade de extração generativa.
const galoRbrText = 'ATLÉTICO-MG 1 X 0 RED BULL BRAGANTINO. Arena MRV. RENDA - R$ 1.002.775,79. PÚBLICO - 22.159 torcedores.';
const galoRbrParsed = extractPublicFromTextDeterministic(galoRbrText, 'https://www.uol.com.br/esporte/noticias/galo-rbr.htm');
assert.equal(galoRbrParsed.encontrado, true);
assert.equal(galoRbrParsed.publico, 22159);
assert.equal(galoRbrParsed.renda, 1002775.79);
const galoRbrValidated = validatePublicPayload(galoRbrParsed, ['https://www.uol.com.br/esporte/noticias/galo-rbr.htm'], {home:'Atlético-MG',away:'Bragantino'});
assert.equal(galoRbrValidated.accepted, true);
assert.equal(galoRbrValidated.values.publico, 22159);
assert.equal(galoRbrValidated.values.renda, 1002775.79);

// Sites oficiais são aceitos apenas quando pertencem a um dos participantes.
const officialSp = {home:'São Paulo',away:'Santos'};
const officialPayload = {encontrado:true,publico:42000,publico_pagante:null,renda:1500000,fonte_publico:'https://www.saopaulofc.net/noticias/ficha',fonte_publico_pagante:null,fonte_renda:'https://www.saopaulofc.net/noticias/ficha',confianca:1,observacao:'ficha oficial'};
assert.equal(validatePublicPayload(officialPayload,['https://www.saopaulofc.net/noticias/ficha'],officialSp).accepted,true);
assert.equal(validatePublicPayload(officialPayload,['https://www.saopaulofc.net/noticias/ficha'],{home:'Flamengo',away:'Santos'}).accepted,false);



// v9 Source Recovery: as URLs do web_search existem independentemente de o
// JSON numérico final ser aceito. O pipeline deve poder cacheá-las e abrir a
// página com o parser determinístico.
const openAiSourceFixture={output:[
  {type:'web_search_call',action:{sources:[{url:'https://www.uol.com.br/esporte/ficha.htm'},{url:'https://www.estadao.com.br/esportes/ficha'}]}},
  {type:'message',content:[{type:'output_text',text:'{}',annotations:[{type:'url_citation',url:'https://www.r7.com/esportes/ficha'}]}]}
]};
assert.deepEqual([...extractOpenAISources(openAiSourceFixture)].sort(),[
  'https://www.estadao.com.br/esportes/ficha',
  'https://www.r7.com/esportes/ficha',
  'https://www.uol.com.br/esporte/ficha.htm'
].sort());

// R10R8: prova unitária do fallback OpenAI com busca realmente executada e
// números do caso de regressão. Nenhum dado é gravado em produção neste teste.
{
  const previousFetch=globalThis.fetch;
  try {
    globalThis.fetch=async (url,opts={})=>{
      assert.equal(String(url),'https://api.openai.com/v1/responses');
      const body=JSON.parse(String(opts.body||'{}'));
      assert.equal(body.tool_choice,'required');
      assert.equal(Object.hasOwn(body.tools[0],'filters'),false,'busca web deve abranger todos os domínios');
      return new Response(JSON.stringify({
        id:'resp_attendance',
        output:[
          {type:'web_search_call',action:{type:'search',sources:[{url:'https://www.uol.com.br/esporte/ficha.htm',title:'Ficha técnica'}]}},
          {type:'message',content:[{type:'output_text',text:'{"encontrado":true,"publico":22159,"publico_pagante":null,"renda":1002775.79,"fonte_publico":"https://www.uol.com.br/esporte/ficha.htm","fonte_publico_pagante":null,"fonte_renda":"https://www.uol.com.br/esporte/ficha.htm","confianca":1,"observacao":"ficha técnica"}',annotations:[{type:'url_citation',url:'https://www.uol.com.br/esporte/ficha.htm'}]}]}
        ],
        usage:{input_tokens:100,output_tokens:40,total_tokens:140}
      }),{status:200,headers:{'content-type':'application/json'}});
    };
    const found=await searchPublicWithOpenAI({OPENAI_API_KEY:'sk-test'},{event_id:'401841168',home:'Atlético-MG',away:'Bragantino',kickoff:'2026-10-03T21:30:00.000Z',home_score:1,away_score:0,round:21,stadium:'Arena MRV',publico:null,publico_pagante:null,renda:null},'openai:fallback-after-gemini');
    assert.equal(found.found,true);
    assert.equal(found.searchCalls,1);
    assert.equal(found.values.publico,22159);
    assert.equal(found.values.renda,1002775.79);
    assert.ok(found.discoveredSources.includes('https://www.uol.com.br/esporte/ficha.htm'));
  } finally { globalThis.fetch=previousFetch; }
}
console.log('postgame-fastlane tests: PASS');

// ============================ Política v10 ============================
import {
  PUBLIC_POLICY, planPublicStep, nextPublicAttemptMs, publicSearchRequest, shouldImmediateOpenAiFallback,
  parseEspnAttendance, isPublicComplete, publicAlertMessage, taskEndMs,
  publicBudgetDecision, sourceQuality, publicSlaAgeMinutes, publicSlaAlertAllowed
} from '../src/postgame-fastlane.js';

const END = Date.parse('2026-10-02T23:53:00.000Z');
const task = { event_id:'401841169', league:'bra.1', home:'São Paulo', away:'Santos', kickoff:'2026-10-02T23:00:00.000Z', final_at:'2026-10-02T23:53:00.000Z', home_score:1, away_score:2, round:21, stadium:'Morumbis' };
const at=(min)=>END+min*60_000;
const zero={mini_attempts:0,sol_attempts:0,sol_completed:0};
const fullBudget={allowGemini:true,allowOpenAI:true};

// R10R28: fontes grátis a cada 3 min e IA paga apenas em checkpoints
// limitados. Primeira contingência OpenAI em T+12, não dezenas de buscas.
assert.equal(planPublicStep(task,zero,at(1),fullBudget).phase,'deterministic');
assert.equal(planPublicStep(task,zero,at(3),fullBudget).phase,'gemini');
assert.equal(planPublicStep(task,{...zero,mini_attempts:1},at(8),fullBudget).phase,'deterministic');
assert.equal(planPublicStep(task,{...zero,mini_attempts:1},at(9),fullBudget).phase,'deterministic');
assert.equal(planPublicStep(task,{...zero,mini_attempts:1,sol_attempts:0},at(12),fullBudget).phase,'openai');
assert.equal(planPublicStep(task,{...zero,mini_attempts:2,sol_attempts:1},at(18),fullBudget).phase,'deterministic');
assert.equal(planPublicStep(task,{...zero,mini_attempts:3,sol_attempts:0},at(20),fullBudget).phase,'openai');
assert.equal(planPublicStep(task,{...zero,mini_attempts:2,sol_attempts:2},at(60),fullBudget).phase,'gemini');
assert.equal(planPublicStep(task,{...zero,mini_attempts:7,sol_attempts:1},at(90),fullBudget).phase,'openai');
assert.equal(planPublicStep(task,{...zero,mini_attempts:8,sol_attempts:2},at(120),fullBudget).phase,'deterministic');
assert.equal(planPublicStep(task,{...zero,mini_attempts:4,sol_attempts:3},at(120),fullBudget).phase,'deterministic');
assert.equal(planPublicStep(task,{...zero,mini_attempts:8,sol_attempts:3},at(180),fullBudget).phase,'deterministic');
assert.equal(planPublicStep(task,{...zero,mini_attempts:4,sol_attempts:2},at(240),fullBudget).phase,'gemini');
assert.notEqual(planPublicStep(task,{mini_attempts:99,sol_attempts:99,sol_completed:1},at(24*60),fullBudget).phase,'give_up');
assert.equal(planPublicStep(task,{...zero,mini_attempts:2},at(45),{allowGemini:true,allowOpenAI:false}).phase,'gemini');
assert.equal(planPublicStep(task,{...zero,mini_attempts:5},at(45),{allowGemini:false,allowOpenAI:false}).phase,'budget_guard');

assert.deepEqual(PUBLIC_POLICY.geminiScheduleMinutes,[3,15,45,105]);
assert.deepEqual(PUBLIC_POLICY.openaiScheduleMinutes,[12,50]);
assert.equal(PUBLIC_POLICY.overdueMinutes,120);
assert.equal(PUBLIC_POLICY.migrationGraceMinutes,15);
const oldFinished={league:'bra.1',final_at:'2026-10-07T22:00:00.000Z'};
const reopenedAt='2026-10-08T15:00:00.000Z';
const reopenedNow=Date.parse('2026-10-08T15:10:00.000Z');
assert.equal(publicSlaAgeMinutes(oldFinished,reopenedNow,reopenedAt),10);
assert.equal(publicSlaAlertAllowed(oldFinished,reopenedNow,reopenedAt),false);
assert.equal(publicSlaAlertAllowed(oldFinished,Date.parse('2026-10-08T16:59:00.000Z'),reopenedAt),false);
assert.equal(publicSlaAlertAllowed(oldFinished,Date.parse('2026-10-08T17:00:00.000Z'),reopenedAt),true);
assert.equal(publicSlaAlertAllowed(oldFinished,Date.parse('2026-10-08T17:00:00.000Z'),''),true);
assert.equal(PUBLIC_POLICY.overdueGeminiEveryMinutes,120);
assert.equal(PUBLIC_POLICY.overdueOpenaiEveryMinutes,240);
assert.equal(PUBLIC_POLICY.eventBudgetUsd,1);
assert.equal(PUBLIC_POLICY.monthlyBudgetUsd,50);
assert.equal(PUBLIC_POLICY.geminiCircuitStructuralMinutes,30);
assert.equal(PUBLIC_POLICY.geminiCircuitSoftMinutes,15);
assert.equal(PUBLIC_POLICY.geminiProbeCacheMinutes,15);

// R10R9: circuit breaker impede repetição cega de erro estrutural do Gemini.
assert.equal(geminiStructuralFailure({httpStatus:400,searchCalls:0,sources:[]}), 'provider_4xx');
assert.equal(geminiStructuralFailure({httpStatus:200,searchCalls:0,sources:[]}), 'no_real_search');
assert.equal(geminiStructuralFailure({httpStatus:200,searchCalls:1,sources:['https://uol.com.br/x']}), '');
const circuitNow=Date.parse('2026-10-04T07:30:00.000Z');
const circuitOpen=geminiCircuitState({openUntil:'2026-10-04T07:45:00.000Z',consecutiveFailures:1,lastFailure:'provider_4xx'},circuitNow);
assert.equal(circuitOpen.open,true);
assert.equal(circuitOpen.state,'open');
assert.equal(circuitOpen.remainingMs,15*60_000);
assert.equal(geminiCircuitState({openUntil:'2026-10-04T07:20:00.000Z'},circuitNow).open,false);

assert.equal(nextPublicAttemptMs(task,'deterministic',{phase:'gemini'},at(4),zero),at(5));
assert.equal(nextPublicAttemptMs(task,'gemini',{phase:'deterministic'},at(5),{...zero,mini_attempts:1}),at(8));
assert.equal(nextPublicAttemptMs(task,'deterministic',{phase:'budget_guard'},at(46),{mini_attempts:3,sol_attempts:0}),at(49));
assert.equal(nextPublicAttemptMs(task,'gemini',{phase:'deterministic'},at(181),{mini_attempts:9,sol_attempts:3}),at(186));

const terra=publicSearchRequest(task,['renda'],{},'openai');
assert.equal(terra.model,'gpt-5.6-terra'); assert.equal(terra.max_tool_calls,3); assert.equal(terra.reasoning.effort,'low');
assert.equal(terra.tool_choice,'required');
assert.equal(Object.hasOwn(terra.tools[0],'filters'),false,'não limitar veículos por domínio');
assert.match(String(terra.input[0].content[0].text),/partida=/,'dossiê factual obrigatório');
assert.match(String(terra.input[0].content[0].text),/público renda/,'consultas abertas devem conter público e renda');
assert.doesNotMatch(String(terra.input[0].content[0].text),/site:uol\.com\.br/,'consultas base sem site: obrigatório');
const sol=publicSearchRequest(task,['renda'],{POSTGAME_OPENAI_MODEL:'gpt-5.6-sol'},'openai');
assert.equal(sol.model,'gpt-5.6-sol');
assert.match(JSON.stringify(terra),/sites oficiais dos clubes participantes/);
assert.match(JSON.stringify(terra),/rodada=21/);

assert.equal(sourceQuality('https://www.gazetaesportiva.com/campeonatos/x'),'robust');
assert.equal(sourceQuality('https://ge.globo.com/futebol/x'),'robust');
assert.equal(sourceQuality('https://www.saopaulofc.net/noticias/x'),'unverified');
assert.equal(sourceQuality('https://www.saopaulofc.net/noticias/x',task),'club_official');
assert.equal(sourceQuality('https://x.com/qualquer/status/1'),'rejected');

const decision=publicBudgetDecision({POSTGAME_PUBLIC_EVENT_BUDGET_USD:'0.25',POSTGAME_PUBLIC_MONTHLY_BUDGET_USD:'10',POSTGAME_PUBLIC_MONTHLY_WARNING_PCT:'80'}, {event:{estimatedUsd:0.26},month:{estimatedUsd:1}});
assert.equal(decision.allowOpenAI,false);
assert.equal(decision.allowGemini,false);
assert.equal(decision.reason,'event_budget_openai_guard');
const hard=publicBudgetDecision({}, {event:{estimatedUsd:0.01},month:{estimatedUsd:50.1}});
assert.equal(hard.allowOpenAI,false); assert.equal(hard.allowGemini,false); assert.equal(hard.hardStop,true);

assert.equal(parseEspnAttendance({gameInfo:{attendance:42317}}),42317);
assert.equal(parseEspnAttendance({gameInfo:{attendance:'61.532'}}),61532);
assert.equal(parseEspnAttendance({}),null);
assert.equal(isPublicComplete({publico:42000,renda:1500000}),true);
assert.equal(isPublicComplete({publico:42000,renda:null}),false);
assert.equal(taskEndMs({kickoff:'2026-09-20T18:00:00.000Z'}),Date.parse('2026-09-20T19:55:00.000Z'));
const msg=publicAlertMessage(task,{publico:null,publico_pagante:null,renda:null},{},{deterministic_checks:15,mini_attempts:5,sol_attempts:2},'not_found',{}, {event:{estimatedUsd:0.06},month:{estimatedUsd:1.84}}, new Date(at(180)).toISOString());
assert.match(msg.body,/busca automática CONTINUA/);
assert.match(msg.body,/reconsulta fontes gratuitas a cada 5–15 min/);
assert.doesNotMatch(msg.body,/Nenhuma nova busca automática será feita/);

// R10R9: falha Gemini em jogo >=45min precisa acionar OpenAI NO MESMO CICLO.
assert.equal(shouldImmediateOpenAiFallback({ageMinutes:120,budget:{allowOpenAI:true},geminiResult:{searchCalls:0,httpStatus:400,found:false},discoveredCount:0,refreshedFoundAny:false,complete:false}),true);
assert.equal(shouldImmediateOpenAiFallback({ageMinutes:11,budget:{allowOpenAI:true},geminiResult:{searchCalls:0,httpStatus:400,found:false},discoveredCount:0,refreshedFoundAny:false,complete:false}),false);
assert.equal(shouldImmediateOpenAiFallback({ageMinutes:20,budget:{allowOpenAI:true},complete:false}),true);
assert.equal(shouldImmediateOpenAiFallback({ageMinutes:20,forcedUpgrade:true,budget:{allowOpenAI:true},geminiResult:{searchCalls:0,httpStatus:400,found:false},discoveredCount:0,refreshedFoundAny:false,complete:false}),true);
assert.equal(shouldImmediateOpenAiFallback({ageMinutes:120,budget:{allowOpenAI:false},geminiResult:{searchCalls:0,httpStatus:400,found:false},discoveredCount:0,refreshedFoundAny:false,complete:false}),false);
assert.equal(shouldImmediateOpenAiFallback({ageMinutes:120,budget:{allowOpenAI:true},geminiResult:{searchCalls:1,httpStatus:200,found:true},discoveredCount:2,refreshedFoundAny:true,complete:true}),false);
assert.equal(shouldImmediateOpenAiFallback({ageMinutes:120,budget:{allowOpenAI:true},geminiResult:{searchCalls:1,httpStatus:200,found:true},discoveredCount:2,refreshedFoundAny:true,complete:false}),true);
// R10R20: resultado simples NÃO deve consumir Workers AI.
assert.equal(hasLabeledFinancialEvidence('Remo 1 x 1 Bragantino, final no Mangueirão.'), false);
assert.equal(hasLabeledFinancialEvidence('Público presente: 9.432 Renda: R$ 399.000'), true);
assert.equal(hasLabeledFinancialEvidence('Renda: R$ 1.658.380,50'), true);
assert.equal(nextPublicAttemptMs(task,'deterministic',{phase:'deterministic'},at(7*60),zero),at(7*60+15));
assert.equal(nextPublicAttemptMs(task,'deterministic',{phase:'deterministic'},at(25*60),zero),at(26*60));
assert.equal(PUBLIC_POLICY.deterministicEveryMinutes,3);
console.log('postgame-fastlane v15 policy + eligibility guard + factual integrity + SLA suppression + circuit tests: PASS');

// ============================ R10R15 Match Identity Gate ============================
{
  const { evaluateSourceMatchIdentity, extractRoundupMatchBlock, buildAttendanceSearchQueries, isCandidateEditorialAttendanceSource, POSTGAME_SEARCH_PROFILE_VERSION } = await import('../src/postgame-search-profile.js');
  assert.equal(POSTGAME_SEARCH_PROFILE_VERSION, 10);
  const searchQueries=buildAttendanceSearchQueries({home:'Flamengo',away:'Atlético-MG',kickoff:'2026-10-26T20:00:00-03:00',home_score:3,away_score:2,round:32,stadium:'Maracanã'});
  assert.equal(searchQueries[0],'Flamengo Atlético-MG público renda 26/10/2026');
  assert.ok(searchQueries.slice(0,3).every((q)=>!q.includes('site:')),'começar com três buscas genéricas');
  assert.ok(searchQueries.some((q)=>q.includes('3 x 2')),'usar placar como consulta alternativa');

  const grenal = {
    event_id:'401841267', league:'bra.1', home:'Grêmio', away:'Internacional',
    kickoff:'2026-10-11T17:30:00-03:00', home_score:1, away_score:1,
    round:30, stadium:'Arena do Grêmio'
  };
  const wrongCompetitionText='Grêmio e Internacional se enfrentaram na Arena do Grêmio, público 55.337, em clássico da Copa do Brasil.';
  const wrongCompetitionUrl='https://www.itatiaia.com.br/esportes/futebol/futebol-nacional/copa-do-brasil/arena-do-gremio-teve-quebra-de-recorde-de-publico-no-grenal-pela-copa-do-brasil';
  const wrongCompetition=evaluateSourceMatchIdentity(grenal,wrongCompetitionText,wrongCompetitionUrl);
  assert.equal(wrongCompetition.accepted,false,'Copa do Brasil não pode validar Gre-Nal do Brasileirão');
  assert.ok(wrongCompetition.conflicts.some(x=>x==='url_competition_mismatch:copa-do-brasil'));
  const validGrenal=evaluateSourceMatchIdentity(grenal,
    'Grêmio 1 x 1 Internacional, na Arena do Grêmio, 30ª rodada do Campeonato Brasileiro. Público 53.528 torcedores. Renda R$ 4.106.188,74.',
    'https://www.uol.com.br/esporte/ultimas-noticias/agencia/2026/10/11/gremio-e-internacional-empatam-no-gre-nal-455.htm');
  assert.equal(validGrenal.accepted,true,'fonte válida do Gre-Nal 455 não pode ser bloqueada');
  const flaFlu={event_id:'401841263',league:'bra.1',home:'Flamengo',away:'Fluminense',kickoff:'2026-10-11T17:30:00-03:00',home_score:1,away_score:0,round:30,stadium:'Maracanã'};
  const wrongCarioca=evaluateSourceMatchIdentity(flaFlu,
    'Flamengo 1 x 0 Fluminense no Maracanã. Público 63.300. Renda R$ 1.245.363,00.',
    'https://ge.globo.com/Esportes/Noticias/Futebol/Campeonato_Carioca/0%2C%2CMUL1082422-9835%2C00.html');
  assert.equal(wrongCarioca.accepted,false,'Campeonato Carioca não pode validar renda do Brasileirão');
  assert.ok(wrongCarioca.conflicts.some(x=>x==='url_competition_mismatch:campeonato-carioca'));

  const vitoriaChape = {
    event_id:'401841250', home:'Vitória', away:'Chapecoense', kickoff:'2026-10-07T20:00:00-03:00',
    home_score:4, away_score:0, round:29, stadium:'Estadio Manoel Barradas'
  };
  const fonteErrada = 'Chapecoense goleou o Amazonas por 4 x 0 na Arena Condá. Depois de dez jogos, a equipe voltou a ter uma vitória. PÚBLICO - 1.945. RENDA - R$ 40.605,00.';
  const gateErrado = evaluateSourceMatchIdentity(vitoriaChape, fonteErrada, 'https://www.uol.com.br/esporte/ultimas-noticias/agencia/2025/06/02/chapecoense-goleia-o-amazonas.htm');
  assert.equal(gateErrado.accepted, false, 'Vitória lexical + Chapecoense não pode provar EC Vitória x Chapecoense');
  assert.ok(gateErrado.conflicts.some((x)=>String(x).startsWith('url_date_mismatch:')));

  const fonteCorreta = 'Na noite desta quarta-feira, o Vitória goleou a Chapecoense por 4 a 0, no Barradão, pela 29ª rodada do Campeonato Brasileiro. Público: 13.934 pessoas. Público pagante: 13.773. Renda: R$ 285.132,00.';
  const gateCorreto = evaluateSourceMatchIdentity(vitoriaChape, fonteCorreta, 'https://www.bahianoticias.com.br/esportes/vitoria/31622-confira-publico-e-renda-de-vitoria-x-chapecoense');
  assert.equal(gateCorreto.accepted, true);
  const parsedCorreto = extractPublicFromTextDeterministic(gateCorreto.window, 'https://www.bahianoticias.com.br/esportes/vitoria/31622-confira-publico-e-renda-de-vitoria-x-chapecoense');
  assert.equal(parsedCorreto.publico, 13934);
  assert.equal(parsedCorreto.publico_pagante, 13773);
  assert.equal(parsedCorreto.renda, 285132);

  const botVasco = {
    event_id:'401841257', home:'Botafogo', away:'Vasco da Gama', kickoff:'2026-10-07T20:30:00-03:00',
    home_score:1, away_score:2, round:29, stadium:'Nilton Santos'
  };
  const rodadaMultijogo = 'Veja os públicos da rodada. Botafogo 1 x 2 Remo (Nilton Santos). Público presente: 22.116. Público pagante: 18.780. Renda: R$ 696.020. Flamengo 2 x 2 Vasco (Maracanã). Público presente: 61.872.';
  const gateMulti = evaluateSourceMatchIdentity(botVasco, rodadaMultijogo, 'https://ge.globo.com/gato-mestre/noticia/2026/05/03/veja-os-publicos-da-14a-rodada.ghtml');
  assert.equal(gateMulti.accepted, false, 'nomes em seções diferentes de página multijogo não podem provar o confronto');

  const rodadaComAlvo = 'Flamengo 2 x 1 Palmeiras. Público presente: 61.000. Público pagante: 58.000. Renda: R$ 4.200.000,00. Botafogo 1 x 2 Vasco. Público presente: 23.596. Público pagante: 22.071. Renda: R$ 801.180,00.';
  const gateRodadaAlvo = evaluateSourceMatchIdentity(botVasco, rodadaComAlvo, 'https://ge.globo.com/gato-mestre/noticia/2026/10/07/publicos-da-29a-rodada.ghtml');
  assert.equal(gateRodadaAlvo.accepted, false, 'matéria multijogo exige parser estruturado por confronto');
  assert.ok(gateRodadaAlvo.conflicts.includes('multi_match_roundup_requires_structured_parser'));
  // R10R27: Fastlane também pode extrair roundups após provar cabeçalho
  // exato (equipes, placar, rodada/data), sem herdar valores de outro jogo.
  const geFlaUrl='https://ge.globo.com/gato-mestre/noticia/2026/10/26/flamengo-x-atletico-mg-tem-o-maior-publico-da-32a-rodada-do-brasileiro-veja-a-lista.ghtml';
  const flaGalo={event_id:'401841286',league:'bra.1',home:'Flamengo',away:'Atlético-MG',kickoff:'2026-10-26T20:00:00-03:00',home_score:3,away_score:2,round:32,stadium:'Maracanã'};
  const sitemapGe='<urlset><url><loc>https://ge.globo.com/gato-mestre/noticia/2026/10/26/flamengo-x-atletico-mg-tem-o-maior-publico-da-32a-rodada-do-brasileiro-veja-a-lista.ghtml</loc></url><url><loc>https://ge.globo.com/gato-mestre/noticia/2026/10/26/outra-lista-de-publicos-da-31a-rodada.ghtml</loc></url><url><loc>https://evil.example.com/gato-mestre/noticia/2026/10/26/publicos-da-32a-rodada.ghtml</loc></url></urlset>';
  assert.deepEqual(geRoundupSitemapUrls(sitemapGe,32),[geFlaUrl],'sitemap não pode trazer domínio ou rodada errados');
  const geRound32='Internacional 3 x 0 Botafogo (Beira-Rio) Público pagante: 34.287 Público presente: não divulgado Renda líquida: R$ 1.440.409 Flamengo 3 x 2 Atlético-MG (Maracanã) Público pagante: 57.619 Público presente: 60.624 Renda: R$ 4.578.137,50 Cruzeiro 1 x 0 Remo (Mineirão) Público presente: 29.516 Renda: R$ 1.220.408';
  assert.equal(evaluateSourceMatchIdentity(flaGalo,geRound32,geFlaUrl).accepted,false,'roundup continua bloqueado no gate generico');
  const scopedFla=extractRoundupMatchBlock(flaGalo,geRound32,geFlaUrl);
  assert.equal(scopedFla.accepted,true,scopedFla.reason);
  assert.ok(!scopedFla.window.includes('1.440.409')&&!scopedFla.window.includes('1.220.408'),'não herdar receita de outras partidas');
  const amounts=extractPublicFromTextDeterministic(scopedFla.window,geFlaUrl);
  assert.equal(amounts.publico,60624);
  assert.equal(amounts.publico_pagante,57619);
  assert.equal(amounts.renda,4578137.50,'centavos precisam ser preservados');
  assert.equal(validatePublicPayload(amounts,[geFlaUrl],flaGalo).accepted,false,'modelo nao pode publicar roundup bruto');
  const safe=validatePublicPayload(amounts,[geFlaUrl],flaGalo,{structuredRoundup:true});
  assert.equal(safe.accepted,true);
  assert.equal(safe.values.renda,4578137.5);
  // Fonte regional ainda não cadastrada: valor explícito + URL segura + jogo exato.
  const regionalUrl='https://jornalregional.com.br/esportes/2026/10/26/flamengo-atletico-mg-publico-renda';
  const regionalText='Flamengo 3 x 2 Atlético-MG pela 32ª rodada do Brasileiro. Público presente: 60.624 torcedores. Público pagante: 57.619. Renda: R$ 4.578.137,50.';
  assert.equal(isCandidateEditorialAttendanceSource(regionalUrl,flaGalo),true,'fonte regional nova não pode ser descartada por lista fixa');
  assert.equal(isCandidateEditorialAttendanceSource('http://jornalregional.com.br/esportes/2026/10/26/fla-galo',flaGalo),false,'candidato deve usar HTTPS');
  assert.equal(isCandidateEditorialAttendanceSource('https://corinthians.com.br/noticias/2026/10/26/flamengo-atletico-mg',flaGalo),false,'site de clube não participante não pode ser fonte nova');
  assert.equal(isCandidateEditorialAttendanceSource('https://localhost/esportes/2026/10/26/fla-galo',flaGalo),false,'host local inseguro');
  const regionalGate=evaluateSourceMatchIdentity(flaGalo,regionalText,regionalUrl);
  assert.equal(regionalGate.accepted,true);
  const regionalNumbers=extractPublicFromTextDeterministic(regionalGate.window,regionalUrl);
  assert.equal(validatePublicPayload(regionalNumbers,[regionalUrl],flaGalo).accepted,false,'dado direto de modelo em domínio novo permanece bloqueado');
  const regionalChecked=validatePublicPayload(regionalNumbers,[regionalUrl],flaGalo,{documentaryCandidate:true});
  assert.equal(regionalChecked.accepted,true,'domínio novo deve funcionar após leitura documental escopada');
  assert.equal(regionalChecked.values.renda,4578137.5);

  assert.equal(extractRoundupMatchBlock({...flaGalo,round:31},geRound32,geFlaUrl).accepted,false,'rodada conflitante bloqueada');
  assert.equal(extractRoundupMatchBlock({...flaGalo,home_score:2},geRound32,geFlaUrl).accepted,false,'placar divergente bloqueado');
  assert.equal(extractRoundupMatchBlock({...flaGalo,kickoff:'2026-09-16T20:00:00-03:00'},geRound32,geFlaUrl).accepted,false,'data divergente bloqueada');
  const partialGe='Flamengo 1 x 0 Fluminense Público presente: 63.300 Público pagante: 58.246 Renda: R$ 7.006.350,00 Chapecoense 1 x 4 Athletico-PR. A partida será na Arena Condá.';
  assert.equal(extractRoundupMatchBlock({event_id:'401841265',home:'Chapecoense',away:'Athletico-PR',kickoff:'2026-10-12T19:30:00-03:00',home_score:1,away_score:4,round:30},partialGe,'https://ge.globo.com/gato-mestre/noticia/2026/10/11/flamengo-1-x-0-fluminense-tem-o-maior-publico-da-30a-rodada-do-brasileiro-veja-a-lista.ghtml').accepted,false,'sem dados no bloco de Chape nao pode copiar Flamengo');

  // O parser Python continua responsável pelas matérias agregadas de rodada.

  const chape = {event_id:'401841265',league:'bra.1',home:'Chapecoense',away:'Athletico-PR',kickoff:'2026-10-12T19:30:00-03:00',home_score:1,away_score:4,round:30,stadium:'Arena Condá'};
  const geRodada = 'Flamengo 1 x 0 Fluminense. Público presente: 63.300. Pagantes: 58.246. Renda: R$ 7.006.350,00. Chapecoense 1 x 4 Athletico-PR. A partida será na Arena Condá.';
  const geUrl = 'https://ge.globo.com/gato-mestre/noticia/2026/10/11/flamengo-1-x-0-fluminense-tem-o-maior-publico-da-30a-rodada-do-brasileiro-veja-a-lista.ghtml';
  const gateChape = evaluateSourceMatchIdentity(chape, geRodada, geUrl);
  assert.equal(gateChape.accepted, false, 'Chapecoense não pode herdar 63.300 presentes do Flamengo');
  assert.ok(gateChape.conflicts.includes('multi_match_roundup_requires_structured_parser'));
  const invalidRoundup = validatePublicPayload({encontrado:true,publico:63300,publico_pagante:58246,renda:7006350,fonte_publico:geUrl,fonte_publico_pagante:geUrl,fonte_renda:geUrl,confianca:1}, [geUrl], chape);
  assert.equal(invalidRoundup.accepted, false, 'IA não pode contornar bloqueio de matéria agregada');
  const chapeSource = 'Chapecoense 1 x 4 Athletico-PR, Arena Condá. Público: 3.924 torcedores. Renda: R$ 169.490,00.';
  const chapeUrl = 'https://www.bol.uol.com.br/esporte/2026/10/12/athletico-pr-goleia-chapecoense-com-dois-gols-do-artilheiro-viveros.htm';
  const validChape = evaluateSourceMatchIdentity(chape, chapeSource, chapeUrl);
  assert.equal(validChape.accepted, true);
  const parsedChape = extractPublicFromTextDeterministic(validChape.window, chapeUrl);
  const acceptedChape = validatePublicPayload(parsedChape, [chapeUrl], chape);
  assert.equal(acceptedChape.accepted, true);
  assert.equal(acceptedChape.values.publico, 3924);
  assert.equal(acceptedChape.values.renda, 169490);
  const impossible = validatePublicPayload({...parsedChape, publico:63300}, [chapeUrl], chape);
  assert.equal(impossible.accepted, false);
  assert.equal(impossible.reason, 'stadium_capacity_exceeded:20089');

  const fonteBotVasco = 'Botafogo e Vasco se enfrentaram no Estádio Nilton Santos pela 29ª rodada. O clássico terminou Botafogo 1 x 2 Vasco. Público presente: 23.596. Público pagante: 22.071. Renda: R$ 801.180,00.';
  const gateBotVasco = evaluateSourceMatchIdentity(botVasco, fonteBotVasco, 'https://www.correiobraziliense.com.br/esportes/2026/10/7516875-botafogo-vasco.html');
  assert.equal(gateBotVasco.accepted, true);
  const parsedBotVasco = extractPublicFromTextDeterministic(gateBotVasco.window, 'https://www.correiobraziliense.com.br/esportes/2026/10/7516875-botafogo-vasco.html');
  assert.equal(parsedBotVasco.publico, 23596);
  assert.equal(parsedBotVasco.publico_pagante, 22071);
  assert.equal(parsedBotVasco.renda, 801180);
}
console.log('R10R15 match identity gate tests: PASS');

// R10R29: casos reais da rodada 33 — normalização sem perda de offsets,
// notícia longa, placar ×, presentes ≠ pagantes e renda em formato combinado.
{
  const {evaluateSourceMatchIdentity} = await import('../src/postgame-search-profile.js');
  const remo={event_id:'401841297',league:'bra.1',home:'Remo',away:'Botafogo',
    kickoff:'2026-10-28T21:30:00-03:00',home_score:2,away_score:1,round:33,stadium:'Mangueirão'};
  const remoUrl='https://www.oliberal.com/esportes/remo/xo-jejum-remo-vence-o-botafogo-e-segue-vivo-no-brasileirao-1.1188130';
  const longStory='Remo 2 x 1 Botafogo no Mangueirão, 33ª rodada do Campeonato Brasileiro. '+
    ('Vitória do clube em Belém; retrospectiva com acentos e pontuação. '.repeat(48))+
    ' Ficha técnica: Renda e público: R$ 378.700,00 / 9.760 pagantes / 13.458 presentes.';
  const longGate=evaluateSourceMatchIdentity(remo,longStory,remoUrl);
  assert.equal(longGate.accepted,true,'a identificação do Remo deve sobreviver à normalização');
  assert.ok(longGate.window.includes('13.458 presentes'),'não truncar ficha técnica após o título');
  const remoFields=extractPublicFromTextDeterministic(longGate.window,remoUrl);
  assert.deepEqual([remoFields.publico,remoFields.publico_pagante,remoFields.renda],[13458,9760,378700]);
  const remoValidated=validatePublicPayload(remoFields,[remoUrl],remo);
  assert.equal(remoValidated.accepted,true);
  const bahia={event_id:'401841296',league:'bra.1',home:'Bahia',away:'São Paulo',
    kickoff:'2026-10-28T21:30:00-03:00',home_score:3,away_score:2,round:33,stadium:'Arena Fonte Nova'};
  const bahiaUrl='https://www.correiobraziliense.com.br/esportes/2026/10/7529972-bahia-vence-o-sao-paulo-em-salvador-e-cola-no-g6-do-brasileirao.html';
  const bahiaText='Bahia 3×2 São Paulo, Arena Fonte Nova, 33ª rodada do Brasileirão. '+
    'A partida teve arbitragem confirmada. Ficha técnica: Público: 21.492 presentes. Renda: 628.385,50.';
  const bahiaGate=evaluateSourceMatchIdentity(bahia,bahiaText,bahiaUrl);
  assert.equal(bahiaGate.accepted,true,'placar 3×2 deve ser reconhecido como resultado do confronto');
  assert.ok(bahiaGate.window.includes('Público: 21.492'));
  const bahiaFields=extractPublicFromTextDeterministic(bahiaGate.window,bahiaUrl);
  assert.equal(bahiaFields.publico,21492);
  assert.equal(bahiaFields.renda,628385.50);
  assert.equal(validatePublicPayload(bahiaFields,[bahiaUrl],bahia).accepted,true);
  // Não copiar dados de um confronto adjacente numa reportagem de rodada.
  const other='Flamengo 1 x 0 Bahia. Público: 61.000. Renda: R$ 1.800.000,00.';
  assert.equal(evaluateSourceMatchIdentity(remo,other,remoUrl).accepted,false);
}
console.log('R10R29 round 33 hunter regression fixtures: PASS');

{
  // Regressão: links de assuntos relacionados no rodapé NUNCA podem vencer
  // o bloco documental do jogo na escolha da dupla de clubes.
  const {evaluateSourceMatchIdentity}=await import('../src/postgame-search-profile.js');
  const task={event_id:'401841297',league:'bra.1',home:'Remo',away:'Botafogo',
    kickoff:'2026-10-28T21:30:00-03:00',home_score:2,away_score:1,round:33,stadium:'Mangueirão'};
  const sourceUrl='https://www.oliberal.com/esportes/remo/ficha-tecnica-remobotafogo';
  const sourceText='Remo vence o Botafogo no Mangueirão pela 33ª rodada do Brasileirão. '+
    'O placar terminou Remo 2 x 1 Botafogo. '+
    ('A equipe teve um jogo intenso em Belém e criou oportunidades. '.repeat(38))+
    'Ficha técnica. Remo 2 x 1 Botafogo. Público total: 13.458. Público pagante: 9.760. Renda: R$ 378.700,00. '+
    'Assuntos relacionados: Remo x Botafogo em outro campeonato. '+
    'Remo x Botafogo e notícias do Remo x Botafogo. ';
  const identity=evaluateSourceMatchIdentity(task,sourceText,sourceUrl);
  assert.equal(identity.accepted,true,'não confundir tags do rodapé com o bloco do jogo');
  const parsed=extractPublicFromTextDeterministic(identity.window,sourceUrl);
  assert.deepEqual([parsed.publico,parsed.publico_pagante,parsed.renda],[13458,9760,378700],
    'a ficha deve prevalecer sobre o link repetido no rodapé');
}
console.log('R10R29.1 source footer identity regression: PASS');



// ============================ R10R16.1 Factual Integrity Guard ============================
{
  const { inspectPostgameFactualIntegrity, quarantinePostgameFactualIntegrity, FACTUAL_INCIDENTS } = await import('../src/postgame-factual-integrity.js');
  const collision=inspectPostgameFactualIntegrity({publico:15056,renda:15056});
  assert.deepEqual(collision.critical,[FACTUAL_INCIDENTS.PUBLIC_REVENUE_FIELD_COLLISION]);
  assert.deepEqual(collision.quarantineFields,['renda']);
  const q=quarantinePostgameFactualIntegrity({publico:15056,publico_pagante:null,renda:15056},{publico:'https://a',renda:'https://b'});
  assert.equal(q.values.publico,15056);
  assert.equal(q.values.renda,null);
  assert.equal(q.sources.publico,'https://a');
  assert.equal(q.sources.renda,undefined);
  const good=inspectPostgameFactualIntegrity({publico:15056,renda:708004.50});
  assert.equal(good.critical.length,0);

  const src=new Set(['https://www.uol.com.br/esporte/ficha.htm']);
  const partial=validatePublicPayload({
    encontrado:true,publico:15056,publico_pagante:null,renda:15056,
    fonte_publico:'https://www.uol.com.br/esporte/ficha.htm',fonte_publico_pagante:null,fonte_renda:'https://www.uol.com.br/esporte/ficha.htm',
    confianca:1,observacao:'colisão'
  },src,{publico:null});
  assert.equal(partial.accepted,true,'público confiável deve sobreviver à quarentena da renda');
  assert.equal(partial.values.publico,15056);
  assert.equal(partial.values.renda,undefined);
  assert.deepEqual(partial.quarantinedFields,['renda']);

  const revenueOnly=validatePublicPayload({
    encontrado:true,publico:null,publico_pagante:null,renda:15056,
    fonte_publico:null,fonte_publico_pagante:null,fonte_renda:'https://www.uol.com.br/esporte/ficha.htm',
    confianca:1,observacao:'colisão contextual'
  },src,{publico:15056});
  assert.equal(revenueOnly.accepted,false);
  assert.match(revenueOnly.reason,/PUBLIC_REVENUE_FIELD_COLLISION/);
}
console.log('R10R16.1 factual integrity guard tests: PASS');

