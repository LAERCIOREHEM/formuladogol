import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { dispatchSpec } from '../src/github.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const read = (p) => readFile(path.join(repo, p), 'utf8');

test('FINAL do Brasileirão é roteado para o AF Fastlane', () => {
  assert.deepEqual(
    dispatchSpec({ action: 'atualizar_brasileirao', eventId: '401841256', traceId: 'fdg-401841256' }),
    {
      workflow: 'af-previsao-fastlane-pos-final.yml',
      inputs: { event_id: '401841256', origem: 'orchestrator-final', trace_id: 'fdg-401841256' },
    },
  );
});

test('AF Fastlane mantém lock global, 2M simulações e reconciliação completa posterior', async () => {
  const yml = await read('.github/workflows/af-previsao-fastlane-pos-final.yml');
  assert.match(yml, /name: AF-Previsão Fastlane pós-FINAL/);
  assert.match(yml, /group: repo-write-main/);
  assert.match(yml, /python atualizar_espn\.py/);
  assert.match(yml, /gerar_agenda_clubes_brasileirao\.py/);
  assert.match(yml, /reconciliar_af_continental\.py --force --max-attempts 2/);
  assert.match(yml, /validar_snapshot_esportivo\.py/);
  assert.match(yml, /registrar_slo_confiabilidade\.py/);
  assert.match(yml, /trace_id/);
  assert.match(yml, /gh workflow run deploy\.yml --ref main/);
  assert.match(yml, /gh workflow run atualizar-brasileirao\.yml --ref main/);
});

test('contract.js é a fonte canônica de versão e Wrangler é renderizado por placeholder', async () => {
  const contract = await read('cloudflare/orchestrator-worker/src/contract.js');
  const deploy = await read('.github/workflows/deploy-orchestrator-worker.yml');
  const render = await read('cloudflare/orchestrator-worker/scripts/render-config.mjs');
  const wrangler = await read('cloudflare/orchestrator-worker/wrangler.template.jsonc');
  const pkg = JSON.parse(await read('cloudflare/orchestrator-worker/package.json'));

  assert.match(contract, /version:\s*'2\.4\.0'/);
  assert.match(contract, /afPostFinalFastlane:\s*true/);
  assert.match(wrangler, /\"ORCHESTRATOR_VERSION\":\s*\"__ORCHESTRATOR_VERSION__\"/);
  assert.match(render, /ORCHESTRATOR_CONTRACT\.version/);
  assert.equal(pkg.version, '2.4.0');
  assert.match(deploy, /EXPECTED_ORCHESTRATOR_VERSION/);
  assert.match(deploy, /ORCHESTRATOR_CONTRACT\.health/);
});

test('config canônico documenta o caminho crítico pós-FINAL', async () => {
  const cfg = JSON.parse(await read('dados-br/config-orquestrador.json'));
  assert.equal(cfg.schema_version, 8);
  assert.equal(cfg.atualizar_brasileirao.af_fastlane_pos_final.ativo, true);
  assert.equal(cfg.atualizar_brasileirao.af_fastlane_pos_final.simulacoes, 2_000_000);
  assert.equal(cfg.execucao_primaria.af_fastlane.includes('af-previsao-fastlane-pos-final.yml'), true);
  assert.equal(cfg.reliability_control_plane.sporting_snapshot_integrity_guard.simulacoes_af_obrigatorias, 2_000_000);
});
