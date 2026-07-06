#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
atualizar_espn.py — Fonte ESPN para o módulo Brasileirão 2026.

Execução 1 da migração:
  - tabela.json        -> classificação via ESPN standings, preservando o
                         formato e os nomes canônicos que alimentam o Ranking.
  - jogos.json         -> próximos jogos via ESPN scoreboard.
  - resultados.json    -> resultados já encerrados via ESPN scoreboard.
  - espn_eventos.json  -> índice de eventos ESPN usado pelo AO VIVO/onde assistir.

Regras de segurança:
  1. O Ranking atual usa nomes exatos nos palpites. Por isso, todos os times
     gravados continuam nos 20 nomes canônicos do site.
  2. Se a tabela vier incompleta, duplicada ou com time não mapeado, o script
     falha antes de gravar tabela.json. O arquivo anterior fica preservado.
  3. Jogos/resultados só são gravados quando a ESPN entregar pelo menos um
     evento mapeável. Se a API estiver indisponível, o workflow falha sem
     publicar JSON vazio.
  4. Nenhum arquivo de copa2026/ é lido ou alterado.

Só usa biblioteca padrão, para rodar direto no GitHub Actions.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import unicodedata
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

FUSO_BRASILIA = timezone(timedelta(hours=-3))
TEMPORADA = int(os.environ.get("BRASILEIRAO_TEMPORADA", "2026"))

URLS_STANDINGS = [
    f"https://site.api.espn.com/apis/v2/sports/soccer/bra.1/standings?season={TEMPORADA}",
    "https://site.api.espn.com/apis/v2/sports/soccer/bra.1/standings",
    f"https://site.web.api.espn.com/apis/v2/sports/soccer/bra.1/standings?season={TEMPORADA}",
]
URL_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/126.0.0.0 Safari/537.36"
    ),
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

ESCUDOS_TIMES = {
    "Athletico-PR":  {"escudo": "https://s.sde.globo.com/media/organizations/2026/01/07/Athletico-PR.svg", "sigla": "CAP"},
    "Atlético-MG":   {"escudo": "https://s.sde.globo.com/media/organizations/2018/03/10/atletico-mg.svg", "sigla": "CAM"},
    "Bahia":         {"escudo": "https://s.sde.globo.com/media/organizations/2018/03/11/bahia.svg", "sigla": "BAH"},
    "Botafogo":      {"escudo": "https://s.sde.globo.com/media/organizations/2019/02/04/botafogo-svg.svg", "sigla": "BOT"},
    "Bragantino":    {"escudo": "https://s.sde.globo.com/media/organizations/2021/06/28/bragantino.svg", "sigla": "RBB"},
    "Chapecoense":   {"escudo": "https://s.sde.globo.com/media/organizations/2021/06/21/CHAPECOENSE-2018.svg", "sigla": "CHA"},
    "Corinthians":   {"escudo": "https://s.sde.globo.com/media/organizations/2024/10/09/Corinthians_2024_Q4ahot4.svg", "sigla": "COR"},
    "Coritiba":      {"escudo": "https://s.sde.globo.com/media/organizations/2018/03/11/coritiba.svg", "sigla": "CFC"},
    "Cruzeiro":      {"escudo": "https://s.sde.globo.com/media/organizations/2021/02/13/cruzeiro_2021.svg", "sigla": "CRU"},
    "Flamengo":      {"escudo": "https://s.sde.globo.com/media/organizations/2018/04/10/Flamengo-2018.svg", "sigla": "FLA"},
    "Fluminense":    {"escudo": "https://s.sde.globo.com/media/organizations/2018/03/11/fluminense.svg", "sigla": "FLU"},
    "Grêmio":        {"escudo": "https://s.sde.globo.com/media/organizations/2018/03/12/gremio.svg", "sigla": "GRE"},
    "Internacional": {"escudo": "https://s.sde.globo.com/media/organizations/2018/03/11/internacional.svg", "sigla": "INT"},
    "Mirassol":      {"escudo": "https://s.sde.globo.com/media/organizations/2024/08/20/mirassol-novo-svg-71690.svg", "sigla": "MIR"},
    "Palmeiras":     {"escudo": "https://s.sde.globo.com/media/organizations/2019/07/06/Palmeiras.svg", "sigla": "PAL"},
    "Remo":          {"escudo": "https://s.sde.globo.com/media/organizations/2021/02/25/Remo-PA.svg", "sigla": "REM"},
    "Santos":        {"escudo": "https://s.sde.globo.com/media/organizations/2018/03/12/santos.svg", "sigla": "SAN"},
    "São Paulo":     {"escudo": "https://s.sde.globo.com/media/organizations/2018/03/11/sao-paulo.svg", "sigla": "SAO"},
    "Vasco da Gama": {"escudo": "https://s.sde.globo.com/media/organizations/2021/09/04/vasco_SVG.svg", "sigla": "VAS"},
    "Vitória":       {"escudo": "https://s.sde.globo.com/media/organizations/2025/12/18/Vitoria_2025.svg", "sigla": "VIT"},
}

ALIASES = {
    "athletico-pr": "Athletico-PR", "athletico paranaense": "Athletico-PR", "athletico": "Athletico-PR",
    "atletico paranaense": "Athletico-PR", "atletico-pr": "Athletico-PR", "cap": "Athletico-PR",
    "atletico-mg": "Atlético-MG", "atletico mineiro": "Atlético-MG", "atletico mg": "Atlético-MG",
    "clube atletico mineiro": "Atlético-MG", "cam": "Atlético-MG",
    "bahia": "Bahia", "ec bahia": "Bahia", "esporte clube bahia": "Bahia", "bah": "Bahia",
    "botafogo": "Botafogo", "botafogo rj": "Botafogo", "botafogo de futebol e regatas": "Botafogo", "bot": "Botafogo",
    "bragantino": "Bragantino", "red bull bragantino": "Bragantino", "rb bragantino": "Bragantino", "rbb": "Bragantino",
    "chapecoense": "Chapecoense", "chapecoense-sc": "Chapecoense", "associacao chapecoense de futebol": "Chapecoense", "cha": "Chapecoense",
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

TOKENS_DECISIVOS = [
    ("paranaense", "Athletico-PR"), ("athletico", "Athletico-PR"), ("mineiro", "Atlético-MG"),
    ("bragantino", "Bragantino"), ("chapecoense", "Chapecoense"), ("corinthians", "Corinthians"),
    ("coritiba", "Coritiba"), ("cruzeiro", "Cruzeiro"), ("flamengo", "Flamengo"),
    ("fluminense", "Fluminense"), ("gremio", "Grêmio"), ("internacional", "Internacional"),
    ("mirassol", "Mirassol"), ("palmeiras", "Palmeiras"), ("remo", "Remo"),
    ("santos", "Santos"), ("vasco", "Vasco da Gama"), ("botafogo", "Botafogo"),
    ("bahia", "Bahia"), ("vitoria", "Vitória"),
]


def agora_brt() -> datetime:
    return datetime.now(FUSO_BRASILIA)


def iso_agora_brt() -> str:
    return agora_brt().isoformat()


def normalizar(nome: Any) -> str:
    if nome is None:
        return ""
    s = unicodedata.normalize("NFD", str(nome))
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
        for c in CANONICOS:
            if n == normalizar(c):
                return c
    texto = " ".join(normalizar(c) for c in candidatos if c)
    for token, canonico in TOKENS_DECISIVOS:
        if re.search(r"\b" + re.escape(token) + r"\b", texto):
            return canonico
    return None


def info_time(nome: str) -> dict[str, str]:
    canonico = para_canonico(nome) or nome
    base = ESCUDOS_TIMES.get(canonico, {})
    return {
        "nome": canonico,
        "escudo": base.get("escudo", ""),
        "sigla": base.get("sigla", normalizar(canonico)[:3].upper()),
    }


def fetch_json(url: str, timeout: int = 25, tentativas: int = 3) -> dict[str, Any]:
    ultimo: Exception | None = None
    for i in range(1, tentativas + 1):
        try:
            sep = "&" if "?" in url else "?"
            req = urllib.request.Request(
                f"{url}{sep}_={int(time.time())}",
                headers=HEADERS,
            )
            with urllib.request.urlopen(req, timeout=timeout + 10 * (i - 1)) as r:
                charset = r.headers.get_content_charset() or "utf-8"
                bruto = r.read().decode(charset, errors="replace")
                return json.loads(bruto)
        except Exception as e:  # noqa: BLE001
            ultimo = e
            print(f"  tentativa {i}/{tentativas} falhou: {type(e).__name__}: {e}")
            if i < tentativas:
                time.sleep(2 * i)
    raise RuntimeError(f"falha ao buscar JSON: {url} :: {ultimo}")


def gravar_json_atomico(caminho: str | Path, payload: dict[str, Any]) -> None:
    path = Path(caminho)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


# ---------------------------------------------------------------------------
# STANDINGS -> tabela.json
# ---------------------------------------------------------------------------
def coletar_entries(no: Any, achados: list[dict[str, Any]]) -> None:
    if isinstance(no, dict):
        if "team" in no and isinstance(no.get("stats"), list):
            achados.append(no)
        for v in no.values():
            coletar_entries(v, achados)
    elif isinstance(no, list):
        for v in no:
            coletar_entries(v, achados)


def stat_valor(stats: list[dict[str, Any]], *nomes: str) -> int | None:
    alvos = {normalizar(n) for n in nomes}
    for s in stats:
        chaves = {
            normalizar(s.get("name")),
            normalizar(s.get("type")),
            normalizar(s.get("abbreviation")),
            normalizar(s.get("shortDisplayName")),
            normalizar(s.get("displayName")),
        }
        if chaves & alvos:
            v = s.get("value", s.get("displayValue"))
            try:
                return int(round(float(str(v).replace("%", ""))))
            except (TypeError, ValueError):
                continue
    return None


def gerar_tabela() -> dict[str, Any]:
    print("== TABELA (ESPN standings) ==")
    data: dict[str, Any] | None = None
    erro: Exception | None = None
    for url in URLS_STANDINGS:
        print(f"Fonte: {url}")
        try:
            data = fetch_json(url)
            break
        except Exception as e:  # noqa: BLE001
            erro = e
            continue
    if data is None:
        raise RuntimeError(f"standings indisponível em todas as URLs: {erro}")

    entries: list[dict[str, Any]] = []
    coletar_entries(data, entries)
    vistos: set[str] = set()
    unicos: list[dict[str, Any]] = []
    for e in entries:
        team = e.get("team") or {}
        tid = str(team.get("id") or team.get("uid") or team.get("displayName") or id(e))
        if tid not in vistos:
            vistos.add(tid)
            unicos.append(e)
    print(f"Entradas de time encontradas: {len(unicos)}")

    linhas: list[dict[str, Any]] = []
    nao_mapeados: list[str] = []
    de_para: list[str] = []
    for e in unicos:
        team = e.get("team") or {}
        stats = e.get("stats") or []
        canonico = para_canonico(
            team.get("displayName"), team.get("shortDisplayName"), team.get("name"),
            team.get("location"), team.get("abbreviation"), team.get("slug"),
        )
        if not canonico:
            nao_mapeados.append(team.get("displayName") or team.get("name") or "?")
            continue
        de_para.append(f"  ESPN '{team.get('displayName') or team.get('name')}' -> '{canonico}'")

        j = stat_valor(stats, "gamesPlayed", "GP", "J")
        v = stat_valor(stats, "wins", "W", "V")
        emp = stat_valor(stats, "ties", "draws", "D", "E")
        der = stat_valor(stats, "losses", "L")
        gp = stat_valor(stats, "pointsFor", "goalsFor", "GF", "F")
        gc = stat_valor(stats, "pointsAgainst", "goalsAgainst", "GA", "A")
        sg = stat_valor(stats, "pointDifferential", "goalDifferential", "GD", "SG")
        p = stat_valor(stats, "points", "PTS", "P")
        rank = stat_valor(stats, "rank", "RANK")

        if p is None and None not in (v, emp):
            p = 3 * int(v) + int(emp)
        if sg is None and None not in (gp, gc):
            sg = int(gp) - int(gc)
        if j is None and None not in (v, emp, der):
            j = int(v) + int(emp) + int(der)

        obrigatorios = {"pontos": p, "jogos": j, "vitorias": v, "empates": emp, "derrotas": der, "gp": gp, "gc": gc}
        faltando = [k for k, val in obrigatorios.items() if val is None]
        if faltando:
            raise RuntimeError(
                f"Time '{canonico}': stats ausentes na ESPN: {faltando}. "
                "Abortando sem gravar tabela.json."
            )

        linhas.append({
            "time": canonico,
            "pontos": int(p), "jogos": int(j), "vitorias": int(v),
            "empates": int(emp), "derrotas": int(der), "gp": int(gp), "gc": int(gc),
            "sg": int(sg if sg is not None else int(gp) - int(gc)),
            "aproveitamento": int(round(100.0 * int(p) / (3 * int(j)))) if int(j) else 0,
            "_rank": rank,
        })

    print("De-para aplicado:")
    print("\n".join(de_para))

    if nao_mapeados:
        raise RuntimeError(
            "Times da ESPN sem correspondência canônica: "
            + ", ".join(sorted(set(nao_mapeados)))
            + " — adicione ao ALIASES e rode de novo."
        )
    nomes = [l["time"] for l in linhas]
    if sorted(nomes) != sorted(CANONICOS):
        faltam = sorted(set(CANONICOS) - set(nomes))
        sobram = sorted(set(nomes) - set(CANONICOS))
        raise RuntimeError(f"Tabela inconsistente. Faltam: {faltam} | Sobram: {sobram}.")
    if len(nomes) != len(set(nomes)):
        raise RuntimeError("Time duplicado na tabela. Abortando.")

    if all(l.get("_rank") for l in linhas):
        linhas.sort(key=lambda l: int(l["_rank"]))
    else:
        linhas.sort(key=lambda l: (-l["pontos"], -l["vitorias"], -l["sg"], -l["gp"], l["time"]))

    tabela = []
    for i, l in enumerate(linhas, 1):
        l.pop("_rank", None)
        tabela.append({"pos": i, **l})

    saida = {
        "atualizado_em": iso_agora_brt(),
        "fonte": "ESPN",
        "tabela": tabela,
    }
    return saida


# ---------------------------------------------------------------------------
# SCOREBOARD -> jogos.json / resultados.json / espn_eventos.json
# ---------------------------------------------------------------------------
def periodo_temporada() -> tuple[datetime, datetime]:
    # Para o workflow de 10 em 10 minutos, não faz sentido consultar dezembro
    # inteiro em julho. Buscamos a temporada desde 1º/jan até 60 dias à frente,
    # mantendo os resultados acumulados e os próximos jogos sem pressionar a API.
    inicio = datetime(TEMPORADA, 1, 1, tzinfo=timezone.utc)
    fim_temporada = datetime(TEMPORADA, 12, 31, 23, 59, tzinfo=timezone.utc)
    fim_janela = datetime.now(timezone.utc) + timedelta(days=60)
    return inicio, min(fim_temporada, fim_janela)


def datas_url(inicio: datetime, fim: datetime) -> str:
    return f"{inicio.strftime('%Y%m%d')}-{fim.strftime('%Y%m%d')}"


def buscar_eventos_scoreboard() -> list[dict[str, Any]]:
    print("== EVENTOS/JOGOS/RESULTADOS (ESPN scoreboard) ==")
    inicio, fim = periodo_temporada()
    eventos_por_id: dict[str, dict[str, Any]] = {}
    cursor = inicio
    while cursor <= fim:
        proximo = min(cursor + timedelta(days=27), fim)
        url = f"{URL_SCOREBOARD}?dates={datas_url(cursor, proximo)}&limit=200"
        print(f"Fonte: {url}")
        data = fetch_json(url, timeout=25, tentativas=2)
        for ev in data.get("events") or []:
            eid = str(ev.get("id") or "")
            if eid:
                eventos_por_id[eid] = ev
        cursor = proximo + timedelta(days=1)
    eventos = list(eventos_por_id.values())
    print(f"Eventos brutos encontrados na temporada: {len(eventos)}")
    if not eventos:
        raise RuntimeError("A ESPN não retornou eventos para a temporada; mantendo JSONs anteriores.")
    return eventos


def primeira_competicao(ev: dict[str, Any]) -> dict[str, Any]:
    comps = ev.get("competitions") or []
    return comps[0] if comps else {}


def status_evento(ev: dict[str, Any]) -> dict[str, Any]:
    comp = primeira_competicao(ev)
    return comp.get("status") or ev.get("status") or {}


def tipo_status(ev: dict[str, Any]) -> dict[str, Any]:
    return status_evento(ev).get("type") or {}


def competidores(ev: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    comp = primeira_competicao(ev)
    cs = comp.get("competitors") or []
    casa = next((c for c in cs if c.get("homeAway") == "home"), None)
    fora = next((c for c in cs if c.get("homeAway") == "away"), None)
    return casa, fora


def canonico_competidor(c: dict[str, Any] | None) -> str | None:
    if not c:
        return None
    t = c.get("team") or {}
    return para_canonico(
        t.get("displayName"), t.get("shortDisplayName"), t.get("name"),
        t.get("location"), t.get("abbreviation"), t.get("slug"),
    )


def parse_data_evento_brt(ev: dict[str, Any]) -> datetime | None:
    valor = ev.get("date") or primeira_competicao(ev).get("date")
    if not valor:
        return None
    try:
        return datetime.fromisoformat(str(valor).replace("Z", "+00:00")).astimezone(FUSO_BRASILIA)
    except ValueError:
        return None


def placar_competidor(c: dict[str, Any] | None) -> int | None:
    if not c:
        return None
    v = c.get("score")
    if v in (None, ""):
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def transmissao_evento(ev: dict[str, Any]) -> str:
    comp = primeira_competicao(ev)
    nomes: list[str] = []
    for b in comp.get("broadcasts") or []:
        nomes.extend(str(n).strip() for n in (b.get("names") or []) if str(n).strip())
        for k in ("shortName", "name"):
            v = str(b.get(k) or "").strip()
            if v:
                nomes.append(v)
    for g in comp.get("geoBroadcasts") or []:
        media = g.get("media") or {}
        for k in ("shortName", "name"):
            v = str(media.get(k) or "").strip()
            if v:
                nomes.append(v)
    # Dedup preservando ordem.
    vistos: set[str] = set()
    saida: list[str] = []
    for n in nomes:
        chave = normalizar(n)
        if chave and chave not in vistos:
            vistos.add(chave)
            saida.append(n)
    return " / ".join(saida)


def extrair_rodada_evento(ev: dict[str, Any]) -> int | None:
    comp = primeira_competicao(ev)
    candidatos: list[Any] = []
    for no in (ev, comp, ev.get("season") or {}, comp.get("season") or {}, ev.get("week") or {}, comp.get("week") or {}, comp.get("round") or {}):
        if isinstance(no, dict):
            for k in ("number", "week", "round", "value"):
                candidatos.append(no.get(k))
            for k in ("displayName", "name", "shortName", "text", "description"):
                candidatos.append(no.get(k))
    for nota in comp.get("notes") or []:
        if isinstance(nota, dict):
            candidatos.extend(nota.values())
        else:
            candidatos.append(nota)
    for c in candidatos:
        if c is None or c == "":
            continue
        if isinstance(c, (int, float)) and 1 <= int(c) <= 38:
            return int(c)
        m = re.search(r"(?:rodada|round|week|matchday)?\s*([1-3]?\d)\b", str(c), flags=re.I)
        if m:
            n = int(m.group(1))
            if 1 <= n <= 38:
                return n
    return None


def carregar_rodadas_legadas() -> dict[tuple[str, str, str], int]:
    """Usa os JSONs atuais apenas como fallback de rodada se a ESPN omitir week."""
    mapa: dict[tuple[str, str, str], int] = {}
    for arquivo, chave_lista in (("jogos.json", "jogos"), ("resultados.json", "resultados")):
        p = Path(arquivo)
        if not p.exists():
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        for item in data.get(chave_lista) or []:
            try:
                mand = para_canonico((item.get("mandante") or {}).get("nome"))
                vis = para_canonico((item.get("visitante") or {}).get("nome"))
                rodada = int(item.get("rodada") or 0)
                dt = str(item.get("data_iso") or "")[:10]
                if mand and vis and rodada:
                    mapa[(mand, vis, dt)] = rodada
            except Exception:
                continue
    return mapa


def normalizar_eventos_scoreboard(eventos: list[dict[str, Any]]) -> list[dict[str, Any]]:
    legadas = carregar_rodadas_legadas()
    normalizados: list[dict[str, Any]] = []
    nao_mapeados: list[str] = []

    for ev in eventos:
        casa, fora = competidores(ev)
        mand = canonico_competidor(casa)
        vis = canonico_competidor(fora)
        if not mand or not vis:
            label = ev.get("shortName") or ev.get("name") or ev.get("id") or "?"
            nao_mapeados.append(str(label))
            continue
        dt_brt = parse_data_evento_brt(ev)
        if not dt_brt:
            continue
        comp = primeira_competicao(ev)
        st = tipo_status(ev)
        estado = str(st.get("state") or "pre").lower()
        if st.get("completed") is True:
            estado = "post"

        rodada = extrair_rodada_evento(ev)
        if not rodada:
            rodada = legadas.get((mand, vis, dt_brt.strftime("%Y-%m-%d")))

        normalizados.append({
            "event_id": str(ev.get("id") or ""),
            "rodada": rodada,
            "data_dt": dt_brt,
            "data_iso": dt_brt.strftime("%Y-%m-%dT%H:%M"),
            "mandante_nome": mand,
            "visitante_nome": vis,
            "mandante": info_time(mand),
            "visitante": info_time(vis),
            "estadio": ((comp.get("venue") or {}).get("fullName") or ""),
            "transmissao": transmissao_evento(ev),
            "status": status_evento(ev).get("displayClock") or st.get("shortDetail") or st.get("detail") or "",
            "estado": estado,
            "placar_mandante": placar_competidor(casa),
            "placar_visitante": placar_competidor(fora),
            "_sort": dt_brt.timestamp(),
        })

    if nao_mapeados:
        print("Aviso: eventos ESPN com clubes fora do de-para foram ignorados:")
        for n in sorted(set(nao_mapeados)):
            print(f"  - {n}")

    normalizados.sort(key=lambda e: e["_sort"])
    inferir_rodadas_faltantes(normalizados)
    normalizados = sanear_eventos_por_rodada(normalizados)
    return normalizados


def inferir_rodadas_faltantes(eventos: list[dict[str, Any]]) -> None:
    """Fallback conservador: se a ESPN não trouxer rodada, usa blocos de 10 jogos."""
    for i, e in enumerate(eventos):
        if e.get("rodada"):
            continue
        # Rodada aproximada pelo calendário completo da temporada; serve só como
        # plano B para não quebrar visual. Quando a ESPN/JSON legado traz rodada,
        # essa inferência não entra.
        e["rodada"] = max(1, min(38, (i // 10) + 1))


def prefixo_evento_espn(event_id: Any) -> str:
    s = str(event_id or "")
    return s[:6] if len(s) >= 6 else s


def sanear_eventos_por_rodada(eventos: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Garante a regra estrutural do Brasileirão: no máximo 10 jogos por rodada.

    A ESPN eventualmente inclui jogos isolados/reagendados com o mesmo número de
    rodada do calendário regular. Isso gerou rodadas com 11 jogos e até clube
    repetido na mesma rodada. Para o site e para as apostas, isso é inviável.

    Critério conservador:
      1. se a rodada tem até 10 jogos, não muda nada;
      2. se tem mais de 10, prioriza o prefixo dominante de event_id ESPN
         (normalmente o bloco regular da competição);
      3. se ainda sobrar mais de 10, escolhe 10 jogos sem clube duplicado;
      4. em último caso, corta nos 10 primeiros ordenados por data.
    """
    por_rodada: dict[int, list[dict[str, Any]]] = {}
    sem_rodada: list[dict[str, Any]] = []
    for e in eventos:
        r = int(e.get("rodada") or 0)
        if not r:
            sem_rodada.append(e)
            continue
        por_rodada.setdefault(r, []).append(e)

    saneados: list[dict[str, Any]] = []
    for rodada in sorted(por_rodada):
        arr = sorted(por_rodada[rodada], key=lambda x: x.get("_sort") or 0)
        original = len(arr)
        if original > 10:
            cont: dict[str, int] = {}
            for e in arr:
                pref = prefixo_evento_espn(e.get("event_id"))
                if pref:
                    cont[pref] = cont.get(pref, 0) + 1
            dominante = max(cont.items(), key=lambda kv: kv[1])[0] if cont else ""
            filtrada = [e for e in arr if prefixo_evento_espn(e.get("event_id")) == dominante]
            if len(filtrada) >= 10:
                arr = filtrada

        if len(arr) > 10:
            usados: set[str] = set()
            sem_duplicar: list[dict[str, Any]] = []
            for e in arr:
                mand = str(e.get("mandante_nome") or "")
                vis = str(e.get("visitante_nome") or "")
                if not mand or not vis or mand in usados or vis in usados:
                    continue
                usados.add(mand)
                usados.add(vis)
                sem_duplicar.append(e)
                if len(sem_duplicar) == 10:
                    break
            if len(sem_duplicar) == 10:
                arr = sem_duplicar

        if original > 10:
            removidos = original - min(len(arr), 10)
            print(f"Rodada {rodada}: ESPN retornou {original} jogos; publicando {min(len(arr), 10)} e removendo {max(0, removidos)} extra(s).")
            for e in arr[10:]:
                print(f"  - extra ignorado: {e.get('mandante_nome')} x {e.get('visitante_nome')} ({e.get('data_iso')}, {e.get('event_id')})")
        saneados.extend(arr[:10])

    saneados.extend(sem_rodada)
    saneados.sort(key=lambda e: e.get("_sort") or 0)
    return saneados


def carregar_transmissoes_manuais() -> list[dict[str, Any]]:
    p = Path("transmissoes.json")
    if not p.exists():
        return []
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return list(d.get("transmissoes") or [])
    except Exception:
        return []


def aplicar_transmissoes_manuais(eventos: list[dict[str, Any]]) -> None:
    manuais = carregar_transmissoes_manuais()
    for e in eventos:
        for t in manuais:
            if (
                para_canonico(t.get("mandante")) == e["mandante_nome"]
                and para_canonico(t.get("visitante")) == e["visitante_nome"]
                and (not t.get("rodada") or int(t.get("rodada")) == int(e.get("rodada") or 0))
            ):
                if t.get("transmissao"):
                    e["transmissao"] = str(t["transmissao"])


def payload_jogo(e: dict[str, Any], incluir_placar: bool = True) -> dict[str, Any]:
    obj = {
        "event_id": e.get("event_id", ""),
        "rodada": int(e.get("rodada") or 0),
        "data_iso": e["data_iso"],
        "mandante": e["mandante"],
        "visitante": e["visitante"],
        "estadio": e.get("estadio", ""),
        "transmissao": e.get("transmissao", ""),
        "status": e.get("status", ""),
        "estado": e.get("estado", "pre"),
    }
    if incluir_placar:
        obj["placar_mandante"] = e.get("placar_mandante")
        obj["placar_visitante"] = e.get("placar_visitante")
    return obj


def gerar_jogos_resultados_eventos(eventos_brutos: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    eventos = normalizar_eventos_scoreboard(eventos_brutos)
    aplicar_transmissoes_manuais(eventos)
    if not eventos:
        raise RuntimeError("Nenhum evento ESPN foi normalizado; abortando para não publicar JSON vazio.")

    agora = agora_brt()
    futuros = [e for e in eventos if e["data_dt"] >= agora - timedelta(hours=3) and e.get("estado") != "post"]
    finalizados = [e for e in eventos if e.get("estado") == "post" or (e.get("placar_mandante") is not None and e.get("placar_visitante") is not None and e["data_dt"] < agora - timedelta(hours=2))]

    # Próximos jogos: mantém leve para a página, mas com pelo menos 2 rodadas
    # quando possível. Nunca corta no meio da rodada vigente.
    futuros.sort(key=lambda e: e["_sort"])
    proximos: list[dict[str, Any]] = []
    rodadas_usadas: list[int] = []
    if futuros:
        primeira_rodada = int(futuros[0].get("rodada") or 0)
        rodadas_alvo = [r for r in sorted({int(e.get("rodada") or 0) for e in futuros}) if r >= primeira_rodada][:2]
        for e in futuros:
            if int(e.get("rodada") or 0) in rodadas_alvo:
                proximos.append(e)
        if len(proximos) < 10:
            proximos = futuros[:20]
        rodadas_usadas = sorted({int(e.get("rodada") or 0) for e in proximos if e.get("rodada")})

    finalizados.sort(key=lambda e: e["_sort"], reverse=True)
    times_resultados = sorted({e["mandante_nome"] for e in finalizados} | {e["visitante_nome"] for e in finalizados}, key=lambda x: normalizar(x))
    rodadas_resultados = sorted({int(e.get("rodada") or 0) for e in finalizados if e.get("rodada")})

    atualizado_em = iso_agora_brt()
    atualizado_br = agora_brt().strftime("%d/%m/%Y %H:%M BRT")

    jogos_json = {
        "atualizado_em": atualizado_em,
        "atualizado_em_br": atualizado_br,
        "fonte": "ESPN",
        "rodada_atual": rodadas_usadas[0] if rodadas_usadas else None,
        "rodadas_consultadas": rodadas_usadas,
        "total_jogos": len(proximos),
        "jogos": [payload_jogo(e, incluir_placar=True) for e in proximos],
    }

    resultados_json = {
        "atualizado_em": atualizado_em,
        "atualizado_em_br": atualizado_br,
        "fonte": "ESPN",
        "ultima_rodada_disputada": max(rodadas_resultados) if rodadas_resultados else None,
        "rodadas_consultadas": rodadas_resultados,
        "total_resultados": len(finalizados),
        "times": times_resultados,
        "resultados": [payload_jogo(e, incluir_placar=True) for e in finalizados],
    }

    eventos_json = {
        "atualizado_em": atualizado_em,
        "fonte": "ESPN",
        "total": len(eventos),
        "eventos": [
            {
                "event_id": e.get("event_id", ""),
                "rodada": int(e.get("rodada") or 0),
                "data_iso": e["data_iso"],
                "mandante": e["mandante_nome"],
                "visitante": e["visitante_nome"],
                "estadio": e.get("estadio", ""),
                "transmissao": e.get("transmissao", ""),
                "estado": e.get("estado", ""),
                "placar_mandante": e.get("placar_mandante"),
                "placar_visitante": e.get("placar_visitante"),
            }
            for e in eventos
        ],
    }

    # Validações de formato que o front espera.
    if proximos and not all(j.get("mandante") and j.get("visitante") and j.get("data_iso") for j in jogos_json["jogos"]):
        raise RuntimeError("jogos.json inválido: jogo sem mandante/visitante/data.")
    if finalizados and not all(r.get("placar_mandante") is not None and r.get("placar_visitante") is not None for r in resultados_json["resultados"]):
        raise RuntimeError("resultados.json inválido: resultado finalizado sem placar.")

    return jogos_json, resultados_json, eventos_json


def validar_contra_ranking(tabela_payload: dict[str, Any]) -> None:
    tabela = tabela_payload.get("tabela") or []
    if len(tabela) != 20:
        raise RuntimeError(f"tabela.json teria {len(tabela)} times; esperado 20.")
    nomes = [t.get("time") for t in tabela]
    if sorted(nomes) != sorted(CANONICOS):
        raise RuntimeError("tabela.json não preserva exatamente os 20 nomes canônicos do Ranking.")
    obrig = {"pos", "time", "pontos", "jogos", "vitorias", "empates", "derrotas", "gp", "gc", "sg", "aproveitamento"}
    for linha in tabela:
        faltando = obrig - set(linha)
        if faltando:
            raise RuntimeError(f"Linha de tabela sem campos obrigatórios {faltando}: {linha}")


def main() -> None:
    try:
        tabela = gerar_tabela()
        validar_contra_ranking(tabela)
        eventos_brutos = buscar_eventos_scoreboard()
        jogos, resultados, eventos = gerar_jogos_resultados_eventos(eventos_brutos)
    except Exception as e:  # noqa: BLE001
        print(f"ERRO FATAL: {e}")
        sys.exit(1)

    gravar_json_atomico("tabela.json", tabela)
    gravar_json_atomico("jogos.json", jogos)
    gravar_json_atomico("resultados.json", resultados)
    gravar_json_atomico("espn_eventos.json", eventos)

    print("== ARQUIVOS GERADOS ==")
    print(f"  tabela.json        {len(tabela['tabela'])} times, fonte ESPN")
    print(f"  jogos.json         {len(jogos['jogos'])} próximos jogos, fonte ESPN")
    print(f"  resultados.json    {len(resultados['resultados'])} resultados, fonte ESPN")
    print(f"  espn_eventos.json  {len(eventos['eventos'])} eventos ESPN")
    print("Concluído com segurança.")


if __name__ == "__main__":
    main()
