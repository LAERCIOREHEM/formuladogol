#!/usr/bin/env python3
"""R10R26: trava factual das semifinais continentais contra agenda CONMEBOL.

Somente resultados esportivos estruturados podem declarar FINAL. A agenda
oficial não fornece placares: serve para detectar jogos já iniciados que
desapareceram dos snapshots e impedir probabilidades/editoriais defasados.
"""
from __future__ import annotations

import argparse
import json
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping

ROOT = Path(__file__).resolve().parent.parent
OFFICIAL = ROOT / "dados-br/correcoes/agenda-continentais-oficial.json"
SNAPSHOTS = {
    "libertadores": ROOT / "dados-br/competicoes-af-previsao/libertadores.json",
    "sul_americana": ROOT / "dados-br/competicoes-af-previsao/sul-americana.json",
}


def key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", unicodedata.normalize("NFD", str(value or "").lower()).encode("ascii", "ignore").decode()).strip()


def when(value: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)
    except (ValueError, TypeError, AttributeError):
        return None


def team(event: Mapping[str, Any], side: str) -> str:
    return key((event.get(side) or {}).get("nome"))


def coverage_gaps(
    agenda: Mapping[str, Any],
    snapshots: Mapping[str, Mapping[str, Any]],
    *,
    now: datetime | None = None,
    start_grace_hours: int = 2,
    final_grace_hours: int = 4,
) -> list[dict[str, str]]:
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise ValueError("now precisa ter timezone")
    if not isinstance(agenda.get("jogos"), list) or not agenda["jogos"]:
        raise ValueError("agenda CONMEBOL oficial ausente ou vazia")
    gaps: list[dict[str, str]] = []
    for fixture in agenda["jogos"]:
        comp = str(fixture.get("competicao_chave") or "")
        if comp not in SNAPSHOTS:
            continue
        kickoff = when(fixture.get("data_iso"))
        if not kickoff or kickoff > now - timedelta(hours=start_grace_hours):
            continue
        home, away = team(fixture, "mandante"), team(fixture, "visitante")
        if not home or not away:
            raise ValueError("agenda CONMEBOL sem clubes identificáveis")
        events = (snapshots.get(comp) or {}).get("eventos") or []
        matched = [
            event for event in events
            if team(event, "mandante") == home
            and team(event, "visitante") == away
            and (date := when(event.get("data_iso"))) is not None
            and abs((date - kickoff).total_seconds()) <= 12 * 3600
        ]
        if not matched:
            gaps.append({"competicao": comp, "data_iso": str(fixture["data_iso"]), "jogo": f"{home} x {away}", "motivo": "ausente_do_snapshot"})
        elif kickoff <= now - timedelta(hours=final_grace_hours) and not any(bool(event.get("concluido")) for event in matched):
            gaps.append({"competicao": comp, "data_iso": str(fixture["data_iso"]), "jogo": f"{home} x {away}", "motivo": "final_nao_confirmado"})
    return gaps


def load_coverage(*, now: datetime | None = None) -> list[dict[str, str]]:
    agenda = json.loads(OFFICIAL.read_text(encoding="utf-8"))
    snapshots = {comp: json.loads(path.read_text(encoding="utf-8")) for comp, path in SNAPSHOTS.items()}
    return coverage_gaps(agenda, snapshots, now=now)


def self_test() -> None:
    fixture = {"competicao_chave": "sul_americana", "data_iso": "2026-10-20T21:30:00-03:00",
               "mandante": {"nome": "Vasco da Gama"}, "visitante": {"nome": "Boca Juniors"}}
    event = {"data_iso": fixture["data_iso"], "mandante": fixture["mandante"], "visitante": fixture["visitante"], "concluido": False}
    before = datetime.fromisoformat("2026-10-20T22:00:00-03:00")
    after = datetime.fromisoformat("2026-10-21T02:00:00-03:00")
    assert not coverage_gaps({"jogos": [fixture]}, {}, now=before)
    missing = coverage_gaps({"jogos": [fixture]}, {}, now=after)
    assert len(missing) == 1 and missing[0]["motivo"] == "ausente_do_snapshot"
    pending = coverage_gaps({"jogos": [fixture]}, {"sul_americana": {"eventos": [event]}}, now=after)
    assert len(pending) == 1 and pending[0]["motivo"] == "final_nao_confirmado"
    event["concluido"] = True
    assert not coverage_gaps({"jogos": [fixture]}, {"sul_americana": {"eventos": [event]}}, now=after)
    wrong = {**event, "visitante": {"nome": "River Plate"}}
    assert coverage_gaps({"jogos": [fixture]}, {"sul_americana": {"eventos": [wrong]}}, now=after)
    assert not coverage_gaps({"jogos": [fixture]}, {"sul_americana": {"eventos": [event]}}, now=before)
    print("R10R26 cobertura continental: self-test OK")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
    else:
        gaps = load_coverage()
        print(json.dumps({"ok": not gaps, "pendencias": gaps}, ensure_ascii=False))
        if args.strict and gaps:
            raise SystemExit(2)
