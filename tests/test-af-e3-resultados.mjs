import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync('js/br-af-resultados.js', 'utf8');
const ctx = { window: {} };
vm.runInNewContext(code, ctx);
const api = ctx.window.FDGResultadosAF;
assert.ok(api && typeof api.render === 'function' && typeof api.decide === 'function');

const record = {
  identidade_partida: 'clube a|clube b', event_ids: ['123'], situacao: 'comprovado',
  mandante: 'Clube A', visitante: 'Clube B',
  inicio_factual: '2026-11-06T23:00:00+00:00',
  placar_final_auditado: { mandante: 1, visitante: 1 },
  placar_previsto: { mandante: 1, visitante: 1 },
  gols_projetados: { mandante: 1.3, visitante: 1.1 },
  probabilidades_ved_pct: { mandante: 46.3, empate: 27.3, visitante: 26.4 },
  palpite_resultado_top1: 'mandante',
  top3_placares: [
    { mandante: 1, visitante: 1, probabilidade_pct: 13.1663 },
    { mandante: 1, visitante: 0, probabilidade_pct: 12.7674 },
    { mandante: 0, visitante: 0, probabilidade_pct: 9.5435 }
  ],
  prova: { commit: 'a'.repeat(40), versao_modelo: 'AF-Previsão teste',
           gerado_em: '2026-11-05T21:00:00+00:00' },
};
const unavailable = {
  ...record, event_ids: ['456'], identidade_partida: 'clube c|clube d',
  mandante: 'Clube C', visitante: 'Clube D',
  situacao: 'sem_snapshot_prejogo_comprovavel'
};
const report = {
  schema_version: 1, temporada: 2026, status: 'ok', tipo: 'comparativo_resultados_af_previsao',
  resumo: { resultados_auditados: 2, previsoes_certificadas: 1, sem_snapshot_certificado: 1 },
  integridade: { hash_jogos: 'a'.repeat(64) },
  jogos: [record, unavailable]
};
api.validateDocument(report);
const game = {
  event_id: '123', data_iso: '2026-11-06T20:00',
  mandante: { nome: 'Clube A' }, visitante: { nome: 'Clube B' },
  placar_mandante: 1, placar_visitante: 1, estado: 'post'
};
let assessment = api.decide(game, report);
// Top-1 derrota, placar modal exato. NUNCA confundir as duas avaliações.
assert.equal(assessment.status, 'comprovado');
assert.equal(assessment.top1, false);
assert.equal(assessment.exact, true);
assert.equal(assessment.top3, true);
let html = api.render(game, report);
assert.match(html, /AF-Previsão/);
assert.match(html, /Placar previsto/);
assert.match(html, /1 × 1/);
assert.match(html, /13,2% desse placar/);
assert.match(html, /V\/E\/D não confirmado/);
assert.match(html, /Placar exato/);
assert.match(html, /Placar no Top-3/);
assert.match(html, /Conferir commit/);
assert.ok(html.startsWith('<details'));
assert.ok(html.endsWith('</details>'));
assert.equal((html.match(/class="af-e3-score-option/g) || []).length, 3);

const diff = { ...record, placar_final_auditado: { mandante: 2, visitante: 1 } };
const docs = { ...report, jogos: [diff, unavailable] };
assessment = api.decide({ ...game, placar_mandante: 2, placar_visitante: 1 }, docs);
assert.equal(assessment.top1, true);
assert.equal(assessment.exact, false);
assert.equal(assessment.top3, false);
assert.match(api.render({ ...game, placar_mandante: 2, placar_visitante: 1 }, docs), /Placar diferente/);

const wrongFinal = api.render({ ...game, placar_mandante: 3 }, report);
assert.match(wrongFinal, /Aferição suspensa/);
assert.doesNotMatch(wrongFinal, /Conferir commit/);
assert.match(api.render({ ...game, data_iso: '2026-11-07T20:00' }, report), /Aferição suspensa/);
assert.match(api.render({ ...game, visitante: {nome:'Clube C'} }, report), /Aferição suspensa/);
assert.match(api.render({ ...game, _provisorioESPN: true }, report), /após consolidação/);
assert.match(api.render({ ...game, event_id:'456', mandante: {nome:'Clube C'}, visitante:{nome:'Clube D'} }, report), /Sem previsão pré-jogo comprovável/);
assert.match(api.render({ ...game, event_id:'999', mandante: {nome:'X'}, visitante: {nome:'Y'} }, report), /Ainda não incluído na auditoria/);
// IDs ESPN alternativos podem ser aceitos por mandante/visitante, sem cruzar partidas.
assert.equal(api.decide({ ...game, event_id: 'novo-id' }, report).status, 'comprovado');

const src = readFileSync('index.html', 'utf8');
assert.match(src, /js\/br-af-resultados\.js\?v=20261110-e3/);
assert.match(src, /css\/br-af-resultados\.css\?v=20261110-e3/);
assert.match(src, /FDGResultadosAF\.render\(r, state\.afE3Resultados\)/);
assert.match(src, /\$\{afericaoHistorica\}\s*\$\{paginaResultado/);
assert.match(src, /if \(state\.afE3Resultados\)/);
assert.ok(src.indexOf('br-af-resultados.js?v=20261110-e3') < src.indexOf('function renderResultados()'));
const css = readFileSync('css/br-af-resultados.css', 'utf8');
assert.match(css, /min-height: 44px/);
assert.match(css, /max-width:480px/);
assert.match(css, /max-width:350px/);

const persisted = JSON.parse(readFileSync('dados-br/resultados-af-placares-2026.json', 'utf8'));
assert.equal(persisted.status, 'ok');
assert.equal(persisted.jogos.length, persisted.resumo.resultados_auditados);
assert.equal(persisted.jogos.filter(r => r.situacao === 'comprovado').length, persisted.resumo.previsoes_certificadas);
assert.ok(persisted.jogos.every(r => r.situacao === 'comprovado' || !('placar_previsto' in r)));
const real = persisted.jogos.find(r => r.situacao === 'comprovado' && r.event_ids.length);
assert.ok(real && real.prova && real.top3_placares.length === 3);
assert.equal(api.decide({
  event_id: real.event_ids[0], data_iso: real.inicio_factual,
  mandante: {nome:real.mandante}, visitante: {nome:real.visitante},
  placar_mandante: real.placar_final_auditado.mandante,
  placar_visitante: real.placar_final_auditado.visitante
}, persisted).status, 'comprovado');
console.log('AF E3 TESTS PASS: Top-1 independente de placar, Top-3, ausência de prova e proteção contra divergência de jogo.');
