"""E06: retrospective league context; no causal motivation, no production activation."""
import argparse, collections as C, json, math, os, statistics as S, sys
from pathlib import Path
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/"e04"))
import engine as e
LOCK=json.loads((HERE/"source-lock.json").read_text())
VERSION="E06.1"
DAY=86400
CAL_LAG=4*3600
RULES={y:{"clubs":20,"matches_per_club":38,"win_points":3,"draw_points":1,"rank_reference":16,
 "status":"conditional round-robin points-only; no administrative adjustments or tie-break certification"} for y in range(2022,2027)}
GROUPS={"calendar":("rest_days","games_7d","games_14d"),"competitive":("points_per_game","gap_leader","gap_rank16","remaining"),
        "workload":("recent_player_minutes","recent_starter_minutes"),"rotation":("prior_rotation",)}
ALL=tuple(k for g in GROUPS.values() for k in g)
UNAVAILABLE=("all_competitions_calendar","cup_congestion","travel","coach","injury","suspension","news","continental_qualification","actual_fatigue","motivation")
def checked_lineup(path,report,ref):
    data=e.load(path)
    if e.sha(path)!=report["private_sha256"] or report["code_commit"]!=LOCK["e05_commit"] or data["version"]!="E05.1" or report["version"]!="E05.1":
        raise ValueError("E05 identity")
    if data["source_manifest_sha256"]!=ref["manifest_sha256"] or report["source_manifest_sha256"]!=ref["manifest_sha256"] or len(data["records"])!=report["fixtures"]:raise ValueError("E05 linkage")
    rec={r["fixture_id"]:r for r in data["records"]}
    if len(rec)!=len(data["records"]):raise ValueError("E05 duplicate")
    return rec
def validate_catalog(fixtures):
    groups=C.defaultdict(list)
    for g in fixtures:groups[g["year"]].append(g)
    report={}
    for y,rows in sorted(groups.items()):
        clubs={g[k] for g in rows for k in ("home_id","away_id")}
        pairs={(g["home_id"],g["away_id"]) for g in rows}
        played=C.Counter(c for g in rows for c in (g["home_id"],g["away_id"]))
        if len(clubs)!=20 or len(pairs)!=len(rows) or any(a==b for a,b in pairs) or max(played.values())>38:raise ValueError("catalogue round-robin")
        if y<2026 and (len(rows)!=380 or min(played.values())!=38):raise ValueError("incomplete historical calendar")
        report[str(y)]={"catalogued_finals":len(rows),"season_capacity":380,"clubs":len(clubs),"min_finals_per_club":min(played.values()),"max_finals_per_club":max(played.values()),"scope":"Brazil Serie A only, retrospective final kickoff dates; no cups"}
    return report
def state_for(table,club,y):
    if len(table)!=RULES[y]["clubs"] or club not in table:return None
    p,n=table[club];remaining=38-n;upper=p+3*remaining
    if not 0<=n<=38:raise ValueError("games bound")
    others=[(v[0],v[0]+3*(38-v[1])) for c,v in table.items() if c!=club]
    scores=sorted((v[0] for v in table.values()),reverse=True)
    return {"points":p,"played":n,"remaining":remaining,"points_per_game":p/n if n else None,
      "gap_leader":scores[0]-p,"gap_rank16":p-scores[15],"conditional_title_clinched":all(p>hi for lo,hi in others),
      "conditional_title_impossible":any(lo>upper for lo,hi in others),
      "conditional_bottom4_avoided":sum(p>hi for lo,hi in others)>=4,
      "conditional_bottom4_certain":sum(lo>upper for lo,hi in others)>=16,
      "rank_reference":16,"official_certified":False}
def calendar(history,t,y):
    # Current/future games excluded. Four hour assumed lag for known completed matches.
    prior=[g for g in history if g["year"]==y and g["t"]+CAL_LAG<=t]
    if not prior:return {"rest_days":None,"games_7d":None,"games_14d":None,"last_kickoff":None}
    rest=(t-prior[-1]["t"])/DAY
    return {"rest_days":min(rest,21),"uncapped_rest_days":rest,"games_7d":sum(g["t"]>=t-7*DAY for g in prior),
      "games_14d":sum(g["t"]>=t-14*DAY for g in prior),"last_kickoff":e.iso(prior[-1]["t"])}
def workload(history,t,y):
    # Seven-day assumed data delay; prior 21-day window ending seven days before target.
    games=[g for g in history if g["year"]==y and t-28*DAY<=g["t"]<=t-e.LAG]
    if not games or any(g["minutes"] is None for g in games):return None,None,len(games)
    return sum(g["minutes"][0] for g in games),sum(g["minutes"][1] for g in games),len(games)
def prior_rotation(history,t,y):
    games=[g for g in history if g["year"]==y and t-60*DAY<=g["t"]<=t-e.LAG][-3:]
    if len(games)<2 or any(g["rotation"] is None for g in games):return None,len(games)
    return S.mean(g["rotation"] for g in games),len(games)
def game_minutes(rows):
    # Don't treat absent player minutes as zero. Full team box score required, 11 starter flags.
    if len(rows)<11 or len({r["player_id"] for r in rows})!=len(rows):return None
    if sum(r["values"].get("starter") is True for r in rows)!=11:return None
    if any(type(r["values"].get("starter")) is not bool or type(r["values"].get("minutes")) is not int or not 0<=r["values"]["minutes"]<=90 for r in rows):return None
    mins=sum(r["values"]["minutes"] for r in rows);starter=sum(r["values"]["minutes"] for r in rows if r["values"]["starter"])
    if not 800<=mins<=1050:return None
    return mins,starter
def rotation(record,side,club):
    if not record:return None
    r=record[side]
    if r["club_id"]!=club:raise ValueError("E05 side mismatch")
    a,b=r.get("actual"),r.get("habitual")
    if a is None or b is None:return None
    aa={p for p,role in a};bb={p for p,role in b}
    if len(aa)!=11 or len(bb)!=11:raise ValueError("E05 XI")
    return len(aa-bb)
def diff(a,b,k):
    x,y=a.get(k),b.get(k)
    return x-y if x is not None and y is not None else None
def build(fixtures,rows,lineups):
    coverage=validate_catalog(fixtures);groups=C.defaultdict(list);fmap={g["fixture_id"]:g for g in fixtures}
    for r in rows:
        g=fmap[r["fixture_id"]]
        if r["t"]!=g["t"] or r["year"]!=g["year"] or r["club_id"] not in (g["home_id"],g["away_id"]):raise ValueError("row fixture")
        groups[r["fixture_id"],r["club_id"]].append(r)
    if set(lineups)!={g["fixture_id"] for g in fixtures if g["year"]>=2024}:raise ValueError("E05 fixture scope")
    for fid,r in lineups.items():
        g=fmap[fid]
        if r["year"]!=g["year"] or r["t"]!=g["t"] or r["home"]["club_id"]!=g["home_id"] or r["away"]["club_id"]!=g["away_id"]:raise ValueError("E05 fixture mismatch")
    history=C.defaultdict(list);tables=C.defaultdict(dict);elo=C.defaultdict(lambda:1500.);queue=[];cur=0;out=[]
    for g in sorted(fixtures,key=lambda x:(x["t"],x["fixture_id"])):
        y,t,fid=g["year"],g["t"],g["fixture_id"];a,b=g["home_id"],g["away_id"];table=tables[y]
        while cur<len(queue) and queue[cur][0]<=t:
            _,yr,h,v,hs,vs,change=queue[cur];cur+=1
            elo[h]+=change;elo[v]-=change
            tab=tables[yr]
            for c,pts in ((h,3 if hs>vs else 1 if hs==vs else 0),(v,3 if vs>hs else 1 if hs==vs else 0)):
                prev,n=tab.get(c,(0,0));tab[c]=(prev+pts,n+1)
        # Only observed participants to date; not future season membership.
        table.setdefault(a,(0,0));table.setdefault(b,(0,0))
        sides={}
        for club in (a,b):
            h=history[club];cal=calendar(h,t,y);state=state_for(table,club,y);m,s,n=workload(h,t,y);rot,nr=prior_rotation(h,t,y)
            sides[club]={**cal,"competitive":state,"recent_player_minutes":m,"recent_starter_minutes":s,"workload_games":n,"prior_rotation":rot,"rotation_games":nr,
               "points_per_game":state["points_per_game"] if state else None,"gap_leader":state["gap_leader"] if state else None,"gap_rank16":state["gap_rank16"] if state else None,"remaining":state["remaining"] if state else None}
        h,v=sides[a],sides[b];features={k:diff(h,v,k) for k in ALL}
        score=g["score"];hs,vs=score["home"],score["away"]
        if not all(type(k) is int and k>=0 for k in (hs,vs)):raise ValueError("score")
        x=(elo[a]-elo[b])/400
        # No current lineup or result in feature vector. Labels separate.
        out.append({"fixture_id":fid,"year":y,"as_of":e.iso(t),"t":t,"home_id":a,"away_id":b,"home":h,"away":v,"features":features,"elo_diff":x,
          "label":{"home_goals":hs,"away_goals":vs,"goal_diff":hs-vs},"lineup_adjustment_enabled":False,"point_in_time_certified":False})
        exp=1/(1+10**((elo[b]-elo[a]-55)/400));obs=1 if hs>vs else 0 if hs<vs else .5
        queue.append((t+e.LAG,y,a,b,hs,vs,20*(obs-exp)))
        for side,club in (("home",a),("away",b)):
            history[club].append({"year":y,"t":t,"minutes":game_minutes(groups[fid,club]) if g["detailed"] else None,"rotation":rotation(lineups.get(fid),side,club)})
    return out,coverage
def solve(A,b):
    a=[list(r)+[v] for r,v in zip(A,b)];n=len(b)
    for i in range(n):
        k=max(range(i,n),key=lambda j:abs(a[j][i]));a[i],a[k]=a[k],a[i]
        if abs(a[i][i])<1e-12:raise ValueError("singular")
        x=a[i][i];a[i]=[v/x for v in a[i]]
        for j in range(n):
            if i!=j:
                q=a[j][i];a[j]=[v-q*w for v,w in zip(a[j],a[i])]
    return [r[-1] for r in a]
def basefit(train):
    x=[r["elo_diff"] for r in train];y=[r["label"]["goal_diff"] for r in train]
    if not x:return (0.,0.)
    mx,my=S.mean(x),S.mean(y);b=sum((a-mx)*(c-my) for a,c in zip(x,y))/(sum((a-mx)**2 for a in x)+len(x)*.1)
    return my-b*mx,b
def baseline(r,b):return b[0]+b[1]*r["elo_diff"]
def complete(r,keys):return all(r["features"].get(k) is not None for k in keys)
def fit(train,keys,b):
    # Residualize standardized features against baseline Elo, then ridge fit residual goals.
    if not keys or len(train)<100:return None
    x=[r["elo_diff"] for r in train];mx=S.mean(x);den=sum((a-mx)**2 for a in x)+len(x)*.1
    norm={}
    for k in keys:
        v=[r["features"][k] for r in train];mu=S.mean(v);sd=S.pstdev(v)
        if sd<1e-8:continue
        z=[(a-mu)/sd for a in v];beta=sum((a-mx)*c for a,c in zip(x,z))/den
        norm[k]=(mu,sd,beta,mx)
    if not norm:return None
    def vector(r):return [(r["features"][k]-mu)/sd-beta*(r["elo_diff"]-mx) for k,(mu,sd,beta,mx) in norm.items()]
    X=[vector(r) for r in train];y=[r["label"]["goal_diff"]-baseline(r,b) for r in train];n=len(norm)
    A=[[sum(v[i]*v[j] for v in X)+(len(X)*.5 if i==j else 0) for j in range(n)] for i in range(n)]
    beta=solve(A,[sum(v[i]*a for v,a in zip(X,y)) for i in range(n)])
    return {"normalization":norm,"coefficients":dict(zip(norm,beta)),"train_n":len(train)}
def predict(r,b,m):
    p=baseline(r,b)
    if m is None or not complete(r,m["normalization"]):return p
    adj=sum(m["coefficients"][k]*((r["features"][k]-mu)/sd-beta*(r["elo_diff"]-mx)) for k,(mu,sd,beta,mx) in m["normalization"].items())
    return p+max(-.5,min(.5,adj))
def evaluate(test,b,m):
    if not test:return {"n":0}
    pairs=[(r["label"]["goal_diff"],baseline(r,b),predict(r,b,m)) for r in test]
    return {"n":len(pairs),"baseline_mae":S.mean(abs(y-a) for y,a,p in pairs),"context_mae":S.mean(abs(y-p) for y,a,p in pairs),
       "baseline_rmse":math.sqrt(S.mean((y-a)**2 for y,a,p in pairs)),"context_rmse":math.sqrt(S.mean((y-p)**2 for y,a,p in pairs))}
def correlation(rows,a,b):
    pairs=[(r["features"][a],r["features"][b]) for r in rows if complete(r,(a,b))]
    if len(pairs)<2:return {"n":len(pairs),"r":None}
    x,y=zip(*pairs);sx,sy=S.pstdev(x),S.pstdev(y)
    return {"n":len(pairs),"r":S.correlation(x,y) if sx>0 and sy>0 else None}
def ablation(records):
    out={}
    for y in (2024,2025,2026):
        cut=e.stamp(f"{y}-01-01T00:00:00+00:00")
        train=[r for r in records if r["year"]<y and r["t"]+e.LAG<=cut];test=[r for r in records if r["year"]==y]
        b=basefit(train);sets={}
        for group,keys in GROUPS.items():
            tr=[r for r in train if complete(r,keys)];te=[r for r in test if complete(r,keys)]
            m=fit(tr,keys,b);sets[group]={"train_n":len(tr),"test_n":len(te),"model":m,"paired":evaluate(te,b,m),"all_with_fallback":evaluate(test,b,m)}
        # Full and leave-one-group-out on identical complete-case cohorts, not different samples.
        tr=[r for r in train if complete(r,ALL)];te=[r for r in test if complete(r,ALL)]
        full=fit(tr,ALL,b);ab={}
        for group,keys in GROUPS.items():
            m=fit(tr,tuple(k for k in ALL if k not in keys),b)
            ab[group]={"model":m,"paired":evaluate(te,b,m)}
        out[str(y)]={"baseline":list(b),"train_n":len(train),"test_n":len(test),"groups":sets,"full":{"train_n":len(tr),"test_n":len(te),"model":full,"paired":evaluate(te,b,full),"all_with_fallback":evaluate(test,b,full),"leave_one_out":ab},
           "rotation_correlations":{k:correlation(train,"prior_rotation",k) for k in ("rest_days","games_7d","games_14d","recent_player_minutes","recent_starter_minutes")}}
    return out
def main():
    p=argparse.ArgumentParser()
    for k in ("archive","e03-report","lineup","e05-report","workspace","output","report"):p.add_argument("--"+k,type=Path,required=True)
    a=p.parse_args()
    try:
        os.umask(0o077)
        for path in (a.workspace,a.output,a.report):
            q=path.resolve()
            if q.exists() or q==e.REPO or e.REPO in q.parents or q in e.REPO.parents:raise ValueError("workspace")
        sources=(a.archive,a.e03_report,a.lineup,a.e05_report);before=[e.sha(p) for p in sources]
        e.extract(a.archive,a.workspace);ref=e.load(a.e03_report);man,fixtures,rows=e.input_data(a.workspace,ref)
        lineups=checked_lineup(a.lineup,e.load(a.e05_report),ref)
        records,catalog=build(fixtures,rows,lineups);folds=ablation(records)
        provenance={"calendar":{"source":"E03 final fixture kickoff","assumed_lag_hours":4,"scope":"league only","true_rest_certified":False},
         "competitive":{"source":"E03 prior scores","assumed_lag_days":7,"rules":RULES,"conditional_only":True},
         "workload":{"source":"E03 complete player box scores","assumed_lag_days":7,"window_days":28,"scope":"league only"},
         "rotation":{"source":"E05 prior observed XI vs habitual, identity-only changes","assumed_lag_days":7,"current_xi_used":False},
         "unavailable":list(UNAVAILABLE),"snapshot_observed_by":man["snapshot_observed_by"],"historical_publication_timestamps_certified":False}
        counts={}
        for y in RULES:
            rr=[r for r in records if r["year"]==y]
            counts[str(y)]={"fixtures":len(rr),"feature_coverage":{k:sum(r["features"][k] is not None for r in rr) for k in ALL},
              "group_coverage":{g:sum(complete(r,keys) for r in rr) for g,keys in GROUPS.items()},"all_features":sum(complete(r,ALL) for r in rr),
              "conditional_objectives":{k:sum(bool(side["competitive"] and side["competitive"][k]) for r in rr for side in (r["home"],r["away"])) for k in ("conditional_title_clinched","conditional_title_impossible","conditional_bottom4_avoided","conditional_bottom4_certain")}}
        private={"version":VERSION,"records":records,"folds":folds,"provenance":provenance,"source_manifest_sha256":ref["manifest_sha256"],"production_ready":False,"lineup_adjustment_enabled":False}
        if before!=[e.sha(p) for p in sources]:raise ValueError("source mutation")
        e.write(a.output,private)
        result={"version":VERSION,"code_commit":os.getenv("GITHUB_SHA","local"),"source_manifest_sha256":ref["manifest_sha256"],"private_sha256":e.sha(a.output),"catalog":catalog,"counts":counts,"folds":folds,"provenance":provenance,"fixtures":len(records),"api_requests":0,"production_ready":False,"lineup_adjustment_enabled":False,"point_in_time_certified":False}
        e.write(a.report,result)
        print("E06 COVERAGE:",json.dumps(counts,sort_keys=True))
        for y,f in folds.items():
            print("E06 FOLD:",y,json.dumps({"groups":{k:{"train_n":v["train_n"],"test_n":v["test_n"],"paired":v["paired"],"all":v["all_with_fallback"],"fitted":v["model"] is not None} for k,v in f["groups"].items()},"full":{"train_n":f["full"]["train_n"],"test_n":f["full"]["test_n"],"paired":f["full"]["paired"],"fitted":f["full"]["model"] is not None,"leave_one_out":{k:v["paired"] for k,v in f["full"]["leave_one_out"].items()}},"rotation_correlations":f["rotation_correlations"]},sort_keys=True))
        print("PASS: E06 context, temporal reconstruction, ablation, zero sporting API calls.")
        return 0
    except Exception as exc:
        print("BLOCKED: E06 failed; exception type="+type(exc).__name__);return 2
if __name__=="__main__":sys.exit(main())
