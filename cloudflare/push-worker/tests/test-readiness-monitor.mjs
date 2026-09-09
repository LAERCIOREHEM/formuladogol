import assert from 'node:assert/strict';
import { SportsMonitor } from '../src/sports-monitor.js';

class FakeStorage {
  constructor(){ this.map=new Map(); this.alarm=null; }
  async get(k){ return this.map.get(k); }
  async put(k,v){ if(k&&typeof k==='object'&&v===undefined){ for(const [a,b] of Object.entries(k)) this.map.set(a,structuredClone(b)); } else this.map.set(k,structuredClone(v)); }
  async getAlarm(){ return this.alarm; }
  async setAlarm(v){ this.alarm=Number(v); }
}
class FakeDB {
  constructor(){ this.essential=new Map(); this.preflight=new Map(); this.incidents=new Map(); }
  prepare(sql){
    const self=this;
    return {
      bind(...args){ return {
        async all(){
          if (/FROM push_subscriptions s/.test(sql)) return { results:[{subscription_id:'s1',installation_id:'inst-sp'}] };
          return {results:[]};
        },
        async first(){ return null; },
        async run(){
          let changes=1;
          if (/INSERT OR IGNORE INTO essential_match_events/.test(sql)) {
            if (self.essential.has(args[0])) changes=0; else self.essential.set(args[0],args);
          }
          if (/INSERT INTO monitor_preflight/.test(sql)) self.preflight.set(`${args[0]}:${args[1]}`,args);
          if (/INSERT OR IGNORE INTO monitor_incidents/.test(sql)) { if(self.incidents.has(args[0])) changes=0; else self.incidents.set(args[0],args); }
          return {meta:{changes}};
        }
      }; },
      async first(){ return null; }, async all(){ return {results:[]}; }, async run(){ return {meta:{changes:1}}; }
    };
  }
}

const realNow=Date.now, realFetch=globalThis.fetch;
const kickoff='2026-09-08T23:30:00.000Z';
const kickoffMs=Date.parse(kickoff);
let now=kickoffMs-31*60_000;
let state='pre';
Date.now=()=>now;
const sourceEventId='401912542';
function scoreboard(){ return {events:[{
  id:sourceEventId,date:kickoff,status:{type:{state,completed:state==='post'},displayClock:state==='in'?"3'":''},
  competitions:[{status:{type:{state}},competitors:[
    {homeAway:'home',score:'0',team:{id:'5',displayName:'Boca Juniors',abbreviation:'BOC'}},
    {homeAway:'away',score:'0',team:{id:'2026',displayName:'São Paulo',abbreviation:'SAO'}}
  ]}]
}]}; }
globalThis.fetch=async (url)=>{
  const href=String(url);
  if(href.includes('agenda-clubes-br.json')) return Response.json({jogos:[{
    event_id:'agenda-id-antigo', espn_league:'conmebol.sudamericana', data_iso:kickoff,
    competicao_chave:'sul_americana', competicao_nome_curto:'Sul-Americana',
    mandante:{espn_id:'5',nome:'Boca Juniors',sigla:'BOC'}, visitante:{espn_id:'2026',nome:'São Paulo',sigla:'SAO'}
  }]});
  if(href.includes('/scoreboard')) return Response.json(scoreboard());
  if(href.includes('/playbyplay')) return Response.json({gamepackageJSON:{plays:[]}});
  if(href.includes('/plays?')) return Response.json({items:[]});
  if(href.includes('/game?')) return Response.json({gamepackageJSON:{plays:[]}});
  if(href.includes('/summary')) return Response.json({rosters:[],scoringPlays:[]});
  throw new Error(`URL inesperada ${href}`);
};
try {
  const storage=new FakeStorage(), db=new FakeDB(), queue=[];
  const monitor=new SportsMonitor({storage},{DB:db,PUSH_QUEUE:{send:async(x)=>queue.push(x)}});
  let status=await monitor.bootstrap();
  assert.equal(status.watchCount,1);
  assert.equal(status.preflight['agenda-id-antigo'],undefined,'T-31 ainda não deve fechar T-30');
  assert.equal(storage.alarm,now+60_000,'entre T-35 e T-20 o guardião deve acordar a cada 60s');

  now=kickoffMs-29*60_000;
  await monitor.pollOnce();
  status=await monitor.publicStatus();
  assert.equal(status.preflight['agenda-id-antigo'].t30.readiness,'green');
  assert.equal(status.preflight['agenda-id-antigo'].t30.sourceEventId,sourceEventId);
  assert.ok(['matchup','event_id','agenda_event_id'].includes(status.preflight['agenda-id-antigo'].t30.strategy));
  assert.equal(status.preflight['agenda-id-antigo'].t30.audience.goal,1);

  now=kickoffMs-9*60_000;
  await monitor.pollOnce();
  status=await monitor.publicStatus();
  assert.equal(status.preflight['agenda-id-antigo'].t10.readiness,'green');

  state='in'; now=kickoffMs+3*60_000;
  await monitor.pollOnce();
  status=await monitor.publicStatus();
  assert.equal(status.preflight['agenda-id-antigo'].tplus3.readiness,'green');
  assert.equal(status.readinessRed,0);
  const starts=[...db.essential.values()].filter((r)=>r[2]==='match_start');
  assert.equal(starts.length,1,'transição pre→in precisa persistir um único alerta de início');
  assert.ok(queue.some((x)=>x.kind==='event_dispatch' && String(x.eventKey).startsWith('match_start:')),'início precisa entrar na fila');
  console.log('readiness-monitor Boca-SaoPaulo regression: PASS');
} finally { Date.now=realNow; globalThis.fetch=realFetch; }
