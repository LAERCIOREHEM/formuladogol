"""SL02 permanent, presentation-only deployment contract.

stage: operate on an already validated, freshly built public tree.
smoke: read the actual public presentation bytes after an authorized deployment.
No provider requests, sports writes, SMTP, Cloudflare calls or deployment actions.
"""
from __future__ import annotations
import argparse,hashlib,json,os,time
from pathlib import Path
from urllib.request import Request,urlopen
from bs4 import BeautifulSoup
from overlay import apply,snapshot,sha
ROOT=Path(__file__).resolve().parent
MODE=ROOT/"release-mode.json"
HOST="https://formuladogol.com.br"
FRONTEND=("estatisticas.html","estatisticas-completas.html","sl02/app.js","sl02/design.css","sl02/shell.js","sl02/shell.css","sl02/history-slim.json","sl02/match-summary.json","agenda.html","index.html","aovivo.html","manifest.webmanifest","sw.js")
def readj(p):return json.loads(p.read_text(encoding="utf-8"))
def mode():
    v=readj(MODE)
    assert set(v)=={"schema","mode","season"} and v["schema"]==1 and v["season"]==2026
    assert v["mode"] in ("legacy","sl02")
    return v["mode"]
def verify(site,active):
    assert (site/"CNAME").read_text().strip()=="formuladogol.com.br"
    assert "Sitemap: https://formuladogol.com.br/sitemap.xml" in (site/"robots.txt").read_text()
    manifest=readj(site/"dados-br/fdg-data-pulse.json")
    assert all(sha(site/p)==v["sha256"] for p,v in manifest["files"].items()),"Data Pulse byte mismatch"
    af=readj(site/"dados-br/af-core-manifest.json")
    prob=readj(site/"dados-br/probabilidades-brasileirao.json")
    results=readj(site/"resultados.json")["resultados"]
    assert prob["temporada"]==2026 and "1.3" in prob["versao_modelo"]
    assert af["concluidos"]==len(results) and af["concluidos"]+af["restantes"]==380
    assert af["hash_entrada"]==prob["hash_entrada"] and af["calculado_em"]==prob["calculado_em"]
    assert prob["simulacao"]["quantidade"]==2000000
    pwa=readj(site/"manifest.webmanifest")
    assert pwa["id"]=="/" and pwa["scope"]=="/" and pwa["start_url"]=="/?source=pwa"
    assert (site/"sl02").is_dir()==active
    stats=BeautifulSoup((site/"estatisticas.html").read_text(encoding="utf-8"),"html.parser")
    assert stats.select_one('link[rel=canonical]')["href"]==HOST+"/estatisticas.html"
    assert stats.select_one('link[rel=manifest]')
    assert "br-pwa.js?v=20260923-pwa-home-install-v5" in str(stats)
    assert not any("noindex" in x.get("content","").lower() for x in stats.select('meta[name=robots]'))
    assert stats.select('script[type="application/ld+json"]')
    if active:
        assert len(stats.select("[data-fdg-shell]"))==1
        assert len(stats.select("#fdg-main tbody tr"))==20
        assert stats.select_one('script[src^="/sl02/app.js"]')
        for f in ("br-af-core-snapshot.js","br-data-manifest.js","br-data-refresh.js","br-data-pulse.js","br-pwa.js","br-push.js"):
            assert stats.select_one('script[src*="'+f+'"]'),f
        full=BeautifulSoup((site/"estatisticas-completas.html").read_text(encoding="utf-8"),"html.parser")
        assert full.select_one('link[rel=canonical]')["href"]==HOST+"/estatisticas.html"
        assert "noindex" in full.select_one('meta[name=robots]')["content"]
        for marker in ("br-classificacao-live.js?v=20260920-monitor-facts-v7","br-estatisticas.js?v=20261124-r36r6final","br-data-pulse.js?v=20261124-r36r6final","fdg-ux-stats"):
            assert marker in str(full),marker
        assert all((site/f).is_file() for f in FRONTEND)
        assert readj(site/"sl02/history-slim.json")["source_sha256"]==sha(site/"dados-br/historico-probabilidades.json")
        assert readj(site/"sl02/match-summary.json")["source_sha256"]==sha(site/"dados-br/jogos-detalhes.json")
        assert all((site/f).is_file() for f in ("copa2026/index.html","museu.html","jogos/index.html","resultados/index.html","tabela/index.html","alertas.html"))
    else:
        assert not (site/"estatisticas-completas.html").exists()
        assert "br-estatisticas.js?v=20261124-r36r6final" in str(stats)
    print("SL02 artifact contract PASS", "sl02" if active else "legacy", af["concluidos"],"FINALs", len(manifest["files"]),"manifest entries",flush=True)
def stage(site,backup,selected):
    if selected=="sl02":
        ledger=apply(site,backup)
        assert ledger["protected_count"]>0 and ledger["publication"] is False
    else:
        assert not backup.exists()
    verify(site,selected=="sl02")
def smoke(site):
    active=(site/"sl02/app.js").is_file()
    verify(site,active)
    paths=FRONTEND if active else ("estatisticas.html","index.html","aovivo.html","manifest.webmanifest","sw.js")
    for path in paths:
        expected=sha(site/path)
        last=""
        for attempt in range(4):
            try:
                req=Request(HOST+"/"+path+"?sl02_verify="+expected[:16],headers={"Cache-Control":"no-cache","User-Agent":"FDG-SL02-Public-Smoke/1.0"})
                with urlopen(req,timeout=20) as r:
                    actual=hashlib.sha256(r.read()).hexdigest()
                if actual==expected:break
                last="hash mismatch"
            except Exception as e:last=str(e)
            if attempt<3:time.sleep(5*(attempt+1))
        else:raise RuntimeError("SL02 public frontend hash failed: "+path+" "+last)
        print("SL02 public SHA-256 PASS",path,expected,flush=True)
    print("SL02 public presentation verified", "sl02" if active else "legacy",flush=True)
def main():
    p=argparse.ArgumentParser()
    p.add_argument("action",choices=("stage","verify","smoke"))
    p.add_argument("--site-root",type=Path,required=True)
    p.add_argument("--backup",type=Path)
    p.add_argument("--mode",choices=("legacy","sl02"),help="CI-only override, cannot enable production")
    a=p.parse_args()
    if a.mode is not None and (os.getenv("GITHUB_EVENT_NAME")!="pull_request" or a.action!="stage"):
        raise SystemExit("Mode override restricted to isolated PR staging")
    if a.action=="stage":
        assert a.backup is not None
        stage(a.site_root,a.backup,a.mode or mode())
    elif a.action=="verify":verify(a.site_root,(a.site_root/"sl02/app.js").is_file())
    else:smoke(a.site_root)
if __name__=="__main__":main()
