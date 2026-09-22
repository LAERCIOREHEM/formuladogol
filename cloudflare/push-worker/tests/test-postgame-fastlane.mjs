import assert from 'node:assert/strict';
import { highlightTitleValid, retryMinutes, validatePublicPayload } from '../src/postgame-fastlane.js';

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

console.log('postgame-fastlane tests: PASS');

// ============================ Política v4 ============================
import {
  PUBLIC_POLICY, planPublicStep, nextPublicAttemptMs, publicSearchRequest,
  parseEspnAttendance, isPublicComplete, publicAlertMessage, taskEndMs
} from '../src/postgame-fastlane.js';

const END = Date.parse('2026-09-20T20:00:00.000Z');
const task = { event_id:'401841200', league:'bra.1', home:'Flamengo', away:'Bragantino', kickoff:'2026-09-20T18:00:00.000Z', final_at:'2026-09-20T20:00:00.000Z', home_score:2, away_score:1 };
const at=(min)=>END+min*60_000;
const zero={mini_attempts:0,sol_attempts:0,sol_completed:0};
assert.equal(planPublicStep(task,zero,at(1)).phase,'deterministic');
assert.equal(planPublicStep(task,zero,at(4.9)).phase,'deterministic');
assert.equal(planPublicStep(task,zero,at(5)).phase,'mini');
assert.equal(planPublicStep(task,{...zero,mini_attempts:1},at(6)).phase,'deterministic');
assert.equal(planPublicStep(task,{...zero,mini_attempts:1},at(12)).phase,'mini');
assert.equal(planPublicStep(task,{...zero,mini_attempts:2},at(22)).phase,'mini');
assert.equal(planPublicStep(task,{...zero,mini_attempts:3},at(35)).phase,'mini');
assert.equal(planPublicStep(task,{...zero,mini_attempts:4},at(35.1)).phase,'sol');
assert.equal(planPublicStep(task,{...zero,mini_attempts:1},at(45)).phase,'sol');
assert.equal(planPublicStep(task,zero,at(180)).phase,'mini');
assert.equal(planPublicStep(task,{...zero,mini_attempts:1},at(181)).phase,'sol');
assert.equal(planPublicStep(task,{mini_attempts:4,sol_attempts:1,sol_completed:1},at(46)).phase,'give_up');
assert.equal(planPublicStep(task,{mini_attempts:4,sol_attempts:3,sol_completed:0},at(60)).phase,'give_up');
assert.equal(nextPublicAttemptMs(task,'deterministic',{phase:'deterministic'},at(2),zero),at(4));
assert.equal(nextPublicAttemptMs(task,'deterministic',{phase:'mini'},at(4),zero),at(5));
assert.equal(nextPublicAttemptMs(task,'mini',{phase:'deterministic'},at(5),{...zero,mini_attempts:1}),at(7));
assert.equal(nextPublicAttemptMs(task,'deterministic',{phase:'mini'},at(11),{...zero,mini_attempts:1}),at(12));
assert.equal(nextPublicAttemptMs(task,'mini',{phase:'sol'},at(35),{...zero,mini_attempts:4}),at(45));
assert.equal(nextPublicAttemptMs(task,'sol',{phase:'sol'},at(46),{mini_attempts:4,sol_attempts:1}),at(51));
assert.deepEqual(PUBLIC_POLICY.miniScheduleMinutes,[5,12,22,35]);
assert.equal(PUBLIC_POLICY.miniMaxAttempts,4);
const mini=publicSearchRequest(task,['renda'],{},'mini');
assert.equal(mini.model,'gpt-4o-mini'); assert.equal(mini.max_tool_calls,1); assert.equal('reasoning' in mini,false);
const sol=publicSearchRequest(task,['renda'],{POSTGAME_OPENAI_MODEL:'gpt-5.6-sol'},'sol');
assert.equal(sol.model,'gpt-5.6-sol'); assert.equal(sol.max_tool_calls,6); assert.equal(sol.reasoning.effort,'medium');
assert.equal(parseEspnAttendance({gameInfo:{attendance:42317}}),42317);
assert.equal(parseEspnAttendance({gameInfo:{attendance:'61.532'}}),61532);
assert.equal(parseEspnAttendance({}),null);
assert.equal(isPublicComplete({publico:42000,renda:1500000}),true);
assert.equal(isPublicComplete({publico:42000,renda:null}),false);
assert.equal(taskEndMs({kickoff:'2026-09-20T18:00:00.000Z'}),Date.parse('2026-09-20T19:55:00.000Z'));
const msg=publicAlertMessage(task,{publico:42317,publico_pagante:null,renda:null},{publico:'https://espn'},{deterministic_checks:15,mini_attempts:4,sol_attempts:1},'not_found',{});
assert.match(msg.body,/IA econômica \(gpt-4o-mini\): 4/);
console.log('postgame-fastlane v4 policy tests: PASS');
