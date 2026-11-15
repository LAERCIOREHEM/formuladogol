#!/usr/bin/env python3
"""Regressão pós-FINAL: fonte versionada antes do apito e reconciliação sem retroprevisão."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
audit = json.loads((root / "dados-br/auditoria-historica-placares-af-2026.json").read_text())
results_raw = (root / "resultados.json").read_bytes()
results = json.loads(results_raw)
assert audit["fontes_resultados"]["arquivo_sha256"] == hashlib.sha256(results_raw).hexdigest()
assert audit["resumo"]["total_resultados_unicos"] == len(results["resultados"])
assert sum(r["situacao"] == "comprovado" for r in audit["jogos"]) == audit["resumo"]["jogos_com_placar_prejogo_comprovado"]
assert all("previsao" not in r for r in audit["jogos"] if r["situacao"] != "comprovado")

mirassol = [
    r for r in audit["jogos"]
    if r["mandante"] == "Mirassol" and r["visitante"] == "Atlético-MG"
]
assert len(mirassol) == 1, "Confronto R35 ausente/duplicado"
game = mirassol[0]
assert game["placar_final"] == {"mandante": 0, "visitante": 0}, "Placar final da R35 divergente"
assert game["situacao"] == "comprovado", "Previsão original R35 não foi recuperada"
assert game["previsao"]["placar_modal"] == {"mandante": 1, "visitante": 0}
assert (game["top3_placares"] and len(game["top3_placares"]) == 3)
assert (game["top3_placares"][2]["mandante"],game["top3_placares"][2]["visitante"]) == (0,0)
assert game["top3_situacao"] in ("nativo_documentado","nativo_conciliado_mesma_previsao")
assert game["proveniencia"]["commit"] and len(game["proveniencia"]["commit"]) == 40
assert game["proveniencia"]["gerado_em_modelo"] < game["inicio_factual"]

print("PÓS-FINAL CERTIFICADO: Mirassol 0×0 Atlético-MG, 3º cenário 0×0, prova histórica",game["proveniencia"]["commit"])
