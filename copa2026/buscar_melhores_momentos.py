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
    # tenta casar os apelidos do mais longo pro mais curto (evita 'CONGO' casar antes de 'RD CONGO')
    for ape in sorted(APELIDOS, key=len, reverse=True):
        if ape in t:
            return APELIDOS[ape]
    return None

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
    a = id_do_time(m.group(1))
    b = id_do_time(m.group(2))
    return a, b

def yt_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "bolao-copa/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))

CAZE_CHANNEL_ID = "UCZiYbVptd3PVPf4f6eR6UaQ"  # canal oficial da CazéTV
# A "uploads playlist" de um canal lista TODOS os vídeos em ordem cronológica.
# Para qualquer canal UC..., a playlist de uploads é UU... (troca UC por UU).
CAZE_UPLOADS_ID = "UU" + CAZE_CHANNEL_ID[2:]

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

def parse_live(titulo):
    """De 'AO VIVO: ESPANHA X ARÁBIA SAUDITA | COPA DO MUNDO...' extrai (idA, idB).
    Diferente de parse_titulo (que espera placar N x N), aqui é só 'TIME x TIME'."""
    t = titulo
    # remove rótulos de transmissão ao vivo
    t = re.sub(r"(?i)ao\s+vivo\s*[:|]?", " ", t)
    t = re.sub(r"(?i)\blive\b\s*[:|]?", " ", t)
    # pega só o trecho antes da primeira barra (onde estão os times)
    antes_barra = t.split("|")[0]
    # casa "TIME x TIME" (sem exigir placar)
    m = re.search(r"(.+?)\s+[xX]\s+(.+)", antes_barra)
    if not m:
        return None, None
    a = id_do_time(m.group(1))
    b = id_do_time(m.group(2))
    return a, b

def buscar_lives_caze(api_key, event_type):
    """Lista as transmissões do canal da Cazé por tipo: 'upcoming' (agendadas) ou 'live' (no ar).
    Retorna lista de {titulo, videoId}. Pagina até pegar todas (até 200)."""
    base = "https://www.googleapis.com/youtube/v3/search"
    itens, token, p = [], "", 0
    while p < 4:
        params = {
            "part": "snippet", "channelId": CAZE_CHANNEL_ID,
            "eventType": event_type, "type": "video",
            "maxResults": "50", "order": "date", "key": api_key
        }
        if token:
            params["pageToken"] = token
        try:
            data = yt_get(base + "?" + urllib.parse.urlencode(params))
        except Exception as e:
            print(f"  busca de lives ({event_type}) falhou:", e)
            break
        for it in data.get("items", []):
            sn = it.get("snippet", {})
            vid = (it.get("id") or {}).get("videoId")
            tit = sn.get("title", "")
            if vid and tit and sn.get("channelId") == CAZE_CHANNEL_ID:
                itens.append({"titulo": tit, "videoId": vid})
        token = data.get("nextPageToken", "")
        p += 1
        if not token:
            break
    return itens

def atualizar_lives(api_key):
    """Busca lives agendadas + ao vivo da Cazé, casa com os jogos pelo título,
    e grava dados/lives.json = { "ESP-KSA": {url, titulo, estado}, ... }.
    'estado' = 'live' (no ar) tem prioridade sobre 'upcoming' (agendada)."""
    # carrega o atual (preserva correções manuais 'admin')
    try:
        atual = json.load(open(SAIDA_LIVES, encoding="utf-8"))
    except Exception:
        atual = {"_comentario": "Lives da CazéTV por jogo. Chave = siglas em ordem alfabética. "
                 "Valor = {url, titulo, estado, fonte}. 'admin' nunca é sobrescrito pelo robô.", "jogos": {}}
    jogos = atual.get("jogos", {})

    # busca as duas categorias: live (no ar) e upcoming (agendadas)
    no_ar = buscar_lives_caze(api_key, "live")
    agendadas = buscar_lives_caze(api_key, "upcoming")
    print(f"Lives no ar: {len(no_ar)} | agendadas: {len(agendadas)}")

    # processa: 'upcoming' primeiro, 'live' depois (live sobrescreve, é o estado mais atual)
    def processar(lista, estado):
        n = 0
        for v in lista:
            a, b = parse_live(v["titulo"])
            if not a or not b:
                continue
            chave = "-".join(sorted([a, b]))
            # respeita correção manual
            if jogos.get(chave, {}).get("fonte") == "admin":
                continue
            # 'live' sempre atualiza; 'upcoming' só preenche se ainda não houver um 'live'
            if estado == "upcoming" and jogos.get(chave, {}).get("estado") == "live":
                continue
            jogos[chave] = {
                "url": "https://www.youtube.com/watch?v=" + v["videoId"],
                "titulo": v["titulo"].split("|")[0].strip(),
                "estado": estado,
                "fonte": "auto"
            }
            n += 1
        return n

    n1 = processar(agendadas, "upcoming")
    n2 = processar(no_ar, "live")
    atual["jogos"] = jogos
    json.dump(atual, open(SAIDA_LIVES, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"Lives gravadas: {n1} agendadas + {n2} no ar. Total no arquivo: {len(jogos)}.")

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
    for v in videos:
        # só nos interessam os de "melhores momentos"
        if "MELHORES MOMENTOS" not in norm(v["titulo"]):
            continue
        a, b = parse_titulo(v["titulo"])
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
    for v in extra:
        if "MELHORES MOMENTOS" not in norm(v["titulo"]):
            continue
        a, b = parse_titulo(v["titulo"])
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
        print(f"  + (uploads) {chave}: {v['titulo'][:55]}")

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
