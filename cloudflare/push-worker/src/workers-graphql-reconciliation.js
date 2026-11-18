/* R38-E2: Workers GraphQL Analytics, operational estimates ONLY.
   Sampling, retention and coverage differ from billed usage. Never turn GraphQL
   aggregates into certified billable quantities or charges. */
const QUERY = `query WorkersAnalyticsR38($accountTag: string, $start: string, $end: string) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      workersInvocationsAdaptive(limit: 10000, filter: {
        datetime_geq: $start, datetime_leq: $end
      }) {
        dimensions { scriptName }
        sum { requests cpuTimeUs }
      }
    }
  }
}`;
const DAY=86400000, MAX_ROWS=10000;
const ms=x=>{const n=Date.parse(String(x||''));return Number.isFinite(n)?n:null};
const number=x=>{if(x==null||x==='')return null;const n=Number(x);return Number.isFinite(n)&&n>=0?n:null};
const iso=n=>new Date(n).toISOString();
const unusable=(reason,extra={})=>({status:'unavailable',source:'workersInvocationsAdaptive',reason,...extra});
export function analyticsWindows(start,end) {
  const a=ms(start),b=ms(end);
  if(a==null||b==null||b<=a||b-a>32*DAY) return [];
  const windows=[];
  for(let p=a;p<b;p+=7*DAY) windows.push({start:iso(p),end:iso(Math.min(p+7*DAY,b)-1)});
  return windows;
}
export function reconcileWorkersAnalytics(billing,analytics) {
  const b=billing?.workers||{};
  const g=analytics||unusable('not_queried');
  // Billing alone can certify billable usage. GraphQL is never a billing fallback.
  const samePeriod=g.periodStart===b.periodStart&&g.periodEnd===b.periodEnd;
  const comparable=g.status==='estimated'&&samePeriod&&b.status==='verified';
  const diff=(a,c)=>comparable&&a!=null&&c!=null&&c>0
    ?Number(((a-c)/c*100).toFixed(2)):null;
  return {
    source:'billing-v1 + workers-graphql',
    billingStatus:b.status||'unavailable',
    analyticsStatus:g.status,
    analyticsReason:g.reason||null,
    operationalCpuMs:g.status==='estimated'?g.cpuMs:null,
    operationalRequests:g.status==='estimated'?g.requests:null,
    operationalScriptCount:g.status==='estimated'?g.scripts?.length:null,
    operationalScripts:g.status==='estimated'?g.scripts:[],
    analyticsPeriodStart:g.periodStart||null,
    analyticsPeriodEnd:g.periodEnd||null,
    billingCpuMs:b.cpuMs??null,billingRequests:b.requests??null,
    cpuDifferencePct:diff(g.cpuMs,b.cpuMs),
    requestDifferencePct:diff(g.requests,b.requests),
    comparable,
    dataQuality:g.status==='estimated'?(comparable?'cross_check_only':'different_source_or_missing_billing'):'analytics_unavailable',
    billableCertified:b.status==='verified',
    warning:'GraphQL é estimativa operacional, não substitui consumo faturável nem valida franquias/cobranças.',
  };
}
export async function fetchWorkersAnalyticsGraphQL({token,account,start,end,fetchImpl=fetch,timeoutMs=9000}) {
  if(!token||!account) return unusable('analytics_read_not_configured');
  const windows=analyticsWindows(start,end);
  if(!windows.length) return unusable('invalid_or_excessive_window');
  const scripts=new Map();let count=0,requests=0,cpuUs=0;
  for(const window of windows) {
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),timeoutMs);
    let response;
    try {
      response=await fetchImpl('https://api.cloudflare.com/client/v4/graphql',{
        method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
        body:JSON.stringify({query:QUERY,variables:{accountTag:account,start:window.start,end:window.end}}),
        signal:controller.signal
      });
      if(!response.ok) return unusable(`graphql_http_${response.status}`);
      const payload=await response.json();
      if(payload?.errors?.length) return unusable('graphql_query_errors',{
        errorTypes:payload.errors.slice(0,3).map(e=>String(e?.extensions?.code||'graphql_error').slice(0,32))
      });
      const accounts=payload?.data?.viewer?.accounts;
      if(!Array.isArray(accounts)||accounts.length!==1) return unusable('graphql_account_scope_invalid');
      const rows=accounts[0]?.workersInvocationsAdaptive;
      if(!Array.isArray(rows)) return unusable('graphql_dataset_missing');
      if(rows.length>=MAX_ROWS) return unusable('graphql_row_limit_reached',{
        rowsSeen:count+rows.length
      });
      for(const row of rows) {
        const req=number(row?.sum?.requests),cpu=number(row?.sum?.cpuTimeUs);
        if(req==null||cpu==null) return unusable('graphql_invalid_metric');
        const script=String(row?.dimensions?.scriptName||'').trim();
        if(!script||script.length>128) return unusable('graphql_script_identity_missing');
        count++;requests+=req;cpuUs+=cpu;
        const previous=scripts.get(script)||{name:script,requests:0,cpuMs:0};
        previous.requests+=req;previous.cpuMs+=cpu/1000;scripts.set(script,previous);
      }
    } catch(_) {return unusable('graphql_network_or_timeout');}
    finally {clearTimeout(timeout);}
  }
  if(!count)return unusable('graphql_no_rows');
  if(!Number.isSafeInteger(Math.round(requests))||!Number.isFinite(cpuUs))
    return unusable('graphql_overflow');
  return {
    status:'estimated',source:'workersInvocationsAdaptive',reason:'adaptive_sampled_operational',
    periodStart:start,periodEnd:end,
    requests:Number(requests.toFixed(2)),cpuMs:Number((cpuUs/1000).toFixed(3)),
    rows:count,windows:windows.length,
    scripts:[...scripts.values()].sort((a,b)=>b.cpuMs-a.cpuMs).slice(0,20).map(r=>({
      name:r.name,requests:Number(r.requests.toFixed(2)),cpuMs:Number(r.cpuMs.toFixed(3))
    })),scriptCount:scripts.size,
    completeness:'non_truncated_rows_only',
    billingEquivalent:false
  };
}
