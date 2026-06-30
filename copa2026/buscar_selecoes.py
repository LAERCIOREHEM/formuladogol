#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
buscar_selecoes.py — Robô da aba SELEÇÕES (Copa 2026)

O que faz:
  1) Lê dados/selecoes.json (fonte da verdade: sigla, nome PT, iso2, grupo).
  2) Busca a lista de seleções na ESPN (fifa.world) e casa cada time com a
     nossa sigla, usando o MESMO mapeamento do buscar_estatisticas.py.
  3) Para cada seleção, busca o elenco (roster) na ESPN.
  4) Baixa o rosto (headshot) de cada jogador para img/jogadores/{id}.png.
  5) Grava:
       - dados/elencos.json -> times[SIGLA] = [ {id,nome,pos,num,foto} ]
       - dados/rostos.json  -> mapa["SIGLA|nome-normalizado"] = "img/jogadores/{id}.png"
     (rostos.json alimenta as carinhas dos artilheiros/assistências.)

Degradação: se a ESPN não tiver foto de um jogador, o site mostra silhueta.
Idempotente: não rebaixa fotos que já existem (use --forcar para rebaixar).

Uso:
  python3 buscar_selecoes.py            # roda de verdade (precisa de internet)
  python3 buscar_selecoes.py --forcar   # rebaixa todas as fotos
  python3 buscar_selecoes.py --selftest # testa a LÓGICA offline (sem internet)

Recomendado rodar 2h e 10h (Brasília). Veja o workflow atualizar-selecoes.yml.
"""

import json
import os
import re
import sys
import time
import unicodedata
import urllib.request

from datetime import datetime, timezone

DIR = os.path.dirname(os.path.abspath(__file__))
DADOS = os.path.join(DIR, "dados")
IMG_DIR = os.path.join(DIR, "img", "jogadores")
SELECOES_JSON = os.path.join(DADOS, "selecoes.json")
ELENCOS_JSON = os.path.join(DADOS, "elencos.json")
ROSTOS_JSON = os.path.join(DADOS, "rostos.json")

BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world"
TEAMS_URL = BASE + "/teams"
ROSTER_URL = BASE + "/teams/{id}/roster"
ROSTER_ALT = BASE + "/teams/{id}?enable=roster"

HEADERS = {
    "User-Agent": "bolao-copa-selecoes/1.0 (+brasileirao2026almoco.com.br)",
    "Accept": "application/json,text/plain,*/*",
}

# --- Mapeamento ESPN -> nossa sigla (espelha buscar_estatisticas.py) -------
DEPARA = {
    "NED": "NED", "HOL": "NED", "SUI": "SUI", "SWE": "SWE",
    "USA": "USA", "US": "USA", "USMNT": "USA", "AUS": "AUS", "KOR": "KOR",
    "RSA": "RSA", "ZAF": "RSA", "CZE": "CZE", "CPV": "CPV",
    "KSA": "KSA", "URU": "URU", "POR": "POR",
    "COD": "COD", "CGO": "COD", "DRC": "COD",
    "GHA": "GHA", "PAN": "PAN", "CRO": "CRO", "ENG": "ENG",
    "ECU": "ECU", "CIV": "CIV", "CUW": "CUW",
    "JPN": "JPN", "TUN": "TUN", "IRN": "IRN", "IRI": "IRN", "IR IRAN": "IRN", "NZL": "NZL",
    "EGY": "EGY", "BEL": "BEL", "ARG": "ARG",
    "ALG": "ALG", "DZA": "ALG",
    "AUT": "AUT", "JOR": "JOR", "FRA": "FRA", "SEN": "SEN",
    "IRQ": "IRQ", "NOR": "NOR", "COL": "COL", "UZB": "UZB",
    "MEX": "MEX", "BRA": "BRA", "MAR": "MAR", "HAI": "HAI",
    "GER": "GER", "DEU": "GER",
    "CAN": "CAN", "QAT": "QAT", "SCO": "SCO", "TUR": "TUR",
    "BIH": "BIH", "PAR": "PAR", "ESP": "ESP",
}

EN2SIGLA = {
    "mexico": "MEX", "south africa": "RSA", "south korea": "KOR", "korea republic": "KOR",
    "czechia": "CZE", "czech republic": "CZE", "canada": "CAN",
    "bosnia and herzegovina": "BIH", "bosnia": "BIH", "qatar": "QAT", "switzerland": "SUI",
    "brazil": "BRA", "morocco": "MAR", "haiti": "HAI", "scotland": "SCO",
    "united states": "USA", "usa": "USA", "paraguay": "PAR", "australia": "AUS",
    "turkey": "TUR", "turkiye": "TUR", "germany": "GER",
    "curacao": "CUW", "ivory coast": "CIV", "cote d ivoire": "CIV",
    "ecuador": "ECU", "netherlands": "NED", "japan": "JPN",
    "sweden": "SWE", "tunisia": "TUN", "belgium": "BEL", "egypt": "EGY",
    "iran": "IRN", "ir iran": "IRN", "iran islamic republic": "IRN",
    "islamic republic of iran": "IRN", "new zealand": "NZL", "spain": "ESP", "cape verde": "CPV",
    "cabo verde": "CPV", "saudi arabia": "KSA", "uruguay": "URU", "france": "FRA",
    "senegal": "SEN", "iraq": "IRQ", "norway": "NOR", "argentina": "ARG",
    "algeria": "ALG", "austria": "AUT", "jordan": "JOR", "portugal": "POR",
    "dr congo": "COD", "congo dr": "COD", "democratic republic of the congo": "COD",
    "congo": "COD", "uzbekistan": "UZB", "colombia": "COL", "england": "ENG",
    "croatia": "CRO", "ghana": "GHA", "panama": "PAN",
}

POS_PT = {
    "G": "GOL", "GK": "GOL", "GOALKEEPER": "GOL",
    "D": "DEF", "DEFENDER": "DEF",
    "M": "MEI", "MIDFIELDER": "MEI",
    "F": "ATA", "FORWARD": "ATA", "STRIKER": "ATA",
}

PT2SIGLA = {}


def norm(s):
    s = str(s or "").lower()
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def carregar_selecoes():
    """Preenche PT2SIGLA e devolve a lista de seleções do nosso JSON."""
    global PT2SIGLA
    try:
        with open(SELECOES_JSON, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return []
    lista = data.get("selecoes", []) or []
    for s in lista:
        sid = s.get("id")
        if sid:
            PT2SIGLA[norm(s.get("nome"))] = sid
            PT2SIGLA[norm(sid)] = sid
    return lista


def sigla(valor):
    if not valor:
        return None
    v = str(valor).strip()
    up = v.upper()
    if up in DEPARA:
        return DEPARA[up]
    n = norm(v)
    return PT2SIGLA.get(n) or EN2SIGLA.get(n)


def pos_pt(p):
    if not p:
        return None
    return POS_PT.get(str(p).strip().upper(), str(p).strip())


# --- Parsing puro (testável sem internet) ----------------------------------
def extrair_times(teams_json):
    """Devolve [ {id, abbr, name} ] a partir do JSON de /teams da ESPN."""
    out = []
    try:
        sports = teams_json.get("sports") or []
        leagues = (sports[0].get("leagues") if sports else []) or []
        times = (leagues[0].get("teams") if leagues else []) or []
    except Exception:
        times = []
    for t in times:
        team = t.get("team") if isinstance(t, dict) else None
        if not isinstance(team, dict):
            continue
        out.append({
            "id": str(team.get("id") or "").strip(),
            "abbr": team.get("abbreviation") or "",
            "name": team.get("displayName") or team.get("name") or "",
        })
    return [x for x in out if x["id"]]


def _coletar_lista(node):
    """Achata roster que pode vir agrupado por posição (com 'items') ou plano."""
    out = []
    if isinstance(node, list):
        for el in node:
            if isinstance(el, dict) and isinstance(el.get("items"), list):
                out.extend(el["items"])
            elif isinstance(el, dict):
                out.append(el)
    return out


def extrair_atletas(roster_json):
    """Devolve [ {id,nome,pos,num,foto_url} ] de qualquer formato de roster ESPN."""
    ath = None
    if isinstance(roster_json, dict):
        if isinstance(roster_json.get("athletes"), list):
            ath = roster_json["athletes"]
        elif isinstance(roster_json.get("team"), dict) and isinstance(roster_json["team"].get("athletes"), list):
            ath = roster_json["team"]["athletes"]
    res = []
    vistos = set()
    for a in _coletar_lista(ath or []):
        if not isinstance(a, dict):
            continue
        inner = a.get("athlete") if isinstance(a.get("athlete"), dict) else a
        aid = inner.get("id") or a.get("id")
        nome = inner.get("displayName") or inner.get("fullName") or inner.get("name")
        if not aid or not nome:
            continue
        aid = str(aid)
        if aid in vistos:
            continue
        vistos.add(aid)
        posicao = inner.get("position")
        if isinstance(posicao, dict):
            posicao = posicao.get("abbreviation") or posicao.get("name")
        num = inner.get("jersey")
        hs = inner.get("headshot")
        foto_url = hs.get("href") if isinstance(hs, dict) else (hs if isinstance(hs, str) else None)
        res.append({
            "id": aid,
            "nome": str(nome).strip(),
            "pos": pos_pt(posicao),
            "num": (str(num).strip() if num not in (None, "") else None),
            "foto_url": foto_url,
        })
    return res


def construir_saida(atletas_por_sigla, fotos_ok):
    """Monta os dicts de elencos.json e rostos.json.
    atletas_por_sigla: {SIGLA: [atleta...]}; fotos_ok: set de ids com foto salva."""
    times = {}
    mapa = {}
    for sg in sorted(atletas_por_sigla.keys()):
        linha = []
        for p in atletas_por_sigla[sg]:
            tem_foto = p["id"] in fotos_ok
            caminho = "img/jogadores/%s.png" % p["id"] if tem_foto else None
            linha.append({
                "id": p["id"],
                "nome": p["nome"],
                "pos": p.get("pos"),
                "num": p.get("num"),
                "foto": caminho,
            })
            if tem_foto:
                mapa["%s|%s" % (sg, norm(p["nome"]))] = caminho
        times[sg] = linha
    return times, mapa


# --- Rede ------------------------------------------------------------------
def http_get_json(url, tentativas=3):
    ultimo = None
    for i in range(tentativas):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except Exception as e:
            ultimo = e
            time.sleep(1.2 * (i + 1))
    print("  ! falha ao buscar %s (%s)" % (url, ultimo))
    return None


def baixar_foto(url, dest, forcar=False):
    if not url:
        return False
    if os.path.exists(dest) and not forcar:
        return True
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=30) as r:
            dados = r.read()
        if not dados:
            return False
        tmp = dest + ".tmp"
        with open(tmp, "wb") as f:
            f.write(dados)
        os.replace(tmp, dest)
        return True
    except Exception as e:
        print("  ! falha ao baixar foto %s (%s)" % (url, e))
        return False


def escrever_json(caminho, obj):
    tmp = caminho + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, caminho)


# --- Execução real ---------------------------------------------------------
def rodar(forcar=False):
    selecoes = carregar_selecoes()
    if not selecoes:
        print("ERRO: não consegui ler selecoes.json — abortando.")
        return 1
    nossas = {s.get("id") for s in selecoes if s.get("id")}
    os.makedirs(IMG_DIR, exist_ok=True)

    print("→ Buscando lista de seleções na ESPN…")
    teams_json = http_get_json(TEAMS_URL)
    times_espn = extrair_times(teams_json or {})
    print("  %d times retornados pela ESPN." % len(times_espn))

    # casa cada time da ESPN com a nossa sigla
    espn_por_sigla = {}
    for t in times_espn:
        sg = sigla(t["abbr"]) or sigla(t["name"])
        if sg and sg in nossas and sg not in espn_por_sigla:
            espn_por_sigla[sg] = t["id"]

    faltando = sorted(nossas - set(espn_por_sigla.keys()))
    if faltando:
        print("  aviso: sem time ESPN para: %s" % ", ".join(faltando))

    atletas_por_sigla = {}
    fotos_ok = set()
    total_jog = 0
    for sg in sorted(espn_por_sigla.keys()):
        tid = espn_por_sigla[sg]
        rj = http_get_json(ROSTER_URL.format(id=tid))
        atletas = extrair_atletas(rj or {})
        if not atletas:
            rj = http_get_json(ROSTER_ALT.format(id=tid))
            atletas = extrair_atletas(rj or {})
        atletas_por_sigla[sg] = atletas
        total_jog += len(atletas)
        baixadas = 0
        for p in atletas:
            dest = os.path.join(IMG_DIR, "%s.png" % p["id"])
            if baixar_foto(p.get("foto_url"), dest, forcar=forcar):
                fotos_ok.add(p["id"])
                baixadas += 1
        print("  %s: %d jogadores, %d fotos." % (sg, len(atletas), baixadas))
        time.sleep(0.4)

    times, mapa = construir_saida(atletas_por_sigla, fotos_ok)
    agora = datetime.now(timezone.utc).isoformat()
    escrever_json(ELENCOS_JSON, {
        "_nota": "Elencos por seleção + caminho das fotos. Gerado por buscar_selecoes.py (ESPN). times[SIGLA] = [ {id,nome,pos,num,foto} ].",
        "gerado_em": agora,
        "fonte": "site.api.espn.com (fifa.world)",
        "times": times,
    })
    escrever_json(ROSTOS_JSON, {
        "_nota": "Mapa de rostos para artilheiros/assistências. Chave = SIGLA|nome-normalizado, valor = caminho da foto.",
        "gerado_em": agora,
        "mapa": mapa,
    })
    print("✓ %d seleções, %d jogadores, %d fotos. elencos.json e rostos.json atualizados." %
          (len(times), total_jog, len(fotos_ok)))
    return 0


# --- Selftest (offline) ----------------------------------------------------
def selftest():
    ok = True

    def checa(cond, msg):
        nonlocal ok
        print(("  ok  " if cond else "  ERRO ") + msg)
        if not cond:
            ok = False

    # PT2SIGLA mínimo para o teste (sem ler arquivo)
    global PT2SIGLA
    PT2SIGLA = {"brasil": "BRA", "bra": "BRA", "argentina": "ARG", "arg": "ARG"}

    checa(sigla("BRA") == "BRA", "sigla('BRA') -> BRA")
    checa(sigla("Brazil") == "BRA", "sigla('Brazil') -> BRA")
    checa(sigla("USMNT") == "USA", "sigla('USMNT') -> USA (DEPARA)")
    checa(sigla("Netherlands") == "NED", "sigla('Netherlands') -> NED")
    checa(norm("Lionel Messi") == "lionel messi", "norm acentos/caixa")
    checa(pos_pt("G") == "GOL" and pos_pt("Forward") == "ATA", "pos_pt mapeia posição")

    teams_mock = {"sports": [{"leagues": [{"teams": [
        {"team": {"id": "205", "abbreviation": "BRA", "displayName": "Brazil"}},
        {"team": {"id": "202", "abbreviation": "ARG", "displayName": "Argentina"}},
    ]}]}]}
    tms = extrair_times(teams_mock)
    checa(len(tms) == 2 and tms[0]["id"] == "205", "extrair_times lê /teams")

    # roster AGRUPADO por posição (com 'items')
    roster_grp = {"athletes": [
        {"position": "Goalkeeper", "items": [
            {"id": "1", "displayName": "Alisson Becker", "jersey": "1",
             "position": {"abbreviation": "G"}, "headshot": {"href": "http://x/1.png"}},
        ]},
        {"position": "Forward", "items": [
            {"id": "2", "displayName": "Neymar Jr", "jersey": "10",
             "position": {"abbreviation": "F"}, "headshot": {"href": "http://x/2.png"}},
            {"id": "3", "fullName": "Vinicius Junior", "jersey": "7",
             "position": {"abbreviation": "F"}},  # sem headshot
        ]},
    ]}
    ag = extrair_atletas(roster_grp)
    checa(len(ag) == 3, "extrair_atletas (agrupado) acha 3")
    checa(ag[0]["pos"] == "GOL" and ag[0]["num"] == "1", "posição/numero ok")
    checa(ag[2]["foto_url"] is None, "jogador sem headshot -> foto_url None")

    # roster PLANO (lista direta) + bloco 'athlete' aninhado
    roster_flat = {"athletes": [
        {"athlete": {"id": "9", "displayName": "Lionel Messi", "jersey": "10",
                     "position": {"name": "Forward"}, "headshot": {"href": "http://x/9.png"}}},
        {"id": "9", "displayName": "Lionel Messi (dup)"},  # duplicado por id -> ignorado
    ]}
    fl = extrair_atletas(roster_flat)
    checa(len(fl) == 1 and fl[0]["nome"] == "Lionel Messi", "extrair_atletas (plano+dedupe)")

    # construir_saida: só quem tem foto entra no rostos.json; foto=None caso contrário
    aps = {"BRA": ag}
    fotos_ok = {"1", "2"}  # 3 (Vinicius) sem foto
    times, mapa = construir_saida(aps, fotos_ok)
    checa(times["BRA"][0]["foto"] == "img/jogadores/1.png", "elenco aponta foto correta")
    vini = [p for p in times["BRA"] if p["id"] == "3"][0]
    checa(vini["foto"] is None, "sem foto -> foto None no elenco (vira silhueta)")
    checa(mapa.get("BRA|alisson becker") == "img/jogadores/1.png", "rostos.json chave SIGLA|nome-normalizado")
    checa("BRA|vinicius junior" not in mapa, "sem foto -> fora do rostos.json")
    # a chave do rostos casa com normNome() do estatisticas.js (mesma normalização)
    checa(norm("Neymar Jr") == "neymar jr", "normalização consistente com o front")

    print("\nSELFTEST:", "PASSOU ✅" if ok else "FALHOU ❌")
    return 0 if ok else 1


def main():
    args = set(sys.argv[1:])
    if "--selftest" in args:
        return selftest()
    return rodar(forcar=("--forcar" in args))


if __name__ == "__main__":
    sys.exit(main())
