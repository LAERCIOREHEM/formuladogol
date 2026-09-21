#!/usr/bin/env python3
"""Consolida no repositório descobertas factuais já validadas pelo Fastlane Cloudflare.

Este script NÃO pesquisa a web. Ele lê /v1/postgame do Push Worker e só altera
os artefatos públicos quando existe valor concreto para o(s) event_id(s) pedidos.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
PUBLICOS = ROOT / "dados-br" / "publicos-complementares.json"
MELHORES = ROOT / "dados-br" / "melhores-momentos.json"
RESULTADOS = ROOT / "resultados.json"
DEFAULT_BASE = "https://push.formuladogol.com.br"


def load_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return deepcopy(fallback)


def save_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def as_number(value: Any) -> int | float | None:
    if value is None or value == "":
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if not (n >= 0):
        return None
    return int(n) if n.is_integer() else round(n, 2)


def youtube_id(url: str) -> str:
    try:
        parsed = urllib.parse.urlparse(str(url or "").strip())
    except Exception:
        return ""
    host = parsed.netloc.lower().split(":", 1)[0]
    value = ""
    if host in {"youtu.be", "www.youtu.be"}:
        value = parsed.path.strip("/").split("/", 1)[0]
    elif host == "youtube.com" or host.endswith(".youtube.com"):
        if parsed.path.rstrip("/") == "/watch":
            value = (urllib.parse.parse_qs(parsed.query).get("v") or [""])[0]
        else:
            parts = [x for x in parsed.path.split("/") if x]
            if len(parts) >= 2 and parts[0] in {"embed", "shorts", "live"}:
                value = parts[1]
    return value if re.fullmatch(r"[A-Za-z0-9_-]{6,20}", value or "") else ""


def event_ids(args: argparse.Namespace) -> list[str]:
    raw = []
    if args.event_id:
        raw.append(args.event_id)
    if args.event_ids:
        raw.extend(args.event_ids.split(","))
    out: list[str] = []
    for item in raw:
        value = str(item or "").strip()
        if value and value not in out:
            out.append(value)
    return out


def fetch_rows(base_url: str, ids: list[str], timeout: float = 15.0) -> list[dict[str, Any]]:
    if not ids:
        raise ValueError("ao menos um event_id é obrigatório")
    base = base_url.rstrip("/")
    query = urllib.parse.urlencode({"event_ids": ",".join(ids[:40])})
    req = urllib.request.Request(
        f"{base}/v1/postgame?{query}",
        headers={"Accept": "application/json", "Cache-Control": "no-cache", "User-Agent": "FormulaDoGol-GitHub-Consolidator/2.0"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        payload = json.load(response)
    if payload.get("ok") is not True or not isinstance(payload.get("rows"), list):
        raise RuntimeError("payload inválido do Fastlane")
    wanted = set(ids)
    return [row for row in payload["rows"] if isinstance(row, dict) and str(row.get("event_id") or "") in wanted]


def material_public_view(row: dict[str, Any]) -> dict[str, Any]:
    return {
        key: row.get(key)
        for key in (
            "tipo", "fonte", "fonte_publico", "fonte_pagantes", "fonte_renda", "origem",
            "publico_status", "pagantes_status", "renda_status", "publico", "pagantes", "renda",
        )
        if key in row
    }


def apply_public_rows(payload: dict[str, Any], rows: list[dict[str, Any]], stamp: str) -> tuple[dict[str, Any], list[str]]:
    out = deepcopy(payload) if isinstance(payload, dict) else {}
    jogos = out.get("jogos") if isinstance(out.get("jogos"), dict) else {}
    out["jogos"] = jogos
    changed: list[str] = []
    for source in rows:
        eid = str(source.get("event_id") or "").strip()
        if not eid:
            continue
        current = deepcopy(jogos.get(eid) if isinstance(jogos.get(eid), dict) else {})
        before = material_public_view(current)
        sources = source.get("public_sources") if isinstance(source.get("public_sources"), dict) else {}
        publico = as_number(source.get("publico"))
        pagantes = as_number(source.get("publico_pagante"))
        renda = as_number(source.get("renda"))
        if publico is not None and publico > 0:
            current.update({"tipo": "presente", "publico": int(publico), "publico_status": "divulgado"})
            if sources.get("publico"):
                current["fonte"] = sources["publico"]
                current["fonte_publico"] = sources["publico"]
        if pagantes is not None:
            current.update({"pagantes": int(pagantes), "pagantes_status": "divulgado"})
            if sources.get("publico_pagante"):
                current["fonte_pagantes"] = sources["publico_pagante"]
        if renda is not None and renda > 0:
            current.update({"renda": renda, "renda_status": "divulgado"})
            if sources.get("renda"):
                current["fonte_renda"] = sources["renda"]
        if material_public_view(current) == before:
            continue
        current["origem"] = "cloudflare-postgame-fastlane"
        current["verificado_em"] = stamp
        jogos[eid] = current
        changed.append(eid)
    if changed:
        out["atualizado_em"] = stamp
    return out, changed


def result_index(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    rows = payload.get("resultados") if isinstance(payload, dict) else []
    return {str(row.get("event_id") or row.get("id") or ""): row for row in (rows or []) if isinstance(row, dict)}


def team_name(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("nome") or value.get("name") or "").strip()
    return str(value or "").strip()


def material_highlight_view(row: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in row.items() if k not in {"atualizado_em", "verificado_em"}}


def apply_highlight_rows(payload: dict[str, Any], rows: list[dict[str, Any]], results: dict[str, dict[str, Any]], stamp: str) -> tuple[dict[str, Any], list[str]]:
    out = deepcopy(payload) if isinstance(payload, dict) else {}
    jogos = out.get("jogos") if isinstance(out.get("jogos"), dict) else {}
    out["jogos"] = jogos
    changed: list[str] = []
    for source in rows:
        eid = str(source.get("event_id") or "").strip()
        game = results.get(eid)
        highlight = source.get("highlight") if isinstance(source.get("highlight"), dict) else None
        if not eid or not game or not highlight:
            continue
        url = str(highlight.get("url") or "").strip()
        vid = str(highlight.get("video_id") or youtube_id(url)).strip()
        if not url or not vid or not youtube_id(url):
            continue
        item: dict[str, Any] = {
            "event_id": eid,
            "chave": eid,
            "rodada": game.get("rodada"),
            "mandante": team_name(game.get("mandante")),
            "visitante": team_name(game.get("visitante")),
            "placar_mandante": game.get("placar_mandante"),
            "placar_visitante": game.get("placar_visitante"),
            "video_id": vid,
            "titulo": str(highlight.get("titulo") or "").strip(),
            "url": url,
            "thumbnail": str(highlight.get("thumbnail") or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg").strip(),
            "published_at": str(highlight.get("published_at") or "").strip(),
            "fonte": str(highlight.get("fonte") or highlight.get("channel_title") or "").strip(),
            "channel_title": str(highlight.get("channel_title") or "").strip(),
            "channel_id": str(highlight.get("channel_id") or "").strip(),
            "embeddable": bool(highlight.get("embed", True)),
            "confianca": float(highlight.get("confianca") or 1.0),
            "fonte_busca": str(highlight.get("origem") or "cloudflare-fastlane-youtube-uploads"),
            "motivos": ["vídeo oficial encontrado pelo Cloudflare Fastlane", "jogo já encerrado em resultados.json"],
        }
        item = {k: v for k, v in item.items() if v not in (None, "")}
        previous = jogos.get(eid) if isinstance(jogos.get(eid), dict) else {}
        if material_highlight_view(previous) == material_highlight_view(item):
            continue
        item["verificado_em"] = stamp
        jogos[eid] = item
        changed.append(eid)
    if changed:
        out["atualizado_em"] = stamp
        out["modo_ultima_execucao"] = "cloudflare-fastlane"
        out["total_vinculados"] = len(jogos)
    return out, changed


def write_outputs(path: str, public_changed: bool, highlight_changed: bool) -> None:
    if not path:
        return
    changed = public_changed or highlight_changed
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(f"publicos_changed={'true' if public_changed else 'false'}\n")
        fh.write(f"melhores_momentos_changed={'true' if highlight_changed else 'false'}\n")
        fh.write(f"changed={'true' if changed else 'false'}\n")


def self_test() -> None:
    stamp = "2026-09-21T12:00:00Z"
    pub, ids = apply_public_rows({"jogos": {}}, [{
        "event_id": "1", "publico": 12345, "publico_pagante": 12000, "renda": 456789,
        "public_sources": {"publico": "https://example.com/a", "publico_pagante": "https://example.com/a", "renda": "https://example.com/b"},
    }], stamp)
    assert ids == ["1"] and pub["jogos"]["1"]["publico"] == 12345 and pub["jogos"]["1"]["renda"] == 456789
    pub2, ids2 = apply_public_rows(pub, [{
        "event_id": "1", "publico": 12345, "publico_pagante": 12000, "renda": 456789,
        "public_sources": {"publico": "https://example.com/a", "publico_pagante": "https://example.com/a", "renda": "https://example.com/b"},
    }], "2026-09-21T13:00:00Z")
    assert ids2 == [] and pub2 == pub, "timestamp isolado não pode virar mudança material"
    mm, mids = apply_highlight_rows({"jogos": {}}, [{"event_id": "1", "highlight": {
        "video_id": "AbCdEf12345", "url": "https://www.youtube.com/watch?v=AbCdEf12345", "titulo": "A x B | MELHORES MOMENTOS",
        "fonte": "GE TV / YouTube", "channel_title": "GE TV", "channel_id": "UCgCKagVhzGnZcuP9bSMgMCg", "embed": True,
    }}], {"1": {"event_id": "1", "rodada": 1, "mandante": {"nome": "A"}, "visitante": {"nome": "B"}, "placar_mandante": 1, "placar_visitante": 0}}, stamp)
    assert mids == ["1"] and mm["jogos"]["1"]["video_id"] == "AbCdEf12345"
    print("SELF-TEST OK: importador Fastlane é material/idempotente.")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tipo", choices=("publicos", "melhores_momentos", "ambos"), default="ambos")
    parser.add_argument("--event-id", default="")
    parser.add_argument("--event-ids", default="")
    parser.add_argument("--base-url", default=os.environ.get("FDG_PUSH_BASE_URL", DEFAULT_BASE))
    parser.add_argument("--github-output", default="")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0

    ids = event_ids(args)
    if not ids:
        parser.error("informe --event-id ou --event-ids")
    rows = fetch_rows(args.base_url, ids)
    stamp = now_iso()
    public_changed: list[str] = []
    highlight_changed: list[str] = []

    if args.tipo in {"publicos", "ambos"}:
        payload = load_json(PUBLICOS, {"jogos": {}})
        payload, public_changed = apply_public_rows(payload, rows, stamp)
        if public_changed:
            save_json(PUBLICOS, payload)

    if args.tipo in {"melhores_momentos", "ambos"}:
        payload = load_json(MELHORES, {"jogos": {}})
        results = result_index(load_json(RESULTADOS, {"resultados": []}))
        payload, highlight_changed = apply_highlight_rows(payload, rows, results, stamp)
        if highlight_changed:
            save_json(MELHORES, payload)

    write_outputs(args.github_output, bool(public_changed), bool(highlight_changed))
    print(json.dumps({
        "ok": True,
        "requested": ids,
        "rows": len(rows),
        "publicos_changed": public_changed,
        "melhores_momentos_changed": highlight_changed,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
