#!/usr/bin/env python3
"""Sporting Snapshot Integrity Guard — R10R16.

Prova que resultados, calendário e AF representam a mesma fotografia esportiva.
É deliberadamente determinístico e é compartilhado pelo AF Fastlane e pelo
workflow completo do Brasileirão.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.fdg_reliability import (  # noqa: E402
    classify_exception,
    correlation_id,
    parse_iso,
    stable_hash,
    write_diagnostic,
)
from scripts.gerar_probabilidades_brasileirao import (  # noqa: E402
    load_current_matches,
    load_current_state,
    load_fixtures,
    sporting_fixture_key,
)

TOTAL_PARTIDAS = 380
SIMULACOES_CANONICAS = 2_000_000


def load(path: str) -> dict[str, Any]:
    return json.loads((ROOT / path).read_text(encoding="utf-8"))


def _team(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("nome") or value.get("name") or "").strip()
    return str(value or "").strip()


def validate_snapshot(*, profile: str = "full", event_id: str = "", trace_id: str = "") -> dict[str, Any]:
    tabela = load("tabela.json")
    resultados = load("resultados.json")
    eventos = load("espn_eventos.json")
    calendario = load("dados-br/calendario-completo.json")
    previsao = load("dados-br/probabilidades-brasileirao.json")
    probs_jogos = load("dados-br/probabilidades-jogos.json")
    aud_af = load("dados-br/auditoria-probabilidades.json")
    aud_jogos = load("dados-br/auditoria-probabilidades-jogos.json")

    state = load_current_state(tabela)
    allowed = set(state.teams)
    concluded = load_current_matches(eventos, allowed, resultados)
    concluded_ids = [str(item.source_id) for item in concluded]
    if len(concluded_ids) != len(set(concluded_ids)):
        raise AssertionError("EVENT_ID_DUPLICATE: event_id duplicado entre resultados concluídos")
    concluded_keys = {sporting_fixture_key(item.round_no, item.home, item.away) for item in concluded}
    if len(concluded_keys) != len(concluded):
        raise AssertionError("EVENT_ID_DUPLICATE: confronto concluído duplicado por identidade esportiva")

    final_by_id = {
        str(row.get("event_id") or ""): row
        for row in (resultados.get("resultados") or [])
        if str(row.get("estado") or "").lower() == "post" and row.get("event_id")
    }
    events_by_id = {str(row.get("event_id") or ""): row for row in (eventos.get("eventos") or []) if row.get("event_id")}
    regressions = []
    for eid, row in final_by_id.items():
        event = events_by_id.get(eid)
        if event and not (event.get("concluido") is True or str(event.get("estado") or "").lower() == "post"):
            regressions.append({"event_id": eid, "resultado": "post", "evento": event.get("estado")})
    if regressions:
        raise AssertionError(f"STATE_REGRESSION_AFTER_FINAL: FINAL regrediu em espn_eventos.json: {regressions[:5]}")

    remaining, _ = load_fixtures(
        calendario,
        set(concluded_ids),
        allowed,
        concluded_keys=concluded_keys,
    )
    remaining_map = {
        sporting_fixture_key(item.round_no, item.home, item.away): item
        for item in remaining
    }
    if len(remaining_map) != len(remaining):
        raise AssertionError("EVENT_ID_DUPLICATE: calendário restante contém confronto duplicado")

    game_rows = probs_jogos.get("jogos") or []
    game_map: dict[Any, dict[str, Any]] = {}
    prob_ids: list[str] = []
    for row in game_rows:
        eid = str(row.get("event_id") or "").strip()
        if not eid:
            raise AssertionError("AF_COVERAGE_MISMATCH: probabilidade pré-jogo sem event_id")
        prob_ids.append(eid)
        key = sporting_fixture_key(int(row.get("rodada") or 0), _team(row.get("mandante")), _team(row.get("visitante")))
        if key in game_map:
            raise AssertionError(f"EVENT_ID_DUPLICATE: confronto duplicado nas probabilidades: {key}")
        game_map[key] = row
    if len(prob_ids) != len(set(prob_ids)):
        raise AssertionError("EVENT_ID_DUPLICATE: event_id duplicado nas probabilidades por jogo")

    overlap = sorted(set(prob_ids) & set(concluded_ids))
    if overlap:
        raise AssertionError(f"AF_COVERAGE_MISMATCH: jogo concluído ainda aparece como pré-jogo: {overlap[:5]}")
    missing = sorted(set(remaining_map) - set(game_map))
    extra = sorted(set(game_map) - set(remaining_map))
    if missing or extra:
        raise AssertionError(
            "AF_COVERAGE_MISMATCH: cobertura das probabilidades por jogo diverge do calendário restante; "
            f"faltam={missing[:5]} sobram={extra[:5]}"
        )

    concluded_count = len(concluded)
    remaining_count = len(remaining)
    if concluded_count + remaining_count != TOTAL_PARTIDAS:
        raise AssertionError(
            f"CALENDAR_PARTITION_INVALID: concluídos={concluded_count} + restantes={remaining_count} != {TOTAL_PARTIDAS}"
        )

    base = previsao.get("base_corrente") or {}
    if int(base.get("partidas_concluidas") or -1) != concluded_count:
        raise AssertionError(
            f"AF_BASE_MISMATCH: base_corrente.partidas_concluidas={base.get('partidas_concluidas')} resultados={concluded_count}"
        )
    if int(base.get("partidas_restantes") or -1) != remaining_count or int(base.get("partidas_totais") or -1) != TOTAL_PARTIDAS:
        raise AssertionError(
            f"AF_BASE_MISMATCH: base_corrente incompatível com calendário; base={base} restantes={remaining_count}"
        )
    if int(probs_jogos.get("total_jogos") or -1) != remaining_count:
        raise AssertionError(
            f"AF_COVERAGE_MISMATCH: probabilidades-jogos total={probs_jogos.get('total_jogos')} restante={remaining_count}"
        )

    simulations = int((previsao.get("simulacao") or {}).get("quantidade") or 0)
    audit_simulations = int((aud_af.get("simulacao") or {}).get("quantidade") or 0)
    if simulations != SIMULACOES_CANONICAS or audit_simulations != SIMULACOES_CANONICAS:
        raise AssertionError(
            f"AF_SIMULATION_CONTRACT: esperado 2.000.000; previsão={simulations}; auditoria={audit_simulations}"
        )
    if previsao.get("status") != "ok" or aud_af.get("status") != "ok" or aud_jogos.get("status") != "ok":
        raise AssertionError("PUBLICATION_VALIDATION_FAILED: AF/auditorias sem status=ok")
    if aud_af.get("hash_entrada") != previsao.get("hash_entrada"):
        raise AssertionError("AUDIT_HASH_MISMATCH: hash_entrada do AF diverge da auditoria")
    if aud_jogos.get("hash_entrada") != probs_jogos.get("hash_entrada"):
        raise AssertionError("AUDIT_HASH_MISMATCH: hash_entrada das probabilidades por jogo diverge")
    expected_games_hash = hashlib.sha256(
        json.dumps(probs_jogos, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    ).hexdigest()
    if aud_jogos.get("hash_saida") != expected_games_hash:
        raise AssertionError("AUDIT_HASH_MISMATCH: hash_saida das probabilidades por jogo diverge")

    finals = [parse_iso(row.get("finalizado_em")) for row in final_by_id.values()]
    finals = [value for value in finals if value]
    latest_final = max(finals) if finals else None
    af_reference = parse_iso(previsao.get("referencia_esportiva_em"))
    if latest_final and (not af_reference or af_reference < latest_final):
        raise AssertionError(
            f"AF_REFERENCE_STALE: referencia={previsao.get('referencia_esportiva_em')} < final={latest_final.isoformat()}"
        )

    selected_event = str(event_id or "").strip()
    trace = trace_id or correlation_id(selected_event) if selected_event else (trace_id or "")
    report = {
        "schema_version": 1,
        "status": "ok",
        "profile": profile,
        "trace_id": trace,
        "event_id": selected_event,
        "invariants": {
            "final_monotonic": True,
            "no_final_in_pregame": True,
            "calendar_partition_380": True,
            "af_base_matches_results": True,
            "pregame_coverage_matches_calendar": True,
            "event_ids_unique": True,
            "af_reference_not_stale": True,
            "simulations_2m": True,
            "audit_hashes_match": True,
        },
        "metrics": {
            "concluded": concluded_count,
            "remaining": remaining_count,
            "total": TOTAL_PARTIDAS,
            "simulations": simulations,
            "latest_final": latest_final.isoformat() if latest_final else "",
            "af_reference": af_reference.isoformat() if af_reference else "",
            "sporting_state_hash": stable_hash({"concluded": sorted(concluded_keys), "remaining": sorted(remaining_map)}),
        },
    }
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", choices=["fastlane", "full", "ci"], default="full")
    parser.add_argument("--event-id", default="")
    parser.add_argument("--trace-id", default=os.environ.get("FDG_TRACE_ID", ""))
    parser.add_argument("--diagnostic", default="artifacts/reliability/fdg-diagnostico.json")
    parser.add_argument("--report", default="artifacts/reliability/sporting-integrity.json")
    args = parser.parse_args()
    try:
        report = validate_snapshot(profile=args.profile, event_id=args.event_id, trace_id=args.trace_id)
        out = ROOT / args.report
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(
            "Sporting Snapshot Integrity: PASS — "
            f"{report['metrics']['concluded']} concluídos + {report['metrics']['remaining']} restantes; "
            "AF=2.000.000 simulações."
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        code = classify_exception(exc)
        write_diagnostic(
            args.diagnostic,
            code=code,
            message=str(exc),
            trace_id=args.trace_id,
            profile=args.profile,
            context={"event_id": args.event_id},
        )
        print(f"::error title={code}::{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
