#!/usr/bin/env python3
"""AF-Previsão E4 — métricas de placares históricos com certificação E1/E3.

A única população avaliada é a de partidas com previsão pré-jogo demonstrada.
Não recalcula probabilidades, não usa placar final para retroprever e nunca
atribui previsões às partidas sem evidência.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import Counter
from pathlib import Path

from gerar_resultados_af_e3 import project as project_e3, digest

ROOT = Path(__file__).resolve().parents[1]
E1 = ROOT / "dados-br/auditoria-historica-placares-af-2026.json"
E3 = ROOT / "dados-br/resultados-af-placares-2026.json"
OUTPUT = ROOT / "dados-br/acuracia-placares-af-2026.json"


def wilson95(success: int, n: int) -> list[float] | None:
    """Intervalo Wilson aproximado para proporção binária (95%)."""
    if n <= 0:
        return None
    z = 1.959963984540054
    p = success / n
    den = 1 + z * z / n
    middle = (p + z * z / (2 * n)) / den
    radius = (z / den) * math.sqrt((p * (1 - p) / n) + z * z / (4 * n * n))
    return [round(100 * max(0, middle - radius), 2),
            round(100 * min(1, middle + radius), 2)]


def round4(x: float) -> float:
    return round(float(x), 4)


def calibration(rows: list[dict], event: str, step: int) -> list[dict]:
    """Classes da probabilidade do evento pré-definido; não é xG de chutes."""
    assert event in ("placar_exato", "top3")
    pkey = "probabilidade_modal_pct" if event == "placar_exato" else "probabilidade_top3_pct"
    hits_key = "acerto_exato" if event == "placar_exato" else "acerto_top3"
    bins = []
    for lower in range(0, 100, step):
        upper = lower + step
        subset = [r for r in rows if lower <= r[pkey] < upper or
                  (upper == 100 and r[pkey] == 100)]
        if not subset:
            continue
        count = len(subset)
        hits = sum(bool(r[hits_key]) for r in subset)
        expected = sum(r[pkey] / 100 for r in subset)
        bins.append({
            "faixa_pct": [lower, upper],
            "amostra": count,
            "ocorrencias": hits,
            "ocorrencias_esperadas": round4(expected),
            "probabilidade_media_pct": round(100 * expected / count, 2),
            "frequencia_observada_pct": round(100 * hits / count, 2),
            "diferenca_observado_menos_previsto_pp": round(100 * (hits - expected) / count, 2),
            "intervalo_wilson_95_pct": wilson95(hits, count),
            "amostra_reduzida": count < 20,
        })
    assert sum(b["amostra"] for b in bins) == len(rows), "calibração não cobre todos os casos"
    return bins


def metrics(rows: list[dict]) -> dict:
    n = len(rows)
    if n == 0:
        return {
            "jogos": 0, "placares_exatos": 0, "top3_confirmados": 0,
            "taxa_placar_exato_pct": None, "taxa_top3_pct": None,
            "ic95_placar_exato_pct": None, "ic95_top3_pct": None,
            "erro_absoluto_medio_gols_por_equipe": None,
            "erro_absoluto_medio_gols_mandante": None,
            "erro_absoluto_medio_gols_visitante": None,
            "erro_absoluto_medio_total_gols": None,
            "previsoes_ved_top1_avaliaveis": 0,
            "acertos_ved_top1": 0, "taxa_ved_top1_pct": None,
            "probabilidade_media_modal_pct": None,
            "frequencia_modal_observada_pct": None,
            "probabilidade_media_top3_pct": None,
            "frequencia_top3_observada_pct": None,
            "calibracao_modal": [], "calibracao_top3": [],
        }

    exact = sum(bool(r["acerto_exato"]) for r in rows)
    top3 = sum(bool(r["acerto_top3"]) for r in rows)
    errs_h = sum(r["erro_absoluto_gols_mandante"] for r in rows)
    errs_a = sum(r["erro_absoluto_gols_visitante"] for r in rows)
    ved = [r for r in rows if r["acerto_ved_top1"] is not None]
    vcorrect = sum(bool(r["acerto_ved_top1"]) for r in ved)
    pmodal = sum(r["probabilidade_modal_pct"] for r in rows) / n
    ptop3 = sum(r["probabilidade_top3_pct"] for r in rows) / n
    return {
        "jogos": n, "placares_exatos": exact, "top3_confirmados": top3,
        "taxa_placar_exato_pct": round(100 * exact / n, 2),
        "taxa_top3_pct": round(100 * top3 / n, 2),
        "ic95_placar_exato_pct": wilson95(exact, n),
        "ic95_top3_pct": wilson95(top3, n),
        "erro_absoluto_medio_gols_por_equipe": round4((errs_h + errs_a) / (2 * n)),
        "erro_absoluto_medio_gols_mandante": round4(errs_h / n),
        "erro_absoluto_medio_gols_visitante": round4(errs_a / n),
        "erro_absoluto_medio_total_gols": round4(sum(r["erro_absoluto_total_gols"] for r in rows) / n),
        "previsoes_ved_top1_avaliaveis": len(ved),
        "acertos_ved_top1": vcorrect,
        "taxa_ved_top1_pct": round(100 * vcorrect / len(ved), 2) if ved else None,
        "probabilidade_media_modal_pct": round(pmodal, 2),
        "frequencia_modal_observada_pct": round(100 * exact / n, 2),
        "probabilidade_media_top3_pct": round(ptop3, 2),
        "frequencia_top3_observada_pct": round(100 * top3 / n, 2),
        "calibracao_modal": calibration(rows, "placar_exato", 5),
        "calibracao_top3": calibration(rows, "top3", 10),
    }


def evaluate(game: dict) -> dict:
    f = game["placar_final_auditado"]
    modal = game["placar_previsto"]
    rates = game["gols_projetados"]
    top = game["top3_placares"]
    pved = game["probabilidades_ved_pct"]
    actual_result = ("mandante" if f["mandante"] > f["visitante"] else
                     "visitante" if f["mandante"] < f["visitante"] else "empate")
    exact = f["mandante"] == modal["mandante"] and f["visitante"] == modal["visitante"]
    top3hit = any((f["mandante"], f["visitante"]) == (x["mandante"], x["visitante"])
                  for x in top)
    # O Top-1 V/E/D é a maior das três probabilidades, NÃO o resultado implícito
    # pelo placar modal. Empate na maior probabilidade => não avaliável Top-1.
    top1 = game.get("palpite_resultado_top1")
    if top1 is not None and top1 not in ("mandante", "empate", "visitante"):
        raise ValueError("Palpite V/E/D desconhecido")
    preferred = max(pved, key=pved.get)
    tied = [k for k in ("mandante", "empate", "visitante")
            if abs(pved[k] - pved[preferred]) <= 1e-9]
    if top1 != (tied[0] if len(tied) == 1 else None):
        raise ValueError("Top-1 diverge das probabilidades V/E/D")
    pmodal = float(top[0]["probabilidade_pct"])
    ptop3 = sum(float(s["probabilidade_pct"]) for s in top)
    if not (0 <= pmodal <= 100 and 0 <= ptop3 <= 100.0001):
        raise ValueError("Soma de probabilidade Top-3 inválida")
    h_error = abs(float(rates["mandante"]) - f["mandante"])
    a_error = abs(float(rates["visitante"]) - f["visitante"])
    return {
        "event_id": game["event_ids"][0] if game.get("event_ids") else "",
        "rodada": game["rodada_auditada"],
        "mandante": game["mandante"], "visitante": game["visitante"],
        "inicio_factual": game["inicio_factual"],
        "placar_final": f, "placar_modal": modal,
        "gols_projetados": rates,
        "top3_placares": top,
        "probabilidade_modal_pct": round4(pmodal),
        "probabilidade_top3_pct": round4(ptop3),
        "acerto_exato": bool(exact),
        "acerto_top3": bool(top3hit),
        "acerto_ved_top1": (actual_result == top1) if top1 is not None else None,
        "palpite_ved_top1": top1, "resultado_ved_observado": actual_result,
        "erro_absoluto_gols_mandante": round4(h_error),
        "erro_absoluto_gols_visitante": round4(a_error),
        "erro_absoluto_total_gols": round4(abs(
            (float(rates["mandante"]) + float(rates["visitante"])) -
            (f["mandante"] + f["visitante"]))),
        "commit_prova": game["prova"]["commit"],
    }


def build(repo: Path = ROOT) -> dict:
    e1_raw = (repo / E1.relative_to(ROOT)).read_bytes()
    e3_raw = (repo / E3.relative_to(ROOT)).read_bytes()
    e1 = json.loads(e1_raw)
    e3 = json.loads(e3_raw)
    expected = project_e3(e1, e1_raw)  # certifica hashes e regras de integridade E1/E3.
    if e3 != expected:
        raise ValueError("E3 diverge da E1: não é permitido aferir dados não certificados")

    candidates = [evaluate(g) for g in e3["jogos"] if g["situacao"] == "comprovado"]
    if len({(g["mandante"].casefold(), g["visitante"].casefold()) for g in candidates}) != len(candidates):
        raise ValueError("Uma partida foi avaliada mais de uma vez")
    if len(candidates) != e3["resumo"]["previsoes_certificadas"]:
        raise ValueError("Denominador da E4 não concilia com a E3")
    for row in candidates:
        if row["acerto_exato"] and not row["acerto_top3"]:
            raise ValueError("Placar exato não está no Top-3")
        if row["probabilidade_top3_pct"] < row["probabilidade_modal_pct"]:
            raise ValueError("Top-3 com probabilidade inferior ao modal")

    summary = metrics(candidates)
    by_round = []
    for r in sorted({int(g["rodada"]) for g in candidates if g["rodada"] is not None}):
        selected = [g for g in candidates if g["rodada"] == r]
        by_round.append({"rodada": r, "metricas": metrics(selected)})
    clubs = sorted({name for row in candidates for name in (row["mandante"], row["visitante"])})
    by_club = [{"clube": club, "metricas": metrics(
        [g for g in candidates if club in (g["mandante"], g["visitante"])]
    )} for club in clubs]
    output = {
        "schema_version": 1, "temporada": 2026,
        "tipo": "acuracia_placares_af_previsao",
        "status": "ok",
        "escopo": {
            "resultados_finais_auditados": e3["resumo"]["resultados_auditados"],
            "jogos_com_previsao_certificada": len(candidates),
            "sem_prova_historica": e3["resumo"]["sem_snapshot_certificado"],
            "em_quarentena": e3["resumo"]["quarentena_por_conflito"] +
                             e3["resumo"]["sem_horario_factual"],
            "observacao": "Esta é uma amostra documental histórica, não a totalidade do Brasileirão.",
        },
        "origem": {
            "e1": str(E1.relative_to(ROOT)),
            "e1_sha256": hashlib.sha256(e1_raw).hexdigest(),
            "e1_hash_jogos": e1["integridade"]["hash_jogos"],
            "e3": str(E3.relative_to(ROOT)),
            "e3_sha256": hashlib.sha256(e3_raw).hexdigest(),
            "e3_hash_jogos": e3["integridade"]["hash_jogos"],
        },
        "metricas": summary, "por_rodada": by_round, "por_clube": by_club,
        "jogos": candidates,
        "metodologia": {
            "denominador": "Uma partida finalizada com previsão de placar pré-jogo documentada no histórico Git E1.",
            "exato": "Placar modal idêntico ao placar final; acertos / partidas auditáveis.",
            "top3": "Placar final em qualquer um dos três placares mais prováveis documentados; acertos / partidas auditáveis.",
            "erro": "Erro absoluto médio por equipe: soma de |gols esperados - gols reais| de mandante e visitante / (2 × partidas).",
            "calibracao": "Para cada partida, comparar a chance publicada do placar modal com a frequência de ele ocorrer; e a soma das três chances publicadas com a frequência de o placar estar no Top-3. Faixas com n<20 são descritivas.",
            "intervalo": "Wilson 95% aproximado para proporções; não comprova superioridade a outros modelos.",
            "ved": "Palpite Top-1 é o desfecho de maior probabilidade V/E/D, independentemente do resultado implícito pelo placar modal.",
            "limitacoes": "Top-3 e modal usam probabilidade registrada no snapshot pré-jogo; não há matriz completa de placares nesta aferição, portanto não atribuímos Log Loss de placar exato.",
            "fontes": "A E4 confere novamente a E1 e a E3 antes de calcular; nada é reconstruído usando gols reais.",
        },
    }
    output["integridade"] = {
        "algoritmo": "SHA-256",
        "hash_jogos": digest(candidates),
        "hash_metricas": digest(summary),
    }
    return output


def self_test() -> None:
    assert wilson95(0, 100) is not None
    assert wilson95(100, 100)[1] == 100.0
    sample = [{
        "acerto_exato": True, "acerto_top3": True,
        "erro_absoluto_gols_mandante": 0.2,
        "erro_absoluto_gols_visitante": 0.4,
        "erro_absoluto_total_gols": 0.6,
        "acerto_ved_top1": False,
        "probabilidade_modal_pct": 15.0,
        "probabilidade_top3_pct": 40.0,
    }, {
        "acerto_exato": False, "acerto_top3": False,
        "erro_absoluto_gols_mandante": 0.8,
        "erro_absoluto_gols_visitante": 1.6,
        "erro_absoluto_total_gols": 2.4,
        "acerto_ved_top1": True,
        "probabilidade_modal_pct": 10.0,
        "probabilidade_top3_pct": 45.0,
    }]
    summary = metrics(sample)
    assert summary["taxa_placar_exato_pct"] == 50.0
    assert summary["taxa_top3_pct"] == 50.0
    assert summary["erro_absoluto_medio_gols_por_equipe"] == .75
    assert summary["acertos_ved_top1"] == 1
    assert summary["probabilidade_media_modal_pct"] == 12.5
    assert summary["probabilidade_media_top3_pct"] == 42.5
    assert sum(x["amostra"] for x in summary["calibracao_modal"]) == 2
    assert sum(x["amostra"] for x in summary["calibracao_top3"]) == 2
    output = build()
    m = output["metricas"]
    assert m["jogos"] == output["escopo"]["jogos_com_previsao_certificada"]
    assert m["placares_exatos"] <= m["top3_confirmados"] <= m["jogos"]
    assert sum(x["metricas"]["jogos"] for x in output["por_rodada"]) == m["jogos"]
    assert sum(x["metricas"]["jogos"] for x in output["por_clube"]) == m["jogos"] * 2
    assert m["jogos"] == 157 and output["escopo"]["sem_prova_historica"] == 182
    print("AF E4 SELF-TEST PASS:", m["jogos"], "jogos,",
          m["placares_exatos"], "exatos,", m["top3_confirmados"], "Top-3")


def main() -> None:
    args = argparse.ArgumentParser()
    args.add_argument("--self-test", action="store_true")
    parsed = args.parse_args()
    if parsed.self_test:
        self_test()
        return
    output = build()
    serialized = json.dumps(output, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    if not OUTPUT.exists() or OUTPUT.read_text(encoding="utf-8") != serialized:
        OUTPUT.write_text(serialized, encoding="utf-8")
    print("AF E4 CERTIFICADA:", json.dumps({
        "escopo": output["escopo"], "metricas": {
            k: v for k, v in output["metricas"].items() if k not in (
                "calibracao_modal", "calibracao_top3")
        }
    }, ensure_ascii=False))
    print("AF E4 HASH:", output["integridade"]["hash_metricas"])


if __name__ == "__main__":
    main()
