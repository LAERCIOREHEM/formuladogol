import argparse,hashlib,json,os,subprocess
from pathlib import Path
from governance import ROOT,HERE,P,raw
def read(p):return json.loads(p.read_bytes())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
    p=argparse.ArgumentParser()
    for k in ("e10-report","e10-private","e09-report","e09-private","output","report"):p.add_argument("--"+k,type=Path,required=True)
    a=p.parse_args();lock=read(HERE/"source-lock.json");paths=(a.e10_report,a.e10_private,a.e09_report,a.e09_private);r,d,q,z=map(read,paths);hashes=[sha(p) for p in paths]
    assert r["code_commit"]==lock["e10_commit"] and q["code_commit"]==lock["e09_commit"] and r["private_sha256"]==hashes[1] and q["private_sha256"]==hashes[3]
    assert d["e08_decision"]==z["e08_decision"]==r["e08_decision"] and not d["e08_decision"]["pass"] and not d["e08_decision"]["promotion"]
    assert not any(r[k] for k in ("production_ready","public_switch","lineup_enabled")) and not any(q[k] for k in ("production_ready","live_adapter_enabled","prospective_started","lineup_enabled"))
    assert r["browser"]["passed"]==43 and r["build"]["deployment_paths_unchanged"]
    changed=subprocess.check_output(["git","diff","--name-only",lock["e10_commit"],"HEAD"],cwd=ROOT,text=True).splitlines()
    assert changed and all(x.startswith("research/fdg2027/e11/") or x==".github/workflows/fdg2027-e11-governance.yml" for x in changed)
    files=["cloudflare/push-worker/src/cost-shield.js","cloudflare/push-worker/src/cloudflare-billing-audit.js","cloudflare/push-worker/src/workers-graphql-reconciliation.js","cloudflare/push-worker/src/health-monitor.js","cloudflare/push-worker/src/api-football-source.js","cloudflare/orchestrator-worker/src/cost-shield-client.js","docs/CF-COST-SHIELD-R2.md","research/fdg2027/e02/historical_r3.py"]
    audit={k:sha(ROOT/k) for k in files}
    for k in files:
        before=subprocess.check_output(["git","show",lock["e10_commit"]+":"+k],cwd=ROOT)
        assert hashlib.sha256(before).hexdigest()==audit[k]
    shield=(ROOT/files[0]).read_text();assert "essentialSportsAllowed:true" in shield and "dailyPauseOptionalUsd: 5" in shield and "dailyPauseSecondaryUsd: 10" in shield
    assert hashes==[sha(p) for p in paths]
    rep={"version":"E11.1","code_commit":os.getenv("GITHUB_SHA","local"),"source_e10_commit":lock["e10_commit"],"source_e09_commit":lock["e09_commit"],"audit_sha256":audit,"changed_paths":len(changed),"policy":P,"e08_decision":r["e08_decision"],"api_requests":0,"cloudflare_requests":0,"production_ready":False,"public_switch":False,"lineup_enabled":False,"live_adapter_enabled":False,"account_quota_verified":False,"actual_billing_usd":None,"report_delivery_enabled":False}
    a.output.write_bytes(raw({**rep,"source_hashes":hashes})+b"\n");rep["private_sha256"]=sha(a.output);a.report.write_bytes(raw(rep)+b"\n");print("E11 AGGREGATE",json.dumps(rep,sort_keys=True))
if __name__=="__main__":main()
