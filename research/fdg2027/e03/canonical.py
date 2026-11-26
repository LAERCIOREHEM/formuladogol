"""E03 private offline canonicalization; no provider calls or production writes."""
import argparse, collections, datetime as dt, hashlib, json, os, sys
from pathlib import Path
HERE=Path(__file__).resolve().parent
REPO=HERE.parents[2]
sys.path[:0]=[str(HERE.parent/"e01"),str(HERE.parent/"e02")]
import foundation as f
import player_data_discovery as b
import historical_r2 as r2
import historical_r3 as r3
import historical_r4 as r4
LOCK=json.loads((HERE/"source-lock.json").read_text())
VERSION="E03.1"
YEARS=("2022","2023","2024","2025","2026")
PATHS={"minutes":("games","minutes"),"starter":("games","substitute"),"position":("games","position"),"rating":("games","rating"),
"goals":("goals","total"),"assists":("goals","assists"),"shots":("shots","total"),"shots_on_target":("shots","on"),
"passes":("passes","total"),"pass_accuracy":("passes","accuracy"),"tackles":("tackles","total"),"interceptions":("tackles","interceptions"),
"duels_won":("duels","won"),"saves":("goals","saves"),"xg":("xg",),"key_passes":("passes","key"),
"duels_total":("duels","total"),"blocks":("tackles","blocks"),"goals_conceded":("goals","conceded")}
ROLE={"G":{"saves","goals_conceded","passes"},"D":{"tackles","interceptions","duels_won","blocks","passes"},
"M":{"passes","key_passes","duels_won","tackles","interceptions","assists"},"F":{"shots","shots_on_target","goals","assists","duels_won","key_passes"}}
P="api-football"
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def extract(o,path):
    for k in path:
        if not isinstance(o,dict) or k not in o:return None,False
        o=o[k]
    return o,True
def normalize(k,v,exists):
    if not exists:return None,"absent"
    if v is None:return None,"explicit_null"
    if k=="starter":return (not v,"valid_shape") if type(v) is bool else (None,"invalid_shape")
    if k=="position":return (v,"valid_shape") if isinstance(v,str) and v in ROLE else (None,"invalid_shape")
    n=r4.number(v)
    if n is None or n<0:return None,"invalid_shape"
    if k in ("pass_accuracy","xg"):return None,"unit_or_definition_unverified"
    if k=="rating":return (n,"benchmark_only") if n<=10 else (None,"invalid_range")
    if k=="minutes":
        if not n.is_integer() or n>90:return None,"minute_convention_unverified"
        return int(n),"zero_exposure" if n==0 else "reported_regulation_proxy"
    if not n.is_integer():return None,"invalid_shape"
    return int(n),"explicit_zero" if n==0 else "observed_count"
def timestamp(v):
    d=dt.datetime.fromisoformat(v.replace("Z","+00:00"))
    if d.tzinfo is None:raise ValueError("timezone required")
    return d.astimezone(dt.timezone.utc).isoformat()
def row(y,fid,tid,p,s,kick,observed,cls):
    pid=r4.ident(b.get(p,"player","id"))
    raw={};present={};vals={};quality={}
    for k,path in PATHS.items():
        raw[k],present[k]=extract(s,path)
        vals[k],quality[k]=normalize(k,raw[k],present[k])
    for part,total in (("shots_on_target","shots"),("duels_won","duels_total"),("key_passes","passes")):
        if vals[part] is not None and vals[total] is not None and vals[part]>vals[total]:
            for k in (part,total):vals[k]=None;quality[k]="cross_field_conflict"
    pos=vals["position"];m=vals["minutes"]
    core=pos in ROLE and type(vals["starter"]) is bool and m is not None and m>0
    fields=sorted(k for k in ROLE.get(pos,set()) if quality[k] in ("observed_count","explicit_zero"))
    fixture=f.identity("fixture",P,fid,y)
    return {"row_id":fixture+":"+tid+":"+pid,"fixture_id":fixture,"player_id":f.identity("player",P,pid),
      "club_id":f.identity("club",P,tid),"source_ids":{"fixture":fid,"club":tid,"player":pid},"source":P,
      "source_run_id":LOCK["source_run_id"],"source_name":b.get(p,"player","name"),
      "kickoff_at":kick,"snapshot_observed_by":observed,"source_published_at":None,"pregame_availability_certified":False,
      "raw":raw,"raw_present":present,"values":vals,"quality":quality,"timeline_class":cls,
      "individual_core_valid":core,"provisional_role_fields":fields,
      "af_player_exploratory_candidate":bool(core and len(fields)>=2),"semantic_certified":False}
def active(s):return b.get(s,"games","substitute") is False or (r4.number(b.get(s,"games","minutes")) or 0)>0
def write(p,x):
    p.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    with p.open("x",encoding="utf-8") as out:json.dump(x,out,sort_keys=True,separators=(",",":"),ensure_ascii=False,allow_nan=False);out.write("\n")
def envelope(y,**kw):return f.validate_envelope(y,dict(schema=1,version=VERSION,competition=f.COMP,season=int(y),**kw))
def coverage(rows):
    by=collections.defaultdict(lambda:collections.defaultdict(collections.Counter));counts=collections.Counter();acc=collections.defaultdict(collections.Counter)
    for p in rows:
        counts["rows"]+=1
        for k in ("individual_core_valid","af_player_exploratory_candidate"):counts[k]+=int(p[k])
        counts["zero_exposure"]+=int(p["quality"]["minutes"]=="zero_exposure")
        counts["minutes_unverified"]+=int(p["quality"]["minutes"]=="minute_convention_unverified")
        for g in ("all",p["values"]["position"] or "unknown"):
            by[g]["_rows"]["rows"]+=1
            for k in PATHS:
                by[g][k][p["quality"][k]]+=1
                by[g][k]["raw_present_nonnull"]+=int(p["raw_present"][k] and p["raw"][k] is not None)
                by[g][k]["usable_value"]+=int(p["values"][k] is not None)
            a=r4.number(p["raw"]["pass_accuracy"]);t=r4.number(p["raw"]["passes"])
            if a is not None and t is not None:
                acc[g]["paired"]+=1;acc[g]["gt_100"]+=int(a>100);acc[g]["gt_passes"]+=int(a>t);acc[g]["le_100_gt_passes"]+=int(a<=100 and a>t)
    return dict(counts),{g:{k:dict(v) for k,v in x.items()} for g,x in by.items()},{g:dict(v) for g,v in acc.items()}
def roster_index(doc):
    idx=collections.defaultdict(set);pos={"goleiro":"G","defensor":"D","meio campista":"M","meia":"M","atacante":"F"}
    for club,players in doc.get("elencos",{}).items():
        for p in players:
            i=r4.ident(p.get("id"));n=b.norm(p.get("nome"));q=pos.get(b.norm(p.get("posicao")))
            if i and n and q:idx[(b.club(club),n,q)].add(i)
    return idx
def identity_review(y,rows,clubs,idx):
    names=collections.defaultdict(set);members=collections.defaultdict(set);hits=collections.defaultdict(set);inverse=collections.defaultdict(set)
    for p in rows:
        key=p["player_id"];n=b.norm(p["source_name"]);members[key].add(p["club_id"])
        if n:names[key].add(n)
        if y=="2026" and n:
            for i in idx.get((b.club(clubs.get(p["club_id"],"")),n,p["values"]["position"]),set()):
                eid=f.identity("player","espn",i);hits[key].add(eid);inverse[eid].add(key)
    result=[]
    for key in sorted(members):
        links=sorted(hits[key]);unique=len(links)==1 and len(inverse[links[0]])==1
        result.append({"player_id":key,"normalized_aliases":sorted(names[key]),"club_ids":sorted(members[key]),
          "espn_candidates":links,"mapping_status":"review_unique_name_club_position" if unique else "review_ambiguous" if links else "unmapped",
          "verified_cross_provider_id":None})
    return result
def build(state,ref,roster,observed,root,input_sha,roster_sha):
    if ref.get("input_sha256")!=input_sha or ref.get("source_run_id")!=LOCK["source_run_id"] or ref.get("code_commit")!=LOCK["r4_commit"]:raise ValueError("R4 binding")
    observed=timestamp(observed)
    check,private=r4.audit(state)
    for k in ("seasons","unique_provider_ids","ids_with_multiple_normalized_names","orphan_historical_records"):
        if check[k]!=ref[k]:raise ValueError("R4 accounting")
    if check["orphan_historical_records"]:raise ValueError("orphans")
    years={};ids=set();keys=set();files={};idx=roster_index(roster)
    for y in YEARS:
        rows=[];fixtures=[];pending=[];clubs={};audit=ref["seasons"][y]
        for fid,expected in sorted(state["catalog"][y].items()):
            key=f.identity("fixture",P,fid,y);kick=timestamp(b.get(expected,"fixture","date"))
            if kick>observed:raise ValueError("future fixture")
            game=state["historical"].get(fid,{});valid,detail=r3.assess(game,expected)
            cls=private["fixtures_and_club_coverage"][fid]["class"]
            fixtures.append({"fixture_id":key,"source_id":fid,"kickoff_at":kick,"score":expected.get("goals"),
              "home_id":f.identity("club",P,r4.ident(b.get(expected,"teams","home","id"))),
              "away_id":f.identity("club",P,r4.ident(b.get(expected,"teams","away","id"))),
              "detailed":detail,"player_validation":valid,"timeline_class":cls,"source_published_at":None,"snapshot_observed_by":observed})
            if not detail:
                n=state["attempts"].get(fid,0)
                pending.append({"fixture_id":key,"source_id":fid,"prior_attempts":n,"exhausted":n>=3,"stored_fixture":fid in state["historical"],
                  "recovery_status":"quarantined_exhausted" if n>=3 else "review_endpoint_specific","proposed_endpoint":"/fixtures/players"})
            if not valid:continue
            for g in b.arr(game.get("players")):
                tid=r4.ident(b.get(g,"team","id"));cid=f.identity("club",P,tid);clubs[cid]=b.get(g,"team","name") or clubs.get(cid,"")
                for p in b.arr(g.get("players")):
                    ss=b.arr(p.get("statistics"))
                    if not ss or not active(ss[0]):continue
                    item=row(y,fid,tid,p,ss[0],kick,observed,cls)
                    if item["row_id"] in keys:raise ValueError("duplicate row")
                    keys.add(item["row_id"]);ids.add(item["player_id"]);rows.append(item)
        rows.sort(key=lambda p:p["row_id"]);counts,cv,acc=coverage(rows)
        if len(rows)!=audit["field_counts_by_position"]["all"]["rows"] or len(fixtures)!=audit["counts"]["catalogued"] or len(pending)!=audit["counts"]["r3_unresolved"]:raise ValueError("row accounting")
        for pos,fields in audit["field_counts_by_position"].items():
            if cv.get(pos,{}).get("_rows",{}).get("rows")!=fields["rows"]:raise ValueError("position accounting")
        review=identity_review(y,rows,clubs,idx)
        for asset,data in {"player_matches":envelope(y,rows=rows),"fixtures":envelope(y,rows=fixtures),
          "identity_map":envelope(y,players=review,clubs=clubs,roster_sha256=roster_sha,verified_cross_provider_links=0),
          "coverage":envelope(y,counts=counts,by_position=cv,pass_accuracy_diagnostics=acc),
          "recovery_ledger":envelope(y,pending=pending,automatic_api_calls=0,proposed_initial_sample_max=5,proposed_endpoint_request_cap=15,requires_fresh_quota_and_authorization=True)}.items():
            p=f.private_path(root,REPO,y,asset);write(p,data);files[f.private_key(y,asset)]={"sha256":sha(p),"bytes":p.stat().st_size}
        years[y]={"catalogued":len(fixtures),"detailed":sum(x["detailed"] for x in fixtures),"pending":len(pending),
          "exhausted":sum(x["exhausted"] for x in pending),"r4_candidates":audit["counts"]["r4_candidates"],"counts":counts,
          "identity_review":dict(collections.Counter(p["mapping_status"] for p in review)),"field_counts_by_position":cv,"pass_accuracy_diagnostics":acc}
    totals={k:sum(x[k] for x in years.values()) for k in ("catalogued","detailed","pending","exhausted","r4_candidates")};totals["rows"]=len(keys)
    if totals!=LOCK["expected"]:raise ValueError("locked snapshot totals")
    manifest={"schema":1,"version":VERSION,"competition":f.COMP,"source_run_id":LOCK["source_run_id"],"r4_run_id":LOCK["r4_run_id"],
      "input_sha256":input_sha,"roster_sha256":roster_sha,"snapshot_observed_by":observed,"code_commit":os.getenv("GITHUB_SHA","local"),
      "files":files,"totals":totals,"raw_data_publication_allowed":False,"rapm_required":False,"rapm_trained":False,
      "semantic_certified":False,"cross_provider_mapping_certified":False,"production_ready":False,
      "source_paths":{k:list(v) for k,v in PATHS.items()},"starter_raw_is_substitute":True}
    write(root/"manifest.json",manifest)
    return {"manifest_sha256":sha(root/"manifest.json"),"version":VERSION,"totals":totals,"source_run_id":LOCK["source_run_id"],
      "r4_run_id":LOCK["r4_run_id"],"input_sha256":input_sha,"code_commit":manifest["code_commit"],"unique_active_provider_ids":len(ids),
      "by_season":years,"api_requests":0,"checkpoint_modified":False,"rapm_trained":False,"rapm_required":False,
      "semantic_certified":False,"cross_provider_mapping_certified":False,"production_ready":False}
def main():
    p=argparse.ArgumentParser()
    for k in ("state","r4-report","roster","output","report"):p.add_argument("--"+k,type=Path,required=True)
    p.add_argument("--observed-by",required=True);a=p.parse_args()
    try:
        os.umask(0o077);out=a.output.resolve();rep=a.report.resolve();source=a.state.resolve()
        if a.output.is_symlink() or out.exists() or rep.exists() or not source.is_file() or REPO in out.parents or out in REPO.parents or out==REPO or REPO in rep.parents or rep==REPO:raise ValueError("unsafe workspace")
        before=sha(source);out.mkdir(mode=0o700,parents=True)
        result=build(r2.load(source),json.loads(a.r4_report.read_text()),json.loads(a.roster.read_text()),a.observed_by,out,before,sha(a.roster))
        if sha(source)!=before:raise ValueError("checkpoint changed")
        write(rep,result)
        for y,s in result["by_season"].items():print(y,"catalogued",s["catalogued"],"detailed",s["detailed"],"rows",s["counts"]["rows"],"exploratory",s["counts"]["af_player_exploratory_candidate"],"pending",s["pending"],"exhausted",s["exhausted"],"identity_review",json.dumps(s["identity_review"],sort_keys=True))
        print("TOTAL:",json.dumps(result["totals"],sort_keys=True))
        print("PASS: source hash, R4 accounting, private namespace, provenance. No API, no RAPM, semantic certification pending.")
        return 0
    except Exception as exc:
        print("BLOCKED: canonical validation failed; exception type="+type(exc).__name__)
        return 2
if __name__=="__main__":sys.exit(main())
