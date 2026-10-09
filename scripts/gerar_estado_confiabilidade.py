#!/usr/bin/env python3
"""Publica o estado CORE/ENRICHMENT do Reliability Control Plane."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from scripts.fdg_reliability import iso_brt, load_json, reliability_state  # noqa: E402
from scripts.validar_snapshot_esportivo import validate_snapshot  # noqa: E402

OUTPUT = ROOT / "dados-br/estado-confiabilidade.json"


def _pending_public() -> int:
    audit = load_json("dados-br/auditoria-publicos.json", default={})
    if isinstance(audit.get("sem_publico"), list):
        return len(audit["sem_publico"])
    return int(audit.get("total_partidas_fisicas_sem_publico") or 0)


def _pending_highlights() -> int:
    audit = load_json("dados-br/auditoria-melhores-momentos.json", default={})
    for key in ("pendentes", "sem_melhores_momentos", "faltantes"):
        if isinstance(audit.get(key), list):
            return len(audit[key])
    resumo = audit.get("resumo") or {}
    return int(resumo.get("pendentes") or 0)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default="full")
    args = ap.parse_args()
    report = validate_snapshot(profile=args.profile)
    status_update = load_json("dados-br/status-atualizacao.json", default={})
    public_pending = _pending_public()
    mm_pending = _pending_highlights()
    source_degraded = str(status_update.get("status") or "").lower() in {"erro", "preservado"} or status_update.get("sincronizado") is False
    state = reliability_state(core_ok=True, source_degraded=source_degraded, enrichment_pending=public_pending + mm_pending)
    slo = load_json("dados-br/slo-confiabilidade.json", default={})
    payload = {
        "schema_version": 1,
        "atualizado_em": iso_brt(),
        "state": state,
        "core": {
            "status": "ok",
            "sporting_integrity": "ok",
            "concluded": report["metrics"]["concluded"],
            "remaining": report["metrics"]["remaining"],
            "simulations": report["metrics"]["simulations"],
            "af_reference": report["metrics"]["af_reference"],
        },
        "enrichment": {
            "pending_public": public_pending,
            "pending_highlights": mm_pending,
            "pending_total": public_pending + mm_pending,
            "does_not_block_core": True,
        },
        "source": {
            "status": status_update.get("status"),
            "sincronizado": status_update.get("sincronizado"),
            "degraded": source_degraded,
        },
        "slo": {
            "targets_minutos": (slo.get("targets_minutos") or {"final_to_detection": 5, "final_to_results": 7, "final_to_af": 10, "commit_to_site": 5}),
            "ultima_observacao": slo.get("ultima_observacao"),
        },
    }
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Reliability state: {state}; core OK; enrichment pendente={public_pending + mm_pending}.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
