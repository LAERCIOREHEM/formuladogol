"""Incremental release overlay; apply AFTER the original public generators.

No data file is edited; original JS/PWA/SEO assets remain in place. All original
pages keep their runtime; only estatisticas.html uses the approved SL02 app,
with the complete original operational statistics at a noindex canonical alias.
Rollback restores only frontend paths, never data or an old commit.
"""
from __future__ import annotations
import hashlib,json,re,shutil,sys
from pathlib import Path
from bs4 import BeautifulSoup
SRC=Path(__file__).resolve().parent
ROOT=SRC.parents[2]
def sha(p):
    with p.open("rb") as f:return hashlib.file_digest(f,"sha256").hexdigest()
def snapshot(site):
    return {p.relative_to(site).as_posix():sha(p) for p in sorted(site.rglob("*")) if p.is_file()}
def read(p):return p.read_text(encoding="utf-8")
def write(p,s):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(s,encoding="utf-8")
CSS='<link rel="stylesheet" href="/sl02/shell.css?v=sl02-release-1">'
JS='<script defer src="/sl02/shell.js?v=sl02-release-1"></script>'
SHELL='<div data-fdg-release-shell></div>'
NAV=re.compile(r'<nav\b(?P<attrs>[^>]*class=["\'][^"\']*["\'][^>]*)>.*?</nav\s*>',re.S|re.I)
IMG=re.compile(r'<img\b[^>]*src=["\'][^"\']*header-formula-do-gol-v2\.png[^"\']*["\'][^>]*>',re.I)
def navkind(m):
    soup=BeautifulSoup(m.group(),"html.parser")
    n=soup.find("nav")
    if not n:return None
    c=n.get("class",[])
    return "main" if "nav" in c else "archive" if "menu" in c else None
def native(s,rel):
    # Keep the original anchors and IDs for legacy handlers; exclude the old
    # navigation from accessibility tree, layout and br-menu's floating clones.
    if rel in ("jogos/index.html","tabela/index.html","resultados/index.html"):
        return s
    matches=[m for m in NAV.finditer(s) if navkind(m)]
    replacement=SHELL
    for m in reversed(matches):
        old=m.group();kind=navkind(m)
        old=re.sub(r'\sdata-br-auth-menu(?:=["\'][^"\']*["\'])?', '',old,count=1)
        old=re.sub(r'<nav\b','<nav data-fdg-oldnav hidden aria-hidden="true" inert',old,count=1,flags=re.I)
        local=""
        if kind=="archive" and rel.startswith("copa2026/"):
            doc=BeautifulSoup(m.group(),"html.parser")
            a=[x for x in doc.select("a[href]") if x.get("href") not in ("/","../","../index.html")]
            local='<details class="fdg-archive-links"><summary>Navegação do acervo Copa 2026</summary><div>'+''.join(str(x) for x in a)+'</div></details>'
        s=s[:m.start()]+(replacement if m is matches[0] else "")+old+local+s[m.end():]
    if not matches:
        s=re.sub(r'(<body\b[^>]*>)',lambda m:m[1]+replacement,s,count=1,flags=re.I)
    # The old Copa-specific logo stays inside the archive, while the FDG logo
    # is reused exactly once in the new global header.
    s=IMG.sub(lambda m:m[0].replace("<img","<img data-fdg-oldbrand hidden",1),s)
    if rel=="index.html":
        nav='<nav class="fdg-native-subnav" aria-label="Central de jogos"><a href="/jogos">Próximos</a><a href="/resultados">Resultados</a><a href="/tabela">Classificação</a></nav>'
        s=s.replace(SHELL,SHELL+nav,1)
    if rel=="museu.html":
        s=s.replace(SHELL,SHELL+'<div class="fdg-native-subnav"><a href="/copa2026/">Acervo da Copa 2026</a></div>',1)
    s=re.sub(r'</head>',CSS+JS+'</head>',s,count=1,flags=re.I)
    return s
def approved(original):
    # Preserve original SEO metadata, canonical, JSON-LD, original GA setup,
    # manifest, favicons and PWA dependencies. No duplicate analytics.
    doc=BeautifulSoup(original,"html.parser")
    head=doc.head
    assert head and head.select_one('link[rel=canonical]') and head.select_one('link[rel=manifest]')
    for x in list(head.find_all("style")):x.decompose()
    for x in list(head.find_all("link",rel="stylesheet")):x.decompose()
    for x in list(head.find_all("script")):
        src=x.get("src","");txt=x.string or x.get_text()
        if x.get("type")=="application/ld+json" or "googletagmanager.com/gtag/js" in src or ("gtag(" in txt and "dataLayer" in txt):continue
        x.decompose()
    for rel in ("/css/br-pwa.css","/css/br-data-pulse.css","/sl02/design.css","/sl02/shell.css"):
        head.append(BeautifulSoup('<link rel="stylesheet" href="'+rel+'?v=sl02-release-1">',"html.parser"))
    for rel in ("/js/br-config.js","/js/br-menu.js","/js/br-af-core-snapshot.js","/js/br-data-manifest.js","/js/br-data-refresh.js","/js/br-data-pulse.js","/sl02/shell.js","/sl02/app.js","/js/br-pwa.js","/js/br-push.js"):
        head.append(BeautifulSoup('<script defer src="'+rel+'?v=sl02-release-1"></script>',"html.parser"))
    body='<body class="fdg-release-app" data-fdg-release-app="1" data-initial="stats/prob"><a class="skip" href="#fdg-main">Ir para conteúdo</a><header data-fdg-shell></header><main id="fdg-main" class="wrap" tabindex="-1" aria-live="polite" aria-busy="true"></main><footer class="wrap site-footer fdg-release-footer"><div class="footer">Fórmula do Gol — site independente. Dados esportivos, resultados e projeções conforme suas fontes e datas. <a href="/sobre.html">Sobre e metodologia</a> · <a href="/alertas.html">Alertas</a> · <a href="/privacidade.html">Privacidade</a></div></footer></body>'
    return '<!doctype html><html lang="pt-BR" data-theme="dark">'+str(head)+body+'</html>'
def apply(site,backup):
    assert not (site/"sl02").exists() and not backup.exists()
    backup.mkdir(parents=True);before=snapshot(site)
    original=read(site/"estatisticas.html")
    # Native full statistics remain reachable and keep their original scripts.
    full=BeautifulSoup(original,"html.parser")
    rob=full.select_one('meta[name=robots]')
    if rob:rob["content"]="noindex,follow"
    else:full.head.append(BeautifulSoup('<meta name="robots" content="noindex,follow">',"html.parser"))
    write(site/"estatisticas-completas.html",str(full))
    native_count=0
    for p in sorted(site.rglob("*.html")):
        rel=p.relative_to(site).as_posix()
        s=read(p)
        changed=approved(original) if rel=="estatisticas.html" else native(s,rel)
        if changed!=s:
            if rel in before:
                dest=backup/"original"/rel;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,dest)
            write(p,changed);native_count+=1
    assets=site/"sl02";assets.mkdir()
    for rel in ("app.js","design.css","shell.js","shell.css"):shutil.copy2(SRC/rel,assets/rel)
    hist=site/"dados-br/historico-probabilidades.json"
    h=json.loads(read(hist));slim={"source_sha256":sha(hist),"source_path":"dados-br/historico-probabilidades.json","snapshots":[]}
    for x in h["snapshots"]:
        entry={k:x[k] for k in ("gerado_em","rodada_referencia","versao_modelo","hash_snapshot","hash_entrada") if k in x}
        entry["clubes"]=[{k:v for k,v in c.items() if k=="clube" or k.endswith("_pct") and isinstance(v,(int,float,type(None)))} for c in x["clubes"]]
        slim["snapshots"].append(entry)
    write(assets/"history-slim.json",json.dumps(slim,ensure_ascii=False,separators=(",",":")))
    after=snapshot(site)
    modified={k:{"before":v,"after":after[k]} for k,v in before.items() if after.get(k)!=v}
    added={k:v for k,v in after.items() if k not in before}
    assert all(k.endswith(".html") for k in modified),"Non-HTML original asset changed"
    assert set(before)<=set(after),"Public path lost"
    assert all(k=="estatisticas-completas.html" or k.startswith("sl02/") for k in added)
    protected={k:v for k,v in before.items() if not k.endswith(".html")}
    assert all(after[k]==v for k,v in protected.items())
    ledger={"schema":1,"modified":modified,"added":added,"protected_count":len(protected),"original_files":len(before),"native_html_touched":native_count,"history_source_bytes":hist.stat().st_size,"history_projection_bytes":(assets/"history-slim.json").stat().st_size,"publication":False}
    write(backup/"rollback.json",json.dumps(ledger,indent=2))
    print("Overlay verified",len(modified),"HTML files; preserved",len(protected),"non-HTML assets;",len(added),"additions",flush=True)
    return ledger
def rollback(site,backup):
    ledger=json.loads(read(backup/"rollback.json"))
    # Verify every frontend path before any write; no partial rollback.
    for rel,x in ledger["modified"].items():
        assert sha(site/rel)==x["after"],"Frontend changed after release: "+rel
        assert sha(backup/"original"/rel)==x["before"],"Rollback original corrupt: "+rel
    for rel,digest in ledger["added"].items():assert sha(site/rel)==digest
    for rel in ledger["modified"]:shutil.copy2(backup/"original"/rel,site/rel)
    for rel in ledger["added"]:(site/rel).unlink()
    if (site/"sl02").is_dir(): (site/"sl02").rmdir()
    print("Frontend-only rollback completed; no sports data restored.",flush=True)
def main():
    mode,site,backup=sys.argv[1:];site=Path(site).resolve();backup=Path(backup).resolve()
    if mode=="apply":apply(site,backup)
    elif mode=="rollback":rollback(site,backup)
    else:raise ValueError(mode)
if __name__=="__main__":main()
