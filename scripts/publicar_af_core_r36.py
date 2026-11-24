#!/usr/bin/env python3
"""R36-R4: public, allowlisted, atomic AF core snapshot and lightweight manifest."""
from __future__ import annotations
import argparse
import hashlib
import json
import sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from scripts.gerar_status_vagas_libertadores import build as build_vagas
from scripts.gerar_probabilidades_brasileirao import current_publication_freshness

MANIFEST="dados-br/af-core-manifest.json"
BUNDLE="dados-br/af-core-snapshot.json"
CORE=("tabela.json","resultados.json","jogos.json","espn_eventos.json",
      "dados-br/agenda-clubes-br.json","dados-br/probabilidades-brasileirao.json",
      "dados-br/probabilidades-por-pontuacao.json","dados-br/probabilidades-jogos.json",
      "dados-br/auditoria-probabilidades.json","dados-br/auditoria-competicoes-af-previsao.json",
      "dados-br/vagas-libertadores-2027.json")

def read(root,path):
    return json.loads((root/path).read_text(encoding="utf-8"))

def write(root,path,obj):
    dest=root/path
    dest.parent.mkdir(parents=True,exist_ok=True)
    tmp=dest.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj,ensure_ascii=False,separators=(",",":"))+"\n",encoding="utf-8")
    tmp.replace(dest)

def manifest(prob):
    base=prob["base_corrente"]
    if prob.get("status")!="ok" or prob["simulacao"]["quantidade"]!=2_000_000:
        raise ValueError("AF inválido para publicação rápida")
    if base["partidas_concluidas"]+base["partidas_restantes"]!=380:
        raise ValueError("partição da temporada inválida")
    if len(prob["clubes"])!=20 or not prob.get("hash_entrada") or not prob.get("calculado_em"):
        raise ValueError("metadados AF incompletos")
    revision=hashlib.sha256((prob["hash_entrada"]+"|"+prob["calculado_em"]).encode()).hexdigest()
    return {"schema_version":1,"revision":revision,"hash_entrada":prob["hash_entrada"],
            "calculado_em":prob["calculado_em"],"concluidos":base["partidas_concluidas"],
            "restantes":base["partidas_restantes"]}

def publish():
    freshness=current_publication_freshness()
    if freshness.get("atualizado") is not True:
        raise ValueError("AF desatualizado: "+str(freshness.get("motivos")))
    datasets={p:(build_vagas() if p.endswith("vagas-libertadores-2027.json") else read(ROOT,p)) for p in CORE}
    meta=manifest(datasets["dados-br/probabilidades-brasileirao.json"])
    results=datasets["resultados.json"]["resultados"]
    table=datasets["tabela.json"]["tabela"]
    predictions=datasets["dados-br/probabilidades-jogos.json"]["jogos"]
    if len(results)!=meta["concluidos"] or len(table)!=20 or len(predictions)!=meta["restantes"]:
        raise ValueError("snapshot não contém a mesma partição em todos os JSONs")
    ids={str(x["event_id"]) for x in results}
    if len(ids)!=len(results) or any(str(x["event_id"]) in ids for x in predictions):
        raise ValueError("FINAL duplicado ou previsão de partida encerrada")
    # All files are already public Pages datasets; no private odds, secrets,
    # full history or raw continental source payload is exported.
    old=ROOT/MANIFEST
    if old.exists() and read(ROOT,MANIFEST)==meta and (ROOT/BUNDLE).exists():
        previous=read(ROOT,BUNDLE)
        if previous.get("manifest")==meta and all(p in previous.get("files",{}) for p in CORE):
            print("R36-R4 atomic bundle already current")
            return
    write(ROOT,BUNDLE,{"manifest":meta,"files":datasets})
    write(ROOT,MANIFEST,meta)
    print("R36-R4 atomic bundle: "+meta["revision"]+" FINALs="+str(meta["concluidos"]))

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--site-manifest")
    args=ap.parse_args()
    if args.site_manifest:
        site=Path(args.site_manifest)
        write(site,MANIFEST,manifest(read(site,"dados-br/probabilidades-brasileirao.json")))
    else:
        publish()
    return 0

if __name__=="__main__":
    raise SystemExit(main())
