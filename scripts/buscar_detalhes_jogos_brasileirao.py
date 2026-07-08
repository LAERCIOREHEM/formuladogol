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


def montar_registro(event_id: str, jogo: dict[str, Any], stats: list[dict[str, Any]], preservado: bool = False) -> dict[str, Any]:
    return {
        "event_id": event_id,
        "rodada": int(jogo.get("rodada") or 0),
        "data_iso": jogo.get("data_iso") or "",
        "mandante": (jogo.get("mandante") or {}).get("nome") or "",
        "visitante": (jogo.get("visitante") or {}).get("nome") or "",
        "placar_mandante": jogo.get("placar_mandante"),
        "placar_visitante": jogo.get("placar_visitante"),
        "stats": stats,
        "estatisticas": stats,
        "fonte": "ESPN summary",
        "preservado_de_execucao_anterior": bool(preservado),
        "atualizado_em": iso_agora_brt(),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Busca estatísticas por jogo do Brasileirão na ESPN.")
    parser.add_argument("--dry-run", action="store_true", help="Só valida entradas, sem rede e sem gravar arquivos.")
    parser.add_argument("--max-jogos", type=int, default=0, help="Limite opcional de jogos processados nesta execução.")
    parser.add_argument("--sleep", type=float, default=0.08, help="Pausa entre chamadas ESPN.")
    args = parser.parse_args()

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
            buscados += 1
        except Exception as exc:  # noqa: BLE001
            antigo = jogos_anteriores.get(event_id) if isinstance(jogos_anteriores, dict) else None
            stats = list((antigo or {}).get("stats") or (antigo or {}).get("estatisticas") or [])
            if stats:
                preservados += 1
                jogos_saida[event_id] = montar_registro(event_id, jogo, stats, preservado=True)
            else:
                falhas.append({"event_id": event_id, "jogo": label, "erro": str(exc)[:300]})
                jogos_saida[event_id] = montar_registro(event_id, jogo, [])
            print(f"[WARN] {label}: {exc}")
            time.sleep(max(0.0, args.sleep))
            continue

        if not stats:
            sem_estatisticas.append({"event_id": event_id, "jogo": label})
        jogos_saida[event_id] = montar_registro(event_id, jogo, stats)
        print(f"[{i:03d}/{len(resultados):03d}] {label}: {len(stats)} estatística(s)")
        time.sleep(max(0.0, args.sleep))

    total_com = sum(1 for j in jogos_saida.values() if j.get("stats"))
    payload = {
        "_comentario": "Gerado por scripts/buscar_detalhes_jogos_brasileirao.py. Estatísticas aparecem apenas quando a ESPN disponibiliza summary/boxscore para o jogo.",
        "gerado_em": iso_agora_brt(),
        "fonte": "ESPN summary",
        "total_jogos": len(jogos_saida),
        "total_com_estatisticas": total_com,
        "jogos": jogos_saida,
    }
    auditoria = {
        "gerado_em": iso_agora_brt(),
        "fonte": "ESPN summary",
        "total_resultados_lidos": len(base_resultados.get("resultados") or []),
        "total_processados": len(resultados),
        "total_buscados_na_espn": buscados,
        "total_com_estatisticas": total_com,
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
