import assert from 'node:assert/strict';
import { aiGatewayId, gatewayBase, geminiConfigured, geminiGroundingSources, geminiSearchCount } from '../src/ai-router.js';
assert.equal(aiGatewayId({}), 'default');
assert.equal(gatewayBase({AI_GATEWAY_ACCOUNT_ID:'abc',AI_GATEWAY_ID:'default'},'openai'),'https://gateway.ai.cloudflare.com/v1/abc/default/openai');
assert.equal(geminiConfigured({AI_GATEWAY_ACCOUNT_ID:'abc',GEMINI_API_KEY:'x'}),true);
const raw={candidates:[{groundingMetadata:{webSearchQueries:['q1','q2'],groundingChunks:[{web:{uri:'https://example.com/a'}},{web:{uri:'https://example.com/b'}}]}}]};
assert.equal(geminiSearchCount(raw),2); assert.deepEqual(geminiGroundingSources(raw),['https://example.com/a','https://example.com/b']);
console.log('ai-router tests: PASS');
