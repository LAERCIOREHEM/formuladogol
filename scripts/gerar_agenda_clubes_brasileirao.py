#!/usr/bin/env python3
"""Gera a agenda complementar dos clubes do Brasileirão.

A saída reúne:
- todos os jogos do Brasileirão publicados em ``jogos.json``;
- Copa do Brasil, Libertadores e Sul-Americana somente quando ao menos um
  participante pertence à Série A 2026;
- apenas partidas de hoje até o fim do mês seguinte.

O arquivo é exclusivamente editorial/operacional. Ele não executa nem amplia
os cálculos do AF-Previsão.
"""
from __future__ import annotations

import argparse
import calendar
import copy
import json
import os
import sys
import unicodedata
from datetime import datetime, time
from pathlib import Path
from typing import Any, Iterable, Mapping
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
TZ = ZoneInfo("America/Sao_Paulo")
OUTPUT = ROOT / "dados-br" / "agenda-clubes-br.json"

COMPETICOES = (
    {
        "chave": "copa_do_brasil",
        "nome": "Copa do Brasil",
        "nome_curto": "Copa do Brasil",
        "arquivo": ROOT / "dados-br" / "competicoes-af-previsao" / "copa-do-brasil.json",
        "espn_league": "bra.copa_do_brazil",
    },
    {
        "chave": "libertadores",
        "nome": "CONMEBOL Libertadores",
        "nome_curto": "Libertadores",
        "arquivo": ROOT / "dados-br" / "competicoes-af-previsao" / "libertadores.json",
        "espn_league": "conmebol.libertadores",
    },
    {
        "chave": "sul_americana",
        "nome": "CONMEBOL Sudamericana",
        "nome_curto": "Sul-Americana",
        "arquivo": ROOT / "dados-br" / "competicoes-af-previsao" / "sul-americana.json",
        "espn_league": "conmebol.sudamericana",
    },
)


def load_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return copy.deepcopy(fallback)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"JSON inválido em {path}: {exc}") from exc


def parse_dt(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=TZ)
    return parsed.astimezone(TZ)


def norm(value: Any) -> str:
    text = unicodedata.normalize("NFD", str(value or "").lower())
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    return " ".join("".join(ch if ch.isalnum() else " " for ch in text).split())


def end_of_next_month(now: datetime) -> datetime:
    year, month = now.year, now.month + 1
    if month == 13:
        year, month = year + 1, 1
    last = calendar.monthrange(year, month)[1]
    return datetime.combine(datetime(year, month, last).date(), time.max, tzinfo=TZ)


def espn_logo(team_id: Any) -> str:
    value = str(team_id or "").strip()
    return f"https://a.espncdn.com/i/teamlogos/soccer/500/{value}.png" if value else ""


def team_from_brasileirao(raw: Any) -> dict[str, Any]:
    item = raw if isinstance(raw, Mapping) else {"nome": raw}
    return {
        "espn_id": str(item.get("espn_id") or item.get("id") or ""),
        "nome": str(item.get("nome") or item.get("displayName") or item.get("name") or "Time"),
        "sigla": str(item.get("sigla") or item.get("abbreviation") or ""),
        "escudo": str(item.get("escudo") or item.get("logo") or ""),
        "pais": "BRA",
        "serie_a_2026": True,
    }


def team_from_cup(raw: Any) -> dict[str, Any]:
    item = raw if isinstance(raw, Mapping) else {"nome": raw}
    team_id = str(item.get("espn_id") or item.get("id") or "")
    return {
        "espn_id": team_id,
        "nome": str(item.get("nome") or item.get("nome_espn") or item.get("displayName") or item.get("name") or "Time"),
        "sigla": str(item.get("sigla") or item.get("abbreviation") or ""),
        "escudo": str(item.get("escudo") or item.get("logo") or espn_logo(team_id)),
        "pais": str(item.get("pais") or ""),
        "serie_a_2026": item.get("serie_a_2026") is True,
    }


def probabilities_ids(root: Path) -> set[str]:
    data = load_json(root / "dados-br" / "probabilidades-jogos.json", {"jogos": []})
    return {
        str(item.get("event_id") or "")
        for item in data.get("jogos") or []
        if isinstance(item, Mapping) and item.get("event_id")
    }


def brasileirao_games(root: Path, probability_ids: set[str]) -> Iterable[dict[str, Any]]:
    data = load_json(root / "jogos.json", {"jogos": []})
    for raw in data.get("jogos") or []:
        if not isinstance(raw, Mapping):
            continue
        event_id = str(raw.get("event_id") or "")
        yield {
            "event_id": event_id,
            "competicao_chave": "brasileirao",
            "competicao_nome": "Campeonato Brasileiro Série A",
            "competicao_nome_curto": "Brasileirão",
            "espn_league": "bra.1",
            "data_iso": str(raw.get("data_iso") or ""),
            "estado": str(raw.get("estado") or "pre").lower(),
            "concluido": str(raw.get("estado") or "").lower() == "post",
            "status": str(raw.get("status") or ""),
            "rodada": int(raw.get("rodada") or 0),
            "fase": "",
            "perna": None,
            "estadio": str(raw.get("estadio") or ""),
            "mandante": team_from_brasileirao(raw.get("mandante")),
            "visitante": team_from_brasileirao(raw.get("visitante")),
            "placar_mandante": raw.get("placar_mandante"),
            "placar_visitante": raw.get("placar_visitante"),
            "adiado": raw.get("adiado") is True,
            "data_definir": raw.get("data_definir") is True,
            "possui_clube_serie_a_2026": True,
            "probabilidades_disponiveis": bool(event_id and event_id in probability_ids),
            "fonte": "jogos.json",
        }


def cup_games(spec: Mapping[str, Any]) -> Iterable[dict[str, Any]]:
    data = load_json(Path(spec["arquivo"]), {"eventos": []})
    competition = data.get("competicao") if isinstance(data.get("competicao"), Mapping) else {}
    league = str(competition.get("espn_league") or spec["espn_league"])
    for raw in data.get("eventos") or []:
        if not isinstance(raw, Mapping):
            continue
        home = team_from_cup(raw.get("mandante"))
        away = team_from_cup(raw.get("visitante"))
        if not (home["serie_a_2026"] or away["serie_a_2026"]):
            continue
        yield {
            "event_id": str(raw.get("event_id") or ""),
            "competicao_chave": str(spec["chave"]),
            "competicao_nome": str(competition.get("nome") or spec["nome"]),
            "competicao_nome_curto": str(spec["nome_curto"]),
            "espn_league": league,
            "data_iso": str(raw.get("data_iso") or ""),
            "estado": str(raw.get("estado") or "pre").lower(),
            "concluido": raw.get("concluido") is True,
            "status": str(raw.get("status") or ""),
            "rodada": 0,
            "fase": str(raw.get("fase") or ""),
            "perna": raw.get("perna"),
            "estadio": str(raw.get("estadio") or ""),
            "mandante": home,
            "visitante": away,
            "placar_mandante": (raw.get("mandante") or {}).get("placar") if isinstance(raw.get("mandante"), Mapping) else None,
            "placar_visitante": (raw.get("visitante") or {}).get("placar") if isinstance(raw.get("visitante"), Mapping) else None,
            "adiado": False,
            "data_definir": not bool(raw.get("data_iso")),
            "possui_clube_serie_a_2026": True,
            "probabilidades_disponiveis": False,
            "fonte": str(Path(spec["arquivo"]).relative_to(ROOT)),
        }


def build(root: Path, now: datetime) -> dict[str, Any]:
    now = now.astimezone(TZ).replace(microsecond=0)
    start = datetime.combine(now.date(), time.min, tzinfo=TZ)
    end = end_of_next_month(now)
    probs = probabilities_ids(root)

    candidates = list(brasileirao_games(root, probs))
    for spec in COMPETICOES:
        candidates.extend(cup_games(spec))

    games: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for item in candidates:
        date = parse_dt(item.get("data_iso"))
        if item.get("data_definir") is True or date is None or not (start <= date <= end):
            continue
        key = (str(item.get("competicao_chave") or ""), str(item.get("event_id") or ""))
        if key in seen:
            continue
        seen.add(key)
        item = dict(item)
        item["data_iso"] = date.replace(second=0, microsecond=0).isoformat()
        games.append(item)

    games.sort(key=lambda game: (
        str(game.get("data_iso") or ""),
        str(game.get("competicao_nome_curto") or ""),
        str((game.get("mandante") or {}).get("nome") or ""),
    ))

    counts: dict[str, int] = {}
    for game in games:
        key = str(game.get("competicao_chave") or "")
        counts[key] = counts.get(key, 0) + 1

    return {
        "schema_version": 1,
        "projeto": "Fórmula do Gol",
        "tipo": "agenda_clubes_brasileirao",
        "descricao": "Agenda do Brasileirão e dos clubes da Série A 2026 na Copa do Brasil, Libertadores e Sul-Americana.",
        "gerado_em": now.isoformat(),
        "periodo": {
            "inicio": start.isoformat(),
            "fim": end.isoformat(),
            "regra": "de hoje até o último dia do mês seguinte",
        },
        "filtros": {
            "brasileirao": "todos os jogos publicados",
            "copas": "somente partidas com ao menos um clube da Série A 2026",
            "probabilidades": "disponíveis apenas para partidas do Brasileirão com saída AF-Previsão publicada",
        },
        "resumo": {
            "total_jogos": len(games),
            "por_competicao": counts,
        },
        "jogos": games,
    }


def atomic_write(path: Path, payload: Mapping[str, Any]) -> bool:
    """Grava apenas quando o conteúdo editorial mudou.

    O horário de execução não deve criar commits a cada ciclo dos workflows.
    Quando todo o restante é idêntico, preservamos ``gerado_em`` e não
    reescrevemos o arquivo.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    output = dict(payload)
    if path.exists():
        previous = load_json(path, {})
        if isinstance(previous, Mapping):
            comparable_previous = dict(previous)
            comparable_output = dict(output)
            comparable_previous.pop("gerado_em", None)
            comparable_output.pop("gerado_em", None)
            if comparable_previous == comparable_output:
                return False
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return True


def selftest() -> None:
    fake_now = datetime(2026, 8, 4, 17, 0, tzinfo=TZ)
    assert end_of_next_month(fake_now).date().isoformat() == "2026-09-30"
    assert parse_dt("2026-08-04T19:30:00-03:00").hour == 19
    assert norm("Sul-Americana") == "sul americana"
    sample = team_from_cup({"espn_id": "123", "nome": "Exemplo", "serie_a_2026": False})
    assert sample["escudo"].endswith("/123.png")
    print("self-test OK")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--now", help="Data/hora ISO para execução determinística")
    parser.add_argument("--output", default=str(OUTPUT))
    parser.add_argument("--self-test", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.self_test:
        selftest()
        return 0
    now = parse_dt(args.now) if args.now else datetime.now(TZ)
    if now is None:
        raise SystemExit("--now inválido")
    payload = build(ROOT, now)
    changed = atomic_write(Path(args.output), payload)
    verb = "atualizada" if changed else "já estava atualizada"
    print(
        f"Agenda {verb}: {payload['resumo']['total_jogos']} jogos, "
        f"período {payload['periodo']['inicio'][:10]} a {payload['periodo']['fim'][:10]}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
