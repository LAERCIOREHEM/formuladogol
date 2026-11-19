import test from 'node:test';
import assert from 'node:assert/strict';
import {activeWriter} from '../src/github.js';

const env={GITHUB_REPOSITORY:'LAERCIOREHEM/formuladogol',GITHUB_BRANCH:'main',GITHUB_TOKEN:'test-token'};
const item=(name,status='in_progress')=>({name,status});
test('final prioritizes Fastlane over slow full ESPN and Pages deployments',async()=>{
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async()=>({ok:true,json:async()=>({workflow_runs:[
      item('Atualizar Brasileirao (ESPN)'),item('Deploy site (GitHub Pages)')
    ]})});
    assert.equal((await activeWriter(env))?.name,'Atualizar Brasileirao (ESPN)');
    assert.equal(await activeWriter(env,{urgentFinal:true}),null);
    globalThis.fetch=async()=>({ok:true,json:async()=>({workflow_runs:[
      item('Atualizar Brasileirao (ESPN)'),item('AF-Previsão Fastlane pós-FINAL')
    ]})});
    assert.equal((await activeWriter(env,{urgentFinal:true}))?.name,'AF-Previsão Fastlane pós-FINAL');
    globalThis.fetch=async()=>({ok:true,json:async()=>({workflow_runs:[
      item('AF-Previsão Fastlane pós-FINAL','completed')
    ]})});
    assert.equal(await activeWriter(env,{urgentFinal:true}),null);
  } finally {globalThis.fetch=original}
});
