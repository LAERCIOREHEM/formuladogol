"""Rebuild updated private ranking from a pinned incremental E02 checkpoint, without new API calls."""
import collections as C,hashlib,json,os,shutil,subprocess,sys,zipfile
from pathlib import Path
import build as b
import recover
e=b.e
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
LOCK=b.load(HERE/"incremental-lock.json")
sys.path.insert(0,str(HERE.parent/"e03"))
import canonical as c
def download(w):
    recover.main(w)
    a=LOCK;r=json.loads(recover.gh(f"repos/{recover.REPO}/actions/runs/{a['run']}"))
    assert r["head_repository"]["full_name"]==recover.REPO and r["head_branch"]=="main" and r["event"]=="workflow_dispatch" and r["status"]=="completed" and r["conclusion"]=="success" and r["head_sha"]==a["commit"] and r["path"]==a["workflow"] and r["updated_at"]==a["observed"]
    m=json.loads(recover.gh(f"repos/{recover.REPO}/actions/artifacts/{a['artifact']}"))
    assert m["name"]==a["name"] and not m["expired"] and m["workflow_run"]["id"]==a["run"] and m["digest"]=="sha256:"+a["sha256"]
    raw=recover.gh(f"repos/{recover.REPO}/actions/artifacts/{a['artifact']}/zip")
    assert hashlib.sha256(raw).hexdigest()==a["sha256"]
    z=w/"inc.zip";z.write_bytes(raw)
    with zipfile.ZipFile(z) as f:
        assert f.namelist()==["state.json.gpg"] and 0<f.getinfo("state.json.gpg").file_size<100_000_000
        (w/"incremental-state.json.gpg").write_bytes(f.read("state.json.gpg"))
    z.unlink()
    print("AFP incremental: original E03/E04 and new checkpoint ZIP hashes verified")
def preservation(old,new):
    totals={"old_fixtures_preserved":0,"old_rows_preserved":0}
    for y in c.YEARS:
        def load_rows(root,name):return b.load(root/f"fdg2027/bra.1/{y}/{name}.json")["rows"]
        original={r["fixture_id"]:r for r in load_rows(old,"fixtures")}
        updated={r["fixture_id"]:r for r in load_rows(new,"fixtures")}
        assert set(original)<=set(updated)
        for k,r in original.items():
            s=updated[k]
            assert all(r[k2]==s[k2] for k2 in ("fixture_id","kickoff_at","score","home_id","away_id"))
            assert not r["detailed"] or s["detailed"]
        totals["old_fixtures_preserved"]+=len(original)
        if y!="2026":assert set(original)==set(updated)
        orig={r["row_id"]:r for r in load_rows(old,"player_matches")}
        newr={r["row_id"]:r for r in load_rows(new,"player_matches")}
        assert set(orig)<=set(newr)
        for k,r in orig.items():
            s=newr[k]
            assert all(r[k2]==s[k2] for k2 in ("fixture_id","player_id","club_id","source_name","values","quality","raw","raw_present","individual_core_valid"))
        totals["old_rows_preserved"]+=len(orig)
        if y!="2026":assert set(orig)==set(newr)
    return totals
def run(w,out):
    # Exact original reproduction first. Its files remain private and unmodified.
    b.build(w,w/"original-preview")
    original_report=b.load(w/"afp-report.json")
    original_artifact=b.load(w/"af-player.json")
    state_path=w/"incremental-state.json";state=c.r2.load(state_path);digest=c.sha(state_path)
    audit,_=c.r4.audit(state)
    audit.update(source_run_id=LOCK["run"],input_sha256=digest,code_commit=os.environ["GITHUB_SHA"])
    counts={y:x["counts"] for y,x in audit["seasons"].items()}
    totals={"catalogued":sum(v["catalogued"] for v in counts.values()),"detailed":sum(v["r3_detailed"] for v in counts.values()),"pending":sum(v["r3_unresolved"] for v in counts.values()),"exhausted":sum(v["r3_exhausted"] for v in counts.values()),"r4_candidates":sum(v["r4_candidates"] for v in counts.values()),"rows":sum(x["field_counts_by_position"]["all"]["rows"] for x in audit["seasons"].values())}
    assert totals["catalogued"]==LOCK["expected_catalogued"] and totals["detailed"]==LOCK["expected_detailed"] and counts["2026"]["catalogued"]==LOCK["expected_current_catalogued"] and counts["2026"]["r3_detailed"]==LOCK["expected_current_detailed"]
    assert totals["rows"]>=original_report["input_rows"]
    # Local, ephemeral lock override only; the immutable E03/E04 code and repo locks stay intact.
    c.LOCK={**c.LOCK,"source_run_id":LOCK["run"],"r4_run_id":LOCK["run"],"r4_commit":os.environ["GITHUB_SHA"],"expected":totals}
    rp=ROOT/"dados-br/elencos.json";roster=b.load(rp)
    new=w/"incremental-canonical";new.mkdir(mode=0o700)
    report=c.build(state,audit,roster,LOCK["observed"],new,digest,c.sha(rp))
    assert c.sha(state_path)==digest
    preserved=preservation(w/"canonical",new)
    assert preserved=={"old_fixtures_preserved":1880,"old_rows_preserved":56150}
    old_lock=e.LOCK
    try:
        e.LOCK={**old_lock,"source_commit":report["code_commit"],"rows":totals["rows"],"fixtures":totals["catalogued"]}
        man,fixtures,rows=e.input_data(new,report)
    finally:e.LOCK=old_lock
    prepared=e.prepare(fixtures,rows)
    observed=e.stamp(man["snapshot_observed_by"]);seasons={};summary={};idx=b.roster_index(roster)
    for y in e.YEARS:
        d=b.load(new/f"fdg2027/bra.1/{y}/identity_map.json")
        identities={r["player_id"]:r for r in d["players"]}
        cut=min(observed,e.stamp(f"{y+1}-01-08T00:00:00+00:00"))
        models=original_artifact["folds"].get(str(y),{}).get("models")
        ranking,_=b.cohort(y,prepared,models,cut,d["clubs"],identities,idx)
        duplicate=C.Counter((b.norm(r["name"]),b.norm(r["club"]),r["position"]) for r in ranking)
        for r in ranking:
            if duplicate[(b.norm(r["name"]),b.norm(r["club"]),r["position"])]>1:r.update(eligible=False,status="ambiguous_display_identity",percentile=None,position_rank=None)
        ranking=b.percentiles(ranking)
        games=[g for g in fixtures if g["year"]==y]
        coverage={"catalogued":len(games),"detailed":sum(bool(g["detailed"]) for g in games),"last_fixture_at":max(g["kickoff_at"] for g in games)}
        seasons[str(y)]={"as_of":e.iso(cut),"coverage":coverage,"calibrated":bool(models),"rows":ranking}
        summary[str(y)]={**coverage,"observed_players":len(ranking),"ranked_candidates":sum(r["eligible"] for r in ranking),"by_position":{p:{"observed":sum(r["position"]==p for r in ranking),"eligible":sum(r["position"]==p and r["eligible"] for r in ranking)} for p in e.FIELDS},"identity_review":dict(C.Counter(r["identity_review"] for r in ranking))}
    # No cross-season recalibration: the two new games are 2026, frozen E04 models unchanged.
    old=b.load(w/"original-preview/ranking.json")
    for y in ("2022","2023","2024","2025"):
        assert old["seasons"][y]==seasons[y],"historical ranking changed"
    out.mkdir(mode=0o700)
    b.save(out/"ranking.json",{"version":b.POL["version"],"publication":"PRIVATE_RESEARCH","as_of":e.iso(observed),"policy":{k:b.POL[k] for k in ("min_season_minutes","min_confidence","active_observation_days")},"seasons":seasons})
    for name in ("index.html","app.js","style.css"):shutil.copyfile(HERE/name,out/name)
    result={"version":"AFP-R1.1-incremental","source_run":LOCK["run"],"source_sha256":digest,"canonical_manifest_sha256":report["manifest_sha256"],"original_e04_profiles_reproduced":original_report["e04_profiles_reproduced"],"preservation":preserved,"totals":totals,"core_rows":len(prepared),"seasons":summary,"historical_rankings_unchanged":True,"frozen_calibration":True,"api_requests_in_rebuild":0,"publication":"BLOCKED","availability_lag_days":7,"gates":original_report["gates"],"limitations":original_report["limitations"][:-1]+["2026 updated checkpoint; rating retains seven-day simulated lag"]}
    b.save(w/"afp-incremental-report.json",result)
    print("AFP INCREMENTAL AGGREGATE:",json.dumps(result,ensure_ascii=False,sort_keys=True))
if __name__=="__main__":
    os.umask(0o077)
    mode=sys.argv[1];w=Path(sys.argv[2]).resolve()
    if ROOT in w.parents or w==ROOT:raise SystemExit("private workspace required")
    try:
        if mode=="download":download(w)
        elif mode=="build":run(w,Path(sys.argv[3]).resolve())
        else:raise ValueError("mode")
    except Exception as exc:
        print("AFP incremental BLOCKED:",type(exc).__name__)
        sys.exit(2)
