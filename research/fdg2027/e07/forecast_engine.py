"""E07: AF 1.3 production functions + research-only Poisson offsets."""
import argparse, collections, datetime as dt, hashlib, json, math, os, sys
from pathlib import Path
from zoneinfo import ZoneInfo
import numpy as np
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
sys.path[:0]=[str(ROOT/"scripts"),str(HERE.parent/"e04")]
import engine as e
import gerar_probabilidades_brasileirao as af
from gerar_probabilidades_jogos import percentage_partition, validate_document
from auditar_historico_placares_af import verify_existing_history
LOCK=json.loads((HERE/"source-lock.json").read_text())
VERSION="E07.1"
BRT=ZoneInfo("America/Sao_Paulo")
LAG=7*86400
CAP=.10
RIDGE=.5
MIN_N=100
TAIL=1e-12
# gap_leader is the negative of gap_rank16 difference, not a separate signal.
GROUPS={"competitive":("points_per_game","gap_rank16","remaining"),
        "calendar":("rest_days","games_7d","games_14d"),
        "workload":("recent_player_minutes","recent_starter_minutes"),
        "rotation":("prior_rotation",)}
def raw(obj):
    return json.dumps(obj,sort_keys=True,separators=(",",":"),allow_nan=False).encode()
def digest(obj):return hashlib.sha256(raw(obj)).hexdigest()
def finite(x):return type(x) in (float,int) and math.isfinite(x)
def eligible(r,keys):return all(finite(r["features"].get(k)) for k in keys)
def day(t):return dt.datetime.fromtimestamp(t,BRT).date()
def day_start(d):return dt.datetime.combine(d,dt.time(),BRT).timestamp()
def verify_sources(c,report,ref,fixtures):
    if c["version"]!="E06.1" or report["version"]!="E06.1" or report["code_commit"]!=LOCK["e06_commit"] or c["production_ready"] or c["lineup_adjustment_enabled"]:
        raise ValueError("context version")
    if c["source_manifest_sha256"]!=ref["manifest_sha256"] or report["source_manifest_sha256"]!=ref["manifest_sha256"]:raise ValueError("context provenance")
    rs=c["records"]; fm={x["fixture_id"]:x for x in fixtures}
    if len(rs)!=1880 or len(fm)!=len(rs) or len({r["fixture_id"] for r in rs})!=len(rs) or report["fixtures"]!=len(rs):raise ValueError("coverage")
    for r in rs:
        g=fm[r["fixture_id"]]
        if (r["year"],r["t"],r["home_id"],r["away_id"],r["label"]["home_goals"],r["label"]["away_goals"])!=(g["year"],g["t"],g["home_id"],g["away_id"],g["score"]["home"],g["score"]["away"]):raise ValueError("E03 E06 mismatch")
        if r["point_in_time_certified"] or r["lineup_adjustment_enabled"] or e.stamp(r["as_of"])!=r["t"]:raise ValueError("context semantics")
        f=r["features"]
        if finite(f.get("gap_leader")) and finite(f.get("gap_rank16")) and abs(f["gap_leader"]+f["gap_rank16"])>1e-9:raise ValueError("redundancy contract")
    return sorted(rs,key=lambda r:(r["t"],r["fixture_id"]))
def replay(records,config,audit):
    mc=af.extract_map_config(audit); ex=config["execucao_2"]
    if config["versao_modelo"]!="AF-Previsão 1.3" or ex["rho_dixon_coles_producao"]!=0 or mc.prior_sd!=ex["desvio_prior"] or mc.half_life_days!=ex["meia_vida_dias"]:raise ValueError("baseline config drift")
    settings=config["execucao_4"]["tendencia_recente"]
    matches=[af.Match(r["year"],i,0,day(r["t"]),r["home_id"],r["away_id"],r["label"]["home_goals"],r["label"]["away_goals"]) for i,r in enumerate(records)]
    batches=collections.defaultdict(list)
    for i,r in enumerate(records):
        if r["year"]>=2024:batches[day(r["t"])].append(i)
    result=[]
    for d,indices in sorted(batches.items()):
        y=records[indices[0]]["year"]
        cutoff=day_start(d)
        known=[m for m,r in zip(matches,records) if y-3<=m.season<=y and r["t"]+LAG<=cutoff and m.played_on<d]
        if not known:raise ValueError("no baseline history")
        asof=max(m.played_on for m in known)+dt.timedelta(days=1)
        model=af.fit_poisson_map(known,asof,mc)
        current=[m for m in known if m.season==y]
        teams=sorted({c for m in current for c in (m.home,m.away)}|{c for i in indices for c in (matches[i].home,matches[i].away)})
        trends=af.calculate_recent_trends(current,model,teams,settings)
        fixtures=[af.Fixture(records[i]["fixture_id"],0,matches[i].home,matches[i].away,records[i]["as_of"],"") for i in indices]
        forecasts=af.build_forecasts(fixtures,model,0.,recent_trends=trends,max_fixture_adjustment_pct=settings["limite_ajuste_taxa_partida_pct"])
        for i,p in zip(indices,forecasts):
            rr=records[i];b={"rates":[p.home_rate,p.away_rate],"map_rates":[p.base_home_rate,p.base_away_rate],"ewma_pct":[p.trend_home_pct,p.trend_away_pct],"matrix":af.score_matrix(p.home_rate,p.away_rate,0.),"ved":list(p.probabilities),"ved_pct":list(percentage_partition(p.probabilities,4)),"display_pct":list(percentage_partition(p.probabilities,1)),"modal":list(p.modal),"top3":[list(x) for x in p.score_probabilities[:3]]}
            result.append({**rr,"baseline":b,"baseline_kind":"replay_af13_functions_e03_provider_ids","cutoff":cutoff,"model_as_of":asof.isoformat(),"prior_seasons":sorted({m.season for m in known if m.season<y}),"max_training_available":max(r["t"]+LAG for r in records if y-3<=r["year"]<=y and r["t"]+LAG<=cutoff and day(r["t"])<d)})
    return result
def controls(r):
    b=r["baseline"]
    return [math.log(x) for x in b["map_rates"]]+[math.log(b["rates"][i]/b["map_rates"][i]) for i in range(2)]
def fit(rows,keys,cutoff):
    tr=[r for r in rows if r["t"]+LAG<cutoff and eligible(r,keys)]
    if len(tr)<MIN_N:return None
    X=np.asarray([[r["features"][k] for k in keys] for r in tr],dtype=float)
    C=np.asarray([controls(r) for r in tr],dtype=float)
    mu=X.mean(0);sd=X.std(0); keep=sd>1e-8
    if not keep.any():return None
    X=(X[:,keep]-mu[keep])/sd[keep]
    cm=C.mean(0);cs=np.maximum(C.std(0),1e-8);C=(C-cm)/cs
    # Orthogonalize with pseudoinverse against baseline MAP strength/mando and EWMA.
    proj=np.linalg.pinv(C,rcond=1e-9)@X
    Z=X-C@proj
    active=Z.std(0)>1e-8
    if not active.any():return None
    Z=Z[:,active]
    selected=np.asarray(keys)[keep][active].tolist()
    mu=mu[keep][active];sd=sd[keep][active];proj=proj[:,active]
    rates=np.asarray([r["baseline"]["rates"] for r in tr])
    labels=np.asarray([[r["label"]["home_goals"],r["label"]["away_goals"]] for r in tr])
    betas=[];n=len(tr)
    for side in range(2):
        b=np.zeros(Z.shape[1])
        def obj(v):
            eta=Z@v
            if np.max(np.abs(eta))>40:return math.inf
            return float(np.mean(rates[:,side]*np.exp(eta)-labels[:,side]*eta)+RIDGE*np.dot(v,v)/2)
        for _ in range(80):
            pred=rates[:,side]*np.exp(Z@b)
            grad=Z.T@(pred-labels[:,side])/n+RIDGE*b
            if np.max(np.abs(grad))<1e-9:break
            h=(Z.T*pred)@Z/n+RIDGE*np.eye(len(b))
            step=np.linalg.solve(h,grad)
            scale=1.
            while scale>1e-8 and obj(b-scale*step)>obj(b):scale*=.5
            b-=scale*step
        if np.max(np.abs(Z.T@(rates[:,side]*np.exp(Z@b)-labels[:,side])/n+RIDGE*b))>1e-6:raise ValueError("optimizer")
        betas.append(b.tolist())
    return {"keys":selected,"required_keys":list(keys),"mean":mu.tolist(),"sd":sd.tolist(),"control_mean":cm.tolist(),"control_sd":cs.tolist(),"projection":proj.tolist(),"beta":betas,"n":n,"cutoff":cutoff,"train_max_available":max(r["t"]+LAG for r in tr),"ridge":RIDGE,"residual_cross_cov_max":float(np.max(np.abs(C.T@Z/n)))}
def matrix(h,a):
    if not all(finite(x) and 0<x<=12 for x in (h,a)):raise ValueError("rate")
    def pmf(l):
        p=[math.exp(-l)]
        while 1-math.fsum(p)>TAIL/2:
            if len(p)>=100:raise ValueError("tail")
            p.append(p[-1]*l/len(p))
        return p
    ph,pa=pmf(h),pmf(a);mass=math.fsum(ph)*math.fsum(pa)
    tail=max(0.,1-mass)
    if tail>TAIL+1e-15:raise ValueError("tail")
    m=[[x*y/mass for y in pa] for x in ph]
    v=[math.fsum(p for i,row in enumerate(m) for j,p in enumerate(row) if (i>j,i==j,i<j)[k]) for k in range(3)]
    v=[p/math.fsum(v) for p in v]
    if abs(math.fsum(v)-1)>1e-12 or min(v)<0:raise ValueError("partition")
    top=sorted(((p,i,j) for i,row in enumerate(m) for j,p in enumerate(row)),key=lambda x:(-x[0],x[1],x[2]))[:3]
    return {"rates":[h,a],"matrix":m,"tail_mass":tail,"ved":v,"ved_pct":list(percentage_partition(v,4)),"display_pct":list(percentage_partition(v,1)),"modal":[top[0][1],top[0][2]],"top3":[[i,j,p] for p,i,j in top]}
def exact_fallback(baseline_bytes):return baseline_bytes
def apply(r,m):
    b=r["baseline"]; original=raw(b)
    reason=None
    if m is None:reason="model_not_eligible"
    elif not eligible(r,m["required_keys"]):reason="missing_context"
    elif m["cutoff"]>r["cutoff"] or m["train_max_available"]>=m["cutoff"]:reason="temporal_guard"
    if reason:return json.loads(exact_fallback(original)),reason,[0.,0.]
    z=(np.asarray([r["features"][k] for k in m["keys"]])-m["mean"])/m["sd"]
    c=(np.asarray(controls(r))-m["control_mean"])/m["control_sd"]
    z=z-c@np.asarray(m["projection"])
    if not np.isfinite(z).all() or np.max(np.abs(z))>5:return json.loads(exact_fallback(original)),"out_of_support",[0.,0.]
    delta=np.clip(np.asarray(m["beta"])@z,math.log1p(-CAP),math.log1p(CAP))
    if np.max(np.abs(delta))<1e-14:return json.loads(exact_fallback(original)),"zero_adjustment",[0.,0.]
    rates=[b["rates"][i]*math.exp(delta[i]) for i in range(2)]
    return matrix(*rates),None,delta.tolist()
def published_audit():
    p=ROOT/"dados-br/probabilidades-jogos.json";d=e.load(p);validate_document(d)
    if d["versao_modelo"]!="AF-Previsão 1.3":raise ValueError("published baseline")
    a=ROOT/"dados-br/auditoria-probabilidades-jogos.json"
    from gerar_probabilidades_jogos import canonical_hash
    audit=e.load(a)
    if audit["hash_saida"]!=canonical_hash(d):raise ValueError("published baseline digest")
    data=p.read_bytes()
    if exact_fallback(data)!=data:raise ValueError("published fallback")
    history=verify_existing_history(ROOT)
    return {"snapshot_sha256":e.sha(p),"rows":len(d["jogos"]),"history_sha256":history,"fallback_whole_file_exact":True,"historical_ved_verified":history is not None,"historical_rates_not_paired":True}
def run(context,report,ref,fixtures,config,audit):
    rs=verify_sources(context,report,ref,fixtures)
    rr=replay(rs,config,audit)
    models={};summ={};out=[]
    for y in (2024,2025,2026):
        yr=[r for r in rr if r["year"]==y]
        cut=day_start(dt.date(y,1,1))
        models[str(y)]={g:fit(rr,keys,cut) for g,keys in GROUPS.items()}
        counts={g:collections.Counter() for g in GROUPS};tail=0.;fallback_checks=0
        for r in yr:
            variants={}
            for g,m in models[str(y)].items():
                p,reason,delta=apply(r,m)
                counts[g][reason or "adjusted"]+=1
                if reason:
                    if raw(p)!=raw(r["baseline"]):raise ValueError("fallback identity")
                    fallback_checks+=1
                else:tail=max(tail,p["tail_mass"])
                variants[g]={"forecast":p,"fallback":reason,"delta":delta,"parameter_sha256":digest(m)}
            out.append({**r,"variants":variants,"operational_prediction":"AF1.3","lineup_enabled":False})
        summ[str(y)]={"rows":len(yr),"full_three_prior_seasons":sum(len(r["prior_seasons"])==3 for r in yr),"variants":{g:dict(c) for g,c in counts.items()},"fit_n":{g:m["n"] if m else 0 for g,m in models[str(y)].items()},"max_residual_cross_cov":{g:m["residual_cross_cov_max"] if m else None for g,m in models[str(y)].items()},"fallback_checks":fallback_checks,"max_tail":tail}
    return {"version":VERSION,"records":out,"models":models,"production_ready":False,"lineup_enabled":False,"point_in_time_certified":False},summ
def main():
    p=argparse.ArgumentParser()
    for k in ("archive","e03-report","context","e06-report","workspace","output","report"):p.add_argument("--"+k,type=Path,required=True)
    a=p.parse_args()
    try:
        os.umask(0o077)
        for path in (a.workspace,a.output,a.report):
            q=path.resolve()
            if q.exists() or q==ROOT or ROOT in q.parents or q in ROOT.parents:raise ValueError("private path")
        inputs=(a.archive,a.e03_report,a.context,a.e06_report);before=[e.sha(p) for p in inputs]
        ref=e.load(a.e03_report);report=e.load(a.e06_report)
        if e.sha(a.context)!=report["private_sha256"]:raise ValueError("context hash")
        e.extract(a.archive,a.workspace);man,fixtures,_=e.input_data(a.workspace,ref)
        conf=e.load(af.CONFIG_PATH);audit=e.load(af.AUDIT_MODELS_PATH)
        pub=published_audit()
        private,summ=run(e.load(a.context),report,ref,fixtures,conf,audit)
        private["source_manifest_sha256"]=ref["manifest_sha256"]
        private["baseline_provenance"]={"kind":"faithful function replay, not archived original","source":"E03/E06 same provider IDs, assumed seven-day lag, local-day cutoff, three prior seasons when present; 2024 warmup with only two","config_sha256":e.sha(af.CONFIG_PATH),"audit_sha256":e.sha(af.AUDIT_MODELS_PATH),"production_code_sha256":{p:e.sha(ROOT/"scripts"/p) for p in ("af_previsao_backtest.py","gerar_probabilidades_brasileirao.py","gerar_probabilidades_jogos.py")},"published":pub}
        if before!=[e.sha(p) for p in inputs] or pub!=published_audit():raise ValueError("input mutation")
        e.write(a.output,private)
        result={"version":VERSION,"code_commit":os.getenv("GITHUB_SHA","local"),"private_sha256":e.sha(a.output),"source_manifest_sha256":ref["manifest_sha256"],"context_sha256":before[2],"baseline_provenance":private["baseline_provenance"],"folds":summ,"parameter_sha256":digest(private["models"]),"fixtures":len(private["records"]),"api_requests":0,"production_ready":False,"lineup_enabled":False,"rapm_required":False,"point_in_time_certified":False,"predictive_gain_claimed":False,"candidate":"competitive","other_variants":"research only"}
        e.write(a.report,result)
        print("E07 AGGREGATE",json.dumps(result,sort_keys=True))
        return 0
    except Exception as exc:
        print("BLOCKED: E07 exception type="+type(exc).__name__);return 2
if __name__=="__main__":sys.exit(main())
