#!/usr/bin/env python3
"""R10R18 - reconciliação gratuita Hunter -> complementos -> detalhes -> analítico.

Nunca pesquisa com IA nem infere público pagante a partir de presentes.
Fatos do D1 passam pelo validador Fastlane já existente antes de virar JSON.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from importar_postgame_fastlane import apply_public_rows, fetch_rows, save_json
from gerar_estatisticas_competicao_brasileirao import deduplicar_resultados

TZ = ZoneInfo("America/Sao_Paulo")
RESULTADOS = ROOT / "resultados.json"
DETALHES = ROOT / "dados-br/jogos-detalhes.json"
COMPLEMENTOS = ROOT / "dados-br/publicos-complementares.json"
CORRECOES = ROOT / "dados-br/correcoes/publicos-verificados.json"
ANALITICO = ROOT / "dados-br/estatisticas-competicao.json"
AUDITORIA = ROOT / "dados-br/auditoria-reconciliacao-publicos.json"

def load(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"JSON inválido: {path}")
    return data

def positive(value):
    try:
        return value is not None and not isinstance(value, bool) and float(value) > 0
    except (ValueError, TypeError):
        return False

def number(value):
    return float(value) if positive(value) else None

def recent_missing(results, details, complements, now, hours=72, limit=12):
    ids = []
    known = details.get("jogos") or {}
    docs = complements.get("jogos") or {}
    for game in reversed(deduplicar_resultados(results.get("resultados") or [])):
        eid = str(game.get("event_id") or "")
        if not eid.isdecimal():
            continue
        try:
            start = datetime.fromisoformat(str(game.get("data_iso") or "")[:19])
            if start.tzinfo is None:
                start = start.replace(tzinfo=TZ)
        except ValueError:
            continue
        if not timedelta(0) <= now - start <= timedelta(hours=hours):
            continue
        row, extra = known.get(eid) or {}, docs.get(eid) or {}
        has_public = positive(row.get("publico")) or positive(extra.get("publico"))
        has_revenue = positive(row.get("renda")) or positive(extra.get("renda"))
        if not has_public or not has_revenue:
            ids.append(eid)
        if len(ids) >= limit:
            break
    return ids

def import_from_fastlane(base_url):
    results, details, complements = load(RESULTADOS), load(DETALHES), load(COMPLEMENTOS)
    ids = recent_missing(results, details, complements, datetime.now(TZ))
    if not ids:
        print("R10R18: nenhum jogo recente exige consulta ao D1.")
        return
    try:
        rows = fetch_rows(base_url, ids)
    except Exception as exc:
        print(f"::warning::R10R18 D1 indisponível; preservados os dados anteriores: {str(exc)[:250]}")
        return
    updated, changed = apply_public_rows(
        complements, rows, datetime.now(TZ).isoformat(), load(CORRECOES)
    )
    if changed:
        save_json(COMPLEMENTOS, updated)
    print(json.dumps({"R10R18_D1_ids": ids, "materializados": changed}, ensure_ascii=False))

def audit(results, details, complements, analytics):
    games = deduplicar_resultados(results.get("resultados") or [])
    source = complements.get("jogos") or {}
    docs = details.get("jogos") or {}
    indexed = analytics.get("jogos") or []
    indexed_by_id = {str(item.get("event_id")): item for item in indexed}
    expected_ids = {str(item.get("event_id")) for item in games}
    errors = []
    if len(indexed) != len(expected_ids) or set(indexed_by_id) != expected_ids:
        errors.append({"motivo": "event_ids_divergentes", "resultados": len(expected_ids), "analitico": len(indexed)})
    rows = []
    missing = []
    public_total = public_count = revenue_count = 0
    for game in games:
        eid = str(game.get("event_id") or "")
        d = docs.get(eid) or {}
        c = source.get(eid) or {}
        a = indexed_by_id.get(eid) or {}
        present, paid, revenue = number(d.get("publico")), number(d.get("publico_pagante")), number(d.get("renda"))
        declared = number(c.get("publico"))
        label = str(c.get("tipo") or "").strip().lower()
        if declared is not None and label not in ("presente", "total"):
            errors.append({"event_id": eid, "motivo": "tipo_publico_nao_confirmado", "tipo": label})
        if declared is not None and present != declared:
            errors.append({"event_id": eid, "motivo": "fonte_nao_propagada", "fonte": declared, "detalhes": present})
        if paid is not None and present is not None and paid > present:
            errors.append({"event_id": eid, "motivo": "pagantes_acima_de_presentes"})
        if (present, paid, revenue) != (number(a.get("publico")), number(a.get("publico_pagante")), number(a.get("renda"))):
            errors.append({"event_id": eid, "motivo": "analitico_diverge_detalhes"})
        if present is None:
            missing.append({"event_id": eid, "mandante": str((game.get("mandante") or {}).get("nome") or ""),
                            "visitante": str((game.get("visitante") or {}).get("nome") or ""),
                            "estado": "AGUARDANDO_FONTE"})
        else:
            public_count += 1
            public_total += int(present)
        if revenue is not None:
            revenue_count += 1
        rows.append({"event_id": eid, "tipo_publico": label or str(d.get("publico_tipo") or ""),
                     "publico_presente": int(present) if present is not None else None,
                     "publico_pagante": int(paid) if paid is not None else None,
                     "renda": revenue,
                     "fonte_publico": str(c.get("fonte_publico") or c.get("fonte") or d.get("publico_fonte") or ""),
                     "origem": str(c.get("origem") or ""),
                     "estado": "CONFIRMADO" if present is not None else "AGUARDANDO_FONTE"})
    p = analytics.get("publico") or {}
    resumo = analytics.get("resumo") or {}
    required = (
        ("resumo.jogos_finalizados", resumo.get("jogos_finalizados"), len(games)),
        ("resumo.jogos_com_publico", resumo.get("jogos_com_publico"), public_count),
        ("publico.jogos_com_publico", p.get("jogos_com_publico"), public_count),
        ("publico.jogos_com_renda", p.get("jogos_com_renda"), revenue_count),
        ("publico.total_publico", p.get("total_publico"), public_total),
    )
    for field, got, expected in required:
        if got != expected:
            errors.append({"motivo": "agregado_divergente", "campo": field, "observado": got, "esperado": expected})
    return {"schema_version": 1, "contrato": "publico_presente_ou_total",
            "jogos_finalizados": len(games), "jogos_com_publico": public_count,
            "jogos_sem_publico": len(missing), "publico_total": public_total,
            "jogos_com_renda": revenue_count, "aguardando_fonte": missing,
            "divergencias": errors, "total_divergencias": len(errors), "por_partida": rows}

def audit_repo():
    state = audit(load(RESULTADOS), load(DETALHES), load(COMPLEMENTOS), load(ANALITICO))
    if state["divergencias"]:
        raise RuntimeError("R10R18: BLOCKED divergência por ID: " + json.dumps(state["divergencias"][:8], ensure_ascii=False))
    old = load(AUDITORIA) if AUDITORIA.exists() else {}
    old.pop("gerado_em", None)
    if state != old:
        state["gerado_em"] = datetime.now(TZ).isoformat()
        AUDITORIA.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"R10R18_OK": True, "cobertura": f'{state["jogos_com_publico"]}/{state["jogos_finalizados"]}',
                      "faltam": [i["event_id"] for i in state["aguardando_fonte"]]}, ensure_ascii=False))

def self_test():
    results = {"resultados": [{"event_id": "11", "mandante": {"nome": "A"}, "visitante": {"nome": "B"}},
                              {"event_id": "22", "mandante": {"nome": "C"}, "visitante": {"nome": "D"}}]}
    details = {"jogos": {"11": {"publico": 14000, "publico_pagante": 13000, "renda": 200000}, "22": {}}}
    complementary = {"jogos": {"11": {"tipo": "presente", "publico": 14000}}}
    stats = {"jogos": [{"event_id": "11", "publico": 14000, "publico_pagante": 13000, "renda": 200000},
                       {"event_id": "22", "publico": None, "publico_pagante": None, "renda": None}],
             "resumo": {"jogos_finalizados": 2, "jogos_com_publico": 1},
             "publico": {"jogos_com_publico": 1, "jogos_com_renda": 1, "total_publico": 14000}}
    assert audit(results, details, complementary, stats)["total_divergencias"] == 0
    wrong = json.loads(json.dumps(stats))
    wrong["jogos"][0]["publico"] = 13000
    assert audit(results, details, complementary, wrong)["total_divergencias"] > 0
    replaced = json.loads(json.dumps(details))
    replaced["jogos"]["11"]["publico"] = None
    assert audit(results, replaced, complementary, stats)["total_divergencias"] > 0
    print("R10R18 self-test: PASS")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--importar-fastlane", action="store_true")
    parser.add_argument("--auditar", action="store_true")
    parser.add_argument("--base-url", default="https://push.formuladogol.com.br")
    args = parser.parse_args()
    if args.self_test:
        self_test()
    if args.importar_fastlane:
        import_from_fastlane(args.base_url)
    if args.auditar:
        audit_repo()
