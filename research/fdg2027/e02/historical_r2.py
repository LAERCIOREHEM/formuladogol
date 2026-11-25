"""FDG 2027 R2. Private, resumable research; never publishes player records."""
import argparse
import collections
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path
import player_data_discovery as base

YEARS = (2022, 2023, 2024)
FIELDS = base.FIELDS
EXPECTED = 380
BASELINE_DATE = "2026-11-25"
BASELINE_MONTH = "2026-11"

def now():
    return dt.datetime.now(dt.timezone.utc)

def save(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)

def load(path):
    if not path.exists():
        return {"schema":1,"catalog":{},"historical":{},"attempts":{},"recent":{},
                "ledger":{},"provider_checks":{}}
    state=json.loads(path.read_text(encoding="utf-8"))
    if state.get("schema") != 1 or not all(isinstance(state.get(k),dict) for k in
           ("catalog","historical","attempts","recent","ledger","provider_checks")):
        raise ValueError("invalid research checkpoint")
    return state

class ResearchProbe(base.Probe):
    def __init__(self, keys, state, path, football_limit, striker_limit):
        super().__init__(keys)
        self.state, self.path = state, path
        base.LIMITS = {"football":football_limit,"striker":striker_limit,"espn":8}
        self.last_football = None
        self.day = now().date().isoformat()
        self.month = self.day[:7]
        self.status_verified = False

    def call(self, source, endpoint, params=None, cost=1):
        if source in self.blocked or self.used[source]+cost > base.LIMITS[source]:
            return None
        ledger=self.state["ledger"]
        period=self.day if source=="football" else self.month if source=="striker" else self.day
        key=source+":"+period
        initial=18 if source=="football" and period==BASELINE_DATE else 55 if source=="striker" and period==BASELINE_MONTH else 0
        reserved=ledger.get(key,initial)
        cap={"football":90,"striker":400,"espn":20}[source]
        if reserved+cost>cap:
            self.blocked.add(source)
            return None
        if source=="football":
            if endpoint!="status" and not self.status_verified:
                return None
            if self.remaining is not None and self.remaining<=10:
                self.blocked.add(source)
                return None
            if self.last_football is not None:
                time.sleep(max(0,6.2-(time.monotonic()-self.last_football)))
            self.last_football=time.monotonic()
        ledger[key]=reserved+cost
        save(self.path,self.state)  # reserve before transport, never refund locally
        before=self.remaining
        data=super().call(source,endpoint,params,cost)
        if source=="football" and before is not None and self.remaining is not None:
            self.remaining=min(self.remaining,max(0,before-cost))
        return data

    def verify_football(self):
        r=self.call("football","status")
        account=base.obj(base.obj(r).get("response"))
        plan=base.get(account,"subscription","plan")
        limit=base.get(account,"requests","limit_day")
        current=base.get(account,"requests","current")
        self.status_verified=(str(plan).lower()=="free" and limit==100 and isinstance(current,int))
        if self.status_verified:
            self.remaining=min(self.remaining if self.remaining is not None else 100,100-current)
        else:
            self.blocked.add("football")
        self.state["provider_checks"]["football_free_verified"]=self.status_verified
        save(self.path,self.state)
        return self.status_verified

def football_id(f):
    return str(base.get(f,"fixture","id") or "")

def complete_catalog(data,year):
    rows=base.arr(base.obj(data).get("response"))
    out={}
    for f in rows:
        if base.get(f,"league","id")!=71 or base.get(f,"league","season")!=year:
            continue
        if base.get(f,"fixture","status","short") not in ("FT","AET","PEN"):
            continue
        fid=football_id(f)
        if fid:
            out[fid]={"fixture":f.get("fixture"),"league":f.get("league"),"teams":f.get("teams"),
                      "goals":f.get("goals"),"score":f.get("score")}
    return out

def validate_football(f, expected):
    if football_id(f)!=football_id(expected) or base.football_key(f)!=base.football_key(expected):
        return False
    if base.get(f,"league","id")!=71 or base.get(f,"league","season")!=base.get(expected,"league","season"):
        return False
    if f.get("goals")!=expected.get("goals"):
        return False
    groups=base.arr(f.get("players"))
    expected_teams={str(base.get(expected,"teams",s,"id")) for s in ("home","away")}
    seen_teams={str(base.get(g,"team","id")) for g in groups}
    if len(groups)!=2 or seen_teams!=expected_teams:
        return False
    for group in groups:
        rows=base.arr(group.get("players"))
        ids=[str(base.get(p,"player","id") or "") for p in rows]
        active=[p for p in rows if isinstance(base.get(p,"statistics"),list) and
                p["statistics"] and isinstance(base.get(p["statistics"][0],"games","minutes"),(int,float)) and
                base.get(p["statistics"][0],"games","minutes")>0]
        if len(active)<11 or "" in ids or len(ids)!=len(set(ids)):
            return False
    return True

def store_football(state, f, expected):
    if not validate_football(f,expected):
        return False
    fid=football_id(f)
    state["historical"][fid]={k:f.get(k) for k in ("fixture","league","teams","goals","score","players","events","lineups")}
    return True

def collect_history(probe,state,path):
    if not probe.verify_football():
        return
    # First obtain all three catalogues. No assumption that advertised coverage means actual data.
    for year in YEARS:
        y=str(year)
        if len(state["catalog"].get(y,{}))!=EXPECTED:
            data=probe.call("football","fixtures",{"league":71,"season":year})
            if data:
                catalogue=complete_catalog(data,year)
                if catalogue:
                    state["catalog"][y]=catalogue
                    save(path,state)
    if not all(len(state["catalog"].get(str(y),{}))==EXPECTED for y in YEARS):
        return
    # First pass uses grouped fixture IDs (20 per documented query).
    for year in YEARS:
        catalogue=state["catalog"][str(year)]
        pending=[fid for fid in sorted(catalogue) if fid not in state["historical"] and state["attempts"].get(fid,0)==0]
        for i in range(0,len(pending),20):
            ids=pending[i:i+20]
            before=probe.used["football"]
            batch_supported=state["provider_checks"].get("batch_supported",True)
            if not batch_supported:
                break
            data=probe.call("football","fixtures",{"ids":"-".join(ids)})
            if probe.used["football"]==before:
                return
            if data is None:
                # Fall back only on explicit plan restriction, not transport/quota errors.
                if probe.calls and probe.calls[-1]["status"]=="plan_or_season_restriction":
                    state["provider_checks"]["batch_supported"]=False
                    save(path,state)
                    break
                return
            state["provider_checks"]["batch_supported"]=True
            for fid in ids:
                state["attempts"][fid]=1
            for f in base.arr(data.get("response")):
                fid=football_id(f)
                if fid in ids:
                    store_football(state,f,catalogue[fid])
            save(path,state)
    # Targeted fallback only for records not validated by grouped endpoint.
    for year in YEARS:
        for fid,expected in state["catalog"][str(year)].items():
            count=state["attempts"].get(fid,0)
            if fid in state["historical"] or count>=2 or (count==0 and state["provider_checks"].get("batch_supported",True)):
                continue
            before=probe.used["football"]
            data=probe.call("football","fixtures",{"id":fid})
            if probe.used["football"]==before:
                return
            if data is None:
                return
            state["attempts"][fid]=2
            for f in base.arr(data.get("response")):
                if football_id(f)==fid:
                    store_football(state,f,expected)
            save(path,state)

def clock_minute(value):
    # Regulation-clock approximation; added time intentionally excluded.
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not 0<=value<=130:
        return None
    return min(90,value)

def minute_interval(p, events):
    start=clock_minute(p.get("minute_on"))
    end=clock_minute(p.get("minute_off"))
    if p.get("starter") is True and start is None:
        start=0
    if start is None:
        return (None,None,"unused_or_unknown")
    if p.get("starter") is True and start!=0:
        return (None,None,"contradictory_start")
    red=[clock_minute(e.get("minute")) for e in events
         if str(e.get("player_id"))==str(p.get("player_id")) and
         base.norm(e.get("type")) in ("red card","second yellow card","yellow red card")]
    red=[x for x in red if x is not None]
    if red:
        end=min([x for x in [end,*red] if x is not None])
    elif p.get("red_cards") and end is None:
        return (None,None,"red_card_time_unknown")
    method="event_or_recorded_exit" if end is not None else "assumed_regulation_end"
    if end is None:
        end=90
    if end<start:
        return (None,None,"contradictory_exit")
    return (start,end,method)

def striker_analysis(data, football=None, espn=None):
    game=base.obj(data.get("game"))
    players=base.arr(data.get("players"))
    events=base.arr(data.get("key_events"))
    teams={str(base.get(game,s,"team_id")) for s in ("home","away")}
    goals={str(base.get(game,s,"team_id")):base.get(game,s,"score") for s in ("home","away")}
    intervals=[]
    methods=collections.Counter()
    for p in players:
        if str(p.get("team_id")) not in teams or not p.get("player_id"):
            continue
        a,b,method=minute_interval(p,events)
        methods[method]+=1
        if a is not None and b>a:
            intervals.append((str(p["team_id"]),str(p["player_id"]),a,b))
    boundaries=sorted({0,90,*[v for _,_,a,b in intervals for v in (a,b)]})
    invalid=0
    usable=0
    for a,b in zip(boundaries,boundaries[1:]):
        count=collections.Counter(t for t,_,x,y in intervals if x<=a and y>=b)
        if any(not 7<=count[t]<=11 for t in teams):
            invalid+=1
        else:
            usable+=1
    starters=collections.Counter(str(p.get("team_id")) for p in players if p.get("starter") is True)
    duplicate_ids=len({(str(p.get("team_id")),str(p.get("player_id"))) for p in players})!=len(players)
    # Own goals and missing event types are not guessed; require score reconciliation.
    goal_events=[e for e in events if base.norm(e.get("type"))=="goal" and not e.get("shootout")]
    tally=collections.Counter(str(e.get("team_id")) for e in goal_events)
    score_reconciled=all(isinstance(goals[t],int) and tally[t]==goals[t] for t in teams)
    full_timeline=(len(teams)==2 and all(starters[t]==11 for t in teams) and
                   not duplicate_ids and invalid==0 and score_reconciled and
                   not methods["red_card_time_unknown"] and not methods["contradictory_exit"] and
                   not methods["contradictory_start"])
    # Same match + exact unique normalized name/club only, not persistent identity proof.
    sp=base.normalize_striker(data)
    fp=base.normalize_football({"response":base.arr(base.obj(football).get("players"))}) if football else []
    ep=base.normalize_espn(espn) if espn else []
    def unique_index(rows):
        out=collections.defaultdict(list)
        for p in rows:
            out[(p.get("team"),base.norm(p.get("name")))].append(p)
        return {k:v[0] for k,v in out.items() if k[0] and k[1] and len(v)==1}
    si=unique_index(sp)
    fi=unique_index(fp)
    comparisons=[]
    for k in si.keys() & fi.keys():
        sr=next((p for p in players if str(p.get("player_id"))==str(si[k].get("id"))),None)
        if sr is None:
            continue
        a,b,_=minute_interval(sr,events)
        actual=fi[k].get("minutes")
        if a is not None and isinstance(actual,(int,float)) and not isinstance(actual,bool):
            comparisons.append(abs((b-a)-actual))
    # ESPN player-stat keys are inspected separately from team boxscores.
    individual_stats=collections.Counter()
    for group in base.arr(base.obj(espn).get("rosters")):
        for p in base.arr(group.get("roster") or group.get("athletes")):
            for s in base.arr(p.get("stats") or p.get("statistics")):
                name=s.get("name") or s.get("label")
                if isinstance(name,str) and len(name)<=80:
                    individual_stats[name]+=1
    return {"player_rows":len(players),"positive_regulation_intervals":len(intervals),
            "minutes_methods":dict(methods),"valid_starter_counts":sorted(starters.values()),
            "segments":usable,"invalid_segments":invalid,"goal_events_reconcile":score_reconciled,
            "timeline_candidate_not_certified":full_timeline,
            "minute_comparison_count":len(comparisons),
            "minute_mae":round(sum(comparisons)/len(comparisons),3) if comparisons else None,
            "minute_exact_count":sum(x==0 for x in comparisons),
            "espn_individual_stat_keys":dict(individual_stats),
            "identity_espn":base.unique_pairs(ep,sp),"identity_football":base.unique_pairs(fp,sp),
            "coverage":base.coverage(sp)}

def lineup_crosscheck(game_data,line_data):
    if base.striker_key(base.obj(game_data.get("game")))!=base.striker_key(base.obj(line_data.get("game"))):
        return {"identity_verified":False}
    if str(base.get(game_data,"game","game_id"))!=str(base.get(line_data,"game","game_id")):
        return {"identity_verified":False}
    key=lambda p,t:(str(t),str(p.get("player_id") or ""))
    raw=base.arr(game_data.get("players"))
    matches={key(p,p.get("team_id")):p for p in raw}
    groups=base.arr(line_data.get("lineups"))
    counts=[]; comparisons=0; mismatches=0; missing=0
    for g in groups:
        t=g.get("team_id")
        starters=base.arr(g.get("starting_xi"))
        counts.append(len(starters))
        for p in starters+base.arr(g.get("substitutes_used")):
            other=matches.get(key(p,t))
            if other is None:
                missing+=1
                continue
            comparisons+=1
            if any(p.get(f)!=other.get(f) for f in ("minute_on","minute_off")):
                mismatches+=1
    return {"identity_verified":True,"starters":sorted(counts),"minute_pairs_compared":comparisons,
            "minute_pair_mismatches":mismatches,"players_missing":missing,
            "same_provider_consistency_only":True}

def recent_sample(probe,state,path):
    for year in (2026,2024,2025):
        y=str(year)
        if y in state["recent"]:
            continue
        params={"season":year,"team":"Palmeiras","status":"final","limit":50}
        if probe.used["striker"]+7>base.LIMITS["striker"]:
            break
        raw=probe.call("striker","list_games",params,2)
        chosen=base.select_striker(base.arr(base.obj(raw).get("games")),year)
        if not chosen:
            continue
        if year==2026 and (base.striker_key(chosen)[1:]!=("chapecoense","palmeiras") or base.striker_key(chosen)[0] not in ("2026-11-24","2026-11-25")):
            continue
        data=probe.call("striker","get_game",{"game_id":str(chosen.get("game_id"))},5)
        if not data or base.striker_key(base.obj(data.get("game")))!=base.striker_key(chosen):
            continue
        if str(base.get(data,"game","game_id"))!=str(chosen.get("game_id")):
            continue
        key=base.striker_key(chosen)
        football=base.unique_match(list(state["historical"].values()),base.football_key,key)
        espn=None
        board=probe.call("espn","scoreboard",{"dates":key[0].replace("-",""),"limit":100})
        match=base.unique_match(base.arr(base.obj(board).get("events")),base.espn_event_key,key)
        if match and match.get("id"):
            espn=probe.call("espn","summary",{"event":match["id"]})
        # Keep only the fields needed for research. Never store market data.
        safe={k:data.get(k) for k in ("game","players","key_events")}
        state["recent"][y]={"data":safe,"analysis":striker_analysis(safe,football,espn)}
        save(path,state)
        if year==2026 and probe.used["striker"]+5<=base.LIMITS["striker"]:
            line=probe.call("striker","get_lineups",{"game_id":str(chosen.get("game_id"))},5)
            if line:
                state["recent"][y]["analysis"]["lineup_crosscheck"]=lineup_crosscheck(safe,line)
                save(path,state)

def historical_timeline(f):
    """Check event/lineup consistency; no model fitting or future-derived xG."""
    teams={str(base.get(f,"teams",s,"id")) for s in ("home","away")}
    active={}
    starts={}
    ends={}
    if len(teams)!=2:
        return {"candidate":False,"reason":"invalid_team"}
    for g in base.arr(f.get("lineups")):
        t=str(base.get(g,"team","id"))
        ids=[str(base.get(x,"player","id") or "") for x in base.arr(g.get("startXI"))]
        if t not in teams or t in active or len(ids)!=11 or len(set(ids))!=11 or "" in ids:
            return {"candidate":False,"reason":"invalid_starting_xi"}
        active[t]=set(ids)
        starts.update({(t,p):0 for p in ids})
    if set(active)!=teams:
        return {"candidate":False,"reason":"missing_lineups"}
    events=base.arr(f.get("events"))
    valid=[]
    for i,e in enumerate(events):
        minute=clock_minute(base.get(e,"time","elapsed"))
        if minute is None:
            return {"candidate":False,"reason":"invalid_event_clock"}
        valid.append((minute,i,e))
    tally=collections.Counter()
    boundaries={0,90}
    for minute,_,e in sorted(valid):
        t=str(base.get(e,"team","id"))
        kind=base.norm(e.get("type"))
        detail=base.norm(e.get("detail"))
        pid=str(base.get(e,"player","id") or "")
        if kind=="goal":
            if t not in teams:
                return {"candidate":False,"reason":"invalid_goal_team"}
            tally[t]+=1
        elif kind=="subst" or (kind=="card" and detail in ("red card","second yellow card","yellow red card")):
            if t not in teams or pid not in active[t]:
                return {"candidate":False,"reason":"unresolved_substitution_or_red"}
            active[t].remove(pid); ends[(t,pid)]=minute; boundaries.add(minute)
            if kind=="subst":
                entering=str(base.get(e,"assist","id") or "")
                if not entering or (t,entering) in starts:
                    return {"candidate":False,"reason":"invalid_substitute"}
                active[t].add(entering); starts[(t,entering)]=minute
    if any(tally[str(base.get(f,"teams",side,"id"))]!=base.get(f,"goals",side) for side in ("home","away")):
        return {"candidate":False,"reason":"goal_event_mismatch"}
    intervals={k:(a,ends.get(k,90)) for k,a in starts.items()}
    ordered=sorted(boundaries)
    for a,b in zip(ordered,ordered[1:]):
        count=collections.Counter(t for (t,_),(x,y) in intervals.items() if x<=a and y>=b)
        if any(not 7<=count[t]<=11 for t in teams):
            return {"candidate":False,"reason":"invalid_on_pitch_counts"}
    errs=[]
    missing=0
    for group in base.arr(f.get("players")):
        t=str(base.get(group,"team","id"))
        for p in base.arr(group.get("players")):
            pid=str(base.get(p,"player","id"))
            stats=base.arr(p.get("statistics"))
            m=base.get(stats[0],"games","minutes") if stats else None
            if isinstance(m,(int,float)) and m>0:
                if (t,pid) not in intervals:
                    missing+=1
                    continue
                a,b=intervals[(t,pid)]
                errs.append(abs((b-a)-m))
    if missing or not errs or max(errs)>5:
        return {"candidate":False,"reason":"minutes_mismatch","minute_comparisons":len(errs)}
    return {"candidate":True,"reason":"regulation_timeline_candidate",
            "segments":len(ordered)-1,"minute_comparisons":len(errs),
            "minute_abs_error_sum":sum(errs)}

def summary(state,probe):
    seasons={}
    for year in YEARS:
        cat=state["catalog"].get(str(year),{})
        valid=[state["historical"][fid] for fid in cat if fid in state["historical"]]
        counts=collections.Counter()
        timeline_reasons=collections.Counter()
        timeline_candidates=segments=minute_n=minute_error=0
        active=0
        for f in valid:
            rows=base.normalize_football({"response":f["players"]})
            cv=base.coverage(rows)
            active+=cv["active_rows"]
            counts.update(cv["filled_active"])
            timeline=historical_timeline(f)
            timeline_reasons[timeline["reason"]]+=1
            if timeline["candidate"]:
                timeline_candidates+=1
                segments+=timeline["segments"]
                minute_n+=timeline["minute_comparisons"]
                minute_error+=timeline["minute_abs_error_sum"]
        seasons[str(year)]={"expected":EXPECTED,"catalogued":len(cat),"validated":len(valid),
            "first_pass_attempted":sum(fid in state["attempts"] for fid in cat),
            "active_rows":active,"filled_active":dict(counts),
            "timeline_candidates":timeline_candidates,"candidate_segments":segments,
            "timeline_reasons":dict(timeline_reasons),
            "timeline_minute_mae":round(minute_error/minute_n,3) if minute_n else None,
            "unresolved_after_fallback":sum(state["attempts"].get(fid)==2 and fid not in state["historical"] for fid in cat)}
    complete=all(v["validated"]==EXPECTED for v in seasons.values())
    attempted=all(v["catalogued"]==EXPECTED and v["first_pass_attempted"]==EXPECTED for v in seasons.values())
    recent={y:r["analysis"] for y,r in state["recent"].items()}
    return {"execution":"FDG-2027-E02-R2","utc":now().isoformat(),"historical":seasons,
            "historical_complete":complete,"historical_first_pass_complete":attempted,
            "recent_samples":recent,"attempted_this_run":dict(probe.used),
            "call_diagnostics":dict(collections.Counter(c["source"]+":"+c["endpoint"]+":"+c["status"] for c in probe.calls)),
            "reserved_cumulative":state["ledger"],"provider_checks":state["provider_checks"],
            "rights":{"striker":"internal storage/model training permitted; no bulk redistribution",
                      "football":"publication rights not granted; internal evaluation only pending rights review"},
            "rapm":{"sample_timeline_candidates":sum(r["timeline_candidate_not_certified"] for r in recent.values()),
                    "trained":False,"xg_as_of":False,"production_ready":False},
            "production_ready":False}

def self_test():
    assert minute_interval({"starter":True,"minute_on":0,"minute_off":None},[])==(0,90,"assumed_regulation_end")
    assert minute_interval({"starter":False,"minute_on":None},[])[0] is None
    assert minute_interval({"starter":False,"minute_on":71,"minute_off":80},[])[:2]==(71,80)
    assert minute_interval({"starter":True,"player_id":"1","red_cards":1},[{"player_id":"1","type":"red-card","minute":63}])[:2]==(0,63)
    assert minute_interval({"starter":True,"red_cards":1},[])[0] is None
    assert minute_interval({"starter":False,"minute_on":80,"minute_off":70},[])[0] is None
    assert clock_minute(94)==90 and clock_minute(True) is None
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        path=Path(tmp)/"state.json"
        state=load(path); state["ledger"]["test"]=3; save(path,state)
        assert load(path)["ledger"]["test"]==3
    assert not validate_football({}, {})
    assert not historical_timeline({})["candidate"]
    assert lineup_crosscheck({"game":{"game_id":"1"}},{"game":{"game_id":"2"}})["identity_verified"] is False
    print("PASS: regulation minutes, red cards, unknowns, checkpoint and invalid fixture")

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--state",default="state.json")
    p.add_argument("--report",default="report.json")
    p.add_argument("--football-limit",type=int,default=65)
    p.add_argument("--striker-limit",type=int,default=25)
    p.add_argument("--self-test",action="store_true")
    a=p.parse_args()
    if a.self_test:
        self_test()
        return 0
    if not 1<=a.football_limit<=65 or not 0<=a.striker_limit<=25:
        return 2
    keys={"football":os.getenv("API_FOOTBALL_KEY"),"striker":os.getenv("STRIKER_API_KEY")}
    if not all(keys.values()):
        print("BLOCKED: required API secrets missing")
        return 2
    path=Path(a.state)
    state=load(path)
    probe=ResearchProbe(keys,state,path,a.football_limit,a.striker_limit)
    collect_history(probe,state,path)
    result=summary(state,probe)
    if result["historical_first_pass_complete"] and a.striker_limit:
        recent_sample(probe,state,path)
    save(path,state)
    result=summary(state,probe)
    save(Path(a.report),result)
    lines=["## FDG 2027 E02-R2 — Historical recovery and feasibility","",
           "| Season | Expected | Catalogued | Validated | First pass | Active player rows |",
           "|---|---:|---:|---:|---:|---:|"]
    for y,r in result["historical"].items():
        lines.append(f"| {y} | {r['expected']} | {r['catalogued']} | {r['validated']} | {r['first_pass_attempted']} | {r['active_rows']} |")
    for y,r in result["historical"].items():
        lines.append(f"- {y}: {r['timeline_candidates']} candidate timelines, {r['candidate_segments']} segments, reconstructed minute MAE={r['timeline_minute_mae']}")
    lines += ["","Complete historical dataset: "+str(result["historical_complete"]),
              "Historical first pass: "+str(result["historical_first_pass_complete"]),
              "Recent samples: "+", ".join(result["recent_samples"]),
              "Reserved attempts this run: "+json.dumps(result["attempted_this_run"]),
              "Research only; no production certification. Missing data is not zero."]
    for year,r in result["recent_samples"].items():
        lines.append(f"- {year}: {r['positive_regulation_intervals']} reconstructed intervals, {r['minute_comparison_count']} minute comparisons, MAE={r['minute_mae']}, score reconciled={r['goal_events_reconcile']}, timeline candidate={r['timeline_candidate_not_certified']}")
    text="\n".join(lines)
    print(text)
    if os.getenv("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"],"a",encoding="utf-8") as out:
            out.write(text+"\n")
    return 0 if probe.status_verified else 2

if __name__=="__main__":
    sys.exit(main())
