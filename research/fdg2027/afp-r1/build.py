"""Private seasonal AF-Player ranking candidate, using the unchanged E04 engine."""
import argparse,collections as C,datetime as dt,hashlib,json,math,os,re,shutil,sys,unicodedata
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
sys.path.insert(0,str(HERE.parent/"e04"))
import engine as e
POL=json.loads((HERE/"policy.json").read_text())
def norm(s):return " ".join(re.sub(r"[^a-z0-9]+"," ",unicodedata.normalize("NFKD",str(s or "")).encode("ascii","ignore").decode().lower()).split())
def load(p):return json.loads(p.read_text(encoding="utf-8"))
def save(p,v):p.write_text(json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(",",":"),allow_nan=False)+"\n",encoding="utf-8")
def valid_num(v):return type(v) in (int,float) and math.isfinite(v) and 0<=v<=100
def eligible(row,year,asof):
    return (valid_num(row["rating"]) and row["season_minutes"]>=POL["min_season_minutes"] and row["confidence"]>=POL["min_confidence"] and (year!=2026 or (asof-e.stamp(row["last_match_at"]))/86400<=POL["active_observation_days"]))
def percentiles(rows):
    for p in e.FIELDS:
        group=sorted((r for r in rows if r["eligible"] and r["position"]==p),key=lambda r:r["rating"])
        i=0
        while i<len(group):
            j=i+1
            while j<len(group) and group[j]["rating"]==group[i]["rating"]:j+=1
            for r in group[i:j]:
                r["percentile"]=round(100*(i+j)/(2*len(group)),3);r["position_rank"]=len(group)-j+1
            i=j
    return sorted(rows,key=lambda r:(not r["eligible"],-(r["percentile"] if r["percentile"] is not None else -1),r["position"],-float(r["rating"] or 0),r["name"],r["club"]))
def cohort(y,prepared,models,asof,clubs,identity,roster):
    per=C.defaultdict(list)
    for r in prepared:
        if r["year"]<=y and r["available"]<=asof:per[r["player_id"]].append(r)
    out=[];audit=C.Counter()
    for pid,past in sorted(per.items()):
        current=[r for r in past if r["year"]==y]
        if not current:continue
        last=current[-1];pos=last["pos"];name=last.get("source_name");club=clubs.get(last["club_id"])
        if not isinstance(name,str) or not name.strip() or not isinstance(club,str) or not club.strip():
            audit["missing_display_identity"]+=1;continue
        pr=e.profile(past,pos,asof,models) if models else {"rating":None,"offense":None,"defense":None,"confidence":0,"effective_minutes":0,"games":0,"feature_count":0,"partial_axes":True}
        ir=identity.get(pid,{})
        if y==2026:
            candidates=roster.get((norm(club),norm(name),pos),set())
            review="candidate_unique" if len(candidates)==1 and ir.get("mapping_status")=="review_unique_name_club_position" else "review_required"
        else:review="historical_provider_identity"
        row={"name":name,"club":club,"position":pos,"season_minutes":sum(r["m"] for r in current),"season_games":len({r["fixture_id"] for r in current}),"last_match_at":e.iso(last["t"]),"rating":pr["rating"],"offense":pr["offense"],"defense":pr["defense"],"confidence":pr["confidence"],"effective_minutes":pr["effective_minutes"],"partial_axes":pr.get("partial_axes",True),"feature_count":pr["feature_count"],"identity_review":review,"percentile":None,"position_rank":None}
        for k in ("rating","offense","defense","confidence"):
            if row[k] is not None and not valid_num(row[k]):raise ValueError("rating range")
        row["eligible"]=eligible(row,y,asof)
        row["status"]="ranked_candidate" if row["eligible"] else "insufficient_evidence" if models else "calibration_unavailable"
        audit[row["status"]]+=1;audit[review]+=1
        out.append(row)
    return percentiles(out),dict(audit)
def roster_index(doc):
    idx=C.defaultdict(set);roles={"goleiro":"G","defensor":"D","meio campista":"M","meia":"M","atacante":"F"}
    for club,rr in doc.get("elencos",{}).items():
        for r in rr:
            p=roles.get(norm(r.get("posicao")))
            if p and r.get("id"):idx[(norm(club),norm(r.get("nome")),p)].add(str(r["id"]))
    return idx
def audit_gate(folds):
    return {y:{p:sorted(m) for p,m in f["models"].items()} for y,f in folds.items()}
def build(w,out):
    if POL["publication"]!="BLOCKED" or any(POL[k] for k in ("rights_verified","identity_verified","semantic_certified","public_release_authorized")):raise ValueError("unexpected release gate")
    report=load(w/"e03-report.json");p04=load(w/"e04-report.json")
    source=w/"source.tar";profiles=w/"af-player.json"
    if e.sha(profiles)!=p04["private_sha256"] or p04["code_commit"]!="95f53441f932d996c9c1e238a7be9b5e9f07d9d1":raise ValueError("E04 hash")
    artifact=load(profiles)
    e.extract(source,w/"canonical")
    man,fixtures,rows=e.input_data(w/"canonical",report)
    if artifact["source_manifest_sha256"]!=report["manifest_sha256"] or artifact["version"]!=e.VERSION or artifact["production_ready"] is not False:raise ValueError("E04 provenance")
    prepared=e.prepare(fixtures,rows)
    if len(prepared)!=p04["core_rows"] or len(artifact["ratings"])!=p04["ratings"]:raise ValueError("E04 accounting")
    by=C.defaultdict(list)
    for r in prepared:by[r["player_id"]].append(r)
    observed=e.stamp(man["snapshot_observed_by"])
    # Check every original profile against the original frozen model, no new training or provider rating.
    for r in artifact["ratings"]:
        h=by[r["player_id"]];v=e.profile(h,r["position"],observed,artifact["folds"]["2026"]["models"])
        for k in ("rating","offense","defense","confidence","effective_minutes","games","feature_count"):
            if v[k]!=r[k]:raise ValueError("E04 reproduction")
    roster=roster_index(load(ROOT/"dados-br/elencos.json"))
    seasons={};aggregate={}
    for y in e.YEARS:
        data=load(w/"canonical"/f"fdg2027/bra.1/{y}/identity_map.json")
        identities={r["player_id"]:r for r in data["players"]}
        clubs=data["clubs"]
        games=[g for g in fixtures if g["year"]==y]
        cut=min(observed,e.stamp(f"{y+1}-01-08T00:00:00+00:00"))
        models=artifact["folds"].get(str(y),{}).get("models")
        ranked,counts=cohort(y,prepared,models,cut,clubs,identities,roster)
        duplicate_labels=C.Counter((norm(r["name"]),norm(r["club"]),r["position"]) for r in ranked)
        # No ambiguous names enter the candidate ranking.
        for r in ranked:
            if duplicate_labels[(norm(r["name"]),norm(r["club"]),r["position"])]>1:
                r.update(eligible=False,status="ambiguous_display_identity",percentile=None,position_rank=None)
        ranked=percentiles(ranked)
        coverage={"catalogued":len(games),"detailed":sum(bool(g["detailed"]) for g in games),"last_fixture_at":max((g["kickoff_at"] for g in games),default=None)}
        seasons[str(y)]={"as_of":e.iso(cut),"coverage":coverage,"calibrated":bool(models),"rows":ranked}
        aggregate[str(y)]={**coverage,"observed_players":len(ranked),"ranked_candidates":sum(r["eligible"] for r in ranked),"by_position":{p:{"observed":sum(r["position"]==p for r in ranked),"eligible":sum(r["position"]==p and r["eligible"] for r in ranked)} for p in e.FIELDS},"identity_review":dict(C.Counter(r["identity_review"] for r in ranked)),"status":dict(C.Counter(r["status"] for r in ranked))}
    current=load(ROOT/"resultados.json")["resultados"]
    # No matching by cross-provider ID: flag catalog delta for controlled recovery, not missing fixture identities.
    report_out={"version":POL["version"],"source_manifest_sha256":report["manifest_sha256"],"e04_profiles_reproduced":len(artifact["ratings"]),"input_rows":len(rows),"core_rows":len(prepared),"seasons":aggregate,"current_public_finals":len(current),"catalogue_count_delta_2026":len(current)-aggregate["2026"]["catalogued"],"metrics_admitted":audit_gate(artifact["folds"]),"api_requests":0,"publication":"BLOCKED","gates":{"rights_verified":False,"identity_verified":False,"semantic_certified":False,"public_release_authorized":False},"limitations":["2022–2023 lack prior calibrated folds","2026 cohort is recent observed appearance, not verified roster","Confidence is heuristic, not a probability","Historical simulated seven-day availability lag","Counts reflect original archive, not completed incremental recovery"]}
    out.mkdir(mode=0o700)
    save(out/"ranking.json",{"version":POL["version"],"publication":"PRIVATE_RESEARCH","as_of":e.iso(observed),"policy":{k:POL[k] for k in ("min_season_minutes","min_confidence","active_observation_days")},"seasons":seasons})
    save(w/"afp-report.json",report_out)
    for f in ("index.html","app.js","style.css"):shutil.copyfile(HERE/f,out/f)
    print("AFP aggregate:",json.dumps(report_out,ensure_ascii=False,sort_keys=True))
def main():
    os.umask(0o077)
    w=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve()
    if ROOT==w or ROOT in w.parents or ROOT in out.parents or out.exists():raise SystemExit("private workspace required")
    try:build(w,out)
    except Exception as exc:
        print("AFP BLOCKED:",type(exc).__name__);return 2
    return 0
if __name__=="__main__":sys.exit(main())
