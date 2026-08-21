#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Camada diária de inteligência/auditoria do Fórmula do Gol.

Princípios operacionais:
- no máximo UMA chamada à OpenAI por data de Brasília;
- coletores e auditorias determinísticas continuam sendo a fonte principal;
- web_search só é disponibilizado quando há lacuna factual real;
- nenhuma resposta da IA altera placar, classificação, estatística ou cálculo;
- público/transmissão só são complementados com evidência web retornada pela
  própria chamada, fonte permitida e confiança alta;
- melhores momentos só entram na auditoria depois de 24 h e nunca são
  vinculados automaticamente pela IA;
- falha da OpenAI nunca derruba os workflows esportivos;
- e-mail via Resend somente para problema crítico não resolvido.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Mapping, Sequence
from zoneinfo import ZoneInfo

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from atualizar_transmissoes_tv_brasileirao import ALLOWED_CHANNELS  # noqa: E402
from gerar_analise_rodada import (  # noqa: E402
    ARQUIVO_CONFIG,
    agora_br,
    carregar_json,
    carregar_manifesto,
    editorial_gerado_pela_openai,
    estado_rodada,
    montar_dossie,
    resumo_editorial,
    schema_editorial,
)
import gerar_analise_copa_do_brasil as copa  # noqa: E402

TZ = ZoneInfo("America/Sao_Paulo")
AUDIT_PATH = ROOT / "dados-br" / "auditoria-ia.json"
PUBLIC_PATH = ROOT / "dados-br" / "publicos-complementares.json"
DETAILS_PATH = ROOT / "dados-br" / "jogos-detalhes.json"
STATS_COMP_PATH = ROOT / "dados-br" / "estatisticas-competicao.json"
TRANSMISSIONS_PATH = ROOT / "dados-br" / "transmissoes-tv.json"
RESULTS_PATH = ROOT / "resultados.json"
TRANSMISSIONS_AUDIT_PATH = ROOT / "dados-br" / "auditoria-transmissoes-tv.json"
HIGHLIGHTS_PATH = ROOT / "dados-br" / "melhores-momentos.json"
HIGHLIGHTS_MANUAL_PATH = ROOT / "dados-br" / "melhores-momentos-manual.json"
DETAILS_AUDIT_PATH = ROOT / "dados-br" / "auditoria-jogos-detalhes.json"
STATS_AUDIT_PATH = ROOT / "dados-br" / "auditoria-estatisticas.json"
CALENDAR_AUDIT_PATH = ROOT / "dados-br" / "auditoria-calendario.json"
COVERAGE_AUDIT_PATH = ROOT / "dados-br" / "auditoria-cobertura-resultados.json"
STATUS_PATH = ROOT / "dados-br" / "status-atualizacao.json"

DEFAULT_MODEL = "gpt-5.6-terra"
MIN_PUBLIC_CONFIDENCE = 0.97
MIN_TRANSMISSION_CONFIDENCE = 0.97
PUBLIC_RESEARCH_GRACE_HOURS = 6.0
HIGHLIGHTS_AI_GRACE_HOURS = 24.0
HIGHLIGHTS_CRITICAL_HOURS = 48.0
REPEAT_ALERT_HOURS = 72.0
MAX_PUBLIC = 100_000

# Busca restrita a fontes esportivas/editoriais reconhecidas. A camada de IA não
# recebe acesso irrestrito à web.
ALLOWED_WEB_DOMAINS = (
    "cbf.com.br",
    "ge.globo.com",
    "globoesporte.globo.com",
    "espn.com.br",
    "uol.com.br",
    "itatiaia.com.br",
    "youtube.com",
)


class DailyAuditError(RuntimeError):
    pass


def load_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return copy.deepcopy(default)


def save_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def parse_dt(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=TZ)
    return parsed.astimezone(TZ)


def now_brt() -> datetime:
    return datetime.now(TZ).replace(microsecond=0)


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def normalize_url(value: Any) -> str:
    try:
        parsed = urllib.parse.urlsplit(str(value or "").strip())
    except Exception:
        return ""
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    host = parsed.hostname.lower() if parsed.hostname else ""
    path = re.sub(r"/+", "/", parsed.path or "/").rstrip("/") or "/"
    return urllib.parse.urlunsplit((parsed.scheme.lower(), host, path, "", ""))


def allowed_source_url(value: Any) -> bool:
    normalized = normalize_url(value)
    if not normalized:
        return False
    host = urllib.parse.urlsplit(normalized).hostname or ""
    return any(host == domain or host.endswith("." + domain) for domain in ALLOWED_WEB_DOMAINS)


def result_rows() -> list[dict[str, Any]]:
    raw = load_json(RESULTS_PATH, {}) or {}
    rows = raw.get("resultados") if isinstance(raw, Mapping) else []
    return [dict(row) for row in (rows or []) if isinstance(row, Mapping)]


def result_by_id() -> dict[str, dict[str, Any]]:
    return {
        str(row.get("event_id") or row.get("id") or ""): row
        for row in result_rows()
        if str(row.get("event_id") or row.get("id") or "")
    }


def game_finished_at(row: Mapping[str, Any]) -> datetime | None:
    explicit = parse_dt(row.get("finalizado_em"))
    if explicit:
        return explicit
    start = parse_dt(row.get("data_iso"))
    return start + timedelta(hours=2, minutes=15) if start else None


def hours_since_game(row: Mapping[str, Any], moment: datetime) -> float | None:
    finished = game_finished_at(row)
    if not finished:
        return None
    return (moment - finished).total_seconds() / 3600.0


def _public_value(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = int(value)
    else:
        text = str(value or "").strip().replace(" ", "")
        if not text:
            return None
        # Público é inteiro; pontos e vírgulas em fontes documentais são
        # separadores de milhar, não casas decimais.
        text = text.replace(".", "").replace(",", "")
        try:
            number = int(text)
        except ValueError:
            return None
    return number if 0 < number <= MAX_PUBLIC else None


def public_gaps_from_sources(
    moment: datetime,
    results: Mapping[str, Mapping[str, Any]],
    detail_games: Mapping[str, Any],
    complements: Mapping[str, Any],
) -> list[dict[str, Any]]:
    """Calcula as lacunas a partir das bases correntes, sem depender de auditoria antiga.

    O arquivo auditoria-publicos.json é um artefato de diagnóstico e pode não ser
    regravado quando uma tentativa automática não encontra nenhum novo público.
    Usá-lo como fila fazia a IA ignorar partidas recentes. A fonte de verdade para
    a triagem passa a ser: resultados finalizados + detalhes + complementos.
    """
    rows: list[dict[str, Any]] = []
    for event_id, result in results.items():
        detail = detail_games.get(event_id) if isinstance(detail_games, Mapping) else None
        complement = complements.get(event_id) if isinstance(complements, Mapping) else None
        if _public_value((detail or {}).get("publico")) is not None:
            continue
        if _public_value((complement or {}).get("publico")) is not None:
            continue
        age = hours_since_game(result, moment)
        if age is None or age < PUBLIC_RESEARCH_GRACE_HOURS:
            continue
        rows.append({
            "event_id": event_id,
            "rodada": int(result.get("rodada") or 0),
            "data_iso": result.get("data_iso"),
            "mandante": (result.get("mandante") or {}).get("nome") or "",
            "visitante": (result.get("visitante") or {}).get("nome") or "",
            "horas_desde_fim": round(age, 1),
        })
    rows.sort(key=lambda item: (int(item.get("rodada") or 0), str(item.get("data_iso") or ""), str(item.get("event_id") or "")))
    return rows


def public_gaps(moment: datetime, details: Mapping[str, Any]) -> list[dict[str, Any]]:
    results = result_by_id()
    detail_games = details.get("jogos") or {}
    public_payload = load_json(PUBLIC_PATH, {}) or {}
    complements = public_payload.get("jogos") if isinstance(public_payload, Mapping) else {}
    return public_gaps_from_sources(moment, results, detail_games, complements or {})


def transmission_gaps(moment: datetime, transmissions: Mapping[str, Any]) -> list[dict[str, Any]]:
    audit = load_json(TRANSMISSIONS_AUDIT_PATH, {}) or {}
    rows: list[dict[str, Any]] = []
    existing = transmissions.get("jogos") or {}
    for item in audit.get("sem_transmissao") or []:
        event_id = str(item.get("event_id") or "")
        if not event_id or event_id in existing:
            continue
        raw_dt = parse_dt(item.get("data_iso"))
        hours_to = ((raw_dt - moment).total_seconds() / 3600.0) if raw_dt else None
        # Só envolve IA em partidas relativamente próximas; o coletor normal tem
        # bastante tempo para resolver jogos mais distantes.
        if hours_to is not None and hours_to > 168:
            continue
        rows.append({
            "event_id": event_id,
            "rodada": int(item.get("rodada") or 0),
            "data_iso": item.get("data_iso"),
            "mandante": item.get("mandante") or "",
            "visitante": item.get("visitante") or "",
            "nivel": item.get("nivel") or ("critico" if hours_to is not None and hours_to <= 72 else "aviso"),
            "horas_ate_jogo": round(hours_to, 1) if hours_to is not None else None,
        })
    return rows


def highlight_gaps(moment: datetime) -> list[dict[str, Any]]:
    automatic = (load_json(HIGHLIGHTS_PATH, {}) or {}).get("jogos") or {}
    manual = (load_json(HIGHLIGHTS_MANUAL_PATH, {}) or {}).get("jogos") or {}
    linked = {
        str((item or {}).get("event_id") or key)
        for source in (automatic, manual)
        for key, item in source.items()
        if isinstance(item, Mapping)
    }
    rows: list[dict[str, Any]] = []
    for game in result_rows():
        event_id = str(game.get("event_id") or "")
        if not event_id or event_id in linked:
            continue
        age = hours_since_game(game, moment)
        if age is None or age < HIGHLIGHTS_AI_GRACE_HOURS:
            continue
        rows.append({
            "event_id": event_id,
            "rodada": int(game.get("rodada") or 0),
            "mandante": (game.get("mandante") or {}).get("nome") or "",
            "visitante": (game.get("visitante") or {}).get("nome") or "",
            "horas_desde_fim": round(age, 1),
        })
    rows.sort(key=lambda item: item["horas_desde_fim"], reverse=True)
    return rows


def round_editorial_candidate(moment: datetime) -> dict[str, Any] | None:
    config = carregar_json(ARQUIVO_CONFIG)
    eligible = [number for number in range(1, 39) if estado_rodada(number, moment, config)["elegivel"]]
    if not eligible:
        return None
    rodada = max(eligible)
    manifest = carregar_manifesto()
    existing = next((a for a in manifest.get("artigos") or [] if int(a.get("rodada") or 0) == rodada), None)
    if existing and editorial_gerado_pela_openai(existing.get("origem_editorial")):
        return None
    state = estado_rodada(rodada, moment, config)
    dossier = montar_dossie(rodada, state)
    return {
        "rodada": rodada,
        "resumo": resumo_editorial(dossier),
        "origem_atual": str((existing or {}).get("origem_editorial") or "ausente"),
    }


def copa_editorial_candidate() -> dict[str, Any] | None:
    try:
        snapshot = copa.load_json(copa.COPA_PATH)
        copa.activate_phase(copa.phase_rank_from_snapshot(snapshot))
        phase = copa.phase_summary(snapshot)
        if not phase.get("todos_concluidos"):
            return None
        manifest = carregar_manifesto()
        existing = next((a for a in manifest.get("artigos") or [] if a.get("id_editorial") == copa.ARTICLE_ID), None)
        if existing and str(existing.get("origem_editorial") or "").startswith("openai:"):
            return None
        history = copa.load_json(copa.HISTORY_PATH)
        before = copa.find_mark(history, copa.BEFORE_ID)
        after = copa.find_mark(history, copa.AFTER_ID)
        if not before or not after:
            return None
        data = copa.dossier(before, after)
        return {
            "fase_ordem": copa.PHASE_RANK,
            "fase": copa.current_phase_config()["fase"],
            "resumo": copa.editorial_summary(data),
            "origem_atual": str((existing or {}).get("origem_editorial") or "ausente"),
        }
    except Exception as exc:
        return {"erro": str(exc)[:500]}


def core_health(moment: datetime, pub_gaps: Sequence[Mapping[str, Any]], trans_gaps: Sequence[Mapping[str, Any]], highlight_gaps_: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    details = load_json(DETAILS_AUDIT_PATH, {}) or {}
    stats = load_json(STATS_AUDIT_PATH, {}) or {}
    calendar = load_json(CALENDAR_AUDIT_PATH, {}) or {}
    coverage = load_json(COVERAGE_AUDIT_PATH, {}) or {}
    transmissions = load_json(TRANSMISSIONS_AUDIT_PATH, {}) or {}
    status = load_json(STATUS_PATH, {}) or {}
    last_success = parse_dt(status.get("ultimo_sucesso"))
    stale_hours = (moment - last_success).total_seconds() / 3600.0 if last_success else None
    critical_reasons: list[str] = []
    attention_reasons: list[str] = []

    stats_critical = int((stats.get("resumo") or {}).get("erros_criticos") or len(stats.get("erros_criticos") or []))
    calendar_critical = int((calendar.get("resumo") or {}).get("falhas_graves") or 0)
    detail_incons = int(details.get("total_inconsistencias_eventos") or 0)
    detail_failures = int(details.get("total_falhas") or 0)
    coverage_no_stats = int((coverage.get("resumo") or {}).get("jogos_sem_estatisticas") or 0)
    critical_trans = sum(1 for item in trans_gaps if item.get("nivel") == "critico")
    old_public = sum(1 for item in pub_gaps if float(item.get("horas_desde_fim") or 0) >= 12)
    old_highlights = sum(1 for item in highlight_gaps_ if float(item.get("horas_desde_fim") or 0) >= HIGHLIGHTS_CRITICAL_HOURS)

    if stats_critical:
        critical_reasons.append(f"auditoria estatística registra {stats_critical} erro(s) crítico(s)")
    if calendar_critical:
        critical_reasons.append(f"calendário registra {calendar_critical} falha(s) grave(s)")
    if detail_incons:
        critical_reasons.append(f"detalhes possuem {detail_incons} inconsistência(s) de evento")
    if detail_failures >= 5:
        critical_reasons.append(f"coleta de detalhes acumula {detail_failures} falhas")
    if coverage_no_stats >= 5:
        critical_reasons.append(f"há {coverage_no_stats} jogos finalizados sem estatísticas")
    if critical_trans >= 3:
        critical_reasons.append(f"há {critical_trans} jogos em até 72 h sem transmissão identificada")
    if old_public >= 5:
        critical_reasons.append(f"há {old_public} jogos antigos sem público")
    if old_highlights >= 5:
        critical_reasons.append(f"há {old_highlights} jogos há mais de 48 h sem melhores momentos")
    if status.get("sincronizado") is False:
        critical_reasons.append("status principal informa snapshot não sincronizado")
    if stale_hours is None:
        attention_reasons.append("horário do último sucesso principal não pôde ser verificado")
    elif stale_hours > 36:
        critical_reasons.append(f"último sucesso principal ocorreu há {stale_hours:.1f} h")

    source_failures = len(transmissions.get("erros") or [])
    if source_failures:
        attention_reasons.append(f"{source_failures} fonte(s) de transmissão falharam, sem perda crítica de cobertura")
    if pub_gaps:
        attention_reasons.append(f"{len(pub_gaps)} público(s) ainda elegíveis para complementação")
    if trans_gaps:
        attention_reasons.append(f"{len(trans_gaps)} transmissão(ões) ainda elegíveis para complementação")
    if highlight_gaps_:
        attention_reasons.append(f"{len(highlight_gaps_)} jogo(s) sem melhores momentos após 24 h")

    return {
        "status_deterministico": "critico" if critical_reasons else "atencao" if attention_reasons else "ok",
        "criticos": critical_reasons,
        "avisos": attention_reasons,
        "indicadores": {
            "estatisticas_erros_criticos": stats_critical,
            "calendario_falhas_graves": calendar_critical,
            "detalhes_inconsistencias": detail_incons,
            "detalhes_falhas": detail_failures,
            "jogos_sem_estatisticas": coverage_no_stats,
            "transmissoes_criticas": critical_trans,
            "publicos_antigos_sem_dado": old_public,
            "melhores_momentos_mais_48h": old_highlights,
            "ultimo_sucesso_horas": round(stale_hours, 1) if stale_hours is not None else None,
        },
    }


def build_triage(moment: datetime) -> dict[str, Any]:
    details = load_json(DETAILS_PATH, {}) or {}
    transmissions = load_json(TRANSMISSIONS_PATH, {}) or {}
    publics = public_gaps(moment, details)
    trans = transmission_gaps(moment, transmissions)
    highlights = highlight_gaps(moment)
    round_candidate: dict[str, Any] | None
    try:
        round_candidate = round_editorial_candidate(moment)
    except Exception as exc:
        round_candidate = {"erro": str(exc)[:500]}
    cup_candidate = copa_editorial_candidate()
    health = core_health(moment, publics, trans, highlights)
    return {
        "data_hora_brt": moment.isoformat(),
        "saude": health,
        "pendencias": {
            "publicos": publics,
            "transmissoes": trans,
            "melhores_momentos_apos_24h": highlights,
        },
        "editoriais": {
            "rodada": round_candidate,
            "copa_do_brasil": cup_candidate,
        },
        "politica": {
            "ia_maximo_chamadas_dia": 1,
            "melhores_momentos_carencia_horas": HIGHLIGHTS_AI_GRACE_HOURS,
            "auto_correcao": ["publico_presente_ou_total", "transmissao_faltante_com_fonte"],
            "nunca_alterar_por_ia": ["placar", "classificacao", "estatisticas", "calculos"],
        },
    }


def problem_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "categoria": {"type": "string", "enum": ["publico", "transmissao", "melhores_momentos", "estatisticas", "calendario", "editorial", "fonte", "outro"]},
            "severidade": {"type": "string", "enum": ["info", "atencao", "critico"]},
            "mensagem": {"type": "string", "minLength": 3, "maxLength": 500},
            "event_id": {"type": "string", "maxLength": 40},
            "requer_intervencao": {"type": "boolean"},
        },
        "required": ["categoria", "severidade", "mensagem", "event_id", "requer_intervencao"],
    }


def audit_schema() -> dict[str, Any]:
    round_schema = schema_editorial()
    cup_schema = copa.editorial_schema()
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "status_geral": {"type": "string", "enum": ["ok", "atencao", "critico"]},
            "resumo": {"type": "string", "minLength": 5, "maxLength": 800},
            "problemas": {"type": "array", "maxItems": 30, "items": problem_schema()},
            "correcoes_publico": {
                "type": "array", "maxItems": 20,
                "items": {
                    "type": "object", "additionalProperties": False,
                    "properties": {
                        "event_id": {"type": "string", "minLength": 1, "maxLength": 40},
                        "publico": {"type": "integer", "minimum": 1, "maximum": MAX_PUBLIC},
                        "tipo": {"type": "string", "enum": ["presente", "total"]},
                        "fonte_url": {"type": "string", "minLength": 1, "maxLength": 1200},
                        "confianca": {"type": "number", "minimum": 0, "maximum": 1},
                        "justificativa": {"type": "string", "minLength": 3, "maxLength": 500},
                    },
                    "required": ["event_id", "publico", "tipo", "fonte_url", "confianca", "justificativa"],
                },
            },
            "correcoes_transmissao": {
                "type": "array", "maxItems": 20,
                "items": {
                    "type": "object", "additionalProperties": False,
                    "properties": {
                        "event_id": {"type": "string", "minLength": 1, "maxLength": 40},
                        "canais": {"type": "array", "minItems": 1, "maxItems": 6, "items": {"type": "string"}},
                        "fonte_url": {"type": "string", "minLength": 1, "maxLength": 1200},
                        "confianca": {"type": "number", "minimum": 0, "maximum": 1},
                        "justificativa": {"type": "string", "minLength": 3, "maxLength": 500},
                    },
                    "required": ["event_id", "canais", "fonte_url", "confianca", "justificativa"],
                },
            },
            "melhores_momentos_pendentes": {
                "type": "array", "maxItems": 20,
                "items": {
                    "type": "object", "additionalProperties": False,
                    "properties": {
                        "event_id": {"type": "string", "minLength": 1, "maxLength": 40},
                        "status": {"type": "string", "enum": ["aguardar", "investigar", "fonte_encontrada"]},
                        "fonte_url": {"type": "string", "maxLength": 1200},
                        "justificativa": {"type": "string", "minLength": 3, "maxLength": 500},
                    },
                    "required": ["event_id", "status", "fonte_url", "justificativa"],
                },
            },
            "editorial_rodada": {"anyOf": [round_schema, {"type": "null"}]},
            "editorial_copa": {"anyOf": [cup_schema, {"type": "null"}]},
        },
        "required": ["status_geral", "resumo", "problemas", "correcoes_publico", "correcoes_transmissao", "melhores_momentos_pendentes", "editorial_rodada", "editorial_copa"],
    }


def needs_web(triage: Mapping[str, Any]) -> bool:
    pending = triage.get("pendencias") or {}
    return bool(pending.get("publicos") or pending.get("transmissoes") or pending.get("melhores_momentos_apos_24h"))


def build_openai_payload(triage: Mapping[str, Any], model: str) -> dict[str, Any]:
    web_needed = needs_web(triage)
    instruction = (
        "Você é a camada diária de controle de qualidade do site Fórmula do Gol. Trabalhe DEPOIS dos coletores determinísticos. "
        "A resposta deve obedecer exatamente ao JSON Schema. Não altere nem proponha alterar placares, classificação, cartões, gols, "
        "estatísticas quantitativas ou cálculos. Para público e transmissão, proponha correção somente quando o event_id constar na "
        "lista de pendências, a evidência for inequívoca e a fonte consultada declarar diretamente o dado. Público deve ser PRESENTE "
        "ou TOTAL; nunca converta público pagante em presente. Não sobrescreva dados existentes. Para melhores momentos, nunca proponha "
        "vínculo automático: apenas classifique a pendência; jogos com menos de vinte e quatro horas nem aparecem no dossiê. "
        "Se web_search estiver disponível, use-o apenas para lacunas factuais; prefira UMA única busca que cubra as pendências e não "
        "pesquise apenas para enriquecer prosa editorial. Os editoriais devem usar SOMENTE o dossiê fornecido, sem fatos externos, sem "
        "algarismos na redação e sem inventar desempenho tático, jogadores, declarações ou causas. O título deve funcionar como uma manchete "
        "jornalística específica: destacar o maior fato comprovado da rodada, priorizar uma mudança de favorito ao título quando ela ocorrer e, "
        "na ausência disso, a oscilação esportivamente mais relevante em título, Libertadores ou rebaixamento. Evite fórmulas genéricas repetidas "
        "como 'ganha espaço e recua nas projeções'. Use termos que descrevam a intenção real da página, como Brasileirão, título, Libertadores ou "
        "rebaixamento quando forem o assunto central. Para editorial_rodada, produza entre 420 e 700 palavras no corpo das seções; cada parágrafo deve ser substantivo e compatível com o schema. Se não houver editorial elegível, "
        "retorne null no campo correspondente. Não transforme avisos isolados de fonte em incidente crítico quando os dados finais estão íntegros."
    )
    payload: dict[str, Any] = {
        "model": model,
        "store": False,
        "reasoning": {"effort": "medium"},
        "input": [
            {"role": "developer", "content": instruction},
            {"role": "user", "content": "Dossiê determinístico da auditoria diária:\n" + json.dumps(triage, ensure_ascii=False, separators=(",", ":"))},
        ],
        "max_output_tokens": 9000,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "auditoria_formula_do_gol",
                "strict": True,
                "schema": audit_schema(),
            }
        },
    }
    if web_needed:
        payload["tools"] = [{
            "type": "web_search",
            "search_context_size": "low",
            "filters": {"allowed_domains": list(ALLOWED_WEB_DOMAINS)},
        }]
        # Limite físico: ainda que o modelo queira investigar mais, esta única
        # requisição diária pode executar no máximo UMA chamada de ferramenta web.
        # Uma ação de busca pode agrupar consultas; se não bastar, a lacuna fica
        # pendente para o dia seguinte em vez de aumentar custo/complexidade.
        payload["tool_choice"] = "auto"
        payload["max_tool_calls"] = 1
        payload["include"] = ["web_search_call.action.sources"]
    return payload


def extract_output_text(response: Mapping[str, Any]) -> str:
    texts: list[str] = []
    for item in response.get("output") or []:
        if not isinstance(item, Mapping):
            continue
        for part in item.get("content") or []:
            if isinstance(part, Mapping) and part.get("type") == "output_text" and part.get("text"):
                texts.append(str(part["text"]))
    return "".join(texts)


def collect_web_metadata(response: Mapping[str, Any]) -> tuple[int, int, set[str], list[dict[str, Any]]]:
    search_count = 0
    tool_count = 0
    urls: set[str] = set()
    actions: list[dict[str, Any]] = []
    for item in response.get("output") or []:
        if not isinstance(item, Mapping):
            continue
        if item.get("type") == "web_search_call":
            tool_count += 1
            action = item.get("action") or {}
            if isinstance(action, Mapping):
                action_type = str(action.get("type") or "")
                if action_type == "search":
                    search_count += 1
                queries = action.get("queries") or ([action.get("query")] if action.get("query") else [])
                actions.append({"type": action_type, "queries": queries})
                for source in action.get("sources") or []:
                    if isinstance(source, Mapping):
                        normalized = normalize_url(source.get("url"))
                        if normalized:
                            urls.add(normalized)
        for part in item.get("content") or []:
            if not isinstance(part, Mapping):
                continue
            for annotation in part.get("annotations") or []:
                if not isinstance(annotation, Mapping):
                    continue
                candidate = annotation.get("url")
                if not candidate and isinstance(annotation.get("url_citation"), Mapping):
                    candidate = annotation["url_citation"].get("url")
                normalized = normalize_url(candidate)
                if normalized:
                    urls.add(normalized)
    return search_count, tool_count, urls, actions


def call_openai_once(payload: Mapping[str, Any], api_key: str) -> dict[str, Any]:
    request = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=210) as raw:
            response = json.loads(raw.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:900]
        raise DailyAuditError(f"OpenAI HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise DailyAuditError(f"Falha única na chamada OpenAI: {exc}") from exc
    if not isinstance(response, dict):
        raise DailyAuditError("OpenAI não devolveu objeto JSON")
    if response.get("status") == "incomplete":
        raise DailyAuditError(f"OpenAI respondeu de forma incompleta: {response.get('incomplete_details') or 'sem detalhe'}")
    text = extract_output_text(response)
    if not text:
        raise DailyAuditError("OpenAI não devolveu output_text")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise DailyAuditError("output_text da OpenAI não é JSON válido") from exc
    response["_parsed_output"] = parsed
    return response


def source_proven(source_url: Any, source_urls: set[str]) -> bool:
    normalized = normalize_url(source_url)
    return bool(normalized and allowed_source_url(normalized) and normalized in source_urls)


def validate_public_corrections(
    proposed: Sequence[Mapping[str, Any]], triage: Mapping[str, Any], details: Mapping[str, Any], source_urls: set[str]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    pending_ids = {str(item.get("event_id") or "") for item in (triage.get("pendencias") or {}).get("publicos") or []}
    detail_games = details.get("jogos") or {}
    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for raw in proposed:
        item = dict(raw)
        event_id = str(item.get("event_id") or "")
        reasons: list[str] = []
        if event_id not in pending_ids:
            reasons.append("event_id não está na pendência diária")
        if (detail_games.get(event_id) or {}).get("publico"):
            reasons.append("jogo já possui público")
        try:
            public = int(item.get("publico") or 0)
        except (TypeError, ValueError):
            public = 0
        if public < 1 or public > MAX_PUBLIC:
            reasons.append("público fora da faixa de sanidade")
        if item.get("tipo") not in {"presente", "total"}:
            reasons.append("tipo não é presente/total")
        try:
            confidence = float(item.get("confianca") or 0)
        except (TypeError, ValueError):
            confidence = 0
        if confidence < MIN_PUBLIC_CONFIDENCE:
            reasons.append("confiança abaixo do limiar")
        if not source_proven(item.get("fonte_url"), source_urls):
            reasons.append("fonte não consta nas fontes web efetivamente retornadas")
        if reasons:
            rejected.append({"tipo": "publico", "event_id": event_id, "motivos": reasons, "proposta": item})
        else:
            item["publico"] = public
            item["confianca"] = confidence
            item["fonte_url"] = normalize_url(item.get("fonte_url"))
            accepted.append(item)
    return accepted, rejected


def validate_transmission_corrections(
    proposed: Sequence[Mapping[str, Any]], triage: Mapping[str, Any], transmissions: Mapping[str, Any], source_urls: set[str]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    pending_ids = {str(item.get("event_id") or "") for item in (triage.get("pendencias") or {}).get("transmissoes") or []}
    existing = transmissions.get("jogos") or {}
    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for raw in proposed:
        item = dict(raw)
        event_id = str(item.get("event_id") or "")
        reasons: list[str] = []
        if event_id not in pending_ids:
            reasons.append("event_id não está na pendência diária")
        if event_id in existing:
            reasons.append("transmissão já existe e não pode ser sobrescrita")
        channels = list(dict.fromkeys(str(value) for value in (item.get("canais") or []) if str(value)))
        if not channels or any(channel not in ALLOWED_CHANNELS for channel in channels):
            reasons.append("canal fora da lista permitida")
        try:
            confidence = float(item.get("confianca") or 0)
        except (TypeError, ValueError):
            confidence = 0
        if confidence < MIN_TRANSMISSION_CONFIDENCE:
            reasons.append("confiança abaixo do limiar")
        if not source_proven(item.get("fonte_url"), source_urls):
            reasons.append("fonte não consta nas fontes web efetivamente retornadas")
        if reasons:
            rejected.append({"tipo": "transmissao", "event_id": event_id, "motivos": reasons, "proposta": item})
        else:
            item["canais"] = channels
            item["confianca"] = confidence
            item["fonte_url"] = normalize_url(item.get("fonte_url"))
            accepted.append(item)
    return accepted, rejected


def apply_public_corrections(items: Sequence[Mapping[str, Any]], moment: datetime, dry_run: bool) -> list[str]:
    if not items:
        return []
    complements = load_json(PUBLIC_PATH, {}) or {"schema_version": 1, "jogos": {}}
    details = load_json(DETAILS_PATH, {}) or {"jogos": {}}
    complements.setdefault("jogos", {})
    details.setdefault("jogos", {})
    applied: list[str] = []
    for item in items:
        event_id = str(item["event_id"])
        if event_id in complements["jogos"] and (complements["jogos"].get(event_id) or {}).get("publico"):
            continue
        detail = details["jogos"].get(event_id)
        if not isinstance(detail, dict) or detail.get("publico"):
            continue
        complements["jogos"][event_id] = {
            "publico": int(item["publico"]),
            "tipo": str(item["tipo"]),
            "fonte": str(item["fonte_url"]),
        }
        detail["publico"] = int(item["publico"])
        detail["publico_tipo"] = str(item["tipo"])
        detail["publico_fonte"] = str(item["fonte_url"])
        applied.append(event_id)
    if applied and not dry_run:
        complements["atualizado_em"] = moment.isoformat()
        save_json(PUBLIC_PATH, complements)
        save_json(DETAILS_PATH, details)
        subprocess.run([sys.executable, "scripts/gerar_estatisticas_competicao_brasileirao.py"], cwd=ROOT, check=True)
    return applied


def apply_transmission_corrections(items: Sequence[Mapping[str, Any]], moment: datetime, dry_run: bool) -> list[str]:
    if not items:
        return []
    payload = load_json(TRANSMISSIONS_PATH, {}) or {"schema_version": 1, "jogos": {}}
    payload.setdefault("jogos", {})
    results = result_by_id()
    audit = load_json(TRANSMISSIONS_AUDIT_PATH, {}) or {}
    pending_meta = {str(item.get("event_id") or ""): item for item in audit.get("sem_transmissao") or []}
    applied: list[str] = []
    for item in items:
        event_id = str(item["event_id"])
        if event_id in payload["jogos"]:
            continue
        raw = results.get(event_id) or pending_meta.get(event_id) or {}
        home = (raw.get("mandante") or {}).get("nome") if isinstance(raw.get("mandante"), Mapping) else raw.get("mandante")
        away = (raw.get("visitante") or {}).get("nome") if isinstance(raw.get("visitante"), Mapping) else raw.get("visitante")
        data_iso = raw.get("data_iso") or (pending_meta.get(event_id) or {}).get("data_iso")
        channels = list(item["canais"])
        payload["jogos"][event_id] = {
            "event_id": event_id,
            "rodada": int(raw.get("rodada") or 0),
            "mandante": home or "",
            "visitante": away or "",
            "data_iso": data_iso or "",
            "tipo": "tv_ou_streaming_oficial",
            "canais": channels,
            "origem": "OpenAI Web Search — auditoria diária",
            "confianca": "confirmado",
            "estavel": False,
            "exclusivo": False,
            "fontes": [{
                "fonte": "OpenAI Web Search — auditoria diária",
                "canais": channels,
                "referencia": str(item["fonte_url"]),
                "capturado_em": moment.isoformat(),
                "autoridade": 800,
                "detalhe": "complemento automático validado por event_id e fonte web retornada",
            }],
            "acessos": [],
        }
        applied.append(event_id)
    if applied and not dry_run:
        payload["atualizado_em"] = moment.isoformat()
        save_json(TRANSMISSIONS_PATH, payload)
    return applied


def apply_editorials(parsed: Mapping[str, Any], triage: Mapping[str, Any], model: str, dry_run: bool) -> list[str]:
    applied: list[str] = []
    editorial_round = parsed.get("editorial_rodada")
    round_candidate = (triage.get("editoriais") or {}).get("rodada")
    if isinstance(round_candidate, Mapping) and round_candidate.get("rodada") and isinstance(editorial_round, Mapping):
        if dry_run:
            applied.append(f"rodada-{round_candidate['rodada']}")
        else:
            with tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8", delete=False) as temp:
                json.dump(editorial_round, temp, ensure_ascii=False)
                path = temp.name
            try:
                env = dict(os.environ)
                env["OPENAI_API_KEY"] = ""
                subprocess.run([
                    sys.executable, "scripts/gerar_analise_rodada.py",
                    "--rodada", str(round_candidate["rodada"]),
                    "--editorial-json", path,
                    "--origem-editorial", f"openai:{model}:auditoria-diaria",
                ], cwd=ROOT, env=env, check=True)
                applied.append(f"rodada-{round_candidate['rodada']}")
            finally:
                Path(path).unlink(missing_ok=True)
    editorial_cup = parsed.get("editorial_copa")
    cup_candidate = (triage.get("editoriais") or {}).get("copa_do_brasil")
    if isinstance(cup_candidate, Mapping) and cup_candidate.get("fase_ordem") and isinstance(editorial_cup, Mapping):
        if dry_run:
            applied.append(f"copa-{cup_candidate['fase_ordem']}")
        else:
            with tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8", delete=False) as temp:
                json.dump(editorial_cup, temp, ensure_ascii=False)
                path = temp.name
            try:
                env = dict(os.environ)
                env["OPENAI_API_KEY"] = ""
                subprocess.run([
                    sys.executable, "scripts/gerar_analise_copa_do_brasil.py",
                    "--editorial-json", path,
                    "--origem-editorial", f"openai:{model}:auditoria-diaria",
                    "--falhar-se-snapshot-atrasado", "--tolerancia-snapshot-horas", "4",
                ], cwd=ROOT, env=env, check=True)
                applied.append(f"copa-{cup_candidate['fase_ordem']}")
            finally:
                Path(path).unlink(missing_ok=True)
    return applied


def severity_rank(value: str) -> int:
    return {"ok": 0, "atencao": 1, "critico": 2}.get(str(value), 1)


def final_status(triage: Mapping[str, Any], parsed: Mapping[str, Any], applied_public: Sequence[str], applied_trans: Sequence[str], previous_failures: int = 0, ai_error: str = "") -> tuple[str, list[str]]:
    base_reasons = list((triage.get("saude") or {}).get("criticos") or [])
    pending = triage.get("pendencias") or {}
    public_pending = list(pending.get("publicos") or [])
    transmission_pending = list(pending.get("transmissoes") or [])
    highlight_pending = list(pending.get("melhores_momentos_apos_24h") or [])
    applied_public_ids = set(applied_public)
    applied_trans_ids = set(applied_trans)

    unresolved_old_public = [
        item for item in public_pending
        if item.get("event_id") not in applied_public_ids and float(item.get("horas_desde_fim") or 0) >= 12
    ]
    unresolved_critical_trans = [
        item for item in transmission_pending
        if item.get("event_id") not in applied_trans_ids and item.get("nivel") == "critico"
    ]
    unresolved_old_highlights = [
        item for item in highlight_pending
        if float(item.get("horas_desde_fim") or 0) >= HIGHLIGHTS_CRITICAL_HOURS
    ]

    # Apenas os três gatilhos abaixo podem mudar de estado dentro desta execução.
    # Preserva integralmente todos os demais críticos determinísticos.
    dynamic_markers = (
        "jogos antigos sem público",
        "jogos em até 72 h sem transmissão identificada",
        "jogos há mais de 48 h sem melhores momentos",
    )
    reasons = [reason for reason in base_reasons if not any(marker in reason for marker in dynamic_markers)]

    if len(unresolved_old_public) >= 5:
        reasons.append(f"há {len(unresolved_old_public)} jogos antigos ainda sem público após a correção automática")
    if len(unresolved_critical_trans) >= 3:
        reasons.append(f"há {len(unresolved_critical_trans)} transmissões críticas ainda sem solução")
    if len(unresolved_old_highlights) >= 5:
        reasons.append(f"há {len(unresolved_old_highlights)} jogos há mais de 48 h ainda sem melhores momentos")

    # A IA pode explicar/diagnosticar um incidente, mas não transforma uma única
    # lacuna editorial, de público, transmissão ou vídeo em e-mail crítico. Para
    # disparo extraordinário aceitamos somente categorias sistêmicas e, ainda
    # assim, quando o próprio modelo afirma que intervenção humana é necessária.
    critical_categories = {"estatisticas", "calendario", "fonte", "outro"}
    model_critical = [
        p for p in parsed.get("problemas") or []
        if isinstance(p, Mapping)
        and p.get("severidade") == "critico"
        and p.get("requer_intervencao") is True
        and p.get("categoria") in critical_categories
    ]
    reasons.extend(str(p.get("mensagem") or "") for p in model_critical if p.get("mensagem"))
    if ai_error and previous_failures >= 1:
        reasons.append("camada diária de IA falhou por dois dias/executações consecutivos")
    if reasons:
        return "critico", list(dict.fromkeys(reasons))

    deterministic = str((triage.get("saude") or {}).get("status_deterministico") or "ok")
    model_status = str(parsed.get("status_geral") or "ok") if parsed else "atencao" if ai_error else "ok"
    return ("atencao" if max(severity_rank(deterministic), severity_rank(model_status)) >= 1 else "ok"), []


def alert_fingerprint(status: str, reasons: Sequence[str]) -> str:
    return canonical_hash({"status": status, "motivos": sorted(set(str(x) for x in reasons))})


def should_send_alert(previous: Mapping[str, Any], status: str, reasons: Sequence[str], moment: datetime) -> bool:
    if status != "critico" or not reasons:
        return False
    current = alert_fingerprint(status, reasons)
    prior_alert = previous.get("alerta") or {}
    if prior_alert.get("ultimo_fingerprint") != current:
        return True
    last_sent = parse_dt(prior_alert.get("ultimo_enviado_em"))
    return not last_sent or (moment - last_sent).total_seconds() >= REPEAT_ALERT_HOURS * 3600


def send_resend_alert(reasons: Sequence[str], audit_summary: str, moment: datetime) -> tuple[bool, str]:
    key = os.environ.get("RESEND_API_KEY", "").strip()
    destination = os.environ.get("EMAIL_DESTINO", "").strip()
    sender = os.environ.get("EMAIL_REMETENTE", "onboarding@resend.dev").strip()
    if not key or not destination:
        return False, "RESEND_API_KEY/EMAIL_DESTINO não configurados"
    items = "".join(f"<li>{html_escape(reason)}</li>" for reason in reasons)
    body = (
        "<h2>Fórmula do Gol — auditoria diária</h2>"
        f"<p><strong>Status:</strong> CRÍTICO — {html_escape(moment.strftime('%d/%m/%Y %H:%M BRT'))}</p>"
        f"<p>{html_escape(audit_summary)}</p><ul>{items}</ul>"
        "<p>A camada automática preservou os dados existentes quando não houve evidência suficiente para corrigir.</p>"
    )
    payload = {"from": sender, "to": [destination], "subject": "Fórmula do Gol — problema crítico detectado", "html": body}
    request = urllib.request.Request(
        "https://api.resend.com/emails",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as raw:
            response = raw.read().decode("utf-8", errors="replace")[:500]
        return True, response or "enviado"
    except Exception as exc:
        return False, str(exc)[:500]


def html_escape(value: Any) -> str:
    return (
        str(value or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    )


def already_attempted_today(previous: Mapping[str, Any], moment: datetime) -> bool:
    return str(previous.get("data_brt") or "") == moment.date().isoformat() and bool((previous.get("openai") or {}).get("tentativa_efetuada"))


def run(*, dry_run: bool = False, moment: datetime | None = None) -> dict[str, Any]:
    moment = (moment or now_brt()).astimezone(TZ).replace(microsecond=0)
    previous = load_json(AUDIT_PATH, {}) or {}
    triage = build_triage(moment)
    if dry_run:
        print(json.dumps({"dry_run": True, "triagem": triage, "web_seria_habilitada": needs_web(triage)}, ensure_ascii=False, indent=2))
        return {"dry_run": True, "triagem": triage}
    if already_attempted_today(previous, moment):
        print(f"Auditoria IA de {moment.date().isoformat()} já tentou a única chamada diária; nova chamada bloqueada.")
        return dict(previous)

    model = os.environ.get("OPENAI_AUDIT_MODEL", os.environ.get("OPENAI_MODEL", DEFAULT_MODEL)).strip() or DEFAULT_MODEL
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    previous_failures = int((previous.get("openai") or {}).get("falhas_consecutivas") or 0)
    parsed: dict[str, Any] = {}
    response: dict[str, Any] = {}
    ai_error = ""
    search_count = 0
    tool_count = 0
    source_urls: set[str] = set()
    web_actions: list[dict[str, Any]] = []

    if not api_key:
        ai_error = "OPENAI_API_KEY não configurada"
    else:
        try:
            response = call_openai_once(build_openai_payload(triage, model), api_key)
            parsed = dict(response.get("_parsed_output") or {})
            search_count, tool_count, source_urls, web_actions = collect_web_metadata(response)
        except Exception as exc:
            ai_error = str(exc)[:1000]

    details = load_json(DETAILS_PATH, {}) or {}
    transmissions = load_json(TRANSMISSIONS_PATH, {}) or {}
    accepted_public: list[dict[str, Any]] = []
    accepted_trans: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    if parsed:
        accepted_public, rejected_public = validate_public_corrections(parsed.get("correcoes_publico") or [], triage, details, source_urls)
        accepted_trans, rejected_trans = validate_transmission_corrections(parsed.get("correcoes_transmissao") or [], triage, transmissions, source_urls)
        rejected.extend(rejected_public)
        rejected.extend(rejected_trans)

    applied_public: list[str] = []
    applied_trans: list[str] = []
    applied_editorials: list[str] = []
    if not ai_error:
        try:
            applied_public = apply_public_corrections(accepted_public, moment, dry_run=False)
            applied_trans = apply_transmission_corrections(accepted_trans, moment, dry_run=False)
            applied_editorials = apply_editorials(parsed, triage, model, dry_run=False)
        except Exception as exc:
            ai_error = f"falha ao aplicar saída validada: {exc}"[:1000]

    failures = previous_failures + 1 if ai_error else 0
    status, critical_reasons = final_status(triage, parsed, applied_public, applied_trans, previous_failures, ai_error)
    summary = str(parsed.get("resumo") or ("Camada de IA indisponível; dados determinísticos preservados." if ai_error else "Auditoria concluída."))
    fingerprint = alert_fingerprint(status, critical_reasons) if critical_reasons else ""
    prior_alert = previous.get("alerta") or {}
    alert_record = {
        "ultimo_fingerprint": str(prior_alert.get("ultimo_fingerprint") or ""),
        "ultimo_enviado_em": str(prior_alert.get("ultimo_enviado_em") or ""),
        "envio_nesta_execucao": False,
        "detalhe": "não necessário",
    }
    if should_send_alert(previous, status, critical_reasons, moment):
        sent, detail = send_resend_alert(critical_reasons, summary, moment)
        alert_record["envio_nesta_execucao"] = sent
        alert_record["detalhe"] = detail
        if sent:
            alert_record["ultimo_fingerprint"] = fingerprint
            alert_record["ultimo_enviado_em"] = moment.isoformat()

    daily_history = [
        item for item in list(previous.get("historico") or [])
        if isinstance(item, Mapping) and str(item.get("data_brt") or "") != moment.date().isoformat()
    ]
    daily_history.append({
        "data_brt": moment.date().isoformat(),
        "executado_em": moment.isoformat(),
        "status": status,
        "resumo": summary,
        "chamadas_openai": 1 if api_key else 0,
        "web_searches": search_count,
        "publicos_aplicados": len(applied_public),
        "transmissoes_aplicadas": len(applied_trans),
        "editoriais_aplicados": list(applied_editorials),
        "criticos": list(critical_reasons),
        "email_enviado": bool(alert_record["envio_nesta_execucao"]),
    })
    daily_history = daily_history[-90:]

    audit = {
        "schema_version": 1,
        "data_brt": moment.date().isoformat(),
        "executado_em": moment.isoformat(),
        "status": status,
        "resumo": summary,
        "triagem": triage,
        "openai": {
            "modelo": model,
            "tentativa_efetuada": bool(api_key),
            "chamadas_nesta_execucao": 1 if api_key else 0,
            "limite_chamadas_dia": 1,
            "falhas_consecutivas": failures,
            "erro": ai_error,
            "web_habilitada": needs_web(triage),
            "web_searches": search_count,
            "web_tool_calls": tool_count,
            "web_acoes": web_actions,
            "fontes_web": sorted(source_urls),
        },
        "resultado_ia": parsed,
        "correcoes": {
            "publicos_aceitos": accepted_public,
            "transmissoes_aceitas": accepted_trans,
            "rejeitadas": rejected,
            "publicos_aplicados": applied_public,
            "transmissoes_aplicadas": applied_trans,
            "editoriais_aplicados": applied_editorials,
        },
        "criticos_nao_resolvidos": critical_reasons,
        "alerta": alert_record,
        "historico": daily_history,
    }
    save_json(AUDIT_PATH, audit)
    print(
        f"Auditoria IA: status={status}; chamada={audit['openai']['chamadas_nesta_execucao']}; "
        f"web_searches={search_count}; públicos={len(applied_public)}; transmissões={len(applied_trans)}; "
        f"editoriais={len(applied_editorials)}; email={alert_record['envio_nesta_execucao']}."
    )
    return audit


def self_test() -> int:
    sample_result = {
        "event_id": "x", "rodada": 1, "data_iso": "2026-08-01T18:00:00-03:00",
        "mandante": {"nome": "Time A"}, "visitante": {"nome": "Time B"},
        "finalizado_em": "2026-08-01T20:00:00-03:00",
    }
    assert hours_since_game(sample_result, datetime.fromisoformat("2026-08-02T20:00:00-03:00")) == 24
    # Regressão: a triagem deve encontrar a lacuna pelas bases atuais mesmo que
    # auditoria-publicos.json esteja antiga ou diga zero pendências.
    gap_result = {
        "1": {
            "event_id": "1", "rodada": 23, "data_iso": "2026-08-01T18:00:00-03:00",
            "mandante": {"nome": "Time A"}, "visitante": {"nome": "Time B"},
            "finalizado_em": "2026-08-01T20:00:00-03:00",
        }
    }
    gaps = public_gaps_from_sources(
        datetime.fromisoformat("2026-08-02T05:30:00-03:00"), gap_result, {"1": {"publico": None}}, {}
    )
    assert [item["event_id"] for item in gaps] == ["1"]
    assert public_gaps_from_sources(
        datetime.fromisoformat("2026-08-02T05:30:00-03:00"), gap_result, {"1": {"publico": None}}, {"1": {"publico": 12345}}
    ) == []
    assert allowed_source_url("https://ge.globo.com/futebol/noticia/teste.ghtml")
    assert not allowed_source_url("https://example.com/noticia")
    assert normalize_url("https://GE.GLOBO.COM/a/?utm=x#z") == "https://ge.globo.com/a"
    schema = audit_schema()
    assert schema["properties"]["editorial_rodada"]["anyOf"][1] == {"type": "null"}

    triage = {
        "pendencias": {
            "publicos": [{"event_id": "1", "horas_desde_fim": 30}],
            "transmissoes": [{"event_id": "2", "nivel": "critico"}],
            "melhores_momentos_apos_24h": [{"event_id": "3", "horas_desde_fim": 25}],
        },
        "saude": {"status_deterministico": "atencao", "criticos": []},
        "editoriais": {"rodada": None, "copa_do_brasil": None},
    }
    payload = build_openai_payload(triage, DEFAULT_MODEL)
    assert payload["tools"][0]["type"] == "web_search" and payload["tool_choice"] == "auto"
    assert payload["max_tool_calls"] == 1, "web_search deve estar fisicamente limitada a uma chamada"
    no_web = copy.deepcopy(triage)
    no_web["pendencias"] = {"publicos": [], "transmissoes": [], "melhores_momentos_apos_24h": []}
    assert "tools" not in build_openai_payload(no_web, DEFAULT_MODEL)

    details = {"jogos": {"1": {"publico": None}}}
    source = normalize_url("https://ge.globo.com/futebol/noticia/a.ghtml")
    accepted, rejected = validate_public_corrections([
        {"event_id": "1", "publico": 12345, "tipo": "presente", "fonte_url": source, "confianca": 0.99, "justificativa": "fonte declara público presente"}
    ], triage, details, {source})
    assert len(accepted) == 1 and not rejected
    accepted, rejected = validate_public_corrections([
        {"event_id": "1", "publico": 12345, "tipo": "presente", "fonte_url": "https://example.com/a", "confianca": 0.99, "justificativa": "x"}
    ], triage, details, {normalize_url("https://example.com/a")})
    assert not accepted and rejected
    accepted, rejected = validate_public_corrections([
        {"event_id": "1", "publico": 12345, "tipo": "pagante", "fonte_url": source, "confianca": 0.99, "justificativa": "x"}
    ], triage, details, {source})
    assert not accepted and any("presente/total" in reason for reason in rejected[0]["motivos"])
    accepted, rejected = validate_public_corrections([
        {"event_id": "1", "publico": 12345, "tipo": "presente", "fonte_url": source, "confianca": 0.96, "justificativa": "x"}
    ], triage, details, {source})
    assert not accepted and rejected
    accepted, rejected = validate_public_corrections([
        {"event_id": "1", "publico": 12345, "tipo": "presente", "fonte_url": source, "confianca": 0.99, "justificativa": "x"}
    ], triage, {"jogos": {"1": {"publico": 9999}}}, {source})
    assert not accepted and rejected

    transmissions = {"jogos": {}}
    accepted_t, rejected_t = validate_transmission_corrections([
        {"event_id": "2", "canais": ["Premiere"], "fonte_url": source, "confianca": 0.99, "justificativa": "grade explícita"}
    ], triage, transmissions, {source})
    assert len(accepted_t) == 1 and not rejected_t
    accepted_t, rejected_t = validate_transmission_corrections([
        {"event_id": "2", "canais": ["Canal Inventado"], "fonte_url": source, "confianca": 0.99, "justificativa": "x"}
    ], triage, transmissions, {source})
    assert not accepted_t and rejected_t
    accepted_t, rejected_t = validate_transmission_corrections([
        {"event_id": "2", "canais": ["Premiere"], "fonte_url": source, "confianca": 0.80, "justificativa": "x"}
    ], triage, transmissions, {source})
    assert not accepted_t and rejected_t
    accepted_t, rejected_t = validate_transmission_corrections([
        {"event_id": "2", "canais": ["Premiere"], "fonte_url": source, "confianca": 0.99, "justificativa": "x"}
    ], triage, {"jogos": {"2": {"canais": ["Premiere"]}}}, {source})
    assert not accepted_t and rejected_t

    parsed = {"status_geral": "ok", "problemas": []}
    status, reasons = final_status(triage, parsed, ["1"], ["2"])
    assert status == "atencao" and not reasons

    five_highlights = copy.deepcopy(triage)
    five_highlights["pendencias"]["publicos"] = []
    five_highlights["pendencias"]["transmissoes"] = []
    five_highlights["pendencias"]["melhores_momentos_apos_24h"] = [
        {"event_id": str(i), "horas_desde_fim": 60} for i in range(5)
    ]
    five_highlights["saude"] = {
        "status_deterministico": "critico",
        "criticos": ["há 5 jogos há mais de 48 h sem melhores momentos"],
    }
    status, reasons = final_status(five_highlights, parsed, [], [])
    assert status == "critico" and any("melhores momentos" in reason for reason in reasons)

    noisy_model = {
        "status_geral": "critico",
        "problemas": [{
            "categoria": "publico", "severidade": "critico", "mensagem": "um público isolado ausente",
            "event_id": "1", "requer_intervencao": True,
        }],
    }
    quiet_triage = copy.deepcopy(triage)
    quiet_triage["saude"] = {"status_deterministico": "atencao", "criticos": []}
    status, reasons = final_status(quiet_triage, noisy_model, [], [])
    assert status == "atencao" and not reasons, "lacuna isolada não pode disparar e-mail crítico"

    systemic_model = {
        "status_geral": "critico",
        "problemas": [{
            "categoria": "fonte", "severidade": "critico", "mensagem": "fonte principal indisponível com impacto sistêmico",
            "event_id": "", "requer_intervencao": True,
        }],
    }
    status, reasons = final_status(quiet_triage, systemic_model, [], [])
    assert status == "critico" and reasons
    status, reasons = final_status(quiet_triage, {}, [], [], previous_failures=1, ai_error="timeout")
    assert status == "critico" and any("dois dias" in reason for reason in reasons)

    # Arquitetura: nenhum outro script ou workflow pode possuir uma chamada direta
    # à OpenAI. Assim a centralização diária é testada no próprio runner.
    direct_api = []
    for script in SCRIPT_DIR.glob("*.py"):
        try:
            text = script.read_text(encoding="utf-8")
        except OSError:
            continue
        if "api.openai.com/v1/responses" in text:
            direct_api.append(script.name)
    assert direct_api == [Path(__file__).name], f"chamada OpenAI fora da auditoria diária: {direct_api}"
    workflow_secret_refs = []
    for workflow in (ROOT / ".github" / "workflows").glob("*.yml"):
        try:
            text = workflow.read_text(encoding="utf-8")
        except OSError:
            continue
        if "secrets.OPENAI_API_KEY" in text:
            workflow_secret_refs.append(workflow.name)
    assert workflow_secret_refs == ["auditoria-ia-diaria.yml"], f"OPENAI_API_KEY exposta a outros workflows: {workflow_secret_refs}"

    previous = {"alerta": {"ultimo_fingerprint": alert_fingerprint("critico", ["x"]), "ultimo_enviado_em": "2026-08-01T12:00:00-03:00"}}
    assert not should_send_alert(previous, "critico", ["x"], datetime.fromisoformat("2026-08-02T12:00:00-03:00"))
    assert should_send_alert(previous, "critico", ["x"], datetime.fromisoformat("2026-08-05T12:00:00-03:00"))
    same_day = {"data_brt": "2026-08-09", "openai": {"tentativa_efetuada": True}}
    assert already_attempted_today(same_day, datetime.fromisoformat("2026-08-09T08:45:00-03:00"))
    print("Self-test auditoria IA diária: OK")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Monta a triagem sem chamar OpenAI nem alterar arquivos")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    try:
        run(dry_run=args.dry_run)
    except Exception as exc:
        # A camada de IA é enriquecimento/auditoria; nunca deve interromper a
        # atualização esportiva. O erro fica visível no log e a próxima execução
        # poderá registrar o estado em auditoria-ia.json.
        print(f"::warning title=Auditoria IA não bloqueante::{exc}")
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
