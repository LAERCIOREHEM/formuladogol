import assert from 'node:assert/strict';
import {
  sourceExtractionDigest, sourceExtractionCacheDecision, extractSourceWithCache,
  EXTRACTION_CACHE_NEGATIVE_MS, EXTRACTION_CACHE_POSITIVE_MS
} from '../src/source-extraction-cache.js';

const digest = await sourceExtractionDigest('abc');
assert.equal(digest, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
assert.equal(sourceExtractionCacheDecision(null,'f','m'), 'miss');
assert.equal(sourceExtractionCacheDecision({version:1,fingerprint:'f',model:'m',at:1000,status:'negative'},'f','m',1000+EXTRACTION_CACHE_NEGATIVE_MS-1),'negative');
assert.equal(sourceExtractionCacheDecision({version:1,fingerprint:'f',model:'m',at:1000,status:'negative'},'f','m',1000+EXTRACTION_CACHE_NEGATIVE_MS),'miss');
assert.equal(sourceExtractionCacheDecision({version:1,fingerprint:'f',model:'m',at:1000,status:'positive',parsed:{encontrado:true}},'f','m',1000+EXTRACTION_CACHE_POSITIVE_MS-1),'positive');

const records = new Map();
const db = { prepare(sql) { return { bind(...args) { return {
  async first() { return {value:records.get(args[0]) ?? null}; },
  async run() { records.set(args[0],args[1]); return {success:true}; }
}; } }; } };
const env = { DB:db };
const task={event_id:'fixture-1'};
const source={url:'https://ge.globo.com/futebol/jogo',text:'Flamengo x Santos. Público declarado na ficha.'};
const valid = p => p?.encontrado===true && p?.confianca>=.9 && p?.publico===12345;
let calls=0;
const positive = async () => {calls++;return {found:true,parsed:{encontrado:true,confianca:1,publico:12345}};};
const negative = async () => {calls++;return {found:false,reason:'invalid_json',parsed:null};};
const args = (extract,model='@cf/meta/llama-3.1-8b-instruct-fp8',now=1000000)=>({model,extract,validate:valid,now});

assert.equal((await extractSourceWithCache(env,task,source,args(positive))).cacheState,'miss');
assert.equal(calls,1);
assert.equal((await extractSourceWithCache(env,task,source,args(positive))).cacheState,'hit_positive');
assert.equal(calls,1,'mesma URL/texto/modelo não pode executar duas inferências');
assert.equal((await extractSourceWithCache(env,task,{...source,text:source.text+' ATUALIZADO'},args(positive))).cacheState,'miss');
assert.equal(calls,2,'mudança do conteúdo reabre inferência');
assert.equal((await extractSourceWithCache(env,task,source,args(positive,'@cf/meta/llama-3.3-70b-instruct-fp8-fast'))).cacheState,'miss');
assert.equal(calls,3,'troca de modelo invalida fingerprint');
assert.equal((await extractSourceWithCache(env,task,source,args(positive,undefined,1000000+EXTRACTION_CACHE_POSITIVE_MS))).cacheState,'miss');
assert.equal(calls,4,'sucesso expira após seis horas');

const source2={...source,url:source.url+'/sem-dados'};
assert.equal((await extractSourceWithCache(env,task,source2,args(negative))).cacheState,'miss');
assert.equal(calls,5);
assert.equal((await extractSourceWithCache(env,task,source2,args(positive))).cacheState,'hit_negative');
assert.equal(calls,5,'falha temporária não chama IA novamente');
assert.equal((await extractSourceWithCache(env,task,source2,args(positive,undefined,1000000+EXTRACTION_CACHE_NEGATIVE_MS))).cacheState,'miss');
assert.equal(calls,6,'falha expirada é retentada');

const noDb=await extractSourceWithCache({},task,source,args(positive));
assert.equal(noDb.cacheState,'miss');
assert.equal(calls,7,'ausência de DB preserva fallback');
console.log('OK: R10R19 source extraction dedup + TTL + content/model invalidation');
