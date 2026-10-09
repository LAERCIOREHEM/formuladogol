import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ORCHESTRATOR_CONTRACT, orchestratorHealth, correlationIdForEvent } from '../src/contract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const read = (p) => readFile(path.join(repo, p), 'utf8');

test('R10R16 contract.js governa versão, schema e SLOs', async () => {
  assert.equal(ORCHESTRATOR_CONTRACT.version, '2.4.0');
  assert.equal(ORCHESTRATOR_CONTRACT.configSchemaVersion, 8);
  assert.equal(ORCHESTRATOR_CONTRACT.reliability.controlPlane, true);
  assert.equal(ORCHESTRATOR_CONTRACT.reliability.sportingIntegrityGuard, true);
  assert.equal(ORCHESTRATOR_CONTRACT.reliability.sloMinutes.finalToAf, 10);
  assert.deepEqual(ORCHESTRATOR_CONTRACT.reliability.healthStates, ['CORE_GREEN','ENRICHMENT_PENDING','DEGRADED','CRITICAL']);
  const health = orchestratorHealth('active');
  assert.equal(health.version, '2.4.0');
  assert.equal(health.reliabilityControlPlane, true);
  assert.equal(health.sportingSnapshotIntegrityGuard, true);
  assert.equal(health.reliabilityFinalToAfSloMinutes, 10);
  const cfg = JSON.parse(await read('dados-br/config-orquestrador.json'));
  assert.equal(cfg.schema_version, 8);
  assert.equal(cfg.reliability_control_plane.ativo, true);
});

test('Wrangler não possui versão autoritativa hardcoded', async () => {
  const wrangler = await read('cloudflare/orchestrator-worker/wrangler.template.jsonc');
  const renderer = await read('cloudflare/orchestrator-worker/scripts/render-config.mjs');
  const deploy = await read('.github/workflows/deploy-orchestrator-worker.yml');
  assert.match(wrangler, /__ORCHESTRATOR_VERSION__/);
  assert.match(wrangler, /__ORCHESTRATOR_CRON__/);
  assert.doesNotMatch(wrangler, /ORCHESTRATOR_VERSION"\s*:\s*"2\.4\.0"/);
  assert.match(renderer, /ORCHESTRATOR_CONTRACT\.version/);
  assert.match(deploy, /contract drift/);
  assert.match(deploy, /EXPECTED_ORCHESTRATOR_VERSION/);
});

test('Fastlane e full updater compartilham Sporting Snapshot Integrity Guard', async () => {
  const fast = await read('.github/workflows/af-previsao-fastlane-pos-final.yml');
  const full = await read('.github/workflows/atualizar-brasileirao.yml');
  const validator = await read('scripts/validar_publicacao_brasileirao.py');
  assert.match(fast, /validar_snapshot_esportivo\.py/);
  assert.match(validator, /validate_snapshot\(profile="full"/);
  assert.match(full, /validar_publicacao_brasileirao\.py/);
  assert.doesNotMatch(full, /cobertura das probabilidades por jogo diverge do calendário restante/);
  assert.match(fast, /2\.000\.000|reconciliar_af_continental\.py --force/);
});

test('falhas produzem diagnóstico anexável e trace é propagado', async () => {
  const fast = await read('.github/workflows/af-previsao-fastlane-pos-final.yml');
  const full = await read('.github/workflows/atualizar-brasileirao.yml');
  const github = await read('cloudflare/orchestrator-worker/src/github.js');
  const state = await read('cloudflare/orchestrator-worker/src/orchestrator-state.js');
  assert.equal(correlationIdForEvent('401841251'), 'fdg-401841251');
  assert.match(github, /trace_id: decision\.traceId/);
  assert.match(state, /reliability:lastTrace/);
  assert.match(state, /reliabilityState/);
  assert.match(fast, /upload-artifact@v4/);
  assert.match(full, /upload-artifact@v4/);
  assert.match(fast, /-f trace_id="\$FDG_TRACE_ID"/);
});

test('estado CORE/ENRICHMENT é publicado e enriquecimento não bloqueia core', async () => {
  const script = await read('scripts/gerar_estado_confiabilidade.py');
  const state = JSON.parse(await read('dados-br/estado-confiabilidade.json'));
  assert.match(script, /reliability_state/);
  assert.equal(state.core.sporting_integrity, 'ok');
  assert.equal(state.enrichment.does_not_block_core, true);
  assert.ok(['CORE_GREEN','ENRICHMENT_PENDING','DEGRADED','CRITICAL'].includes(state.state));
});

test('corpus operacional e rollback existem sem ativar RAG no caminho crítico', async () => {
  const cfg = JSON.parse(await read('dados-br/config-orquestrador.json'));
  const manifest = JSON.parse(await read('docs/operations/RAG-MANIFEST.json'));
  const rollback = await read('docs/operations/R10R16-ROLLBACK.md');
  assert.equal(cfg.reliability_control_plane.knowledge_base.rag_em_producao, false);
  assert.equal(manifest.production_rag_enabled, false);
  assert.match(rollback, /rollback/i);
});
