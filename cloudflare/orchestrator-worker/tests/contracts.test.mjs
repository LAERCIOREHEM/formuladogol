import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const read = (p) => readFile(path.join(repo, p), 'utf8');

test('AO VIVO browser contract remains at 30 seconds', async () => {
  const live = await read('js/br-aovivo.js');
  const stats = await read('js/br-estatisticas.js');
  assert.match(live, /REFRESH_MS\s*=\s*30000/);
  assert.match(stats, /REFRESH_MS\s*=\s*30000/);
});

test('legacy GitHub orchestrator is manual fallback only', async () => {
  const yml = await read('.github/workflows/orquestrador-inteligente.yml');
  assert.match(yml, /Fallback MANUAL/);
  assert.match(yml, /workflow_dispatch:/);
  assert.doesNotMatch(yml, /^\s*schedule:/m);
  assert.match(yml, /-f event_id="\$EVENT_ID"/);
});

test('Cloudflare deploy is explicit shadow/active and protects first install', async () => {
  const yml = await read('.github/workflows/deploy-orchestrator-worker.yml');
  assert.match(yml, /default: "shadow"/);
  assert.match(yml, /Deploy base SHADOW/);
  assert.match(yml, /wrangler secret put GITHUB_TOKEN/);
  assert.match(yml, /inputs\.mode == 'active'/);
  assert.match(yml, /orchestrator\.formuladogol\.com\.br\/health/);
});

test('targeted highlights input reaches both BR scripts and skips Cup broad scan', async () => {
  const yml = await read('.github/workflows/buscar-melhores-momentos-getv.yml');
  const getv = await read('scripts/buscar_melhores_momentos_getv.py');
  const substitute = await read('scripts/substituir_fontes_preferidas_mm.py');
  assert.match(yml, /event_id:/);
  assert.match(yml, /--event-id/);
  assert.match(yml, /if: \$\{\{ inputs\.event_id == '' \}\}/);
  assert.match(yml, /published == 'true'.*cup_changed == 'true'/);
  assert.match(getv, /--event-id/);
  assert.match(substitute, /--event-id/);
});

test('transmission publication ignores volatile clock-only audit fields', async () => {
  const py = await read('scripts/atualizar_transmissoes_tv_brasileirao.py');
  assert.match(py, /VOLATILE_SEMANTIC_KEYS/);
  assert.match(py, /"faltam_horas"/);
  assert.match(py, /"nivel"/);
  assert.match(py, /semantic_audit_payload/);
});

test('all normal writers touched by this package share repo-write-main', async () => {
  const continental = await read('.github/workflows/publicar-analise-continentais.yml');
  const bets = await read('.github/workflows/apurar-brasileirao.yml');
  const deploy = await read('.github/workflows/deploy.yml');
  assert.match(continental, /group: repo-write-main/);
  assert.match(bets, /group: repo-write-main/);
  assert.match(deploy, /group: repo-write-main/);
  assert.match(deploy, /cancel-in-progress: false/);
});

test('AI audit documentation and schedule agree on 08:45 BRT', async () => {
  const yml = await read('.github/workflows/auditoria-ia-diaria.yml');
  assert.match(yml, /08:45 em Brasília/);
  assert.match(yml, /cron: '45 11 \* \* \*'/);
});


test('one-minute path fetches only the compact agenda; multi-megabyte details stay out of Worker', async () => {
  const state = await read('cloudflare/orchestrator-worker/src/orchestrator-state.js');
  const fastBlock = state.match(/const FAST_PATHS = \[([\s\S]*?)\];/)?.[1] || '';
  assert.match(fastBlock, /agenda-clubes-br\.json/);
  assert.doesNotMatch(fastBlock, /resultados\.json|competicoes-af-previsao|jogos-detalhes/);
  assert.doesNotMatch(state, /dados-br\/jogos-detalhes\.json/);
  assert.match(state, /pendingPublicsFromAudit/);
});

test('successful ESPN scoreboard that omits a wanted event is treated as degraded', async () => {
  const src = await read('cloudflare/orchestrator-worker/src/sources.js');
  assert.match(src, /event_id ausente no scoreboard/);
});
test('Wrangler contract uses independent SQLite Durable Object and one-minute cron', async () => {
  const wrangler = await read('cloudflare/orchestrator-worker/wrangler.template.jsonc');
  assert.match(wrangler, /formula-do-gol-orchestrator/);
  assert.match(wrangler, /orchestrator\.formuladogol\.com\.br/);
  assert.match(wrangler, /"\* \* \* \* \*"/);
  assert.match(wrangler, /"new_sqlite_classes"/);
  assert.match(wrangler, /"OrchestratorState"/);
  assert.doesNotMatch(wrangler, /formula-do-gol-push/);
});
