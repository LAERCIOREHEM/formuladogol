#!/usr/bin/env python3
"""R10R16.1 — regras determinísticas de integridade factual de público/renda.

Não pesquisa rede e não estima valores. O objetivo é detectar colisões semânticas
antes da publicação e colocar SOMENTE o campo suspeito em quarentena.
"""
from __future__ import annotations
from copy import deepcopy
from typing import Any

POLICY_VERSION = 1
INCIDENT_PUBLIC_REVENUE_COLLISION = "PUBLIC_REVENUE_FIELD_COLLISION"
WARNING_REVENUE_PER_ATTENDEE_LOW = "REVENUE_PER_ATTENDEE_LOW"
LOW_REVENUE_PER_ATTENDEE = 5.0


def _number(value: Any) -> float | None:
    if value in (None, "") or isinstance(value, bool):
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


def inspect_factual_integrity(publico: Any, pagantes: Any = None, renda: Any = None) -> dict[str, Any]:
    p = _number(publico)
    paid = _number(pagantes)
    rev = _number(renda)
    critical: list[str] = []
    warnings: list[str] = []
    quarantine: list[str] = []
    ratio = None

    if p is not None and paid is not None and paid > p:
        critical.append("PAID_ATTENDANCE_GT_PRESENT")
        quarantine.append("pagantes")

    if p is not None and p > 0 and rev is not None and rev > 0:
        ratio = rev / p
        # Incidente real 401841248: renda recebeu exatamente o número de público.
        # Centavos tolerados apenas para evitar artefato de float.
        if abs(rev - p) < 0.005:
            critical.append(INCIDENT_PUBLIC_REVENUE_COLLISION)
            quarantine.append("renda")
        elif ratio < LOW_REVENUE_PER_ATTENDEE:
            # Anomalia secundária: não prova erro e, portanto, NÃO remove o dado.
            # Serve para auditoria/rechecagem direcionada sem varredura por IA.
            warnings.append(WARNING_REVENUE_PER_ATTENDEE_LOW)

    return {
        "policy_version": POLICY_VERSION,
        "critical": critical,
        "warnings": warnings,
        "quarantine_fields": list(dict.fromkeys(quarantine)),
        "revenue_per_attendee": None if ratio is None else round(ratio, 4),
    }


def quarantine_row(row: dict[str, Any], *, verified: dict[str, Any] | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    """Remove somente campos criticamente suspeitos, salvo correção curada idêntica."""
    current = deepcopy(row) if isinstance(row, dict) else {}
    verified = verified if isinstance(verified, dict) else {}
    verdict = inspect_factual_integrity(current.get("publico"), current.get("pagantes"), current.get("renda"))

    # Correção documental explícita tem precedência sobre heurística determinística.
    if INCIDENT_PUBLIC_REVENUE_COLLISION in verdict["critical"]:
        vr = _number(verified.get("renda"))
        cr = _number(current.get("renda"))
        if vr is not None and cr is not None and abs(vr - cr) < 0.005:
            verdict = {**verdict, "critical": [x for x in verdict["critical"] if x != INCIDENT_PUBLIC_REVENUE_COLLISION], "quarantine_fields": [x for x in verdict["quarantine_fields"] if x != "renda"], "verified_override": True}

    for field in verdict.get("quarantine_fields") or []:
        if field == "renda":
            current.pop("renda", None)
            current.pop("fonte_renda", None)
            current["renda_status"] = "em_verificacao"
        elif field == "pagantes":
            current.pop("pagantes", None)
            current.pop("fonte_pagantes", None)
            current["pagantes_status"] = "em_verificacao"

    return current, verdict


def self_test() -> None:
    bad = inspect_factual_integrity(15056, None, 15056)
    assert bad["critical"] == [INCIDENT_PUBLIC_REVENUE_COLLISION]
    assert bad["quarantine_fields"] == ["renda"]
    row, verdict = quarantine_row({"publico": 15056, "renda": 15056, "fonte_renda": "https://x"})
    assert row.get("publico") == 15056 and "renda" not in row and "fonte_renda" not in row
    assert verdict["critical"]
    good = inspect_factual_integrity(15056, None, 708004.50)
    assert not good["critical"] and not good["warnings"]
    low = inspect_factual_integrity(10000, None, 40000)
    assert not low["critical"] and WARNING_REVENUE_PER_ATTENDEE_LOW in low["warnings"]
    verified, verdict2 = quarantine_row({"publico": 1000, "renda": 1000}, verified={"renda": 1000})
    assert verified["renda"] == 1000 and not verdict2["critical"]
    print("SELF-TEST OK: R10R16.1 factual integrity policy")


if __name__ == "__main__":
    self_test()
