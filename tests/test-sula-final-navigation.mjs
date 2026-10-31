import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// A aba JOGOS principal não pode herdar "Hoje" / "7 dias" e esconder uma final
// já publicada para 21 de novembro quando a competição Sul-Americana é escolhida.
const main = readFileSync('index.html','utf8');
const begin = main.indexOf('function setFiltroCompeticaoJogos(chave) {');
const end = main.indexOf('function setFiltroPeriodoJogos(periodo)',begin);
assert.ok(begin>=0 && end>begin,'função de filtro principal presente');
const filterFn = main.slice(begin,end);
function runMainTest(hasGameInCurrentRange) {
  const state={jogosFiltroCompeticao:'todos',jogosFiltroPeriodo:'hoje',jogosFiltroData:'',jogosFiltroTime:''};
  let rendered=0;
  const ctx={
    state,
    BR_JOGOS_COMPETICOES:{todos:{},sul_americana:{}},
    jogosUnificadosBase:()=>[{competicao_chave:'sul_americana',event_id:'401913961',data_iso:'2026-11-21T20:00:00-03:00'}],
    jogoPassaPeriodo:()=>hasGameInCurrentRange,
    renderJogos:()=>{rendered++;}
  };
  vm.runInNewContext(filterFn+"\nsetFiltroCompeticaoJogos('sul_americana');",ctx);
  assert.equal(state.jogosFiltroCompeticao,'sul_americana');
  assert.equal(state.jogosFiltroPeriodo,hasGameInCurrentRange?'hoje':'todos');
  assert.equal(rendered,1);
}
runMainTest(false);
runMainTest(true);

// A agenda standalone usa filtros por mês: Outubro sem a final deve avançar
// automaticamente para Novembro ao selecionar a Sul-Americana.
const agenda=readFileSync('js/br-agenda.js','utf8');
const a=agenda.indexOf('competitionBox.addEventListener("click",');
const b=agenda.indexOf('monthBox.addEventListener("click"',a);
assert.ok(a>=0&&b>a,'callback standalone presente');
const state={competition:'todos',month:'2026-10',games:[
  {competicao_chave:'brasileirao',data_iso:'2026-10-31T16:00:00-03:00'},
  {competicao_chave:'sul_americana',data_iso:'2026-11-21T20:00:00-03:00'}
]};
let handler=null;
let renders=0;
const context={
  competitionBox:{addEventListener:(_name,cb)=>{handler=cb;}},
  state,
  parseDate:(value)=>new Date(value),
  monthKey:(date)=>date.toISOString().slice(0,7),
  render:()=>{renders++;},
  Date,
  Set,Array
};
vm.runInNewContext(agenda.slice(a,b),context);
assert.equal(typeof handler,'function');
handler({target:{closest:()=>({getAttribute:()=> 'sul_americana'})}});
assert.equal(state.competition,'sul_americana');
assert.equal(state.month,'2026-11');
assert.equal(renders,1);
console.log('SULA FINAL NAVIGATION: principal filter and standalone month auto-selection PASS');
