#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
apurar_rodada.py — Apuração das apostas por rodada do Brasileirão 2026.

Lê:
  - br_palpites no Supabase
  - resultados.json / jogos.json / espn_eventos.json do repositório

Gera:
  - dados-br/apuracao.json
  - dados-br/ranking-apostas.json

Segurança:
  - descarta palpite atualizado depois de fecha_em
  - não altera o módulo Copa
  - não depende de bibliotecas externas
"""
from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

FUSO_BRT = timezone(timedelta(hours=-3))
TEMPORADA = int(os.environ.get("BRASILEIRAO_TEMPORADA", "2026"))
TABELA = os.environ.get("SUPABASE_BR_PALPITES_TABLE", "br_palpites")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_ANON_KEY") or ""

ROOT = Path(__file__).resolve().parents[1]


def agora_brt() -> datetime:
    return datetime.now(FUSO_BRT)


def carregar_json(nome: str, fallback: Any) -> Any:
    p = ROOT / nome
    if not p.exists():
        return fallback
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"Aviso: não consegui ler {nome}: {exc}")
        return fallback


def parse_dt(valor: Any) -> datetime | None:
    if not valor:
        return None
    s = str(valor)
    try:
        if s.endswith("Z"):
            return datetime.fromisoformat(s.replace("Z", "+00:00"))
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=FUSO_BRT)
        return dt
    except ValueError:
        return None


def normalizar(s: Any) -> str:
    import re
    import unicodedata
    txt = unicodedata.normalize("NFD", str(s or ""))
    txt = "".join(c for c in txt if unicodedata.category(c) != "Mn")
    txt = re.sub(r"[^a-zA-Z0-9]+", "-", txt.lower()).strip("-")
    return txt


def jogo_id(j: dict[str, Any]) -> str:
    if j.get("event_id"):
        return str(j["event_id"])
    mand = normalizar((j.get("mandante") or {}).get("nome") or j.get("mandante"))
    vis = normalizar((j.get("visitante") or {}).get("nome") or j.get("visitante"))
    dt = str(j.get("data_iso") or "")[:16]
    return f"{j.get('rodada')}-{mand}-{vis}-{dt}"


def placar_disponivel(j: dict[str, Any]) -> bool:
    return j.get("placar_mandante") is not None and j.get("placar_visitante") is not None


def resultado_mapa() -> dict[str, dict[str, Any]]:
    resultados = carregar_json("resultados.json", {}).get("resultados", []) or []
    jogos = carregar_json("jogos.json", {}).get("jogos", []) or []
    eventos = carregar_json("espn_eventos.json", {}).get("eventos", []) or []
    todos = []
    todos.extend(resultados)
    todos.extend([j for j in jogos if placar_disponivel(j)])
    for e in eventos:
        if placar_disponivel(e):
            todos.append({
                "event_id": e.get("event_id"),
                "rodada": e.get("rodada"),
                "data_iso": e.get("data_iso"),
                "mandante": {"nome": e.get("mandante")},
                "visitante": {"nome": e.get("visitante")},
                "placar_mandante": e.get("placar_mandante"),
                "placar_visitante": e.get("placar_visitante"),
                "estado": e.get("estado"),
            })

    mapa: dict[str, dict[str, Any]] = {}
    for j in todos:
        if not placar_disponivel(j):
            continue
        rid = jogo_id(j)
        obj = {
            "event_id": rid,
            "rodada": int(j.get("rodada") or 0),
            "mandante": (j.get("mandante") or {}).get("nome") or j.get("mandante"),
            "visitante": (j.get("visitante") or {}).get("nome") or j.get("visitante"),
            "placar_mandante": int(j["placar_mandante"]),
            "placar_visitante": int(j["placar_visitante"]),
            "data_iso": j.get("data_iso"),
        }
        mapa[rid] = obj
        if j.get("event_id"):
            mapa[str(j["event_id"])] = obj
    return mapa


def sinal(n: int) -> int:
    return 1 if n > 0 else -1 if n < 0 else 0


def calcular(p: dict[str, Any], r: dict[str, Any]) -> dict[str, Any]:
    pm, pv = int(p["placar_mandante"]), int(p["placar_visitante"])
    rm, rv = int(r["placar_mandante"]), int(r["placar_visitante"])
    if pm == rm and pv == rv:
        return {"pontos": 5, "tipo": "exato"}
    sp, sr = sinal(pm - pv), sinal(rm - rv)
    if sp != sr:
        return {"pontos": 0, "tipo": "erro"}
    if sr == 0:
        return {"pontos": 2, "tipo": "resultado"}
    if (pm - pv) == (rm - rv):
        return {"pontos": 3, "tipo": "saldo"}
    return {"pontos": 2, "tipo": "resultado"}


def palpite_valido_no_prazo(p: dict[str, Any]) -> bool:
    atualizado = parse_dt(p.get("atualizado_em") or p.get("criado_em"))
    fecha = parse_dt(p.get("fecha_em"))
    if not atualizado or not fecha:
        return True
    return atualizado <= fecha


def buscar_palpites_supabase() -> list[dict[str, Any]]:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError(
            "SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY não configurados. "
            "No GitHub Actions, cadastre os secrets antes de rodar a apuração."
        )
    params = urllib.parse.urlencode({
        "temporada": f"eq.{TEMPORADA}",
        "select": "*",
        "order": "rodada.asc,membro.asc",
    })
    url = f"{SUPABASE_URL}/rest/v1/{TABELA}?{params}"
    req = urllib.request.Request(url, headers={
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if not isinstance(data, list):
        raise RuntimeError(f"Resposta inesperada do Supabase: {data!r}")
    return data


def apurar(palpites: list[dict[str, Any]], resultados: dict[str, dict[str, Any]]) -> dict[str, Any]:
    por_rodada: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for p in palpites:
        try:
            rodada = int(p.get("rodada") or 0)
        except (TypeError, ValueError):
            continue
        if rodada <= 0:
            continue
        por_rodada[rodada].append(p)

    saida_rodadas: list[dict[str, Any]] = []
    geral: dict[str, dict[str, Any]] = {}

    for rodada in sorted(por_rodada):
        acumulado: dict[str, dict[str, Any]] = {}
        detalhes_jogos: dict[str, dict[str, Any]] = {}
        jogos_apurados: set[str] = set()
        descartados = 0

        for p in por_rodada[rodada]:
            if not palpite_valido_no_prazo(p):
                descartados += 1
                continue
            eid = str(p.get("event_id") or p.get("jogo_chave") or "")
            r = resultados.get(eid)
            if not r:
                continue
            det = calcular(p, r)
            membro = str(p.get("membro") or "").strip()
            if not membro:
                continue
            jogos_apurados.add(eid)

            base = acumulado.setdefault(membro, {
                "membro": membro, "pontos": 0, "cravadas": 0, "saldos": 0,
                "resultados": 0, "erros": 0, "palpites_validos": 0
            })
            base["pontos"] += det["pontos"]
            base["palpites_validos"] += 1
            if det["tipo"] == "exato": base["cravadas"] += 1
            elif det["tipo"] == "saldo": base["saldos"] += 1
            elif det["tipo"] == "resultado": base["resultados"] += 1
            elif det["tipo"] == "erro": base["erros"] += 1

            g = geral.setdefault(membro, {
                "membro": membro, "pontos": 0, "cravadas": 0, "saldos": 0,
                "resultados": 0, "erros": 0, "palpites_validos": 0, "rodadas_pontuadas": 0,
                "vitorias_rodada": 0
            })
            g["pontos"] += det["pontos"]
            g["palpites_validos"] += 1
            if det["tipo"] == "exato": g["cravadas"] += 1
            elif det["tipo"] == "saldo": g["saldos"] += 1
            elif det["tipo"] == "resultado": g["resultados"] += 1
            elif det["tipo"] == "erro": g["erros"] += 1

            detalhes_jogos.setdefault(eid, {"resultado": r, "palpites": []})["palpites"].append({
                "membro": membro,
                "palpite": f"{p.get('placar_mandante')}×{p.get('placar_visitante')}",
                "pontos": det["pontos"],
                "tipo": det["tipo"],
            })

        ranking = sorted(acumulado.values(), key=lambda x: (
            -x["pontos"], -x["cravadas"], -x["saldos"], -x["resultados"], x["membro"]
        ))
        for i, row in enumerate(ranking, 1):
            row["pos"] = i
            if row["palpites_validos"]:
                geral[row["membro"]]["rodadas_pontuadas"] += 1

        vencedores = []
        if ranking:
            top = ranking[0]
            vencedores = [r["membro"] for r in ranking if r["pontos"] == top["pontos"] and r["cravadas"] == top["cravadas"] and r["saldos"] == top["saldos"]]
            for nome in vencedores:
                if nome in geral:
                    geral[nome]["vitorias_rodada"] += 1

        saida_rodadas.append({
            "rodada": rodada,
            "participantes": len(acumulado),
            "jogos_apurados": len(jogos_apurados),
            "palpites_descartados_fora_do_prazo": descartados,
            "vencedores": vencedores,
            "ranking": ranking,
            "jogos": list(detalhes_jogos.values()),
        })

    ranking_geral = sorted(geral.values(), key=lambda x: (
        -x["pontos"], -x["cravadas"], -x["saldos"], -x["resultados"], x["membro"]
    ))
    for i, row in enumerate(ranking_geral, 1):
        row["pos"] = i

    return {
        "temporada": TEMPORADA,
        "atualizado_em": agora_brt().isoformat(),
        "fonte": "Supabase br_palpites + JSONs ESPN locais",
        "rodadas": saida_rodadas,
        "ranking_geral": ranking_geral,
    }


def gravar(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def main() -> int:
    try:
      palpites = buscar_palpites_supabase()
    except Exception as exc:  # noqa: BLE001
      print(f"ERRO: {exc}")
      return 1

    resultados = resultado_mapa()
    payload = apurar(palpites, resultados)
    gravar(ROOT / "dados-br" / "apuracao.json", payload)
    gravar(ROOT / "dados-br" / "ranking-apostas.json", {
        "temporada": TEMPORADA,
        "atualizado_em": payload["atualizado_em"],
        "fonte": payload["fonte"],
        "ranking_geral": payload["ranking_geral"],
    })

    print("Apuração concluída.")
    print(f"Rodadas apuradas: {len(payload['rodadas'])}")
    print(f"Participantes no geral: {len(payload['ranking_geral'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
