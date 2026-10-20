#!/usr/bin/env python3
"""AF Fastlane R10R22 — recupera dessincronia transitória sem publicar AF incorreto.

O gate usa EXATAMENTE o mesmo preflight do reconciliador do AF. Apenas o
caso diagnosticado de atraso entre standings e resultados ESPN é retentável.
Demais falhas de integridade continuam bloqueantes (exit 1).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.gerar_probabilidades_brasileirao import current_publication_freshness  # noqa: E402

ESPN_STANDINGS_LAG = "feeds da ESPN temporariamente fora de sincronia; resultados concluídos divergem da tabela oficial:"
DEFAULT_RETRIES = 2
DEFAULT_WAIT_SECONDS = 25


def classify_readiness(snapshot: dict[str, Any]) -> str:
    """ready, deferred ou fatal: nunca converter erro genérico em verde."""
    if snapshot.get("estado_pronto") is True:
        return "ready"
    reasons = snapshot.get("motivos") or []
    if (
        isinstance(reasons, list)
        and len(reasons) == 1
        and isinstance(reasons[0], str)
        and reasons[0].startswith(ESPN_STANDINGS_LAG)
    ):
        return "deferred"
    return "fatal"


def write_outputs(state: str, reason: str, attempts: int) -> None:
    output = str(os.environ.get("GITHUB_OUTPUT") or "").strip()
    if not output:
        return
    values = {
        "ready": str(state == "ready").lower(),
        "deferred": str(state == "deferred").lower(),
        "classification": state,
        "refresh_attempts": str(attempts),
        "reason": " ".join(reason.split())[:600],
    }
    with Path(output).open("a", encoding="utf-8", newline="\n") as file:
        for key, value in values.items():
            file.write(f"{key}={value}\n")


def refresh_espn() -> None:
    env = dict(os.environ)
    # Tentativas externas limitadas. Não forçar resultados nem alterar overrides.
    env["ESPN_MAX_TENTATIVAS_SINCRONIA"] = "1"
    env["ESPN_ESPERA_SINCRONIA_SEGUNDOS"] = "0"
    subprocess.run([sys.executable, str(ROOT / "atualizar_espn.py")], cwd=ROOT, env=env, check=True)
    subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "gerar_agenda_clubes_brasileirao.py")],
        cwd=ROOT, env=env, check=True,
    )


def check_with_retries(retries: int, wait_seconds: int) -> tuple[str, str, int]:
    for attempt in range(retries + 1):
        freshness = current_publication_freshness()
        state = classify_readiness(freshness)
        reason = "; ".join(str(x) for x in (freshness.get("motivos") or []))
        print(f"AF sync gate: {state}; refreshes={attempt}/{retries}; reason={reason or 'modelo esportivo válido'}", flush=True)
        if state != "deferred" or attempt >= retries:
            return state, reason, attempt
        print(f"::notice title=AF aguardando ESPN::Rechecagem controlada em {wait_seconds}s ({attempt+1}/{retries}).", flush=True)
        time.sleep(wait_seconds)
        refresh_espn()
    raise AssertionError("unreachable")


def self_test() -> None:
    assert classify_readiness({"estado_pronto": True, "motivos": ["AF antigo, mas base íntegra"]}) == "ready"
    assert classify_readiness({"estado_pronto": False, "motivos": [
        ESPN_STANDINGS_LAG + " Vitória jogos=30/31; Corinthians jogos=30/31"
    ]}) == "deferred"
    for bad in (
        {"estado_pronto": False, "motivos": ["hash continental inválido"]},
        {"estado_pronto": False, "motivos": ["resultados e calendário atuais não totalizam 380 partidas"]},
        {"estado_pronto": False, "motivos": []},
        {"estado_pronto": False, "motivos": [
            ESPN_STANDINGS_LAG + " jogo=30/31", "EVENT_ID_DUPLICATE"
        ]},
        {"estado_pronto": False, "motivos": ["ESPN error 500"]},
        {"estado_pronto": None, "motivos": []},
    ):
        assert classify_readiness(bad) == "fatal", bad
    # Retentativa simulada: o guard só libera o AF após obter prova objetiva
    # de consistência. Não usa rede, não executa simulações nem grava D1.
    from unittest.mock import patch

    lag = {"estado_pronto": False, "motivos": [
        ESPN_STANDINGS_LAG + " Vitória jogos=30/31; Corinthians jogos=30/31"
    ]}
    ready = {"estado_pronto": True, "motivos": ["AF ainda precisa ser atualizado"]}
    fatal = {"estado_pronto": False, "motivos": ["AF_COVERAGE_MISMATCH"]}

    with (
        patch(__name__ + ".current_publication_freshness", side_effect=[lag, lag, ready]),
        patch(__name__ + ".refresh_espn") as refresh,
        patch(__name__ + ".time.sleep") as sleep,
    ):
        state, _, attempts = check_with_retries(2, 0)
        assert state == "ready" and attempts == 2
        assert refresh.call_count == 2 and sleep.call_count == 2

    with (
        patch(__name__ + ".current_publication_freshness", side_effect=[lag, lag, lag]),
        patch(__name__ + ".refresh_espn") as refresh,
    ):
        state, _, attempts = check_with_retries(2, 0)
        assert state == "deferred" and attempts == 2
        assert refresh.call_count == 2

    with (
        patch(__name__ + ".current_publication_freshness", return_value=fatal),
        patch(__name__ + ".refresh_espn") as refresh,
    ):
        state, _, attempts = check_with_retries(2, 0)
        assert state == "fatal" and attempts == 0
        refresh.assert_not_called()

    # O modo deferred nunca deve declarar ready=true, mesmo com job encerrado 0.
    import tempfile
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "outputs"
        with patch.dict(os.environ, {"GITHUB_OUTPUT": str(path)}):
            write_outputs("deferred", lag["motivos"][0], 2)
        outputs = path.read_text(encoding="utf-8")
        assert "ready=false" in outputs and "deferred=true" in outputs
        assert "classification=deferred" in outputs
    print("R10R22 AF sync gate: PASS (ready/deferred/fatal + bounded retries + outputs)", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--max-retries", type=int, default=DEFAULT_RETRIES)
    parser.add_argument("--wait-seconds", type=int, default=DEFAULT_WAIT_SECONDS)
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    retries = max(0, min(3, args.max_retries))
    wait = max(0, min(60, args.wait_seconds))
    state, reason, attempts = check_with_retries(retries, wait)
    write_outputs(state, reason, attempts)
    if state == "ready":
        print("::notice title=AF Ready::Standings, FINAL e calendário fecharam no guard do AF. Permitido recalcular.", flush=True)
        return 0
    if state == "deferred":
        print("::warning title=AF DEFERRED — ESPN ainda dessincronizada::Nenhum AF novo será publicado. Disparar recuperação controlada.", flush=True)
        return 0
    print("::error title=AF Sporting Integrity BLOCKED::" + (reason or "falha de integridade não classificável"), flush=True)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
