import assert from 'node:assert/strict';
import { SportsMonitor, kickoffRescheduled } from '../src/sports-monitor.js';

const ID='401841326';
const OLD='2026-11-21T17:00:00-03:00';
const NEW='2026-11-23T20:00:00-03:00';
const game=(kickoff)=>({
 eventId:ID,league:'bra.1',kickoff,home:{name:'Botafogo',id:'6086'},
 away:{name:'São Paulo',id:'2026'},lastState:'pre'
});
assert.equal(kickoffRescheduled(game(OLD),game(NEW)),true);
assert.equal(kickoffRescheduled(game(NEW),game(NEW)),false);
assert.equal(kickoffRescheduled(game(OLD),{...game(NEW),eventId:'other'}),false);
assert.equal(kickoffRescheduled(game(OLD),{...game(NEW),away:{name:'Vasco da Gama'}}),false);
assert.equal(kickoffRescheduled(game(OLD),{...game(OLD),kickoff:'2026-11-21T17:01:00-03:00'}),false);

class Storage {
 constructor(){this.entries=new Map();this.alarm=null}
 async get(key){return this.entries.get(key)}
 async put(k,v){this.entries.set(k,structuredClone(v))}
 async getAlarm(){return this.alarm}
 async setAlarm(v){this.alarm=v}
}
class DB {
 constructor(){this.incidents=new Map()}
 prepare(sql){
  return {bind:(...args)=>({run:async()=>{
   if(sql.includes("email_status='rescheduled_silent'")){
    const row=this.incidents.get(args[0]);
    if(row)this.incidents.set(args[0],{...row,severity:'resolved',email_status:'rescheduled_silent',checkpoint:'rescheduled'});
   }
   return {meta:{changes:1}};
  }})};
 }
}
const realNow=Date.now,realFetch=globalThis.fetch;
Date.now=()=>Date.parse('2026-11-21T21:36:00Z');
const storage=new Storage(),db=new DB();
const previous=game(OLD);
const key='push_readiness:'+ID;
db.incidents.set(key,{incident_key:key,severity:'critical',email_status:'critical_sent'});
await storage.put('watchlist',{[ID]:{...previous,lastState:'pre',finalSince:0}});
await storage.put('scheduleSnapshot',{[ID]:previous});
await storage.put('preflight',{[ID]:{t10:{readiness:'red',completedAt:Date.parse(OLD)-600000},tplus3:{readiness:'red',completedAt:Date.parse(OLD)+180000}}});
await storage.put('status',{scheduleBaselineAt:Date.now()});
globalThis.fetch=async()=>Response.json({jogos:[{
 event_id:ID,espn_league:'bra.1',data_iso:NEW,competicao_chave:'brasileirao',
 mandante:{nome:'Botafogo',espn_id:'6086'},
 visitante:{nome:'São Paulo',espn_id:'2026'},estado:'pre',concluido:false
}]});
try{
 const monitor=new SportsMonitor({storage},{DB:db});
 await monitor.bootstrap();
 assert.equal((await storage.get('watchlist'))[ID].kickoff,NEW);
 assert.equal((await storage.get('preflight'))[ID],undefined,'historical T-10/T+3 must not block next kickoff');
 assert.equal(db.incidents.get(key).severity,'resolved');
 assert.equal(db.incidents.get(key).email_status,'rescheduled_silent');
 await monitor.bootstrap();
 assert.equal(db.incidents.get(key).email_status,'rescheduled_silent','same schedule must be idempotent');
 console.log('R36 readiness reschedule / old incident re-armed and dedup safe: PASS');
}finally{Date.now=realNow;globalThis.fetch=realFetch}
