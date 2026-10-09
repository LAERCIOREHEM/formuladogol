import { createMcpHandler, McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { healthMonitorStatus } from './health-monitor.js';
import { postgameStatus } from './postgame-fastlane.js';
import {
  OPS_INTELLIGENCE_CONSTANTS,
  loadOpsRag,
  opsIntelligenceStatus,
  opsReliabilityContext,
  searchOpsRag,
} from './ops-intelligence.js';

export const OPS_MCP_CONSTANTS = Object.freeze({
  name: 'formula-do-gol-ops',
  version: '1.0.0',
  endpoint: '/mcp',
  protocolVersion: OPS_INTELLIGENCE_CONSTANTS.mcpProtocolVersion,
  readOnly: true,
  tools: Object.freeze([
    'fdg_ops_status',
    'fdg_rag_search',
    'fdg_incident_lookup',
    'fdg_reliability_context',
    'fdg_postgame_status',
  ]),
  resources: Object.freeze(['fdg://ops/rag-manifest','fdg://ops/reliability']),
});

function text(v){ return String(v ?? '').trim(); }
function asTextResult(value){
  const payload=value && typeof value==='object'?value:{value};
  return {content:[{type:'text',text:JSON.stringify(payload,null,2)}],structuredContent:payload};
}
function compactHealth(status){
  const snap=status?.snapshot||{};
  return {
    ok:status?.ok===true,
    state:snap?.state||null,
    policyVersion:Number(snap?.policyVersion||0),
    at:snap?.at||null,
    indicators:Array.isArray(snap?.indicators)?snap.indicators:[],
    reliabilityIntelligence:snap?.reliabilityIntelligence||null,
    dailyDelivery:status?.dailyDelivery||null,
    scheduler:status?.scheduler||null,
  };
}
function compactPostgame(status){
  return {
    ok:status?.ok===true, engine:status?.engine||'', version:Number(status?.version||0), storedPolicyVersion:Number(status?.storedPolicyVersion||0),
    total:Number(status?.total||0), publicResolved:Number(status?.publicResolved||0), publicPending:Number(status?.publicPending||0),
    publicSearching:Number(status?.publicSearching||0), publicOverdue:Number(status?.publicOverdue||0), publicBudgetGuard:Number(status?.publicBudgetGuard||0),
    highlightPending:Number(status?.highlightPending||0), lastRun:status?.lastRun||null,
    factualIntegrity:{matchIdentityGateVersion:Number(status?.matchIdentityGateVersion||0),sourceScopedExtraction:status?.sourceScopedExtraction===true,modelValuesAuthoritative:status?.modelValuesAuthoritative===true,verifiedCorrectionsOverrideD1:status?.verifiedCorrectionsOverrideD1===true},
    aiPolicy:{geminiDiscoveryOnly:status?.geminiDiscoveryOnly===true,openAiRequiredWebSearch:status?.openAiRequiredWebSearch===true}
  };
}

const READ_ONLY_ANNOTATIONS=Object.freeze({readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});

export function buildOpsMcpServer(env){
  const server=new McpServer({name:OPS_MCP_CONSTANTS.name,version:OPS_MCP_CONSTANTS.version},{capabilities:{tools:{},resources:{}}});

  server.registerTool('fdg_ops_status',{
    title:'FDG Ops Intelligence Status',
    description:'Retorna o estado da camada R10R17: RAG operacional, MCP read-only e integração com o Health. Não altera dados.',
    annotations:READ_ONLY_ANNOTATIONS,
  },async()=>asTextResult(await opsIntelligenceStatus(env)));

  server.registerTool('fdg_rag_search',{
    title:'FDG Operational RAG Search',
    description:'Recupera contratos, runbooks e incidentes do corpus operacional. Use para diagnóstico/contexto; nunca como autoridade de placar, classificação, probabilidades, público ou renda.',
    inputSchema:fromJsonSchema({type:'object',additionalProperties:false,properties:{query:{type:'string',minLength:2,maxLength:320},top_k:{type:'integer',minimum:1,maximum:8,default:5},scope:{type:'string',enum:['all','incidents','runbooks','operations'],default:'all'}},required:['query']}),
    annotations:READ_ONLY_ANNOTATIONS,
  },async({query,top_k=5,scope='all'})=>asTextResult(await searchOpsRag(env,query,{topK:top_k,scope})));

  server.registerTool('fdg_incident_lookup',{
    title:'FDG Incident Lookup',
    description:'Busca incidentes reais e regressões conhecidas do Fórmula do Gol por código, event_id, sintoma ou termo técnico.',
    inputSchema:fromJsonSchema({type:'object',additionalProperties:false,properties:{query:{type:'string',minLength:2,maxLength:320},event_id:{type:'string',maxLength:40},top_k:{type:'integer',minimum:1,maximum:8,default:5}},required:['query']}),
    annotations:READ_ONLY_ANNOTATIONS,
  },async({query,event_id='',top_k=5})=>{
    const q=[text(query),text(event_id)].filter(Boolean).join(' ');
    return asTextResult(await searchOpsRag(env,q,{topK:top_k,scope:'incidents'}));
  });

  server.registerTool('fdg_reliability_context',{
    title:'FDG Reliability Context',
    description:'Lê o estado CORE/ENRICHMENT, auditoria factual e health/status do Orchestrator. Somente leitura.',
    annotations:READ_ONLY_ANNOTATIONS,
  },async()=>asTextResult(await opsReliabilityContext(env)));

  server.registerTool('fdg_postgame_status',{
    title:'FDG Postgame Status',
    description:'Retorna um resumo seguro do Fastlane pós-jogo: cobertura, pendências, SLA e políticas de integridade. Não executa busca nem IA.',
    annotations:READ_ONLY_ANNOTATIONS,
  },async()=>asTextResult(compactPostgame(await postgameStatus(env))));

  server.registerResource('fdg-rag-manifest','fdg://ops/rag-manifest',{title:'FDG Operational RAG Manifest',mimeType:'application/json'},async(uri)=>{
    const loaded=await loadOpsRag(env);
    return {contents:[{uri:uri.href,mimeType:'application/json',text:JSON.stringify(loaded.manifest||{ok:false,problems:loaded.problems},null,2)}]};
  });
  server.registerResource('fdg-reliability','fdg://ops/reliability',{title:'FDG Reliability Context',mimeType:'application/json'},async(uri)=>{
    const payload=await opsReliabilityContext(env);
    return {contents:[{uri:uri.href,mimeType:'application/json',text:JSON.stringify(payload,null,2)}]};
  });
  return server;
}

export function mcpHostAuthorized(request,env){
  const host=text(new URL(request.url).hostname).toLowerCase();
  const configured=text(env?.OPS_MCP_ALLOWED_HOSTS).split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
  const allowed=new Set(['push.formuladogol.com.br','localhost','127.0.0.1',...configured]);
  return allowed.has(host);
}

export function mcpBearerAuthorized(request,env){
  const required=text(env?.OPS_MCP_TOKEN);
  if(!required) return true;
  const auth=text(request.headers.get('authorization'));
  if(!auth.toLowerCase().startsWith('bearer ')) return false;
  return auth.slice(7).trim()===required;
}

export async function handleOpsMcp(request,env){
  if(!mcpHostAuthorized(request,env)){
    return new Response(JSON.stringify({error:'host_not_allowed',service:OPS_MCP_CONSTANTS.name}),{status:403,headers:{'content-type':'application/json; charset=utf-8'}});
  }
  if(!mcpBearerAuthorized(request,env)){
    return new Response(JSON.stringify({error:'unauthorized',service:OPS_MCP_CONSTANTS.name}),{status:401,headers:{'content-type':'application/json; charset=utf-8','www-authenticate':'Bearer realm="fdg-ops-mcp"'}});
  }
  const handler=createMcpHandler(()=>buildOpsMcpServer(env));
  return handler.fetch(request);
}

export async function opsMcpHealth(env){
  const [ops,health]=await Promise.all([opsIntelligenceStatus(env),healthMonitorStatus(env)]);
  return {ok:ops.ok===true,service:OPS_MCP_CONSTANTS.name,version:OPS_MCP_CONSTANTS.version,protocolVersion:OPS_MCP_CONSTANTS.protocolVersion,readOnly:true,tools:OPS_MCP_CONSTANTS.tools,resources:OPS_MCP_CONSTANTS.resources,ops,health:compactHealth(health)};
}
