import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { syncIncidents, syncOverallRecovery, githubActionsSeverity, continentalAgendaHealth } from '../src/health-monitor.js';
import { buildActionCenter, healthYellowDecision, healthActionDigestLines, healthActionMessage, HEALTH_ACTION_CENTER_VERSION } from '../src/health-action-center.js';

const now=Date.parse('2026-10-15T13:00:00Z');
assert.equal(HEALTH_ACTION_CENTER_VERSION,1);
assert.equal(githubActionsSeverity({dispatches:15,dormant:false,pendingPostgameTasks:2,hoursToNext:10}).severity,'green', '15 dispatches alone are not an incident');
assert.equal(githubActionsSeverity({dispatches:15,previousDispatches:14,hasPrevious:true,dormant:true,pendingPostgameTasks:0,hoursToNext:240}).severity,'red','confirmed dormant anomaly remains critical');
assert.equal(continentalAgendaHealth({integridade_continental:{status:'ok',faltantes:[],fallbacks_documentais_ativos:5},jogos:[]}).severity,'green','valid documented fallback is informational');
assert.equal(continentalAgendaHealth({integridade_continental:{status:'degraded',faltantes:[{event_id:'missing'}]},jogos:[]}).severity,'red','missing official fixture is critical');
assert.equal(continentalAgendaHealth({integridade_continental:{status:'unknown',faltantes:[],fallbacks_documentais_ativos:0},jogos:[]}).severity,'yellow','unknown integrity requires attention');

const highlights=[{eventId:'e1',home:'Fluminense',away:'Palmeiras',finalAt:'2026-10-15T07:00:00Z',attempts:2,lastError:'not_found',nextAt:'2026-10-15T13:30:00Z'}];
const mock={
  state:'yellow',
  indicators:[{id:'openai',label:'IA / Custos',severity:'yellow',detail:'5 falha(s)'},
    {id:'highlights',label:'Melhores Momentos',severity:'yellow',detail:'1 pendência vencida'},
    {id:'github',label:'GitHub Actions',severity:'green',detail:'15 dispatches'},
    {id:'continentais',label:'Agenda continental',severity:'green',detail:'fallback válido'}],
  postgame:{highlightPending:1,highlightOverdue:1,highlightPendingRows:highlights,cost:{budget:{monthPct:49.29,warningPct:80}}},
  providers:{failures:5,byProvider:[{provider:'gemini',failures:4,calls:9},{provider:'openai',failures:1,calls:1}]},
  providerUnrecoveredFailures:3,
  providerFailureRows:[{provider:'gemini',purpose:'postgame',eventId:'e1',httpStatus:429,detail:'rate limit',recovered:false}],
  orchestrator:{githubDispatchesLast24h:15},
  continentalAgenda:{integrityOk:true,fallbacks:5},
};
const plan=buildActionCenter(mock,now);
const recoveredAI=buildActionCenter({...mock,indicators:[{id:'openai',label:'IA / Custos',severity:'green',detail:'custo normal'}],postgame:{...mock.postgame,pending:0},providers:{...mock.providers,failures:35}},now);
assert.equal(recoveredAI.requiresAttention.length,0,'35 falhas históricas não entram na Central de Ações');
assert.ok(recoveredAI.informational.some(x=>x.includes('históricas/24h')));
const withBreakdown=buildActionCenter({
  ...mock,
  providerFailureSummary:{total:5,recovered:4,unresolved:1,activeUnresolved:1}
},now);
assert.ok(withBreakdown.requiresAttention.find(a=>a.id==='openai').evidence.some(x=>x.includes('4 com sucesso posterior')));
const closedWithBreakdown=buildActionCenter({
  ...mock,indicators:[{id:'openai',label:'IA / Custos',severity:'green',detail:'saudável'}],
  postgame:{...mock.postgame,pending:0},
  providerFailureSummary:{total:5,recovered:4,unresolved:1,activeUnresolved:0}
},now);
assert.ok(closedWithBreakdown.informational.some(x=>x.includes('4 recuperada(s)')));

const spike=buildActionCenter({...mock,postgame:{...mock.postgame,cost:{last24h:{estimatedUsd:5.1},budget:{monthlyBudgetUsd:50}}}},now);
assert.ok(spike.requiresAttention.find(x=>x.id==='openai').recommendation.includes('US$ 5 em 24 horas'));

assert.equal(plan.requiresAttention.length,2);
assert.ok(plan.requiresAttention.find(a=>a.id==='openai').evidence.some(x=>x.includes('HTTP 429')),'provider HTTP evidence');
assert.ok(plan.requiresAttention.find(a=>a.id==='highlights').evidence.some(x=>x.includes('Fluminense x Palmeiras')),'actual game in diagnostic');
assert.ok(plan.informational.some(x=>x.includes('15 disparos')));
assert.ok(plan.informational.some(x=>x.includes('5 fallback')));
assert.match(healthActionDigestLines({...mock,actionCenter:plan}).join('\n'),/O QUE FAZER:/);
assert.match(healthActionMessage(plan.requiresAttention[0],mock,{now}).body,/Responsável: CORREÇÃO\/REAVALIAÇÃO AUTOMÁTICA/);
assert.equal(healthYellowDecision(null,now),'observe');
assert.equal(healthYellowDecision({status:'observing',opened_at:new Date(now-14*60_000).toISOString()},now),'wait');
assert.equal(healthYellowDecision({status:'observing',opened_at:new Date(now-15*60_000).toISOString()},now),'send');
assert.equal(healthYellowDecision({status:'open',opened_at:new Date(now-30*60_000).toISOString()},now),'already_open');

const sqlite=new DatabaseSync(':memory:');
const migration=readFileSync(new URL('../migrations/0011_health_monitor.sql',import.meta.url),'utf8');
sqlite.exec(migration);
class D1 {
  constructor(db){this.db=db;}
  prepare(sql){
    const statement=this.db.prepare(sql);
    return {
      async first(){return statement.get()??null;},
      async all(){return {results:statement.all()};},
      async run(){return {meta:{changes:statement.run().changes}};},
      bind(...values){return {
      async first(){return statement.get(...values)??null;},
      async all(){return {results:statement.all(...values)};},
      async run(){return {meta:{changes:statement.run(...values).changes}};}
    };}};
  }
}
const sent=[];
let failNext=false;
const env={DB:new D1(sqlite),EMAIL:{async send(payload){if(failNext){failNext=false;throw new Error('simulated transport failure');}sent.push(payload);}},EMAIL_DESTINO:'health@example.com'};
const snapshot=(sev)=>{
  const x={state:sev==='green'?'green':sev,indicators:[{id:'openai',label:'IA / Custos',severity:sev,detail:sev==='green'?'normalizado':'5 falhas sem recuperação'}],postgame:mock.postgame,providers:mock.providers,providerUnrecoveredFailures:3,providerFailureRows:mock.providerFailureRows};
  x.actionCenter=buildActionCenter(x,now);
  return x;
};
const row=()=>sqlite.prepare("SELECT * FROM health_incidents WHERE incident_key='health:openai'").get();
await syncIncidents(env,snapshot('yellow'),now);
assert.equal(row().status,'observing','first yellow is observing');
assert.equal(sent.length,0,'no email on first yellow observation');
await syncIncidents(env,snapshot('yellow'),now+10*60_000);
assert.equal(row().status,'observing','yellow remains observing before 15min');
assert.equal(sent.length,0);
await syncIncidents(env,snapshot('yellow'),now+16*60_000);
assert.equal(row().status,'open');
assert.equal(row().severity,'yellow');
assert.equal(sent.length,1,'15min sustained yellow sends one email');
assert.match(sent[0].subject,/ATENÇÃO/);
await syncIncidents(env,snapshot('yellow'),now+21*60_000);
assert.equal(sent.length,1,'same warning does not resend');
await syncIncidents(env,snapshot('red'),now+22*60_000);
assert.equal(sent.length,2,'red escalation immediately sends');
assert.match(sent[1].subject,/CRÍTICO/);
await syncIncidents(env,snapshot('red'),now+23*60_000);
assert.equal(sent.length,2,'red unchanged deduplicated');
await syncIncidents(env,snapshot('green'),now+24*60_000);
assert.equal(sent.length,3,'recovery email sent');
assert.match(sent[2].subject,/RECUPERADO/);
assert.equal(row().status,'resolved');
await syncIncidents(env,snapshot('yellow'),now+25*60_000);
await syncIncidents(env,snapshot('green'),now+26*60_000);
assert.equal(sent.length,3,'flapping before delay must not notify');
assert.equal(row().status,'resolved');
await syncIncidents(env,snapshot('yellow'),now+27*60_000,{dailySentThisRun:true});
assert.equal(row().status,'open');
assert.equal(row().email_status,'covered_by_daily');
await syncIncidents(env,snapshot('yellow'),now+47*60_000);
assert.equal(sent.length,3,'daily digest suppresses duplicate yellow alert');
await syncIncidents(env,snapshot('green'),now+48*60_000);
assert.equal(sent.length,4,'covered digest warning gets recovery email');
// Red transport errors remain open with retries; no silent loss.
failNext=true;
await syncIncidents(env,snapshot('red'),now+50*60_000);
assert.equal(sent.length,4);
assert.equal(row().status,'open');
assert.match(row().email_status,/mail_error:/);
await syncIncidents(env,snapshot('red'),now+55*60_000);
assert.equal(sent.length,5,'failed critical email retried');
assert.equal(row().email_status,'sent');
await syncIncidents(env,snapshot('green'),now+60*60_000);
assert.equal(row().status,'resolved');
assert.equal(sent.length,6);
const noDuplicate=await syncOverallRecovery(env,{state:'red'},{state:'green'},{coveredByActionRecovery:true,now:now+65*60_000});
assert.equal(noDuplicate.status,'covered_by_action_recovery');
assert.equal(sent.length,6,'per-item recovery should suppress redundant global recovery');
const fallbackOverall=await syncOverallRecovery(env,{state:'yellow'},{state:'green'},{now:now+70*60_000});
assert.equal(fallbackOverall.status,'sent');
assert.equal(sent.length,7,'global recovery remains available when there is no specific incident to close');
console.log('R10R17.6 HEALTH ACTION CENTER: classification, diagnostics, D1 lifecycle, dedup, retries, daily digest, recovery PASS');
