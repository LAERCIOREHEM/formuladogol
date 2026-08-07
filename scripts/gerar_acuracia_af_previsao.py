#!/usr/bin/env python3
"""Mantém o histórico auditável e o painel público de acurácia do AF-Previsão.

Princípios:
- preserva a última previsão V/E/D realmente publicada antes do kickoff;
- não reconstrói previsões passadas com dados posteriores;
- avalia os jogos somente de forma agregada na interface pública;
- mantém a timeline de posição, pontos e probabilidades por clube;
- calcula a cobertura da faixa central de 80% somente quando o Brasileirão termina;
- calcula campeão/Libertadores/Sul-Americana somente quando os desfechos são factuais;
- toda escrita é atômica; falhas do módulo não devem corromper o último estado válido.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from collections import defaultdict
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from avaliar_af_previsao import (  # noqa: E402
    COMPETITION_PATHS,
    CONFIG_PATH,
    final_table_state,
    resolve_final_outcomes,
)

BRT = ZoneInfo("America/Sao_Paulo")
PREGAME_PATH = ROOT / "dados-br" / "probabilidades-jogos.json"
RESULTS_PATH = ROOT / "resultados.json"
TABLE_PATH = ROOT / "tabela.json"
HISTORY_SEASON_PATH = ROOT / "dados-br" / "historico-probabilidades.json"
HISTORY_GAMES_PATH = ROOT / "dados-br" / "historico-probabilidades-jogos.json"
OUTPUT_PATH = ROOT / "dados-br" / "acuracia-af-previsao.json"
EPS = 1e-12


def load_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return deepcopy(default)
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")
    os.replace(temp, path)


def now_brt() -> str:
    return datetime.now(BRT).replace(microsecond=0).isoformat()


def parse_dt(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=BRT)
    return dt.astimezone(BRT)


def canonical_hash(payload: Any) -> str:
    raw = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def without_volatile_timestamps(payload: Any) -> Any:
    """Remove somente timestamps operacionais que não alteram o conteúdo auditado."""
    if isinstance(payload, Mapping):
        return {
            key: without_volatile_timestamps(value)
            for key, value in payload.items()
            if key not in {"atualizado_em", "gerado_em"}
        }
    if isinstance(payload, list):
        return [without_volatile_timestamps(value) for value in payload]
    return payload


def semantic_hash(payload: Any) -> str:
    return canonical_hash(without_volatile_timestamps(payload))


def finite_probability(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number < 0 or number > 100:
        return None
    return number


def team_name(value: Any) -> str:
    if isinstance(value, Mapping):
        return str(value.get("nome") or value.get("name") or "").strip()
    return str(value or "").strip()


def sporting_key(home: str, away: str) -> str:
    return f"{home.strip()}|||{away.strip()}"


def normalize_probabilities(row: Mapping[str, Any]) -> dict[str, float] | None:
    raw = row.get("probabilidades_pct") or {}
    values = {}
    for field in ("mandante", "empate", "visitante"):
        value = finite_probability(raw.get(field))
        if value is None:
            return None
        values[field] = value
    total = sum(values.values())
    if total <= 0 or abs(total - 100.0) > 0.05:
        return None
    # Preserva os valores publicados; apenas normaliza erro residual de ponto flutuante.
    if abs(total - 100.0) > 1e-12:
        values = {key: value * 100.0 / total for key, value in values.items()}
    return values


def prediction_record(document: Mapping[str, Any], row: Mapping[str, Any]) -> dict[str, Any] | None:
    event_id = str(row.get("event_id") or "").strip()
    home = str(row.get("mandante") or "").strip()
    away = str(row.get("visitante") or "").strip()
    generated_at = str(document.get("gerado_em") or "").strip()
    probabilities = normalize_probabilities(row)
    if not event_id or not home or not away or not generated_at or probabilities is None:
        return None
    generated_dt = parse_dt(generated_at)
    if generated_dt is None:
        return None
    kickoff = str(row.get("data_iso") or "").strip() or None
    source = {
        "event_id": event_id,
        "rodada": int(row.get("rodada") or 0),
        "data_iso": kickoff,
        "mandante": home,
        "visitante": away,
        "gerado_em_modelo": generated_dt.isoformat(),
        "versao_modelo": str(document.get("versao_modelo") or "AF-Previsão"),
        "hash_entrada_modelo": str(document.get("hash_entrada") or ""),
        "probabilidades_pct": {key: round(value, 8) for key, value in probabilities.items()},
    }
    source["hash_previsao"] = canonical_hash(source)
    return source


def empty_game_history() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "projeto": "AF-Previsão",
        "tipo": "historico_probabilidades_pre_jogo",
        "temporada": 2026,
        "descricao": (
            "Histórico das probabilidades V/E/D efetivamente publicadas antes do início das partidas. "
            "O registro preserva versões distintas e seleciona para avaliação a última previsão válida anterior ao kickoff."
        ),
        "criterio": {
            "inicio_coleta": "segunda metade do Brasileirão 2026",
            "previsao_avaliavel": "gerado_em_modelo estritamente anterior ao kickoff factual",
            "selecao": "última previsão válida anterior ao kickoff",
            "nao_reconstroi_passado": True,
            "alvo_avaliado": "resultado_v_e_d",
        },
        "previsoes": [],
        "resultados_observados": {},
        "integridade": {},
    }


def validate_game_history(history: Mapping[str, Any]) -> None:
    if int(history.get("schema_version") or 0) != 1:
        raise ValueError("histórico pré-jogo em schema inesperado")
    forecasts = list(history.get("previsoes") or [])
    hashes: set[str] = set()
    for index, record in enumerate(forecasts, start=1):
        declared = str(record.get("hash_previsao") or "")
        base = dict(record)
        base.pop("hash_previsao", None)
        computed = canonical_hash(base)
        if not declared or declared != computed:
            raise ValueError(f"previsão {index}: hash inválido")
        if declared in hashes:
            raise ValueError(f"previsão {index}: hash duplicado")
        hashes.add(declared)
        if normalize_probabilities(record) is None:
            raise ValueError(f"previsão {index}: probabilidades inválidas")
    integrity = history.get("integridade") or {}
    if integrity:
        if int(integrity.get("total_previsoes_distintas") or 0) != len(forecasts):
            raise ValueError("histórico pré-jogo: total declarado divergente")
        digest = canonical_hash([record.get("hash_previsao") for record in forecasts])
        if integrity.get("hash_conjunto_previsoes") != digest:
            raise ValueError("histórico pré-jogo: hash do conjunto divergente")
        observed_digest = integrity.get("hash_resultados_observados")
        if observed_digest is not None and observed_digest != canonical_hash(history.get("resultados_observados") or {}):
            raise ValueError("histórico pré-jogo: hash dos resultados observados divergente")


def result_index(results: Mapping[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    by_id: dict[str, dict[str, Any]] = {}
    by_pair: dict[str, dict[str, Any]] = {}
    for row in results.get("resultados") or []:
        home = team_name(row.get("mandante"))
        away = team_name(row.get("visitante"))
        event_id = str(row.get("event_id") or "").strip()
        try:
            home_goals = int(row.get("placar_mandante"))
            away_goals = int(row.get("placar_visitante"))
        except (TypeError, ValueError):
            continue
        if not home or not away:
            continue
        outcome = "mandante" if home_goals > away_goals else "visitante" if away_goals > home_goals else "empate"
        normalized = {
            "event_id": event_id,
            "rodada": int(row.get("rodada") or 0),
            "data_iso": str(row.get("data_iso") or "").strip() or None,
            "finalizado_em": str(row.get("finalizado_em") or "").strip() or None,
            "mandante": home,
            "visitante": away,
            "resultado": outcome,
        }
        if event_id:
            by_id[event_id] = normalized
        by_pair[sporting_key(home, away)] = normalized
    return by_id, by_pair


def refresh_results(history: dict[str, Any], results: Mapping[str, Any]) -> bool:
    by_id, by_pair = result_index(results)
    observed: dict[str, Any] = {}
    event_pairs: dict[str, tuple[str, str]] = {}
    for forecast in history.get("previsoes") or []:
        event_pairs[str(forecast.get("event_id") or "")] = (
            str(forecast.get("mandante") or ""),
            str(forecast.get("visitante") or ""),
        )
    for event_id, pair in event_pairs.items():
        result = by_id.get(event_id) or by_pair.get(sporting_key(*pair))
        if result:
            observed[event_id] = result
    normalized = dict(sorted(observed.items()))
    changed = normalized != (history.get("resultados_observados") or {})
    history["resultados_observados"] = normalized
    return changed


def capture_pregame(history: dict[str, Any], document: Mapping[str, Any]) -> dict[str, Any]:
    existing = {str(record.get("hash_previsao") or "") for record in history.get("previsoes") or []}
    additions: list[dict[str, Any]] = []
    for row in document.get("jogos") or []:
        record = prediction_record(document, row)
        if record and record["hash_previsao"] not in existing:
            existing.add(record["hash_previsao"])
            additions.append(record)
    history.setdefault("previsoes", []).extend(additions)
    history["previsoes"].sort(
        key=lambda item: (
            str(item.get("gerado_em_modelo") or ""),
            str(item.get("event_id") or ""),
            str(item.get("hash_previsao") or ""),
        )
    )
    history["atualizado_em"] = now_brt()
    history["primeiro_registro"] = (
        history["previsoes"][0].get("gerado_em_modelo") if history["previsoes"] else None
    )
    history["ultimo_registro"] = (
        history["previsoes"][-1].get("gerado_em_modelo") if history["previsoes"] else None
    )
    events = {str(item.get("event_id") or "") for item in history["previsoes"] if item.get("event_id")}
    history["integridade"] = {
        "algoritmo": "SHA-256",
        "total_previsoes_distintas": len(history["previsoes"]),
        "total_eventos_com_previsao": len(events),
        "hash_conjunto_previsoes": canonical_hash([item["hash_previsao"] for item in history["previsoes"]]),
    }
    validate_game_history(history)
    return {"adicionadas": len(additions), "total": len(history["previsoes"])}


def selected_pregame_records(history: Mapping[str, Any]) -> list[dict[str, Any]]:
    observed = history.get("resultados_observados") or {}
    by_event: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for forecast in history.get("previsoes") or []:
        by_event[str(forecast.get("event_id") or "")].append(dict(forecast))
    selected: list[dict[str, Any]] = []
    for event_id, forecasts in by_event.items():
        result = observed.get(event_id)
        if not result:
            continue
        actual_kickoff = parse_dt(result.get("data_iso"))
        if actual_kickoff is None:
            continue
        eligible = []
        for forecast in forecasts:
            generated = parse_dt(forecast.get("gerado_em_modelo"))
            if generated is None or generated >= actual_kickoff:
                continue
            # O kickoff do próprio forecast pode ser antigo em um reagendamento; a
            # regra factual usa o horário final observado da partida.
            eligible.append((generated, forecast))
        if not eligible:
            continue
        eligible.sort(key=lambda item: (item[0], str(item[1].get("hash_previsao") or "")))
        chosen = dict(eligible[-1][1])
        chosen["kickoff_factual"] = actual_kickoff.isoformat()
        chosen["resultado_observado"] = result.get("resultado")
        chosen["rodada_observada"] = int(result.get("rodada") or chosen.get("rodada") or 0)
        selected.append(chosen)
    selected.sort(key=lambda item: (str(item.get("kickoff_factual") or ""), str(item.get("event_id") or "")))
    return selected


def calibration_bins(pairs: Iterable[tuple[float, int]], bins: int = 10) -> list[dict[str, Any]]:
    buckets: list[list[tuple[float, int]]] = [[] for _ in range(bins)]
    for probability_pct, observed in pairs:
        p = min(100.0, max(0.0, float(probability_pct)))
        index = min(bins - 1, int(p // (100.0 / bins)))
        buckets[index].append((p, int(observed)))
    output = []
    for index, bucket in enumerate(buckets):
        if not bucket:
            continue
        mean = sum(value for value, _ in bucket) / len(bucket)
        observed_rate = 100.0 * sum(outcome for _, outcome in bucket) / len(bucket)
        output.append({
            "faixa_pct": [index * 10, (index + 1) * 10],
            "amostra": len(bucket),
            "probabilidade_media_pct": round(mean, 4),
            "frequencia_observada_pct": round(observed_rate, 4),
            "erro_absoluto_pp": round(abs(mean - observed_rate), 4),
        })
    return output


def game_accuracy(selected: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    top_total = 0
    top_confirmed = 0
    high_total = 0
    high_confirmed = 0
    brier_values: list[float] = []
    log_values: list[float] = []
    calibration_pairs: list[tuple[float, int]] = []
    by_round: dict[int, dict[str, Any]] = {}

    for record in selected:
        probs = normalize_probabilities(record)
        observed = str(record.get("resultado_observado") or "")
        if probs is None or observed not in {"mandante", "empate", "visitante"}:
            continue
        values = list(probs.items())
        max_value = max(value for _, value in values)
        top_labels = [key for key, value in values if abs(value - max_value) <= 1e-9]
        unique_top = len(top_labels) == 1
        confirmed = unique_top and top_labels[0] == observed
        if unique_top:
            top_total += 1
            top_confirmed += int(confirmed)

        high_labels = [key for key, value in values if value >= 80.0]
        for key in high_labels:
            high_total += 1
            high_confirmed += int(key == observed)

        one_hot = {key: 1 if key == observed else 0 for key in probs}
        p01 = {key: probs[key] / 100.0 for key in probs}
        brier_values.append(sum((p01[key] - one_hot[key]) ** 2 for key in probs) / 3.0)
        log_values.append(-math.log(max(EPS, p01[observed])))
        for key, probability in probs.items():
            calibration_pairs.append((probability, one_hot[key]))

        round_no = int(record.get("rodada_observada") or record.get("rodada") or 0)
        row = by_round.setdefault(round_no, {
            "rodada": round_no,
            "jogos_avaliados": 0,
            "maior_probabilidade_avaliada": 0,
            "maior_probabilidade_confirmada": 0,
            "previsoes_fortes_60_total": 0,
            "previsoes_fortes_60_confirmadas": 0,
        })
        row["jogos_avaliados"] += 1
        if unique_top:
            row["maior_probabilidade_avaliada"] += 1
            row["maior_probabilidade_confirmada"] += int(confirmed)
            if max_value >= 60.0:
                row["previsoes_fortes_60_total"] += 1
                row["previsoes_fortes_60_confirmadas"] += int(confirmed)

    for row in by_round.values():
        denominator = int(row["maior_probabilidade_avaliada"] or 0)
        row["taxa_confirmacao_pct"] = round(100.0 * row["maior_probabilidade_confirmada"] / denominator, 2) if denominator else None
        strong = int(row["previsoes_fortes_60_total"] or 0)
        row["taxa_fortes_60_pct"] = round(100.0 * row["previsoes_fortes_60_confirmadas"] / strong, 2) if strong else None

    return {
        "jogos_avaliados": len(selected),
        "maior_probabilidade": {
            "amostra": top_total,
            "confirmadas": top_confirmed,
            "taxa_confirmacao_pct": round(100.0 * top_confirmed / top_total, 2) if top_total else None,
        },
        "alta_confianca_80": {
            "amostra": high_total,
            "confirmadas": high_confirmed,
            "taxa_confirmacao_pct": round(100.0 * high_confirmed / high_total, 2) if high_total else None,
            "limiar_pct": 80,
        },
        "calibracao": calibration_bins(calibration_pairs),
        "metricas_tecnicas": {
            "brier_multiclasse_medio": round(sum(brier_values) / len(brier_values), 8) if brier_values else None,
            "log_loss_medio": round(sum(log_values) / len(log_values), 8) if log_values else None,
        },
        "por_rodada": [by_round[key] for key in sorted(by_round) if key > 0],
    }


def prediction_state_hash(row: Mapping[str, Any]) -> str:
    fields = {
        "clube": row.get("clube"),
        "jogos_atuais": row.get("jogos_atuais"),
        "posicao_atual": row.get("posicao_atual"),
        "pontos_atuais": row.get("pontos_atuais"),
        "posicao_projetada": row.get("posicao_projetada"),
        "faixa_posicao_80": row.get("faixa_posicao_80"),
        "pontos_projetados": row.get("pontos_projetados"),
        "pontos_percentis": row.get("pontos_percentis"),
        "campeao_pct": row.get("campeao_pct"),
        "libertadores_pct": row.get("libertadores_pct", row.get("libertadores_base_pct")),
        "sul_americana_pct": row.get("sul_americana_pct", row.get("sul_americana_base_pct")),
    }
    return canonical_hash(fields)


def build_timelines(history: Mapping[str, Any]) -> dict[str, list[dict[str, Any]]]:
    by_team: dict[str, list[dict[str, Any]]] = defaultdict(list)
    seen: dict[str, set[str]] = defaultdict(set)
    for snapshot in history.get("snapshots") or []:
        generated = str(snapshot.get("gerado_em") or "")
        version = str(snapshot.get("versao_modelo") or "")
        snapshot_hash = str(snapshot.get("hash_snapshot") or "")
        for row in snapshot.get("clubes") or []:
            team = str(row.get("clube") or "").strip()
            position_range = row.get("faixa_posicao_80") or {}
            point_range = row.get("pontos_percentis") or {}
            if not team or row.get("jogos_atuais") is None or not position_range:
                continue
            state_hash = str(row.get("hash_previsao_clube") or "") or prediction_state_hash(row)
            if state_hash in seen[team]:
                continue
            seen[team].add(state_hash)
            record = {
                "gerado_em": generated,
                "versao_modelo": version,
                "hash_snapshot": snapshot_hash,
                "hash_previsao_clube": state_hash,
                "jogos_atuais": int(row.get("jogos_atuais") or 0),
                "rodada_referencia": row.get("rodada_referencia_clube", snapshot.get("rodada_referencia")),
                "posicao_atual": row.get("posicao_atual"),
                "pontos_atuais": row.get("pontos_atuais"),
                "posicao_projetada": row.get("posicao_classificacao_projetada", row.get("posicao_projetada")),
                "posicao_media_estimada": row.get("posicao_media_estimada"),
                "faixa_posicao_80": {
                    "melhor": position_range.get("melhor"),
                    "pior": position_range.get("pior"),
                },
                "pontos_projetados": row.get("pontos_projetados", row.get("pontos_medios")),
                "faixa_pontos_80": {
                    "min": point_range.get("p10"),
                    "max": point_range.get("p90"),
                },
                "probabilidades_pct": {
                    "campeao": row.get("campeao_pct"),
                    "libertadores": row.get("libertadores_pct", row.get("libertadores_base_pct")),
                    "sul_americana": row.get("sul_americana_pct", row.get("sul_americana_base_pct")),
                },
            }
            by_team[team].append(record)
    for team, rows in by_team.items():
        rows.sort(key=lambda item: (str(item.get("gerado_em") or ""), str(item.get("hash_previsao_clube") or "")))
    return dict(sorted(by_team.items()))


def latest_per_games(rows: Sequence[Mapping[str, Any]]) -> dict[int, Mapping[str, Any]]:
    output: dict[int, Mapping[str, Any]] = {}
    for row in rows:
        games = int(row.get("jogos_atuais") or 0)
        if games > 0:
            output[games] = row
    return output


def final_range_coverage(
    timelines: Mapping[str, Sequence[Mapping[str, Any]]],
    table_rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    final_positions = {str(row["clube"]): int(row["posicao"]) for row in table_rows}
    final_points = {str(row["clube"]): int(row["pontos"]) for row in table_rows}
    per_team_games = {team: latest_per_games(rows) for team, rows in timelines.items()}
    # Não usa previsões praticamente pós-fato (36–38 jogos) como headline de
    # acurácia. A série pública acompanha os marcos ainda genuinamente preditivos
    # da segunda metade da temporada, com 35 jogos como último marco principal.
    milestones = sorted({
        games
        for mapping in per_team_games.values()
        for games in mapping
        if 1 <= int(games) <= 35
    })
    positions = []
    points = []
    for games in milestones:
        position_sample = position_ok = point_sample = point_ok = 0
        for team, mapping in per_team_games.items():
            row = mapping.get(games)
            if not row or team not in final_positions:
                continue
            interval = row.get("faixa_posicao_80") or {}
            try:
                best, worst = int(interval.get("melhor")), int(interval.get("pior"))
            except (TypeError, ValueError):
                pass
            else:
                if 1 <= best <= worst <= 20:
                    position_sample += 1
                    position_ok += int(best <= final_positions[team] <= worst)
            interval_points = row.get("faixa_pontos_80") or {}
            try:
                low, high = int(interval_points.get("min")), int(interval_points.get("max"))
            except (TypeError, ValueError):
                pass
            else:
                if low <= high:
                    point_sample += 1
                    point_ok += int(low <= final_points[team] <= high)
        if position_sample:
            positions.append({
                "apos_jogos": games,
                "amostra": position_sample,
                "dentro_faixa": position_ok,
                "cobertura_pct": round(100.0 * position_ok / position_sample, 2),
            })
        if point_sample:
            points.append({
                "apos_jogos": games,
                "amostra": point_sample,
                "dentro_faixa": point_ok,
                "cobertura_pct": round(100.0 * point_ok / point_sample, 2),
            })

    def headline(rows: Sequence[Mapping[str, Any]]) -> Mapping[str, Any] | None:
        candidates = [
            row for row in rows
            if int(row.get("amostra") or 0) >= 15 and int(row.get("apos_jogos") or 0) <= 35
        ]
        return dict(candidates[-1]) if candidates else (dict(rows[-1]) if rows else None)

    return {
        "status": "concluido",
        "posicao": {"marcos": positions, "destaque": headline(positions)},
        "pontos": {"marcos": points, "destaque": headline(points)},
    }


def season_outcome_accuracy(
    timelines: Mapping[str, Sequence[Mapping[str, Any]]],
    outcomes: Mapping[str, Any],
) -> dict[str, Any]:
    specs = {
        "campeao": lambda team: team == outcomes["campeao"],
        "libertadores": lambda team: team in outcomes["libertadores"],
        "sul_americana": lambda team: team in outcomes["sul_americana"],
    }
    result: dict[str, Any] = {}
    for event, predicate in specs.items():
        pairs: list[tuple[float, int]] = []
        high_total = high_ok = 0
        for team, rows in timelines.items():
            observed = int(predicate(team))
            first_high_confidence: float | None = None
            for row in rows:
                probability = finite_probability((row.get("probabilidades_pct") or {}).get(event))
                if probability is None:
                    continue
                games = int(row.get("jogos_atuais") or 0)
                # Calibração usa estados preditivos, não o fechamento já conhecido.
                if games <= 35 and probability < 100.0:
                    pairs.append((probability, observed))
                # Para o headline ≥80%, conta uma única previsão por clube/evento:
                # a primeira entrada real na faixa de alta confiança, evitando
                # inflar a métrica com o mesmo clube repetido após cada jogo.
                if first_high_confidence is None and games <= 35 and 80.0 <= probability < 100.0:
                    first_high_confidence = probability
            if first_high_confidence is not None:
                high_total += 1
                high_ok += observed
        result[event] = {
            "alta_confianca_80": {
                "amostra": high_total,
                "confirmadas": high_ok,
                "taxa_confirmacao_pct": round(100.0 * high_ok / high_total, 2) if high_total else None,
                "limiar_pct": 80,
                "criterio": "primeira entrada entre 80% e menos de 100%, até 35 jogos",
            },
            "calibracao": calibration_bins(pairs),
        }
    return {"status": "concluido", "eventos": result}


def current_tracking() -> dict[str, Any]:
    return {
        "status": "em_acompanhamento",
        "mensagem": "A cobertura da faixa de 80% será aferida contra posição e pontuação finais do Brasileirão 2026.",
    }


def generate_accuracy(history_games: Mapping[str, Any]) -> dict[str, Any]:
    results = load_json(RESULTS_PATH, {}) or {}
    history_season = load_json(HISTORY_SEASON_PATH, {}) or {}
    table = load_json(TABLE_PATH, {}) or {}
    selected = selected_pregame_records(history_games)
    games = game_accuracy(selected)
    timelines = build_timelines(history_season)
    league_finished, table_rows, table_message = final_table_state(table)
    range_coverage = final_range_coverage(timelines, table_rows) if league_finished else current_tracking()

    season_events: dict[str, Any] = {
        "status": "em_acompanhamento",
        "mensagem": "Campeão, Libertadores e Sul-Americana serão aferidos quando os desfechos estiverem factualmente definidos.",
    }
    if league_finished:
        try:
            config = load_json(CONFIG_PATH, {}) or {}
            competition_snapshots = {key: load_json(path, {}) for key, path in COMPETITION_PATHS.items()}
            outcomes = resolve_final_outcomes(table_rows, competition_snapshots, config)
        except Exception as exc:  # dado final ainda não pronto; mantém acompanhamento
            season_events = {
                "status": "aguardando_competicoes",
                "mensagem": f"Brasileirão concluído; aguardando definição factual das competições continentais: {exc}",
            }
        else:
            season_events = season_outcome_accuracy(timelines, outcomes)

    snapshots = list(history_season.get("snapshots") or [])
    first_timeline = min(
        (str(row.get("gerado_em") or "") for rows in timelines.values() for row in rows if row.get("gerado_em")),
        default=None,
    )
    latest_timeline = max(
        (str(row.get("gerado_em") or "") for rows in timelines.values() for row in rows if row.get("gerado_em")),
        default=None,
    )
    return {
        "schema_version": 1,
        "projeto": "AF-Previsão",
        "temporada": 2026,
        "gerado_em": now_brt(),
        "status": "ok",
        "escopo_publico": {
            "inicio_historico_classificacao": first_timeline,
            "inicio_historico_jogos": history_games.get("primeiro_registro"),
            "observacao": "Histórico auditável disponível a partir da segunda metade do Brasileirão 2026.",
            "avaliacao_alvo": "resultado_v_e_d",
            "avaliacao_jogo_individual_publica": False,
        },
        "integridade": {
            "historico_temporada_schema": history_season.get("schema_version"),
            "snapshots_temporada": len(snapshots),
            "hash_final_temporada": (history_season.get("integridade") or {}).get("hash_final"),
            "historico_pre_jogo_total": len(history_games.get("previsoes") or []),
            "hash_pre_jogo": (history_games.get("integridade") or {}).get("hash_conjunto_previsoes"),
            "ultima_previsao_temporada": latest_timeline,
        },
        "jogos": games,
        "classificacao": {
            "status": "concluido" if league_finished else "em_acompanhamento",
            "mensagem": table_message,
            "faixa_80": range_coverage,
        },
        "eventos_temporada": season_events,
        "timeline_clubes": timelines,
    }


def validate_accuracy(payload: Mapping[str, Any]) -> None:
    if payload.get("status") != "ok":
        raise ValueError("acurácia com status inválido")
    timelines = payload.get("timeline_clubes") or {}
    if not isinstance(timelines, Mapping):
        raise ValueError("timeline_clubes inválida")
    for team, rows in timelines.items():
        if not team or not isinstance(rows, list):
            raise ValueError("timeline de clube inválida")
        seen: set[str] = set()
        for row in rows:
            digest = str(row.get("hash_previsao_clube") or "")
            if not digest or digest in seen:
                raise ValueError(f"{team}: estado de previsão duplicado ou sem hash")
            seen.add(digest)
            interval = row.get("faixa_posicao_80") or {}
            if interval.get("melhor") is not None:
                best, worst = int(interval["melhor"]), int(interval["pior"])
                if not 1 <= best <= worst <= 20:
                    raise ValueError(f"{team}: faixa de posição inválida")
    games = payload.get("jogos") or {}
    top = games.get("maior_probabilidade") or {}
    if int(top.get("confirmadas") or 0) > int(top.get("amostra") or 0):
        raise ValueError("confirmações maiores que a amostra")
    for row in games.get("calibracao") or []:
        if not 0 <= float(row.get("frequencia_observada_pct") or 0) <= 100:
            raise ValueError("calibração fora da faixa")


def update_files(capture: bool, update: bool) -> dict[str, Any]:
    history = load_json(HISTORY_GAMES_PATH, None) or empty_game_history()
    if history.get("integridade"):
        validate_game_history(history)
    history_before = deepcopy(history)
    before_semantic = semantic_hash(history_before)
    # Migra metadados/critério sem tocar nas previsões históricas já congeladas.
    # O painel avalia exclusivamente resultado V/E/D; nenhum outro alvo é publicado.
    history["criterio"] = deepcopy(empty_game_history()["criterio"])

    capture_summary = {"adicionadas": 0, "total": len(history.get("previsoes") or [])}
    if capture:
        document = load_json(PREGAME_PATH, {}) or {}
        capture_summary = capture_pregame(history, document)
    results = load_json(RESULTS_PATH, {}) or {}
    refresh_results(history, results)

    forecasts = list(history.get("previsoes") or [])
    observed = history.get("resultados_observados") or {}
    history["integridade"] = {
        "algoritmo": "SHA-256",
        "total_previsoes_distintas": len(forecasts),
        "total_eventos_com_previsao": len({str(item.get('event_id') or '') for item in forecasts if item.get('event_id')}),
        "hash_conjunto_previsoes": canonical_hash([item.get("hash_previsao") for item in forecasts]),
        "hash_resultados_observados": canonical_hash(observed),
    }
    history["total_resultados_observados"] = len(observed)
    after_semantic = semantic_hash(history)
    history_changed = after_semantic != before_semantic or not HISTORY_GAMES_PATH.exists()
    if history_changed:
        history["atualizado_em"] = now_brt()
    else:
        if history_before.get("atualizado_em"):
            history["atualizado_em"] = history_before.get("atualizado_em")
        else:
            history.pop("atualizado_em", None)
    validate_game_history(history)

    payload = generate_accuracy(history) if update else None
    accuracy_changed = False
    existing_accuracy = load_json(OUTPUT_PATH, None) if update else None
    if payload is not None:
        validate_accuracy(payload)
        accuracy_changed = (
            not OUTPUT_PATH.exists()
            or not isinstance(existing_accuracy, Mapping)
            or semantic_hash(payload) != semantic_hash(existing_accuracy)
        )
        if not accuracy_changed and isinstance(existing_accuracy, Mapping):
            payload = dict(existing_accuracy)

    # Só grava depois de todas as validações: operação transacional local.
    if history_changed:
        write_json(HISTORY_GAMES_PATH, history)
    if payload is not None and accuracy_changed:
        write_json(OUTPUT_PATH, payload)
    return {
        "captura": capture_summary,
        "avaliados": int(((payload or existing_accuracy or {}).get("jogos") or {}).get("jogos_avaliados") or 0),
        "clubes_timeline": len((payload or existing_accuracy or {}).get("timeline_clubes") or {}),
        "historico_alterado": history_changed,
        "painel_alterado": accuracy_changed,
    }


def self_test() -> None:
    document = {
        "gerado_em": "2026-08-07T12:00:00-03:00",
        "versao_modelo": "AF teste",
        "hash_entrada": "entrada",
        "jogos": [{
            "event_id": "1", "rodada": 22, "data_iso": "2026-08-07T19:00:00-03:00",
            "mandante": "A", "visitante": "B",
            "probabilidades_pct": {"mandante": 70.0, "empate": 20.0, "visitante": 10.0},
        }],
    }
    history = empty_game_history()
    capture = capture_pregame(history, document)
    if capture["adicionadas"] != 1:
        raise AssertionError("captura sintética falhou")
    capture_again = capture_pregame(history, document)
    if capture_again["adicionadas"] != 0:
        raise AssertionError("captura duplicou previsão idêntica")
    history["resultados_observados"] = {
        "1": {"event_id": "1", "rodada": 22, "data_iso": "2026-08-07T19:00:00-03:00", "mandante": "A", "visitante": "B", "resultado": "mandante"}
    }
    chosen = selected_pregame_records(history)
    if len(chosen) != 1 or chosen[0]["resultado_observado"] != "mandante":
        raise AssertionError("seleção pré-jogo válida falhou")
    metrics = game_accuracy(chosen)
    if metrics["maior_probabilidade"]["taxa_confirmacao_pct"] != 100.0:
        raise AssertionError("acurácia sintética deveria ser 100%")
    if not metrics["calibracao"]:
        raise AssertionError("calibração sintética ausente")

    late = deepcopy(document)
    late["gerado_em"] = "2026-08-07T20:00:00-03:00"
    capture_pregame(history, late)
    if selected_pregame_records(history)[0]["gerado_em_modelo"] != "2026-08-07T12:00:00-03:00":
        raise AssertionError("previsão posterior ao kickoff contaminou a avaliação")

    timeline_history = {
        "snapshots": [{
            "gerado_em": "2026-08-01T10:00:00-03:00",
            "versao_modelo": "AF teste",
            "hash_snapshot": "s1",
            "clubes": [{
                "clube": "A", "jogos_atuais": 20, "posicao_atual": 7, "pontos_atuais": 28,
                "posicao_projetada": 6, "faixa_posicao_80": {"melhor": 4, "pior": 9},
                "pontos_projetados": 55, "pontos_percentis": {"p10": 49, "p90": 61},
                "campeao_pct": 2, "libertadores_pct": 45, "sul_americana_pct": 40,
            }],
        }]
    }
    timelines = build_timelines(timeline_history)
    if timelines["A"][0]["faixa_posicao_80"] != {"melhor": 4, "pior": 9}:
        raise AssertionError("timeline sintética perdeu faixa de 80%")

    synthetic_timelines = {}
    synthetic_table = []
    for index in range(20):
        team = f"T{index+1}"
        final_pos = index + 1
        synthetic_table.append({"clube": team, "posicao": final_pos, "pontos": 80 - index})
        synthetic_timelines[team] = [
            {
                "jogos_atuais": 20,
                "faixa_posicao_80": {"melhor": max(1, final_pos - 1), "pior": min(20, final_pos + 1)},
                "faixa_pontos_80": {"min": 78 - index, "max": 82 - index},
                "probabilidades_pct": {"campeao": 85 if index == 0 else 5, "libertadores": 85 if index < 5 else 20, "sul_americana": 85 if 5 <= index < 10 else 20},
            },
            {
                "jogos_atuais": 38,
                "faixa_posicao_80": {"melhor": final_pos, "pior": final_pos},
                "faixa_pontos_80": {"min": 80 - index, "max": 80 - index},
                "probabilidades_pct": {"campeao": 100 if index == 0 else 0, "libertadores": 100 if index < 5 else 0, "sul_americana": 100 if 5 <= index < 10 else 0},
            },
        ]
    coverage = final_range_coverage(synthetic_timelines, synthetic_table)
    if any(int(item["apos_jogos"]) > 35 for item in coverage["posicao"]["marcos"]):
        raise AssertionError("faixa final contaminada por estado pós-fato de 36–38 jogos")
    outcomes = {"campeao": "T1", "libertadores": {f"T{i}" for i in range(1, 6)}, "sul_americana": {f"T{i}" for i in range(6, 11)}}
    outcome_accuracy = season_outcome_accuracy(synthetic_timelines, outcomes)
    if outcome_accuracy["eventos"]["campeao"]["alta_confianca_80"]["amostra"] != 1:
        raise AssertionError("alta confiança contou o mesmo clube mais de uma vez")
    print("Self-test acurácia AF-Previsão: OK")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capturar-pre-jogo", action="store_true")
    parser.add_argument("--atualizar", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    capture = args.capturar_pre_jogo or not args.atualizar
    update = args.atualizar or (not args.capturar_pre_jogo)
    summary = update_files(capture=capture, update=update)
    print(
        "Acurácia AF-Previsão atualizada: "
        f"+{summary['captura']['adicionadas']} previsões; "
        f"{summary['avaliados']} jogos avaliados; "
        f"{summary['clubes_timeline']} clubes na timeline; "
        f"histórico={'alterado' if summary['historico_alterado'] else 'sem mudança'}; "
        f"painel={'alterado' if summary['painel_alterado'] else 'sem mudança'}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
