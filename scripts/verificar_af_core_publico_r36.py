#!/usr/bin/env python3
"""Measure actual public branch delivery without treating a commit as CDN delivery."""
import json
import os
import sys
import time
from datetime import datetime,timezone
from pathlib import Path
from urllib.request import Request,urlopen

def parse(s):
    return datetime.fromisoformat(s.replace("Z","+00:00"))
def main():
    expected=json.loads(Path("dados-br/af-core-manifest.json").read_text())
    repo=os.environ.get("GITHUB_REPOSITORY","LAERCIOREHEM/formuladogol")
    sha=os.environ.get("FDG_CORE_COMMIT","")
    commit_at=os.environ.get("FDG_CORE_COMMIT_AT","")
    base=f"https://raw.githubusercontent.com/{repo}/main/dados-br/"
    verified=None
    error=""
    for attempt in range(3):
        try:
            def fetch(name):
                url=base+name+"?revision="+expected["revision"]
                with urlopen(Request(url,headers={"Cache-Control":"no-cache","User-Agent":"FDG-R36-R4/1.0"}),timeout=5) as response:
                    return json.load(response)
            live=fetch("af-core-manifest.json")
            if live["revision"]!=expected["revision"]:
                raise RuntimeError("manifesto público ainda não representa a revisão")
            bundle=fetch("af-core-snapshot.json")
            if bundle.get("manifest")!=live:
                raise RuntimeError("manifesto/bundle de revisões diferentes")
            p=bundle["files"]["dados-br/probabilidades-brasileirao.json"]
            if p["hash_entrada"]!=live["hash_entrada"] or p["calculado_em"]!=live["calculado_em"]:
                raise RuntimeError("AF público divergente")
            verified=datetime.now(timezone.utc).isoformat()
            break
        except Exception as e:
            error=str(e)
            if attempt<2: time.sleep(2)
    final=json.loads(Path("resultados.json").read_text())["resultados"]
    last=max((x["finalizado_em"] for x in final if x.get("finalizado_em")),default=None)
    def minutes(a,b):
        return round((parse(b)-parse(a)).total_seconds()/60,3) if a and b else None
    report={"schema_version":1,"revision":expected["revision"],"commit":sha,
            "final_mais_recente_estimado":last,"af_calculado_em":expected["calculado_em"],
            "commit_at":commit_at,"public_verified_at":verified,
            "final_to_af_minutes":minutes(last,expected["calculado_em"]),
            "commit_to_public_minutes":minutes(commit_at,verified),
            "final_to_public_minutes":minutes(last,verified),
            "status":"verified" if verified else "not_verified",
            "error":"" if verified else error}
    p=Path("artifacts/reliability/af-core-publicacao.json")
    p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
    print(json.dumps(report,ensure_ascii=False))
    return 0 if verified else 1
if __name__=="__main__":sys.exit(main())
