"""Certify exact public bytes of an already validated statistical revision."""
import argparse
import hashlib
import json
import time
import urllib.request
from pathlib import Path
from validar_recuperacao_estatistica_r36r7 import certify, ROOT

PATHS = ("resultados.json", "tabela.json", "dados-br/jogos-detalhes.json",
         "dados-br/lideres-jogadores.json", "dados-br/estatisticas-competicao.json",
         "dados-br/auditoria-estatisticas.json", "dados-br/ranking-desempenho.json")
HOST = "https://formuladogol.com.br/"

def load(path):
    return json.loads(path.read_bytes())

def fetch_verified(path, expected):
    for attempt in range(4):
        try:
            req = urllib.request.Request(HOST + path + "?sha=" + expected,
                headers={"User-Agent":"FDG-R36-R7-Production/1.0","Cache-Control":"no-cache"})
            with urllib.request.urlopen(req, timeout=25) as r:
                data = r.read()
            if hashlib.sha256(data).hexdigest() == expected:
                return
            last = "SHA-256 diverge"
        except Exception as e:
            last = str(e)
        if attempt < 3:
            time.sleep(4 * (attempt + 1))
    raise RuntimeError(f"Public statistics verification failed: {path}: {last}")

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--site-root",type=Path,required=True)
    root=p.parse_args().site_root
    manifest=load(root/"dados-br/fdg-data-pulse.json")
    n=len(load(root/"resultados.json")["resultados"])
    comp=load(root/"dados-br/estatisticas-competicao.json")
    if comp["resumo"]["jogos_com_estatisticas"] != n:
        print(f"::warning::R36-R7 ainda não certificável: {comp['resumo']['jogos_com_estatisticas']}/{n}.")
        return
    # A complete candidate must satisfy the same rigorous gate as recovery.
    assert certify(ROOT)==n
    for path in PATHS:
        expected=manifest["files"][path]["sha256"]
        assert hashlib.sha256((root/path).read_bytes()).hexdigest()==expected, path
        fetch_verified(path,expected)
    print(f"PASS R36-R7 PRODUCTION: {n}/{n}; seven public datasets SHA-256 verified; publico={comp['resumo']['jogos_com_publico']}; renda={comp['resumo']['jogos_com_renda']}")
if __name__=="__main__":
    main()
