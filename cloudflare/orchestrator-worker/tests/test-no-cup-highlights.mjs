import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cupEditorialDecision } from '../src/logic.js';

// R10R17.7: As decisões de vídeo da Copa e CONMEBOL nunca devem ser
// emitidas pelo Orchestrator. Não afetar editoriais nem vídeos da Série A.
const decisionSource = fs.readFileSync(new URL('../src/orchestrator-state.js', import.meta.url), 'utf8');
assert.doesNotMatch(decisionSource, /action:\s*['"]melhores_momentos_continentais['"]/,
  'Orchestrator reintroduziu dispatch de MM continental');
assert.doesNotMatch(decisionSource, /mmcup:\$\{/, 'Orchestrator reintroduziu fila de MM da Copa do Brasil');
assert.match(decisionSource, /ledgerKind:\s*['"]highlight['"]/, 'Melhores Momentos Brasileirão devem continuar');
assert.match(decisionSource, /action:\s*['"]editorial_copa_do_brasil['"]/, 'Editorial da Copa deve continuar');
assert.match(decisionSource, /action:\s*['"]editorial_continentais['"]/, 'Editorial continental deve continuar');
assert.ok(await cupEditorialDecision({fase_atual:{ordem:800,status:'encerrada'}},{artigos:[]},{jogos:{}}),
  'Sem vídeos, o editorial da Copa deve continuar decidindo autonomamente');
const cupWorkflow = fs.readFileSync(new URL('../../../.github/workflows/publicar-analise-copa-do-brasil.yml', import.meta.url), 'utf8');
assert.doesNotMatch(cupWorkflow, /run:\s*python scripts\/buscar_melhores_momentos_copa_do_brasil\.py\s*(?:\n|$)/,
  'Workflow editorial não deve executar busca de vídeos da Copa');
assert.match(cupWorkflow, /scripts\/gerar_analise_copa_do_brasil\.py/, 'Editorial da Copa segue operacional');
console.log('R10R17.7 Orchestrator: sem MM Copa/CONMEBOL, editoriais e BR preservados: PASS');
