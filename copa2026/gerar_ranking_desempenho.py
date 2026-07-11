#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Gera copa2026/dados/ranking-desempenho.json.

Ranking de Desempenho — metodologia própria do site:
- Usa dados detalhados dos jogos já coletados do ESPN summary.
- Usa gols/cartões consolidados de estatisticas.json.
- Não inventa xG, grandes chances ou métricas ausentes.
- Normaliza métricas por torneio, aplica corte de extremos e ajuste por amostra pequena.
- A situação (classificada/eliminada/em disputa) é contextual e NÃO entra no índice.
"""

from __future__ import annotations

import json
import math
import re
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

BASE = Path(__file__).resolve().parent
DADOS = BASE / "dados"
OUT = DADOS / "ranking-desempenho.json"

SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260719&limit=200"

PESOS_GRUPOS = {
    "ataque": 0.35,
    "dominio": 0.25,
    "defesa": 0.25,
    "eficiencia": 0.10,
    "disciplina": 0.05,
}

# nome normalizado -> chave interna
METRICAS = {
    "posse": "posse",
    "possession": "posse",
    "possession pct": "posse",

    "finalizacoes": "finalizacoes",
    "finalizações": "finalizacoes",
    "total shots": "finalizacoes",

    "chutes no gol": "chutes_gol",
    "shots on goal": "chutes_gol",
    "shots on target": "chutes_gol",

    "chutes bloqueados": "chutes_bloqueados",
    "blocked shots": "chutes_bloqueados",

    "escanteios": "escanteios",
    "corner kicks": "escanteios",
    "corners": "escanteios",

    "faltas": "faltas",
    "fouls": "faltas",
    "fouls committed": "faltas",

    "amarelos": "amarelos",
    "yellow cards": "amarelos",

    "vermelhos": "vermelhos",
    "red cards": "vermelhos",

    "impedimentos": "impedimentos",
    "offsides": "impedimentos",

    "defesas": "defesas",
    "saves": "defesas",

    "passes certos": "passes_certos",
    "accurate passes": "passes_certos",

    "precisao de passe": "precisao_passe",
    "precisão de passe": "precisao_passe",
    "pass pct": "precisao_passe",
    "pass accuracy": "precisao_passe",

    "xg": "xg",
    "expected goals": "xg",

    "grandes chances": "grandes_chances",
    "big chances created": "grandes_chances",
}

def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default

def dump_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def norm(s: Any) -> str:
    import unicodedata
    s = str(s or "").strip().lower()
    s = "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", s).strip()

def nome_metrica(s: Any) -> str:
    n = norm(s)
    return METRICAS.get(n, n.replace(" ", "_"))

def numero(v: Any) -> Optional[float]:
    if v is None:
        return None
    s = str(v).strip()
    if not s or s in {"—", "-", "None", "null"}:
        return None
    s = s.replace("%", "").replace(",", ".")
    s = re.sub(r"[^0-9.\-]", "", s)
    if not s or s in {"-", ".", "-."}:
        return None
    try:
        return float(s)
    except Exception:
        return None

def pct(v: Any) -> Optional[float]:
    return numero(v)

def safe_div(a: float, b: float) -> Optional[float]:
    if b is None or abs(b) < 1e-12:
        return None
    return a / b

def pctl(vals: List[float], q: float) -> float:
    if not vals:
        return 0.0
    vals = sorted(vals)
    if len(vals) == 1:
        return vals[0]
    pos = (len(vals) - 1) * q
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return vals[lo]
    return vals[lo] * (hi - pos) + vals[hi] * (pos - lo)

def normalizar_metricas(rows: List[Dict[str, Any]], specs: List[Tuple[str, str, bool, float]]) -> Dict[str, Dict[str, float]]:
    """
    specs: (campo, nome_saida, maior_melhor, peso)
    Retorna por equipe: nome_saida -> score 0-100.
    Usa winsorização 5%-95%.
    """
    out: Dict[str, Dict[str, float]] = defaultdict(dict)
    for campo, nome_saida, maior_melhor, peso in specs:
        vals = [float(r[campo]) for r in rows if isinstance(r.get(campo), (int, float)) and math.isfinite(float(r[campo]))]
        if not vals:
            continue
        lo = pctl(vals, 0.05)
        hi = pctl(vals, 0.95)
        if abs(hi - lo) < 1e-9:
            for r in rows:
                if isinstance(r.get(campo), (int, float)):
                    out[r["equipe"]][nome_saida] = 50.0
            continue
        for r in rows:
            v = r.get(campo)
            if not isinstance(v, (int, float)) or not math.isfinite(float(v)):
                continue
            x = max(lo, min(hi, float(v)))
            z = (x - lo) / (hi - lo)
            score = z * 100.0 if maior_melhor else (1.0 - z) * 100.0
            out[r["equipe"]][nome_saida] = round(score, 4)
    return out

def media_ponderada(vals: Iterable[Tuple[Optional[float], float]]) -> Optional[float]:
    total = 0.0
    peso = 0.0
    for v, w in vals:
        if v is None:
            continue
        try:
            if not math.isfinite(float(v)):
                continue
        except Exception:
            continue
        total += float(v) * float(w)
        peso += float(w)
    if peso <= 0:
        return None
    return total / peso

def ajustar_amostra(score: Optional[float], jogos: int) -> float:
    # Suavização empírica: poucos jogos puxam para 50.
    if score is None:
        return 50.0
    peso = jogos / (jogos + 2.0) if jogos > 0 else 0.0
    return 50.0 * (1.0 - peso) + float(score) * peso

def fetch_scoreboard() -> List[Dict[str, Any]]:
    try:
        req = urllib.request.Request(SCOREBOARD_URL + "&_=" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S"),
                                     headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data.get("events") or []
    except Exception:
        return []

def team_sig(c: Dict[str, Any]) -> str:
    t = c.get("team") or {}
    return str(t.get("abbreviation") or t.get("shortDisplayName") or t.get("displayName") or "").strip().upper()

def score_num(v: Any) -> Optional[int]:
    n = numero(v)
    if n is None:
        return None
    return int(n)

def penalty_num(c: Dict[str, Any]) -> Optional[int]:
    for key in ("shootoutScore", "shootoutDisplayScore", "penaltyScore", "penalties", "shootout"):
        if key in c:
            n = score_num(c.get(key))
            if n is not None:
                return n
    return None

def extrair_scoreboard(events: List[Dict[str, Any]]) -> Tuple[Dict[str, Dict[str, int]], Dict[str, str], Dict[str, float]]:
    gols = defaultdict(lambda: {"pro": 0, "contra": 0, "jogos": 0, "vitorias": 0, "empates": 0, "derrotas": 0, "pontos": 0})
    event_teams = set()
    ativos = set()
    vencedores_mata = set()
    perdedores_mata = set()
    campeao_final = ""
    situacao: Dict[str, str] = {}
    ultimo_ts: Dict[str, float] = {}
    tem_mata = False

    for ev in events:
        comp = (ev.get("competitions") or [{}])[0]
        cs = comp.get("competitors") or []
        if len(cs) < 2:
            continue
        home = next((c for c in cs if c.get("homeAway") == "home"), cs[0])
        away = next((c for c in cs if c.get("homeAway") == "away"), cs[1])
        h, a = team_sig(home), team_sig(away)
        if not h or not a:
            continue

        event_teams.update([h, a])
        st = (((comp.get("status") or {}).get("type") or {}).get("state") or "pre").lower()
        slug = ((ev.get("season") or {}).get("slug") or "").lower()
        if slug and slug != "group-stage":
            tem_mata = True

        dt = ev.get("date") or ""
        try:
            ts = datetime.fromisoformat(dt.replace("Z", "+00:00")).timestamp()
        except Exception:
            ts = 0.0
        for sig in (h, a):
            ultimo_ts[sig] = max(ultimo_ts.get(sig, 0), ts)

        if st in {"pre", "in"}:
            ativos.update([h, a])

        if st == "post":
            hs, ass = score_num(home.get("score")), score_num(away.get("score"))
            if hs is not None and ass is not None:
                gols[h]["pro"] += hs; gols[h]["contra"] += ass; gols[h]["jogos"] += 1
                gols[a]["pro"] += ass; gols[a]["contra"] += hs; gols[a]["jogos"] += 1
                if hs > ass:
                    gols[h]["vitorias"] += 1; gols[h]["pontos"] += 3
                    gols[a]["derrotas"] += 1
                elif ass > hs:
                    gols[a]["vitorias"] += 1; gols[a]["pontos"] += 3
                    gols[h]["derrotas"] += 1
                else:
                    gols[h]["empates"] += 1; gols[a]["empates"] += 1
                    gols[h]["pontos"] += 1; gols[a]["pontos"] += 1

            if slug and slug != "group-stage":
                winner = ""
                if home.get("winner"): winner = h
                elif away.get("winner"): winner = a
                elif hs is not None and ass is not None and hs != ass:
                    winner = h if hs > ass else a
                elif hs is not None and ass is not None and hs == ass:
                    pen_h, pen_a = penalty_num(home), penalty_num(away)
                    if pen_h is not None and pen_a is not None and pen_h != pen_a:
                        winner = h if pen_h > pen_a else a
                if winner:
                    loser = a if winner == h else h
                    vencedores_mata.add(winner)
                    perdedores_mata.add(loser)
                    if slug == "final":
                        campeao_final = winner

    # Situação contextual simplificada para o site:
    # - Em disputa: seleção ainda viva no mata-mata ou com jogo futuro/ao vivo.
    # - Eliminada: seleção derrotada ou fora da fase viva.
    # - Campeã: somente a seleção vencedora da final encerrada.
    for sig in event_teams:
        situacao[sig] = "Eliminada" if tem_mata else "Em disputa"
    for sig in vencedores_mata:
        situacao[sig] = "Em disputa"
    for sig in perdedores_mata:
        situacao[sig] = "Eliminada"
    for sig in ativos:
        situacao[sig] = "Em disputa"
    if campeao_final:
        situacao[campeao_final] = "Campeã"

    return dict(gols), situacao, ultimo_ts

def main() -> int:
    selecoes = load_json(DADOS / "selecoes.json", {}).get("selecoes", [])
    detalhes = load_json(DADOS / "jogos-detalhes.json", {})
    estat = load_json(DADOS / "estatisticas.json", {})

    nome_de = {s.get("id"): s.get("nome", s.get("id")) for s in selecoes if s.get("id")}
    grupo_de = {s.get("id"): s.get("grupo", "") for s in selecoes if s.get("id")}

    base = {}
    for sid in nome_de:
        base[sid] = {
            "equipe": sid,
            "nome": nome_de.get(sid, sid),
            "grupo": grupo_de.get(sid, ""),
            "jogos_stats": 0,
            "somas": defaultdict(float),
            "somas_contra": defaultdict(float),
        }

    # Gols/cartões consolidados
    por_sel = {}
    for x in estat.get("por_selecao") or []:
        eq = str(x.get("equipe") or "").upper()
        if eq:
            por_sel[eq] = x
            base.setdefault(eq, {"equipe": eq, "nome": nome_de.get(eq, eq), "grupo": grupo_de.get(eq, ""), "jogos_stats": 0, "somas": defaultdict(float), "somas_contra": defaultdict(float)})

    jogos = (detalhes.get("jogos") or {})
    if isinstance(jogos, list):
        iterable = jogos
    else:
        iterable = jogos.values()

    for j in iterable:
        h = str(j.get("home") or "").upper()
        a = str(j.get("away") or "").upper()
        if not h or not a:
            continue
        base.setdefault(h, {"equipe": h, "nome": nome_de.get(h, h), "grupo": grupo_de.get(h, ""), "jogos_stats": 0, "somas": defaultdict(float), "somas_contra": defaultdict(float)})
        base.setdefault(a, {"equipe": a, "nome": nome_de.get(a, a), "grupo": grupo_de.get(a, ""), "jogos_stats": 0, "somas": defaultdict(float), "somas_contra": defaultdict(float)})
        mapa = {}
        for st in j.get("stats") or []:
            k = nome_metrica(st.get("nome"))
            vh, va = numero(st.get("home")), numero(st.get("away"))
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

    # Scoreboard é opcional: melhora gols contra, pontos e situação.
    gols_score, situacao_score, _ultimo = extrair_scoreboard(fetch_scoreboard())

    rows = []
    for eq, b in base.items():
        jogos_stats = int(b.get("jogos_stats") or 0)
        ps = por_sel.get(eq, {})
        jogos_oficiais = int(ps.get("jogos") or jogos_stats or gols_score.get(eq, {}).get("jogos") or 0)
        if jogos_oficiais <= 0 and jogos_stats <= 0:
            continue
        jogos_base = max(jogos_oficiais, jogos_stats, 1)

        def avg(k: str) -> Optional[float]:
            if jogos_stats <= 0:
                return None
            return b["somas"].get(k, 0.0) / jogos_stats

        def avgc(k: str) -> Optional[float]:
            if jogos_stats <= 0:
                return None
            return b["somas_contra"].get(k, 0.0) / jogos_stats

        gols_pro = int(ps.get("gols") or gols_score.get(eq, {}).get("pro") or 0)
        gols_contra_val = gols_score.get(eq, {}).get("contra")
        pontos = gols_score.get(eq, {}).get("pontos")
        jogos_score = gols_score.get(eq, {}).get("jogos") or 0

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
            "situacao": situacao_score.get(eq, "Em disputa"),
        }
        row["aproveitamento_chutes"] = safe_div(row["chutes_gol_jogo"] or 0.0, row["finalizacoes_jogo"] or 0.0)
        row["conversao_gols_chute_gol"] = safe_div(row["gols_jogo"] or 0.0, row["chutes_gol_jogo"] or 0.0)
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

    norm_scores = normalizar_metricas(rows, specs)

    # Pesos internos por grupo
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
            comps[grupo] = ajustar_amostra(media_ponderada([(ns.get(k), w) for k, w in itens]), int(r["jogos"] or 0))
        final = media_ponderada([(comps[g], PESOS_GRUPOS[g]) for g in PESOS_GRUPOS]) or 50.0
        r["ataque"] = round(comps["ataque"], 1)
        r["dominio"] = round(comps["dominio"], 1)
        r["defesa"] = round(comps["defesa"], 1)
        r["eficiencia"] = round(comps["eficiencia"], 1)
        r["disciplina"] = round(comps["disciplina"], 1)
        r["indice_final"] = round(final, 1)

        # Arredondamentos limpos para exibição.
        for k, v in list(r.items()):
            if isinstance(v, float):
                if math.isfinite(v):
                    r[k] = round(v, 2)
                else:
                    r[k] = None
        ranking.append(r)

    ranking.sort(key=lambda x: (
        -(x.get("indice_final") or 0),
        -(x.get("ataque") or 0),
        -(x.get("dominio") or 0),
        x.get("nome") or x.get("equipe")
    ))
    for i, r in enumerate(ranking, 1):
        r["posicao"] = i

    metricas_presentes = sorted({
        nome_metrica(st.get("nome"))
        for j in iterable if isinstance(j, dict)
        for st in (j.get("stats") or [])
    })

    out = {
        "_comentario": "Ranking de Desempenho gerado automaticamente. Metodologia própria, não oficial. Situação não entra no índice.",
        "fonte": "ESPN summary consolidado em jogos-detalhes.json + estatisticas.json do site",
        "atualizado_em": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "ranking_nome": "Ranking de Desempenho",
        "escala": "0 a 100",
        "pesos": {
            "ataque": "35%",
            "dominio": "25%",
            "defesa": "25%",
            "eficiencia": "10%",
            "disciplina": "5%",
        },
        "observacoes": [
            "O índice usa médias por jogo, não somas brutas.",
            "Métricas ausentes no feed da ESPN não são inventadas; os pesos são redistribuídos entre as métricas disponíveis.",
            "A classificação/eliminaçao é exibida como contexto e não compõe o índice.",
            "Times com poucos jogos recebem suavização estatística para reduzir distorções por amostra pequena.",
            "xG e grandes chances entram automaticamente se estiverem presentes no ESPN summary."
        ],
        "metricas_disponiveis": metricas_presentes,
        "total_selecoes": len(ranking),
        "ranking": ranking,
    }
    dump_json(OUT, out)
    print(f"OK: {OUT} gerado com {len(ranking)} seleções.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
