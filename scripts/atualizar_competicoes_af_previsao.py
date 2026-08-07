#!/usr/bin/env python3
"""Atualiza as competições que influenciam as vagas continentais do AF-Previsão.

Fontes ESPN consultadas:
  * Copa do Brasil:          bra.copa_do_brazil
  * CONMEBOL Libertadores:   conmebol.libertadores
  * CONMEBOL Sudamericana:   conmebol.sudamericana

O script normaliza eventos, fases, placares e participantes em snapshots próprios.
Ele não calcula probabilidades; apenas fornece a camada factual usada pelo motor
integrado da Execução 2.5.

Uso:
    python scripts/atualizar_competicoes_af_previsao.py
    python scripts/atualizar_competicoes_af_previsao.py --force
    python scripts/atualizar_competicoes_af_previsao.py --strict --force
    python scripts/atualizar_competicoes_af_previsao.py --self-test
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import sys
import time
import unicodedata
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    from atualizar_espn import ALIASES, CANONICOS, normalizar  # type: ignore
except Exception:  # pragma: no cover - fallback isolado
    ALIASES = {}
    CANONICOS = []
    normalizar = None

try:
    from scripts.af_previsao_continental import (
        ContinentalDataNotReady,
        validate_competition_snapshot_structure,
    )
except ModuleNotFoundError:  # execução direta: python scripts/arquivo.py
    from af_previsao_continental import (
        ContinentalDataNotReady,
        validate_competition_snapshot_structure,
    )

BRT = ZoneInfo("America/Sao_Paulo")
SEASON = int(os.environ.get("AF_PREVISAO_TEMPORADA", "2026"))
DATA_DIR = ROOT / "dados-br" / "competicoes-af-previsao"
AUDIT_PATH = ROOT / "dados-br" / "auditoria-competicoes-af-previsao.json"
SNAPSHOT_SCHEMA_VERSION = 2
BASE_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/{league}/scoreboard"
SUMMARY_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/{league}/summary"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
}


@dataclass(frozen=True)
class CompetitionSpec:
    key: str
    league: str
    name: str
    filename: str
    pairing_after_current_round: str
    final_single_match: bool


COMPETITIONS = (
    CompetitionSpec(
        "copa_do_brasil",
        "bra.copa_do_brazil",
        "Copa do Brasil",
        "copa-do-brasil.json",
        "sorteio",
        True,
    ),
    CompetitionSpec(
        "libertadores",
        "conmebol.libertadores",
        "CONMEBOL Libertadores",
        "libertadores.json",
        "chave",
        True,
    ),
    CompetitionSpec(
        "sul_americana",
        "conmebol.sudamericana",
        "CONMEBOL Sudamericana",
        "sul-americana.json",
        "chave",
        True,
    ),
)


def normalize_text(value: Any) -> str:
    text = unicodedata.normalize("NFD", str(value or ""))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = re.sub(r"[^a-zA-Z0-9]+", " ", text).lower()
    return re.sub(r"\s+", " ", text).strip()


def parse_datetime(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(BRT)
    except ValueError:
        return None


def now_brt() -> datetime:
    return datetime.now(BRT).replace(microsecond=0)


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")
    os.replace(tmp, path)


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: raiz JSON precisa ser objeto")
    return data


def fetch_json(url: str, timeout: int = 30, attempts: int = 3) -> dict[str, Any]:
    """Busca JSON via curl-cffi/Chrome e urllib, preservando fallback duplo."""
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        separator = "&" if "?" in url else "?"
        cache_url = f"{url}{separator}_={int(time.time())}"
        errors: list[str] = []
        try:
            from curl_cffi import requests as curl_requests  # type: ignore

            response = curl_requests.get(
                cache_url,
                impersonate="chrome",
                timeout=timeout + 5 * (attempt - 1),
                headers={
                    "Accept": HEADERS["Accept"],
                    "Accept-Language": HEADERS["Accept-Language"],
                    "Cache-Control": HEADERS["Cache-Control"],
                },
            )
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict):
                raise ValueError("resposta ESPN sem objeto JSON na raiz")
            return data
        except ImportError:
            pass
        except Exception as exc:  # noqa: BLE001
            errors.append(f"curl_cffi={type(exc).__name__}: {exc}")
            last_error = exc

        try:
            request = urllib.request.Request(cache_url, headers=HEADERS)
            with urllib.request.urlopen(request, timeout=timeout + 5 * (attempt - 1)) as response:
                charset = response.headers.get_content_charset() or "utf-8"
                data = json.loads(response.read().decode(charset, errors="replace"))
            if not isinstance(data, dict):
                raise ValueError("resposta ESPN sem objeto JSON na raiz")
            return data
        except Exception as exc:  # noqa: BLE001
            errors.append(f"urllib={type(exc).__name__}: {exc}")
            last_error = RuntimeError(" | ".join(errors))
            if attempt < attempts:
                time.sleep(2 * attempt)
    raise RuntimeError(f"falha ao buscar {url}: {last_error}")


def date_windows_between(
    start: datetime, end: datetime, days: int = 42
) -> Iterable[tuple[datetime, datetime]]:
    cursor = start
    while cursor <= end:
        upper = min(end, cursor + timedelta(days=days - 1))
        yield cursor, upper
        cursor = upper + timedelta(days=1)


def date_windows(year: int, days: int = 42) -> Iterable[tuple[datetime, datetime]]:
    start = datetime(year, 1, 1, tzinfo=BRT)
    end = datetime(year, 12, 31, 23, 59, tzinfo=BRT)
    yield from date_windows_between(start, end, days)


def fetch_events_between(
    spec: CompetitionSpec, start: datetime, end: datetime
) -> tuple[list[dict[str, Any]], int]:
    events: dict[str, dict[str, Any]] = {}
    requests = 0
    season_start = datetime(SEASON, 1, 1, tzinfo=BRT)
    season_end = datetime(SEASON, 12, 31, 23, 59, tzinfo=BRT)
    start = max(start, season_start)
    end = min(end, season_end)
    if start > end:
        return [], 0
    for lower, upper in date_windows_between(start, end):
        date_range = f"{lower:%Y%m%d}-{upper:%Y%m%d}"
        url = BASE_URL.format(league=spec.league)
        payload = fetch_json(f"{url}?dates={date_range}&limit=250&lang=pt&region=br")
        requests += 1
        for event in payload.get("events") or []:
            if isinstance(event, dict) and event.get("id"):
                events[str(event["id"])] = event
    return sorted(
        events.values(), key=lambda item: (str(item.get("date") or ""), str(item.get("id") or ""))
    ), requests


def fetch_season_events(spec: CompetitionSpec) -> tuple[list[dict[str, Any]], int]:
    return fetch_events_between(
        spec,
        datetime(SEASON, 1, 1, tzinfo=BRT),
        datetime(SEASON, 12, 31, 23, 59, tzinfo=BRT),
    )


def score_value(value: Any) -> int | None:
    if isinstance(value, dict):
        value = value.get("value", value.get("displayValue"))
    text = str(value or "").strip().replace(",", ".")
    if not text:
        return None
    try:
        return int(round(float(text)))
    except ValueError:
        return None


def round_rank(label: str, week_number: int | None = None) -> int:
    text = normalize_text(label)
    mappings = (
        (("semi final", "semifinal"), 800),
        (("quarter final", "quartas", "cuartos"), 700),
        (("round of 16", "oitavas", "octavos"), 600),
        (("playoff", "play off", "repescagem"), 550),
        (("round of 32", "5 fase", "quinta fase", "32 avos"), 500),
        (("4 fase", "quarta fase"), 450),
        (("3 fase", "terceira fase"), 400),
        (("2 fase", "segunda fase"), 350),
        (("group", "grupo", "fase de grupos"), 300),
        (("1 fase", "primeira fase", "qualifying", "preliminar"), 200),
        (("final", "decision", "decisao"), 900),
    )
    for needles, rank in mappings:
        if any(needle in text for needle in needles):
            return rank
    return 100 + int(week_number or 0)


def round_label(event: dict[str, Any], competition: dict[str, Any]) -> str:
    candidates = [
        (competition.get("type") or {}).get("text"),
        (competition.get("type") or {}).get("abbreviation"),
        (event.get("seasonType") or {}).get("name"),
        (event.get("season") or {}).get("name"),
        (event.get("week") or {}).get("text"),
        (competition.get("notes") or [{}])[0].get("headline")
        if isinstance(competition.get("notes"), list) and competition.get("notes")
        else None,
    ]
    for candidate in candidates:
        if candidate and normalize_text(candidate) not in {"2026", "2026 27"}:
            return str(candidate).strip()
    return "Fase não identificada"


def country_code(team: dict[str, Any], spec: CompetitionSpec) -> str | None:
    if spec.key == "copa_do_brasil":
        return "BRA"
    for key in ("countryCode", "country", "countryId"):
        value = team.get(key)
        if isinstance(value, dict):
            value = value.get("abbreviation") or value.get("code") or value.get("id")
        text = str(value or "").strip().upper()
        if text:
            return text
    return None


def serie_a_canonical_exact(*candidates: Any) -> str | None:
    """Reconhece somente os 20 clubes por nomes/aliases exatos.

    O normalizador geral do Brasileirão também possui uma busca aproximada por
    palavras. Ela é útil dentro da competição, mas não é segura no universo de
    copas: "América Mineiro", "Botafogo-PB" e "Vitória-ES", por exemplo, não
    podem herdar a identidade de clubes da Série A apenas por compartilharem
    uma palavra. O coletor continental, portanto, usa somente aliases exatos.
    """
    if not callable(normalizar):
        return None
    canonical_by_normalized = {normalizar(name): name for name in CANONICOS}
    for candidate in candidates:
        key = normalizar(candidate)
        if not key:
            continue
        if key in ALIASES:
            return str(ALIASES[key])
        if key in canonical_by_normalized:
            return canonical_by_normalized[key]
    return None


def team_payload(competitor: dict[str, Any], spec: CompetitionSpec) -> dict[str, Any]:
    team = competitor.get("team") or {}
    names = [
        team.get("displayName"),
        team.get("shortDisplayName"),
        team.get("name"),
        team.get("location"),
        competitor.get("displayName"),
    ]
    canonical = serie_a_canonical_exact(*names)
    display = canonical or next((str(value).strip() for value in names if value), "Equipe não identificada")
    return {
        "espn_id": str(team.get("id") or competitor.get("id") or ""),
        "nome": display,
        "nome_espn": next((str(value).strip() for value in names if value), display),
        "sigla": str(team.get("abbreviation") or "").strip(),
        "pais": country_code(team, spec),
        "serie_a_2026": bool(canonical),
        "mandante": competitor.get("homeAway") == "home",
        "vencedor": bool(competitor.get("winner")),
        "placar": score_value(competitor.get("score")),
    }


def extract_event(event: dict[str, Any], spec: CompetitionSpec) -> dict[str, Any] | None:
    competitions = event.get("competitions") or []
    if not competitions or not isinstance(competitions[0], dict):
        return None
    competition = competitions[0]
    competitors = competition.get("competitors") or []
    if len(competitors) != 2:
        return None
    teams = [team_payload(item, spec) for item in competitors if isinstance(item, dict)]
    if len(teams) != 2:
        return None
    home = next((item for item in teams if item["mandante"]), teams[0])
    away = next((item for item in teams if not item["mandante"]), teams[1])
    status_type = (event.get("status") or {}).get("type") or {}
    completed = bool(status_type.get("completed"))
    state = str(status_type.get("state") or ("post" if completed else "pre")).lower()
    label = round_label(event, competition)
    week = (event.get("week") or {}).get("number")
    try:
        week_number = int(week) if week is not None else None
    except (TypeError, ValueError):
        week_number = None
    event_date = parse_datetime(event.get("date"))
    venue = ((competition.get("venue") or {}).get("fullName") or "").strip()
    leg = competition.get("leg") or {}
    if not isinstance(leg, dict):
        leg = {}
    status_detail = str(status_type.get("detail") or status_type.get("shortDetail") or "").strip()
    winner = next((item["nome"] for item in teams if item["vencedor"]), None)
    return {
        "event_id": str(event.get("id") or ""),
        "data_iso": event_date.isoformat() if event_date else str(event.get("date") or ""),
        "estado": state,
        "concluido": completed,
        "status": status_detail,
        "fase": label,
        "fase_ordem": round_rank(label, week_number),
        "semana": week_number,
        "perna": leg.get("value") or leg.get("displayValue"),
        "estadio": venue,
        "mandante": home,
        "visitante": away,
        "vencedor": winner,
        "penaltis": bool("pen" in normalize_text(status_detail) or "penal" in normalize_text(status_detail)),
    }



def _raw_event_from_summary(payload: dict[str, Any], event_id: str) -> dict[str, Any] | None:
    """Converte o header do summary ESPN no formato bruto aceito por extract_event."""
    header = payload.get("header") or {}
    competitions = header.get("competitions") or []
    competition = competitions[0] if competitions else None
    if not isinstance(competition, dict):
        return None
    return {
        "id": str(header.get("id") or event_id),
        "date": competition.get("date") or header.get("date"),
        "status": competition.get("status") or header.get("status"),
        "season": header.get("season"),
        "seasonType": header.get("seasonType"),
        "week": header.get("week"),
        "competitions": [competition],
    }


def _evento_adiado_ou_cancelado(event: dict[str, Any]) -> bool:
    texto = normalize_text(event.get("status"))
    return any(termo in texto for termo in ("adiado", "postponed", "cancelado", "canceled", "cancelled"))


def overdue_pending_events(
    snapshot: dict[str, Any], *, grace_hours: int
) -> list[dict[str, Any]]:
    """Pendências cujo horário já passou além da janela normal de duração do jogo."""
    limite = now_brt() - timedelta(hours=max(3, int(grace_hours)))
    vencidos: list[dict[str, Any]] = []
    for event in snapshot.get("eventos") or []:
        if event.get("concluido") or _evento_adiado_ou_cancelado(event):
            continue
        data = parse_datetime(event.get("data_iso"))
        if data and data < limite:
            vencidos.append(event)
    return vencidos


def refresh_overdue_pending_with_summaries(
    spec: CompetitionSpec,
    snapshot: dict[str, Any],
    *,
    grace_hours: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Reconsulta individualmente jogos vencidos no endpoint summary da ESPN.

    O scoreboard em janelas longas pode permanecer em cache após o apito final.
    O summary individual é a segunda rota oficial já usada pelo projeto para o
    Brasileirão e evita que uma fase encerrada permaneça artificialmente aberta.
    """
    overdue = overdue_pending_events(snapshot, grace_hours=grace_hours)
    if not overdue:
        return snapshot, {"consultados": 0, "atualizados": 0, "pendentes": []}

    normalized_by_id = {
        str(item.get("event_id")): copy.deepcopy(item)
        for item in (snapshot.get("eventos") or [])
        if item.get("event_id")
    }
    consulted = 0
    updated = 0
    errors: list[str] = []
    for original in overdue:
        event_id = str(original.get("event_id") or "").strip()
        if not event_id:
            continue
        consulted += 1
        try:
            url = SUMMARY_URL.format(league=spec.league) + f"?event={event_id}"
            payload = fetch_json(url, timeout=25, attempts=2)
            raw = _raw_event_from_summary(payload, event_id)
            parsed = extract_event(raw, spec) if raw else None
            if not parsed:
                errors.append(f"{event_id}: summary sem evento normalizável")
                continue
            # Não aceitar resposta de outro confronto em caso de ID ESPN reciclado.
            if event_pair_key(parsed) != event_pair_key(original):
                errors.append(f"{event_id}: summary retornou confronto divergente")
                continue
            before = normalized_by_id.get(event_id)
            normalized_by_id[event_id] = parsed
            if before != parsed:
                updated += 1
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{event_id}: {type(exc).__name__}: {exc}")

    collection = dict(snapshot.get("coleta") or {})
    collection["summary_pendentes_vencidos"] = {
        "consultados": consulted,
        "atualizados": updated,
        "erros": errors,
    }
    refreshed = build_snapshot_from_normalized(
        spec, list(normalized_by_id.values()), collection=collection
    )
    still_overdue = [
        str(item.get("event_id"))
        for item in overdue_pending_events(refreshed, grace_hours=grace_hours)
    ]
    return refreshed, {
        "consultados": consulted,
        "atualizados": updated,
        "pendentes": still_overdue,
        "erros": errors,
    }


def assert_no_overdue_pending(snapshot: dict[str, Any], spec: CompetitionSpec, *, grace_hours: int) -> None:
    overdue = overdue_pending_events(snapshot, grace_hours=grace_hours)
    if overdue:
        ids = ", ".join(str(item.get("event_id") or "?") for item in overdue[:6])
        raise ValueError(
            f"{spec.key}: há jogo(s) com horário vencido sem resultado confirmado pela ESPN: {ids}"
        )


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


def event_pair_key(event: dict[str, Any]) -> tuple[str, str]:
    return tuple(sorted((
        normalize_text((event.get("mandante") or {}).get("nome")),
        normalize_text((event.get("visitante") or {}).get("nome")),
    )))


def normalize_active_knockout_stage(events: list[dict[str, Any]]) -> None:
    """Corrige fases que a ESPN devolve apenas como Ida/Volta/status agregado."""
    pending = [event for event in events if not event.get("concluido")]
    if not pending:
        return
    current_rank = min(int(event.get("fase_ordem") or 0) for event in pending)
    current_rank_events = [event for event in events if int(event.get("fase_ordem") or 0) == current_rank]
    current_pairs = {event_pair_key(event) for event in current_rank_events}
    current_teams = {team for pair in current_pairs for team in pair if team}
    if current_pairs and len(current_teams) == 2 * len(current_pairs) and len(current_teams) & (len(current_teams) - 1) == 0:
        return

    pending_pairs = {event_pair_key(event) for event in pending}

    # Uma fase não deixa de ser a fase atual quando algumas chaves terminam
    # antes das demais. Se a ESPN chamou as partidas apenas de "Ida/Volta",
    # incorpora também as chaves concluídas na mesma janela de jogos. Sem isso,
    # 6 voltas pendentes de uma fase com 8 chaves parecem formar 12 equipes e a
    # reconstrução é rejeitada como não sendo potência de dois.
    pending_dates = [
        parsed for event in pending
        if (parsed := parse_datetime(event.get("data_iso"))) is not None
    ]
    if pending_dates:
        lower = min(pending_dates) - timedelta(days=3)
        upper = max(pending_dates) + timedelta(days=3)
        cohort_pairs = {
            event_pair_key(event)
            for event in events
            if int(event.get("fase_ordem") or 0) == current_rank
            and (parsed := parse_datetime(event.get("data_iso"))) is not None
            and lower <= parsed <= upper
        }
        cohort_teams = {team for pair in cohort_pairs for team in pair if team}
        if (
            len(cohort_pairs) >= len(pending_pairs)
            and len(cohort_teams) == 2 * len(cohort_pairs)
            and len(cohort_teams) & (len(cohort_teams) - 1) == 0
        ):
            pending_pairs = cohort_pairs

    active_events: list[dict[str, Any]] = []
    for pair in pending_pairs:
        pair_current = sorted(
            (
                event for event in events
                if event_pair_key(event) == pair
                and int(event.get("fase_ordem") or 0) == current_rank
            ),
            key=lambda item: (item.get("data_iso") or "", item.get("event_id") or ""),
        )
        if not pair_current:
            continue
        latest_event = pair_current[-1]
        active_events.append(latest_event)
        if len(pair_current) == 1 or event_pair_key(pair_current[-2]) != pair:
            pending_date = parse_datetime(latest_event.get("data_iso"))
            before = []
            if pending_date:
                before = sorted(
                    (
                        event for event in events
                        if event.get("concluido")
                        and event_pair_key(event) == pair
                        and event is not latest_event
                        and (event_date := parse_datetime(event.get("data_iso"))) is not None
                        and event_date < pending_date
                        and (pending_date - event_date).days <= 35
                    ),
                    key=lambda item: (item.get("data_iso") or "", item.get("event_id") or ""),
                )
            if before:
                active_events.append(before[-1])
        else:
            active_events.append(pair_current[-2])
    active_teams = {team for pair in pending_pairs for team in pair if team}
    inferred = knockout_stage_from_team_count(len(active_teams))
    if not inferred or len(active_teams) != 2 * len(pending_pairs):
        return
    inferred_rank, inferred_label = inferred
    for event in active_events:
        event["fase_ordem"] = inferred_rank
        event["fase"] = inferred_label

def detect_current_stage(events: list[dict[str, Any]]) -> dict[str, Any]:
    not_completed = [event for event in events if not event.get("concluido")]
    if not_completed:
        rank = min(int(event.get("fase_ordem") or 0) for event in not_completed)
        current = [event for event in events if int(event.get("fase_ordem") or 0) == rank]
        labels = sorted({str(event.get("fase") or "") for event in current if event.get("fase")})
        return {
            "status": "em_andamento",
            "ordem": rank,
            "nome": labels[0] if len(labels) == 1 else " / ".join(labels),
            "eventos": len(current),
            "eventos_pendentes": sum(not item.get("concluido") for item in current),
        }
    if events:
        rank = max(int(event.get("fase_ordem") or 0) for event in events)
        current = [event for event in events if int(event.get("fase_ordem") or 0) == rank]
        labels = sorted({str(event.get("fase") or "") for event in current if event.get("fase")})
        return {
            "status": "encerrada",
            "ordem": rank,
            "nome": labels[0] if labels else "Final",
            "eventos": len(current),
            "eventos_pendentes": 0,
        }
    return {"status": "sem_eventos", "ordem": 0, "nome": None, "eventos": 0, "eventos_pendentes": 0}


def build_snapshot_from_normalized(
    spec: CompetitionSpec,
    normalized_events: list[dict[str, Any]],
    *,
    collection: dict[str, Any] | None = None,
) -> dict[str, Any]:
    events = copy.deepcopy(normalized_events)
    events.sort(key=lambda item: (item.get("data_iso") or "", item.get("event_id") or ""))
    normalize_active_knockout_stage(events)
    team_map: dict[str, dict[str, Any]] = {}
    for event in events:
        for side in ("mandante", "visitante"):
            team = event[side]
            key = str(team.get("espn_id") or normalize_text(team.get("nome")))
            current = team_map.setdefault(
                key,
                {
                    "espn_id": team.get("espn_id"),
                    "nome": team.get("nome"),
                    "nome_espn": team.get("nome_espn"),
                    "sigla": team.get("sigla"),
                    "pais": team.get("pais"),
                    "serie_a_2026": team.get("serie_a_2026"),
                    "jogos": 0,
                },
            )
            current["jogos"] += 1
            current["serie_a_2026"] = bool(current["serie_a_2026"] or team.get("serie_a_2026"))
    generated = now_brt().isoformat()
    current_stage = detect_current_stage(events)
    return {
        "schema_version": SNAPSHOT_SCHEMA_VERSION,
        "projeto": "AF-Previsão Continental",
        "temporada": SEASON,
        "competicao": {
            "chave": spec.key,
            "nome": spec.name,
            "espn_league": spec.league,
            "pareamento_apos_fase_atual": spec.pairing_after_current_round,
            "final_partida_unica": spec.final_single_match,
        },
        "gerado_em": generated,
        "fonte": "ESPN",
        "status": "ok" if events else "sem_eventos",
        "fase_atual": current_stage,
        "resumo": {
            "eventos": len(events),
            "finalizados": sum(bool(event.get("concluido")) for event in events),
            "pendentes": sum(not bool(event.get("concluido")) for event in events),
            "equipes": len(team_map),
            "equipes_serie_a_2026": sum(bool(team.get("serie_a_2026")) for team in team_map.values()),
        },
        "coleta": collection or {"modo": "completa", "requisicoes": None, "ultima_completa_em": generated},
        "equipes": sorted(team_map.values(), key=lambda item: normalize_text(item.get("nome"))),
        "eventos": events,
    }


def build_snapshot(
    spec: CompetitionSpec,
    raw_events: list[dict[str, Any]],
    *,
    collection: dict[str, Any] | None = None,
) -> dict[str, Any]:
    events = [parsed for event in raw_events if (parsed := extract_event(event, spec))]
    return build_snapshot_from_normalized(spec, events, collection=collection)


def snapshot_state_payload(snapshot: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": snapshot.get("status"),
        "temporada": snapshot.get("temporada"),
        "competicao": snapshot.get("competicao"),
        "fase_atual": snapshot.get("fase_atual"),
        "eventos": snapshot.get("eventos") or [],
    }


def snapshots_state_hash(snapshots: dict[str, dict[str, Any]]) -> str:
    stable = {
        key: snapshot_state_payload(snapshot)
        for key, snapshot in sorted(snapshots.items())
    }
    raw = json.dumps(stable, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def load_existing_snapshots() -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for spec in COMPETITIONS:
        path = DATA_DIR / spec.filename
        if path.exists():
            try:
                result[spec.key] = load_json(path)
            except Exception:  # noqa: BLE001
                pass
    return result


def write_github_outputs(values: dict[str, Any]) -> None:
    output_path = os.environ.get("GITHUB_OUTPUT")
    if not output_path:
        return
    with open(output_path, "a", encoding="utf-8") as handle:
        for key, value in values.items():
            safe = str(value).replace("\n", " ").replace("\r", " ")
            handle.write(f"{key}={safe}\n")


def effective_cache_minutes(
    snapshot: dict[str, Any] | None,
    default_minutes: int,
    live_minutes: int,
    live_window_hours: int,
) -> int:
    if not snapshot or live_minutes >= default_minutes:
        return default_minutes
    # Resultado vencido nunca pode ser considerado cache válido. Isso cobre o
    # intervalo após o fim da janela "ao vivo", quando um scoreboard stale em
    # ``pre`` antes voltava ao cache padrão de 45 minutos.
    if overdue_pending_events(snapshot, grace_hours=max(4, live_window_hours)):
        return 0
    now = now_brt()
    before = timedelta(hours=2)
    after = timedelta(hours=max(3, live_window_hours))
    for event in snapshot.get("eventos") or []:
        event_time = parse_datetime(event.get("data_iso"))
        if event_time and event_time - before <= now <= event_time + after:
            return live_minutes
    return default_minutes


def full_refresh_due(snapshot: dict[str, Any] | None, hours: int) -> bool:
    if not snapshot or hours <= 0:
        return not snapshot
    collection = snapshot.get("coleta") or {}
    last_full = parse_datetime(collection.get("ultima_completa_em") or snapshot.get("gerado_em"))
    return not last_full or now_brt() - last_full >= timedelta(hours=hours)


def incremental_snapshot(
    spec: CompetitionSpec,
    previous: dict[str, Any],
    past_days: int,
    future_days: int,
) -> dict[str, Any]:
    now = now_brt()
    start = (now - timedelta(days=past_days)).replace(hour=0, minute=0, second=0, microsecond=0)
    end = (now + timedelta(days=future_days)).replace(hour=23, minute=59, second=59, microsecond=0)
    raw, requests = fetch_events_between(spec, start, end)
    parsed = [item for event in raw if (item := extract_event(event, spec))]
    if not parsed:
        previous_in_window = [
            item for item in (previous.get("eventos") or [])
            if (event_time := parse_datetime(item.get("data_iso"))) is not None
            and start <= event_time <= end
        ]
        if previous_in_window:
            raise RuntimeError(
                "janela incremental ESPN voltou vazia apesar de conter "
                f"{len(previous_in_window)} evento(s) no snapshot anterior"
            )
        previous_collection = previous.get("coleta") or {}
        return build_snapshot_from_normalized(
            spec,
            previous.get("eventos") or [],
            collection={
                "modo": "incremental_sem_eventos_na_janela",
                "janela_inicio": start.isoformat(),
                "janela_fim": end.isoformat(),
                "requisicoes": requests,
                "ultima_completa_em": previous_collection.get("ultima_completa_em") or previous.get("gerado_em"),
            },
        )
    merged = {
        str(item.get("event_id")): copy.deepcopy(item)
        for item in (previous.get("eventos") or [])
        if item.get("event_id")
    }
    for item in parsed:
        merged[str(item["event_id"])] = item
    previous_collection = previous.get("coleta") or {}
    collection = {
        "modo": "incremental",
        "janela_inicio": start.isoformat(),
        "janela_fim": end.isoformat(),
        "requisicoes": requests,
        "ultima_completa_em": previous_collection.get("ultima_completa_em") or previous.get("gerado_em"),
    }
    return build_snapshot_from_normalized(spec, list(merged.values()), collection=collection)


def refreshed_snapshot(
    spec: CompetitionSpec,
    previous: dict[str, Any] | None,
    *,
    force_full: bool,
    full_refresh_hours: int,
    past_days: int,
    future_days: int,
) -> dict[str, Any]:
    def complete_snapshot() -> dict[str, Any]:
        raw, requests = fetch_season_events(spec)
        candidate = build_snapshot(
            spec,
            raw,
            collection={
                "modo": "completa",
                "requisicoes": requests,
                "ultima_completa_em": now_brt().isoformat(),
            },
        )
        if previous:
            previous_completed = {
                str(item.get("event_id")) for item in (previous.get("eventos") or [])
                if item.get("concluido") and item.get("event_id")
            }
            candidate_completed = {
                str(item.get("event_id")) for item in (candidate.get("eventos") or [])
                if item.get("concluido") and item.get("event_id")
            }
            missing = sorted(previous_completed - candidate_completed)
            if missing:
                raise RuntimeError(
                    "reconstrução completa omitiu resultados históricos já confirmados: "
                    + ", ".join(missing[:5])
                )
        return candidate

    if not previous:
        return complete_snapshot()

    # Uma reconstrução manual não deve depender primeiro da janela incremental:
    # tenta a temporada completa; se a ESPN bloquear essa consulta, ainda salva
    # a execução usando a janela recente mesclada ao último snapshot íntegro.
    if force_full:
        try:
            return complete_snapshot()
        except Exception as full_error:  # noqa: BLE001
            incremental = incremental_snapshot(spec, previous, past_days, future_days)
            collection = dict(incremental.get("coleta") or {})
            collection["reconstrucao_completa_preservada_apos_falha"] = str(full_error)
            incremental["coleta"] = collection
            return incremental

    incremental = incremental_snapshot(spec, previous, past_days, future_days)
    if not full_refresh_due(previous, full_refresh_hours):
        return incremental
    try:
        return complete_snapshot()
    except Exception as exc:  # noqa: BLE001
        collection = dict(incremental.get("coleta") or {})
        collection["reconstrucao_completa_preservada_apos_falha"] = str(exc)
        incremental["coleta"] = collection
        return incremental


def snapshot_is_fresh(path: Path, max_age_minutes: int) -> bool:
    if max_age_minutes <= 0 or not path.exists():
        return False
    try:
        data = load_json(path)
        if data.get("status") != "ok":
            return False
        if int(data.get("schema_version") or 0) != SNAPSHOT_SCHEMA_VERSION:
            return False
        generated = parse_datetime(data.get("gerado_em"))
        return bool(generated and now_brt() - generated <= timedelta(minutes=max_age_minutes))
    except Exception:  # noqa: BLE001
        return False


def validate_snapshot(snapshot: dict[str, Any], spec: CompetitionSpec) -> None:
    if int(snapshot.get("schema_version") or 0) != SNAPSHOT_SCHEMA_VERSION:
        raise ValueError(f"{spec.key}: schema de snapshot desatualizado")
    if snapshot.get("status") not in {"ok", "sem_eventos"}:
        raise ValueError(f"{spec.key}: status inválido")
    if (snapshot.get("competicao") or {}).get("espn_league") != spec.league:
        raise ValueError(f"{spec.key}: league divergente")
    events = snapshot.get("eventos") or []
    if not isinstance(events, list):
        raise ValueError(f"{spec.key}: eventos não é lista")
    ids: set[str] = set()
    for event in events:
        event_id = str(event.get("event_id") or "")
        if not event_id or event_id in ids:
            raise ValueError(f"{spec.key}: event_id ausente/duplicado")
        ids.add(event_id)
        if not event.get("mandante") or not event.get("visitante"):
            raise ValueError(f"{spec.key}: evento sem equipes")
        if event.get("concluido"):
            for side in ("mandante", "visitante"):
                if event[side].get("placar") is None:
                    raise ValueError(f"{spec.key}: finalizado sem placar")


def migrate_legacy_snapshot(snapshot: dict[str, Any], spec: CompetitionSpec) -> dict[str, Any] | None:
    """Migra com segurança um snapshot v1 para a normalização exata da v2.

    A primeira execução após a troca de schema não pode depender de a ESPN
    responder naquele instante. Todos os clubes são reclassificados a partir
    dos nomes já preservados no JSON usando somente aliases exatos; em seguida,
    equipes e contagens são reconstruídas dos eventos. Schemas desconhecidos
    continuam sendo rejeitados, sem receber apenas uma troca cosmética de número.
    """
    version = int(snapshot.get("schema_version") or 0)
    if version == SNAPSHOT_SCHEMA_VERSION:
        return None
    if version != 1 or (snapshot.get("competicao") or {}).get("chave") != spec.key:
        raise ValueError(f"{spec.key}: snapshot legado incompatível com migração segura")

    migrated = copy.deepcopy(snapshot)
    events = migrated.get("eventos") or []
    if not isinstance(events, list) or not events:
        raise ValueError(f"{spec.key}: snapshot legado sem eventos para migrar")

    team_map: dict[str, dict[str, Any]] = {}
    for event in events:
        for side in ("mandante", "visitante"):
            team = event.get(side) or {}
            # nome_espn é a evidência bruta preservada. O campo nome do schema
            # antigo pode já ter sido canonizado por aproximação; só o usamos
            # quando o nome original realmente não existe.
            source_name = team.get("nome_espn") or team.get("nome")
            canonical = serie_a_canonical_exact(source_name)
            if canonical:
                team["nome"] = canonical
            elif team.get("nome_espn"):
                team["nome"] = str(team["nome_espn"]).strip()
            team["serie_a_2026"] = bool(canonical)
            key = str(team.get("espn_id") or normalize_text(team.get("nome")))
            current = team_map.setdefault(
                key,
                {
                    "espn_id": team.get("espn_id"),
                    "nome": team.get("nome"),
                    "nome_espn": team.get("nome_espn"),
                    "sigla": team.get("sigla"),
                    "pais": team.get("pais"),
                    "serie_a_2026": bool(canonical),
                    "jogos": 0,
                },
            )
            current["jogos"] += 1
            current["serie_a_2026"] = bool(current["serie_a_2026"] or canonical)

    migrated["schema_version"] = SNAPSHOT_SCHEMA_VERSION
    migrated["equipes"] = sorted(
        team_map.values(), key=lambda item: normalize_text(item.get("nome"))
    )
    summary = dict(migrated.get("resumo") or {})
    summary.update(
        {
            "eventos": len(events),
            "finalizados": sum(bool(event.get("concluido")) for event in events),
            "pendentes": sum(not bool(event.get("concluido")) for event in events),
            "equipes": len(team_map),
            "equipes_serie_a_2026": sum(
                bool(team.get("serie_a_2026")) for team in team_map.values()
            ),
        }
    )
    migrated["resumo"] = summary
    migrated["migracao_schema"] = {
        "origem": 1,
        "destino": SNAPSHOT_SCHEMA_VERSION,
        "regra": "reclassificação por aliases exatos preservando eventos ESPN",
    }
    validate_snapshot(migrated, spec)
    return migrated


def preserved_snapshot_safe_for_af(
    snapshot: dict[str, Any] | None,
    *,
    live_window_hours: int,
    max_snapshot_age_hours: int = 24,
) -> tuple[bool, list[str]]:
    """Aceita fallback factual somente fora de janela de jogo e por tempo limitado."""
    reasons: list[str] = []
    if not snapshot or snapshot.get("status") != "ok":
        return False, ["snapshot anterior ausente ou inválido"]
    try:
        validate_competition_snapshot_structure(snapshot)
    except ContinentalDataNotReady as exc:
        return False, [f"snapshot anterior não simulável: {exc}"]

    generated = parse_datetime(snapshot.get("gerado_em"))
    now = now_brt()
    if not generated:
        reasons.append("snapshot anterior sem horário válido")
    else:
        age = now - generated
        if age > timedelta(hours=max_snapshot_age_hours):
            reasons.append(
                f"snapshot anterior tem {age.total_seconds() / 3600:.1f}h; limite={max_snapshot_age_hours}h"
            )

    before = timedelta(hours=2)
    after = timedelta(hours=max(4, live_window_hours))
    for event in snapshot.get("eventos") or []:
        if event.get("concluido"):
            continue
        event_time = parse_datetime(event.get("data_iso"))
        if not event_time:
            continue
        if event_time - before <= now <= event_time + after:
            reasons.append(
                f"há jogo em janela crítica sem confirmação: {event.get('event_id')}"
            )
            break
        if event_time < now - after:
            reasons.append(
                f"há jogo vencido sem resultado confirmado: {event.get('event_id')}"
            )
            break
    return not reasons, reasons


def run_update(
    force: bool,
    strict: bool,
    max_age_minutes: int,
    *,
    live_cache_minutes: int = 5,
    live_window_hours: int = 4,
    full_refresh_hours: int = 168,
    force_full: bool = False,
    past_days: int = 21,
    future_days: int = 120,
) -> dict[str, Any]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    before_snapshots = load_existing_snapshots()
    before_hash = snapshots_state_hash(before_snapshots)
    audit_rows: list[dict[str, Any]] = []
    failures: list[str] = []
    blocking_failures: list[str] = []
    for spec in COMPETITIONS:
        path = DATA_DIR / spec.filename
        previous: dict[str, Any] | None = None
        if path.exists():
            previous = load_json(path)
            migrated = migrate_legacy_snapshot(previous, spec)
            if migrated is not None:
                write_json_atomic(path, migrated)
                previous = migrated
        cache_minutes = effective_cache_minutes(
            previous, max_age_minutes, live_cache_minutes, live_window_hours
        )
        if not force and snapshot_is_fresh(path, cache_minutes):
            previous = load_json(path)
            audit_rows.append(
                {
                    "competicao": spec.key,
                    "status": "cache_valido",
                    "arquivo": str(path.relative_to(ROOT)),
                    "gerado_em": previous.get("gerado_em"),
                    "cache_efetivo_minutos": cache_minutes,
                    "eventos": (previous.get("resumo") or {}).get("eventos", 0),
                    "coleta": previous.get("coleta") or {},
                }
            )
            continue
        try:
            snapshot = refreshed_snapshot(
                spec,
                previous,
                force_full=force_full,
                full_refresh_hours=full_refresh_hours,
                past_days=past_days,
                future_days=future_days,
            )
            snapshot, summary_refresh = refresh_overdue_pending_with_summaries(
                spec, snapshot, grace_hours=max(4, live_window_hours)
            )
            assert_no_overdue_pending(
                snapshot, spec, grace_hours=max(4, live_window_hours)
            )
            validate_snapshot(snapshot, spec)
            if snapshot.get("status") == "ok":
                try:
                    structural = validate_competition_snapshot_structure(snapshot)
                except ContinentalDataNotReady as exc:
                    raise ValueError(f"snapshot não está pronto para o AF: {exc}") from exc
                snapshot["validacao_af"] = {
                    "status": "pronto",
                    "fase": structural.get("fase"),
                    "fase_ordem": structural.get("fase_ordem"),
                    "chaves": structural.get("chaves"),
                    "equipes_ativas": structural.get("equipes_ativas"),
                }
            if snapshot.get("status") != "ok":
                raise ValueError("ESPN não retornou eventos normalizáveis")
            write_json_atomic(path, snapshot)
            audit_rows.append(
                {
                    "competicao": spec.key,
                    "status": "atualizado",
                    "arquivo": str(path.relative_to(ROOT)),
                    "gerado_em": snapshot.get("gerado_em"),
                    "cache_efetivo_minutos": cache_minutes,
                    "eventos": snapshot["resumo"]["eventos"],
                    "finalizados": snapshot["resumo"]["finalizados"],
                    "pendentes": snapshot["resumo"]["pendentes"],
                    "fase_atual": snapshot.get("fase_atual"),
                    "summary_pendentes_vencidos": summary_refresh,
                    "coleta": snapshot.get("coleta") or {},
                }
            )
        except Exception as exc:  # noqa: BLE001
            message = f"{spec.key}: {type(exc).__name__}: {exc}"
            failures.append(message)
            previous = load_json(path) if path.exists() else None
            previous_compatible = bool(
                previous and int(previous.get("schema_version") or 0) == SNAPSHOT_SCHEMA_VERSION
            )
            if strict or not previous_compatible:
                raise RuntimeError(message) from exc
            safe_preserved, safe_reasons = preserved_snapshot_safe_for_af(
                previous, live_window_hours=live_window_hours
            )
            if not safe_preserved:
                blocking_failures.append(
                    f"{spec.key}: snapshot preservado não é seguro para o AF: "
                    + "; ".join(safe_reasons)
                )
            audit_rows.append(
                {
                    "competicao": spec.key,
                    "status": (
                        "preservado_apos_falha_seguro" if safe_preserved
                        else "preservado_apos_falha"
                    ),
                    "arquivo": str(path.relative_to(ROOT)),
                    "gerado_em": previous.get("gerado_em"),
                    "cache_efetivo_minutos": cache_minutes,
                    "erro": message,
                    "fallback_seguro_para_af": safe_preserved,
                    "motivos_fallback": safe_reasons,
                }
            )
    after_snapshots = load_existing_snapshots()
    after_hash = snapshots_state_hash(after_snapshots)
    accepted_rows = {"atualizado", "cache_valido", "preservado_apos_falha_seguro"}
    ready = (
        not blocking_failures
        and len(after_snapshots) == len(COMPETITIONS)
        and all(snapshot.get("status") == "ok" for snapshot in after_snapshots.values())
        and all(row.get("status") in accepted_rows for row in audit_rows)
    )
    audit = {
        "schema_version": 2,
        "projeto": "AF-Previsão Continental",
        "etapa": "Execução 2.5 — coleta independente e incremental das competições que alteram vagas",
        "gerado_em": now_brt().isoformat(),
        "status": "ok" if ready else "parcial_com_snapshot_preservado",
        "coleta_confiavel": ready,
        "mudanca_esportiva": before_hash != after_hash,
        "hash_estado_antes": before_hash,
        "hash_estado_depois": after_hash,
        "fonte": "ESPN",
        "temporada": SEASON,
        "competicoes": audit_rows,
        "falhas": failures,
        "falhas_bloqueantes": blocking_failures,
        "fontes_totalmente_atualizadas": not failures,
        "snapshots_prontos_para_af": ready,
        "regras_operacionais": {
            "cache_padrao_minutos": max_age_minutes,
            "cache_janela_de_jogo_minutos": live_cache_minutes,
            "janela_de_jogo_horas_apos_inicio": live_window_hours,
            "janela_incremental_dias_passado": past_days,
            "janela_incremental_dias_futuro": future_days,
            "reconstrucao_completa_horas": full_refresh_hours,
            "falha_de_rede": "preserva o último snapshot íntegro; --strict transforma a falha em erro",
            "nenhum_json_vazio": True,
        },
    }
    write_json_atomic(AUDIT_PATH, audit)
    write_github_outputs(
        {
            "continental_ready": str(ready).lower(),
            "continental_changed": str(before_hash != after_hash).lower(),
            "continental_status": audit["status"],
            "continental_hash_before": before_hash,
            "continental_hash_after": after_hash,
            "continental_failures": " | ".join(failures),
        }
    )
    return audit


def self_test() -> None:
    spec = COMPETITIONS[1]
    synthetic = {
        "id": "123",
        "date": "2026-07-10T00:30:00Z",
        "week": {"number": 7},
        "season": {"name": "2026"},
        "status": {"type": {"state": "post", "completed": True, "detail": "Final"}},
        "competitions": [
            {
                "type": {"text": "Quartas de final"},
                "venue": {"fullName": "Estádio Teste"},
                "competitors": [
                    {
                        "homeAway": "home",
                        "winner": True,
                        "score": "2",
                        "team": {"id": "1", "displayName": "Palmeiras", "abbreviation": "PAL"},
                    },
                    {
                        "homeAway": "away",
                        "winner": False,
                        "score": "1",
                        "team": {"id": "2", "displayName": "River Plate", "abbreviation": "RIV", "countryCode": "ARG"},
                    },
                ],
            }
        ],
    }
    parsed = extract_event(synthetic, spec)
    assert parsed is not None
    assert parsed["fase_ordem"] == 700
    assert parsed["mandante"]["nome"] == "Palmeiras"
    assert parsed["mandante"]["serie_a_2026"] is True
    assert parsed["visitante"]["pais"] == "ARG"
    assert parsed["vencedor"] == "Palmeiras"
    assert serie_a_canonical_exact("América Mineiro", "América-MG", "AMG") is None
    assert serie_a_canonical_exact("Botafogo-PB") is None
    assert serie_a_canonical_exact("Vitória-ES") is None
    assert serie_a_canonical_exact("Atlético-MG", "Atlético Mineiro") == "Atlético-MG"
    snapshot = build_snapshot(spec, [synthetic])
    validate_snapshot(snapshot, spec)
    assert snapshot["resumo"]["eventos"] == 1
    assert snapshot["fase_atual"]["status"] == "encerrada"

    legacy = json.loads(json.dumps(snapshot))
    legacy["schema_version"] = 1
    legacy["eventos"][0]["visitante"].update(
        {"nome": "Botafogo", "nome_espn": "Botafogo-PB", "sigla": "BOT", "serie_a_2026": True}
    )
    migrated = migrate_legacy_snapshot(legacy, spec)
    assert migrated is not None and migrated["schema_version"] == SNAPSHOT_SCHEMA_VERSION
    assert migrated["eventos"][0]["mandante"]["serie_a_2026"] is True
    assert migrated["eventos"][0]["visitante"]["nome"] == "Botafogo-PB"
    assert migrated["eventos"][0]["visitante"]["serie_a_2026"] is False

    pending = json.loads(json.dumps(synthetic))
    pending["id"] = "124"
    pending["status"]["type"] = {"state": "pre", "completed": False, "detail": "Agendado"}
    pending["competitions"][0]["type"]["text"] = "Semifinal"
    pending["competitions"][0]["competitors"][0]["score"] = None
    pending["competitions"][0]["competitors"][1]["score"] = None
    current = build_snapshot(spec, [synthetic, pending])
    assert current["fase_atual"]["ordem"] == 800
    assert current["fase_atual"]["eventos_pendentes"] == 1

    # Regressão: duas das oito voltas terminaram antes das outras seis. A fase
    # completa continua tendo 16 equipes e não pode ser reduzida às pendentes.
    mixed_stage: list[dict[str, Any]] = []
    for tie in range(8):
        first = f"Equipe {2 * tie:02d}"
        second = f"Equipe {2 * tie + 1:02d}"
        for leg, (home, away, when) in enumerate((
            (first, second, "2026-07-21T20:00:00-03:00"),
            (second, first, "2026-07-28T20:00:00-03:00"),
        ), start=1):
            completed = leg == 1 or tie < 2
            mixed_stage.append({
                "event_id": f"mixed-{tie}-{leg}",
                "data_iso": when,
                "concluido": completed,
                "fase": "Ida" if leg == 1 else "Volta",
                "fase_ordem": 100,
                "mandante": {"nome": home},
                "visitante": {"nome": away},
            })
    mixed_stage.append({
        "event_id": "mixed-fase-antiga",
        "data_iso": "2026-04-02T20:00:00-03:00",
        "concluido": True,
        "fase": "Fase não identificada",
        "fase_ordem": 100,
        "mandante": {"nome": "Equipe antiga A"},
        "visitante": {"nome": "Equipe antiga B"},
    })
    normalize_active_knockout_stage(mixed_stage)
    rebuilt = detect_current_stage(mixed_stage)
    assert rebuilt["ordem"] == 600
    assert rebuilt["eventos"] == 16
    assert rebuilt["eventos_pendentes"] == 6

    now = now_brt()
    live_snapshot = build_snapshot_from_normalized(
        spec,
        [{
            **parsed,
            "event_id": "live-cache",
            "data_iso": (now - timedelta(hours=1)).isoformat(),
            "concluido": False,
            "estado": "in",
        }],
    )
    assert effective_cache_minutes(live_snapshot, 45, 5, 4) == 5
    old_snapshot = copy.deepcopy(live_snapshot)
    old_snapshot["eventos"][0]["data_iso"] = (now - timedelta(days=2)).isoformat()
    assert effective_cache_minutes(old_snapshot, 45, 5, 4) == 0

    # Regressão: scoreboard amplo pode ficar em ``pre`` após o término. O
    # summary individual deve fechar a partida antes de o snapshot ser aceito.
    pending_overdue = build_snapshot_from_normalized(
        spec,
        [{
            "event_id": "summary-overdue",
            "data_iso": (now - timedelta(hours=8)).isoformat(),
            "estado": "pre",
            "concluido": False,
            "status": "Agendado",
            "fase": "Oitavas de final",
            "fase_ordem": 600,
            "semana": None,
            "perna": 2,
            "estadio": "Arena",
            "mandante": {"espn_id": "1", "nome": "Flamengo", "nome_espn": "Flamengo", "sigla": "FLA", "pais": "BRA", "serie_a_2026": True, "mandante": True, "vencedor": False, "placar": 0},
            "visitante": {"espn_id": "2", "nome": "Palmeiras", "nome_espn": "Palmeiras", "sigla": "PAL", "pais": "BRA", "serie_a_2026": True, "mandante": False, "vencedor": False, "placar": 0},
            "vencedor": None,
            "penaltis": False,
        }],
    )
    original_fetch = globals()["fetch_json"]
    try:
        def fake_summary(url: str, timeout: int = 30, attempts: int = 3) -> dict[str, Any]:
            del url, timeout, attempts
            return {
                "header": {
                    "id": "summary-overdue",
                    "status": {"type": {"state": "post", "completed": True, "detail": "Finalizado"}},
                    "competitions": [{
                        "date": (now - timedelta(hours=8)).isoformat(),
                        "status": {"type": {"state": "post", "completed": True, "detail": "Finalizado"}},
                        "type": {"text": "Oitavas de final"},
                        "leg": {"value": 2},
                        "venue": {"fullName": "Arena"},
                        "competitors": [
                            {"homeAway": "home", "winner": True, "score": 2, "team": {"id": "1", "displayName": "Flamengo", "abbreviation": "FLA"}},
                            {"homeAway": "away", "winner": False, "score": 1, "team": {"id": "2", "displayName": "Palmeiras", "abbreviation": "PAL"}},
                        ],
                    }],
                }
            }
        globals()["fetch_json"] = fake_summary
        refreshed, diag = refresh_overdue_pending_with_summaries(
            spec, pending_overdue, grace_hours=4
        )
    finally:
        globals()["fetch_json"] = original_fetch
    assert diag["consultados"] == 1 and diag["atualizados"] == 1 and not diag["pendentes"]
    assert refreshed["resumo"]["finalizados"] == 1 and refreshed["resumo"]["pendentes"] == 0
    assert_no_overdue_pending(refreshed, spec, grace_hours=4)
    merged_snapshot = build_snapshot_from_normalized(
        spec, [parsed], collection={"modo": "incremental", "ultima_completa_em": now.isoformat()}
    )
    assert merged_snapshot["coleta"]["modo"] == "incremental"
    stable_a = snapshots_state_hash({spec.key: merged_snapshot})
    changed_timestamp = copy.deepcopy(merged_snapshot)
    changed_timestamp["gerado_em"] = (now + timedelta(minutes=1)).isoformat()
    stable_b = snapshots_state_hash({spec.key: changed_timestamp})
    assert stable_a == stable_b
    print("Self-test coleta AF-Previsão Continental incremental: OK")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="ignora cache e consulta a ESPN")
    parser.add_argument("--full", action="store_true", help="força reconstrução completa da temporada após a janela incremental")
    parser.add_argument("--strict", action="store_true", help="falha se qualquer competição não atualizar")
    parser.add_argument("--max-age-minutes", type=int, default=45)
    parser.add_argument("--live-cache-minutes", type=int, default=5)
    parser.add_argument("--live-window-hours", type=int, default=4)
    parser.add_argument("--full-refresh-hours", type=int, default=168)
    parser.add_argument("--past-days", type=int, default=21)
    parser.add_argument("--future-days", type=int, default=120)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    audit = run_update(
        args.force,
        args.strict,
        args.max_age_minutes,
        live_cache_minutes=args.live_cache_minutes,
        live_window_hours=args.live_window_hours,
        full_refresh_hours=args.full_refresh_hours,
        force_full=args.full,
        past_days=args.past_days,
        future_days=args.future_days,
    )
    print(
        "Competições AF-Previsão atualizadas: "
        + ", ".join(f"{row['competicao']}={row['status']}" for row in audit["competicoes"])
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
