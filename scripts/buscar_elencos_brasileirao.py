#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
buscar_elencos_brasileirao.py — coleta elencos dos clubes do Brasileirão pela ESPN.

Objetivo da Execução 9:
  - preencher dados-br/elencos.json com jogadores, posições, números, idade e foto;
  - não quebrar o workflow caso a ESPN não entregue roster para algum clube;
  - preservar nomes canônicos usados pelo Ranking/Clubes.

A API da ESPN não é oficial para este uso; por isso este script é tolerante:
se uma coleta falhar, ele grava avisos e mantém a estrutura válida para o site.
"""
from __future__ import annotations

import json
import re
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

FUSO_BRASILIA = timezone(timedelta(hours=-3))
URL_TEAMS = "https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/teams"
URL_ROSTER = "https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/teams/{team_id}/roster"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
}

CANONICOS = [
    "Athletico-PR", "Atlético-MG", "Bahia", "Botafogo", "Bragantino",
    "Chapecoense", "Corinthians", "Coritiba", "Cruzeiro", "Flamengo",
    "Fluminense", "Grêmio", "Internacional", "Mirassol", "Palmeiras",
    "Remo", "Santos", "São Paulo", "Vasco da Gama", "Vitória",
]

ALIASES = {
    "athletico-pr": "Athletico-PR", "athletico paranaense": "Athletico-PR", "athletico": "Athletico-PR", "cap": "Athletico-PR",
    "atletico-mg": "Atlético-MG", "atletico mineiro": "Atlético-MG", "atletico mg": "Atlético-MG", "clube atletico mineiro": "Atlético-MG", "cam": "Atlético-MG",
    "bahia": "Bahia", "esporte clube bahia": "Bahia", "ec bahia": "Bahia", "bah": "Bahia",
    "botafogo": "Botafogo", "botafogo rj": "Botafogo", "botafogo de futebol e regatas": "Botafogo", "bot": "Botafogo",
    "bragantino": "Bragantino", "red bull bragantino": "Bragantino", "rb bragantino": "Bragantino", "rbb": "Bragantino",
    "chapecoense": "Chapecoense", "associacao chapecoense de futebol": "Chapecoense", "cha": "Chapecoense",
    "corinthians": "Corinthians", "sc corinthians paulista": "Corinthians", "corinthians paulista": "Corinthians", "cor": "Corinthians",
    "coritiba": "Coritiba", "coritiba fc": "Coritiba", "coritiba foot ball club": "Coritiba", "cfc": "Coritiba",
    "cruzeiro": "Cruzeiro", "cruzeiro ec": "Cruzeiro", "cruzeiro esporte clube": "Cruzeiro", "cru": "Cruzeiro",
    "flamengo": "Flamengo", "cr flamengo": "Flamengo", "clube de regatas do flamengo": "Flamengo", "fla": "Flamengo",
    "fluminense": "Fluminense", "fluminense fc": "Fluminense", "fluminense football club": "Fluminense", "flu": "Fluminense",
    "gremio": "Grêmio", "gremio fbpa": "Grêmio", "gremio foot-ball porto alegrense": "Grêmio", "gre": "Grêmio",
    "internacional": "Internacional", "sc internacional": "Internacional", "sport club internacional": "Internacional", "inter de porto alegre": "Internacional", "int": "Internacional",
    "mirassol": "Mirassol", "mirassol fc": "Mirassol", "mirassol futebol clube": "Mirassol", "mir": "Mirassol",
    "palmeiras": "Palmeiras", "se palmeiras": "Palmeiras", "sociedade esportiva palmeiras": "Palmeiras", "pal": "Palmeiras",
    "remo": "Remo", "clube do remo": "Remo", "rem": "Remo",
    "santos": "Santos", "santos fc": "Santos", "santos futebol clube": "Santos", "san": "Santos",
    "sao paulo": "São Paulo", "sao paulo fc": "São Paulo", "sao paulo futebol clube": "São Paulo", "sao": "São Paulo",
    "vasco": "Vasco da Gama", "vasco da gama": "Vasco da Gama", "cr vasco da gama": "Vasco da Gama", "club de regatas vasco da gama": "Vasco da Gama", "vas": "Vasco da Gama",
    "vitoria": "Vitória", "ec vitoria": "Vitória", "esporte clube vitoria": "Vitória", "vitoria ba": "Vitória", "vit": "Vitória",
}

TOKENS = [
    ("paranaense", "Athletico-PR"), ("athletico", "Athletico-PR"), ("mineiro", "Atlético-MG"),
    ("bragantino", "Bragantino"), ("chapecoense", "Chapecoense"), ("corinthians", "Corinthians"),
    ("coritiba", "Coritiba"), ("cruzeiro", "Cruzeiro"), ("flamengo", "Flamengo"),
    ("fluminense", "Fluminense"), ("gremio", "Grêmio"), ("internacional", "Internacional"),
    ("mirassol", "Mirassol"), ("palmeiras", "Palmeiras"), ("remo", "Remo"), ("santos", "Santos"),
    ("vasco", "Vasco da Gama"), ("botafogo", "Botafogo"), ("bahia", "Bahia"), ("vitoria", "Vitória"),
]


def agora_iso() -> str:
    return datetime.now(FUSO_BRASILIA).isoformat()


def normalizar(valor: Any) -> str:
    s = unicodedata.normalize("NFD", str(valor or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = re.sub(r"[^a-z0-9\- ]", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


def para_canonico(*candidatos: Any) -> str | None:
    for cand in candidatos:
        n = normalizar(cand)
        if not n:
            continue
        if n in ALIASES:
            return ALIASES[n]
        for canon in CANONICOS:
            if n == normalizar(canon):
                return canon
    texto = " ".join(normalizar(c) for c in candidatos if c)
    for token, canon in TOKENS:
        if re.search(r"\b" + re.escape(token) + r"\b", texto):
            return canon
    return None


def fetch_json(url: str, timeout: int = 25, tentativas: int = 2) -> dict[str, Any]:
    ultimo: Exception | None = None
    for i in range(1, tentativas + 1):
        try:
            sep = "&" if "?" in url else "?"
            req = urllib.request.Request(f"{url}{sep}_={int(time.time())}", headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout + 8 * (i - 1)) as r:
                charset = r.headers.get_content_charset() or "utf-8"
                return json.loads(r.read().decode(charset, errors="replace"))
        except Exception as e:  # noqa: BLE001
            ultimo = e
            if i < tentativas:
                time.sleep(1.5 * i)
    raise RuntimeError(f"falha ao buscar {url}: {ultimo}")


def gravar(caminho: str, payload: dict[str, Any]) -> None:
    p = Path(caminho)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(p)


def carregar_json(caminho: str, fallback: dict[str, Any]) -> dict[str, Any]:
    try:
        return json.loads(Path(caminho).read_text(encoding="utf-8"))
    except Exception:
        return fallback


def coletar_times(no: Any, achados: list[dict[str, Any]]) -> None:
    if isinstance(no, dict):
        team = no.get("team") if isinstance(no.get("team"), dict) else no
        if isinstance(team, dict) and (team.get("id") or team.get("uid")) and (
            team.get("displayName") or team.get("name") or team.get("shortDisplayName")
        ):
            achados.append(team)
        for v in no.values():
            coletar_times(v, achados)
    elif isinstance(no, list):
        for v in no:
            coletar_times(v, achados)


def mapear_times_espn() -> tuple[dict[str, str], list[str]]:
    avisos: list[str] = []
    data = fetch_json(URL_TEAMS)
    teams: list[dict[str, Any]] = []
    coletar_times(data, teams)
    mapa: dict[str, str] = {}
    vistos_ids: set[str] = set()
    for t in teams:
        team_id = str(t.get("id") or t.get("uid") or "").split(":")[-1]
        if not team_id or team_id in vistos_ids:
            continue
        vistos_ids.add(team_id)
        canon = para_canonico(t.get("displayName"), t.get("shortDisplayName"), t.get("name"), t.get("location"), t.get("abbreviation"), t.get("slug"))
        if canon and canon not in mapa:
            mapa[canon] = team_id
    faltam = sorted(set(CANONICOS) - set(mapa))
    if faltam:
        avisos.append("Times sem id ESPN no endpoint /teams: " + ", ".join(faltam))
    return mapa, avisos


def extrair_athletes(no: Any, saida: list[dict[str, Any]]) -> None:
    if isinstance(no, dict):
        if isinstance(no.get("athletes"), list):
            for a in no.get("athletes") or []:
                if isinstance(a, dict):
                    saida.append(a.get("athlete") if isinstance(a.get("athlete"), dict) else a)
        # alguns endpoints podem devolver uma lista plana de atletas
        if (no.get("displayName") or no.get("fullName") or no.get("name")) and (no.get("position") or no.get("jersey") or no.get("id")):
            saida.append(no)
        for v in no.values():
            extrair_athletes(v, saida)
    elif isinstance(no, list):
        for v in no:
            extrair_athletes(v, saida)


def texto_posicao(pos: Any) -> str:
    if isinstance(pos, dict):
        return str(pos.get("displayName") or pos.get("name") or pos.get("abbreviation") or "")
    return str(pos or "")


def foto_atleta(a: dict[str, Any]) -> str:
    head = a.get("headshot")
    if isinstance(head, dict) and head.get("href"):
        return str(head.get("href"))
    if isinstance(head, str):
        return head
    aid = a.get("id")
    if aid:
        return f"https://a.espncdn.com/i/headshots/soccer/players/full/{aid}.png"
    return ""


def normalizar_atleta(a: dict[str, Any]) -> dict[str, Any] | None:
    nome = a.get("displayName") or a.get("fullName") or a.get("name") or a.get("shortName")
    if not nome:
        return None
    out = {
        "id": str(a.get("id") or ""),
        "nome": str(nome),
        "posicao": texto_posicao(a.get("position")),
        "numero": str(a.get("jersey") or a.get("number") or ""),
        "idade": a.get("age") or "",
        "foto": foto_atleta(a),
    }
    return out


def coletar_roster(team_id: str) -> list[dict[str, Any]]:
    url = URL_ROSTER.format(team_id=urllib.parse.quote(str(team_id)))
    data = fetch_json(url)
    atletas: list[dict[str, Any]] = []
    extrair_athletes(data, atletas)
    vistos: set[str] = set()
    jogadores: list[dict[str, Any]] = []
    for a in atletas:
        j = normalizar_atleta(a)
        if not j:
            continue
        chave = j.get("id") or normalizar(j.get("nome"))
        if chave in vistos:
            continue
        vistos.add(chave)
        jogadores.append(j)
    jogadores.sort(key=lambda x: (normalizar(x.get("posicao")), normalizar(x.get("nome"))))
    return jogadores


def main() -> None:
    antigo = carregar_json("dados-br/elencos.json", {"elencos": {}})
    elencos_antigos = antigo.get("elencos") or {}
    avisos: list[str] = []
    elencos: dict[str, list[dict[str, Any]]] = dict(elencos_antigos) if isinstance(elencos_antigos, dict) else {}
    mapa: dict[str, str] = {}

    try:
        mapa, avisos_times = mapear_times_espn()
        avisos.extend(avisos_times)
    except Exception as e:  # noqa: BLE001
        avisos.append(f"Falha ao buscar lista de times ESPN: {type(e).__name__}: {e}")

    for clube in CANONICOS:
        team_id = mapa.get(clube)
        if not team_id:
            elencos.setdefault(clube, [])
            continue
        try:
            jogadores = coletar_roster(team_id)
            if jogadores:
                elencos[clube] = jogadores
                print(f"{clube}: {len(jogadores)} jogadores")
            else:
                elencos.setdefault(clube, [])
                avisos.append(f"{clube}: ESPN retornou roster vazio")
        except Exception as e:  # noqa: BLE001
            elencos.setdefault(clube, [])
            avisos.append(f"{clube}: falha no roster ESPN ({type(e).__name__}: {e})")
        time.sleep(0.25)

    total = sum(len(v) for v in elencos.values() if isinstance(v, list))
    saida = {
        "atualizado_em": agora_iso(),
        "fonte": "ESPN roster endpoint + fallback local",
        "metodologia": "Mapeia os 20 clubes canônicos pelo endpoint de times da ESPN e busca roster por equipe. Falhas individuais não quebram o site.",
        "total_clubes_com_elenco": sum(1 for v in elencos.values() if isinstance(v, list) and v),
        "total_jogadores": total,
        "elencos": {c: elencos.get(c, []) for c in CANONICOS},
        "avisos": avisos,
    }
    gravar("dados-br/elencos.json", saida)
    print(f"dados-br/elencos.json gerado: {saida['total_clubes_com_elenco']} clubes, {total} jogadores")
    if avisos:
        print("Avisos:")
        for a in avisos[:40]:
            print(" -", a)


if __name__ == "__main__":
    main()
