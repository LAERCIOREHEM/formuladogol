import argparse,json,hashlib,os
from pathlib import Path
HERE=Path(__file__).resolve().parent
def read(p):return json.loads(p.read_bytes())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
    p=argparse.ArgumentParser()
    for k in ("certification","e09-report","backtest","e08-report","build-report","browser-report","output","report"):p.add_argument("--"+k,type=Path,required=True)
    a=p.parse_args();lock=read(HERE/"source-lock.json")
    d,r,x,y,b,ui=map(read,(a.certification,a.e09_report,a.backtest,a.e08_report,a.build_report,a.browser_report))
    assert r["code_commit"]==lock["e09_commit"] and y["code_commit"]==lock["e08_commit"]
    assert r["private_sha256"]==sha(a.certification) and y["private_sha256"]==sha(a.backtest)
    assert d["e08_decision"]==x["decision"]==y["decision"] and not x["decision"]["pass"] and not x["decision"]["promotion"]
    assert not any(d[k] for k in ("production_ready","lineup_enabled","live_adapter_enabled","prospective_started"))
    assert d["protocol_sha256"]==y["protocol_sha256"] and b["deployment_paths_unchanged"] and not b["public_switch"] and ui["passed"]>=37
    result={"version":"E10.1","code_commit":os.getenv("GITHUB_SHA","local"),"build":b,"browser":ui,"e08_decision":y["decision"],"source_e09_commit":lock["e09_commit"],"source_e08_commit":lock["e08_commit"],"production_ready":False,"public_switch":False,"lineup_enabled":False,"api_requests":0}
    a.output.write_text(json.dumps({**result,"private_source_hashes":[sha(a.certification),sha(a.backtest)]},sort_keys=True)+"\n")
    result["private_sha256"]=sha(a.output);a.report.write_text(json.dumps(result,sort_keys=True)+"\n");print("E10 AGGREGATE",json.dumps(result,sort_keys=True))
if __name__=="__main__":main()
