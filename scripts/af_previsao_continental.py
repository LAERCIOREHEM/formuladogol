#!/usr/bin/env python3
"""Motor continental integrado do AF-Previsão — Execução 2.5.

O módulo simula Copa do Brasil, Libertadores e Sul-Americana e aplica, em cada
universo Monte Carlo, as regras de distribuição e repasse de vagas. A saída é
uma chance única de Libertadores/Sul-Americana para cada clube, acompanhada de
uma decomposição exclusiva por via de classificação.

Este arquivo é importado por gerar_probabilidades_brasileirao.py e também pode
ser testado isoladamente com --self-test.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Mapping, Sequence
from zoneinfo import ZoneInfo

try:
    import numpy as np
except ImportError as exc:  # pragma: no cover
    raise SystemExit("AF-Previsão Continental requer numpy") from exc

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from af_previsao_backtest import MapConfig, Match, fit_poisson_map  # noqa: E402

BRT = ZoneInfo("America/Sao_Paulo")
SNAPSHOT_DIR = ROOT / "dados-br" / "competicoes-af-previsao"
SNAPSHOT_FILES = {
    "copa_do_brasil": SNAPSHOT_DIR / "copa-do-brasil.json",
    "libertadores": SNAPSHOT_DIR / "libertadores.json",
    "sul_americana": SNAPSHOT_DIR / "sul-americana.json",
}
EPS = 1e-12


class ContinentalDataNotReady(ValueError):
    """Snapshot continental ausente, antigo demais ou sem mata-mata identificável."""


@dataclass(frozen=True)
class CupTeam:
    name: str
    espn_id: str
    serie_a: bool
    country: str | None


@dataclass(frozen=True)
class CupEvent:
    event_id: str
    played_at: datetime
    stage: str
    stage_rank: int
    completed: bool
    home: CupTeam
    away: CupTeam
    home_goals: int | None
    away_goals: int | None
    winner: str | None
    penalties: bool


@dataclass(frozen=True)
class Tie:
    key: str
    team_a: str
    team_b: str
    events: tuple[CupEvent, ...]
    order_key: tuple[str, str]


@dataclass
class CupSimulation:
    competition: str
    team_names: tuple[str, ...]
    brazilian_team_names: frozenset[str]
    eligible_team_names: frozenset[str]
    champion_ids: np.ndarray
    runner_up_ids: np.ndarray
    audit: dict[str, Any]

    def champion_names(self) -> np.ndarray:
        names = np.asarray(self.team_names, dtype=object)
        return names[self.champion_ids]

    def runner_up_names(self) -> np.ndarray:
        names = np.asarray(self.team_names, dtype=object)
        return names[self.runner_up_ids]


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: raiz JSON precisa ser objeto")
    return data


def normalize_text(value: Any) -> str:
    text = unicodedata.normalize("NFD", str(value or ""))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = re.sub(r"[^a-zA-Z0-9]+", " ", text).lower()
    return re.sub(r"\s+", " ", text).strip()


def parse_datetime(value: Any) -> datetime:
    text = str(value or "").strip()
    if not text:
        return datetime(2026, 1, 1, tzinfo=BRT)
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=BRT)
    return parsed.astimezone(BRT)


def parse_team(payload: Mapping[str, Any]) -> CupTeam:
    return CupTeam(
        name=str(payload.get("nome") or payload.get("nome_espn") or "Equipe não identificada"),
        espn_id=str(payload.get("espn_id") or ""),
        serie_a=bool(payload.get("serie_a_2026")),
        country=str(payload.get("pais") or "").upper() or None,
    )


def parse_snapshot(snapshot: Mapping[str, Any]) -> tuple[str, list[CupEvent], dict[str, Any]]:
    competition = str((snapshot.get("competicao") or {}).get("chave") or "")
    if competition not in SNAPSHOT_FILES:
        raise ContinentalDataNotReady("snapshot sem chave de competição válida")
    if snapshot.get("status") != "ok":
        raise ContinentalDataNotReady(f"{competition}: snapshot não está com status ok")
    events: list[CupEvent] = []
    for item in snapshot.get("eventos") or []:
        home_payload = item.get("mandante") or {}
        away_payload = item.get("visitante") or {}
        events.append(
            CupEvent(
                event_id=str(item.get("event_id") or ""),
                played_at=parse_datetime(item.get("data_iso")),
                stage=str(item.get("fase") or "Fase não identificada"),
                stage_rank=int(item.get("fase_ordem") or 0),
                completed=bool(item.get("concluido")),
                home=parse_team(home_payload),
                away=parse_team(away_payload),
                home_goals=(None if home_payload.get("placar") is None else int(home_payload["placar"])),
                away_goals=(None if away_payload.get("placar") is None else int(away_payload["placar"])),
                winner=(str(item.get("vencedor")) if item.get("vencedor") else None),
                penalties=bool(item.get("penaltis")),
            )
        )
    if not events:
        raise ContinentalDataNotReady(f"{competition}: snapshot sem eventos")
    return competition, events, dict(snapshot.get("competicao") or {})


def competition_matches(events: Sequence[CupEvent], season: int = 2026) -> list[Match]:
    matches: list[Match] = []
    for index, event in enumerate(events, start=1):
        if not event.completed or event.home_goals is None or event.away_goals is None:
            continue
        source_id = int(event.event_id) if event.event_id.isdigit() else index
        matches.append(
            Match(
                season=season,
                source_id=source_id,
                round_no=event.stage_rank,
                played_on=event.played_at.date(),
                home=event.home.name,
                away=event.away.name,
                home_goals=event.home_goals,
                away_goals=event.away_goals,
            )
        )
    return matches


def fit_cup_model(
    events: Sequence[CupEvent],
    league_model: Mapping[str, Any],
    serie_a_names: set[str],
    prior_sd: float,
    half_life_days: float,
    league_weight: float,
) -> dict[str, Any]:
    matches = competition_matches(events)
    # Datas futuras do chaveamento não podem envelhecer artificialmente os
    # jogos usados no ajuste. A referência temporal usa somente partidas já
    # concluídas, como no modelo principal do Brasileirão.
    as_of = max(
        (event.played_at.date() for event in events if event.completed),
        default=date(2026, 1, 1),
    ) + timedelta(days=1)
    cup = fit_poisson_map(matches, as_of, MapConfig(prior_sd=prior_sd, half_life_days=half_life_days))
    teams = sorted({event.home.name for event in events} | {event.away.name for event in events})
    attack: dict[str, float] = {}
    defence: dict[str, float] = {}
    for team in teams:
        cup_attack = float((cup.get("attack") or {}).get(team, 0.0))
        cup_defence = float((cup.get("defence") or {}).get(team, 0.0))
        if team in serie_a_names:
            league_attack = float((league_model.get("attack") or {}).get(team, 0.0))
            league_defence = float((league_model.get("defence") or {}).get(team, 0.0))
            attack[team] = league_weight * league_attack + (1.0 - league_weight) * cup_attack
            defence[team] = league_weight * league_defence + (1.0 - league_weight) * cup_defence
        else:
            attack[team] = cup_attack
            defence[team] = cup_defence
    return {
        "mu": float(cup.get("mu", math.log(1.1))),
        "home_adv": float(cup.get("home_adv", math.log(1.18))),
        "attack": attack,
        "defence": defence,
        "matches": len(matches),
        "as_of": as_of.isoformat(),
    }


def model_rates(model: Mapping[str, Any], home: str, away: str, neutral: bool = False) -> tuple[float, float]:
    mu = float(model.get("mu", math.log(1.1)))
    home_adv = 0.0 if neutral else float(model.get("home_adv", 0.0))
    attack = model.get("attack") or {}
    defence = model.get("defence") or {}
    home_log = mu + home_adv + float(attack.get(home, 0.0)) - float(defence.get(away, 0.0))
    away_log = mu + float(attack.get(away, 0.0)) - float(defence.get(home, 0.0))
    return (
        min(5.5, max(0.08, math.exp(home_log))),
        min(5.0, max(0.06, math.exp(away_log))),
    )


def stage_is_group(stage: str) -> bool:
    text = normalize_text(stage)
    return "grupo" in text or "group" in text


def stage_is_final(stage: str, rank: int) -> bool:
    text = normalize_text(stage)
    explicit = {"final", "finalissima", "decisao", "decision", "grand final"}
    return rank >= 900 or text in explicit or text.startswith("final ")


def knockout_stage_from_team_count(team_count: int) -> tuple[int, str] | None:
    stages = {
        2: (900, "Final"),
        4: (800, "Semifinal"),
        8: (700, "Quartas de final"),
        16: (600, "Oitavas de final"),
        32: (500, "Fase de 32"),
        64: (400, "Fase de 64"),
    }
    return stages.get(team_count)


def event_pair_key(event: CupEvent) -> tuple[str, str]:
    return tuple(sorted((normalize_text(event.home.name), normalize_text(event.away.name))))


def stage_group_is_consistent(stage_events: Sequence[CupEvent]) -> bool:
    ties = build_ties(stage_events)
    participants = {tie.team_a for tie in ties} | {tie.team_b for tie in ties}
    return bool(ties) and len(participants) == 2 * len(ties) and is_power_of_two(len(participants))


def current_stage(events: Sequence[CupEvent]) -> tuple[int, str, list[CupEvent]]:
    pending = [event for event in events if not event.completed]
    if not pending:
        highest = max(event.stage_rank for event in events)
        stage_events = [event for event in events if event.stage_rank == highest]
        return highest, stage_events[0].stage, stage_events

    rank = min(event.stage_rank for event in pending)
    stage_events = [event for event in events if event.stage_rank == rank]
    if stage_group_is_consistent(stage_events):
        stage = sorted({event.stage for event in stage_events})[0]
        return rank, stage, stage_events

    # A ESPN às vezes substitui o nome da fase por textos operacionais como
    # “Ida”, “Volta” ou “avança nos pênaltis”. Nesses casos todos os eventos
    # podem chegar com fase_ordem=100, misturando o torneio inteiro. Reconstrói
    # a fase corrente pelos confrontos que ainda possuem partida pendente e
    # inclui as duas pernas de cada chave.
    pending_pairs = {event_pair_key(event) for event in pending}
    paired_events: list[CupEvent] = []
    for pair in pending_pairs:
        pair_pending = sorted(
            (event for event in pending if event_pair_key(event) == pair),
            key=lambda item: (item.played_at, item.event_id),
        )
        paired_events.extend(pair_pending)
        # Quando só a volta está pendente, inclui a ida concluída mais recente.
        # Se as duas pernas futuras já vieram da ESPN, não mistura confrontos
        # antigos entre os mesmos clubes (por exemplo, jogos da fase de grupos).
        if len(pair_pending) == 1:
            before = sorted(
                (
                    event for event in events
                    if event.completed
                    and event_pair_key(event) == pair
                    and event.played_at < pair_pending[0].played_at
                    and (pair_pending[0].played_at - event.played_at).days <= 35
                ),
                key=lambda item: (item.played_at, item.event_id),
            )
            if before:
                paired_events.append(before[-1])
    paired_events.sort(key=lambda item: (item.played_at, item.event_id))
    participants = {event.home.name for event in paired_events} | {event.away.name for event in paired_events}
    inferred = knockout_stage_from_team_count(len(participants))
    if inferred and len(participants) == 2 * len(pending_pairs):
        inferred_rank, inferred_stage = inferred
        return inferred_rank, inferred_stage, paired_events

    stage = sorted({event.stage for event in stage_events})[0]
    return rank, stage, stage_events


def build_ties(events: Sequence[CupEvent]) -> list[Tie]:
    grouped: dict[tuple[str, str], list[CupEvent]] = {}
    first_key: dict[tuple[str, str], tuple[str, str]] = {}
    for event in sorted(events, key=lambda item: (item.played_at, item.event_id)):
        pair = tuple(sorted((event.home.name, event.away.name), key=normalize_text))
        grouped.setdefault(pair, []).append(event)
        first_key.setdefault(pair, (event.played_at.isoformat(), event.event_id))
    ties = [
        Tie(
            key=f"{normalize_text(pair[0])}::{normalize_text(pair[1])}",
            team_a=pair[0],
            team_b=pair[1],
            events=tuple(items),
            order_key=first_key[pair],
        )
        for pair, items in grouped.items()
    ]
    ties.sort(key=lambda tie: tie.order_key)
    return ties


def is_power_of_two(value: int) -> bool:
    return value > 0 and value & (value - 1) == 0


def team_power(model: Mapping[str, Any], team: str) -> float:
    return float((model.get("attack") or {}).get(team, 0.0)) + float((model.get("defence") or {}).get(team, 0.0))


def penalties_winner(
    rng: np.random.Generator,
    team_a_ids: np.ndarray,
    team_b_ids: np.ndarray,
    powers: np.ndarray,
) -> np.ndarray:
    delta = np.clip(powers[team_a_ids] - powers[team_b_ids], -2.0, 2.0)
    probability_a = 1.0 / (1.0 + np.exp(-0.55 * delta))
    return np.where(rng.random(team_a_ids.shape) < probability_a, team_a_ids, team_b_ids)


def simulate_current_tie(
    tie: Tie,
    team_index: Mapping[str, int],
    model: Mapping[str, Any],
    rates_home: np.ndarray,
    rates_away: np.ndarray,
    powers: np.ndarray,
    simulations: int,
    rng: np.random.Generator,
) -> np.ndarray:
    a_id = team_index[tie.team_a]
    b_id = team_index[tie.team_b]
    aggregate_a = np.zeros(simulations, dtype=np.int16)
    aggregate_b = np.zeros(simulations, dtype=np.int16)
    fixed_winner: str | None = None
    for event in tie.events:
        home_is_a = event.home.name == tie.team_a
        if event.completed:
            if event.home_goals is None or event.away_goals is None:
                raise ContinentalDataNotReady(f"{tie.key}: partida concluída sem placar")
            if home_is_a:
                aggregate_a += event.home_goals
                aggregate_b += event.away_goals
            else:
                aggregate_a += event.away_goals
                aggregate_b += event.home_goals
            if event.penalties and event.winner:
                fixed_winner = event.winner
            continue
        home_id = a_id if home_is_a else b_id
        away_id = b_id if home_is_a else a_id
        home_goals = rng.poisson(rates_home[home_id, away_id], simulations).astype(np.int16)
        away_goals = rng.poisson(rates_away[home_id, away_id], simulations).astype(np.int16)
        if home_is_a:
            aggregate_a += home_goals
            aggregate_b += away_goals
        else:
            aggregate_a += away_goals
            aggregate_b += home_goals

    winners = np.where(aggregate_a > aggregate_b, a_id, b_id).astype(np.int16)
    tied = aggregate_a == aggregate_b
    if np.any(tied):
        a_ids = np.full(int(tied.sum()), a_id, dtype=np.int16)
        b_ids = np.full(int(tied.sum()), b_id, dtype=np.int16)
        all_completed = all(event.completed for event in tie.events)
        if all_completed:
            if fixed_winner not in {tie.team_a, tie.team_b}:
                raise ContinentalDataNotReady(
                    f"{tie.key}: confronto concluído e empatado no agregado sem vencedor dos pênaltis"
                )
            winners[tied] = a_id if fixed_winner == tie.team_a else b_id
        else:
            winners[tied] = penalties_winner(rng, a_ids, b_ids, powers)
    return winners


def rates_matrices(model: Mapping[str, Any], teams: Sequence[str], neutral: bool = False) -> tuple[np.ndarray, np.ndarray]:
    size = len(teams)
    home = np.zeros((size, size), dtype=np.float64)
    away = np.zeros((size, size), dtype=np.float64)
    for i, first in enumerate(teams):
        for j, second in enumerate(teams):
            if i == j:
                continue
            home[i, j], away[i, j] = model_rates(model, first, second, neutral=neutral)
    return home, away


def random_pairings(participants: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    random_keys = rng.random(participants.shape)
    permutation = np.argsort(random_keys, axis=1)
    return np.take_along_axis(participants, permutation, axis=1)


def simulate_round(
    participants: np.ndarray,
    rates_home: np.ndarray,
    rates_away: np.ndarray,
    rates_neutral_home: np.ndarray,
    rates_neutral_away: np.ndarray,
    powers: np.ndarray,
    rng: np.random.Generator,
    pairing_mode: str,
    single_match: bool,
) -> tuple[np.ndarray, np.ndarray]:
    simulations, count = participants.shape
    if count < 2 or count % 2:
        raise ContinentalDataNotReady(f"fase com quantidade inválida de equipes: {count}")
    arranged = random_pairings(participants, rng) if pairing_mode == "sorteio" else participants
    first = arranged[:, 0::2]
    second = arranged[:, 1::2]
    if single_match:
        lambda_first = rates_neutral_home[first, second]
        lambda_second = rates_neutral_away[first, second]
        goals_first = rng.poisson(lambda_first).astype(np.int16)
        goals_second = rng.poisson(lambda_second).astype(np.int16)
    else:
        first_leg_a = rng.poisson(rates_home[first, second]).astype(np.int16)
        first_leg_b = rng.poisson(rates_away[first, second]).astype(np.int16)
        second_leg_b = rng.poisson(rates_home[second, first]).astype(np.int16)
        second_leg_a = rng.poisson(rates_away[second, first]).astype(np.int16)
        goals_first = first_leg_a + second_leg_a
        goals_second = first_leg_b + second_leg_b
    winners = np.where(goals_first > goals_second, first, second).astype(np.int16)
    losers = np.where(goals_first > goals_second, second, first).astype(np.int16)
    tied = goals_first == goals_second
    if np.any(tied):
        tied_first = first[tied]
        tied_second = second[tied]
        penalty_winners = penalties_winner(rng, tied_first, tied_second, powers)
        winners[tied] = penalty_winners
        losers[tied] = np.where(penalty_winners == tied_first, tied_second, tied_first)
    return winners, losers


def completed_champion(events: Sequence[CupEvent]) -> tuple[str, str | None] | None:
    finals = [event for event in events if event.completed and stage_is_final(event.stage, event.stage_rank)]
    if not finals:
        return None
    event = sorted(finals, key=lambda item: (item.played_at, item.event_id))[-1]
    winner = event.winner
    if not winner and event.home_goals is not None and event.away_goals is not None:
        if event.home_goals > event.away_goals:
            winner = event.home.name
        elif event.away_goals > event.home_goals:
            winner = event.away.name
    if not winner:
        return None
    runner = event.away.name if winner == event.home.name else event.home.name
    return winner, runner


def brazilian_teams_in_events(competition: str, events: Sequence[CupEvent]) -> frozenset[str]:
    """Identifica clubes brasileiros sem classificar estrangeiros como externos nacionais.

    Na Copa do Brasil todos os participantes são brasileiros. Nas competições
    continentais, o país informado pela ESPN é a fonte principal; a marcação de
    clube da Série A corrente funciona como salvaguarda quando o país não vier.
    """
    names: set[str] = set()
    for event in events:
        for team in (event.home, event.away):
            if competition == "copa_do_brasil" or team.country == "BRA" or team.serie_a:
                names.add(normalize_text(team.name))
    return frozenset(names)


def simulate_competition(
    snapshot: Mapping[str, Any],
    league_model: Mapping[str, Any],
    serie_a_names: Sequence[str],
    simulations: int,
    seed: int,
    config: Mapping[str, Any],
) -> CupSimulation:
    competition, events, meta = parse_snapshot(snapshot)
    completed = completed_champion(events)
    all_teams = sorted({event.home.name for event in events} | {event.away.name for event in events}, key=normalize_text)
    team_index = {team: index for index, team in enumerate(all_teams)}
    brazilian_team_names = brazilian_teams_in_events(competition, events)
    if completed:
        champion, runner = completed
        champion_ids = np.full(simulations, team_index[champion], dtype=np.int16)
        runner_ids = np.full(simulations, team_index[runner or champion], dtype=np.int16)
        return CupSimulation(
            competition,
            tuple(all_teams),
            brazilian_team_names,
            frozenset(normalize_text(name) for name in (champion, runner) if name),
            champion_ids,
            runner_ids,
            {
                "status": "encerrada",
                "campeao": champion,
                "vice": runner,
                "eventos": len(events),
            },
        )

    rank, stage, stage_events = current_stage(events)
    if stage_is_group(stage):
        raise ContinentalDataNotReady(
            f"{competition}: fase de grupos ativa; a Execução 2.5 exige mata-mata definido"
        )
    ties = build_ties(stage_events)
    if not ties:
        raise ContinentalDataNotReady(f"{competition}: nenhuma chave da fase atual foi identificada")
    final_stage = stage_is_final(stage, rank)
    if final_stage and len(ties) != 1:
        raise ContinentalDataNotReady(f"{competition}: final precisa conter exatamente um confronto")
    if not final_stage and rank >= 600:
        incomplete_ties = [tie.key for tie in ties if len(tie.events) != 2]
        if incomplete_ties:
            raise ContinentalDataNotReady(
                f"{competition}: fase eliminatória com confrontos sem ida e volta: {incomplete_ties[:3]}"
            )
    participants = sorted({tie.team_a for tie in ties} | {tie.team_b for tie in ties}, key=normalize_text)
    if len(participants) != 2 * len(ties) or not is_power_of_two(len(participants)):
        raise ContinentalDataNotReady(
            f"{competition}: fase atual inconsistente ({len(participants)} equipes, {len(ties)} chaves)"
        )

    model = fit_cup_model(
        events,
        league_model,
        set(serie_a_names),
        prior_sd=float(config.get("desvio_prior_copas", 0.65)),
        half_life_days=float(config.get("meia_vida_copas_dias", 240.0)),
        league_weight=float(config.get("peso_modelo_brasileirao_para_serie_a", 0.65)),
    )
    home_rates, away_rates = rates_matrices(model, all_teams, neutral=False)
    neutral_home, neutral_away = rates_matrices(model, all_teams, neutral=True)
    powers = np.asarray([team_power(model, team) for team in all_teams], dtype=np.float64)
    rng = np.random.default_rng(seed)
    current_winners = np.column_stack(
        [
            simulate_current_tie(
                tie,
                team_index,
                model,
                home_rates,
                away_rates,
                powers,
                simulations,
                rng,
            )
            for tie in ties
        ]
    ).astype(np.int16)

    # Se a fase atual já é a final, o vencedor do confronto é o campeão e o
    # outro participante é o vice. Não existe rodada futura a simular.
    if final_stage:
        tie = ties[0]
        team_a_id = team_index[tie.team_a]
        team_b_id = team_index[tie.team_b]
        champion = current_winners[:, 0].astype(np.int16)
        runner_up = np.where(champion == team_a_id, team_b_id, team_a_id).astype(np.int16)
        counts = np.bincount(champion, minlength=len(all_teams))
        top_indices = np.argsort(-counts)[:5]
        return CupSimulation(
            competition=competition,
            team_names=tuple(all_teams),
            brazilian_team_names=brazilian_team_names,
            eligible_team_names=frozenset(normalize_text(name) for name in participants),
            champion_ids=champion,
            runner_up_ids=runner_up,
            audit={
                "status": "simulado",
                "fase_atual": stage,
                "fase_ordem": rank,
                "chaves_atuais": 1,
                "equipes_ativas": 2,
                "rodadas_simuladas_tamanhos": [1],
                "pareamento_futuro": "não aplicável",
                "partidas_concluidas_no_ajuste": model["matches"],
                "principais_chances_titulo": [
                    {
                        "clube": all_teams[index],
                        "probabilidade_pct": round(100.0 * int(counts[index]) / simulations, 6),
                    }
                    for index in top_indices
                    if counts[index]
                ],
            },
        )

    pairing_mode = str(meta.get("pareamento_apos_fase_atual") or "chave")
    round_sizes = [current_winners.shape[1]]
    participants_matrix = current_winners
    runner_up = np.full(simulations, -1, dtype=np.int16)
    while participants_matrix.shape[1] > 1:
        is_final = participants_matrix.shape[1] == 2
        winners, losers = simulate_round(
            participants_matrix,
            home_rates,
            away_rates,
            neutral_home,
            neutral_away,
            powers,
            rng,
            pairing_mode=pairing_mode,
            single_match=is_final and bool(meta.get("final_partida_unica", True)),
        )
        if is_final:
            runner_up = losers[:, 0].astype(np.int16)
        participants_matrix = winners
        round_sizes.append(participants_matrix.shape[1])
        if pairing_mode == "sorteio":
            pairing_mode = "sorteio"
    champion = participants_matrix[:, 0].astype(np.int16)
    if np.any(runner_up < 0):
        raise ContinentalDataNotReady(f"{competition}: vice-campeão não foi produzido")
    counts = np.bincount(champion, minlength=len(all_teams))
    top_indices = np.argsort(-counts)[:5]
    return CupSimulation(
        competition=competition,
        team_names=tuple(all_teams),
        brazilian_team_names=brazilian_team_names,
        eligible_team_names=frozenset(normalize_text(name) for name in participants),
        champion_ids=champion,
        runner_up_ids=runner_up,
        audit={
            "status": "simulado",
            "fase_atual": stage,
            "fase_ordem": rank,
            "chaves_atuais": len(ties),
            "equipes_ativas": len(participants),
            "rodadas_simuladas_tamanhos": round_sizes,
            "pareamento_futuro": str(meta.get("pareamento_apos_fase_atual") or "chave"),
            "partidas_concluidas_no_ajuste": model["matches"],
            "principais_chances_titulo": [
                {
                    "clube": all_teams[index],
                    "probabilidade_pct": round(100.0 * int(counts[index]) / simulations, 6),
                }
                for index in top_indices
                if counts[index]
            ],
        },
    )


def names_to_serie_a_indices(names: np.ndarray, index: Mapping[str, int]) -> np.ndarray:
    return np.fromiter((index.get(str(name), -1) for name in names), dtype=np.int16, count=len(names))


def display_probability(
    count: int,
    simulations: int,
    threshold_pct: float,
    *,
    structurally_possible: bool = True,
    impossibility_reason: str | None = None,
) -> dict[str, Any]:
    pct = 100.0 * count / simulations
    zero_observed = count == 0
    if not structurally_possible:
        display = "0%"
    elif pct < threshold_pct:
        display = f"<{str(threshold_pct).replace('.', ',')}%"
    elif pct >= 99.95:
        display = "100,0%" if count == simulations else ">99,9%"
    else:
        display = f"{pct:.1f}%".replace(".", ",")
    upper_95 = 100.0 * (3.0 / simulations) if zero_observed and structurally_possible else None
    return {
        "ocorrencias": int(count),
        "simulacoes": int(simulations),
        "percentual_estimado": round(pct, 6),
        "exibicao": display,
        "zero_observado": zero_observed,
        "possivel_estruturalmente": bool(structurally_possible),
        "impossivel_estruturalmente": not bool(structurally_possible),
        "motivo_impossibilidade": impossibility_reason if not structurally_possible else None,
        "limite_superior_95_regra_dos_tres_pct": round(upper_95, 8) if upper_95 is not None else None,
    }


def allocate_integrated_qualification(
    league_order: np.ndarray,
    serie_a_names: Sequence[str],
    copa: CupSimulation,
    libertadores: CupSimulation,
    sulamericana: CupSimulation,
    simulations: int,
    config: Mapping[str, Any],
    league_points: np.ndarray | None = None,
) -> dict[str, Any]:
    """Aloca vagas continentais e atribui uma via exclusiva a cada clube.

    A decomposição adota uma regra interpretável e causal:
      1. as cinco vagas-base do Brasileirão são atribuídas primeiro;
      2. títulos continentais classificam quem ainda não estava na base;
      3. as duas vagas da Copa do Brasil classificam quem ainda não estava;
      4. toda sobreposição devolve vaga à classificação do Brasileirão;
      5. as seis vagas da Sul-Americana vão aos melhores ainda não classificados.

    Assim, "via Copa do Brasil" representa situações em que a Copa foi
    necessária para a classificação, e não apenas cenários em que o clube foi
    campeão/vice mas já terminaria na zona-base do Brasileirão.
    """
    if league_order.shape != (simulations, len(serie_a_names)):
        raise ValueError("matriz de classificação final incompatível")

    team_index = {team: index for index, team in enumerate(serie_a_names)}
    copa_champion_names = copa.champion_names()
    copa_runner_names = copa.runner_up_names()
    lib_champion_names = libertadores.champion_names()
    sula_champion_names = sulamericana.champion_names()

    top_direct = int(config.get("brasileirao_vagas_diretas", 4))
    top_prelim = int(config.get("brasileirao_vagas_preliminares", 1))
    base_league_slots = top_direct + top_prelim
    sula_slots = int(config.get("sul_americana_vagas", 6))
    if base_league_slots <= 0 or base_league_slots >= len(serie_a_names):
        raise ValueError("quantidade inválida de vagas-base do Brasileirão")
    if sula_slots <= 0 or base_league_slots + sula_slots >= len(serie_a_names):
        raise ValueError("quantidade inválida de vagas da Sul-Americana")

    route_names = (
        "via_brasileirao",
        "via_copa_do_brasil",
        "via_titulo_libertadores",
        "via_titulo_sul_americana",
        "via_repasse",
    )
    route_counts = {route: np.zeros(len(serie_a_names), dtype=np.int64) for route in route_names}
    copa_subroute_names = (
        "campeao",
        "vice",
        "vice_herda_vaga_direta",
    )
    copa_subroute_counts = {
        route: np.zeros(len(serie_a_names), dtype=np.int64) for route in copa_subroute_names
    }
    lib_total = np.zeros(len(serie_a_names), dtype=np.int64)
    sula_total = np.zeros(len(serie_a_names), dtype=np.int64)
    sula_base = np.zeros(len(serie_a_names), dtype=np.int64)
    sula_repasse = np.zeros(len(serie_a_names), dtype=np.int64)
    per_sim_lib_counts = np.zeros(simulations, dtype=np.int16)
    per_sim_total_brazil_slots = np.zeros(simulations, dtype=np.int16)
    external_qualified_counts = np.zeros(simulations, dtype=np.int16)
    lib_by_points = np.zeros(115, dtype=np.int64)
    continental_by_points = np.zeros(115, dtype=np.int64)

    def current_index(team_name: str) -> int:
        return int(team_index.get(team_name, -1))

    def is_brazilian_in(simulation: CupSimulation, team_name: str) -> bool:
        return current_index(team_name) >= 0 or normalize_text(team_name) in simulation.brazilian_team_names

    for row in range(simulations):
        order = league_order[row]
        position = np.empty(len(serie_a_names), dtype=np.int16)
        position[order] = np.arange(1, len(serie_a_names) + 1, dtype=np.int16)

        # Vias exclusivas para clubes da Série A atual; externos são mantidos
        # em um conjunto próprio para detectar sobreposições entre competições.
        qualified: dict[int, str] = {}
        external_qualified: set[str] = set()

        # 1) Zona-base do Brasileirão: quatro vagas diretas + uma preliminar.
        for team_raw in order[:base_league_slots]:
            qualified[int(team_raw)] = "via_brasileirao"

        returned_slots = 0

        def already_qualified(team_name: str) -> bool:
            index = current_index(team_name)
            return index in qualified if index >= 0 else normalize_text(team_name) in external_qualified

        def qualify(team_name: str, route: str) -> int:
            """Registra clube brasileiro; retorna índice Série A ou -1 se externo."""
            index = current_index(team_name)
            if index >= 0:
                qualified[index] = route
            else:
                external_qualified.add(normalize_text(team_name))
            return index

        # 2) Campeões continentais: se já estavam no G5, a vaga-base é
        # repassada para a classificação do Brasileirão.
        for champion_name, route, competition_simulation in (
            (str(lib_champion_names[row]), "via_titulo_libertadores", libertadores),
            (str(sula_champion_names[row]), "via_titulo_sul_americana", sulamericana),
        ):
            # Campeão estrangeiro não altera a alocação brasileira. Um clube
            # brasileiro fora da Série A, porém, precisa ser contabilizado e
            # pode gerar sobreposição com outra via de classificação.
            if not is_brazilian_in(competition_simulation, champion_name):
                continue
            if already_qualified(champion_name):
                # O repasse pelo Brasileirão existe quando a sobreposição
                # libera uma vaga-base ocupada por clube da Série A corrente.
                if current_index(champion_name) >= 0:
                    returned_slots += 1
            else:
                qualify(champion_name, route)

        # 3) Copa do Brasil. Se o campeão já estiver classificado, o vice
        # herda a vaga direta e a vaga preliminar original do vice retorna ao
        # Brasileirão. Se ambos já estiverem classificados, as duas retornam.
        champion_name = str(copa_champion_names[row])
        runner_name = str(copa_runner_names[row])
        champion_already = already_qualified(champion_name)
        runner_already = already_qualified(runner_name)

        if not champion_already:
            champion_index = qualify(champion_name, "via_copa_do_brasil")
            if champion_index >= 0:
                copa_subroute_counts["campeao"][champion_index] += 1
            if runner_name != champion_name and not runner_already:
                runner_index = qualify(runner_name, "via_copa_do_brasil")
                if runner_index >= 0:
                    copa_subroute_counts["vice"][runner_index] += 1
            else:
                returned_slots += 1
        else:
            returned_slots += 1
            if runner_name != champion_name and not runner_already:
                runner_index = qualify(runner_name, "via_copa_do_brasil")
                if runner_index >= 0:
                    copa_subroute_counts["vice_herda_vaga_direta"][runner_index] += 1
            else:
                returned_slots += 1

        # 4) Repasses: cada vaga devolvida desce uma posição, pulando clubes
        # já classificados por outra via. O limite defensivo evita publicar
        # estado impossível caso o regulamento/configuração fique incoerente.
        repasses_preenchidos = 0
        for team_raw in order:
            if repasses_preenchidos >= returned_slots:
                break
            team = int(team_raw)
            if team in qualified:
                continue
            qualified[team] = "via_repasse"
            repasses_preenchidos += 1
        if repasses_preenchidos != returned_slots:
            raise ValueError("não foi possível alocar todos os repasses de vagas à Libertadores")

        for team, route in qualified.items():
            lib_total[team] += 1
            if league_points is not None:
                lib_by_points[int(league_points[row, team])] += 1
                continental_by_points[int(league_points[row, team])] += 1
            route_counts[route][team] += 1
        per_sim_lib_counts[row] = len(qualified)
        external_qualified_counts[row] = len(external_qualified)
        per_sim_total_brazil_slots[row] = len(qualified) + len(external_qualified)

        # 5) Sul-Americana: seis melhores clubes da Série A não classificados
        # à Libertadores. A via é base (6º–11º) ou repasse/expansão.
        selected_sula: list[int] = []
        for team_raw in order:
            team = int(team_raw)
            if team in qualified:
                continue
            selected_sula.append(team)
            if len(selected_sula) == sula_slots:
                break
        if len(selected_sula) != sula_slots:
            raise ValueError("não foi possível alocar seis vagas da Sul-Americana")
        for team in selected_sula:
            sula_total[team] += 1
            if league_points is not None:
                continental_by_points[int(league_points[row, team])] += 1
            if base_league_slots < int(position[team]) <= base_league_slots + sula_slots:
                sula_base[team] += 1
            else:
                sula_repasse[team] += 1

    results: dict[str, Any] = {}
    threshold = float(config.get("limiar_exibicao_percentual", 0.1))
    for index, team in enumerate(serie_a_names):
        normalized_team = normalize_text(team)
        route_possible = {
            "via_brasileirao": True,
            "via_copa_do_brasil": normalized_team in copa.eligible_team_names,
            "via_titulo_libertadores": normalized_team in libertadores.eligible_team_names,
            "via_titulo_sul_americana": normalized_team in sulamericana.eligible_team_names,
            "via_repasse": True,
        }
        route_reasons = {
            "via_copa_do_brasil": "clube não está mais ativo na Copa do Brasil",
            "via_titulo_libertadores": "clube não está mais ativo na Libertadores",
            "via_titulo_sul_americana": "clube não está mais ativo na Sul-Americana",
        }
        lib_routes = {
            route: display_probability(
                int(values[index]),
                simulations,
                threshold,
                structurally_possible=route_possible[route],
                impossibility_reason=route_reasons.get(route),
            )
            for route, values in route_counts.items()
        }
        lib_total_info = display_probability(int(lib_total[index]), simulations, threshold)
        route_sum = sum(item["percentual_estimado"] for item in lib_routes.values())
        if abs(route_sum - lib_total_info["percentual_estimado"]) > 0.002:
            raise ValueError(f"decomposição da Libertadores não fecha para {team}")

        copa_possible = normalized_team in copa.eligible_team_names
        copa_subroutes = {
            route: display_probability(
                int(values[index]),
                simulations,
                threshold,
                structurally_possible=copa_possible,
                impossibility_reason="clube não está mais ativo na Copa do Brasil",
            )
            for route, values in copa_subroute_counts.items()
        }
        copa_subroute_sum = sum(item["percentual_estimado"] for item in copa_subroutes.values())
        if abs(copa_subroute_sum - lib_routes["via_copa_do_brasil"]["percentual_estimado"]) > 0.002:
            raise ValueError(f"subdecomposição da Copa do Brasil não fecha para {team}")

        sula_routes = {
            "via_brasileirao": display_probability(int(sula_base[index]), simulations, threshold),
            "via_repasse": display_probability(int(sula_repasse[index]), simulations, threshold),
        }
        sula_total_info = display_probability(int(sula_total[index]), simulations, threshold)
        sula_route_sum = sum(item["percentual_estimado"] for item in sula_routes.values())
        if abs(sula_route_sum - sula_total_info["percentual_estimado"]) > 0.002:
            raise ValueError(f"decomposição da Sul-Americana não fecha para {team}")

        results[team] = {
            "libertadores": {
                "total": lib_total_info,
                "vias": lib_routes,
                "subvias_copa_do_brasil": copa_subroutes,
                "soma_vias_pct": round(route_sum, 6),
            },
            "sul_americana": {
                "total": sula_total_info,
                "vias": sula_routes,
                "soma_vias_pct": round(sula_route_sum, 6),
            },
        }

    return {
        "clubes": results,
        "pontuacao_objetivos": {
            "libertadores": lib_by_points.tolist(),
            "sul_americana_ou_melhor": continental_by_points.tolist(),
        },
        "auditoria": {
            "vagas_brasileirao_base": base_league_slots,
            "vagas_sul_americana": sula_slots,
            "media_clubes_serie_a_2026_na_libertadores": round(float(np.mean(per_sim_lib_counts)), 6),
            "minimo_clubes_serie_a_2026_na_libertadores": int(np.min(per_sim_lib_counts)),
            "maximo_clubes_serie_a_2026_na_libertadores": int(np.max(per_sim_lib_counts)),
            "media_total_clubes_brasileiros_na_libertadores": round(
                float(np.mean(per_sim_total_brazil_slots)), 6
            ),
            "minimo_total_clubes_brasileiros_na_libertadores": int(
                np.min(per_sim_total_brazil_slots)
            ),
            "maximo_total_clubes_brasileiros_na_libertadores": int(
                np.max(per_sim_total_brazil_slots)
            ),
            "media_vagas_consumidas_por_clubes_brasileiros_fora_da_serie_a_2026": round(
                float(np.mean(external_qualified_counts)), 6
            ),
            "soma_probabilidades_libertadores_pct": round(
                100.0 * float(np.mean(per_sim_lib_counts)), 6
            ),
            "soma_probabilidades_sul_americana_pct": round(
                sum(
                    results[team]["sul_americana"]["total"]["percentual_estimado"]
                    for team in serie_a_names
                ),
                6,
            ),
            "regra_decomposicao": (
                "vias exclusivas: G5 do Brasileirão primeiro; títulos/copa apenas quando necessários; "
                "sobreposições descem como repasse"
            ),
            "regra_elegibilidade": (
                "títulos da Copa do Brasil, Libertadores e Sul-Americana classificam mesmo que o clube "
                "seja rebaixado; a posição na liga limita apenas as vagas obtidas pelo Brasileirão"
            ),
        },
    }


def integrate_continental_probabilities(
    snapshots: Mapping[str, Mapping[str, Any]],
    league_model: Mapping[str, Any],
    league_order: np.ndarray,
    serie_a_names: Sequence[str],
    simulations: int,
    seed: int,
    config: Mapping[str, Any],
    league_points: np.ndarray | None = None,
) -> dict[str, Any]:
    cup_simulations: dict[str, CupSimulation] = {}
    seed_offsets = {"copa_do_brasil": 101, "libertadores": 211, "sul_americana": 307}
    for key in ("copa_do_brasil", "libertadores", "sul_americana"):
        if key not in snapshots:
            raise ContinentalDataNotReady(f"snapshot ausente: {key}")
        cup_simulations[key] = simulate_competition(
            snapshots[key],
            league_model,
            serie_a_names,
            simulations,
            seed + seed_offsets[key],
            config,
        )
    allocated = allocate_integrated_qualification(
        league_order,
        serie_a_names,
        cup_simulations["copa_do_brasil"],
        cup_simulations["libertadores"],
        cup_simulations["sul_americana"],
        simulations,
        config,
        league_points=league_points,
    )
    return {
        "clubes": allocated["clubes"],
        "pontuacao_objetivos": allocated["pontuacao_objetivos"],
        "auditoria": {
            "competicoes": {key: value.audit for key, value in cup_simulations.items()},
            "alocacao_vagas": allocated["auditoria"],
        },
    }


def load_snapshots() -> dict[str, dict[str, Any]]:
    snapshots: dict[str, dict[str, Any]] = {}
    for key, path in SNAPSHOT_FILES.items():
        if not path.exists():
            raise ContinentalDataNotReady(f"arquivo ausente: {path.relative_to(ROOT)}")
        snapshots[key] = load_json(path)
    return snapshots


def self_test() -> None:
    teams = tuple(f"Clube {index:02d}" for index in range(20))
    league_model = {
        "mu": math.log(1.15),
        "home_adv": math.log(1.22),
        "attack": {team: (0.20 if team == teams[0] else 0.0) for team in teams},
        "defence": {team: (0.15 if team == teams[0] else 0.0) for team in teams},
    }

    def snapshot(key: str, active: Sequence[str], stage: str = "Quartas de final") -> dict[str, Any]:
        events = []
        for index in range(0, len(active), 2):
            first = active[index]
            second = active[index + 1]
            for leg, (home, away, when) in enumerate(
                (
                    (first, second, "2026-07-20T20:00:00-03:00"),
                    (second, first, "2026-07-27T20:00:00-03:00"),
                ),
                start=1,
            ):
                events.append(
                    {
                        "event_id": f"{key}-{index}-{leg}",
                        "data_iso": when,
                        "estado": "pre",
                        "concluido": False,
                        "fase": stage,
                        "fase_ordem": 700,
                        "mandante": {"nome": home, "espn_id": str(index), "serie_a_2026": home in teams, "placar": None},
                        "visitante": {"nome": away, "espn_id": str(index + 1), "serie_a_2026": away in teams, "placar": None},
                        "vencedor": None,
                        "penaltis": False,
                    }
                )
        return {
            "schema_version": 1,
            "status": "ok",
            "competicao": {
                "chave": key,
                "pareamento_apos_fase_atual": "sorteio" if key == "copa_do_brasil" else "chave",
                "final_partida_unica": True,
            },
            "eventos": events,
        }

    snapshots = {
        "copa_do_brasil": snapshot("copa_do_brasil", [*teams[:7], "Equipe B"]),
        "libertadores": snapshot("libertadores", [*teams[:4], "River", "Boca", "LDU", "Nacional"]),
        "sul_americana": snapshot("sul_americana", [*teams[4:8], "Lanús", "Colo-Colo", "Emelec", "Cerro"]),
    }
    simulations = 10_000
    # Ordem fixa: Clube 00 em primeiro, Clube 19 em último.
    order = np.broadcast_to(np.arange(20, dtype=np.int16), (simulations, 20)).copy()
    config = {
        "desvio_prior_copas": 0.65,
        "meia_vida_copas_dias": 240,
        "peso_modelo_brasileirao_para_serie_a": 0.65,
        "brasileirao_vagas_diretas": 4,
        "brasileirao_vagas_preliminares": 1,
        "sul_americana_vagas": 6,
        "rebaixamento_a_partir_da_posicao": 17,
        "limiar_exibicao_percentual": 0.1,
    }
    result_a = integrate_continental_probabilities(
        snapshots, league_model, order, teams, simulations, 1234, config
    )
    result_b = integrate_continental_probabilities(
        snapshots, league_model, order, teams, simulations, 1234, config
    )
    assert json.dumps(result_a, sort_keys=True) == json.dumps(result_b, sort_keys=True)
    assert len(result_a["clubes"]) == 20
    assert abs(result_a["auditoria"]["alocacao_vagas"]["soma_probabilidades_sul_americana_pct"] - 600.0) < 0.02
    for team, item in result_a["clubes"].items():
        lib = item["libertadores"]
        assert abs(lib["total"]["percentual_estimado"] - lib["soma_vias_pct"]) < 0.002, team
        sula = item["sul_americana"]
        assert abs(sula["total"]["percentual_estimado"] - sula["soma_vias_pct"]) < 0.002, team
    zero = display_probability(0, 2_000_000, 0.1)
    assert zero["exibicao"] == "<0,1%"
    assert zero["limite_superior_95_regra_dos_tres_pct"] == 0.00015
    impossible = display_probability(0, 2_000_000, 0.1, structurally_possible=False, impossibility_reason="eliminado")
    assert impossible["exibicao"] == "0%"
    assert impossible["impossivel_estruturalmente"] is True
    assert impossible["limite_superior_95_regra_dos_tres_pct"] is None

    # Cenários determinísticos de alocação e repasse. Inclui campeões em G5,
    # finalistas da Copa já classificados e campeões continentais rebaixados.
    deterministic_sims = 4
    deterministic_order = np.broadcast_to(
        np.arange(20, dtype=np.int16), (deterministic_sims, 20)
    ).copy()

    def fixed_cup(
        competition: str,
        champions: Sequence[str],
        runners: Sequence[str],
        brazilian_names: Sequence[str],
    ) -> CupSimulation:
        names = tuple(sorted(set(champions) | set(runners), key=normalize_text))
        name_index = {name: index for index, name in enumerate(names)}
        return CupSimulation(
            competition=competition,
            team_names=names,
            brazilian_team_names=frozenset(normalize_text(name) for name in brazilian_names),
            eligible_team_names=frozenset(normalize_text(name) for name in names),
            champion_ids=np.asarray([name_index[name] for name in champions], dtype=np.int16),
            runner_up_ids=np.asarray([name_index[name] for name in runners], dtype=np.int16),
            audit={"status": "fixo_self_test"},
        )

    copa_fixed = fixed_cup(
        "copa_do_brasil",
        [teams[0], teams[8], teams[0], teams[17]],
        [teams[6], teams[9], teams[1], "Clube externo Copa"],
        [*teams, "Clube externo Copa"],
    )
    libertadores_fixed = fixed_cup(
        "libertadores",
        ["Clube estrangeiro Libertadores", teams[0], teams[2], teams[19]],
        ["Vice L0", "Vice L1", "Vice L2", "Vice L3"],
        teams,
    )
    sulamericana_fixed = fixed_cup(
        "sul_americana",
        ["Clube estrangeiro Sul-Americana", teams[10], teams[3], teams[18]],
        ["Vice S0", "Vice S1", "Vice S2", "Vice S3"],
        teams,
    )
    final_snapshot = {
        "schema_version": 1,
        "status": "ok",
        "competicao": {
            "chave": "copa_do_brasil",
            "pareamento_apos_fase_atual": "sorteio",
            "final_partida_unica": True,
        },
        "eventos": [
            {
                "event_id": "final-pendente",
                "data_iso": "2026-12-06T16:00:00-03:00",
                "estado": "pre",
                "concluido": False,
                "fase": "Final",
                "fase_ordem": 900,
                "mandante": {"nome": teams[0], "espn_id": "1", "serie_a_2026": True, "placar": None},
                "visitante": {"nome": teams[1], "espn_id": "2", "serie_a_2026": True, "placar": None},
                "vencedor": None,
                "penaltis": False,
            }
        ],
    }
    final_simulation = simulate_competition(
        final_snapshot, league_model, teams, 1_000, 777, config
    )
    assert final_simulation.champion_ids.shape == (1_000,)
    assert final_simulation.runner_up_ids.shape == (1_000,)
    assert np.all(final_simulation.champion_ids != final_simulation.runner_up_ids)

    incomplete_snapshot = json.loads(json.dumps(snapshots["libertadores"]))
    incomplete_snapshot["eventos"] = incomplete_snapshot["eventos"][:1]
    try:
        simulate_competition(incomplete_snapshot, league_model, teams, 1_000, 778, config)
    except ContinentalDataNotReady as exc:
        assert "ida e volta" in str(exc)
    else:
        raise AssertionError("mata-mata incompleto deveria bloquear publicação")

    deterministic_points = np.full((deterministic_sims, 20), 60, dtype=np.int16)
    fixed = allocate_integrated_qualification(
        deterministic_order,
        teams,
        copa_fixed,
        libertadores_fixed,
        sulamericana_fixed,
        deterministic_sims,
        config,
        league_points=deterministic_points,
    )
    # Linha 0: campeão da Copa no G5; vice herda a vaga e há um repasse.
    assert fixed["clubes"][teams[0]]["libertadores"]["vias"]["via_brasileirao"]["ocorrencias"] >= 1
    assert fixed["clubes"][teams[6]]["libertadores"]["vias"]["via_copa_do_brasil"]["ocorrencias"] >= 1
    assert fixed["clubes"][teams[5]]["libertadores"]["vias"]["via_repasse"]["ocorrencias"] >= 1
    # Linha 2: quatro sobreposições (dois títulos + dois finalistas no G5)
    # expandem a classificação da liga até o nono clube.
    assert fixed["clubes"][teams[8]]["libertadores"]["vias"]["via_repasse"]["ocorrencias"] >= 1
    # Linha 3: rebaixamento não anula vaga conquistada por título continental.
    assert fixed["clubes"][teams[19]]["libertadores"]["vias"]["via_titulo_libertadores"]["ocorrencias"] == 1
    assert fixed["clubes"][teams[18]]["libertadores"]["vias"]["via_titulo_sul_americana"]["ocorrencias"] == 1
    assert fixed["auditoria"]["maximo_total_clubes_brasileiros_na_libertadores"] == 9
    assert abs(fixed["auditoria"]["soma_probabilidades_sul_americana_pct"] - 600.0) < 0.02
    assert sum(fixed["pontuacao_objetivos"]["libertadores"]) == sum(fixed["auditoria"]["media_clubes_serie_a_2026_na_libertadores"] for _ in range(deterministic_sims))
    assert sum(fixed["pontuacao_objetivos"]["sul_americana_ou_melhor"]) == sum(fixed["pontuacao_objetivos"]["libertadores"]) + deterministic_sims * int(config["sul_americana_vagas"])

    print("Self-test AF-Previsão Continental Execução 2.5: OK")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    raise SystemExit("Este módulo é importado pelo gerador principal; use --self-test para validá-lo.")


if __name__ == "__main__":
    raise SystemExit(main())
