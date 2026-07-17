#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Atualiza transmissões de TV/streaming do Brasileirão a partir da ESPN.

- Lê a agenda local em jogos.json.
- Consulta o scoreboard público da ESPN para os próximos jogos.
- Extrai apenas provedores fechados conhecidos (Premiere, SporTV,
  Disney+/ESPN, Prime Video e Globo).
- Preserva os cadastros manuais, normalizando o campo ``canais`` para que
  fontes de YouTube (CazéTV/GE TV) permaneçam exclusivamente no arquivo
  dados-br/transmissoes-aovivo.json, onde há URL oficial e prioridade visual.
- Não cria links de terceiros; a página usa apenas destinos oficiais já
  definidos no JavaScript.
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import re
import sys
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Sao_Paulo")
API = "https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard"
ROOT = Path(__file__).resolve().parents[1]
AGENDA = ROOT / "jogos.json"
OUTPUT = ROOT / "dados-br" / "transmissoes-tv.json"

PROVIDERS = [
    ("Premiere", ("premiere",)),
    ("SporTV", ("sportv", "sport tv")),
    ("Disney+ / ESPN", ("disney+", "disney plus", "espn")),
    ("Prime Video", ("prime video", "amazon prime", "amazon prime video")),
    ("Globo", ("tv globo", "globo")),
]
ALLOWED_CHANNELS = {label for label, _aliases in PROVIDERS}


def norm(value: Any) -> str:
    text = unicodedata.normalize("NFD", str(value or "").lower())
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = re.sub(r"[^a-z0-9+]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def canonical_closed_channel(value: Any) -> Optional[str]:
    """Retorna o nome canônico de um canal fechado aceito pelo site.

    CazéTV e GE TV não pertencem a este arquivo: quando há transmissão oficial
    no YouTube, elas ficam em ``transmissoes-aovivo.json`` acompanhadas da URL.
    """
    wanted = norm(value)
    if not wanted:
        return None
    for label, aliases in PROVIDERS:
        candidates = (label, *aliases)
        if any(norm(candidate) == wanted for candidate in candidates):
            return label
    return None


def sanitize_closed_channels(values: Any) -> List[str]:
    """Normaliza, remove duplicatas e descarta fontes fora da TV fechada."""
    if not isinstance(values, list):
        return []
    out: List[str] = []
    for raw in values:
        label = canonical_closed_channel(raw)
        if label and label not in out:
            out.append(label)
    return out


def sanitize_manual_entry(item: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    """Preserva o cadastro manual, mas separa corretamente TV de YouTube."""
    cleaned = copy.deepcopy(dict(item))
    cleaned["canais"] = sanitize_closed_channels(cleaned.get("canais"))
    if not cleaned["canais"]:
        return None
    return cleaned


def parse_dt(value: Any) -> Optional[dt.datetime]:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        obj = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
        if obj.tzinfo is None:
            obj = obj.replace(tzinfo=TZ)
        return obj.astimezone(TZ)
    except ValueError:
        return None


def load_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return copy.deepcopy(fallback)


def broadcasts(event: Mapping[str, Any]) -> List[str]:
    comp = ((event.get("competitions") or [{}])[0]) or {}
    values: List[str] = []

    def walk(node: Any) -> None:
        if node is None:
            return
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, Mapping):
            return
        names = node.get("names")
        if isinstance(names, list):
            values.extend(str(x) for x in names if x)
        for key in ("name", "shortName", "displayName", "network", "callLetters"):
            if node.get(key):
                values.append(str(node[key]))
        if node.get("media"):
            walk(node["media"])

    # A ESPN costuma usar broadcasts em alguns jogos e geoBroadcasts em outros.
    # O parser anterior ignorava geoBroadcasts, por isso muitos canais próximos
    # nunca entravam no JSON mesmo após o workflow rodar.
    for source in (
        comp.get("broadcasts"), comp.get("geoBroadcasts"),
        event.get("broadcasts"), event.get("geoBroadcasts")
    ):
        walk(source)

    out: List[str] = []
    for raw in values:
        n = norm(raw)
        for label, aliases in PROVIDERS:
            if any(norm(alias) in n for alias in aliases) and label not in out:
                out.append(label)
    return out


def fetch_scoreboard(start: dt.date, end: dt.date) -> Dict[str, Any]:
    dates = f"{start:%Y%m%d}-{end:%Y%m%d}"
    url = API + "?" + urllib.parse.urlencode({"dates": dates, "limit": 200})
    req = urllib.request.Request(url, headers={"User-Agent": "brasileirao-tv-discovery/1.0"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def auto_entries(agenda: Mapping[str, Any], scoreboard: Mapping[str, Any]) -> Dict[str, Any]:
    local = {str(j.get("event_id") or ""): j for j in (agenda.get("jogos") or []) if j.get("event_id")}
    out: Dict[str, Any] = {}
    for event in scoreboard.get("events") or []:
        event_id = str(event.get("id") or "")
        channels = broadcasts(event)
        if not event_id or not channels:
            continue
        item = local.get(event_id, {})
        comp = ((event.get("competitions") or [{}])[0]) or {}
        competitors = comp.get("competitors") or []
        home = next((x for x in competitors if x.get("homeAway") == "home"), competitors[0] if competitors else {})
        away = next((x for x in competitors if x.get("homeAway") == "away"), competitors[1] if len(competitors) > 1 else {})
        home_name = ((home.get("team") or {}).get("displayName") or item.get("mandante") or "")
        away_name = ((away.get("team") or {}).get("displayName") or item.get("visitante") or "")
        kickoff = event.get("date") or comp.get("date") or item.get("data_iso") or ""
        out[event_id] = {
            "event_id": event_id,
            "rodada": int(item.get("rodada") or 0),
            "mandante": home_name,
            "visitante": away_name,
            "data_iso": kickoff,
            "tipo": "assinatura",
            "canais": channels,
            "origem": "ESPN automático",
        }
    return out


def build(existing: Mapping[str, Any], agenda: Mapping[str, Any], scoreboard: Mapping[str, Any], now: dt.datetime) -> Dict[str, Any]:
    generated = auto_entries(agenda, scoreboard)
    for event_id, item in (existing.get("jogos") or {}).items():
        if str(item.get("origem") or "").lower().startswith("manual"):
            cleaned = sanitize_manual_entry(item)
            if cleaned is not None:
                generated[str(event_id)] = cleaned
    return {
        "descricao": "Transmissões oficiais por TV ou streaming com assinatura. CazéTV e GE TV ficam no arquivo de transmissões oficiais do YouTube.",
        "politica": {
            "origem": "ESPN automática com prioridade para cadastro manual; YouTube oficial mantido separadamente",
            "limite_links": 3,
            "regra": "Somente páginas oficiais dos serviços; os links podem exigir assinatura e login.",
        },
        "jogos": generated,
        "atualizado_em": now.astimezone(TZ).replace(microsecond=0).isoformat(),
    }


def selftest() -> None:
    agenda = {"jogos": [{"event_id": "1", "rodada": 19, "mandante": "Vitória", "visitante": "Vasco", "data_iso": "2026-07-16T19:30:00-03:00"}]}
    score = {"events": [{"id": "1", "date": "2026-07-16T22:30:00Z", "competitions": [{"geoBroadcasts": [{"media": {"shortName": "Premiere"}}, {"media": {"shortName": "SporTV"}}], "competitors": [{"homeAway": "home", "team": {"displayName": "Vitória"}}, {"homeAway": "away", "team": {"displayName": "Vasco da Gama"}}]}]}]}
    existing = {
        "jogos": {
            "2": {
                "event_id": "2",
                "origem": "manual confirmado",
                "canais": ["GE TV", "Amazon Prime Video", "Prime Video"],
            },
            "3": {
                "event_id": "3",
                "origem": "manual confirmado — YouTube",
                "canais": ["CazéTV"],
            },
        }
    }
    result = build(existing, agenda, score, dt.datetime(2026, 7, 16, 20, 0, tzinfo=TZ))
    assert result["jogos"]["1"]["canais"] == ["Premiere", "SporTV"]
    assert result["jogos"]["2"]["canais"] == ["Prime Video"]
    assert "3" not in result["jogos"]
    assert all(
        set(item.get("canais") or []).issubset(ALLOWED_CHANNELS)
        for item in result["jogos"].values()
    )
    print("Selftest OK")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        selftest()
        return 0
    now = dt.datetime.now(TZ)
    agenda = load_json(AGENDA, {"jogos": []})
    existing = load_json(OUTPUT, {"jogos": {}})
    score = fetch_scoreboard(now.date() - dt.timedelta(days=1), now.date() + dt.timedelta(days=21))
    payload = build(existing, agenda, score, now)
    if args.dry_run:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Transmissões TV atualizadas: {len(payload['jogos'])} jogo(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
