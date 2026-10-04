import assert from 'node:assert/strict';
import { highlightTitleValid, retryMinutes, validatePublicPayload, extractPublicFromTextDeterministic, extractOpenAISources } from '../src/postgame-fastlane.js';

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



// v8 Source Recovery: as URLs do web_search existem independentemente de o
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
console.log('postgame-fastlane tests: PASS');

// ============================ Política v8 ============================
import {
  PUBLIC_POLICY, planPublicStep, nextPublicAttemptMs, publicSearchRequest,
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

assert.equal(nextPublicAttemptMs(task,'deterministic',{phase:'gemini'},at(4),zero),at(5));
assert.equal(nextPublicAttemptMs(task,'gemini',{phase:'deterministic'},at(5),{...zero,mini_attempts:1}),at(10));
assert.equal(nextPublicAttemptMs(task,'deterministic',{phase:'budget_guard'},at(46),{mini_attempts:3,sol_attempts:0}),at(51));
assert.equal(nextPublicAttemptMs(task,'gemini',{phase:'deterministic'},at(181),{mini_attempts:9,sol_attempts:3}),at(240));

const terra=publicSearchRequest(task,['renda'],{},'openai');
assert.equal(terra.model,'gpt-5.6-terra'); assert.equal(terra.max_tool_calls,6); assert.equal(terra.reasoning.effort,'low');
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
console.log('postgame-fastlane v8 policy tests: PASS');
