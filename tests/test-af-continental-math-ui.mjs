import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code=fs.readFileSync('js/br-estatisticas.js','utf8');
const begin=code.indexOf('  function probabilityTooltip(detail) {');
const end=code.indexOf('  // ────────────────────────────────────────────────────────────────────\n  // CLASSIFICAÇÃO CORRENTE',begin);
assert.ok(begin>0 && end>begin,'UI function extraction anchors');
const source=code.slice(begin,end);
const {probabilityTooltip,probabilityDisplayText,continentalDisplayTriplet}=vm.runInNewContext(
  source+'\n({probabilityTooltip,probabilityDisplayText,continentalDisplayTriplet});',
  {number:(x,d=1)=>Number(x).toLocaleString('pt-BR',{minimumFractionDigits:d,maximumFractionDigits:d})}
);
const data=JSON.parse(fs.readFileSync('dados-br/probabilidades-brasileirao.json','utf8'));
const chap=data.clubes.find(x=>x.clube==='Chapecoense');
const triplet=continentalDisplayTriplet(chap);
assert.deepEqual(JSON.parse(JSON.stringify(triplet)),{
  libertadores:'0%',sul_americana:'0%',sem_competicao_continental:'100%'
},'UI must show exact 0/0/100 without approximation');
assert.equal(probabilityDisplayText(chap.probabilidades_detalhes.rebaixamento,100),'100%');
assert.equal(probabilityDisplayText(chap.probabilidades_detalhes.libertadores,0),'0%');
assert.equal(probabilityDisplayText(chap.probabilidades_detalhes.sem_competicao_continental,100),'100%');
for(const field of ['libertadores','sul_americana','sem_competicao_continental','rebaixamento']){
  const tooltip=probabilityTooltip(chap.probabilidades_detalhes[field]);
  assert.ok(/matematicamente/i.test(tooltip),field+' tooltip should explain the proof');
  assert.ok(!/ocorrências em/i.test(tooltip),field+' tooltip should not present simulations as mathematical evidence');
}
const empirical=structuredClone(chap);
for(const f of ['libertadores','sul_americana','sem_competicao_continental']){
  const d=empirical.probabilidades_detalhes[f];
  d.certeza_estrutural=false;
  d.impossivel_estruturalmente=false;
  d.possivel_estruturalmente=true;
  d.exibicao=f==='sem_competicao_continental'?'>99,999%':'<0,001%';
}
const approximated=continentalDisplayTriplet(empirical);
assert.notEqual(approximated.sem_competicao_continental,'100%',
  'simulation-only 2 million/2 million must NOT be shown as mathematical certainty');
for (const name of ['Flamengo','Palmeiras']) {
  const club=data.clubes.find(x=>x.clube===name);
  const labels=JSON.parse(JSON.stringify(continentalDisplayTriplet(club)));
  assert.deepEqual(labels,{
    libertadores:'100%',sul_americana:'0%',sem_competicao_continental:'0%'
  },name+' must show mathematical 100/0/0');
  for(const field of ['libertadores','sul_americana','sem_competicao_continental']){
    const detail=club.probabilidades_detalhes[field];
    assert.equal(probabilityDisplayText(detail,club.probabilidades_pct[field]),labels[field]);
    assert.match(probabilityTooltip(detail),/matematicamente/i);
  }
}
assert.equal(probabilityDisplayText({exibicao:'100%',certeza_estrutural:false},100),'~100%',
 'Monte Carlo 2M/2M cannot be presented as mathematical certainty');
assert.equal(probabilityDisplayText({exibicao:'0%',possivel_estruturalmente:true},0),'~0%',
 'Monte Carlo 0/2M cannot be presented as impossible');
for(const club of data.clubes){
  const tri=continentalDisplayTriplet(club);
  for(const field of ['libertadores','sul_americana','sem_competicao_continental']){
    const meta=club.probabilidades_detalhes[field];
    if(meta.certeza_estrutural===true)assert.equal(tri[field],'100%',club.clube+':'+field);
    if(meta.impossivel_estruturalmente===true)assert.equal(tri[field],'0%',club.clube+':'+field);
    if(meta.certeza_estrutural!==true)assert.notEqual(tri[field],'100%',club.clube+':'+field+' false guarantee');
  }
}
console.log('PASS: All 20 teams preserve proof-based zero/one, Flamengo and Palmeiras 100/0/0');
console.log('PASS: Actual statistics UI renders Chapecoense 0% / 0% / 100% and proof tooltips');
