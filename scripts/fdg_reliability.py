#!/usr/bin/env python3
"""Primitivas compartilhadas do Reliability Control Plane do Fórmula do Gol."""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
FUSO_BR = timezone(timedelta(hours=-3))

INCIDENT_CODES = {
    "STATE_REGRESSION_AFTER_FINAL",
    "AF_COVERAGE_MISMATCH",
    "AF_BASE_MISMATCH",
    "AF_SIMULATION_CONTRACT",
    "AF_REFERENCE_STALE",
    "EVENT_ID_DUPLICATE",
    "CALENDAR_PARTITION_INVALID",
    "AUDIT_HASH_MISMATCH",
    "CONTRACT_VERSION_DRIFT",
    "SOURCE_IDENTITY_MISMATCH",
    "PUBLICATION_VALIDATION_FAILED",
    "RELIABILITY_INTERNAL_ERROR",
}


def now_brt() -> datetime:
    return datetime.now(FUSO_BR)


def iso_brt(value: datetime | None = None) -> str:
    return (value or now_brt()).astimezone(FUSO_BR).isoformat(timespec="seconds")


def parse_iso(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=FUSO_BR)
    return parsed.astimezone(FUSO_BR)


def minutes_between(start: Any, end: Any) -> float | None:
    a, b = parse_iso(start), parse_iso(end)
    if not a or not b:
        return None
    return round((b - a).total_seconds() / 60.0, 3)


def correlation_id(event_id: Any, _finalizado_em: Any = None) -> str:
    """ID estável de ponta a ponta. O event_id é a identidade canônica do ciclo."""
    clean = "".join(ch for ch in str(event_id or "") if ch.isalnum() or ch in "._-")[:80]
    return f"fdg-{clean or 'unknown'}"


def load_json(path: str | Path, *, default: Any = None) -> Any:
    p = Path(path)
    if not p.is_absolute():
        p = ROOT / p
    if not p.exists() and default is not None:
        return default
    return json.loads(p.read_text(encoding="utf-8"))


def stable_hash(payload: Any) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def classify_exception(exc: BaseException) -> str:
    text = str(exc).casefold()
    rules = (
        ("regress", "STATE_REGRESSION_AFTER_FINAL"),
        ("cobertura das probabilidades", "AF_COVERAGE_MISMATCH"),
        ("calendário restante", "AF_COVERAGE_MISMATCH"),
        ("base_corrente", "AF_BASE_MISMATCH"),
        ("2.000.000", "AF_SIMULATION_CONTRACT"),
        ("2000000", "AF_SIMULATION_CONTRACT"),
        ("referencia", "AF_REFERENCE_STALE"),
        ("referência", "AF_REFERENCE_STALE"),
        ("event_id duplic", "EVENT_ID_DUPLICATE"),
        ("380", "CALENDAR_PARTITION_INVALID"),
        ("hash", "AUDIT_HASH_MISMATCH"),
        ("version", "CONTRACT_VERSION_DRIFT"),
        ("versão", "CONTRACT_VERSION_DRIFT"),
        ("identidade", "SOURCE_IDENTITY_MISMATCH"),
    )
    for needle, code in rules:
        if needle in text:
            return code
    return "PUBLICATION_VALIDATION_FAILED"


def write_diagnostic(
    path: str | Path,
    *,
    code: str,
    message: str,
    trace_id: str = "",
    profile: str = "",
    context: dict[str, Any] | None = None,
    state: str = "CRITICAL",
) -> dict[str, Any]:
    code = code if code in INCIDENT_CODES else "RELIABILITY_INTERNAL_ERROR"
    payload = {
        "schema_version": 1,
        "gerado_em": iso_brt(),
        "state": state,
        "code": code,
        "message": str(message),
        "trace_id": trace_id or str(os.environ.get("FDG_TRACE_ID") or ""),
        "profile": profile,
        "github": {
            "repository": str(os.environ.get("GITHUB_REPOSITORY") or ""),
            "run_id": str(os.environ.get("GITHUB_RUN_ID") or ""),
            "run_attempt": str(os.environ.get("GITHUB_RUN_ATTEMPT") or ""),
            "sha": str(os.environ.get("GITHUB_SHA") or ""),
        },
        "context": context or {},
    }
    p = Path(path)
    if not p.is_absolute():
        p = ROOT / p
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return payload


def reliability_state(*, core_ok: bool, source_degraded: bool = False, enrichment_pending: int = 0) -> str:
    if not core_ok:
        return "CRITICAL"
    if source_degraded:
        return "DEGRADED"
    if int(enrichment_pending or 0) > 0:
        return "ENRICHMENT_PENDING"
    return "CORE_GREEN"
