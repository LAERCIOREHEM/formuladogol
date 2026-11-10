#!/usr/bin/env python3
"""AF-Previsão E3: projeção pública MÍNIMA da auditoria documental E1.

Não simula gols, não retreina modelos, não altera o histórico e não reinterpreta
jogos sem previsão comprovada. O placar real corrente é novamente conferido
pelo navegador antes de exibir qualquer comparação.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping

ROOT = Path(__file__).resolve().parents[1]
AUDIT_SOURCE = Path("dados-br/auditoria-historica-placares-af-2026.json")
DESTINATION = Path("dados-br/resultados-af-placares-2026.json")
OUTCOMES = ("mandante", "empate", "visitante")
STATUS = {
    "comprovado", "sem_snapshot_prejogo_comprovavel",
    "conflito_resultado", "inicio_factual_indisponivel",
}


def json_bytes(payload: Any) -> bytes:
    return json.dumps(payload, sort_keys=True, ensure_ascii=False,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(payload: Any) -> str:
    return hashlib.sha256(json_bytes(payload)).hexdigest()


def parse_time(text: Any) -> datetime:
    value = datetime.fromisoformat(str(text or "").replace("Z", "+00:00"))
    if value.tzinfo is None:
        raise ValueError("timestamp sem fuso explícito")
    return value


def valid_score(score: Any) -> bool:
    return (isinstance(score, Mapping) and all(
        type(score.get(k)) is int and 0 <= score[k] <= 30
        for k in ("mandante", "visitante")
    ))


def validated_top3(row: Mapping[str, Any], modal: Mapping[str, Any]) -> list[dict[str, Any]]:
    original = row.get("top3_placares")
    if row.get("top3_situacao") not in ("nativo_documentado", "nativo_conciliado_mesma_previsao"):
        raise ValueError("Top-3 sem certificação de origem")
    if not isinstance(original, list) or len(original) != 3:
        raise ValueError("Top-3 documental ausente")
    out = []
    keys = set()
    last = 101.0
    for score in original:
        h, a = score.get("mandante"), score.get("visitante")
        p = score.get("probabilidade_pct")
        if (type(h) is not int or type(a) is not int or
                not 0 <= h <= 12 or not 0 <= a <= 12 or
                (h, a) in keys or type(p) not in (int, float) or
                not math.isfinite(p) or not 0 <= p <= last + 0.00011):
            raise ValueError("Top-3 inválido, duplicado ou fora de ordem")
        keys.add((h, a))
        last = p
        out.append({"mandante": h, "visitante": a, "probabilidade_pct": p})
    if (out[0]["mandante"], out[0]["visitante"]) != (modal["mandante"], modal["visitante"]):
        raise ValueError("Placar modal diverge do Top-3 nativo")
    return out


def validate_audit(source: Mapping[str, Any]) -> None:
    if (source.get("schema_version") != 1 or source.get("temporada") != 2026 or
            source.get("tipo") != "auditoria_historica_placares_prejogo"):
        raise ValueError("Artefato de origem não é a auditoria E1 de 2026")
    games = source.get("jogos")
    summary = source.get("resumo") or {}
    if not isinstance(games, list) or len(games) != summary.get("total_resultados_unicos"):
        raise ValueError("Contagem da auditoria E1 divergente")
    integrity = source.get("integridade") or {}
    if (integrity.get("hash_jogos") != digest(games) or
            integrity.get("hash_resumo") != digest(summary)):
        raise ValueError("Hashes da E1 alterados ou inválidos")
    totals = Counter(item.get("situacao") for item in games)
    if not set(totals).issubset(STATUS):
        raise ValueError("Categoria de auditoria desconhecida")
    if (totals["comprovado"] != summary.get("jogos_com_placar_prejogo_comprovado") or
            totals["sem_snapshot_prejogo_comprovavel"] != summary.get("jogos_sem_prova_prejogo") or
            totals["conflito_resultado"] != summary.get("jogos_com_conflito") or
            totals["inicio_factual_indisponivel"] != summary.get("jogos_sem_inicio_factual")):
        raise ValueError("Categorias E1 não conciliadas")
    keys = [item.get("identidade_partida") for item in games]
    if len(set(keys)) != len(keys):
        raise ValueError("Partidas duplicadas no relatório E1")


def project(source: Mapping[str, Any], source_bytes: bytes) -> dict[str, Any]:
    validate_audit(source)
    result = []
    for game in source["jogos"]:
        status = game["situacao"]
        if not valid_score(game.get("placar_final")):
            raise ValueError("Placar factual inválido em " + str(game.get("event_id")))
        ids = sorted(set(
            [str(game.get("event_id") or "").strip(), *[
                str(item).strip() for item in (game.get("ids_resultado") or [])
            ]]
        ) - {""})
        record = {
            "identidade_partida": game["identidade_partida"],
            "event_ids": ids,
            "rodada_auditada": game.get("rodada"),
            "mandante": game["mandante"],
            "visitante": game["visitante"],
            "inicio_factual": game.get("inicio_factual"),
            "placar_final_auditado": game["placar_final"],
            "situacao": status,
        }
        if status == "comprovado":
            prediction = game["previsao"]
            means = prediction["gols_esperados"]
            modal = prediction["placar_modal"]
            probs = prediction["probabilidades_ved_pct"]
            provenance = game["proveniencia"]
            if not valid_score(modal) or max(modal.values()) > 12:
                raise ValueError("Placar modal inválido")
            if (not all(type(means.get(k)) in (float, int) and
                        math.isfinite(means[k]) and 0 < means[k] <= 12
                        for k in ("mandante", "visitante"))):
                raise ValueError("Gols esperados inválidos")
            if (not all(type(probs.get(k)) in (float, int) and
                        math.isfinite(probs[k]) and 0 <= probs[k] <= 100
                        for k in OUTCOMES) or
                    abs(sum(probs[k] for k in OUTCOMES) - 100) > .05):
                raise ValueError("V/E/D inválido")
            top3 = validated_top3(game, modal)
            if not (re.fullmatch(r"[0-9a-f]{40}", str(provenance.get("commit") or "")) and
                    re.fullmatch(r"[0-9a-f]{64}", str(provenance.get("arquivo_sha256") or "")) and
                    parse_time(provenance["commit_em"]) < parse_time(game["inicio_factual"]) and
                    parse_time(provenance["gerado_em_modelo"]) < parse_time(game["inicio_factual"])):
                raise ValueError("Prova de anterioridade inválida")
            if (provenance.get("calculado_em") and
                    parse_time(provenance["calculado_em"]) >= parse_time(game["inicio_factual"])):
                raise ValueError("Previsão calculada depois do jogo")
            best = max(probs[k] for k in OUTCOMES)
            winners = [k for k in OUTCOMES if abs(probs[k] - best) <= 1e-9]
            record.update({
                "placar_previsto": modal,
                "gols_projetados": means,
                "probabilidades_ved_pct": probs,
                "palpite_resultado_top1": winners[0] if len(winners) == 1 else None,
                "top3_placares": top3,
                "prova": {
                    "commit": provenance["commit"],
                    "gerado_em": provenance["gerado_em_modelo"],
                    "versao_modelo": provenance.get("versao_modelo"),
                    "top3_origem": game["top3_situacao"],
                },
            })
        result.append(record)

    statuses = Counter(x["situacao"] for x in result)
    output = {
        "schema_version": 1,
        "temporada": 2026,
        "tipo": "comparativo_resultados_af_previsao",
        "status": "ok",
        "origem": {
            "arquivo": str(AUDIT_SOURCE),
            "sha256_arquivo": hashlib.sha256(source_bytes).hexdigest(),
            "hash_jogos_e1": source["integridade"]["hash_jogos"],
            "data_fonte_resultados": source.get("fontes_resultados", {}).get("atualizado_em"),
        },
        "resumo": {
            "resultados_auditados": len(result),
            "previsoes_certificadas": statuses["comprovado"],
            "sem_snapshot_certificado": statuses["sem_snapshot_prejogo_comprovavel"],
            "quarentena_por_conflito": statuses["conflito_resultado"],
            "sem_horario_factual": statuses["inicio_factual_indisponivel"],
        },
        "nota": (
            "A previsão é exibida apenas se o placar, os clubes e o início factual "
            "do jogo corrente coincidirem com a prova E1; os outros jogos não "
            "recebem previsões recriadas retroativamente."
        ),
        "jogos": result,
    }
    output["integridade"] = {
        "algoritmo": "SHA-256",
        "hash_jogos": digest(result),
    }
    if len(result) != source["resumo"]["total_resultados_unicos"]:
        raise ValueError("Cobertura histórica truncada")
    return output


def self_test() -> None:
    original = (ROOT / AUDIT_SOURCE).read_bytes()
    audit = json.loads(original)
    view = project(audit, original)
    assert view["resumo"]["previsoes_certificadas"] == 157 or view["resumo"]["previsoes_certificadas"] > 0
    assert view["resumo"]["resultados_auditados"] == len(view["jogos"])
    assert view["resumo"]["sem_snapshot_certificado"] + view["resumo"]["previsoes_certificadas"] + (
        view["resumo"]["quarentena_por_conflito"] + view["resumo"]["sem_horario_factual"]
    ) == len(view["jogos"])
    good = next(r for r in view["jogos"] if r["situacao"] == "comprovado")
    assert good["top3_placares"][0]["mandante"] == good["placar_previsto"]["mandante"]
    assert good["top3_placares"][0]["visitante"] == good["placar_previsto"]["visitante"]
    assert not any("placar_previsto" in row for row in view["jogos"]
                   if row["situacao"] != "comprovado")
    forged = json.loads(json.dumps(audit))
    forged["jogos"][0]["placar_final"]["mandante"] += 1
    try:
        project(forged, original)
    except ValueError:
        pass
    else:
        raise AssertionError("Alteração de placar factual da E1 não detectada")
    print("AF E3 SELF-TEST: OK", view["resumo"])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    src = (ROOT / AUDIT_SOURCE).read_bytes()
    data = project(json.loads(src), src)
    out = ROOT / DESTINATION
    encoded = json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    if not out.exists() or out.read_text(encoding="utf-8") != encoded:
        out.write_text(encoded, encoding="utf-8")
    print("AF E3 DADOS CERTIFICADOS:", json.dumps(data["resumo"], ensure_ascii=False))
    print("AF E3 SHA256:", data["integridade"]["hash_jogos"])


if __name__ == "__main__":
    main()
