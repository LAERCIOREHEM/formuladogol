#!/usr/bin/env python3
"""Avalia o histórico público do AF-Previsão sem antecipar resultados futuros.

Execução 5:
  * audita a integridade encadeada dos snapshots;
  * acompanha a cobertura histórica durante o campeonato;
  * só calcula métricas finais quando a Série A e as três competições que
    alteram vagas continentais estiverem concluídas;
  * mede posição, pontos e eventos probabilísticos com regras próprias.

Uso:
    python scripts/avaliar_af_previsao.py
    python scripts/avaliar_af_previsao.py --strict
    python scripts/avaliar_af_previsao.py --self-test
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

try:
    import numpy as np
except ImportError as exc:  # pragma: no cover
    raise SystemExit("A avaliação do AF-Previsão requer numpy") from exc

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from af_previsao_continental import (  # noqa: E402
    ContinentalDataNotReady,
    CupSimulation,
    allocate_integrated_qualification,
    brazilian_teams_in_events,
    completed_champion,
    parse_snapshot,
)

BRT = ZoneInfo("America/Sao_Paulo")
TABLE_PATH = ROOT / "tabela.json"
HISTORY_PATH = ROOT / "dados-br" / "historico-probabilidades.json"
CONFIG_PATH = ROOT / "dados-br" / "config-af-previsao.json"
OUTPUT_PATH = ROOT / "dados-br" / "avaliacao-af-previsao.json"
COMPETITION_PATHS = {
    "copa_do_brasil": ROOT / "dados-br" / "competicoes-af-previsao" / "copa-do-brasil.json",
    "libertadores": ROOT / "dados-br" / "competicoes-af-previsao" / "libertadores.json",
    "sul_americana": ROOT / "dados-br" / "competicoes-af-previsao" / "sul-americana.json",
}
EPS = 1e-12


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: raiz JSON precisa ser objeto")
    return data


def write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")
    os.replace(temporary, path)


def now_brt() -> str:
    return datetime.now(BRT).replace(microsecond=0).isoformat()


def canonical_bytes(payload: Any) -> bytes:
    return json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def snapshot_hash(snapshot: Mapping[str, Any]) -> str:
    payload = deepcopy(dict(snapshot))
    payload.pop("hash_snapshot", None)
    return hashlib.sha256(canonical_bytes(payload)).hexdigest()


def _finite_probability(value: Any) -> bool:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return False
    return math.isfinite(number) and 0.0 <= number <= 100.0


def audit_history(history: Mapping[str, Any], require_chain: bool = False) -> dict[str, Any]:
    snapshots = list(history.get("snapshots") or [])
    errors: list[str] = []
    warnings: list[str] = []
    seen_inputs: set[str] = set()
    previous_hash: str | None = None
    rounds: list[int] = []
    model_versions: set[str] = set()
    chain_present = bool(snapshots) and all(item.get("hash_snapshot") for item in snapshots)

    for index, snapshot in enumerate(snapshots):
        prefix = f"snapshot {index + 1}"
        input_hash = str(snapshot.get("hash_entrada") or "")
        if not input_hash:
            errors.append(f"{prefix}: hash_entrada ausente")
        elif input_hash in seen_inputs:
            errors.append(f"{prefix}: hash_entrada duplicado")
        else:
            seen_inputs.add(input_hash)

        clubs = list(snapshot.get("clubes") or [])
        names = [str(row.get("clube") or "").strip() for row in clubs]
        if len(clubs) != 20 or len(set(names)) != 20 or any(not name for name in names):
            errors.append(f"{prefix}: precisa conter 20 clubes únicos")

        for row in clubs:
            club = str(row.get("clube") or "clube desconhecido")
            for field in ("campeao_pct", "rebaixamento_pct"):
                if not _finite_probability(row.get(field)):
                    errors.append(f"{prefix}: {club} com {field} inválido")
            for primary, fallback in (
                ("libertadores_pct", "libertadores_base_pct"),
                ("sul_americana_pct", "sul_americana_base_pct"),
            ):
                value = row.get(primary, row.get(fallback))
                if not _finite_probability(value):
                    errors.append(f"{prefix}: {club} com {primary} inválido")

            distribution = row.get("distribuicao_posicoes_pct")
            if distribution is not None:
                if not isinstance(distribution, list) or len(distribution) != 20:
                    errors.append(f"{prefix}: distribuição de posições inválida para {club}")
                else:
                    try:
                        total = sum(float(value) for value in distribution)
                    except (TypeError, ValueError):
                        total = math.nan
                    if not math.isfinite(total) or abs(total - 100.0) > 0.03:
                        errors.append(f"{prefix}: distribuição de posições não soma 100% para {club}")

        round_reference = snapshot.get("rodada_referencia")
        if round_reference is not None:
            try:
                round_number = int(round_reference)
            except (TypeError, ValueError):
                errors.append(f"{prefix}: rodada_referencia inválida")
            else:
                if not 0 <= round_number <= 38:
                    errors.append(f"{prefix}: rodada fora do intervalo")
                rounds.append(round_number)

        version = str(snapshot.get("versao_modelo") or "").strip()
        if version:
            model_versions.add(version)

        if chain_present:
            declared_previous = snapshot.get("hash_anterior")
            if declared_previous != previous_hash:
                errors.append(f"{prefix}: hash_anterior não corresponde ao elo anterior")
            computed = snapshot_hash(snapshot)
            if snapshot.get("hash_snapshot") != computed:
                errors.append(f"{prefix}: hash_snapshot divergente do conteúdo")
            previous_hash = computed

    if rounds and any(current < previous for previous, current in zip(rounds, rounds[1:])):
        warnings.append("as rodadas não são monotônicas; jogos atrasados podem explicar a sequência")

    if snapshots and not chain_present:
        message = "histórico estruturalmente válido, mas ainda sem cadeia SHA-256 da Execução 5"
        if require_chain:
            errors.append(message)
        else:
            warnings.append(message)

    declared_integrity = history.get("integridade") or {}
    if chain_present:
        if declared_integrity.get("hash_final") not in {None, previous_hash}:
            errors.append("hash_final do histórico diverge do último snapshot")
        if declared_integrity.get("quantidade_snapshots") not in {None, len(snapshots)}:
            errors.append("quantidade_snapshots declarada diverge da lista")

    return {
        "valido": not errors,
        "encadeado": chain_present,
        "algoritmo": "SHA-256" if chain_present else None,
        "quantidade_snapshots": len(snapshots),
        "hash_inicial": snapshots[0].get("hash_snapshot") if chain_present and snapshots else None,
        "hash_final": previous_hash if chain_present else None,
        "rodadas_distintas": sorted(set(rounds)),
        "modelos_registrados": sorted(model_versions),
        "erros": errors,
        "avisos": warnings,
    }


def final_table_state(table: Mapping[str, Any]) -> tuple[bool, list[dict[str, Any]], str]:
    rows = list(table.get("tabela") or [])
    if len(rows) != 20:
        return False, [], "A tabela ainda não contém 20 clubes."
    try:
        normalized = [
            {
                "clube": str(row.get("time") or "").strip(),
                "posicao": int(row.get("pos")),
                "pontos": int(row.get("pontos")),
                "jogos": int(row.get("jogos")),
            }
            for row in rows
        ]
    except (TypeError, ValueError):
        return False, [], "A tabela contém posição, pontos ou jogos inválidos."
    if len({row["clube"] for row in normalized}) != 20 or any(not row["clube"] for row in normalized):
        return False, [], "A tabela não contém 20 nomes únicos."
    if sorted(row["posicao"] for row in normalized) != list(range(1, 21)):
        return False, [], "As posições finais ainda não formam a sequência de 1 a 20."
    if any(row["jogos"] != 38 for row in normalized):
        maximum = max((row["jogos"] for row in normalized), default=0)
        return False, normalized, f"Campeonato em andamento: maior número de jogos por clube é {maximum}/38."
    if sum(row["jogos"] for row in normalized) != 760:
        return False, normalized, "A soma de partidas da tabela final não é 760 jogos de clube."
    normalized.sort(key=lambda item: item["posicao"])
    return True, normalized, "Campeonato concluído com 20 clubes e 38 jogos por clube."


def final_cup_simulation(snapshot: Mapping[str, Any]) -> CupSimulation:
    competition, events, _ = parse_snapshot(snapshot)
    result = completed_champion(events)
    if result is None:
        raise ContinentalDataNotReady(f"{competition}: campeão ainda não definido")
    champion, runner = result
    names = sorted({event.home.name for event in events} | {event.away.name for event in events})
    index = {name: position for position, name in enumerate(names)}
    if champion not in index or not runner or runner not in index:
        raise ContinentalDataNotReady(f"{competition}: campeão/vice não identificados na lista de participantes")
    return CupSimulation(
        competition=competition,
        team_names=tuple(names),
        brazilian_team_names=brazilian_teams_in_events(competition, events),
        champion_ids=np.asarray([index[champion]], dtype=np.int16),
        runner_up_ids=np.asarray([index[runner]], dtype=np.int16),
        audit={"status": "resultado_final", "campeao": champion, "vice": runner},
    )


def resolve_final_outcomes(
    table_rows: Sequence[Mapping[str, Any]],
    competition_snapshots: Mapping[str, Mapping[str, Any]],
    config: Mapping[str, Any],
) -> dict[str, Any]:
    team_names = tuple(str(row["clube"]) for row in table_rows)
    if len(team_names) != 20:
        raise ValueError("classificação final precisa conter 20 clubes")
    simulations = {
        key: final_cup_simulation(competition_snapshots[key])
        for key in ("copa_do_brasil", "libertadores", "sul_americana")
    }
    league_order = np.asarray([list(range(20))], dtype=np.int16)
    rules = (config.get("execucao_2_5") or {})
    allocated = allocate_integrated_qualification(
        league_order,
        team_names,
        simulations["copa_do_brasil"],
        simulations["libertadores"],
        simulations["sul_americana"],
        1,
        rules,
    )
    clubs = allocated["clubes"]
    positions = {str(row["clube"]): int(row["posicao"]) for row in table_rows}
    points = {str(row["clube"]): int(row["pontos"]) for row in table_rows}
    champion = team_names[0]
    relegated = {team for team, position in positions.items() if position >= 17}
    libertadores = {
        team for team in team_names
        if int(clubs[team]["libertadores"]["total"]["ocorrencias"]) == 1
    }
    sul_americana = {
        team for team in team_names
        if int(clubs[team]["sul_americana"]["total"]["ocorrencias"]) == 1
    }
    return {
        "campeao": champion,
        "posicoes": positions,
        "pontos": points,
        "libertadores": libertadores,
        "sul_americana": sul_americana,
        "rebaixados": relegated,
        "copas": {key: value.audit for key, value in simulations.items()},
        "auditoria_alocacao": allocated["auditoria"],
    }


def _value(row: Mapping[str, Any], *fields: str) -> float | None:
    for field in fields:
        value = row.get(field)
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(number):
            return number
    return None


def binary_scores(probabilities: Iterable[tuple[float, int]]) -> dict[str, Any]:
    pairs = [(min(1.0, max(0.0, float(p))), int(y)) for p, y in probabilities]
    if not pairs:
        return {"amostra": 0, "brier": None, "log_loss": None}
    brier = sum((p - y) ** 2 for p, y in pairs) / len(pairs)
    log_loss = -sum(y * math.log(max(EPS, p)) + (1 - y) * math.log(max(EPS, 1 - p)) for p, y in pairs) / len(pairs)
    return {"amostra": len(pairs), "brier": round(brier, 8), "log_loss": round(log_loss, 8)}


def calibration_bins(probabilities: Iterable[tuple[float, int]], bins: int = 10) -> list[dict[str, Any]]:
    buckets: list[list[tuple[float, int]]] = [[] for _ in range(bins)]
    for probability, outcome in probabilities:
        p = min(1.0, max(0.0, float(probability)))
        index = min(bins - 1, int(p * bins))
        buckets[index].append((p, int(outcome)))
    result: list[dict[str, Any]] = []
    for index, bucket in enumerate(buckets):
        if not bucket:
            continue
        mean_probability = sum(item[0] for item in bucket) / len(bucket)
        observed = sum(item[1] for item in bucket) / len(bucket)
        result.append({
            "faixa_pct": [index * (100 // bins), (index + 1) * (100 // bins)],
            "amostra": len(bucket),
            "probabilidade_media_pct": round(100.0 * mean_probability, 4),
            "frequencia_observada_pct": round(100.0 * observed, 4),
            "erro_absoluto_pontos_percentuais": round(100.0 * abs(mean_probability - observed), 4),
        })
    return result


def position_rps(distribution_pct: Sequence[Any], actual_position: int) -> float | None:
    if len(distribution_pct) != 20 or not 1 <= actual_position <= 20:
        return None
    try:
        probabilities = [max(0.0, float(value) / 100.0) for value in distribution_pct]
    except (TypeError, ValueError):
        return None
    total = sum(probabilities)
    if not math.isfinite(total) or total <= 0:
        return None
    probabilities = [value / total for value in probabilities]
    cumulative = 0.0
    score = 0.0
    for index in range(19):
        cumulative += probabilities[index]
        observed = 1.0 if actual_position <= index + 1 else 0.0
        score += (cumulative - observed) ** 2
    return score / 19.0


def evaluate_snapshot(snapshot: Mapping[str, Any], outcomes: Mapping[str, Any]) -> dict[str, Any]:
    rows = list(snapshot.get("clubes") or [])
    position_errors: list[float] = []
    point_errors: list[float] = []
    position_rps_values: list[float] = []
    binary: dict[str, list[tuple[float, int]]] = defaultdict(list)
    within_one = 0
    within_two = 0
    exact = 0

    for row in rows:
        team = str(row.get("clube") or "")
        if team not in outcomes["posicoes"]:
            continue
        actual_position = int(outcomes["posicoes"][team])
        actual_points = int(outcomes["pontos"][team])
        projected_position = _value(row, "posicao_projetada", "posicao_media_estimada")
        projected_points = _value(row, "pontos_projetados", "pontos_media_estimada", "pontos_medios")
        if projected_position is not None:
            error = abs(projected_position - actual_position)
            position_errors.append(error)
            exact += int(error < 0.5)
            within_one += int(error <= 1.0)
            within_two += int(error <= 2.0)
        if projected_points is not None:
            point_errors.append(projected_points - actual_points)
        rps = position_rps(row.get("distribuicao_posicoes_pct") or [], actual_position)
        if rps is not None:
            position_rps_values.append(rps)

        event_specs = {
            "campeao": (_value(row, "campeao_pct"), int(team == outcomes["campeao"])),
            "libertadores": (_value(row, "libertadores_pct", "libertadores_base_pct"), int(team in outcomes["libertadores"])),
            "sul_americana": (_value(row, "sul_americana_pct", "sul_americana_base_pct"), int(team in outcomes["sul_americana"])),
            "rebaixamento": (_value(row, "rebaixamento_pct"), int(team in outcomes["rebaixados"])),
        }
        for event, (probability_pct, observed) in event_specs.items():
            if probability_pct is not None:
                binary[event].append((probability_pct / 100.0, observed))

    position_metrics = {
        "amostra": len(position_errors),
        "mae_posicoes": round(sum(position_errors) / len(position_errors), 6) if position_errors else None,
        "rmse_posicoes": round(math.sqrt(sum(value * value for value in position_errors) / len(position_errors)), 6) if position_errors else None,
        "acerto_exato_pct": round(100.0 * exact / len(position_errors), 4) if position_errors else None,
        "ate_1_posicao_pct": round(100.0 * within_one / len(position_errors), 4) if position_errors else None,
        "ate_2_posicoes_pct": round(100.0 * within_two / len(position_errors), 4) if position_errors else None,
        "rps_posicao": round(sum(position_rps_values) / len(position_rps_values), 8) if position_rps_values else None,
        "amostra_rps": len(position_rps_values),
    }
    point_metrics = {
        "amostra": len(point_errors),
        "mae_pontos": round(sum(abs(value) for value in point_errors) / len(point_errors), 6) if point_errors else None,
        "rmse_pontos": round(math.sqrt(sum(value * value for value in point_errors) / len(point_errors)), 6) if point_errors else None,
        "vies_medio_pontos": round(sum(point_errors) / len(point_errors), 6) if point_errors else None,
    }
    probabilistic = {event: binary_scores(values) for event, values in binary.items()}
    return {
        "gerado_em": snapshot.get("gerado_em"),
        "rodada_referencia": snapshot.get("rodada_referencia"),
        "versao_modelo": snapshot.get("versao_modelo"),
        "hash_snapshot": snapshot.get("hash_snapshot"),
        "posicao": position_metrics,
        "pontos": point_metrics,
        "eventos": probabilistic,
        "pares_eventos": {key: values for key, values in binary.items()},
    }


def aggregate_evaluations(evaluations: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    position_abs: list[tuple[float, int]] = []
    point_abs: list[tuple[float, int]] = []
    rps_weighted: list[tuple[float, int]] = []
    binary_accumulator: dict[str, list[tuple[float, int]]] = defaultdict(list)

    for item in evaluations:
        position = item.get("posicao") or {}
        if position.get("mae_posicoes") is not None and int(position.get("amostra") or 0) > 0:
            position_abs.append((float(position["mae_posicoes"]), int(position["amostra"])))
        points = item.get("pontos") or {}
        if points.get("mae_pontos") is not None and int(points.get("amostra") or 0) > 0:
            point_abs.append((float(points["mae_pontos"]), int(points["amostra"])))
        if position.get("rps_posicao") is not None and int(position.get("amostra_rps") or 0) > 0:
            rps_weighted.append((float(position["rps_posicao"]), int(position["amostra_rps"])))
        for event, values in (item.get("pares_eventos") or {}).items():
            binary_accumulator[event].extend(values)

    def weighted(values: Sequence[tuple[float, int]]) -> float | None:
        total_weight = sum(weight for _, weight in values)
        if not total_weight:
            return None
        return sum(value * weight for value, weight in values) / total_weight

    events = {event: binary_scores(values) for event, values in binary_accumulator.items()}
    calibrations = {event: calibration_bins(values) for event, values in binary_accumulator.items()}
    return {
        "snapshots_avaliados": len(evaluations),
        "posicao": {
            "mae_posicoes": round(weighted(position_abs), 6) if weighted(position_abs) is not None else None,
            "rps_posicao": round(weighted(rps_weighted), 8) if weighted(rps_weighted) is not None else None,
            "clubes_snapshot_avaliados": sum(weight for _, weight in position_abs),
        },
        "pontos": {
            "mae_pontos": round(weighted(point_abs), 6) if weighted(point_abs) is not None else None,
            "clubes_snapshot_avaliados": sum(weight for _, weight in point_abs),
        },
        "eventos": events,
        "calibracao": calibrations,
    }


def generate_evaluation(strict: bool = False) -> dict[str, Any]:
    history = load_json(HISTORY_PATH)
    table = load_json(TABLE_PATH)
    config = load_json(CONFIG_PATH)
    history_audit = audit_history(history, require_chain=strict)
    generated_at = now_brt()
    snapshots = list(history.get("snapshots") or [])
    rounds = history_audit.get("rodadas_distintas") or []
    exec5 = config.get("execucao_5") or {}
    minimum_publication = int(exec5.get("minimo_snapshots_publicacao") or 5)

    common = {
        "schema_version": 1,
        "projeto": "AF-Previsão",
        "temporada": int(config.get("temporada_corrente") or 2026),
        "gerado_em": generated_at,
        "versao_avaliacao": "AF-Avaliação 1.0",
        "integridade_historico": history_audit,
        "cobertura": {
            "snapshots": len(snapshots),
            "rodadas_distintas": len(rounds),
            "primeira_rodada": min(rounds) if rounds else None,
            "ultima_rodada": max(rounds) if rounds else None,
            "primeiro_registro": snapshots[0].get("gerado_em") if snapshots else None,
            "ultimo_registro": snapshots[-1].get("gerado_em") if snapshots else None,
            "minimo_snapshots_publicacao": minimum_publication,
        },
        "metricas_planejadas": {
            "posicao": ["MAE", "RMSE", "RPS da distribuição de posições", "acerto exato e faixas"],
            "pontos": ["MAE", "RMSE", "viés médio"],
            "eventos": ["Brier Score", "Log Loss", "calibração em dez faixas"],
            "eventos_avaliados": ["campeão", "Libertadores", "Sul-Americana", "rebaixamento"],
        },
        "publicar_na_interface": False,
    }

    if not history_audit["valido"]:
        return {
            **common,
            "status": "erro_integridade_historico",
            "mensagem": "A avaliação foi bloqueada porque o histórico não passou nas travas de integridade.",
            "avaliacao_final": None,
        }

    league_finished, table_rows, table_message = final_table_state(table)
    if not league_finished:
        return {
            **common,
            "status": "coletando_historico",
            "mensagem": table_message,
            "campeonato": {"concluido": False, "detalhe": table_message},
            "avaliacao_final": None,
        }

    try:
        competition_snapshots = {key: load_json(path) for key, path in COMPETITION_PATHS.items()}
        outcomes = resolve_final_outcomes(table_rows, competition_snapshots, config)
    except (OSError, ValueError, ContinentalDataNotReady) as exc:
        return {
            **common,
            "status": "aguardando_resultados_continentais",
            "mensagem": f"Brasileirão concluído, mas a avaliação das vagas aguarda as competições relacionadas: {exc}",
            "campeonato": {"concluido": True, "detalhe": table_message},
            "avaliacao_final": None,
        }

    detailed = [evaluate_snapshot(snapshot, outcomes) for snapshot in snapshots]
    aggregate = aggregate_evaluations(detailed)
    public_ready = len(snapshots) >= minimum_publication
    versions: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in detailed:
        versions[str(item.get("versao_modelo") or "não informada")].append(item)
    by_version = {version: aggregate_evaluations(items) for version, items in sorted(versions.items())}

    # Remove pares internos usados para agregação antes de publicar o JSON.
    public_detailed = []
    for item in detailed:
        clean = dict(item)
        clean.pop("pares_eventos", None)
        public_detailed.append(clean)

    return {
        **common,
        "status": "avaliacao_concluida" if public_ready else "avaliacao_concluida_amostra_reduzida",
        "mensagem": (
            "Avaliação final calculada com histórico suficiente para publicação."
            if public_ready
            else "Avaliação final calculada, mas a quantidade de snapshots ainda é pequena e deve ser interpretada com cautela."
        ),
        "campeonato": {"concluido": True, "detalhe": table_message},
        "publicar_na_interface": public_ready,
        "resultado_observado": {
            "campeao": outcomes["campeao"],
            "libertadores": sorted(outcomes["libertadores"]),
            "sul_americana": sorted(outcomes["sul_americana"]),
            "rebaixados": sorted(outcomes["rebaixados"]),
            "tabela_final": table_rows,
            "copas": outcomes["copas"],
        },
        "avaliacao_final": {
            "agregado": aggregate,
            "por_versao_modelo": by_version,
            "por_snapshot": public_detailed,
            "observacao": "Cada snapshot é avaliado contra o desfecho final; métricas menores são melhores, exceto percentuais de acerto.",
        },
    }


def self_test() -> None:
    teams = [f"Clube {index:02d}" for index in range(1, 21)]
    snapshot = {
        "gerado_em": "2026-07-18T08:00:00-03:00",
        "rodada_referencia": 19,
        "hash_entrada": "entrada-1",
        "versao_modelo": "AF-Previsão teste",
        "hash_anterior": None,
        "clubes": [],
    }
    for index, team in enumerate(teams, start=1):
        distribution = [0.0] * 20
        distribution[index - 1] = 100.0
        snapshot["clubes"].append({
            "clube": team,
            "posicao_projetada": index,
            "pontos_projetados": 80 - index,
            "campeao_pct": 100.0 if index == 1 else 0.0,
            "libertadores_pct": 100.0 if index <= 7 else 0.0,
            "sul_americana_pct": 100.0 if 8 <= index <= 13 else 0.0,
            "rebaixamento_pct": 100.0 if index >= 17 else 0.0,
            "distribuicao_posicoes_pct": distribution,
        })
    snapshot["hash_snapshot"] = snapshot_hash(snapshot)
    history = {
        "schema_version": 3,
        "snapshots": [snapshot],
        "integridade": {"hash_final": snapshot["hash_snapshot"], "quantidade_snapshots": 1},
    }
    audit = audit_history(history, require_chain=True)
    if not audit["valido"] or not audit["encadeado"]:
        raise AssertionError(f"cadeia sintética inválida: {audit}")
    tampered = deepcopy(history)
    tampered["snapshots"][0]["clubes"][0]["campeao_pct"] = 99.0
    if audit_history(tampered, require_chain=True)["valido"]:
        raise AssertionError("alteração retroativa não foi detectada")

    outcomes = {
        "campeao": teams[0],
        "posicoes": {team: index for index, team in enumerate(teams, start=1)},
        "pontos": {team: 80 - index for index, team in enumerate(teams, start=1)},
        "libertadores": set(teams[:7]),
        "sul_americana": set(teams[7:13]),
        "rebaixados": set(teams[16:]),
    }
    evaluation = evaluate_snapshot(snapshot, outcomes)
    if evaluation["posicao"]["mae_posicoes"] != 0.0:
        raise AssertionError("MAE de posição perfeito deveria ser zero")
    if evaluation["pontos"]["mae_pontos"] != 0.0:
        raise AssertionError("MAE de pontos perfeito deveria ser zero")
    for event in ("campeao", "libertadores", "sul_americana", "rebaixamento"):
        if evaluation["eventos"][event]["brier"] != 0.0:
            raise AssertionError(f"Brier perfeito deveria ser zero em {event}")
    aggregate = aggregate_evaluations([evaluation])
    if aggregate["eventos"]["campeao"]["brier"] != 0.0:
        raise AssertionError("agregação alterou o Brier perfeito")
    if position_rps([5.0] * 20, 10) is None:
        raise AssertionError("RPS de posição não foi calculado")

    def final_snapshot(key: str, champion: str, runner: str) -> dict[str, Any]:
        return {
            "status": "ok",
            "competicao": {"chave": key},
            "eventos": [{
                "event_id": f"final-{key}",
                "data_iso": "2026-12-10T20:00:00-03:00",
                "fase": "Final",
                "fase_ordem": 900,
                "concluido": True,
                "mandante": {"nome": champion, "espn_id": "1", "serie_a_2026": True, "pais": "BRA", "placar": 2},
                "visitante": {"nome": runner, "espn_id": "2", "serie_a_2026": True, "pais": "BRA", "placar": 1},
                "vencedor": champion,
                "penaltis": False,
            }],
        }

    final_rows = [
        {"clube": team, "posicao": index, "pontos": 80 - index, "jogos": 38}
        for index, team in enumerate(teams, start=1)
    ]
    competition_snapshots = {
        "copa_do_brasil": final_snapshot("copa_do_brasil", teams[7], teams[8]),
        "libertadores": final_snapshot("libertadores", teams[0], teams[9]),
        "sul_americana": final_snapshot("sul_americana", teams[10], teams[11]),
    }
    rules = {
        "execucao_2_5": {
            "brasileirao_vagas_diretas": 4,
            "brasileirao_vagas_preliminares": 1,
            "sul_americana_vagas": 6,
            "limiar_exibicao_percentual": 0.1,
        }
    }
    resolved = resolve_final_outcomes(final_rows, competition_snapshots, rules)
    if len(resolved["sul_americana"]) != 6 or len(resolved["rebaixados"]) != 4:
        raise AssertionError("desfechos finais integrados foram alocados incorretamente")
    if resolved["libertadores"] & resolved["sul_americana"]:
        raise AssertionError("um clube não pode terminar simultaneamente nas duas competições")
    print("Self-test AF-Avaliação Execução 5: OK")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true", help="exige histórico já encadeado")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    payload = generate_evaluation(strict=args.strict)
    write_json(OUTPUT_PATH, payload)
    print(f"AF-Avaliação: {payload['status']} · {payload['cobertura']['snapshots']} snapshots")
    if args.strict and payload["status"] == "erro_integridade_historico":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
