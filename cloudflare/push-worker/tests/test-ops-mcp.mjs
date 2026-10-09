import assert from 'node:assert/strict';
import { handleOpsMcp, mcpBearerAuthorized, mcpHostAuthorized, OPS_MCP_CONSTANTS } from '../src/ops-mcp.js';

assert.equal(OPS_MCP_CONSTANTS.protocolVersion,'2026-07-28');
assert.equal(OPS_MCP_CONSTANTS.readOnly,true);
assert.equal(OPS_MCP_CONSTANTS.tools.length,5);
assert.equal(OPS_MCP_CONSTANTS.resources.length,2);

assert.equal(mcpHostAuthorized(new Request('https://push.formuladogol.com.br/mcp'),{}),true);
assert.equal(mcpHostAuthorized(new Request('https://evil.example/mcp'),{}),false);
assert.equal(mcpHostAuthorized(new Request('https://ops.example/mcp'),{OPS_MCP_ALLOWED_HOSTS:'ops.example'}),true);
assert.equal(mcpBearerAuthorized(new Request('https://push.formuladogol.com.br/mcp'),{}),true);
assert.equal(mcpBearerAuthorized(new Request('https://push.formuladogol.com.br/mcp'),{OPS_MCP_TOKEN:'abc'}),false);
assert.equal(mcpBearerAuthorized(new Request('https://push.formuladogol.com.br/mcp',{headers:{authorization:'Bearer abc'}}),{OPS_MCP_TOKEN:'abc'}),true);

const modernMeta={
  'io.modelcontextprotocol/protocolVersion':'2026-07-28',
  'io.modelcontextprotocol/clientInfo':{name:'fdg-ci',version:'1.0.0'},
  'io.modelcontextprotocol/clientCapabilities':{}
};

let nextRequestId=1;
async function rpc(method,params={},name=''){
  const id=nextRequestId++;
  const headers={
    'content-type':'application/json',
    'accept':'application/json, text/event-stream',
    'MCP-Protocol-Version':'2026-07-28',
    'Mcp-Method':method,
  };
  if(name) headers['Mcp-Name']=name;
  const request=new Request('https://push.formuladogol.com.br/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id,method,params:{...params,_meta:modernMeta}})});
  const response=await handleOpsMcp(request,{});
  assert.equal(response.status,200,`${method} HTTP ${response.status}: ${await response.clone().text()}`);
  const raw=await response.text();
  // createMcpHandler normally returns JSON for these finite requests; tolerate SSE framing too.
  const jsonText=raw.startsWith('event:')?(raw.match(/data:\s*(\{[\s\S]*\})\s*$/m)?.[1]||'{}'):raw;
  return JSON.parse(jsonText);
}

const discover=await rpc('server/discover');
assert.equal(discover.jsonrpc,'2.0');
assert.ok(Array.isArray(discover.result?.supportedVersions));
assert.ok(discover.result.supportedVersions.includes('2026-07-28'));

const listed=await rpc('tools/list');
const names=(listed.result?.tools||[]).map(x=>x.name).sort();
assert.deepEqual(names,[...OPS_MCP_CONSTANTS.tools].sort());
for(const tool of listed.result.tools) assert.equal(tool.annotations?.readOnlyHint,true);

const statusCall=await rpc('tools/call',{name:'fdg_ops_status',arguments:{}});
assert.equal(statusCall.jsonrpc,'2.0');
assert.notEqual(statusCall.result?.isError,true);
const statusText=(statusCall.result?.content||[]).find(x=>x?.type==='text')?.text||'';
assert.match(statusText,/fdg-ops-intelligence/);

console.log('ops-mcp protocol tests: PASS');
