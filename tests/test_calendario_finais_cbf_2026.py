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
from scripts.gerar_agenda_clubes_brasileirao import (
    brasileirao_games, apply_official_cbf_overrides,
)  # noqa: E402

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
def name(value):
    return value.get("nome") if isinstance(value, dict) else value

def identity(row):
    return (int(row.get("rodada") or 0), name(row.get("mandante")), name(row.get("visitante")))

def final(row):
    return row.get("estado") == "post" or row.get("concluido") is True

from scripts.gerar_auditoria_calendario import normalizar_estadio_cbf
results = [x for x in load("resultados.json")["resultados"] if x.get("rodada") in (37,38)]
by_final = {identity(x): x for x in results}
assert len(by_final) == len(results)
assert all(final(x) and all(type(x.get(k)) is int and x[k]>=0 for k in ("placar_mandante","placar_visitante")) for x in results)
for r in (37,38):
    expected = {identity(x) for x in fixes if x["rodada"]==r}
    assert len(expected)==10
    assert len({t for x in fixes if x["rodada"]==r for t in (x["mandante"],x["visitante"])})==20
    completed = {k for k in by_final if k[0]==r}
    assert completed <= expected
    for key, matches in sources.items():
        arr=[x for x in matches if x.get("rodada")==r]
        actual={identity(x) for x in arr}
        assert len(actual)==len(arr), (key,r,"duplicates")
        target=expected-completed if key in ("jogos","agenda") else expected
        assert actual==target, (key,r,"missing",target-actual,"extra",actual-target)

for fix in fixes:
    expected=fix["data_iso"]
    assert (24 <= int(expected[8:10]) <= 29) if fix["rodada"] == 37 else expected == "2026-12-02T21:30"
    assert fix["origem_calendario"].endswith(".pdf")
    assert fix["fonte_calendario"].startswith("CBF oficial — tabela detalhada")
    if fix["rodada"]==38:
        assert fix["event_id"]==f"cbf-2026-{fix['referencia_cbf']}"
    else:
        assert fix["event_id"].isdigit()
    ident=identity(fix)
    completed=by_final.get(ident)
    canonical=next(x for x in sources["eventos"] if identity(x)==ident)
    canonical_id=str(canonical["event_id"])
    assert canonical_id==str(fix["event_id"]) or (fix["rodada"]==38 and canonical_id.isdigit())
    rows=[("resultados",completed)] if completed else []
    rows.extend((key,x) for key,matches in sources.items() for x in matches if identity(x)==ident)
    for key,row in rows:
        assert str(row.get("data_iso")).startswith(expected), (key,ident,row.get("data_iso"))
        assert normalizar_estadio_cbf(row.get("estadio"))==normalizar_estadio_cbf(fix["estadio"]), (key,ident,row.get("estadio"))
        assert row.get("data_definir") is not True
        assert str(row.get("event_id"))==canonical_id, (key,ident,"ID mismatch")
        if completed:
            assert final(row), (key,ident,"FINAL regressed")
            if key in ("resultados","eventos"):
                assert all(row.get(k)==completed.get(k) for k in ("placar_mandante","placar_visitante"))
        else:
            assert not final(row)
            assert "CBF oficial — tabela detalhada" in row.get("fonte_calendario",""), (key,ident)

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

# O regenerador do site deve manter a prova CBF mesmo que o feed ESPN
# publique 17h ou já traga 21h30 sem a fonte oficial.
stale_card = {
    "event_id": "401841312", "competicao_chave": "brasileirao", "rodada": 35,
    "mandante": {"nome": "Grêmio"}, "visitante": {"nome": "Bahia"},
    "estado": "pre", "concluido": False,
    "data_iso": "2026-11-18T17:00", "fonte_calendario": "ESPN",
    "origem_calendario": "",
}
reconciled = apply_official_cbf_overrides([stale_card], ROOT)[0]
assert reconciled["data_iso"] == "2026-11-18T21:30"
assert reconciled["fonte_calendario"] == r35["fonte_calendario"]
assert reconciled["origem_calendario"] == r35["origem_calendario"]
assert reconciled["data_fonte_anterior"] == "2026-11-18T17:00"
assert stale_card["data_iso"] == "2026-11-18T17:00", "Fonte não pode ser alterada in-place"
already_correct = apply_official_cbf_overrides(
    [{**stale_card, "data_iso": "2026-11-18T21:30"}], ROOT
)[0]
assert already_correct["fonte_calendario"].startswith("CBF oficial")
assert "data_fonte_anterior" not in already_correct
for other in (
    {**stale_card, "estado": "in"},
    {**stale_card, "estado": "post", "concluido": True},
    {**stale_card, "event_id": "401841313"},
    {**stale_card, "mandante": {"nome": "Flamengo"}},
):
    original = dict(other)
    assert apply_official_cbf_overrides([other], ROOT)[0] == original

# O portal de credenciamento antigo não tem precedência sobre o PDF detalhado.
stale = SimpleNamespace(
    mandante=base["mandante"], visitante=base["visitante"],
    data_iso="2026-11-28T17:00", origem="https://credencial.cbf.com.br/competicoes/listar/42/1/"
)
cards = list(brasileirao_games(ROOT, set(), [stale]))
matching_cards = [x for x in cards if x["rodada"] == 37
            and x["mandante"]["nome"] == base["mandante"]
            and x["visitante"]["nome"] == base["visitante"]]
if identity(base) in by_final:
    assert not matching_cards, "FINAL cannot return to future agenda"
else:
    assert len(matching_cards)==1
    card=matching_cards[0]
    assert card["data_iso"].startswith(base["data_iso"]), card
    assert "tabela detalhada" in card["fonte_calendario"], card

print("PASS CBF 2026: R37/R38 20/20 datas oficiais; R35 Grêmio x Bahia 21h30,"
      " ESPN deduplicado; FINAL protegido; credenciamento antigo sem precedência")
