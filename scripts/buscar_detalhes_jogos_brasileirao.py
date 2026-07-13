#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
buscar_detalhes_jogos_brasileirao.py

Busca o summary da ESPN para cada jogo finalizado do Brasileirão e gera:
  - dados-br/jogos-detalhes.json
  - dados-br/auditoria-jogos-detalhes.json

O front usa o JSON para exibir o botão recolhível "📊 Estatísticas do jogo"
na aba Resultados. A rotina é conservadora: não inventa estatística, preserva
estatísticas boas de execuções anteriores quando a ESPN oscila e nunca toca no
módulo copa2026/.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

BASE_SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/summary?event={event_id}"
FUSO_BRASILIA = timezone(timedelta(hours=-3))
ROOT = Path(__file__).resolve().parents[1]
RESULTADOS = ROOT / "resultados.json"
SAIDA = ROOT / "dados-br" / "jogos-detalhes.json"
AUDITORIA = ROOT / "dados-br" / "auditoria-jogos-detalhes.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    ),
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
}

# Métricas que interessam para uma leitura simples no card do jogo. A ESPN muda
# nomes e formatos entre competições; por isso aceitamos variações.
METRIC_RULES = [
    {"keys": ["expected goals", "expectedgoals", "xg"], "label": "xG", "order": 1},
    {"keys": ["possession pct", "possession percent", "possession percentage", "possessionpct", "possession"], "label": "Posse", "order": 2, "percent": True},
    {"keys": ["total shots", "totalshots", "shots total", "shots"], "label": "Finalizações", "order": 3},
    {"keys": ["shots on goal", "shots on target", "shotsongoal", "shotsontarget"], "label": "Chutes no gol", "order": 4},
    {"keys": ["shots off target", "shotsofftarget"], "label": "Chutes para fora", "order": 5},
    {"keys": ["blocked shots", "blockedshots"], "label": "Chutes bloqueados", "order": 6},
    {"keys": ["shot pct", "shot percent", "shot percentage", "shotpct", "shooting percentage"], "label": "Aproveitamento dos chutes", "order": 7, "percent01": True, "note": "chutes no gol ÷ finalizações"},
    {"keys": ["big chances created", "bigchancescreated"], "label": "Grandes chances", "order": 8},
    {"keys": ["big chances missed", "bigchancesmissed"], "label": "Chances perdidas", "order": 9},
    {"keys": ["corner kicks", "cornerkicks", "won corners", "woncorners", "corners"], "label": "Escanteios", "order": 10},
    {"keys": ["fouls committed", "foulscommitted", "fouls"], "label": "Faltas", "order": 11},
    {"keys": ["yellow cards", "yellowcards"], "label": "Amarelos", "order": 12},
    {"keys": ["red cards", "redcards"], "label": "Vermelhos", "order": 13},
    {"keys": ["offsides", "offside"], "label": "Impedimentos", "order": 14},
    {"keys": ["saves", "goalkeeper saves"], "label": "Defesas", "order": 15},
    {"keys": ["accurate passes", "accuratepasses", "completed passes"], "label": "Passes certos", "order": 16},
    {"keys": ["pass pct", "pass percent", "pass percentage", "pass accuracy", "passpct", "passaccuracy"], "label": "Precisão de passe", "order": 17, "percent01": True},
    {"keys": ["duels won", "duelswon"], "label": "Duelos vencidos", "order": 18},
]


def agora_brt() -> datetime:
    return datetime.now(FUSO_BRASILIA)


def iso_agora_brt() -> str:
    return agora_brt().isoformat()


def normalizar(valor: Any) -> str:
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", str(valor or ""))
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def compacto(valor: Any) -> str:
    return normalizar(valor).replace(" ", "")


def rule_of(nome: Any) -> dict[str, Any] | None:
    k = normalizar(nome)
    kc = compacto(nome)
    if not k:
        return None

    for regra in METRIC_RULES:
        if k == normalizar(regra["label"]) or kc == compacto(regra["label"]):
            return regra

    for regra in METRIC_RULES:
        for chave in regra["keys"]:
            if k == normalizar(chave) or kc == compacto(chave):
                return regra

    # Parcial controlado: evita tratar "shots on goal" como "Finalizações".
    for regra in METRIC_RULES:
        if regra["label"] == "Finalizações":
            continue
        if normalizar(regra["label"]) in k or compacto(regra["label"]) in kc:
            return regra
        for chave in regra["keys"]:
            nk, nck = normalizar(chave), compacto(chave)
            if nk and (nk in k or nck in kc):
                return regra
    return None


def stat_name(item: dict[str, Any]) -> str:
    return str(
        item.get("displayName")
        or item.get("shortDisplayName")
        or item.get("name")
        or item.get("label")
        or item.get("abbreviation")
        or ""
    )


def stat_val(item: dict[str, Any]) -> str:
    valor = item.get("displayValue")
    if valor is None:
        valor = item.get("value")
    return "" if valor is None else str(valor)


def numero(valor: Any) -> float | None:
    m = re.search(r"-?\d+(?:[\.,]\d+)?", str(valor or ""))
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", "."))
    except ValueError:
        return None


def fmt_value(regra: dict[str, Any], bruto: Any) -> str:
    if bruto is None:
        return ""
    s = str(bruto).strip()
    if s == "":
        return ""
    n = numero(s)
    if (regra.get("percent") or regra.get("percent01")) and "%" not in s and n is not None:
        if regra.get("percent01") and 0 <= n <= 1:
            return f"{round(n * 100)}%"
        return f"{round(n, 1):g}%"
    return s


def team_nome(team_box: dict[str, Any]) -> str:
    t = team_box.get("team") or {}
    return str(t.get("displayName") or t.get("shortDisplayName") or t.get("name") or t.get("abbreviation") or "")


def team_id(team_box: dict[str, Any]) -> str:
    t = team_box.get("team") or {}
    return str(t.get("id") or t.get("uid") or t.get("abbreviation") or team_nome(team_box) or "")


def home_away_from_competitors(summary: dict[str, Any]) -> tuple[str, str]:
    comp = (((summary.get("header") or {}).get("competitions") or [{}])[0])
    home = away = ""
    for c in comp.get("competitors") or []:
        t = c.get("team") or {}
        tid = str(t.get("id") or t.get("uid") or t.get("abbreviation") or t.get("displayName") or "")
        if c.get("homeAway") == "home":
            home = tid
        elif c.get("homeAway") == "away":
            away = tid
    return home, away


def ordenar_times_boxscore(summary: dict[str, Any], jogo: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    teams = (((summary or {}).get("boxscore") or {}).get("teams") or [])
    if len(teams) < 2:
        return None, None

    home_by_flag = next((t for t in teams if str(t.get("homeAway") or "").lower() == "home"), None)
    away_by_flag = next((t for t in teams if str(t.get("homeAway") or "").lower() == "away"), None)
    if home_by_flag and away_by_flag:
        return home_by_flag, away_by_flag

    home_id, away_id = home_away_from_competitors(summary)
    if home_id or away_id:
        home = next((t for t in teams if team_id(t) == home_id), None)
        away = next((t for t in teams if team_id(t) == away_id), None)
        if home and away:
            return home, away

    mandante = normalizar((jogo.get("mandante") or {}).get("nome"))
    visitante = normalizar((jogo.get("visitante") or {}).get("nome"))
    if mandante or visitante:
        home = next((t for t in teams if mandante and mandante in normalizar(team_nome(t))), None)
        away = next((t for t in teams if visitante and visitante in normalizar(team_nome(t))), None)
        if home and away and home is not away:
            return home, away

    # A ESPN geralmente já entrega na ordem mandante/visitante.
    return teams[0], teams[1]


def estatisticas_do_time(team_box: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not team_box:
        return []
    return list(team_box.get("statistics") or team_box.get("stats") or [])


def parse_summary(summary: dict[str, Any], jogo: dict[str, Any]) -> list[dict[str, Any]]:
    home, away = ordenar_times_boxscore(summary, jogo)
    stats_home = estatisticas_do_time(home)
    stats_away = estatisticas_do_time(away)
    if not stats_home or not stats_away:
        return []

    away_por_label: dict[str, tuple[dict[str, Any], str]] = {}
    for s in stats_away:
        regra = rule_of(stat_name(s))
        if regra:
            away_por_label[regra["label"]] = (regra, stat_val(s))

    by_label: dict[str, dict[str, Any]] = {}
    for s in stats_home:
        regra = rule_of(stat_name(s))
        if not regra:
            continue
        label = regra["label"]
        par_away = away_por_label.get(label)
        item = {
            "nome": label,
            "home": fmt_value(regra, stat_val(s)),
            "away": fmt_value(regra, par_away[1] if par_away else ""),
        }
        if regra.get("note"):
            item["note"] = regra["note"]
        if item["home"] == "" and item["away"] == "":
            continue
        anterior = by_label.get(label)
        if anterior is None or regra["order"] < anterior.get("_order", 999):
            item["_order"] = regra["order"]
            by_label[label] = item

    saida = sorted(by_label.values(), key=lambda x: x.get("_order", 999))
    for item in saida:
        item.pop("_order", None)
    return saida



def _walk(no: Any):
    if isinstance(no, dict):
        yield no
        for v in no.values():
            yield from _walk(v)
    elif isinstance(no, list):
        for v in no:
            yield from _walk(v)


def _first_text(no: Any, *keys: str) -> str:
    if not isinstance(no, dict):
        return ""
    for key in keys:
        v = no.get(key)
        if isinstance(v, dict):
            text = _first_text(v, "displayName", "fullName", "name", "shortDisplayName", "text")
            if text:
                return text
        elif v not in (None, ""):
            return str(v).strip()
    return ""


def parse_publico(summary: dict[str, Any]) -> int | None:
    candidatos: list[int] = []
    for no in _walk(summary):
        for key, value in no.items():
            if normalizar(key) not in {"attendance", "crowd", "publico", "spectators"}:
                continue
            n = numero(value.get("value") if isinstance(value, dict) else value)
            if n is not None and 100 <= n <= 250000:
                candidatos.append(int(round(n)))
    return max(candidatos) if candidatos else None


def parse_estadio(summary: dict[str, Any], jogo: dict[str, Any]) -> str:
    paths = [
        ((summary.get("gameInfo") or {}).get("venue") or {}),
        ((((summary.get("header") or {}).get("competitions") or [{}])[0]).get("venue") or {}),
    ]
    for venue in paths:
        text = _first_text(venue, "fullName", "displayName", "name", "shortName")
        if text:
            return text
    return str(jogo.get("estadio") or "").strip()


def parse_arbitro(summary: dict[str, Any]) -> str:
    officials = (summary.get("gameInfo") or {}).get("officials") or []
    if not isinstance(officials, list):
        officials = []
    preferidos: list[str] = []
    outros: list[str] = []
    for item in officials:
        if not isinstance(item, dict):
            continue
        nome = _first_text(item, "displayName", "fullName", "name")
        if not nome and isinstance(item.get("official"), dict):
            nome = _first_text(item["official"], "displayName", "fullName", "name")
        if not nome:
            continue
        papel = normalizar(" ".join(str(item.get(k) or "") for k in ("position", "type", "role", "order")))
        if "referee" in papel or "arbitro" in papel:
            preferidos.append(nome)
        else:
            outros.append(nome)
    return (preferidos or outros or [""])[0]


def limpar_nome_jogador(nome: Any) -> str:
    s = str(nome or "").strip()
    if not s:
        return ""
    s = re.sub(r"\s+(?:with a|with the)\s+(?:cross|pass|header|shot).*?$", "", s, flags=re.I)
    s = re.sub(r"\s+(?:right|left)-?footed.*?$", "", s, flags=re.I)
    s = re.sub(r"\s+(?:assisted by|from the centre|from outside).*?$", "", s, flags=re.I)
    s = re.sub(r"\s*\([^)]*\)\s*$", "", s).strip(" -.,;")
    return s


def _event_nodes(summary: dict[str, Any]) -> list[dict[str, Any]]:
    keys = {"scoringplays", "keyevents", "plays", "commentary", "incidents", "matchevents", "details"}
    out: list[dict[str, Any]] = []
    seen: set[int] = set()
    def walk(no: Any, parent_key: str = "") -> None:
        if isinstance(no, dict):
            for k, v in no.items():
                nk = normalizar(k).replace(" ", "")
                if isinstance(v, list) and nk in keys:
                    for item in v:
                        if isinstance(item, dict) and id(item) not in seen:
                            seen.add(id(item)); out.append(item)
                if nk in keys or k in ("header", "competitions", "competition", "gameInfo"):
                    walk(v, k)
        elif isinstance(no, list):
            for item in no:
                walk(item, parent_key)
    walk(summary)
    return out


def _event_text(ev: dict[str, Any]) -> str:
    tipo = ev.get("type")
    parts = []
    if isinstance(tipo, dict):
        parts.extend(str(tipo.get(k) or "") for k in ("text", "name", "displayName", "description", "id"))
    elif tipo:
        parts.append(str(tipo))
    parts.extend(str(ev.get(k) or "") for k in ("text", "description", "shortText", "headline", "eventType", "playType"))
    return " ".join(parts).strip()


def _event_minute(ev: dict[str, Any]) -> str:
    for key in ("clock", "time", "displayClock", "timeDisplayValue", "minute"):
        v = ev.get(key)
        if isinstance(v, dict):
            text = _first_text(v, "displayValue", "displayClock", "value", "text")
            if text:
                return text
        elif v not in (None, ""):
            return str(v)
    return ""


def _athletes_event(ev: dict[str, Any]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for key in ("athletes", "athletesInvolved", "participants", "players"):
        for item in ev.get(key) or []:
            if not isinstance(item, dict):
                continue
            base = item.get("athlete") if isinstance(item.get("athlete"), dict) else item
            nome = limpar_nome_jogador(_first_text(base, "displayName", "fullName", "name", "shortName"))
            papel = normalizar(" ".join(str(item.get(k) or "") for k in ("type", "role", "position")))
            if nome:
                out.append((nome, papel))
    for key in ("athlete", "player", "scorer"):
        if isinstance(ev.get(key), dict):
            nome = limpar_nome_jogador(_first_text(ev[key], "displayName", "fullName", "name", "shortName"))
            if nome and not any(n == nome for n, _ in out):
                out.append((nome, "scorer" if key == "scorer" else ""))
    return out


def parse_eventos(summary: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    gols: list[dict[str, Any]] = []
    cartoes: list[dict[str, Any]] = []
    vistos: set[str] = set()
    for ev in _event_nodes(summary):
        text = _event_text(ev)
        ntext = normalizar(text)
        athletes = _athletes_event(ev)
        player = next((n for n, role in athletes if "assist" not in role), athletes[0][0] if athletes else "")
        assists = [n for n, role in athletes if "assist" in role]
        if not assists:
            m = re.search(r"assist(?:ed|encia|ência)?\s+(?:by|de|por)\s+([^.,;()]+)", text, flags=re.I)
            if m:
                nome = limpar_nome_jogador(m.group(1))
                if nome:
                    assists = [nome]
        team = ""
        t = ev.get("team") or ev.get("competitor")
        if isinstance(t, dict):
            team = _first_text(t, "displayName", "shortDisplayName", "name", "abbreviation")
        minuto = _event_minute(ev)
        is_goal = bool(re.search(r"\b(goal|gol|own goal|gol contra|penalty goal)\b", ntext)) and not any(x in ntext for x in ("shots on goal", "goal difference", "goals for", "expected goals"))
        card = ""
        if "red card" in ntext or "cartao vermelho" in ntext:
            card = "vermelho"
        elif "yellow card" in ntext or "cartao amarelo" in ntext:
            card = "amarelo"
        if is_goal:
            key = f"g|{minuto}|{normalizar(player)}|{normalizar(team)}"
            if key not in vistos:
                vistos.add(key)
                gols.append({"minuto": minuto, "jogador": player, "time": team, "assistencias": assists, "descricao": text})
        if card:
            key = f"c|{card}|{minuto}|{normalizar(player)}|{normalizar(team)}"
            if key not in vistos:
                vistos.add(key)
                cartoes.append({"tipo": card, "minuto": minuto, "jogador": player, "time": team, "descricao": text})
    return gols, cartoes


def fetch_json(url: str, timeout: int = 20, tentativas: int = 2) -> dict[str, Any]:
    ultimo: Exception | None = None
    for i in range(1, tentativas + 1):
        try:
            sep = "&" if "?" in url else "?"
            req = urllib.request.Request(f"{url}{sep}_={int(time.time())}", headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout + 6 * (i - 1)) as r:
                charset = r.headers.get_content_charset() or "utf-8"
                return json.loads(r.read().decode(charset, errors="replace"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
            ultimo = exc
            if i < tentativas:
                time.sleep(1.5 * i)
    raise RuntimeError(f"falha ao buscar {url}: {type(ultimo).__name__}: {ultimo}")


def carregar_json(path: Path, padrao: Any) -> Any:
    if not path.exists():
        return padrao
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return padrao


def gravar_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def jogo_finalizado(jogo: dict[str, Any]) -> bool:
    if not jogo.get("event_id"):
        return False
    if jogo.get("placar_mandante") is None or jogo.get("placar_visitante") is None:
        return False
    estado = str(jogo.get("estado") or "").lower()
    if estado == "pre":
        return False
    return True


def montar_registro(
    event_id: str,
    jogo: dict[str, Any],
    stats: list[dict[str, Any]],
    *,
    publico: int | None = None,
    estadio: str = "",
    arbitro: str = "",
    gols: list[dict[str, Any]] | None = None,
    cartoes: list[dict[str, Any]] | None = None,
    preservado: bool = False,
) -> dict[str, Any]:
    return {
        "event_id": event_id,
        "rodada": int(jogo.get("rodada") or 0),
        "data_iso": jogo.get("data_iso") or "",
        "mandante": (jogo.get("mandante") or {}).get("nome") or "",
        "visitante": (jogo.get("visitante") or {}).get("nome") or "",
        "placar_mandante": jogo.get("placar_mandante"),
        "placar_visitante": jogo.get("placar_visitante"),
        "estadio": estadio or str(jogo.get("estadio") or ""),
        "publico": publico,
        "arbitro": arbitro,
        "stats": stats,
        "estatisticas": stats,
        "gols": gols or [],
        "cartoes": cartoes or [],
        "fonte": "ESPN summary",
        "preservado_de_execucao_anterior": bool(preservado),
        "atualizado_em": iso_agora_brt(),
    }



def self_test() -> None:
    summary = {
        "gameInfo": {
            "attendance": 43210,
            "venue": {"fullName": "Estádio Teste"},
            "officials": [{"displayName": "Árbitro Teste", "position": {"displayName": "Referee"}}],
        },
        "header": {"competitions": [{"competitors": [
            {"homeAway": "home", "team": {"id": "1"}},
            {"homeAway": "away", "team": {"id": "2"}},
        ]}]},
        "boxscore": {"teams": [
            {"homeAway": "home", "team": {"id": "1", "displayName": "Flamengo"}, "statistics": [
                {"name": "possessionPct", "displayValue": "60%"},
                {"name": "totalShots", "displayValue": "10"},
            ]},
            {"homeAway": "away", "team": {"id": "2", "displayName": "Palmeiras"}, "statistics": [
                {"name": "possessionPct", "displayValue": "40%"},
                {"name": "totalShots", "displayValue": "7"},
            ]},
        ]},
        "scoringPlays": [{
            "type": {"text": "Goal"}, "clock": {"displayValue": "23'"},
            "athletes": [
                {"athlete": {"displayName": "Pedro"}, "role": "scorer"},
                {"athlete": {"displayName": "Samuel Lino"}, "role": "assist"},
            ],
            "team": {"displayName": "Flamengo"},
            "text": "Goal! Pedro. Assisted by Samuel Lino with a cross.",
        }],
        "keyEvents": [{
            "type": {"text": "Yellow Card"}, "clock": {"displayValue": "31'"},
            "athletes": [{"athlete": {"displayName": "Jogador X"}}],
            "team": {"displayName": "Palmeiras"}, "text": "Yellow card",
        }],
    }
    jogo = {"mandante": {"nome": "Flamengo"}, "visitante": {"nome": "Palmeiras"}, "estadio": ""}
    assert parse_publico(summary) == 43210
    assert parse_estadio(summary, jogo) == "Estádio Teste"
    assert parse_arbitro(summary) == "Árbitro Teste"
    stats = parse_summary(summary, jogo)
    assert any(x["nome"] == "Posse" and x["home"] == "60%" and x["away"] == "40%" for x in stats)
    gols, cartoes = parse_eventos(summary)
    assert gols and gols[0]["jogador"] == "Pedro"
    assert gols[0]["assistencias"] == ["Samuel Lino"]
    assert cartoes and cartoes[0]["tipo"] == "amarelo"
    print("SELF-TEST OK: público, estádio, árbitro, boxscore, gol, assistência e cartão.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Busca estatísticas por jogo do Brasileirão na ESPN.")
    parser.add_argument("--dry-run", action="store_true", help="Só valida entradas, sem rede e sem gravar arquivos.")
    parser.add_argument("--self-test", action="store_true", help="Executa testes internos do parser sem usar rede.")
    parser.add_argument("--max-jogos", type=int, default=0, help="Limite opcional de jogos processados nesta execução.")
    parser.add_argument("--sleep", type=float, default=0.08, help="Pausa entre chamadas ESPN.")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return

    base_resultados = carregar_json(RESULTADOS, {})
    resultados = [j for j in (base_resultados.get("resultados") or []) if jogo_finalizado(j)]

    if args.max_jogos and args.max_jogos > 0:
        resultados = resultados[: args.max_jogos]

    if args.dry_run:
        print(f"DRY-RUN OK: {len(resultados)} jogo(s) finalizado(s) elegível(is) em resultados.json")
        return

    anterior = carregar_json(SAIDA, {})
    jogos_anteriores = anterior.get("jogos") if isinstance(anterior, dict) else {}
    if not isinstance(jogos_anteriores, dict):
        jogos_anteriores = {}

    jogos_saida: dict[str, dict[str, Any]] = {}
    falhas: list[dict[str, Any]] = []
    sem_estatisticas: list[dict[str, Any]] = []
    preservados = 0
    buscados = 0

    for i, jogo in enumerate(resultados, 1):
        event_id = str(jogo.get("event_id") or "")
        if not event_id:
            continue
        label = f"R{jogo.get('rodada')} · {(jogo.get('mandante') or {}).get('nome')} x {(jogo.get('visitante') or {}).get('nome')} · {event_id}"
        try:
            summary = fetch_json(BASE_SUMMARY.format(event_id=event_id))
            stats = parse_summary(summary, jogo)
            publico = parse_publico(summary)
            estadio = parse_estadio(summary, jogo)
            arbitro = parse_arbitro(summary)
            gols, cartoes = parse_eventos(summary)
            buscados += 1
        except Exception as exc:  # noqa: BLE001
            antigo = jogos_anteriores.get(event_id) if isinstance(jogos_anteriores, dict) else None
            stats = list((antigo or {}).get("stats") or (antigo or {}).get("estatisticas") or [])
            if antigo:
                preservados += 1
                jogos_saida[event_id] = montar_registro(
                    event_id, jogo, stats,
                    publico=(antigo or {}).get("publico"),
                    estadio=str((antigo or {}).get("estadio") or jogo.get("estadio") or ""),
                    arbitro=str((antigo or {}).get("arbitro") or ""),
                    gols=list((antigo or {}).get("gols") or []),
                    cartoes=list((antigo or {}).get("cartoes") or []),
                    preservado=True,
                )
            else:
                falhas.append({"event_id": event_id, "jogo": label, "erro": str(exc)[:300]})
                jogos_saida[event_id] = montar_registro(event_id, jogo, [])
            print(f"[WARN] {label}: {exc}")
            time.sleep(max(0.0, args.sleep))
            continue

        if not stats:
            sem_estatisticas.append({"event_id": event_id, "jogo": label})
        jogos_saida[event_id] = montar_registro(
            event_id, jogo, stats, publico=publico, estadio=estadio, arbitro=arbitro,
            gols=gols, cartoes=cartoes,
        )
        print(
            f"[{i:03d}/{len(resultados):03d}] {label}: {len(stats)} estatística(s) · "
            f"público={publico if publico is not None else 'n/d'} · gols={len(gols)} · cartões={len(cartoes)}"
        )
        time.sleep(max(0.0, args.sleep))

    total_com = sum(1 for j in jogos_saida.values() if j.get("stats"))
    payload = {
        "_comentario": "Gerado por scripts/buscar_detalhes_jogos_brasileirao.py. Estatísticas aparecem apenas quando a ESPN disponibiliza summary/boxscore para o jogo.",
        "gerado_em": iso_agora_brt(),
        "fonte": "ESPN summary",
        "total_jogos": len(jogos_saida),
        "total_com_estatisticas": total_com,
        "total_com_publico": sum(1 for j in jogos_saida.values() if j.get("publico") not in (None, "")),
        "total_com_eventos": sum(1 for j in jogos_saida.values() if j.get("gols") or j.get("cartoes")),
        "jogos": jogos_saida,
    }
    auditoria = {
        "gerado_em": iso_agora_brt(),
        "fonte": "ESPN summary",
        "total_resultados_lidos": len(base_resultados.get("resultados") or []),
        "total_processados": len(resultados),
        "total_buscados_na_espn": buscados,
        "total_com_estatisticas": total_com,
        "total_com_publico": sum(1 for j in jogos_saida.values() if j.get("publico") not in (None, "")),
        "total_sem_publico": sum(1 for j in jogos_saida.values() if j.get("publico") in (None, "")),
        "total_com_eventos": sum(1 for j in jogos_saida.values() if j.get("gols") or j.get("cartoes")),
        "total_sem_estatisticas": len(sem_estatisticas),
        "total_preservados_de_execucao_anterior": preservados,
        "total_falhas": len(falhas),
        "sem_estatisticas": sem_estatisticas,
        "falhas": falhas,
    }

    gravar_json(SAIDA, payload)
    gravar_json(AUDITORIA, auditoria)
    print(f"OK: {len(jogos_saida)} jogos em {SAIDA.relative_to(ROOT)}; {total_com} com estatísticas.")
    print(f"OK: auditoria em {AUDITORIA.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
