"""Verify original GitHub ZIP bytes, run status and exact provenance. No old runs rerun."""
import argparse,hashlib,json,os,subprocess,zipfile
from pathlib import Path,PurePosixPath
HERE=Path(__file__).resolve().parent
LOCK=json.loads((HERE/"source-lock.json").read_text())
def gh(path):return subprocess.check_output(["gh","api",path],timeout=120)
def check(work):
    repo=os.environ["GITHUB_REPOSITORY"]
    if repo!="LAERCIOREHEM/formuladogol":raise ValueError("repository")
    results=[]
    for x in LOCK["runs"]:
        d=json.loads(gh(f"repos/{repo}/actions/runs/{x['id']}"))
        assert d["head_repository"]["full_name"]==repo and d["head_branch"]=="main" and d["head_sha"]==x["commit"] and d["status"]=="completed" and d["conclusion"]=="success" and d["path"]==x["path"]
        jobs=json.loads(gh(f"repos/{repo}/actions/runs/{x['id']}/jobs?per_page=100"))
        assert jobs["total_count"]==len(jobs["jobs"]) and all(j["status"]=="completed" and j["conclusion"] in ("success","skipped") for j in jobs["jobs"]) and any(j["conclusion"]=="success" for j in jobs["jobs"])
        results.append({"stage":x["stage"],"run":x["id"],"commit":x["commit"],"jobs_success":sum(j["conclusion"]=="success" for j in jobs["jobs"])})
    ars=[]
    for a in LOCK["artifacts"]:
        meta=json.loads(gh(f"repos/{repo}/actions/artifacts/{a['id']}"))
        assert meta["name"]==a["name"] and meta["expired"] is False and meta["digest"]=="sha256:"+a["sha256"] and meta["workflow_run"]["id"]==a["run"]
        assert 0<meta["size_in_bytes"]<=100_000_000
        blob=gh(f"repos/{repo}/actions/artifacts/{a['id']}/zip")
        assert len(blob)==meta["size_in_bytes"] and hashlib.sha256(blob).hexdigest()==a["sha256"]
        path=work/(str(a["id"])+".zip");path.write_bytes(blob)
        with zipfile.ZipFile(path) as z:
            infos=z.infolist();names=z.namelist()
            assert len(names)==len(set(names)) and 0<len(names)<=1000 and sum(i.file_size for i in infos)<=200_000_000
            assert all(not PurePosixPath(n).is_absolute() and ".." not in PurePosixPath(n).parts and "\\" not in n for n in names)
            assert z.testzip() is None
            if "member" in a:
                m=a["member"];assert names==[m] and 0<z.getinfo(m).file_size<=100_000_000
                with (work/m).open("xb") as f:f.write(z.read(m))
        ars.append({"id":a["id"],"stage":a["stage"],"run":a["run"],"sha256":a["sha256"],"bytes":len(blob),"expires_at":meta["expires_at"]})
    out={"runs":results,"archives":ars}
    (work/"chain.json").write_text(json.dumps(out,sort_keys=True)+"\n")
    print("PASS: verified",len(results),"historical runs and",len(ars),"original artifact ZIP digests")
if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("work",type=Path);check(p.parse_args().work)
