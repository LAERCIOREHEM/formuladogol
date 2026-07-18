#!/usr/bin/env python3
"""Gera as probabilidades do AF-Previsão para o Brasileirão 2026.

Execução 2 do projeto:
  * ajusta a arquitetura Poisson log-linear MAP selecionada no backtesting;
  * prevê placares e resultados das partidas restantes;
  * simula o campeonato por Monte Carlo;
  * produz probabilidades de título, zonas continentais e rebaixamento;
  * registra auditoria, convergência, sensibilidades e histórico versionado.

O modelo publicado usa a arquitetura vencedora da Execução 1. A correção
Dixon–Coles permanece implementada e auditada como análise de sensibilidade;
ela só entra na produção quando melhorar as regras de pontuação fora da amostra.
O AF-Score também é auditado, mas não altera a previsão enquanto não existir
cobertura histórica homogênea para backtesting sem vazamento temporal.

Uso:
    python scripts/gerar_probabilidades_brasileirao.py
    python scripts/gerar_probabilidades_brasileirao.py --simulacoes 200000
    python scripts/gerar_probabilidades_brasileirao.py --self-test
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence
from zoneinfo import ZoneInfo

try:
    import numpy as np
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "AF-Previsão requer numpy. Instale com: python -m pip install -r requirements-af-previsao.txt"
    ) from exc

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from af_previsao_backtest import (  # noqa: E402
    MapConfig,
    Match,
    fit_poisson_map,
    map_rates,
    modal_score,
    outcome_from_matrix,
    score_matrix,
)

CONFIG_PATH = ROOT / "dados-br" / "config-af-previsao.json"
AUDIT_MODELS_PATH = ROOT / "dados-br" / "auditoria-modelos-af-previsao.json"
HIST_DIR = ROOT / "dados-br" / "historico-af-previsao"
TABLE_PATH = ROOT / "tabela.json"
EVENTS_PATH = ROOT / "espn_eventos.json"
RESULTS_PATH = ROOT / "resultados.json"
CALENDAR_PATH = ROOT / "dados-br" / "calendario-completo.json"
AF_SCORE_PATH = ROOT / "dados-br" / "ranking-desempenho.json"
OUTPUT_PATH = ROOT / "dados-br" / "probabilidades-brasileirao.json"
AUDIT_PATH = ROOT / "dados-br" / "auditoria-probabilidades.json"
HISTORY_PATH = ROOT / "dados-br" / "historico-probabilidades.json"
BRT = ZoneInfo("America/Sao_Paulo")
EPS = 1e-12
MAX_GOALS_OUTPUT = 7


@dataclass(frozen=True)
class Fixture:
    event_id: str
    round_no: int
    home: str
    away: str
    kickoff: str | None
    stadium: str


@dataclass(frozen=True)
class CurrentState:
    teams: tuple[str, ...]
    points: np.ndarray
    wins: np.ndarray
    draws: np.ndarray
    losses: np.ndarray
    goals_for: np.ndarray
    goals_against: np.ndarray
    played: np.ndarray


class CurrentDataNotSynchronized(ValueError):
    """Tabela e feeds de partidas ainda não foram atualizados pela ESPN no mesmo instante."""


@dataclass(frozen=True)
class MatchForecast:
    fixture: Fixture
    home_rate: float
    away_rate: float
    probabilities: tuple[float, float, float]
    modal: tuple[int, int]
    score_probabilities: tuple[tuple[int, int, float], ...]


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: a raiz JSON precisa ser um objeto")
    return data


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")
    os.replace(temporary, path)


def canonical_hash_payload(payload: dict[str, Any]) -> str:
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_date(value: str | None) -> date | None:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except ValueError:
        try:
            return datetime.strptime(text[:10], "%Y-%m-%d").date()
        except ValueError:
            return None


def parse_reference_datetime(table: dict[str, Any], events: dict[str, Any]) -> datetime:
    candidates = [table.get("atualizado_em"), table.get("atualizado_em_br"), events.get("atualizado_em")]
    for value in candidates:
        if not value:
            continue
        text = str(value).strip().replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(text)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=BRT)
            return parsed.astimezone(BRT)
        except ValueError:
            continue
    return datetime.now(BRT).replace(microsecond=0)


def latest_concluded_datetime(events: dict[str, Any], current: Sequence[Match]) -> datetime:
    instants: list[datetime] = []
    for item in events.get("eventos") or []:
        if item.get("concluido") is not True:
            continue
        value = str(item.get("finalizado_em") or "").strip()
        if not value:
            continue
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=BRT)
            instants.append(parsed.astimezone(BRT))
        except ValueError:
            continue
    if instants:
        return max(instants).replace(microsecond=0)
    if current:
        return datetime.combine(max(match.played_on for match in current), datetime.max.time(), tzinfo=BRT).replace(microsecond=0)
    return datetime(2026, 1, 1, tzinfo=BRT)


def build_model_state_hash(
    config: dict[str, Any],
    audit_models: dict[str, Any],
    state: CurrentState,
    current: Sequence[Match],
    fixtures: Sequence[Fixture],
) -> str:
    historical_hashes = {
        path.name: file_sha256(path) for path in sorted(HIST_DIR.glob("brasileirao-*.json"))
    }
    table_rows = []
    for index, team in enumerate(state.teams):
        table_rows.append({
            "clube": team,
            "pontos": int(state.points[index]),
            "jogos": int(state.played[index]),
            "vitorias": int(state.wins[index]),
            "empates": int(state.draws[index]),
            "derrotas": int(state.losses[index]),
            "gp": int(state.goals_for[index]),
            "gc": int(state.goals_against[index]),
        })
    current_rows = [
        {
            "id": match.source_id,
            "rodada": match.round_no,
            "data": match.played_on.isoformat(),
            "mandante": match.home,
            "visitante": match.away,
            "gm": match.home_goals,
            "gv": match.away_goals,
        }
        for match in current
    ]
    fixture_structure = [
        {"rodada": fixture.round_no, "mandante": fixture.home, "visitante": fixture.away}
        for fixture in sorted(fixtures, key=lambda item: (item.round_no, item.home, item.away))
    ]
    winner = (audit_models.get("selecao_modelo") or {}).get("vencedor") or {}
    payload = {
        "schema": 1,
        "versao_modelo": config.get("versao_modelo"),
        "execucao_2": config.get("execucao_2"),
        "historico": historical_hashes,
        "modelo_vencedor": winner,
        "tabela": table_rows,
        "resultados_2026": current_rows,
        "estrutura_restante": fixture_structure,
    }
    return canonical_hash_payload(payload)


def load_historical_matches() -> list[Match]:
    matches: list[Match] = []
    for path in sorted(HIST_DIR.glob("brasileirao-*.json")):
        data = load_json(path)
        season = int(data["temporada"])
        for item in data.get("partidas") or []:
            matches.append(
                Match(
                    season=season,
                    source_id=int(item["id_fonte"]),
                    round_no=int(item["rodada"]),
                    played_on=datetime.strptime(item["data"], "%Y-%m-%d").date(),
                    home=str(item["mandante"]),
                    away=str(item["visitante"]),
                    home_goals=int(item["gols_mandante"]),
                    away_goals=int(item["gols_visitante"]),
                )
            )
    matches.sort(key=lambda match: (match.played_on, match.source_id))
    if len(matches) != 1140:
        raise ValueError(f"base histórica incompleta: esperadas 1.140 partidas, encontradas {len(matches)}")
    return matches


def load_current_matches(
    events: dict[str, Any],
    allowed_teams: set[str],
    results: dict[str, Any] | None = None,
) -> list[Match]:
    """Une os concluídos de espn_eventos.json e resultados.json.

    Os endpoints da ESPN podem ficar alguns minutos fora de sincronia. O merge
    evita perder uma partida que já apareceu em um dos dois feeds, sem aceitar
    placares conflitantes silenciosamente.
    """
    merged: dict[str, Match] = {}

    def add_match(match: Match, origin: str) -> None:
        key = str(match.source_id)
        previous = merged.get(key)
        if previous is None:
            merged[key] = match
            return
        comparable_previous = (
            previous.round_no, previous.played_on, previous.home, previous.away,
            previous.home_goals, previous.away_goals,
        )
        comparable_new = (
            match.round_no, match.played_on, match.home, match.away,
            match.home_goals, match.away_goals,
        )
        if comparable_previous != comparable_new:
            raise ValueError(
                f"evento {key}: dados conflitantes entre feeds ao incorporar {origin}: "
                f"{previous.home} {previous.home_goals}x{previous.away_goals} {previous.away} / "
                f"{match.home} {match.home_goals}x{match.away_goals} {match.away}"
            )

    for item in events.get("eventos") or []:
        if item.get("concluido") is not True:
            continue
        event_id = str(item.get("event_id") or "").strip()
        if not event_id:
            raise ValueError("evento concluído sem event_id em espn_eventos.json")
        home = str(item.get("mandante") or "").strip()
        away = str(item.get("visitante") or "").strip()
        if home not in allowed_teams or away not in allowed_teams:
            raise ValueError(f"evento {event_id}: clube fora da tabela atual ({home} x {away})")
        played_on = parse_date(item.get("data_iso"))
        if played_on is None:
            raise ValueError(f"evento {event_id}: data inválida")
        add_match(
            Match(
                season=2026, source_id=int(event_id), round_no=int(item.get("rodada") or 0),
                played_on=played_on, home=home, away=away,
                home_goals=int(item.get("placar_mandante") or 0),
                away_goals=int(item.get("placar_visitante") or 0),
            ),
            "espn_eventos.json",
        )

    for item in (results or {}).get("resultados") or []:
        if str(item.get("estado") or "").lower() != "post":
            continue
        event_id = str(item.get("event_id") or "").strip()
        if not event_id:
            raise ValueError("resultado concluído sem event_id em resultados.json")
        raw_home = item.get("mandante")
        raw_away = item.get("visitante")
        home = str(raw_home.get("nome") if isinstance(raw_home, dict) else raw_home or "").strip()
        away = str(raw_away.get("nome") if isinstance(raw_away, dict) else raw_away or "").strip()
        if home not in allowed_teams or away not in allowed_teams:
            raise ValueError(f"resultado {event_id}: clube fora da tabela atual ({home} x {away})")
        played_on = parse_date(item.get("data_iso"))
        if played_on is None:
            raise ValueError(f"resultado {event_id}: data inválida")
        add_match(
            Match(
                season=2026, source_id=int(event_id), round_no=int(item.get("rodada") or 0),
                played_on=played_on, home=home, away=away,
                home_goals=int(item.get("placar_mandante") or 0),
                away_goals=int(item.get("placar_visitante") or 0),
            ),
            "resultados.json",
        )

    matches = sorted(merged.values(), key=lambda match: (match.played_on, match.source_id))
    return matches


def load_current_state(table: dict[str, Any]) -> CurrentState:
    rows = table.get("tabela") or []
    if len(rows) != 20:
        raise ValueError(f"tabela atual precisa ter 20 clubes; encontrados {len(rows)}")
    teams = tuple(str(row["time"]) for row in rows)
    if len(set(teams)) != 20:
        raise ValueError("tabela atual contém clubes duplicados")

    def column(name: str) -> np.ndarray:
        return np.asarray([int(row.get(name) or 0) for row in rows], dtype=np.int16)

    state = CurrentState(
        teams=teams,
        points=column("pontos"),
        wins=column("vitorias"),
        draws=column("empates"),
        losses=column("derrotas"),
        goals_for=column("gp"),
        goals_against=column("gc"),
        played=column("jogos"),
    )
    if int(state.played.sum()) % 2 != 0:
        raise ValueError("soma de jogos da tabela não é par")
    if int(state.points.sum()) <= 0:
        raise ValueError("tabela atual sem pontuação válida")
    return state


def validate_current_results_against_table(matches: Sequence[Match], state: CurrentState) -> dict[str, Any]:
    index = {team: position for position, team in enumerate(state.teams)}
    played = np.zeros(20, dtype=np.int16)
    points = np.zeros(20, dtype=np.int16)
    wins = np.zeros(20, dtype=np.int16)
    draws = np.zeros(20, dtype=np.int16)
    losses = np.zeros(20, dtype=np.int16)
    goals_for = np.zeros(20, dtype=np.int16)
    goals_against = np.zeros(20, dtype=np.int16)
    for match in matches:
        home = index[match.home]
        away = index[match.away]
        played[[home, away]] += 1
        goals_for[home] += match.home_goals
        goals_against[home] += match.away_goals
        goals_for[away] += match.away_goals
        goals_against[away] += match.home_goals
        if match.home_goals > match.away_goals:
            points[home] += 3
            wins[home] += 1
            losses[away] += 1
        elif match.home_goals < match.away_goals:
            points[away] += 3
            wins[away] += 1
            losses[home] += 1
        else:
            points[[home, away]] += 1
            draws[[home, away]] += 1

    fields = {
        "jogos": (played, state.played),
        "pontos": (points, state.points),
        "vitorias": (wins, state.wins),
        "empates": (draws, state.draws),
        "derrotas": (losses, state.losses),
        "gols_pro": (goals_for, state.goals_for),
        "gols_contra": (goals_against, state.goals_against),
    }
    discrepancies: list[dict[str, Any]] = []
    for field, (calculated, official) in fields.items():
        for team_index, team in enumerate(state.teams):
            if int(calculated[team_index]) != int(official[team_index]):
                discrepancies.append(
                    {
                        "clube": team,
                        "campo": field,
                        "reconstruido": int(calculated[team_index]),
                        "oficial": int(official[team_index]),
                    }
                )
    if discrepancies:
        sample = "; ".join(
            f"{item['clube']} {item['campo']}={item['reconstruido']}/{item['oficial']}"
            for item in discrepancies[:5]
        )
        raise CurrentDataNotSynchronized(
            "feeds da ESPN temporariamente fora de sincronia; "
            f"resultados concluídos divergem da tabela oficial: {sample}"
        )
    return {
        "partidas_concluidas": len(matches),
        "soma_jogos_tabela": int(state.played.sum()),
        "resultado": "íntegro",
    }


def load_fixtures(calendar: dict[str, Any], concluded_ids: set[str], allowed_teams: set[str]) -> tuple[list[Fixture], int]:
    items = calendar.get("jogos") or []
    if int(calendar.get("total_partidas") or len(items)) != 380 or len(items) != 380:
        raise ValueError("calendário completo precisa conter exatamente 380 partidas")
    seen_ids: set[str] = set()
    fixtures: list[Fixture] = []
    concluded_in_calendar = 0
    pair_rounds: set[tuple[int, str, str]] = set()
    for item in items:
        home = str(item.get("mandante") or "").strip()
        away = str(item.get("visitante") or "").strip()
        round_no = int(item.get("rodada") or 0)
        raw_event_id = str(item.get("event_id") or "").strip()
        event_id = raw_event_id or f"AF-{round_no:02d}-{home}-{away}"
        if event_id in seen_ids:
            raise ValueError(f"calendário com event_id duplicado: {event_id!r}")
        seen_ids.add(event_id)
        if home not in allowed_teams or away not in allowed_teams or home == away:
            raise ValueError(f"calendário inválido no evento {event_id}: {home} x {away}")
        key = (round_no, home, away)
        if key in pair_rounds:
            raise ValueError(f"partida duplicada na rodada {round_no}: {home} x {away}")
        pair_rounds.add(key)
        if event_id in concluded_ids:
            concluded_in_calendar += 1
            continue
        fixtures.append(
            Fixture(
                event_id=event_id,
                round_no=round_no,
                home=home,
                away=away,
                kickoff=str(item.get("data_iso") or "").strip() or None,
                stadium=str(item.get("estadio") or "").strip(),
            )
        )
    if concluded_in_calendar != len(concluded_ids):
        raise ValueError(
            f"calendário não reconheceu todos os concluídos: {concluded_in_calendar}/{len(concluded_ids)}"
        )
    if len(fixtures) + concluded_in_calendar != 380:
        raise ValueError("partição entre jogos concluídos e restantes não totaliza 380")
    fixtures.sort(key=lambda item: (item.kickoff or "9999-12-31", item.round_no, item.event_id))
    return fixtures, concluded_in_calendar


def extract_map_config(audit: dict[str, Any]) -> MapConfig:
    winner = ((audit.get("selecao_modelo") or {}).get("vencedor") or {}).get("id")
    if winner != "poisson_map_bayesiano":
        raise ValueError(f"arquitetura vencedora inesperada na Execução 1: {winner!r}")
    candidates: list[tuple[int, dict[str, Any]]] = []
    for fold in audit.get("folds") or []:
        item = (((fold.get("hiperparametros") or {}).get("poisson_map_bayesiano") or {}).get("selecionado"))
        if isinstance(item, dict):
            candidates.append((int(fold.get("temporada_teste") or 0), item))
    if not candidates:
        raise ValueError("auditoria da Execução 1 não contém hiperparâmetros MAP")
    # Para produção, usa-se a calibração temporal mais recente disponível.
    # Isso evita criar por média um conjunto de hiperparâmetros que nunca foi
    # efetivamente testado em nenhum fold.
    _, selected = max(candidates, key=lambda pair: pair[0])
    half_life_value = selected.get("meia_vida_dias")
    return MapConfig(
        prior_sd=float(selected["desvio_prior"]),
        half_life_days=None if half_life_value is None else float(half_life_value),
        refit_days=int(selected["reajuste_a_cada_dias"]),
    )


def top_scores(matrix: Sequence[Sequence[float]], limit: int = 5) -> tuple[tuple[int, int, float], ...]:
    values: list[tuple[float, int, int]] = []
    for home_goals, row in enumerate(matrix):
        for away_goals, probability in enumerate(row):
            if home_goals <= MAX_GOALS_OUTPUT and away_goals <= MAX_GOALS_OUTPUT:
                values.append((float(probability), home_goals, away_goals))
    values.sort(reverse=True)
    return tuple((home, away, probability) for probability, home, away in values[:limit])


def build_forecasts(
    fixtures: Sequence[Fixture],
    model: dict[str, Any],
    rho_production: float,
) -> list[MatchForecast]:
    forecasts: list[MatchForecast] = []
    for fixture in fixtures:
        home_rate, away_rate = map_rates(model, fixture.home, fixture.away)
        matrix = score_matrix(home_rate, away_rate, rho_production)
        probabilities = outcome_from_matrix(matrix)
        if abs(sum(probabilities) - 1.0) > 1e-9:
            raise ValueError(f"probabilidades não somam 1 em {fixture.event_id}")
        forecasts.append(
            MatchForecast(
                fixture=fixture,
                home_rate=home_rate,
                away_rate=away_rate,
                probabilities=probabilities,
                modal=modal_score(matrix),
                score_probabilities=top_scores(matrix),
            )
        )
    return forecasts


def sample_scores(
    rng: np.random.Generator,
    forecast: MatchForecast,
    simulations: int,
    rho: float,
) -> tuple[np.ndarray, np.ndarray]:
    if abs(rho) < 1e-15:
        home = rng.poisson(forecast.home_rate, simulations).astype(np.int16, copy=False)
        away = rng.poisson(forecast.away_rate, simulations).astype(np.int16, copy=False)
        return home, away
    matrix = np.asarray(score_matrix(forecast.home_rate, forecast.away_rate, rho), dtype=np.float64)
    flat = matrix.ravel()
    samples = rng.choice(flat.size, size=simulations, p=flat)
    width = matrix.shape[1]
    return (samples // width).astype(np.int16), (samples % width).astype(np.int16)


def run_monte_carlo(
    state: CurrentState,
    forecasts: Sequence[MatchForecast],
    simulations: int,
    seed: int,
    rho: float,
) -> dict[str, Any]:
    if simulations < 10_000:
        raise ValueError("produção exige pelo menos 10.000 simulações")
    team_index = {team: index for index, team in enumerate(state.teams)}
    points = np.broadcast_to(state.points, (simulations, 20)).copy()
    wins = np.broadcast_to(state.wins, (simulations, 20)).copy()
    goals_for = np.broadcast_to(state.goals_for, (simulations, 20)).copy()
    goals_against = np.broadcast_to(state.goals_against, (simulations, 20)).copy()
    played = np.broadcast_to(state.played, (simulations, 20)).copy()
    rng = np.random.default_rng(seed)

    for forecast in forecasts:
        home_index = team_index[forecast.fixture.home]
        away_index = team_index[forecast.fixture.away]
        home_goals, away_goals = sample_scores(rng, forecast, simulations, rho)
        goals_for[:, home_index] += home_goals
        goals_against[:, home_index] += away_goals
        goals_for[:, away_index] += away_goals
        goals_against[:, away_index] += home_goals
        played[:, home_index] += 1
        played[:, away_index] += 1
        home_win = home_goals > away_goals
        away_win = away_goals > home_goals
        draw = ~(home_win | away_win)
        points[:, home_index] += home_win.astype(np.int16) * 3 + draw.astype(np.int16)
        points[:, away_index] += away_win.astype(np.int16) * 3 + draw.astype(np.int16)
        wins[:, home_index] += home_win.astype(np.int16)
        wins[:, away_index] += away_win.astype(np.int16)

    if not np.all(played == 38):
        offenders = np.where(np.any(played != 38, axis=0))[0]
        raise ValueError(f"simulação não encerrou com 38 jogos: {[state.teams[i] for i in offenders]}")

    goal_difference = goals_for - goals_against
    # Critérios primários oficiais: pontos, vitórias, saldo e gols pró.
    # Empates residuais após esses quatro critérios são resolvidos por uma
    # chave pseudoaleatória reproduzível, pois cartões e confronto direto não
    # estão disponíveis de forma homogênea para todas as partidas simuladas.
    residual = rng.integers(0, np.iinfo(np.int32).max, size=(simulations, 20), dtype=np.int32)
    order = np.lexsort((residual, -goals_for, -goal_difference, -wins, -points), axis=1)
    positions = np.empty_like(order, dtype=np.uint8)
    rows = np.arange(simulations)[:, None]
    positions[rows, order] = np.arange(1, 21, dtype=np.uint8)[None, :]

    sorted_points = points[rows, order]
    sorted_wins = wins[rows, order]
    sorted_gd = goal_difference[rows, order]
    sorted_gf = goals_for[rows, order]
    residual_ties = (
        (sorted_points[:, :-1] == sorted_points[:, 1:])
        & (sorted_wins[:, :-1] == sorted_wins[:, 1:])
        & (sorted_gd[:, :-1] == sorted_gd[:, 1:])
        & (sorted_gf[:, :-1] == sorted_gf[:, 1:])
    )
    simulations_with_residual_tie = int(np.any(residual_ties, axis=1).sum())
    total_residual_pairs = int(residual_ties.sum())

    half = simulations // 2
    team_results: list[dict[str, Any]] = []
    position_matrix: dict[str, list[float]] = {}
    convergence_deltas: list[float] = []
    for index, team in enumerate(state.teams):
        team_positions = positions[:, index]
        counts = np.bincount(team_positions, minlength=21)[1:21]
        distribution = counts / simulations
        position_matrix[team] = [round(float(value * 100.0), 6) for value in distribution]
        probabilities = {
            "campeao": float(np.mean(team_positions == 1)),
            "g4": float(np.mean(team_positions <= 4)),
            "g6": float(np.mean(team_positions <= 6)),
            "libertadores_base": float(np.mean(team_positions <= 6)),
            "sul_americana_base": float(np.mean((team_positions >= 7) & (team_positions <= 12))),
            "rebaixamento": float(np.mean(team_positions >= 17)),
        }
        first_half = positions[:half, index]
        second_half = positions[half : 2 * half, index]
        for criterion, predicate in (
            ("campeao", lambda values: values == 1),
            ("g4", lambda values: values <= 4),
            ("g6", lambda values: values <= 6),
            ("rebaixamento", lambda values: values >= 17),
        ):
            delta = abs(float(np.mean(predicate(first_half))) - float(np.mean(predicate(second_half))))
            convergence_deltas.append(delta)
        points_team = points[:, index]
        team_results.append(
            {
                "clube": team,
                "posicao_atual": index + 1,
                "pontos_atuais": int(state.points[index]),
                "jogos_atuais": int(state.played[index]),
                "probabilidades_pct": {
                    key: round(value * 100.0, 6) for key, value in probabilities.items()
                },
                "posicao_projetada_media": round(float(np.mean(team_positions)), 4),
                "posicao_projetada_mediana": int(np.median(team_positions)),
                "pontos_projetados": {
                    "media": round(float(np.mean(points_team)), 3),
                    "mediana": int(np.median(points_team)),
                    "percentil_10": int(np.percentile(points_team, 10, method="nearest")),
                    "percentil_90": int(np.percentile(points_team, 90, method="nearest")),
                    "minimo_simulado": int(np.min(points_team)),
                    "maximo_simulado": int(np.max(points_team)),
                },
                "distribuicao_posicoes_pct": position_matrix[team],
            }
        )

    team_results.sort(key=lambda item: (-item["probabilidades_pct"]["campeao"], item["posicao_projetada_media"]))
    standard_error_max = 100.0 * math.sqrt(0.25 / simulations)
    return {
        "clubes": team_results,
        "simulacoes": simulations,
        "semente": seed,
        "convergencia": {
            "erro_padrao_maximo_pontos_percentuais": round(standard_error_max, 6),
            "margem_95_maxima_pontos_percentuais": round(1.96 * standard_error_max, 6),
            "maior_diferenca_entre_metades_pontos_percentuais": round(
                100.0 * max(convergence_deltas, default=0.0), 6
            ),
        },
        "desempate_residual": {
            "simulacoes_com_empate_apos_pontos_vitorias_saldo_gols": simulations_with_residual_tie,
            "percentual_simulacoes": round(100.0 * simulations_with_residual_tie / simulations, 6),
            "pares_residuais": total_residual_pairs,
        },
    }


def dixon_coles_sensitivity(forecasts: Sequence[MatchForecast], rho: float) -> dict[str, Any]:
    deltas: list[float] = []
    low_score_changes: list[float] = []
    for forecast in forecasts:
        base_matrix = score_matrix(forecast.home_rate, forecast.away_rate, 0.0)
        dc_matrix = score_matrix(forecast.home_rate, forecast.away_rate, rho)
        base_outcome = outcome_from_matrix(base_matrix)
        dc_outcome = outcome_from_matrix(dc_matrix)
        deltas.extend(abs(base_outcome[index] - dc_outcome[index]) for index in range(3))
        base_low = sum(base_matrix[i][j] for i, j in ((0, 0), (1, 0), (0, 1), (1, 1)))
        dc_low = sum(dc_matrix[i][j] for i, j in ((0, 0), (1, 0), (0, 1), (1, 1)))
        low_score_changes.append(dc_low - base_low)
    return {
        "rho_testado": rho,
        "aplicado_na_producao": False,
        "motivo": (
            "A Execução 1 mostrou melhora de calibração, mas piora nas três regras próprias de pontuação. "
            "A versão 1.0 mantém rho=0 e publica esta sensibilidade para reavaliação versionada."
        ),
        "diferenca_media_absoluta_1x2_pontos_percentuais": round(
            100.0 * float(np.mean(deltas)) if deltas else 0.0, 6
        ),
        "diferenca_maxima_1x2_pontos_percentuais": round(
            100.0 * max(deltas, default=0.0), 6
        ),
        "alteracao_media_massa_placares_baixos_pontos_percentuais": round(
            100.0 * float(np.mean(low_score_changes)) if low_score_changes else 0.0, 6
        ),
    }


def af_score_diagnostic(model: dict[str, Any], state: CurrentState) -> dict[str, Any]:
    if not AF_SCORE_PATH.exists():
        return {"disponivel": False, "aplicado_na_producao": False, "motivo": "arquivo AF-Score ausente"}
    data = load_json(AF_SCORE_PATH)
    ranking = data.get("ranking") or []
    scores = {str(item.get("clube") or item.get("time")): float(item.get("indice_final") or 0.0) for item in ranking}
    common = [team for team in state.teams if team in scores]
    if len(common) != 20:
        return {
            "disponivel": True,
            "cobertura_clubes": len(common),
            "aplicado_na_producao": False,
            "motivo": "cobertura incompleta no ranking atual",
        }
    model_strength = []
    af_values = []
    for team in common:
        attack = float(model.get("attack", {}).get(team, 0.0))
        defence = float(model.get("defence", {}).get(team, 0.0))
        model_strength.append(attack + defence)  # defesa positiva no MAP significa menos gols sofridos
        af_values.append(scores[team])
    correlation = float(np.corrcoef(model_strength, af_values)[0, 1]) if np.std(model_strength) > 0 else 0.0
    return {
        "disponivel": True,
        "cobertura_clubes": 20,
        "correlacao_pearson_com_forca_map": round(correlation, 6),
        "aplicado_na_producao": False,
        "motivo": (
            "O AF-Score não possui série histórica homogênea em 2023–2025. Incluí-lo agora impediria "
            "backtesting temporal equivalente e poderia introduzir vazamento."
        ),
    }


def serialize_match_forecasts(
    forecasts: Sequence[MatchForecast], limit: int | None = None
) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    selected = forecasts if limit is None else forecasts[:limit]
    for forecast in selected:
        output.append(
            {
                "event_id": forecast.fixture.event_id,
                "rodada": forecast.fixture.round_no,
                "data_iso": forecast.fixture.kickoff,
                "mandante": forecast.fixture.home,
                "visitante": forecast.fixture.away,
                "estadio": forecast.fixture.stadium,
                "gols_esperados": {
                    "mandante": round(forecast.home_rate, 4),
                    "visitante": round(forecast.away_rate, 4),
                },
                "probabilidades_pct": {
                    "mandante": round(100.0 * forecast.probabilities[0], 4),
                    "empate": round(100.0 * forecast.probabilities[1], 4),
                    "visitante": round(100.0 * forecast.probabilities[2], 4),
                },
                "placar_modal": {
                    "mandante": forecast.modal[0],
                    "visitante": forecast.modal[1],
                },
                "placares_mais_provaveis": [
                    {
                        "mandante": home,
                        "visitante": away,
                        "probabilidade_pct": round(100.0 * probability, 4),
                    }
                    for home, away, probability in forecast.score_probabilities
                ],
            }
        )
    return output


def highlight(teams: Sequence[dict[str, Any]], field: str, reverse: bool = True) -> dict[str, Any]:
    selected = sorted(
        teams,
        key=lambda item: item["probabilidades_pct"][field],
        reverse=reverse,
    )[0]
    return {
        "clube": selected["clube"],
        "probabilidade_pct": selected["probabilidades_pct"][field],
    }


def update_history(
    existing: dict[str, Any] | None,
    generated_at: str,
    input_hash: str,
    teams: Sequence[dict[str, Any]],
    model_version: str,
    max_snapshots: int = 300,
) -> dict[str, Any]:
    snapshots = list((existing or {}).get("snapshots") or [])
    if not snapshots or snapshots[-1].get("hash_entrada") != input_hash:
        snapshots.append(
            {
                "gerado_em": generated_at,
                "hash_entrada": input_hash,
                "versao_modelo": model_version,
                "clubes": [
                    {
                        "clube": item["clube"],
                        "campeao_pct": item["probabilidades_pct"]["campeao"],
                        "libertadores_base_pct": item["probabilidades_pct"]["libertadores_base"],
                        "sul_americana_base_pct": item["probabilidades_pct"]["sul_americana_base"],
                        "rebaixamento_pct": item["probabilidades_pct"]["rebaixamento"],
                        "pontos_medios": item["pontos_projetados"]["media"],
                    }
                    for item in teams
                ],
            }
        )
    snapshots = snapshots[-max(1, int(max_snapshots)) :]
    return {
        "schema_version": 1,
        "projeto": "AF-Previsão",
        "descricao": "Histórico versionado das probabilidades; um snapshot por alteração dos dados de entrada.",
        "total_snapshots": len(snapshots),
        "snapshots": snapshots,
    }


def validate_probabilities(teams: Sequence[dict[str, Any]]) -> None:
    if len(teams) != 20 or len({item["clube"] for item in teams}) != 20:
        raise ValueError("resultado probabilístico precisa conter 20 clubes únicos")
    expected_sums = {
        "campeao": 100.0,
        "g4": 400.0,
        "g6": 600.0,
        "libertadores_base": 600.0,
        "sul_americana_base": 600.0,
        "rebaixamento": 400.0,
    }
    for field, expected in expected_sums.items():
        total = sum(float(item["probabilidades_pct"][field]) for item in teams)
        if abs(total - expected) > 0.02:
            raise ValueError(f"soma probabilística inválida em {field}: {total:.6f}, esperado {expected:.1f}")
    for item in teams:
        distribution = item["distribuicao_posicoes_pct"]
        if len(distribution) != 20 or abs(sum(distribution) - 100.0) > 0.02:
            raise ValueError(f"distribuição de posições inválida para {item['clube']}")
        for value in item["probabilidades_pct"].values():
            if not math.isfinite(float(value)) or not 0.0 <= float(value) <= 100.0:
                raise ValueError(f"probabilidade fora do intervalo para {item['clube']}")


def generate(simulations: int | None = None, seed_override: int | None = None) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    config = load_json(CONFIG_PATH)
    audit_models = load_json(AUDIT_MODELS_PATH)
    table = load_json(TABLE_PATH)
    events = load_json(EVENTS_PATH)
    results = load_json(RESULTS_PATH) if RESULTS_PATH.exists() else {"resultados": []}
    calendar = load_json(CALENDAR_PATH)
    state = load_current_state(table)
    allowed_teams = set(state.teams)
    historical = load_historical_matches()
    current = load_current_matches(events, allowed_teams, results)
    integrity = validate_current_results_against_table(current, state)
    concluded_ids = {str(match.source_id) for match in current}
    fixtures, concluded_in_calendar = load_fixtures(calendar, concluded_ids, allowed_teams)
    if len(current) + len(fixtures) != 380:
        raise ValueError("quantidade de partidas correntes não totaliza 380")

    reference = latest_concluded_datetime(events, current)
    latest_played = max((match.played_on for match in current), default=reference.date())
    as_of = max(reference.date(), latest_played) + timedelta(days=1)
    map_config = extract_map_config(audit_models)

    execution = config.get("execucao_2") or {}
    configured_prior = float(execution.get("desvio_prior", map_config.prior_sd))
    configured_half_life = execution.get("meia_vida_dias", map_config.half_life_days)
    configured_half_life = None if configured_half_life is None else float(configured_half_life)
    if abs(configured_prior - map_config.prior_sd) > 1e-12 or configured_half_life != map_config.half_life_days:
        raise ValueError(
            "configuração da Execução 2 diverge dos hiperparâmetros selecionados no backtesting"
        )
    model = fit_poisson_map([*historical, *current], as_of, map_config)

    simulations_final = int(simulations or execution.get("simulacoes_monte_carlo") or 200_000)
    seed = int(seed_override if seed_override is not None else execution.get("semente") or 20260717)
    rho_production = float(execution.get("rho_dixon_coles_producao") or 0.0)
    rho_sensitivity = float(execution.get("rho_dixon_coles_sensibilidade") or 0.08)
    forecasts = build_forecasts(fixtures, model, rho_production)
    simulation = run_monte_carlo(state, forecasts, simulations_final, seed, rho_production)
    max_half_delta = float(simulation["convergencia"]["maior_diferenca_entre_metades_pontos_percentuais"])
    if max_half_delta > 1.0:
        raise ValueError(
            f"Monte Carlo sem convergência suficiente: diferença entre metades de {max_half_delta:.4f} p.p."
        )
    teams = simulation["clubes"]
    validate_probabilities(teams)

    input_hash = build_model_state_hash(config, audit_models, state, current, fixtures)
    generated_at = reference.replace(microsecond=0).isoformat()
    model_version = str(config.get("versao_modelo") or "AF-Previsão 1.0")
    methodology = {
        "arquitetura": "Poisson log-linear ajustado por MAP com priors gaussianos e partial pooling",
        "modelo_de_gols": "Poisson duplo com parâmetros de ataque, defesa e vantagem de mando",
        "regularizacao": "aproximação bayesiana MAP; clubes com menos evidência regridem à média",
        "decaimento_temporal_meia_vida_dias": map_config.half_life_days,
        "desvio_prior": map_config.prior_sd,
        "dixon_coles": {
            "implementado": True,
            "rho_producao": rho_production,
            "regra": "ativação condicionada a ganho fora da amostra; atualmente mantido como sensibilidade",
        },
        "monte_carlo": simulations_final,
        "criterios_ordenacao": [
            "pontos",
            "vitórias",
            "saldo de gols",
            "gols pró",
            "desempate residual pseudoaleatório reproduzível quando os quatro critérios permanecem iguais",
        ],
        "zonas_base": {
            "campeao": "1º lugar",
            "g4": "1º ao 4º",
            "g6": "1º ao 6º",
            "libertadores_base": "1º ao 6º; vagas extraordinárias de copas não são antecipadas",
            "sul_americana_base": "7º ao 12º; cenário-base antes de redistribuições por copas",
            "rebaixamento": "17º ao 20º",
        },
        "af_score": "auditado como diagnóstico, não aplicado sem backtesting histórico homogêneo",
    }
    probabilities = {
        "schema_version": 1,
        "projeto": "AF-Previsão",
        "versao_modelo": model_version,
        "temporada": 2026,
        "gerado_em": generated_at,
        "fonte_resultados_calendario": "ESPN",
        "status": "ok",
        "hash_entrada": input_hash,
        "responsavel": config.get("responsavel"),
        "metodologia_resumida": methodology,
        "base_corrente": {
            "partidas_concluidas": len(current),
            "partidas_restantes": len(fixtures),
            "partidas_totais": 380,
            "rodada_maxima_com_resultado": max((match.round_no for match in current), default=0),
        },
        "simulacao": {
            "quantidade": simulations_final,
            "semente": seed,
            **simulation["convergencia"],
        },
        "destaques": {
            "maior_chance_titulo": highlight(teams, "campeao"),
            "maior_chance_libertadores": highlight(teams, "libertadores_base"),
            "maior_chance_sul_americana": highlight(teams, "sul_americana_base"),
            "maior_risco_rebaixamento": highlight(teams, "rebaixamento"),
        },
        "clubes": teams,
        "total_previsoes_partidas": len(forecasts),
        "partidas_restantes": serialize_match_forecasts(forecasts),
        "avisos": [
            "Probabilidades não são certezas e mudam quando novos jogos são concluídos.",
            "Libertadores e Sul-Americana usam zonas-base; vagas adicionais por copas serão tratadas por cenário quando confirmadas.",
            "O modelo não utiliza cotações de apostas.",
        ],
    }

    strengths = []
    for team in state.teams:
        attack = float(model.get("attack", {}).get(team, 0.0))
        defence = float(model.get("defence", {}).get(team, 0.0))
        strengths.append(
            {
                "clube": team,
                "ataque_log": round(attack, 8),
                "defesa_log": round(defence, 8),
                "multiplicador_ataque": round(math.exp(attack), 8),
                "multiplicador_protecao_defensiva": round(math.exp(defence), 8),
            }
        )
    dc_audit = dixon_coles_sensitivity(forecasts, rho_sensitivity)
    af_audit = af_score_diagnostic(model, state)
    audit = {
        "schema_version": 1,
        "projeto": "AF-Previsão",
        "versao_modelo": model_version,
        "etapa": "Execução 2 — motor probabilístico e Monte Carlo",
        "gerado_em": generated_at,
        "status": "ok",
        "hash_entrada": input_hash,
        "responsavel": config.get("responsavel"),
        "integridade": {
            "base_historica_partidas": len(historical),
            "temporadas_historicas": sorted({match.season for match in historical}),
            "partidas_2026_concluidas": len(current),
            "partidas_2026_restantes": len(fixtures),
            "partidas_calendario": len(current) + len(fixtures),
            "concluidos_reconhecidos_no_calendario": concluded_in_calendar,
            "comparacao_resultados_tabela": integrity,
        },
        "modelo": {
            "selecionado_execucao_1": "poisson_map_bayesiano",
            "data_ajuste": as_of.isoformat(),
            "desvio_prior": map_config.prior_sd,
            "meia_vida_dias": map_config.half_life_days,
            "intercepto_log": round(float(model["mu"]), 8),
            "vantagem_mando_log": round(float(model["home_adv"]), 8),
            "multiplicador_mando": round(math.exp(float(model["home_adv"])), 8),
            "forcas_clubes": strengths,
        },
        "simulacao": {
            "quantidade": simulations_final,
            "semente": seed,
            "rho_producao": rho_production,
            "convergencia": simulation["convergencia"],
            "desempate_residual": simulation["desempate_residual"],
        },
        "sensibilidade_dixon_coles": dc_audit,
        "diagnostico_af_score": af_audit,
        "validacoes": {
            "clubes": len(teams),
            "soma_campeao_pct": round(sum(item["probabilidades_pct"]["campeao"] for item in teams), 6),
            "soma_g4_pct": round(sum(item["probabilidades_pct"]["g4"] for item in teams), 6),
            "soma_g6_pct": round(sum(item["probabilidades_pct"]["g6"] for item in teams), 6),
            "soma_sul_americana_pct": round(
                sum(item["probabilidades_pct"]["sul_americana_base"] for item in teams), 6
            ),
            "soma_rebaixamento_pct": round(
                sum(item["probabilidades_pct"]["rebaixamento"] for item in teams), 6
            ),
            "todas_distribuicoes_posicao_somam_100": True,
            "sem_nan_ou_infinity": True,
        },
        "limites_conhecidos": [
            "O ajuste é MAP regularizado, não amostragem MCMC da posterior completa.",
            "A incerteza publicada vem dos resultados futuros simulados; a versão 1.0 não amostra incerteza dos parâmetros.",
            "Vagas continentais são cenários-base e podem mudar após títulos em copas.",
            "Confronto direto e cartões não são simulados; empates residuais após pontos, vitórias, saldo e gols pró usam chave reproduzível.",
            "AF-Score não altera a previsão enquanto não houver backtesting histórico comparável.",
        ],
        "arquivos": {
            "probabilidades": "dados-br/probabilidades-brasileirao.json",
            "historico": "dados-br/historico-probabilidades.json",
            "auditoria": "dados-br/auditoria-probabilidades.json",
        },
    }

    existing_history = load_json(HISTORY_PATH) if HISTORY_PATH.exists() else None
    history = update_history(
        existing_history, generated_at, input_hash, teams, model_version,
        max_snapshots=int(execution.get("historico_max_snapshots") or 300),
    )
    return probabilities, audit, history


def self_test() -> None:
    # Testes unitários de ordenação, somas e reprodutibilidade em liga sintética de 20 clubes.
    teams = tuple(f"Clube {index:02d}" for index in range(20))
    state = CurrentState(
        teams=teams,
        points=np.zeros(20, dtype=np.int16),
        wins=np.zeros(20, dtype=np.int16),
        draws=np.zeros(20, dtype=np.int16),
        losses=np.zeros(20, dtype=np.int16),
        goals_for=np.zeros(20, dtype=np.int16),
        goals_against=np.zeros(20, dtype=np.int16),
        played=np.zeros(20, dtype=np.int16),
    )
    fixtures: list[Fixture] = []
    for round_no in range(1, 39):
        shift = (round_no - 1) % 19
        for index in range(10):
            home = teams[(index + shift) % 20]
            away = teams[(19 - index + shift) % 20]
            if home == away:
                away = teams[(19 - index + shift + 1) % 20]
            fixtures.append(Fixture(str(round_no * 100 + index), round_no, home, away, None, ""))
    # A construção acima pode repetir pares, mas cada clube precisa totalizar 38 jogos no self-test.
    counts = defaultdict(int)
    for fixture in fixtures:
        counts[fixture.home] += 1
        counts[fixture.away] += 1
    if set(counts.values()) != {38}:
        # Usa calendário circular garantido quando a construção simplificada não satisfizer a trava.
        fixtures = []
        rotation = list(teams)
        first_half: list[list[tuple[str, str]]] = []
        for round_index in range(19):
            games = []
            for index in range(10):
                a = rotation[index]
                b = rotation[-1 - index]
                games.append((a, b) if (round_index + index) % 2 == 0 else (b, a))
            first_half.append(games)
            rotation = [rotation[0], rotation[-1], *rotation[1:-1]]
        event = 1
        for round_index, games in enumerate(first_half, start=1):
            for home, away in games:
                fixtures.append(Fixture(str(event), round_index, home, away, None, ""))
                event += 1
        for round_index, games in enumerate(first_half, start=20):
            for home, away in games:
                fixtures.append(Fixture(str(event), round_index, away, home, None, ""))
                event += 1
    forecasts = [
        MatchForecast(
            fixture=fixture,
            home_rate=1.35 + (0.02 if fixture.home == teams[0] else 0.0),
            away_rate=1.05,
            probabilities=(0.45, 0.28, 0.27),
            modal=(1, 1),
            score_probabilities=((1, 1, 0.12),),
        )
        for fixture in fixtures
    ]
    result_a = run_monte_carlo(state, forecasts, 10_000, 12345, 0.0)
    result_b = run_monte_carlo(state, forecasts, 10_000, 12345, 0.0)
    if json.dumps(result_a, sort_keys=True) != json.dumps(result_b, sort_keys=True):
        raise AssertionError("Monte Carlo não é reproduzível com a mesma semente")
    validate_probabilities(result_a["clubes"])
    if result_a["simulacoes"] != 10_000:
        raise AssertionError("quantidade de simulações incorreta")
    print("Self-test AF-Previsão Execução 2: OK")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--simulacoes", type=int, default=None, help="substitui a quantidade configurada")
    parser.add_argument("--semente", type=int, default=None, help="substitui a semente configurada")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    try:
        probabilities, audit, history = generate(args.simulacoes, args.semente)
    except CurrentDataNotSynchronized as exc:
        previous_files = (OUTPUT_PATH, AUDIT_PATH, HISTORY_PATH)
        previous_valid = all(path.exists() for path in previous_files)
        if previous_valid:
            try:
                previous_output = load_json(OUTPUT_PATH)
                previous_audit = load_json(AUDIT_PATH)
                previous_history = load_json(HISTORY_PATH)
                previous_valid = (
                    previous_output.get("status") == "ok"
                    and previous_audit.get("status") == "ok"
                    and bool(previous_history.get("snapshots"))
                    and previous_output.get("hash_entrada") == previous_audit.get("hash_entrada")
                )
            except (OSError, ValueError, json.JSONDecodeError):
                previous_valid = False
        if not previous_valid:
            raise
        print(
            "::warning title=AF-Previsão aguardando sincronização da ESPN::"
            f"{exc}. A previsão anterior íntegra foi preservada; a próxima execução tentará atualizar novamente."
        )
        return 0
    write_json(OUTPUT_PATH, probabilities)
    write_json(AUDIT_PATH, audit)
    write_json(HISTORY_PATH, history)
    print(
        "AF-Previsão gerado: "
        f"{probabilities['base_corrente']['partidas_concluidas']} concluídos, "
        f"{probabilities['base_corrente']['partidas_restantes']} restantes, "
        f"{probabilities['simulacao']['quantidade']:,} simulações."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
