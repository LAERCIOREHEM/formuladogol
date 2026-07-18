#!/usr/bin/env python3
"""Gera as probabilidades do AF-Previsão para o Brasileirão 2026.

Execução 5 do projeto:
  * mantém a arquitetura Poisson log-linear MAP selecionada no backtesting;
  * aplica um ajuste conservador de forma recente por EWMA, sem sazonalidade artificial;
  * prevê placares e resultados das partidas restantes do Brasileirão;
  * simula Copa do Brasil, Libertadores e Sul-Americana;
  * aloca, em cada universo Monte Carlo, vagas e repasses regulamentares;
  * publica chances continentais consolidadas e decompostas por via exclusiva;
  * publica posição e pontos projetados em inteiros, preservando as médias brutas para auditoria;
  * registra ocorrências brutas, limites de resolução e histórico encadeado por rodada;
  * preserva a distribuição completa necessária à avaliação científica pós-campeonato.

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
from af_previsao_continental import (  # noqa: E402
    ContinentalDataNotReady,
    display_probability,
    integrate_continental_probabilities,
    load_snapshots as load_continental_snapshots,
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
    base_home_rate: float | None = None
    base_away_rate: float | None = None
    trend_home_pct: float = 0.0
    trend_away_pct: float = 0.0


@dataclass(frozen=True)
class RecentTrend:
    team: str
    matches_used: int
    attack_log_adjustment: float
    defence_log_adjustment: float
    attack_adjustment_pct: float
    defence_adjustment_pct: float
    strength_adjustment_pct: float
    label: str


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
        "execucao_2_5": config.get("execucao_2_5"),
        "execucao_4": config.get("execucao_4"),
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


def _bounded_log_multiplier(value: float, limit_pct: float) -> float:
    limit = max(0.0, min(95.0, float(limit_pct))) / 100.0
    return min(math.log1p(limit), max(math.log1p(-limit), float(value)))


def _ewma_recent(values: Sequence[float], alpha: float) -> float:
    if not values:
        return 0.0
    alpha = min(1.0, max(0.01, float(alpha)))
    weights = np.asarray([(1.0 - alpha) ** lag for lag in range(len(values) - 1, -1, -1)], dtype=np.float64)
    observations = np.asarray(values, dtype=np.float64)
    return float(np.dot(weights, observations) / max(EPS, float(weights.sum())))


def _round_half_up(value: float) -> int:
    return int(math.floor(float(value) + 0.5))


def calculate_recent_trends(
    current_matches: Sequence[Match],
    model: dict[str, Any],
    teams: Sequence[str],
    settings: dict[str, Any],
) -> dict[str, RecentTrend]:
    """Calcula um ajuste leve de forma recente, sem componente sazonal.

    Cada observação mede o resíduo do placar em relação à taxa esperada pelo
    modelo MAP. Ataque e defesa são suavizados separadamente por EWMA. A
    contribuição final é reduzida por confiabilidade, multiplicada por um peso
    pequeno e limitada para impedir que uma sequência curta domine a projeção.
    """
    window = max(1, int(settings.get("janela_jogos") or 12))
    alpha = float(settings.get("alpha") or 0.18)
    model_weight = max(0.0, min(1.0, float(settings.get("peso_no_modelo") or 0.08)))
    minimum_matches = max(1, int(settings.get("minimo_jogos_ativacao") or 6))
    full_confidence_matches = max(minimum_matches, int(settings.get("jogos_para_confianca_total") or window))
    pseudo = max(0.05, float(settings.get("pseudo_contagem_gols") or 0.75))
    residual_limit = max(0.05, float(settings.get("limite_residuo_log") or 0.8))
    component_limit_pct = max(0.0, float(settings.get("limite_ajuste_componente_pct") or 6.0))
    observations: dict[str, dict[str, list[float]]] = {team: {"attack": [], "defence": []} for team in teams}

    for match in sorted(current_matches, key=lambda item: (item.played_on, item.source_id)):
        home_rate, away_rate = map_rates(model, match.home, match.away)
        home_attack = math.log((match.home_goals + pseudo) / (home_rate + pseudo))
        away_attack = math.log((match.away_goals + pseudo) / (away_rate + pseudo))
        home_defence = math.log((away_rate + pseudo) / (match.away_goals + pseudo))
        away_defence = math.log((home_rate + pseudo) / (match.home_goals + pseudo))
        observations[match.home]["attack"].append(max(-residual_limit, min(residual_limit, home_attack)))
        observations[match.home]["defence"].append(max(-residual_limit, min(residual_limit, home_defence)))
        observations[match.away]["attack"].append(max(-residual_limit, min(residual_limit, away_attack)))
        observations[match.away]["defence"].append(max(-residual_limit, min(residual_limit, away_defence)))

    output: dict[str, RecentTrend] = {}
    for team in teams:
        attack_values = observations[team]["attack"][-window:]
        defence_values = observations[team]["defence"][-window:]
        used = min(len(attack_values), len(defence_values))
        if used < minimum_matches:
            attack_adjustment = defence_adjustment = 0.0
        else:
            reliability = min(1.0, used / float(full_confidence_matches))
            attack_adjustment = _ewma_recent(attack_values, alpha) * model_weight * reliability
            defence_adjustment = _ewma_recent(defence_values, alpha) * model_weight * reliability
            attack_adjustment = _bounded_log_multiplier(attack_adjustment, component_limit_pct)
            defence_adjustment = _bounded_log_multiplier(defence_adjustment, component_limit_pct)
        attack_pct = 100.0 * math.expm1(attack_adjustment)
        defence_pct = 100.0 * math.expm1(defence_adjustment)
        strength_pct = 100.0 * math.expm1((attack_adjustment + defence_adjustment) / 2.0)
        if strength_pct >= 1.5:
            label = "leve melhora"
        elif strength_pct <= -1.5:
            label = "leve queda"
        else:
            label = "estável"
        output[team] = RecentTrend(
            team=team,
            matches_used=used,
            attack_log_adjustment=attack_adjustment,
            defence_log_adjustment=defence_adjustment,
            attack_adjustment_pct=round(attack_pct, 4),
            defence_adjustment_pct=round(defence_pct, 4),
            strength_adjustment_pct=round(strength_pct, 4),
            label=label,
        )
    return output


def build_forecasts(
    fixtures: Sequence[Fixture],
    model: dict[str, Any],
    rho_production: float,
    recent_trends: dict[str, RecentTrend] | None = None,
    max_fixture_adjustment_pct: float = 10.0,
) -> list[MatchForecast]:
    forecasts: list[MatchForecast] = []
    trends = recent_trends or {}
    for fixture in fixtures:
        base_home_rate, base_away_rate = map_rates(model, fixture.home, fixture.away)
        home_trend = trends.get(fixture.home)
        away_trend = trends.get(fixture.away)
        home_log_adjustment = (home_trend.attack_log_adjustment if home_trend else 0.0) - (away_trend.defence_log_adjustment if away_trend else 0.0)
        away_log_adjustment = (away_trend.attack_log_adjustment if away_trend else 0.0) - (home_trend.defence_log_adjustment if home_trend else 0.0)
        home_log_adjustment = _bounded_log_multiplier(home_log_adjustment, max_fixture_adjustment_pct)
        away_log_adjustment = _bounded_log_multiplier(away_log_adjustment, max_fixture_adjustment_pct)
        home_rate = min(5.5, max(0.08, base_home_rate * math.exp(home_log_adjustment)))
        away_rate = min(5.0, max(0.06, base_away_rate * math.exp(away_log_adjustment)))
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
                base_home_rate=base_home_rate,
                base_away_rate=base_away_rate,
                trend_home_pct=round(100.0 * math.expm1(home_log_adjustment), 4),
                trend_away_pct=round(100.0 * math.expm1(away_log_adjustment), 4),
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
    return_samples: bool = False,
    display_threshold_pct: float = 0.1,
    position_interval_percentiles: tuple[int, int] = (10, 90),
) -> dict[str, Any]:
    if simulations < 10_000:
        raise ValueError("produção exige pelo menos 10.000 simulações")
    lower_position_pct, upper_position_pct = (int(position_interval_percentiles[0]), int(position_interval_percentiles[1]))
    if not 0 <= lower_position_pct < upper_position_pct <= 100:
        raise ValueError("percentis da faixa de posição precisam satisfazer 0 <= inferior < superior <= 100")
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
        criterion_masks = {
            "campeao": team_positions == 1,
            "g4": team_positions <= 4,
            "g6": team_positions <= 6,
            "libertadores_base": team_positions <= 5,
            "sul_americana_base": (team_positions >= 6) & (team_positions <= 11),
            "rebaixamento": team_positions >= 17,
        }
        criterion_counts = {key: int(np.sum(mask)) for key, mask in criterion_masks.items()}
        probabilities = {key: count / simulations for key, count in criterion_counts.items()}
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
        position_mean = float(np.mean(team_positions))
        points_mean = float(np.mean(points_team))
        position_lower = int(np.percentile(team_positions, lower_position_pct, method="nearest"))
        position_upper = int(np.percentile(team_positions, upper_position_pct, method="nearest"))
        team_results.append(
            {
                "clube": team,
                "posicao_atual": index + 1,
                "pontos_atuais": int(state.points[index]),
                "jogos_atuais": int(state.played[index]),
                "probabilidades_pct": {
                    key: round(value * 100.0, 6) for key, value in probabilities.items()
                },
                "probabilidades_detalhes": {
                    key: display_probability(count, simulations, display_threshold_pct)
                    for key, count in criterion_counts.items()
                },
                "posicao_projetada": _round_half_up(position_mean),
                "posicao_projetada_media": round(position_mean, 4),
                "posicao_projetada_mediana": int(np.median(team_positions)),
                "faixa_posicao_80": {
                    "melhor": min(position_lower, position_upper),
                    "pior": max(position_lower, position_upper),
                    "percentil_inferior": lower_position_pct,
                    "percentil_superior": upper_position_pct,
                },
                "pontos_projetados": {
                    "media": _round_half_up(points_mean),
                    "media_estimada": round(points_mean, 3),
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
    output: dict[str, Any] = {
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
    if return_samples:
        output["_league_order"] = order
    return output


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
                "tendencia_recente": {
                    "taxa_base_mandante": round(forecast.base_home_rate if forecast.base_home_rate is not None else forecast.home_rate, 4),
                    "taxa_base_visitante": round(forecast.base_away_rate if forecast.base_away_rate is not None else forecast.away_rate, 4),
                    "ajuste_taxa_mandante_pct": round(forecast.trend_home_pct, 4),
                    "ajuste_taxa_visitante_pct": round(forecast.trend_away_pct, 4),
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


def history_snapshot_hash(snapshot: dict[str, Any]) -> str:
    """Calcula o hash canônico do snapshot, incluindo o elo anterior."""
    payload = dict(snapshot)
    payload.pop("hash_snapshot", None)
    serialized = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(serialized).hexdigest()


def chain_history_snapshots(snapshots: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Recalcula uma cadeia SHA-256 determinística sobre os snapshots retidos."""
    chained: list[dict[str, Any]] = []
    previous_hash: str | None = None
    for original in snapshots:
        snapshot = json.loads(json.dumps(original, ensure_ascii=False))
        snapshot["hash_anterior"] = previous_hash
        snapshot.pop("hash_snapshot", None)
        snapshot["hash_snapshot"] = history_snapshot_hash(snapshot)
        previous_hash = snapshot["hash_snapshot"]
        chained.append(snapshot)
    return chained


def validate_history_chain(history: dict[str, Any]) -> None:
    snapshots = list(history.get("snapshots") or [])
    previous_hash: str | None = None
    seen_inputs: set[str] = set()
    for index, snapshot in enumerate(snapshots, start=1):
        input_hash = str(snapshot.get("hash_entrada") or "")
        if not input_hash or input_hash in seen_inputs:
            raise ValueError(f"histórico inválido no snapshot {index}: hash_entrada ausente ou duplicado")
        seen_inputs.add(input_hash)
        if snapshot.get("hash_anterior") != previous_hash:
            raise ValueError(f"histórico inválido no snapshot {index}: elo anterior divergente")
        computed = history_snapshot_hash(snapshot)
        if snapshot.get("hash_snapshot") != computed:
            raise ValueError(f"histórico inválido no snapshot {index}: hash do conteúdo divergente")
        clubs = list(snapshot.get("clubes") or [])
        if len(clubs) != 20 or len({str(item.get("clube") or "") for item in clubs}) != 20:
            raise ValueError(f"histórico inválido no snapshot {index}: clubes incompletos")
        previous_hash = computed
    integrity = history.get("integridade") or {}
    if integrity.get("quantidade_snapshots") != len(snapshots):
        raise ValueError("histórico inválido: quantidade declarada diverge da lista")
    if integrity.get("hash_final") != previous_hash:
        raise ValueError("histórico inválido: hash final diverge da cadeia")


def build_history_document(snapshots: Sequence[dict[str, Any]]) -> dict[str, Any]:
    chained = chain_history_snapshots(snapshots)
    history = {
        "schema_version": 3,
        "projeto": "AF-Previsão",
        "descricao": (
            "Histórico público e encadeado das probabilidades; um snapshot por alteração "
            "do estado esportivo, identificado por rodada e hash da entrada."
        ),
        "total_snapshots": len(chained),
        "integridade": {
            "algoritmo": "SHA-256",
            "regra": "cada hash inclui todo o snapshot e o hash do elo anterior",
            "quantidade_snapshots": len(chained),
            "hash_inicial": chained[0].get("hash_snapshot") if chained else None,
            "hash_final": chained[-1].get("hash_snapshot") if chained else None,
            "encadeamento_valido": True,
        },
        "snapshots": chained,
    }
    validate_history_chain(history)
    return history


def update_history(
    existing: dict[str, Any] | None,
    generated_at: str,
    input_hash: str,
    teams: Sequence[dict[str, Any]],
    model_version: str,
    round_reference: int,
    simulations: int,
    max_snapshots: int = 300,
) -> dict[str, Any]:
    if existing and int(existing.get("schema_version") or 0) >= 3:
        # Não recalcula silenciosamente uma cadeia já publicada: primeiro
        # verifica se o conteúdo ainda corresponde aos hashes registrados.
        validate_history_chain(existing)
    snapshots = list((existing or {}).get("snapshots") or [])
    if not snapshots or snapshots[-1].get("hash_entrada") != input_hash:
        snapshots.append(
            {
                "gerado_em": generated_at,
                "rodada_referencia": int(round_reference),
                "hash_entrada": input_hash,
                "versao_modelo": model_version,
                "metodologia": "AF-Previsão Integrada com tendência controlada",
                "simulacoes": int(simulations),
                "clubes": [
                    {
                        "clube": item["clube"],
                        "posicao_atual": item.get("posicao_atual"),
                        "pontos_atuais": item.get("pontos_atuais"),
                        "jogos_atuais": item.get("jogos_atuais"),
                        "posicao_projetada": item.get("posicao_projetada"),
                        "posicao_media_estimada": item.get("posicao_projetada_media"),
                        "posicao_mediana": item.get("posicao_projetada_mediana"),
                        "faixa_posicao_80": item.get("faixa_posicao_80"),
                        "distribuicao_posicoes_pct": item.get("distribuicao_posicoes_pct"),
                        "pontos_projetados": item["pontos_projetados"].get("media"),
                        "pontos_media_estimada": item["pontos_projetados"].get(
                            "media_estimada", item["pontos_projetados"].get("media")
                        ),
                        "pontos_percentis": {
                            "p10": item["pontos_projetados"].get("percentil_10"),
                            "p50": item["pontos_projetados"].get("percentil_50"),
                            "p90": item["pontos_projetados"].get("percentil_90"),
                        },
                        "campeao_pct": item["probabilidades_pct"]["campeao"],
                        "libertadores_pct": item["probabilidades_pct"].get("libertadores"),
                        "sul_americana_pct": item["probabilidades_pct"].get("sul_americana"),
                        "libertadores_base_pct": item["probabilidades_pct"]["libertadores_base"],
                        "sul_americana_base_pct": item["probabilidades_pct"]["sul_americana_base"],
                        "rebaixamento_pct": item["probabilidades_pct"]["rebaixamento"],
                        "exibicao": {
                            key: detail.get("exibicao")
                            for key, detail in (item.get("probabilidades_detalhes") or {}).items()
                        },
                        "ocorrencias": {
                            key: detail.get("ocorrencias")
                            for key, detail in (item.get("probabilidades_detalhes") or {}).items()
                        },
                        "decomposicao_chances": item.get("decomposicao_chances"),
                        "tendencia_recente": item.get("tendencia_recente"),
                        # Compatibilidade com snapshots das versões anteriores.
                        "pontos_medios": item["pontos_projetados"].get(
                            "media_estimada", item["pontos_projetados"].get("media")
                        ),
                    }
                    for item in teams
                ],
            }
        )
    snapshots = snapshots[-max(1, int(max_snapshots)) :]
    return build_history_document(snapshots)

def continental_snapshots_state_hash(snapshots: dict[str, dict[str, Any]]) -> str:
    """Hash apenas do estado esportivo, sem timestamps de coleta/cache."""
    stable: dict[str, Any] = {}
    for key, snapshot in sorted(snapshots.items()):
        stable[key] = {
            "status": snapshot.get("status"),
            "temporada": snapshot.get("temporada"),
            "competicao": snapshot.get("competicao"),
            "fase_atual": snapshot.get("fase_atual"),
            "eventos": snapshot.get("eventos") or [],
        }
    return canonical_hash_payload(stable)


def validate_probabilities(teams: Sequence[dict[str, Any]]) -> None:
    if len(teams) != 20 or len({item["clube"] for item in teams}) != 20:
        raise ValueError("resultado probabilístico precisa conter 20 clubes únicos")
    expected_sums = {
        "campeao": 100.0,
        "g4": 400.0,
        "g6": 600.0,
        "libertadores_base": 500.0,
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
    execution_4 = config.get("execucao_4") or {}
    trend_settings = execution_4.get("tendencia_recente") or {}
    recent_trends = calculate_recent_trends(current, model, state.teams, trend_settings)
    forecasts = build_forecasts(
        fixtures,
        model,
        rho_production,
        recent_trends=recent_trends,
        max_fixture_adjustment_pct=float(trend_settings.get("limite_ajuste_taxa_partida_pct") or 10.0),
    )
    execution_25 = config.get("execucao_2_5") or {}
    display_threshold = float(execution_25.get("limiar_exibicao_percentual", 0.1))
    projection_settings = execution_4.get("projecoes_exibicao") or {}
    raw_position_percentiles = projection_settings.get("faixa_posicao_percentis") or [10, 90]
    position_percentiles = (int(raw_position_percentiles[0]), int(raw_position_percentiles[1]))
    simulation = run_monte_carlo(
        state,
        forecasts,
        simulations_final,
        seed,
        rho_production,
        return_samples=True,
        display_threshold_pct=display_threshold,
        position_interval_percentiles=position_percentiles,
    )
    league_order = simulation.pop("_league_order")
    try:
        continental_snapshots = load_continental_snapshots()
        continental = integrate_continental_probabilities(
            continental_snapshots,
            model,
            league_order,
            state.teams,
            simulations_final,
            seed,
            execution_25,
        )
    except ContinentalDataNotReady as exc:
        raise CurrentDataNotSynchronized(f"AF-Previsão Continental aguardando dados: {exc}") from exc
    max_half_delta = float(simulation["convergencia"]["maior_diferenca_entre_metades_pontos_percentuais"])
    if max_half_delta > 1.0:
        raise ValueError(
            f"Monte Carlo sem convergência suficiente: diferença entre metades de {max_half_delta:.4f} p.p."
        )
    teams = simulation["clubes"]
    validate_probabilities(teams)
    continental_by_team = continental["clubes"]
    for item in teams:
        trend = recent_trends[item["clube"]]
        item["tendencia_recente"] = {
            "metodo": "EWMA sem sazonalidade",
            "jogos_considerados": trend.matches_used,
            "ajuste_ataque_pct": trend.attack_adjustment_pct,
            "ajuste_defesa_pct": trend.defence_adjustment_pct,
            "ajuste_forca_pct": trend.strength_adjustment_pct,
            "classificacao": trend.label,
            "peso_no_modelo": float(trend_settings.get("peso_no_modelo") or 0.08),
        }
        integrated = continental_by_team[item["clube"]]
        item["probabilidades_pct"]["libertadores"] = integrated["libertadores"]["total"]["percentual_estimado"]
        item["probabilidades_pct"]["sul_americana"] = integrated["sul_americana"]["total"]["percentual_estimado"]
        item["probabilidades_detalhes"]["libertadores"] = integrated["libertadores"]["total"]
        item["probabilidades_detalhes"]["sul_americana"] = integrated["sul_americana"]["total"]
        item["decomposicao_chances"] = {
            "libertadores": integrated["libertadores"],
            "sul_americana": integrated["sul_americana"],
        }
    total_sul_integrada = sum(item["probabilidades_pct"]["sul_americana"] for item in teams)
    if abs(total_sul_integrada - 600.0) > 0.02:
        raise ValueError(f"soma integrada da Sul-Americana inválida: {total_sul_integrada:.6f}")
    for item in teams:
        for field in ("libertadores", "sul_americana"):
            value = float(item["probabilidades_pct"][field])
            if not math.isfinite(value) or not 0.0 <= value <= 100.0:
                raise ValueError(f"probabilidade integrada inválida para {item['clube']}: {field}")

    input_hash = build_model_state_hash(config, audit_models, state, current, fixtures)
    continental_hash = continental_snapshots_state_hash(continental_snapshots)
    input_hash = canonical_hash_payload({"brasileirao": input_hash, "competicoes": continental_hash})
    generated_at = reference.replace(microsecond=0).isoformat()
    model_version = str(config.get("versao_modelo") or "AF-Previsão 1.0")
    methodology = {
        "arquitetura": "Poisson log-linear ajustado por MAP com priors gaussianos e partial pooling",
        "modelo_de_gols": "Poisson duplo com parâmetros de ataque, defesa e vantagem de mando",
        "regularizacao": "aproximação bayesiana MAP; clubes com menos evidência regridem à média",
        "tendencia_recente": {
            "metodo": "EWMA de resíduos de gols sem componente sazonal",
            "janela_jogos": int(trend_settings.get("janela_jogos") or 12),
            "peso_no_modelo": float(trend_settings.get("peso_no_modelo") or 0.08),
            "limite_ajuste_taxa_partida_pct": float(trend_settings.get("limite_ajuste_taxa_partida_pct") or 10.0),
            "regra": "ajuste marginal e limitado; não substitui a força acumulada nem a simulação da tabela restante",
        },
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
            "libertadores_base": "1º ao 5º (quatro vagas diretas e uma preliminar)",
            "sul_americana_base": "6º ao 11º antes dos repasses",
            "libertadores": "chance consolidada por Brasileirão, Copa do Brasil, Libertadores, Sul-Americana e repasses",
            "sul_americana": "seis vagas alocadas após a definição de todos os classificados à Libertadores",
            "rebaixamento": "17º ao 20º",
            "posicao_projetada": "média das posições simuladas arredondada para o inteiro mais próximo",
            "faixa_posicao_80": "intervalo entre os percentis 10 e 90 das posições simuladas",
        },
        "projecoes_exibicao": "pontos e posição aparecem como inteiros; médias sem arredondamento permanecem no JSON para auditoria",
        "af_score": "auditado como diagnóstico, não aplicado sem backtesting histórico homogêneo",
    }
    probabilities = {
        "schema_version": 2,
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
            "maior_chance_libertadores": highlight(teams, "libertadores"),
            "maior_chance_sul_americana": highlight(teams, "sul_americana"),
            "maior_risco_rebaixamento": highlight(teams, "rebaixamento"),
        },
        "clubes": teams,
        "integracao_continental": {
            "status": "ok",
            "competicoes": ["Copa do Brasil", "CONMEBOL Libertadores", "CONMEBOL Sudamericana"],
            "decomposicao_exclusiva_por_via": True,
            "limiar_exibicao_percentual": float(execution_25.get("limiar_exibicao_percentual", 0.1)),
            "hash_snapshots": continental_hash,
        },
        "total_previsoes_partidas": len(forecasts),
        "partidas_restantes": serialize_match_forecasts(forecasts),
        "avisos": [
            "Probabilidades não são certezas e mudam quando novos jogos são concluídos.",
            "Libertadores e Sul-Americana são probabilidades consolidadas e incluem os caminhos por copas e repasses regulamentares.",
            "Valores exibidos como <0,1% não significam impossibilidade matemática; indicam evento abaixo da resolução visual escolhida.",
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
                "tendencia_recente": {
                    "jogos_considerados": recent_trends[team].matches_used,
                    "ajuste_ataque_pct": recent_trends[team].attack_adjustment_pct,
                    "ajuste_defesa_pct": recent_trends[team].defence_adjustment_pct,
                    "ajuste_forca_pct": recent_trends[team].strength_adjustment_pct,
                    "classificacao": recent_trends[team].label,
                },
            }
        )
    dc_audit = dixon_coles_sensitivity(forecasts, rho_sensitivity)
    af_audit = af_score_diagnostic(model, state)
    audit = {
        "schema_version": 2,
        "projeto": "AF-Previsão",
        "versao_modelo": model_version,
        "etapa": "Execução 5 — histórico encadeado e avaliação científica preparada",
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
        "tendencia_recente": {
            "configuracao": trend_settings,
            "maior_ajuste_absoluto_forca_pct": round(max((abs(item.strength_adjustment_pct) for item in recent_trends.values()), default=0.0), 4),
            "maior_ajuste_absoluto_taxa_partida_pct": round(max((max(abs(forecast.trend_home_pct), abs(forecast.trend_away_pct)) for forecast in forecasts), default=0.0), 4),
            "observacao": "Ajuste complementar sem sazonalidade, limitado e separado entre ataque e defesa.",
        },
        "sensibilidade_dixon_coles": dc_audit,
        "diagnostico_af_score": af_audit,
        "integracao_continental": continental["auditoria"],
        "validacoes": {
            "clubes": len(teams),
            "soma_campeao_pct": round(sum(item["probabilidades_pct"]["campeao"] for item in teams), 6),
            "soma_g4_pct": round(sum(item["probabilidades_pct"]["g4"] for item in teams), 6),
            "soma_g6_pct": round(sum(item["probabilidades_pct"]["g6"] for item in teams), 6),
            "soma_libertadores_consolidada_pct": round(
                sum(item["probabilidades_pct"]["libertadores"] for item in teams), 6
            ),
            "soma_sul_americana_base_pct": round(
                sum(item["probabilidades_pct"]["sul_americana_base"] for item in teams), 6
            ),
            "soma_sul_americana_consolidada_pct": round(
                sum(item["probabilidades_pct"]["sul_americana"] for item in teams), 6
            ),
            "soma_rebaixamento_pct": round(
                sum(item["probabilidades_pct"]["rebaixamento"] for item in teams), 6
            ),
            "todas_distribuicoes_posicao_somam_100": True,
            "sem_nan_ou_infinity": True,
        },
        "limites_conhecidos": [
            "O ajuste é MAP regularizado, não amostragem MCMC da posterior completa.",
            "A incerteza publicada vem dos resultados futuros simulados; a versão atual não amostra incerteza dos parâmetros.",
            "A tendência recente usa placares, não xG, e por isso recebe peso pequeno e limites rígidos para reduzir o efeito de jogos atípicos.",
            "Clubes brasileiros fora da Série A 2026 continuam elegíveis por Copa do Brasil ou títulos continentais; estrangeiros não alteram a alocação brasileira.",
            "O pareamento de fases futuras é inferido da chave ESPN; na Copa do Brasil, sorteios ainda não realizados são simulados.",
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
        round_reference=max((match.round_no for match in current), default=0),
        simulations=simulations_final,
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
    trend_model = {
        "mu": math.log(1.10),
        "home_adv": math.log(1.20),
        "attack": {team: 0.0 for team in teams},
        "defence": {team: 0.0 for team in teams},
    }
    trend_settings = {
        "janela_jogos": 12,
        "alpha": 0.18,
        "peso_no_modelo": 0.08,
        "minimo_jogos_ativacao": 6,
        "jogos_para_confianca_total": 12,
        "pseudo_contagem_gols": 0.75,
        "limite_residuo_log": 0.8,
        "limite_ajuste_componente_pct": 6.0,
    }
    trend_matches = [
        Match(2026, 9000 + index, index + 1, date(2026, 1, 1) + timedelta(days=index), teams[0], teams[1], 4, 0)
        for index in range(12)
    ]
    recent = calculate_recent_trends(trend_matches, trend_model, teams, trend_settings)
    if recent[teams[0]].strength_adjustment_pct <= 0:
        raise AssertionError("EWMA não reconheceu melhora ofensiva/defensiva sintética")
    if abs(recent[teams[0]].attack_adjustment_pct) > 6.0001 or abs(recent[teams[0]].defence_adjustment_pct) > 6.0001:
        raise AssertionError("ajuste recente ultrapassou a trava por componente")
    short_recent = calculate_recent_trends(trend_matches[:5], trend_model, teams, trend_settings)
    if short_recent[teams[0]].strength_adjustment_pct != 0.0:
        raise AssertionError("tendência não deveria ativar antes do mínimo de jogos")
    adjusted_forecast = build_forecasts(
        [Fixture("trend", 13, teams[0], teams[1], None, "")],
        trend_model,
        0.0,
        recent_trends=recent,
        max_fixture_adjustment_pct=10.0,
    )[0]
    if abs(adjusted_forecast.trend_home_pct) > 10.0001 or abs(adjusted_forecast.trend_away_pct) > 10.0001:
        raise AssertionError("ajuste recente ultrapassou a trava da taxa da partida")

    result_a = run_monte_carlo(state, forecasts, 10_000, 12345, 0.0)
    result_b = run_monte_carlo(state, forecasts, 10_000, 12345, 0.0)
    if json.dumps(result_a, sort_keys=True) != json.dumps(result_b, sort_keys=True):
        raise AssertionError("Monte Carlo não é reproduzível com a mesma semente")
    validate_probabilities(result_a["clubes"])
    if result_a["simulacoes"] != 10_000:
        raise AssertionError("quantidade de simulações incorreta")
    for team_row in result_a["clubes"]:
        if not isinstance(team_row.get("posicao_projetada"), int):
            raise AssertionError("posição projetada precisa ser inteira na publicação")
        if not isinstance((team_row.get("pontos_projetados") or {}).get("media"), int):
            raise AssertionError("pontos projetados precisam ser inteiros na publicação")
        if not isinstance((team_row.get("pontos_projetados") or {}).get("media_estimada"), float):
            raise AssertionError("média bruta de pontos precisa permanecer auditável")
        interval = team_row.get("faixa_posicao_80") or {}
        if not 1 <= int(interval.get("melhor") or 0) <= int(interval.get("pior") or 0) <= 20:
            raise AssertionError("faixa de posição de 80% inválida")
    synthetic_history = update_history(
        None, "2026-07-18T08:00:00-03:00", "hash-teste", result_a["clubes"],
        "AF-Previsão teste", round_reference=19, simulations=10_000, max_snapshots=10,
    )
    repeated_history = update_history(
        synthetic_history, "2026-07-18T09:00:00-03:00", "hash-teste", result_a["clubes"],
        "AF-Previsão teste", round_reference=19, simulations=10_000, max_snapshots=10,
    )
    if synthetic_history["total_snapshots"] != 1 or repeated_history["total_snapshots"] != 1:
        raise AssertionError("histórico criou snapshot artificial sem mudança esportiva")
    saved = synthetic_history["snapshots"][0]
    if saved.get("rodada_referencia") != 19 or saved["clubes"][0].get("posicao_projetada") is None:
        raise AssertionError("histórico não guardou rodada e projeção final")
    if len(saved["clubes"][0].get("distribuicao_posicoes_pct") or []) != 20:
        raise AssertionError("histórico não guardou a distribuição completa das posições")
    validate_history_chain(synthetic_history)
    tampered_history = json.loads(json.dumps(synthetic_history))
    tampered_history["snapshots"][0]["clubes"][0]["campeao_pct"] = 99.0
    try:
        update_history(
            tampered_history, "2026-07-18T10:00:00-03:00", "hash-teste-2", result_a["clubes"],
            "AF-Previsão teste", round_reference=20, simulations=10_000, max_snapshots=10,
        )
    except ValueError:
        pass
    else:
        raise AssertionError("alteração retroativa em cadeia publicada não foi bloqueada")
    snapshot_a = {
        "copa_do_brasil": {"status": "ok", "temporada": 2026, "competicao": {"chave": "copa_do_brasil"}, "fase_atual": {}, "eventos": [], "gerado_em": "2026-07-18T00:00:00-03:00"}
    }
    snapshot_b = json.loads(json.dumps(snapshot_a))
    snapshot_b["copa_do_brasil"]["gerado_em"] = "2026-07-18T01:00:00-03:00"
    if continental_snapshots_state_hash(snapshot_a) != continental_snapshots_state_hash(snapshot_b):
        raise AssertionError("timestamp de coleta não pode criar snapshot histórico artificial")
    snapshot_b["copa_do_brasil"]["eventos"] = [{"event_id": "novo"}]
    if continental_snapshots_state_hash(snapshot_a) == continental_snapshots_state_hash(snapshot_b):
        raise AssertionError("mudança esportiva precisa alterar o hash continental")
    print("Self-test AF-Previsão Execução 5: OK")


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
        # A Execução 5 pode migrar o histórico legado para a cadeia SHA-256
        # sem criar snapshot novo nem alterar as probabilidades preservadas.
        if int(previous_history.get("schema_version") or 0) >= 3:
            validate_history_chain(previous_history)
        upgraded_history = build_history_document(list(previous_history.get("snapshots") or []))
        write_json(HISTORY_PATH, upgraded_history)
        print(
            "::warning title=AF-Previsão aguardando sincronização da ESPN::"
            f"{exc}. Probabilidades e auditoria anteriores foram preservadas; "
            "o histórico foi apenas encadeado, sem criar novo estado esportivo."
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
