import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('js/br-af-scorecards.js', 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context);
const api = context.window.FDGScoreCards;
assert.ok(api && typeof api.render === 'function');

const row = {
  status: 'pre_jogo',
  gols_esperados: { mandante: 1.3796, visitante: .9697 },
  placar_modal: { mandante: 1, visitante: 0 },
  placares_mais_provaveis: [
    { mandante: 1, visitante: 0, probabilidade_pct: 13.1663 },
    { mandante: 1, visitante: 1, probabilidade_pct: 12.7674 },
    { mandante: 0, visitante: 0, probabilidade_pct: 9.5435 }
  ],
  probabilidades_pct: { mandante: 46.3225, empate: 27.2716, visitante: 26.4059 }
};

const pregame = api.render(row, { context: 'jogos' });
assert.match(pregame, /af-e2-jogos/);
assert.match(pregame, /PLACAR MAIS PROVÁVEL/);
assert.match(pregame, /1 × 0/);
assert.match(pregame, /1 × 1/);
assert.match(pregame, /0 × 0/);
assert.match(pregame, /13,2%/);
assert.match(pregame, /12,8%/);
assert.match(pregame, /9,5%/);
assert.match(pregame, /1,38 × 0,97/);
assert.equal((pregame.match(/class="af-e2-alternative"/g) || []).length, 2);
assert.ok(pregame.endsWith('</section>'));
assert.match(pregame, /af-e2-primary/);
assert.match(pregame, /af-e2-footer/);
assert.match(pregame, /Projeção pré-jogo · não é o resultado/);
assert.match(pregame, /chance desse placar/);
assert.equal((pregame.match(/class="af-e2-alt-score"/g) || []).length, 2);
assert.ok(pregame.indexOf('af-e2-primary') < pregame.indexOf('af-e2-alternatives'));
assert.ok(pregame.indexOf('af-e2-alternatives') < pregame.indexOf('af-e2-footer'));
assert.doesNotMatch(pregame, /46,3% de chance desse placar/);

assert.match(api.render(row, { context: 'aovivo' }), /af-e2-aovivo/);
assert.equal(api.render({ ...row, status: 'final' }), '');
assert.equal(api.render({ ...row, placar_modal: { mandante: 1, visitante: 2 } }), '');
assert.equal(api.render({ ...row, gols_esperados: { mandante: 0, visitante: 1 } }), '');
assert.equal(api.render({ ...row, placares_mais_provaveis: [
  row.placares_mais_provaveis[0], row.placares_mais_provaveis[0], row.placares_mais_provaveis[2]
] }), '');

const legacy = api.render({ ...row, placares_mais_provaveis: undefined });
assert.match(legacy, /Chance individual indisponível/);
assert.match(legacy, /aguardando o Top-3/);
assert.doesNotMatch(legacy, /2º cenário/);
assert.ok(legacy.endsWith('</section>'));

const home = readFileSync('index.html', 'utf8');
const live = readFileSync('aovivo.html', 'utf8');
const liveJs = readFileSync('js/br-aovivo.js', 'utf8');
for (const html of [home, live]) {
  assert.ok(html.includes('css/br-af-scorecards.css?v=20261110-ux-r1'));
  assert.ok(html.includes('js/br-af-scorecards.js?v=20261110-ux-r1'));
}
assert.ok(home.indexOf('br-af-scorecards.js') < home.indexOf('function probabilidadesPreJogoDoJogo'));
assert.match(home, /const previsaoElegivel = estado\.estado === 'pre'/);
assert.match(home, /\$\{placaresPreJogo\}/);
assert.match(liveJs, /s\.key === "pre" && hasProbabilities && window\.FDGScoreCards/);
assert.match(liveJs, /probabilityMobile \+\s*placaresPreJogo \+/);

const css = readFileSync('css/br-af-scorecards.css', 'utf8');
assert.match(css, /max-width:\s*480px/);
assert.match(css, /max-width:\s*350px/);
assert.match(css, /minmax\(0, 1fr\)/);
console.log('E2 SCORECARDS: PASS — modal, Top-3, percentuais, legado, desktop/mobile e não exibição em FINAL');
