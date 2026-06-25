#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
buscar_melhores_momentos.py
Lê a PLAYLIST oficial de "Melhores Momentos" da CazéTV (YouTube Data API v3),
extrai os times de cada título no padrão "MELHORES MOMENTOS: TIME N x N TIME",
casa com os jogos da Copa (selecoes.json) e grava dados/melhores-momentos.json.

REGRAS:
- NÃO sobrescreve entradas marcadas com "fonte":"admin" (correções manuais do organizador).
- Marca o que ele preenche com "fonte":"auto".
- A chave da API vem da variável de ambiente YOUTUBE_API_KEY (secret do GitHub), NUNCA do código.
- A playlist vem da variável CAZE_PLAYLIST_ID (secret ou env), com um padrão de fallback.

Uso local (teste):  YOUTUBE_API_KEY=xxxx CAZE_PLAYLIST_ID=PLxxx python3 buscar_melhores_momentos.py
"""
import os, re, json, sys, unicodedata, urllib.request, urllib.parse
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

DIR = os.path.dirname(os.path.abspath(__file__))
SELECOES = os.path.join(DIR, "dados", "selecoes.json")
SAIDA    = os.path.join(DIR, "dados", "melhores-momentos.json")
SAIDA_LIVES = os.path.join(DIR, "dados", "lives.json")

API_KEY     = os.environ.get("YOUTUBE_API_KEY", "").strip()
PLAYLIST_ID = os.environ.get("CAZE_PLAYLIST_ID", "").strip()

def norm(s):
    """maiúsculas, sem acento, sem pontuação — para casar nomes de forma robusta."""
    s = unicodedata.normalize("NFKD", s).encode("ASCII", "ignore").decode("ASCII")
    s = re.sub(r"[^A-Za-z0-9 ]", " ", s).upper()
    return re.sub(r"\s+", " ", s).strip()

# Apelidos: como a CazéTV pode escrever -> nosso id. Inclui variações comuns.
APELIDOS = {
    "MEXICO": "MEX",
    "AFRICA DO SUL": "RSA",
    "COREIA DO SUL": "KOR", "COREIA": "KOR",
    "REP TCHECA": "CZE", "REPUBLICA TCHECA": "CZE", "TCHEQUIA": "CZE",
    "CANADA": "CAN",
    "BOSNIA": "BIH", "BOSNIA E HERZEGOVINA": "BIH", "BOSNIA HERZEGOVINA": "BIH",
    "CATAR": "QAT", "QATAR": "QAT",
    "SUICA": "SUI",
    "BRASIL": "BRA",
    "MARROCOS": "MAR",
    "HAITI": "HAI",
    "ESCOCIA": "SCO",
    "EUA": "USA", "ESTADOS UNIDOS": "USA",
    "PARAGUAI": "PAR",
    "AUSTRALIA": "AUS",
    "TURQUIA": "TUR",
    "ALEMANHA": "GER",
    "CURACAO": "CUW",
    "COSTA DO MARFIM": "CIV", "MARFIM": "CIV",
    "EQUADOR": "ECU",
    "HOLANDA": "NED", "PAISES BAIXOS": "NED",
    "JAPAO": "JPN",
    "SUECIA": "SWE",
    "TUNISIA": "TUN",
    "BELGICA": "BEL",
    "EGITO": "EGY",
    "IRA": "IRN", "IRAN": "IRN",
    "NOVA ZELANDIA": "NZL",
    "ESPANHA": "ESP",
    "CABO VERDE": "CPV",
    "ARABIA SAUDITA": "KSA", "ARABIA": "KSA",
    "URUGUAI": "URU",
    "FRANCA": "FRA",
    "SENEGAL": "SEN",
    "IRAQUE": "IRQ",
    "NORUEGA": "NOR",
    "ARGENTINA": "ARG",
    "ARGELIA": "ALG",
    "AUSTRIA": "AUT",
    "JORDANIA": "JOR",
    "PORTUGAL": "POR",
    "RD CONGO": "COD", "REPUBLICA DEMOCRATICA DO CONGO": "COD", "CONGO": "COD",
    "UZBEQUISTAO": "UZB",
    "COLOMBIA": "COL",
    "INGLATERRA": "ENG",
    "CROACIA": "CRO",
    "GANA": "GHA",
    "PANAMA": "PAN",
}

def id_do_time(trecho):
    """recebe um pedaço de texto e tenta achar o id do time (casa pelo apelido mais longo)."""
    t = norm(trecho)
    # tenta casar os apelidos do mais longo pro mais curto (evita 'CONGO' casar antes de 'RD CONGO').
    # O casamento por palavra evita falsos positivos com apelidos curtos (ex.: IRA dentro de IRAQUE).
    for ape in sorted(APELIDOS, key=len, reverse=True):
        if re.search(r"(^| )" + re.escape(ape) + r"($| )", t):
            return APELIDOS[ape]
    return None

def id_do_time_parse(trecho):
    """Parser usado nos títulos. Quando o alias flexível já existe, aceita
    também nomes em inglês vindos do YouTube/ESPN; antes disso, usa o parser base."""
    flex = globals().get("id_do_time_flex")
    if flex:
        return flex(trecho)
    return id_do_time(trecho)

def parse_titulo(titulo):
    """
    De 'MELHORES MOMENTOS: ESTADOS UNIDOS 4 X 1 PARAGUAI | COPA ...'
    extrai (idA, idB). Retorna (None,None) se não casar o padrão.
    """
    t = titulo
    # remove o rótulo "MELHORES MOMENTOS" em qualquer posição (com : ou |)
    t = re.sub(r"(?i)melhores\s+momentos\s*[:|]?", " ", t)
    # acha o "N X N" no meio; o lado B vai até a próxima barra ou fim
    m = re.search(r"(.+?)\s+\d+\s*[xX]\s*\d+\s+([^|]+)", t)
    if not m:
        return None, None
    a = id_do_time_parse(m.group(1))
    b = id_do_time_parse(m.group(2))
    return a, b


def tem_melhores_momentos_no_titulo(titulo):
    return "MELHORES MOMENTOS" in norm(titulo)


def titulo_ruim_para_fallback_generico(titulo):
    """Bloqueia vídeos do canal que parecem live, jogo completo, corte ou clipe solto.
    O fallback genérico só deve entrar quando o vídeo parece ser o VT/resumo do confronto,
    mas a Cazé esqueceu de escrever 'MELHORES MOMENTOS' no título."""
    t = norm(titulo)
    termos_bloqueados = (
        "AO VIVO", "JOGO COMPLETO", "PRE JOGO", "POS JOGO", "TRANSMISSAO",
        "ASSISTA", "NARRACAO", "AQUECIMENTO", "ESQUENTA", "COLETIVA",
        "ENTREVISTA", "BASTIDORES", "REACT", "CORTE", "SHORTS", "SHORT",
        "GOL DE", "GOLACO", "PENALTI", "ESCALACAO", "TODOS OS LANCES"
    )
    return any(x in t for x in termos_bloqueados)


def parse_confronto_generico(titulo):
    """Extrai (idA, idB) de títulos no formato seleção x seleção, mesmo sem
    o texto 'MELHORES MOMENTOS' e mesmo sem placar.

    Ex.: 'JORDÂNIA 0 X 1 ARGÉLIA | COPA ...'
         'JORDÂNIA X ARGÉLIA | COPA ...'
    """
    # Se houver placar, usa primeiro o parser mais específico já existente.
    a, b = parse_titulo(titulo)
    if a and b:
        return a, b

    # Remove rótulos que podem aparecer antes do confronto e limita no primeiro '|'.
    t = re.sub(r"(?i)melhores\s+momentos\s*[:|]?", " ", titulo)
    t = re.sub(r"(?i)resumo\s*[:|]?", " ", t)
    t = t.split("|")[0]

    # Padrões aceitos: TIME X TIME, TIME 0 X 1 TIME, TIME 0x1 TIME.
    m = re.search(r"(.+?)\s+(?:\d+\s*)?[xX]\s*(?:\d+\s*)?(.+)", t)
    if not m:
        return None, None
    a = id_do_time_parse(m.group(1))
    b = id_do_time_parse(m.group(2))
    if a and b and a != b:
        return a, b
    return None, None

def yt_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "bolao-copa/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))

CAZE_CHANNEL_ID = "UCZiYbVptd3PVPf4f6eR6UaQ"  # canal oficial da CazéTV
# A "uploads playlist" de um canal lista TODOS os vídeos em ordem cronológica.
# Para qualquer canal UC..., a playlist de uploads é UU... (troca UC por UU).
CAZE_UPLOADS_ID = "UU" + CAZE_CHANNEL_ID[2:]
CAZE_STREAMS_URL = "https://www.youtube.com/@CazeTV/streams"

SCOREBOARD_API = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard"

# Alguns nomes vêm em inglês no feed da ESPN; estes aliases ajudam a converter
# para as mesmas siglas usadas no site.
APELIDOS_EN = {
    "MEXICO": "MEX",
    "SOUTH AFRICA": "RSA",
    "SOUTH KOREA": "KOR", "KOREA REPUBLIC": "KOR",
    "CZECHIA": "CZE", "CZECH REPUBLIC": "CZE",
    "CANADA": "CAN",
    "BOSNIA AND HERZEGOVINA": "BIH", "BOSNIA": "BIH",
    "QATAR": "QAT",
    "SWITZERLAND": "SUI",
    "BRAZIL": "BRA",
    "MOROCCO": "MAR",
    "HAITI": "HAI",
    "SCOTLAND": "SCO",
    "UNITED STATES": "USA", "USA": "USA",
    "PARAGUAY": "PAR",
    "AUSTRALIA": "AUS",
    "TURKEY": "TUR", "TURKIYE": "TUR",
    "GERMANY": "GER",
    "CURACAO": "CUW",
    "IVORY COAST": "CIV", "COTE D IVOIRE": "CIV",
    "ECUADOR": "ECU",
    "NETHERLANDS": "NED",
    "JAPAN": "JPN",
    "SWEDEN": "SWE",
    "TUNISIA": "TUN",
    "BELGIUM": "BEL",
    "EGYPT": "EGY",
    "IRAN": "IRN", "IR IRAN": "IRN",
    "NEW ZEALAND": "NZL",
    "SPAIN": "ESP",
    "CAPE VERDE": "CPV",
    "SAUDI ARABIA": "KSA",
    "URUGUAY": "URU",
    "FRANCE": "FRA",
    "SENEGAL": "SEN",
    "IRAQ": "IRQ",
    "NORWAY": "NOR",
    "ARGENTINA": "ARG",
    "ALGERIA": "ALG",
    "AUSTRIA": "AUT",
    "JORDAN": "JOR",
    "PORTUGAL": "POR",
    "DR CONGO": "COD", "CONGO DR": "COD", "CONGO": "COD",
    "UZBEKISTAN": "UZB",
    "COLOMBIA": "COL",
    "ENGLAND": "ENG",
    "CROATIA": "CRO",
    "GHANA": "GHA",
    "PANAMA": "PAN",
}


def agora_sp():
    try:
        return datetime.now(ZoneInfo("America/Sao_Paulo"))
    except Exception:
        return datetime.now(timezone(timedelta(hours=-3)))


def ymd_sp(offset_dias=0):
    return (agora_sp() + timedelta(days=offset_dias)).strftime("%Y%m%d")


def id_do_time_flex(trecho):
    """Versão mais ampla de id_do_time: aceita português, inglês e siglas."""
    if not trecho:
        return None
    t = norm(trecho)
    ids = set(APELIDOS.values())
    if t in ids:
        return t
    a = id_do_time(trecho)
    if a:
        return a
    for ape in sorted(APELIDOS_EN, key=len, reverse=True):
        if re.search(r"(^| )" + re.escape(ape) + r"($| )", t):
            return APELIDOS_EN[ape]
    return None


def nome_por_id():
    """Nome PT-BR oficial do nosso arquivo, usado para montar busca exata no YouTube."""
    try:
        data = json.load(open(SELECOES, encoding="utf-8"))
        return {x["id"]: x.get("nome") or x["id"] for x in data.get("selecoes", [])}
    except Exception:
        return {v: k.title() for k, v in APELIDOS.items()}


def id_time_espn(comp):
    team = (comp or {}).get("team", {}) or {}
    for campo in ("abbreviation", "displayName", "shortDisplayName", "name", "location"):
        achou = id_do_time_flex(team.get(campo))
        if achou:
            return achou
    return None


def jogos_espn_para_buscar_live():
    """Retorna confrontos do feed ESPN que estão ao vivo ou perto de começar.
    Isso evita fazer 1.128 buscas no YouTube: só consultamos a Cazé para jogos
    relevantes naquele momento."""
    url = f"{SCOREBOARD_API}?dates={ymd_sp(-1)}-{ymd_sp(4)}&limit=80"
    try:
        data = yt_get(url)
    except Exception as e:
        print("  ESPN scoreboard falhou para lives exatas:", e)
        return []

    now = datetime.now(timezone.utc)
    out, vistos = [], set()
    for ev in data.get("events", []) or []:
        comps = (ev.get("competitions") or [])
        if not comps:
            continue
        comp = comps[0]
        st = ((comp.get("status") or {}).get("type") or {}).get("state")
        dt_txt = ev.get("date") or ""
        try:
            dt = datetime.fromisoformat(dt_txt.replace("Z", "+00:00"))
            diff_min = (dt - now).total_seconds() / 60
        except Exception:
            diff_min = 999999

        # Busca live para: jogo no ar, pré-jogo perto do início, ou partida que acabou há pouco.
        if not (st == "in" or (st == "pre" and -15 <= diff_min <= 180) or (st == "post" and -240 <= diff_min <= 30)):
            continue

        cs = comp.get("competitors") or []
        if len(cs) < 2:
            continue
        a = id_time_espn(cs[0])
        b = id_time_espn(cs[1])
        if not a or not b or a == b:
            continue
        chave = "-".join(sorted([a, b]))
        if chave in vistos:
            continue
        vistos.add(chave)
        out.append({"a": a, "b": b, "chave": chave, "estado_espn": st, "data": dt_txt})
    return out



def jogos_espn_para_mapear_streams(dias_futuros=45):
    """Retorna todos os confrontos conhecidos no feed ESPN dentro de uma janela.

    Isso serve para validar a página /streams da CazéTV: se a live agendada
    cita Portugal x Uzbequistão, gravamos POR-UZB; se for mata-mata ainda com
    TBD, só será gravado quando a ESPN já trouxer os classificados reais.
    """
    url = f"{SCOREBOARD_API}?dates={ymd_sp(-1)}-{ymd_sp(dias_futuros)}&limit=400"
    try:
        data = yt_get(url)
    except Exception as e:
        print("  ESPN scoreboard falhou para mapear streams futuras:", e)
        return []

    out, vistos = [], set()
    for ev in data.get("events", []) or []:
        comps = ev.get("competitions") or []
        if not comps:
            continue
        comp = comps[0]
        cs = comp.get("competitors") or []
        if len(cs) < 2:
            continue
        a = id_time_espn(cs[0])
        b = id_time_espn(cs[1])
        if not a or not b or a == b:
            continue
        chave = "-".join(sorted([a, b]))
        if chave in vistos:
            continue
        vistos.add(chave)
        st = ((comp.get("status") or {}).get("type") or {}).get("state")
        out.append({"a": a, "b": b, "chave": chave, "estado_espn": st, "data": ev.get("date") or ""})
    return out

def yt_search_caze(api_key, query, max_results=8):
    """Busca textual restrita ao canal oficial da CazéTV e retorna vídeos."""
    base = "https://www.googleapis.com/youtube/v3/search"
    params = {
        "part": "snippet",
        "channelId": CAZE_CHANNEL_ID,
        "type": "video",
        "order": "date",
        "maxResults": str(max_results),
        "q": query,
        "key": api_key,
    }
    try:
        data = yt_get(base + "?" + urllib.parse.urlencode(params))
    except Exception as e:
        print(f"  busca Cazé falhou ({query}):", e)
        return []
    out = []
    for it in data.get("items", []) or []:
        vid = ((it.get("id") or {}).get("videoId") or "").strip()
        sn = it.get("snippet", {}) or {}
        tit = sn.get("title", "")
        if not vid or not tit:
            continue
        out.append({
            "videoId": vid,
            "titulo": tit,
            "estado": sn.get("liveBroadcastContent", "none") or "none",
        })
    return out


def yt_search_caze_evento(api_key, event_type, max_results=25):
    """Lista lives/upcoming do canal oficial da CazéTV pela Search API.
    eventType=live/upcoming é tentado primeiro porque, quando funciona, já
    entrega as transmissões certas sem depender de texto da busca."""
    base = "https://www.googleapis.com/youtube/v3/search"
    params = {
        "part": "snippet",
        "channelId": CAZE_CHANNEL_ID,
        "type": "video",
        "eventType": event_type,
        "order": "date",
        "maxResults": str(max_results),
        "key": api_key,
    }
    try:
        data = yt_get(base + "?" + urllib.parse.urlencode(params))
    except Exception as e:
        print(f"  busca Cazé eventType={event_type} falhou:", e)
        return []
    out = []
    for it in data.get("items", []) or []:
        vid = ((it.get("id") or {}).get("videoId") or "").strip()
        sn = it.get("snippet", {}) or {}
        tit = sn.get("title", "")
        if not vid or not tit:
            continue
        out.append({
            "videoId": vid,
            "titulo": tit,
            "estado": sn.get("liveBroadcastContent", event_type) or event_type,
            "origem": f"search-eventType-{event_type}",
        })
    return out


def ids_times_no_texto(trecho):
    """Retorna as siglas de seleções citadas no texto, por apelidos PT/EN.
    Usado apenas para validar live de jogo quando o título não está no padrão
    perfeito 'TIME X TIME', mas contém claramente os dois países."""
    t = norm(trecho)
    achados = []
    pares = list(APELIDOS.items()) + list(APELIDOS_EN.items())
    for ape, cod in sorted(pares, key=lambda x: len(x[0]), reverse=True):
        if re.search(r"(^| )" + re.escape(ape) + r"($| )", t) and cod not in achados:
            achados.append(cod)
    return achados


def parse_confronto_por_presenca(titulo):
    ids = ids_times_no_texto(titulo)
    if len(ids) == 2 and ids[0] != ids[1]:
        return ids[0], ids[1]
    return None, None


def titulo_ruim_para_live(titulo):
    """Bloqueia clipes/resumos/cortes. Para AO VIVO, só queremos a página de
    transmissão do jogo ou o jogo completo depois que acabou."""
    t = norm(titulo)
    termos_bloqueados = (
        "MELHORES MOMENTOS", "TODOS OS LANCES", "GOL DE", "GOLACO",
        "SHORTS", "SHORT", "ENTREVISTA", "BASTIDORES", "REACT", "CORTE",
        "COLETIVA", "ESCALACAO", "PENALTI"
    )
    return any(x in t for x in termos_bloqueados)


def parece_transmissao_de_jogo(titulo, estado="none"):
    """Aceita somente coisas com cara de transmissão do jogo.
    Importante: @CazeTV/live genérico só entra depois de resolvido para um
    videoId e validado contra o confronto."""
    t = norm(titulo)
    if titulo_ruim_para_live(titulo):
        return False
    if estado in ("live", "upcoming"):
        return True
    termos_ok = ("AO VIVO", "JOGO COMPLETO", "TRANSMISSAO", "COM IMAGENS")
    return any(x in t for x in termos_ok)


def parse_iso8601_duration_seconds(valor):
    """Converte durações ISO 8601 do YouTube (PT8M12S) para segundos.
    Retorna None quando a duração não está disponível."""
    if not valor:
        return None
    m = re.match(r"^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$", valor)
    if not m:
        return None
    dias, horas, minutos, segundos = [int(x or 0) for x in m.groups()]
    return dias * 86400 + horas * 3600 + minutos * 60 + segundos


def tem_placar_no_titulo(titulo):
    return bool(re.search(r"\b\d+\s*[xX]\s*\d+\b", titulo or ""))


def chave_confronto(a, b):
    return "-".join(sorted([a, b]))


def mapa_jogos_espn_status():
    """Mapeia confrontos da Copa no feed ESPN.

    Uso nos melhores momentos: só publicar automaticamente quando o jogo já
    estiver encerrado no scoreboard. Isso evita pegar live, pré-jogo, corte ou
    vídeo errado antes de o VT/resumo oficial realmente sair.
    """
    ano = agora_sp().year
    url = f"{SCOREBOARD_API}?dates={ano}0611-{ano}0719&limit=500"
    try:
        data = yt_get(url)
    except Exception as e:
        print("  ESPN scoreboard falhou para validar melhores momentos:", e)
        return {}
    out = {}
    for ev in data.get("events", []) or []:
        comps = ev.get("competitions") or []
        if not comps:
            continue
        comp = comps[0]
        cs = comp.get("competitors") or []
        if len(cs) < 2:
            continue
        a = id_time_espn(cs[0])
        b = id_time_espn(cs[1])
        if not a or not b or a == b:
            continue
        chave = chave_confronto(a, b)
        st_type = ((comp.get("status") or {}).get("type") or {})
        out[chave] = {
            "state": st_type.get("state") or "",
            "completed": bool(st_type.get("completed")),
            "detail": st_type.get("detail") or "",
            "data": ev.get("date") or "",
        }
    return out


def jogo_ja_encerrado_para_melhores(chave, status_jogos):
    info = status_jogos.get(chave)
    # Se o jogo está no feed, só aceita quando finalizado.
    if info:
        return info.get("state") == "post" or info.get("completed") is True
    # Se não achou o jogo no feed, não derruba vídeos antigos/fora da janela,
    # mas a validação de vídeo continua rigorosa.
    return True


def video_mm_valido(v, detalhe, chave, status_jogos, titulo_tem_mm, origem):
    """Validação única para preencher melhores-momentos.json.

    Regras principais:
    - nunca aceitar live/upcoming como melhores momentos;
    - nunca aceitar vídeo antes do jogo terminar no feed ESPN;
    - bloquear full match, pré/pós-jogo, cortes, gols isolados e shorts;
    - aceitar vídeo sem o rótulo 'MELHORES MOMENTOS' só se estiver na playlist
      oficial ou se tiver placar no título + duração curta típica de resumo.
    """
    titulo = (detalhe or {}).get("titulo") or v.get("titulo", "")
    estado = ((detalhe or {}).get("estado") or "none").lower()
    canal = (detalhe or {}).get("channelId") or ""
    dur = (detalhe or {}).get("duration_seconds")

    if estado in ("live", "upcoming"):
        print(f"  rejeitei MM ainda live/upcoming: {chave} -> {titulo[:70]}")
        return False
    if canal and canal != CAZE_CHANNEL_ID:
        print(f"  rejeitei MM fora do canal CazéTV: {chave} -> {titulo[:70]}")
        return False
    if not jogo_ja_encerrado_para_melhores(chave, status_jogos):
        print(f"  rejeitei MM antes do jogo encerrar: {chave} -> {titulo[:70]}")
        return False

    # Shorts/clipes muito curtos e jogo completo/replay longo não entram.
    if dur is not None:
        if dur < 45:
            print(f"  rejeitei MM curto demais/short: {chave} -> {titulo[:70]} ({dur}s)")
            return False
        if dur > 30 * 60:
            print(f"  rejeitei MM longo demais/full match: {chave} -> {titulo[:70]} ({dur}s)")
            return False

    if titulo_tem_mm:
        return True

    # Sem o rótulo, só aceita se NÃO parecer live/corte e tiver estrutura forte
    # de confronto com placar. Isso cobre o caso do estagiário que pôs o vídeo
    # na playlist, mas esqueceu de escrever 'MELHORES MOMENTOS'.
    if titulo_ruim_para_fallback_generico(titulo):
        return False
    if not tem_placar_no_titulo(titulo):
        return False
    if dur is None:
        return False

    # Fora da playlist oficial, seja ainda mais conservador.
    if origem != "playlist" and dur > 20 * 60:
        return False
    return True


def detalhes_videos(api_key, video_ids):
    """Retorna detalhes básicos de vídeos pelo videos.list."""
    out = {}
    base = "https://www.googleapis.com/youtube/v3/videos"
    video_ids = [v for v in dict.fromkeys(video_ids) if v]
    for i in range(0, len(video_ids), 50):
        lote = video_ids[i:i + 50]
        params = {"part": "snippet,liveStreamingDetails,contentDetails", "id": ",".join(lote), "key": api_key}
        try:
            data = yt_get(base + "?" + urllib.parse.urlencode(params))
        except Exception as e:
            print("  detalhes dos vídeos falhou:", e)
            continue
        for it in data.get("items", []) or []:
            sn = it.get("snippet", {}) or {}
            live = it.get("liveStreamingDetails", {}) or {}
            out[it["id"]] = {
                "videoId": it["id"],
                "titulo": sn.get("title", ""),
                "estado": sn.get("liveBroadcastContent", "none") or "none",
                "channelId": sn.get("channelId", ""),
                "duration": ((it.get("contentDetails") or {}).get("duration") or ""),
                "duration_seconds": parse_iso8601_duration_seconds(((it.get("contentDetails") or {}).get("duration") or "")),
                "scheduledStartTime": live.get("scheduledStartTime"),
                "actualStartTime": live.get("actualStartTime"),
                "actualEndTime": live.get("actualEndTime"),
            }
    return out


def extrair_video_ids_de_url_ou_html(final_url, html):
    ids = []
    def add(v):
        if v and re.match(r"^[A-Za-z0-9_-]{8,}$", v) and v not in ids:
            ids.append(v)
    parsed = urllib.parse.urlparse(final_url or "")
    qs = urllib.parse.parse_qs(parsed.query)
    for v in qs.get("v", []):
        add(v)
    for padrao in (
        r'"videoId"\s*:\s*"([A-Za-z0-9_-]{8,})"',
        r"watch\?v=([A-Za-z0-9_-]{8,})",
        r"/embed/([A-Za-z0-9_-]{8,})",
    ):
        for v in re.findall(padrao, html or ""):
            add(v)
    return ids


def resolver_caze_live_generico(api_key):
    """Tenta resolver https://www.youtube.com/@CazeTV/live para o videoId real.
    Só serve como candidato. A aceitação final ainda valida o título contra o
    confronto esperado; se /live estiver apontando para outro jogo, será descartado."""
    url = "https://www.youtube.com/@CazeTV/live"
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            final_url = r.geturl()
            html = r.read(350000).decode("utf-8", "ignore")
    except Exception as e:
        print("  não consegui resolver @CazeTV/live:", e)
        return None
    ids = extrair_video_ids_de_url_ou_html(final_url, html)
    if not ids:
        return None
    detalhes = detalhes_videos(api_key, ids[:8])
    # prefere o vídeo que a API diz estar live; se não houver, pega o primeiro resolvido
    ordenados = sorted(detalhes.values(), key=lambda x: 0 if x.get("estado") == "live" else 1)
    if not ordenados:
        return None
    v = ordenados[0]
    v["origem"] = "caze-live-resolvido"
    return v



def listar_caze_streams_page(api_key):
    """Varre a aba /streams do canal da CazéTV e transforma os vídeos
    encontrados em candidatos via videos.list.

    A Search API com eventType=upcoming costuma funcionar, mas a aba /streams
    é a fonte visual onde a Cazé publica as próximas lives. Usamos as duas para
    aumentar a chance de preencher lives.json ANTES do jogo começar.
    """
    req = urllib.request.Request(CAZE_STREAMS_URL, headers={
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    })
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            html = r.read(800000).decode("utf-8", "ignore")
    except Exception as e:
        print("  leitura da aba /streams da CazéTV falhou:", e)
        return []

    ids = []
    def add(v):
        if v and re.match(r"^[A-Za-z0-9_-]{8,}$", v) and v not in ids:
            ids.append(v)

    for padrao in (
        r'"videoId"\s*:\s*"([A-Za-z0-9_-]{8,})"',
        r'watch\?v=([A-Za-z0-9_-]{8,})',
        r'/watch/([A-Za-z0-9_-]{8,})',
    ):
        for v in re.findall(padrao, html):
            add(v)

    if not ids:
        return []

    detalhes = detalhes_videos(api_key, ids[:80])
    out = []
    for v in detalhes.values():
        vv = dict(v)
        vv["origem"] = "caze-streams-page"
        out.append(vv)
    return out


def buscar_lives_agendadas_por_streams(api_key):
    """Pré-mapeia lives futuras já publicadas pela CazéTV.

    Regra: varre lives/upcoming do canal e a página @CazeTV/streams; aceita só
    se o título citar exatamente as duas seleções de um jogo conhecido no feed
    da ESPN. Assim não usamos /live genérico e não pegamos transmissão errada.
    """
    agenda = {j["chave"]: j for j in jogos_espn_para_mapear_streams(dias_futuros=45)}
    if not agenda:
        return []

    candidatos = []
    candidatos.extend(yt_search_caze_evento(api_key, "live", max_results=50))
    candidatos.extend(yt_search_caze_evento(api_key, "upcoming", max_results=50))
    candidatos.extend(listar_caze_streams_page(api_key))
    candidatos = dedupe_videos(candidatos)

    detalhes = detalhes_videos(api_key, [v["videoId"] for v in candidatos])
    achados, vistos = [], set()
    for v in candidatos:
        d = detalhes.get(v["videoId"], {})
        vv = dict(v)
        if d.get("titulo"):
            vv["titulo"] = d["titulo"]
        if d.get("estado"):
            vv["estado"] = d["estado"]
        if d.get("scheduledStartTime"):
            vv["scheduledStartTime"] = d["scheduledStartTime"]
        if d.get("actualStartTime"):
            vv["actualStartTime"] = d["actualStartTime"]
        if d.get("actualEndTime"):
            vv["actualEndTime"] = d["actualEndTime"]

        estado = vv.get("estado", "none") or "none"
        # Para pré-mapeamento via /streams, só queremos lives no ar/agendadas.
        # Replays/completos continuam entrando pelo fluxo de uploads recentes.
        if estado not in ("live", "upcoming"):
            continue
        if not parece_transmissao_de_jogo(vv.get("titulo", ""), estado):
            continue

        a, b = parse_jogo_live_ou_generico(vv.get("titulo", ""))
        if not a or not b:
            a, b = parse_confronto_por_presenca(vv.get("titulo", ""))
        if not a or not b or a == b:
            continue
        chave = "-".join(sorted([a, b]))
        jogo = agenda.get(chave)
        if not jogo:
            # Evita mapear outras competições que a Cazé também pode transmitir.
            continue
        if (vv["videoId"], chave) in vistos:
            continue
        vistos.add((vv["videoId"], chave))
        achados.append({
            "a": jogo["a"],
            "b": jogo["b"],
            "videoId": vv["videoId"],
            "titulo": vv.get("titulo", ""),
            "estado": estado,
            "origem": vv.get("origem") or "caze-streams/upcoming",
            "scheduledStartTime": vv.get("scheduledStartTime"),
            "validado_confronto": True,
        })
        print(f"  + (live agendada /streams Cazé) {chave}: {vv.get('titulo','')[:75]} [{estado}]")
    return achados

def dedupe_videos(videos):
    out, vistos = [], set()
    for v in videos:
        vid = v.get("videoId")
        if not vid or vid in vistos:
            continue
        vistos.add(vid)
        out.append(v)
    return out


def aceitar_live_para_jogo(video, jogo, origem=""):
    """Validação central: só aceita o vídeo se o título contém exatamente as
    duas seleções daquele jogo, em qualquer ordem. Sem isso, não grava link."""
    titulo = video.get("titulo", "")
    estado = video.get("estado", "none") or "none"
    if not parece_transmissao_de_jogo(titulo, estado):
        return None
    a, b = parse_jogo_live_ou_generico(titulo)
    if not a or not b:
        a, b = parse_confronto_por_presenca(titulo)
    if not a or not b or set([a, b]) != set([jogo["a"], jogo["b"]]):
        return None
    return {
        "a": jogo["a"],
        "b": jogo["b"],
        "videoId": video["videoId"],
        "titulo": titulo,
        "estado": estado,
        "origem": origem or video.get("origem") or "validado-caze",
        "validado_confronto": True,
    }


def parse_jogo_live_ou_generico(titulo):
    a, b = parse_jogo_live(titulo)
    if a and b:
        return a, b
    a, b = parse_confronto_generico(titulo)
    if a and b:
        return a, b
    return parse_confronto_por_presenca(titulo)


def buscar_lives_exatas_por_espn(api_key):
    """Busca/valida transmissões exatas para a aba AO VIVO.

    Regra de ouro: NUNCA grava @CazeTV/search nem @CazeTV/live como chute.
    O link só entra se for possível validar o título do vídeo contra o jogo
    esperado (ex.: POR-UZB), aceitando mandante/visitante em qualquer ordem.
    """
    nomes = nome_por_id()
    jogos = jogos_espn_para_buscar_live()
    if not jogos:
        return []

    # Candidatos globais do canal: lives/upcoming + busca ampla por "ao vivo".
    # Eles são filtrados jogo a jogo pela validação central.
    globais = []
    globais.extend(yt_search_caze_evento(api_key, "live", max_results=25))
    globais.extend(yt_search_caze_evento(api_key, "upcoming", max_results=25))
    globais.extend(listar_caze_streams_page(api_key))
    globais.extend(yt_search_caze(api_key, "ao vivo", max_results=25))

    # Resolve o /live genérico só para descobrir o videoId real. Se esse vídeo
    # for de outro confronto, será descartado em aceitar_live_para_jogo().
    live_generica = resolver_caze_live_generico(api_key)
    if live_generica:
        globais.append(live_generica)

    globais = dedupe_videos(globais)

    achados, vistos_video_jogo = [], set()
    for j in jogos:
        na, nb = nomes.get(j["a"], j["a"]), nomes.get(j["b"], j["b"])

        candidatos_jogo = list(globais)
        consultas = [
            f"{na} x {nb} ao vivo",
            f"{nb} x {na} ao vivo",
            f"{na} {nb} ao vivo",
            f"{nb} {na} ao vivo",
            f"{na} x {nb}",
            f"{nb} x {na}",
            f"{j['a']} x {j['b']} ao vivo",
            f"{j['b']} x {j['a']} ao vivo",
        ]
        for q in consultas:
            candidatos_jogo.extend(yt_search_caze(api_key, q, max_results=12))

        # Confirma estado/título atual via videos.list antes de validar.
        candidatos_jogo = dedupe_videos(candidatos_jogo)
        detalhes = detalhes_videos(api_key, [v["videoId"] for v in candidatos_jogo])
        enriquecidos = []
        for v in candidatos_jogo:
            d = detalhes.get(v["videoId"], {})
            vv = dict(v)
            if d.get("titulo"):
                vv["titulo"] = d["titulo"]
            if d.get("estado"):
                vv["estado"] = d["estado"]
            enriquecidos.append(vv)

        for v in enriquecidos:
            aceito = aceitar_live_para_jogo(v, j, origem=v.get("origem") or "search-exata-caze")
            if not aceito:
                continue
            vk = (aceito["videoId"], j["chave"])
            if vk in vistos_video_jogo:
                continue
            vistos_video_jogo.add(vk)
            achados.append(aceito)
            print(f"  + (live validada Cazé) {j['chave']}: {aceito['titulo'][:75]} [{aceito['estado']}]")

    return achados


def buscar_uploads_recentes(api_key, paginas=4):
    """Lê os uploads MAIS RECENTES do canal da Cazé direto da playlist de uploads.
    Isso é DETERMINÍSTICO (não depende da busca textual frágil da Search API):
    pega os vídeos um a um em ordem, do mais novo pro mais antigo.
    paginas=4 -> até 200 vídeos recentes, cobre vários dias de Copa com folga."""
    itens, token, p = [], "", 0
    base = "https://www.googleapis.com/youtube/v3/playlistItems"
    while p < paginas:
        params = {"part": "snippet", "maxResults": "50", "playlistId": CAZE_UPLOADS_ID, "key": api_key}
        if token:
            params["pageToken"] = token
        try:
            data = yt_get(base + "?" + urllib.parse.urlencode(params))
        except Exception as e:
            print("  leitura dos uploads falhou:", e)
            break
        for it in data.get("items", []):
            sn = it.get("snippet", {})
            vid = sn.get("resourceId", {}).get("videoId")
            tit = sn.get("title", "")
            if vid and tit:
                itens.append({"titulo": tit, "videoId": vid})
        token = data.get("nextPageToken", "")
        p += 1
        if not token:
            break
    return itens

def listar_playlist(playlist_id, api_key):
    """retorna lista de {titulo, videoId} de toda a playlist (pagina automaticamente)."""
    itens, token = [], ""
    base = "https://www.googleapis.com/youtube/v3/playlistItems"
    while True:
        params = {
            "part": "snippet", "maxResults": "50",
            "playlistId": playlist_id, "key": api_key
        }
        if token:
            params["pageToken"] = token
        data = yt_get(base + "?" + urllib.parse.urlencode(params))
        for it in data.get("items", []):
            sn = it.get("snippet", {})
            vid = sn.get("resourceId", {}).get("videoId")
            tit = sn.get("title", "")
            if vid and tit:
                itens.append({"titulo": tit, "videoId": vid})
        token = data.get("nextPageToken", "")
        if not token:
            break
    return itens

def parse_jogo_live(titulo):
    """Extrai (idA, idB) de títulos de JOGO da Cazé:
    'AO VIVO: FRANÇA X IRAQUE |...' ou 'JOGO COMPLETO: FRANÇA X IRAQUE |...'.
    Ignora clipes ('MELHORES MOMENTOS', 'TODOS OS LANCES', narração, etc.)."""
    t = titulo
    # só considera se for marcado como jogo (ao vivo ou jogo completo)
    if not re.search(r"(?i)\b(ao\s+vivo|jogo\s+completo)\b", t):
        return None, None
    # mas NÃO é melhores momentos (que tem placar no meio)
    if re.search(r"(?i)melhores\s+momentos", t):
        return None, None
    t = re.sub(r"(?i)jogo\s+completo\s*[:|]?", " ", t)
    t = re.sub(r"(?i)ao\s+vivo\s*[:|]?", " ", t)
    antes_barra = t.split("|")[0]
    m = re.search(r"(.+?)\s+[xX]\s+(.+)", antes_barra)
    if not m:
        return None, None
    return id_do_time_parse(m.group(1)), id_do_time_parse(m.group(2))


def estado_dos_videos(api_key, video_ids):
    """Para uma lista de videoIds, retorna {videoId: 'live'|'upcoming'|'none'}
    via liveBroadcastContent. É assim que sabemos o que está NO AR agora
    (o eventType=live da Search API não é confiável para a Cazé)."""
    out = {}
    base = "https://www.googleapis.com/youtube/v3/videos"
    # a API aceita até 50 ids por chamada
    for i in range(0, len(video_ids), 50):
        lote = video_ids[i:i + 50]
        params = {"part": "snippet", "id": ",".join(lote), "key": api_key}
        try:
            data = yt_get(base + "?" + urllib.parse.urlencode(params))
        except Exception as e:
            print("  estado dos vídeos falhou:", e)
            continue
        for it in data.get("items", []):
            out[it["id"]] = (it.get("snippet", {}) or {}).get("liveBroadcastContent", "none")
    return out


def atualizar_lives(api_key):
    """Casa as transmissões de JOGO da Cazé com cada partida e grava dados/lives.json.
    Estratégia: usa uploads recentes + aba /streams + buscas restritas ao canal
    + tentativa de resolver @CazeTV/live, mas só grava link quando o vídeo é
    validado contra o confronto esperado. Prioridade: live > upcoming > none
    (jogo completo)."""
    try:
        atual = json.load(open(SAIDA_LIVES, encoding="utf-8"))
    except Exception:
        atual = {"_comentario": "Lives da CazéTV por jogo. Chave = siglas em ordem alfabética. "
                 "Valor = {url, titulo, estado, fonte}. 'admin' nunca é sobrescrito pelo robô.", "jogos": {}}
    jogos = atual.get("jogos", {})

    # Limpa fallbacks antigos não validados que possam ter ficado no JSON.
    # O front também bloqueia, mas limpar aqui evita o link errado reaparecer.
    for chave, item in list(jogos.items()):
        if item.get("fonte") == "admin":
            continue
        url = item.get("url", "")
        if "@CazeTV/search" in url or "@CazeTV/live" in url:
            print(f"  removendo fallback não validado de live: {chave} -> {url}")
            del jogos[chave]

    # 1) uploads recentes do canal (isto SEMPRE funciona — o eventType não)
    uploads = buscar_uploads_recentes(api_key, paginas=2)  # ~100 vídeos recentes
    # 2) filtra os que são JOGO (ao vivo / jogo completo) e extrai os times
    candidatos = []
    for v in uploads:
        a, b = parse_jogo_live(v["titulo"])
        if a and b:
            candidatos.append({"a": a, "b": b, "videoId": v["videoId"], "titulo": v["titulo"], "origem": "uploads-recentes", "validado_confronto": True})

    # 3) Pré-mapeia lives publicadas em @CazeTV/streams e eventType=upcoming.
    # Isso preenche lives.json ANTES do jogo começar, desde que o título da
    # live agendada cite exatamente as duas seleções do confronto.
    candidatos.extend(buscar_lives_agendadas_por_streams(api_key))

    # 4) Fallback dinâmico: se a live ainda não estava prevista em /streams,
    # busca o confronto exato no canal oficial da CazéTV com base no jogo
    # atual/próximo do feed ESPN. Útil para fases futuras assim que os
    # classificados reais aparecem no feed.
    candidatos.extend(buscar_lives_exatas_por_espn(api_key))

    # 5) descobre quais estão AO VIVO agora (liveBroadcastContent).
    # A busca textual já traz esse campo, mas videos.list confirma/atualiza.
    estados = estado_dos_videos(api_key, [c["videoId"] for c in candidatos])
    prioridade = {"live": 3, "upcoming": 2, "none": 1}

    # 6) para cada jogo, escolhe o melhor vídeo (live > upcoming > jogo completo).
    #    Se houver mais de um vídeo do mesmo confronto, fica com o de maior prioridade
    #    e, em empate, o mais recente (uploads já vêm do mais novo pro mais antigo).
    melhor = {}  # chave -> {videoId, estado, titulo, prio}
    for c in candidatos:
        chave = "-".join(sorted([c["a"], c["b"]]))
        est = estados.get(c["videoId"], c.get("estado", "none"))
        prio = prioridade.get(est, 1)
        if chave not in melhor or prio > melhor[chave]["prio"]:
            melhor[chave] = {
                "videoId": c["videoId"],
                "estado": est,
                "titulo": c["titulo"],
                "prio": prio,
                "origem": c.get("origem", "auto"),
                "scheduledStartTime": c.get("scheduledStartTime"),
                "validado_confronto": bool(c.get("validado_confronto", True)),
            }

    # 7) grava (respeitando correções manuais 'admin')
    n_live = n_outros = 0
    for chave, m in melhor.items():
        if jogos.get(chave, {}).get("fonte") == "admin":
            continue
        jogos[chave] = {
            "url": "https://www.youtube.com/watch?v=" + m["videoId"],
            "titulo": m["titulo"].split("|")[0].strip(),
            "estado": m["estado"],
            "fonte": "auto",
            "origem": m.get("origem", "auto"),
            "scheduledStartTime": m.get("scheduledStartTime"),
            "validado_confronto": True,
            "atualizado_em": agora_sp().isoformat(timespec="seconds")
        }
        if m["estado"] == "live":
            n_live += 1
        else:
            n_outros += 1

    atual["jogos"] = jogos
    json.dump(atual, open(SAIDA_LIVES, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"Lives: {n_live} ao vivo + {n_outros} (agendada/completo). Total no arquivo: {len(jogos)}.")

def main():
    if not API_KEY:
        print("ERRO: defina a variável de ambiente YOUTUBE_API_KEY (secret do GitHub).")
        sys.exit(1)
    if not PLAYLIST_ID:
        print("ERRO: defina a variável CAZE_PLAYLIST_ID com o ID da playlist de melhores momentos da CazéTV.")
        sys.exit(1)

    # carrega o arquivo atual; preserva somente correções manuais admin.
    # Entradas auto são reconstruídas a cada execução com validação rigorosa,
    # para remover links errados que tenham sido capturados por fallback antigo.
    try:
        atual = json.load(open(SAIDA, encoding="utf-8"))
    except Exception:
        atual = {"_comentario": "", "jogos": {}}
    antigos = atual.get("jogos", {}) or {}
    jogos = {k: v for k, v in antigos.items() if (v or {}).get("fonte") == "admin"}
    removidos_auto = len([1 for v in antigos.values() if (v or {}).get("fonte") == "auto"])
    if removidos_auto:
        print(f"Revalidando/remontando {removidos_auto} registros automáticos de melhores momentos.")

    status_jogos = mapa_jogos_espn_status()

    # lê a playlist oficial
    try:
        videos = listar_playlist(PLAYLIST_ID, API_KEY)
    except Exception as e:
        print("ERRO ao ler a playlist:", e)
        sys.exit(1)
    print(f"Vídeos na playlist: {len(videos)}")

    # Detalhes dos vídeos da playlist: status live/upcoming, canal e duração.
    detalhes_playlist = detalhes_videos(API_KEY, [v["videoId"] for v in videos])

    novos, ignorados = 0, 0
    validos_auto = set()

    def registrar(chave, v, detalhe, titulo_tem_mm, origem):
        nonlocal novos
        if jogos.get(chave, {}).get("fonte") == "admin":
            return False
        if not video_mm_valido(v, detalhe, chave, status_jogos, titulo_tem_mm, origem):
            return False
        titulo_final = ((detalhe or {}).get("titulo") or v.get("titulo", "")).split("|")[0].strip()
        jogos[chave] = {
            "url": "https://youtu.be/" + v["videoId"],
            "titulo": titulo_final,
            "fonte": "auto",
            "origem": origem,
            "validado_mm": True,
            "atualizado_em": agora_sp().isoformat(timespec="seconds"),
        }
        validos_auto.add(chave)
        novos += 1
        print(f"  + ({origem}) {chave}: {titulo_final[:70]}")
        return True

    # --- ETAPA 1: playlist oficial da CazéTV ---
    # Continua sendo a fonte prioritária. Mas agora só aceita vídeo finalizado,
    # curto/típico de resumo e com jogo já encerrado no feed ESPN.
    for v in videos:
        titulo = v.get("titulo", "")
        titulo_tem_mm = tem_melhores_momentos_no_titulo(titulo)
        detalhe = detalhes_playlist.get(v["videoId"], {})
        titulo_parse = detalhe.get("titulo") or titulo
        if titulo_tem_mm:
            a, b = parse_titulo(titulo_parse)
            if not a or not b:
                a, b = parse_confronto_generico(titulo_parse)
        else:
            if titulo_ruim_para_fallback_generico(titulo_parse):
                a, b = None, None
            else:
                a, b = parse_confronto_generico(titulo_parse)

        if not a or not b:
            ignorados += 1
            print("  não casei:", titulo[:70])
            continue
        chave = chave_confronto(a, b)
        registrar(chave, v, detalhe, titulo_tem_mm, "playlist")

    # --- ETAPA 2: uploads recentes do canal da CazéTV ---
    print("Lendo uploads recentes do canal da CazéTV (fallback determinístico)...")
    vistos = set(v["videoId"] for v in videos)
    extra = []
    for v in buscar_uploads_recentes(API_KEY, paginas=4):
        if v["videoId"] not in vistos:
            vistos.add(v["videoId"])
            extra.append(v)
    print(f"  uploads recentes lidos (novos): {len(extra)}")
    detalhes_extra = detalhes_videos(API_KEY, [v["videoId"] for v in extra])

    # ETAPA 2A: vídeos com 'MELHORES MOMENTOS' no título.
    for v in extra:
        titulo = (detalhes_extra.get(v["videoId"], {}) or {}).get("titulo") or v.get("titulo", "")
        if not tem_melhores_momentos_no_titulo(titulo):
            continue
        a, b = parse_titulo(titulo)
        if not a or not b:
            a, b = parse_confronto_generico(titulo)
        if not a or not b:
            continue
        chave = chave_confronto(a, b)
        # não sobrescreve auto já validado pela playlist
        if chave in validos_auto:
            continue
        registrar(chave, v, detalhes_extra.get(v["videoId"], {}), True, "uploads-melhores-momentos")

    # ETAPA 2B: fallback sem rótulo, agora MUITO mais conservador.
    # Só aceita se for vídeo curto, com placar no título, jogo já encerrado e
    # sem cara de live/corte. Isso evita aparecer 'melhores momentos' antes de sair.
    for v in extra:
        titulo = (detalhes_extra.get(v["videoId"], {}) or {}).get("titulo") or v.get("titulo", "")
        if tem_melhores_momentos_no_titulo(titulo):
            continue
        if titulo_ruim_para_fallback_generico(titulo):
            continue
        if not tem_placar_no_titulo(titulo):
            continue
        a, b = parse_confronto_generico(titulo)
        if not a or not b:
            continue
        chave = chave_confronto(a, b)
        if chave in validos_auto:
            continue
        registrar(chave, v, detalhes_extra.get(v["videoId"], {}), False, "uploads-confronto-validado")

    atual["jogos"] = jogos
    json.dump(atual, open(SAIDA, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"OK. Melhores momentos automáticos válidos: {len(validos_auto)}. Títulos não reconhecidos: {ignorados}. Total no arquivo: {len(jogos)}.")

    # --- ETAPA 3: lives da Cazé (agendadas + ao vivo) coladas em cada jogo ---
    print("\nAtualizando lives da CazéTV...")
    try:
        atualizar_lives(API_KEY)
    except Exception as e:
        print("Falha ao atualizar lives (não interrompe os melhores momentos):", e)

if __name__ == "__main__":
    main()
