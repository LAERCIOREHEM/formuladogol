import fs from 'node:fs';

function must(condition, message) {
  if (!condition) throw new Error(message);
}

const manifest = JSON.parse(fs.readFileSync('manifest.webmanifest', 'utf8'));
const index = fs.readFileSync('index.html', 'utf8');
const pwa = fs.readFileSync('js/br-pwa.js', 'utf8');
const css = fs.readFileSync('css/br-pwa.css', 'utf8');

must(manifest.id === '/', 'manifest.id deve ser /');
must(manifest.scope === '/', 'manifest.scope deve ser /');
must(manifest.start_url === '/?source=pwa', 'PWA instalada deve abrir a Home');
must(manifest.display === 'standalone', 'manifest.display deve ser standalone');
const iconSizes = new Set((manifest.icons || []).map((icon) => String(icon.sizes || '')));
must(iconSizes.has('192x192'), 'manifest sem ícone 192x192');
must(iconSizes.has('512x512'), 'manifest sem ícone 512x512');

const version = '20260923-pwa-home-install-v4';
must(index.includes(`/manifest.webmanifest?v=${version}`), 'Home sem cache-busting do manifest PWA');
must(index.includes(`/css/br-pwa.css?v=${version}`), 'Home sem CSS PWA atualizado');
must(index.includes(`/js/br-pwa.js?v=${version}`), 'Home sem JS PWA atualizado');

must(pwa.includes(`const VERSION = '${version}'`), 'versão do br-pwa.js inconsistente');
must(pwa.includes('30 * 24 * 60 * 60 * 1000'), 'silenciamento deve durar 30 dias');
must(pwa.includes('HOME_INSTALL_DELAY_MS = 4 * 1000'), 'prompt da Home deve aguardar 4 segundos');
must(pwa.includes("window.addEventListener('beforeinstallprompt'"), 'Android/native install sem beforeinstallprompt');
must(pwa.includes("window.addEventListener('appinstalled'"), 'instalação sem appinstalled');
must(pwa.includes('Adicionar à Tela de Início'), 'instruções iOS ausentes');
must(pwa.includes('isAndroid()'), 'fallback Android ausente');
must(pwa.includes('fdg_pwa_install_completed_v1'), 'persistência de instalação ausente');
must(pwa.includes('br-pwa-home-install'), 'prompt mobile da Home ausente');

must(css.includes('.br-pwa-home-install'), 'CSS do prompt mobile ausente');
must(css.includes('env(safe-area-inset-bottom)'), 'prompt sem safe area do iPhone');
must(css.includes('@media (min-width: 901px)'), 'prompt sem bloqueio em desktop');

const stalePwaVersions = [
  '20260901-pwa-v1',
  '20260903-pwa-onboarding-v4-safari-first',
  '20260901-pwa-onboarding-v2'
];
for (const stale of stalePwaVersions) {
  const offenders = [];
  for (const file of fs.readdirSync('.')) {
    // arquivos de raiz são verificados abaixo junto com analises/ e scripts/.
  }
  const candidates = [
    ...fs.readdirSync('.').filter((name) => name.endsWith('.html')).map((name) => name),
    ...fs.readdirSync('analises').filter((name) => name.endsWith('.html')).map((name) => `analises/${name}`),
    'scripts/gerar_analise_rodada.py'
  ];
  for (const file of candidates) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(stale)) offenders.push(file);
  }
  must(offenders.length === 0, `referência PWA antiga ${stale}: ${offenders.join(', ')}`);
}

console.log('OK: PWA Home — Android nativo, iOS guiado, 4s de atraso, 30 dias de silêncio e start_url na Home.');
