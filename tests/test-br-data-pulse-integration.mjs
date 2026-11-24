import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const html=read('estatisticas.html'),source=read('js/br-estatisticas.js');
for(const tab of ['probabilidades','artilheiros','assistencias','jogos','gols-clube','campeonato','desempenho']){
 assert.ok(html.includes('id="data-pulse-'+tab+'"'),tab);
 assert.ok(source.includes('"'+tab+'"'),tab);
}
for(const page of ['index.html','estatisticas.html','acuracia.html']){
 assert.match(read(page),/br-data-pulse\.css\?v=20261124-r36r6final/);
 assert.match(read(page),/br-data-pulse\.js\?v=20261124-r36r6final/);
}
assert.match(read('index.html'),/coverageLabel:"Resultados consolidados"/);
assert.match(read('index.html'),/updatedAt:state\._atualizadoEmServidor,processed:jogosTabela/);
assert.match(read('js/br-acuracia.js'),/processed:proof\?proof\.processed:sample,expected:proof\?proof\.expected:null/);
assert.match(read('js/br-acuracia-placares-e4.js'),/pulse\.accuracyProof\(reference,e3,state\.payload\)/);
const ctx=vm.createContext({});
vm.runInContext(read('js/br-data-pulse.js'),ctx);
assert.match(ctx.FDGDataPulse.render({processed:176,expected:null}),/>176<\/strong>/);
assert.match(source,/const totalGames = totalFinishedGames\(\)/);
assert.match(source,/pulse\.reconcile\(r,t\)/);
console.log('PASS Data Pulse integration: 10 sections');

assert.ok(source.includes('completude?.[tab==="artilheiros"?"artilharia":"assistencias"]'));
