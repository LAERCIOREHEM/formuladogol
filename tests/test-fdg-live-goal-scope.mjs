import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const ctx = {
  window: { FormulaDoGolPush: {}, addEventListener() {} },
  document: { addEventListener() {} },
  MutationObserver: class { observe() {} },
};
vm.runInNewContext(fs.readFileSync('js/br-alertas.js','utf8'), ctx);
const coverage = ctx.window.FormulaDoGolAlerts?.goalCoverageForGame;
assert.equal(typeof coverage, 'function');
const game = [{event_id:'401841318',mandante:{nome:'Athletico-PR',sigla:'CAP'},visitante:{nome:'Remo',sigla:'REM'}}];
const selected = {goals:true,allGames:false,teams:[],games:[]};
assert.equal(coverage('401841318',selected,game),'not_selected');
assert.equal(coverage('401841318',{...selected,allGames:true},game),'all_games');
assert.equal(coverage('401841318',{...selected,games:['401841318']},game),'specific_game');
assert.equal(coverage('401841318',{...selected,teams:['abbr:CAP']},game),'selected_team');
assert.equal(coverage('401841318',{...selected,teams:['team:remo']},game),'selected_team');
assert.equal(coverage('401841318',{...selected,teams:['Remo']},game),'not_selected');
assert.equal(coverage('401841318',{...selected,goals:false,allGames:true},game),'goals_disabled');
assert.equal(coverage('401841318',{...selected,games:['401841319']},game),'not_selected');
assert.equal(coverage('401841318',{...selected},[]),'not_selected');
assert.equal(coverage('',{...selected,allGames:true},game),'no_game');
assert.match(fs.readFileSync('aovivo.html','utf8'), /goalscope-r1/);
assert.match(fs.readFileSync('alertas.html','utf8'), /goalscope-r1/);
console.log('PASS: contextual goal push coverage, no auto-opt-in, matches backend scope');
