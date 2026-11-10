#!/usr/bin/env python3
"""E1 — Recuperação documental de placares previstos ANTES das partidas.

Lê commits reais do Git para duas fontes AF-Previsão e resultados finais da
temporada. Não executa o modelo, não gera previsões retroativas e NÃO modifica
os históricos SHA-256 existentes.

Git é uma prova verificável de que o conteúdo existia naquele commit, não uma
prova independente de que o usuário visualizou a previsão no site.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import subprocess
import tempfile
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path("dados-br/auditoria-historica-placares-af-2026.json")
SOURCES = (
    ("dados-br/probabilidades-jogos.json", "jogos"),
    ("dados-br/probabilidades-brasileirao.json", "brasileirao"),
)
BRT = ZoneInfo("America/Sao_Paulo")
OUTCOMES = ("mandante", "empate", "visitante")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_hash(value: Any) -> str:
    return sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                             separators=(",", ":"), allow_nan=False).encode("utf-8"))


def parse_dt(value: Any) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        result = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if result.tzinfo is None:
        result = result.replace(tzinfo=BRT)
    return result.astimezone(timezone.utc)


def normalized_name(name: Any) -> str:
    name = str(name or "").strip().casefold()
    name = "".join(c for c in unicodedata.normalize("NFKD", name)
                   if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", name).strip()


def name_from(value: Any) -> str:
    if isinstance(value, Mapping):
        return str(value.get("nome") or value.get("name") or "").strip()
    return str(value or "").strip()


def pair_key(home: Any, away: Any) -> tuple[str, str]:
    return normalized_name(name_from(home)), normalized_name(name_from(away))


def execute(repo: Path, *args: str) -> bytes:
    result = subprocess.run(["git", *args], cwd=repo, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise RuntimeError("git " + " ".join(args[:2]) + ": " +
                           result.stderr.decode("utf-8", "replace")[:500])
    return result.stdout


def documented_history(repo: Path, path: str) -> list[tuple[str, datetime]]:
    output = execute(repo, "log", "--format=%H%x09%cI", "--", path)
    commits = []
    for line in output.decode("utf-8").splitlines():
        if not line.strip():
            continue
        commit, timestamp = line.split("\t", 1)
        dt = parse_dt(timestamp)
        if not re.fullmatch(r"[a-f0-9]{40}", commit) or dt is None:
            raise ValueError("Git log sem SHA-1 e data verificáveis")
        commits.append((commit, dt))
    return list(reversed(commits))


def finite(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def goals_prediction(row: Mapping[str, Any]) -> dict[str, Any] | None:
    rates = row.get("gols_esperados") or {}
    modal = row.get("placar_modal") or {}
    try:
        h, a = float(rates["mandante"]), float(rates["visitante"])
        mh, ma = modal["mandante"], modal["visitante"]
    except (KeyError, ValueError, TypeError):
        return None
    if not (math.isfinite(h) and math.isfinite(a) and 0 < h <= 12 and 0 < a <= 12):
        return None
    if (not isinstance(mh, int) or isinstance(mh, bool) or
            not isinstance(ma, int) or isinstance(ma, bool) or
            not (0 <= mh <= 12 and 0 <= ma <= 12)):
        return None
    probabilities = row.get("probabilidades_pct") or {}
    try:
        ved = {k: float(probabilities[k]) for k in OUTCOMES}
    except (KeyError, ValueError, TypeError):
        return None
    if any(not math.isfinite(v) or not 0 <= v <= 100 for v in ved.values()):
        return None
    if abs(sum(ved.values()) - 100.0) > 0.05:
        return None
    return {
        "gols_esperados": {"mandante": h, "visitante": a},
        "placar_modal": {"mandante": mh, "visitante": ma},
        "probabilidades_ved_pct": ved,
    }


def native_top3(row: Mapping[str, Any], modal: Mapping[str, Any]) -> list[dict[str, Any]] | None:
    values = row.get("placares_mais_provaveis")
    if not isinstance(values, list) or len(values) < 3:
        return None
    top = []
    for item in values[:3]:
        if not isinstance(item, Mapping):
            return None
        gh, ga = item.get("mandante"), item.get("visitante")
        pct = finite(item.get("probabilidade_pct"))
        if not all(isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 12
                   for v in (gh, ga)) or pct is None or not 0 <= pct <= 100:
            return None
        top.append({"mandante": gh, "visitante": ga, "probabilidade_pct": pct})
    keys = {(p["mandante"], p["visitante"]) for p in top}
    if (len(keys) != 3 or any(top[i]["probabilidade_pct"] + 0.0001 <
                             top[i + 1]["probabilidade_pct"] for i in range(2))
            or (top[0]["mandante"], top[0]["visitante"]) !=
            (modal["mandante"], modal["visitante"])):
        return None
    return top


def final_results(document: Mapping[str, Any]) -> tuple[list[dict[str, Any]], dict[tuple[str, str], list[str]]]:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for r in document.get("resultados") or []:
        home, away = name_from(r.get("mandante")), name_from(r.get("visitante"))
        pair = pair_key(home, away)
        if not all(pair) or pair[0] == pair[1]:
            continue
        hg, ag = r.get("placar_mandante"), r.get("placar_visitante")
        if not isinstance(hg, int) or isinstance(hg, bool) or not isinstance(ag, int) or isinstance(ag, bool):
            continue
        if min(hg, ag) < 0 or max(hg, ag) > 30:
            continue
        dt = parse_dt(r.get("data_iso"))
        groups[pair].append({
            "event_id": str(r.get("event_id") or "").strip(),
            "rodada": int(r.get("rodada") or 0),
            "mandante": home, "visitante": away,
            "inicio_factual": dt.isoformat() if dt else None,
            "placar_final": {"mandante": hg, "visitante": ag},
        })
    outcomes: list[dict[str, Any]] = []
    conflicts: dict[tuple[str, str], list[str]] = {}
    for pair, rows in sorted(groups.items()):
        distinct = {(r["placar_final"]["mandante"], r["placar_final"]["visitante"]) for r in rows}
        kickoffs = {r["inicio_factual"] for r in rows if r["inicio_factual"]}
        if len(distinct) != 1 or len(kickoffs) > 1:
            conflicts[pair] = sorted(set("id=" + r["event_id"] + " " + str(r["placar_final"]) +
                                         " kickoff=" + str(r["inicio_factual"]) for r in rows))
        chosen = sorted(rows, key=lambda r: (
            bool(r["inicio_factual"]), r["inicio_factual"] or "", bool(r["event_id"]), r["event_id"]
        ))[-1]
        chosen["identidade_partida"] = "|".join(pair)
        chosen["ids_resultado"] = sorted({r["event_id"] for r in rows if r["event_id"]})
        outcomes.append(chosen)
    return outcomes, conflicts


def git_forecasts(repo: Path, results: list[dict[str, Any]]) -> tuple[dict[tuple[str, str], list[dict[str, Any]]], dict[str, Any]]:
    target_pairs = {pair_key(r["mandante"], r["visitante"]) for r in results}
    by_pair: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    report: dict[str, Any] = {"fontes": {}, "linhas_rejeitadas": Counter()}
    for path, source_type in SOURCES:
        commits = documented_history(repo, path)
        stats = Counter()
        for commit_sha, committed_at in commits:
            stats["commits_localizados"] += 1
            try:
                raw = execute(repo, "show", commit_sha + ":" + path)
                document = json.loads(raw)
            except (RuntimeError, ValueError, json.JSONDecodeError):
                stats["snapshots_ilegíveis"] += 1
                continue
            if not isinstance(document, Mapping) or document.get("status") != "ok" or int(document.get("temporada") or 0) != 2026:
                stats["snapshots_ignorados"] += 1
                continue
            produced_at = parse_dt(document.get("gerado_em"))
            calculated_at = parse_dt(document.get("calculado_em"))
            if (produced_at is None or produced_at > committed_at + timedelta(minutes=2)
                    or (calculated_at and calculated_at > committed_at + timedelta(minutes=2))):
                stats["cronologia_documento_invalida"] += 1
                continue
            rows = document.get("jogos") if source_type == "jogos" else document.get("partidas_restantes")
            if not isinstance(rows, list):
                stats["snapshots_sem_lista"] += 1
                continue
            stats["snapshots_validos"] += 1
            digest = sha256(raw)
            for row in rows:
                if not isinstance(row, Mapping):
                    continue
                if source_type == "jogos" and row.get("status") != "pre_jogo":
                    continue
                pair = pair_key(row.get("mandante"), row.get("visitante"))
                if pair not in target_pairs:
                    continue
                prediction = goals_prediction(row)
                if prediction is None:
                    report["linhas_rejeitadas"]["dados_matematicos_invalidos"] += 1
                    continue
                event_id = str(row.get("event_id") or "").strip()
                if not event_id:
                    report["linhas_rejeitadas"]["event_id_ausente"] += 1
                    continue
                observed_result = next((r for r in results if
                                        pair_key(r["mandante"], r["visitante"]) == pair), None)
                if not observed_result:
                    continue
                kickoff = parse_dt(observed_result.get("inicio_factual"))
                if not kickoff:
                    continue
                if committed_at >= kickoff or produced_at >= kickoff or (
                        calculated_at is not None and calculated_at >= kickoff):
                    report["linhas_rejeitadas"]["apos_inicio_factual"] += 1
                    continue
                native = native_top3(row, prediction["placar_modal"])
                provenance = {
                    "origem": path,
                    "commit": commit_sha,
                    "commit_em": committed_at.isoformat(),
                    "arquivo_sha256": digest,
                    "linha_sha256": canonical_hash(row),
                    "gerado_em_modelo": produced_at.isoformat(),
                    "versao_modelo": str(document.get("versao_modelo") or ""),
                    "hash_entrada_modelo": str(document.get("hash_entrada") or ""),
                }
                if calculated_at:
                    provenance["calculado_em"] = calculated_at.isoformat()
                by_pair[pair].append({
                    "event_id_original": event_id,
                    "previsao": prediction,
                    "top3_nativo": native,
                    "proveniencia": provenance,
                })
                stats["linhas_prejogo_elegiveis"] += 1
        report["fontes"][path] = dict(stats)
    report["linhas_rejeitadas"] = dict(report["linhas_rejeitadas"])
    return by_pair, report


def choose_forecast(items: list[dict[str, Any]]) -> tuple[dict[str, Any], str] | None:
    if not items:
        return None
    # A previsão mais recente realmente presente no Git antes do início.
    # Em empate cronológico, prioriza a fonte de placares Top-3 nativa.
    ranked = sorted(items, key=lambda x: (
        x["proveniencia"]["commit_em"],
        x["proveniencia"]["gerado_em_modelo"],
        bool(x["top3_nativo"]),
        x["proveniencia"]["commit"],
        x["proveniencia"]["origem"],
    ))
    selected = dict(ranked[-1])
    status = "ausente_na_fonte_escolhida"
    if selected["top3_nativo"] is not None:
        status = "nativo_documentado"
    else:
        # Complemento permitido APENAS com a mesma rodada de cálculo e taxas
        # exatamente iguais. Nunca usar o resultado do jogo para construir Top-3.
        best = None
        for alternative in ranked:
            if alternative["top3_nativo"] is None:
                continue
            p1, p2 = selected["previsao"], alternative["previsao"]
            if (alternative["proveniencia"]["gerado_em_modelo"] !=
                    selected["proveniencia"]["gerado_em_modelo"]):
                continue
            if p1["placar_modal"] != p2["placar_modal"]:
                continue
            if any(abs(p1["gols_esperados"][k] - p2["gols_esperados"][k]) > 0.00011
                   for k in ("mandante", "visitante")):
                continue
            if any(abs(p1["probabilidades_ved_pct"][k] - p2["probabilidades_ved_pct"][k]) > .001
                   for k in OUTCOMES):
                continue
            best = alternative
        if best:
            selected["top3_nativo"] = best["top3_nativo"]
            selected["proveniencia_top3"] = best["proveniencia"]
            status = "nativo_conciliado_mesma_previsao"
    return selected, status


def verify_existing_history(repo: Path) -> str | None:
    path = repo / "dados-br/historico-probabilidades-jogos.json"
    if not path.exists():
        return None
    raw = path.read_bytes()
    history = json.loads(raw)
    forecasts = history.get("previsoes") or []
    checks = []
    for forecast in forecasts:
        doc = dict(forecast)
        declared = doc.pop("hash_previsao", None)
        if not declared or declared != canonical_hash(doc):
            raise ValueError("Histórico V/E/D original com SHA-256 inválido")
        checks.append(declared)
    integral = (history.get("integridade") or {}).get("hash_conjunto_previsoes")
    if integral is not None and integral != canonical_hash(checks):
        raise ValueError("Histórico V/E/D original com hash de conjunto divergente")
    return sha256(raw)


def audit(repo: Path) -> dict[str, Any]:
    results_raw = (repo / "resultados.json").read_bytes()
    results_doc = json.loads(results_raw)
    results, conflicts = final_results(results_doc)
    all_candidates, stats = git_forecasts(repo, results)
    historical_digest = verify_existing_history(repo)

    games = []
    for result in sorted(results, key=lambda r: (
            r["inicio_factual"] or "", r["identidade_partida"])):
        pair = pair_key(result["mandante"], result["visitante"])
        item = dict(result)
        if pair in conflicts:
            item.update({"situacao": "conflito_resultado", "conflitos": conflicts[pair]})
        elif not parse_dt(result.get("inicio_factual")):
            item["situacao"] = "inicio_factual_indisponivel"
        else:
            picked = choose_forecast(all_candidates.get(pair, []))
            if picked is None:
                item["situacao"] = "sem_snapshot_prejogo_comprovavel"
            else:
                selected, top3_status = picked
                item.update({
                    "situacao": "comprovado",
                    "event_id_previsao": selected["event_id_original"],
                    "previsao": selected["previsao"],
                    "top3_placares": selected["top3_nativo"],
                    "top3_situacao": top3_status,
                    "proveniencia": selected["proveniencia"],
                })
                if selected.get("proveniencia_top3"):
                    item["proveniencia_top3"] = selected["proveniencia_top3"]
        games.append(item)

    count = Counter(item["situacao"] for item in games)
    valid = [item for item in games if item["situacao"] == "comprovado"]
    with_top3 = sum(bool(item.get("top3_placares")) for item in valid)
    summary = {
        "total_resultados_unicos": len(games),
        "jogos_com_placar_prejogo_comprovado": len(valid),
        "jogos_sem_prova_prejogo": count["sem_snapshot_prejogo_comprovavel"],
        "jogos_com_conflito": count["conflito_resultado"],
        "jogos_sem_inicio_factual": count["inicio_factual_indisponivel"],
        "jogos_com_top3_original": with_top3,
        "jogos_sem_top3_original": len(valid) - with_top3,
        "partidas_sem_previsao_nao_foram_reconstituidas": True,
    }
    report = {
        "schema_version": 1,
        "projeto": "Fórmula do Gol · AF-Previsão",
        "tipo": "auditoria_historica_placares_prejogo",
        "temporada": 2026,
        "status": "auditado_com_lacunas" if any(item["situacao"] != "comprovado" for item in games)
                  else "auditado",
        "resumo": summary,
        "fontes_resultados": {
            "caminho": "resultados.json",
            "arquivo_sha256": sha256(results_raw),
            "atualizado_em": results_doc.get("atualizado_em"),
        },
        "historico_ved_preexistente": {
            "caminho": "dados-br/historico-probabilidades-jogos.json",
            "arquivo_sha256_antes_da_auditoria": historical_digest,
            "alterado_pela_e1": False,
        },
        "metodologia": {
            "criterio": "último commit que contém previsão válida, anterior ao horário factual da partida",
            "cronologia": "commit, geração e cálculo (quando presente) precisam anteceder o início factual",
            "identidade": "confronto mandante/visitante normalizado; IDs ESPN alternativos não multiplicam partidas",
            "escopo": "somente resultados finais 2026 existentes em resultados.json",
            "top3": "publicado no snapshot original; apenas conciliado se geração, médias, placar modal e V/E/D coincidirem",
            "proibicoes": [
                "não recalcular previsões com dados posteriores",
                "não inferir placares de jogos sem snapshot",
                "não apresentar um Top-3 reconstruído como se tivesse sido publicado",
                "não alterar os hashes históricos V/E/D",
            ],
            "limite_documental": "Git comprova o conteúdo versionado e sua data de commit; não comprova sozinho a data de exibição em página pública.",
        },
        "varredura_git": stats,
        "jogos": games,
    }
    report["integridade"] = {
        "algoritmo": "SHA-256",
        "hash_jogos": canonical_hash(games),
        "hash_resumo": canonical_hash(summary),
    }
    validate_report(report)
    return report


def validate_report(report: Mapping[str, Any]) -> None:
    games = report.get("jogos") or []
    pairs = [item["identidade_partida"] for item in games]
    if len(set(pairs)) != len(pairs):
        raise ValueError("Auditou confronto repetido")
    proven = [row for row in games if row["situacao"] == "comprovado"]
    for row in proven:
        if not (parse_dt(row["proveniencia"]["commit_em"]) <
                parse_dt(row["inicio_factual"]) and
                parse_dt(row["proveniencia"]["gerado_em_modelo"]) <
                parse_dt(row["inicio_factual"])):
            raise ValueError("Previsão publicada após início")
        if row.get("top3_placares") and len(row["top3_placares"]) != 3:
            raise ValueError("Top-3 parcial")
        if row.get("top3_placares") and row["top3_situacao"] not in {
                "nativo_documentado", "nativo_conciliado_mesma_previsao"}:
            raise ValueError("Top-3 sem origem")
    summary = report["resumo"]
    if summary["jogos_com_placar_prejogo_comprovado"] != len(proven):
        raise ValueError("Amostra incompatível")
    if sum([summary["jogos_com_placar_prejogo_comprovado"],
            summary["jogos_sem_prova_prejogo"],
            summary["jogos_com_conflito"], summary["jogos_sem_inicio_factual"]]) != len(games):
        raise ValueError("Cobertura incompatível")
    integrity = report["integridade"]
    if integrity["hash_jogos"] != canonical_hash(games):
        raise ValueError("Hash da listagem divergente")


def self_test() -> None:
    with tempfile.TemporaryDirectory(prefix="fdg-e1-") as tmp:
        root = Path(tmp)
        (root / "dados-br").mkdir()
        execute(root, "init", "-q")
        execute(root, "config", "user.name", "Test")
        execute(root, "config", "user.email", "test@example.com")

        def commit(path: str, content: Any, iso_date: str) -> None:
            file = root / path
            file.write_text(json.dumps(content, ensure_ascii=False), encoding="utf-8")
            execute(root, "add", path)
            env = {"GIT_AUTHOR_DATE": iso_date, "GIT_COMMITTER_DATE": iso_date}
            import os
            subprocess.run(["git", "commit", "-qm", "self-test"], cwd=root,
                           env={**os.environ, **env}, check=True)

        base = {
            "schema_version": 1, "status": "ok", "temporada": 2026,
            "gerado_em": "2026-08-01T10:00:00-03:00", "versao_modelo": "teste",
            "jogos": [{
                "event_id": "A", "mandante": "Clube A", "visitante": "Clube B",
                "data_iso": "2026-08-01T18:00:00-03:00", "status": "pre_jogo",
                "probabilidades_pct": {"mandante": 55, "empate": 25, "visitante": 20},
                "gols_esperados": {"mandante": 1.6, "visitante": 0.8},
                "placar_modal": {"mandante": 1, "visitante": 0},
            }],
        }
        commit("dados-br/probabilidades-jogos.json", base, "2026-08-01T13:05:00+00:00")
        br = {
            "schema_version": 2, "status": "ok", "temporada": 2026,
            "gerado_em": base["gerado_em"], "versao_modelo": "teste",
            "partidas_restantes": [{
                **{k: v for k, v in base["jogos"][0].items() if k != "status"},
                "placares_mais_provaveis": [
                    {"mandante": 1, "visitante": 0, "probabilidade_pct": 18},
                    {"mandante": 2, "visitante": 0, "probabilidade_pct": 14},
                    {"mandante": 1, "visitante": 1, "probabilidade_pct": 13},
                ],
            }],
        }
        commit("dados-br/probabilidades-brasileirao.json", br, "2026-08-01T13:06:00+00:00")

        # Corrupção posterior: uma previsão criada DEPOIS do início jamais contamina E1.
        contaminated = json.loads(json.dumps(base))
        contaminated["gerado_em"] = "2026-08-01T20:00:00-03:00"
        contaminated["jogos"][0]["placar_modal"] = {"mandante": 9, "visitante": 9}
        commit("dados-br/probabilidades-jogos.json", contaminated, "2026-08-01T23:02:00+00:00")
        # Outro jogo encerrado sem snapshot deve continuar sem previsão.
        results = {"atualizado_em": "2026-08-04", "resultados": [
            {"event_id": "A", "mandante": {"nome": "Clube A"}, "visitante": {"nome": "Clube B"},
             "data_iso": "2026-08-01T18:00:00-03:00", "rodada": 1,
             "placar_mandante": 1, "placar_visitante": 0},
            {"event_id": "C", "mandante": {"nome": "Clube C"}, "visitante": {"nome": "Clube D"},
             "data_iso": "2026-08-02T18:00:00-03:00", "rodada": 1,
             "placar_mandante": 0, "placar_visitante": 1},
        ]}
        (root / "resultados.json").write_text(json.dumps(results), encoding="utf-8")
        report = audit(root)
        assert report["resumo"]["jogos_com_placar_prejogo_comprovado"] == 1
        assert report["resumo"]["jogos_sem_prova_prejogo"] == 1
        eligible = next(row for row in report["jogos"] if row["situacao"] == "comprovado")
        assert eligible["previsao"]["placar_modal"] == {"mandante": 1, "visitante": 0}
        assert eligible["top3_situacao"] == "nativo_documentado"
        assert eligible["proveniencia"]["commit"] != documented_history(root, SOURCES[0][0])[-1][0]
        # Empate explícito é um dos três resultados, independentemente do modal.
        assert eligible["previsao"]["probabilidades_ved_pct"]["empate"] == 25
        invalid = dict(report)
        invalid["integridade"] = {"hash_jogos": "tampered"}
        try:
            validate_report(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError("Relatório adulterado passou pela verificação")
    print("E1 SELF-TEST: OK (pré-jogo, cronologia, top-3 nativo, ausência e hash)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--repo", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    repo = args.repo.resolve()
    result = audit(repo)
    output = args.output if args.output.is_absolute() else repo / args.output
    if not args.dry_run:
        output.parent.mkdir(parents=True, exist_ok=True)
        value = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        if not output.exists() or output.read_text(encoding="utf-8") != value:
            temp = output.with_suffix(output.suffix + ".tmp")
            temp.write_text(value, encoding="utf-8")
            temp.replace(output)
    print("E1 HISTÓRICO:", json.dumps(result["resumo"], ensure_ascii=False))
    print("E1 FONTES:", json.dumps(result["varredura_git"]["fontes"], ensure_ascii=False))
    print("E1 INTEGRIDADE:", result["integridade"]["hash_jogos"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
