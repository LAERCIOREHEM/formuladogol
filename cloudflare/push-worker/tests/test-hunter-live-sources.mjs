import assert from 'node:assert/strict';
import { fetchSourceText } from '../src/ai-router.js';
import { evaluateSourceMatchIdentity, isCandidateEditorialAttendanceSource } from '../src/postgame-search-profile.js';
import { extractPublicFromTextDeterministic, validatePublicPayload } from '../src/postgame-fastlane.js';

const cases = [
  {
    task: { event_id:'401841297',league:'bra.1',home:'Remo',away:'Botafogo',kickoff:'2026-10-28T21:30:00-03:00',home_score:2,away_score:1,round:33,stadium:'Mangueirão' },
    urls: [
      'https://www.uol.com.br/esporte/ultimas-noticias/agencia/2026/10/28/botafogo-perde-a-segunda-seguida-e-ve-remo-quebrar-jejum-de-12-jogos-no-brasileirao.amp.htm',
      'https://www.oliberal.com/esportes/remo/xo-jejum-remo-vence-o-botafogo-e-segue-vivo-no-brasileirao-1.1188130',
      'https://www.romanews.com.br/esportes/remo-vence-o-botafogo-e-registra-publico-de-mais-de-13-mil-torcedores-no-mangueirao-1026',
    ],
    expected: {publico:13458,renda:378700}
  },
  {
    task: { event_id:'401841296',league:'bra.1',home:'Bahia',away:'São Paulo',kickoff:'2026-10-28T21:30:00-03:00',home_score:3,away_score:2,round:33,stadium:'Arena Fonte Nova' },
    urls: [
      'https://www.correiobraziliense.com.br/esportes/2026/10/amp/7529972-bahia-vence-o-sao-paulo-em-salvador-e-cola-no-g6-do-brasileirao.html',
      'https://acaopopular.net/jornal/bahia-vence-sao-paulo-em-jogo-de-5-gols-e-encosta-no-g-4-da-serie-a/',
    ],
    expected: {publico:21492,renda:628385.50}
  }
];

let overall=true;
for (const {task,urls,expected} of cases) {
  let successful=0;
  for (const url of urls) {
    const source=await fetchSourceText(url);
    if(!source.ok) {
      console.log(JSON.stringify({eventId:task.event_id,url,stage:'fetch',ok:false,reason:source.reason}));
      continue;
    }
    const identity=evaluateSourceMatchIdentity(task,source.text,source.url);
    if(!identity.accepted) {
      console.log(JSON.stringify({eventId:task.event_id,url,stage:'identity',ok:false,reason:[...identity.conflicts,...identity.reasons],score:identity.score,length:source.text.length}));
      continue;
    }
    const extracted=extractPublicFromTextDeterministic(identity.window,source.url);
    const documentaryCandidate=isCandidateEditorialAttendanceSource(source.url,task);
    const verified=validatePublicPayload(extracted,[source.url],task,{documentaryCandidate});
    const expectedMatches=Object.entries(expected).every(([k,v])=>Math.abs(Number(verified.values?.[k]??0)-v)<0.01);
    const ok=verified.accepted&&expectedMatches;
    console.log(JSON.stringify({eventId:task.event_id,url,stage:'extracted',ok,reason:verified.reason||'',publico:verified.values?.publico??null,pagantes:verified.values?.publico_pagante??null,renda:verified.values?.renda??null,sourceLength:source.text.length,windowLength:identity.window.length,score:identity.score}));
    if(!ok) {
      const locations=[...source.text.matchAll(/p[úu]blico|pagantes?|renda|bilheteria/gi)].slice(0,15).map(m=>({at:m.index,withinWindow:identity.window.includes(source.text.slice(m.index,m.index+10)),snippet:source.text.slice(Math.max(0,m.index-36),m.index+105).replace(/\\s+/g,' ')}));
      console.log('MISSING_LABELED_FIELDS '+JSON.stringify({eventId:task.event_id,url,sourceLength:source.text.length,windowLength:identity.window.length,examples:locations}));
    }
    if(ok)successful++;
  }
  console.log('SOURCE_COVERAGE '+task.event_id+': '+successful+'/'+urls.length);
  if(successful<1)overall=false;
}
assert.equal(overall,true,'nenhuma fonte real lida e validada para um dos dois jogos');
console.log('HOT SOURCE EXTRACTION: PASS');
