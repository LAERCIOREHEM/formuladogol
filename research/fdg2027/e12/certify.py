"""Final evidence package. Block promotion honestly even when software CI succeeds."""
import argparse,hashlib,json,os,subprocess
from pathlib import Path
from certification import ROOT,HERE,raw,sha,jsonfile,decide,repository_core,rollback_drill,GATES,CURRENT
def main():
    p=argparse.ArgumentParser();p.add_argument("work",type=Path);p.add_argument("output",type=Path);p.add_argument("report",type=Path);a=p.parse_args()
    w=a.work;lock=jsonfile(HERE/"source-lock.json");chain=jsonfile(w/"chain.json");live=jsonfile(w/"public.json")
    assert len(chain["runs"])==len(lock["runs"])==12 and len(chain["archives"])==len(lock["artifacts"])==24
    for l,c in zip(lock["artifacts"],chain["archives"]):
        assert (l["id"],l["sha256"])==(c["id"],c["sha256"])
    reports={s:jsonfile(w/(s+"-report.json")) for s in ("e08","e09","e10","e11")}
    for stage,r in reports.items():
        d=(w/(stage+"-private.json")).read_bytes()
        assert r["private_sha256"]==sha(d) and r["code_commit"]==next(x["commit"] for x in lock["runs"] if x["stage"].lower()==stage)
        assert r["production_ready"] is False and r["lineup_enabled"] is False
    e08=reports["e08"];e09=reports["e09"];e10=reports["e10"];e11=reports["e11"]
    assert e08["decision"]==e09["e08_decision"]==e10["e08_decision"]==e11["e08_decision"]
    assert e08["decision"]["pass"] is False and e08["decision"]["promotion"] is False
    assert e08["paired"]==740 and e09["real_enrollments"]==0 and not e09["prospective_started"] and not e09["live_adapter_enabled"]
    assert e10["browser"]["passed"]==43 and not e10["public_switch"] and not e11["public_switch"]
    assert e11["account_quota_verified"] is False and e11["actual_billing_usd"] is None and not e11["report_delivery_enabled"]
    for path,digest in e11["audit_sha256"].items():
        assert sha((ROOT/path).read_bytes())==digest
    # E12 commit is purely additive, based on the current main (not old E11).
    diff=subprocess.check_output(["git","diff","--name-status",lock["base"],"HEAD"],cwd=ROOT,text=True).splitlines()
    assert diff and all(line.startswith("A\t") and (line.split("\t")[1].startswith("research/fdg2027/e12/") or line.split("\t")[1]==".github/workflows/fdg2027-e12-certification.yml") for line in diff),diff
    assert all("research/" not in (ROOT/".github/workflows"/p).read_text() for p in ("deploy.yml","deploy-push-worker.yml","deploy-orchestrator-worker.yml"))
    core=repository_core()
    evidence=dict.fromkeys(GATES,False)
    # These are deliberately negative/unverified, not assertions that providers failed.
    decision=decide(evidence);assert not decision["production_ready"] and len(decision["blocked"])==len(GATES)
    result={"version":"E12.1","code_commit":os.getenv("GITHUB_SHA","local"),"base_commit":lock["base"],"historical_runs_verified":len(chain["runs"]),"historical_artifacts_verified":len(chain["archives"]),"historical_artifact_bytes":sum(x["bytes"] for x in chain["archives"]),"chain_sha256":sha((w/"chain.json").read_bytes()),"repository_core":core,"public_readonly":live,"decision":decision,"e08_decision":e08["decision"],"retrospective_pairs":e08["paired"],"real_prospective_pairs":e09["real_enrollments"],"e10_browser_checks":e10["browser"]["passed"],"e11_actual_billing_usd":e11["actual_billing_usd"],"rollback":rollback_drill(),"api_requests":0,"cloudflare_api_requests":0,"deploy":False,"activation":False,"promotion":False,"archive_frozen":False,"production_ready":False,"source_rights_verified":False,"key_rotation_verified":False,"changed_paths":len(diff)}
    a.output.write_bytes(raw({**result,"chain":chain,"source_report_hashes":{s:sha((w/(s+"-report.json")).read_bytes()) for s in reports}})+b"\n")
    result["private_sha256"]=sha(a.output.read_bytes());a.report.write_bytes(raw(result)+b"\n");print("E12 AGGREGATE",json.dumps(result,sort_keys=True))
if __name__=="__main__":main()
