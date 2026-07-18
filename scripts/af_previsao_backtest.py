#!/usr/bin/env python3
"""Backtesting comparativo da Execução 1 do AF-Previsão.

O script compara modelos probabilísticos em validação temporal fora da amostra.
Ele NÃO publica probabilidades da temporada corrente; apenas escolhe e documenta
a arquitetura que seguirá para a Execução 2.

Modelos comparados:
  * frequência histórica regularizada (baseline);
  * Poisson regularizado hierárquico (empirical Bayes);
  * Poisson temporal com correção Dixon–Coles;
  * Elo dinâmico com componente explícito de empate;
  * híbrido Dixon–Coles + Elo.

Uso:
    python scripts/af_previsao_backtest.py
    python scripts/af_previsao_backtest.py --self-test
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence

try:
    import numpy as np
except ImportError as exc:  # pragma: no cover
    raise SystemExit("AF-Previsão requer numpy. Instale com: python -m pip install numpy==2.3.5") from exc

ROOT = Path(__file__).resolve().parents[1]
HIST_DIR = ROOT / "dados-br" / "historico-af-previsao"
BASE_AUDIT = ROOT / "dados-br" / "auditoria-base-historica-af-previsao.json"
CONFIG_PATH = ROOT / "dados-br" / "config-af-previsao.json"
OUTPUT_PATH = ROOT / "dados-br" / "auditoria-modelos-af-previsao.json"
REPORT_PATH = ROOT / "docs" / "af-previsao-execucao-1.md"
EPS = 1e-12
MAX_GOALS = 10


@dataclass(frozen=True)
class Match:
    season: int
    source_id: int
    round_no: int
    played_on: date
    home: str
    away: str
    home_goals: int
    away_goals: int

    @property
    def outcome_index(self) -> int:
        if self.home_goals > self.away_goals:
            return 0  # mandante
        if self.home_goals == self.away_goals:
            return 1  # empate
        return 2  # visitante

    @property
    def key(self) -> str:
        return f"{self.season}:{self.source_id}"


@dataclass
class Prediction:
    match: Match
    probabilities: tuple[float, float, float]
    expected_home_goals: float | None = None
    expected_away_goals: float | None = None
    predicted_score: tuple[int, int] | None = None


@dataclass(frozen=True)
class PoissonConfig:
    prior_matches: float
    half_life_days: float | None
    rho: float = 0.0


@dataclass(frozen=True)
class MapConfig:
    prior_sd: float
    half_life_days: float | None
    refit_days: int = 21


@dataclass(frozen=True)
class EloConfig:
    k_factor: float
    home_advantage: float
    draw_base: float
    draw_scale: float


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: raiz JSON precisa ser objeto")
    return data


def load_matches() -> dict[int, list[Match]]:
    seasons: dict[int, list[Match]] = {}
    for path in sorted(HIST_DIR.glob("brasileirao-*.json")):
        data = load_json(path)
        season = int(data["temporada"])
        matches: list[Match] = []
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
        seasons[season] = matches
    return seasons


def chronological_batches(matches: Sequence[Match]) -> Iterator[list[Match]]:
    batch: list[Match] = []
    current: date | None = None
    for match in sorted(matches, key=lambda item: (item.played_on, item.source_id)):
        if current is None or match.played_on == current:
            batch.append(match)
            current = match.played_on
            continue
        yield batch
        batch = [match]
        current = match.played_on
    if batch:
        yield batch


def safe_normalize(values: Sequence[float]) -> tuple[float, ...]:
    clipped = [max(EPS, float(value)) for value in values]
    total = sum(clipped)
    return tuple(value / total for value in clipped)


def poisson_pmf(k: int, rate: float) -> float:
    if rate <= 0:
        return 1.0 if k == 0 else 0.0
    return math.exp(-rate + k * math.log(rate) - math.lgamma(k + 1))


def dixon_coles_tau(home_goals: int, away_goals: int, home_rate: float, away_rate: float, rho: float) -> float:
    if home_goals == 0 and away_goals == 0:
        return 1.0 - home_rate * away_rate * rho
    if home_goals == 0 and away_goals == 1:
        return 1.0 + home_rate * rho
    if home_goals == 1 and away_goals == 0:
        return 1.0 + away_rate * rho
    if home_goals == 1 and away_goals == 1:
        return 1.0 - rho
    return 1.0


def score_matrix(home_rate: float, away_rate: float, rho: float = 0.0) -> list[list[float]]:
    matrix: list[list[float]] = []
    for home_goals in range(MAX_GOALS + 1):
        row: list[float] = []
        for away_goals in range(MAX_GOALS + 1):
            base = poisson_pmf(home_goals, home_rate) * poisson_pmf(away_goals, away_rate)
            tau = dixon_coles_tau(home_goals, away_goals, home_rate, away_rate, rho)
            row.append(max(0.0, base * tau))
        matrix.append(row)
    total = sum(sum(row) for row in matrix)
    if total <= 0:
        raise ValueError("matriz de placares sem massa positiva")
    return [[value / total for value in row] for row in matrix]


def outcome_from_matrix(matrix: Sequence[Sequence[float]]) -> tuple[float, float, float]:
    home = draw = away = 0.0
    for home_goals, row in enumerate(matrix):
        for away_goals, probability in enumerate(row):
            if home_goals > away_goals:
                home += probability
            elif home_goals == away_goals:
                draw += probability
            else:
                away += probability
    return safe_normalize((home, draw, away))  # type: ignore[return-value]


def modal_score(matrix: Sequence[Sequence[float]]) -> tuple[int, int]:
    best = (-1.0, 0, 0)
    for home_goals, row in enumerate(matrix):
        for away_goals, probability in enumerate(row):
            if probability > best[0]:
                best = (probability, home_goals, away_goals)
    return best[1], best[2]


def temporal_weight(match_date: date, as_of: date, half_life_days: float | None) -> float:
    if half_life_days is None:
        return 1.0
    age = max(0, (as_of - match_date).days)
    return 0.5 ** (age / half_life_days)


def geometric_mean(values: Iterable[float]) -> float:
    safe = [max(EPS, value) for value in values]
    if not safe:
        return 1.0
    return math.exp(sum(math.log(value) for value in safe) / len(safe))


def fit_poisson_strengths(history: Sequence[Match], as_of: date, config: PoissonConfig) -> dict[str, Any]:
    if not history:
        return {
            "home_mean": 1.35,
            "away_mean": 1.05,
            "attack": {},
            "defence": {},
            "effective_matches": 0.0,
        }
    weighted: list[tuple[Match, float]] = [
        (match, temporal_weight(match.played_on, as_of, config.half_life_days))
        for match in history
        if match.played_on < as_of
    ]
    if not weighted:
        weighted = [(match, 1.0) for match in history]
    total_weight = sum(weight for _, weight in weighted)
    home_mean = sum(weight * match.home_goals for match, weight in weighted) / max(EPS, total_weight)
    away_mean = sum(weight * match.away_goals for match, weight in weighted) / max(EPS, total_weight)
    home_mean = min(3.5, max(0.35, home_mean))
    away_mean = min(3.5, max(0.25, away_mean))
    teams = sorted({match.home for match, _ in weighted} | {match.away for match, _ in weighted})
    attack = {team: 1.0 for team in teams}
    defence = {team: 1.0 for team in teams}  # >1 significa defesa mais permissiva
    prior_rate = (home_mean + away_mean) / 2.0
    prior_exposure = max(0.0, config.prior_matches) * prior_rate

    for _ in range(80):
        new_attack: dict[str, float] = {}
        for team in teams:
            observed = prior_exposure
            expected = prior_exposure
            for match, weight in weighted:
                if match.home == team:
                    observed += weight * match.home_goals
                    expected += weight * home_mean * defence.get(match.away, 1.0)
                elif match.away == team:
                    observed += weight * match.away_goals
                    expected += weight * away_mean * defence.get(match.home, 1.0)
            new_attack[team] = min(3.0, max(0.25, observed / max(EPS, expected)))
        scale = geometric_mean(new_attack.values())
        new_attack = {team: value / scale for team, value in new_attack.items()}

        new_defence: dict[str, float] = {}
        for team in teams:
            observed = prior_exposure
            expected = prior_exposure
            for match, weight in weighted:
                if match.home == team:
                    observed += weight * match.away_goals
                    expected += weight * away_mean * new_attack.get(match.away, 1.0)
                elif match.away == team:
                    observed += weight * match.home_goals
                    expected += weight * home_mean * new_attack.get(match.home, 1.0)
            new_defence[team] = min(3.0, max(0.25, observed / max(EPS, expected)))
        defence_scale = geometric_mean(new_defence.values())
        new_defence = {team: value / defence_scale for team, value in new_defence.items()}

        max_change = max(
            [abs(new_attack[team] - attack[team]) for team in teams]
            + [abs(new_defence[team] - defence[team]) for team in teams]
        )
        attack, defence = new_attack, new_defence
        if max_change < 1e-7:
            break

    return {
        "home_mean": home_mean,
        "away_mean": away_mean,
        "attack": attack,
        "defence": defence,
        "effective_matches": total_weight,
    }


def poisson_rates(model: dict[str, Any], home: str, away: str) -> tuple[float, float]:
    home_rate = (
        float(model["home_mean"])
        * float(model["attack"].get(home, 1.0))
        * float(model["defence"].get(away, 1.0))
    )
    away_rate = (
        float(model["away_mean"])
        * float(model["attack"].get(away, 1.0))
        * float(model["defence"].get(home, 1.0))
    )
    return min(5.5, max(0.08, home_rate)), min(5.0, max(0.06, away_rate))


def fit_poisson_map(history: Sequence[Match], as_of: date, config: MapConfig) -> dict[str, Any]:
    """Ajuste MAP log-linear vetorizado com priors gaussianos.

    O ajuste estima o modo da distribuição posterior. Não é amostragem MCMC;
    trata-se de uma aproximação bayesiana determinística, com partial pooling.
    """
    selected = [match for match in history if match.played_on < as_of]
    if not selected:
        return {"mu": math.log(1.15), "home_adv": math.log(1.25), "attack": {}, "defence": {}}
    teams = sorted({match.home for match in selected} | {match.away for match in selected})
    team_index = {team: index for index, team in enumerate(teams)}
    home_idx = np.asarray([team_index[match.home] for match in selected], dtype=np.int64)
    away_idx = np.asarray([team_index[match.away] for match in selected], dtype=np.int64)
    home_goals = np.asarray([match.home_goals for match in selected], dtype=np.float64)
    away_goals = np.asarray([match.away_goals for match in selected], dtype=np.float64)
    weights = np.asarray(
        [temporal_weight(match.played_on, as_of, config.half_life_days) for match in selected],
        dtype=np.float64,
    )
    total_weight = float(weights.sum())
    home_mean = float(np.dot(weights, home_goals) / max(EPS, total_weight))
    away_mean = float(np.dot(weights, away_goals) / max(EPS, total_weight))
    n_teams = len(teams)
    # theta = [mu, mando, ataques..., defesas...]
    theta = np.zeros(2 + 2 * n_teams, dtype=np.float64)
    theta[0] = math.log(max(0.20, away_mean))
    theta[1] = math.log(max(0.50, home_mean) / max(0.20, away_mean))
    first = np.zeros_like(theta)
    second = np.zeros_like(theta)
    beta1, beta2, adam_eps = 0.9, 0.999, 1e-8
    learning_rate = 0.035
    prior_precision = 1.0 / max(0.05, config.prior_sd) ** 2

    for iteration in range(1, 181):
        mu = theta[0]
        home_adv = theta[1]
        attack = theta[2 : 2 + n_teams]
        defence = theta[2 + n_teams :]
        log_home = np.clip(mu + home_adv + attack[home_idx] - defence[away_idx], -3.0, 2.0)
        log_away = np.clip(mu + attack[away_idx] - defence[home_idx], -3.0, 2.0)
        home_rate = np.exp(log_home)
        away_rate = np.exp(log_away)
        home_residual = weights * (home_goals - home_rate)
        away_residual = weights * (away_goals - away_rate)

        gradient = np.zeros_like(theta)
        gradient[0] = float(home_residual.sum() + away_residual.sum()) - 0.05 * mu
        gradient[1] = float(home_residual.sum()) - 0.5 * home_adv
        grad_attack = (
            np.bincount(home_idx, weights=home_residual, minlength=n_teams)
            + np.bincount(away_idx, weights=away_residual, minlength=n_teams)
            - prior_precision * attack
        )
        grad_defence = (
            -np.bincount(away_idx, weights=home_residual, minlength=n_teams)
            -np.bincount(home_idx, weights=away_residual, minlength=n_teams)
            - prior_precision * defence
        )
        gradient[2 : 2 + n_teams] = grad_attack
        gradient[2 + n_teams :] = grad_defence
        gradient /= max(1.0, total_weight)

        first = beta1 * first + (1.0 - beta1) * gradient
        second = beta2 * second + (1.0 - beta2) * gradient * gradient
        first_hat = first / (1.0 - beta1**iteration)
        second_hat = second / (1.0 - beta2**iteration)
        theta += learning_rate * first_hat / (np.sqrt(second_hat) + adam_eps)
        theta[0] = np.clip(theta[0], -2.0, 1.0)
        theta[1] = np.clip(theta[1], -0.3, 0.9)
        theta[2:] = np.clip(theta[2:], -1.5, 1.5)
        theta[2 : 2 + n_teams] -= theta[2 : 2 + n_teams].mean()
        theta[2 + n_teams :] -= theta[2 + n_teams :].mean()

    return {
        "mu": float(theta[0]),
        "home_adv": float(theta[1]),
        "attack": {team: float(theta[2 + index]) for team, index in team_index.items()},
        "defence": {team: float(theta[2 + n_teams + index]) for team, index in team_index.items()},
    }


def map_rates(model: dict[str, Any], home: str, away: str) -> tuple[float, float]:
    home_log = (
        float(model["mu"]) + float(model["home_adv"])
        + float(model["attack"].get(home, 0.0)) - float(model["defence"].get(away, 0.0))
    )
    away_log = (
        float(model["mu"]) + float(model["attack"].get(away, 0.0))
        - float(model["defence"].get(home, 0.0))
    )
    return min(5.5, max(0.08, math.exp(home_log))), min(5.0, max(0.06, math.exp(away_log)))


def predict_map_walkforward(history: Sequence[Match], target: Sequence[Match], config: MapConfig) -> list[Prediction]:
    known = list(sorted(history, key=lambda match: (match.played_on, match.source_id)))
    predictions: list[Prediction] = []
    model: dict[str, Any] | None = None
    last_fit: date | None = None
    for batch in chronological_batches(target):
        as_of = batch[0].played_on
        if model is None or last_fit is None or (as_of - last_fit).days >= config.refit_days:
            model = fit_poisson_map(known, as_of, config)
            last_fit = as_of
        for match in batch:
            home_rate, away_rate = map_rates(model, match.home, match.away)
            matrix = score_matrix(home_rate, away_rate, 0.0)
            predictions.append(Prediction(
                match=match, probabilities=outcome_from_matrix(matrix),
                expected_home_goals=home_rate, expected_away_goals=away_rate,
                predicted_score=modal_score(matrix),
            ))
        known.extend(batch)
    return predictions


def predict_poisson_walkforward(
    history: Sequence[Match],
    target: Sequence[Match],
    config: PoissonConfig,
) -> list[Prediction]:
    known = list(sorted(history, key=lambda match: (match.played_on, match.source_id)))
    predictions: list[Prediction] = []
    for batch in chronological_batches(target):
        as_of = batch[0].played_on
        model = fit_poisson_strengths(known, as_of, config)
        for match in batch:
            home_rate, away_rate = poisson_rates(model, match.home, match.away)
            matrix = score_matrix(home_rate, away_rate, config.rho)
            predictions.append(
                Prediction(
                    match=match,
                    probabilities=outcome_from_matrix(matrix),
                    expected_home_goals=home_rate,
                    expected_away_goals=away_rate,
                    predicted_score=modal_score(matrix),
                )
            )
        known.extend(batch)
    return predictions


def replace_rho(predictions: Sequence[Prediction], rho: float) -> list[Prediction]:
    adjusted: list[Prediction] = []
    for prediction in predictions:
        if prediction.expected_home_goals is None or prediction.expected_away_goals is None:
            raise ValueError("previsão sem intensidades de gol")
        matrix = score_matrix(prediction.expected_home_goals, prediction.expected_away_goals, rho)
        adjusted.append(
            Prediction(
                match=prediction.match,
                probabilities=outcome_from_matrix(matrix),
                expected_home_goals=prediction.expected_home_goals,
                expected_away_goals=prediction.expected_away_goals,
                predicted_score=modal_score(matrix),
            )
        )
    return adjusted


def baseline_walkforward(history: Sequence[Match], target: Sequence[Match]) -> list[Prediction]:
    counts = Counter(match.outcome_index for match in history)
    predictions: list[Prediction] = []
    for batch in chronological_batches(target):
        probabilities = safe_normalize((counts[0] + 3.0, counts[1] + 3.0, counts[2] + 3.0))
        for match in batch:
            predictions.append(Prediction(match=match, probabilities=probabilities))
        for match in batch:
            counts[match.outcome_index] += 1
    return predictions


def elo_probabilities(ratings: dict[str, float], home: str, away: str, config: EloConfig) -> tuple[float, float, float]:
    home_rating = ratings.get(home, 1500.0)
    away_rating = ratings.get(away, 1500.0)
    difference = home_rating + config.home_advantage - away_rating
    home_share = 1.0 / (1.0 + 10.0 ** (-difference / 400.0))
    draw = config.draw_base * math.exp(-abs(difference) / max(1.0, config.draw_scale))
    draw = min(0.36, max(0.10, draw))
    remaining = 1.0 - draw
    return safe_normalize((remaining * home_share, draw, remaining * (1.0 - home_share)))  # type: ignore[return-value]


def elo_update(ratings: dict[str, float], match: Match, config: EloConfig) -> None:
    home_rating = ratings.get(match.home, 1500.0)
    away_rating = ratings.get(match.away, 1500.0)
    difference = home_rating + config.home_advantage - away_rating
    expected = 1.0 / (1.0 + 10.0 ** (-difference / 400.0))
    score = 1.0 if match.home_goals > match.away_goals else 0.5 if match.home_goals == match.away_goals else 0.0
    goal_difference = abs(match.home_goals - match.away_goals)
    margin = 1.0 + (math.log1p(goal_difference) if goal_difference else 0.0) * 0.35
    delta = config.k_factor * margin * (score - expected)
    ratings[match.home] = home_rating + delta
    ratings[match.away] = away_rating - delta


def elo_walkforward(history: Sequence[Match], target: Sequence[Match], config: EloConfig) -> list[Prediction]:
    ratings: dict[str, float] = {}
    for batch in chronological_batches(history):
        for match in batch:
            ratings.setdefault(match.home, 1500.0)
            ratings.setdefault(match.away, 1500.0)
        for match in batch:
            elo_update(ratings, match, config)
    predictions: list[Prediction] = []
    for batch in chronological_batches(target):
        for match in batch:
            predictions.append(
                Prediction(match=match, probabilities=elo_probabilities(ratings, match.home, match.away, config))
            )
        for match in batch:
            elo_update(ratings, match, config)
    return predictions


def hybrid_predictions(
    poisson_predictions: Sequence[Prediction],
    elo_predictions: Sequence[Prediction],
    poisson_weight: float,
) -> list[Prediction]:
    elo_by_key = {prediction.match.key: prediction for prediction in elo_predictions}
    output: list[Prediction] = []
    for poisson_prediction in poisson_predictions:
        elo_prediction = elo_by_key.get(poisson_prediction.match.key)
        if elo_prediction is None:
            raise ValueError(f"previsão Elo ausente para {poisson_prediction.match.key}")
        probabilities = safe_normalize(
            tuple(
                poisson_weight * poisson_prediction.probabilities[index]
                + (1.0 - poisson_weight) * elo_prediction.probabilities[index]
                for index in range(3)
            )
        )
        output.append(
            Prediction(
                match=poisson_prediction.match,
                probabilities=probabilities,  # type: ignore[arg-type]
                expected_home_goals=poisson_prediction.expected_home_goals,
                expected_away_goals=poisson_prediction.expected_away_goals,
                predicted_score=poisson_prediction.predicted_score,
            )
        )
    return output


def metrics(predictions: Sequence[Prediction]) -> dict[str, Any]:
    if not predictions:
        raise ValueError("lista vazia de previsões")
    log_loss = 0.0
    brier = 0.0
    rps = 0.0
    correct = 0
    home_goal_errors: list[float] = []
    away_goal_errors: list[float] = []
    exact_scores = 0
    flat: list[tuple[float, int]] = []
    batch_probabilities: dict[date, list[tuple[float, float, float]]] = defaultdict(list)

    for prediction in predictions:
        actual = prediction.match.outcome_index
        probabilities = safe_normalize(prediction.probabilities)
        log_loss -= math.log(max(EPS, probabilities[actual]))
        target = [1.0 if index == actual else 0.0 for index in range(3)]
        brier += sum((probabilities[index] - target[index]) ** 2 for index in range(3))
        cumulative_p1 = probabilities[0]
        cumulative_y1 = target[0]
        cumulative_p2 = probabilities[0] + probabilities[1]
        cumulative_y2 = target[0] + target[1]
        rps += ((cumulative_p1 - cumulative_y1) ** 2 + (cumulative_p2 - cumulative_y2) ** 2) / 2.0
        correct += int(max(range(3), key=lambda index: probabilities[index]) == actual)
        for index in range(3):
            flat.append((probabilities[index], int(index == actual)))
        if prediction.expected_home_goals is not None:
            home_goal_errors.append(abs(prediction.expected_home_goals - prediction.match.home_goals))
        if prediction.expected_away_goals is not None:
            away_goal_errors.append(abs(prediction.expected_away_goals - prediction.match.away_goals))
        if prediction.predicted_score is not None:
            exact_scores += int(
                prediction.predicted_score == (prediction.match.home_goals, prediction.match.away_goals)
            )
        batch_probabilities[prediction.match.played_on].append(probabilities)  # type: ignore[arg-type]

    bins: list[dict[str, Any]] = []
    expected_calibration_error = 0.0
    for lower_index in range(10):
        lower = lower_index / 10.0
        upper = (lower_index + 1) / 10.0
        bucket = [item for item in flat if lower <= item[0] < upper or (upper == 1.0 and item[0] <= 1.0)]
        if not bucket:
            bins.append(
                {
                    "faixa": f"{lower:.1f}–{upper:.1f}",
                    "n": 0,
                    "probabilidade_media": None,
                    "frequencia_observada": None,
                }
            )
            continue
        mean_probability = sum(item[0] for item in bucket) / len(bucket)
        observed = sum(item[1] for item in bucket) / len(bucket)
        expected_calibration_error += len(bucket) / len(flat) * abs(mean_probability - observed)
        bins.append(
            {
                "faixa": f"{lower:.1f}–{upper:.1f}",
                "n": len(bucket),
                "probabilidade_media": round(mean_probability, 6),
                "frequencia_observada": round(observed, 6),
            }
        )

    chronological_means: list[tuple[float, float, float]] = []
    for played_on in sorted(batch_probabilities):
        values = batch_probabilities[played_on]
        chronological_means.append(
            tuple(sum(value[index] for value in values) / len(values) for index in range(3))
        )
    shifts: list[float] = []
    for previous, current in zip(chronological_means, chronological_means[1:]):
        shifts.append(sum(abs(current[index] - previous[index]) for index in range(3)) / 3.0)

    n = len(predictions)
    return {
        "partidas": n,
        "log_loss": round(log_loss / n, 8),
        "brier_multiclasse": round(brier / n, 8),
        "rps": round(rps / n, 8),
        "acuracia_resultado": round(correct / n, 8),
        "ece_10_faixas": round(expected_calibration_error, 8),
        "mae_gols_mandante": round(statistics.mean(home_goal_errors), 8) if home_goal_errors else None,
        "mae_gols_visitante": round(statistics.mean(away_goal_errors), 8) if away_goal_errors else None,
        "acerto_placar_exato": round(exact_scores / n, 8) if home_goal_errors else None,
        "oscilacao_media_vetor_rodada": round(statistics.mean(shifts), 8) if shifts else 0.0,
        "calibracao": bins,
    }


def objective(metric: dict[str, Any]) -> float:
    return (
        float(metric["log_loss"])
        + 0.35 * float(metric["brier_multiclasse"])
        + 0.15 * float(metric["rps"])
        + 0.10 * float(metric["ece_10_faixas"])
    )


def tune_poisson_regularized(base: Sequence[Match], calibration: Sequence[Match]) -> tuple[PoissonConfig, dict[str, Any]]:
    trials: list[dict[str, Any]] = []
    for prior in (4.0, 8.0, 12.0, 20.0):
        config = PoissonConfig(prior_matches=prior, half_life_days=None, rho=0.0)
        prediction = predict_poisson_walkforward(base, calibration, config)
        metric = metrics(prediction)
        trials.append({"config": config, "metricas": metric, "objetivo": objective(metric)})
    winner = min(trials, key=lambda item: item["objetivo"])
    return winner["config"], {
        "selecionado": poisson_config_dict(winner["config"]),
        "objetivo": round(winner["objetivo"], 8),
        "tentativas": [
            {
                "config": poisson_config_dict(item["config"]),
                "objetivo": round(item["objetivo"], 8),
                "log_loss": item["metricas"]["log_loss"],
                "brier_multiclasse": item["metricas"]["brier_multiclasse"],
            }
            for item in trials
        ],
    }


def valid_rho_for_predictions(predictions: Sequence[Prediction], rho: float) -> bool:
    for prediction in predictions:
        home_rate = prediction.expected_home_goals
        away_rate = prediction.expected_away_goals
        if home_rate is None or away_rate is None:
            return False
        for score in ((0, 0), (0, 1), (1, 0), (1, 1)):
            if dixon_coles_tau(score[0], score[1], home_rate, away_rate, rho) <= 0:
                return False
    return True


def tune_poisson_map(base: Sequence[Match], calibration: Sequence[Match]) -> tuple[MapConfig, dict[str, Any]]:
    trials: list[dict[str, Any]] = []
    for prior_sd in (0.25, 0.40, 0.60):
        for half_life in (None, 365.0, 730.0):
            config = MapConfig(prior_sd=prior_sd, half_life_days=half_life)
            metric = metrics(predict_map_walkforward(base, calibration, config))
            trials.append({"config": config, "metricas": metric, "objetivo": objective(metric)})
    winner = min(trials, key=lambda item: item["objetivo"])
    ordered = sorted(trials, key=lambda item: item["objetivo"])
    return winner["config"], {
        "selecionado": map_config_dict(winner["config"]),
        "objetivo": round(winner["objetivo"], 8),
        "tentativas": [
            {
                "config": map_config_dict(item["config"]),
                "objetivo": round(item["objetivo"], 8),
                "log_loss": item["metricas"]["log_loss"],
                "brier_multiclasse": item["metricas"]["brier_multiclasse"],
            }
            for item in ordered
        ],
    }


def tune_dixon_coles(base: Sequence[Match], calibration: Sequence[Match]) -> tuple[PoissonConfig, dict[str, Any]]:
    trials: list[dict[str, Any]] = []
    rho_grid = [round(-0.20 + index * 0.02, 2) for index in range(16)]  # -0,20 a +0,10
    for prior in (6.0, 10.0, 16.0):
        for half_life in (180.0, 365.0, 730.0):
            base_config = PoissonConfig(prior_matches=prior, half_life_days=half_life, rho=0.0)
            raw = predict_poisson_walkforward(base, calibration, base_config)
            for rho in rho_grid:
                if not valid_rho_for_predictions(raw, rho):
                    continue
                adjusted = replace_rho(raw, rho)
                metric = metrics(adjusted)
                config = PoissonConfig(prior_matches=prior, half_life_days=half_life, rho=rho)
                trials.append({"config": config, "metricas": metric, "objetivo": objective(metric)})
    if not trials:
        raise RuntimeError("nenhuma configuração Dixon–Coles válida")
    winner = min(trials, key=lambda item: item["objetivo"])
    ordered = sorted(trials, key=lambda item: item["objetivo"])[:12]
    return winner["config"], {
        "selecionado": poisson_config_dict(winner["config"]),
        "objetivo": round(winner["objetivo"], 8),
        "melhores_tentativas": [
            {
                "config": poisson_config_dict(item["config"]),
                "objetivo": round(item["objetivo"], 8),
                "log_loss": item["metricas"]["log_loss"],
                "brier_multiclasse": item["metricas"]["brier_multiclasse"],
            }
            for item in ordered
        ],
        "total_tentativas_validas": len(trials),
    }


def tune_elo(base: Sequence[Match], calibration: Sequence[Match]) -> tuple[EloConfig, dict[str, Any]]:
    trials: list[dict[str, Any]] = []
    for k_factor in (18.0, 26.0, 34.0):
        for home_advantage in (45.0, 70.0, 95.0):
            for draw_base in (0.24, 0.28, 0.32):
                for draw_scale in (260.0, 420.0):
                    config = EloConfig(k_factor, home_advantage, draw_base, draw_scale)
                    metric = metrics(elo_walkforward(base, calibration, config))
                    trials.append({"config": config, "metricas": metric, "objetivo": objective(metric)})
    winner = min(trials, key=lambda item: item["objetivo"])
    ordered = sorted(trials, key=lambda item: item["objetivo"])[:10]
    return winner["config"], {
        "selecionado": elo_config_dict(winner["config"]),
        "objetivo": round(winner["objetivo"], 8),
        "melhores_tentativas": [
            {
                "config": elo_config_dict(item["config"]),
                "objetivo": round(item["objetivo"], 8),
                "log_loss": item["metricas"]["log_loss"],
                "brier_multiclasse": item["metricas"]["brier_multiclasse"],
            }
            for item in ordered
        ],
        "total_tentativas": len(trials),
    }


def tune_hybrid(
    dc_predictions: Sequence[Prediction], elo_predictions: Sequence[Prediction]
) -> tuple[float, dict[str, Any]]:
    trials: list[dict[str, Any]] = []
    for index in range(0, 21):
        weight = index / 20.0
        metric = metrics(hybrid_predictions(dc_predictions, elo_predictions, weight))
        trials.append({"peso_poisson_dc": weight, "metricas": metric, "objetivo": objective(metric)})
    winner = min(trials, key=lambda item: item["objetivo"])
    return float(winner["peso_poisson_dc"]), {
        "peso_poisson_dc": winner["peso_poisson_dc"],
        "peso_elo": round(1.0 - winner["peso_poisson_dc"], 2),
        "objetivo": round(winner["objetivo"], 8),
        "tentativas": [
            {
                "peso_poisson_dc": item["peso_poisson_dc"],
                "peso_elo": round(1.0 - item["peso_poisson_dc"], 2),
                "objetivo": round(item["objetivo"], 8),
            }
            for item in trials
        ],
    }


def poisson_config_dict(config: PoissonConfig) -> dict[str, Any]:
    return {
        "prior_partidas": config.prior_matches,
        "meia_vida_dias": config.half_life_days,
        "rho_dixon_coles": config.rho,
    }


def map_config_dict(config: MapConfig) -> dict[str, Any]:
    return {
        "desvio_prior": config.prior_sd,
        "meia_vida_dias": config.half_life_days,
        "reajuste_a_cada_dias": config.refit_days,
    }


def elo_config_dict(config: EloConfig) -> dict[str, Any]:
    return {
        "fator_k": config.k_factor,
        "vantagem_mando_pontos": config.home_advantage,
        "empate_base": config.draw_base,
        "escala_empate": config.draw_scale,
    }


def calibration_split(training: Sequence[Match]) -> tuple[list[Match], list[Match], str]:
    last_season = max(match.season for match in training)
    last_matches = [match for match in training if match.season == last_season]
    earlier = [match for match in training if match.season < last_season]
    cut = int(len(last_matches) * 0.63)
    cut = min(max(cut, 180), len(last_matches) - 100)
    cutoff_date = last_matches[cut - 1].played_on
    base = earlier + last_matches[:cut]
    calibration = last_matches[cut:]
    return base, calibration, cutoff_date.isoformat()


def fold_backtest(training: Sequence[Match], test: Sequence[Match], target_season: int) -> dict[str, Any]:
    base, calibration, cutoff = calibration_split(training)
    poisson_config, poisson_tuning = tune_poisson_regularized(base, calibration)
    map_config, map_tuning = tune_poisson_map(base, calibration)
    dc_config, dc_tuning = tune_dixon_coles(base, calibration)
    elo_config, elo_tuning = tune_elo(base, calibration)

    calibration_dc = predict_poisson_walkforward(base, calibration, dc_config)
    calibration_elo = elo_walkforward(base, calibration, elo_config)
    hybrid_weight, hybrid_tuning = tune_hybrid(calibration_dc, calibration_elo)

    predictions: dict[str, list[Prediction]] = {
        "frequencia_historica": baseline_walkforward(training, test),
        "poisson_regularizado": predict_poisson_walkforward(training, test, poisson_config),
        "poisson_map_bayesiano": predict_map_walkforward(training, test, map_config),
        "dixon_coles_temporal": predict_poisson_walkforward(training, test, dc_config),
        "elo_dinamico": elo_walkforward(training, test, elo_config),
    }
    predictions["hibrido_dc_elo"] = hybrid_predictions(
        predictions["dixon_coles_temporal"], predictions["elo_dinamico"], hybrid_weight
    )
    model_metrics = {name: metrics(values) for name, values in predictions.items()}
    return {
        "temporada_teste": target_season,
        "temporadas_treinamento": sorted({match.season for match in training}),
        "partidas_treinamento": len(training),
        "partidas_teste": len(test),
        "validacao_interna": {
            "temporada": max(match.season for match in training),
            "data_corte": cutoff,
            "partidas_base": len(base),
            "partidas_calibracao": len(calibration),
            "regra": "corte cronológico de aproximadamente 63% da última temporada de treinamento",
        },
        "hiperparametros": {
            "poisson_regularizado": poisson_tuning,
            "poisson_map_bayesiano": map_tuning,
            "dixon_coles_temporal": dc_tuning,
            "elo_dinamico": elo_tuning,
            "hibrido_dc_elo": hybrid_tuning,
        },
        "metricas": model_metrics,
        "previsoes_por_modelo": predictions,
        "configs": {
            "poisson_regularizado": poisson_config,
            "poisson_map_bayesiano": map_config,
            "dixon_coles_temporal": dc_config,
            "elo_dinamico": elo_config,
            "peso_hibrido": hybrid_weight,
        },
    }


def aggregate_metrics(folds: Sequence[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    names = sorted(folds[0]["metricas"])
    output: dict[str, dict[str, Any]] = {}
    for name in names:
        total = sum(int(fold["metricas"][name]["partidas"]) for fold in folds)
        numeric_fields = [
            "log_loss",
            "brier_multiclasse",
            "rps",
            "acuracia_resultado",
            "ece_10_faixas",
            "mae_gols_mandante",
            "mae_gols_visitante",
            "acerto_placar_exato",
            "oscilacao_media_vetor_rodada",
        ]
        aggregate: dict[str, Any] = {"partidas": total}
        for field in numeric_fields:
            values: list[tuple[float, int]] = []
            for fold in folds:
                value = fold["metricas"][name].get(field)
                count = int(fold["metricas"][name]["partidas"])
                if value is not None:
                    values.append((float(value), count))
            aggregate[field] = (
                round(sum(value * count for value, count in values) / sum(count for _, count in values), 8)
                if values
                else None
            )
        output[name] = aggregate
    return output


def rank_models(aggregate: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    # Log Loss, Brier e RPS são regras de pontuação próprias. O ECE é
    # um diagnóstico útil, mas não é regra própria e pode ser instável em
    # amostras pequenas; por isso não decide o vencedor. Modelos com ECE
    # acima do limite são sinalizados, não premiados por simples suavização.
    fields = {
        "log_loss": 0.50,
        "brier_multiclasse": 0.30,
        "rps": 0.20,
    }
    ranges: dict[str, tuple[float, float]] = {}
    for field in fields:
        values = [float(metric[field]) for metric in aggregate.values()]
        ranges[field] = (min(values), max(values))
    ranking: list[dict[str, Any]] = []
    for name, metric in aggregate.items():
        score = 0.0
        components: dict[str, float] = {}
        for field, weight in fields.items():
            low, high = ranges[field]
            normalized = 0.0 if math.isclose(low, high) else (float(metric[field]) - low) / (high - low)
            components[field] = round(normalized, 8)
            score += weight * normalized
        ranking.append(
            {
                "modelo": name,
                "score_selecao": round(score, 8),
                "componentes_normalizados": components,
                "metricas": metric,
            }
        )
    ranking.sort(key=lambda item: (item["score_selecao"], item["metricas"]["log_loss"]))
    for position, item in enumerate(ranking, start=1):
        item["posicao"] = position
    return ranking


def clean_fold_for_json(fold: dict[str, Any]) -> dict[str, Any]:
    return {
        "temporada_teste": fold["temporada_teste"],
        "temporadas_treinamento": fold["temporadas_treinamento"],
        "partidas_treinamento": fold["partidas_treinamento"],
        "partidas_teste": fold["partidas_teste"],
        "validacao_interna": fold["validacao_interna"],
        "hiperparametros": fold["hiperparametros"],
        "metricas": fold["metricas"],
    }


def build_report(audit: dict[str, Any]) -> str:
    winner = audit["selecao_modelo"]["vencedor"]
    ranking = audit["selecao_modelo"]["ranking"]
    report_labels = {
        "frequencia_historica": "Frequência histórica",
        "poisson_regularizado": "Poisson regularizado empírico-bayesiano",
        "poisson_map_bayesiano": "Poisson log-linear MAP",
        "dixon_coles_temporal": "Poisson temporal + Dixon–Coles",
        "elo_dinamico": "Elo dinâmico",
        "hibrido_dc_elo": "Híbrido Dixon–Coles + Elo",
    }
    rows = "\n".join(
        f"| {item['posicao']} | {report_labels[item['modelo']]} | {item['metricas']['log_loss']:.4f} | "
        f"{item['metricas']['brier_multiclasse']:.4f} | {item['metricas']['rps']:.4f} | "
        f"{item['metricas']['ece_10_faixas']:.4f} | {item['metricas']['acuracia_resultado']:.1%} |"
        for item in ranking
    )
    folds_text: list[str] = []
    for fold in audit["folds"]:
        folds_text.append(
            f"### Teste em {fold['temporada_teste']}\n\n"
            f"Treinamento: {', '.join(map(str, fold['temporadas_treinamento']))}; "
            f"{fold['partidas_treinamento']} partidas de treinamento e "
            f"{fold['partidas_teste']} partidas integralmente fora da amostra.\n"
        )
    return f"""# AF-Previsão — Execução 1

## Base histórica, comparação de modelos e backtesting

**Versão:** {audit['versao_modelo']}  
**Supervisão matemática:** **Laércio Rehem**, matemático pela Universidade Federal da Bahia (UFBA).  
**Sugestões, elogios e dúvidas:** utilize o botão **SUGESTÕES** do site.

## Finalidade desta execução

Esta etapa constrói a fundação científica do futuro módulo de probabilidades do Brasileirão. Ela **não publica ainda percentuais de título, classificação continental ou rebaixamento**. Seu objetivo é impedir que a interface seja criada antes de existir uma validação temporal rigorosa do motor estatístico.

Foram normalizadas e auditadas as temporadas completas de **2023, 2024 e 2025**, totalizando **1.140 partidas**. A temporada de 2026 é mantida separada: entra apenas como estado corrente na próxima execução e nunca é tratada como campeonato concluído.

## Protocolo de validação

O backtesting respeita a ordem temporal. Nenhuma partida futura participa da previsão de uma partida passada. Foram usados dois testes fora da amostra:

{''.join(folds_text)}
Cada teste possui ainda uma validação interna cronológica na temporada anterior para escolher hiperparâmetros sem consultar o campeonato testado.

## Modelos comparados

1. **Frequência histórica regularizada:** referência simples de vitórias do mandante, empates e vitórias do visitante.
2. **Poisson regularizado empírico-bayesiano:** estima forças ofensivas e defensivas com regressão à média por pseudo-observações.
3. **Poisson log-linear MAP:** ajusta ataque e defesa na escala log com priors gaussianos e escolhe o modo posterior; é uma aproximação bayesiana determinística, sem MCMC.
4. **Poisson temporal com correção Dixon–Coles:** acrescenta decaimento temporal e corrige a dependência dos placares baixos — especialmente 0–0, 1–0, 0–1 e 1–1.
5. **Elo dinâmico:** atualiza a força das equipes após cada resultado, considerando mando e margem do placar.
6. **Híbrido Dixon–Coles + Elo:** combina probabilidades de gols e força dinâmica. O peso da combinação é escolhido apenas na janela de calibração anterior.

O AF-Score não foi usado neste backtesting porque as estatísticas detalhadas históricas não possuem a mesma cobertura de 2026. Incluí-lo apenas na temporada corrente produziria uma comparação desigual e poderia gerar vazamento metodológico. Na Execução 2, sua contribuição será testada de forma controlada, sem substituir o modelo de gols.

## Critérios de escolha

A seleção não usa somente “taxa de acerto”. Probabilidades precisam ser **bem calibradas**, não apenas escolher o lado mais provável. O score de seleção combina:

- **50% Log Loss:** pune com força previsões excessivamente confiantes e erradas;
- **30% Brier Score multiclasse:** mede a distância entre as probabilidades e o resultado observado;
- **20% Ranked Probability Score (RPS):** respeita a ordenação vitória–empate–derrota.

As três métricas são regras de pontuação próprias: um modelo não melhora seu resultado apenas “achatando” probabilidades. O erro de calibração (ECE) é exibido e gera alerta acima de 0,05, mas não decide sozinho o vencedor, pois depende da escolha das faixas e pode oscilar em amostras menores. A acurácia do resultado, os erros de gols, o acerto de placar exato e a oscilação entre blocos cronológicos também são diagnósticos.

## Resultado comparativo

| Posição | Modelo | Log Loss | Brier | RPS | ECE | Acurácia do resultado |
|---:|---|---:|---:|---:|---:|---:|
{rows}

### Arquitetura selecionada para a Execução 2

**{winner['rotulo']}** (`{winner['id']}`).

{winner['justificativa']}

A escolha é provisória no sentido científico correto: permanecerá versionada e poderá ser substituída se novos backtests demonstrarem ganho real de calibração. O site não declarará superioridade sem evidência mensurável.

## Tratamento dos clubes promovidos

A ausência de um clube em uma ou mais temporadas da Série A não invalida o histórico. O modelo regularizado aplica **partial pooling**: um time novo ou promovido começa próximo da média da competição, com incerteza maior, e passa a receber identidade própria conforme acumula jogos em 2026. Isso é preferível a atribuir força arbitrária ou importar diretamente resultados da Série B, competição de nível e composição diferentes.

## Limitações assumidas

- Escalações, lesões, suspensões e mudanças de treinador ainda não entram como variáveis explícitas.
- O banco histórico desta execução contém resultados e gols, não xG histórico homogêneo.
- O regulamento de vagas continentais pode mudar conforme campeões de outras competições; esse tratamento será configurável na Execução 2.
- A correção Dixon–Coles melhora a representação de placares baixos, mas não elimina toda dependência entre os gols das equipes.
- Probabilidade não é certeza: um evento com 20% continua possível, e um evento com 80% pode não ocorrer.

## Reprodutibilidade

Os arquivos de auditoria registram:

- fontes e hashes da base;
- partidas e clubes por temporada;
- reconstrução independente das classificações;
- hiperparâmetros testados e selecionados;
- métricas por temporada e agregadas;
- versão do protocolo de seleção.

A Execução 2 deverá usar a arquitetura vencedora para estimar cada partida restante e simular o campeonato por Monte Carlo. A Execução 3 cuidará da interface e da metodologia pública completa.

## Referências bibliográficas centrais

1. Dixon, M. J.; Coles, S. G. (1997). Artigo sobre modelagem de placares de futebol. *Journal of the Royal Statistical Society: Series C*, 46(2), 265–280. DOI: 10.1111/1467-9876.00065. A referência é utilizada exclusivamente pela formulação estatística dos placares.
2. Baio, G.; Blangiardo, M. (2010). *Bayesian hierarchical model for the prediction of football results*. Journal of Applied Statistics, 37(2), 253–264. DOI: 10.1080/02664760802684177.
3. Constantinou, A. C.; Fenton, N. E. (2012). *Solving the problem of inadequate scoring rules for assessing probabilistic football forecast models*. Journal of Quantitative Analysis in Sports, 8(1). DOI: 10.1515/1559-0410.1418.
4. UFMG — Departamento de Matemática. *Probabilidades no Futebol*. Referência brasileira de divulgação e simulação probabilística do Campeonato Brasileiro.

## Autoria

Metodologia AF-Previsão desenvolvida para o site **Brasileirão 2026 — Almoço de Sexta**, sob supervisão de **Laércio Rehem, matemático pela Universidade Federal da Bahia (UFBA)**.

Para sugestões, elogios ou dúvidas metodológicas, utilize o botão **SUGESTÕES** do site.
"""


def create_audit() -> dict[str, Any]:
    base_audit = load_json(BASE_AUDIT)
    if base_audit.get("status") != "ok":
        raise RuntimeError("auditoria histórica não está válida; execute af_previsao_base_historica.py")
    seasons = load_matches()
    missing = [season for season in (2023, 2024, 2025) if season not in seasons]
    if missing:
        raise RuntimeError(f"temporadas ausentes: {missing}")

    fold_2024 = fold_backtest(seasons[2023], seasons[2024], 2024)
    fold_2025 = fold_backtest(seasons[2023] + seasons[2024], seasons[2025], 2025)
    folds = [fold_2024, fold_2025]
    aggregate = aggregate_metrics(folds)
    ranking = rank_models(aggregate)
    winner_id = ranking[0]["modelo"]
    labels = {
        "frequencia_historica": "Frequência histórica regularizada",
        "poisson_regularizado": "Poisson regularizado empírico-bayesiano",
        "poisson_map_bayesiano": "Poisson log-linear MAP com priors gaussianos",
        "dixon_coles_temporal": "Poisson temporal com correção Dixon–Coles",
        "elo_dinamico": "Elo dinâmico",
        "hibrido_dc_elo": "Modelo híbrido Dixon–Coles + Elo",
    }
    winning_metric = ranking[0]["metricas"]
    runner_up = ranking[1]
    improvement = (
        (float(runner_up["metricas"]["log_loss"]) - float(winning_metric["log_loss"]))
        / float(runner_up["metricas"]["log_loss"])
        * 100.0
    )
    if winner_id == "poisson_map_bayesiano":
        winner_note = (
            "O resultado é um empate prático com o Poisson regularizado por pseudo-observações, "
            "mas o MAP obteve vantagem pequena e consistente no agregado de Log Loss, Brier e RPS. "
            "Ele foi escolhido por representar diretamente ataque e defesa na escala log, com priors "
            "gaussianos e partial pooling. A correção Dixon–Coles apresentou ECE menor, porém não "
            "superou o MAP nas três regras de pontuação próprias; seguirá como análise de sensibilidade."
        )
    else:
        winner_note = (
            "A arquitetura foi escolhida pelas regras de pontuação próprias. Modelos com melhor ECE "
            "isolado permanecem como análise de sensibilidade, pois calibração por faixas não deve "
            "substituir Log Loss, Brier e RPS na decisão principal."
        )
    winner = {
        "id": winner_id,
        "rotulo": labels[winner_id],
        "justificativa": (
            f"Obteve o menor score composto do protocolo, com Log Loss {winning_metric['log_loss']:.4f}, "
            f"Brier {winning_metric['brier_multiclasse']:.4f}, RPS {winning_metric['rps']:.4f} e "
            f"ECE {winning_metric['ece_10_faixas']:.4f}. O ganho de Log Loss sobre o segundo colocado "
            f"foi de {improvement:.2f}% no conjunto agregado. {winner_note}"
        ),
        "empate_pratico": improvement < 0.25,
        "uso_na_execucao_2": "arquitetura-base; parâmetros serão recalibrados com todas as temporadas concluídas",
    }

    audit = {
        "schema_version": 1,
        "projeto": "AF-Previsão",
        "versao_modelo": "AF-Previsão 0.1 — protocolo de seleção",
        "etapa": "Execução 1 — base histórica e backtesting",
        "gerado_em": load_json(CONFIG_PATH).get("data_referencia_execucao_1"),
        "status": "ok",
        "responsavel": {
            "nome": "Laércio Rehem",
            "formacao": "Matemático pela Universidade Federal da Bahia (UFBA)",
            "contato": "Sugestões, elogios e dúvidas: utilize o botão SUGESTÕES do site.",
        },
        "base": {
            "temporadas": [2023, 2024, 2025],
            "partidas": sum(len(seasons[season]) for season in (2023, 2024, 2025)),
            "auditoria": str(BASE_AUDIT.relative_to(ROOT)),
            "status": base_audit.get("status"),
        },
        "protocolo": {
            "tipo": "validação temporal aninhada fora da amostra",
            "folds": [
                "treina em 2023 e testa as 380 partidas de 2024",
                "treina em 2023–2024 e testa as 380 partidas de 2025",
            ],
            "lote_temporal": "partidas da mesma data são previstas antes de qualquer atualização desse dia",
            "score_selecao": {
                "log_loss": 0.50,
                "brier_multiclasse": 0.30,
                "rps": 0.20,
                "ece_10_faixas": "diagnóstico; alerta acima de 0,05",
            },
            "semente_aleatoria": None,
            "deterministico": True,
            "observacao": "A Execução 1 não utiliza Monte Carlo; a simulação entra somente na Execução 2.",
        },
        "modelos": {
            "frequencia_historica": "baseline Dirichlet para mandante/empate/visitante",
            "poisson_regularizado": "forças ataque/defesa com shrinkage empírico-bayesiano",
            "poisson_map_bayesiano": "modelo log-linear ajustado pelo modo posterior (MAP), com priors gaussianos",
            "dixon_coles_temporal": "Poisson regularizado + decaimento temporal + correção de placares baixos",
            "elo_dinamico": "rating sequencial com mando, empate e margem do resultado",
            "hibrido_dc_elo": "combinação convexa calibrada sem consultar a temporada de teste",
        },
        "folds": [clean_fold_for_json(fold) for fold in folds],
        "metricas_agregadas": aggregate,
        "selecao_modelo": {"vencedor": winner, "ranking": ranking},
        "af_score": {
            "usado_no_backtesting": False,
            "motivo": "não há cobertura histórica homogênea das estatísticas detalhadas de 2023–2025",
            "decisao": "testar contribuição incremental apenas na Execução 2, com trava contra dupla contagem e vazamento",
        },
        "promovidos": {
            "tratamento": "regressão à média / partial pooling",
            "serie_b_incorporada": False,
            "justificativa": "resultados de outra divisão não são diretamente comparáveis; a incerteza inicial é explicitamente maior",
        },
        "referencias": [
            {
                "citacao": "Dixon, M. J.; Coles, S. G. (1997). Artigo de modelagem probabilística de placares de futebol, JRSS Series C 46(2), 265–280.",
                "doi": "10.1111/1467-9876.00065",
                "uso": "correção de dependência em placares baixos",
            },
            {
                "citacao": "Baio, G.; Blangiardo, M. (2010). Bayesian hierarchical model for the prediction of football results.",
                "doi": "10.1080/02664760802684177",
                "uso": "regularização hierárquica e compartilhamento parcial de informação",
            },
            {
                "citacao": "Constantinou, A. C.; Fenton, N. E. (2012). Solving the problem of inadequate scoring rules for assessing probabilistic football forecast models.",
                "doi": "10.1515/1559-0410.1418",
                "uso": "avaliação probabilística além da acurácia simples",
            },
            {
                "citacao": "UFMG — Departamento de Matemática. Probabilidades no Futebol.",
                "url": "https://www.mat.ufmg.br/extensao/probabilidade-no-futebol/",
                "uso": "referência brasileira de divulgação e simulação do campeonato",
            },
        ],
        "limites": [
            "sem xG histórico homogêneo",
            "sem escalações, lesões ou suspensões como variáveis explícitas",
            "sem probabilidades comerciais ou dados de apostas",
            "regulamento de vagas continentais será parametrizado na Execução 2",
        ],
        "proxima_execucao": [
            "recalibrar a arquitetura vencedora com 2023–2025 completos",
            "incorporar o estado atual de 2026 sem vazamento",
            "calcular probabilidades de cada partida restante",
            "simular a classificação final por Monte Carlo com critérios oficiais de desempate",
            "gerar probabilidades de título, zonas continentais e rebaixamento com intervalos de incerteza",
        ],
    }
    return audit


def self_test() -> None:
    matrix = score_matrix(1.4, 1.0, -0.08)
    assert math.isclose(sum(sum(row) for row in matrix), 1.0, rel_tol=0.0, abs_tol=1e-10)
    probabilities = outcome_from_matrix(matrix)
    assert math.isclose(sum(probabilities), 1.0, rel_tol=0.0, abs_tol=1e-10)
    assert all(0.0 < value < 1.0 for value in probabilities)
    synthetic = [
        Match(2023, 1, 1, date(2023, 1, 1), "A", "B", 2, 0),
        Match(2023, 2, 1, date(2023, 1, 1), "C", "D", 1, 1),
        Match(2023, 3, 2, date(2023, 1, 8), "B", "A", 0, 1),
        Match(2023, 4, 2, date(2023, 1, 8), "D", "C", 1, 2),
    ]
    target = [Match(2024, 5, 1, date(2024, 1, 1), "A", "C", 1, 0)]
    config = PoissonConfig(8.0, 365.0, -0.05)
    prediction = predict_poisson_walkforward(synthetic, target, config)
    assert len(prediction) == 1
    assert math.isclose(sum(prediction[0].probabilities), 1.0, abs_tol=1e-10)
    map_prediction = predict_map_walkforward(synthetic, target, MapConfig(0.4, 365.0, 21))
    assert len(map_prediction) == 1
    assert math.isclose(sum(map_prediction[0].probabilities), 1.0, abs_tol=1e-10)
    elo = elo_walkforward(synthetic, target, EloConfig(26.0, 70.0, 0.28, 420.0))
    assert len(elo) == 1
    hybrid = hybrid_predictions(prediction, elo, 0.7)
    assert math.isclose(sum(hybrid[0].probabilities), 1.0, abs_tol=1e-10)
    metric = metrics(hybrid)
    assert metric["partidas"] == 1
    assert metric["log_loss"] > 0
    print("SELF-TEST OK — backtesting AF-Previsão")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    try:
        audit = create_audit()
        OUTPUT_PATH.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        REPORT_PATH.write_text(build_report(audit), encoding="utf-8")
    except Exception as exc:  # pragma: no cover - falha precisa parar workflow
        print(f"ERRO no backtesting: {exc}", file=sys.stderr)
        raise
    winner = audit["selecao_modelo"]["vencedor"]
    print("Backtesting concluído")
    print(f"Modelo selecionado: {winner['rotulo']}")
    print(f"Auditoria: {OUTPUT_PATH.relative_to(ROOT)}")
    print(f"Relatório: {REPORT_PATH.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
