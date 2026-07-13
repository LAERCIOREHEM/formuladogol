#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
buscar_lideres_jogadores_espn.py

Busca os rankings oficiais de gols e assistências da temporada do Brasileirão
nas fontes JSON que alimentam as páginas de estatísticas da ESPN.

Saídas:
  - dados-br/lideres-jogadores.json
  - dados-br/auditoria-lideres-jogadores.json

Princípios:
  * não usa summary de partida para reconstruir a classificação da temporada;
  * tenta múltiplas rotas ESPN e múltiplos formatos de resposta;
  * preserva o último snapshot válido se a ESPN oscilar;
  * rejeita nomes contaminados por texto de narração;
  * nunca publica lista vazia ou regressão catastrófica.

Somente biblioteca padrão.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from atualizar_espn import ESCUDOS_TIMES, FUSO_BRASILIA, HEADERS, para_canonico  # type: ignore

TEMPORADA = int(os.environ.get("BRASILEIRAO_TEMPORADA", "2026"))
SAIDA = ROOT / "dados-br" / "lideres-jogadores.json"
AUDITORIA = ROOT / "dados-br" / "auditoria-lideres-jogadores.json"

SUSPICIOUS_NAME_TOKENS = (
    " with a ", " with the ", " cross", " right foot", " left foot", " header",
    " assisted by", " from the ", " shot", " penalty", " own goal", " attempt",
    " goal!", " substitution", " yellow card", " red card",
)

STAT_ALIASES = {
    "gols": {"goals", "goal", "gols", "gol", "total goals", "goals scored"},
    "assistencias": {"assists", "assist", "assistencias", "assistência", "assists total"},
    "jogos": {"appearances", "games played", "games", "matches", "jogos", "partidas", "apps"},
}


def agora_brt() -> datetime:
    return datetime.now(FUSO_BRASILIA)


def iso_agora_brt() -> str:
    return agora_brt().isoformat()


def norm(v: Any) -> str:
    s = unicodedata.normalize("NFD", str(v or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", s)
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def num(v: Any) -> float | None:
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    m = re.search(r"-?\d+(?:[\.,]\d+)?", str(v))
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", "."))
    except ValueError:
        return None


def int_num(v: Any) -> int | None:
    n = num(v)
    return None if n is None else int(round(n))


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def candidate_urls(stat: str) -> list[str]:
    sort_key = "goals" if stat == "gols" else "assists"
    q = urllib.parse.urlencode({
        "region": "br",
        "lang": "pt",
        "contentorigin": "espn",
        "isqualified": "true",
        "limit": "200",
        "sort": f"{sort_key}:desc",
        "season": str(TEMPORADA),
    })
    q_en = urllib.parse.urlencode({
        "region": "us",
        "lang": "en",
        "contentorigin": "espn",
        "isqualified": "true",
        "limit": "200",
        "sort": f"{sort_key}:desc",
        "season": str(TEMPORADA),
    })
    return [
        f"https://site.web.api.espn.com/apis/fittwo/v3/sports/soccer/bra.1/athletes?{q}",
        f"https://site.web.api.espn.com/apis/fittwo/v3/sports/soccer/bra.1/athletes?{q_en}",
        f"https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/athletes?season={TEMPORADA}&limit=200&sort={urllib.parse.quote(sort_key + ':desc')}",
        f"https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/leaders?season={TEMPORADA}&limit=200",
        f"https://site.web.api.espn.com/apis/v2/sports/soccer/bra.1/leaders?region=br&lang=pt&season={TEMPORADA}&limit=200",
        f"https://www.espn.com.br/futebol/estatisticas/_/liga/bra.1/temporada/{TEMPORADA}?xhr=1",
        f"https://www.espn.com/soccer/stats/_/league/bra.1/season/{TEMPORADA}?xhr=1",
    ]


def fetch_document(url: str, timeout: int = 30, attempts: int = 2) -> tuple[Any, str]:
    last: Exception | None = None
    headers = dict(HEADERS)
    headers.update({
        "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
        "Referer": "https://www.espn.com.br/",
    })
    for attempt in range(1, attempts + 1):
        try:
            sep = "&" if "?" in url else "?"
            req = urllib.request.Request(f"{url}{sep}_={int(time.time())}", headers=headers)
            with urllib.request.urlopen(req, timeout=timeout + 8 * (attempt - 1)) as resp:
                raw = resp.read()
                ctype = str(resp.headers.get("Content-Type") or "").lower()
                charset = resp.headers.get_content_charset() or "utf-8"
                text = raw.decode(charset, errors="replace")
                if "json" in ctype or text.lstrip().startswith(("{", "[")):
                    return json.loads(text), ctype
                embedded = extract_embedded_json(text)
                if embedded:
                    return embedded, ctype or "text/html"
                raise ValueError("HTML sem JSON incorporado utilizável")
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt < attempts:
                time.sleep(1.5 * attempt)
    raise RuntimeError(f"{type(last).__name__}: {last}")


def extract_embedded_json(text: str) -> dict[str, Any] | list[Any] | None:
    patterns = [
        r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>',
        r'<script[^>]+type=["\']application/json["\'][^>]*>(.*?)</script>',
        r'window\.__espn(?:fitt)?__\s*=\s*(\{.*?\})\s*;</script>',
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, text, flags=re.I | re.S):
            blob = html.unescape(match.group(1)).strip()
            try:
                data = json.loads(blob)
                if isinstance(data, (dict, list)):
                    return data
            except Exception:
                continue
    return None


def dict_name(d: dict[str, Any]) -> str:
    return str(
        d.get("displayName") or d.get("fullName") or d.get("shortDisplayName")
        or d.get("name") or d.get("shortName") or ""
    ).strip()


def athlete_from_item(item: dict[str, Any]) -> dict[str, Any] | None:
    candidates: list[dict[str, Any]] = []
    for key in ("athlete", "player", "person", "participant", "competitor"):
        if isinstance(item.get(key), dict):
            candidates.append(item[key])
    candidates.append(item)
    for a in candidates:
        name = dict_name(a)
        if not name:
            continue
        aid = str(a.get("id") or a.get("athleteId") or a.get("uid") or item.get("athleteId") or "").strip()
        return {"nome": name, "athlete_id": aid, "raw": a}
    return None


def team_from_item(item: dict[str, Any], athlete_raw: dict[str, Any] | None = None) -> tuple[str, str]:
    candidates: list[Any] = []
    for source in (item, athlete_raw or {}):
        for key in ("team", "club", "currentTeam", "teamInfo"):
            if isinstance(source.get(key), dict):
                candidates.append(source[key])
        for key in ("teamName", "clubName", "teamAbbreviation", "teamId"):
            if source.get(key):
                candidates.append(source.get(key))
    for t in candidates:
        if isinstance(t, dict):
            canon = para_canonico(
                t.get("displayName"), t.get("shortDisplayName"), t.get("name"),
                t.get("location"), t.get("abbreviation"), t.get("slug"), t.get("id"),
            )
            espn_id = str(t.get("id") or t.get("uid") or "").strip()
        else:
            canon = para_canonico(t)
            espn_id = str(t or "").strip() if str(t or "").isdigit() else ""
        if canon:
            return canon, espn_id
    return "", ""


def name_matches_stat(value: Any, stat: str) -> bool:
    n = norm(value)
    return any(n == norm(alias) or norm(alias) in n for alias in STAT_ALIASES[stat])


def stat_from_node(node: Any, stat: str) -> int | None:
    aliases = STAT_ALIASES[stat]
    if isinstance(node, dict):
        # Campos diretos.
        for key, value in node.items():
            nk = norm(key)
            if any(nk == norm(a) or norm(a) in nk for a in aliases):
                if isinstance(value, dict):
                    for vk in ("value", "displayValue", "total", "count"):
                        v = int_num(value.get(vk))
                        if v is not None:
                            return v
                else:
                    v = int_num(value)
                    if v is not None:
                        return v
        # Nós de estatística nome/valor.
        label = " ".join(str(node.get(k) or "") for k in (
            "name", "displayName", "shortDisplayName", "abbreviation", "label", "type", "description"
        ))
        if name_matches_stat(label, stat):
            for key in ("value", "displayValue", "total", "count", "stat"):
                v = int_num(node.get(key))
                if v is not None:
                    return v
        # Recursão limitada às áreas estatísticas.
        for key in ("statistics", "stats", "splits", "categories", "values", "totals", "seasonTotals"):
            if key in node:
                v = stat_from_node(node[key], stat)
                if v is not None:
                    return v
    elif isinstance(node, list):
        for item in node:
            v = stat_from_node(item, stat)
            if v is not None:
                return v
    return None


def item_value(item: dict[str, Any], stat: str, category_hint: str = "") -> int | None:
    value = stat_from_node(item, stat)
    if value is not None:
        return value
    if name_matches_stat(category_hint, stat):
        for key in ("value", "displayValue", "total", "count", "stat"):
            v = int_num(item.get(key))
            if v is not None:
                return v
    return None


def walk_candidates(node: Any, stat: str, category_hint: str = "", order_counter: list[int] | None = None) -> Iterable[tuple[dict[str, Any], str, int]]:
    if order_counter is None:
        order_counter = [0]
    if isinstance(node, dict):
        local_hint = category_hint
        label = " ".join(str(node.get(k) or "") for k in (
            "name", "displayName", "shortDisplayName", "label", "description", "type"
        ))
        if name_matches_stat(label, stat):
            local_hint = label
        athlete = athlete_from_item(node)
        if athlete:
            value = item_value(node, stat, local_hint)
            if value is not None:
                order_counter[0] += 1
                yield node, local_hint, order_counter[0]
        for key, value in node.items():
            child_hint = local_hint
            if name_matches_stat(key, stat):
                child_hint = key
            yield from walk_candidates(value, stat, child_hint, order_counter)
    elif isinstance(node, list):
        for item in node:
            yield from walk_candidates(item, stat, category_hint, order_counter)


def suspicious_name(name: str) -> bool:
    n = f" {norm(name)} "
    return len(name.strip()) < 2 or any(norm(tok) in n for tok in SUSPICIOUS_NAME_TOKENS)


def extract_ranking(payload: Any, stat: str) -> list[dict[str, Any]]:
    field = "gols" if stat == "gols" else "assistencias"
    dedup: dict[str, dict[str, Any]] = {}
    for item, hint, order in walk_candidates(payload, stat):
        athlete = athlete_from_item(item)
        if not athlete:
            continue
        name = athlete["nome"].strip()
        if suspicious_name(name):
            continue
        value = item_value(item, stat, hint)
        if value is None or value < 0:
            continue
        team, team_id = team_from_item(item, athlete.get("raw"))
        if not team:
            # Não publica jogador sem clube reconhecido no Brasileirão.
            continue
        games = stat_from_node(item, "jogos")
        key = athlete.get("athlete_id") or f"{norm(name)}|{norm(team)}"
        record = {
            "posicao_fonte": order,
            "athlete_id": athlete.get("athlete_id", ""),
            "nome": name,
            "time": team,
            "team_id": team_id,
            "escudo": (ESCUDOS_TIMES.get(team) or {}).get("escudo", ""),
            "jogos": games,
            field: int(value),
        }
        if games and games > 0:
            record["media_por_jogo"] = round(float(value) / games, 3)
        old = dedup.get(key)
        if old is None or int(record[field]) > int(old[field]):
            dedup[key] = record
    ranking = list(dedup.values())
    ranking.sort(key=lambda x: (-int(x[field]), int(x.get("posicao_fonte") or 9999), norm(x["nome"])))
    for pos, item in enumerate(ranking, 1):
        item["posicao"] = pos
        item.pop("posicao_fonte", None)
    return ranking


def validate_ranking(ranking: list[dict[str, Any]], stat: str, previous: list[dict[str, Any]] | None = None) -> list[str]:
    field = "gols" if stat == "gols" else "assistencias"
    errors: list[str] = []
    min_len = 5
    if len(ranking) < min_len:
        errors.append(f"{stat}: apenas {len(ranking)} jogador(es); mínimo {min_len}")
    if ranking:
        top = int(ranking[0].get(field) or 0)
        if top <= 0:
            errors.append(f"{stat}: líder com valor não positivo")
        values = [int(x.get(field) or 0) for x in ranking]
        if values != sorted(values, reverse=True):
            errors.append(f"{stat}: ranking fora de ordem")
        if len({(norm(x.get('nome')), norm(x.get('time'))) for x in ranking}) != len(ranking):
            errors.append(f"{stat}: jogadores duplicados")
        for item in ranking[:20]:
            if suspicious_name(str(item.get("nome") or "")):
                errors.append(f"{stat}: nome suspeito: {item.get('nome')}")
            if not item.get("time"):
                errors.append(f"{stat}: jogador sem clube: {item.get('nome')}")
    if previous:
        old_top = int((previous[0] or {}).get(field) or 0) if previous else 0
        new_top = int((ranking[0] or {}).get(field) or 0) if ranking else 0
        if old_top >= 5 and new_top < max(3, int(old_top * 0.60)):
            errors.append(f"{stat}: regressão catastrófica do líder ({old_top} -> {new_top})")
        if len(previous) >= 10 and len(ranking) < max(5, len(previous) // 2):
            errors.append(f"{stat}: lista caiu de {len(previous)} para {len(ranking)}")
    return errors


def load_previous() -> dict[str, Any]:
    data = read_json(SAIDA, {})
    return data if isinstance(data, dict) else {}


def collect_one(stat: str, fixture: Path | None = None) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str]:
    attempts_log: list[dict[str, Any]] = []
    if fixture:
        payload = json.loads(fixture.read_text(encoding="utf-8"))
        ranking = extract_ranking(payload, stat)
        return ranking, [{"url": str(fixture), "status": "fixture", "itens": len(ranking)}], str(fixture)

    for url in candidate_urls(stat):
        try:
            payload, ctype = fetch_document(url)
            ranking = extract_ranking(payload, stat)
            attempts_log.append({"url": url, "status": "ok", "content_type": ctype, "itens_extraidos": len(ranking)})
            if len(ranking) >= 5:
                return ranking, attempts_log, url
        except Exception as exc:  # noqa: BLE001
            attempts_log.append({"url": url, "status": "erro", "erro": str(exc)[:300]})
    return [], attempts_log, ""


def self_test() -> None:
    fixture = {
        "categories": [
            {
                "name": "goals",
                "leaders": [
                    {"value": 11, "athlete": {"id": "1", "displayName": "Kevin Viveros"}, "team": {"displayName": "Athletico Paranaense"}, "statistics": [{"name": "appearances", "value": 17}]},
                    {"value": 10, "athlete": {"id": "2", "displayName": "Pedro"}, "team": {"displayName": "Flamengo"}, "statistics": [{"name": "appearances", "value": 17}]},
                    {"value": 9, "athlete": {"id": "3", "displayName": "Carlos Vinícius"}, "team": {"displayName": "Grêmio"}},
                    {"value": 9, "athlete": {"id": "4", "displayName": "John Kennedy"}, "team": {"displayName": "Fluminense"}},
                    {"value": 8, "athlete": {"id": "5", "displayName": "Breno"}, "team": {"displayName": "Coritiba"}},
                ],
            },
            {
                "name": "assists",
                "leaders": [
                    {"value": 8, "athlete": {"id": "6", "displayName": "Jogador A"}, "team": {"displayName": "Palmeiras"}},
                    {"value": 7, "athlete": {"id": "7", "displayName": "Jogador B"}, "team": {"displayName": "Bahia"}},
                    {"value": 6, "athlete": {"id": "8", "displayName": "Jogador C"}, "team": {"displayName": "Santos"}},
                    {"value": 5, "athlete": {"id": "9", "displayName": "Jogador D"}, "team": {"displayName": "Cruzeiro"}},
                    {"value": 4, "athlete": {"id": "10", "displayName": "Jogador E"}, "team": {"displayName": "Botafogo"}},
                ],
            },
        ]
    }
    goals = extract_ranking(fixture, "gols")
    assists = extract_ranking(fixture, "assistencias")
    assert [x["gols"] for x in goals[:5]] == [11, 10, 9, 9, 8]
    assert goals[0]["time"] == "Athletico-PR"
    assert goals[0]["jogos"] == 17
    assert [x["assistencias"] for x in assists[:5]] == [8, 7, 6, 5, 4]
    assert not validate_ranking(goals, "gols")
    assert not validate_ranking(assists, "assistencias")
    contaminated = {
        "categories": [{"name": "assists", "leaders": [
            {"value": 5, "athlete": {"displayName": "Renan Lodi with a cross"}, "team": {"displayName": "Atlético Mineiro"}}
        ]}]
    }
    assert not extract_ranking(contaminated, "assistencias")
    print("SELF-TEST OK: parser de líderes, aliases, jogos e bloqueio de nomes contaminados.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Busca artilharia e assistências oficiais da ESPN.")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--fixture-gols", type=Path)
    parser.add_argument("--fixture-assistencias", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return

    previous = load_previous()
    prev_goals = list(previous.get("artilharia") or [])
    prev_assists = list(previous.get("assistencias") or [])

    goals, log_goals, source_goals = collect_one("gols", args.fixture_gols)
    assists, log_assists, source_assists = collect_one("assistencias", args.fixture_assistencias)

    errors_goals = validate_ranking(goals, "gols", prev_goals)
    errors_assists = validate_ranking(assists, "assistencias", prev_assists)
    used_previous: dict[str, bool] = {"artilharia": False, "assistencias": False}

    if errors_goals and prev_goals and not validate_ranking(prev_goals, "gols"):
        goals = prev_goals
        used_previous["artilharia"] = True
    if errors_assists and prev_assists and not validate_ranking(prev_assists, "assistencias"):
        assists = prev_assists
        used_previous["assistencias"] = True

    final_errors = validate_ranking(goals, "gols") + validate_ranking(assists, "assistencias")
    status = "valido" if not final_errors else "invalido"

    audit = {
        "gerado_em": iso_agora_brt(),
        "temporada": TEMPORADA,
        "status": status,
        "resumo": {
            "artilheiros": len(goals),
            "assistentes": len(assists),
            "lider_gols": goals[0] if goals else None,
            "lider_assistencias": assists[0] if assists else None,
            "preservado_de_execucao_anterior": used_previous,
        },
        "fonte_aceita": {"artilharia": source_goals, "assistencias": source_assists},
        "tentativas": {"artilharia": log_goals, "assistencias": log_assists},
        "erros_nova_coleta": {"artilharia": errors_goals, "assistencias": errors_assists},
        "erros_finais": final_errors,
        "nomes_suspeitos": [
            x.get("nome") for x in goals + assists if suspicious_name(str(x.get("nome") or ""))
        ],
    }

    if args.dry_run:
        print(json.dumps(audit, ensure_ascii=False, indent=2))
        if final_errors:
            raise SystemExit(2)
        return

    write_json_atomic(AUDITORIA, audit)
    if final_errors:
        raise RuntimeError("Coleta de líderes inválida: " + " | ".join(final_errors))

    payload = {
        "atualizado_em": iso_agora_brt(),
        "temporada": TEMPORADA,
        "fonte": "ESPN · rankings oficiais da competição",
        "status": "valido",
        "preservado_de_execucao_anterior": used_previous,
        "fonte_aceita": {"artilharia": source_goals, "assistencias": source_assists},
        "artilharia": goals,
        "assistencias": assists,
    }
    write_json_atomic(SAIDA, payload)
    print(f"OK: {len(goals)} artilheiros e {len(assists)} assistentes em {SAIDA.relative_to(ROOT)}")
    print(f"OK: auditoria em {AUDITORIA.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
