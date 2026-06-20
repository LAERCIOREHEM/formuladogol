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

def buscar_no_canal_caze(termo, api_key, max_results=10):
    """Busca vídeos de 'melhores momentos' DENTRO do canal da CazéTV.
    Mantém o padrão (só pega vídeo da Cazé). Retorna lista de {titulo, videoId}."""
    base = "https://www.googleapis.com/youtube/v3/search"
    params = {
        "part": "snippet", "channelId": CAZE_CHANNEL_ID,
        "q": termo, "type": "video", "maxResults": str(max_results),
        "order": "date", "key": api_key
    }
    try:
        data = yt_get(base + "?" + urllib.parse.urlencode(params))
    except Exception as e:
        print("  busca no canal falhou:", e)
        return []
    out = []
    for it in data.get("items", []):
        sn = it.get("snippet", {})
        vid = (it.get("id") or {}).get("videoId")
        tit = sn.get("title", "")
        # confirma que é do canal da Cazé (a API já filtra, mas garantimos)
        if vid and tit and sn.get("channelId") == CAZE_CHANNEL_ID:
            out.append({"titulo": tit, "videoId": vid})
    return out

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

    # --- ETAPA 2: busca no CANAL da Cazé (pega jogos que NÃO entraram na playlist) ---
    # A Cazé às vezes não adiciona o vídeo na playlist oficial (ex.: EUA x Austrália).
    # Então procuramos direto no canal dela, mantendo o padrão (só vídeo da Cazé).
    print("Buscando melhores momentos direto no canal da CazéTV...")
    termos = ["melhores momentos copa do mundo", "melhores momentos copa 2026"]
    vistos = set(v["videoId"] for v in videos)
    extra = []
    for termo in termos:
        for v in buscar_no_canal_caze(termo, API_KEY, max_results=25):
            if v["videoId"] not in vistos:
                vistos.add(v["videoId"])
                extra.append(v)
    print(f"  vídeos extras encontrados no canal: {len(extra)}")
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
        print(f"  + (canal) {chave}: {v['titulo'][:55]}")

    atual["jogos"] = jogos
    json.dump(atual, open(SAIDA, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"OK. Preenchidos/atualizados (auto): {novos}. Títulos não reconhecidos: {ignorados}. Total no arquivo: {len(jogos)}.")

if __name__ == "__main__":
    main()
