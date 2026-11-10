import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const apiSource = readFileSync('js/br-acuracia-placares-e4.js', 'utf8');
const fakeDoc = { readyState: 'loading', addEventListener() {} };
const ctx = { window: {}, document: fakeDoc, console };
vm.runInNewContext(apiSource, ctx);
const api = ctx.window.FDGAccuracyScoresE4;
assert.ok(api && typeof api.validate === 'function' && typeof api.summarize === 'function');

const doc = JSON.parse(readFileSync('dados-br/acuracia-placares-af-2026.json', 'utf8'));
api.validate(doc);
const list = doc.jogos;
const summary = api.summarize(list);
assert.equal(summary.jogos, doc.metricas.jogos);
assert.equal(summary.jogos, 157);
assert.equal(doc.escopo.resultados_finais_auditados, 339);
assert.equal(doc.escopo.sem_prova_historica, 182);
assert.equal(summary.placares_exatos, doc.metricas.placares_exatos);
assert.equal(summary.top3_confirmados, doc.metricas.top3_confirmados);
assert.ok(summary.top3_confirmados >= summary.placares_exatos);
assert.ok(Math.abs(summary.erro_absoluto_medio_gols_por_equipe -
                  doc.metricas.erro_absoluto_medio_gols_por_equipe) < .00011);
assert.ok(Math.abs(summary.probabilidade_media_modal_pct -
                  doc.metricas.probabilidade_media_modal_pct) < .011);
assert.ok(Math.abs(summary.probabilidade_media_top3_pct -
                  doc.metricas.probabilidade_media_top3_pct) < .011);

const probabilities = [
  ['modal','calibracao_modal'],['top3','calibracao_top3']
];
for (const [type, target] of probabilities) {
  const bins = api.statsBins(list,type);
  const published = doc.metricas[target];
  assert.equal(bins.length, published.length);
  assert.equal(bins.reduce((a,b)=>a+b.amostra,0), 157);
  for (let i=0;i<bins.length;i++) {
    assert.equal(bins[i].amostra,published[i].amostra);
    assert.equal(bins[i].ocorrencias,published[i].ocorrencias);
    assert.ok(Math.abs(bins[i].probabilidade_media_pct -
                       published[i].probabilidade_media_pct)<.011);
  }
}
const allRounds = doc.por_rodada.reduce((a,x)=>a+x.metricas.jogos,0);
const allClubs = doc.por_clube.reduce((a,x)=>a+x.metricas.jogos,0);
assert.equal(allRounds,157);
assert.equal(allClubs,314);
for (const row of doc.por_rodada) {
  assert.equal(row.metricas.jogos, list.filter(g=>g.rodada===row.rodada).length);
}
for (const row of doc.por_clube) {
  assert.equal(row.metricas.jogos,
    list.filter(g=>g.mandante===row.clube||g.visitante===row.clube).length);
}
const club = doc.por_clube[0].clube;
const round = String(doc.por_rodada[0].rodada);
const selected = list.filter(g=>(g.mandante===club||g.visitante===club)&&String(g.rodada)===round);
const filtered = api.summarize(selected);
assert.equal(filtered.jogos,selected.length);
if (selected.length) assert.ok(filtered.top3_confirmados>=filtered.placares_exatos);
const tampered = structuredClone(doc);
tampered.jogos[0].acerto_exato = true;
tampered.jogos[0].acerto_top3 = false;
assert.throws(()=>api.validate(tampered), /certificação/);
const invalid = structuredClone(doc);
invalid.metricas.jogos++;
assert.throws(()=>api.validate(invalid), /Base E4/);
const html = readFileSync('acuracia.html','utf8');
for(const id of ['af-e4-title','af-e4-club','af-e4-round','af-e4-summary',
  'af-e4-calibration-type','af-e4-calibration','af-e4-rounds','af-e4-integrity']) {
  assert.ok(html.includes('id="'+id+'"'), 'ausência na interface: '+id);
}
assert.ok(html.indexOf('id="af-e4-title"') > html.indexOf('id="accuracy-games-title"'));
assert.ok(html.indexOf('id="af-e4-title"') < html.indexOf('id="accuracy-timeline-title"'));
assert.ok(html.includes('br-acuracia-placares-e4.css?v=20261110-e4'));
assert.ok(html.includes('br-acuracia-placares-e4.js?v=20261110-e4'));
assert.ok(!html.includes('Top-3: 100% de acerto'));
console.log('AF E4 TESTS PASS:', doc.metricas.jogos, 'jogos,',
  doc.metricas.placares_exatos, 'exatos,',doc.metricas.top3_confirmados,
  'Top-3. Filtros e calibração conciliados.');
