import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Regressão de todas as superfícies que exibem chances matemáticas.
const index = fs.readFileSync('index.html', 'utf8');
const start = index.indexOf('function metasObjetivosChance(prob, tipo) {');
const end = index.indexOf('\nfunction metasObjetivosCombinacao(', start);
assert.ok(start >= 0 && end > start, 'Funções de objetivos não localizadas');
const {metasObjetivosChance, metasObjetivosProva, metasObjetivosFormatarChance} =
  vm.runInNewContext(index.slice(start, end) +
    '\n({metasObjetivosChance,metasObjetivosProva,metasObjetivosFormatarChance})');

const clubsJs = fs.readFileSync('js/br-clubes.js', 'utf8');
const a = clubsJs.indexOf('  function probDisplay(prob, key){');
const b = clubsJs.indexOf('  function paginaClubeUrl(', a);
assert.ok(a >= 0 && b > a, 'Formatador de probabilidades dos clubes não localizado');
const {probDisplay} = vm.runInNewContext(clubsJs.slice(a, b) + '\n({probDisplay})');

const snap = JSON.parse(fs.readFileSync('dados-br/probabilidades-brasileirao.json', 'utf8'));
assert.equal(snap.clubes.length, 20);
const get = name => snap.clubes.find(row => row.clube === name);
for(const name of ['Flamengo','Palmeiras']){
  const t=get(name);
  assert.ok(t, name);
  assert.equal(probDisplay(t,'libertadores'),'100%');
  assert.equal(metasObjetivosFormatarChance(metasObjetivosChance(t,'libertadores'),metasObjetivosProva(t,'libertadores')),'100%');
  assert.equal(metasObjetivosFormatarChance(metasObjetivosChance(t,'sul_americana_ou_melhor'),metasObjetivosProva(t,'sul_americana_ou_melhor')),'100%');
  assert.equal(metasObjetivosFormatarChance(metasObjetivosChance(t,'permanencia'),metasObjetivosProva(t,'permanencia')),'100%');
}
const chap=get('Chapecoense');
for(const objective of ['titulo','libertadores','sul_americana_ou_melhor','permanencia']){
  assert.equal(metasObjetivosFormatarChance(metasObjetivosChance(chap,objective),metasObjetivosProva(chap,objective)),'0%',objective);
}
assert.equal(metasObjetivosFormatarChance(99.96),'99,96%','Não arredondar para 100,0%');
assert.equal(metasObjetivosFormatarChance(100),'~100%','100/100 sem prova não é certeza');
assert.equal(metasObjetivosFormatarChance(0),'~0%','0 observações sem prova não é impossível');
assert.equal(probDisplay({probabilidades_pct:{libertadores:100}},'libertadores'),'~100%');
assert.equal(probDisplay({probabilidades_pct:{libertadores:0}},'libertadores'),'~0%');

for(const club of snap.clubes){
  for(const field of ['campeao','libertadores','sul_americana','sem_competicao_continental','rebaixamento']){
    const detail=club.probabilidades_detalhes[field];
    if(detail.certeza_estrutural===true)assert.equal(probDisplay(club,field),'100%',club.clube+'/'+field);
    if(detail.impossivel_estruturalmente===true)assert.equal(probDisplay(club,field),'0%',club.clube+'/'+field);
  }
}
console.log('PASS: 20 clubes, objetivos personalizados, classificação continental e distinção exato/empírico');
