#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
buscar_estatisticas.py
----------------------
Consolida estatísticas públicas da Copa 2026 usando o mesmo feed ESPN/API
que o site já usa para resultados/ao vivo.

Gera: copa2026/dados/estatisticas.json

Observações:
- Artilharia: extraída primeiro de scoringPlays; se não existir, tenta commentary.
- Assistências: extraídas quando a ESPN disponibilizar no summary/texto do lance.
- Cartões: extraídos do commentary quando houver nome do jogador.
- O script é defensivo: se a ESPN oscilar, preserva o arquivo atual em vez de zerar.
"""
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone

DIR = os.path.dirname(os.path.abspath(__file__))
DADOS = os.path.join(DIR, "dados")
SAIDA = os.path.join(DADOS, "estatisticas.json")
SELECOES_JSON = os.path.join(DADOS, "selecoes.json")

SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard"
SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary"
DATES = "20260611-20260719"

HEADERS = {
    "User-Agent": "bolao-copa-estatisticas/1.0 (+brasileirao2026almoco.com.br)",
    "Accept": "application/json,text/plain,*/*",
}

# Siglas alternativas da ESPN -> siglas internas do site.
DEPARA = {
    "NED": "NED", "HOL": "NED",
    "SUI": "SUI", "SWE": "SWE",
    "USA": "USA", "US": "USA", "USMNT": "USA",
    "AUS": "AUS", "KOR": "KOR",
    "RSA": "RSA", "ZAF": "RSA",
    "CZE": "CZE", "CPV": "CPV",
    "KSA": "KSA", "URU": "URU", "POR": "POR",
    "COD": "COD", "CGO": "COD", "DRC": "COD",
    "GHA": "GHA", "PAN": "PAN", "CRO": "CRO", "ENG": "ENG",
    "ECU": "ECU", "CIV": "CIV", "CUW": "CUW",
    "JPN": "JPN", "TUN": "TUN", "IRN": "IRN", "NZL": "NZL",
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
    "turkey": "TUR", "turkiye": "TUR", "türkiye": "TUR", "germany": "GER",
    "curacao": "CUW", "curaçao": "CUW", "ivory coast": "CIV", "cote d ivoire": "CIV",
    "côte d ivoire": "CIV", "ecuador": "ECU", "netherlands": "NED", "japan": "JPN",
    "sweden": "SWE", "tunisia": "TUN", "belgium": "BEL", "egypt": "EGY",
    "iran": "IRN", "new zealand": "NZL", "spain": "ESP", "cape verde": "CPV",
    "cabo verde": "CPV", "saudi arabia": "KSA", "uruguay": "URU", "france": "FRA",
    "senegal": "SEN", "iraq": "IRQ", "norway": "NOR", "argentina": "ARG",
    "algeria": "ALG", "austria": "AUT", "jordan": "JOR", "portugal": "POR",
    "dr congo": "COD", "congo dr": "COD", "democratic republic of the congo": "COD",
    "congo": "COD", "uzbekistan": "UZB", "colombia": "COL", "england": "ENG",
    "croatia": "CRO", "ghana": "GHA", "panama": "PAN",
}

PT2SIGLA = {}


def norm(s):
    import unicodedata
    s = str(s or "").lower()
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def carregar_selecoes():
    global PT2SIGLA
    try:
        with open(SELECOES_JSON, "r", encoding="utf-8") as f:
            data = json.load(f)
        for s in data.get("selecoes", []):
            sid = s.get("id")
            if sid:
                PT2SIGLA[norm(s.get("nome"))] = sid
                PT2SIGLA[norm(sid)] = sid
    except Exception:
        pass


def sigla(valor):
    if not valor:
        return None
    v = str(valor).strip()
    up = v.upper()
    if up in DEPARA:
        return DEPARA[up]
    n = norm(v)
    return PT2SIGLA.get(n) or EN2SIGLA.get(n)


def http_get_json(url, tentativas=3):
    ultimo = None
    for i in range(tentativas):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=35) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            ultimo = e
            time.sleep(1 + i)
    raise ultimo


def get_path(obj, *path, default=None):
    cur = obj
    for p in path:
        if isinstance(cur, dict):
            cur = cur.get(p)
        elif isinstance(cur, list) and isinstance(p, int) and 0 <= p < len(cur):
            cur = cur[p]
        else:
            return default
    return cur if cur is not None else default


def team_from_obj(obj):
    if not isinstance(obj, dict):
        return None
    candidates = [
        get_path(obj, "team", "abbreviation"),
        get_path(obj, "team", "shortDisplayName"),
        get_path(obj, "team", "displayName"),
        obj.get("teamAbbreviation"),
        obj.get("teamName"),
        obj.get("team"),
    ]
    for c in candidates:
        if isinstance(c, dict):
            c = c.get("abbreviation") or c.get("displayName")
        s = sigla(c)
        if s:
            return s
    return None


def player_name_from_athlete(a):
    if not isinstance(a, dict):
        return None
    if "athlete" in a and isinstance(a["athlete"], dict):
        return player_name_from_athlete(a["athlete"])
    for k in ("displayName", "fullName", "shortName", "name"):
        v = a.get(k)
        if v and not str(v).isdigit():
            return limpar_nome(v)
    return None


def limpar_nome(s):
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    # Remove sufixos comuns que às vezes vêm no texto do lance.
    s = re.sub(r"\s*\((?:[^)]{2,40})\)\s*$", "", s).strip()
    return s


def player_from_obj(obj):
    if not isinstance(obj, dict):
        return None
    for key in ("athlete", "player", "scorer"):
        p = player_name_from_athlete(obj.get(key))
        if p:
            return p
    for key in ("athletes", "participants", "athletesInvolved", "players"):
        arr = obj.get(key)
        if isinstance(arr, list):
            for item in arr:
                p = player_name_from_athlete(item)
                if p:
                    return p
    for key in ("displayName", "athleteDisplayName", "name"):
        v = obj.get(key)
        if v:
            return limpar_nome(v)
    return None


def minute_from_obj(obj):
    for path in (("clock", "displayValue"), ("time", "displayValue"), ("period", "displayValue")):
        v = get_path(obj, *path)
        if v:
            return str(v)
    for k in ("clock", "time", "minute"):
        v = obj.get(k) if isinstance(obj, dict) else None
        if isinstance(v, (str, int, float)) and v != "":
            return str(v)
    return ""


def add(agg, nome, equipe, campo, valor, jogo_id, minuto=""):
    if not nome:
        return
    nome = limpar_nome(nome)
    if not nome or nome in ("Own Goal", "Penalty Shootout"):
        return
    equipe = equipe or ""
    key = (norm(nome), equipe)
    rec = agg.setdefault(key, {
        "nome": nome,
        "equipe": equipe,
        "gols": 0,
        "assistencias": 0,
        "amarelos": 0,
        "vermelhos": 0,
        "jogos": set(),
        "lances": set(),
    })
    lance_key = f"{jogo_id}|{campo}|{minuto}|{norm(nome)}|{equipe}"
    if lance_key in rec["lances"]:
        return
    rec["lances"].add(lance_key)
    rec[campo] += valor
    if jogo_id:
        rec["jogos"].add(str(jogo_id))


def text_of(obj):
    if not isinstance(obj, dict):
        return ""
    return str(obj.get("text") or obj.get("description") or obj.get("shortText") or obj.get("displayText") or "")


def type_text(obj):
    if not isinstance(obj, dict):
        return ""
    t = obj.get("type")
    if isinstance(t, dict):
        return " ".join(str(t.get(k) or "") for k in ("id", "text", "name", "displayName", "abbreviation"))
    return str(t or "")


def team_from_text(txt):
    # tenta capturar o nome entre parênteses logo após o jogador: "Fulano (Portugal)".
    for m in re.finditer(r"\(([^)]{2,45})\)", txt or ""):
        s = sigla(m.group(1))
        if s:
            return s
    return None


def goal_scorer_from_text(txt):
    if not txt:
        return None
    # Padrões comuns da ESPN em inglês e português.
    patterns = [
        r"Goal!\s.*?\.\s*([^\.]+?)\s*\((?:[^)]*)\)",
        r"Gol!\s.*?\.\s*([^\.]+?)\s*\((?:[^)]*)\)",
        r"^\s*([^\.]+?)\s+\((?:[^)]*)\)\s*(?:right|left|header|converts|marca|finalização)",
    ]
    for pat in patterns:
        m = re.search(pat, txt, flags=re.I)
        if m:
            p = limpar_nome(m.group(1))
            if p and len(p) <= 60:
                return p
    return None


def assist_from_text(txt):
    if not txt:
        return None
    patterns = [
        r"Assisted by\s+([^\.]+?)(?:\s+with|\s+following|\.|$)",
        r"Assistência de\s+([^\.]+?)(?:\s+com|\.|$)",
    ]
    for pat in patterns:
        m = re.search(pat, txt, flags=re.I)
        if m:
            p = limpar_nome(m.group(1))
            if p and len(p) <= 60:
                return p
    return None


def card_player_from_text(txt):
    if not txt:
        return None
    patterns = [
        r"(?:Yellow Card|Red Card)\s+(?:to\s+)?([^\(\.]+?)\s*\((?:[^)]*)\)",
        r"(?:Cartão amarelo|Cartão vermelho)\s+(?:para\s+)?([^\(\.]+?)\s*\((?:[^)]*)\)",
        r"^([^\(\.]+?)\s*\((?:[^)]*)\)\s+(?:is shown the|recebe|levou)",
    ]
    for pat in patterns:
        m = re.search(pat, txt, flags=re.I)
        if m:
            p = limpar_nome(m.group(1))
            if p and len(p) <= 60:
                return p
    return None


def extract_scoring_plays(summary, jogo_id, agg):
    plays = []
    for path in (("scoringPlays",), ("competitions", 0, "scoringPlays")):
        v = get_path(summary, *path, default=[])
        if isinstance(v, list):
            plays.extend(v)

    used = 0
    for sp in plays:
        if not isinstance(sp, dict):
            continue
        txt = text_of(sp)
        ttxt = type_text(sp).lower()
        # Evita gols de disputa de pênaltis.
        if "shootout" in ttxt or "penalty shootout" in txt.lower():
            continue
        equipe = team_from_obj(sp) or team_from_text(txt)
        minuto = minute_from_obj(sp)
        scorer = player_from_obj(sp) or goal_scorer_from_text(txt)
        if scorer:
            add(agg, scorer, equipe, "gols", 1, jogo_id, minuto)
            used += 1
        # assistência pode vir estruturada ou no texto.
        ast = None
        for key in ("assist", "assistedBy"):
            ast = player_name_from_athlete(sp.get(key)) if isinstance(sp, dict) else None
            if ast:
                break
        if not ast:
            ast = assist_from_text(txt)
        if ast:
            add(agg, ast, equipe, "assistencias", 1, jogo_id, minuto)
    return used


def extract_commentary(summary, jogo_id, agg, skip_goals_if_scoringplays=True):
    commentary = summary.get("commentary") or summary.get("plays") or []
    if isinstance(commentary, dict):
        commentary = commentary.get("items") or commentary.get("plays") or []
    if not isinstance(commentary, list):
        return

    for ev in commentary:
        if not isinstance(ev, dict):
            continue
        txt = text_of(ev)
        raw = (type_text(ev) + " " + txt).lower()
        minuto = minute_from_obj(ev)
        equipe = team_from_obj(ev) or team_from_text(txt)

        is_goal = ("goal" in raw or "gol!" in raw or " gol " in raw) and "own goal" not in raw and "shootout" not in raw
        is_yellow = "yellow card" in raw or "cartão amarelo" in raw or "cartao amarelo" in raw
        is_red = "red card" in raw or "cartão vermelho" in raw or "cartao vermelho" in raw

        if is_goal and not skip_goals_if_scoringplays:
            scorer = player_from_obj(ev) or goal_scorer_from_text(txt)
            if scorer:
                add(agg, scorer, equipe, "gols", 1, jogo_id, minuto)
            ast = assist_from_text(txt)
            if ast:
                add(agg, ast, equipe, "assistencias", 1, jogo_id, minuto)
        elif is_goal:
            # Mesmo que o gol já tenha vindo de scoringPlays, a assistência às vezes só vem no commentary.
            ast = assist_from_text(txt)
            if ast:
                add(agg, ast, equipe, "assistencias", 1, jogo_id, minuto)

        if is_yellow or is_red:
            p = player_from_obj(ev) or card_player_from_text(txt)
            if p:
                if is_yellow:
                    add(agg, p, equipe, "amarelos", 1, jogo_id, minuto)
                if is_red:
                    add(agg, p, equipe, "vermelhos", 1, jogo_id, minuto)


def coletar():
    carregar_selecoes()
    sb = http_get_json(f"{SCOREBOARD}?dates={DATES}&limit=220")
    eventos = sb.get("events") or []
    processaveis = []
    for ev in eventos:
        comp = get_path(ev, "competitions", 0, default={}) or {}
        status = get_path(comp, "status", "type", "state")
        # Pega jogos encerrados e em andamento. Pré-jogo não tem estatística relevante.
        if status in ("post", "in"):
            processaveis.append(ev)

    agg = {}
    falhas = []
    for ev in processaveis:
        eid = ev.get("id")
        if not eid:
            continue
        try:
            summary = http_get_json(f"{SUMMARY}?event={eid}")
        except Exception as e:
            falhas.append({"event": eid, "erro": str(e)[:140]})
            continue
        qtd_gols_sp = extract_scoring_plays(summary, eid, agg)
        extract_commentary(summary, eid, agg, skip_goals_if_scoringplays=(qtd_gols_sp > 0))

    jogadores = []
    for rec in agg.values():
        jogos = sorted(rec.pop("jogos", set()))
        rec.pop("lances", None)
        rec["jogos"] = jogos
        rec["total_cartoes"] = rec.get("amarelos", 0) + rec.get("vermelhos", 0)
        jogadores.append(rec)

    def sort_base(campo):
        return sorted(
            [x for x in jogadores if x.get(campo, 0) > 0],
            key=lambda x: (-x.get(campo, 0), x.get("nome", ""), x.get("equipe", ""))
        )

    artilheiros = sort_base("gols")
    assistencias = sort_base("assistencias")
    cartoes = sorted(
        [x for x in jogadores if x.get("total_cartoes", 0) > 0],
        key=lambda x: (-x.get("vermelhos", 0), -x.get("amarelos", 0), x.get("nome", ""), x.get("equipe", ""))
    )

    # Consolida por seleção para cards-resumo/uso futuro.
    por_sel = {}
    for x in jogadores:
        e = x.get("equipe") or ""
        if not e:
            continue
        r = por_sel.setdefault(e, {"equipe": e, "gols": 0, "assistencias": 0, "amarelos": 0, "vermelhos": 0})
        r["gols"] += x.get("gols", 0)
        r["assistencias"] += x.get("assistencias", 0)
        r["amarelos"] += x.get("amarelos", 0)
        r["vermelhos"] += x.get("vermelhos", 0)

    return {
        "_comentario": "Estatísticas consolidadas automaticamente a partir do feed ESPN/API. Assistências dependem de disponibilidade no summary/comentário da ESPN.",
        "fonte": "ESPN API pública/oculta usada pelo site.api.espn.com",
        "atualizado_em": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "periodo": DATES,
        "jogos_encontrados": len(eventos),
        "jogos_processados": len(processaveis),
        "falhas_summary": falhas[:20],
        "artilheiros": artilheiros,
        "assistencias": assistencias,
        "cartoes": cartoes,
        "por_selecao": sorted(por_sel.values(), key=lambda x: x["equipe"]),
    }


def main():
    os.makedirs(DADOS, exist_ok=True)
    try:
        dados = coletar()
    except Exception as e:
        print("Falha geral ao coletar estatísticas:", e)
        # Preserva o arquivo atual para não zerar a página em oscilação da ESPN/GitHub.
        if os.path.exists(SAIDA):
            print("Arquivo existente preservado:", SAIDA)
            return 0
        dados = {
            "_comentario": "Arquivo inicial. A coleta automática ainda não conseguiu consultar a ESPN.",
            "fonte": "ESPN API pública/oculta usada pelo site.api.espn.com",
            "atualizado_em": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "periodo": DATES,
            "jogos_encontrados": 0,
            "jogos_processados": 0,
            "falhas_summary": [{"erro": str(e)[:180]}],
            "artilheiros": [],
            "assistencias": [],
            "cartoes": [],
            "por_selecao": [],
        }

    with open(SAIDA, "w", encoding="utf-8") as f:
        json.dump(dados, f, ensure_ascii=False, indent=2)
    print(f"OK: {len(dados.get('artilheiros', []))} artilheiros, {len(dados.get('assistencias', []))} assistentes, {len(dados.get('cartoes', []))} jogadores com cartões.")
    print("Salvo em", SAIDA)
    return 0


if __name__ == "__main__":
    sys.exit(main())
