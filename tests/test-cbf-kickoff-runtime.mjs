import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync('index.html','utf8');
const begin=html.indexOf('function aplicarCorrecoesKickoffOficial(');
const end=html.indexOf('\nasync function carregarJogos(',begin);
assert.ok(begin>=0 && end>begin,'Runtime CBF reconciliation must be present on homepage');
assert.match(html,/fetch\('dados-br\/ajustes-calendario\.json\?t='/);
assert.match(html,/state\.agendaJogos = aplicarCorrecoesKickoffOficial\(/);
const sandbox={};
vm.runInNewContext(html.slice(begin,end)+'\nthis.apply=aplicarCorrecoesKickoffOficial;',sandbox);
const corrections=JSON.parse(readFileSync('dados-br/ajustes-calendario.json','utf8')).ajustes;
const fix=corrections.find(x=>String(x.event_id)==='401841312');
assert.equal(fix.data_iso,'2026-11-18T21:30');
assert.match(fix.fonte_calendario,/^CBF oficial/);
const provisional={event_id:'401841312',estado:'pre',concluido:false,mandante:{nome:'Grêmio'},visitante:{nome:'Bahia'},data_iso:'2026-11-18T17:00:00-03:00'};
const actual=sandbox.apply([provisional],corrections)[0];
assert.equal(actual.data_iso,'2026-11-18T21:30:00-03:00');
assert.equal(actual.kickoff_oficial_cbf,true);
assert.equal(sandbox.apply([{...provisional,estado:'post',concluido:true}],corrections)[0].data_iso,provisional.data_iso,'FINAL cannot be rewritten');
assert.equal(sandbox.apply([{...provisional,mandante:{nome:'Flamengo'}}],corrections)[0].data_iso,provisional.data_iso,'fixture identity protected');
assert.equal(sandbox.apply([{...provisional,event_id:'401841999'}],corrections)[0].data_iso,provisional.data_iso,'unrelated fixture protected');
assert.equal(sandbox.apply([provisional],[{...fix,fonte_calendario:'ESPN'}])[0].data_iso,provisional.data_iso,'ESPN cannot impersonate CBF');
for(const path of ['jogos.json','dados-br/agenda-clubes-br.json','dados-br/calendario-completo.json']){
  const file=JSON.parse(readFileSync(path,'utf8'));
  const games=file.jogos||[];
  const matches=games.filter(x=>String(x.event_id)==='401841312');
  assert.equal(matches.length,1,path+': CBF fixture must be unique');
  assert.match(matches[0].data_iso,/^2026-11-18T21:30/,path+': source kickoff');
}
console.log('PASS: UI corrects stale ESPN 17h to official CBF 21h30; unrelated/FINAL fixtures preserved');
