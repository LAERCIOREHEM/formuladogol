#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
atualizar_espn.py — Fonte ESPN para o Bolão Brasileirão 2026.

Substitui o antigo atualizar.py (Terra). Gera:

  1. tabela.json        — classificação via ESPN standings (MESMO formato
                          do arquivo atual; o Ranking do bolão depende dele).
  2. espn_eventos.json  — de-para de jogos (id ESPN, times canônicos,
                          transmissão), usado pelo site para o AO VIVO.

REGRAS DE SEGURANÇA (não negociáveis):
  - Os nomes dos times gravados em tabela.json são EXATAMENTE os 20 nomes
    canônicos já usados pelo site (os mesmos dos palpites do Ranking).
  - Se QUALQUER um dos 20 times da ESPN não puder ser mapeado para um nome
    canônico, o script FALHA RUIDOSAMENTE (exit 1) e NÃO grava tabela.json,
    preservando o arquivo anterior. Nunca publica tabela quebrada.
  - Falha no espn_eventos.json NÃO derruba a tabela (é acessório).

Roda no GitHub Actions (sem CORS). Só usa biblioteca padrão.
"""

import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

FUSO_BRASILIA = timezone(timedelta(hours=-3))

# ---------------------------------------------------------------------------
# ENDPOINTS ESPN (liga bra.1 = Campeonato Brasileiro Série A)
# Observação importante: standings de futebol funciona em /apis/v2/
# (o caminho /apis/site/v2/ devolve um objeto vazio para standings).
# ---------------------------------------------------------------------------
URLS_STANDINGS = [
    "https://site.api.espn.com/apis/v2/sports/soccer/bra.1/standings?season=2026",
    "https://site.api.espn.com/apis/v2/sports/soccer/bra.1/standings",
    "https://site.web.api.espn.com/apis/v2/sports/soccer/bra.1/standings?season=2026",
]
URL_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
}

# ---------------------------------------------------------------------------
# NOMES CANÔNICOS — os 20 nomes EXATOS que o site usa hoje (tabela.json,
# palpites do Ranking em index.html). NÃO ALTERAR sem migrar os palpites.
# ---------------------------------------------------------------------------
CANONICOS = [
    "Athletico-PR", "Atlético-MG", "Bahia", "Botafogo", "Bragantino",
    "Chapecoense", "Corinthians", "Coritiba", "Cruzeiro", "Flamengo",
    "Fluminense", "Grêmio", "Internacional", "Mirassol", "Palmeiras",
    "Remo", "Santos", "São Paulo", "Vasco da Gama", "Vitória",
]

# Apelidos/variações conhecidas (ESPN, Globo, Terra) -> nome canônico.
# As chaves são comparadas já NORMALIZADAS (minúsculas, sem acento).
ALIASES = {
    # Athletico-PR
    "athletico-pr": "Athletico-PR",
    "athletico paranaense": "Athletico-PR",
    "athletico": "Athletico-PR",
    "atletico paranaense": "Athletico-PR",
    "atletico-pr": "Athletico-PR",
    "cap": "Athletico-PR",
    # Atlético-MG
    "atletico-mg": "Atlético-MG",
    "atletico mineiro": "Atlético-MG",
    "atletico mg": "Atlético-MG",
    "clube atletico mineiro": "Atlético-MG",
    # Bahia
    "bahia": "Bahia",
    "ec bahia": "Bahia",
    "esporte clube bahia": "Bahia",
    # Botafogo
    "botafogo": "Botafogo",
    "botafogo rj": "Botafogo",
    "botafogo de futebol e regatas": "Botafogo",
    # Bragantino
    "bragantino": "Bragantino",
    "red bull bragantino": "Bragantino",
    "rb bragantino": "Bragantino",
    # Chapecoense
    "chapecoense": "Chapecoense",
    "chapecoense-sc": "Chapecoense",
    "associacao chapecoense de futebol": "Chapecoense",
    # Corinthians
    "corinthians": "Corinthians",
    "sc corinthians paulista": "Corinthians",
    "corinthians paulista": "Corinthians",
    # Coritiba
    "coritiba": "Coritiba",
    "coritiba fc": "Coritiba",
    "coritiba foot ball club": "Coritiba",
    # Cruzeiro
    "cruzeiro": "Cruzeiro",
    "cruzeiro ec": "Cruzeiro",
    "cruzeiro esporte clube": "Cruzeiro",
    # Flamengo
    "flamengo": "Flamengo",
    "cr flamengo": "Flamengo",
    "clube de regatas do flamengo": "Flamengo",
    # Fluminense
    "fluminense": "Fluminense",
    "fluminense fc": "Fluminense",
    "fluminense football club": "Fluminense",
    # Grêmio
    "gremio": "Grêmio",
    "gremio fbpa": "Grêmio",
    "gremio foot-ball porto alegrense": "Grêmio",
    # Internacional
    "internacional": "Internacional",
    "sc internacional": "Internacional",
    "sport club internacional": "Internacional",
    "inter de porto alegre": "Internacional",
    # Mirassol
    "mirassol": "Mirassol",
    "mirassol fc": "Mirassol",
    "mirassol futebol clube": "Mirassol",
    # Palmeiras
    "palmeiras": "Palmeiras",
    "se palmeiras": "Palmeiras",
    "sociedade esportiva palmeiras": "Palmeiras",
    # Remo
    "remo": "Remo",
    "clube do remo": "Remo",
    # Santos
    "santos": "Santos",
    "santos fc": "Santos",
    "santos futebol clube": "Santos",
    # São Paulo
    "sao paulo": "São Paulo",
    "sao paulo fc": "São Paulo",
    "sao paulo futebol clube": "São Paulo",
    # Vasco da Gama
    "vasco": "Vasco da Gama",
    "vasco da gama": "Vasco da Gama",
    "cr vasco da gama": "Vasco da Gama",
    "club de regatas vasco da gama": "Vasco da Gama",
    # Vitória
    "vitoria": "Vitória",
    "ec vitoria": "Vitória",
    "esporte clube vitoria": "Vitória",
    "vitoria ba": "Vitória",
}

# Palavras-chave decisivas (última tentativa de casamento, por token).
TOKENS_DECISIVOS = [
    ("paranaense", "Athletico-PR"),
    ("athletico", "Athletico-PR"),
    ("mineiro", "Atlético-MG"),
    ("bragantino", "Bragantino"),
    ("chapecoense", "Chapecoense"),
    ("corinthians", "Corinthians"),
    ("coritiba", "Coritiba"),
    ("cruzeiro", "Cruzeiro"),
    ("flamengo", "Flamengo"),
    ("fluminense", "Fluminense"),
    ("gremio", "Grêmio"),
    ("internacional", "Internacional"),
    ("mirassol", "Mirassol"),
    ("palmeiras", "Palmeiras"),
    ("remo", "Remo"),
    ("santos", "Santos"),
    ("vasco", "Vasco da Gama"),
    ("botafogo", "Botafogo"),
    ("bahia", "Bahia"),
    ("vitoria", "Vitória"),
]


def normalizar(nome):
    """minúsculas, sem acento, espaços comprimidos."""
    if not nome:
        return ""
    s = unicodedata.normalize("NFD", str(nome))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = re.sub(r"[^a-z0-9\- ]", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


def para_canonico(*candidatos):
    """
    Recebe vários nomes candidatos do mesmo time (displayName,
    shortDisplayName, name, abbreviation...) e devolve o nome canônico
    ou None se não conseguir mapear com segurança.
    """
    for cand in candidatos:
        n = normalizar(cand)
        if not n:
            continue
        if n in ALIASES:
            return ALIASES[n]
        # comparação direta com canônicos normalizados
        for c in CANONICOS:
            if n == normalizar(c):
                return c
    # última tentativa: tokens decisivos no displayName completo
    texto = " ".join(normalizar(c) for c in candidatos if c)
    for token, canonico in TOKENS_DECISIVOS:
        if re.search(r"\b" + re.escape(token) + r"\b", texto):
            return canonico
    return None


def fetch_json(url, timeout=25, tentativas=3):
    """GET com headers de navegador, anti-cache e retentativa."""
    ultimo = None
    for i in range(1, tentativas + 1):
        try:
            sep = "&" if "?" in url else "?"
            req = urllib.request.Request(
                f"{url}{sep}_={int(time.time())}", headers=HEADERS
            )
            with urllib.request.urlopen(req, timeout=timeout + 10 * (i - 1)) as r:
                charset = r.headers.get_content_charset() or "utf-8"
                return json.loads(r.read().decode(charset, errors="replace"))
        except Exception as e:  # noqa: BLE001
            ultimo = e
            print(f"  tentativa {i}/{tentativas} falhou: {type(e).__name__}: {e}")
            if i < tentativas:
                time.sleep(2 * i)
    raise ultimo


# ---------------------------------------------------------------------------
# STANDINGS -> tabela.json
# ---------------------------------------------------------------------------
def coletar_entries(no, achados):
    """
    Varre o JSON de standings recursivamente e junta todos os objetos que
    tenham 'team' + 'stats' (o formato exato varia entre children/entries).
    """
    if isinstance(no, dict):
        if "team" in no and isinstance(no.get("stats"), list):
            achados.append(no)
        for v in no.values():
            coletar_entries(v, achados)
    elif isinstance(no, list):
        for v in no:
            coletar_entries(v, achados)


def stat_valor(stats, *nomes):
    """
    Busca um valor numérico na lista de stats da ESPN por name/type/
    abbreviation/shortDisplayName (a ESPN alterna entre eles).
    """
    alvo = {normalizar(n) for n in nomes}
    for s in stats:
        chaves = {
            normalizar(s.get("name")),
            normalizar(s.get("type")),
            normalizar(s.get("abbreviation")),
            normalizar(s.get("shortDisplayName")),
        }
        if chaves & alvo:
            v = s.get("value")
            if v is None:
                v = s.get("displayValue")
            try:
                return int(round(float(v)))
            except (TypeError, ValueError):
                continue
    return None


def gerar_tabela():
    print("== TABELA (ESPN standings) ==")
    data = None
    erro = None
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

    entries = []
    coletar_entries(data, entries)
    # dedup por id do time (a varredura recursiva pode achar duplicatas)
    vistos, unicos = set(), []
    for e in entries:
        tid = str((e.get("team") or {}).get("id") or id(e))
        if tid not in vistos:
            vistos.add(tid)
            unicos.append(e)
    entries = unicos
    print(f"Entradas de time encontradas: {len(entries)}")

    linhas, nao_mapeados, de_para = [], [], []
    for e in entries:
        team = e.get("team") or {}
        stats = e.get("stats") or []
        canonico = para_canonico(
            team.get("displayName"),
            team.get("shortDisplayName"),
            team.get("name"),
            team.get("location"),
            team.get("abbreviation"),
        )
        if not canonico:
            nao_mapeados.append(team.get("displayName") or team.get("name") or "?")
            continue
        de_para.append(f"  ESPN '{team.get('displayName')}' -> '{canonico}'")

        j = stat_valor(stats, "gamesPlayed", "GP")
        v = stat_valor(stats, "wins", "W")
        emp = stat_valor(stats, "ties", "draws", "D")
        d = stat_valor(stats, "losses", "L")
        gp = stat_valor(stats, "pointsFor", "goalsFor", "GF", "F")
        gc = stat_valor(stats, "pointsAgainst", "goalsAgainst", "GA", "A")
        sg = stat_valor(stats, "pointDifferential", "goalDifferential", "GD")
        p = stat_valor(stats, "points", "PTS", "P")
        rank = stat_valor(stats, "rank")

        # Reconstruções defensivas (a ESPN às vezes omite um campo)
        if p is None and None not in (v, emp):
            p = 3 * v + emp
        if sg is None and None not in (gp, gc):
            sg = gp - gc
        if j is None and None not in (v, emp, d):
            j = v + emp + d

        obrigatorios = {"pontos": p, "jogos": j, "vitorias": v,
                        "empates": emp, "derrotas": d, "gp": gp, "gc": gc}
        faltando = [k for k, val in obrigatorios.items() if val is None]
        if faltando:
            raise RuntimeError(
                f"Time '{canonico}': stats ausentes na ESPN: {faltando}. "
                "Abortando sem gravar (formato da API pode ter mudado)."
            )

        linhas.append({
            "time": canonico,
            "pontos": p, "jogos": j, "vitorias": v, "empates": emp,
            "derrotas": d, "gp": gp, "gc": gc,
            "sg": sg if sg is not None else gp - gc,
            "aproveitamento": int(round(100.0 * p / (3 * j))) if j else 0,
            "_rank": rank,
        })

    print("De-para aplicado:")
    print("\n".join(de_para))

    # ------------------ VALIDAÇÕES FAIL-LOUD ------------------
    if nao_mapeados:
        raise RuntimeError(
            "Times da ESPN SEM correspondência canônica: "
            + ", ".join(sorted(set(nao_mapeados)))
            + " — adicione ao ALIASES e rode de novo. NADA foi gravado."
        )
    nomes = [l["time"] for l in linhas]
    if sorted(nomes) != sorted(CANONICOS):
        faltam = sorted(set(CANONICOS) - set(nomes))
        sobram = sorted(set(nomes) - set(CANONICOS))
        raise RuntimeError(
            f"Tabela inconsistente. Faltam: {faltam} | Sobram: {sobram}. "
            "NADA foi gravado."
        )
    if len(nomes) != len(set(nomes)):
        raise RuntimeError("Time duplicado na tabela. NADA foi gravado.")

    # Ordenação: rank da ESPN quando existir; senão critérios oficiais
    # (pontos > vitórias > SG > gols pró), como no Brasileirão.
    if all(l["_rank"] for l in linhas):
        linhas.sort(key=lambda l: l["_rank"])
    else:
        linhas.sort(key=lambda l: (-l["pontos"], -l["vitorias"], -l["sg"], -l["gp"]))

    tabela = []
    for i, l in enumerate(linhas, 1):
        l.pop("_rank", None)
        tabela.append({"pos": i, **l})

    saida = {
        "atualizado_em": datetime.now(FUSO_BRASILIA).isoformat(),
        "fonte": "ESPN",
        "tabela": tabela,
    }
    with open("tabela.json", "w", encoding="utf-8") as f:
        json.dump(saida, f, ensure_ascii=False, indent=2)
    print(f"OK tabela.json gravado ({len(tabela)} times, fonte ESPN).")


# ---------------------------------------------------------------------------
# SCOREBOARD -> espn_eventos.json (de-para de jogos p/ AO VIVO do site)
# ---------------------------------------------------------------------------
def gerar_eventos():
    print("== EVENTOS (ESPN scoreboard) ==")
    hoje_utc = datetime.now(timezone.utc)
    ini = (hoje_utc - timedelta(days=2)).strftime("%Y%m%d")
    fim = (hoje_utc + timedelta(days=10)).strftime("%Y%m%d")
    url = f"{URL_SCOREBOARD}?dates={ini}-{fim}&limit=120"
    print(f"Fonte: {url}")
    data = fetch_json(url)

    eventos = []
    for ev in data.get("events") or []:
        try:
            comp = (ev.get("competitions") or [{}])[0]
            cs = comp.get("competitors") or []
            casa = next((c for c in cs if c.get("homeAway") == "home"), None)
            fora = next((c for c in cs if c.get("homeAway") == "away"), None)
            if not casa or not fora:
                continue

            def canon(c):
                t = c.get("team") or {}
                return para_canonico(
                    t.get("displayName"), t.get("shortDisplayName"),
                    t.get("name"), t.get("location"), t.get("abbreviation"),
                )

            mand, vis = canon(casa), canon(fora)
            if not mand or not vis:
                print(f"  aviso: evento {ev.get('id')} com time não mapeado; pulado.")
                continue

            # data em BRT no formato usado pelo site (YYYY-MM-DDTHH:MM)
            dt = datetime.fromisoformat(str(ev.get("date")).replace("Z", "+00:00"))
            data_brt = dt.astimezone(FUSO_BRASILIA).strftime("%Y-%m-%dT%H:%M")

            # transmissão: broadcasts + geoBroadcasts (quando a ESPN informa)
            nomes_tx = []
            for b in comp.get("broadcasts") or []:
                nomes_tx.extend(b.get("names") or [])
            for g in comp.get("geoBroadcasts") or []:
                sn = ((g.get("media") or {}).get("shortName") or "").strip()
                if sn:
                    nomes_tx.append(sn)
            transmissao = " / ".join(dict.fromkeys(n for n in nomes_tx if n))

            eventos.append({
                "event_id": str(ev.get("id") or ""),
                "data_iso": data_brt,
                "mandante": mand,
                "visitante": vis,
                "estadio": ((comp.get("venue") or {}).get("fullName") or ""),
                "transmissao": transmissao,
                "estado": (((comp.get("status") or {}).get("type") or {})
                           .get("state") or ""),
            })
        except Exception as e:  # noqa: BLE001
            print(f"  aviso: evento ignorado ({type(e).__name__}: {e})")

    saida = {
        "atualizado_em": datetime.now(FUSO_BRASILIA).isoformat(),
        "fonte": "ESPN",
        "total": len(eventos),
        "eventos": eventos,
    }
    with open("espn_eventos.json", "w", encoding="utf-8") as f:
        json.dump(saida, f, ensure_ascii=False, indent=2)
    print(f"OK espn_eventos.json gravado ({len(eventos)} eventos).")


def main():
    # 1) Tabela: obrigatória. Se falhar, exit 1 e NADA é gravado
    #    (o tabela.json anterior permanece intacto no repositório).
    try:
        gerar_tabela()
    except Exception as e:  # noqa: BLE001
        print(f"ERRO FATAL na tabela: {e}")
        sys.exit(1)

    # 2) Eventos: acessório. Falha não derruba o workflow.
    try:
        gerar_eventos()
    except Exception as e:  # noqa: BLE001
        print(f"AVISO: espn_eventos.json não atualizado ({e}). Seguindo.")

    print("Concluído.")


if __name__ == "__main__":
    main()
