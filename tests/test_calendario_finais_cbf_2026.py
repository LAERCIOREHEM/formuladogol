#!/usr/bin/env python3
"""Regressão CBF: todos os 20 jogos finais, fonte e restauração pós-ESPN."""
from __future__ import annotations

import copy
import json
import sys
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import atualizar_espn as espn  # noqa: E402
from scripts.gerar_agenda_clubes_brasileirao import brasileirao_games  # noqa: E402

def load(name):
    return json.loads((ROOT / name).read_text(encoding="utf-8"))

fixes = [x for x in load("dados-br/ajustes-calendario.json")["ajustes"]
         if x.get("rodada") in (37, 38)]
assert len(fixes) == 20
assert set(x["referencia_cbf"] for x in fixes) == set(range(361, 381))
assert len({(x["rodada"], x["mandante"], x["visitante"]) for x in fixes}) == 20

sources = {
    "jogos": load("jogos.json")["jogos"],
    "eventos": load("espn_eventos.json")["eventos"],
    "calendario": load("dados-br/calendario-completo.json")["jogos"],
    "agenda": [x for x in load("dados-br/agenda-clubes-br.json")["jogos"]
               if x.get("competicao_chave") == "brasileirao"],
}
for r in (37, 38):
    rows = [x for x in fixes if x["rodada"] == r]
    assert len(rows) == 10
    assert len({t for x in rows for t in (x["mandante"], x["visitante"])}) == 20
    for key, matches in sources.items():
        assert len([x for x in matches if x.get("rodada") == r]) == 10, (key, r)

def name(value):
    return value.get("nome") if isinstance(value, dict) else value

for fix in fixes:
    expected = fix["data_iso"]
    assert 24 <= int(expected[8:10]) <= 29 if fix["rodada"] == 37 else expected == "2026-12-02T21:30"
    assert fix["origem_calendario"].endswith(".pdf")
    assert fix["fonte_calendario"].startswith("CBF oficial — tabela detalhada")
    if fix["rodada"] == 38:
        assert fix["event_id"] == f"cbf-2026-{fix['referencia_cbf']}"
    else:
        assert fix["event_id"].isdigit()
    for key, matches in sources.items():
        found = [x for x in matches if x.get("rodada") == fix["rodada"]
                 and name(x.get("mandante")) == fix["mandante"]
                 and name(x.get("visitante")) == fix["visitante"]]
        assert len(found) == 1, (key, fix["mandante"], fix["visitante"])
        row = found[0]
        assert str(row.get("data_iso")).startswith(expected), (key, fix["event_id"], row.get("data_iso"))
        assert row.get("estadio") == fix["estadio"], (key, fix["event_id"])
        assert row.get("data_definir") is False
        assert row.get("event_id") == fix["event_id"], (key, fix["event_id"])
        assert "CBF oficial — tabela detalhada" in row.get("fonte_calendario", ""), key

assert len(load("dados-br/calendario-completo.json")["jogos"]) == 380
assert not any(str(x.get("event_id", "")).startswith("cbf-2026-")
               for x in load("resultados.json")["resultados"])

# A atualização ESPN posterior deve restaurar os fixtures que ela ainda omite.
base = next(x for x in fixes if x["rodada"] == 37)
fixture = {
    "event_id": base["event_id"], "rodada": 37,
    "mandante_nome": base["mandante"], "visitante_nome": base["visitante"],
    "mandante": espn.info_time(base["mandante"]),
    "visitante": espn.info_time(base["visitante"]),
    "data_iso": "2026-11-28T17:00",
    "data_dt": datetime.fromisoformat("2026-11-28T17:00:00-03:00"),
    "_sort": datetime.fromisoformat("2026-11-28T17:00:00-03:00").timestamp(),
    "estado": "pre", "concluido": False, "adiado": False,
    "data_definir": False, "status": "0'", "placar_mandante": 0,
    "placar_visitante": 0,
}
# Este teste certifica exclusivamente as rodadas 37/38: ajustes de outras
# rodadas (ex.: Grêmio x Bahia, R35) são testados separadamente e não devem
# aumentar o conjunto de fixtures desta regressão.
def aplicar_apenas_rodadas_finais(eventos):
    # Fixar a data do teste: partidas futuras em novembro/dezembro não podem
    # deixar de existir só porque o CI voltou a rodar semanas depois.
    clock = datetime.fromisoformat("2026-11-18T18:00:00-03:00")
    with patch.object(espn, "carregar_ajustes_calendario", return_value=fixes), \
         patch.object(espn, "agora_brt", return_value=clock):
        espn.aplicar_ajustes_calendario(eventos)

events = [fixture]
aplicar_apenas_rodadas_finais(events)
assert len(events) == 20, len(events)
assert fixture["data_iso"] == base["data_iso"]
assert fixture["fonte_calendario"].startswith("CBF oficial — tabela detalhada")
round38 = next(x for x in fixes if x["rodada"] == 38)
old = next(x for x in events if x["mandante_nome"] == round38["mandante"]
           and x["visitante_nome"] == round38["visitante"])
real = copy.deepcopy(old)
real["event_id"] = "401842999"  # ID ESPN de teste, não usado na publicação
real["data_iso"] = "2026-12-06T17:00"
events.append(real)
aplicar_apenas_rodadas_finais(events)
matched = [x for x in events if x["mandante_nome"] == round38["mandante"]
           and x["visitante_nome"] == round38["visitante"]]
assert len(matched) == 1 and matched[0]["event_id"] == "401842999"
assert matched[0]["data_iso"] == round38["data_iso"]
assert len(events) == 20

# Placar FINAL nunca é reaberto pela correção de kickoff.
fixture["concluido"], fixture["estado"] = True, "post"
fixture["placar_mandante"], fixture["placar_visitante"] = 2, 1
fixture["data_iso"] = "2026-11-24T19:00"
aplicar_apenas_rodadas_finais(events)
assert fixture["data_iso"] == "2026-11-24T19:00"
assert (fixture["placar_mandante"], fixture["placar_visitante"]) == (2, 1)

# Regressão independente da 35ª rodada: o novo ajuste Grêmio x Bahia
# não integra as 20 partidas das rodadas finais, mas deve continuar válido.
r35 = next(x for x in load("dados-br/ajustes-calendario.json")["ajustes"]
           if str(x.get("event_id")) == "401841312")
assert r35["rodada"] == 35 and r35["data_iso"] == "2026-11-18T21:30"
gremio_bahia = {
    "event_id": "401841312", "rodada": 35,
    "mandante_nome": "Grêmio", "visitante_nome": "Bahia",
    "mandante": espn.info_time("Grêmio"), "visitante": espn.info_time("Bahia"),
    "data_iso": "2026-11-18T17:00",
    "data_dt": datetime.fromisoformat("2026-11-18T17:00:00-03:00"),
    "_sort": datetime.fromisoformat("2026-11-18T17:00:00-03:00").timestamp(),
    "estado": "pre", "concluido": False, "adiado": False,
    "data_definir": False, "status": "0'",
    "placar_mandante": 0, "placar_visitante": 0,
}
with patch.object(espn, "carregar_ajustes_calendario", return_value=[r35]):
    gremio_events = [gremio_bahia]
    espn.aplicar_ajustes_calendario(gremio_events)
    assert len(gremio_events) == 1, "CBF R35 não deve duplicar partida"
    assert gremio_bahia["data_iso"] == "2026-11-18T21:30"
    assert gremio_bahia["fonte_calendario"].startswith("CBF oficial")
    gremio_bahia["concluido"], gremio_bahia["estado"] = True, "post"
    gremio_bahia["data_iso"] = "2026-11-18T21:30"
    gremio_bahia["placar_mandante"], gremio_bahia["placar_visitante"] = 2, 1
    espn.aplicar_ajustes_calendario(gremio_events)
    assert gremio_bahia["data_iso"] == "2026-11-18T21:30"
    assert (gremio_bahia["placar_mandante"], gremio_bahia["placar_visitante"]) == (2, 1)

# O portal de credenciamento antigo não tem precedência sobre o PDF detalhado.
stale = SimpleNamespace(
    mandante=base["mandante"], visitante=base["visitante"],
    data_iso="2026-11-28T17:00", origem="https://credencial.cbf.com.br/competicoes/listar/42/1/"
)
cards = list(brasileirao_games(ROOT, set(), [stale]))
card = next(x for x in cards if x["rodada"] == 37
            and x["mandante"]["nome"] == base["mandante"]
            and x["visitante"]["nome"] == base["visitante"])
assert card["data_iso"].startswith(base["data_iso"]), card
assert "tabela detalhada" in card["fonte_calendario"], card

print("PASS CBF 2026: R37/R38 20/20 datas oficiais; R35 Grêmio x Bahia 21h30,"
      " ESPN deduplicado; FINAL protegido; credenciamento antigo sem precedência")
