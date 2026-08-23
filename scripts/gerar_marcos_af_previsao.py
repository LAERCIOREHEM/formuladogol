#!/usr/bin/env python3
"""Gera marcos públicos imutáveis do AF-Previsão.

O histórico técnico continua registrando cada mudança esportiva relevante. Este
arquivo cria uma camada pública menor e semanticamente estável: fechamento de
rodadas elegíveis e fechamentos continentais já auditados. Uma vez criado, um
marco não é recalculado; futuras execuções apenas validam e acrescentam marcos.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
HISTORY_PATH = ROOT / "dados-br" / "historico-probabilidades.json"
CONT_HISTORY_PATH = ROOT / "dados-br" / "historico-probabilidades-continentais.json"
OUTPUT_PATH = ROOT / "dados-br" / "marcos-af-previsao.json"
ANALYSES_PATH = ROOT / "dados-br" / "analises.json"
CONFIG_PATH = ROOT / "dados-br" / "config-analises.json"
RESULTS_PATH = ROOT / "resultados.json"
CALENDAR_PATH = ROOT / "dados-br" / "calendario-completo.json"
BRT = timezone(timedelta(hours=-3))

PUBLIC_KEYS = (
    "clube", "posicao_atual", "pontos_atuais", "jogos_atuais",
    "rodada_referencia_clube", "ultimo_jogo_concluido_id", "hash_estado_clube",
    "hash_previsao_clube", "posicao_projetada", "posicao_classificacao_projetada",
    "pontos_projetados", "pontos_media_estimada", "pontos_medios",
    "campeao_pct", "libertadores_pct", "sul_americana_pct", "rebaixamento_pct",
    "libertadores_base_pct", "sul_americana_base_pct", "exibicao",
)


def load_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def canonical_hash(value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def now_brt() -> datetime:
    raw = os.environ.get("FDG_AGORA", "").strip()
    if raw:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=BRT)
        return parsed.astimezone(BRT)
    return datetime.now(BRT)


def parse_dt(value: Any) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=BRT)
    return parsed.astimezone(BRT)


def team_name(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("nome") or value.get("name") or "").strip()
    return str(value or "").strip()


def public_clubs(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for source in snapshot.get("clubes") or []:
        row = {key: source.get(key) for key in PUBLIC_KEYS if key in source}
        # Compatibilidade com o primeiro schema do histórico.
        if row.get("libertadores_pct") is None:
            row["libertadores_pct"] = source.get("libertadores_base_pct")
        if row.get("sul_americana_pct") is None:
            row["sul_americana_pct"] = source.get("sul_americana_base_pct")
        if row.get("pontos_projetados") is None:
            row["pontos_projetados"] = source.get("pontos_media_estimada", source.get("pontos_medios"))
        rows.append(row)
    rows.sort(key=lambda item: str(item.get("clube") or ""))
    if len(rows) != 20 or len({str(row.get("clube") or "") for row in rows}) != 20:
        raise ValueError("snapshot não contém os vinte clubes necessários ao marco público")
    return rows


def snapshot_index(history: dict[str, Any]) -> dict[str, tuple[int, dict[str, Any]]]:
    return {
        str(item.get("hash_snapshot") or ""): (index, item)
        for index, item in enumerate(history.get("snapshots") or [])
        if str(item.get("hash_snapshot") or "")
    }


def mark_from_snapshot(
    *,
    mark_id: str,
    kind: str,
    label: str,
    description: str,
    reference_at: str,
    snapshot: dict[str, Any],
    registered_at: str,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    clubs = public_clubs(snapshot)
    mark = {
        "id": mark_id,
        "tipo": kind,
        "rotulo": label,
        "descricao": description,
        "referencia_em": reference_at,
        "registrado_em": registered_at,
        "fonte": {
            "hash_snapshot": snapshot.get("hash_snapshot"),
            "hash_estado_esportivo": snapshot.get("hash_estado_esportivo"),
            "hash_entrada": snapshot.get("hash_entrada"),
            "gerado_em": snapshot.get("gerado_em"),
            "rodada_referencia": snapshot.get("rodada_referencia"),
        },
        "clubes": clubs,
        "hash_20_clubes": canonical_hash(clubs),
    }
    if metadata:
        mark.update(metadata)
    mark["hash_marco"] = canonical_hash({k: v for k, v in mark.items() if k != "hash_marco"})
    return mark


def round_state(round_no: int, moment: datetime, config: dict[str, Any]) -> dict[str, Any]:
    calendar = (load_json(CALENDAR_PATH, {}) or {}).get("jogos") or []
    results = (load_json(RESULTS_PATH, {}) or {}).get("resultados") or []
    planned = [row for row in calendar if int(row.get("rodada") or 0) == round_no]
    completed = [row for row in results if int(row.get("rodada") or 0) == round_no]
    completed_ids = {str(row.get("event_id") or row.get("id") or "") for row in completed}
    pending = [row for row in planned if str(row.get("event_id") or row.get("id") or "") not in completed_ids]
    complete = len(completed) == 10
    minimum = int(config.get("minimo_jogos_para_fechamento_editorial") or 8)
    wait_hours = int(config.get("espera_apos_ultimo_jogo_horas") or 8)
    postponed_hours = int(config.get("distancia_jogo_adiado_horas") or 72)
    eligible = complete
    reason = "todos os dez jogos foram concluídos" if complete else "rodada em andamento"
    result_dates = [parse_dt(row.get("data_iso")) for row in completed]
    result_dates = [value for value in result_dates if value]
    last_result = max(result_dates) if result_dates else None
    if not complete and len(completed) >= minimum and completed:
        pending_dates = [parse_dt(row.get("data_iso")) for row in pending]
        pending_dates = [value for value in pending_dates if value]
        distant = bool(pending) and (not pending_dates or (last_result and min(pending_dates) >= last_result + timedelta(hours=postponed_hours)))
        waited = bool(last_result and moment >= last_result + timedelta(hours=wait_hours))
        if distant and waited:
            eligible = True
            reason = "janela encerrada com partida adiada"
    return {
        "rodada": round_no,
        "elegivel": eligible,
        "completo": complete,
        "motivo": reason,
        "jogos_concluidos": len(completed),
        "jogos_pendentes": len(pending),
        "referencia_em": last_result.isoformat(timespec="minutes") if last_result else None,
    }


def latest_round_snapshot(history: dict[str, Any], round_no: int) -> dict[str, Any] | None:
    candidates = [
        item for item in history.get("snapshots") or []
        if int(item.get("rodada_referencia") or 0) == round_no
    ]
    return candidates[-1] if candidates else None


def previous_snapshot_for_round(history: dict[str, Any], mark: dict[str, Any]) -> dict[str, Any] | None:
    source_hash = str((mark.get("fonte") or {}).get("hash_snapshot") or "")
    snapshots = list(history.get("snapshots") or [])
    source_index = next((i for i, item in enumerate(snapshots) if str(item.get("hash_snapshot") or "") == source_hash), None)
    if source_index is None:
        return None
    round_no = int(mark.get("rodada") or 0)
    games_end = sum(int(row.get("jogos_atuais") or 0) for row in snapshots[source_index].get("clubes") or []) // 2
    candidates: list[tuple[int, int, int, dict[str, Any]]] = []
    for index, item in enumerate(snapshots[:source_index]):
        reference = int(item.get("rodada_referencia") or 0)
        games = sum(int(row.get("jogos_atuais") or 0) for row in item.get("clubes") or []) // 2
        if reference < round_no and games < games_end:
            candidates.append((reference, games, index, item))
    return max(candidates, key=lambda value: (value[0], value[1], value[2]))[3] if candidates else None


def match_continental_snapshot(mark: dict[str, Any], history: dict[str, Any]) -> dict[str, Any] | None:
    source = mark.get("fonte") or {}
    wanted_snapshot = str(source.get("hash_snapshot") or "").strip()
    wanted_input = str(source.get("probabilidades_hash_entrada") or "").strip()
    snapshots = history.get("snapshots") or []
    if wanted_snapshot:
        found = next((row for row in snapshots if str(row.get("hash_snapshot") or "") == wanted_snapshot), None)
        if found:
            return found
    if wanted_input:
        matches = [row for row in snapshots if str(row.get("hash_entrada") or "") == wanted_input]
        if matches:
            return matches[-1]
    return None


def phase_short(value: Any) -> str:
    text = str(value or "").casefold()
    if "oitav" in text:
        return "OITAVAS"
    if "quarta" in text:
        return "QUARTAS"
    if "semi" in text:
        return "SEMIS"
    if "final" in text:
        return "FINAL"
    return str(value or "FASE").upper()


def continental_label(mark: dict[str, Any]) -> str:
    competition = str(mark.get("competicao") or "")
    prefix = "CB" if competition == "copa_do_brasil" else "CONT"
    return f"{prefix} · {phase_short(mark.get('fase'))}"


def validate_mark(mark: dict[str, Any]) -> None:
    expected = canonical_hash({k: v for k, v in mark.items() if k != "hash_marco"})
    if mark.get("hash_marco") != expected:
        raise ValueError(f"marco {mark.get('id')}: hash_marco divergente")
    clubs = list(mark.get("clubes") or [])
    if len(clubs) != 20 or len({str(row.get("clube") or "") for row in clubs}) != 20:
        raise ValueError(f"marco {mark.get('id')}: vinte clubes obrigatórios")
    if mark.get("hash_20_clubes") != canonical_hash(clubs):
        raise ValueError(f"marco {mark.get('id')}: hash dos vinte clubes divergente")


def validate_document(document: dict[str, Any], history: dict[str, Any]) -> None:
    marks = list(document.get("marcos") or [])
    ids = [str(mark.get("id") or "") for mark in marks]
    if not all(ids) or len(ids) != len(set(ids)):
        raise ValueError("marcos públicos possuem id ausente ou duplicado")
    index = snapshot_index(history)
    for mark in marks:
        validate_mark(mark)
        source_hash = str((mark.get("fonte") or {}).get("hash_snapshot") or "")
        if source_hash and source_hash in index:
            technical = index[source_hash][1]
            if mark.get("hash_20_clubes") != canonical_hash(public_clubs(technical)):
                raise ValueError(f"marco {mark.get('id')}: clubes divergem do snapshot técnico referenciado")
    integrity = document.get("integridade") or {}
    if integrity.get("quantidade_marcos") != len(marks):
        raise ValueError("quantidade de marcos divergente")
    expected = canonical_hash([mark.get("hash_marco") for mark in marks])
    if integrity.get("hash_documento") != expected:
        raise ValueError("hash_documento dos marcos divergente")


def build_document(existing: dict[str, Any] | None = None, *, moment: datetime | None = None) -> tuple[dict[str, Any], list[str]]:
    history = load_json(HISTORY_PATH, {}) or {}
    snapshots = list(history.get("snapshots") or [])
    if not snapshots:
        raise ValueError("histórico técnico do AF-Previsão está vazio")
    config = load_json(CONFIG_PATH, {}) or {}
    moment = moment or now_brt()
    registered_at = moment.isoformat(timespec="seconds")
    existing_marks = {str(item.get("id") or ""): item for item in (existing or {}).get("marcos") or []}
    # Imutabilidade: todos os marcos já publicados entram sem alteração.
    marks: dict[str, dict[str, Any]] = {key: json.loads(json.dumps(value, ensure_ascii=False)) for key, value in existing_marks.items()}
    warnings: list[str] = []

    rounds = sorted({int(item.get("rodada_referencia") or 0) for item in snapshots if int(item.get("rodada_referencia") or 0) > 0})
    # R18 pode ser elegível no calendário mas o histórico técnico começou depois;
    # não inventamos uma fotografia que nunca foi gravada.
    rounds = sorted(set(rounds) | {18})
    for round_no in rounds:
        mark_id = f"brasileirao-2026-r{round_no:02d}-fechamento"
        if mark_id in marks:
            continue
        state = round_state(round_no, moment, config)
        if not state["elegivel"]:
            continue
        snapshot = latest_round_snapshot(history, round_no)
        if snapshot is None:
            warnings.append(f"R{round_no}: fechamento elegível, mas não existe snapshot técnico canônico; marco não foi inventado")
            continue
        reference_at = state.get("referencia_em") or str(snapshot.get("gerado_em") or registered_at)
        marks[mark_id] = mark_from_snapshot(
            mark_id=mark_id,
            kind="brasileirao_fechamento",
            label=f"R{round_no}",
            description=f"Fechamento público imutável da rodada {round_no} usado pela evolução e pelos editoriais.",
            reference_at=reference_at,
            snapshot=snapshot,
            registered_at=registered_at,
            metadata={
                "rodada": round_no,
                "estado_rodada": state,
            },
        )

    continental_history = load_json(CONT_HISTORY_PATH, {}) or {}
    for continental in continental_history.get("marcos") or []:
        if str(continental.get("tipo") or "") != "depois":
            continue
        mark_id = f"af:{continental.get('id')}"
        if mark_id in marks:
            continue
        snapshot = match_continental_snapshot(continental, history)
        if snapshot is None:
            warnings.append(f"{continental.get('id')}: sem snapshot técnico correspondente; marco público não criado")
            continue
        reference_at = str(continental.get("registrado_em") or snapshot.get("gerado_em") or registered_at)
        marks[mark_id] = mark_from_snapshot(
            mark_id=mark_id,
            kind="continental_fechamento",
            label=continental_label(continental),
            description=str(continental.get("descricao") or "Fechamento continental auditado."),
            reference_at=reference_at,
            snapshot=snapshot,
            registered_at=registered_at,
            metadata={
                "competicao": continental.get("competicao"),
                "competicao_nome": continental.get("competicao_nome"),
                "fase": continental.get("fase"),
                "marco_continental_origem": continental.get("id"),
            },
        )

    ordered = sorted(
        marks.values(),
        key=lambda item: (
            parse_dt(item.get("referencia_em")) or datetime.min.replace(tzinfo=BRT),
            0 if item.get("tipo") == "brasileirao_fechamento" else 1,
            str(item.get("id") or ""),
        ),
    )
    document = {
        "schema_version": 1,
        "projeto": "AF-Previsão",
        "descricao": "Marcos públicos imutáveis que sincronizam a evolução exibida com os estados factuais usados pelos editoriais.",
        "regra": {
            "historico_tecnico": "historico-probabilidades.json mantém toda mudança esportiva relevante",
            "historico_publico": "somente fechamentos elegíveis e marcos continentais auditados",
            "imutabilidade": "um marco existente nunca é recalculado; novos estados entram apenas como novos marcos ou como ATUAL",
            "editorial": "o snapshot DEPOIS do editorial de rodada deve ser exatamente o marco público da mesma rodada",
        },
        "gerado_em": max((str(mark.get("registrado_em") or "") for mark in ordered), default=registered_at),
        "avisos_backfill": warnings,
        "total_marcos": len(ordered),
        "integridade": {
            "algoritmo": "SHA-256",
            "quantidade_marcos": len(ordered),
            "hash_documento": canonical_hash([mark.get("hash_marco") for mark in ordered]),
        },
        "marcos": ordered,
    }
    validate_document(document, history)
    return document, warnings


def enrich_analyses_manifest(document: dict[str, Any], history: dict[str, Any]) -> bool:
    manifest = load_json(ANALYSES_PATH, {}) or {}
    articles = list(manifest.get("artigos") or [])
    by_round = {
        int(mark.get("rodada")): mark
        for mark in document.get("marcos") or []
        if mark.get("tipo") == "brasileirao_fechamento" and int(mark.get("rodada") or 0) > 0
    }
    changed = False
    for article in articles:
        if str(article.get("tipo") or "") != "brasileirao_rodada":
            continue
        round_no = int(article.get("rodada") or 0)
        mark = by_round.get(round_no)
        if not mark:
            continue
        previous = previous_snapshot_for_round(history, mark)
        metadata = {
            "marco_id": mark.get("id"),
            "snapshot_depois_hash": (mark.get("fonte") or {}).get("hash_snapshot"),
            "hash_20_clubes_depois": mark.get("hash_20_clubes"),
            "snapshot_antes_hash": previous.get("hash_snapshot") if previous else None,
        }
        if article.get("af_marco") != metadata:
            article["af_marco"] = metadata
            changed = True
    if changed:
        manifest["artigos"] = articles
        write_json(ANALYSES_PATH, manifest)
    return changed


def self_test() -> None:
    sample_clubs = [
        {"clube": f"Clube {i:02d}", "campeao_pct": float(i), "libertadores_pct": 50.0, "sul_americana_pct": 20.0, "rebaixamento_pct": 5.0}
        for i in range(20)
    ]
    snapshot = {
        "hash_snapshot": "abc",
        "hash_estado_esportivo": "sport",
        "hash_entrada": "input",
        "gerado_em": "2026-08-01T20:00:00-03:00",
        "rodada_referencia": 20,
        "clubes": sample_clubs,
    }
    mark = mark_from_snapshot(
        mark_id="test", kind="brasileirao_fechamento", label="R20",
        description="teste", reference_at="2026-08-01T20:00:00-03:00",
        snapshot=snapshot, registered_at="2026-08-01T21:00:00-03:00", metadata={"rodada": 20},
    )
    validate_mark(mark)
    mutated = json.loads(json.dumps(mark))
    mutated["clubes"][0]["campeao_pct"] = 99
    try:
        validate_mark(mutated)
    except ValueError:
        pass
    else:
        raise AssertionError("alteração de marco imutável não foi detectada")
    print("Self-test marcos AF-Previsão: OK")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--validar", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    history = load_json(HISTORY_PATH, {}) or {}
    if args.validar:
        document = load_json(OUTPUT_PATH, {}) or {}
        validate_document(document, history)
        print(f"Marcos AF-Previsão válidos: {len(document.get('marcos') or [])}")
        return 0
    existing = load_json(OUTPUT_PATH, None)
    document, warnings = build_document(existing)
    write_json(OUTPUT_PATH, document)
    changed_manifest = enrich_analyses_manifest(document, history)
    for warning in warnings:
        print(f"::warning::{warning}")
    print(f"Marcos AF-Previsão: {len(document.get('marcos') or [])}; manifesto editorial atualizado={str(changed_manifest).lower()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
