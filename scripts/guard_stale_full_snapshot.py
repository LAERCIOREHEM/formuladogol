#!/usr/bin/env python3
"""Fail-closed guard: a slow full ESPN rebuild must not regress Fastlane FINAL.

Invoked after fetch/reset of origin/main and BEFORE copying artifacts collected
earlier. Checks every already-published FINAL by immutable ESPN event identity,
clubs and score. This is intentionally independent of clocks and total counts.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Mapping


def verified_finals(document: Mapping[str, Any]) -> dict[str, tuple[str, str, int, int]]:
    finals: dict[str, tuple[str, str, int, int]] = {}
    for row in document.get("resultados") or []:
        if not isinstance(row, dict) or str(row.get("estado") or "") != "post":
            continue
        event_id = str(row.get("event_id") or "").strip()
        home, away = row.get("mandante"), row.get("visitante")
        home = str(home.get("nome") or "") if isinstance(home, dict) else str(home or "")
        away = str(away.get("nome") or "") if isinstance(away, dict) else str(away or "")
        a, b = row.get("placar_mandante"), row.get("placar_visitante")
        if not event_id or not home or not away or isinstance(a, bool) or isinstance(b, bool):
            raise ValueError("FINAL canônico sem identificação completa")
        if not isinstance(a, int) or not isinstance(b, int) or a < 0 or b < 0:
            raise ValueError(f"FINAL {event_id} com placar inválido")
        candidate = (home, away, a, b)
        if event_id in finals and finals[event_id] != candidate:
            raise ValueError(f"FINAL duplicado e contraditório: {event_id}")
        finals[event_id] = candidate
    return finals


def validate_not_stale(candidate: Mapping[str, Any], published: Mapping[str, Any]) -> None:
    new, old = verified_finals(candidate), verified_finals(published)
    lost = sorted(set(old) - set(new))
    changed = sorted(k for k in old.keys() & new.keys() if old[k] != new[k])
    if lost or changed:
        raise ValueError(
            f"Coleta completa obsoleta: {len(lost)} FINAL(is) novos ausentes, "
            f"{len(changed)} placar(es)/identidade divergentes. "
            f"IDs: {(lost + changed)[:10]}. Publicação bloqueada; não reabrir FINALS."
        )


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("Uso: guard_stale_full_snapshot.py CANDIDATO_RESULTADOS PUBLISHED_RESULTADOS")
        return 2
    try:
        candidate = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
        published = json.loads(Path(argv[2]).read_text(encoding="utf-8"))
        validate_not_stale(candidate, published)
        print(f"FINAL MONOTÔNICO: {len(verified_finals(published))} registros preservados")
    except (ValueError, OSError, TypeError, json.JSONDecodeError) as exc:
        print(f"::warning title=Reconstrução obsoleta preservada::{exc}")
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
