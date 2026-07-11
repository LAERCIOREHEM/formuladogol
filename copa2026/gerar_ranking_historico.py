#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Gera copa2026/dados/ranking-selecoes-historico.json.

Histórico vivo do Ranking de Desempenho da Copa.
- Reaproveita a MESMA metodologia do ranking-desempenho.py.
- Cria snapshots por marco:
  após 1º jogo, 2º jogo, 3º jogo, 2ª fase, oitavas, quartas, semifinal e final.
- As fases de mata-mata são "vivas": a cada jogo encerrado, o snapshot parcial é atualizado.
- Snapshots já fechados não dependem de cálculo no navegador.
"""

from __future__ import annotations

import json
import math
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

BASE = Path(__file__).resolve().parent
DADOS = BASE / "dados"
OUT = DADOS / "ranking-selecoes-historico.json"

try:
    import gerar_ranking_desempenho as gr
except Exception as exc:
    print(f"ERRO: não foi possível importar gerar_ranking_desempenho.py: {exc}", file=sys.stderr)
    raise

STAGES = [
    ("apos-1-jogo", "Após 1º jogo", "group-stage", 1),
    ("apos-2-jogo", "Após 2º jogo", "group-stage", 2),
    ("apos-3-jogo", "Após 3º jogo", "group-stage", 3),
    ("segunda-fase", "2ª fase", "round-of-32", None),
    ("oitavas", "Oitavas", "round-of-16", None),
    ("quartas", "Quartas", "quarterfinals", None),
    ("semifinal", "Semifinal", "semifinals", None),
    ("final", "Final", "final", None),
]

PHASE_ORDER = {
    "group-stage": 1,
    "round-of-32": 2,
    "round-of-16": 3,
    "quarterfinals": 4,
    "semifinals": 5,
    "third-place": 6,
    "final": 7,
}

PHASE_LABEL = {
    "group-stage": "Fase de grupos",
    "round-of-32": "2ª fase",
    "round-of-16": "Oitavas",
    "quarterfinals": "Quartas",
    "semifinals": "Semifinal",
    "third-place": "Disputa de 3º",
    "final": "Final",
}

def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default

def dump_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def event_id(ev: Dict[str, Any]) -> str:
    return str(ev.get("id") or ev.get("uid") or "").strip()

def event_slug(ev: Dict[str, Any]) -> str:
    return str(((ev.get("season") or {}).get("slug") or "group-stage")).strip().lower() or "group-stage"

def event_state(ev: Dict[str, Any]) -> str:
    comp = (ev.get("competitions") or [{}])[0]
    return str((((comp.get("status") or {}).get("type") or {}).get("state") or "pre")).strip().lower()

def event_date_ts(ev: Dict[str, Any]) -> float:
    dt = ev.get("date") or ""
    try:
        return datetime.fromisoformat(dt.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0

def event_teams(ev: Dict[str, Any]) -> Tuple[str, str]:
    comp = (ev.get("competitions") or [{}])[0]
    cs = comp.get("competitors") or []
    if len(cs) < 2:
        return "", ""
    home = next((c for c in cs if c.get("homeAway") == "home"), cs[0])
    away = next((c for c in cs if c.get("homeAway") == "away"), cs[1])
    return gr.team_sig(home), gr.team_sig(away)

def score_pair(ev: Dict[str, Any]) -> Tuple[Optional[int], Optional[int]]:
    comp = (ev.get("competitions") or [{}])[0]
    cs = comp.get("competitors") or []
    if len(cs) < 2:
        return None, None
    home = next((c for c in cs if c.get("homeAway") == "home"), cs[0])
    away = next((c for c in cs if c.get("homeAway") == "away"), cs[1])
    return gr.score_num(home.get("score")), gr.score_num(away.get("score"))

def penalty_pair(ev: Dict[str, Any]) -> Tuple[Optional[int], Optional[int]]:
    comp = (ev.get("competitions") or [{}])[0]
    cs = comp.get("competitors") or []
    if len(cs) < 2:
        return None, None
    home = next((c for c in cs if c.get("homeAway") == "home"), cs[0])
    away = next((c for c in cs if c.get("homeAway") == "away"), cs[1])
    return gr.penalty_num(home), gr.penalty_num(away)

def winner_loser(ev: Dict[str, Any]) -> Tuple[str, str]:
    h, a = event_teams(ev)
    if not h or not a:
        return "", ""
    comp = (ev.get("competitions") or [{}])[0]
    cs = comp.get("competitors") or []
    home = next((c for c in cs if c.get("homeAway") == "home"), cs[0])
    away = next((c for c in cs if c.get("homeAway") == "away"), cs[1])
    if home.get("winner"):
        return h, a
    if away.get("winner"):
        return a, h
    hs, ass = score_pair(ev)
    if hs is not None and ass is not None and hs != ass:
        return (h, a) if hs > ass else (a, h)
    if hs is not None and ass is not None and hs == ass:
        pen_h, pen_a = penalty_pair(ev)
        if pen_h is not None and pen_a is not None and pen_h != pen_a:
            return ((h, a) if pen_h > pen_a else (a, h))
    return "", ""

def detalhes_iter(detalhes: Dict[str, Any]) -> List[Dict[str, Any]]:
    jogos = detalhes.get("jogos") or {}
    if isinstance(jogos, list):
        return [j for j in jogos if isinstance(j, dict)]
    return [j for j in jogos.values() if isinstance(j, dict)]

def detalhe_id(j: Dict[str, Any]) -> str:
    return str(j.get("event_id") or j.get("id") or "").strip()

def eventos_ordenados(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted([e for e in events if isinstance(e, dict)], key=lambda e: (event_date_ts(e), event_id(e)))

def compute_status(selecoes_ids: List[str], events: List[Dict[str, Any]], target_slug: str, included_ids: Set[str]) -> Dict[str, str]:
    status = {s: "Em disputa" for s in selecoes_ids if s}

    # Se já existe mata-mata no recorte, quem perde jogo de mata encerrado sai.
    for ev in eventos_ordenados(events):
        eid = event_id(ev)
        slug = event_slug(ev)
        if eid not in included_ids or event_state(ev) != "post":
            continue
        if PHASE_ORDER.get(slug, 1) <= 1:
            continue
        win, lose = winner_loser(ev)
        if lose:
            status[lose] = "Eliminada"
        if win and status.get(win) != "Eliminada":
            status[win] = "Campeã" if slug == "final" else "Em disputa"

    # Jogos pendentes/ao vivo da fase selecionada sinalizam disputa viva.
    for ev in eventos_ordenados(events):
        if event_slug(ev) != target_slug:
            continue
        st = event_state(ev)
        if st not in {"pre", "in"}:
            continue
        for sig in event_teams(ev):
            if not sig:
                continue
            status[sig] = "Em disputa"

    # Em fases de mata-mata, quem não está na fase atual e não está classificado
    # depois de um mata anterior fica como eliminado para contexto visual.
    if PHASE_ORDER.get(target_slug, 1) > 1:
        participantes_target = set()
        for ev in events:
            if event_slug(ev) == target_slug:
                participantes_target.update([x for x in event_teams(ev) if x])
        for sig in selecoes_ids:
            if sig not in participantes_target and status.get(sig) == "Em disputa":
                status[sig] = "Eliminada"

    return status

def ranking_para_snapshot(
    selecoes: List[Dict[str, Any]],
    detalhes_all: List[Dict[str, Any]],
    events: List[Dict[str, Any]],
    included_ids: Set[str],
    target_slug: str,
) -> List[Dict[str, Any]]:
    nome_de = {s.get("id"): s.get("nome", s.get("id")) for s in selecoes if s.get("id")}
    grupo_de = {s.get("id"): s.get("grupo", "") for s in selecoes if s.get("id")}
    selecoes_ids = [s.get("id") for s in selecoes if s.get("id")]

    detalhes = [j for j in detalhes_all if detalhe_id(j) in included_ids]
    events_post = [ev for ev in events if event_id(ev) in included_ids and event_state(ev) == "post"]
    gols_score, _situacao_score, _ultimo = gr.extrair_scoreboard(events_post)
    status_ctx = compute_status(selecoes_ids, events, target_slug, included_ids)

    base: Dict[str, Any] = {}
    for sid in nome_de:
        base[sid] = {
            "equipe": sid,
            "nome": nome_de.get(sid, sid),
            "grupo": grupo_de.get(sid, ""),
            "jogos_stats": 0,
            "somas": defaultdict(float),
            "somas_contra": defaultdict(float),
        }

    for j in detalhes:
        h = str(j.get("home") or "").upper()
        a = str(j.get("away") or "").upper()
        if not h or not a:
            continue
        base.setdefault(h, {"equipe": h, "nome": nome_de.get(h, h), "grupo": grupo_de.get(h, ""), "jogos_stats": 0, "somas": defaultdict(float), "somas_contra": defaultdict(float)})
        base.setdefault(a, {"equipe": a, "nome": nome_de.get(a, a), "grupo": grupo_de.get(a, ""), "jogos_stats": 0, "somas": defaultdict(float), "somas_contra": defaultdict(float)})
        mapa = {}
        for st in j.get("stats") or []:
            k = gr.nome_metrica(st.get("nome"))
            vh, va = gr.numero(st.get("home")), gr.numero(st.get("away"))
            if vh is None and va is None:
                continue
            mapa[k] = (vh, va)
        if not mapa:
            continue
        base[h]["jogos_stats"] += 1
        base[a]["jogos_stats"] += 1
        for k, (vh, va) in mapa.items():
            if vh is not None:
                base[h]["somas"][k] += vh
                base[a]["somas_contra"][k] += vh
            if va is not None:
                base[a]["somas"][k] += va
                base[h]["somas_contra"][k] += va

    rows = []
    for eq, b in base.items():
        jogos_stats = int(b.get("jogos_stats") or 0)
        jogos_score = int(gols_score.get(eq, {}).get("jogos") or 0)
        jogos_base = max(jogos_score, jogos_stats, 0)
        if jogos_base <= 0:
            continue

        def avg(k: str) -> Optional[float]:
            if jogos_stats <= 0:
                return None
            return b["somas"].get(k, 0.0) / jogos_stats

        def avgc(k: str) -> Optional[float]:
            if jogos_stats <= 0:
                return None
            return b["somas_contra"].get(k, 0.0) / jogos_stats

        gols_pro = int(gols_score.get(eq, {}).get("pro") or 0)
        gols_contra_val = gols_score.get(eq, {}).get("contra")
        pontos = gols_score.get(eq, {}).get("pontos")

        finalizacoes = avg("finalizacoes")
        chutes_gol = avg("chutes_gol")
        finalizacoes_c = avgc("finalizacoes")
        chutes_gol_c = avgc("chutes_gol")
        gols_jogo = gols_pro / jogos_base if jogos_base else 0.0
        gols_contra_jogo = (gols_contra_val / jogos_score) if gols_contra_val is not None and jogos_score else None

        row = {
            "equipe": eq,
            "nome": nome_de.get(eq, b.get("nome", eq)),
            "grupo": grupo_de.get(eq, b.get("grupo", "")),
            "jogos": jogos_base,
            "jogos_com_estatisticas": jogos_stats,
            "gols_pro": gols_pro,
            "gols_contra": gols_contra_val if gols_contra_val is not None else None,
            "gols_jogo": gols_jogo,
            "gols_contra_jogo": gols_contra_jogo,
            "pontos_jogo": (pontos / jogos_score) if pontos is not None and jogos_score else None,
            "posse_media": avg("posse"),
            "precisao_passe": avg("precisao_passe"),
            "passes_certos_jogo": avg("passes_certos"),
            "finalizacoes_jogo": finalizacoes,
            "finalizacoes_contra_jogo": finalizacoes_c,
            "saldo_finalizacoes_jogo": (finalizacoes - finalizacoes_c) if finalizacoes is not None and finalizacoes_c is not None else None,
            "chutes_gol_jogo": chutes_gol,
            "chutes_gol_contra_jogo": chutes_gol_c,
            "saldo_chutes_gol_jogo": (chutes_gol - chutes_gol_c) if chutes_gol is not None and chutes_gol_c is not None else None,
            "chutes_bloqueados_jogo": avg("chutes_bloqueados"),
            "escanteios_jogo": avg("escanteios"),
            "escanteios_contra_jogo": avgc("escanteios"),
            "faltas_jogo": avg("faltas"),
            "amarelos_jogo": avg("amarelos"),
            "vermelhos_jogo": avg("vermelhos"),
            "defesas_jogo": avg("defesas"),
            "xg_jogo": avg("xg"),
            "xg_contra_jogo": avgc("xg"),
            "grandes_chances_jogo": avg("grandes_chances"),
            "grandes_chances_contra_jogo": avgc("grandes_chances"),
            "situacao": status_ctx.get(eq, "Em disputa"),
        }
        row["aproveitamento_chutes"] = gr.safe_div(row["chutes_gol_jogo"] or 0.0, row["finalizacoes_jogo"] or 0.0)
        row["conversao_gols_chute_gol"] = gr.safe_div(row["gols_jogo"] or 0.0, row["chutes_gol_jogo"] or 0.0)
        rows.append(row)

    specs = [
        ("gols_jogo", "n_gols_jogo", True, 1.0),
        ("finalizacoes_jogo", "n_finalizacoes", True, 1.0),
        ("chutes_gol_jogo", "n_chutes_gol", True, 1.0),
        ("escanteios_jogo", "n_escanteios", True, 0.5),
        ("xg_jogo", "n_xg", True, 1.2),
        ("grandes_chances_jogo", "n_grandes_chances", True, 1.0),
        ("posse_media", "n_posse", True, 1.0),
        ("precisao_passe", "n_precisao_passe", True, 0.8),
        ("passes_certos_jogo", "n_passes_certos", True, 0.5),
        ("saldo_finalizacoes_jogo", "n_saldo_finalizacoes", True, 1.2),
        ("saldo_chutes_gol_jogo", "n_saldo_chutes_gol", True, 1.4),
        ("gols_contra_jogo", "n_gols_contra", False, 1.4),
        ("finalizacoes_contra_jogo", "n_finalizacoes_contra", False, 1.0),
        ("chutes_gol_contra_jogo", "n_chutes_gol_contra", False, 1.3),
        ("escanteios_contra_jogo", "n_escanteios_contra", False, 0.6),
        ("xg_contra_jogo", "n_xg_contra", False, 1.4),
        ("grandes_chances_contra_jogo", "n_grandes_chances_contra", False, 1.0),
        ("aproveitamento_chutes", "n_aproveitamento_chutes", True, 1.0),
        ("conversao_gols_chute_gol", "n_conversao", True, 1.0),
        ("pontos_jogo", "n_pontos_jogo", True, 0.6),
        ("faltas_jogo", "n_faltas", False, 0.7),
        ("amarelos_jogo", "n_amarelos", False, 1.0),
        ("vermelhos_jogo", "n_vermelhos", False, 1.8),
    ]

    norm_scores = gr.normalizar_metricas(rows, specs)
    pesos_metricas = {
        "ataque": [
            ("n_gols_jogo", 1.5), ("n_chutes_gol", 1.35), ("n_finalizacoes", 1.0),
            ("n_escanteios", 0.45), ("n_xg", 1.7), ("n_grandes_chances", 1.2),
        ],
        "dominio": [
            ("n_posse", 1.0), ("n_precisao_passe", 0.85), ("n_passes_certos", 0.55),
            ("n_saldo_finalizacoes", 1.35), ("n_saldo_chutes_gol", 1.55),
        ],
        "defesa": [
            ("n_gols_contra", 1.5), ("n_chutes_gol_contra", 1.35), ("n_finalizacoes_contra", 1.0),
            ("n_escanteios_contra", 0.55), ("n_xg_contra", 1.7), ("n_grandes_chances_contra", 1.1),
        ],
        "eficiencia": [
            ("n_aproveitamento_chutes", 1.1), ("n_conversao", 1.1), ("n_pontos_jogo", 0.8),
        ],
        "disciplina": [
            ("n_faltas", 0.6), ("n_amarelos", 1.0), ("n_vermelhos", 1.6),
        ],
    }

    ranking = []
    for r in rows:
        ns = norm_scores.get(r["equipe"], {})
        comps = {}
        for grupo, itens in pesos_metricas.items():
            comps[grupo] = gr.ajustar_amostra(gr.media_ponderada([(ns.get(k), w) for k, w in itens]), int(r["jogos"] or 0))
        final = gr.media_ponderada([(comps[g], gr.PESOS_GRUPOS[g]) for g in gr.PESOS_GRUPOS]) or 50.0
        r["ataque"] = round(comps["ataque"], 1)
        r["dominio"] = round(comps["dominio"], 1)
        r["defesa"] = round(comps["defesa"], 1)
        r["eficiencia"] = round(comps["eficiencia"], 1)
        r["disciplina"] = round(comps["disciplina"], 1)
        r["indice_final"] = round(final, 1)
        for k, v in list(r.items()):
            if isinstance(v, float):
                r[k] = round(v, 2) if math.isfinite(v) else None
        ranking.append(r)

    ranking.sort(key=lambda x: (
        -(x.get("indice_final") or 0),
        -(x.get("ataque") or 0),
        -(x.get("dominio") or 0),
        x.get("nome") or x.get("equipe")
    ))
    for i, r in enumerate(ranking, 1):
        r["posicao"] = i
    return ranking

def group_snapshot_ids(events: List[Dict[str, Any]], n: int) -> Tuple[Set[str], bool, int]:
    count = defaultdict(int)
    ids: Set[str] = set()
    for ev in eventos_ordenados(events):
        if event_slug(ev) != "group-stage" or event_state(ev) != "post":
            continue
        h, a = event_teams(ev)
        if not h or not a:
            continue
        # Em Copa real, a rodada é sincronizada; esta trava evita passar muito do marco.
        if count[h] < n or count[a] < n:
            ids.add(event_id(ev))
            count[h] += 1
            count[a] += 1
    completos = sum(1 for _, c in count.items() if c >= n)
    fechado = completos >= 48
    return ids, fechado, completos

def phase_snapshot_ids(events: List[Dict[str, Any]], slug: str) -> Tuple[Set[str], bool, int, int]:
    target_order = PHASE_ORDER.get(slug, 99)
    ids = {
        event_id(ev) for ev in events
        if event_state(ev) == "post" and PHASE_ORDER.get(event_slug(ev), 99) <= target_order
    }
    fase_events = [ev for ev in events if event_slug(ev) == slug]
    feitos = sum(1 for ev in fase_events if event_state(ev) == "post")
    total = len(fase_events)
    fechado = total > 0 and feitos == total
    return ids, fechado, feitos, total


def fallback_events_from_detalhes(detalhes_all: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Fallback offline: monta eventos sintéticos a partir de jogos-detalhes.json.
    Serve para manter os snapshots funcionando mesmo se a ESPN falhar.
    As estatísticas detalhadas continuam sendo usadas; placares ficam ausentes.
    """
    ordered = sorted(detalhes_all, key=lambda j: (str(j.get("date") or ""), str(j.get("event_id") or "")))
    phase_by_index = []
    phase_by_index += ["group-stage"] * 72
    phase_by_index += ["round-of-32"] * 16
    phase_by_index += ["round-of-16"] * 8
    phase_by_index += ["quarterfinals"] * 4
    phase_by_index += ["semifinals"] * 2
    phase_by_index += ["third-place"] * 1
    phase_by_index += ["final"] * 1
    events = []
    for i, j in enumerate(ordered):
        h = str(j.get("home") or "").upper()
        a = str(j.get("away") or "").upper()
        if not h or not a:
            continue
        slug = phase_by_index[i] if i < len(phase_by_index) else "final"
        st = "post" if (j.get("stats") or []) else "pre"
        eid = str(j.get("event_id") or j.get("id") or f"fallback-{i}")
        events.append({
            "id": eid,
            "date": j.get("date") or "",
            "season": {"slug": slug},
            "competitions": [{
                "status": {"type": {"state": st}},
                "competitors": [
                    {"homeAway": "home", "team": {"abbreviation": h}, "score": None, "winner": False},
                    {"homeAway": "away", "team": {"abbreviation": a}, "score": None, "winner": False},
                ],
            }],
        })
    return events

def main() -> int:
    selecoes = load_json(DADOS / "selecoes.json", {}).get("selecoes", [])
    detalhes = load_json(DADOS / "jogos-detalhes.json", {})
    detalhes_all = detalhes_iter(detalhes)

    try:
        events = gr.fetch_scoreboard()
    except Exception as exc:
        print(f"Aviso: ESPN scoreboard indisponível para histórico: {exc}", file=sys.stderr)
        events = []
    if not events:
        events = fallback_events_from_detalhes(detalhes_all)
        if events:
            print(f"Aviso: usando fallback local por jogos-detalhes.json ({len(events)} eventos).", file=sys.stderr)

    ranking_atual = load_json(DADOS / "ranking-desempenho.json", {"ranking": []})
    snapshots = []
    if events:
        for ordem, (sid, nome, slug, group_n) in enumerate(STAGES, 1):
            if group_n:
                ids, fechado, completos = group_snapshot_ids(events, int(group_n))
                total = 48
                feitos = completos
                status = "fechado" if fechado else "parcial"
                desc = f"{completos}/48 seleções com {group_n} jogo(s) considerado(s)"
            else:
                ids, fechado, feitos, total = phase_snapshot_ids(events, slug)
                # Só mostra fase de mata que já começou ou já apareceu na tabela.
                if not total and not ids:
                    continue
                status = "fechado" if fechado else "parcial"
                desc = f"{feitos}/{total or 0} jogos da fase encerrados"
            if not ids:
                continue
            ranking = ranking_para_snapshot(selecoes, detalhes_all, events, ids, slug)
            if not ranking:
                continue
            snapshots.append({
                "id": sid,
                "nome": nome,
                "fase": PHASE_LABEL.get(slug, nome),
                "fase_slug": slug,
                "ordem": ordem,
                "status": status,
                "jogos_encerrados": feitos,
                "jogos_total_fase": total,
                "descricao": desc,
                "ranking": ranking,
            })

    # Fallback seguro: se não conseguiu montar histórico, publica uma foto atual
    # para a página nunca quebrar.
    if not snapshots and ranking_atual.get("ranking"):
        snapshots.append({
            "id": "atual",
            "nome": "Ranking atual",
            "fase": "Atual",
            "fase_slug": "atual",
            "ordem": 99,
            "status": "parcial",
            "jogos_encerrados": None,
            "jogos_total_fase": None,
            "descricao": "Fallback com o ranking atual porque o scoreboard não respondeu.",
            "ranking": ranking_atual.get("ranking", []),
        })

    out = {
        "_comentario": "Histórico vivo do Ranking de Desempenho. Usa a mesma metodologia do ranking-desempenho.json; fases de mata são atualizadas jogo a jogo.",
        "fonte": "gerar_ranking_historico.py + ranking-desempenho.py + ESPN scoreboard + jogos-detalhes.json",
        "atualizado_em": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "total_snapshots": len(snapshots),
        "snapshots": snapshots,
    }
    dump_json(OUT, out)
    print(f"OK: {OUT} gerado com {len(snapshots)} snapshots.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
