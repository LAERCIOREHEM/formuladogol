#!/usr/bin/env python3
"""Teste ponta a ponta das páginas estáticas: comparação com E3 e proteção anti-retroprevisão."""
from __future__ import annotations
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "scripts"))
from gerar_paginas_jogos import certified_match_e3, certified_prediction, render_page

data = json.loads((root / "dados-br/resultados-af-placares-2026.json").read_text())
source = json.loads((root / "resultados.json").read_text())
match = next(r for r in source["resultados"]
             if r["mandante"]["nome"] == "Mirassol" and r["visitante"]["nome"] == "Atlético-MG")
evidence = next(r for r in data["jogos"]
                if r["mandante"] == "Mirassol" and r["visitante"] == "Atlético-MG")
game = {**match, "concluido": True}
certified = certified_match_e3(game, match, evidence)
assert certified, "O resultado consolidado precisa identificar a previsão antes do apito"
assert certified["palpite_resultado_top1"] == "mandante"
assert (certified["placar_previsto"]["mandante"], certified["placar_previsto"]["visitante"]) == (1,0)
assert any((r["mandante"],r["visitante"]) == (0,0) for r in certified["top3_placares"])
assert not certified_match_e3(game, {**match, "placar_mandante": 3}, evidence), "Placar divergente exibido"
assert not certified_match_e3({**game,"data_iso":"2026-11-15T18:30"}, {
    **match,"data_iso":"2026-11-15T18:30"}, evidence), "Reagendamento divergiu sem revisão documental"
fakeclubs = {
    "Mirassol": {"escudo": "https://example.org/mirassol.svg"},
    "Atlético-MG": {"escudo": "https://example.org/cam.svg"}
}
slug, canonical, page = render_page(
    game, result=match, details={}, current_pred={},
    historical_pred=certified_prediction(certified), certified_e3=certified,
    tv={}, club_map=fakeclubs, table_map={}, prob_map={},
    rank_map={}, related=[], updated_at=source["atualizado_em"]
)
assert slug == "mirassol-x-atletico-mg-2026-11-14"
assert "Placar no Top-3" in page, "Faltou o acerto no 3º cenário"
assert "Resultado principal V/E/D" in page and "Placar exato" in page
assert "Conferir registro original" in page
assert "1 × 0" in page and "0 × 0" in page
assert "9,5% de chance" in page
assert canonical.endswith("/jogo/mirassol-x-atletico-mg-2026-11-14/")
print("PÁGINAS AF PÓS-FINAL PASS: 0×0 no Top-3, V/E/D principal não confirmado e prova de origem")

# FDG R35 — empate previsto no placar, embora favorito V/E/D difira.
from gerar_paginas_jogos import result_evaluation_html
gremio_bahia = next(x for x in data["jogos"] if x["mandante"]=="Grêmio" and x["visitante"]=="Bahia" and x["rodada_auditada"]==35)
r35_html = result_evaluation_html(gremio_bahia,0,0)
assert "Acertou o empate pelo placar previsto" in r35_html
assert "Resultado principal V/E/D" in r35_html
assert "Desfecho do placar previsto" in r35_html
assert "Placar exato" in r35_html
