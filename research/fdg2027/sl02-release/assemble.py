"""Rebuild the existing public staging tree from the checked-out commit, not Actions artifacts.

Uses the actual deploy allowlists and existing deterministic SEO/data-manifest generators.
Never runs the deployment workflow, AF simulations, collection, notifications or external APIs.
Run in an ephemeral checkout only. No writes to GitHub, Cloudflare, D1 or Supabase.
"""
from __future__ import annotations
import hashlib,json,re,shutil,subprocess,sys
from pathlib import Path
from datetime import datetime,timezone
REPO=Path(__file__).resolve().parents[3]
def sha(p):return hashlib.file_digest(p.open("rb"),"sha256").hexdigest()
def run(name,*args):
    print("Offline generator:",name,*args,flush=True)
    subprocess.run([sys.executable,str(REPO/"scripts"/name),*map(str,args)],cwd=REPO,check=True)
def array(source,name):
    m=re.search(r"(?m)^\s*"+re.escape(name)+r"=\(([^)]*)\)",source)
    if not m:raise RuntimeError("Deploy allowlist absent: "+name)
    items=" ".join(s.split("#",1)[0].strip() for s in m[1].splitlines()).split()
    if not all(re.fullmatch(r"[A-Za-z0-9_./-]+",x) and ".." not in Path(x).parts for x in items):raise RuntimeError("Unsafe allowlist item")
    return items
def copy_file(out,rel):
    src=REPO/rel
    if not src.is_file() or src.is_symlink():raise RuntimeError("Required public file absent: "+rel)
    dest=out/rel;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dest)
def copy_dir(out,rel):
    src=REPO/rel
    if not src.is_dir():raise RuntimeError("Required public directory absent: "+rel)
    if any(x.is_symlink() for x in src.rglob("*")):raise RuntimeError("Symlink in public directory")
    shutil.copytree(src,out/rel,dirs_exist_ok=True)
def manifest(out):
    p=json.loads((out/"dados-br/probabilidades-brasileirao.json").read_text())
    b=p["base_corrente"];r=json.loads((out/"resultados.json").read_text())["resultados"];t=json.loads((out/"tabela.json").read_text())["tabela"];j=json.loads((out/"dados-br/probabilidades-jogos.json").read_text())["jogos"]
    assert p["status"]=="ok" and p["simulacao"]["quantidade"]==2000000 and len(p["clubes"])==20
    assert b["partidas_concluidas"]+b["partidas_restantes"]==380
    assert len(r)==b["partidas_concluidas"] and len(t)==20 and len(j)==b["partidas_restantes"]
    assert len({str(x["event_id"]) for x in r})==len(r) and not {str(x["event_id"]) for x in r}&{str(x["event_id"]) for x in j}
    rev=hashlib.sha256((p["hash_entrada"]+"|"+p["calculado_em"]).encode()).hexdigest()
    m={"schema_version":1,"revision":rev,"hash_entrada":p["hash_entrada"],"calculado_em":p["calculado_em"],"concluidos":len(r),"restantes":len(j)}
    (out/"dados-br/af-core-manifest.json").write_text(json.dumps(m,ensure_ascii=False,separators=(",",":"))+"\n")
    return m
def main():
    out=Path(sys.argv[1]).resolve();assert not out.exists()
    if out.is_relative_to(REPO):raise RuntimeError("Build outside checkout")
    out.mkdir(parents=True)
    src=(REPO/".github/workflows/deploy.yml").read_text()
    run("gerar_status_vagas_libertadores.py")
    for name in ("PUBLIC_ROOT","PUBLIC_CSS","PUBLIC_JS","PUBLIC_DATA","COPA_PUBLIC_FILES"):
        for rel in array(src,name):copy_file(out,rel)
    for rel in array(src,"PUBLIC_ROUTES"):copy_file(out,rel+"/index.html")
    for rel in ["img","analises",*array(src,"COPA_IMAGE_DIRS")]:copy_dir(out,rel)
    (out/".nojekyll").touch()
    copy_file(out,"docs/operations/RAG-MANIFEST.json")
    (out/"docs/operations/RAG-MANIFEST.json").replace(out/"dados-br/rag-manifest.json")
    shutil.rmtree(out/"docs")
    run("build_ops_rag_index.py","--output",out/"dados-br/ops-rag-index.json")
    meta=manifest(out)
    source_commit=subprocess.check_output(["git","rev-parse","HEAD"],cwd=REPO,text=True).strip()
    # This file describes only local staging, never claims an actual deployment.
    (out/"dados-br/status-deploy.json").write_text(json.dumps({"schema_version":1,"site":"Fórmula do Gol","workflow":"SL02 local staging","status":"aviso","nivel":"aviso","source_commit":source_commit,"publicado_em":None,"local_only":True},ensure_ascii=False))
    run("gerar_fundacao_organica.py","--site-root",out,"--check")
    run("gerar_paginas_clubes.py","--site-root",out,"--repo-root",REPO,"--check")
    run("gerar_paginas_jogos.py","--site-root",out,"--check")
    run("gerar_hubs_competicoes.py","--site-root",out,"--repo-root",REPO,"--check")
    run("gerar_fechamento_organico.py","--site-root",out,"--check")
    run("validar_org_final.py","--site-root",out,"--check")
    run("otimizar_imagens.py","--raiz",out,"--pastas","img","copa2026/img")
    run("validar_contrato_publicos_fastlane.py","--site-root",out)
    for rel in array(src,"FORBIDDEN"):
        assert not (out/rel.removeprefix("_site/")).exists(),"Private path in public staging: "+rel
    run("gerar_fdg_data_manifest.py","--site-root",out)
    run("gerar_fdg_data_manifest.py","--site-root",out,"--check")
    print("Independent staging assembled:",source_commit,meta,flush=True)
if __name__=="__main__":main()
