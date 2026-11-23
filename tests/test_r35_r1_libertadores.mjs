import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read=(path)=>JSON.parse(readFileSync(new URL('../'+path,import.meta.url),'utf8'));
const table=read('tabela.json').tabela;
const odds=read('dados-br/probabilidades-brasileirao.json');
const copa=read('dados-br/competicoes-af-previsao/copa-do-brasil.json');
const libertadores=read('dados-br/competicoes-af-previsao/libertadores.json');
const sulamericana=read('dados-br/competicoes-af-previsao/sul-americana.json');
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');

const start=html.indexOf('// HOTFIX R35-R1 — zona garantida');
const end=html.indexOf('function renderTabela() {',start);
assert.ok(start>0&&end>start,'libertadores dynamic function must be included in public page');
const code=html.slice(start,end);
const sandbox={state:{
  tabela:table,probabilidadesBrasileirao:odds,
  vagasLibertadores2027:{copa,libertadores,sulamericana}
}};
const evaluate=(patch={})=>{
  const state=structuredClone(sandbox.state);
  if (patch.table) state.tabela=patch.table;
  if (patch.copa!==undefined) state.vagasLibertadores2027.copa=patch.copa;
  if (patch.libertadores) state.vagasLibertadores2027.libertadores=patch.libertadores;
  if (patch.sulamericana) state.vagasLibertadores2027.sulamericana=patch.sulamericana;
  const ctx=vm.createContext({state});
  return vm.runInContext(code+'; vagasLibertadores2027(state.tabela)',ctx);
};
const withChampion=(source,team)=>{
  const j=structuredClone(source);
  j.eventos=j.eventos.map(e=>Number(e.fase_ordem)===900?
    {...e,estado:'post',concluido:true,vencedor:team}:e);
  return j;
};

test('R35 minimum confirmed zone is G6 with 4 groups + 2 preliminary',()=>{
 const zone=evaluate();
 assert.equal(zone.guaranteedG6,true);
 assert.equal(zone.direct,4);
 assert.equal(zone.preliminary,2);
 assert.equal(zone.guarantee,6);
 assert.equal(zone.conditionalMax,8);
 assert.ok(html.includes('zona-libertadores-condicional'));
 assert.ok(html.includes('tabela-vaga-badge'));
 assert.ok(html.includes('vagasLibertadores2027(state.tabela || [])'));
});
test('future group reallocation is conditional, never inferred from a finalist alone',()=>{
 assert.equal(evaluate({copa:null}).guarantee,5);
 assert.equal(evaluate({libertadores:withChampion(libertadores,'Estudiantes')}).guarantee,6);
 assert.equal(evaluate({libertadores:withChampion(libertadores,'Palmeiras')}).guarantee,7);
 const gremioDown=table.map(x=>x.time==='Grêmio'?{...x,pos:18,jogos:38}:x);
 assert.equal(evaluate({table:gremioDown}).guarantee,7);
 assert.equal(evaluate({table:gremioDown,libertadores:withChampion(libertadores,'Palmeiras')}).guarantee,8);
 const g9=[...gremioDown.map(x=>x.time==='Atlético-MG'?{...x,pos:7}:x)];
 assert.equal(evaluate({table:g9,libertadores:withChampion(libertadores,'Palmeiras'),sulamericana:withChampion(sulamericana,'Atlético-MG')}).guarantee,9);
 assert.equal(evaluate({table:g9,libertadores:withChampion(libertadores,'Palmeiras'),sulamericana:withChampion(sulamericana,'Boca Juniors')}).guarantee,8);
});
test('mathematical 100% certified from published proof, not rounding',()=>{
 assert.equal(odds.simulacao.quantidade,2_000_000);
 const flu=odds.clubes.find(t=>t.clube==='Fluminense');
 assert.equal(flu.probabilidades_pct.libertadores,100);
 assert.equal(flu.probabilidades_detalhes.libertadores.certeza_estrutural,true);
 assert.equal(flu.probabilidades_detalhes.libertadores.exibicao,'100%');
 assert.ok(flu.situacao_matematica.limite_posicao_pior>=1 && flu.situacao_matematica.limite_posicao_pior<=6);
 // O pior cenário pode melhorar para 5º após novos resultados; G6 permanece certo.
 assert.equal(flu.probabilidades_detalhes.g6.certeza_estrutural,true);
 const cru=odds.clubes.find(t=>t.clube==='Cruzeiro');
 assert.equal(cru.probabilidades_detalhes.g4.certeza_estrutural,true);
 assert.equal(cru.probabilidades_detalhes.g4.exibicao,'100%');
});
test('all executable inline scripts parse (including dynamically added zone)',()=>{
 const tags=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(([,attrs,js])=>!/\bsrc\s*=/.test(attrs)&&!/application\/ld\+json/.test(attrs)&&js.trim());
 assert.ok(tags.length>=5);
 for(const [i,tag] of tags.entries())assert.doesNotThrow(()=>new vm.Script(tag[2],{filename:'inline-'+i+'.js'}));
});

test('Boca 2-0 Atlético-MG encerra a via Sul-Americana e G9 condicional',()=>{
 const f=sulamericana.eventos.find(e=>Number(e.fase_ordem)===900);
 assert.equal(f?.concluido,true);
 assert.equal(f?.vencedor,'Boca Juniors');
 assert.equal(f?.mandante?.nome,'Atlético-MG');
 assert.equal(f?.mandante?.placar,0);
 assert.equal(f?.visitante?.placar,2);
 const zone=evaluate();
 assert.equal(zone.conditionalMax,8);
 assert.ok(!zone.pending.some(x=>x.includes('título do Atlético-MG')));
 const hypothetical=withChampion(sulamericana,'Atlético-MG');
 assert.equal(evaluate({sulamericana:hypothetical}).conditionalMax,9);
 const galo=odds.clubes.find(x=>x.clube==='Atlético-MG');
 assert.ok(galo);
 assert.equal(galo.decomposicao_chances.libertadores.vias.via_titulo_sul_americana.ocorrencias,0);
});
