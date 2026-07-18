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
- Assistências: extraídas somente quando vinculadas a lance de gol real da ESPN.
- Cartões: extraídos do commentary quando houver nome do jogador.
- Gols por seleção: consolidados pelo placar oficial dos jogos processados, incluindo gols contra.
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
    "turkey": "TUR", "turkiye": "TUR", "türkiye": "TUR", "germany": "GER",
    "curacao": "CUW", "curaçao": "CUW", "ivory coast": "CIV", "cote d ivoire": "CIV",
    "côte d ivoire": "CIV", "ecuador": "ECU", "netherlands": "NED", "japan": "JPN",
    "sweden": "SWE", "tunisia": "TUN", "belgium": "BEL", "egypt": "EGY",
    "iran": "IRN", "ir iran": "IRN", "iran islamic republic": "IRN", "islamic republic of iran": "IRN", "new zealand": "NZL", "spain": "ESP", "cape verde": "CPV",
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


def score_int(v):
    try:
        if v is None or v == "":
            return 0
        return int(float(str(v).replace(",", ".")))
    except Exception:
        return 0


def team_from_competitor(comp):
    if not isinstance(comp, dict):
        return None
    candidates = [
        get_path(comp, "team", "abbreviation"),
        get_path(comp, "team", "shortDisplayName"),
        get_path(comp, "team", "displayName"),
        comp.get("abbreviation"),
        comp.get("teamAbbreviation"),
        comp.get("displayName"),
        comp.get("name"),
    ]
    for c in candidates:
        s = sigla(c)
        if s:
            return s
    return team_from_obj(comp)


def player_name_from_athlete(a):
    if not isinstance(a, dict):
        return None
    if "athlete" in a and isinstance(a["athlete"], dict):
        return player_name_from_athlete(a["athlete"])
    for k in ("displayName", "fullName", "shortName", "name"):
        v = a.get(k)
        if v and not str(v).isdigit():
            nome = limpar_nome(v)
            if nome and not nome_eh_marcador_tecnico(nome):
                return nome
    return None


def limpar_nome(s):
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    # Remove sufixos comuns que às vezes vêm no texto do lance.
    s = re.sub(r"\s*\((?:[^)]{2,40})\)\s*$", "", s).strip()
    return s


def nome_eh_marcador_tecnico(nome):
    """Identifica rótulos do lance que não são atletas.

    A ESPN às vezes expõe abreviações como ``PEN`` no próprio objeto do
    scoring play. Isso significa que o gol foi de pênalti; não é nome de
    jogador. O autor deve vir do objeto ``athlete``/``participants`` ou do
    texto do lance.
    """
    texto = limpar_nome(nome)
    if not texto:
        return True
    n = norm(texto)
    compact = n.replace(" ", "")
    rotulos = {
        "pen", "pk", "p k", "penalty", "penaltykick", "penaltygoal",
        "penaltyscored", "penaltyscore", "penalti", "penaltimarcado",
        "penalticonvertido", "penaltiscored", "goal", "gol",
        "goalscored", "goalscore", "golmarcado", "owngoal",
        "og", "golcontra", "penaltyshootout", "shootout",
        "penaltyshoot out", "penaltyshoot-out",
    }
    return n in rotulos or compact in rotulos


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
    # Só usa nome solto do próprio lance se ele parecer atleta. Campos como
    # displayName/name podem vir como "PEN" ou "OG" e são qualificador do gol.
    for key in ("displayName", "athleteDisplayName", "name"):
        v = obj.get(key)
        if v:
            nome = limpar_nome(v)
            if nome and not nome_eh_marcador_tecnico(nome):
                return nome
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


def normalizar_minuto(minuto):
    """Normaliza minuto para deduplicar scoringPlays/commentary sem confundir 45+2 com 45."""
    txt = str(minuto or "").strip().lower()
    if not txt:
        return ""
    nums = re.findall(r"\d+", txt)
    if not nums:
        return norm(txt)
    if len(nums) >= 2 and ("+" in txt or "'" in txt or "stoppage" in txt or "acr" in txt):
        return f"{int(nums[0])}+{int(nums[1])}"
    return str(int(nums[0]))


def texto_indica_gol_real(txt):
    """True apenas para texto típico de gol, evitando 'shot on goal', 'saved ... goal' etc."""
    texto = str(txt or "").strip()
    bruto = texto.lower()
    if not texto:
        return False
    if "own goal" in bruto or "gol contra" in bruto or "shootout" in bruto or "penalty shootout" in bruto:
        return False
    # ESPN costuma iniciar lances de gol com Goal!/Gol!.
    # Não usa fallback amplo do tipo "Fulano (Time) right footed...",
    # porque esse formato também aparece em chute defendido/para fora.
    return bool(re.search(r"^\s*(?:goal|gol)\s*!", texto, flags=re.I))


def tipo_indica_gol_real(ev):
    """Usa o tipo estruturado da ESPN, mas sem aceitar frases amplas como 'shot on goal'."""
    ttxt = type_text(ev).lower()
    if not ttxt:
        return False
    if "shootout" in ttxt or "own goal" in ttxt or "penalty" in ttxt and "shootout" in ttxt:
        return False
    bloqueios = (
        "shot on goal", "attempt", "save", "saved", "goalkeeper",
        "goal kick", "miss", "missed", "blocked", "off target",
    )
    if any(b in ttxt for b in bloqueios):
        return False
    return bool(re.search(r"\b(?:goal|gol)\b", ttxt, flags=re.I))


def evento_e_gol_real(ev, txt=None):
    txt = text_of(ev) if txt is None else txt
    return tipo_indica_gol_real(ev) or texto_indica_gol_real(txt)


def period_number_from_obj(obj):
    """Retorna o número do período quando a ESPN informa isso de forma estruturada."""
    if not isinstance(obj, dict):
        return None
    candidates = [
        get_path(obj, "period", "number"),
        get_path(obj, "period", "value"),
        get_path(obj, "period", "id"),
        obj.get("period"),
    ]
    for v in candidates:
        if isinstance(v, dict):
            continue
        try:
            if v is not None and str(v).strip() != "":
                return int(float(str(v).strip()))
        except Exception:
            pass
    return None


def periodo_texto_from_obj(obj):
    if not isinstance(obj, dict):
        return ""
    partes = [
        get_path(obj, "period", "displayValue"),
        get_path(obj, "period", "text"),
        get_path(obj, "period", "name"),
        get_path(obj, "period", "abbreviation"),
        get_path(obj, "status", "type", "description"),
        get_path(obj, "status", "type", "detail"),
    ]
    return " ".join(str(x or "") for x in partes)


def evento_e_disputa_penaltis(ev, txt=None):
    """
    True somente para cobranças de disputa de pênaltis pós-jogo.

    Importante: NÃO barra gol de pênalti durante tempo normal/prorrogação.
    Portanto, palavras soltas como "penalty" ou "pênalti" não bastam.
    """
    txt = text_of(ev) if txt is None else str(txt or "")
    bruto = " ".join([type_text(ev), periodo_texto_from_obj(ev), txt]).lower()
    bruto_norm = norm(bruto)

    sinais = (
        "penalty shootout", "penalty shoot out", "penalty shoot-out",
        "shootout", "shoot out", "shoot-out",
        "kicks from the penalty mark", "penalty kicks",
        "disputa de penaltis", "disputa dos penaltis", "decisao por penaltis",
    )
    if any(s in bruto or s in bruto_norm for s in sinais):
        return True

    # Em futebol, períodos 1/2 = tempo normal; 3/4 = prorrogação; 5+ = disputa.
    # Isso preserva pênaltis cobrados no jogo, inclusive na prorrogação.
    periodo = period_number_from_obj(ev)
    if periodo is not None and periodo >= 5:
        return True

    return False


def texto_indica_gol_contra(txt):
    bruto = str(txt or "").lower()
    bruto_norm = norm(bruto)
    return "own goal" in bruto or "gol contra" in bruto_norm


def ordem_lance_para_gol(ev, idx):
    """Ordena lances para priorizar gols de jogo antes de qualquer ruído pós-jogo."""
    shootout = evento_e_disputa_penaltis(ev)
    periodo = period_number_from_obj(ev)
    periodo_ordem = periodo if periodo is not None else 99
    minuto_txt = minute_from_obj(ev)
    nums = re.findall(r"\d+", str(minuto_txt or ""))
    minuto = int(nums[0]) if nums else 999
    sem_minuto = 1 if not nums else 0
    return (1 if shootout else 0, periodo_ordem, sem_minuto, minuto, idx)


def pode_consumir_gol_oficial(equipe, gols_aceitos_por_equipe, gols_oficiais_evento):
    """Garante que artilheiros individuais nunca passem do placar oficial do jogo."""
    if not equipe or not isinstance(gols_oficiais_evento, dict):
        return True
    if equipe not in gols_oficiais_evento:
        return True
    limite = gols_oficiais_evento.get(equipe, 0) or 0
    return gols_aceitos_por_equipe.get(equipe, 0) < limite


def consumir_gol_oficial(equipe, gols_aceitos_por_equipe):
    if equipe:
        gols_aceitos_por_equipe[equipe] = gols_aceitos_por_equipe.get(equipe, 0) + 1


def chave_gol(equipe, minuto):
    return (equipe or "", normalizar_minuto(minuto))


def match_gol_real(gols_reais, equipe, minuto):
    """Vincula assistência do commentary a um gol real já identificado em scoringPlays."""
    if not gols_reais:
        return None
    m = normalizar_minuto(minuto)
    candidatos = [g for g in gols_reais if (not equipe or not g.get("equipe") or g.get("equipe") == equipe)]
    if m:
        exatos = [g for g in candidatos if normalizar_minuto(g.get("minuto")) == m]
        if len(exatos) == 1:
            return exatos[0]
        if equipe and exatos:
            return exatos[0]
    # Fallback muito conservador: se há apenas um gol do mesmo time no jogo.
    if equipe:
        mesmo_time = [g for g in gols_reais if g.get("equipe") == equipe]
        if len(mesmo_time) == 1:
            return mesmo_time[0]
    return None


def add(agg, nome, equipe, campo, valor, jogo_id, minuto=""):
    if not nome:
        return
    nome = limpar_nome(nome)
    if not nome or nome in ("Own Goal", "Penalty Shootout") or nome_eh_marcador_tecnico(nome):
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
    minuto_key = normalizar_minuto(minuto)
    lance_key = f"{jogo_id}|{campo}|{minuto_key}|{norm(nome)}|{equipe}"
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
        r"^\s*([^\.]+?)\s+\((?:[^)]*)\)\s*(?:right|left|header|converts|converted|scores|scored|penalty|penalti|pênalti|marca|finalização)",
        r"(?:Penalty|Penalti|Pênalti)\s+(?:Goal|Scored|Convertido|Marcado).*?(?:by|de)\s+([^\.]+?)\s*\((?:[^)]*)\)",
    ]
    for pat in patterns:
        m = re.search(pat, txt, flags=re.I)
        if m:
            p = limpar_nome(m.group(1))
            if p and len(p) <= 60 and not nome_eh_marcador_tecnico(p):
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
            if p and len(p) <= 60 and not nome_eh_marcador_tecnico(p):
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
            if p and len(p) <= 60 and not nome_eh_marcador_tecnico(p):
                return p
    return None


def extract_scoring_plays(summary, jogo_id, agg, gols_oficiais_evento=None):
    plays = []
    for path in (("scoringPlays",), ("competitions", 0, "scoringPlays")):
        v = get_path(summary, *path, default=[])
        if isinstance(v, list):
            plays.extend(v)

    used = 0
    gols_reais = []
    alertas = []
    chaves_usadas = set()
    gols_aceitos_por_equipe = {}

    candidatos = []
    for idx, sp in enumerate(plays):
        if not isinstance(sp, dict):
            continue
        txt = text_of(sp)
        equipe = team_from_obj(sp) or team_from_text(txt)
        minuto = minute_from_obj(sp)
        scorer = player_from_obj(sp) or goal_scorer_from_text(txt)
        candidatos.append({
            "idx": idx,
            "sp": sp,
            "txt": txt,
            "equipe": equipe,
            "minuto": minuto,
            "scorer": scorer,
            "shootout": evento_e_disputa_penaltis(sp, txt),
            "own_goal": texto_indica_gol_contra(txt),
        })

    candidatos.sort(key=lambda c: ordem_lance_para_gol(c["sp"], c["idx"]))

    for c in candidatos:
        sp = c["sp"]
        txt = c["txt"]
        equipe = c["equipe"]
        minuto = c["minuto"]
        scorer = c["scorer"]

        # Disputa de pênaltis pós-jogo não entra em artilharia.
        # Gol de pênalti durante a partida segue contando normalmente.
        if c["shootout"]:
            continue

        # Limita o número de gols individuais/own goals ao placar oficial daquele time no jogo.
        # Isso evita que cobranças de pênaltis pós-jogo, caso venham mal marcadas no feed,
        # inflem a artilharia mesmo quando o texto não traz "shootout" claramente.
        if not pode_consumir_gol_oficial(equipe, gols_aceitos_por_equipe, gols_oficiais_evento):
            alertas.append({
                "tipo": "gol_individual_excedeu_placar_do_jogo",
                "event": str(jogo_id),
                "equipe": equipe,
                "minuto": str(minuto or ""),
                "jogador": scorer or "",
                "acao": "lance_ignorado_para_nao_inflar_artilharia",
            })
            continue

        # Gol contra conta no placar oficial da seleção beneficiada, mas não vira artilharia.
        if c["own_goal"]:
            consumir_gol_oficial(equipe, gols_aceitos_por_equipe)
            used += 1
            ck = chave_gol(equipe, minuto)
            if ck not in chaves_usadas:
                gols_reais.append({"equipe": equipe, "minuto": minuto, "scorer": "Gol contra"})
                chaves_usadas.add(ck)
            continue

        if scorer:
            add(agg, scorer, equipe, "gols", 1, jogo_id, minuto)
            consumir_gol_oficial(equipe, gols_aceitos_por_equipe)
            used += 1
            ck = chave_gol(equipe, minuto)
            if ck not in chaves_usadas:
                gols_reais.append({"equipe": equipe, "minuto": minuto, "scorer": scorer})
                chaves_usadas.add(ck)

            # Assistência pode vir estruturada ou no texto, mas apenas dentro de gol aceito.
            ast = None
            for key in ("assist", "assistedBy"):
                ast = player_name_from_athlete(sp.get(key)) if isinstance(sp, dict) else None
                if ast:
                    break
            if not ast:
                ast = assist_from_text(txt)
            if ast:
                add(agg, ast, equipe, "assistencias", 1, jogo_id, minuto)

    return used, gols_reais, alertas


def extract_commentary(summary, jogo_id, agg, skip_goals_if_scoringplays=True, gols_reais=None, gols_oficiais_evento=None):
    commentary = summary.get("commentary") or summary.get("plays") or []
    if isinstance(commentary, dict):
        commentary = commentary.get("items") or commentary.get("plays") or []
    if not isinstance(commentary, list):
        return []

    gols_commentary = []
    gols_aceitos_por_equipe = {}

    eventos_ordenados = []
    for idx, ev in enumerate(commentary):
        if isinstance(ev, dict):
            eventos_ordenados.append((ordem_lance_para_gol(ev, idx), idx, ev))
    eventos_ordenados.sort(key=lambda x: x[0])

    for _, _, ev in eventos_ordenados:
        txt = text_of(ev)
        raw = (type_text(ev) + " " + txt).lower()
        minuto = minute_from_obj(ev)
        equipe = team_from_obj(ev) or team_from_text(txt)
        is_shootout = evento_e_disputa_penaltis(ev, txt)

        # Importante: não usa mais `"goal" in raw`. Isso pegava "shot on goal",
        # "saved ... goal", "goal kick" etc. e inflava assistências falsas.
        is_goal = False if is_shootout else evento_e_gol_real(ev, txt)
        is_yellow = "yellow card" in raw or "cartão amarelo" in raw or "cartao amarelo" in raw
        is_red = "red card" in raw or "cartão vermelho" in raw or "cartao vermelho" in raw

        if is_goal and not skip_goals_if_scoringplays:
            if not pode_consumir_gol_oficial(equipe, gols_aceitos_por_equipe, gols_oficiais_evento):
                continue
            if texto_indica_gol_contra(txt):
                consumir_gol_oficial(equipe, gols_aceitos_por_equipe)
                gols_commentary.append({"equipe": equipe, "minuto": minuto, "scorer": "Gol contra"})
                continue
            scorer = player_from_obj(ev) or goal_scorer_from_text(txt)
            if scorer:
                add(agg, scorer, equipe, "gols", 1, jogo_id, minuto)
                consumir_gol_oficial(equipe, gols_aceitos_por_equipe)
                gols_commentary.append({"equipe": equipe, "minuto": minuto, "scorer": scorer})
            ast = assist_from_text(txt)
            if ast and scorer:
                add(agg, ast, equipe, "assistencias", 1, jogo_id, minuto)
        elif is_goal:
            # Mesmo que o gol já tenha vindo de scoringPlays, a assistência às vezes
            # só vem no commentary. Agora ela só é aceita se bater com um gol real.
            gol_real = match_gol_real(gols_reais or [], equipe, minuto)
            ast = assist_from_text(txt)
            if ast and gol_real:
                add(agg, ast, gol_real.get("equipe") or equipe, "assistencias", 1, jogo_id, gol_real.get("minuto") or minuto)

        if is_yellow or is_red:
            p = player_from_obj(ev) or card_player_from_text(txt)
            if p:
                if is_yellow:
                    add(agg, p, equipe, "amarelos", 1, jogo_id, minuto)
                if is_red:
                    add(agg, p, equipe, "vermelhos", 1, jogo_id, minuto)
    return gols_commentary

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

    # Ranking de gols por seleção: usa o placar oficial/momentâneo do jogo,
    # portanto inclui gol contra para a seleção beneficiada e evita depender
    # somente da atribuição individual do artilheiro.
    por_sel_placar = {}
    for ev in processaveis:
        comp = get_path(ev, "competitions", 0, default={}) or {}
        for c in comp.get("competitors") or []:
            equipe = team_from_competitor(c)
            if not equipe:
                continue
            r = por_sel_placar.setdefault(equipe, {
                "equipe": equipe,
                "gols": 0,
                "assistencias": 0,
                "amarelos": 0,
                "vermelhos": 0,
                "jogos": 0,
            })
            r["gols"] += score_int(c.get("score"))
            r["jogos"] += 1

    agg = {}
    falhas = []
    alertas_lances = []
    for ev in processaveis:
        eid = ev.get("id")
        if not eid:
            continue
        try:
            summary = http_get_json(f"{SUMMARY}?event={eid}")
        except Exception as e:
            falhas.append({"event": eid, "erro": str(e)[:140]})
            continue
        comp = get_path(ev, "competitions", 0, default={}) or {}
        gols_oficiais_evento = {}
        for c in comp.get("competitors") or []:
            equipe = team_from_competitor(c)
            if equipe:
                gols_oficiais_evento[equipe] = score_int(c.get("score"))

        qtd_gols_sp, gols_reais, alertas_jogo = extract_scoring_plays(summary, eid, agg, gols_oficiais_evento=gols_oficiais_evento)
        extract_commentary(
            summary,
            eid,
            agg,
            skip_goals_if_scoringplays=(qtd_gols_sp > 0),
            gols_reais=gols_reais,
            gols_oficiais_evento=gols_oficiais_evento,
        )
        alertas_lances.extend(alertas_jogo[:10])

    jogadores = []
    for rec in agg.values():
        jogos = sorted(rec.pop("jogos", set()))
        rec.pop("lances", None)
        rec["jogos"] = jogos
        rec["total_cartoes"] = rec.get("amarelos", 0) + rec.get("vermelhos", 0)
        jogadores.append(rec)

    alertas_consistencia = list(alertas_lances[:30])

    # Trava final de sanidade: em futebol, uma seleção não pode ter mais
    # assistências do que gols marcados. Se a ESPN/API mudar o texto e o parser
    # voltar a produzir falso positivo, não publica estatística impossível.
    gols_por_equipe = {e: r.get("gols", 0) for e, r in por_sel_placar.items()}
    assist_por_equipe = {}
    for x in jogadores:
        e = x.get("equipe") or ""
        if not e:
            continue
        assist_por_equipe[e] = assist_por_equipe.get(e, 0) + x.get("assistencias", 0)
    equipes_assist_invalidas = {
        e for e, total in assist_por_equipe.items()
        if total > (gols_por_equipe.get(e, 0) or 0)
    }
    if equipes_assist_invalidas:
        for e in sorted(equipes_assist_invalidas):
            alertas_consistencia.append({
                "tipo": "assistencias_maiores_que_gols",
                "equipe": e,
                "gols": gols_por_equipe.get(e, 0) or 0,
                "assistencias_descartadas": assist_por_equipe.get(e, 0) or 0,
                "acao": "assistencias_da_equipe_descartadas_para_nao_publicar_dado_impossivel",
            })
        for x in jogadores:
            if x.get("equipe") in equipes_assist_invalidas:
                x["assistencias"] = 0

    # Trava equivalente para artilharia: a soma dos gols dos jogadores de uma
    # seleção jamais pode ultrapassar o placar oficial agregado da seleção.
    # Diferença para menos é aceita, pois pode representar gol contra a favor.
    gols_jogadores_por_equipe = {}
    for x in jogadores:
        e = x.get("equipe") or ""
        if not e:
            continue
        gols_jogadores_por_equipe[e] = gols_jogadores_por_equipe.get(e, 0) + x.get("gols", 0)
    equipes_gols_invalidas = {
        e for e, total in gols_jogadores_por_equipe.items()
        if total > (gols_por_equipe.get(e, 0) or 0)
    }
    if equipes_gols_invalidas:
        for e in sorted(equipes_gols_invalidas):
            alertas_consistencia.append({
                "tipo": "artilharia_maior_que_gols_da_selecao",
                "equipe": e,
                "gols_selecao": gols_por_equipe.get(e, 0) or 0,
                "gols_individuais_descartados": gols_jogadores_por_equipe.get(e, 0) or 0,
                "acao": "gols_individuais_da_equipe_descartados_para_nao_publicar_dado_impossivel",
            })
        for x in jogadores:
            if x.get("equipe") in equipes_gols_invalidas:
                x["gols"] = 0

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

    # Consolida por seleção. Os gols vêm do placar oficial/momentâneo, e não
    # apenas da soma dos artilheiros, para incluir gols contra corretamente.
    por_sel = por_sel_placar
    for x in jogadores:
        e = x.get("equipe") or ""
        if not e:
            continue
        r = por_sel.setdefault(e, {"equipe": e, "gols": 0, "assistencias": 0, "amarelos": 0, "vermelhos": 0, "jogos": 0})
        r["assistencias"] += x.get("assistencias", 0)
        r["amarelos"] += x.get("amarelos", 0)
        r["vermelhos"] += x.get("vermelhos", 0)

    for r in por_sel.values():
        jogos = r.get("jogos", 0) or 0
        r["media_gols"] = round((r.get("gols", 0) / jogos), 2) if jogos else 0

    return {
        "_comentario": "Estatísticas consolidadas automaticamente a partir do feed ESPN/API. Assistências só são publicadas quando vinculadas a lance de gol real; cobranças de disputa de pênaltis pós-jogo não entram na artilharia; gols por seleção usam o placar oficial/momentâneo e incluem gols contra.",
        "fonte": "ESPN API pública/oculta usada pelo site.api.espn.com",
        "atualizado_em": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "periodo": DATES,
        "jogos_encontrados": len(eventos),
        "jogos_processados": len(processaveis),
        "falhas_summary": falhas[:20],
        "alertas_consistencia": alertas_consistencia[:50],
        "artilheiros": artilheiros,
        "assistencias": assistencias,
        "cartoes": cartoes,
        "por_selecao": sorted(por_sel.values(), key=lambda x: (-x.get("gols", 0), -x.get("media_gols", 0), x.get("equipe", ""))),
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
            "alertas_consistencia": [],
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
