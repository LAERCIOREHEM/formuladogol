#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Busca POWER de melhores momentos do Brasileirão fora das playlists.

Execução 4: versão mais segura para quota.
- considera fallback manual como jogo já coberto;
- usa cache leve para evitar repetir consultas sem resultado;
- interrompe no primeiro erro 429/RESOURCE_EXHAUSTED, em vez de gastar várias consultas inúteis;
- prioriza rodadas recentes quando o usuário não informa rodada;
- preserva melhores-momentos.json quando não encontra nada novo;
- gera auditoria legível para decidir busca manual.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    from buscar_melhores_momentos_getv import (
        BRT,
        YouTubeClient,
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
        "Suba primeiro a execução dos melhores momentos GE TV. "
        f"Erro: {exc}"
    ) from exc


def as_int(v: Any, default: int = 0) -> int:
    try:
        return int(v)
    except Exception:
        return default


def normalizar_chave_query(q: str) -> str:
    return re.sub(r"\s+", " ", q.strip().lower())


def contem_alias(texto_norm: str, clube: str, config: Dict[str, Any]) -> bool:
    return time_no_titulo(texto_norm, clube, config)


def canal_oficial(channel_title: str, config: Dict[str, Any]) -> bool:
    ch = norm(channel_title)
    termos = config.get("busca_extra", {}).get("canais_oficiais_ou_confiaveis", [])
    termos_norm = [norm(t) for t in termos]
    return any(t and t in ch for t in termos_norm)


def erro_quota(exc: Exception | str) -> bool:
    txt = str(exc).lower()
    gatilhos = [
        "quota exceeded",
        "resource_exhausted",
        "ratelimitexceeded",
        "rate_limit_exceeded",
        "search queries per day",
        "defaultsearchlistperdayperproject",
        "http 429",
    ]
    return any(g in txt for g in gatilhos)


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
        "brasileirao",
        "campeonato brasileiro",
    ]
    return any(b in titulo_norm for b in bons)


def tem_termo_ruim(titulo_norm: str) -> bool:
    ruins = [
        "ao vivo", "live", "simulacao", "simulação", "palpite", "prognostico", "prognóstico",
        "coletiva", "entrevista", "treino", "bastidores", "noticias", "notícias", "mesa redonda",
        "shorts", "short", "efootball", "fifa 26", "pes 2026", "football manager",
    ]
    # "react" não barra automaticamente: há vídeos oficiais da GE TV com "react" no título.
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

    # Publicação automática exige os dois clubes no título. Isso evita vínculos errados.
    if not (mand_titulo and vist_titulo):
        if mand_texto and vist_texto:
            return 0.30, ["dois clubes só aparecem fora do título; manter em auditoria"]
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


def carregar_manual(root: Path) -> Dict[str, Any]:
    return load_json(root / "dados-br" / "melhores-momentos-manual.json", {"jogos": {}})


def chaves_vinculadas(data: Dict[str, Any]) -> set[str]:
    out: set[str] = set()
    jogos = data.get("jogos") or {}
    if isinstance(jogos, dict):
        for k, v in jogos.items():
            out.add(str(k))
            if isinstance(v, dict):
                if v.get("event_id"):
                    out.add(str(v.get("event_id")))
                if v.get("chave"):
                    out.add(str(v.get("chave")))
    return out


def carregar_cache(root: Path) -> Dict[str, Any]:
    path = root / "dados-br" / "auditoria-melhores-momentos-power-cache.json"
    data = load_json(path, {"queries": {}})
    if not isinstance(data, dict):
        data = {"queries": {}}
    if not isinstance(data.get("queries"), dict):
        data["queries"] = {}
    return data


def cache_valido(entry: Dict[str, Any], ttl_dias: int) -> bool:
    if not entry or not ttl_dias:
        return False
    status = entry.get("status")
    if status not in {"sem_resultado", "candidatos_fracos"}:
        return False
    try:
        quando = dt.datetime.fromisoformat(str(entry.get("quando")))
        if quando.tzinfo is None:
            quando = quando.replace(tzinfo=BRT)
        agora = dt.datetime.now(quando.tzinfo)
    except Exception:
        return False
    return (agora - quando).days < ttl_dias


def salvar_cache(root: Path, cache: Dict[str, Any]) -> None:
    cache["atualizado_em"] = agora_iso()
    cache.setdefault("observacao", "Cache leve do workflow POWER para não repetir buscas sem resultado em curto prazo. Erros de quota não entram como ausência de vídeo.")
    save_json(root / "dados-br" / "auditoria-melhores-momentos-power-cache.json", cache)


def jogo_audit(jogo: Any, motivo: str = "") -> Dict[str, Any]:
    d = {"event_id": jogo.event_id, "rodada": jogo.rodada, "mandante": jogo.mandante, "visitante": jogo.visitante}
    if motivo:
        d["motivo"] = motivo
    return d


def main() -> int:
    ap = argparse.ArgumentParser(description="Busca reforçada de melhores momentos do Brasileirão via YouTube Search.")
    ap.add_argument("--root", default=".", help="raiz do repositório")
    ap.add_argument("--rodada-inicio", type=int, default=None)
    ap.add_argument("--rodada-fim", type=int, default=None)
    ap.add_argument("--rodadas-recentes", type=int, default=2, help="usado quando rodada-inicio/fim não forem informadas")
    ap.add_argument("--max-buscas-total", type=int, default=20, help="limite total de chamadas search.list")
    ap.add_argument("--max-consultas-por-jogo", type=int, default=1)
    ap.add_argument("--max-results", type=int, default=6)
    ap.add_argument("--min-confianca", type=float, default=None)
    ap.add_argument("--sleep", type=float, default=0.05)
    ap.add_argument("--ttl-cache-dias", type=int, default=21)
    ap.add_argument("--ignorar-cache", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    config = load_json(root / "dados-br" / "getv-config.json", {})
    busca_cfg = config.get("busca_extra") or {}
    min_conf = float(args.min_confianca if args.min_confianca is not None else busca_cfg.get("min_confianca_publicar", 0.82))

    jogos_all = carregar_jogos(root)
    if not jogos_all:
        raise SystemExit("Nenhum jogo encontrado em espn_eventos.json/resultados.json/jogos.json.")

    max_rodada = max([j.rodada for j in jogos_all], default=18)
    if args.rodada_inicio is None and args.rodada_fim is None:
        rf = max_rodada
        ri = max(1, rf - max(0, args.rodadas_recentes - 1))
    else:
        ri = int(args.rodada_inicio or 1)
        rf = int(args.rodada_fim or max_rodada)

    jogos = [j for j in jogos_all if ri <= j.rodada <= rf]
    prev = carregar_prev(root)
    manual = carregar_manual(root)
    ja_vinculados = chaves_vinculadas(prev) | chaves_vinculadas(manual)
    missing = [j for j in jogos if j.chave not in ja_vinculados and j.event_id not in ja_vinculados]

    if args.dry_run:
        print(f"DRY RUN POWER OK: {len(jogos)} jogos nas rodadas {ri}-{rf}; {len(missing)} ainda sem vídeo após automático+manual.")
        return 0

    api_key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("Secret/variável YOUTUBE_API_KEY não encontrada.")

    client = YouTubeClient(api_key, sleep=args.sleep)
    cache = carregar_cache(root)
    qcache: Dict[str, Any] = cache.setdefault("queries", {})

    vinculados: Dict[str, Dict[str, Any]] = {}
    duvidosos: List[Dict[str, Any]] = []
    ainda_sem: List[Dict[str, Any]] = []
    buscas_exec: List[Dict[str, Any]] = []
    buscas_puladas_cache: List[Dict[str, Any]] = []
    erros: List[Dict[str, Any]] = []
    calls = 0
    quota_excedida = False

    for jogo in missing:
        if quota_excedida:
            ainda_sem.append(jogo_audit(jogo, "não buscado: quota excedida nesta execução"))
            continue
        if calls >= args.max_buscas_total:
            ainda_sem.append(jogo_audit(jogo, "limite de buscas atingido"))
            continue

        melhor: Optional[Tuple[float, Dict[str, Any], List[str]]] = None
        candidatos_jogo: List[Dict[str, Any]] = []
        queries = consultas_para_jogo(jogo, config, max(1, args.max_consultas_por_jogo))

        for q in queries:
            if quota_excedida or calls >= args.max_buscas_total:
                break
            qkey = normalizar_chave_query(q)
            entry = qcache.get(qkey) if isinstance(qcache.get(qkey), dict) else None
            if entry and not args.ignorar_cache and cache_valido(entry, max(0, args.ttl_cache_dias)):
                buscas_puladas_cache.append({"event_id": jogo.event_id, "rodada": jogo.rodada, "query": q, "cache_status": entry.get("status")})
                continue

            calls += 1
            try:
                resultados = search_youtube(client, q, max_results=max(1, min(args.max_results, 20)))
            except Exception as exc:
                err = {"event_id": jogo.event_id, "rodada": jogo.rodada, "mandante": jogo.mandante, "visitante": jogo.visitante, "query": q, "erro": str(exc)}
                erros.append(err)
                candidatos_jogo.append(err)
                if erro_quota(exc):
                    quota_excedida = True
                    break
                continue

            buscas_exec.append({"event_id": jogo.event_id, "rodada": jogo.rodada, "mandante": jogo.mandante, "visitante": jogo.visitante, "query": q, "resultados": len(resultados)})
            melhor_query_score = 0.0
            for video in resultados:
                score, motivos = pontuar_busca_extra(jogo, video, config)
                melhor_query_score = max(melhor_query_score, score)
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
                    "fonte_busca": "YouTube Search POWER",
                    "confianca": round(score, 3),
                    "motivos": motivos,
                    "query": video.get("query"),
                }
                candidatos_jogo.append(reg)
                if melhor is None or score > melhor[0]:
                    melhor = (score, reg, motivos)
            if resultados and melhor_query_score < min_conf:
                qcache[qkey] = {"quando": agora_iso(), "status": "candidatos_fracos", "resultados": len(resultados), "melhor_score": round(melhor_query_score, 3)}
            elif not resultados:
                qcache[qkey] = {"quando": agora_iso(), "status": "sem_resultado", "resultados": 0}

            if melhor and melhor[0] >= min_conf:
                break

        if melhor and melhor[0] >= min_conf:
            vinculados[jogo.chave] = melhor[1]
        else:
            validos = [c for c in candidatos_jogo if "confianca" in c]
            if validos:
                duvidosos.extend(sorted(validos, key=lambda x: x.get("confianca", 0), reverse=True)[:3])
            elif candidatos_jogo:
                duvidosos.extend(candidatos_jogo[:2])
            motivo = "quota excedida" if quota_excedida else "sem vínculo com confiança suficiente"
            ainda_sem.append(jogo_audit(jogo, motivo))

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
        "fonte": "YouTube Search POWER com controle de quota/cache",
        "rodadas_processadas": {"inicio": ri, "fim": rf},
        "youtube_search_requests": calls,
        "quota_excedida": quota_excedida,
        "min_confianca_publicar": min_conf,
        "cache": {"ttl_dias": args.ttl_cache_dias, "consultas_puladas_por_cache": len(buscas_puladas_cache)},
        "resumo": {
            "jogos_ja_vinculados_antes_automatico_ou_manual": len(ja_vinculados),
            "jogos_sem_video_antes": len(missing),
            "jogos_vinculados_nesta_execucao": len(vinculados),
            "jogos_vinculados_total_automatico": len(merged),
            "candidatos_duvidosos": len(duvidosos),
            "jogos_ainda_sem_video_na_janela": len(ainda_sem),
            "erros": len(erros),
        },
        "vinculados_nesta_execucao": list(vinculados.values()),
        "candidatos_duvidosos": duvidosos[:250],
        "jogos_ainda_sem_video": ainda_sem[:400],
        "erros": erros[:80],
        "buscas_executadas": buscas_exec[:500],
        "buscas_puladas_por_cache": buscas_puladas_cache[:250],
    }

    if vinculados:
        save_json(root / "dados-br" / "melhores-momentos.json", saida)
    else:
        print("Nenhum vínculo novo com confiança suficiente. melhores-momentos.json preservado.")
    save_json(root / "dados-br" / "auditoria-melhores-momentos-power.json", auditoria)
    salvar_cache(root, cache)

    print("Busca POWER concluída")
    print(f"Rodadas: {ri}-{rf} | sem vídeo antes: {len(missing)} | novos vínculos: {len(vinculados)} | ainda sem na janela: {len(ainda_sem)}")
    print(f"Search requests: {calls} | quota_excedida={quota_excedida} | puladas_cache={len(buscas_puladas_cache)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
