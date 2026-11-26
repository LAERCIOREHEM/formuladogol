import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as f from './foundation.mjs';
const vectors=JSON.parse(readFileSync(new URL('./test-vectors.json',import.meta.url),'utf8'));
for(const [name,args,expected] of vectors) {
  if(expected===null) assert.throws(()=>f[name](...args),name+JSON.stringify(args));
  else assert.deepEqual(f[name](...args),expected,name+JSON.stringify(args));
}
assert.equal(f.REG.public_switch_enabled,false);
assert.equal(f.REG.production_write_enabled,false);
for(const d of f.REG.namespace_domains) assert.notEqual(f.namespace(2026,d,'same-id'),f.namespace(2027,d,'same-id'));
console.log('PASS: '+vectors.length+' shared contract vectors and namespace isolation');
