#!/usr/bin/env python3
"""Publica o fechamento editorial das oitavas da Copa do Brasil 2026.

O fluxo é deliberadamente conservador:
- só publica quando os oito confrontos estiverem concluídos;
- exige que o AF-Previsão publicado corresponda aos snapshots correntes;
- preserva um marco histórico anterior imutável;
- grava o primeiro marco posterior elegível e nunca o reescreve;
- insere placares e percentuais deterministicamente no HTML.

A IA, quando configurada, redige apenas os parágrafos interpretativos sem
algarismos. Resultados, classificados e probabilidades não passam pelo modelo.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping, Sequence

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from af_previsao_continental import (  # noqa: E402
    ContinentalDataNotReady,
    build_ties,
    completed_tie_winner,
    parse_snapshot,
)
from gerar_analise_rodada import (  # noqa: E402
    CAMINHO_ANALISES,
    FUSO_BR,
    MODELO_PADRAO,
    SITE,
    TEMPORADA,
    agora_br,
    cabecalho_html,
    carregar_manifesto,
    chave_ordenacao_artigo,
    comparacao_percentual,
    data_curta,
    esc,
    gerar_feed,
    gerar_hub,
    gerar_news_sitemap,
    gravar_texto,
    menu,
    normalizar_modelo_openai,
    rodape,
    submenu_rodadas,
    atualizar_sitemap,
)
from gerar_probabilidades_brasileirao import current_publication_freshness  # noqa: E402

HISTORY_PATH = ROOT / "dados-br" / "historico-probabilidades-continentais.json"
PROBABILITIES_PATH = ROOT / "dados-br" / "probabilidades-brasileirao.json"
COPA_PATH = ROOT / "dados-br" / "competicoes-af-previsao" / "copa-do-brasil.json"
MANIFEST_PATH = ROOT / "dados-br" / "analises.json"
ARTICLE_ID = "copa-do-brasil-2026-classificados-quartas"
ARTICLE_SLUG = "copa-do-brasil-2026-classificados-quartas.html"
ARTICLE_URL = f"{SITE}/analises/{ARTICLE_SLUG}"
BEFORE_ID = "copa-do-brasil-2026-oitavas-antes-jogos-de-volta"
AFTER_ID = "copa-do-brasil-2026-oitavas-fechamento"
PHASE_RANK = 600
EXPECTED_TIES = 8
EXPECTED_GAMES = 16


class EditorialCopaError(RuntimeError):
    pass


def load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise EditorialCopaError(f"JSON inválido ou ausente: {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise EditorialCopaError(f"{path}: objeto JSON esperado")
    return data


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def mark_hash(mark: Mapping[str, Any]) -> str:
    return canonical_hash({key: value for key, value in mark.items() if key != "hash_marco"})


def validate_history(history: dict[str, Any]) -> None:
    if int(history.get("schema_version") or 0) != 1:
        raise EditorialCopaError("histórico continental em schema inesperado")
    marks = history.get("marcos") or []
    ids: set[str] = set()
    for mark in marks:
        identifier = str(mark.get("id") or "")
        if not identifier or identifier in ids:
            raise EditorialCopaError("histórico continental com id ausente ou duplicado")
        ids.add(identifier)
        if mark.get("hash_marco") != mark_hash(mark):
            raise EditorialCopaError(f"marco continental adulterado ou inconsistente: {identifier}")
    if int(history.get("total_marcos") or -1) != len(marks):
        raise EditorialCopaError("total_marcos divergente")
    if BEFORE_ID not in ids:
        raise EditorialCopaError("marco anterior das oitavas não foi preservado")


def metric_detail(detail: Mapping[str, Any] | None) -> dict[str, Any]:
    detail = detail or {}
    return {
        "percentual_estimado": float(detail.get("percentual_estimado") or 0),
        "exibicao": str(detail.get("exibicao") or "0%"),
        "possivel_estruturalmente": bool(detail.get("possivel_estruturalmente")),
        "impossivel_estruturalmente": bool(detail.get("impossivel_estruturalmente")),
    }


def probability_snapshot(probabilities: dict[str, Any], club_names: Sequence[str]) -> list[dict[str, Any]]:
    by_name = {str(item.get("clube") or ""): item for item in probabilities.get("clubes") or []}
    missing = [name for name in club_names if name not in by_name]
    if missing:
        raise EditorialCopaError("clubes ausentes das probabilidades: " + ", ".join(missing))
    rows: list[dict[str, Any]] = []
    for name in club_names:
        club = by_name[name]
        decomposition = club.get("decomposicao_chances") or {}
        libertadores = decomposition.get("libertadores") or {}
        rows.append(
            {
                "clube": name,
                "posicao_atual": int(club.get("posicao_atual") or 0),
                "pontos_atuais": int(club.get("pontos_atuais") or 0),
                "jogos_atuais": int(club.get("jogos_atuais") or 0),
                "posicao_projetada": int(
                    club.get("posicao_projetada") or club.get("posicao_classificacao_projetada") or 0
                ),
                "pontos_projetados": club.get("pontos_projetados"),
                "libertadores_total": metric_detail(libertadores.get("total")),
                "libertadores_vias": {
                    key: metric_detail(value) for key, value in (libertadores.get("vias") or {}).items()
                },
                "copa_do_brasil_subvias": {
                    key: metric_detail(value)
                    for key, value in (libertadores.get("subvias_copa_do_brasil") or {}).items()
                },
                "sul_americana_total": metric_detail(
                    (decomposition.get("sul_americana") or {}).get("total")
                ),
                "rebaixamento": metric_detail(
                    (club.get("probabilidades_detalhes") or {}).get("rebaixamento")
                ),
            }
        )
    return rows


def raw_events_by_id(snapshot: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(item.get("event_id") or ""): item for item in snapshot.get("eventos") or []}


def validate_phase_probabilities(probabilities: dict[str, Any], phase: dict[str, Any]) -> None:
    """Impede congelar um pós-fase antes de o AF refletir classificados e eliminados."""
    by_name = {str(item.get("clube") or ""): item for item in probabilities.get("clubes") or []}
    classified = set(phase.get("classificados") or [])
    eliminated = set(phase.get("eliminados") or [])
    errors: list[str] = []
    for name in phase.get("clubes_serie_a_na_fase") or []:
        club = by_name.get(name)
        if not club:
            errors.append(f"{name}: ausente das probabilidades")
            continue
        libertadores = ((club.get("decomposicao_chances") or {}).get("libertadores") or {})
        cup_path = (libertadores.get("vias") or {}).get("via_copa_do_brasil") or {}
        subpaths = libertadores.get("subvias_copa_do_brasil") or {}
        percent = float(cup_path.get("percentual_estimado") or 0)
        possible = bool(cup_path.get("possivel_estruturalmente"))
        impossible = bool(cup_path.get("impossivel_estruturalmente"))
        if name in eliminated:
            if abs(percent) > 1e-12 or possible or not impossible:
                errors.append(f"{name}: eliminado ainda conserva chance estrutural via Copa do Brasil")
            for key in ("campeao", "vice", "vice_herda_vaga_direta"):
                detail = subpaths.get(key) or {}
                if (
                    abs(float(detail.get("percentual_estimado") or 0)) > 1e-12
                    or bool(detail.get("possivel_estruturalmente"))
                    or not bool(detail.get("impossivel_estruturalmente"))
                ):
                    errors.append(f"{name}: subvia {key} não foi zerada após a eliminação")
        elif name in classified:
            if not possible or impossible:
                errors.append(f"{name}: classificado não está ativo estruturalmente na Copa do Brasil")
        else:
            errors.append(f"{name}: situação indefinida no fechamento das oitavas")
    if errors:
        raise EditorialCopaError("AF-Previsão ainda não fechou a fase: " + "; ".join(errors))


def phase_summary(snapshot: dict[str, Any]) -> dict[str, Any]:
    _, events, _ = parse_snapshot(snapshot)
    phase_events = [event for event in events if event.stage_rank == PHASE_RANK]
    ties = build_ties(phase_events)
    if len(ties) != EXPECTED_TIES or len(phase_events) != EXPECTED_GAMES:
        raise EditorialCopaError(
            f"oitavas incompletas na estrutura: {len(ties)} confrontos e {len(phase_events)} jogos"
        )
    raw_by_id = raw_events_by_id(snapshot)
    rows: list[dict[str, Any]] = []
    winners: list[str] = []
    losers: list[str] = []
    series_a: set[str] = set()
    all_complete = True
    for index, tie in enumerate(ties, start=1):
        complete = all(event.completed for event in tie.events)
        all_complete = all_complete and complete
        winner = completed_tie_winner(tie) if complete else None
        loser = None
        if winner:
            loser = tie.team_b if winner == tie.team_a else tie.team_a
            winners.append(winner)
            losers.append(loser)
        aggregate = {tie.team_a: 0, tie.team_b: 0}
        games = []
        teams_meta: dict[str, dict[str, Any]] = {}
        for event in sorted(tie.events, key=lambda item: (item.played_at, item.event_id)):
            raw = raw_by_id[event.event_id]
            for side in (raw.get("mandante") or {}, raw.get("visitante") or {}):
                name = str(side.get("nome") or side.get("nome_espn") or "")
                teams_meta[name] = {
                    "nome": name,
                    "espn_id": str(side.get("espn_id") or ""),
                    "sigla": str(side.get("sigla") or ""),
                    "serie_a_2026": bool(side.get("serie_a_2026")),
                }
                if side.get("serie_a_2026"):
                    series_a.add(name)
            home = str((raw.get("mandante") or {}).get("nome") or "")
            away = str((raw.get("visitante") or {}).get("nome") or "")
            home_goals = (raw.get("mandante") or {}).get("placar")
            away_goals = (raw.get("visitante") or {}).get("placar")
            if home_goals is not None and away_goals is not None:
                aggregate[home] += int(home_goals)
                aggregate[away] += int(away_goals)
            games.append(
                {
                    "event_id": event.event_id,
                    "perna": int(raw.get("perna") or len(games) + 1),
                    "data_iso": raw.get("data_iso"),
                    "estadio": raw.get("estadio"),
                    "mandante": home,
                    "visitante": away,
                    "placar_mandante": home_goals,
                    "placar_visitante": away_goals,
                    "concluido": bool(raw.get("concluido")),
                    "vencedor": raw.get("vencedor"),
                    "penaltis": bool(raw.get("penaltis")),
                }
            )
        rows.append(
            {
                "ordem": index,
                "chave": tie.key,
                "equipe_a": teams_meta[tie.team_a],
                "equipe_b": teams_meta[tie.team_b],
                "jogos": games,
                "agregado": aggregate,
                "concluido": complete,
                "classificado": winner,
                "eliminado": loser,
                "decidido_nos_penaltis": any(game["penaltis"] for game in games),
            }
        )
    return {
        "fase": "Oitavas de final",
        "fase_ordem": PHASE_RANK,
        "confrontos": rows,
        "todos_concluidos": all_complete,
        "classificados": sorted(winners),
        "eliminados": sorted(losers),
        "clubes_serie_a_na_fase": sorted(series_a),
    }


def source_metadata(probabilities: dict[str, Any], cup_snapshot: dict[str, Any]) -> dict[str, Any]:
    return {
        "probabilidades_calculadas_em": probabilities.get("calculado_em"),
        "probabilidades_referencia_esportiva_em": probabilities.get("referencia_esportiva_em"),
        "probabilidades_hash_entrada": probabilities.get("hash_entrada"),
        "probabilidades_hash_snapshots": (
            probabilities.get("integracao_continental") or {}
        ).get("hash_snapshots"),
        "copa_snapshot_gerado_em": cup_snapshot.get("gerado_em"),
        "copa_fase_atual": cup_snapshot.get("fase_atual"),
    }


def build_after_mark(
    probabilities: dict[str, Any], cup_snapshot: dict[str, Any], phase: dict[str, Any]
) -> dict[str, Any]:
    mark = {
        "id": AFTER_ID,
        "competicao": "copa_do_brasil",
        "competicao_nome": "Copa do Brasil",
        "temporada": TEMPORADA,
        "fase": "Oitavas de final",
        "fase_ordem": PHASE_RANK,
        "tipo": "depois",
        "descricao": "Primeira fotografia imutável do AF-Previsão após o encerramento integral das oitavas de final.",
        "registrado_em": probabilities.get("calculado_em"),
        "fonte": source_metadata(probabilities, cup_snapshot),
        "clubes_serie_a_na_fase": phase["clubes_serie_a_na_fase"],
        "classificados": phase["classificados"],
        "eliminados": phase["eliminados"],
        "confrontos": phase["confrontos"],
        "clubes": probability_snapshot(probabilities, phase["clubes_serie_a_na_fase"]),
    }
    mark["hash_marco"] = mark_hash(mark)
    return mark


def find_mark(history: dict[str, Any], identifier: str) -> dict[str, Any] | None:
    return next((mark for mark in history.get("marcos") or [] if mark.get("id") == identifier), None)


def metric(row: Mapping[str, Any], path: Sequence[str]) -> dict[str, Any]:
    value: Any = row
    for key in path:
        value = value.get(key) if isinstance(value, Mapping) else None
    return value if isinstance(value, dict) else metric_detail(None)


def dossier(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    before_rows = {row["clube"]: row for row in before.get("clubes") or []}
    after_rows = {row["clube"]: row for row in after.get("clubes") or []}
    if set(before_rows) != set(after_rows):
        raise EditorialCopaError("marcos anterior e posterior não cobrem os mesmos clubes da Série A")
    classified = set(after.get("classificados") or [])
    eliminated = set(after.get("eliminados") or [])
    comparisons = []
    for name in sorted(before_rows):
        old, new = before_rows[name], after_rows[name]
        old_total = metric(old, ("libertadores_total",))
        new_total = metric(new, ("libertadores_total",))
        old_cup = metric(old, ("libertadores_vias", "via_copa_do_brasil"))
        new_cup = metric(new, ("libertadores_vias", "via_copa_do_brasil"))
        status = "classificado" if name in classified else "eliminado" if name in eliminated else "fora_da_fase"
        comparisons.append(
            {
                "clube": name,
                "situacao": status,
                "libertadores_antes": old_total,
                "libertadores_depois": new_total,
                "libertadores_delta": new_total["percentual_estimado"] - old_total["percentual_estimado"],
                "via_copa_antes": old_cup,
                "via_copa_depois": new_cup,
                "via_copa_delta": new_cup["percentual_estimado"] - old_cup["percentual_estimado"],
                "campeao_antes": metric(old, ("copa_do_brasil_subvias", "campeao")),
                "campeao_depois": metric(new, ("copa_do_brasil_subvias", "campeao")),
                "vice_antes": metric(old, ("copa_do_brasil_subvias", "vice")),
                "vice_depois": metric(new, ("copa_do_brasil_subvias", "vice")),
            }
        )
    comparisons.sort(
        key=lambda row: (
            row["situacao"] != "classificado",
            -abs(row["via_copa_delta"]),
            row["clube"],
        )
    )
    return {
        "id_editorial": ARTICLE_ID,
        "competicao": "Copa do Brasil",
        "fase_encerrada": "Oitavas de final",
        "fase_seguinte": "Quartas de final",
        "classificados": after.get("classificados") or [],
        "eliminados": after.get("eliminados") or [],
        "confrontos": after.get("confrontos") or [],
        "comparacoes": comparisons,
        "antes": before.get("fonte") or {},
        "depois": after.get("fonte") or {},
        "simulacoes": int(
            next(iter(after_rows.values())).get("libertadores_total", {}).get("simulacoes") or 2_000_000
        ),
        "hash_antes": before.get("hash_marco"),
        "hash_depois": after.get("hash_marco"),
    }


def narrative_fallback(data: dict[str, Any]) -> dict[str, Any]:
    rises = sorted(data["comparacoes"], key=lambda row: row["via_copa_delta"], reverse=True)
    falls = sorted(data["comparacoes"], key=lambda row: row["via_copa_delta"])
    risers = [row["clube"] for row in rises if row["via_copa_delta"] > 0][:3]
    losers = [row["clube"] for row in falls if row["situacao"] == "eliminado"][:3]
    rise_text = ", ".join(risers[:-1]) + (" e " + risers[-1] if len(risers) > 1 else risers[0] if risers else "os classificados da Série A")
    loss_text = ", ".join(losers[:-1]) + (" e " + losers[-1] if len(losers) > 1 else losers[0] if losers else "os eliminados")
    return {
        "titulo": "Copa do Brasil: definidos os classificados às quartas de final",
        "linha_fina": "Os jogos de ida e volta fecharam as oitavas, definiram os oito sobreviventes e alteraram o caminho dos clubes da Série A rumo à Libertadores.",
        "secoes": [
            {
                "titulo": "O mata-mata fechou a lista, não os confrontos",
                "paragrafos": [
                    "As oitavas terminaram com oito clubes ainda vivos na Copa do Brasil. A definição desta fase encerra cada confronto de ida e volta, mas não antecipa os duelos seguintes: o sorteio ainda determinará quem enfrenta quem nas quartas de final.",
                    "A leitura desta página parte dos placares oficiais, do agregado de cada chave e da identificação objetiva de classificado e eliminado. O recorte editorial evita misturar esse fechamento com a tabela do Brasileirão e concentra a análise no efeito esportivo produzido pelo torneio eliminatório.",
                ],
            },
            {
                "titulo": "A classificação abriu uma rota continental mais forte",
                "paragrafos": [
                    f"Entre os clubes da Série A presentes nas oitavas, {rise_text} aparecem entre os principais beneficiados pela sobrevivência no torneio. Avançar não garante a Libertadores, mas mantém abertas as possibilidades de título, vice-campeonato e redistribuição da vaga prevista pelo modelo.",
                    "Esse impacto não deve ser lido isoladamente. O AF-Previsão atribui uma única via principal a cada classificação simulada, evitando contar duas vezes o clube que já alcançaria a Libertadores pelo Brasileirão e também teria sucesso na Copa do Brasil.",
                ],
            },
            {
                "titulo": "Para os eliminados, a via da Copa foi encerrada",
                "paragrafos": [
                    f"A eliminação retirou de {loss_text} qualquer possibilidade de chegar à Libertadores pela Copa do Brasil. Nesses casos, a coluna da via do mata-mata passa a mostrar zero, enquanto a chance consolidada ainda pode existir por posições no Brasileirão ou por repasses de vagas.",
                    "A tabela final compara a fotografia anterior aos jogos de volta com o primeiro cálculo publicado depois do fechamento integral da fase. Dessa forma, a variação registrada pertence a um marco preservado e não será reescrita por rodadas posteriores do campeonato nacional.",
                ],
            },
        ],
    }


def editorial_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "titulo": {"type": "string", "minLength": 45, "maxLength": 125},
            "linha_fina": {"type": "string", "minLength": 80, "maxLength": 220},
            "secoes": {
                "type": "array",
                "minItems": 3,
                "maxItems": 3,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "titulo": {"type": "string", "minLength": 20, "maxLength": 85},
                        "paragrafos": {
                            "type": "array",
                            "minItems": 2,
                            "maxItems": 2,
                            "items": {"type": "string", "minLength": 120, "maxLength": 650},
                        },
                    },
                    "required": ["titulo", "paragrafos"],
                },
            },
        },
        "required": ["titulo", "linha_fina", "secoes"],
    }


def editorial_summary(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "competicao": data["competicao"],
        "fase_encerrada": data["fase_encerrada"],
        "fase_seguinte": data["fase_seguinte"],
        "classificados": data["classificados"],
        "eliminados": data["eliminados"],
        "clubes_serie_a": [
            {
                "clube": row["clube"],
                "situacao": row["situacao"],
                "movimento_via_copa": (
                    "alta" if row["via_copa_delta"] > 0 else "queda" if row["via_copa_delta"] < 0 else "estavel"
                ),
                "movimento_libertadores_total": (
                    "alta" if row["libertadores_delta"] > 0 else "queda" if row["libertadores_delta"] < 0 else "estavel"
                ),
            }
            for row in data["comparacoes"]
        ],
    }


def call_openai(data: dict[str, Any], model: str) -> dict[str, Any]:
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        raise EditorialCopaError("OPENAI_API_KEY não configurada")
    instruction = (
        "Você é o editor esportivo do Fórmula do Gol. Redija uma análise breve e sóbria sobre o fechamento das oitavas "
        "da Copa do Brasil, usando exclusivamente o dossiê fornecido. Deixe explícito que foram definidos os classificados, "
        "não os confrontos das quartas, pois haverá sorteio. Não invente fatos táticos, jogadores, declarações ou causas. "
        "Não escreva algarismos nem percentuais: os dados auditados serão inseridos pelo template. Diferencie chance total de "
        "Libertadores e via específica da Copa do Brasil. Evite clichês, frases motivacionais e linguagem publicitária."
    )
    payload = {
        "model": model,
        "store": False,
        "reasoning": {"effort": "medium"},
        "input": [
            {"role": "developer", "content": instruction},
            {
                "role": "user",
                "content": "Dossiê factual auditado:\n"
                + json.dumps(editorial_summary(data), ensure_ascii=False, separators=(",", ":")),
            },
        ],
        "max_output_tokens": 3200,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "analise_copa_do_brasil",
                "strict": True,
                "schema": editorial_schema(),
            }
        },
    }
    response: dict[str, Any] | None = None
    for attempt in range(1, 4):
        request = urllib.request.Request(
            "https://api.openai.com/v1/responses",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=150) as raw:
                response = json.loads(raw.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:600]
            if exc.code not in {408, 409, 429, 500, 502, 503, 504} or attempt == 3:
                raise EditorialCopaError(f"OpenAI respondeu HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            if attempt == 3:
                raise EditorialCopaError(f"Falha na API da OpenAI após três tentativas: {exc}") from exc
        time.sleep(2 ** (attempt - 1))
    texts = []
    for output in (response or {}).get("output") or []:
        for part in output.get("content") or []:
            if part.get("type") == "output_text" and part.get("text"):
                texts.append(part["text"])
    if not texts:
        raise EditorialCopaError("Resposta da OpenAI sem output_text")
    try:
        return json.loads("".join(texts))
    except json.JSONDecodeError as exc:
        raise EditorialCopaError("Resposta editorial não é JSON válido") from exc


def validate_editorial(editorial: dict[str, Any], data: dict[str, Any]) -> None:
    if set(editorial) != {"titulo", "linha_fina", "secoes"}:
        raise EditorialCopaError("editorial fora do schema")
    if "Copa do Brasil" not in editorial["titulo"]:
        raise EditorialCopaError("título não identifica a Copa do Brasil")
    if "classific" not in editorial["titulo"].casefold():
        raise EditorialCopaError("título não comunica a definição dos classificados")
    sections = editorial.get("secoes") or []
    if len(sections) != 3 or any(len(section.get("paragrafos") or []) != 2 for section in sections):
        raise EditorialCopaError("editorial deve ter três seções curtas")
    values = [editorial["titulo"], editorial["linha_fina"]]
    for section in sections:
        values.append(section.get("titulo"))
        values.extend(section.get("paragrafos") or [])
    if not all(isinstance(value, str) and value.strip() for value in values):
        raise EditorialCopaError("editorial incompleto")
    text = " ".join(values)
    if re.search(r"\d", text):
        raise EditorialCopaError("editorial narrativo incluiu algarismos")
    forbidden = ["confrontos definidos", "duelos definidos", "vale destacar", "a narrativa", "mergulhar", "jornada"]
    if any(term in text.casefold() for term in forbidden):
        raise EditorialCopaError("editorial contém afirmação ou linguagem proibida")
    known = set(data["classificados"]) | set(data["eliminados"])
    if not any(name.casefold() in text.casefold() for name in known):
        raise EditorialCopaError("editorial não menciona nenhum clube do dossiê")
    word_count = len(re.findall(r"\b[\wÀ-ÿ-]+\b", " ".join(p for s in sections for p in s["paragrafos"])))
    if not 240 <= word_count <= 650:
        raise EditorialCopaError(f"editorial fora do tamanho sucinto: {word_count} palavras")


def team_logo(team: Mapping[str, Any]) -> str:
    espn_id = re.sub(r"\D", "", str(team.get("espn_id") or ""))
    if not espn_id:
        return ""
    return f"https://a.espncdn.com/i/teamlogos/soccer/500/{espn_id}.png"


def date_game(value: Any) -> str:
    if not value:
        return "Data não informada"
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=FUSO_BR)
    return parsed.astimezone(FUSO_BR).strftime("%d/%m/%Y · %H:%M")


def render_team(team: Mapping[str, Any], classified: str | None) -> str:
    name = str(team.get("nome") or "")
    logo = team_logo(team)
    image = f'<img src="{esc(logo)}" alt="" loading="lazy">' if logo else '<span aria-hidden="true">⚽</span>'
    status = '<small>CLASSIFICADO</small>' if name == classified else '<small>ELIMINADO</small>'
    return f'<div class="analysis-cup-team"><div class="analysis-cup-crest">{image}</div><strong>{esc(name)}</strong>{status}</div>'


def render_tie(tie: Mapping[str, Any]) -> str:
    classified = str(tie.get("classificado") or "")
    eliminated = str(tie.get("eliminado") or "")
    team_a = tie["equipe_a"]
    team_b = tie["equipe_b"]
    aggregate = tie.get("agregado") or {}
    games_html = []
    for game in sorted(tie.get("jogos") or [], key=lambda item: (int(item.get("perna") or 0), item.get("data_iso") or "")):
        leg = "IDA" if int(game.get("perna") or 0) == 1 else "VOLTA"
        score = (
            f'{esc(game["mandante"])} <b>{int(game["placar_mandante"]) if game.get("placar_mandante") is not None else "—"} × '
            f'{int(game["placar_visitante"]) if game.get("placar_visitante") is not None else "—"}</b> {esc(game["visitante"])}'
        )
        stadium = f'<small>📍 {esc(game.get("estadio"))}</small>' if game.get("estadio") else ""
        games_html.append(
            f'<div class="analysis-cup-leg"><span>{leg}</span><time datetime="{esc(game.get("data_iso") or "")}">{esc(date_game(game.get("data_iso")))}</time><p>{score}</p>{stadium}</div>'
        )
    penalty = " · decisão nos pênaltis" if tie.get("decidido_nos_penaltis") else ""
    return f'''<article class="analysis-cup-tie">
      <header><span>CONFRONTO {int(tie.get("ordem") or 0)}</span><b>ENCERRADO</b></header>
      <div class="analysis-cup-matchup">
        {render_team(team_a, classified)}
        <div class="analysis-cup-aggregate"><span>AGREGADO</span><strong>{int(aggregate.get(team_a['nome']) or 0)} × {int(aggregate.get(team_b['nome']) or 0)}</strong></div>
        {render_team(team_b, classified)}
      </div>
      <div class="analysis-cup-legs">{''.join(games_html)}</div>
      <footer><strong>Classificado: {esc(classified)}</strong><span>Eliminado: {esc(eliminated)}{esc(penalty)}</span></footer>
    </article>'''


def status_label(status: str) -> str:
    return "Classificado" if status == "classificado" else "Eliminado" if status == "eliminado" else "Fora da fase"


def comparison_table(data: dict[str, Any]) -> str:
    rows = []
    for row in data["comparacoes"]:
        total_before, total_after, total_delta = comparacao_percentual(
            row["libertadores_antes"]["percentual_estimado"],
            row["libertadores_depois"]["percentual_estimado"],
            row["libertadores_antes"]["possivel_estruturalmente"],
            row["libertadores_depois"]["possivel_estruturalmente"],
        )
        cup_before, cup_after, cup_delta = comparacao_percentual(
            row["via_copa_antes"]["percentual_estimado"],
            row["via_copa_depois"]["percentual_estimado"],
            row["via_copa_antes"]["possivel_estruturalmente"],
            row["via_copa_depois"]["possivel_estruturalmente"],
        )
        total_class = "delta-up" if row["libertadores_delta"] > 0 else "delta-down" if row["libertadores_delta"] < 0 else "delta-flat"
        cup_class = "delta-up" if row["via_copa_delta"] > 0 else "delta-down" if row["via_copa_delta"] < 0 else "delta-flat"
        status_class = "status-qualified" if row["situacao"] == "classificado" else "status-eliminated"
        rows.append(
            f'''<tr><th scope="row">{esc(row['clube'])}</th><td><span class="analysis-status {status_class}">{status_label(row['situacao'])}</span></td>
            <td>{esc(total_before)}</td><td>{esc(total_after)}</td><td class="delta {total_class}">{esc(total_delta)}</td>
            <td>{esc(cup_before)}</td><td>{esc(cup_after)}</td><td class="delta {cup_class}">{esc(cup_delta)}</td></tr>'''
        )
    return '''<div class="analysis-table-wrap" tabindex="0" aria-label="Comparação das probabilidades antes e depois das oitavas">
      <table class="analysis-table analysis-cup-prob-table"><thead><tr><th>Clube</th><th>Situação</th><th>Libertadores antes</th><th>Depois</th><th>Variação</th><th>Via Copa antes</th><th>Depois</th><th>Variação</th></tr></thead><tbody>''' + "".join(rows) + "</tbody></table></div>"


def render_article(data: dict[str, Any], editorial: dict[str, Any], published: str, modified: str, articles: list[dict[str, Any]]) -> tuple[str, dict[str, Any]]:
    sections = "".join(
        '<section class="analysis-copy-section"><h3>'
        + esc(section["titulo"])
        + "</h3>"
        + "".join(f"<p>{esc(paragraph)}</p>" for paragraph in section["paragrafos"])
        + "</section>"
        for section in editorial["secoes"]
    )
    ties = "".join(render_tie(tie) for tie in data["confrontos"])
    before_date = data["antes"].get("probabilidades_calculadas_em") or ""
    after_date = data["depois"].get("probabilidades_calculadas_em") or ""
    navigation_history = [article for article in articles if article.get("id_editorial") != ARTICLE_ID]
    navigation_history.append(
        {
            "id_editorial": ARTICLE_ID,
            "rotulo_menu": "CB · QF",
            "slug": ARTICLE_SLUG,
            "publicado_em": published,
        }
    )
    page = cabecalho_html(
        editorial["titulo"], editorial["linha_fina"], ARTICLE_URL, "NewsArticle", published, modified
    ) + f'''
<body data-fdg-editorial-id="{ARTICLE_ID}" data-fdg-analise-competicao="copa-do-brasil">
  <div class="container analysis-shell">
    <header class="hero" aria-label="Fórmula do Gol — A matemática por trás do futebol"><img src="../img/header-formula-do-gol-v2.png" alt="Fórmula do Gol — A matemática por trás do futebol" fetchpriority="high"></header>
    {menu('../', True)}
    {submenu_rodadas(navigation_history, id_ativo=ARTICLE_ID)}
    <main>
      <article class="analysis-article analysis-cup-article">
        <nav class="analysis-breadcrumb" aria-label="Navegação estrutural"><a href="./">Análises</a><span>›</span><span>Copa do Brasil</span></nav>
        <header class="analysis-head">
          <div class="analysis-published"><time datetime="{esc(published)}">Publicado em {data_curta(published)}</time></div>
          <span class="analysis-tag">COPA DO BRASIL · CLASSIFICADOS ÀS QUARTAS</span>
          <h1>{esc(editorial['titulo'])}</h1>
          <p class="analysis-deck">{esc(editorial['linha_fina'])}</p>
          <div class="analysis-byline">Por <a href="../sobre.html">Laércio Rehem</a></div>
        </header>
        <section class="analysis-copy"><h2>O fechamento das oitavas</h2><div class="analysis-copy-sections">{sections}</div></section>
        <section><h2>Ida, volta e quem avançou</h2><p class="analysis-help">Os oito classificados estão definidos. Os confrontos das quartas dependerão do sorteio.</p><div class="analysis-cup-ties">{ties}</div></section>
        <section><h2>O impacto para os clubes da Série A</h2><p class="analysis-help">A comparação usa uma fotografia preservada antes dos jogos de volta e o primeiro AF-Previsão publicado após o encerramento integral das oitavas. No celular, arraste a tabela para o lado.</p>
          <p class="analysis-snapshot-line"><span>Antes: {esc(data_curta(before_date))}</span><span>Depois: {esc(data_curta(after_date))}</span></p>
          <p class="analysis-percent-legend"><strong>Como ler:</strong> a chance total de Libertadores considera todas as vias. A coluna <b>Via Copa</b> mostra somente os cenários em que a Copa do Brasil foi necessária para a classificação. Clube eliminado recebe <b>0%</b> nessa via.</p>
          {comparison_table(data)}
        </section>
        <aside class="analysis-method"><strong>Leitura dos dados:</strong> resultados e classificados vêm do snapshot auditado da ESPN. As probabilidades são estimativas do AF-Previsão em 2.000.000 simulações. Os marcos anterior e posterior são imutáveis e identificados por hash.</aside>
        <nav class="analysis-next" aria-label="Mais conteúdo"><a href="./">← Todas as análises</a><a href="../estatisticas.html#probabilidades">Probabilidades atuais →</a></nav>
      </article>
    </main>
    {rodape('../')}
  </div>
  <script src="../js/br-menu.js?v=20260724-status-dot-v2"></script>
  <script src="../js/br-analises.js?v=20260805-editorial-continental-v1"></script>
</body>
</html>'''
    metadata = {
        "tipo": "copa_do_brasil_fase",
        "id_editorial": ARTICLE_ID,
        "rotulo_menu": "CB · QF",
        "categoria": "COPA DO BRASIL · QUARTAS DE FINAL",
        "competicao": "Copa do Brasil",
        "fase_encerrada": "Oitavas de final",
        "fase_seguinte": "Quartas de final",
        "slug": ARTICLE_SLUG,
        "url": ARTICLE_URL,
        "titulo": editorial["titulo"],
        "linha_fina": editorial["linha_fina"],
        "publicado_em": published,
        "modificado_em": modified,
        "jogos_concluidos": EXPECTED_GAMES,
        "jogos_pendentes": 0,
        "confrontos": EXPECTED_TIES,
        "classificados": data["classificados"],
        "hash_dossie": canonical_hash(data),
        "hash_editorial": canonical_hash(editorial_summary(data)),
        "editorial": editorial,
        "email_assunto": "Fórmula do Gol: definidos os classificados às quartas da Copa do Brasil",
        "email_chamada": "As oitavas terminaram. Veja os oito classificados e como os resultados alteraram as chances de Libertadores dos clubes da Série A.",
    }
    return page, metadata


def update_history(history: dict[str, Any], mark: dict[str, Any]) -> None:
    if find_mark(history, mark["id"]):
        return
    history.setdefault("marcos", []).append(mark)
    history["total_marcos"] = len(history["marcos"])
    validate_history(history)


def execute(args: argparse.Namespace) -> int:
    history = load_json(HISTORY_PATH)
    validate_history(history)
    cup_snapshot = load_json(COPA_PATH)
    phase = phase_summary(cup_snapshot)
    if not phase["todos_concluidos"]:
        completed = sum(1 for tie in phase["confrontos"] if tie["concluido"])
        print(f"Oitavas ainda em andamento: {completed}/{EXPECTED_TIES} confrontos encerrados.")
        return 0
    if len(phase["classificados"]) != EXPECTED_TIES or len(set(phase["classificados"])) != EXPECTED_TIES:
        raise EditorialCopaError("a fase terminou, mas os oito classificados não foram identificados")
    freshness = current_publication_freshness()
    if freshness.get("atualizado") is not True:
        print("AF-Previsão ainda não corresponde ao fechamento das oitavas: " + "; ".join(freshness.get("motivos") or []))
        return 0
    probabilities = load_json(PROBABILITIES_PATH)
    validate_phase_probabilities(probabilities, phase)
    before = find_mark(history, BEFORE_ID)
    assert before is not None
    after = find_mark(history, AFTER_ID)
    history_changed = False
    if after is None:
        after = build_after_mark(probabilities, cup_snapshot, phase)
        update_history(history, after)
        history_changed = True
    data = dossier(before, after)
    manifest = carregar_manifesto()
    articles = manifest.get("artigos") or []
    existing = next((article for article in articles if article.get("id_editorial") == ARTICLE_ID), None)
    dossier_hash = canonical_hash(data)
    if existing and existing.get("hash_dossie") == dossier_hash and not args.forcar:
        if history_changed and not args.dry_run:
            gravar_texto(HISTORY_PATH, json.dumps(history, ensure_ascii=False, indent=2))
        print("Editorial da Copa do Brasil já publicado com o mesmo fechamento.")
        return 0
    fallback = narrative_fallback(data)
    if args.sem_ia:
        editorial, origin = fallback, "deterministico"
    else:
        model = normalizar_modelo_openai(args.modelo)
        try:
            editorial = call_openai(data, model)
            origin = f"openai:{model}"
        except EditorialCopaError as exc:
            print(f"Aviso: redação por IA indisponível ({exc}); usando contingência determinística.")
            editorial, origin = fallback, "deterministico-contingencia"
    validate_editorial(editorial, data)
    published = existing.get("publicado_em") if existing else agora_br().replace(microsecond=0).isoformat()
    modified = agora_br().replace(microsecond=0).isoformat()
    page, metadata = render_article(data, editorial, published, modified, articles)
    metadata["origem_editorial"] = origin
    articles = [article for article in articles if article.get("id_editorial") != ARTICLE_ID] + [metadata]
    articles.sort(key=chave_ordenacao_artigo)
    manifest.update(
        {
            "schema_version": 2,
            "site": "Fórmula do Gol",
            "temporada": TEMPORADA,
            "atualizado_em": modified,
            "total_artigos": len(articles),
            "artigos": articles,
        }
    )
    if args.dry_run:
        print(json.dumps({"metadados": metadata, "classificados": data["classificados"]}, ensure_ascii=False, indent=2))
        return 0
    gravar_texto(HISTORY_PATH, json.dumps(history, ensure_ascii=False, indent=2))
    gravar_texto(CAMINHO_ANALISES / ARTICLE_SLUG, page)
    gravar_texto(CAMINHO_ANALISES / "index.html", gerar_hub(articles))
    gravar_texto(MANIFEST_PATH, json.dumps(manifest, ensure_ascii=False, indent=2))
    atualizar_sitemap(articles)
    moment = agora_br()
    gravar_texto(ROOT / "news-sitemap.xml", gerar_news_sitemap(articles, moment))
    gravar_texto(ROOT / "feed.xml", gerar_feed(articles, moment))
    print(f"Editorial da Copa do Brasil gerado: {ARTICLE_URL} ({origin}).")
    return 0


def synthetic_data() -> dict[str, Any]:
    ties = []
    for index in range(8):
        a, b = f"Equipe {chr(65 + index * 2)}", f"Equipe {chr(66 + index * 2)}"
        ties.append(
            {
                "ordem": index + 1,
                "equipe_a": {"nome": a, "espn_id": str(100 + index * 2)},
                "equipe_b": {"nome": b, "espn_id": str(101 + index * 2)},
                "jogos": [
                    {"perna": 1, "data_iso": "2026-08-01T19:00:00-03:00", "mandante": a, "visitante": b, "placar_mandante": 1, "placar_visitante": 0, "estadio": "Estádio A"},
                    {"perna": 2, "data_iso": "2026-08-06T21:00:00-03:00", "mandante": b, "visitante": a, "placar_mandante": 0, "placar_visitante": 0, "estadio": "Estádio B"},
                ],
                "agregado": {a: 1, b: 0},
                "classificado": a,
                "eliminado": b,
                "decidido_nos_penaltis": False,
            }
        )
    clubs = [tie["classificado"] for tie in ties[:7]] + [tie["eliminado"] for tie in ties[:7]]
    comparisons = []
    for index, name in enumerate(clubs):
        qualified = index < 7
        before = 2.0 + index
        after = before + 4.0 if qualified else max(0.0, before - 2.0)
        cup_before = 1.0 + index
        cup_after = cup_before + 6.0 if qualified else 0.0
        comparisons.append(
            {
                "clube": name,
                "situacao": "classificado" if qualified else "eliminado",
                "libertadores_antes": {"percentual_estimado": before, "possivel_estruturalmente": True},
                "libertadores_depois": {"percentual_estimado": after, "possivel_estruturalmente": True},
                "libertadores_delta": after - before,
                "via_copa_antes": {"percentual_estimado": cup_before, "possivel_estruturalmente": True},
                "via_copa_depois": {"percentual_estimado": cup_after, "possivel_estruturalmente": qualified},
                "via_copa_delta": cup_after - cup_before,
                "campeao_antes": {}, "campeao_depois": {}, "vice_antes": {}, "vice_depois": {},
            }
        )
    return {
        "id_editorial": ARTICLE_ID,
        "competicao": "Copa do Brasil",
        "fase_encerrada": "Oitavas de final",
        "fase_seguinte": "Quartas de final",
        "classificados": [tie["classificado"] for tie in ties],
        "eliminados": [tie["eliminado"] for tie in ties],
        "confrontos": ties,
        "comparacoes": comparisons,
        "antes": {"probabilidades_calculadas_em": "2026-08-04T02:13:04-03:00"},
        "depois": {"probabilidades_calculadas_em": "2026-08-07T00:10:00-03:00"},
        "simulacoes": 2_000_000,
        "hash_antes": "a" * 64,
        "hash_depois": "b" * 64,
    }


def self_test() -> int:
    history = load_json(HISTORY_PATH)
    validate_history(history)
    before = find_mark(history, BEFORE_ID)
    assert before and len(before.get("clubes") or []) == 14
    old = {row["clube"]: row for row in before["clubes"]}
    assert old["Atlético-MG"]["libertadores_vias"]["via_copa_do_brasil"]["percentual_estimado"] == 3.1636
    assert old["Santos"]["libertadores_vias"]["via_copa_do_brasil"]["percentual_estimado"] == 5.5272
    assert old["Remo"]["libertadores_vias"]["via_copa_do_brasil"]["percentual_estimado"] == 6.9784
    current_phase = phase_summary(load_json(COPA_PATH))
    assert len(current_phase["confrontos"]) == 8 and len(current_phase["clubes_serie_a_na_fase"]) == 14
    assert set(old) == set(current_phase["clubes_serie_a_na_fase"])
    data = synthetic_data()
    editorial = narrative_fallback(data)
    validate_editorial(editorial, data)
    page, metadata = render_article(
        data,
        editorial,
        "2026-08-07T00:10:00-03:00",
        "2026-08-07T00:10:00-03:00",
        carregar_manifesto().get("artigos") or [],
    )
    assert f'data-fdg-editorial-id="{ARTICLE_ID}"' in page
    assert page.count('class="analysis-cup-tie"') == 8
    assert page.count('class="analysis-status ') == 14
    assert "Os confrontos das quartas dependerão do sorteio" in page
    assert "Tabela do Brasileirão" not in page
    assert "analysis-kpis" not in page
    assert metadata["confrontos"] == 8 and len(metadata["classificados"]) == 8
    assert "CB · QF" in submenu_rodadas(
        [{"id_editorial": ARTICLE_ID, "rotulo_menu": "CB · QF", "slug": ARTICLE_SLUG, "publicado_em": "2026-08-07T00:10:00-03:00"}],
        id_ativo=ARTICLE_ID,
    )
    print("OK self-test: histórico, fase, comparativo, HTML e navegação continental.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--forcar", action="store_true", help="Regenera o texto depois que a fase estiver elegível")
    parser.add_argument("--sem-ia", action="store_true", help="Usa o editorial determinístico")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--modelo", default=os.environ.get("OPENAI_MODEL", MODELO_PADRAO))
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    try:
        return self_test() if args.self_test else execute(args)
    except (EditorialCopaError, ContinentalDataNotReady, AssertionError) as exc:
        print(f"ERRO: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
