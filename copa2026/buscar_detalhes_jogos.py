#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
buscar_detalhes_jogos.py
Busca o summary de cada jogo da Copa 2026 na ESPN e gera:
  copa2026/dados/jogos-detalhes.json

O site usa esse JSON para o botão recolhível "📊 Estatísticas do jogo".
Se algum jogo vier sem estatísticas, ele fica registrado sem inventar dados.
"""
from __future__ import annotations

import json
import os
import time
import urllib.request
from datetime import datetime, timezone

BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world"
JANELAS = [
    "20260611-20260627",
    "20260628-20260703",
    "20260704-20260707",
    "20260709-20260711",
    "20260714-20260715",
    "20260718-20260718",
    "20260719-20260719",
]
DADOS = os.path.join(os.path.dirname(__file__), "dados")
SAIDA = os.path.join(DADOS, "jogos-detalhes.json")

METRIC_RULES = [
    {"keys":["expected goals","expectedgoals","xg"], "label":"xG", "order":1},
    {"keys":["possession pct","possession percent","possession percentage","possessionpct","possession"], "label":"Posse", "order":2, "percent":True},
    {"keys":["total shots","totalshots","shots total"], "label":"Finalizações", "order":3},
    {"keys":["shots on goal","shots on target","shotsongoal","shotsontarget"], "label":"Chutes no gol", "order":4},
    {"keys":["shots off target","shotsofftarget"], "label":"Chutes para fora", "order":5},
    {"keys":["blocked shots","blockedshots"], "label":"Chutes bloqueados", "order":6},
    {"keys":["shot pct","shot percent","shot percentage","shotpct","shooting percentage"], "label":"Aproveitamento dos chutes", "order":7, "percent01":True, "note":"chutes no gol ÷ finalizações"},
    {"keys":["big chances created","bigchancescreated"], "label":"Grandes chances", "order":8},
    {"keys":["big chances missed","bigchancesmissed"], "label":"Chances perdidas", "order":9},
    {"keys":["corner kicks","cornerkicks","won corners","woncorners","corners"], "label":"Escanteios", "order":10},
    {"keys":["fouls committed","foulscommitted","fouls"], "label":"Faltas", "order":11},
    {"keys":["yellow cards","yellowcards"], "label":"Amarelos", "order":12},
    {"keys":["red cards","redcards"], "label":"Vermelhos", "order":13},
    {"keys":["offsides","offside"], "label":"Impedimentos", "order":14},
    {"keys":["saves","goalkeeper saves"], "label":"Defesas", "order":15},
    {"keys":["accurate passes","accuratepasses"], "label":"Passes certos", "order":16},
    {"keys":["pass pct","pass percent","pass percentage","pass accuracy","passpct","passaccuracy"], "label":"Precisão de passe", "order":17, "percent01":True},
    {"keys":["duels won","duelswon"], "label":"Duelos vencidos", "order":18},
]

def fetch_json(url: str, timeout: int = 25) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))

def norm(s: str) -> str:
    import unicodedata, re
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", str(s or ""))
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()

def compact(s: str) -> str:
    return norm(s).replace(" ", "")

def rule_of(name: str) -> dict | None:
    k, kc = norm(name), compact(name)
    for r in METRIC_RULES:
        for key in r["keys"]:
            if k == norm(key) or kc == compact(key):
                return r
    for r in METRIC_RULES:
        if r["label"] == "Finalizações":
            continue
        for key in r["keys"]:
            if norm(key) in k or compact(key) in kc:
                return r
    return None

def stat_name(s: dict) -> str:
    return s.get("displayName") or s.get("shortDisplayName") or s.get("name") or s.get("label") or s.get("abbreviation") or ""

def stat_val(s: dict) -> str:
    v = s.get("displayValue")
    if v is None:
        v = s.get("value")
    return "" if v is None else str(v)

def num(s: str) -> float | None:
    import re
    m = re.search(r"-?\d+(?:[\.,]\d+)?", str(s or ""))
    return float(m.group(0).replace(",", ".")) if m else None

def fmt_value(rule: dict, raw: str) -> str:
    if raw is None or raw == "":
        return ""
    s = str(raw).strip()
    n = num(s)
    if (rule.get("percent") or rule.get("percent01")) and "%" not in s and n is not None:
        if rule.get("percent01") and 0 <= n <= 1:
            return f"{round(n * 100)}%"
        return f"{round(n, 1):g}%"
    return s

def parse_summary(summary: dict) -> list[dict]:
    teams = (((summary or {}).get("boxscore") or {}).get("teams") or [])
    if len(teams) < 2:
        return []
    a, b = teams[0], teams[1]
    stats_a = a.get("statistics") or a.get("stats") or []
    stats_b = b.get("statistics") or b.get("stats") or []
    map_b = {}
    for s in stats_b:
        r = rule_of(stat_name(s))
        if r:
            map_b[r["label"]] = (r, stat_val(s))
    by_label = {}
    for s in stats_a:
        r = rule_of(stat_name(s))
        if not r:
            continue
        label = r["label"]
        mb = map_b.get(label)
        item = {
            "nome": label,
            "home": fmt_value(r, stat_val(s)),
            "away": fmt_value(r, mb[1] if mb else ""),
        }
        if r.get("note"):
            item["note"] = r["note"]
        if item["home"] == "" and item["away"] == "":
            continue
        old = by_label.get(label)
        if old is None or r["order"] < old["_order"]:
            item["_order"] = r["order"]
            by_label[label] = item
    out = sorted(by_label.values(), key=lambda x: x["_order"])
    for x in out:
        x.pop("_order", None)
    return out

def team_abbr(comp: dict, idx: int) -> str:
    try:
        return (((comp.get("competitors") or [])[idx]).get("team") or {}).get("abbreviation") or ""
    except Exception:
        return ""

def main() -> None:
    os.makedirs(DADOS, exist_ok=True)
    eventos = {}
    for janela in JANELAS:
        data = fetch_json(f"{BASE}/scoreboard?dates={janela}&limit=120")
        for ev in data.get("events") or []:
            if ev.get("id"):
                eventos[str(ev["id"])] = ev

    jogos = {}
    for i, (event_id, ev) in enumerate(sorted(eventos.items(), key=lambda kv: kv[1].get("date", "")), 1):
        try:
            summary = fetch_json(f"{BASE}/summary?event={event_id}")
            stats = parse_summary(summary)
        except Exception as exc:
            stats = []
            print(f"[WARN] {event_id}: {exc}")
        comp = (ev.get("competitions") or [{}])[0]
        jogos[event_id] = {
            "event_id": event_id,
            "date": ev.get("date"),
            "home": team_abbr(comp, 0),
            "away": team_abbr(comp, 1),
            "stats": stats,
            "fonte": "ESPN summary",
            "atualizado_em": datetime.now(timezone.utc).isoformat()
        }
        time.sleep(0.12)

    payload = {
        "_comentario": "Gerado por copa2026/buscar_detalhes_jogos.py. Estatísticas podem variar conforme disponibilidade da ESPN.",
        "gerado_em": datetime.now(timezone.utc).isoformat(),
        "total_jogos": len(jogos),
        "jogos": jogos
    }
    with open(SAIDA, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"OK: {len(jogos)} jogos em {SAIDA}")

if __name__ == "__main__":
    main()
