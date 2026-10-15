import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { collectHealthSnapshot } from '../src/health-monitor.js';

const now=Date.parse('2026-10-15T11:00:00Z');
const sqlite=new DatabaseSync(':memory:');
const migrations=new URL('../migrations/',import.meta.url);
for(const file of readdirSync(migrations).filter(x=>/\.sql$/.test(x)).sort()) sqlite.exec(readFileSync(new URL(file,migrations),'utf8'));
class D1 {
  constructor(db){this.db=db;}
  prepare(sql){
    const stmt=this.db.prepare(sql);
    return {
      async first(){return stmt.get()??null;},
      async all(){return {results:stmt.all()};},
      async run(){return {meta:{changes:stmt.run().changes}};},
      bind(...values){return {
        async first(){return stmt.get(...values)??null;},
        async all(){return {results:stmt.all(...values)};},
        async run(){return {meta:{changes:stmt.run(...values).changes}};},
      };}
    };
  }
}
const env={DB:new D1(sqlite),SITE_BASE:'https://formuladogol.com.br',OPENAI_API_KEY:'x',GEMINI_API_KEY:'x',AI_GATEWAY_TOKEN:'x',AI:{},EMAIL:{send:async()=>{}},EMAIL_DESTINO:'user@example.com'};
// Futebol brasileiro com vídeo ainda pendente há 3 horas.
sqlite.prepare(`INSERT INTO postgame_fastlane(event_id,league,home,away,kickoff,final_at,home_score,away_score,public_status,highlight_status,highlight_attempts,highlight_last_error)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('e1','bra.1','Fluminense','Palmeiras','2026-10-15T04:00:00Z','2026-10-15T08:00:00Z',0,1,'resolved','pending',3,'video_not_yet_published');
// Cinco falhas, com uma recuperação posterior no mesmo evento.
for(let i=0;i<5;i++)sqlite.prepare(`INSERT INTO ai_provider_ledger(provider,purpose,event_id,phase,ok,http_status,detail,created_at)
 VALUES (?,?,?,?,?,?,?,?)`).run('gemini','postgame','e1','source_search',0,429,'rate_limited','2026-10-15T10:00:00Z');
sqlite.prepare(`INSERT INTO ai_provider_ledger(provider,purpose,event_id,phase,ok,http_status,detail,created_at)
 VALUES (?,?,?,?,?,?,?,?)`).run('gemini','postgame','e1','source_search',1,200,'recovered','2026-10-15T10:05:00Z');
const previousFetch=globalThis.fetch;
const json=(body)=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
const responses={
  '/':{},
  '/dados-br/auditoria-publicos.json':{total_jogos_finalizados:30,total_com_publico_ou_complemento:25,total_sem_publico:5,total_com_renda:25,total_sem_renda:5},
  '/dados-br/auditoria-publicos-identidade.json':{schema_version:2,total_criticos:0,total_avisos:0},
  '/dados-br/rag-manifest.json':{schema_version:2,production_rag_enabled:true,collections:['a']},
  '/dados-br/estado-confiabilidade.json':{state:'CORE_GREEN'},
  '/dados-br/agenda-clubes-br.json':{integridade_continental:{status:'ok',faltantes:[],fallbacks_documentais_ativos:5},jogos:[]},
  '/dados-br/ops-rag-index.json':{schema_version:1,runtime:'fdg-ops-rag',runtime_version:1,source_count:2,chunk_count:2,chunks:[{id:'1',scope:'operations',text:'monitor健康'}]},
};
const orchHealth={sportingSnapshotIntegrityGuard:true,sportingSnapshotIntegrityGuardVersion:1,reliabilityControlPlane:true,reliabilityDiagnosticArtifact:true,reliabilityIncidentRegressionSuite:true,reliabilityCorrelationId:true};
const orchStatus={workloadMode:'active',nextRelevantMatchAt:'2026-10-15T21:30:00-03:00',pendingPostgameTasks:0,githubDispatchesLast24h:15,reliabilityState:'CORE_GREEN',errors:[]};
globalThis.fetch=async function(url){
  const s=String(url);
  if(s==='https://orchestrator.formuladogol.com.br/health') return json(orchHealth);
  if(s==='https://orchestrator.formuladogol.com.br/status') return json(orchStatus);
  const path=new URL(s).pathname;
  if(path in responses) return json(responses[path]);
  return new Response('{}',{status:404});
};
try{
  const shot=await collectHealthSnapshot(env,{ok:true,activeGames:0,lastPollAt:now,readinessRed:0},now,true);
  assert.equal(shot.policyVersion,12);
  assert.equal(shot.healthActionCenterVersion,1);
  assert.equal(shot.indicators.length,17);
  assert.equal(shot.indicators.find(i=>i.id==='github')?.severity,'green');
  assert.equal(shot.indicators.find(i=>i.id==='continentais')?.severity,'green');
  assert.equal(shot.indicators.find(i=>i.id==='highlights')?.severity,'yellow');
  assert.equal(shot.indicators.find(i=>i.id==='openai')?.severity,'green','five failed attempts with success for same event become recovered informational');
  assert.equal(shot.postgame.highlightOverdue,1);
  assert.equal(shot.postgame.highlightPendingRows[0].home,'Fluminense');
  assert.equal(shot.providerUnrecoveredFailures,0);
  assert.ok(shot.actionCenter.requiresAttention.some(x=>x.id==='highlights'));
  assert.ok(shot.actionCenter.informational.some(x=>x.includes('CONMEBOL')));
  assert.ok(shot.actionCenter.informational.some(x=>x.includes('IA: 5')));
  // Falhas ainda sem sucesso posterior devem passar a amarelo e expor causa/HTTP.
  for(let i=0;i<2;i++)sqlite.prepare(`INSERT INTO ai_provider_ledger(provider,purpose,event_id,phase,ok,http_status,detail,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run('openai','postgame','e2','source_search',0,503,'upstream_unavailable','2026-10-15T10:55:00Z');
  const ongoing=await collectHealthSnapshot(env,{ok:true,activeGames:0,lastPollAt:now,readinessRed:0},now,true);
  assert.equal(ongoing.indicators.find(i=>i.id==='openai')?.severity,'yellow');
  assert.equal(ongoing.providerUnrecoveredFailures,2);
  assert.ok(ongoing.actionCenter.requiresAttention.find(x=>x.id==='openai')?.evidence.some(x=>x.includes('HTTP 503')));
  console.log('R10R17.6 real snapshot + D1 queries + HTTP feeds mock: PASS');
}finally{globalThis.fetch=previousFetch;sqlite.close();}
