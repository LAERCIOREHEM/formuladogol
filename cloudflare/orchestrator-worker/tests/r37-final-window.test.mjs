import test from 'node:test';
import assert from 'node:assert/strict';
import {r37FinalWindow,r37NextFinalProbe} from '../src/logic.js';
const kickoff=new Date('2026-11-24T21:00:00Z');
const game={eventId:'401841335',league:'bra.1',kickoff,concluded:false};
const at=m=>new Date(kickoff.getTime()+m*60000);
test('R37 extra FINAL probe bounded to real Brazilian match window',()=>{
 assert.equal(r37NextFinalProbe([game],at(94)),null);
 assert.equal(r37NextFinalProbe([game],at(95)),at(100).getTime());
 assert.equal(r37FinalWindow([game],at(99)).length,0);
 assert.equal(r37FinalWindow([game],at(100)).length,1);
 assert.equal(r37NextFinalProbe([game],at(115)),at(116).getTime());
 assert.equal(r37NextFinalProbe([game],at(145)),null);
 assert.equal(r37FinalWindow([game],at(146)).length,0);
 assert.equal(r37NextFinalProbe([{...game,concluded:true}],at(115)),null);
 assert.equal(r37NextFinalProbe([{...game,league:'conmebol.libertadores'}],at(115)),null);
 assert.equal(r37NextFinalProbe([],at(115)),null);
});
