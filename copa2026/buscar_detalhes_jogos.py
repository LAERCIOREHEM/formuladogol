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

LABELS = [
    ("expected goals", "xG"),
    ("xg", "xG"),
    ("possession", "Posse"),
    ("total shots", "Finalizações"),
    ("shots on goal", "Chutes no gol"),
    ("shots on target", "Chutes no gol"),
    ("big chances created", "Grandes chances"),
    ("big chances missed", "Chances perdidas"),
    ("corner", "Escanteios"),
    ("fouls", "Faltas"),
    ("yellow", "Amarelos"),
    ("red", "Vermelhos"),
    ("offsides", "Impedimentos"),
    ("saves", "Defesas"),
    ("accurate passes", "Passes certos"),
    ("pass accuracy", "Precisão passe"),
    ("duels won", "Duelos vencidos"),
]
ORDEM = ["xG","Posse","Finalizações","Chutes no gol","Grandes chances","Chances perdidas","Escanteios","Faltas","Amarelos","Vermelhos","Impedimentos","Defesas","Passes certos","Precisão passe","Duelos vencidos"]

def fetch_json(url: str, timeout: int = 25) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))

def norm(s: str) -> str:
    import unicodedata, re
    s = unicodedata.normalize("NFD", str(s or ""))
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()

def label_of(name: str) -> str:
    n = norm(name)
    for needle, label in LABELS:
        if norm(needle) in n:
            return label
    return name or ""

def stat_name(s: dict) -> str:
    return s.get("displayName") or s.get("shortDisplayName") or s.get("name") or s.get("label") or s.get("abbreviation") or ""

def stat_val(s: dict) -> str:
    v = s.get("displayValue")
    if v is None:
        v = s.get("value")
    return "" if v is None else str(v)

def parse_summary(summary: dict) -> list[dict]:
    teams = (((summary or {}).get("boxscore") or {}).get("teams") or [])
    if len(teams) < 2:
        return []
    a, b = teams[0], teams[1]
    stats_a = a.get("statistics") or a.get("stats") or []
    stats_b = b.get("statistics") or b.get("stats") or []
    map_b = {label_of(stat_name(s)): stat_val(s) for s in stats_b}
    out = []
    for s in stats_a:
        nome = label_of(stat_name(s))
        if not nome:
            continue
        home = stat_val(s)
        away = map_b.get(nome, "")
        if home == "" and away == "":
            continue
        out.append({"nome": nome, "home": home, "away": away})
    out.sort(key=lambda x: ORDEM.index(x["nome"]) if x["nome"] in ORDEM else 999)
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
