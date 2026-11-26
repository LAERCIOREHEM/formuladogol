"""E08.1: paired temporal replay scoring, documentary archive separate, no promotion."""
import argparse, collections as C, datetime as dt, hashlib, json, math, os, random, sys
from pathlib import Path
import numpy as np
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/"e07"))
import forecast_engine as f
from auditar_historico_placares_af import validate_report, canonical_hash, parse_dt
e=f.e
LOCK=e.load(HERE/"source-lock.json")
PROTOCOL=e.load(HERE/"protocol.json")
VERSION="E08.1"
KEYS=("brier","log_loss","ved","exact","top3")
OUTCOMES=("mandante","empate","visitante")
def outcome(h,a):return 0 if h>a else 1 if h==a else 2
def scores(p,h,a):
    v=np.asarray(p["ved"],dtype=float)
    if len(v)!=3 or not np.isfinite(v).all() or min(v)<0 or abs(sum(v)-1)>1e-8:raise ValueError("VED")
    o=outcome(h,a)
    modal=tuple(p["modal"]); top=[tuple(x[:2]) for x in p["top3"]]
    if len(top)!=3 or len(set(top))!=3:raise ValueError("top3")
    return {"brier":float(np.sum((v-np.eye(3)[o])**2)),"log_loss":-math.log(max(1e-12,float(v[o]))),"ved":int(np.argmax(v)==o),"exact":int(modal==(h,a)),"top3":int((h,a) in top)}
def calibration(ps,ys):
    if not ps:return None
    v=np.asarray(ps);y=np.asarray(ys);out=[]
    for k in range(3):
        bins=[];ece=0.
        for j in range(10):
            mask=(v[:,k]>=j/10)&((v[:,k]<(j+1)/10) if j<9 else (v[:,k]<=1))
            n=int(mask.sum())
            if not n:bins.append({"n":0,"mean":None,"observed":None});continue
            m=float(v[mask,k].mean());o=float((y[mask]==k).mean())
            ece+=n/len(y)*abs(m-o);bins.append({"n":n,"mean":m,"observed":o})
        out.append({"ece":ece,"bins":bins})
    return {"macro_ece":sum(x["ece"] for x in out)/3,"classes":dict(zip(OUTCOMES,out))}
def record(r,p):
    h,a=r["label"]["home_goals"],r["label"]["away_goals"]
    return scores(p,h,a)
def summary(pairs):
    # pair: (row, baseline, candidate)
    if not pairs:return {"n":0}
    out={"n":len(pairs)}
    for name,i in (("baseline",1),("candidate",2)):
        ss=[record(x[0],x[i]) for x in pairs]
        out[name]={k:sum(v[k] for v in ss)/len(ss) for k in KEYS}
        cal=calibration([x[i]["ved"] for x in pairs],[outcome(x[0]["label"]["home_goals"],x[0]["label"]["away_goals"]) for x in pairs])
        out[name]["calibration"]=cal
    out["delta"]={k:out["candidate"][k]-out["baseline"][k] for k in KEYS}
    return out
def paired_ci(pairs):
    blocks=C.defaultdict(list)
    for r,b,c in pairs:
        d=f.day(r["t"]).isocalendar()
        x,y=record(r,b),record(r,c)
        blocks[(r["year"],d.year,d.week)].append([y[k]-x[k] for k in KEYS])
    by_year=C.defaultdict(list)
    for key,v in sorted(blocks.items()):by_year[key[0]].append((np.sum(v,axis=0),len(v)))
    if len(blocks)<PROTOCOL["uncertainty"]["min_clusters"]:return {"clusters":len(blocks),"intervals":None}
    rng=random.Random(PROTOCOL["uncertainty"]["seed"])
    vals=[]
    for _ in range(PROTOCOL["uncertainty"]["replicates"]):
        sums=np.zeros(len(KEYS));n=0
        for year,bs in sorted(by_year.items()):
            for _ in bs:
                s,k=rng.choice(bs);sums+=s;n+=k
        vals.append(sums/n)
    q=np.quantile(vals,[.025,.975],axis=0)
    return {"clusters":len(blocks),"intervals":{k:[float(q[0,i]),float(q[1,i])] for i,k in enumerate(KEYS)}}
def compact(s):
    if not s["n"]:return s
    return {"n":s["n"],"baseline":{**{k:s["baseline"][k] for k in KEYS},"ece":s["baseline"]["calibration"]["macro_ece"]},"candidate":{**{k:s["candidate"][k] for k in KEYS},"ece":s["candidate"]["calibration"]["macro_ece"]},"delta":s["delta"]}
def verify(data,rep,xi,xrep,paths):
    if data["version"]!="E07.1" or rep["version"]!="E07.1" or rep["code_commit"]!=LOCK["e07_commit"] or data["production_ready"] or data["lineup_enabled"] or data["point_in_time_certified"]:raise ValueError("E07 state")
    if e.sha(paths[0])!=rep["private_sha256"] or f.digest(data["models"])!=rep["parameter_sha256"]:raise ValueError("E07 checksum")
    if xi["version"]!="E05.1" or xrep["version"]!="E05.1" or xrep["code_commit"]!=LOCK["e05_commit"] or xi["production_ready"] or xi["availability_certified"] or e.sha(paths[1])!=xrep["private_sha256"]:raise ValueError("E05 state")
    if len({data["source_manifest_sha256"],rep["source_manifest_sha256"],xi["source_manifest_sha256"],xrep["source_manifest_sha256"]})!=1:raise ValueError("source binding")
    rows=sorted(data["records"],key=lambda r:(r["t"],r["fixture_id"]))
    xm={r["fixture_id"]:r for r in xi["records"]}
    if len(rows)!=1120 or len(xm)!=len(xi["records"]) or len(xm)!=len(rows) or set(xm)!={r["fixture_id"] for r in rows} or C.Counter(r["year"] for r in rows)!={2024:380,2025:380,2026:360}:raise ValueError("cohort")
    for r in rows:
        x=xm[r["fixture_id"]];y=r["year"];cut=f.day_start(dt.date(y,1,1))
        if x["year"]!=y or x["t"]!=r["t"] or x["home"]["club_id"]!=r["home_id"] or x["away"]["club_id"]!=r["away_id"] or x["goal_diff"]!=r["label"]["goal_diff"] or x["pregame_lineup_certified"] or x["publication_allowed"]:raise ValueError("XI join")
        if not (r["max_training_available"]<=r["cutoff"]<=r["t"]) or r["cutoff"]!=f.day_start(f.day(r["t"])) or f.e.stamp(r["as_of"])!=r["t"] or r["point_in_time_certified"] or r["lineup_enabled"]:raise ValueError("time")
        if dt.date.fromisoformat(r["model_as_of"])>f.day(r["t"]):raise ValueError("baseline asof")
        for g,v in r["variants"].items():
            m=data["models"][str(y)][g]
            if f.digest(m)!=v["parameter_sha256"] or (m and not m["train_max_available"]<m["cutoff"]==cut):raise ValueError("fit cutoff")
            if v["fallback"] is not None and f.raw(v["forecast"])!=f.raw(r["baseline"]):raise ValueError("fallback")
        r["xi_supported"]=bool(x["supported"])
        if r["xi_supported"]!=(x["home"]["status"]==x["away"]["status"]=="supported"):raise ValueError("XI gate")
        r["xi_diff"]=x["lineup_diff"] if r["xi_supported"] else None
    return rows
def groups(rows):
    result={}
    for g in f.GROUPS:
        p=[(r,r["baseline"],r["variants"][g]["forecast"]) for r in rows]
        eligible=[x for x in p if x[0]["variants"][g]["fallback"] is None]
        result[g]={"all":summary(p),"adjusted_only":summary(eligible),"ci":paired_ci(p),"fallback":dict(C.Counter(r["variants"][g]["fallback"] or "adjusted" for r in rows))}
    return result
def xi_experiment(rows):
    result={};allpairs=[];supportedpairs=[]
    # The E05 gate is unchanged; fit only on supported rows and prior available outcomes.
    rs=[]
    for r in rows:
        b=r["variants"]["competitive"]["forecast"]
        base={**r["baseline"],**b,"map_rates":r["baseline"]["map_rates"]}
        rs.append({**r,"baseline":base,"features":{"xi_diff":r["xi_diff"]}})
    for y in (2025,2026):
        cut=f.day_start(dt.date(y,1,1))
        tr=[r for r in rs if r["t"]+f.LAG<cut and r["xi_supported"]]
        m=f.fit(tr,("xi_diff",),cut)
        pp=[];supp=[];reasons=C.Counter()
        for r in rs:
            if r["year"]!=y:continue
            p,why,_=f.apply(r,m)
            # No fabricated additions: candidate reverts to competitive if not eligible.
            reasons[why or "adjusted"]+=1
            pp.append((r,r["baseline"],p))
            if r["xi_supported"]:supp.append(pp[-1])
        allpairs+=pp;supportedpairs+=supp
        result[str(y)]={"train_supported":len(tr),"test_supported":len(supp),"model_fitted":m is not None,"fallback":dict(reasons),"all":summary(pp),"supported":summary(supp)}
    return {"by_year":result,"all":summary(allpairs),"supported":summary(supportedpairs),"ci":paired_ci(supportedpairs),"availability_certified":False,"operational":False}
def ablation(rows):
    result={};keys=tuple(k for g in f.GROUPS.values() for k in g)
    for y in (2025,2026):
        cut=f.day_start(dt.date(y,1,1))
        tr=[r for r in rows if r["t"]+f.LAG<cut and f.eligible(r,keys)]
        te=[r for r in rows if r["year"]==y and f.eligible(r,keys)]
        models={"full":f.fit(tr,keys,cut)}
        for g,kk in f.GROUPS.items():models["without_"+g]=f.fit(tr,tuple(k for k in keys if k not in kk),cut)
        result[str(y)]={"train_n":len(tr),"test_n":len(te),"variants":{}}
        if models["full"] is None:
            result[str(y)]["status"]="insufficient_common_training";continue
        full=[f.apply(r,models["full"])[0] for r in te]
        for g,m in models.items():
            if m is None:result[str(y)]["variants"][g]={"status":"not_fitted"};continue
            p=[(r,r["baseline"],f.apply(r,m)[0]) for r in te]
            result[str(y)]["variants"][g]={"against_baseline":summary(p),"against_full":summary([(r,b,x[2]) for r,b,x in zip(te,full,p)])}
        result[str(y)]["status"]="exploratory"
    return result
def robust(rows):
    p=[(r,r["baseline"],r["variants"]["competitive"]["forecast"]) for r in rows]
    partitions=C.defaultdict(list);clubs=C.defaultdict(list)
    for x in p:
        r,b,c=x
        lab=r["label"];o=outcome(lab["home_goals"],lab["away_goals"])
        partitions["actual_"+OUTCOMES[o]].append(x)
        partitions["favorite_"+OUTCOMES[int(np.argmax(b["ved"]))]].append(x)
        partitions["fallback" if r["variants"]["competitive"]["fallback"] else "adjusted"].append(x)
        partitions["rotation_available" if f.eligible(r,f.GROUPS["rotation"]) else "rotation_missing"].append(x)
        partitions["workload_available" if f.eligible(r,f.GROUPS["workload"]) else "workload_missing"].append(x)
        partitions["xi_supported" if r["xi_supported"] else "xi_not_supported"].append(x)
        for role in ("home","away"):
            clubs[(r["year"],role,r[role+"_id"])].append(x)
        month=f.day(r["t"]).month
        partitions["first_half_calendar" if month<=6 else "second_half_calendar"].append(x)
    # Same truncation kernel as AF1.3 sensitivity; also quantify pure kernel-change effect.
    legacy=[];kernel=[]
    for r,b,c in p:
        if r["variants"]["competitive"]["fallback"]:
            legacy.append((r,b,b));kernel.append((r,b,b));continue
        h,a=c["rates"];m=f.af.score_matrix(h,a,0.)
        z={**c,"ved":list(f.af.outcome_from_matrix(m)),"modal":list(f.af.modal_score(m)),"top3":[list(t) for t in f.af.top_scores(m,3)]}
        legacy.append((r,b,z));kernel.append((r,b,f.matrix(*b["rates"])))
    return {"strata":{k:summary(v) for k,v in sorted(partitions.items())},"clubs_private":{str(k):summary(v) for k,v in sorted(clubs.items())},"legacy_kernel":summary(legacy),"kernel_only":summary(kernel)}
def archive_report(doc):
    validate_report(doc)
    if doc["integridade"]["hash_resumo"]!=canonical_hash(doc["resumo"]):raise ValueError("archive summary")
    pairs=[];versions=C.Counter()
    for x in doc["jogos"]:
        if x["situacao"]!="comprovado":continue
        p=x["previsao"];pr=x["proveniencia"];kick=parse_dt(x["inicio_factual"])
        if pr.get("calculado_em") and parse_dt(pr["calculado_em"])>=kick:raise ValueError("archive time")
        ved=[p["probabilidades_ved_pct"][k]/100 for k in OUTCOMES];total=sum(ved)
        if abs(total-1)>.0005:raise ValueError("archive probabilities")
        z={"ved":[v/total for v in ved],"modal":[p["placar_modal"][k] for k in ("mandante","visitante")],"top3":[[i["mandante"],i["visitante"],i["probabilidade_pct"]/100] for i in x["top3_placares"]]}
        r={"label":{"home_goals":x["placar_final"]["mandante"],"away_goals":x["placar_final"]["visitante"]},"t":kick.timestamp(),"year":2026}
        versions[pr["versao_modelo"]]+=1;pairs.append((r,z,z))
    if len(pairs)!=178:raise ValueError("pinned archive coverage")
    s=summary(pairs)
    return {"n":len(pairs),"archive_total":len(doc["jogos"]),"versions":dict(versions),"metrics":s["baseline"],"paired_to_e07":False,"point_in_time_note":"git documentary evidence, not actual page delivery; different forecast horizon"}
def gate(byyear,pooled):
    s=pooled["all"];ci=pooled["ci"]["intervals"]
    checks={}
    for k in ("brier","log_loss"):
        checks[k+"_relative_1pct"]=s["candidate"][k]<=.99*s["baseline"][k]
        checks[k+"_ci_upper_negative"]=ci is not None and ci[k][1]<0
        checks[k+"_each_year_no_degradation_gt_1pct"]=all(z["competitive"]["all"]["candidate"][k]<=1.01*z["competitive"]["all"]["baseline"][k] for z in byyear.values())
    return {"checks":checks,"pass":all(checks.values()),"promotion":False,"decision":"retain AF1.3; prospective validation required regardless of retrospective gate"}
def main():
    p=argparse.ArgumentParser()
    for k in ("forecast","e07-report","lineup","e05-report","archive","output","report"):p.add_argument("--"+k,type=Path,required=True)
    a=p.parse_args()
    try:
        os.umask(0o077)
        for path in (a.output,a.report):
            q=path.resolve()
            if q.exists() or q==f.ROOT or f.ROOT in q.parents or q in f.ROOT.parents:raise ValueError("private path")
        inputs=(a.forecast,a.e07_report,a.lineup,a.e05_report,a.archive);before=[e.sha(p) for p in inputs]
        data=e.load(a.forecast);rep=e.load(a.e07_report);rows=verify(data,rep,e.load(a.lineup),e.load(a.e05_report),(a.forecast,a.lineup))
        byyear={str(y):groups([r for r in rows if r["year"]==y]) for y in (2025,2026)}
        test=[r for r in rows if r["year"] in (2025,2026)]
        pooled=groups(test);xi=xi_experiment(rows);ab=ablation(rows);rb=robust(test);arc=archive_report(e.load(a.archive));decision=gate(byyear,pooled["competitive"])
        private={"version":VERSION,"protocol":PROTOCOL,"source_hashes":before,"by_year":byyear,"pooled":pooled,"xi":xi,"ablation":ab,"robustness":rb,"archive":arc,"decision":decision}
        if before!=[e.sha(p) for p in inputs]:raise ValueError("source mutation")
        e.write(a.output,private)
        result={"version":VERSION,"code_commit":os.getenv("GITHUB_SHA","local"),"source_commit":LOCK["e07_commit"],"source_private_sha256":before[0],"protocol_sha256":e.sha(HERE/"protocol.json"),"private_sha256":e.sha(a.output),"source_manifest_sha256":data["source_manifest_sha256"],"warmup":380,"paired":len(test),"by_year":{y:{g:compact(s["all"]) for g,s in v.items()} for y,v in byyear.items()},"pooled":{g:{"all":compact(v["all"]),"adjusted_only":compact(v["adjusted_only"]),"ci":v["ci"],"fallback":v["fallback"]} for g,v in pooled.items()},"xi":{"by_year":{y:{k:v[k] for k in ("train_supported","test_supported","model_fitted","fallback")} for y,v in xi["by_year"].items()},"all":compact(xi["all"]),"supported":compact(xi["supported"]),"availability_certified":False},"ablation":{y:{"train_n":v["train_n"],"test_n":v["test_n"],"status":v["status"],"variants":{k:compact(z["against_full"]) if "against_full" in z else z for k,z in v["variants"].items()}} for y,v in ab.items()},"robustness":{"legacy_kernel":compact(rb["legacy_kernel"]),"kernel_only":compact(rb["kernel_only"]),"strata":{k:compact(v) for k,v in rb["strata"].items()},"club_role_strata_private":len(rb["clubs_private"])},"archive":{"n":arc["n"],"archive_total":arc["archive_total"],"versions":arc["versions"],"metrics":{**{k:arc["metrics"][k] for k in KEYS},"ece":arc["metrics"]["calibration"]["macro_ece"]},"paired_to_e07":False,"sha256":before[4]},"decision":decision,"api_requests":0,"production_ready":False,"lineup_enabled":False,"point_in_time_certified":False,"prospective_started":False}
        e.write(a.report,result)
        print("E08 CORE",json.dumps({k:result[k] for k in ("version","paired","warmup","by_year","pooled","xi","ablation","archive","decision","private_sha256","protocol_sha256")},sort_keys=True))
        print("E08 ROBUST",json.dumps(result["robustness"],sort_keys=True))
        return 0
    except Exception as exc:
        print("BLOCKED: E08 exception type="+type(exc).__name__);return 2
if __name__=="__main__":sys.exit(main())
