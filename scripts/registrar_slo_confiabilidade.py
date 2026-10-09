#!/usr/bin/env python3
"""Registra observações mensuráveis de SLO da cadeia pós-FINAL."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from scripts.fdg_reliability import correlation_id, iso_brt, load_json, minutes_between  # noqa: E402

TARGETS = {"final_to_detection": 5, "final_to_results": 7, "final_to_af": 10, "commit_to_site": 5}
OUTPUT = ROOT / "dados-br/slo-confiabilidade.json"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--event-id", required=True)
    ap.add_argument("--trace-id", default=os.environ.get("FDG_TRACE_ID", ""))
    args = ap.parse_args()
    results = load_json("resultados.json")
    probs = load_json("dados-br/probabilidades-brasileirao.json")
    row = next((x for x in results.get("resultados") or [] if str(x.get("event_id")) == str(args.event_id)), None)
    if not row:
        print(f"::warning::SLO não registrado: event_id {args.event_id} ainda não está em resultados.json")
        return 0
    final_at = row.get("finalizado_em") or row.get("data_iso")
    af_at = probs.get("calculado_em") or probs.get("gerado_em")
    value = minutes_between(final_at, af_at)
    trace = args.trace_id or correlation_id(args.event_id)
    previous = load_json(OUTPUT, default={}) if OUTPUT.exists() else {}
    observations = list(previous.get("observacoes") or [])
    observation = {
        "trace_id": trace,
        "event_id": str(args.event_id),
        "finalizado_em": final_at,
        "af_calculado_em": af_at,
        "final_para_af_minutos": value,
        "alvo_minutos": TARGETS["final_to_af"],
        "dentro_slo": value is not None and value <= TARGETS["final_to_af"],
        "registrado_em": iso_brt(),
        "run_id": str(os.environ.get("GITHUB_RUN_ID") or ""),
    }
    observations = [x for x in observations if x.get("trace_id") != trace]
    observations.append(observation)
    observations = observations[-100:]
    values = [float(x["final_para_af_minutos"]) for x in observations if x.get("final_para_af_minutos") is not None]
    payload = {
        "schema_version": 1,
        "atualizado_em": iso_brt(),
        "targets_minutos": TARGETS,
        "ultima_observacao": observation,
        "resumo": {
            "amostra_final_para_af": len(values),
            "media_final_para_af_minutos": round(sum(values) / len(values), 3) if values else None,
            "violacoes_final_para_af": sum(1 for x in observations if x.get("dentro_slo") is False),
        },
        "observacoes": observations,
    }
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"SLO registrado: trace={trace}; FINAL→AF={value} min; alvo={TARGETS['final_to_af']} min")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
