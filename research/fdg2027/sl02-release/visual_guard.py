"""HF1 visual publication exception; never pause live monitoring.

The exception is limited to the exact reviewed HF1 path set, with season and
release mode unchanged. Mixed/data/worker/model changes fail closed. Before
upload, verify the package contains every already-public final score and is
not behind the current main sporting inputs. No external sports API or writes.
"""
import argparse,json,subprocess
from datetime import datetime
from pathlib import Path
from urllib.request import Request,urlopen
ROOT=Path(__file__).resolve().parent
HOST="https://formuladogol.com.br"
PREFIX="research/fdg2027/sl02-release/"
MODE=PREFIX+"release-mode.json"
VISUAL={PREFIX+x for x in ("app.js","design.css","shell.css","shell.js","overlay.py")}
ALLOWED=VISUAL|{PREFIX+x for x in ("HF1.md","HF2.md","R1.md","UX-HF1.md","qa.py","public_browser.py","visual_guard.py")}|{".github/workflows/deploy.yml",".github/workflows/fdg2027-sl02-release.yml"}
def git(*args):return subprocess.check_output(["git",*args],text=True).strip()
def is_visual(paths,before,after):
    return bool(paths&VISUAL) and paths<=ALLOWED and before==after=={"schema":1,"mode":"sl02","season":2026}
def classify(before,after):
    if not before or not after:return False
    try:
        a=json.loads(git("show",before+":"+MODE));b=json.loads(git("show",after+":"+MODE))
        paths=set(git("diff","--name-only",before,after).splitlines())
        return is_visual(paths,a,b)
    except (ValueError,subprocess.CalledProcessError):return False
def final_scores(doc):
    rows=doc["resultados"]
    result={str(x["event_id"]):(x["placar_mandante"],x["placar_visitante"]) for x in rows}
    assert len(rows)==len(result),"Duplicate FINAL ID"
    assert all(all(isinstance(n,int) and n>=0 for n in v) for v in result.values()),"Invalid FINAL score"
    return result
def verify_data(public,local,public_af,local_af):
    old,new=final_scores(public),final_scores(local)
    assert all(k in new and new[k]==v for k,v in old.items()),"Visual deploy would remove or change an already-published FINAL"
    assert len(new)==local_af["concluidos"] and len(old)==public_af["concluidos"]
    assert local_af["concluidos"]+local_af["restantes"]==380
    assert datetime.fromisoformat(local_af["calculado_em"])>=datetime.fromisoformat(public_af["calculado_em"]),"AF snapshot older than public"
    return len(new)
def read_public(path):
    req=Request(HOST+path+"?hf1_visual_guard=1",headers={"Cache-Control":"no-cache","User-Agent":"FDG-HF1-VisualGuard/1.0"})
    with urlopen(req,timeout=20) as r:return json.load(r)
def preupload(site):
    # The normal Pages workflow serializes all publications. If the sporting
    # source changes while this visual package builds, fail closed; the normal
    # queued data-triggered deploy will assemble the latest main.
    subprocess.run(["git","fetch","--no-tags","origin","main"],check=True)
    changed=git("diff","--name-only","HEAD","FETCH_HEAD","--","jogos.json","resultados.json","tabela.json","espn_eventos.json","transmissoes.json","dados-br","analises")
    assert not changed,"New sporting source while building; use queued current-main deploy: "+changed[:500]
    local=lambda p:json.loads((site/p).read_text(encoding="utf-8"))
    n=verify_data(read_public("/resultados.json"),local("resultados.json"),read_public("/dados-br/af-core-manifest.json"),local("dados-br/af-core-manifest.json"))
    print("HF1 VISUAL GUARD PASS:",n,"FINALs retained; current-main source verified; monitoring unchanged",flush=True)
def selftest():
    mode={"schema":1,"mode":"sl02","season":2026}
    paths={PREFIX+"app.js",PREFIX+"visual_guard.py",".github/workflows/deploy.yml"}
    assert is_visual(paths,mode,mode)
    assert is_visual(paths|{PREFIX+"R1.md",PREFIX+"public_browser.py",PREFIX+"qa.py",".github/workflows/fdg2027-sl02-release.yml"},mode,mode)
    for x in ("resultados.json","dados-br/probabilidades-brasileirao.json","cloudflare/push-worker/src/index.js",MODE,"sw.js"):
        assert not is_visual(paths|{x},mode,mode)
    assert not is_visual(paths,dict(mode,mode="legacy"),mode)
    assert not is_visual({".github/workflows/deploy.yml"},mode,mode)
    def results(n):return {"resultados":[{"event_id":str(i),"placar_mandante":1,"placar_visitante":0} for i in range(n)]}
    def af(n):return {"concluidos":n,"restantes":380-n,"calculado_em":"2026-11-26T18:00:00-03:00"}
    assert verify_data(results(2),results(3),af(2),af(3))==3
    for new in (results(1),{"resultados":[{"event_id":"0","placar_mandante":0,"placar_visitante":0},results(2)["resultados"][1]]}):
        try:verify_data(results(2),new,af(2),af(len(new["resultados"])))
        except AssertionError:pass
        else:raise AssertionError("Sporting regression was accepted")
    print("HF1 VISUAL GUARD FIXTURES PASS: allowlist, mixed changes, season, activation, missing/altered FINAL")
if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("action",choices=("classify","preupload","self-test"));p.add_argument("--before",default="");p.add_argument("--after",default="");p.add_argument("--site-root",type=Path)
    a=p.parse_args()
    if a.action=="classify":print("true" if classify(a.before,a.after) else "false")
    elif a.action=="self-test":selftest()
    else:preupload(a.site_root)
