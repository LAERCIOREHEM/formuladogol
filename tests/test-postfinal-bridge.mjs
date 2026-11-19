import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const bridge = require('../js/br-final-canonical-bridge.js');

const row = (id, home, away, hs, as) => ({
  event_id: id, estado:'post', mandante:{nome:home}, visitante:{nome:away},
  placar_mandante:hs,placar_visitante:as, data_iso:'2026-11-18T20:30'
});
const final = {eventId:'401841313',mandante:'Flamengo',visitante:'Athletico-PR',
  placarMandante:2,placarVisitante:1,final:true};
const published = [row('1','A','B',0,0)];
const canonical = {fonte:'ESPN',total_resultados:2,resultados:[
  ...published,row('401841313','Flamengo','Athletico-PR',2,1)]};
const odds = {status:'ok',base_corrente:{partidas_concluidas:2,partidas_totais:380},
  clubes:Array.from({length:20}, (_,i)=>({clube:'C'+i}))};
const clubs=Array.from({length:20},(_,i)=>({time:'C'+i,jogos:i<4?1:0}));
const table={fonte:'ESPN',tabela:clubs};
const waiting=bridge.missingFinals({a:final},published,x=>x.final);
assert.equal(waiting.length,1);
assert.equal(waiting[0].id,'401841313');
assert.ok(bridge.reconcile({results:canonical,probabilities:odds,table,waiting,currentCount:1}));
assert.equal(bridge.reconcile({results:canonical,probabilities:{...odds,base_corrente:{partidas_concluidas:1,partidas_totais:380}},table,waiting,currentCount:1}),null);
assert.equal(bridge.reconcile({results:{...canonical,total_resultados:1},probabilities:odds,table,waiting,currentCount:1}),null);
assert.equal(bridge.reconcile({results:canonical,probabilities:odds,table,waiting:[{...waiting[0],hs:3}],currentCount:1}),null);
assert.equal(bridge.reconcile({results:canonical,probabilities:odds,table:{...table,tabela:[...clubs.slice(1)]},waiting,currentCount:1}),null);
assert.equal(bridge.reconcile({results:canonical,probabilities:odds,table,waiting,currentCount:3}),null);
assert.equal(bridge.missingFinals({a:{...final,final:false}},published,x=>x.final).length,0);
assert.equal(bridge.missingFinals({a:final},canonical.resultados,x=>x.final).length,0);
const responses={
  'resultados.json':canonical,
  'dados-br/probabilidades-brasileirao.json':odds,
  'tabela.json':table,
};
let calls=0;
const fetcher=async url=>{calls++;const key=Object.keys(responses).find(x=>url.includes('/'+x+'?'));assert.ok(key);return {ok:true,json:async()=>responses[key]}};
const result=await bridge.check({liveMap:{a:final},publishedRows:published,currentCount:1,isFinal:x=>x.final,fetcher,now:Date.now()+500000});
assert.ok(result);
const duplicate=await bridge.check({liveMap:{a:final},publishedRows:published,currentCount:1,isFinal:x=>x.final,fetcher,now:Date.now()+500001});
assert.equal(duplicate,null);assert.equal(calls,3);
console.log('PASS FINAL bridge: matches ESPN identity, score, 20-club standings and 380-game AF; avoids regressions and duplicates');
