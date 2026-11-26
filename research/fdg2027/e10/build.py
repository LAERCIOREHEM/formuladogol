"""Build isolated local E10 demonstration; never write site or private data."""
import argparse, hashlib, json, os, re, shutil, subprocess, sys
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
sys.path.insert(0,str(HERE.parent/"e01"))
import foundation as f
LOCK=json.loads((HERE/"source-lock.json").read_text())
ASSETS={"calendar":"dados-br/agenda-clubes-br.json","fixtures":"jogos.json","standings":"tabela.json","results":"resultados.json","editorials":"feed.xml","statistics":"dados-br/estatisticas-competicao.json","highlights":"dados-br/melhores-momentos.json","accuracy":"dados-br/acuracia-af-previsao.json","forecast":"dados-br/probabilidades-jogos.json","history":"dados-br/historico-probabilidades-jogos.json","manifest":"dados-br/af-core-manifest.json","snapshot":"dados-br/af-core-snapshot.json","rules":"regras.html","players":"dados-br/jogadores.json","rosters":"dados-br/elencos.json"}
LEGACY={"calendar":"/agenda.html","fixtures":"/jogos/","standings":"/tabela/","results":"/resultados/","editorials":"/analises/","statistics":"/estatisticas.html","highlights":"/resultados/","accuracy":"/acuracia.html","forecast":"/jogos/","history":"/acuracia.html","manifest":"/acuracia.html","snapshot":"/acuracia.html","rules":"/regras.html","players":"/estatisticas.html","rosters":"/clubes.html"}
def raw(o):return json.dumps(o,sort_keys=True,separators=(",",":"),ensure_ascii=False,allow_nan=False).encode()+b"\n"
def sha(b):return hashlib.sha256(b).hexdigest()
def git(path):return subprocess.check_output(["git","show",LOCK["e09_commit"]+":"+path],cwd=ROOT)
def public_json(path):return json.loads(git(path))
def write(p,b):p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b)
def verify_deploy():
    d=(ROOT/".github/workflows/deploy.yml").read_text()
    for w in ("deploy.yml","deploy-push-worker.yml","deploy-orchestrator-worker.yml"):
        s=(ROOT/".github/workflows"/w).read_text()
        assert "research/" not in s and "fdg2027-e10" not in s
    assert "PUBLIC_ROOT=(" in d and "PUBLIC_DATA=(" in d and "PUBLIC_JS=(" in d and "PUBLIC_CSS=(" in d
    assert "temporada: 2026" in (ROOT/"js/br-config.js").read_text()
    assert f.public_season()=="2026" and not f.REG["public_switch_enabled"]
    # Check entire commit delta, not just sample files.
    names=subprocess.check_output(["git","diff","--name-only",LOCK["e09_commit"],"HEAD"],cwd=ROOT,text=True).splitlines()
    # Only E10 changes in the candidate branch; concurrent production changes fail closed.
    assert all(n.startswith("research/fdg2027/e10/") or n==".github/workflows/fdg2027-e10-ux.yml" for n in names),names
    return {"production_default":2026,"deployment_paths_unchanged":True,"public_allowlist_excludes_research":True,"changed_paths":len(names),"worker_d1_binding":"formula-do-gol-push","supabase_schema_review":"br_palpites and br_config_rodadas include temporada; no live inspection or migration"}
def build(out):
    out=out.resolve()
    assert not out.exists() and ROOT not in out.parents and out not in ROOT.parents and out!=ROOT
    audit=verify_deploy();out.mkdir()
    for file in ("index.html","app.mjs","style.css"):shutil.copyfile(HERE/file,out/file)
    # Preview cannot be indexed; no production canonical or service worker registration.
    write(out/"robots.txt",b"User-agent: *\nDisallow: /\n")
    registry={"competition":"bra.1","default":"2026","shadow_only":True,"public_switch":False,"seasons":["2026","2027"],"assets":list(ASSETS),"legacy":LEGACY,"pinned_commit":LOCK["e09_commit"]}
    write(out/"registry.json",raw(registry))
    docs={k:git(p) for k,p in ASSETS.items()}
    forecasts=json.loads(docs["forecast"]);assert forecasts["temporada"]==2026 and forecasts["versao_modelo"]=="AF-Previsão 1.3"
    players=json.loads(docs["players"]);assert players["temporada"]==2026
    table=json.loads(docs["standings"]);results=json.loads(docs["results"])
    highlights=json.loads(docs["highlights"])
    def fields(row,keys):return {k:row.get(k) for k in keys}
    data={"forecast":{"model":forecasts["versao_modelo"],"generated":forecasts["gerado_em"],"rows":[fields(x,("event_id","rodada","data_iso","mandante","visitante","probabilidades_exibicao_pct","gols_esperados","placar_modal","placares_mais_provaveis")) for x in forecasts["jogos"]]},"players":{"rows":[fields(x,("nome","time","gols","jogos","athlete_id")) for x in players["artilharia"]],"source":players["fonte"],"rating":None},"standings":{"rows":[fields(x,("pos","time","pontos","jogos","sg")) for x in table["tabela"]]},"results":{"count":len(results["resultados"])},"highlights":{"count":highlights["total_vinculados"]}}
    manifests={}
    for y in ("2026","2027"):
        entries={}
        for k,p in ASSETS.items():
            body={"competition":"bra.1","season":y,"asset":k,"state":"documentary" if y=="2026" else "unavailable","source_path":p if y=="2026" else None,"source_sha256":sha(docs[k]) if y=="2026" else None,"legacy":LEGACY[k] if y=="2026" else None,"data":data.get(k) if y=="2026" else None}
            f.validate_envelope(y,body)
            # Namespace includes season and asset; no cross-season fallback.
            b=raw(body);rel=f"data/{y}/{k}.json";write(out/rel,b)
            entries[k]={"path":rel,"sha256":sha(b),"bytes":len(b),"namespace":f.namespace(y,"cache",k)}
        m={"competition":"bra.1","season":y,"entries":entries,"public":False,"source_commit":LOCK["e09_commit"] if y=="2026" else None}
        b=raw(m);write(out/f"data/{y}/_manifest.json",b);manifests[y]=sha(b)
    write(out/"manifest-lock.json",raw(manifests))
    return {**audit,"assets_per_season":len(ASSETS),"documentary_assets":len(ASSETS),"unavailable_2027_assets":len(ASSETS),"forecast_rows":len(data["forecast"]["rows"]),"player_rows":len(data["players"]["rows"]),"standings_rows":len(data["standings"]["rows"]),"result_rows":data["results"]["count"],"highlights":data["highlights"]["count"],"manifest_sha256":manifests,"production_ready":False,"public_switch":False}
def main():
    p=argparse.ArgumentParser();p.add_argument("--out",type=Path,required=True);p.add_argument("--report",type=Path,required=True);a=p.parse_args()
    result=build(a.out);a.report.write_bytes(raw(result));print("E10 BUILD",json.dumps(result,sort_keys=True))
if __name__=="__main__":main()
