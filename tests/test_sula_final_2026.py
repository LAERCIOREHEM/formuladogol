#!/usr/bin/env python3
"""Regression contract: Copa Sul-Americana 2026 final in all published surfaces."""
from __future__ import annotations
import copy
import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(ROOT))

from scripts.gerar_agenda_clubes_brasileirao import build, merge_schedule_candidates
from scripts.atualizar_competicoes_af_previsao import COMPETITIONS, apply_confirmed_event_overrides
from scripts.atualizar_transmissoes_tv_brasileirao import manual_policy_for_game, Evidence, consolidate_game

ID = "401913961"
DATE = "2026-11-21T20:00:00-03:00"
SOURCE = "https://www.uol.com.br/esporte/ultimas-noticias/agencia/2026/10/30/final-da-sul-americana-entre-atletico-mg-e-boca-juniors-tem-horario-definido.htm"

def load(path):
    return json.loads((ROOT / path).read_text(encoding="utf-8"))

def test():
    overrides = load("dados-br/ajustes-competicoes.json")
    override = overrides["eventos"][ID]
    assert override["data_iso"] == DATE
    assert overrides["fontes"][override["fonte"]] == SOURCE

    snapshot = load("dados-br/competicoes-af-previsao/sul-americana.json")
    matches = [x for x in snapshot["eventos"] if str(x.get("event_id")) == ID]
    assert len(matches) == 1
    event = matches[0]
    assert event["data_iso"] == DATE
    assert event["fase"] == "Final" and event["concluido"] is False
    assert event["mandante"]["nome"] == "Atlético-MG"
    assert event["visitante"]["nome"] == "Boca Juniors"
    assert event["estadio"] == "Metropolitano Roberto Meléndez"

    spec = next(x for x in COMPETITIONS if x.key == "sul_americana")
    original = copy.deepcopy(event)
    original["data_iso"] = "2026-11-21T17:00:00-03:00"
    assert apply_confirmed_event_overrides(spec, [original]) > 0
    assert original["data_iso"] == DATE, "ESPN provisional time must not overwrite official kick-off"

    official = load("dados-br/correcoes/agenda-continentais-oficial.json")
    official_matches = [x for x in official["jogos"]
                        if x.get("fase") == "Final" and x.get("competicao_chave") == "sul_americana"]
    assert len(official_matches) == 1
    assert official_matches[0]["data_iso"] == DATE

    built = build(ROOT, datetime.fromisoformat("2026-10-31T08:00:00-03:00"), [])
    final = [x for x in built["jogos"] if x.get("competicao_chave") == "sul_americana"
             and x["mandante"]["nome"] == "Atlético-MG" and x["visitante"]["nome"] == "Boca Juniors"]
    assert len(final) == 1, "must not duplicate final between ESPN and CONMEBOL documentary fallback"
    assert final[0]["event_id"] == ID
    assert final[0]["data_iso"] == DATE
    assert built["integridade_continental"]["status"] == "ok"

    saved = load("dados-br/agenda-clubes-br.json")
    saved_final = [x for x in saved["jogos"] if x.get("event_id") == ID]
    assert len(saved_final) == 1
    assert saved_final[0]["data_iso"] == DATE

    manual = load("transmissoes.json")
    policy = manual_policy_for_game(manual, saved_final[0])
    assert policy["modo"] == "fixo"
    assert policy["exibicao_confirmada"] == "Disney+ Premium"
    disney = "https://www.disneyplus.com/pt-br/explore/articles/semifinais-libertadores-2026"
    selection = consolidate_game(
        saved_final[0],
        [Evidence("override editorial — transmissoes.json", ["Disney+ / ESPN"], disney, "2026-10-31T08:14:00-03:00", 1000)],
        automatic_sources_responded=False,
        manual_policy=policy,
    )
    assert selection is not None
    assert selection["exibicao_confirmada"] == "Disney+ Premium"
    assert selection["canais"] == ["Disney+ / ESPN"]
    published_tv = load("dados-br/transmissoes-tv.json")["jogos"][ID]
    assert published_tv["data_iso"] == DATE
    assert published_tv["exibicao_confirmada"] == "Disney+ Premium"
    assert published_tv["acessos"][0]["url"].startswith("https://www.disneyplus.com/")
    print("SULA FINAL 2026: 10/10 editorial, ESPN-ID, schedule, dedupe, transmission PASS")

if __name__ == "__main__":
    test()
