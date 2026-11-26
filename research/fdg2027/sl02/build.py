"""Build only from the immutable public production archive; do not publish."""
import hashlib,json,shutil,sys,tarfile,tempfile,zipfile,re
from pathlib import Path
SRC=Path(__file__).resolve().parent
SHA="298ce3a9f0feca9c8c4dc4ab325b20628a299e92bea8854bb3c15a2460763c20"
BASE="b0e2550b2579034f77bcb1afc67626741ab3f7b4"
def digest(p):
    with p.open("rb") as f:return hashlib.file_digest(f,"sha256").hexdigest()
def relative(p):return "../"*(len(p.parts)-1) or "./"
def main():
    z,out=Path(sys.argv[1]),Path(sys.argv[2]);assert digest(z)==SHA
    out.mkdir(parents=True,exist_ok=False)
    with tempfile.TemporaryDirectory() as td:
        temp=Path(td)
        with zipfile.ZipFile(z) as a:
            assert a.namelist()==["artifact.tar"];a.extract("artifact.tar",temp)
        with tarfile.open(temp/"artifact.tar") as t:t.extractall(out,filter="data")
    routes={"index.html":"stats/prob","estatisticas.html":"stats/prob","tabela/index.html":"stats/table","jogos/index.html":"games/next","resultados/index.html":"games/results","aovivo.html":"live","analises/index.html":"articles","clubes.html":"clubs","acuracia.html":"stats/accuracy","museu.html":"more/museum"}
    # Preserve original files/routes for reference, with only preview safeguards and shared navigation.
    csp="<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://s.sde.globo.com; connect-src 'self'; font-src 'self' data:; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'\">"
    safe='<meta name="robots" content="noindex,nofollow">'+csp
    for path in sorted(out.rglob("*.html")):
        rel=path.relative_to(out);s=path.read_text(encoding="utf-8")
        nav=re.search(r'<nav\b[^>]*class=["\'][^"\']*\bnav\b[^"\']*["\'][^>]*>.*?</nav>',s,re.S|re.I)
        if nav:
            prefix=relative(rel)
            # One common component; retain original app scripts and data as local inspection only.
            section=routes.get(rel.as_posix(),"clubs" if rel.parts[0]=="clube" else "games" if rel.parts[0]=="jogo" else "articles" if rel.parts[0]=="analises" else "more")
            # Base applies to new navigation and assets; legacy relative links continue with original path.
            # The shell script uses explicit root based on a data attribute for legacy paths.
            s=s[:nav.start()]+'<div data-fdg-shell data-prefix="'+prefix+'"></div>'+s[nav.end():]
            s=re.sub(r'(<body\b[^>]*)(>)',lambda m:m[1]+' data-legacy="1" data-initial="'+section+'">'+m[2][1:],s,count=1,flags=re.I)
            s=re.sub(r'</head>',safe+'<link rel="stylesheet" href="'+prefix+'sl02/design.css"><script defer src="'+prefix+'sl02/app.js"></script></head>',s,count=1,flags=re.I)
        else:s=re.sub(r'</head>',safe+'</head>',s,count=1,flags=re.I)
        path.write_text(s,encoding="utf-8")
    assets=out/"sl02";assets.mkdir()
    for f in ("design.css","app.js"):shutil.copy2(SRC/f,assets/f)
    for name,section in routes.items():
        p=out/name
        if p.exists():
            legacy=p.with_name("legacy-"+p.name)
            shutil.copy2(p,legacy)
        prefix=relative(Path(name))
        html='<!doctype html><html lang="pt-BR" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base href="'+prefix+'">'+safe+'<title>Fórmula do GOL · Prévia SL02</title><link rel="icon" href="favicon-formula-do-gol-32.png"><link rel="stylesheet" href="sl02/design.css"><script defer src="sl02/app.js"></script></head><body data-initial="'+section+'"><a class="skip" href="#fdg-main">Ir para conteúdo</a><header data-fdg-shell></header><main id="fdg-main" class="wrap" tabindex="-1" aria-live="polite" aria-busy="true"></main><footer class="wrap"><div class="footer">Prévia local SL02 · Dados públicos de 26/11/2026 · Fonte ESPN / CBF / AF-Previsão 1.3 · Sem atualização ou publicação automática.</div></footer></body></html>'
        p.write_text(html,encoding="utf-8")
    # Remove the deploy marker from this isolated archive. Legacy SW code is retained but cannot register.
    (out/"CNAME").unlink(missing_ok=True)
    (out/"robots.txt").write_text("User-agent: *\nDisallow: /\n")
    (out/"ABRIR_PREVIA.txt").write_text("FDG SL02 — prévia local, não publicada.\nExtraia o pacote. Abra um terminal nesta pasta e execute: python -m http.server 8765 --bind 127.0.0.1\nAbra http://127.0.0.1:8765/ no navegador. Feche o terminal para encerrar.\nDados reais de 26/11/2026; sem live/push operacional, sem alterar produção. Acesso a escudos originais depende da rede; fallback de siglas. Não enviar a uma hospedagem.\n",encoding="utf-8")
    public_data={p.relative_to(out).as_posix():digest(p) for p in sorted(out.rglob("*.json")) if p.is_file()}
    (out/"SL02-manifest.json").write_text(json.dumps({"stage":"SL02","base":BASE,"source_run":45806559507,"source_artifact":15110286620,"source_zip_sha256":SHA,"season":2026,"snapshot_at":"2026-11-26T08:00:00-03:00","publication":False,"data_sha256":public_data},indent=2))
if __name__=="__main__":main()
