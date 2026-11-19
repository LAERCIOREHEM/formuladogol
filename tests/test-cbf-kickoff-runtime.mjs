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
// O evento muda de jogos/agenda (PRE) para resultados (FINAL).
// A antiga asserção exigia que um FINAL voltasse para jogos.json e derrubava
// o deploy todas as noites após o encerramento. Verificar ciclo de vida completo.
const matchId='401841312';
const readRows=path=>{
  const file=JSON.parse(readFileSync(path,'utf8'));
  const games=file.jogos||file.resultados||[];
  const ids=games.map(x=>String(x.event_id||''));
  assert.equal(new Set(ids).size,ids.length,path+': IDs duplicados');
  return games.filter(x=>String(x.event_id)===matchId);
};
const results=readRows('resultados.json');
const pending=readRows('jogos.json');
const agenda=readRows('dados-br/agenda-clubes-br.json');
const archive=readRows('dados-br/calendario-completo.json');
assert.equal(archive.length,1,'calendário completo preserva uma entrada para o evento');
assert.match(archive[0].data_iso,/^2026-11-18T21:30/,'calendário mantém kickoff oficial CBF');
assert.equal(results.length+pending.length,1,'evento deve constar em exatamente uma fase: PRE ou FINAL');
if(results.length){
  assert.equal(results[0].estado,'post','FINAL confirmado pela fonte');
  assert.equal(pending.length,0,'FINAL não pode voltar a jogos.json');
  assert.equal(agenda.length,0,'FINAL não pode voltar à agenda futura');
  assert.equal(archive[0].estado,'post','calendário registra fase final');
  assert.equal(archive[0].concluido,true,'calendário registra conclusão real');
  assert.match(results[0].data_iso,/^2026-11-18T21:30/,'resultado preserva kickoff CBF');
  assert.ok(Number.isInteger(results[0].placar_mandante));
  assert.ok(Number.isInteger(results[0].placar_visitante));
  // calendario-completo.json guarda fase, data e identidades, não placar.
  assert.equal(results[0].mandante.nome,archive[0].mandante);
  assert.equal(results[0].visitante.nome,archive[0].visitante);
}else{
  assert.equal(pending.length,1,'PRE deve constar exatamente uma vez em jogos.json');
  assert.equal(agenda.length,1,'PRE deve constar exatamente uma vez na agenda futura');
  assert.equal(pending[0].estado,'pre');
  for (const entry of [...pending,...agenda]) {
    assert.match(entry.data_iso,/^2026-11-18T21:30/,'kickoff oficial CBF na agenda');
  }
}
console.log('PASS: horário oficial preservado e ciclo PRE → FINAL consistente nas quatro fontes');
