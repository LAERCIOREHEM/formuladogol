#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
substituir_fontes_preferidas_mm.py

Sanitiza e atualiza os melhores momentos do Brasileirão usando SOMENTE fontes
preferidas:
  - GE TV / ge.globo / sportv / Premiere / Globoplay
  - CazéTV
  - Amazon Prime Video / Prime Video
  - UOL Esporte, apenas como fallback automático após 48 horas

Regra editorial atual:
  - canal aleatório NÃO entra no site, mesmo que o título diga "ge.globo";
  - nas primeiras 48 horas, prioriza GE/Globo, CazéTV e Prime Video;
  - depois de 48 horas sem publicação primária, aceita UOL Esporte;
  - se não achar vídeo em fonte preferida, o jogo fica SEM link;
  - a auditoria informa exatamente quais jogos seguem sem link preferido.

O script não toca em Copa 2026 e não altera layout.
"""
from __future__ import annotations

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
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

BRT = timezone(timedelta(hours=-3), name="BRT")
RAIZ = Path(__file__).resolve().parents[1]
API = "https://www.googleapis.com/youtube/v3"

MM_AUTO = RAIZ / "dados-br" / "melhores-momentos.json"
MM_MANUAL = RAIZ / "dados-br" / "melhores-momentos-manual.json"
GETV_PLAYLISTS = RAIZ / "dados-br" / "getv-playlists.json"
RELATORIO = RAIZ / "dados-br" / "relatorio-substituicao-fontes.json"
RESULTADOS = RAIZ / "resultados.json"

# Channel IDs usados como trava dura quando o vídeo vem da API.
GE_CHANNEL_ID = "UCgCKagVhzGnZcuP9bSMgMCg"
CAZE_CHANNEL_ID = "UCZiYbVptd3PVPf4f6eR6UaQ"
PRIME_HANDLES = ["@primevideosportbr", "@PrimeVideoSportBR", "@primevideobr", "@primevideobrasil"]
UOL_HANDLES = ["@uolesporte", "@UOLEsporte"]
UOL_FALLBACK_HORAS = 48

ROTULOS = {
    "ge": "GE TV / YouTube",
    "caze": "CazéTV / YouTube",
    "prime": "Prime Video / YouTube",
    "uol": "UOL Esporte / YouTube",
}
ORDEM = {"ge": 0, "caze": 1, "prime": 2, "uol": 3}

QUOTA = {"unidades": 0, "playlist_items": 0, "search": 0, "channels": 0, "videos": 0}


def agora_iso() -> str:
    return datetime.now(BRT).replace(microsecond=0).isoformat()


def norm(s: Any) -> str:
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ASCII", "ignore").decode("ASCII")
    s = re.sub(r"[^A-Za-z0-9 ]", " ", s).upper()
    return re.sub(r"\s+", " ", s).strip()


def norm_min(s: Any) -> str:
    s = str(s or "").strip().lower()
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


ALIASES = {
    "Atlético-MG": ["ATLETICO MG", "ATLETICO MINEIRO", "GALO"],
    "Athletico-PR": ["ATHLETICO PR", "ATHLETICO PARANAENSE", "ATHLETICO"],
    "Bahia": ["BAHIA"],
    "Botafogo": ["BOTAFOGO"],
    "Bragantino": ["BRAGANTINO", "RED BULL BRAGANTINO", "RB BRAGANTINO"],
    "Chapecoense": ["CHAPECOENSE", "CHAPE"],
    "Corinthians": ["CORINTHIANS", "CORINTHIANS PAULISTA"],
    "Coritiba": ["CORITIBA", "COXA"],
    "Cruzeiro": ["CRUZEIRO"],
    "Flamengo": ["FLAMENGO", "FLA"],
    "Fluminense": ["FLUMINENSE", "FLU"],
    "Grêmio": ["GREMIO"],
    "Internacional": ["INTERNACIONAL", "INTER"],
    "Mirassol": ["MIRASSOL"],
    "Palmeiras": ["PALMEIRAS"],
    "Remo": ["REMO", "CLUBE DO REMO"],
    "Santos": ["SANTOS"],
    "São Paulo": ["SAO PAULO", "SPFC", "TRICOLOR PAULISTA"],
    "Vasco da Gama": ["VASCO DA GAMA", "VASCO"],
    "Vitória": ["VITORIA"],
}
_APELIDOS = sorted(((norm(a), c) for c, lst in ALIASES.items() for a in lst), key=lambda x: -len(x[0]))
PLACAR_RE = re.compile(r"\b(\d+)\s*[xX]\s*(\d+)\b")


def carregar(path: Path, fallback: Any) -> Any:
    try:
        if not path.exists():
            return fallback
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"JSON inválido em {path}: {exc}") from exc


def gravar(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def nome_time(obj: Any) -> str:
    if isinstance(obj, dict):
        return str(obj.get("nome") or obj.get("name") or obj.get("displayName") or "")
    return str(obj or "")


def chave_texto(valor: Any) -> str:
    return norm_min(valor).replace(" ", "-")


def chave_jogo_dict(jogo: Dict[str, Any]) -> str:
    rodada = jogo.get("rodada") or ""
    mand = nome_time(jogo.get("mandante"))
    vist = nome_time(jogo.get("visitante"))
    return f"rodada-{rodada}-{chave_texto(mand)}-{chave_texto(vist)}"


def uploads_de(channel_id: str) -> str:
    # uploads playlist = UU + channel_id sem UC
    return "UU" + channel_id[2:] if channel_id.startswith("UC") else channel_id


def yt_get(resource: str, api_key: str, **params: Any) -> Dict[str, Any]:
    params = {k: v for k, v in params.items() if v not in (None, "", [])}
    params["key"] = api_key
    url = f"{API}/{resource}?" + urllib.parse.urlencode(params, doseq=True)
    req = urllib.request.Request(url, headers={"User-Agent": "bolao-brasileirao-mm-preferidos/2.0"})
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"YouTube API HTTP {exc.code} em {resource}: {body[:800]}") from exc
    if resource == "playlistItems":
        QUOTA["playlist_items"] += 1
        QUOTA["unidades"] += 1
    elif resource == "search":
        QUOTA["search"] += 1
        QUOTA["unidades"] += 100
    elif resource == "channels":
        QUOTA["channels"] += 1
        QUOTA["unidades"] += 1
    elif resource == "videos":
        QUOTA["videos"] += 1
        QUOTA["unidades"] += 1
    else:
        QUOTA["unidades"] += 1
    time.sleep(0.03)
    return data


def resolver_channel_id(api_key: str, handles: Iterable[str]) -> str:
    for h in handles:
        try:
            data = yt_get("channels", api_key, part="id,snippet", forHandle=h, maxResults=1)
        except Exception:
            continue
        items = data.get("items") or []
        if items:
            return items[0].get("id") or ""
    return ""


def resolver_prime_channel_id(api_key: str) -> str:
    return resolver_channel_id(api_key, PRIME_HANDLES)


def resolver_uol_channel_id(api_key: str) -> str:
    return resolver_channel_id(api_key, UOL_HANDLES)


def listar_playlist(api_key: str, playlist_id: str, max_paginas: int, canal: str) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    token = None
    paginas = 0
    while True:
        paginas += 1
        data = yt_get("playlistItems", api_key, part="snippet,contentDetails", playlistId=playlist_id, maxResults=50, pageToken=token)
        for item in data.get("items") or []:
            sn = item.get("snippet") or {}
            cd = item.get("contentDetails") or {}
            vid = cd.get("videoId") or (sn.get("resourceId") or {}).get("videoId")
            if not vid:
                continue
            thumbs = sn.get("thumbnails") or {}
            thumb = (thumbs.get("maxres") or thumbs.get("standard") or thumbs.get("high") or thumbs.get("medium") or thumbs.get("default") or {}).get("url")
            out.append({
                "video_id": vid,
                "titulo": sn.get("title") or "",
                "descricao": sn.get("description") or "",
                "published_at": cd.get("videoPublishedAt") or sn.get("publishedAt"),
                "thumbnail": thumb,
                "playlist_id": playlist_id if canal == "ge" else None,
                "canal": canal,
                "channel_id": sn.get("channelId"),
                "channel_title": sn.get("channelTitle") or ROTULOS.get(canal, canal),
                "metodo": "playlistItems",
            })
        token = data.get("nextPageToken")
        if not token or paginas >= max_paginas:
            break
    return out


def search_no_canal(api_key: str, channel_id: str, canal: str, query: str, max_results: int) -> List[Dict[str, Any]]:
    data = yt_get(
        "search",
        api_key,
        part="snippet",
        type="video",
        channelId=channel_id,
        q=query,
        maxResults=max_results,
        order="relevance",
        safeSearch="none",
        videoEmbeddable="true",
    )
    out: List[Dict[str, Any]] = []
    for item in data.get("items") or []:
        sn = item.get("snippet") or {}
        vid = (item.get("id") or {}).get("videoId")
        if not vid:
            continue
        thumbs = sn.get("thumbnails") or {}
        thumb = (thumbs.get("maxres") or thumbs.get("standard") or thumbs.get("high") or thumbs.get("medium") or thumbs.get("default") or {}).get("url")
        out.append({
            "video_id": vid,
            "titulo": sn.get("title") or "",
            "descricao": sn.get("description") or "",
            "published_at": sn.get("publishedAt"),
            "thumbnail": thumb,
            "playlist_id": None,
            "canal": canal,
            "channel_id": sn.get("channelId"),
            "channel_title": sn.get("channelTitle") or ROTULOS.get(canal, canal),
            "metodo": "search.list oficial por channelId",
            "query": query,
        })
    return out


def clubes_no_titulo(titulo: Any) -> set[str]:
    t = " " + norm(titulo) + " "
    achados: set[str] = set()
    usado = t
    for ape, canon in _APELIDOS:
        if canon in achados:
            continue
        if re.search(r"(^| )" + re.escape(ape) + r"($| )", usado):
            achados.add(canon)
            usado = re.sub(r"(^| )" + re.escape(ape) + r"($| )", " ", usado, count=1)
    return achados


def placar_do_titulo(titulo: Any) -> Optional[Tuple[int, int]]:
    m = PLACAR_RE.search(norm(titulo))
    if not m:
        return None
    return int(m.group(1)), int(m.group(2))


def rodada_do_titulo(titulo: Any) -> Optional[int]:
    t = norm(titulo)
    for pat in [r"\b(\d{1,2})\s*(?:A|O)?\s*RODADA\b", r"\bRODADA\s*(\d{1,2})\b"]:
        m = re.search(pat, t)
        if m:
            r = int(m.group(1))
            if 1 <= r <= 38:
                return r
    return None


def titulo_parece_mm(titulo: Any) -> bool:
    t = norm(titulo)
    bons = ["MELHORES MOMENTOS", "MELHORES MOMENTO", "HIGHLIGHTS", "LANCES", "GOLS E MELHORES"]
    return any(b in t for b in bons)


def titulo_tem_termo_ruim(titulo: Any) -> bool:
    t = norm(titulo)
    ruins = [
        "AO VIVO", "LIVE", "POS JOGO", "PRE JOGO", "COLETIVA", "ENTREVISTA", "TREINO",
        "BASTIDORES", "NOTICIAS", "PALPITE", "PROGNOSTICO", "SIMULACAO", "SIMULADOR",
        "PES 2026", "FIFA 26", "EFOOTBALL", "FOOTBALL MANAGER", "SHORTS",
    ]
    return any(r in t for r in ruins)


def data_jogo(jogo: Dict[str, Any]) -> Optional[datetime]:
    valor = jogo.get("finalizado_em") or jogo.get("data_iso")
    texto = str(valor or "").strip()
    if not texto:
        return None
    try:
        obj = datetime.fromisoformat(texto.replace("Z", "+00:00"))
        if obj.tzinfo is None:
            obj = obj.replace(tzinfo=BRT)
        return obj.astimezone(BRT)
    except ValueError:
        return None


def uol_fallback_liberado(jogo: Dict[str, Any], agora: Optional[datetime] = None) -> bool:
    inicio = data_jogo(jogo)
    if not inicio:
        return False
    ref = (agora or datetime.now(BRT)).astimezone(BRT)
    return ref - inicio >= timedelta(hours=UOL_FALLBACK_HORAS)


def video_serve_para_jogo(titulo: Any, jogo: Dict[str, Any]) -> bool:
    if titulo_tem_termo_ruim(titulo):
        return False
    if not titulo_parece_mm(titulo):
        return False
    clubs = clubes_no_titulo(titulo)
    mand = nome_time(jogo.get("mandante"))
    vist = nome_time(jogo.get("visitante"))
    if not ({mand, vist} <= clubs):
        return False
    placar = placar_do_titulo(titulo)
    if placar is not None:
        try:
            pm, pv = int(jogo.get("placar_mandante")), int(jogo.get("placar_visitante"))
            if placar != (pm, pv):
                return False
        except Exception:
            return False
    rodada_tit = rodada_do_titulo(titulo)
    if rodada_tit is not None:
        try:
            if rodada_tit != int(jogo.get("rodada") or 0):
                return False
        except Exception:
            return False
    return True


def score_candidato(cand: Dict[str, Any], jogo: Dict[str, Any]) -> int:
    score = 0
    placar = placar_do_titulo(cand.get("titulo"))
    if placar is not None:
        score += 30
    if rodada_do_titulo(cand.get("titulo")) == int(jogo.get("rodada") or 0):
        score += 20
    if "BRASILEIR" in norm(cand.get("titulo")) or "CAMPEONATO BRASILEIRO" in norm(cand.get("titulo")):
        score += 10
    if cand.get("metodo") == "playlistItems":
        score += 5
    return score


def escolher_candidato(jogo: Dict[str, Any], cands: Iterable[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    aptos = [c for c in cands if video_serve_para_jogo(c.get("titulo"), jogo)]
    if not aptos:
        return None
    aptos.sort(key=lambda c: (ORDEM.get(c.get("canal"), 99), -score_candidato(c, jogo), c.get("published_at") or ""))
    return aptos[0]


def texto_fonte(video: Dict[str, Any]) -> str:
    return norm_min(" ".join(str(video.get(k) or "") for k in ["fonte", "fonte_busca", "channel_title", "channel_id"]))


def classificar_video(video: Optional[Dict[str, Any]], prime_id: str = "", uol_id: str = "") -> str:
    if not video:
        return "sem_video"
    channel_id = str(video.get("channel_id") or "").strip()
    if channel_id == GE_CHANNEL_ID:
        return "ge"
    if channel_id == CAZE_CHANNEL_ID:
        return "caze"
    if prime_id and channel_id == prime_id:
        return "prime"
    if uol_id and channel_id == uol_id:
        return "uol"
    t = texto_fonte(video)
    if any(x in t for x in ["cazetv", "caze tv", "caze"]):
        return "caze"
    if any(x in t for x in ["amazon prime video", "prime video", "amazon"]):
        return "prime"
    if any(x in t for x in ["uol esporte", "uolesporte", "uol / youtube", "uol youtube"]):
        return "uol"
    if any(x in t for x in ["ge tv", "ge globo", "geglobo", "globoesporte", "globo esporte", "sportv", "premiere", "globoplay"]):
        return "ge"
    return "outros"


def preferido(video: Optional[Dict[str, Any]], prime_id: str = "", uol_id: str = "") -> bool:
    return classificar_video(video, prime_id, uol_id) in {"ge", "caze", "prime", "uol"}


def iter_videos(data: Dict[str, Any]) -> Iterable[Tuple[str, Dict[str, Any]]]:
    jogos = data.get("jogos") or {}
    if isinstance(jogos, dict):
        for k, v in jogos.items():
            if isinstance(v, dict):
                yield str(k), v


def indexar_videos(auto: Dict[str, Any], manual: Dict[str, Any]) -> Tuple[Dict[str, Tuple[str, str, Dict[str, Any]]], Dict[str, Tuple[str, str, Dict[str, Any]]]]:
    por_id: Dict[str, Tuple[str, str, Dict[str, Any]]] = {}
    por_chave: Dict[str, Tuple[str, str, Dict[str, Any]]] = {}
    for origem, fonte in [("auto", auto), ("manual", manual)]:
        for key, reg in iter_videos(fonte):
            event_id = str(reg.get("event_id") or key or "").strip()
            item = (origem, key, reg)
            if event_id:
                por_id[event_id] = item
            ch = str(reg.get("chave") or "").strip()
            if ch:
                por_chave[ch] = item
            if reg.get("rodada") and reg.get("mandante") and reg.get("visitante"):
                fake = {"rodada": reg.get("rodada"), "mandante": {"nome": reg.get("mandante")}, "visitante": {"nome": reg.get("visitante")}}
                por_chave[chave_jogo_dict(fake)] = item
    return por_id, por_chave


def video_do_jogo(jogo: Dict[str, Any], por_id: Dict[str, Tuple[str, str, Dict[str, Any]]], por_chave: Dict[str, Tuple[str, str, Dict[str, Any]]]) -> Optional[Tuple[str, str, Dict[str, Any]]]:
    event_id = str(jogo.get("event_id") or jogo.get("id") or "").strip()
    if event_id and event_id in por_id:
        return por_id[event_id]
    ch = chave_jogo_dict(jogo)
    return por_chave.get(ch)


def resumo_jogo(jogo: Dict[str, Any], motivo: str = "", video: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    item = {
        "event_id": str(jogo.get("event_id") or jogo.get("id") or ""),
        "rodada": jogo.get("rodada"),
        "mandante": nome_time(jogo.get("mandante")),
        "visitante": nome_time(jogo.get("visitante")),
        "placar_mandante": jogo.get("placar_mandante"),
        "placar_visitante": jogo.get("placar_visitante"),
    }
    if motivo:
        item["motivo"] = motivo
    if video:
        item.update({
            "fonte_anterior": video.get("fonte") or video.get("channel_title") or "",
            "channel_title": video.get("channel_title") or "",
            "titulo_anterior": video.get("titulo") or "",
            "url_anterior": video.get("url") or "",
        })
    return item


def montar_entrada(jogo: Dict[str, Any], cand: Dict[str, Any]) -> Dict[str, Any]:
    event_id = str(jogo.get("event_id") or jogo.get("id") or "")
    rodada = int(jogo.get("rodada") or 0)
    mand = nome_time(jogo.get("mandante"))
    vist = nome_time(jogo.get("visitante"))
    pm = jogo.get("placar_mandante")
    pv = jogo.get("placar_visitante")
    canal = cand.get("canal") or "ge"
    video_id = cand.get("video_id") or ""
    return {
        "event_id": event_id,
        "chave": event_id,
        "rodada": rodada,
        "mandante": mand,
        "visitante": vist,
        "placar_mandante": pm,
        "placar_visitante": pv,
        "video_id": video_id,
        "titulo": cand.get("titulo") or "",
        "url": f"https://www.youtube.com/watch?v={video_id}" if video_id else cand.get("url"),
        "thumbnail": cand.get("thumbnail") or (f"https://i.ytimg.com/vi/{video_id}/maxresdefault.jpg" if video_id else None),
        "playlist_id": cand.get("playlist_id"),
        "published_at": cand.get("published_at"),
        "channel_id": cand.get("channel_id"),
        "channel_title": cand.get("channel_title") or ROTULOS.get(canal, canal),
        "fonte": ROTULOS.get(canal, canal),
        "fonte_busca": cand.get("metodo") or "fonte preferida",
        "confianca": 1.0,
        "motivos": [
            "fonte preferida verificada por channelId/playlist oficial",
            "mandante e visitante no título",
            "título compatível com melhores momentos",
        ],
        "atualizado_em": agora_iso(),
    }


def consultas_para_jogo(jogo: Dict[str, Any], max_consultas: int) -> List[str]:
    mand = nome_time(jogo.get("mandante"))
    vist = nome_time(jogo.get("visitante"))
    pm = jogo.get("placar_mandante")
    pv = jogo.get("placar_visitante")
    rodada = jogo.get("rodada")
    base = [
        f'"{mand} {pm} x {pv} {vist}" "melhores momentos" "Brasileirão 2026"',
        f'"{mand} x {vist}" "melhores momentos" "Brasileirão 2026"',
        f'{mand} {vist} melhores momentos {rodada}ª rodada Brasileirão 2026',
        f'{mand} {vist} melhores momentos Campeonato Brasileiro 2026',
    ]
    vistos = set()
    out = []
    for q in base:
        qn = q.strip()
        if qn and qn not in vistos:
            out.append(qn)
            vistos.add(qn)
    return out[: max(1, max_consultas)]


def remover_chave(data: Dict[str, Any], key: str, event_id: str = "") -> bool:
    jogos = data.setdefault("jogos", {})
    removeu = False
    for k in list(jogos.keys()):
        v = jogos.get(k)
        if k == key or (event_id and str((v or {}).get("event_id") or "") == event_id):
            del jogos[k]
            removeu = True
    return removeu


def sanear_vinculos_sem_resultado(data: Dict[str, Any], jogos_resultados: List[Dict[str, Any]], origem: str) -> List[Dict[str, Any]]:
    """Remove vídeos associados a jogos que ainda não constam em Resultados.

    A aba de melhores momentos só pode receber partidas efetivamente
    encerradas. O saneamento usa event_id como chave principal e o confronto
    canônico como fallback, evitando que partidas futuras/adiadas recebam
    vídeos de jogos antigos ou de canais aleatórios com título semelhante.
    """
    ids_validos = {
        str(j.get("event_id") or j.get("id") or "").strip()
        for j in jogos_resultados
        if str(j.get("event_id") or j.get("id") or "").strip()
    }
    chaves_validas = {chave_jogo_dict(j) for j in jogos_resultados}
    jogos = data.setdefault("jogos", {})
    removidos: List[Dict[str, Any]] = []
    for key in list(jogos.keys()):
        reg = jogos.get(key) or {}
        event_id = str(reg.get("event_id") or "").strip()
        chave = str(reg.get("chave") or "").strip()
        if not chave and reg.get("rodada") and reg.get("mandante") and reg.get("visitante"):
            chave = chave_jogo_dict({
                "rodada": reg.get("rodada"),
                "mandante": {"nome": reg.get("mandante")},
                "visitante": {"nome": reg.get("visitante")},
            })
        if (event_id and event_id in ids_validos) or (chave and chave in chaves_validas):
            continue
        removidos.append({
            "origem": origem,
            "chave_arquivo": str(key),
            "event_id": event_id,
            "rodada": reg.get("rodada"),
            "mandante": reg.get("mandante"),
            "visitante": reg.get("visitante"),
            "titulo": reg.get("titulo"),
            "url": reg.get("url"),
            "motivo": "partida ainda não consta em resultados finalizados",
        })
        del jogos[key]
    return removidos


def sanear_fontes_nao_preferidas(data: Dict[str, Any], origem: str, prime_id: str = "", uol_id: str = "") -> List[Dict[str, Any]]:
    """Remove fontes não autorizadas mesmo quando existe fallback manual.

    A limpeza é feita em cada arquivo individualmente para impedir que um
    vínculo manual válido masque uma entrada automática antiga de canal
    aleatório com o mesmo event_id.
    """
    jogos = data.setdefault("jogos", {})
    removidos: List[Dict[str, Any]] = []
    for key in list(jogos.keys()):
        reg = jogos.get(key) or {}
        if preferido(reg, prime_id, uol_id):
            continue
        removidos.append({
            "origem": origem,
            "chave_arquivo": str(key),
            "event_id": str(reg.get("event_id") or ""),
            "rodada": reg.get("rodada"),
            "mandante": reg.get("mandante"),
            "visitante": reg.get("visitante"),
            "titulo": reg.get("titulo"),
            "url": reg.get("url"),
            "fonte": reg.get("fonte") or reg.get("channel_title") or "",
            "motivo": "fonte/canal fora da política editorial autorizada",
        })
        del jogos[key]
    return removidos


def calcular_resumo(jogos_resultados: List[Dict[str, Any]], auto: Dict[str, Any], manual: Dict[str, Any], prime_id: str = "", uol_id: str = "") -> Dict[str, int]:
    por_id, por_chave = indexar_videos(auto, manual)
    r = {"jogos_resultados": len(jogos_resultados), "ge": 0, "caze": 0, "prime": 0, "uol": 0, "outros": 0, "sem_video": 0, "com_fonte_preferida": 0}
    for jogo in jogos_resultados:
        item = video_do_jogo(jogo, por_id, por_chave)
        video = item[2] if item else None
        cat = classificar_video(video, prime_id, uol_id)
        if cat == "sem_video":
            r["sem_video"] += 1
        elif cat in {"ge", "caze", "prime", "uol"}:
            r[cat] += 1
            r["com_fonte_preferida"] += 1
        else:
            r["outros"] += 1
    return r


def rodar(args: argparse.Namespace) -> int:
    api_key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    youtube_ativo = bool(api_key) and not args.sem_youtube

    resultados = carregar(RESULTADOS, {"resultados": []})
    jogos_resultados = resultados.get("resultados") or []
    if not isinstance(jogos_resultados, list):
        jogos_resultados = []
    auto = carregar(MM_AUTO, {"jogos": {}})
    manual = carregar(MM_MANUAL, {"jogos": {}})
    auto.setdefault("jogos", {})
    manual.setdefault("jogos", {})
    auto_jogos_originais = json.loads(json.dumps(auto.get("jogos") or {}))
    manual_jogos_originais = json.loads(json.dumps(manual.get("jogos") or {}))

    removidos_fora_resultados = (
        sanear_vinculos_sem_resultado(auto, jogos_resultados, "automático")
        + sanear_vinculos_sem_resultado(manual, jogos_resultados, "manual")
    )

    prime_id = resolver_prime_channel_id(api_key) if youtube_ativo else ""
    uol_id = resolver_uol_channel_id(api_key) if youtube_ativo else ""
    removidos_fontes_globais = (
        sanear_fontes_nao_preferidas(auto, "automático", prime_id, uol_id)
        + sanear_fontes_nao_preferidas(manual, "manual", prime_id, uol_id)
    )

    def na_janela(j: Dict[str, Any]) -> bool:
        r = int(j.get("rodada") or 0)
        if args.rodada_inicio and r < args.rodada_inicio:
            return False
        if args.rodada_fim and r > args.rodada_fim:
            return False
        return True

    universo = [j for j in jogos_resultados if na_janela(j)]
    antes = calcular_resumo(jogos_resultados, auto, manual, prime_id, uol_id)
    antes_janela = calcular_resumo(universo, auto, manual, prime_id, uol_id)

    por_id, por_chave = indexar_videos(auto, manual)
    alvos: List[Tuple[Dict[str, Any], str, Optional[Tuple[str, str, Dict[str, Any]]]]] = []
    mantidos_preferidos: List[Dict[str, Any]] = []
    for jogo in universo:
        item = video_do_jogo(jogo, por_id, por_chave)
        video = item[2] if item else None
        cat = classificar_video(video, prime_id, uol_id)
        if cat == "sem_video":
            alvos.append((jogo, "sem_link_preferido", item))
        elif cat in {"ge", "caze", "prime", "uol"}:
            mantidos_preferidos.append(resumo_jogo(jogo, f"mantido: fonte preferida ({cat})", video))
        else:
            alvos.append((jogo, "fonte_nao_preferida_removida", item))

    rodadas_alvo = {int(j.get("rodada") or 0) for j, _, _ in alvos if j.get("rodada")}
    candidatos: List[Dict[str, Any]] = []
    erros: List[str] = []

    if youtube_ativo and alvos:
        try:
            getv = carregar(GETV_PLAYLISTS, {"playlists": []})
            for pl in getv.get("playlists") or []:
                if rodadas_alvo and int(pl.get("rodada") or 0) not in rodadas_alvo:
                    continue
                pid = pl.get("playlist_id")
                if pid:
                    candidatos.extend(listar_playlist(api_key, pid, args.paginas_getv, "ge"))
        except Exception as exc:
            erros.append(f"Falha ao varrer playlists GE: {exc}")
        try:
            candidatos.extend(listar_playlist(api_key, uploads_de(CAZE_CHANNEL_ID), args.paginas_caze, "caze"))
        except Exception as exc:
            erros.append(f"Falha ao varrer uploads CazéTV: {exc}")
        if prime_id:
            try:
                candidatos.extend(listar_playlist(api_key, uploads_de(prime_id), args.paginas_prime, "prime"))
            except Exception as exc:
                erros.append(f"Falha ao varrer uploads Prime Video: {exc}")

    substituidos: List[Dict[str, Any]] = []
    removidos: List[Dict[str, Any]] = []
    ainda_sem_link: List[Dict[str, Any]] = []
    buscas_executadas: List[Dict[str, Any]] = []

    for jogo, motivo, item in alvos:
        event_id = str(jogo.get("event_id") or jogo.get("id") or "")
        atual = item[2] if item else None
        cand = escolher_candidato(jogo, candidatos)

        # Se a varredura por playlists não achou, tenta search.list SOMENTE dentro dos canais permitidos.
        if not cand and youtube_ativo and QUOTA["search"] < args.max_search_total:
            canais = [(GE_CHANNEL_ID, "ge"), (CAZE_CHANNEL_ID, "caze")]
            if prime_id:
                canais.append((prime_id, "prime"))
            # UOL só participa do search.list depois de 48h sem fonte primária.
            # Vínculos manuais informados pelo administrador continuam válidos
            # imediatamente, pois já foram individualmente conferidos.
            if uol_id and uol_fallback_liberado(jogo):
                canais.append((uol_id, "uol"))
            for q in consultas_para_jogo(jogo, args.max_consultas_por_jogo):
                for channel_id, canal in canais:
                    if QUOTA["search"] >= args.max_search_total:
                        break
                    try:
                        achados = search_no_canal(api_key, channel_id, canal, q, args.max_results_search)
                        buscas_executadas.append({
                            "event_id": event_id,
                            "rodada": jogo.get("rodada"),
                            "jogo": f"{nome_time(jogo.get('mandante'))} x {nome_time(jogo.get('visitante'))}",
                            "canal": canal,
                            "query": q,
                            "resultados": len(achados),
                        })
                        candidatos.extend(achados)
                        cand = escolher_candidato(jogo, achados)
                        if cand:
                            break
                    except Exception as exc:
                        erros.append(f"Falha no search oficial {canal} para {event_id}: {exc}")
                if cand or QUOTA["search"] >= args.max_search_total:
                    break

        if cand:
            entrada = montar_entrada(jogo, cand)
            if not args.dry_run:
                if item:
                    origem, key, _ = item
                    remover_chave(auto, key, event_id)
                    remover_chave(manual, key, event_id)
                auto["jogos"][event_id] = entrada
            substituidos.append({
                **resumo_jogo(jogo, motivo, atual),
                "fonte_nova": entrada["fonte"],
                "channel_title_novo": entrada.get("channel_title") or "",
                "titulo_novo": entrada["titulo"],
                "url_nova": entrada["url"],
                "metodo": cand.get("metodo"),
            })
            continue

        # Sem candidato preferido: remove qualquer link ruim, ou mantém sem vídeo.
        if item and atual and not preferido(atual, prime_id, uol_id):
            if not args.dry_run:
                origem, key, _ = item
                remover_chave(auto, key, event_id)
                remover_chave(manual, key, event_id)
            removidos.append(resumo_jogo(jogo, motivo, atual))
        ainda_sem_link.append(resumo_jogo(jogo, "sem link em GE/Globo, CazéTV, Prime Video ou UOL após 48h", atual))

    if not args.dry_run:
        fonte_auto = "GE/Globo, CazéTV, Prime Video e fallback UOL Esporte / YouTube"
        politica_auto = "GE/Globo, CazéTV e Prime Video têm prioridade; após 48 horas sem publicação, UOL Esporte é aceito como fallback. Outros canais são removidos."
        observacao_manual = "Fallback manual prioritário. GE/Globo, CazéTV e Prime Video são fontes primárias; UOL Esporte é permitido manualmente e como fallback automático após 48 horas."
        auto_mudou = (
            auto.get("jogos") != auto_jogos_originais
            or auto.get("fonte") != fonte_auto
            or auto.get("politica_publicacao") != politica_auto
            or int(auto.get("total_vinculados") or 0) != len(auto.get("jogos") or {})
        )
        manual_mudou = (
            manual.get("jogos") != manual_jogos_originais
            or manual.get("observacao") != observacao_manual
        )
        if auto_mudou:
            auto["atualizado_em"] = agora_iso()
            auto["fonte"] = fonte_auto
            auto["politica_publicacao"] = politica_auto
            auto["total_vinculados"] = len(auto.get("jogos") or {})
            gravar(MM_AUTO, auto)
        if manual_mudou:
            manual["atualizado_em"] = agora_iso()
            manual["observacao"] = observacao_manual
            gravar(MM_MANUAL, manual)

    depois = calcular_resumo(jogos_resultados, auto, manual, prime_id, uol_id)
    depois_janela = calcular_resumo(universo, auto, manual, prime_id, uol_id)

    rel = {
        "atualizado_em": agora_iso(),
        "fonte": "sanitização e busca oficial de melhores momentos do Brasileirão",
        "politica": {
            "regra": "GE/Globo/sportv/Premiere/Globoplay, CazéTV e Amazon Prime Video são prioritários. Após 48 horas sem vídeo, UOL Esporte é aceito como fallback.",
            "criterio": "A validação usa fonte/canal real e channelId quando disponível. Título com 'ge.globo' em canal aleatório não é aceito; UOL automático respeita carência de 48 horas.",
            "escopo": "Apenas módulo Brasileirão. Nada em copa2026 é alterado.",
        },
        "dry_run": bool(args.dry_run),
        "youtube_ativo": bool(youtube_ativo),
        "quota_estimada_youtube": dict(QUOTA),
        "rodadas_processadas": {"inicio": args.rodada_inicio or None, "fim": args.rodada_fim or None},
        "resumo_geral_antes": antes,
        "resumo_geral_depois": depois,
        "resumo_janela_antes": antes_janela,
        "resumo_janela_depois": depois_janela,
        "mantidos_preferidos_na_janela": mantidos_preferidos,
        "substituidos_para_fontes_preferidas": substituidos,
        "removidos_por_fonte_nao_preferida": removidos_fontes_globais + removidos,
        "removidos_por_jogo_nao_finalizado": removidos_fora_resultados,
        "ainda_sem_link_preferido": sorted(ainda_sem_link, key=lambda x: (x.get("rodada") or 999, x.get("mandante") or "")),
        "buscas_executadas_em_canais_preferidos": buscas_executadas,
        "erros": erros,
    }
    gravar(RELATORIO, rel)

    print("Relatório:", RELATORIO.relative_to(RAIZ))
    print(json.dumps({
        "dry_run": bool(args.dry_run),
        "youtube_ativo": bool(youtube_ativo),
        "alvos": len(alvos),
        "substituidos": len(substituidos),
        "removidos": len(removidos_fontes_globais) + len(removidos),
        "removidos_por_jogo_nao_finalizado": len(removidos_fora_resultados),
        "ainda_sem_link_preferido": len(ainda_sem_link),
        "resumo_geral_depois": depois,
        "quota_estimada_youtube": QUOTA,
    }, ensure_ascii=False, indent=2))
    return 0


def selftest() -> int:
    ok = True

    def c(cond: bool, msg: str) -> None:
        nonlocal ok
        print(("  ok  " if cond else "  ERRO ") + msg)
        ok = ok and bool(cond)

    jogo = {"rodada": 18, "mandante": {"nome": "Remo"}, "visitante": {"nome": "São Paulo"}, "placar_mandante": 1, "placar_visitante": 0}
    c(video_serve_para_jogo("REMO 1 X 0 SÃO PAULO | MELHORES MOMENTOS | 18ª RODADA BRASILEIRÃO 2026 | ge.globo", jogo), "aceita título correto se vier de canal permitido")
    c(not video_serve_para_jogo("REMO 2 X 0 SÃO PAULO | MELHORES MOMENTOS | 18ª RODADA", jogo), "rejeita placar errado")
    c(not video_serve_para_jogo("REMO 1 X 0 SÃO PAULO AO VIVO", jogo), "rejeita ao vivo")
    c(not video_serve_para_jogo("REMO 1 X 0 SÃO PAULO | COLETIVA", jogo), "rejeita conteúdo que não é melhores momentos")
    c(not preferido({"channel_title": "Futebol Raiz TV", "titulo": "REMO 1 X 0 SÃO PAULO ge.globo"}), "não aceita falso ge.globo por título")
    c(preferido({"channel_id": GE_CHANNEL_ID, "channel_title": "ge"}), "aceita GE por channelId")
    c(preferido({"fonte": "sportv / YouTube"}), "aceita sportv por fonte manual")
    c(classificar_video({"channel_id": CAZE_CHANNEL_ID}) == "caze", "classifica CazéTV por channelId")
    c(preferido({"fonte": "UOL Esporte / YouTube"}), "aceita UOL Esporte como fonte de fallback")
    c(uploads_de(GE_CHANNEL_ID).startswith("UU"), "gera playlist de uploads")
    antigo = {**jogo, "data_iso": "2026-07-15T20:00:00-03:00"}
    recente = {**jogo, "data_iso": "2026-07-18T20:00:00-03:00"}
    agora_teste = datetime(2026, 7, 18, 21, 0, tzinfo=BRT)
    c(uol_fallback_liberado(antigo, agora_teste), "libera UOL após 48 horas")
    c(not uol_fallback_liberado(recente, agora_teste), "bloqueia UOL automático antes de 48 horas")

    base_teste = {"jogos": {
        "final": {"event_id": "1", "rodada": 18, "mandante": "Remo", "visitante": "São Paulo"},
        "futuro": {"event_id": "2", "rodada": 19, "mandante": "Botafogo", "visitante": "Vitória"},
    }}
    removidos_teste = sanear_vinculos_sem_resultado(base_teste, [{**jogo, "event_id": "1"}], "teste")
    c("final" in base_teste["jogos"] and "futuro" not in base_teste["jogos"], "remove vídeo de jogo não finalizado")
    c(len(removidos_teste) == 1 and removidos_teste[0]["event_id"] == "2", "audita vínculo futuro removido")
    fontes_teste = {"jogos": {
        "ok": {"event_id": "1", "fonte": "GE TV / YouTube"},
        "ruim": {"event_id": "2", "fonte": "VÁRZEA TV"},
    }}
    removidos_fonte_teste = sanear_fontes_nao_preferidas(fontes_teste, "teste")
    c("ok" in fontes_teste["jogos"] and "ruim" not in fontes_teste["jogos"], "remove canal não autorizado mesmo fora do índice mesclado")
    c(len(removidos_fonte_teste) == 1, "audita fonte não autorizada removida")

    cand_ge = {"video_id": "a", "titulo": "REMO 1 X 0 SÃO PAULO | MELHORES MOMENTOS | 18ª RODADA BRASILEIRÃO 2026", "canal": "ge", "metodo": "playlistItems"}
    cand_caze = {"video_id": "b", "titulo": "REMO 1 X 0 SÃO PAULO | MELHORES MOMENTOS | 18ª RODADA BRASILEIRÃO 2026", "canal": "caze", "metodo": "search.list"}
    esc = escolher_candidato(jogo, [cand_caze, cand_ge])
    c(esc and esc["video_id"] == "a", "prioridade GE > Cazé")
    entrada = montar_entrada(jogo, cand_ge)
    c(entrada["fonte"] == "GE TV / YouTube" and entrada["url"].endswith("v=a"), "monta entrada no formato do site")
    print("\nSELFTEST:", "PASSOU ✅" if ok else "FALHOU ❌")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Sanitiza e busca melhores momentos em fontes primárias e UOL após 48 horas.")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--sem-youtube", action="store_true", help="não consulta YouTube; apenas remove fontes não preferidas e gera relatório")
    ap.add_argument("--rodada-inicio", type=int, default=0)
    ap.add_argument("--rodada-fim", type=int, default=0)
    ap.add_argument("--paginas-getv", type=int, default=2)
    ap.add_argument("--paginas-caze", type=int, default=12)
    ap.add_argument("--paginas-prime", type=int, default=8)
    ap.add_argument("--max-search-total", type=int, default=20, help="limite de chamadas search.list somente em canais preferidos")
    ap.add_argument("--max-consultas-por-jogo", type=int, default=2)
    ap.add_argument("--max-results-search", type=int, default=6)
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    return rodar(args)


if __name__ == "__main__":
    sys.exit(main())
