#!/usr/bin/env python3
"""E2: migra exclusivamente Top-3 comprovadamente idêntico entre snapshots AF.

Não recalcula probabilidades ou gols; conserva gerado_em/versão de ambos
arquivos e atualiza o hash da auditoria do snapshot pré-jogo.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRE = ROOT / "dados-br/probabilidades-jogos.json"
FULL = ROOT / "dados-br/probabilidades-brasileirao.json"
AUDIT = ROOT / "dados-br/auditoria-probabilidades-jogos.json"


def canonical_hash(payload: dict) -> str:
    return hashlib.sha256(json.dumps(
        payload, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False
    ).encode("utf-8")).hexdigest()


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def save_if_changed(path: Path, payload: dict) -> None:
    serialized = json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    if path.read_text(encoding="utf-8") != serialized:
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(serialized, encoding="utf-8")
        tmp.replace(path)


def compatible(a: dict, b: dict) -> bool:
    if any(str(a.get(k) or "") != str(b.get(k) or "")
           for k in ("event_id", "mandante", "visitante", "data_iso")):
        return False
    for k in ("mandante", "visitante"):
        if abs(float(a["gols_esperados"][k]) -
               float(b["gols_esperados"][k])) > 0.00001:
            return False
        if int(a["placar_modal"][k]) != int(b["placar_modal"][k]):
            return False
    for k in ("mandante", "empate", "visitante"):
        # Diferença residual de arredondamento: pré-jogo particiona 100% com
        # maior resto; a fonte completa arredonda as 3 parcelas isoladamente.
        if abs(float(a["probabilidades_pct"][k]) -
               float(b["probabilidades_pct"][k])) > 0.00015:
            return False
    return True


def synchronize() -> dict:
    current, full, audited = load(PRE), load(FULL), load(AUDIT)
    if (current.get("status") != "ok" or full.get("status") != "ok" or
            current.get("gerado_em") != full.get("gerado_em") or
            current.get("versao_modelo") != full.get("versao_modelo")):
        raise ValueError("Origem completa e snapshot pré-jogo não são do mesmo instante/versão")
    if (audited.get("hash_entrada") != current.get("hash_entrada") or
            audited.get("hash_saida") != canonical_hash(current)):
        raise ValueError("Auditoria pré-jogo original já diverge do JSON")
    base = {str(x["event_id"]): x for x in full.get("partidas_restantes") or []}
    games = current.get("jogos") or []
    if len(games) != len(base) or not games:
        raise ValueError("Fontes não contêm a mesma cobertura")
    enriched = 0
    for game in games:
        match = base.get(str(game["event_id"]))
        if not match or not compatible(game, match):
            raise ValueError("O snapshot completo diverge em " + str(game["event_id"]))
        top = (match.get("placares_mais_provaveis") or [])[:3]
        if len(top) != 3:
            raise ValueError("Top-3 nativo não encontrado em " + str(game["event_id"]))
        candidates = []
        seen = set()
        last = 101.0
        for item in top:
            h, a, p = item.get("mandante"), item.get("visitante"), item.get("probabilidade_pct")
            if (type(h) is not int or type(a) is not int or
                    not (0 <= h <= 12 and 0 <= a <= 12) or (h, a) in seen or
                    not math.isfinite(float(p)) or not (0 <= float(p) <= last + .00011)):
                raise ValueError("Top-3 inconsistente: " + str(game["event_id"]))
            seen.add((h, a))
            last = float(p)
            candidates.append({"mandante": h, "visitante": a, "probabilidade_pct": round(last, 4)})
        if (candidates[0]["mandante"], candidates[0]["visitante"]) != (
                game["placar_modal"]["mandante"], game["placar_modal"]["visitante"]):
            raise ValueError("Top-3 diverge do placar modal: " + str(game["event_id"]))
        game["placares_mais_provaveis"] = candidates
        enriched += 1
    audited["hash_saida"] = canonical_hash(current)
    # Mantém metadados e métricas preexistentes da auditoria, sem tocar em
    # históricos SHA-256 do projeto.
    save_if_changed(PRE, current)
    save_if_changed(AUDIT, audited)
    return {"jogos": len(games), "top3_original_transportado": enriched, "hash_saida": audited["hash_saida"]}


if __name__ == "__main__":
    print("E2 TOP-3:", json.dumps(synchronize(), ensure_ascii=False))
