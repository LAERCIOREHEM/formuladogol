"""FDG Data Pulse E: hash exactly the bytes served by the Pages artifact."""
import argparse
import hashlib
import json
import os
from pathlib import Path

PATHS = (
    "tabela.json", "resultados.json", "jogos.json", "espn_eventos.json",
    "dados-br/agenda-clubes-br.json", "dados-br/lideres-jogadores.json",
    "dados-br/estatisticas-competicao.json", "dados-br/jogos-detalhes.json",
    "dados-br/ranking-desempenho.json", "dados-br/historico-ranking-desempenho.json",
    "dados-br/auditoria-estatisticas.json", "dados-br/status-atualizacao.json",
    "dados-br/probabilidades-brasileirao.json", "dados-br/auditoria-probabilidades.json",
    "dados-br/historico-probabilidades.json", "dados-br/marcos-af-previsao.json",
    "dados-br/auditoria-modelos-af-previsao.json", "dados-br/avaliacao-af-previsao.json",
    "dados-br/probabilidades-por-pontuacao.json", "dados-br/auditoria-competicoes-af-previsao.json",
    "dados-br/probabilidades-jogos.json", "dados-br/vagas-libertadores-2027.json",
    "dados-br/acuracia-af-previsao.json", "dados-br/acuracia-placares-af-2026.json",
    "dados-br/resultados-af-placares-2026.json",
)
def digest(data):
    return hashlib.sha256(data).hexdigest()

def build(root):
    files = {}
    for rel in PATHS:
        raw = (root / rel).read_bytes()
        obj = json.loads(raw)
        if not isinstance(obj, (dict, list)):
            raise ValueError("Invalid public JSON: " + rel)
        entry = {"sha256": digest(raw), "bytes": len(raw)}
        if isinstance(obj, dict):
            for k in ("atualizado_em", "gerado_em", "calculado_em"):
                if isinstance(obj.get(k), str):
                    entry[k] = obj[k]
        files[rel] = entry
    revision = digest(json.dumps(files, sort_keys=True, separators=(",", ":")).encode())
    return {"schema_version": 1, "revision": revision, "files": files}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--site-root", type=Path, required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    manifest = build(args.site_root)
    target = args.site_root / "dados-br/fdg-data-pulse.json"
    if args.check:
        if json.loads(target.read_bytes()) != manifest:
            raise SystemExit("FDG manifest differs from public bytes")
    else:
        tmp = target.with_suffix(".tmp")
        tmp.write_text(json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
        os.replace(tmp, target)
    print("FDG manifest:", len(manifest["files"]), "files", manifest["revision"])

if __name__ == "__main__":
    main()
