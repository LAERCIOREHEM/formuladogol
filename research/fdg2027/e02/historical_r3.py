"""R3: bounded API-Football recovery; compatible with R2 encrypted state."""
import argparse
import collections
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
import historical_r2 as r2
import player_data_discovery as base

PLANS={"free":100,"pro":7500}
YEARS=(2026,2025,2024,2023,2022)

def integer(x):
    if isinstance(x,bool): return None
    if isinstance(x,int) and x>=0: return x
    if isinstance(x,str) and x.isdecimal() and len(x)<=9: return int(x)
    return None

def plan_status(data):
    a=base.obj(base.obj(data).get("response"))
    p=base.get(a,"subscription","plan")
    p=p.strip().casefold() if isinstance(p,str) else ""
    limit=integer(base.get(a,"requests","limit_day"))
    used=integer(base.get(a,"requests","current"))
    active=base.get(a,"subscription","active")
    valid=p in PLANS and PLANS[p]==limit and used is not None and used<=limit and active is True
    return {"plan":p if p in PLANS else "unknown","daily_limit":limit,"reported_usage":used,
            "active":active if isinstance(active,bool) else None,"verified":valid}

class Probe(r2.ResearchProbe):
    def __init__(self,keys,state,path,limit,transport=None):
        super().__init__(keys,state,path,limit,0)
        if transport is not None: self.transport=transport
        self.plan=None
        self.halted=None
        self.local_limit=limit

    def call(self,source,endpoint,params=None,cost=1):
        if source!="football" or self.halted or source in self.blocked:
            return None
        if self.used[source]+cost>self.local_limit:
            self.halted="run_budget"; return None
        if endpoint!="status" and not self.status_verified:
            self.halted="status_not_verified"; return None
        # Daily ledger is inherited across encrypted R2/R3 checkpoints.
        key="football:"+self.day
        ledger=self.state["ledger"]
        prior=ledger.get(key,18 if self.day==r2.BASELINE_DATE else 0)
        cap=150 if self.plan=="pro" else 90
        if prior+cost>cap:
            self.halted="daily_research_budget"; return None
        if self.remaining is not None and self.remaining<=10:
            self.halted="provider_quota_reserve"; return None
        if self.last_football is not None:
            r2.time.sleep(max(0,6.2-(r2.time.monotonic()-self.last_football)))
        self.last_football=r2.time.monotonic()
        ledger[key]=prior+cost
        r2.save(self.path,self.state)
        before=self.remaining
        # Inspect errors only to classify them, never retain body or print secrets.
        original=self.transport
        tags=[]
        def classified(req):
            data,headers=original(req)
            errors=base.obj(data).get("errors")
            if errors:
                e=str(errors).casefold()
                if "suspend" in e: tags.append("account_suspended")
                elif any(x in e for x in ("rate","quota","too many","limit per")): tags.append("rate_or_quota")
                elif any(x in e for x in ("invalid key","api key","token","access","authentication")): tags.append("access_denied")
            return data,headers
        self.transport=classified
        try:
            data=base.Probe.call(self,source,endpoint,params,cost)
        finally:
            self.transport=original
        if before is not None and self.remaining is not None:
            self.remaining=min(self.remaining,max(0,before-cost))
        status=self.calls[-1]["status"] if self.calls else "not_attempted"
        if tags:
            self.halted=tags[0]
        elif status in ("auth_or_quota_error","http_401","http_402","http_403","http_429"):
            self.halted=status
        elif status.startswith("http_5") or status=="transport_or_json_error":
            self.halted="transient_provider_failure"
        elif data is None:
            self.halted=status
        if self.halted:
            self.blocked.add("football")
        return data

    def verify_football(self):
        d=plan_status(self.call("football","status"))
        self.status_verified=d["verified"] and not self.halted
        if self.status_verified:
            self.plan=d["plan"]
            avail=d["daily_limit"]-d["reported_usage"]
            self.remaining=min(self.remaining if self.remaining is not None else avail,avail)
        else:
            self.halted=self.halted or "unverified_plan"
        d["reason"]=self.halted or "verified"
        self.state["provider_checks"]["r3_status"]=d
        r2.save(self.path,self.state)
        print("API-Football status (sanitized): "+json.dumps(d))
        return self.status_verified

def assess(f,expected):
    if not r2.validate_football(f,expected): return False,False
    groups=base.arr(f.get("lineups"))
    ids={str(base.get(expected,"teams",s,"id")) for s in ("home","away")}
    lineup=(len(groups)==2 and {str(base.get(g,"team","id")) for g in groups}==ids and
            all(len(base.arr(g.get("startXI")))==11 and
                len({str(base.get(x,"player","id") or "") for x in g["startXI"]})==11 and
                all(base.get(x,"player","id") for x in g["startXI"]) for g in groups))
    return True, bool(lineup and isinstance(f.get("events"),list))

def store(state,f,expected):
    valid,detail=assess(f,expected)
    if not valid: return False
    fid=r2.football_id(f)
    old=state["historical"].get(fid)
    if old and assess(old,expected)[1] and not detail: return False
    state["historical"][fid]={k:f.get(k) for k in ("fixture","league","teams","goals","score","players","events","lineups","statistics")}
    return detail

def catalogue(probe,state,year):
    data=probe.call("football","fixtures",{"league":71,"season":year})
    if data is None: return False
    rows=base.arr(data.get("response"))
    cat=r2.complete_catalog(data,year)
    # Refuse partial catalogues rather than treating a provider subset as a full season.
    all_ids={r2.football_id(f) for f in rows if base.get(f,"league","id")==71 and base.get(f,"league","season")==year}
    if len(all_ids)!=380 or "" in all_ids or len(cat)>380 or (year!=2026 and len(cat)!=380) or (year==2026 and not cat):
        probe.halted="catalogue_integrity"; return False
    prior=state["catalog"].get(str(year),{})
    if not set(prior).issubset(cat):
        probe.halted="catalogue_regression"; return False
    state["catalog"][str(year)]=cat
    r2.save(probe.path,state)
    return True

def homologate(probe,state,years):
    if not probe.verify_football(): return False
    for year in (years[0],years[-1]):
        if str(year) not in state["catalog"] and not catalogue(probe,state,year): return False
    cat=state["catalog"][str(years[0])]
    ids=sorted(cat)[:20]
    data=probe.call("football","fixtures",{"ids":"-".join(ids)})
    if data is None: return False
    found={}
    for f in base.arr(data.get("response")):
        fid=r2.football_id(f)
        if fid in ids:
            found[fid]=store(state,f,cat[fid])
    diagnostic={"requested":len(ids),"returned_unique":len(found),"detailed_validated":sum(found.values())}
    state["provider_checks"]["r3_batch"]=diagnostic
    for fid in found: state["attempts"][fid]=max(1,state["attempts"].get(fid,0))
    r2.save(probe.path,state)
    print("Batch certification: "+json.dumps(diagnostic))
    diagnostic["plan"]=probe.plan
    diagnostic["certified"]=bool(len(ids)==20 and len(found)==20 and all(found.values()))
    diagnostic["transport_verified"]=bool(ids and len(found)==len(ids) and any(found.values()))
    r2.save(probe.path,state)
    if not diagnostic["transport_verified"]:
        probe.halted="batch_not_certified"; return False
    return True

def recover(probe,state,years):
    for year in years:
        # Refresh current season every collection; historical catalogues are immutable.
        if (year==2026 or len(state["catalog"].get(str(year),{}))!=380) and not catalogue(probe,state,year):
            return
        cat=state["catalog"][str(year)]
        def complete(fid): return assess(state["historical"].get(fid,{}),cat[fid])[1]
        pending=[fid for fid in sorted(cat) if not complete(fid) and state["attempts"].get(fid,0)==0]
        for i in range(0,len(pending),20):
            ids=pending[i:i+20]
            data=probe.call("football","fixtures",{"ids":"-".join(ids)})
            if data is None: return
            for fid in ids: state["attempts"][fid]=1
            for f in base.arr(data.get("response")):
                fid=r2.football_id(f)
                if fid in ids: store(state,f,cat[fid])
            r2.save(probe.path,state)
        # Complete the grouped first pass across all seasons before selective retries.
    for year in years:
        cat=state["catalog"][str(year)]
        def complete(fid): return assess(state["historical"].get(fid,{}),cat[fid])[1]
        for fid in sorted(cat):
            if complete(fid) or state["attempts"].get(fid,0)>=3: continue
            data=probe.call("football","fixtures",{"id":fid})
            if data is None: return
            state["attempts"][fid]=max(2,state["attempts"].get(fid,0)+1)
            for f in base.arr(data.get("response")):
                if r2.football_id(f)==fid: store(state,f,cat[fid])
            r2.save(probe.path,state)
        print("Season "+str(year)+": "+str(sum(complete(fid) for fid in cat))+"/"+str(len(cat))+" detailed fixtures")

def report(probe,state,years,mode):
    out={}
    identities=collections.defaultdict(set)
    for year in years:
        cat=state["catalog"].get(str(year),{})
        counts=collections.Counter()
        reasons=collections.Counter()
        filled=collections.Counter()
        active=0
        candidates=segments=0
        for fid,expected in cat.items():
            f=state["historical"].get(fid,{})
            valid,detail=assess(f,expected)
            counts["validated_players"]+=valid
            counts["detailed"]+=detail
            if not valid: continue
            rows=base.normalize_football({"response":f["players"]})
            cv=base.coverage(rows)
            active+=cv["active_rows"]
            filled.update(cv["filled_active"])
            for row in rows:
                if row.get("id") and row.get("name"): identities[str(row["id"])].add(base.norm(row["name"]))
            timeline=r2.historical_timeline(f)
            reasons[timeline["reason"]]+=1
            if timeline["candidate"]:
                candidates+=1; segments+=timeline["segments"]
        out[str(year)]={"scheduled_target":380,"final_catalogued":len(cat),"validated_players":counts["validated_players"],
            "detailed":counts["detailed"],"active_rows":active,"field_coverage_pct":{k:round(100*filled[k]/active,2) if active else None for k in base.FIELDS},
            "timeline_candidates":candidates,"candidate_segments":segments,"timeline_reasons":dict(reasons),
            "unresolved":len(cat)-counts["detailed"],"exhausted":sum(state["attempts"].get(fid,0)>=3 and not assess(state["historical"].get(fid,{}),e)[1] for fid,e in cat.items())}
    return {"execution":"FDG-2027-E02-R3","mode":mode,"utc":r2.now().isoformat(),"seasons":out,"plan":state["provider_checks"].get("r3_status"),
            "batch":state["provider_checks"].get("r3_batch"),"stop_reason":probe.halted,
            "attempts":dict(probe.used),"ledger":state["ledger"],"unique_provider_ids":len(identities),
            "ids_with_multiple_name_forms":sum(len(v)>1 for v in identities.values()),
            "cross_provider_mapping_certified":False,"rapm_trained":False,"production_ready":False,
            "historical_complete_as_of_catalogue":all(v["final_catalogued"]>0 and v["detailed"]==v["final_catalogued"] and (y=="2026" or v["final_catalogued"]==380) for y,v in out.items())}

def self_test():
    def status(p,limit,used=14,active=True):
        return {"response":{"subscription":{"plan":p,"active":active},"requests":{"limit_day":limit,"current":used}}}
    assert plan_status(status(" Pro ","7500","14"))["verified"]
    assert plan_status(status("Free",100))["verified"]
    assert not plan_status(status("Pro",100))["verified"]
    assert not plan_status(status("Pro",7500,active=False))["verified"]
    assert not plan_status(status("Pro",7500,True))["verified"]
    assert not plan_status({"errors":{"access":"suspended"}})["verified"]
    with tempfile.TemporaryDirectory() as d,patch("time.sleep"):
        path=Path(d)/"state.json"; state=r2.load(path)
        p=Probe({"football":"fake"},state,path,5,lambda req:(status("Pro",7500),{}))
        assert p.verify_football() and p.plan=="pro"
        for _ in range(7): p.call("football","fixtures")
        assert p.used["football"]==5 and p.halted=="run_budget"
        p=Probe({"football":"fake"},state,path,5,lambda req:({"errors":{"access":"Your account is suspended"},"response":[]},{"x-ratelimit-requests-remaining":"99"}))
        assert not p.verify_football() and p.halted=="account_suspended"
        assert p.call("football","fixtures") is None and p.used["football"]==1
    assert assess({}, {})==(False,False)
    print("PASS: FREE/PRO contract, quota, suspension, fail-closed and R2 compatibility")

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--state",required=False)
    parser.add_argument("--report",required=False)
    parser.add_argument("--mode",choices=("probe","recover"),default="probe")
    parser.add_argument("--limit",type=int,default=5)
    parser.add_argument("--self-test",action="store_true")
    a=parser.parse_args()
    if a.self_test: self_test(); return 0
    if not a.state or not a.report or not 1<=a.limit<=150 or (a.mode=="probe" and a.limit>5): return 2
    if not os.getenv("API_FOOTBALL_KEY"): print("BLOCKED: missing API_FOOTBALL_KEY"); return 2
    state=r2.load(Path(a.state))
    probe=Probe({"football":os.getenv("API_FOOTBALL_KEY")},state,Path(a.state),a.limit)
    # Probe every run, even after prior suspension; manual dispatch only.
    ok=probe.verify_football()
    years=YEARS if probe.plan=="pro" else (2024,2023,2022)
    if ok:
        if a.mode=="probe":
            # verify_football already ran; homologate uses current verified account.
            ok=homologate_verified(probe,state,years)
        elif not state["provider_checks"].get("r3_batch",{}).get("transport_verified") or state["provider_checks"]["r3_batch"].get("plan")!=probe.plan:
            probe.halted="run_probe_first"; ok=False
        else:
            recover(probe,state,years)
    result=report(probe,state,years,a.mode)
    r2.save(Path(a.report),result)
    lines=["## FDG 2027 E02-R3 — "+a.mode,"","| Season | Final catalogued | Player data | Detailed | RAPM candidates |","|---|---:|---:|---:|---:|"]
    for y,v in result["seasons"].items():
        lines.append(f"| {y} | {v['final_catalogued']} | {v['validated_players']} | {v['detailed']} | {v['timeline_candidates']} |")
    lines+=["","Plan: "+str(probe.plan),"Batch: "+json.dumps(result["batch"]),
            "Requests: "+json.dumps(result["attempts"]),"Stop: "+str(probe.halted),
            "Complete as of catalogue: "+str(result["historical_complete_as_of_catalogue"]),
            "Research only — production not certified."]
    msg="\n".join(lines); print(msg)
    if os.getenv("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"],"a",encoding="utf-8") as f:f.write(msg+"\n")
    return 0 if ok and probe.halted in (None,"run_budget","daily_research_budget","provider_quota_reserve") else 2

def homologate_verified(probe,state,years):
    # Reuse the certified status without a duplicate network call.
    with patch.object(probe,"verify_football",return_value=True):
        return homologate(probe,state,years)

if __name__=="__main__": sys.exit(main())
