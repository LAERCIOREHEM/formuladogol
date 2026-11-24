#!/usr/bin/env python3
"""CBF R36-R38 + Copa do Brasil: auditoria documental da reta final de 2026."""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://stcbfsiteprdimgbrs.blob.core.windows.net/img-site/cdn/"
OFFICIAL = (
    ("Internacional", "Vitória", "2026-11-23T19:30", "Beira-Rio", 36, 357),
    ("Botafogo", "São Paulo", "2026-11-23T20:00", "Nilton Santos", 36, 352),
    ("Santos", "Grêmio", "2026-11-23T21:00", "Morumbis", 36, 353),
    ("Atlético-MG", "Corinthians", "2026-11-25T20:00", "Arena MRV", 36, 356),
    ("Chapecoense", "Palmeiras", "2026-11-24T18:00", "Arena Condá", 37, 370),
    ("São Paulo", "Remo", "2026-11-26T20:00", "Morumbis", 37, 363),
    ("Fluminense", "Cruzeiro", "2026-11-27T20:00", "Maracanã", 37, 361),
    ("Botafogo", "Bahia", "2026-11-28T21:00", "Nilton Santos", 37, 362),
    ("Coritiba", "Flamengo", "2026-11-29T16:00", "Couto Pereira", 37, 368),
    ("Vitória", "Santos", "2026-11-29T16:00", "Barradão", 37, 369),
    ("Corinthians", "Grêmio", "2026-11-29T18:30", "Neo Química Arena", 37, 364),
    ("Mirassol", "Athletico-PR", "2026-11-29T18:30", "José Maria de Campos Maia", 37, 365),
    ("Internacional", "Bragantino", "2026-11-29T18:30", "Beira-Rio", 37, 367),
    ("Atlético-MG", "Vasco da Gama", "2026-11-29T19:30", "Arena MRV", 37, 366),
    ("Flamengo", "Chapecoense", "2026-12-02T21:30", "Maracanã", 38, 371),
    ("Vasco da Gama", "Vitória", "2026-12-02T21:30", "São Januário", 38, 372),
    ("Santos", "Botafogo", "2026-12-02T21:30", "Vila Belmiro", 38, 373),
    ("Palmeiras", "Coritiba", "2026-12-02T21:30", "Nubank Parque", 38, 374),
    ("Bragantino", "Fluminense", "2026-12-02T21:30", "Cícero de Souza Marques", 38, 375),
    ("Cruzeiro", "Internacional", "2026-12-02T21:30", "Mineirão", 38, 376),
    ("Grêmio", "Mirassol", "2026-12-02T21:30", "Arena do Grêmio", 38, 377),
    ("Athletico-PR", "São Paulo", "2026-12-02T21:30", "Arena da Baixada", 38, 378),
    ("Bahia", "Atlético-MG", "2026-12-02T21:30", "Arena Fonte Nova", 38, 379),
    ("Remo", "Corinthians", "2026-12-02T21:30", "Mangueirão", 38, 380),
)


def read(path: str) -> dict:
    return json.loads((ROOT / path).read_text(encoding="utf-8"))


def name(value):
    return str(value.get("nome") or "") if isinstance(value, dict) else str(value or "")


def match(rows, home, away, rd=None):
    return [
        item for item in rows
        if name(item.get("mandante")) == home and name(item.get("visitante")) == away
        and (rd is None or int(item.get("rodada") or 0) == rd)
    ]


def same_kickoff(value: str, expected: str) -> bool:
    if not value:
        return False
    if value.startswith(expected):
        return True
    try:
        first = datetime.fromisoformat(value.replace("Z", "+00:00"))
        second = datetime.fromisoformat(expected + ":00-03:00")
        return first.tzinfo is not None and first == second
    except ValueError:
        return False


fixes = read("dados-br/ajustes-calendario.json")["ajustes"]
assert len(OFFICIAL) == 24
assert len({(home, away) for home, away, *_ in OFFICIAL}) == 24
for rnd, count in ((36, 4), (37, 10), (38, 10)):
    assert len([x for x in OFFICIAL if x[4] == rnd]) == count

sources = {
    "jogos": read("jogos.json")["jogos"],
    "eventos": read("espn_eventos.json")["eventos"],
    "calendario": read("dados-br/calendario-completo.json")["jogos"],
    "agenda": [x for x in read("dados-br/agenda-clubes-br.json")["jogos"] if x.get("competicao_chave") == "brasileirao"],
}
assert len(read("dados-br/calendario-completo.json")["jogos"]) == 380
for home, away, dt, stadium, rd, ref in OFFICIAL:
    fix = match(fixes, home, away, rd)
    assert len(fix) == 1, ("ajuste CBF ausente ou duplicado", home, away)
    fix = fix[0]
    assert fix["data_iso"] == dt and fix["estadio"] == stadium, (home, away, fix)
    assert fix["referencia_cbf"] == ref
    assert fix["fonte_calendario"].startswith("CBF oficial — tabela detalhada")
    completed = match(read("resultados.json")["resultados"], home, away, rd)
    assert len(completed)<=1,("FINAL duplicado",home,away)
    if completed:
        result=completed[0]
        assert result.get("estado")=="post",("histórico sem FINAL",home,away)
        assert same_kickoff(str(result.get("data_iso") or ""),dt),(home,away,"horário FINAL")
        assert all(isinstance(result.get(k),int) and result[k]>=0 for k in ("placar_mandante","placar_visitante"))
    for source_name, rows in sources.items():
        games = match(rows, home, away, rd)
        if completed and source_name=="jogos":
            assert not games,("FINAL na lista futura",home,away)
            continue
        if completed and source_name=="agenda" and not games:
            continue
        assert len(games) == 1, (source_name, home, away, len(games))
        game = games[0]
        assert same_kickoff(str(game.get("data_iso") or ""), dt), (source_name, home, away, game.get("data_iso"))
        if completed and source_name in {"eventos","agenda"}:
            assert game.get("estado")=="post" or game.get("concluido") is True,("FINAL regrediu",source_name,home,away)
        if not completed or source_name=="calendario":
            assert game.get("estadio") == stadium, (source_name, home, away, game.get("estadio"))
            assert game.get("data_definir") is not True, (source_name, home, away)

assert not any(str(x.get("data_iso") or "").startswith("2026-11-23T17:00")
               for x in match(sources["agenda"], "Botafogo", "São Paulo", 36))

cup = read("dados-br/competicoes-af-previsao/copa-do-brasil.json")
final = [x for x in cup["eventos"] if int(x.get("fase_ordem") or 0) == 900]
assert len(final) == 1
cup_event = final[0]
assert {name(cup_event["mandante"]), name(cup_event["visitante"])} == {"Grêmio", "Palmeiras"}
assert same_kickoff(str(cup_event["data_iso"]), "2026-12-06T16:00")
assert cup_event["estadio"] == "Mané Garrincha"
adjustments = read("dados-br/ajustes-competicoes.json")
override = adjustments["eventos"].get(str(cup_event["event_id"]))
assert override and override["fonte"] == "cbf_final_copa_do_brasil_2026"
assert same_kickoff(str(override["data_iso"]), "2026-12-06T16:00")
cup_agenda = match(read("dados-br/agenda-clubes-br.json")["jogos"], "Grêmio", "Palmeiras")
assert len(cup_agenda) == 1 and same_kickoff(cup_agenda[0]["data_iso"], "2026-12-06T16:00")
print("CBF RETA FINAL PASS: 24 partidas Série A R36-R38 + 1 final Copa do Brasil, 4 feeds, horários e locais certificados")
