import assert from 'node:assert/strict';
import { highlightTitleValid, retryMinutes, validatePublicPayload, extractPublicFromTextDeterministic, extractOpenAISources, searchPublicWithOpenAI, geminiCircuitState, geminiStructuralFailure } from '../src/postgame-fastlane.js';

assert.equal(highlightTitleValid('FLAMENGO 1 X 0 BRAGANTINO | MELHORES MOMENTOS | BRASILEIRÃO 2026', 'Flamengo', 'Bragantino'), true);
assert.equal(highlightTitleValid('FLAMENGO X BRAGANTINO | AQUECIMENTO AO VIVO | BRASILEIRÃO', 'Flamengo', 'Bragantino'), false);
assert.equal(highlightTitleValid('CORINTHIANS 1 X 3 FLUMINENSE | GOLS E MELHORES MOMENTOS', 'Corinthians', 'Fluminense'), true);
assert.equal(highlightTitleValid('CORINTHIANS X FLUMINENSE | AO VIVO SEM IMAGENS', 'Corinthians', 'Fluminense'), false);
assert.equal(highlightTitleValid('SANTOS 2 X 1 REMO | MELHORES MOMENTOS', 'Remo', 'Santos'), true);

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
const geAmpSources = new Set(['https://ge.globo.com/google/amp/gato-mestre/noticia/2026/09/20/exemplo.ghtml']);
const geCanonical = validatePublicPayload({
  encontrado: true, publico: 66053, publico_pagante: null, renda: null,
  fonte_publico: 'https://ge.globo.com/gato-mestre/noticia/2026/09/20/exemplo.ghtml',
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
      assert.ok(body.tools[0].filters.allowed_domains.includes('uol.com.br'));
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
  publicBudgetDecision, sourceQuality
} from '../src/postgame-fastlane.js';

const END = Date.parse('2026-10-02T23:53:00.000Z');
const task = { event_id:'401841169', league:'bra.1', home:'São Paulo', away:'Santos', kickoff:'2026-10-02T23:00:00.000Z', final_at:'2026-10-02T23:53:00.000Z', home_score:1, away_score:2, round:21, stadium:'Morumbis' };
const at=(min)=>END+min*60_000;
const zero={mini_attempts:0,sol_attempts:0,sol_completed:0};
const fullBudget={allowGemini:true,allowOpenAI:true};

assert.equal(planPublicStep(task,zero,at(1),fullBudget).phase,'deterministic');
assert.equal(planPublicStep(task,zero,at(5),fullBudget).phase,'gemini');
assert.equal(planPublicStep(task,{...zero,mini_attempts:1},at(14),fullBudget).phase,'deterministic');
assert.equal(planPublicStep(task,{...zero,mini_attempts:1},at(15),fullBudget).phase,'gemini');
assert.equal(planPublicStep(task,{...zero,mini_attempts:2},at(30),fullBudget).phase,'gemini');
assert.equal(planPublicStep(task,{...zero,mini_attempts:3},at(45),fullBudget).phase,'openai');
assert.equal(planPublicStep(task,{...zero,mini_attempts:3,sol_attempts:1},at(60),fullBudget).phase,'gemini');
assert.equal(planPublicStep(task,{...zero,mini_attempts:7,sol_attempts:1},at(90),fullBudget).phase,'openai');
assert.equal(planPublicStep(task,{...zero,mini_attempts:8,sol_attempts:2},at(120),fullBudget).phase,'openai');
assert.equal(planPublicStep(task,{...zero,mini_attempts:4,sol_attempts:3},at(120),fullBudget).phase,'gemini');
assert.equal(planPublicStep(task,{...zero,mini_attempts:8,sol_attempts:3},at(180),fullBudget).phase,'gemini');
assert.equal(planPublicStep(task,{...zero,mini_attempts:9,sol_attempts:3},at(300),fullBudget).phase,'openai');
assert.notEqual(planPublicStep(task,{mini_attempts:99,sol_attempts:99,sol_completed:1},at(24*60),fullBudget).phase,'give_up');
assert.equal(planPublicStep(task,{...zero,mini_attempts:3},at(45),{allowGemini:true,allowOpenAI:false}).phase,'gemini');
assert.equal(planPublicStep(task,{...zero,mini_attempts:5},at(45),{allowGemini:false,allowOpenAI:false}).phase,'budget_guard');

assert.deepEqual(PUBLIC_POLICY.geminiScheduleMinutes,[5,15,25,35,45,60,90,120]);
assert.deepEqual(PUBLIC_POLICY.openaiScheduleMinutes,[45,90,120]);
assert.equal(PUBLIC_POLICY.overdueMinutes,120);
assert.equal(PUBLIC_POLICY.overdueGeminiEveryMinutes,60);
assert.equal(PUBLIC_POLICY.overdueOpenaiEveryMinutes,180);
assert.equal(PUBLIC_POLICY.eventBudgetUsd,0.25);
assert.equal(PUBLIC_POLICY.monthlyBudgetUsd,10);
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
assert.equal(nextPublicAttemptMs(task,'gemini',{phase:'deterministic'},at(5),{...zero,mini_attempts:1}),at(10));
assert.equal(nextPublicAttemptMs(task,'deterministic',{phase:'budget_guard'},at(46),{mini_attempts:3,sol_attempts:0}),at(51));
assert.equal(nextPublicAttemptMs(task,'gemini',{phase:'deterministic'},at(181),{mini_attempts:9,sol_attempts:3}),at(240));

const terra=publicSearchRequest(task,['renda'],{},'openai');
assert.equal(terra.model,'gpt-5.6-terra'); assert.equal(terra.max_tool_calls,6); assert.equal(terra.reasoning.effort,'low');
assert.equal(terra.tool_choice,'required');
assert.ok(terra.tools[0].filters.allowed_domains.includes('uol.com.br'));
assert.ok(terra.tools[0].filters.allowed_domains.includes('saopaulofc.net'));
assert.ok(terra.tools[0].filters.allowed_domains.includes('santosfc.com.br'));
assert.ok(terra.tools[0].filters.allowed_domains.length <= 100);
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
assert.equal(decision.allowGemini,true);
assert.equal(decision.reason,'event_budget_openai_guard');
const hard=publicBudgetDecision({}, {event:{estimatedUsd:0.01},month:{estimatedUsd:10.1}});
assert.equal(hard.allowOpenAI,false); assert.equal(hard.allowGemini,false); assert.equal(hard.hardStop,true);

assert.equal(parseEspnAttendance({gameInfo:{attendance:42317}}),42317);
assert.equal(parseEspnAttendance({gameInfo:{attendance:'61.532'}}),61532);
assert.equal(parseEspnAttendance({}),null);
assert.equal(isPublicComplete({publico:42000,renda:1500000}),true);
assert.equal(isPublicComplete({publico:42000,renda:null}),false);
assert.equal(taskEndMs({kickoff:'2026-09-20T18:00:00.000Z'}),Date.parse('2026-09-20T19:55:00.000Z'));
const msg=publicAlertMessage(task,{publico:null,publico_pagante:null,renda:null},{},{deterministic_checks:15,mini_attempts:5,sol_attempts:2},'not_found',{}, {event:{estimatedUsd:0.06},month:{estimatedUsd:1.84}}, new Date(at(180)).toISOString());
assert.match(msg.body,/busca automática CONTINUA/);
assert.match(msg.body,/Depois de 2h o Hunter tenta novamente a cada 1h/);
assert.doesNotMatch(msg.body,/Nenhuma nova busca automática será feita/);

// R10R9: falha Gemini em jogo >=45min precisa acionar OpenAI NO MESMO CICLO.
assert.equal(shouldImmediateOpenAiFallback({ageMinutes:120,budget:{allowOpenAI:true},geminiResult:{searchCalls:0,httpStatus:400,found:false},discoveredCount:0,refreshedFoundAny:false,complete:false}),true);
assert.equal(shouldImmediateOpenAiFallback({ageMinutes:20,budget:{allowOpenAI:true},geminiResult:{searchCalls:0,httpStatus:400,found:false},discoveredCount:0,refreshedFoundAny:false,complete:false}),false);
assert.equal(shouldImmediateOpenAiFallback({ageMinutes:20,forcedUpgrade:true,budget:{allowOpenAI:true},geminiResult:{searchCalls:0,httpStatus:400,found:false},discoveredCount:0,refreshedFoundAny:false,complete:false}),true);
assert.equal(shouldImmediateOpenAiFallback({ageMinutes:120,budget:{allowOpenAI:false},geminiResult:{searchCalls:0,httpStatus:400,found:false},discoveredCount:0,refreshedFoundAny:false,complete:false}),false);
assert.equal(shouldImmediateOpenAiFallback({ageMinutes:120,budget:{allowOpenAI:true},geminiResult:{searchCalls:1,httpStatus:200,found:true},discoveredCount:2,refreshedFoundAny:true,complete:true}),false);
assert.equal(shouldImmediateOpenAiFallback({ageMinutes:120,budget:{allowOpenAI:true},geminiResult:{searchCalls:1,httpStatus:200,found:true},discoveredCount:2,refreshedFoundAny:true,complete:false}),true);
console.log('postgame-fastlane v11 policy + circuit tests: PASS');

// ============================ R10R15 Match Identity Gate ============================
{
  const { evaluateSourceMatchIdentity, POSTGAME_SEARCH_PROFILE_VERSION } = await import('../src/postgame-search-profile.js');
  assert.equal(POSTGAME_SEARCH_PROFILE_VERSION, 8);

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
  assert.equal(gateRodadaAlvo.accepted, true);
  const parsedRodadaAlvo = extractPublicFromTextDeterministic(gateRodadaAlvo.window, 'https://ge.globo.com/gato-mestre/noticia/2026/10/07/publicos-da-29a-rodada.ghtml');
  assert.equal(parsedRodadaAlvo.publico, 23596, 'bloco anterior da página multijogo não pode contaminar público');
  assert.equal(parsedRodadaAlvo.publico_pagante, 22071);
  assert.equal(parsedRodadaAlvo.renda, 801180);

  const fonteBotVasco = 'Botafogo e Vasco se enfrentaram no Estádio Nilton Santos pela 29ª rodada. O clássico terminou Botafogo 1 x 2 Vasco. Público presente: 23.596. Público pagante: 22.071. Renda: R$ 801.180,00.';
  const gateBotVasco = evaluateSourceMatchIdentity(botVasco, fonteBotVasco, 'https://www.correiobraziliense.com.br/esportes/2026/10/7516875-botafogo-vasco.html');
  assert.equal(gateBotVasco.accepted, true);
  const parsedBotVasco = extractPublicFromTextDeterministic(gateBotVasco.window, 'https://www.correiobraziliense.com.br/esportes/2026/10/7516875-botafogo-vasco.html');
  assert.equal(parsedBotVasco.publico, 23596);
  assert.equal(parsedBotVasco.publico_pagante, 22071);
  assert.equal(parsedBotVasco.renda, 801180);
}
console.log('R10R15 match identity gate tests: PASS');
