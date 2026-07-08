#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
substituir_fontes_preferidas_mm.py — troca os melhores momentos do Brasileirão
para as FONTES PREFERIDAS: GE TV, CazéTV e Prime Video (nesta ordem).

COMO FUNCIONA (e por que não erra de canal):
  1) Descobre o canal ATUAL de cada vídeo vinculado (videos.list em lote,
     1 unidade a cada 50 vídeos). Quem já é GE/Cazé/Prime não é tocado.
  2) Para os demais ("outros", ex.: Corinthians TV), VARRE apenas os 3 canais:
       - GE TV: playlists por rodada (dados-br/getv-playlists.json)
       - CazéTV: playlist de uploads do canal (UU...)
       - Prime Video: playlist de uploads do canal (UU...)
     Tudo via playlistItems (1 unidade por página de 50) — ZERO search.list.
  3) Um vídeo só substitui o link se: é de um dos 3 canais (por construção),
     o título cita OS DOIS clubes do jogo e, se houver placar no título,
     o placar confere. Determinístico, sem "confiança 0.8".
  4) Quem não for encontrado nos 3 canais fica exatamente como está.
  5) Gera dados-br/relatorio-substituicao-fontes.json com a contagem
     assertiva: quantos GE, quantos Cazé, quantos Prime, quantos outros,
     antes e depois, e a lista do que foi trocado.

Custo típico de cota: ~30 a 60 unidades por execução (contra 100 por UMA
única busca do search.list). Dá pra rodar o dia inteiro sem estourar.

Uso:
  python scripts/substituir_fontes_preferidas_mm.py                 # executa
  python scripts/substituir_fontes_preferidas_mm.py --dry-run       # só mostra
  python scripts/substituir_fontes_preferidas_mm.py --selftest      # valida offline
Opções: --paginas-caze N (padrão 12) | --paginas-prime N (padrão 8)
        | --rodada-inicio N --rodada-fim N (limita o alvo)
"""

import argparse
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MM_AUTO = os.path.join(RAIZ, "dados-br", "melhores-momentos.json")
MM_MANUAL = os.path.join(RAIZ, "dados-br", "melhores-momentos-manual.json")
GETV_PLAYLISTS = os.path.join(RAIZ, "dados-br", "getv-playlists.json")
RELATORIO = os.path.join(RAIZ, "dados-br", "relatorio-substituicao-fontes.json")

API_KEY = os.environ.get("YOUTUBE_API_KEY", "").strip()
API = "https://www.googleapis.com/youtube/v3/"

# Canais preferidos (ordem = prioridade na escolha).
GE_CHANNEL_ID = "UCgCKagVhzGnZcuP9bSMgMCg"      # confirmado no getv-playlists.json do repo
CAZE_CHANNEL_ID = "UCZiYbVptd3PVPf4f6eR6UaQ"    # canal oficial CazéTV (mesmo do robô da Copa)
# O ID do Prime é resolvido em tempo de execução pelos handles abaixo (channels.list = 1 unidade).
PRIME_HANDLES = ["@primevideosportbr", "@PrimeVideoSportBR", "@primevideobr", "@primevideobrasil"]

ROTULOS = {"ge": "GE TV / YouTube", "caze": "CazéTV / YouTube", "prime": "Prime Video / YouTube"}

def agora_iso():
    return datetime.now(timezone(timedelta(hours=-3))).isoformat(timespec="seconds")

# ---------------------------------------------------------------- nomes/títulos
def norm(s):
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ASCII", "ignore").decode("ASCII")
    s = re.sub(r"[^A-Za-z0-9 ]", " ", s).upper()
    return re.sub(r"\s+", " ", s).strip()

# Apelidos que os 3 canais usam nos títulos -> nome canônico do site.
ALIASES = {
    "Atlético-MG": ["ATLETICO MG", "ATLETICO MINEIRO", "GALO"],
    "Athletico-PR": ["ATHLETICO PR", "ATHLETICO PARANAENSE", "ATHLETICO"],
    "Bahia": ["BAHIA"],
    "Botafogo": ["BOTAFOGO"],
    "Bragantino": ["BRAGANTINO", "RED BULL BRAGANTINO", "RB BRAGANTINO"],
    "Chapecoense": ["CHAPECOENSE", "CHAPE"],
    "Corinthians": ["CORINTHIANS"],
    "Coritiba": ["CORITIBA", "COXA"],
    "Cruzeiro": ["CRUZEIRO"],
    "Flamengo": ["FLAMENGO"],
    "Fluminense": ["FLUMINENSE"],
    "Grêmio": ["GREMIO"],
    "Internacional": ["INTERNACIONAL", "INTER"],
    "Mirassol": ["MIRASSOL"],
    "Palmeiras": ["PALMEIRAS"],
    "Remo": ["REMO", "CLUBE DO REMO"],
    "Santos": ["SANTOS"],
    "São Paulo": ["SAO PAULO", "TRICOLOR PAULISTA"],
    "Vasco da Gama": ["VASCO DA GAMA", "VASCO"],
    "Vitória": ["VITORIA"],
}
# lista (apelido_norm, canonico) do apelido mais longo para o mais curto
_APELIDOS = sorted(((norm(a), c) for c, lst in ALIASES.items() for a in lst),
                   key=lambda x: -len(x[0]))

def clubes_no_titulo(titulo):
    """Retorna o conjunto de clubes canônicos citados no título (casamento por palavra)."""
    t = " " + norm(titulo) + " "
    achados, usado = set(), t
    for ape, canon in _APELIDOS:
        if canon in achados:
            continue
        if re.search(r"(^| )" + re.escape(ape) + r"($| )", usado):
            achados.add(canon)
            usado = re.sub(r"(^| )" + re.escape(ape) + r"($| )", " ", usado, count=1)
    return achados

PLACAR_RE = re.compile(r"\b(\d+)\s*[xX]\s*(\d+)\b")

def placar_do_titulo(titulo):
    m = PLACAR_RE.search(norm(titulo))
    return (int(m.group(1)), int(m.group(2))) if m else None

def rodada_do_titulo(titulo):
    m = re.search(r"\b(\d{1,2})\s*(?:ª|A)?\s*RODADA\b", norm(titulo))
    return int(m.group(1)) if m else None

def titulo_parece_mm(titulo):
    t = norm(titulo)
    if any(x in t for x in ("AO VIVO", "PRE JOGO", "POS JOGO", "REACT", "PODCAST",
                            "BASTIDORES", "ENTREVISTA", "COLETIVA", "SHORTS")):
        return False
    return ("MELHORES MOMENTOS" in t) or bool(PLACAR_RE.search(t))

def video_serve_para_jogo(titulo, jogo, exigir_rodada=False):
    """Determinístico: os DOIS clubes no título; placar (se houver) confere; rodada idem."""
    clubes = clubes_no_titulo(titulo)
    if not (jogo["mandante"] in clubes and jogo["visitante"] in clubes):
        return False
    if not titulo_parece_mm(titulo):
        return False
    pt = placar_do_titulo(titulo)
    pm, pv = jogo.get("placar_mandante"), jogo.get("placar_visitante")
    if pt and pm is not None and pv is not None:
        if set(pt) != {pm, pv} and pt not in ((pm, pv), (pv, pm)):
            return False
    rt = rodada_do_titulo(titulo)
    if rt and jogo.get("rodada") and rt != jogo["rodada"]:
        return False
    if exigir_rodada and not rt:
        return False
    return True

# ---------------------------------------------------------------- YouTube API
def yt_get(recurso, **params):
    params["key"] = API_KEY
    url = API + recurso + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "bolao-brasileirao/fontes-1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))

QUOTA = {"unidades": 0}
def q(custo):
    QUOTA["unidades"] += custo

def canais_dos_videos(video_ids):
    """{videoId: channelId} em lote (videos.list, 1 unidade / 50 ids)."""
    out = {}
    ids = [v for v in video_ids if v]
    for i in range(0, len(ids), 50):
        lote = ids[i:i + 50]
        try:
            data = yt_get("videos", part="snippet", id=",".join(lote), maxResults="50")
            q(1)
        except Exception as e:
            print("  ! videos.list falhou:", e)
            continue
        for it in data.get("items", []):
            sn = it.get("snippet") or {}
            out[it["id"]] = sn.get("channelId", "")
        time.sleep(0.2)
    return out

def resolver_prime_channel_id():
    for h in PRIME_HANDLES:
        try:
            data = yt_get("channels", part="id", forHandle=h)
            q(1)
            items = data.get("items") or []
            if items:
                cid = items[0]["id"]
                print(f"  Prime Video resolvido: {h} -> {cid}")
                return cid
        except Exception:
            continue
        time.sleep(0.2)
    print("  ! não resolvi o canal do Prime Video (handles testados: %s) — sigo só com GE+Cazé" % ", ".join(PRIME_HANDLES))
    return None

def listar_playlist(playlist_id, max_paginas=10):
    """[(videoId, titulo, publishedAt)] via playlistItems (1 unidade/página)."""
    out, token = [], None
    for _ in range(max_paginas):
        params = {"part": "snippet", "playlistId": playlist_id, "maxResults": "50"}
        if token:
            params["pageToken"] = token
        try:
            data = yt_get("playlistItems", **params)
            q(1)
        except Exception as e:
            print(f"  ! playlistItems {playlist_id[:20]}… falhou:", e)
            break
        for it in data.get("items", []):
            sn = it.get("snippet") or {}
            vid = ((sn.get("resourceId") or {}).get("videoId")) or ""
            if vid:
                out.append((vid, sn.get("title", ""), sn.get("publishedAt", "")))
        token = data.get("nextPageToken")
        if not token:
            break
        time.sleep(0.2)
    return out

def uploads_de(channel_id):
    return "UU" + channel_id[2:]

# ---------------------------------------------------------------- núcleo
def carregar(caminho, padrao):
    if not os.path.exists(caminho):
        return padrao
    with open(caminho, encoding="utf-8") as f:
        return json.load(f)

def gravar(caminho, obj):
    tmp = caminho + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, caminho)

def categoria_por_canal(channel_id, prime_id):
    if channel_id == GE_CHANNEL_ID:
        return "ge"
    if channel_id == CAZE_CHANNEL_ID:
        return "caze"
    if prime_id and channel_id == prime_id:
        return "prime"
    return "outros"

def montar_candidatos(rodadas_alvo, paginas_caze, paginas_prime, prime_id):
    """Varre os 3 canais e devolve lista de candidatos {video_id, titulo, canal, playlist_id, published_at}."""
    cands = []

    # GE: playlists por rodada (só as rodadas que precisamos)
    getv = carregar(GETV_PLAYLISTS, {})
    for pl in getv.get("playlists", []):
        if rodadas_alvo and pl.get("rodada") not in rodadas_alvo:
            continue
        for vid, tit, pub in listar_playlist(pl["playlist_id"], max_paginas=2):
            cands.append({"video_id": vid, "titulo": tit, "canal": "ge",
                          "playlist_id": pl["playlist_id"], "published_at": pub})

    # Cazé: uploads do canal
    for vid, tit, pub in listar_playlist(uploads_de(CAZE_CHANNEL_ID), max_paginas=paginas_caze):
        cands.append({"video_id": vid, "titulo": tit, "canal": "caze",
                      "playlist_id": None, "published_at": pub})

    # Prime: uploads do canal (se resolvido)
    if prime_id:
        for vid, tit, pub in listar_playlist(uploads_de(prime_id), max_paginas=paginas_prime):
            cands.append({"video_id": vid, "titulo": tit, "canal": "prime",
                          "playlist_id": None, "published_at": pub})
    return cands

def escolher_candidato(jogo, cands):
    """Melhor candidato para o jogo, priorizando GE > Cazé > Prime; exige validação determinística."""
    ordem = {"ge": 0, "caze": 1, "prime": 2}
    aptos = [c for c in cands if video_serve_para_jogo(c["titulo"], jogo)]
    if not aptos:
        return None
    aptos.sort(key=lambda c: (ordem.get(c["canal"], 9), c.get("published_at") or ""))
    return aptos[0]

def aplicar(entrada, cand):
    entrada.update({
        "video_id": cand["video_id"],
        "titulo": cand["titulo"],
        "url": "https://www.youtube.com/watch?v=" + cand["video_id"],
        "thumbnail": f"https://i.ytimg.com/vi/{cand['video_id']}/maxresdefault.jpg",
        "playlist_id": cand.get("playlist_id"),
        "published_at": cand.get("published_at"),
        "fonte": ROTULOS[cand["canal"]],
        "confianca": 1.0,
        "motivos": ["substituição para fonte preferida (varredura de canal)",
                    "dois clubes no título", "canal verificado por channelId"],
        "substituido_em": agora_iso(),
    })

def rodar(args):
    if not API_KEY:
        print("ERRO: defina YOUTUBE_API_KEY no ambiente."); return 2
    auto = carregar(MM_AUTO, {"jogos": {}})
    manual = carregar(MM_MANUAL, {"jogos": {}})
    jga, jgm = auto.get("jogos", {}), manual.get("jogos", {})

    # visão efetiva: manual vence
    efetivos = {}
    for eid, e in jga.items():
        efetivos[eid] = ("auto", e)
    for eid, e in jgm.items():
        efetivos[eid] = ("manual", e)

    universo = {eid: e for eid, (org, e) in efetivos.items()
                if (not args.rodada_inicio or e.get("rodada", 0) >= args.rodada_inicio)
                and (not args.rodada_fim or e.get("rodada", 99) <= args.rodada_fim)}
    print(f"→ {len(universo)} jogos no universo (rodadas {args.rodada_inicio or 'todas'}–{args.rodada_fim or ''})")

    # 1) canal atual de cada vídeo
    prime_id = resolver_prime_channel_id()
    canais = canais_dos_videos([e.get("video_id") for e in universo.values()])
    antes = {"ge": 0, "caze": 0, "prime": 0, "outros": 0, "sem_video": 0}
    alvos = []
    for eid, e in universo.items():
        vid = e.get("video_id")
        if not vid:
            antes["sem_video"] += 1
            alvos.append(eid)
            continue
        cat = categoria_por_canal(canais.get(vid, ""), prime_id)
        antes[cat] += 1
        if cat == "outros":
            alvos.append(eid)
    print("ANTES:", antes, f"| alvos p/ substituição: {len(alvos)}")

    substituidos, mantidos = [], []
    if alvos:
        rodadas_alvo = {universo[eid].get("rodada") for eid in alvos if universo[eid].get("rodada")}
        cands = montar_candidatos(rodadas_alvo, args.paginas_caze, args.paginas_prime, prime_id)
        print(f"  candidatos varridos nos 3 canais: {len(cands)}")
        for eid in alvos:
            org, e = efetivos[eid]
            cand = escolher_candidato(e, cands)
            jogo_txt = f"R{e.get('rodada','?')} {e.get('mandante')} x {e.get('visitante')}"
            if not cand:
                mantidos.append({"event_id": eid, "jogo": jogo_txt,
                                 "fonte_atual": e.get("fonte") or "(sem vídeo)"})
                print(f"  = mantido (não achei nos 3 canais): {jogo_txt}")
                continue
            de = e.get("fonte") or "(sem vídeo)"
            if not args.dry_run:
                aplicar(e, cand)
            substituidos.append({"event_id": eid, "jogo": jogo_txt, "de": de,
                                 "para": ROTULOS[cand["canal"]], "video_novo": cand["video_id"],
                                 "titulo_novo": cand["titulo"], "onde": org})
            print(f"  ✓ trocado ({cand['canal'].upper()}): {jogo_txt}  [{de} → {ROTULOS[cand['canal']]}]")

    # 2) contagem DEPOIS (recalcula localmente: quem foi trocado virou preferido)
    depois = dict(antes)
    for s in substituidos:
        depois["outros"] = max(0, depois["outros"] - (0 if s["de"] == "(sem vídeo)" else 1))
        if s["de"] == "(sem vídeo)":
            depois["sem_video"] = max(0, depois["sem_video"] - 1)
        chave = [k for k, v in ROTULOS.items() if v == s["para"]][0]
        depois[chave] += 1

    rel = {
        "atualizado_em": agora_iso(),
        "politica": "Fontes preferidas: GE TV > CazéTV > Prime Video. Varredura de playlists (sem search.list). "
                    "Só substitui com os dois clubes no título e placar/rodada conferindo. Quem não é achado, permanece.",
        "quota_gasta_nesta_execucao": QUOTA["unidades"],
        "resumo_antes": antes,
        "resumo_depois": depois,
        "substituidos": substituidos,
        "mantidos_de_outros_canais": mantidos,
        "dry_run": bool(args.dry_run),
    }
    if not args.dry_run:
        auto["atualizado_em"] = agora_iso()
        gravar(MM_AUTO, auto)
        manual["atualizado_em"] = agora_iso()
        gravar(MM_MANUAL, manual)
    gravar(RELATORIO, rel)
    print(f"\n✓ FIM. Trocados: {len(substituidos)} | Mantidos (não achados nos 3): {len(mantidos)} | "
          f"Cota gasta: {QUOTA['unidades']} unidades")
    print(f"Relatório: dados-br/relatorio-substituicao-fontes.json")
    return 0

# ---------------------------------------------------------------- selftest
def selftest():
    ok = True
    def c(cond, msg):
        nonlocal ok
        print(("  ok  " if cond else "  ERRO ") + msg); ok = ok and cond

    c(clubes_no_titulo("RED BULL BRAGANTINO 1 X 0 ATLÉTICO-MG | MELHORES MOMENTOS") ==
      {"Bragantino", "Atlético-MG"}, "aliases: Red Bull Bragantino + Atlético-MG")
    c(clubes_no_titulo("INTER 2 X 2 VASCO | MELHORES MOMENTOS | 9ª RODADA") ==
      {"Internacional", "Vasco da Gama"}, "aliases: Inter + Vasco")
    c(clubes_no_titulo("ATHLETICO-PR 3 X 1 ATLETICO-MG") == {"Athletico-PR", "Atlético-MG"},
      "Athletico-PR não colide com Atlético-MG")

    jogo = {"mandante": "Corinthians", "visitante": "Atlético-MG",
            "placar_mandante": 1, "placar_visitante": 0, "rodada": 17}
    c(video_serve_para_jogo("CORINTHIANS 1 X 0 ATLÉTICO-MG | MELHORES MOMENTOS | 17ª RODADA BRASILEIRÃO 2026 | ge.globo", jogo),
      "valida título GE padrão")
    c(not video_serve_para_jogo("CORINTHIANS 2 X 0 ATLÉTICO-MG | MELHORES MOMENTOS", jogo),
      "rejeita placar errado")
    c(not video_serve_para_jogo("CORINTHIANS 1 X 0 ATLÉTICO-MG | MELHORES MOMENTOS | 16ª RODADA", jogo),
      "rejeita rodada errada")
    c(not video_serve_para_jogo("PÓS-JOGO: CORINTHIANS 1 X 0 ATLÉTICO-MG AO VIVO", jogo),
      "rejeita live/pós-jogo")
    c(not video_serve_para_jogo("CORINTHIANS 1 X 0 GALO | MELHORES MOMENTOS", {**jogo, "visitante": "Palmeiras"}),
      "rejeita quando o 2º clube não é o do jogo")

    cands = [
        {"video_id": "b", "titulo": "CORINTHIANS 1 X 0 ATLÉTICO-MG | MELHORES MOMENTOS | 17ª RODADA", "canal": "caze", "published_at": "2026-07-01"},
        {"video_id": "a", "titulo": "CORINTHIANS 1 X 0 ATLÉTICO-MG | MELHORES MOMENTOS | 17ª RODADA BRASILEIRÃO 2026 | ge.globo", "canal": "ge", "playlist_id": "PL1", "published_at": "2026-07-02"},
    ]
    esc = escolher_candidato(jogo, cands)
    c(esc and esc["canal"] == "ge", "prioridade GE > Cazé quando ambos servem")

    e = {"event_id": "x", "rodada": 17, "mandante": "Corinthians", "visitante": "Atlético-MG",
         "placar_mandante": 1, "placar_visitante": 0, "video_id": "velho", "fonte": "Corinthians TV"}
    aplicar(e, esc)
    c(e["video_id"] == "a" and e["fonte"] == "GE TV / YouTube" and e["url"].endswith("v=a") and e["confianca"] == 1.0,
      "aplicar() preserva formato e troca os campos certos")
    c(categoria_por_canal(GE_CHANNEL_ID, None) == "ge" and categoria_por_canal("UCoutro", None) == "outros",
      "categoria por channelId")
    c(uploads_de("UCZiYbVptd3PVPf4f6eR6UaQ") == "UUZiYbVptd3PVPf4f6eR6UaQ", "uploads UU do canal")
    print("\nSELFTEST:", "PASSOU ✅" if ok else "FALHOU ❌")
    return 0 if ok else 1

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="mostra o que faria; grava só o relatório")
    ap.add_argument("--paginas-caze", type=int, default=12, help="páginas de uploads da Cazé (50 vídeos/página)")
    ap.add_argument("--paginas-prime", type=int, default=8)
    ap.add_argument("--rodada-inicio", type=int, default=0)
    ap.add_argument("--rodada-fim", type=int, default=0)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    return rodar(args)

if __name__ == "__main__":
    sys.exit(main())
