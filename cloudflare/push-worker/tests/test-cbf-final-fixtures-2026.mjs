import assert from 'node:assert/strict';
import { CBF_FIXTURES_2026, officialPrematchCheck } from '../src/cbf-final-fixtures-2026.js';
import { deriveScheduleEvents } from '../src/sports-monitor.js';
import { processQueueBody } from '../src/push-dispatch.js';

const withTime = (league, home, away, kickoff) => ({
  type: 'prematch_15', eventId: 'test-cbf-2026', league, kickoff,
  home: {name: home}, away: {name: away}, postponed: false, cancelled: false,
  competitionName: league === 'bra.1' ? 'Brasileirão' : 'Copa do Brasil'
});
assert.equal(CBF_FIXTURES_2026.length, 25, '24 Brasileirão + 1 final da Copa do Brasil');
const unique = new Set(CBF_FIXTURES_2026.map(([l,h,a]) => [l,h,a].join(':')));
assert.equal(unique.size,25,'confronto duplicado');
for(const [league,home,away,kickoff] of CBF_FIXTURES_2026){
  const approved=withTime(league,home,away,kickoff);
  assert.deepEqual(officialPrematchCheck(approved).allowed,true,home+' x '+away);
  const shifted=withTime(league,home,away,new Date(Date.parse(kickoff)-3*3600_000).toISOString());
  assert.equal(officialPrematchCheck(shifted).allowed,false,'fuso de três horas não pode disparar T-15: '+home+' x '+away);
  const now=Date.parse(kickoff)-15*60_000;
  const fresh=deriveScheduleEvents({}, {[home+'-'+away]: approved},now);
  assert.equal(fresh.length,1,'lembrete T-15 oficial deve existir '+home+' x '+away);
  const stale=deriveScheduleEvents({}, {[home+'-'+away]: shifted},Date.parse(shifted.kickoff)-15*60_000);
  assert.equal(stale.length,0,'lembrete T-15 adiantado deve ser suprimido '+home+' x '+away);
}
const botafogo=withTime('bra.1','Botafogo','São Paulo','2026-11-23T17:00:00-03:00');
assert.equal(officialPrematchCheck(botafogo).reason,'kickoff_mismatch');
assert.equal(deriveScheduleEvents({}, {botafogo},Date.parse(botafogo.kickoff)-15*60_000).length,0);
assert.equal(officialPrematchCheck(withTime('bra.1','Red Bull Bragantino','Fluminense','2026-12-02T21:30:00-03:00')).allowed,true);
assert.equal(officialPrematchCheck(withTime('bra.1','América-MG','Santos','2026-12-01T20:00:00-03:00')).allowed,false);
assert.equal(officialPrematchCheck(withTime('bra.copa_do_brazil','Grêmio','Palmeiras','2026-12-06T17:00:00-03:00')).allowed,false);
assert.equal(officialPrematchCheck(withTime('bra.copa_do_brazil','Grêmio','Palmeiras','2026-12-06T16:00:00-03:00')).allowed,true);
assert.equal(officialPrematchCheck(withTime('conmebol.libertadores','Palmeiras','Estudiantes','2026-11-28T17:00:00-03:00')).allowed,true,'Libertadores não deve ser bloqueada');
assert.equal(officialPrematchCheck({...botafogo,type:'goal'}).allowed,true,'gols nunca devem ser bloqueados');
console.log('PASS R36: 24 jogos Série A + 1 final Copa; horários BRT, T-15 e filas incorretas bloqueados');

// R36: despacho já registrado no D1 antes da correção documental não pode
// expandir para destinatários. O banco aceita somente status='failed' no veto.
{
  const oldPush = withTime('bra.1','Botafogo','São Paulo','2026-11-23T17:00:00-03:00');
  const oldEventKey = 'prematch_15:401841326:historical';
  const updates = [];
  const db = {
    prepare(sql) {
      let params = [];
      return {
        bind(...args) { params = args; return this; },
        async first() {
          if (sql.includes('FROM sports_events') || sql.includes('FROM essential_match_events')) return null;
          if (sql.includes('FROM match_events')) {
            return { event_key: oldEventKey, event_type: 'prematch_15', payload_json: JSON.stringify(oldPush) };
          }
          throw new Error('consulta D1 inesperada: '+sql.slice(0,70));
        },
        async run() {
          updates.push({sql,params});
          return {meta:{changes:1}};
        }
      };
    }
  };
  const response = await processQueueBody({kind:'event_dispatch',eventKey:oldEventKey}, {DB:db, PUSH_QUEUE:{send:async()=>{throw Error('fila não deve ser alimentada')}}});
  assert.equal(response.suppressed,true);
  assert.equal(response.targetCount,0);
  assert.equal(updates.length,1);
  assert.match(updates[0].sql,/status='failed'/);
  assert.match(updates[0].params[0],/cbf_fixture_guard:kickoff_mismatch/);
}
