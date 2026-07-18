#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Audita as fontes dos melhores momentos exibidos na aba Resultados.

Objetivo:
- confirmar que só fontes preferidas aparecem no site;
- informar quantos links efetivos vêm de GE/Globo, Amazon Prime Video,
  CazéTV, UOL Esporte e Outros;
- listar exatamente quais jogos ainda estão sem vídeo por falta de fonte preferida;
- não acessar internet e não alterar os vínculos de vídeos.

A ordem de prioridade do site é respeitada: manual substitui automático.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import unicodedata
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

BRT = dt.timezone(dt.timedelta(hours=-3), name="BRT")


def agora_iso() -> str:
    return dt.datetime.now(BRT).replace(microsecond=0).isoformat()


def load_json(path: Path, default: Any) -> Any:
    try:
        if not path.exists():
            return default
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def norm(txt: Any) -> str:
    s = str(txt or "").strip().lower()
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def nome_time(obj: Any) -> str:
    if isinstance(obj, dict):
        return str(obj.get("nome") or obj.get("name") or obj.get("displayName") or "")
    return str(obj or "")


def chave_texto(valor: Any) -> str:
    return norm(valor).replace(" ", "-")


def chave_jogo(jogo: Dict[str, Any]) -> str:
    rodada = jogo.get("rodada") or ""
    mand = nome_time(jogo.get("mandante"))
    vist = nome_time(jogo.get("visitante"))
    return f"rodada-{rodada}-{chave_texto(mand)}-{chave_texto(vist)}"


def iter_videos(data: Dict[str, Any], origem: str) -> Iterable[Tuple[str, Dict[str, Any]]]:
    jogos = data.get("jogos") or {}
    if isinstance(jogos, dict):
        for k, v in jogos.items():
            if isinstance(v, dict):
                reg = dict(v)
                reg["origem_vinculo"] = origem
                yield str(k), reg


def indexar_videos(*fontes: Tuple[Dict[str, Any], str]) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    por_id: Dict[str, Dict[str, Any]] = {}
    por_chave: Dict[str, Dict[str, Any]] = {}
    # A ordem importa: se manual vier por último, substitui automático.
    for fonte, origem in fontes:
        for k, reg in iter_videos(fonte, origem):
            event_id = str(reg.get("event_id") or k or "").strip()
            if event_id:
                por_id[event_id] = reg
            ch = str(reg.get("chave") or "").strip()
            if ch:
                por_chave[ch] = reg
            rodada = reg.get("rodada")
            mand = reg.get("mandante")
            vist = reg.get("visitante")
            if rodada and mand and vist:
                fake = {"rodada": rodada, "mandante": {"nome": mand}, "visitante": {"nome": vist}}
                por_chave[chave_jogo(fake)] = reg
    return por_id, por_chave


def video_do_jogo(jogo: Dict[str, Any], por_id: Dict[str, Dict[str, Any]], por_chave: Dict[str, Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    event_id = str(jogo.get("event_id") or jogo.get("id") or "").strip()
    if event_id and event_id in por_id:
        return por_id[event_id]
    ch = chave_jogo(jogo)
    if ch and ch in por_chave:
        return por_chave[ch]
    return None


def texto_fonte(video: Dict[str, Any]) -> str:
    # IMPORTANTE: a classificação da fonte NÃO usa título nem URL.
    # Alguns vídeos de canais aleatórios colocam "ge.globo" ou "ge tv" no título,
    # e isso gerava falso positivo como GE. A fonte deve vir do canal/origem
    # ou de vínculo manual informado pelo administrador.
    partes = [
        video.get("fonte"),
        video.get("fonte_busca"),
        video.get("channel_title"),
        video.get("channel_id"),
    ]
    return norm(" ".join(str(p or "") for p in partes))


def classificar_fonte(video: Dict[str, Any]) -> str:
    t = texto_fonte(video)

    # Prioridade das exceções explícitas, para não cair dentro de "outros".
    if any(x in t for x in ["cazetv", "caze tv", "caze", "caze tv"]):
        return "cazetv"
    if any(x in t for x in ["amazon prime video", "prime video", "amazon"]):
        return "amazon_prime_video"
    if any(x in t for x in ["uol esporte", "uolesporte", "uol / youtube", "uol youtube"]):
        return "uol_esporte"

    # GE/Globo aqui inclui GE TV, ge.globo e marcas Globo usadas nos títulos/canais.
    if any(x in t for x in [
        "ge tv",
        "ge globo",
        "geglobo",
        "globoesporte",
        "globo esporte",
        "sportv",
        "premiere",
        "globoplay",
    ]):
        return "ge_globo"

    return "outros"


def jogo_resumido(jogo: Dict[str, Any], video: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    item = {
        "event_id": str(jogo.get("event_id") or jogo.get("id") or ""),
        "rodada": jogo.get("rodada"),
        "mandante": nome_time(jogo.get("mandante")),
        "visitante": nome_time(jogo.get("visitante")),
        "placar_mandante": jogo.get("placar_mandante"),
        "placar_visitante": jogo.get("placar_visitante"),
    }
    if video:
        item.update({
            "categoria_fonte": classificar_fonte(video),
            "origem_vinculo": video.get("origem_vinculo") or "",
            "fonte": video.get("fonte") or "",
            "fonte_busca": video.get("fonte_busca") or "",
            "channel_title": video.get("channel_title") or "",
            "titulo": video.get("titulo") or "",
            "url": video.get("url") or "",
            "confianca": video.get("confianca"),
        })
    return item


def main() -> int:
    ap = argparse.ArgumentParser(description="Audita fontes dos melhores momentos do Brasileirão.")
    ap.add_argument("--root", default=".")
    ap.add_argument("--saida", default="dados-br/auditoria-fontes-melhores-momentos.json")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    resultados = load_json(root / "resultados.json", {"resultados": []})
    auto = load_json(root / "dados-br" / "melhores-momentos.json", {"jogos": {}})
    manual = load_json(root / "dados-br" / "melhores-momentos-manual.json", {"jogos": {}})

    jogos = resultados.get("resultados") or []
    if not isinstance(jogos, list):
        jogos = []

    por_id, por_chave = indexar_videos((auto, "automatico"), (manual, "manual"))

    por_categoria: Dict[str, List[Dict[str, Any]]] = {
        "ge_globo": [],
        "amazon_prime_video": [],
        "cazetv": [],
        "uol_esporte": [],
        "outros": [],
        "sem_video": [],
    }

    for jogo in jogos:
        video = video_do_jogo(jogo, por_id, por_chave)
        if not video:
            por_categoria["sem_video"].append(jogo_resumido(jogo))
            continue
        cat = classificar_fonte(video)
        por_categoria.setdefault(cat, []).append(jogo_resumido(jogo, video))

    total = len(jogos)
    total_com_video = total - len(por_categoria["sem_video"])
    resumo = {
        "jogos_resultados": total,
        "jogos_com_video": total_com_video,
        "ge_globo": len(por_categoria["ge_globo"]),
        "amazon_prime_video": len(por_categoria["amazon_prime_video"]),
        "cazetv": len(por_categoria["cazetv"]),
        "uol_esporte": len(por_categoria["uol_esporte"]),
        "outros": len(por_categoria["outros"]),
        "sem_video": len(por_categoria["sem_video"]),
        "percentual_fontes_preferidas": round(((len(por_categoria["ge_globo"]) + len(por_categoria["amazon_prime_video"]) + len(por_categoria["cazetv"]) + len(por_categoria["uol_esporte"])) / total_com_video * 100), 1) if total_com_video else 0,
    }

    saida = {
        "atualizado_em": agora_iso(),
        "fonte": "auditoria local das fontes dos melhores momentos",
        "politica": {
            "regra": "GE/Globo/sportv/Premiere/Globoplay, Amazon Prime Video e CazéTV são prioritários. UOL Esporte é aceito como fallback após 48 horas ou por vínculo manual conferido.",
            "preferenciais": ["GE TV/ge.globo/sportv/Premiere/Globoplay", "Amazon Prime Video", "CazéTV", "UOL Esporte (fallback)"],
            "outros": "Não devem aparecer no site. Se houver algum item nesta lista, é problema de saneamento.",
            "criterio_classificacao": "A auditoria classifica pela fonte/canal/origem do vínculo, não pelo título do vídeo, para evitar falso ge.globo em canais não oficiais.",
        },
        "resumo": resumo,
        "outros_sites_ainda_em_uso": sorted(por_categoria["outros"], key=lambda x: (x.get("rodada") or 999, x.get("mandante") or "")),
        "sem_video": sorted(por_categoria["sem_video"], key=lambda x: (x.get("rodada") or 999, x.get("mandante") or "")),
        "detalhamento": {
            "ge_globo": sorted(por_categoria["ge_globo"], key=lambda x: (x.get("rodada") or 999, x.get("mandante") or "")),
            "amazon_prime_video": sorted(por_categoria["amazon_prime_video"], key=lambda x: (x.get("rodada") or 999, x.get("mandante") or "")),
            "cazetv": sorted(por_categoria["cazetv"], key=lambda x: (x.get("rodada") or 999, x.get("mandante") or "")),
            "uol_esporte": sorted(por_categoria["uol_esporte"], key=lambda x: (x.get("rodada") or 999, x.get("mandante") or "")),
        },
    }

    if args.dry_run:
        print(json.dumps(resumo, ensure_ascii=False, indent=2))
        return 0
    save_json(root / args.saida, saida)
    print("Auditoria de fontes dos melhores momentos gerada:", args.saida)
    print(json.dumps(resumo, ensure_ascii=False, indent=2))
    if por_categoria["outros"]:
        print("\nJogos ainda usando OUTROS sites:")
        for item in sorted(por_categoria["outros"], key=lambda x: (x.get("rodada") or 999, x.get("mandante") or "")):
            print(f"- Rodada {item.get('rodada')}: {item.get('mandante')} x {item.get('visitante')} | {item.get('fonte') or item.get('channel_title')} | {item.get('url')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
