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
 assert.match(read(page),/br-data-pulse\.css\?v=20261124-r36r5c/);
 assert.match(read(page),/br-data-pulse\.js\?v=20261124-r36r5c/);
}
assert.match(read('index.html'),/coverageLabel:"Resultados consolidados"/);
assert.match(read('index.html'),/updatedAt:state\._atualizadoEmServidor,processed:jogosTabela/);
assert.match(read('js/br-acuracia.js'),/processed:sample,expected:null/);
const ctx=vm.createContext({});
vm.runInContext(read('js/br-data-pulse.js'),ctx);
assert.match(ctx.FDGDataPulse.render({processed:176,expected:null}),/>176<\/strong>/);
assert.match(source,/Math\.max\(Number\(completeness\.total_jogos_declarado\)\|\|0,totalFinishedGames\(\)\)/);
console.log('PASS Data Pulse integration: 10 sections');

assert.ok(source.includes('completude?.[tab==="artilheiros"?"artilharia":"assistencias"]'));
