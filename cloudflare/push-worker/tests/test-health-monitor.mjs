import assert from 'node:assert/strict';
import { countWebSearchCalls } from '../src/ai-usage.js';
assert.equal(countWebSearchCalls({output:[{type:'web_search_call'},{type:'message'},{type:'web_search_call'}]}),2);
assert.equal(countWebSearchCalls({}),0);
console.log('health-monitor/ai-usage tests: PASS');
