#!/usr/bin/env python3
"""Somente leitura: audit Athletico-PR v Remo goal push delivery."""
import json,os,urllib.error,urllib.request
from datetime import datetime,timezone
id=os.environ.get("FDG_EVENT","401841318")
token=os.environ.get("CLOUDFLARE_API_TOKEN","")
account=os.environ.get("CLOUDFLARE_ACCOUNT_ID","")
result={"event_id":id,"utc":datetime.now(timezone.utc).isoformat(),"mode":"READ_ONLY_NO_REPLAY","public":{},"d1":{},"findings":[]}
def get(url,data=None,token=""):
    hdr={"User-Agent":"FDG-Goal-Forensic/1","Accept":"application/json"}
    if token:hdr["Authorization"]="Bearer "+token
    if data is not None:hdr["Content-Type"]="application/json"
    req=urllib.request.Request(url,data=json.dumps(data).encode() if data is not None else None,headers=hdr)
    try:
        with urllib.request.urlopen(req,timeout=12) as r:return r.status,json.load(r)
    except urllib.error.HTTPError as ex:
        try:return ex.code,json.loads(ex.read().decode())
        except:return ex.code,{}
    except Exception as ex:return 0,{"error":str(ex)[:130]}
for name,route in [("monitor","/v1/monitor/status"),("dispatch","/v1/dispatch/status"),("events","/v1/monitor/events"),("live","/v1/live/state?league=bra.1&dates=20261122&fresh=1")]:
    status,d=get("https://push.formuladogol.com.br"+route)
    if name=="monitor":
        match=next((x for x in d.get("matches",[]) if str(x.get("eventId"))==id),None)
        result["public"][name]={"http":status,"active":d.get("activeGames"),"poll":d.get("lastPollCompletedAt"),"error":d.get("lastPollError"),"watch":d.get("watchCount"),"match":match,"reconciliation":(d.get("goalReconciliation") or {}).get(id)}
    elif name=="dispatch":
        result["public"][name]={"http":status,"subs":d.get("activeSubscriptions"),"pending":d.get("pendingEvents"),"deliveries":d.get("deliveries"),"recent_goals":[x for x in d.get("recentGoals",[]) if str(x.get("eventId") or x.get("event_id"))==id]}
    elif name=="events":
        rows=d.get("recentEvents",d.get("events",[]))
        result["public"][name]={"http":status,"matching":[{"type":x.get("type"),"key":x.get("eventKey")} for x in rows if str(x.get("eventId"))==id] if isinstance(rows,list) else []}
    else:
        game=next((x for x in (d.get("data") or {}).get("events",[]) if str(x.get("id"))==id),None)
        result["public"][name]={"http":status,"found":bool(game),"state":(game or {}).get("status")}
if token and account:
    root="https://api.cloudflare.com/client/v4/accounts/"+account+"/d1/database"
    code,data=get(root+"?per_page=100",token=token)
    db=next((x for x in data.get("result",[]) if x.get("name")=="formula-do-gol-push"),None)
    if db:
        result["d1"]["available"]=True
        endpoint=root+"/"+str(db.get("uuid") or db.get("id"))+"/query"
        sqls={
          "goals":"SELECT event_key,minute,home_score,away_score,confirmed_at,created_at FROM sports_events WHERE event_id=? AND event_type='goal' ORDER BY created_at",
          "dispatch":"SELECT e.event_key,d.status,d.target_count,d.last_error,(SELECT COUNT(*) FROM push_deliveries v WHERE v.event_key=e.event_key) deliveries,(SELECT COUNT(*) FROM push_deliveries v WHERE v.event_key=e.event_key AND v.status='sent') sent,(SELECT COUNT(*) FROM push_deliveries v WHERE v.event_key=e.event_key AND v.status='gone') gone FROM sports_events e LEFT JOIN push_event_dispatch d ON d.event_key=e.event_key WHERE e.event_id=? AND e.event_type='goal' ORDER BY e.created_at",
          "preflight":"SELECT checkpoint,readiness,source_state,monitor_initialized,reasons_json,checked_at FROM monitor_preflight WHERE event_id=? ORDER BY checked_at",
          "audience":"SELECT COUNT(DISTINCT s.installation_id) goal_enabled FROM push_subscriptions s JOIN push_preferences_v3 p ON s.installation_id=p.installation_id WHERE s.active=1 AND p.goals=1"
        }
        for name,sql in sqls.items():
            code,data=get(endpoint,{"sql":sql,"params":[] if name=="audience" else [id]},token)
            chunks=data.get("result") or []
            result["d1"][name]={"http":code,"ok":data.get("success"),"rows":chunks[0].get("results",[]) if chunks else [],"errors":[x.get("message") for x in data.get("errors",[])]}
    else:result["d1"]={"available":False,"http":code,"errors":[x.get("message") for x in data.get("errors",[])]}
else:result["d1"]={"available":False,"reason":"Cloudflare secret unavailable"}
goals=result["d1"].get("goals",{}).get("rows")
dispatch=result["d1"].get("dispatch",{}).get("rows")
if goals is None:result["findings"].append("D1 indisponivel: nao podemos provar emissao/entrega")
elif not goals:result["findings"].append("Nenhum GOAL confirmado persistido pelo monitor")
else:
    if len(goals)<2:result["findings"].append("Menos de 2 gols persistidos como eventos push")
    for x in dispatch or []:
        if not x.get("status"):result["findings"].append("GOL sem registro na fila: "+x["event_key"])
        elif x.get("status")=="expanded" and x.get("target_count")==0:result["findings"].append("Sem inscritos elegiveis: "+x["event_key"])
        elif (x.get("sent") or 0)>0:result["findings"].append("Provedor aceitou push, exibicao nao comprovada")
        elif x.get("status") in ("failed","pending"):result["findings"].append("Fila falhou ou ficou pendente: "+x["event_key"])
print(json.dumps(result,ensure_ascii=False,indent=2))
if os.environ.get("GITHUB_STEP_SUMMARY"):
    with open(os.environ["GITHUB_STEP_SUMMARY"],"a",encoding="utf-8") as f:
        f.write("## Gol sem push - auditoria somente leitura\n\nEvento: "+id+"\n\n")
        f.write(json.dumps(result,ensure_ascii=False,indent=2))
