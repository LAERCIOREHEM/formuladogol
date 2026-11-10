import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium, webkit, devices } from 'playwright';

const css = readFileSync('css/br-af-scorecards.css', 'utf8');
const moduleCode = readFileSync('js/br-af-scorecards.js', 'utf8');
const dataset = JSON.parse(readFileSync('dados-br/probabilidades-jogos.json', 'utf8'));
const row = dataset.jogos.find(x => x.placares_mais_provaveis?.length >= 3);
assert.ok(row, 'E2 exige Top-3 original no JSON de publicação');
mkdirSync('test-results/af-e2', { recursive: true });

const scenarios = [
  { name: 'web-desktop-1440', engine: chromium, viewport: { width: 1440, height: 900 }, isMobile: false },
  { name: 'web-tablet-768', engine: chromium, viewport: { width: 768, height: 1024 }, isMobile: false },
  { name: 'android-pixel7-412', engine: chromium, device: devices['Pixel 7'] },
  { name: 'iphone13-webkit-390', engine: webkit, device: devices['iPhone 13'] },
  { name: 'iphone-se-webkit-375', engine: webkit, device: devices['iPhone SE'] },
  { name: 'small-android-320', engine: chromium, viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true }
];

for (const s of scenarios) {
  const browser = await s.engine.launch({ headless: true });
  try {
    const context = await browser.newContext(s.device || { viewport: s.viewport, isMobile: !!s.isMobile, hasTouch: !!s.hasTouch });
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html lang="pt-BR"><head><meta name="viewport" content="width=device-width, initial-scale=1">
      <style>*{box-sizing:border-box}body{margin:0;background:#0c141b;color:#fff;font-family:Arial,sans-serif}
      .demo{max-width:1100px;margin:0 auto;padding:12px}.card{min-width:0;padding:15px;border:1px solid #43556a;border-radius:16px}
      .names{text-align:center;font-weight:800;line-height:1.5;font-size:18px}
      .fixture{width:100%;display:grid;grid-template-columns:minmax(0,1fr) 80px minmax(0,1fr);align-items:center;gap:5px;text-align:center}
      .fixture strong{font-size:20px}.fixture span{font-size:22px} </style></head><body>
      <main class="demo"><div class="card"><div class="names">Brasileirão · E2 · versão responsiva</div>
      <div class="fixture"><strong>Mirassol</strong><span>×</span><strong>Atlético-MG</strong></div>
      <div id="score"></div></div></main></body></html>`);
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: moduleCode });
    const rendered = await page.evaluate(data => {
      document.querySelector('#score').innerHTML = window.FDGScoreCards.render(data, { context: 'jogos' });
      const node = document.querySelector('.af-e2-prediction');
      const rect = node?.getBoundingClientRect();
      return { exists: !!node, text: node?.innerText, width: rect?.width };
    }, row);
    assert.ok(rendered.exists, s.name + ': componente ausente');
    assert.match(rendered.text, /PLACAR MAIS PROVÁVEL/, s.name);
    assert.match(rendered.text, /2º cenário/, s.name);
    assert.match(rendered.text, /3º cenário/, s.name);
    const sizes = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
      card: document.querySelector('.af-e2-prediction').getBoundingClientRect().width,
      overflow: [...document.querySelectorAll('.af-e2-prediction *')].filter(x => {
        const b = x.getBoundingClientRect();
        return b.right > window.innerWidth + 1 || b.left < -1;
      }).map(x => x.className).slice(0, 8)
    }));
    assert.ok(sizes.scroll <= sizes.inner + 1, s.name + ': rolagem horizontal: ' + JSON.stringify(sizes));
    assert.ok(!sizes.overflow.length, s.name + ': texto/elemento fora da tela: ' + JSON.stringify(sizes));
    assert.ok(sizes.card > 220 && sizes.card < sizes.inner + 1, s.name + ': card fora dos limites');
    const alignment = await page.evaluate(() => {
      const card = document.querySelector('.af-e2-prediction').getBoundingClientRect();
      const main = document.querySelector('.af-e2-main-score').getBoundingClientRect();
      const scenarios = [...document.querySelectorAll('.af-e2-alternative')].map(el => el.getBoundingClientRect());
      const center = r => (r.left + r.right) / 2;
      return {
        mainOffset: Math.abs(center(main) - center(card)),
        scenarioWidths: scenarios.map(r => r.width),
        mainFont: parseFloat(getComputedStyle(document.querySelector('.af-e2-main-score')).fontSize),
        scenarioFont: parseFloat(getComputedStyle(document.querySelector('.af-e2-alt-score')).fontSize)
      };
    });
    assert.ok(alignment.mainOffset <= 2, s.name + ': placar central desalinhado ' + JSON.stringify(alignment));
    assert.ok(Math.abs(alignment.scenarioWidths[0] - alignment.scenarioWidths[1]) <= 1,
      s.name + ': cenários assimétricos ' + JSON.stringify(alignment));
    assert.ok(alignment.mainFont <= 30 && alignment.mainFont >= 22, s.name + ': placar principal excessivo');
    assert.ok(alignment.scenarioFont < alignment.mainFont, s.name + ': hierarquia visual invertida');
    await page.screenshot({ path: 'test-results/af-e2/' + s.name + '.png', fullPage: true });
    console.log('VIEWPORT PASS:', s.name, sizes.inner + 'px', Math.round(sizes.card) + 'px');
    await context.close();
  } finally {
    await browser.close();
  }
}
