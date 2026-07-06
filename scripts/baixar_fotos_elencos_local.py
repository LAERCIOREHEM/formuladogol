#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
baixar_fotos_elencos_local.py — baixa localmente as fotos dos jogadores.

Use na raiz do repositório:

    py scripts\baixar_fotos_elencos_local.py

O script lê:
    dados-br/elencos.json
    dados-br/jogadores.json (se existir)

Baixa fotos para:
    img/jogadores-br/<id-ou-slug>.png

E atualiza os JSONs com:
    foto_local: "img/jogadores-br/<arquivo>.png"

Depois suba no GitHub:
    img/jogadores-br/
    dados-br/elencos.json
    dados-br/jogadores.json (se alterado)
"""
from __future__ import annotations

import json
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
ELENCOS = ROOT / "dados-br" / "elencos.json"
JOGADORES = ROOT / "dados-br" / "jogadores.json"
DEST = ROOT / "img" / "jogadores-br"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
}


def slug(valor: Any) -> str:
    s = unicodedata.normalize("NFD", str(valor or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s.lower()).strip("-")
    return s or "jogador"


def carregar(path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def salvar(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def atleta_id(j: dict[str, Any]) -> str:
    for campo in ("id", "athlete_id", "espn_id"):
        val = str(j.get(campo) or "").strip()
        if val:
            return val
    return ""


def url_foto(j: dict[str, Any]) -> str:
    for campo in ("foto", "headshot", "headshot_href", "imagem", "image"):
        val = str(j.get(campo) or "").strip()
        if val.startswith("https://"):
            return val
    aid = atleta_id(j)
    if aid:
        return f"https://a.espncdn.com/i/headshots/soccer/players/full/{urllib.parse.quote(aid)}.png"
    return ""


def nome_arquivo(j: dict[str, Any]) -> str:
    aid = atleta_id(j)
    if aid:
        return f"espn-{slug(aid)}.png"
    return f"{slug(j.get('nome') or j.get('name') or 'jogador')}.png"


def baixar(url: str, destino: Path) -> bool:
    if destino.exists() and destino.stat().st_size > 3000:
        return True
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=25) as resp:
            ctype = (resp.headers.get("Content-Type") or "").lower()
            data = resp.read()
        # Evita salvar HTML/placeholder vazio como imagem.
        if not data or len(data) < 2500 or "text/html" in ctype:
            return False
        destino.parent.mkdir(parents=True, exist_ok=True)
        destino.write_bytes(data)
        return True
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError):
        return False


def iter_elencos(payload: dict[str, Any]):
    elencos = payload.get("elencos") or {}
    if not isinstance(elencos, dict):
        return
    for clube, lista in elencos.items():
        if not isinstance(lista, list):
            continue
        for j in lista:
            if isinstance(j, dict):
                yield clube, j


def processar_elencos() -> tuple[int, int]:
    payload = carregar(ELENCOS, {"elencos": {}})
    baixadas = 0
    tentadas = 0
    for clube, j in iter_elencos(payload):
        url = url_foto(j)
        if not url:
            j["foto_status"] = "sem_url"
            continue
        tentadas += 1
        arq = nome_arquivo(j)
        destino = DEST / arq
        if baixar(url, destino):
            j["foto_local"] = f"img/jogadores-br/{arq}"
            j["foto_status"] = "local"
            baixadas += 1
        else:
            j["foto_status"] = "indisponivel_na_fonte"
        time.sleep(0.05)
    payload["fotos_baixadas_localmente"] = baixadas
    payload["fotos_tentadas_localmente"] = tentadas
    salvar(ELENCOS, payload)
    return tentadas, baixadas


def processar_jogadores_json() -> tuple[int, int]:
    if not JOGADORES.exists():
        return (0, 0)
    payload = carregar(JOGADORES, {})
    tentadas = 0
    baixadas = 0
    for chave in ("artilharia", "assistencias", "participacoes_gol"):
        lista = payload.get(chave) or []
        if not isinstance(lista, list):
            continue
        for j in lista:
            if not isinstance(j, dict):
                continue
            url = url_foto(j)
            if not url:
                continue
            tentadas += 1
            arq = nome_arquivo(j)
            destino = DEST / arq
            if baixar(url, destino):
                j["foto_local"] = f"img/jogadores-br/{arq}"
                baixadas += 1
            time.sleep(0.03)
    payload["fotos_baixadas_localmente"] = baixadas
    payload["fotos_tentadas_localmente"] = tentadas
    salvar(JOGADORES, payload)
    return tentadas, baixadas


def main() -> None:
    print("== BAIXAR FOTOS DOS ELENCOS DO BRASILEIRÃO ==")
    if not ELENCOS.exists():
        raise SystemExit("Não achei dados-br/elencos.json. Rode primeiro: py scripts\\baixar_elencos_local.py")
    t1, b1 = processar_elencos()
    t2, b2 = processar_jogadores_json()
    print(f"Elencos: {b1}/{t1} fotos salvas em img/jogadores-br/")
    if t2:
        print(f"Estatísticas: {b2}/{t2} fotos vinculadas em dados-br/jogadores.json")
    print("Agora suba no GitHub: img/jogadores-br/, dados-br/elencos.json e, se alterado, dados-br/jogadores.json.")


if __name__ == "__main__":
    main()
