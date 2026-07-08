#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Gera auditoria de cobertura da aba Resultados do Brasileirão.

Combina:
- resultados.json                         -> jogos finalizados exibidos na aba Resultados
- dados-br/melhores-momentos.json         -> vídeos automáticos GE TV / YouTube
- dados-br/melhores-momentos-manual.json  -> fallback manual prioritário
- dados-br/jogos-detalhes.json            -> estatísticas por jogo via ESPN summary

Não acessa internet. É seguro rodar em todo workflow.
"""
from __future__ import annotations

import datetime as dt
import json
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

BRT = dt.timezone(dt.timedelta(hours=-3))


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
    repl = str.maketrans("áàãâäéèêëíìîïóòõôöúùûüçñ", "aaaaaeeeeiiiiooooouuuucn")
    s = s.translate(repl)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def chave_texto(valor: Any) -> str:
    return norm(valor).replace(" ", "-")


def nome_time(obj: Any) -> str:
    if isinstance(obj, dict):
        return str(obj.get("nome") or "")
    return str(obj or "")


def chave_jogo(jogo: Dict[str, Any]) -> str:
    rodada = jogo.get("rodada") or ""
    mand = nome_time(jogo.get("mandante"))
    vist = nome_time(jogo.get("visitante"))
    return f"rodada-{rodada}-{chave_texto(mand)}-{chave_texto(vist)}"


def iter_videos(data: Dict[str, Any]) -> Iterable[Tuple[str, Dict[str, Any]]]:
    jogos = data.get("jogos") or {}
    if isinstance(jogos, dict):
        for k, v in jogos.items():
            if isinstance(v, dict):
                yield str(k), v


def indexar_videos(*fontes: Dict[str, Any]) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    por_id: Dict[str, Dict[str, Any]] = {}
    por_chave: Dict[str, Dict[str, Any]] = {}
    # A ordem das fontes importa: se o manual vier por último, ele substitui o automático.
    for fonte in fontes:
        for k, reg in iter_videos(fonte):
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


def stats_do_jogo(jogo: Dict[str, Any], detalhes: Dict[str, Any]) -> List[Dict[str, Any]]:
    jogos = detalhes.get("jogos") or {}
    event_id = str(jogo.get("event_id") or jogo.get("id") or "").strip()
    det = jogos.get(event_id) if event_id else None
    if not isinstance(det, dict):
        return []
    stats = det.get("stats") or det.get("estatisticas") or []
    if not isinstance(stats, list):
        return []
    return [s for s in stats if isinstance(s, dict) and (s.get("home") not in (None, "") or s.get("away") not in (None, ""))]


def jogo_resumido(j: Dict[str, Any], motivo: str = "") -> Dict[str, Any]:
    item = {
        "event_id": str(j.get("event_id") or j.get("id") or ""),
        "rodada": j.get("rodada"),
        "mandante": nome_time(j.get("mandante")),
        "visitante": nome_time(j.get("visitante")),
        "placar_mandante": j.get("placar_mandante"),
        "placar_visitante": j.get("placar_visitante"),
        "data_iso": j.get("data_iso"),
    }
    if motivo:
        item["motivo"] = motivo
    return item


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser(description="Gera auditoria de cobertura de melhores momentos e estatísticas na aba Resultados.")
    ap.add_argument("--root", default=".")
    ap.add_argument("--saida", default="dados-br/auditoria-cobertura-resultados.json")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    resultados = load_json(root / "resultados.json", {"resultados": []})
    auto = load_json(root / "dados-br" / "melhores-momentos.json", {"jogos": {}})
    manual = load_json(root / "dados-br" / "melhores-momentos-manual.json", {"jogos": {}})
    detalhes = load_json(root / "dados-br" / "jogos-detalhes.json", {"jogos": {}})

    jogos = resultados.get("resultados") or []
    if not isinstance(jogos, list):
        jogos = []

    auto_id, auto_ch = indexar_videos(auto)
    manual_id, manual_ch = indexar_videos(manual)
    # Para a cobertura, manual tem prioridade sobre automático.
    todos_id = dict(auto_id)
    todos_id.update(manual_id)
    todos_ch = dict(auto_ch)
    todos_ch.update(manual_ch)

    total = len(jogos)
    com_video = []
    sem_video = []
    com_stats = []
    sem_stats = []
    por_rodada: Dict[str, Dict[str, int]] = {}

    for j in jogos:
        r = str(j.get("rodada") or "?")
        por_rodada.setdefault(r, {"jogos": 0, "com_video": 0, "sem_video": 0, "com_estatisticas": 0, "sem_estatisticas": 0})
        por_rodada[r]["jogos"] += 1

        video = video_do_jogo(j, todos_id, todos_ch)
        if video:
            com_video.append(jogo_resumido(j))
            por_rodada[r]["com_video"] += 1
        else:
            sem_video.append(jogo_resumido(j, "sem melhores momentos vinculado"))
            por_rodada[r]["sem_video"] += 1

        stats = stats_do_jogo(j, detalhes)
        if stats:
            item = jogo_resumido(j)
            item["estatisticas"] = len(stats)
            com_stats.append(item)
            por_rodada[r]["com_estatisticas"] += 1
        else:
            sem_stats.append(jogo_resumido(j, "sem estatísticas ESPN summary"))
            por_rodada[r]["sem_estatisticas"] += 1

    saida = {
        "atualizado_em": agora_iso(),
        "fonte": "auditoria local do site",
        "resumo": {
            "jogos_resultados": total,
            "melhores_momentos_automaticos": len(auto_id),
            "melhores_momentos_manuais": len(manual_id),
            "jogos_com_melhores_momentos": len(com_video),
            "jogos_sem_melhores_momentos": len(sem_video),
            "jogos_com_estatisticas": len(com_stats),
            "jogos_sem_estatisticas": len(sem_stats),
            "percentual_video": round((len(com_video) / total * 100), 1) if total else 0,
            "percentual_estatisticas": round((len(com_stats) / total * 100), 1) if total else 0,
        },
        "por_rodada": dict(sorted(por_rodada.items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else 999)),
        "jogos_sem_melhores_momentos": sorted(sem_video, key=lambda x: (x.get("rodada") or 999, x.get("mandante") or "")),
        "jogos_sem_estatisticas": sorted(sem_stats, key=lambda x: (x.get("rodada") or 999, x.get("mandante") or "")),
    }

    if args.dry_run:
        print(json.dumps(saida["resumo"], ensure_ascii=False, indent=2))
        return 0
    save_json(root / args.saida, saida)
    print("Auditoria de cobertura gerada:", args.saida)
    print(json.dumps(saida["resumo"], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
