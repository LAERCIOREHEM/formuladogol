#!/usr/bin/env python3
"""Gera a agenda complementar dos clubes do Brasileirão.

A saída reúne:
- todos os jogos do Brasileirão publicados em ``jogos.json`` e, quando o feed
  corrente estiver incompleto, complementados pelo calendário canônico de 380 jogos;
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
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from atualizar_espn import para_canonico  # noqa: E402
from fontes_brasileirao import CBFAgendaPartida, buscar_agenda_cbf  # noqa: E402

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


def club_metadata(root: Path) -> dict[str, dict[str, Any]]:
    data = load_json(root / "dados-br" / "clubes.json", {"clubes": []})
    out: dict[str, dict[str, Any]] = {}
    for raw in data.get("clubes") or []:
        if not isinstance(raw, Mapping):
            continue
        name = str(raw.get("nome") or "").strip()
        if not name:
            continue
        out[norm(name)] = {
            "nome": name,
            "sigla": str(raw.get("sigla") or ""),
            "escudo": str(raw.get("escudo") or ""),
        }
    return out


def brasileirao_team_from_name(name: Any, metadata: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    raw_name = str(name or "Time").strip() or "Time"
    meta = metadata.get(norm(raw_name), {})
    return team_from_brasileirao({
        "nome": str(meta.get("nome") or raw_name),
        "sigla": str(meta.get("sigla") or ""),
        "escudo": str(meta.get("escudo") or ""),
    })


def _rodadas_com_kickoff_provisorio(rows: Iterable[Mapping[str, Any]]) -> set[int]:
    """Detecta lote ESPN claramente provisório sem inventar horário.

    Quando o feed corrente conhece menos de 10 jogos de uma rodada e publica
    pelo menos quatro deles no EXATO mesmo instante, tratamos esse timestamp
    como placeholder até a grade se detalhar ou a CBF confirmar o confronto.
    A regra não atinge uma rodada completa (inclusive a R38, que pode ser
    legitimamente simultânea) e confirmação CBF sempre prevalece depois.
    """
    por_rodada: dict[int, list[str]] = {}
    for raw in rows:
        if not isinstance(raw, Mapping):
            continue
        rodada = int(raw.get("rodada") or 0)
        data_iso = str(raw.get("data_iso") or "").strip()
        estado = str(raw.get("estado") or "pre").lower()
        if not (1 <= rodada <= 38) or not data_iso or estado == "post" or raw.get("data_definir") is True:
            continue
        por_rodada.setdefault(rodada, []).append(data_iso)
    return {
        rodada
        for rodada, datas in por_rodada.items()
        if 4 <= len(datas) < 10 and len(set(datas)) == 1
    }


def brasileirao_games(
    root: Path,
    probability_ids: set[str],
    official_schedule: Iterable[CBFAgendaPartida] = (),
) -> Iterable[dict[str, Any]]:
    data = load_json(root / "jogos.json", {"jogos": []})
    calendar_data = load_json(root / "dados-br" / "calendario-completo.json", {"jogos": []})
    metadata = club_metadata(root)
    official_by_matchup = {
        (norm(row.mandante), norm(row.visitante)): row
        for row in official_schedule
    }
    canonical_round_by_matchup: dict[tuple[str, str], int] = {}
    for item in calendar_data.get("jogos") or []:
        if not isinstance(item, Mapping):
            continue
        home_name = str(item.get("mandante") or "").strip()
        away_name = str(item.get("visitante") or "").strip()
        round_no = int(item.get("rodada") or 0)
        if home_name and away_name and round_no:
            canonical_round_by_matchup[(norm(home_name), norm(away_name))] = round_no
    seen_ids: set[str] = set()
    seen_matchups: set[tuple[str, str]] = set()
    round_counts: dict[int, int] = {}
    raw_rows = list(data.get("jogos") or [])
    for raw in raw_rows:
        if isinstance(raw, Mapping):
            round_no = int(raw.get("rodada") or 0)
            if round_no:
                round_counts[round_no] = round_counts.get(round_no, 0) + 1
    provisional_rounds = _rodadas_com_kickoff_provisorio(raw_rows)

    for raw in raw_rows:
        if not isinstance(raw, Mapping):
            continue
        event_id = str(raw.get("event_id") or "").strip()
        home = team_from_brasileirao(raw.get("mandante"))
        away = team_from_brasileirao(raw.get("visitante"))
        if event_id:
            seen_ids.add(event_id)
        seen_matchups.add((norm(home.get("nome")), norm(away.get("nome"))))
        matchup = (norm(home.get("nome")), norm(away.get("nome")))
        canonical_round = canonical_round_by_matchup.get(matchup, int(raw.get("rodada") or 0))
        official = official_by_matchup.get(matchup)
        raw_date = str(raw.get("data_iso") or "")
        official_date = str(official.data_iso if official else "")
        chosen_date = official_date or raw_date
        provisional = canonical_round in provisional_rounds and not official_date
        raw_status = str(raw.get("status") or "")
        official_resolved = bool(official_date)
        public_status = raw_status
        if official_resolved and ("data a definir" in raw_status.lower() or "adiad" in raw_status.lower()):
            public_status = "Agendado"
        yield {
            "event_id": event_id,
            "competicao_chave": "brasileirao",
            "competicao_nome": "Campeonato Brasileiro Série A",
            "competicao_nome_curto": "Brasileirão",
            "espn_league": "bra.1",
            "data_iso": chosen_date,
            "estado": str(raw.get("estado") or "pre").lower(),
            "concluido": str(raw.get("estado") or "").lower() == "post",
            "status": public_status,
            "rodada": canonical_round,
            "fase": "",
            "perna": None,
            "estadio": str(raw.get("estadio") or ""),
            "mandante": home,
            "visitante": away,
            "placar_mandante": raw.get("placar_mandante"),
            "placar_visitante": raw.get("placar_visitante"),
            # Confirmação CBF de data/hora encerra o estado corrente de adiamento,
            # mesmo que um snapshot/manual antigo ainda carregue esse marcador.
            "adiado": False if official_resolved else raw.get("adiado") is True,
            "data_definir": bool((raw.get("data_definir") is True or provisional) and not official_date),
            "possui_clube_serie_a_2026": True,
            "probabilidades_disponiveis": bool(event_id and event_id in probability_ids),
            "fonte": "jogos.json",
            "fonte_calendario": "CBF oficial — agenda de credenciamento" if official else str(raw.get("fonte_calendario") or "ESPN"),
            "origem_calendario": official.origem if official else str(raw.get("origem_calendario") or ""),
            "data_fonte_anterior": raw_date if official_date and raw_date and raw_date != official_date else "",
        }

    # O feed operacional pode omitir temporariamente uma partida futura mesmo
    # quando o calendário canônico de 380 jogos já possui event_id/data válidos.
    # A agenda não pode herdar esse buraco: complementa apenas jogos ausentes,
    # sem sobrescrever estado/placar de jogos.json.
    for raw in calendar_data.get("jogos") or []:
        if not isinstance(raw, Mapping):
            continue
        event_id = str(raw.get("event_id") or "").strip()
        home_name = str(raw.get("mandante") or "").strip()
        away_name = str(raw.get("visitante") or "").strip()
        if not home_name or not away_name:
            continue
        matchup = (norm(home_name), norm(away_name))
        if (event_id and event_id in seen_ids) or matchup in seen_matchups:
            continue
        round_no = int(raw.get("rodada") or 0)
        official = official_by_matchup.get(matchup)
        official_date = str(official.data_iso if official else "")
        raw_date = str(raw.get("data_iso") or "").strip()
        # Sem confirmação oficial, o fallback continua conservador e só repara
        # buraco em rodada já amplamente detalhada pelo feed. Quando a própria
        # CBF publicou o kickoff, ela autoriza a entrada mesmo que a ESPN ainda
        # tenha menos de oito jogos ou data placeholder/a definir.
        if round_counts.get(round_no, 0) < 8 and not official:
            continue
        chosen_date = official_date or raw_date
        if (raw.get("data_definir") is True and not official) or not chosen_date:
            continue
        yield {
            "event_id": event_id,
            "competicao_chave": "brasileirao",
            "competicao_nome": "Campeonato Brasileiro Série A",
            "competicao_nome_curto": "Brasileirão",
            "espn_league": "bra.1",
            "data_iso": chosen_date,
            "estado": str(raw.get("estado") or "pre").lower(),
            "concluido": raw.get("concluido") is True,
            "status": "pré-jogo",
            "rodada": int(raw.get("rodada") or 0),
            "fase": "",
            "perna": None,
            "estadio": str(raw.get("estadio") or ""),
            "mandante": brasileirao_team_from_name(home_name, metadata),
            "visitante": brasileirao_team_from_name(away_name, metadata),
            "placar_mandante": None,
            "placar_visitante": None,
            "adiado": raw.get("adiado") is True,
            "data_definir": False,
            "possui_clube_serie_a_2026": True,
            "probabilidades_disponiveis": bool(event_id and event_id in probability_ids),
            "fonte": "dados-br/calendario-completo.json (fallback canônico)",
            "fonte_calendario": "CBF oficial — agenda de credenciamento" if official else str(raw.get("fonte_calendario") or "calendário canônico"),
            "origem_calendario": official.origem if official else str(raw.get("origem_calendario") or ""),
            "data_fonte_anterior": raw_date if official_date and raw_date and raw_date != official_date else "",
        }


def _continental_tie_key(raw: Mapping[str, Any]) -> tuple[str, str]:
    home = raw.get("mandante") if isinstance(raw.get("mandante"), Mapping) else {}
    away = raw.get("visitante") if isinstance(raw.get("visitante"), Mapping) else {}
    ids = [str(home.get("espn_id") or home.get("nome") or ""), str(away.get("espn_id") or away.get("nome") or "")]
    return tuple(sorted(ids))


def _continental_aggregate(data: Mapping[str, Any], raw: Mapping[str, Any]) -> dict[str, Any]:
    """Agregado orientado pelo mandante/visitante do jogo exibido.

    Na ida mostra o placar acumulado da própria ida. Antes da volta, considera
    somente a ida concluída; durante/depois da volta soma também o placar atual.
    """
    try:
        leg = int(raw.get("perna") or 0)
        rank = int(raw.get("fase_ordem") or 0)
    except (TypeError, ValueError):
        return {}
    if leg not in {1, 2} or rank < 600:
        return {}
    key = _continental_tie_key(raw)
    home = raw.get("mandante") if isinstance(raw.get("mandante"), Mapping) else {}
    away = raw.get("visitante") if isinstance(raw.get("visitante"), Mapping) else {}
    hid, aid = str(home.get("espn_id") or home.get("nome") or ""), str(away.get("espn_id") or away.get("nome") or "")
    totals = {hid: 0, aid: 0}
    used = 0
    current_id = str(raw.get("event_id") or "")
    for event in data.get("eventos") or []:
        if not isinstance(event, Mapping) or int(event.get("fase_ordem") or 0) != rank or _continental_tie_key(event) != key:
            continue
        event_leg = int(event.get("perna") or 0)
        include = bool(event.get("concluido")) or str(event.get("event_id") or "") == current_id
        if event_leg > leg or not include:
            continue
        eh = event.get("mandante") if isinstance(event.get("mandante"), Mapping) else {}
        ea = event.get("visitante") if isinstance(event.get("visitante"), Mapping) else {}
        ehid, eaid = str(eh.get("espn_id") or eh.get("nome") or ""), str(ea.get("espn_id") or ea.get("nome") or "")
        if ehid in totals and eaid in totals:
            totals[ehid] += int(eh.get("placar") or 0); totals[eaid] += int(ea.get("placar") or 0); used += 1
    return {
        "confronto_id": "-".join(key),
        "partida_numero": leg,
        "partidas_total": 2,
        "agregado_mandante": totals.get(hid, 0),
        "agregado_visitante": totals.get(aid, 0),
        "agregado_disponivel": used > 0,
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
        knockout = _continental_aggregate(data, raw) if str(spec["chave"]) in {"libertadores", "sul_americana"} else {}
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
            **knockout,
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


def build(
    root: Path, now: datetime, official_schedule: Iterable[CBFAgendaPartida] = ()
) -> dict[str, Any]:
    now = now.astimezone(TZ).replace(microsecond=0)
    start = datetime.combine(now.date(), time.min, tzinfo=TZ)
    end = end_of_next_month(now)
    probs = probabilities_ids(root)

    candidates = list(brasileirao_games(root, probs, official_schedule))
    for spec in COMPETICOES:
        candidates.extend(cup_games(spec))

    games: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for item in candidates:
        date = parse_dt(item.get("data_iso"))
        if item.get("data_definir") is True or date is None or not (start <= date <= end):
            continue
        event_id = str(item.get("event_id") or "").strip()
        if event_id:
            identity = f"id:{event_id}"
        else:
            identity = "match:" + "|".join((
                norm((item.get("mandante") or {}).get("nome") if isinstance(item.get("mandante"), Mapping) else item.get("mandante")),
                norm((item.get("visitante") or {}).get("nome") if isinstance(item.get("visitante"), Mapping) else item.get("visitante")),
                date.strftime("%Y-%m-%dT%H:%M"),
            ))
        key = (str(item.get("competicao_chave") or ""), identity)
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
            "brasileirao": "jogos publicados + fallback canônico para partidas futuras ausentes do feed corrente",
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
    fallback_team = brasileirao_team_from_name("Palmeiras", {"palmeiras": {"nome": "Palmeiras", "sigla": "PAL", "escudo": "x.svg"}})
    assert fallback_team["sigla"] == "PAL" and fallback_team["escudo"] == "x.svg"
    official = CBFAgendaPartida(
        mandante="Atlético-MG", visitante="Grêmio", data_iso="2026-08-16T16:00", origem="teste"
    )
    assert official.data_iso == "2026-08-16T16:00"
    provisional = [
        {"rodada": 26, "data_iso": "2026-09-05T15:00", "estado": "pre"}
        for _ in range(7)
    ]
    assert _rodadas_com_kickoff_provisorio(provisional) == {26}
    # Rodada completa simultânea não é tratada como placeholder: a R38 pode
    # legitimamente ter todos os jogos no mesmo horário.
    assert _rodadas_com_kickoff_provisorio(provisional + [
        {"rodada": 26, "data_iso": "2026-09-05T15:00", "estado": "pre"}
        for _ in range(3)
    ]) == set()
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
    official_schedule: list[CBFAgendaPartida] = []
    try:
        official_schedule = buscar_agenda_cbf(resolver=para_canonico)
        print(f"Agenda oficial CBF: {len(official_schedule)} kickoffs disponíveis para reconciliação.")
    except Exception as exc:  # noqa: BLE001
        # A agenda pública nunca deixa de ser gerada por indisponibilidade da
        # fonte complementar. Nesse cenário, conserva o fluxo ESPN/canônico.
        print(f"::warning::Agenda CBF indisponível; mantendo fontes locais: {type(exc).__name__}: {exc}")
    payload = build(ROOT, now, official_schedule)
    changed = atomic_write(Path(args.output), payload)
    verb = "atualizada" if changed else "já estava atualizada"
    print(
        f"Agenda {verb}: {payload['resumo']['total_jogos']} jogos, "
        f"período {payload['periodo']['inicio'][:10]} a {payload['periodo']['fim'][:10]}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
