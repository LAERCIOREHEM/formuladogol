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
    from atualizar_espn import para_canonico  # type: ignore
except Exception:  # pragma: no cover - fallback isolado
    para_canonico = None

BRT = ZoneInfo("America/Sao_Paulo")
SEASON = int(os.environ.get("AF_PREVISAO_TEMPORADA", "2026"))
DATA_DIR = ROOT / "dados-br" / "competicoes-af-previsao"
AUDIT_PATH = ROOT / "dados-br" / "auditoria-competicoes-af-previsao.json"
BASE_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/{league}/scoreboard"
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
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            separator = "&" if "?" in url else "?"
            request = urllib.request.Request(
                f"{url}{separator}_={int(time.time())}",
                headers=HEADERS,
            )
            with urllib.request.urlopen(request, timeout=timeout + 5 * (attempt - 1)) as response:
                charset = response.headers.get_content_charset() or "utf-8"
                data = json.loads(response.read().decode(charset, errors="replace"))
            if not isinstance(data, dict):
                raise ValueError("resposta ESPN sem objeto JSON na raiz")
            return data
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt < attempts:
                time.sleep(2 * attempt)
    raise RuntimeError(f"falha ao buscar {url}: {last_error}")


def date_windows(year: int, days: int = 42) -> Iterable[tuple[datetime, datetime]]:
    cursor = datetime(year, 1, 1, tzinfo=BRT)
    end = datetime(year, 12, 31, 23, 59, tzinfo=BRT)
    while cursor <= end:
        upper = min(end, cursor + timedelta(days=days - 1))
        yield cursor, upper
        cursor = upper + timedelta(days=1)


def fetch_season_events(spec: CompetitionSpec) -> list[dict[str, Any]]:
    events: dict[str, dict[str, Any]] = {}
    for start, end in date_windows(SEASON):
        date_range = f"{start:%Y%m%d}-{end:%Y%m%d}"
        url = BASE_URL.format(league=spec.league)
        payload = fetch_json(f"{url}?dates={date_range}&limit=250&lang=pt&region=br")
        for event in payload.get("events") or []:
            if isinstance(event, dict) and event.get("id"):
                events[str(event["id"])] = event
    return sorted(events.values(), key=lambda item: (str(item.get("date") or ""), str(item.get("id") or "")))


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


def team_payload(competitor: dict[str, Any], spec: CompetitionSpec) -> dict[str, Any]:
    team = competitor.get("team") or {}
    names = [
        team.get("displayName"),
        team.get("shortDisplayName"),
        team.get("name"),
        team.get("location"),
        competitor.get("displayName"),
    ]
    canonical = para_canonico(*names) if callable(para_canonico) else None
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


def build_snapshot(spec: CompetitionSpec, raw_events: list[dict[str, Any]]) -> dict[str, Any]:
    events = [parsed for event in raw_events if (parsed := extract_event(event, spec))]
    events.sort(key=lambda item: (item.get("data_iso") or "", item.get("event_id") or ""))
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
        "schema_version": 1,
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
        "equipes": sorted(team_map.values(), key=lambda item: normalize_text(item.get("nome"))),
        "eventos": events,
    }


def snapshot_is_fresh(path: Path, max_age_minutes: int) -> bool:
    if max_age_minutes <= 0 or not path.exists():
        return False
    try:
        data = load_json(path)
        if data.get("status") != "ok":
            return False
        generated = parse_datetime(data.get("gerado_em"))
        return bool(generated and now_brt() - generated <= timedelta(minutes=max_age_minutes))
    except Exception:  # noqa: BLE001
        return False


def validate_snapshot(snapshot: dict[str, Any], spec: CompetitionSpec) -> None:
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


def run_update(force: bool, strict: bool, max_age_minutes: int) -> dict[str, Any]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    audit_rows: list[dict[str, Any]] = []
    failures: list[str] = []
    for spec in COMPETITIONS:
        path = DATA_DIR / spec.filename
        if not force and snapshot_is_fresh(path, max_age_minutes):
            previous = load_json(path)
            audit_rows.append(
                {
                    "competicao": spec.key,
                    "status": "cache_valido",
                    "arquivo": str(path.relative_to(ROOT)),
                    "gerado_em": previous.get("gerado_em"),
                    "eventos": (previous.get("resumo") or {}).get("eventos", 0),
                }
            )
            continue
        try:
            raw_events = fetch_season_events(spec)
            snapshot = build_snapshot(spec, raw_events)
            validate_snapshot(snapshot, spec)
            if snapshot.get("status") != "ok":
                raise ValueError("ESPN não retornou eventos normalizáveis")
            write_json_atomic(path, snapshot)
            audit_rows.append(
                {
                    "competicao": spec.key,
                    "status": "atualizado",
                    "arquivo": str(path.relative_to(ROOT)),
                    "gerado_em": snapshot.get("gerado_em"),
                    "eventos": snapshot["resumo"]["eventos"],
                    "finalizados": snapshot["resumo"]["finalizados"],
                    "pendentes": snapshot["resumo"]["pendentes"],
                    "fase_atual": snapshot.get("fase_atual"),
                }
            )
        except Exception as exc:  # noqa: BLE001
            message = f"{spec.key}: {type(exc).__name__}: {exc}"
            failures.append(message)
            if strict or not path.exists():
                raise RuntimeError(message) from exc
            previous = load_json(path)
            audit_rows.append(
                {
                    "competicao": spec.key,
                    "status": "preservado_apos_falha",
                    "arquivo": str(path.relative_to(ROOT)),
                    "gerado_em": previous.get("gerado_em"),
                    "erro": message,
                }
            )
    audit = {
        "schema_version": 1,
        "projeto": "AF-Previsão Continental",
        "etapa": "Execução 2.5 — coleta das competições que alteram vagas",
        "gerado_em": now_brt().isoformat(),
        "status": "ok" if not failures else "parcial_com_snapshot_preservado",
        "fonte": "ESPN",
        "temporada": SEASON,
        "competicoes": audit_rows,
        "falhas": failures,
        "regras_operacionais": {
            "cache_minutos": max_age_minutes,
            "falha_de_rede": "preserva o último snapshot íntegro; --strict transforma a falha em erro",
            "nenhum_json_vazio": True,
        },
    }
    write_json_atomic(AUDIT_PATH, audit)
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
    snapshot = build_snapshot(spec, [synthetic])
    validate_snapshot(snapshot, spec)
    assert snapshot["resumo"]["eventos"] == 1
    assert snapshot["fase_atual"]["status"] == "encerrada"

    pending = json.loads(json.dumps(synthetic))
    pending["id"] = "124"
    pending["status"]["type"] = {"state": "pre", "completed": False, "detail": "Agendado"}
    pending["competitions"][0]["type"]["text"] = "Semifinal"
    pending["competitions"][0]["competitors"][0]["score"] = None
    pending["competitions"][0]["competitors"][1]["score"] = None
    current = build_snapshot(spec, [synthetic, pending])
    assert current["fase_atual"]["ordem"] == 800
    assert current["fase_atual"]["eventos_pendentes"] == 1
    print("Self-test coleta AF-Previsão Continental: OK")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="ignora cache e consulta a ESPN")
    parser.add_argument("--strict", action="store_true", help="falha se qualquer competição não atualizar")
    parser.add_argument("--max-age-minutes", type=int, default=45)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    audit = run_update(args.force, args.strict, args.max_age_minutes)
    print(
        "Competições AF-Previsão atualizadas: "
        + ", ".join(f"{row['competicao']}={row['status']}" for row in audit["competicoes"])
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
