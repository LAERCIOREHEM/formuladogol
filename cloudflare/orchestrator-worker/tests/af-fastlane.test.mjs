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
    dispatchSpec({ action: 'atualizar_brasileirao', eventId: '401841256' }),
    {
      workflow: 'af-previsao-fastlane-pos-final.yml',
      inputs: { event_id: '401841256', origem: 'orchestrator-final' },
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
  assert.match(yml, /2_000_000/);
  assert.match(yml, /gh workflow run deploy\.yml --ref main/);
  assert.match(yml, /gh workflow run atualizar-brasileirao\.yml --ref main/);
});

test('health e deploy expõem e validam AF Fastlane v1', async () => {
  const index = await read('cloudflare/orchestrator-worker/src/index.js');
  const deploy = await read('.github/workflows/deploy-orchestrator-worker.yml');
  assert.match(index, /version: String\(env\.ORCHESTRATOR_VERSION \|\| '2\.2\.0'\)/);
  assert.match(index, /afPostFinalFastlane:\s*true/);
  assert.match(index, /afPostFinalFastlaneVersion:\s*1/);
  assert.match(deploy, /p\.afPostFinalFastlane === true/);
  assert.match(deploy, /p\.afPostFinalFastlaneVersion === 1/);
  assert.match(deploy, /af-previsao-fastlane-pos-final\.yml/);
});

test('config canônico documenta o caminho crítico pós-FINAL', async () => {
  const cfg = JSON.parse(await read('dados-br/config-orquestrador.json'));
  assert.equal(cfg.schema_version, 6);
  assert.equal(cfg.atualizar_brasileirao.af_fastlane_pos_final.ativo, true);
  assert.equal(cfg.atualizar_brasileirao.af_fastlane_pos_final.simulacoes, 2_000_000);
  assert.equal(cfg.execucao_primaria.af_fastlane.includes('af-previsao-fastlane-pos-final.yml'), true);
});
