import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context={window:{}};
vm.runInNewContext(fs.readFileSync('js/br-live-goal-sync.js','utf8'),context);
const guard=context.window.FDGLiveGoalSync;
assert.equal(guard.version,1);
function facts(home,away,goals){return {integrity:{expectedHome:home,expectedAway:away,expectedGoals:home+away,mathematicallyValid:true,scoreComplete:goals.length===home+away,missingScorers:goals.filter(g=>!g.scorer).length},goals};}
const goal={scorer:'Jogador validado',scorerId:'11',minute:"54'",teamId:'vas',side:'away',scoreAfter:{home:0,away:1}};
const saved=facts(0,1,[goal]);
const empty=facts(0,1,[{...goal,scorer:'',scorerId:'',minute:''}]);
const recovered=guard.reconcile(saved,empty);
assert.equal(recovered.goals[0].scorer,'Jogador validado');
assert.equal(recovered.integrity.missingScorers,0);
assert.equal(recovered.goals[0].minute,"54'");
assert.equal(guard.reconcile(saved,null).goals[0].scorer,'Jogador validado');
assert.equal(guard.reconcile(saved,facts(0,2,[{...goal,scorer:'',scoreAfter:{home:0,away:2}}])).goals[0].scorer,'','mudança de placar não reaproveita autor');
assert.equal(guard.reconcile(saved,facts(0,1,[{...goal,scorer:'',teamId:'other'}])).goals[0].scorer,'','outro clube nunca herda autor');
assert.equal(guard.reconcile(saved,facts(0,1,[{...goal,scorer:'',side:'home'}])).goals[0].scorer,'','outro lado nunca herda autor');
assert.equal(guard.reconcile(saved,facts(0,1,[{...goal,scorer:'',scorerConflict:true}])).goals[0].scorer,'','conflito explícito não herda');
assert.equal(guard.reconcile(saved,facts(0,1,[{...goal,scorer:'Novo autor confirmado'}])).goals[0].scorer,'Novo autor confirmado','correção de autoria oficial deve vencer cache');
assert.equal(guard.reconcile(saved,facts(0,1,[{...goal,scorer:'',scoreAfter:{home:1,away:0},side:'home',teamId:'boca'}])).goals[0].scorer,'Jogador validado','resposta matematicamente inválida não deve apagar dado validado');
assert.equal(guard.reconcile(null,saved),saved);
// Integração real de arquivos: página não pode continuar bloqueando id documental.
const page=fs.readFileSync('js/br-aovivo.js','utf8');
assert.match(page,/FDGLiveGoalSync\?\.reconcile/);
assert.doesNotMatch(page,/if\(!selected\|\|!\/\^\\d\{5,15\}/);
assert.match(page,/Evento documental sem dados do monitor/);
assert.match(fs.readFileSync('aovivo.html','utf8'),/br-live-goal-sync\.js\?v=20261014-r10r17-2/);
// R10R17.3: autoria confirmada aparece antes do retry de estatísticas parciais.
const firstSummaryIndex = page.indexOf('let data = await fetchSummaryPayload(g, { signal });');
const earlyFactsIndex = page.indexOf('renderMain(currentSelectedGame(), data, allGames());', firstSummaryIndex);
const statsRetryIndex = page.indexOf('await waitWithSignal(PARTIAL_STATS_RETRY_DELAY_MS', firstSummaryIndex);
assert.ok(firstSummaryIndex >= 0 && earlyFactsIndex > firstSummaryIndex && statsRetryIndex > earlyFactsIndex,
  'R10R17.3 deve exibir o autor assim que o gateway entrega facts, antes do retry das estatísticas');
assert.match(fs.readFileSync('aovivo.html','utf8'), /br-aovivo\.js\?v=20261127-live-hf1/);

// R36-R3: um placar 0x1 SEM facts mostra pendência no lado certo.
{
  const start=page.indexOf('  function goalsBySide(g, summary) {');
  const end=page.indexOf('  function renderGoalsUnderTeams(g, summary)',start);
  assert.ok(start>0&&end>start,'renderizador de gols está presente');
  const scope={numericScore:(v)=>Number(v),compactPlayerName:(v)=>String(v||'').trim()};
  vm.runInNewContext(page.slice(start,end)+'\nthis.goalsBySide=goalsBySide;',scope);
  const game={home:{id:'bot',nome:'Botafogo',score:0},away:{id:'sp',nome:'São Paulo',score:1}};
  const blank=scope.goalsBySide(game,null);
  assert.equal(blank.home.length,0);
  assert.equal(blank.away.length,1);
  assert.equal(blank.away[0].athlete,'Autor sendo confirmado');
  const found=scope.goalsBySide(game,{__fdgLiveFacts:{
    integrity:{expectedHome:0,expectedAway:1,mathematicallyValid:true},
    goals:[{scorer:'Pedro Lima',minute:"28'",teamId:'sp',side:'away',scoreAfter:{home:0,away:1}}]
  }});
  assert.equal(found.away[0].athlete,'Pedro Lima');
  assert.equal(found.away[0].min,"28'");
  const wrong=scope.goalsBySide(game,{__fdgLiveFacts:{
    integrity:{expectedHome:1,expectedAway:0,mathematicallyValid:true},
    goals:[{scorer:'Nome de outro jogo',teamId:'bot',side:'home',scoreAfter:{home:1,away:0}}]
  }});
  assert.equal(wrong.away[0].athlete,'Autor sendo confirmado','proibir marcador de outro placar');
  const two=scope.goalsBySide({...game,away:{...game.away,score:2}},{__fdgLiveFacts:{
    integrity:{expectedHome:0,expectedAway:2,mathematicallyValid:true},
    goals:[{scorer:'Pedro Lima',minute:"28'",teamId:'sp',side:'away',scoreAfter:{home:0,away:1}}]
  }});
  assert.equal(two.away.length,2,'não ocultar segundo gol sem autor');
  assert.equal(two.away[0].athlete,'Pedro Lima');
  assert.equal(two.away[1].athlete,'Autor sendo confirmado');
  assert.match(page,/direct\.__fdgLiveFacts = envelope\.data\.__fdgLiveFacts/,
    'troca para estatísticas ESPN diretas não pode apagar autor validado');
}

console.log('br-live-goal-sync R10R17.2: PASS');
