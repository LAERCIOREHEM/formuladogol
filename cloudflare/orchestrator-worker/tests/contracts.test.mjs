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
  assert.match(yml, /atualizar-publicos-brasileirao\.yml --ref main -f modo=partida -f event_id="\$EVENT_ID"/);
});

test('Cloudflare deploy auto-activates on main push and protects first install', async () => {
  const yml = await read('.github/workflows/deploy-orchestrator-worker.yml');
  assert.match(yml, /push:/);
  assert.match(yml, /branches: \[main\]/);
  assert.match(yml, /default: "shadow"/);
  assert.match(yml, /Deploy base SHADOW/);
  assert.match(yml, /wrangler secret put GITHUB_TOKEN/);
  assert.match(yml, /github\.event_name == 'push' \|\| inputs\.mode == 'active'/);
  assert.match(yml, /orchestrator\.formuladogol\.com\.br\/health/);
  assert.match(yml, /transmissionGuardianNeedGate/);
  assert.match(yml, /targetedPublicResearch/);
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


test('five-minute fast path fetches compact agenda plus authoritative source status', async () => {
  const state = await read('cloudflare/orchestrator-worker/src/orchestrator-state.js');
  const fastBlock = state.match(/const FAST_PATHS = \[([\s\S]*?)\];/)?.[1] || '';
  assert.match(fastBlock, /agenda-clubes-br\.json/);
  assert.match(fastBlock, /status-atualizacao\.json/);
  assert.doesNotMatch(fastBlock, /resultados\.json|competicoes-af-previsao|jogos-detalhes/);
  assert.doesNotMatch(state, /dados-br\/jogos-detalhes\.json/);
  assert.match(state, /pendingPublicsFromAudit/);
});

test('successful ESPN scoreboard that omits a wanted event is treated as degraded', async () => {
  const src = await read('cloudflare/orchestrator-worker/src/sources.js');
  assert.match(src, /event_id ausente no scoreboard/);
});
test('Wrangler contract uses independent SQLite Durable Object and five-minute cron', async () => {
  const wrangler = await read('cloudflare/orchestrator-worker/wrangler.template.jsonc');
  assert.match(wrangler, /formula-do-gol-orchestrator/);
  assert.match(wrangler, /orchestrator\.formuladogol\.com\.br/);
  assert.match(wrangler, /"\*\/5 \* \* \* \*"/);
  assert.match(wrangler, /"new_sqlite_classes"/);
  assert.match(wrangler, /"OrchestratorState"/);
  assert.doesNotMatch(wrangler, /formula-do-gol-push/);
});

test('repository fallback contract keeps internal artifacts out of Pages dependency', async () => {
  const src = await read('cloudflare/orchestrator-worker/src/sources.js');
  assert.match(src, /application\/vnd\.github\.raw\+json/);
  assert.match(src, /fetchRepositoryJson/);
  assert.match(src, /repositoryFallbacks/);
  const state = await read('cloudflare/orchestrator-worker/src/orchestrator-state.js');
  assert.match(state, /fontesRepositorio/);
});

test('deploy validates Contents read permission before changing Worker', async () => {
  const workflow = await read('.github/workflows/deploy-orchestrator-worker.yml');
  assert.match(workflow, /Contents: Read-only/);
  assert.match(workflow, /config-analises\.json\?ref=main/);
});


test('AI transmission Guardian has OpenAI/web-search and checkpoint contracts', async () => {
  const yml = await read('.github/workflows/auditar-transmissoes-ia.yml');
  const guardian = await read('scripts/guardiao_transmissoes_ia.py');
  const state = await read('cloudflare/orchestrator-worker/src/orchestrator-state.js');
  assert.match(yml, /OPENAI_API_KEY/);
  assert.match(yml, /gpt-5\.6-sol/);
  assert.match(guardian, /web_search/);
  assert.match(guardian, /Guardião IA de transmissões/);
  assert.match(state, /guardiancp:/);
  assert.match(state, /transmissoes_guardian/);
  const index = await read('cloudflare/orchestrator-worker/src/index.js');
  assert.match(index, /transmissionGuardian:\s*true/);
  assert.match(index, /1\.6\.0/);
  assert.match(index, /transmissionGuardianNeedGate:\s*true/);
  assert.match(index, /transmissionNeedDrivenV2:\s*true/);
  assert.match(index, /adaptiveSlowPath:\s*true/);
  assert.match(index, /adaptiveSlowPathMaxSleepMinutes:\s*60/);
  assert.match(index, /transmissionTvOperationalWindowHours:\s*72/);
  assert.match(index, /transmissionYoutubeOnlyWhenRequired:\s*true/);
  assert.match(index, /publicFirstAttemptAfterFinalMinutes:\s*30/);
  assert.match(index, /transmissionGuardianBatching:\s*true/);
  assert.match(index, /targetedPublicResearch:\s*true/);
  assert.match(index, /continentalPhaseFingerprints:\s*true/);
  assert.match(index, /continentalAgendaAware:\s*true/);
  assert.match(index, /continentalStateIdempotency:\s*true/);
  assert.match(index, /brasileiraoSourceCircuitBreaker:\s*true/);
  assert.match(index, /espnScoreboardGateway:\s*true/);
});

test('public workflow is targetable and Guardian workflow supports batch event ids', async () => {
  const publicYml = await read('.github/workflows/atualizar-publicos-brasileirao.yml');
  const guardianYml = await read('.github/workflows/auditar-transmissoes-ia.yml');
  const publicAi = await read('scripts/completar_publicos_ia.py');
  const state = await read('cloudflare/orchestrator-worker/src/orchestrator-state.js');
  const github = await read('cloudflare/orchestrator-worker/src/github.js');
  assert.match(publicYml, /modo:/);
  assert.match(publicYml, /event_id:/);
  assert.match(publicYml, /--modo/);
  assert.match(publicYml, /--event-id/);
  assert.match(publicAi, /FDG_DIAGNOSTICO_JSON=/);
  assert.match(publicAi, /web_search/);
  assert.match(guardianYml, /event_ids:/);
  assert.match(state, /guardianResolution/);
  assert.match(state, /transmissoes-guardiao\.json/);
  assert.match(state, /publicPendingFingerprint/);
  assert.match(github, /modo:\s*'partida'/);
  assert.match(github, /event_ids/);
});


test('live player state never inherits match live state', async () => {
  const live = await read('js/br-aovivo.js');
  assert.doesNotMatch(live, /principal\.status[^;]*\|\|\s*game\.state\s*===\s*["']in["']/);
  assert.match(live, /principal\.status[^;]*===\s*["']live["']/);
});


test('continental orchestrator has agenda sleep, state idempotency and circuit-breaker contracts', async () => {
  const logic = await read('cloudflare/orchestrator-worker/src/logic.js');
  const state = await read('cloudflare/orchestrator-worker/src/orchestrator-state.js');
  const deploy = await read('.github/workflows/deploy-orchestrator-worker.yml');
  const wrangler = await read('cloudflare/orchestrator-worker/wrangler.template.jsonc');
  assert.match(logic, /openEditorialRank/);
  assert.match(logic, /rankHasCompleteTwoLegTies/);
  assert.match(logic, /continentalNextCheck/);
  assert.match(logic, /continentalFallbackMinutes:\s*1440/);
  assert.match(state, /idempotency:\s*'state'/);
  assert.match(state, /continental:nextCheckAt/);
  assert.match(state, /estado-editorial-continentais\.json/);
  assert.match(state, /CONTINENTAL_GUARD_FINGERPRINT/);
  assert.match(deploy, /editorial_continental_guard_fingerprint/);
  assert.match(wrangler, /__CONTINENTAL_GUARD_FINGERPRINT__/);
});


test('Brasileirão source breaker blocks heavy retries and uses structured collector status', async () => {
  const logic = await read('cloudflare/orchestrator-worker/src/logic.js');
  const state = await read('cloudflare/orchestrator-worker/src/orchestrator-state.js');
  const sources = await read('cloudflare/orchestrator-worker/src/sources.js');
  const collector = await read('atualizar_espn.py');
  const status = await read('scripts/gerenciar_status_brasileirao.py');
  const workflow = await read('.github/workflows/atualizar-brasileirao.yml');
  assert.match(logic, /brasileiraoSourceGate/);
  assert.match(logic, /sourceProbeMinutes:\s*5/);
  assert.match(state, /br:sourceBreaker/);
  assert.match(state, /half_open/);
  assert.match(state, /probeEspnAvailability/);
  assert.match(state, /!candidate && brSource\.externalOpen && brSource\.recoveryEligible/);
  assert.match(state, /uma única atualização de recuperação/);
  assert.match(sources, /espn_cdn_league/);
  assert.match(sources, /espn_site_web_api/);
  assert.match(sources, /status-atualizacao\.json/);
  assert.match(collector, /ScoreboardUnavailableError/);
  assert.match(collector, /Circuit breaker local/);
  assert.match(collector, /source_state=/);
  assert.match(status, /"schema_version": 2/);
  assert.match(status, /"fonte_estado"/);
  assert.match(workflow, /BR_SOURCE_STATE/);
  assert.match(workflow, /BR_SNAPSHOT_PRESERVED/);
});


test('canonical operational config is aligned with Cloudflare transmission/public policy', async () => {
  const cfg = JSON.parse(await read('dados-br/config-orquestrador.json'));
  assert.equal(cfg.schema_version, 3);
  assert.equal(cfg.publicos.primeira_tentativa_apos_final_minutos, 30);
  assert.equal(cfg.transmissoes.janela_operacional_tv_horas, 72);
  assert.deepEqual(cfg.transmissoes.tv_checkpoints_minutos, [-4320, -1440, -360]);
  assert.deepEqual(cfg.transmissoes.aovivo_checkpoints_minutos, [-90, -15, 10]);
  assert.deepEqual(cfg.transmissoes.guardiao_checkpoints_minutos, [-90, -15, 10]);
  assert.equal(cfg.execucao_primaria.cron, '*/5 * * * *');
  const logic = await read('cloudflare/orchestrator-worker/src/logic.js');
  assert.match(logic, /firstAfterFinalMinutes:\s*30/);
  assert.match(logic, /tvCheckpointsMinutes:\s*\[-4320, -1440, -360\]/);
  assert.match(logic, /liveCheckpointsMinutes:\s*\[-90, -15, 10\]/);
  assert.match(logic, /guardianCheckpointsMinutes:\s*\[-90, -15, 10\]/);
});

test('TV workflow no longer scans future YouTube players in tv mode', async () => {
  const yml = await read('.github/workflows/buscar-transmissoes-aovivo-brasileirao.yml');
  assert.match(yml, /Modo tv: nenhuma varredura antecipada de player YouTube/);
  assert.doesNotMatch(yml, /Modo tv: colheita barata de players futuros/);
});

test('live collector revalidates preserved players against the target game', async () => {
  const py = await read('scripts/buscar_transmissoes_aovivo_brasileirao.py');
  assert.match(py, /evaluate_candidate\(cand, game, config, aliases\)/);
  assert.match(py, /Nunca preservar só porque o vídeo continua live\/upcoming/);
});
