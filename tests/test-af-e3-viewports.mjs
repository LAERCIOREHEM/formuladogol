import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium, webkit, devices } from 'playwright';

const source = readFileSync('index.html', 'utf8');
const rootCss = source.match(/<style>([\s\S]*?)<\/style>/i)?.[1];
assert.ok(rootCss && rootCss.includes('.resultado-card'), 'CSS real da home não encontrado');
const e3Css = readFileSync('css/br-af-resultados.css', 'utf8');
const e3Script = readFileSync('js/br-af-resultados.js', 'utf8');
const data = JSON.parse(readFileSync('dados-br/resultados-af-placares-2026.json', 'utf8'));
const proven = data.jogos.find(g => g.situacao === 'comprovado');
const missing = data.jogos.find(g => g.situacao !== 'comprovado');
assert.ok(proven && missing);

const cases = [
  { name: 'desktop-1440', browser: chromium, options: { viewport: { width: 1440, height: 900 } } },
  { name: 'tablet-768', browser: chromium, options: { viewport: { width: 768, height: 1024 } } },
  { name: 'android-pixel7-412', browser: chromium, options: devices['Pixel 7'] },
  { name: 'iphone13-webkit-390', browser: webkit, options: devices['iPhone 13'] },
  { name: 'iphone-se-webkit-375', browser: webkit, options: devices['iPhone SE'] },
  { name: 'android-small-320', browser: chromium, options: { viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true } }
];

mkdirSync('test-results/af-e3', { recursive: true });
for (const test of cases) {
  const browser = await test.browser.launch({ headless: true });
  try {
    const context = await browser.newContext(test.options);
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html lang="pt-BR"><head>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>${rootCss}</style><style>${e3Css}</style>
      </head><body><div class="container" style="max-width:1260px;margin:0 auto">
      <main id="view-resultados"><div class="resultados-lista">
      <article class="resultado-card" id="match1">
        <div class="resultado-meta"><span class="resultado-rodada">R32</span><span class="resultado-data">SEX 06/11</span></div>
        <div class="resultado-jogo">
          <div class="resultado-time mandante"><span class="resultado-nome">Atlético-MG</span><span class="resultado-escudo">⚽</span></div>
          <div class="resultado-placar">1 <span class="placar-x">×</span> 1</div>
          <div class="resultado-time visitante"><span class="resultado-escudo">⚽</span><span class="resultado-nome">Bahia</span></div>
        </div>
      </article>
      <article class="resultado-card" id="match2">
        <div class="resultado-meta"><span class="resultado-rodada">R01</span></div>
        <div class="resultado-jogo"><div class="resultado-time mandante">Clube A</div>
        <div class="resultado-placar">2 <span class="placar-x">×</span> 0</div>
        <div class="resultado-time visitante">Clube B</div></div>
      </article></div></main></div></body></html>`);
    await page.addScriptTag({ content: e3Script });
    await page.evaluate(({ data, p, m }) => {
      const create = r => ({
        event_id: r.event_ids[0], data_iso: r.inicio_factual,
        mandante: { nome: r.mandante }, visitante: { nome: r.visitante },
        placar_mandante: r.placar_final_auditado.mandante,
        placar_visitante: r.placar_final_auditado.visitante,
        estado: 'post'
      });
      document.querySelector('#match1').insertAdjacentHTML('beforeend',
        window.FDGResultadosAF.render(create(p), data));
      document.querySelector('#match2').insertAdjacentHTML('beforeend',
        window.FDGResultadosAF.render(create(m), data));
    }, { data, p: proven, m: missing });
    assert.equal(await page.locator('#match1 details.af-e3-result').count(), 1, test.name);
    assert.equal(await page.locator('#match2 .af-e3-outcome-missing').count(), 1, test.name);
    assert.equal(await page.locator('#match1 .af-e3-featured').count(), 1, test.name);
    assert.equal(await page.locator('#match1 .af-e3-breakdown').isVisible(), false,
      test.name + ': avaliação técnica não deve poluir o cartão fechado');
    await page.locator('#match1 details.af-e3-result summary').click();
    assert.ok(await page.locator('#match1 details.af-e3-result').evaluate(el => el.open), test.name);
    assert.equal(await page.locator('#match1 .af-e3-score-option').count(), 3);
    assert.equal(await page.locator('#match1 .af-e3-breakdown').isVisible(), true, test.name);
    assert.equal(await page.locator('#match1 .af-e3-breakdown .af-e3-chip').count(), 3,
      test.name + ': preservar critérios V/E/D, exato e Top-3 independentes');
    const metrics = await page.evaluate(() => {
      const card = document.querySelector('#match1 .af-e3-result');
      const box = card.getBoundingClientRect();
      return {
        viewport: window.innerWidth,
        pageWidth: document.documentElement.scrollWidth,
        boxWidth: box.width,
        overflow: [...document.querySelectorAll('.af-e3-result *, .af-e3-outcome *')]
          .filter(el => {
            const r = el.getBoundingClientRect();
            return r.width && (r.left < -1 || r.right > window.innerWidth + 1);
          }).slice(0, 6).map(el => el.className)
      };
    });
    assert.ok(metrics.pageWidth <= metrics.viewport + 1,
      test.name + ' rolagem horizontal: ' + JSON.stringify(metrics));
    assert.equal(metrics.overflow.length, 0, test.name + ' elemento fora da tela: ' + JSON.stringify(metrics));
    assert.ok(metrics.boxWidth > 210 && metrics.boxWidth <= metrics.viewport + 1, test.name + ' largura');
    await page.screenshot({ path: 'test-results/af-e3/' + test.name + '.png', fullPage: true });
    console.log('AF E3 VIEWPORT PASS:', test.name, metrics.viewport);
    await context.close();
  } finally {
    await browser.close();
  }
}
