"""AF-Player E04.1: retrospective, role-conditioned statistical index; no causal skill claim."""
import argparse, collections as C, datetime as dt, hashlib, json, math, os, pathlib, statistics as st, sys, tarfile
from pathlib import Path
HERE=Path(__file__).resolve().parent
REPO=HERE.parents[2]
LOCK=json.loads((HERE/"source-lock.json").read_text())
VERSION="E04.1"
LAG=7*86400
HALF=180*86400
PRIOR=450
MIN_COVER=.70
MAX_SHIFT=.20
MIN_N=100
YEARS=range(2022,2027)
# Volume is a proxy for involvement, not causal quality. No external rating, xG, accuracy or null imputation.
FIELDS={
"G":{"offense":{"passes":1},"defense":{"saves":1}},
"D":{"offense":{"passes":1,"key_passes":1},"defense":{"duel_ratio":2,"tackles":1,"interceptions":1,"blocks":1}},
"M":{"offense":{"passes":1,"key_passes":2,"shots":1,"assists":1},"defense":{"duel_ratio":2,"tackles":1,"interceptions":1}},
"F":{"offense":{"shots":2,"shots_on_target":2,"goals":2,"assists":1,"key_passes":1,"passes":1},"defense":{"duel_ratio":1,"tackles":1}}}
# Saves/blocks are workload proxies; no goals-conceded semantics assumed.
LIMIT={"passes":200,"key_passes":30,"shots":30,"shots_on_target":30,"goals":15,"assists":15,"tackles":40,"interceptions":40,"blocks":40,"saves":40,"duels_won":100,"duels_total":100}
def stamp(s):
    d=dt.datetime.fromisoformat(s.replace("Z","+00:00"))
    if d.tzinfo is None:raise ValueError("timezone required")
    return d.timestamp()
def iso(t):return dt.datetime.fromtimestamp(t,dt.timezone.utc).isoformat()
def sha(p):
    h=hashlib.sha256()
    with p.open("rb") as f:
        for x in iter(lambda:f.read(1<<20),b""):h.update(x)
    return h.hexdigest()
def write(p,o):
    with p.open("x",encoding="utf8") as f:json.dump(o,f,sort_keys=True,separators=(",",":"),allow_nan=False);f.write("\n")
def load(p):return json.loads(p.read_text())
def extract(archive,root):
    expected={"manifest.json"}|{f"fdg2027/bra.1/{y}/{a}.json" for y in YEARS for a in ("player_matches","fixtures","identity_map","coverage","recovery_ledger")}
    root.mkdir(mode=0o700)
    seen=set();size=0
    with tarfile.open(archive,"r:") as t:
        for m in t:
            if m.isdir():continue
            name=m.name.removeprefix("./")
            if not m.isfile() or name not in expected or name in seen or m.size<=0:raise ValueError("archive member")
            size+=m.size
            if size>500_000_000:raise ValueError("archive size")
            p=root/name;p.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            with p.open("xb") as out:out.write(t.extractfile(m).read())
            seen.add(name)
    if seen!=expected:raise ValueError("archive completeness")
def input_data(root,report):
    man=load(root/"manifest.json")
    if sha(root/"manifest.json")!=report["manifest_sha256"] or man["code_commit"]!=LOCK["source_commit"] or report["code_commit"]!=LOCK["source_commit"] or man["totals"]!=report["totals"]:raise ValueError("E03 binding")
    expected={f"fdg2027/bra.1/{y}/{a}.json" for y in YEARS for a in ("player_matches","fixtures","identity_map","coverage","recovery_ledger")}
    if set(man["files"])!=expected:raise ValueError("manifest paths")
    for k,v in man["files"].items():
        p=root/k
        if p.stat().st_size!=v["bytes"] or sha(p)!=v["sha256"]:raise ValueError("manifest integrity")
    fixtures=[];rows=[];seen=set()
    for y in YEARS:
        for name,target in (("fixtures",fixtures),("player_matches",rows)):
            d=load(root/f"fdg2027/bra.1/{y}/{name}.json")
            if d["competition"]!="bra.1" or d["season"]!=y or d["version"]!="E03.1":raise ValueError("envelope")
            for r in d["rows"]:
                r["year"]=y;r["t"]=stamp(r["kickoff_at"])
                key=r.get("row_id",r["fixture_id"])
                if key in seen:raise ValueError("duplicate identity")
                seen.add(key);target.append(r)
    if len(rows)!=LOCK["rows"] or len(fixtures)!=LOCK["fixtures"]:raise ValueError("row accounting")
    return man,fixtures,rows
def count(r,k):
    v=r["values"].get(k);q=r["quality"].get(k);raw=r["raw"].get(k)
    if q not in ("observed_count","explicit_zero") or not r["raw_present"].get(k) or type(v) is not int or not 0<=v<=LIMIT[k]:return None
    if isinstance(raw,bool):return None
    try:
        if float(raw)!=v:return None
    except (TypeError,ValueError,OverflowError):return None
    return v
def feature(r,k):
    if k=="duel_ratio":
        a,b=count(r,"duels_won"),count(r,"duels_total")
        if a is None or b is None or b==0 or a>b:return None
        # Variance control for small within-game denominators; not imputing missing.
        return (a+2)/(b+4)
    v=count(r,k)
    if v is None:return None
    return math.log1p(90*v/r["m"])
def prepare(fixtures,rows):
    # Only previous match outcomes after explicit simulated availability lag.
    games=sorted(fixtures,key=lambda g:(g["t"],g["fixture_id"]))
    elo=C.defaultdict(lambda:1500.); pending=[];cursor=0;opp={}; seen=set()
    for g in games:
        while cursor<len(pending) and pending[cursor][0]<=g["t"]:
            _,a,b,delta=pending[cursor];elo[a]+=delta;elo[b]-=delta;cursor+=1
        a,b=g["home_id"],g["away_id"];score=g["score"]
        if a==b or g["fixture_id"] in seen or not all(type(score.get(k)) is int and score[k]>=0 for k in ("home","away")):raise ValueError("fixture integrity")
        seen.add(g["fixture_id"]);opp[g["fixture_id"]]=(a,b,elo[a],elo[b],g["t"],g["year"])
        exp=1/(1+10**((elo[b]-elo[a]-55)/400))
        obs=1 if score["home"]>score["away"] else 0 if score["home"]<score["away"] else .5
        pending.append((g["t"]+LAG,a,b,20*(obs-exp)))
    out=[]
    for r in rows:
        a,b,ea,eb,t,y=opp[r["fixture_id"]]
        if r["t"]!=t or r["year"]!=y or r["club_id"] not in (a,b):raise ValueError("row fixture mismatch")
        v=r["values"];m=v.get("minutes");p=v.get("position")
        if not r["individual_core_valid"] or p not in FIELDS or type(m) is not int or not 0<m<=90 or r["quality"]["minutes"]!="reported_regulation_proxy":continue
        r["m"]=m;r["pos"]=p;r["x"]=((eb if r["club_id"]==a else ea)-1500)/400
        r["available"]=t+LAG
        r["features"]={k:feature(r,k) for k in sorted(set().union(*FIELDS[p].values()))}
        out.append(r)
    return sorted(out,key=lambda r:(r["t"],r["row_id"]))
def fit(rows,cut):
    # Only past seasons; selection and coefficients frozen before holdout.
    train=[r for r in rows if r["available"]<=cut]
    groups=C.defaultdict(list)
    for r in train:groups[r["pos"]].append(r)
    models={};audit={}
    for p,axes in FIELDS.items():
        rr=groups[p];models[p]={};audit[p]={}
        for k in sorted(set().union(*axes.values())):
            yrs=C.defaultdict(lambda:[0,0,0,0,0,0])
            obs=[]
            for r in rr:
                a=yrs[r["year"]];a[0]+=1;a[2]+=r["m"]
                v=r["features"][k]
                if v is not None:a[1]+=1;a[3]+=r["m"];obs.append((v,r["x"],r["m"]))
                # Explicit null/absence are not zero; assess exposure-stratified missingness.
                if r["m"]>=45:a[4]+=1;a[5]+=int(v is not None)
            rates=[a[1]/a[0] for a in yrs.values()]
            exp=[a[3]/a[2] for a in yrs.values()]
            long=[a[5]/a[4] for a in yrs.values() if a[4]]
            eligible=bool(len(yrs)>=2 and len(obs)>=MIN_N and min(rates+exp+long)>=MIN_COVER and max(rates)-min(rates)<=MAX_SHIFT)
            audit[p][k]={"by_year":{str(y):a for y,a in sorted(yrs.items())},"eligible":eligible,"reason":"coverage_stability_gate" if not eligible else "provisional_documented_count"}
            if not eligible:continue
            values=sorted(v for v,x,w in obs);lo=values[int(.01*(len(values)-1))];hi=values[int(.99*(len(values)-1))]
            vals=[(min(hi,max(lo,v)),x,w) for v,x,w in obs]
            W=sum(w for v,x,w in vals);mx=sum(x*w for v,x,w in vals)/W;my=sum(v*w for v,x,w in vals)/W
            beta=sum(w*(x-mx)*(v-my) for v,x,w in vals)/(sum(w*(x-mx)**2 for v,x,w in vals)+W*.10)
            center=my-beta*mx;sd=math.sqrt(sum(w*(v-center-beta*x)**2 for v,x,w in vals)/W)
            if sd<1e-6:
                audit[p][k].update(eligible=False,reason="no_variation");continue
            models[p][k]={"lo":lo,"hi":hi,"beta":beta,"center":center,"sd":sd,"n":len(obs)}
    return models,audit
def zvalue(r,k,model):
    v=r["features"].get(k)
    if v is None:return None
    return max(-3,min(3,(max(model["lo"],min(model["hi"],v))-model["center"]-model["beta"]*r["x"])/model["sd"]))
def score(z):return round(100/(1+math.exp(-.8*z)),4)
def axis_value(p,axis,values):
    usable=[(values[k],w) for k,w in FIELDS[p][axis].items() if k in values]
    return sum(v*w for v,w in usable)/sum(w for v,w in usable) if usable else None
def profile(history,p,at,models):
    rr=[r for r in history if r["available"]<=at and r["pos"]==p]
    if not rr:return {"rating":None,"offense":None,"defense":None,"confidence":0,"effective_minutes":0,"games":0,"feature_count":0}
    weighted=[(r,r["m"]*2**(-(at-r["available"])/HALF)) for r in rr]
    total=sum(w for r,w in weighted);zs={};supports=[]
    for k,model in models[p].items():
        data=[(zvalue(r,k,model),w) for r,w in weighted]
        data=[(z,w) for z,w in data if z is not None]
        n=sum(w for z,w in data)
        if n<=0:continue
        zs[k]=sum(z*w for z,w in data)/(n+PRIOR);supports.append(n/total)
    a,b=(axis_value(p,axis,zs) for axis in ("offense","defense"))
    zz=[z for z in (a,b) if z is not None]
    # Axes with no evidence stay null; one-axis overall is explicitly partial.
    confidence=100*(total/(total+PRIOR))*(sum(supports)/len(supports) if supports else 0)*(len(zz)/2)
    return {"rating":score(sum(zz)/len(zz)) if zz else None,"offense":score(a) if a is not None else None,"defense":score(b) if b is not None else None,
      "confidence":round(confidence,4),"effective_minutes":round(total,2),"games":len(rr),"feature_count":len(zs),"partial_axes":len(zz)<2}
def target(r,models):
    zs={k:z for k,model in models[r["pos"]].items() if (z:=zvalue(r,k,model)) is not None}
    a,b=(axis_value(r["pos"],axis,zs) for axis in ("offense","defense"))
    return a,b
def paired(history,r,models):
    # Compare exactly the same observed axes; no label from later matches.
    a,b=target(r,models)
    pr=profile(history,r["pos"],r["t"],models)
    pairs=[(score(z),pr[k]) for z,k in ((a,"offense"),(b,"defense")) if z is not None and pr[k] is not None]
    if not pairs:return None
    actual=sum(a for a,p in pairs)/len(pairs);pred=sum(p for a,p in pairs)/len(pairs)
    return actual,pred,pr
def build(man,fixtures,rawrows,out,report):
    rows=prepare(fixtures,rawrows);byplayer=C.defaultdict(list);folds={};snapshots=[]
    for r in rows:byplayer[r["player_id"]].append(r)
    for y in (2024,2025,2026):
        cut=stamp(f"{y}-01-01T00:00:00+00:00")
        models,audit=fit([r for r in rows if r["year"]<y],cut)
        metrics=C.defaultdict(lambda:[0,0.,0.,0.,0.]);total=0
        for r in rows:
            if r["year"]!=y:continue
            total+=1;result=paired(byplayer[r["player_id"]],r,models)
            if result is None:continue
            a,p,pr=result
            for k in ("all",r["pos"]):
                v=metrics[k];v[0]+=1;v[1]+=abs(a-p);v[2]+=abs(a-50);v[3]+=(a-p)**2;v[4]+=(a-50)**2
            snapshots.append({"fixture_id":r["fixture_id"],"player_id":r["player_id"],"club_id":r["club_id"],"position":r["pos"],"as_of":iso(r["t"]),"calibration_year":y,
              "historical_availability_certified":False,"rating":pr["rating"],"offense":pr["offense"],"defense":pr["defense"],"confidence":pr["confidence"],"effective_minutes":pr["effective_minutes"]})
        folds[str(y)]={"holdout_rows":total,"calibration_cutoff":iso(cut),"models":models,"semantic_gate":audit,
          "paired":{k:{"n":v[0],"mae":v[1]/v[0],"neutral_mae":v[2]/v[0],"rmse":math.sqrt(v[3]/v[0]),"neutral_rmse":math.sqrt(v[4]/v[0])} for k,v in metrics.items() if v[0]}}
    # Current retrospective profile, freeze calibration before 2026; actual source observed upper bound only.
    at=stamp(man["snapshot_observed_by"]);models=folds["2026"]["models"];ratings=[]
    for pid,h in sorted(byplayer.items()):
        past=[r for r in h if r["available"]<=at]
        if not past:continue
        last=past[-1];p=last["pos"];pr=profile(past,p,at,models)
        ratings.append(dict(pr,player_id=pid,last_observed_club=last["club_id"],position=p,as_of=iso(at),last_match_at=iso(last["t"]),roster_membership_certified=False))
    # Percentile only among same-position ratings; ties share midrank.
    for p in FIELDS:
        group=sorted((r for r in ratings if r["position"]==p and r["rating"] is not None),key=lambda r:r["rating"])
        i=0
        while i<len(group):
            j=i+1
            while j<len(group) and group[j]["rating"]==group[i]["rating"]:j+=1
            for r in group[i:j]:r["position_percentile"]=round(100*(i+j)/(2*len(group)),3)
            i=j
    out.mkdir(mode=0o700)
    private={"version":VERSION,"source_manifest_sha256":report["manifest_sha256"],"availability_mode":"retrospective kickoff + 7 day assumed lag; not point-in-time certified",
      "ratings":ratings,"historical_snapshots":snapshots,"folds":folds,"production_ready":False}
    write(out/"af-player.json",private)
    pos={}
    for p in FIELDS:
        rr=[r for r in ratings if r["position"]==p];v=[r for r in rr if r["rating"] is not None]
        pos[p]={"players":len(rr),"rated":len(v),"both_axes":sum(r["offense"] is not None and r["defense"] is not None for r in v),
          "confidence_median":st.median(r["confidence"] for r in v) if v else None,"rating_median":st.median(r["rating"] for r in v) if v else None}
    result={"version":VERSION,"source_run":LOCK["source_run"],"source_manifest_sha256":report["manifest_sha256"],"code_commit":os.getenv("GITHUB_SHA","local"),
      "input_rows":len(rawrows),"core_rows":len(rows),"ratings":len(ratings),"rated":sum(r["rating"] is not None for r in ratings),"snapshots":len(snapshots),"positions":pos,
      "folds":{y:{"holdout_rows":f["holdout_rows"],"paired":f["paired"],"metrics_admitted":{p:sorted(m) for p,m in f["models"].items()},"semantic_gate":f["semantic_gate"]} for y,f in folds.items()},
      "private_sha256":sha(out/"af-player.json"),"production_ready":False,"semantic_certified":False,"source_availability_certified":False,"rapm_required":False,"api_requests":0}
    return result
def main():
    p=argparse.ArgumentParser()
    for k in ("archive","aggregate","workspace","output","report"):p.add_argument("--"+k,type=Path,required=True)
    a=p.parse_args()
    try:
        os.umask(0o077)
        for path in (a.workspace,a.output,a.report):
            q=path.resolve()
            if q.exists() or REPO==q or REPO in q.parents or q in REPO.parents:raise ValueError("private paths")
        before=sha(a.archive);extract(a.archive,a.workspace)
        report=load(a.aggregate);man,fixtures,rows=input_data(a.workspace,report)
        result=build(man,fixtures,rows,a.output,report)
        if before!=sha(a.archive):raise ValueError("source changed")
        write(a.report,result)
        print("E04 TOTAL:",json.dumps({k:result[k] for k in ("input_rows","core_rows","ratings","rated","snapshots","positions")},sort_keys=True))
        for y,f in result["folds"].items():print("E04 FOLD:",y,json.dumps({k:f[k] for k in ("holdout_rows","paired","metrics_admitted")},sort_keys=True))
        print("PASS: E03 hashes, role gates, chronological holdouts; no rating from provider, no RAPM, no API calls.")
        return 0
    except Exception as exc:
        print("BLOCKED: E04 failed; exception type="+type(exc).__name__)
        return 2
if __name__=="__main__":sys.exit(main())
