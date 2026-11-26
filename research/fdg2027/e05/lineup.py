"""AF-Lineup research: observed XI vs prior-only habitual XI; not live availability."""
import argparse, collections as C, json, math, os, statistics as S, sys
from pathlib import Path
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/"e04"))
import engine as e
LOCK=json.loads((HERE/"source-lock.json").read_text())
VERSION="E05.1"
ROLES=("G","D","M","F")
WINDOW=60*86400
MIN_HISTORY=3
MIN_CONF=25
MIN_COVER=8
MAX_DELTA=5.0

def validate_player(private,report,source_report,private_path):
    if e.sha(private_path)!=report["private_sha256"] or report["code_commit"]!=LOCK["e04_commit"] or private["version"]!="E04.1" or report["version"]!="E04.1":
        raise ValueError("E04 binding")
    if private["source_manifest_sha256"]!=source_report["manifest_sha256"] or report["source_manifest_sha256"]!=source_report["manifest_sha256"]:
        raise ValueError("E03/E04 mismatch")
    if len(private["historical_snapshots"])!=report["snapshots"] or len(private["ratings"])!=report["ratings"]:raise ValueError("E04 totals")
    if set(private["folds"])!={"2024","2025","2026"}:raise ValueError("folds")
    for y,fold in private["folds"].items():
        if e.stamp(fold["calibration_cutoff"])!=e.stamp(y+"-01-01T00:00:00+00:00"):raise ValueError("cutoff")
        if {p:sorted(m) for p,m in fold["models"].items()}!=report["folds"][y]["metrics_admitted"]:raise ValueError("model contract")
    return private["folds"]

def observed_xi(rows):
    # Starter flags reconstructed from source box score, not certified pregame announcements.
    if any(r["values"].get("starter") is None for r in rows):return None
    starters=[(r["player_id"],r["values"].get("position")) for r in rows if r["values"].get("starter") is True and r["quality"].get("starter")=="valid_shape"]
    if len(starters)!=11 or len({p for p,r in starters})!=11 or any(r not in ROLES for p,r in starters):return None
    if sum(r=="G" for p,r in starters)!=1:return None
    return tuple(sorted(starters))

def habitual(prior,at,year,club,latest):
    # Only complete observed XIs in prior 60 days, same season, last 6 of up to 8 prior fixtures.
    recent=[g for g in prior[-8:] if g["year"]==year and at-g["t"]<=WINDOW and g["t"]+e.LAG<=at and g["xi"] is not None][-6:]
    if len(recent)<MIN_HISTORY:return None,len(recent)
    weights=C.Counter()
    for i,g in enumerate(recent,1):
        for player,role in g["xi"]:weights[player,role]+=i
    candidates=[g for g in recent if all(latest.get(p,club)==club for p,r in g["xi"])]
    if not candidates:return None,len(recent)
    # Recency-weighted medoid chosen from actual historical XIs, never fabricates a player or formation.
    best=max(candidates,key=lambda g:(sum(weights[x] for x in g["xi"]),g["t"],g["fixture_id"]))
    return best["xi"],len(recent)

def acceptable(profile,axis):
    value=profile.get(axis)
    return value is not None and math.isfinite(value) and 0<=value<=100 and profile.get("confidence",0)>=MIN_CONF

def compare(actual,usual,profiles):
    if actual is None or usual is None:return {"status":"missing_xi","applied_delta":0.0,"raw_delta":None,"sectors":{}}
    # Shared exact player/role pairs cancel. Missing profiles are not given a fabricated rating.
    actual=set(actual);usual=set(usual);common=actual&usual
    added=actual-common;removed=usual-common
    sectors={};coverage_a=coverage_b=0;total=0.;changed_supported=0
    for role in ROLES:
        a=[x for x in actual if x[1]==role];b=[x for x in usual if x[1]==role]
        ca=sum(acceptable(profiles[x],"rating") for x in a);cb=sum(acceptable(profiles[x],"rating") for x in b)
        coverage_a+=ca;coverage_b+=cb
        aa=sorted(x for x in added if x[1]==role);bb=sorted(x for x in removed if x[1]==role)
        def axis_delta(axis):
            # Only compare supported changed slots. Unbalanced role counts are explicit composition changes.
            if not aa and not bb:return 0.0
            if len(aa)!=len(bb) or not all(acceptable(profiles[x],axis) for x in aa+bb):return None
            # Reliability attenuation (not an imputed player rating); common pair cancels exactly.
            return sum((profiles[x][axis]-50)*profiles[x]["confidence"]/100 for x in aa)/11-sum((profiles[x][axis]-50)*profiles[x]["confidence"]/100 for x in bb)/11
        v=axis_delta("rating");off=axis_delta("offense");de=axis_delta("defense")
        sectors[role]={"actual_slots":len(a),"habitual_slots":len(b),"actual_supported":ca,"habitual_supported":cb,"delta":v,"offense_proxy_delta":off,"defense_proxy_delta":de,"composition_changed":len(a)!=len(b)}
        if v is not None:total+=v;changed_supported+=len(aa)+len(bb)
    # Fail closed if any changed slot is unsupported or role mix differs; no fake zero raw delta.
    status="supported"
    if coverage_a<MIN_COVER or coverage_b<MIN_COVER:status="low_coverage"
    elif any(v["composition_changed"] for v in sectors.values()):status="role_mix_changed"
    elif changed_supported!=len(added)+len(removed):status="changed_slot_unrated"
    raw=total if status=="supported" else None
    return {"status":status,"raw_delta":raw,"applied_delta":max(-MAX_DELTA,min(MAX_DELTA,raw)) if raw is not None else 0.0,"actual_supported":coverage_a,"habitual_supported":coverage_b,"shared_slots":len(common),"rotation_slots":len(added),"sectors":sectors}

def baseline_fit(train):
    # OLS intercept + Elo difference; ridge slope. Residualize lineup differential against same baseline.
    n=len(train)
    if not n:return (0.,0.,0.,0.,0.)
    x=[r["elo_diff"] for r in train];y=[r["goal_diff"] for r in train];z=[r["lineup_diff"] for r in train]
    mx=S.mean(x);my=S.mean(y);mz=S.mean(z)
    den=sum((v-mx)**2 for v in x)+n*.1
    by=sum((a-mx)*(b-my) for a,b in zip(x,y))/den
    bz=sum((a-mx)*(b-mz) for a,b in zip(x,z))/den
    supported=[r for r in train if r["supported"]]
    if not supported:return my-by*mx,by,0.,0.,0.
    sx=[r["elo_diff"] for r in supported];sz=[r["lineup_diff"] for r in supported]
    smx=S.mean(sx);smz=S.mean(sz)
    bz=sum((a-smx)*(b-smz) for a,b in zip(sx,sz))/(sum((a-smx)**2 for a in sx)+len(sx)*.1)
    mz=smz-bz*smx+bz*mx
    ry=[r["goal_diff"]-(my+by*(r["elo_diff"]-mx)) for r in supported]
    rz=[r["lineup_diff"]-(mz+bz*(r["elo_diff"]-mx)) for r in supported]
    gamma=sum(a*b for a,b in zip(ry,rz))/(sum(a*a for a in rz)+len(supported)*1.)
    return my-by*mx,by,mz-bz*mx,bz,gamma

def prediction(r,coef):
    a,b,c,d,g=coef
    base=a+b*r["elo_diff"]
    # Fallback must leave baseline exactly unchanged, including residualization.
    return base,base+g*(r["lineup_diff"]-c-d*r["elo_diff"]) if r["supported"] else base

def validate_outcomes(records):
    result={}
    for y in (2025,2026):
        cut=e.stamp(f"{y}-01-01T00:00:00+00:00")
        train=[r for r in records if r["year"]<y and r["t"]+e.LAG<=cut]
        # Baseline uses all eligible past fixtures; lineup coefficient learns from supported subset only.
        coef=baseline_fit(train)
        test=[r for r in records if r["year"]==y]
        def evaluate(rr):
            if not rr:return {"n":0}
            pairs=[(r["goal_diff"],*prediction(r,coef)) for r in rr]
            return {"n":len(rr),"baseline_mae":S.mean(abs(y-b) for y,b,a in pairs),"augmented_mae":S.mean(abs(y-a) for y,b,a in pairs),"baseline_rmse":math.sqrt(S.mean((y-b)**2 for y,b,a in pairs)),"augmented_rmse":math.sqrt(S.mean((y-a)**2 for y,b,a in pairs))}
        result[str(y)]={"training":len(train),"training_supported":sum(r["supported"] for r in train),"coefficients":list(coef),"all":evaluate(test),"supported":evaluate([r for r in test if r["supported"]])}
    return result

def build(fixtures,rawrows,folds,private,source_report):
    rawgroups=C.defaultdict(list);fmap={g["fixture_id"]:g for g in fixtures}
    for r in rawrows:
        g=fmap[r["fixture_id"]]
        if r["t"]!=g["t"] or r["year"]!=g["year"] or r["club_id"] not in (g["home_id"],g["away_id"]):raise ValueError("fixture binding")
        rawgroups[r["fixture_id"],r["club_id"]].append(r)
    prepared=e.prepare(fixtures,rawrows);byplayer=C.defaultdict(list)
    for r in prepared:byplayer[r["player_id"]].append(r)
    snapshots={(r["fixture_id"],r["player_id"],r["position"]):r for r in private["historical_snapshots"]}
    if len(snapshots)!=len(private["historical_snapshots"]):raise ValueError("snapshot duplicates")
    games=sorted(fixtures,key=lambda g:(g["t"],g["fixture_id"]))
    past=C.defaultdict(list);latest={};queued=[];cursor=0;elo=C.defaultdict(lambda:1500.);results=[];audit=C.defaultdict(C.Counter);crosschecks=0
    for g in games:
        t=g["t"];fid=g["fixture_id"];year=g["year"];home=g["home_id"];away=g["away_id"]
        while cursor<len(queued) and queued[cursor][0]<=t:
            _,previous,xis,players,delta=queued[cursor];cursor+=1
            a,b=previous["home_id"],previous["away_id"];elo[a]+=delta;elo[b]-=delta
            for club,xi in xis.items():past[club].append({"xi":xi,"year":previous["year"],"t":previous["t"],"fixture_id":previous["fixture_id"]})
            for p,club in players:latest[p]=club
        xis={club:observed_xi(rawgroups[fid,club]) if g["detailed"] and g["player_validation"] else None for club in (home,away)}
        if xis[home] is not None and xis[away] is not None and {x[0] for x in xis[home]}&{x[0] for x in xis[away]}:xis={home:None,away:None}
        x=(elo[home]-elo[away])/400
        if year>=2024:
            models=folds[str(year)]["models"];sides={}
            for club in (home,away):
                actual=xis[club];usual,n=habitual(past[club],t,year,club,latest);profiles={}
                for player,role in sorted(set(actual or ())|set(usual or ())):
                    pr=e.profile(byplayer[player],role,t,models);profiles[player,role]=pr
                    snap=snapshots.get((fid,player,role))
                    if snap is not None and (player,role) in (actual or ()):
                        if snap["club_id"]!=club or e.stamp(snap["as_of"])!=t or any(snap[k]!=pr[k] for k in ("rating","offense","defense","confidence","effective_minutes")):raise ValueError("E04 profile mismatch")
                        crosschecks+=1
                side=compare(actual,usual,profiles)
                side.update(club_id=club,actual=actual,habitual=usual,history_matches=n)
                sides[club]=side
                a=audit[str(year)];a["sides"]+=1;a["observed_xi"]+=int(actual is not None);a["habitual_xi"]+=int(usual is not None);a[side["status"]]+=1
                if actual is not None and usual is not None:a["rotation_slots"]+=side.get("rotation_slots",0);a["comparisons"]+=1
            h,a=sides[home],sides[away];supported=h["status"]==a["status"]=="supported"
            diff=h["applied_delta"]-a["applied_delta"] if supported else 0.
            audit[str(year)]["fixtures"]+=1;audit[str(year)]["both_supported"]+=int(supported)
            results.append({"fixture_id":fid,"year":year,"t":t,"as_of":e.iso(t),"home":h,"away":a,"supported":supported,
                "lineup_diff":diff,"elo_diff":x,"goal_diff":g["score"]["home"]-g["score"]["away"],"pregame_lineup_certified":False,"publication_allowed":False})
        score=g["score"];exp=1/(1+10**((elo[away]-elo[home]-55)/400));obs=1 if score["home"]>score["away"] else 0 if score["home"]<score["away"] else .5
        players=sorted({(r["player_id"],club) for club in (home,away) for r in rawgroups[fid,club] if r["values"].get("minutes") is not None and r["values"]["minutes"]>0})
        queued.append((t+e.LAG,g,xis,players,20*(obs-exp)))
    outcome=validate_outcomes(results)
    return {"version":VERSION,"records":results,"source_manifest_sha256":source_report["manifest_sha256"],"production_ready":False,"availability_certified":False}, {"version":VERSION,"by_year":{y:dict(c) for y,c in audit.items()},"fixtures":len(results),"snapshot_crosschecks":crosschecks,"outcomes":outcome,"source_manifest_sha256":source_report["manifest_sha256"],"code_commit":os.getenv("GITHUB_SHA","local"),"production_ready":False,"availability_certified":False,"api_requests":0,"rapm_required":False}

def main():
    p=argparse.ArgumentParser()
    for k in ("archive","e03-report","player","e04-report","workspace","output","report"):p.add_argument("--"+k,type=Path,required=True)
    a=p.parse_args()
    try:
        os.umask(0o077)
        for path in (a.workspace,a.output,a.report):
            q=path.resolve()
            if q.exists() or e.REPO==q or e.REPO in q.parents or q in e.REPO.parents:raise ValueError("workspace")
        original=[e.sha(x) for x in (a.archive,a.e03_report,a.player,a.e04_report)]
        e.extract(a.archive,a.workspace)
        ref=e.load(a.e03_report);man,fixtures,rows=e.input_data(a.workspace,ref)
        private=e.load(a.player);report=e.load(a.e04_report)
        folds=validate_player(private,report,ref,a.player)
        data,result=build(fixtures,rows,folds,private,ref)
        if original!=[e.sha(x) for x in (a.archive,a.e03_report,a.player,a.e04_report)]:raise ValueError("source mutated")
        e.write(a.output,data);result["private_sha256"]=e.sha(a.output);e.write(a.report,result)
        print("E05 TOTAL:",json.dumps({k:result[k] for k in ("fixtures","snapshot_crosschecks","by_year")},sort_keys=True))
        print("E05 OUTCOMES:",json.dumps(result["outcomes"],sort_keys=True))
        print("PASS: retrospective lineup comparison, no production activation, no APIs.")
        return 0
    except Exception as exc:
        print("BLOCKED: E05 failed; exception type="+type(exc).__name__);return 2
if __name__=="__main__":sys.exit(main())
