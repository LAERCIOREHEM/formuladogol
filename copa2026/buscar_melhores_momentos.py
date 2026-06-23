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


def parse_jogo_live_ou_generico(titulo):
    a, b = parse_jogo_live(titulo)
    if a and b:
        return a, b
    return parse_confronto_generico(titulo)


def buscar_lives_exatas_por_espn(api_key):
    """Fallback novo para AO VIVO: pega o jogo atual/próximo na ESPN e faz
    uma busca restrita ao canal da CazéTV. Assim o site grava o watch?v=... do
    confronto específico, em vez de mandar o usuário para @CazeTV/search."""
    nomes = nome_por_id()
    jogos = jogos_espn_para_buscar_live()
    if not jogos:
        return []

    achados, vistos_video = [], set()
    for j in jogos:
        na, nb = nomes.get(j["a"], j["a"]), nomes.get(j["b"], j["b"])
        consultas = [
            f"{na} x {nb} ao vivo",
            f"{nb} x {na} ao vivo",
            f"{j['a']} x {j['b']} ao vivo",
        ]
        for q in consultas:
            for v in yt_search_caze(api_key, q):
                if v["videoId"] in vistos_video:
                    continue
                a, b = parse_jogo_live_ou_generico(v["titulo"])
                if set([a, b]) != set([j["a"], j["b"]]):
                    continue
                vistos_video.add(v["videoId"])
                achados.append({
                    "a": j["a"],
                    "b": j["b"],
                    "videoId": v["videoId"],
                    "titulo": v["titulo"],
                    "estado": v.get("estado", "none"),
                    "origem": "search-exata-caze",
                })
                print(f"  + (live exata Cazé) {j['chave']}: {v['titulo'][:70]}")
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
    Estratégia (validada por diagnóstico): NÃO usa eventType=live (retorna vazio
    para a Cazé). Usa os UPLOADS recentes do canal + liveBroadcastContent para
    saber o que está ao vivo. 'live' > 'upcoming' > 'none' (jogo completo)."""
    try:
        atual = json.load(open(SAIDA_LIVES, encoding="utf-8"))
    except Exception:
        atual = {"_comentario": "Lives da CazéTV por jogo. Chave = siglas em ordem alfabética. "
                 "Valor = {url, titulo, estado, fonte}. 'admin' nunca é sobrescrito pelo robô.", "jogos": {}}
    jogos = atual.get("jogos", {})

    # 1) uploads recentes do canal (isto SEMPRE funciona — o eventType não)
    uploads = buscar_uploads_recentes(api_key, paginas=2)  # ~100 vídeos recentes
    # 2) filtra os que são JOGO (ao vivo / jogo completo) e extrai os times
    candidatos = []
    for v in uploads:
        a, b = parse_jogo_live(v["titulo"])
        if a and b:
            candidatos.append({"a": a, "b": b, "videoId": v["videoId"], "titulo": v["titulo"]})

    # 3) Fallback novo: se os uploads ainda não têm a live/sala agendada,
    # busca o confronto exato no canal oficial da CazéTV com base no jogo
    # atual/próximo do feed ESPN. Isso corrige o botão da aba AO VIVO para
    # apontar direto no watch?v=... daquele jogo.
    candidatos.extend(buscar_lives_exatas_por_espn(api_key))

    # 4) descobre quais estão AO VIVO agora (liveBroadcastContent).
    # A busca textual já traz esse campo, mas videos.list confirma/atualiza.
    estados = estado_dos_videos(api_key, [c["videoId"] for c in candidatos])
    prioridade = {"live": 3, "upcoming": 2, "none": 1}

    # 5) para cada jogo, escolhe o melhor vídeo (live > upcoming > jogo completo).
    #    Se houver mais de um vídeo do mesmo confronto, fica com o de maior prioridade
    #    e, em empate, o mais recente (uploads já vêm do mais novo pro mais antigo).
    melhor = {}  # chave -> {videoId, estado, titulo, prio}
    for c in candidatos:
        chave = "-".join(sorted([c["a"], c["b"]]))
        est = estados.get(c["videoId"], c.get("estado", "none"))
        prio = prioridade.get(est, 1)
        if chave not in melhor or prio > melhor[chave]["prio"]:
            melhor[chave] = {"videoId": c["videoId"], "estado": est, "titulo": c["titulo"], "prio": prio}

    # 6) grava (respeitando correções manuais 'admin')
    n_live = n_outros = 0
    for chave, m in melhor.items():
        if jogos.get(chave, {}).get("fonte") == "admin":
            continue
        jogos[chave] = {
            "url": "https://www.youtube.com/watch?v=" + m["videoId"],
            "titulo": m["titulo"].split("|")[0].strip(),
            "estado": m["estado"],
            "fonte": "auto"
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

    # carrega o arquivo atual (preserva correções 'admin')
    try:
        atual = json.load(open(SAIDA, encoding="utf-8"))
    except Exception:
        atual = {"_comentario": "", "jogos": {}}
    jogos = atual.get("jogos", {})

    # lê a playlist
    try:
        videos = listar_playlist(PLAYLIST_ID, API_KEY)
    except Exception as e:
        print("ERRO ao ler a playlist:", e)
        sys.exit(1)
    print(f"Vídeos na playlist: {len(videos)}")

    novos, ignorados = 0, 0

    # --- ETAPA 1: playlist oficial da CazéTV ---
    # Regra nova: se o vídeo está NA PLAYLIST oficial, ele é fortíssimo sinal de que é destaque.
    # Então tentamos casar o confronto mesmo quando o estagiário esqueceu de escrever
    # "MELHORES MOMENTOS" no título (caso Jordânia x Argélia).
    for v in videos:
        titulo_tem_mm = tem_melhores_momentos_no_titulo(v["titulo"])
        if titulo_tem_mm:
            a, b = parse_titulo(v["titulo"])
            # tolerância: se tiver "melhores momentos" mas sem placar no título, ainda tenta TIME X TIME.
            if not a or not b:
                a, b = parse_confronto_generico(v["titulo"])
        else:
            # Mesmo dentro da playlist, não usa como melhores momentos se for claramente live,
            # jogo completo, corte, gol isolado etc.
            if titulo_ruim_para_fallback_generico(v["titulo"]):
                a, b = None, None
            else:
                a, b = parse_confronto_generico(v["titulo"])

        if not a or not b:
            ignorados += 1
            print("  não casei:", v["titulo"][:70])
            continue
        chave = "-".join(sorted([a, b]))
        # respeita correção manual
        if jogos.get(chave, {}).get("fonte") == "admin":
            continue
        jogos[chave] = {
            "url": "https://youtu.be/" + v["videoId"],
            "titulo": v["titulo"].split("|")[0].strip(),
            "fonte": "auto"
        }
        novos += 1
        if not titulo_tem_mm:
            print(f"  + (playlist/confronto sem rótulo) {chave}: {v['titulo'][:60]}")

    # --- ETAPA 2: lê os UPLOADS RECENTES do canal da Cazé (determinístico) ---
    # A Cazé às vezes não adiciona o vídeo na playlist de melhores momentos (ex.: EUA x Austrália,
    # Tunísia x Japão). Em vez da busca textual (que falha), lemos os uploads recentes do canal
    # direto da playlist de uploads — pega TODO vídeo novo, inclusive os que faltaram na playlist.
    print("Lendo uploads recentes do canal da CazéTV (fallback determinístico)...")
    vistos = set(v["videoId"] for v in videos)
    extra = []
    for v in buscar_uploads_recentes(API_KEY, paginas=4):
        if v["videoId"] not in vistos:
            vistos.add(v["videoId"])
            extra.append(v)
    print(f"  uploads recentes lidos (novos): {len(extra)}")

    # ETAPA 2A: fallback antigo e seguro — só vídeos com "MELHORES MOMENTOS" no título.
    for v in extra:
        if not tem_melhores_momentos_no_titulo(v["titulo"]):
            continue
        a, b = parse_titulo(v["titulo"])
        if not a or not b:
            a, b = parse_confronto_generico(v["titulo"])
        if not a or not b:
            continue
        chave = "-".join(sorted([a, b]))
        if jogos.get(chave, {}).get("fonte") == "admin":
            continue
        # só preenche se ainda não tiver (não sobrescreve auto já existente da playlist)
        if chave in jogos and jogos[chave].get("fonte") == "auto":
            continue
        jogos[chave] = {
            "url": "https://youtu.be/" + v["videoId"],
            "titulo": v["titulo"].split("|")[0].strip(),
            "fonte": "auto"
        }
        novos += 1
        print(f"  + (uploads/melhores momentos) {chave}: {v['titulo'][:55]}")

    # ETAPA 2B: fallback novo — seleção x seleção NO CANAL DA CAZÉTV, sem depender do rótulo.
    # Aqui somos mais conservadores: não pegamos live, jogo completo, corte, gol isolado etc.
    # Só entra se ainda não existir registro do confronto.
    for v in extra:
        if tem_melhores_momentos_no_titulo(v["titulo"]):
            continue
        if titulo_ruim_para_fallback_generico(v["titulo"]):
            continue
        a, b = parse_confronto_generico(v["titulo"])
        if not a or not b:
            continue
        chave = "-".join(sorted([a, b]))
        if jogos.get(chave, {}).get("fonte") == "admin":
            continue
        if chave in jogos and jogos[chave].get("fonte") == "auto":
            continue
        jogos[chave] = {
            "url": "https://youtu.be/" + v["videoId"],
            "titulo": v["titulo"].split("|")[0].strip(),
            "fonte": "auto"
        }
        novos += 1
        print(f"  + (uploads/confronto Cazé sem rótulo) {chave}: {v['titulo'][:55]}")

    atual["jogos"] = jogos
    json.dump(atual, open(SAIDA, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"OK. Preenchidos/atualizados (auto): {novos}. Títulos não reconhecidos: {ignorados}. Total no arquivo: {len(jogos)}.")

    # --- ETAPA 3: lives da Cazé (agendadas + ao vivo) coladas em cada jogo ---
    print("\nAtualizando lives da CazéTV...")
    try:
        atualizar_lives(API_KEY)
    except Exception as e:
        print("Falha ao atualizar lives (não interrompe os melhores momentos):", e)

if __name__ == "__main__":
    main()
