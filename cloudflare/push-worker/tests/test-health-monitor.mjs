import assert from 'node:assert/strict';
import { countWebSearchCalls } from '../src/ai-usage.js';
import { githubActionsSeverity, isDailyDigestDue } from '../src/health-monitor.js';

assert.equal(countWebSearchCalls({output:[{type:'web_search_call'},{type:'message'},{type:'web_search_call'}]}),2);
assert.equal(countWebSearchCalls({}),0);

assert.equal(githubActionsSeverity({dormant:true,dispatches:4,previousDispatches:4,pendingPostgameTasks:0,hoursToNext:240,hasPrevious:true}).severity,'green');
assert.equal(githubActionsSeverity({dormant:true,dispatches:5,previousDispatches:4,pendingPostgameTasks:0,hoursToNext:240,hasPrevious:true}).severity,'red');
assert.equal(githubActionsSeverity({dormant:true,dispatches:4,previousDispatches:0,pendingPostgameTasks:0,hoursToNext:240,hasPrevious:false}).severity,'green');
assert.equal(githubActionsSeverity({dormant:false,dispatches:9,previousDispatches:8,pendingPostgameTasks:1,hoursToNext:1,hasPrevious:true}).severity,'yellow');

assert.equal(isDailyDigestDue({date:'2026-09-22',hour:8,minute:1},''),true);
assert.equal(isDailyDigestDue({date:'2026-09-22',hour:23,minute:5},''),false);
assert.equal(isDailyDigestDue({date:'2026-09-22',hour:8,minute:5},'2026-09-22'),false);

console.log('health-monitor/ai-usage tests: PASS');
