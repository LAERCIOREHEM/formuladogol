#!/usr/bin/env python3
"""Validação e auditoria da base histórica do projeto AF-Previsão.

Execução 1: não publica probabilidades no site. Ela garante que as temporadas
históricas usadas no backtesting sejam completas, coerentes e rastreáveis.

Uso:
    python scripts/af_previsao_base_historica.py
    python scripts/af_previsao_base_historica.py --self-test
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
HIST_DIR = ROOT / "dados-br" / "historico-af-previsao"
AUDIT_PATH = ROOT / "dados-br" / "auditoria-base-historica-af-previsao.json"
SEASONS = (2023, 2024, 2025)
EXPECTED_MATCHES = 380
EXPECTED_TEAMS = 20
EXPECTED_ROUNDS = 38

OFFICIAL_CHECKS: dict[int, dict[str, Any]] = {
    2023: {
        "campeao": "Palmeiras",
        "pontos_campeao": 70,
        "rebaixados": ["Santos", "Goiás", "Coritiba", "América-MG"],
    },
    2024: {
        "campeao": "Botafogo",
        "pontos_campeao": 79,
        "rebaixados": ["Athletico-PR", "Criciúma", "Atlético-GO", "Cuiabá"],
    },
    2025: {
        "campeao": "Flamengo",
        "pontos_campeao": 79,
        "rebaixados": ["Ceará", "Fortaleza", "Juventude", "Sport"],
    },
}


def now_iso() -> str:
    config_path = ROOT / "dados-br" / "config-af-previsao.json"
    if config_path.exists():
        try:
            return str(load_json(config_path).get("data_referencia_execucao_1"))
        except (OSError, ValueError, json.JSONDecodeError):
            pass
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: raiz JSON precisa ser um objeto")
    return data


def match_result(match: dict[str, Any]) -> str:
    home = int(match["gols_mandante"])
    away = int(match["gols_visitante"])
    if home > away:
        return "mandante"
    if home < away:
        return "visitante"
    return "empate"


def reconstruct_table(matches: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    table: dict[str, dict[str, int]] = defaultdict(
        lambda: {
            "jogos": 0,
            "vitorias": 0,
            "empates": 0,
            "derrotas": 0,
            "gols_pro": 0,
            "gols_contra": 0,
            "pontos": 0,
        }
    )
    for match in matches:
        home = str(match["mandante"])
        away = str(match["visitante"])
        hg = int(match["gols_mandante"])
        ag = int(match["gols_visitante"])
        table[home]["jogos"] += 1
        table[away]["jogos"] += 1
        table[home]["gols_pro"] += hg
        table[home]["gols_contra"] += ag
        table[away]["gols_pro"] += ag
        table[away]["gols_contra"] += hg
        if hg > ag:
            table[home]["vitorias"] += 1
            table[home]["pontos"] += 3
            table[away]["derrotas"] += 1
        elif hg < ag:
            table[away]["vitorias"] += 1
            table[away]["pontos"] += 3
            table[home]["derrotas"] += 1
        else:
            table[home]["empates"] += 1
            table[away]["empates"] += 1
            table[home]["pontos"] += 1
            table[away]["pontos"] += 1

    rows: list[dict[str, Any]] = []
    for club, values in table.items():
        row: dict[str, Any] = {"clube": club, **values}
        row["saldo_gols"] = row["gols_pro"] - row["gols_contra"]
        rows.append(row)
    rows.sort(
        key=lambda row: (
            -row["pontos"],
            -row["vitorias"],
            -row["saldo_gols"],
            -row["gols_pro"],
            row["clube"],
        )
    )
    for position, row in enumerate(rows, start=1):
        row["posicao"] = position
    return rows


def validate_match(match: dict[str, Any], season: int, index: int) -> list[str]:
    errors: list[str] = []
    required = {
        "id_fonte",
        "rodada",
        "data",
        "mandante",
        "visitante",
        "gols_mandante",
        "gols_visitante",
    }
    missing = sorted(required - set(match))
    if missing:
        return [f"partida {index}: campos ausentes: {', '.join(missing)}"]
    try:
        reference = int(match["id_fonte"])
        round_no = int(match["rodada"])
        hg = int(match["gols_mandante"])
        ag = int(match["gols_visitante"])
        date = datetime.strptime(str(match["data"]), "%Y-%m-%d")
    except (TypeError, ValueError) as exc:
        return [f"partida {index}: tipo/formato inválido ({exc})"]
    if reference <= 0:
        errors.append(f"partida {index}: id_fonte não positivo")
    if not 1 <= round_no <= EXPECTED_ROUNDS:
        errors.append(f"partida {index}: rodada fora de 1..38")
    if date.year != season:
        errors.append(f"partida {index}: data {date.date()} fora da temporada {season}")
    if hg < 0 or ag < 0:
        errors.append(f"partida {index}: placar negativo")
    if not str(match["mandante"]).strip() or not str(match["visitante"]).strip():
        errors.append(f"partida {index}: clube vazio")
    if match["mandante"] == match["visitante"]:
        errors.append(f"partida {index}: clube enfrenta a si próprio")
    return errors


def validate_season(data: dict[str, Any], season: int) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    matches = data.get("partidas")
    if not isinstance(matches, list):
        return {
            "temporada": season,
            "status": "erro",
            "erros": ["campo partidas não é uma lista"],
            "avisos": [],
        }
    if data.get("temporada") != season:
        errors.append(f"temporada declarada={data.get('temporada')!r}; esperada={season}")
    if data.get("schema_version") != 1:
        errors.append(f"schema_version={data.get('schema_version')!r}; esperado=1")

    for index, match in enumerate(matches, start=1):
        if not isinstance(match, dict):
            errors.append(f"partida {index}: não é objeto")
            continue
        errors.extend(validate_match(match, season, index))

    teams = sorted(
        {str(match.get("mandante")) for match in matches if isinstance(match, dict)}
        | {str(match.get("visitante")) for match in matches if isinstance(match, dict)}
    )
    refs = [int(match["id_fonte"]) for match in matches if isinstance(match, dict) and "id_fonte" in match]
    rounds = Counter(int(match["rodada"]) for match in matches if isinstance(match, dict) and "rodada" in match)
    directed = Counter(
        (str(match["mandante"]), str(match["visitante"]))
        for match in matches
        if isinstance(match, dict) and "mandante" in match and "visitante" in match
    )
    appearances = Counter()
    for match in matches:
        if not isinstance(match, dict):
            continue
        appearances[str(match.get("mandante"))] += 1
        appearances[str(match.get("visitante"))] += 1

    if len(matches) != EXPECTED_MATCHES:
        errors.append(f"partidas={len(matches)}; esperado={EXPECTED_MATCHES}")
    if len(teams) != EXPECTED_TEAMS:
        errors.append(f"clubes={len(teams)}; esperado={EXPECTED_TEAMS}")
    if len(set(refs)) != len(refs):
        errors.append("id_fonte duplicado")
    if len(rounds) != EXPECTED_ROUNDS:
        errors.append(f"rodadas={len(rounds)}; esperado={EXPECTED_ROUNDS}")
    bad_rounds = {round_no: count for round_no, count in rounds.items() if count != 10}
    if bad_rounds:
        errors.append(f"rodadas sem 10 jogos: {bad_rounds}")
    bad_appearances = {team: count for team, count in appearances.items() if count != 38}
    if bad_appearances:
        errors.append(f"clubes sem 38 partidas: {bad_appearances}")

    pair_errors: list[str] = []
    for home in teams:
        for away in teams:
            if home == away:
                continue
            count = directed[(home, away)]
            if count != 1:
                pair_errors.append(f"{home} x {away}={count}")
    if pair_errors:
        errors.append("ida/volta incompletas: " + "; ".join(pair_errors[:12]))

    reconstructed = reconstruct_table(matches)
    committed = data.get("classificacao_reconstruida")
    if committed != reconstructed:
        errors.append("classificação_reconstruida difere da reconstrução independente")

    official = OFFICIAL_CHECKS[season]
    champion = reconstructed[0] if reconstructed else {}
    relegated = [row["clube"] for row in reconstructed[-4:]] if len(reconstructed) >= 4 else []
    if champion.get("clube") != official["campeao"]:
        errors.append(
            f"campeão reconstruído={champion.get('clube')}; oficial={official['campeao']}"
        )
    if champion.get("pontos") != official["pontos_campeao"]:
        errors.append(
            f"pontos do campeão={champion.get('pontos')}; oficial={official['pontos_campeao']}"
        )
    if relegated != official["rebaixados"]:
        errors.append(f"rebaixados={relegated}; oficial={official['rebaixados']}")

    results = Counter(match_result(match) for match in matches)
    total_goals = sum(int(match["gols_mandante"]) + int(match["gols_visitante"]) for match in matches)
    low_scores = sum(
        1
        for match in matches
        if (int(match["gols_mandante"]), int(match["gols_visitante"]))
        in {(0, 0), (1, 0), (0, 1), (1, 1)}
    )
    dates = [datetime.strptime(str(match["data"]), "%Y-%m-%d") for match in matches]
    if dates != sorted(dates, key=lambda value: value):
        warnings.append("lista não está em ordem cronológica estrita; rodada permanece a chave de ordenação")

    return {
        "temporada": season,
        "status": "ok" if not errors else "erro",
        "arquivo": str((HIST_DIR / f"brasileirao-{season}.json").relative_to(ROOT)),
        "sha256_arquivo_normalizado": sha256_file(HIST_DIR / f"brasileirao-{season}.json"),
        "partidas": len(matches),
        "clubes": len(teams),
        "rodadas": len(rounds),
        "clubes_com_38_jogos": sum(1 for count in appearances.values() if count == 38),
        "confrontos_direcionados_unicos": sum(1 for count in directed.values() if count == 1),
        "gols": total_goals,
        "media_gols": round(total_goals / len(matches), 5) if matches else None,
        "vitorias_mandante": results["mandante"],
        "empates": results["empate"],
        "vitorias_visitante": results["visitante"],
        "placares_baixos_dc": low_scores,
        "proporcao_placares_baixos_dc": round(low_scores / len(matches), 5) if matches else None,
        "primeira_data": min(dates).date().isoformat() if dates else None,
        "ultima_data": max(dates).date().isoformat() if dates else None,
        "campeao_reconstruido": champion.get("clube"),
        "pontos_campeao": champion.get("pontos"),
        "rebaixados_reconstruidos": relegated,
        "clubes_lista": teams,
        "erros": errors,
        "avisos": warnings,
    }


def current_2026_snapshot() -> dict[str, Any]:
    result_path = ROOT / "resultados.json"
    schedule_path = ROOT / "dados-br" / "calendario-completo.json"
    table_path = ROOT / "tabela.json"
    snapshot: dict[str, Any] = {
        "status": "não_disponível",
        "observacao": "O snapshot corrente é auditado apenas para integração futura e não entra no backtesting histórico.",
    }
    if not (result_path.exists() and schedule_path.exists() and table_path.exists()):
        return snapshot
    results = load_json(result_path).get("resultados") or []
    schedule_data = load_json(schedule_path)
    schedule = schedule_data.get("jogos") or schedule_data.get("partidas") or []
    table = load_json(table_path).get("tabela") or []
    snapshot.update(
        {
            "status": "ok",
            "temporada": 2026,
            "resultados_finalizados": len(results),
            "partidas_no_calendario": len(schedule),
            "clubes_na_tabela": len(table),
            "fonte_resultados": load_json(result_path).get("fonte"),
            "fonte_tabela": load_json(table_path).get("fonte"),
            "sha256_resultados": sha256_file(result_path),
            "sha256_calendario": sha256_file(schedule_path),
            "sha256_tabela": sha256_file(table_path),
            "entra_no_backtesting": False,
            "motivo": "temporada em andamento; será usada como estado atual na Execução 2",
        }
    )
    return snapshot


def build_audit() -> dict[str, Any]:
    seasons: list[dict[str, Any]] = []
    for season in SEASONS:
        path = HIST_DIR / f"brasileirao-{season}.json"
        if not path.exists():
            seasons.append(
                {
                    "temporada": season,
                    "status": "erro",
                    "erros": [f"arquivo ausente: {path.relative_to(ROOT)}"],
                    "avisos": [],
                }
            )
            continue
        seasons.append(validate_season(load_json(path), season))

    errors = [
        f"{item['temporada']}: {error}"
        for item in seasons
        for error in item.get("erros", [])
    ]
    total_matches = sum(int(item.get("partidas") or 0) for item in seasons)
    total_goals = sum(int(item.get("gols") or 0) for item in seasons)
    return {
        "schema_version": 1,
        "projeto": "AF-Previsão",
        "etapa": "Execução 1 — base histórica e backtesting",
        "gerado_em": now_iso(),
        "status": "ok" if not errors else "erro",
        "responsavel": {
            "nome": "Laércio Rehem",
            "formacao": "Matemático pela Universidade Federal da Bahia (UFBA)",
            "contato": "Sugestões, elogios e dúvidas: utilize o botão SUGESTÕES do site.",
        },
        "escopo": {
            "temporadas_historicas": list(SEASONS),
            "partidas_historicas": total_matches,
            "gols_historicos": total_goals,
            "uso_da_temporada_2026": "somente snapshot de integração; não entra na validação fora da amostra",
        },
        "temporadas": seasons,
        "snapshot_2026": current_2026_snapshot(),
        "travas": {
            "partidas_por_temporada": EXPECTED_MATCHES,
            "clubes_por_temporada": EXPECTED_TEAMS,
            "rodadas_por_temporada": EXPECTED_ROUNDS,
            "jogos_por_rodada": 10,
            "jogos_por_clube": 38,
            "ida_e_volta_por_par": True,
            "classificacao_reconstruida": True,
            "campeao_e_rebaixados_conferidos": True,
        },
        "erros": errors,
        "observacoes_metodologicas": [
            "As temporadas históricas são usadas exclusivamente para calibração e backtesting.",
            "A temporada corrente nunca é usada como se fosse uma temporada concluída.",
            "Clubes promovidos ou ausentes no histórico recebem regressão à média no modelo regularizado.",
            "Nenhum dado de apostas ou cotações comerciais integra a base.",
        ],
    }


def self_test() -> None:
    synthetic = [
        {
            "id_fonte": 1,
            "rodada": 1,
            "data": "2025-01-01",
            "mandante": "A",
            "visitante": "B",
            "gols_mandante": 2,
            "gols_visitante": 0,
        },
        {
            "id_fonte": 2,
            "rodada": 2,
            "data": "2025-01-08",
            "mandante": "B",
            "visitante": "A",
            "gols_mandante": 1,
            "gols_visitante": 1,
        },
    ]
    table = reconstruct_table(synthetic)
    assert table[0]["clube"] == "A"
    assert table[0]["pontos"] == 4
    assert table[1]["pontos"] == 1
    assert match_result(synthetic[0]) == "mandante"
    assert match_result(synthetic[1]) == "empate"
    assert math.isclose(sum(row["pontos"] for row in table), 5)
    print("SELF-TEST OK — base histórica")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    audit = build_audit()
    AUDIT_PATH.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Auditoria histórica: {audit['status']}")
    print(f"Temporadas: {', '.join(str(season) for season in SEASONS)}")
    print(f"Partidas históricas: {audit['escopo']['partidas_historicas']}")
    print(f"Arquivo: {AUDIT_PATH.relative_to(ROOT)}")
    if audit["erros"]:
        for error in audit["erros"]:
            print(f"ERRO: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
