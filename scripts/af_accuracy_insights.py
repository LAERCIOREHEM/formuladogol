"""Indicadores de leitura pública da calibração do AF-Previsão.

Somente previsões pré-jogo já selecionadas pelo gerador histórico entram aqui.
A avaliação probabilística mantém três desfechos por partida, mas cada
jogo físico entra uma única vez nas métricas Top-1, Brier e Log Loss.
"""
from __future__ import annotations

import math
from collections import defaultdict
from typing import Any, Callable, Iterable, Mapping, Sequence

OUTCOMES = ("mandante", "empate", "visitante")
LABELS = {"mandante": "Vitória do mandante", "empate": "Empate", "visitante": "Vitória do visitante"}


def deduplicate_selected_games(rows: Sequence[Mapping[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Concilia IDs alternativos da mesma partida sem alterar o histórico SHA-256.

    No Brasileirão de pontos corridos, cada par ordenado mandante/visitante
    se enfrenta uma vez por temporada. O timestamp pré-jogo mais recente
    válido prevalece entre IDs que representem o mesmo confronto.
    """
    by_match: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        home = str(row.get("mandante") or "").strip().casefold()
        away = str(row.get("visitante") or "").strip().casefold()
        if not home or not away:
            continue
        key = (home, away)
        previous = by_match.get(key)
        score = (str(row.get("gerado_em_modelo") or ""), str(row.get("event_id") or ""))
        old_score = (
            (str(previous.get("gerado_em_modelo") or ""), str(previous.get("event_id") or ""))
            if previous else None
        )
        if previous is None or score > old_score:
            by_match[key] = dict(row)
    unique = sorted(by_match.values(), key=lambda r: (
        str(r.get("kickoff_factual") or ""), str(r.get("event_id") or "")
    ))
    return unique, max(0, len(rows) - len(unique))


def confidence_band(probabilities: Mapping[str, float]) -> str:
    values = sorted((float(probabilities[key]) for key in OUTCOMES), reverse=True)
    gap = values[0] - values[1]
    if gap < 10.0:
        return "aberto"
    return "favorito_claro" if values[0] >= 60.0 else "favoritismo_moderado"


def build_insights(
    selected: Sequence[Mapping[str, Any]],
    calibration_bins: Callable[[Iterable[tuple[float, int]]], list[dict[str, Any]]],
) -> dict[str, Any]:
    """Segmentação por confiança, calibração por desfecho e jogos exemplares.

    'Top-1' é acerto exato de resultado mais provável, não prova de calibração.
    'Brier' adota o mesmo divisor 3 utilizado no gerador histórico.
    """
    bands = {key: {"amostra": 0, "acertos": 0, "avaliaveis_top1": 0, "soma_probabilidade_top1": 0.0}
             for key in ("aberto", "favoritismo_moderado", "favorito_claro")}
    pairs: dict[str, list[tuple[float, int]]] = {key: [] for key in OUTCOMES}
    examples: list[dict[str, Any]] = []
    high_success: list[dict[str, Any]] = []
    high_surprise: list[dict[str, Any]] = []
    balanced: list[dict[str, Any]] = []
    valid = 0

    for row in selected:
        raw = row.get("probabilidades_pct") or {}
        try:
            p = {key: float(raw[key]) for key in OUTCOMES}
        except (KeyError, TypeError, ValueError):
            continue
        if any(not math.isfinite(v) or v < 0 or v > 100 for v in p.values()):
            continue
        if abs(sum(p.values()) - 100) > 0.05:
            continue
        observed = str(row.get("resultado_observado") or "")
        if observed not in OUTCOMES:
            continue
        valid += 1
        maximum = max(p.values())
        top = [key for key in OUTCOMES if abs(p[key] - maximum) <= 1e-9]
        unique_top = len(top) == 1
        correct = unique_top and top[0] == observed
        band = confidence_band(p)
        bucket = bands[band]
        bucket["amostra"] += 1
        if unique_top:
            bucket["avaliaveis_top1"] += 1
            bucket["acertos"] += int(correct)
            bucket["soma_probabilidade_top1"] += maximum
        for key in OUTCOMES:
            pairs[key].append((p[key], int(key == observed)))

        example = {
            "event_id": str(row.get("event_id") or ""),
            "rodada": int(row.get("rodada_observada") or row.get("rodada") or 0),
            "mandante": str(row.get("mandante") or ""),
            "visitante": str(row.get("visitante") or ""),
            "probabilidades_pct": {key: round(p[key], 2) for key in OUTCOMES},
            "resultado": observed,
            "palpite": top[0] if unique_top else None,
            "acerto_top1": bool(correct),
            "faixa": band,
            "probabilidade_resultado_pct": round(p[observed], 2),
            "hash_previsao": str(row.get("hash_previsao") or ""),
        }
        if band == "favorito_claro" and correct:
            high_success.append(example)
        elif band == "favorito_claro" and unique_top and not correct:
            high_surprise.append(example)
        elif band == "aberto":
            balanced.append(example)

    segment_names = {
        "aberto": "Jogo aberto",
        "favoritismo_moderado": "Favoritismo moderado",
        "favorito_claro": "Favorito claro",
    }
    segments = []
    for key in ("aberto", "favoritismo_moderado", "favorito_claro"):
        row = bands[key]
        count = row["avaliaveis_top1"]
        segments.append({
            "id": key,
            "rotulo": segment_names[key],
            "amostra": row["amostra"],
            "avaliaveis_top1": count,
            "acertos": row["acertos"],
            "taxa_acerto_pct": round(100 * row["acertos"] / count, 2) if count else None,
            "probabilidade_media_favorito_pct": round(row["soma_probabilidade_top1"] / count, 2) if count else None,
        })

    by_outcome = {}
    for key in OUTCOMES:
        entries = calibration_bins(pairs[key])
        # Cada desfecho tem exatamente uma previsão binária por jogo; a coluna
        # "ocorrencias" torna visíveis os numeradores usados na comparação.
        for entry in entries:
            lo, hi = entry["faixa_pct"]
            relevant = [(p, o) for p, o in pairs[key] if
                        (lo <= p < hi or (hi == 100 and p == 100))]
            entry["ocorrencias"] = sum(obs for _, obs in relevant)
        by_outcome[key] = entries

    if high_success:
        examples.append({"tipo": "favorito_confirmado", **max(
            high_success, key=lambda x: x["probabilidades_pct"][x["palpite"]]
        )})
    if high_surprise:
        examples.append({"tipo": "surpresa", **max(
            high_surprise, key=lambda x: x["probabilidades_pct"][x["palpite"]]
        )})
    if balanced:
        examples.append({"tipo": "jogo_aberto", **min(
            balanced,
            key=lambda x: max(x["probabilidades_pct"].values()) -
            sorted(x["probabilidades_pct"].values(), reverse=True)[1]
        )})

    rounds: dict[int, int] = defaultdict(int)
    for row in selected:
        try:
            r = int(row.get("rodada_observada") or row.get("rodada") or 0)
        except (TypeError, ValueError):
            continue
        if r > 0:
            rounds[r] += 1

    return {
        "jogos_validos": valid,
        "faixas_confianca": segments,
        "calibracao_por_resultado": by_outcome,
        "exemplos": examples,
        "comparador": {
            "tipo": "probabilidades_iguais_para_todos_os_resultados",
            "rotulo": "Referência neutra (33,3% / 33,3% / 33,3%)",
            "brier_multiclasse": round(2 / 9, 8),
            "log_loss": round(math.log(3), 8),
            "nota": "Referência matemática simplificada; não equivale a superar modelos profissionais.",
        },
        "auditoria_rodadas": [
            {"rodada": key, "jogos": n}
            for key, n in sorted(rounds.items()) if n > 10
        ],
        "metodologia": {
            "amostra": "Uma partida por confronto mandante/visitante; última previsão anterior ao início factual.",
            "aberto": "Margem entre a primeira e a segunda probabilidade inferior a 10 pontos percentuais.",
            "moderado": "Margem de pelo menos 10 pontos percentuais e favorito abaixo de 60%.",
            "claro": "Margem de pelo menos 10 pontos percentuais e favorito com 60% ou mais.",
            "empate": "Empates são aferidos pela frequência observada, não por um limiar arbitrário de 40%.",
        },
    }
