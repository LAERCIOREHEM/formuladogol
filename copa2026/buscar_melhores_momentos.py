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
    # tenta casar os apelidos do mais longo pro mais curto (evita 'CONGO' casar antes de 'RD CONGO').
    # O casamento por palavra evita falsos positivos com apelidos curtos (ex.: IRA dentro de IRAQUE).
    for ape in sorted(APELIDOS, key=len, reverse=True):
        if re.search(r"(^| )" + re.escape(ape) + r"($| )", t):
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
    a = id_do_time(m.group(1))
    b = id_do_time(m.group(2))
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
    return id_do_time(m.group(1)), id_do_time(m.group(2))


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

    # 3) descobre quais estão AO VIVO agora (liveBroadcastContent)
    estados = estado_dos_videos(api_key, [c["videoId"] for c in candidatos])
    prioridade = {"live": 3, "upcoming": 2, "none": 1}

    # 4) para cada jogo, escolhe o melhor vídeo (live > upcoming > jogo completo).
    #    Se houver mais de um vídeo do mesmo confronto, fica com o de maior prioridade
    #    e, em empate, o mais recente (uploads já vêm do mais novo pro mais antigo).
    melhor = {}  # chave -> {videoId, estado, titulo, prio}
    for c in candidatos:
        chave = "-".join(sorted([c["a"], c["b"]]))
        est = estados.get(c["videoId"], "none")
        prio = prioridade.get(est, 1)
        if chave not in melhor or prio > melhor[chave]["prio"]:
            melhor[chave] = {"videoId": c["videoId"], "estado": est, "titulo": c["titulo"], "prio": prio}

    # 5) grava (respeitando correções manuais 'admin')
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
