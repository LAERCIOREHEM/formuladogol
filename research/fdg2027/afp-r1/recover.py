"""Download and verify pinned research artifacts. Never print or publish source records."""
import hashlib,json,subprocess,sys,zipfile
from pathlib import Path
HERE=Path(__file__).resolve().parent
REPO="LAERCIOREHEM/formuladogol"
def gh(path):return subprocess.check_output(["gh","api",path])
def main(w):
    for a in json.loads((HERE/"source-lock.json").read_text())["artifacts"]:
        r=json.loads(gh(f"repos/{REPO}/actions/runs/{a['run']}"))
        assert r["head_repository"]["full_name"]==REPO and r["head_branch"]=="main" and r["head_sha"]==a["commit"] and r["status"]=="completed" and r["conclusion"]=="success" and r["path"]==a["path"]
        m=json.loads(gh(f"repos/{REPO}/actions/artifacts/{a['id']}"))
        assert m["name"]==a["name"] and not m["expired"] and m["workflow_run"]["id"]==a["run"] and m["digest"]=="sha256:"+a["sha256"]
        z=w/(a["label"]+".zip");z.write_bytes(gh(f"repos/{REPO}/actions/artifacts/{a['id']}/zip"))
        assert hashlib.sha256(z.read_bytes()).hexdigest()==a["sha256"]
        with zipfile.ZipFile(z) as f:
            assert f.namelist()==[a["member"]] and 0<f.getinfo(a["member"]).file_size<100_000_000
            (w/a["member"]).write_bytes(f.read(a["member"]))
        z.unlink()
    print("AFP: four exact archive hashes verified")
if __name__=="__main__":main(Path(sys.argv[1]))
