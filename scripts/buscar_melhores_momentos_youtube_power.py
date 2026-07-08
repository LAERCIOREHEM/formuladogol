#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Busca reforçada de melhores momentos do Brasileirão fora das playlists.

Este script é complementar ao buscar_melhores_momentos_getv.py.
Ele lê os jogos ainda sem vídeo em dados-br/melhores-momentos.json,
usa YouTube search.list para procurar vídeos oficiais/prováveis e só publica
vínculos com alta confiança.

Atenção: search.list é mais restrito que playlistItems.list. Use o workflow POWER manual para rodadas específicas ou para o backfill inicial e controle o número de chamadas.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Reaproveita utilitários do coletor principal da Execução 1.
try:
    from buscar_melhores_momentos_getv import (
        BRT,
        YouTubeClient,
        aliases_para,
        agora_iso,
        carregar_jogos,
        load_json,
        norm,
        rodada_do_texto,
        save_json,
        time_no_titulo,
        video_tem_melhores_momentos,
    )
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "Não consegui importar scripts/buscar_melhores_momentos_getv.py. "
        "Suba primeiro a EXECUÇÃO 1 e depois rode este workflow POWER. "
        f"Erro: {exc}"
    ) from exc

YOUTUBE_API = "https://www.googleapis.com/youtube/v3"


def as_int(v: Any, default: int = 0) -> int:
    try:
        return int(v)
    except Exception:
        return default


def contem_alias(texto_norm: str, clube: str, config: Dict[str, Any]) -> bool:
    return time_no_titulo(texto_norm, clube, config)


def canal_oficial(channel_title: str, config: Dict[str, Any]) -> bool:
    ch = norm(channel_title)
    termos = config.get("busca_extra", {}).get("canais_oficiais_ou_confiaveis", [])
    termos_norm = [norm(t) for t in termos]
    return any(t and t in ch for t in termos_norm)


def search_youtube(client: YouTubeClient, query: str, max_results: int = 8, published_after: str = "") -> List[Dict[str, Any]]:
    params: Dict[str, Any] = {
        "part": "snippet",
        "type": "video",
        "q": query,
        "maxResults": max_results,
        "order": "relevance",
        "safeSearch": "none",
        "videoEmbeddable": "any",
    }
    if published_after:
        params["publishedAfter"] = published_after
    data = client.get("search", **params)
    out: List[Dict[str, Any]] = []
    for item in data.get("items") or []:
        sn = item.get("snippet") or {}
        video_id = (item.get("id") or {}).get("videoId")
        if not video_id:
            continue
        thumbs = sn.get("thumbnails") or {}
        thumb = (thumbs.get("maxres") or thumbs.get("standard") or thumbs.get("high") or thumbs.get("medium") or thumbs.get("default") or {}).get("url")
        out.append({
            "video_id": video_id,
            "titulo": sn.get("title") or "",
            "descricao": sn.get("description") or "",
            "published_at": sn.get("publishedAt"),
            "thumbnail": thumb,
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "playlist_id": None,
            "rodada_playlist": None,
            "channel_id": sn.get("channelId"),
            "channel_title": sn.get("channelTitle") or "",
            "fonte_busca": "youtube_search",
            "query": query,
        })
    return out


def placar_no_titulo(titulo_norm: str, pm: Any, pv: Any) -> bool:
    if pm is None or pv is None:
        return False
    a, b = str(pm), str(pv)
    placares = re.findall(r"(\d+)\s*x\s*(\d+)", titulo_norm)
    return any(x == a and y == b for x, y in placares)


def parece_brasileirao_2026(titulo_norm: str) -> bool:
    bons = [
        "brasileirao 2026",
        "campeonato brasileiro 2026",
        "brasileirao serie a 2026",
        "serie a 2026",
        "brasileirao",  # aceita sem ano se os clubes/placar/rodada fecharem muito bem
        "campeonato brasileiro",
    ]
    return any(b in titulo_norm for b in bons)


def tem_termo_ruim(titulo_norm: str) -> bool:
    ruins = [
        "ao vivo", "live", "react", "simulacao", "simulação", "palpite", "prognostico", "prognóstico",
        "coletiva", "entrevista", "treino", "bastidores", "noticias", "notícias", "mesa redonda",
        "shorts", "short", "efootball", "fifa 26", "pes 2026", "football manager",
    ]
    return any(norm(r) in titulo_norm for r in ruins)


def pontuar_busca_extra(jogo: Any, video: Dict[str, Any], config: Dict[str, Any]) -> Tuple[float, List[str]]:
    titulo_norm = norm(video.get("titulo"))
    descr_norm = norm(video.get("descricao"))
    texto = (titulo_norm + " " + descr_norm).strip()
    motivos: List[str] = []
    score = 0.0

    if tem_termo_ruim(titulo_norm):
        return 0.0, ["título tem termo ruim para melhores momentos"]

    mand_titulo = contem_alias(titulo_norm, jogo.mandante, config)
    vist_titulo = contem_alias(titulo_norm, jogo.visitante, config)
    mand_texto = mand_titulo or contem_alias(texto, jogo.mandante, config)
    vist_texto = vist_titulo or contem_alias(texto, jogo.visitante, config)

    # Publicação automática exige os dois clubes no título, não apenas na descrição.
    if not (mand_titulo and vist_titulo):
        return 0.0, ["não tem os dois clubes no título"]

    score += 0.46
    motivos.append("mandante e visitante no título")

    if video_tem_melhores_momentos(video):
        score += 0.12
        motivos.append("título compatível com melhores momentos")

    if placar_no_titulo(titulo_norm, jogo.placar_mandante, jogo.placar_visitante):
        score += 0.16
        motivos.append("placar confere")

    rodada_titulo = rodada_do_texto(video.get("titulo") or "")
    if rodada_titulo == jogo.rodada:
        score += 0.12
        motivos.append("rodada no título confere")

    if parece_brasileirao_2026(titulo_norm):
        score += 0.06
        motivos.append("título indica Brasileirão/Campeonato Brasileiro")

    if canal_oficial(video.get("channel_title") or "", config):
        score += 0.10
        motivos.append(f"canal confiável: {video.get('channel_title')}")

    # Se veio de query exata com placar e os dois clubes, pequeno bônus.
    qn = norm(video.get("query"))
    if str(jogo.placar_mandante) in qn and str(jogo.placar_visitante) in qn:
        score += 0.04
        motivos.append("query exata com placar")

    return min(score, 1.0), motivos


def consultas_para_jogo(jogo: Any, config: Dict[str, Any], max_por_jogo: int) -> List[str]:
    aliases = config.get("aliases_clubes") or {}
    mand = jogo.mandante
    vist = jogo.visitante
    pm = jogo.placar_mandante
    pv = jogo.placar_visitante
    rodada = jogo.rodada
    base = [
        f'"{mand} {pm} x {pv} {vist}" "melhores momentos" "Brasileirão 2026"',
        f'"{mand} x {vist}" "melhores momentos" "Brasileirão 2026"',
        f'{mand} {vist} melhores momentos {rodada}ª rodada Brasileirão 2026',
        f'{mand} {vist} melhores momentos Campeonato Brasileiro 2026',
    ]
    # Variante útil para Vasco da Gama etc. usando primeiro alias curto.
    am = (aliases.get(mand) or [mand])[0]
    av = (aliases.get(vist) or [vist])[0]
    if am != mand or av != vist:
        base.append(f'{am} {av} melhores momentos Brasileirão 2026')
    out: List[str] = []
    seen = set()
    for q in base:
        if q not in seen:
            out.append(q)
            seen.add(q)
    return out[:max_por_jogo]


def carregar_prev(root: Path) -> Dict[str, Any]:
    return load_json(root / "dados-br" / "melhores-momentos.json", {"jogos": {}})


def main() -> int:
    ap = argparse.ArgumentParser(description="Busca reforçada de melhores momentos do Brasileirão via YouTube Search.")
    ap.add_argument("--root", default=".", help="raiz do repositório")
    ap.add_argument("--rodada-inicio", type=int, default=None)
    ap.add_argument("--rodada-fim", type=int, default=None)
    ap.add_argument("--max-buscas-total", type=int, default=70, help="limite total de chamadas search.list")
    ap.add_argument("--max-consultas-por-jogo", type=int, default=2)
    ap.add_argument("--max-results", type=int, default=8)
    ap.add_argument("--min-confianca", type=float, default=None)
    ap.add_argument("--sleep", type=float, default=0.05)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    config = load_json(root / "dados-br" / "getv-config.json", {})
    busca_cfg = config.get("busca_extra") or {}
    min_conf = float(args.min_confianca if args.min_confianca is not None else busca_cfg.get("min_confianca_publicar", 0.82))

    jogos_all = carregar_jogos(root)
    if not jogos_all:
        raise SystemExit("Nenhum jogo encontrado em espn_eventos.json/resultados.json/jogos.json.")
    ri = int(args.rodada_inicio or 1)
    rf = int(args.rodada_fim or max([j.rodada for j in jogos_all], default=18))
    jogos = [j for j in jogos_all if ri <= j.rodada <= rf]
    prev = carregar_prev(root)
    ja_vinculados = set((prev.get("jogos") or {}).keys())
    missing = [j for j in jogos if j.chave not in ja_vinculados and j.event_id not in ja_vinculados]

    if args.dry_run:
        print(f"DRY RUN POWER OK: {len(jogos)} jogos nas rodadas {ri}-{rf}; {len(missing)} ainda sem vídeo.")
        return 0

    api_key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("Secret/variável YOUTUBE_API_KEY não encontrada.")

    client = YouTubeClient(api_key, sleep=args.sleep)
    vinculados: Dict[str, Dict[str, Any]] = {}
    duvidosos: List[Dict[str, Any]] = []
    ainda_sem: List[Dict[str, Any]] = []
    todas_buscas: List[Dict[str, Any]] = []
    calls = 0

    for jogo in missing:
        if calls >= args.max_buscas_total:
            ainda_sem.append({"event_id": jogo.event_id, "rodada": jogo.rodada, "mandante": jogo.mandante, "visitante": jogo.visitante, "motivo": "limite de buscas atingido"})
            continue
        melhor: Optional[Tuple[float, Dict[str, Any], List[str]]] = None
        candidatos_jogo: List[Dict[str, Any]] = []
        queries = consultas_para_jogo(jogo, config, max(1, args.max_consultas_por_jogo))
        for q in queries:
            if calls >= args.max_buscas_total:
                break
            calls += 1
            try:
                resultados = search_youtube(client, q, max_results=max(1, min(args.max_results, 20)))
            except Exception as exc:
                candidatos_jogo.append({"query": q, "erro": str(exc)})
                continue
            todas_buscas.append({"event_id": jogo.event_id, "rodada": jogo.rodada, "mandante": jogo.mandante, "visitante": jogo.visitante, "query": q, "resultados": len(resultados)})
            for video in resultados:
                score, motivos = pontuar_busca_extra(jogo, video, config)
                if score <= 0:
                    continue
                reg = {
                    "event_id": jogo.event_id,
                    "chave": jogo.chave,
                    "rodada": jogo.rodada,
                    "mandante": jogo.mandante,
                    "visitante": jogo.visitante,
                    "placar_mandante": jogo.placar_mandante,
                    "placar_visitante": jogo.placar_visitante,
                    "video_id": video.get("video_id"),
                    "titulo": video.get("titulo"),
                    "url": video.get("url"),
                    "thumbnail": video.get("thumbnail"),
                    "playlist_id": None,
                    "published_at": video.get("published_at"),
                    "channel_id": video.get("channel_id"),
                    "channel_title": video.get("channel_title"),
                    "fonte": video.get("channel_title") or "YouTube",
                    "fonte_busca": "YouTube Search",
                    "confianca": round(score, 3),
                    "motivos": motivos,
                    "query": video.get("query"),
                }
                candidatos_jogo.append(reg)
                if melhor is None or score > melhor[0]:
                    melhor = (score, reg, motivos)
            if melhor and melhor[0] >= min_conf:
                break
        if melhor and melhor[0] >= min_conf:
            vinculados[jogo.chave] = melhor[1]
        else:
            if candidatos_jogo:
                candidatos_jogo = sorted([c for c in candidatos_jogo if "confianca" in c], key=lambda x: x.get("confianca", 0), reverse=True)[:5] or candidatos_jogo[:5]
                duvidosos.extend(candidatos_jogo[:3])
            ainda_sem.append({"event_id": jogo.event_id, "rodada": jogo.rodada, "mandante": jogo.mandante, "visitante": jogo.visitante})

    merged = dict(prev.get("jogos") or {})
    merged.update(vinculados)
    saida = {
        "atualizado_em": agora_iso(),
        "fonte": "GE TV / YouTube + busca reforçada",
        "modo_ultima_execucao": "power-search",
        "rodadas_processadas": {"inicio": ri, "fim": rf},
        "total_vinculados": len(merged),
        "jogos": dict(sorted(merged.items(), key=lambda kv: (kv[1].get("rodada") or 999, kv[1].get("mandante") or ""))),
    }
    auditoria = {
        "atualizado_em": agora_iso(),
        "fonte": "YouTube Search reforçado",
        "rodadas_processadas": {"inicio": ri, "fim": rf},
        "youtube_search_requests": calls,
        "min_confianca_publicar": min_conf,
        "resumo": {
            "jogos_ja_vinculados_antes": len(ja_vinculados),
            "jogos_sem_video_antes": len(missing),
            "jogos_vinculados_nesta_execucao": len(vinculados),
            "jogos_vinculados_total": len(merged),
            "candidatos_duvidosos": len(duvidosos),
            "jogos_ainda_sem_video": len(ainda_sem),
        },
        "vinculados_nesta_execucao": list(vinculados.values()),
        "candidatos_duvidosos": duvidosos[:250],
        "jogos_ainda_sem_video": ainda_sem[:400],
        "buscas_executadas": todas_buscas[:500],
    }

    if vinculados:
        save_json(root / "dados-br" / "melhores-momentos.json", saida)
    else:
        print("Nenhum vínculo novo com confiança suficiente. melhores-momentos.json preservado.")
    save_json(root / "dados-br" / "auditoria-melhores-momentos-power.json", auditoria)

    print("Busca POWER concluída")
    print(f"Rodadas: {ri}-{rf} | sem vídeo antes: {len(missing)} | novos vínculos: {len(vinculados)} | ainda sem: {len(ainda_sem)}")
    print(f"Search requests: {calls}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
