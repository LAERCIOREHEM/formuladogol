#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gerar_estatisticas_competicao_brasileirao.py

Consolida estatísticas gerais do Brasileirão a partir de dados ESPN já
normalizados pelo projeto.

Saída:
  - dados-br/estatisticas-competicao.json

Inclui:
  * performance por partida;
  * sequências máximas e atuais;
  * público (máximo, mínimo, média e total);
  * gols por clube;
  * marcadores conhecidos por clube;
  * índice de jogos para a futura tela "Por jogo".
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from atualizar_espn import CANONICOS, ESCUDOS_TIMES, FUSO_BRASILIA, para_canonico  # type: ignore

OUT = ROOT / "dados-br" / "estatisticas-competicao.json"


def now_iso() -> str:
    return datetime.now(FUSO_BRASILIA).isoformat()


def norm(v: Any) -> str:
    s = unicodedata.normalize("NFD", str(v or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def parse_date(v: Any) -> datetime:
    s = str(v or "")
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return datetime(1970, 1, 1, tzinfo=FUSO_BRASILIA)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=FUSO_BRASILIA)
    return dt.astimezone(FUSO_BRASILIA)


def team_name(obj: Any) -> str:
    if isinstance(obj, dict):
        return para_canonico(obj.get("nome"), obj.get("name"), obj.get("sigla")) or str(obj.get("nome") or obj.get("name") or "")
    return para_canonico(obj) or str(obj or "")


def result_code(game: dict[str, Any], team: str) -> str | None:
    home = team_name(game.get("mandante"))
    away = team_name(game.get("visitante"))
    try:
        hg = int(game.get("placar_mandante"))
        ag = int(game.get("placar_visitante"))
    except (TypeError, ValueError):
        return None
    if team == home:
        return "V" if hg > ag else "E" if hg == ag else "D"
    if team == away:
        return "V" if ag > hg else "E" if hg == ag else "D"
    return None


def game_brief(game: dict[str, Any], details: dict[str, Any] | None = None) -> dict[str, Any]:
    details = details or {}
    return {
        "event_id": str(game.get("event_id") or ""),
        "rodada": int(game.get("rodada") or 0),
        "data_iso": str(game.get("data_iso") or ""),
        "mandante": team_name(game.get("mandante")),
        "visitante": team_name(game.get("visitante")),
        "placar_mandante": game.get("placar_mandante"),
        "placar_visitante": game.get("placar_visitante"),
        "estadio": str(details.get("estadio") or game.get("estadio") or ""),
        "publico": details.get("publico"),
        "arbitro": str(details.get("arbitro") or ""),
        "tem_estatisticas": bool(details.get("stats") or details.get("estatisticas")),
        "tem_eventos": bool(details.get("gols") or details.get("cartoes")),
    }


def performance_records(results: list[dict[str, Any]], details: dict[str, Any]) -> dict[str, Any]:
    if not results:
        return {}

    def hg(g: dict[str, Any]) -> int:
        return int(g.get("placar_mandante") or 0)

    def ag(g: dict[str, Any]) -> int:
        return int(g.get("placar_visitante") or 0)

    def record(label: str, key: Callable[[dict[str, Any]], tuple[Any, ...]]) -> dict[str, Any]:
        game = max(results, key=key)
        d = details.get(str(game.get("event_id") or ""), {})
        out = game_brief(game, d)
        out["categoria"] = label
        return out

    return {
        "mais_gols_mandante": record("Mais gols do mandante", lambda g: (hg(g), hg(g) + ag(g), parse_date(g.get("data_iso")))),
        "mais_gols_visitante": record("Mais gols do visitante", lambda g: (ag(g), hg(g) + ag(g), parse_date(g.get("data_iso")))),
        "maior_margem_vitoria": record("Maior margem de vitória", lambda g: (abs(hg(g) - ag(g)), hg(g) + ag(g), parse_date(g.get("data_iso")))),
        "jogo_com_mais_gols": record("Jogo com mais gols", lambda g: (hg(g) + ag(g), abs(hg(g) - ag(g)), parse_date(g.get("data_iso")))),
    }


def longest_run(codes: list[str], predicate: Callable[[str], bool]) -> int:
    best = cur = 0
    for code in codes:
        if predicate(code):
            cur += 1
            best = max(best, cur)
        else:
            cur = 0
    return best


def current_run(codes: list[str], predicate: Callable[[str], bool]) -> int:
    cur = 0
    for code in reversed(codes):
        if predicate(code):
            cur += 1
        else:
            break
    return cur


def sequence_rankings(results: list[dict[str, Any]]) -> dict[str, Any]:
    by_team: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for game in sorted(results, key=lambda g: parse_date(g.get("data_iso"))):
        home = team_name(game.get("mandante"))
        away = team_name(game.get("visitante"))
        if home:
            by_team[home].append(game)
        if away:
            by_team[away].append(game)

    definitions = {
        "vitorias": (lambda c: c == "V", "vitórias"),
        "invencibilidade": (lambda c: c != "D", "jogos invicto"),
        "derrotas": (lambda c: c == "D", "derrotas"),
        "sem_vencer": (lambda c: c != "V", "jogos sem vencer"),
    }
    output: dict[str, Any] = {}
    for key, (predicate, label) in definitions.items():
        all_rows = []
        current_rows = []
        for team in CANONICOS:
            codes = [result_code(g, team) for g in by_team.get(team, [])]
            codes = [c for c in codes if c]
            all_rows.append({"time": team, "quantidade": longest_run(codes, predicate), "rotulo": label})
            current_rows.append({"time": team, "quantidade": current_run(codes, predicate), "rotulo": label})
        all_rows.sort(key=lambda x: (-int(x["quantidade"]), norm(x["time"])))
        current_rows.sort(key=lambda x: (-int(x["quantidade"]), norm(x["time"])))
        output[key] = {
            "maior": all_rows[0] if all_rows else None,
            "atual": current_rows[0] if current_rows else None,
            "todos_maiores": all_rows,
            "todos_atuais": current_rows,
        }
    return output


def attendance_stats(results: list[dict[str, Any]], details: dict[str, Any]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for game in results:
        d = details.get(str(game.get("event_id") or ""), {})
        value = d.get("publico")
        try:
            crowd = int(value)
        except (TypeError, ValueError):
            continue
        if crowd <= 0:
            continue
        row = game_brief(game, d)
        row["publico"] = crowd
        rows.append(row)
    rows.sort(key=lambda x: int(x["publico"]), reverse=True)
    total = sum(int(x["publico"]) for x in rows)
    return {
        "jogos_com_publico": len(rows),
        "jogos_sem_publico": max(0, len(results) - len(rows)),
        "total_publico": total,
        "media_publico": round(total / len(rows)) if rows else None,
        "maior_publico": rows[0] if rows else None,
        "menor_publico": rows[-1] if rows else None,
        "ranking": rows,
        "observacao": "Média calculada apenas sobre jogos com público informado pela ESPN.",
    }


def club_goals(table: list[dict[str, Any]], leaders: dict[str, Any]) -> list[dict[str, Any]]:
    scorers_by_team: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for player in leaders.get("artilharia") or []:
        team = para_canonico(player.get("time")) or str(player.get("time") or "")
        if team:
            scorers_by_team[team].append(dict(player))
    output = []
    for row in table:
        team = para_canonico(row.get("time")) or str(row.get("time") or "")
        if not team:
            continue
        scorers = sorted(scorers_by_team.get(team, []), key=lambda x: (-int(x.get("gols") or 0), norm(x.get("nome"))))
        known = sum(int(x.get("gols") or 0) for x in scorers)
        total_goals = int(row.get("gp") or 0)
        difference = max(0, total_goals - known)
        output.append({
            "time": team,
            "escudo": (ESCUDOS_TIMES.get(team) or {}).get("escudo", ""),
            "jogos": int(row.get("jogos") or 0),
            "gols_pro": total_goals,
            "gols_contra": int(row.get("gc") or 0),
            "saldo": int(row.get("sg") or 0),
            "media_gols": round(total_goals / int(row.get("jogos") or 1), 2) if int(row.get("jogos") or 0) else 0,
            "marcadores": scorers,
            "gols_mapeados_nos_lideres": known,
            "gols_nao_individualizados": difference,
        })
    output.sort(key=lambda x: (-int(x["gols_pro"]), -int(x["saldo"]), norm(x["time"])))
    for i, row in enumerate(output, 1):
        row["posicao"] = i
    return output


def main() -> None:
    table_data = read_json(ROOT / "tabela.json", {})
    results_data = read_json(ROOT / "resultados.json", {})
    details_data = read_json(ROOT / "dados-br" / "jogos-detalhes.json", {})
    leaders = read_json(ROOT / "dados-br" / "lideres-jogadores.json", {})

    table = [x for x in table_data.get("tabela") or [] if isinstance(x, dict)]
    results = [x for x in results_data.get("resultados") or [] if isinstance(x, dict)]
    details = details_data.get("jogos") or {}
    if not isinstance(details, dict):
        details = {}
    if len(table) != 20:
        raise RuntimeError(f"tabela.json deve ter 20 clubes; recebido {len(table)}")
    if not results:
        raise RuntimeError("resultados.json sem jogos finalizados")
    if leaders.get("status") != "valido":
        raise RuntimeError("dados-br/lideres-jogadores.json ainda não está válido")

    games_index = [game_brief(g, details.get(str(g.get("event_id") or ""), {})) for g in results]
    games_index.sort(key=lambda x: parse_date(x.get("data_iso")), reverse=True)

    payload = {
        "atualizado_em": now_iso(),
        "temporada": int(leaders.get("temporada") or 2026),
        "fonte": "ESPN · tabela, resultados e eventos validados dos summaries",
        "resumo": {
            "jogos_finalizados": len(results),
            "jogos_com_estatisticas": sum(1 for x in games_index if x["tem_estatisticas"]),
            "jogos_com_publico": sum(1 for x in games_index if x.get("publico") not in (None, "")),
            "clubes": len(table),
        },
        "performance_por_partida": performance_records(results, details),
        "sequencias": sequence_rankings(results),
        "publico": attendance_stats(results, details),
        "gols_por_clube": club_goals(table, leaders),
        "jogos": games_index,
    }
    write_json(OUT, payload)
    print(f"OK: estatísticas da competição em {OUT.relative_to(ROOT)}")
    print(json.dumps(payload["resumo"], ensure_ascii=False))


if __name__ == "__main__":
    main()
