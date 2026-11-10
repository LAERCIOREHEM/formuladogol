import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
assert.match(html, /Placar no Top-3/);
assert.equal((html.match(/class="af-e3-featured /g) || []).length, 1);
assert.match(html, /✓ Placar no Top-3/);
assert.ok(html.indexOf('af-e3-featured') < html.indexOf('af-e3-details'));
assert.match(html, /af-e3-breakdown/);
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
assert.match(api.render({ ...game, placar_mandante: 2, placar_visitante: 1 }, docs), /Acertou o vencedor/);
assert.match(api.render({ ...game, placar_mandante: 2, placar_visitante: 1 }, docs), /Placar exato não confirmado/);

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

// Dois casos REAIS auditados no snapshot E1/E3 (sem estimativas inventadas).
const historical = JSON.parse(readFileSync('dados-br/resultados-af-placares-2026.json','utf8'));
function lookup(home,away){return historical.jogos.find(x=>x.mandante===home&&x.visitante===away&&x.situacao==='comprovado');}
function toResult(r){return {
  event_id:r.event_ids[0],data_iso:r.inicio_factual,
  mandante:{nome:r.mandante},visitante:{nome:r.visitante},
  placar_mandante:r.placar_final_auditado.mandante,
  placar_visitante:r.placar_final_auditado.visitante
};}
const vitoriaFlu=lookup('Vitória','Fluminense');
const saoPauloCor=lookup('São Paulo','Corinthians');
assert.ok(vitoriaFlu&&saoPauloCor,'Exemplos históricos ausentes');
const vitoriaDecision=api.decide(toResult(vitoriaFlu),historical);
const saoPauloDecision=api.decide(toResult(saoPauloCor),historical);
assert.equal(vitoriaDecision.top1,true);
assert.equal(vitoriaDecision.exact,false);
assert.equal(api.highlight(vitoriaDecision).label,'Acertou o vencedor');
assert.match(api.render(toResult(vitoriaFlu),historical),/✓ Acertou o vencedor/);
assert.equal(saoPauloDecision.top1,false);
assert.equal(saoPauloDecision.exact,false);
assert.equal(saoPauloDecision.top3,true);
assert.equal(api.highlight(saoPauloDecision).label,'Placar no Top-3');
assert.match(api.render(toResult(saoPauloCor),historical),/✓ Placar no Top-3/);
assert.match(api.render(toResult(saoPauloCor),historical),/V\/E\/D não confirmado/);
assert.match(api.render(toResult(saoPauloCor),historical),/Placar exato não confirmado/);
const allBad={...saoPauloDecision,top3:false};
assert.equal(api.highlight(allBad).label,'Sem acerto principal');

const src = readFileSync('index.html', 'utf8');
assert.match(src, /js\/br-af-resultados\.js\?v=20261110-ux-r1/);
assert.match(src, /css\/br-af-resultados\.css\?v=20261110-ux-r1/);
assert.match(src, /FDGResultadosAF\.render\(r, state\.afE3Resultados\)/);
assert.match(src, /\$\{afericaoHistorica\}\s*\$\{paginaResultado/);
assert.match(src, /if \(state\.afE3Resultados\)/);
assert.ok(src.indexOf('br-af-resultados.js?v=20261110-ux-r1') < src.indexOf('function renderResultados()'));
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
// Regressão ponta a ponta usando os 339 resultados reais, não só exemplos sintéticos.
const actualResults = readFileSync('resultados.json');
const actualDocument = JSON.parse(actualResults.toString('utf8'));
const sourceDigest = createHash('sha256').update(actualResults).digest('hex');
const matches = { comprovado: 0, sem_prova: 0, inconsistente: 0, nao_auditado: 0, other: 0 };
for (const game of actualDocument.resultados || []) {
  const classification = api.decide(game, persisted);
  if (classification.status === 'comprovado') matches.comprovado++;
  else if (classification.status === 'sem_prova') matches.sem_prova++;
  else if (classification.status === 'inconsistente') matches.inconsistente++;
  else if (classification.status === 'nao_auditado') matches.nao_auditado++;
  else matches.other++;
}
assert.ok(matches.comprovado > 0, 'Nenhuma previsão E1 é exibível nos resultados reais');
if (sourceDigest === JSON.parse(readFileSync('dados-br/auditoria-historica-placares-af-2026.json', 'utf8'))
    .fontes_resultados.arquivo_sha256) {
  assert.equal(matches.comprovado, 157, 'Snapshot de resultados idêntico à E1 precisa exibir 157 provas');
  assert.equal(matches.sem_prova, 182, 'Snapshot idêntico precisa preservar 182 lacunas');
  assert.equal(matches.inconsistente, 0);
  assert.equal(matches.nao_auditado, 0);
}
console.log('E3 MATCHING REAL:', matches, 'fonte de resultados idêntica à E1:', sourceDigest === persisted.origem.sha256_arquivo);
console.log('AF E3 TESTS PASS: Top-1 independente de placar, Top-3, lacunas, correspondência real e bloqueio por divergência de jogo.');
