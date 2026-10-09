import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPS_INTELLIGENCE_CONSTANTS, ragTokens, rankRagChunks } from '../src/ops-intelligence.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(here,'../../..');
const index=JSON.parse(fs.readFileSync(path.join(repo,'dados-br/ops-rag-index.json'),'utf8'));

assert.equal(OPS_INTELLIGENCE_CONSTANTS.ragRuntimeVersion,1);
assert.equal(OPS_INTELLIGENCE_CONSTANTS.mcpProtocolVersion,'2026-07-28');
assert.equal(index.runtime,'fdg-ops-rag');
assert.ok(index.chunk_count>=20);
assert.ok(ragTokens('Renda R$ 708.004,50 + PÚBLICO 15.056').includes('renda'));

const collision=rankRagChunks(index,'renda igual publico Fluminense Coritiba',{topK:3,scope:'incidents'});
assert.ok(collision.length>0);
assert.match(collision[0].path,/PUBLIC-REVENUE-FIELD-COLLISION/i);

const finalRegression=rankRagChunks(index,'FINAL regrediu para in pre ESPN',{topK:4,scope:'incidents'});
assert.ok(finalRegression.some(x=>/FINAL-REGRESSION/i.test(x.path)));

const noSportsAuthority=rankRagChunks(index,'probabilidades classificacao autoridade deterministica',{topK:5,scope:'all'});
assert.ok(noSportsAuthority.some(x=>/CONTRACTS\.md/.test(x.path)||/OPS-INTELLIGENCE-RAG-MCP/.test(x.path)));

console.log('ops-intelligence tests: PASS');
