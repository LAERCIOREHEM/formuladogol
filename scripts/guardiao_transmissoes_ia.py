#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Guardião IA de transmissões do Fórmula do Gol.

A camada determinística continua sendo a primeira linha (CBF/GE/ESPN/YouTube/manual).
Este módulo entra nos checkpoints críticos, usa Responses API + Web Search para
reconciliar a grade brasileira e grava SOMENTE um overlay auditado. O consolidado
final continua sendo produzido por atualizar_transmissoes_tv_brasileirao.py.

Garantias:
- event_id/data/clubes vêm da agenda local, nunca da IA;
- canais pertencem à allowlist do projeto;
- toda fonte aceita precisa ter sido efetivamente retornada pelo web_search;
- uma fonte forte OU duas fontes independentes são exigidas;
- confiança mínima configurável;
- a resposta da IA representa a grade COMPLETA, não um delta;
- o overlay não substitui override editorial manual, cuja autoridade segue máxima.
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Mapping, Sequence
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from atualizar_transmissoes_tv_brasileirao import ALLOWED_CHANNELS, access_options_for_game  # noqa: E402

TZ = ZoneInfo("America/Sao_Paulo")
OPENAI_URL = "https://api.openai.com/v1/responses"
AGENDA = ROOT / "dados-br" / "agenda-clubes-br.json"
TV = ROOT / "dados-br" / "transmissoes-tv.json"
LIVE = ROOT / "dados-br" / "transmissoes-aovivo.json"
MANUAL = ROOT / "transmissoes.json"
CONFIG = ROOT / "dados-br" / "config-transmissoes-guardiao.json"
OVERLAY = ROOT / "dados-br" / "transmissoes-guardiao.json"
AUDIT = ROOT / "dados-br" / "auditoria-transmissoes-guardiao.json"

DEFAULT_CONFIG: dict[str, Any] = {
    "modelo_padrao": "gpt-5.6-sol",
    "janela_antes_horas": 24,
    "janela_depois_minutos": 30,
    "checkpoints_minutos": [-1440, -360, -90, -15, 10],
    "checkpoints_auditoria_completa": [-1440, -90],
    "confianca_minima": 0.90,
    "max_tool_calls": 3,
    "search_context_size": "medium",
    "dominios_permitidos": ["ge.globo.com", "espn.com.br", "uol.com.br", "youtube.com"],
    "dominios_fortes": ["ge.globo.com", "espn.com.br", "uol.com.br"],
}


class GuardianError(RuntimeError):
    pass


def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return copy.deepcopy(default)


def atomic_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def parse_dt(value: Any) -> dt.datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=TZ)
    return parsed.astimezone(TZ)


def now_brt() -> dt.datetime:
    return dt.datetime.now(TZ).replace(microsecond=0)


def team_name(value: Any) -> str:
    if isinstance(value, Mapping):
        return str(value.get("nome") or value.get("name") or value.get("displayName") or "").strip()
    return str(value or "").strip()


def normalize_url(value: Any) -> str:
    """Normaliza URL sem destruir a identidade de vídeos do YouTube.

    Para páginas editoriais, query/fragment são ruído e são removidos. Em
    ``youtube.com/watch``, porém, ``v=`` É o identificador do vídeo; descartá-lo
    faria vídeos distintos colidirem em ``/watch`` e poderia remover o player
    errado durante a auditoria.
    """
    try:
        parsed = urllib.parse.urlsplit(str(value or "").strip())
    except Exception:
        return ""
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return ""
    host = parsed.hostname.lower()
    path = re.sub(r"/+", "/", parsed.path or "/").rstrip("/") or "/"
    query = ""
    if (host == "youtube.com" or host.endswith(".youtube.com")) and path == "/watch":
        video_id = (urllib.parse.parse_qs(parsed.query).get("v") or [""])[0].strip()
        if video_id:
            query = urllib.parse.urlencode({"v": video_id})
    return urllib.parse.urlunsplit((parsed.scheme.lower(), host, path, query, ""))


def host_of(value: Any) -> str:
    normalized = normalize_url(value)
    return urllib.parse.urlsplit(normalized).hostname or "" if normalized else ""


def domain_matches(host: str, domain: str) -> bool:
    host = str(host or "").lower().strip(".")
    domain = str(domain or "").lower().strip(".")
    return bool(host and domain and (host == domain or host.endswith("." + domain)))


def allowed_url(url: Any, domains: Sequence[str]) -> bool:
    host = host_of(url)
    return any(domain_matches(host, domain) for domain in domains)


def strong_url(url: Any, domains: Sequence[str]) -> bool:
    host = host_of(url)
    return any(domain_matches(host, domain) for domain in domains)


def game_by_id(agenda: Mapping[str, Any], event_id: str) -> dict[str, Any] | None:
    for game in agenda.get("jogos") or []:
        if not isinstance(game, Mapping):
            continue
        if str(game.get("event_id") or game.get("id") or "") == str(event_id):
            return dict(game)
    return None


def manual_rule(manual: Mapping[str, Any], event_id: str) -> dict[str, Any] | None:
    for raw in manual.get("transmissoes") or []:
        if isinstance(raw, Mapping) and str(raw.get("event_id") or "") == str(event_id):
            return dict(raw)
    return None


def current_live_links(live: Mapping[str, Any], event_id: str) -> list[dict[str, Any]]:
    item = (live.get("jogos") or {}).get(str(event_id)) if isinstance(live.get("jogos"), Mapping) else None
    if not isinstance(item, Mapping):
        return []
    links: list[dict[str, Any]] = []
    for raw in [item.get("principal")] + list(item.get("alternativas") or []):
        if isinstance(raw, Mapping) and raw.get("url"):
            links.append({
                "fonte": str(raw.get("fonte") or ""),
                "nome": str(raw.get("nome") or ""),
                "url": str(raw.get("url") or ""),
                "status": str(raw.get("status") or ""),
                "titulo": str(raw.get("titulo") or ""),
                "canal": str(raw.get("canal") or ""),
                "inicio_programado": str(raw.get("inicio_programado") or ""),
                "inicio_real": str(raw.get("inicio_real") or ""),
                "escopo": str(raw.get("escopo") or "partida"),
            })
    return links


def source_snapshot(tv: Mapping[str, Any], event_id: str) -> dict[str, Any]:
    item = (tv.get("jogos") or {}).get(str(event_id)) if isinstance(tv.get("jogos"), Mapping) else None
    return dict(item) if isinstance(item, Mapping) else {}


def should_call_ai(*, checkpoint: int, current: Mapping[str, Any], live_links: Sequence[Mapping[str, Any]], cfg: Mapping[str, Any]) -> tuple[bool, str]:
    complete = {int(v) for v in (cfg.get("checkpoints_auditoria_completa") or [-1440, -90])}
    if checkpoint in complete:
        return True, "checkpoint de auditoria completa"
    channels = [str(x) for x in (current.get("canais") or []) if str(x)]
    confidence = str(current.get("confianca") or "")
    origin = str(current.get("origem") or "")
    if not channels:
        return True, "transmissão ausente"
    if confidence == "preservado" or "snapshot anterior" in origin.lower():
        return True, "fonte preservada exige reconfirmação"
    if live_links:
        return True, "há player YouTube que precisa auditoria de escopo/estado"
    if checkpoint >= 0 and set(channels) & {"GE TV", "CazéTV", "SBT"}:
        return True, "canal digital aberto durante a partida exige reconfirmação"
    return False, "grade forte já confirmada; checkpoint intermediário não exige nova chamada"


def response_schema() -> dict[str, Any]:
    channel_enum = sorted(ALLOWED_CHANNELS)
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "event_id": {"type": "string"},
            "resolved": {"type": "boolean"},
            "channels": {"type": "array", "items": {"type": "string", "enum": channel_enum}, "maxItems": len(channel_enum)},
            "exclusive": {"type": "boolean"},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "summary": {"type": "string", "maxLength": 700},
            "source_urls": {"type": "array", "items": {"type": "string", "maxLength": 1400}, "maxItems": 8},
            "youtube_assessments": {
                "type": "array",
                "maxItems": 6,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "url": {"type": "string", "maxLength": 1400},
                        "scope": {"type": "string", "enum": ["match", "pre_game", "post_game", "highlights", "unknown"]},
                        "valid_for_match": {"type": "boolean"},
                        "reason": {"type": "string", "maxLength": 400}
                    },
                    "required": ["url", "scope", "valid_for_match", "reason"]
                }
            }
        },
        "required": ["event_id", "resolved", "channels", "exclusive", "confidence", "summary", "source_urls", "youtube_assessments"]
    }


def build_payload(dossier: Mapping[str, Any], cfg: Mapping[str, Any], model: str) -> dict[str, Any]:
    domains = [str(x) for x in (cfg.get("dominios_permitidos") or []) if str(x)]
    instruction = (
        "Você é o Guardião de Transmissões do Fórmula do Gol. Sua tarefa é pesquisar AGORA a grade oficial NO BRASIL para uma única partida. "
        "Use web_search e devolva a grade COMPLETA e atual, nunca apenas o canal que faltava. Confirme data, clubes, competição e horário do dossiê. "
        "Priorize competição, emissora/plataforma oficial e veículos esportivos reconhecidos. Não inferir por direitos históricos. "
        "GE/YouTube exige cuidado: tempo real, aquecimento, pré-jogo, pós-jogo, narração/watchalong e melhores momentos NÃO são transmissão integral da partida. "
        "Se houver um URL YouTube no dossiê, classifique seu escopo; valid_for_match=true apenas quando houver evidência de que transmite o jogo integral. "
        "O campo channels deve usar somente os nomes permitidos pelo schema. Se não houver evidência suficiente, resolved=false, channels=[] e explique. "
        "source_urls deve conter apenas páginas que você efetivamente consultou e que sustentam a decisão. Não invente URLs."
    )
    return {
        "model": model,
        "store": False,
        "reasoning": {"effort": "medium"},
        "input": [
            {"role": "developer", "content": instruction},
            {"role": "user", "content": "Dossiê da partida:\n" + json.dumps(dossier, ensure_ascii=False, separators=(",", ":"))},
        ],
        "max_output_tokens": 5000,
        "text": {"format": {"type": "json_schema", "name": "guardiao_transmissoes", "strict": True, "schema": response_schema()}},
        "tools": [{"type": "web_search", "search_context_size": str(cfg.get("search_context_size") or "medium"), "filters": {"allowed_domains": domains}}],
        "tool_choice": "auto",
        "max_tool_calls": int(cfg.get("max_tool_calls") or 3),
        "include": ["web_search_call.action.sources"],
    }


def extract_output_text(response: Mapping[str, Any]) -> str:
    out: list[str] = []
    for item in response.get("output") or []:
        if not isinstance(item, Mapping):
            continue
        for part in item.get("content") or []:
            if isinstance(part, Mapping) and part.get("type") == "output_text" and part.get("text"):
                out.append(str(part["text"]))
    return "".join(out)


def collect_source_urls(response: Mapping[str, Any]) -> set[str]:
    urls: set[str] = set()
    for item in response.get("output") or []:
        if not isinstance(item, Mapping):
            continue
        if item.get("type") == "web_search_call":
            action = item.get("action") or {}
            if isinstance(action, Mapping):
                for source in action.get("sources") or []:
                    if isinstance(source, Mapping):
                        u = normalize_url(source.get("url"))
                        if u:
                            urls.add(u)
        for part in item.get("content") or []:
            if not isinstance(part, Mapping):
                continue
            for ann in part.get("annotations") or []:
                if not isinstance(ann, Mapping):
                    continue
                raw = ann.get("url")
                if not raw and isinstance(ann.get("url_citation"), Mapping):
                    raw = ann["url_citation"].get("url")
                u = normalize_url(raw)
                if u:
                    urls.add(u)
    return urls


def call_openai(payload: Mapping[str, Any], api_key: str, timeout: int = 210) -> dict[str, Any]:
    req = urllib.request.Request(
        OPENAI_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as raw:
            response = json.loads(raw.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:900]
        raise GuardianError(f"OpenAI HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise GuardianError(f"Falha na chamada OpenAI: {exc}") from exc
    if not isinstance(response, dict):
        raise GuardianError("OpenAI não devolveu objeto JSON")
    if response.get("status") == "incomplete":
        raise GuardianError(f"OpenAI respondeu de forma incompleta: {response.get('incomplete_details') or 'sem detalhe'}")
    text = extract_output_text(response)
    if not text:
        raise GuardianError("OpenAI não devolveu output_text")
    try:
        response["_parsed"] = json.loads(text)
    except json.JSONDecodeError as exc:
        raise GuardianError("output_text da OpenAI não é JSON válido") from exc
    return response


def validate_result(parsed: Mapping[str, Any], *, event_id: str, current_live: Sequence[Mapping[str, Any]], actual_sources: set[str], cfg: Mapping[str, Any]) -> tuple[dict[str, Any] | None, list[str]]:
    reasons: list[str] = []
    if str(parsed.get("event_id") or "") != str(event_id):
        reasons.append("event_id divergente")
    if parsed.get("resolved") is not True:
        reasons.append("modelo não conseguiu confirmar a grade")
    channels = list(dict.fromkeys(str(x) for x in (parsed.get("channels") or []) if str(x)))
    if not channels:
        reasons.append("grade vazia")
    if any(ch not in ALLOWED_CHANNELS for ch in channels):
        reasons.append("canal fora da allowlist")
    exclusive = parsed.get("exclusive") is True
    if exclusive and len(channels) != 1:
        reasons.append("exclusive=true exige exatamente um canal/plataforma na grade completa")
    try:
        confidence = float(parsed.get("confidence") or 0)
    except (TypeError, ValueError):
        confidence = 0.0
    if confidence < float(cfg.get("confianca_minima") or 0.90):
        reasons.append(f"confiança {confidence:.3f} abaixo do limiar")

    allowed_domains = [str(x) for x in (cfg.get("dominios_permitidos") or [])]
    strong_domains = [str(x) for x in (cfg.get("dominios_fortes") or [])]
    declared: list[str] = []
    for raw in parsed.get("source_urls") or []:
        u = normalize_url(raw)
        if u and u not in declared:
            declared.append(u)
    proven = [u for u in declared if u in actual_sources and allowed_url(u, allowed_domains)]
    if not proven:
        reasons.append("nenhuma fonte declarada consta entre as páginas efetivamente retornadas pelo web_search")
    strong = [u for u in proven if strong_url(u, strong_domains)]
    unique_hosts = {host_of(u) for u in proven}
    if proven and not strong and len(unique_hosts) < 2:
        reasons.append("evidência insuficiente: exige uma fonte forte ou duas fontes independentes")

    live_by_url = {normalize_url(x.get("url")): x for x in current_live if normalize_url(x.get("url"))}
    live_urls = set(live_by_url)
    yt_out: list[dict[str, Any]] = []
    for raw in parsed.get("youtube_assessments") or []:
        if not isinstance(raw, Mapping):
            continue
        u = normalize_url(raw.get("url"))
        if not u or u not in live_urls:
            reasons.append("avaliação YouTube refere URL que não está no dossiê atual")
            continue
        valid_for_match = raw.get("valid_for_match") is True
        current_item = live_by_url.get(u) or {}
        source_key = re.sub(r"[^a-z0-9]+", " ", str(current_item.get("fonte") or current_item.get("nome") or "").lower()).strip()
        source_channel = ""
        if source_key in {"getv", "ge tv", "ge"} or "ge tv" in source_key:
            source_channel = "GE TV"
        elif "cazetv" in source_key or "caze tv" in source_key:
            source_channel = "CazéTV"
        elif source_key == "sbt" or "sbt sports" in source_key:
            source_channel = "SBT"
        if valid_for_match and source_channel and source_channel not in channels:
            reasons.append(f"player {source_channel} marcado como transmissão integral, mas canal ausente da grade completa")
        yt_out.append({
            "url": u,
            "scope": str(raw.get("scope") or "unknown"),
            "valid_for_match": valid_for_match,
            "reason": str(raw.get("reason") or "")[:400],
        })

    if reasons:
        return None, reasons
    return {
        "event_id": str(event_id),
        "canais": channels,
        "exclusivo": parsed.get("exclusive") is True,
        "confianca": round(confidence, 4),
        "resumo": str(parsed.get("summary") or "")[:700],
        "fontes": proven,
        "youtube": yt_out,
    }, []


def prune_invalid_youtube(live: Mapping[str, Any], event_id: str, assessments: Sequence[Mapping[str, Any]]) -> tuple[dict[str, Any], list[str]]:
    """Remove do snapshot automático players que a auditoria provou não serem o jogo.

    Nunca toca no arquivo manual. A remoção é URL-exata e só ocorre quando o
    modelo devolve valid_for_match=false para um player presente no dossiê.
    """
    invalid = {
        normalize_url(item.get("url"))
        for item in assessments
        if isinstance(item, Mapping) and item.get("valid_for_match") is False and normalize_url(item.get("url"))
    }
    clone = copy.deepcopy(live)
    if not invalid:
        return clone, []
    jogos = clone.get("jogos") if isinstance(clone.get("jogos"), dict) else {}
    entry = jogos.get(str(event_id)) if isinstance(jogos, dict) else None
    if not isinstance(entry, Mapping):
        return clone, []
    links = []
    for raw in [entry.get("principal")] + list(entry.get("alternativas") or []):
        if isinstance(raw, Mapping) and raw.get("url"):
            links.append(dict(raw))
    kept = [item for item in links if normalize_url(item.get("url")) not in invalid]
    removed = [str(item.get("url")) for item in links if normalize_url(item.get("url")) in invalid]
    if not removed:
        return clone, []
    if kept:
        updated = dict(entry)
        updated["principal"] = kept[0]
        updated["alternativas"] = kept[1:]
        jogos[str(event_id)] = updated
    else:
        jogos.pop(str(event_id), None)
    clone["jogos"] = jogos
    return clone, removed


def semantic_overlay(payload: Mapping[str, Any]) -> Any:
    clone = copy.deepcopy(payload)
    clone.pop("atualizado_em", None)
    for item in (clone.get("jogos") or {}).values() if isinstance(clone.get("jogos"), Mapping) else []:
        if isinstance(item, dict):
            item.pop("capturado_em", None)
            item.pop("checkpoint", None)
    return clone


def build_dossier(game: Mapping[str, Any], current: Mapping[str, Any], live_links: Sequence[Mapping[str, Any]], manual: Mapping[str, Any], checkpoint: int, moment: dt.datetime) -> dict[str, Any]:
    kickoff = parse_dt(game.get("data_iso"))
    return {
        "event_id": str(game.get("event_id") or game.get("id") or ""),
        "competition": str(game.get("competicao_nome_curto") or game.get("competicao_nome") or game.get("competicao_chave") or ""),
        "phase": str(game.get("fase") or ""),
        "leg": int(game.get("perna") or 0),
        "home": team_name(game.get("mandante")),
        "away": team_name(game.get("visitante")),
        "kickoff_brt": kickoff.isoformat() if kickoff else str(game.get("data_iso") or ""),
        "hours_to_kickoff": round(((kickoff - moment).total_seconds() / 3600), 2) if kickoff else None,
        "checkpoint_minutes": int(checkpoint),
        "country_of_audience": "Brasil",
        "current_transmission": {
            "channels": list(current.get("canais") or []),
            "origin": str(current.get("origem") or ""),
            "confidence": str(current.get("confianca") or ""),
            "stable": current.get("estavel") is True,
            "exclusive": current.get("exclusivo") is True,
            "sources": list(current.get("fontes") or []),
        },
        "current_youtube_players": list(live_links),
        "manual_override": {
            "exists": bool(manual),
            "mode": str(manual.get("modo") or "") if manual else "",
            "channels": manual.get("canais") or manual.get("transmissao") or [] if manual else [],
            "exclusive": manual.get("exclusivo") is True if manual else False,
        },
        "allowed_channels": sorted(ALLOWED_CHANNELS),
    }


def write_audit(record: Mapping[str, Any]) -> None:
    audit = load_json(AUDIT, {"schema_version": 1, "historico": []})
    history = list(audit.get("historico") or [])
    history.append(dict(record))
    audit["schema_version"] = 1
    audit["historico"] = history[-500:]
    audit["ultima_execucao"] = dict(record)
    audit["atualizado_em"] = str(record.get("executado_em") or now_brt().isoformat())
    atomic_json(AUDIT, audit)


def selftest() -> None:
    cfg = {**DEFAULT_CONFIG, **load_json(CONFIG, {})}
    current = {}
    live = []
    assert should_call_ai(checkpoint=-1440, current=current, live_links=live, cfg=cfg)[0]
    assert should_call_ai(checkpoint=-360, current={}, live_links=live, cfg=cfg)[0]
    assert not should_call_ai(checkpoint=-360, current={"canais": ["Paramount+"], "confianca": "confirmado", "origem": "GE"}, live_links=[], cfg=cfg)[0]
    assert should_call_ai(checkpoint=-15, current={"canais": ["Premiere"], "confianca": "confirmado"}, live_links=[{"url": "https://www.youtube.com/watch?v=ABCDEFGHIJK"}], cfg=cfg)[0]

    sources = {
        normalize_url("https://ge.globo.com/futebol/times/vasco/noticia/2026/09/08/santa-fe-x-vasco-onde-assistir-ao-vivo-horario-e-escalacoes.ghtml"),
        normalize_url("https://www.uol.com.br/esporte/ultimas-noticias/2026/09/08/santa-fe-x-vasco-horario-e-onde-assistir-ao-jogo-da-sul-americana.ghtm"),
    }
    parsed = {
        "event_id": "401913960", "resolved": True, "channels": ["Paramount+"], "exclusive": True, "confidence": 0.99,
        "summary": "Paramount+ confirmado para o Brasil.", "source_urls": list(sources), "youtube_assessments": [],
    }
    accepted, reasons = validate_result(parsed, event_id="401913960", current_live=[], actual_sources=sources, cfg=cfg)
    assert accepted and accepted["canais"] == ["Paramount+"] and not reasons

    bad = dict(parsed); bad["source_urls"] = ["https://exemplo-inventado.invalid/jogo"]
    accepted, reasons = validate_result(bad, event_id="401913960", current_live=[], actual_sources=sources, cfg=cfg)
    assert accepted is None and any("efetivamente retornadas" in x for x in reasons)

    yt = [{"url": "https://www.youtube.com/watch?v=ABCDEFGHIJK"}]
    parsed_yt = dict(parsed)
    parsed_yt["channels"] = ["Premiere"]
    parsed_yt["youtube_assessments"] = [{"url": yt[0]["url"], "scope": "pre_game", "valid_for_match": False, "reason": "Apenas aquecimento."}]
    accepted, reasons = validate_result(parsed_yt, event_id="401913960", current_live=yt, actual_sources=sources, cfg=cfg)
    assert accepted and accepted["youtube"][0]["scope"] == "pre_game" and not reasons

    inconsistent = dict(parsed)
    inconsistent["channels"] = ["Premiere"]
    inconsistent["exclusive"] = True
    inconsistent["youtube_assessments"] = [{"url": yt[0]["url"], "scope": "match", "valid_for_match": True, "reason": "supostamente integral"}]
    bad_accepted, bad_reasons = validate_result(inconsistent, event_id="401913960", current_live=[{"url": yt[0]["url"], "fonte": "getv"}], actual_sources=sources, cfg=cfg)
    assert bad_accepted is None and any("player GE TV" in x for x in bad_reasons)

    live_payload = {"jogos": {"401913960": {"event_id": "401913960", "principal": {"url": yt[0]["url"], "fonte": "getv"}, "alternativas": []}}}
    pruned, removed = prune_invalid_youtube(live_payload, "401913960", accepted["youtube"])
    assert removed == [yt[0]["url"]] and "401913960" not in pruned["jogos"]

    # Identidade do vídeo precisa sobreviver à normalização; vídeos distintos
    # jamais podem colidir e ser removidos juntos.
    yta = normalize_url("https://www.youtube.com/watch?v=ABCDEFGHIJK&utm_source=x")
    ytb = normalize_url("https://www.youtube.com/watch?v=ZYXWVUTSRQP")
    assert yta.endswith("watch?v=ABCDEFGHIJK") and ytb.endswith("watch?v=ZYXWVUTSRQP") and yta != ytb
    multi_live = {"jogos": {"401913960": {"principal": {"url": "https://www.youtube.com/watch?v=ABCDEFGHIJK"}, "alternativas": [{"url": "https://www.youtube.com/watch?v=ZYXWVUTSRQP"}]}}}
    multi_pruned, multi_removed = prune_invalid_youtube(multi_live, "401913960", [{"url": "https://www.youtube.com/watch?v=ABCDEFGHIJK", "valid_for_match": False}])
    assert multi_removed == ["https://www.youtube.com/watch?v=ABCDEFGHIJK"]
    assert multi_pruned["jogos"]["401913960"]["principal"]["url"].endswith("ZYXWVUTSRQP")

    payload = build_payload({"event_id": "x"}, cfg, "gpt-5.6-sol")
    assert payload["model"] == "gpt-5.6-sol"
    assert payload["tools"][0]["type"] == "web_search"
    assert payload["text"]["format"]["type"] == "json_schema"
    assert payload["max_tool_calls"] <= 3
    print("SELFTEST OK: T-24/T-90, fonte provada, Paramount+, YouTube pre_game e payload Responses API")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--event-id", default="")
    parser.add_argument("--checkpoint", type=int, default=-1440)
    parser.add_argument("--agora", default="")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--fixture-response", default="", help="JSON de resposta Responses API para teste offline")
    args = parser.parse_args()
    if args.self_test:
        selftest(); return 0

    cfg = {**DEFAULT_CONFIG, **load_json(CONFIG, {})}
    event_id = str(args.event_id or "").strip()
    if not event_id:
        raise GuardianError("--event-id é obrigatório")
    moment = parse_dt(args.agora) if args.agora else now_brt()
    if moment is None:
        raise GuardianError("--agora inválido")

    agenda = load_json(AGENDA, {"jogos": []})
    game = game_by_id(agenda, event_id)
    if not game:
        raise GuardianError(f"event_id {event_id} não encontrado na agenda consolidada")
    kickoff = parse_dt(game.get("data_iso"))
    if not kickoff:
        raise GuardianError(f"event_id {event_id} sem data válida")
    delta_min = (moment - kickoff).total_seconds() / 60.0
    before = -float(cfg.get("janela_antes_horas") or 24) * 60
    after = float(cfg.get("janela_depois_minutos") or 30)
    if not args.force and not (before <= delta_min <= after):
        print(f"Guardião: {event_id} fora da janela ({delta_min:.1f} min do kickoff); sem chamada OpenAI.")
        return 0

    tv = load_json(TV, {"jogos": {}})
    live = load_json(LIVE, {"jogos": {}})
    manual_payload = load_json(MANUAL, {"transmissoes": []})
    current = source_snapshot(tv, event_id)
    live_links = current_live_links(live, event_id)
    manual = manual_rule(manual_payload, event_id) or {}
    checkpoint = int(args.checkpoint)
    call_needed, call_reason = should_call_ai(checkpoint=checkpoint, current=current, live_links=live_links, cfg=cfg)

    base_record = {
        "event_id": event_id,
        "jogo": f"{team_name(game.get('mandante'))} x {team_name(game.get('visitante'))}",
        "data_iso": game.get("data_iso") or "",
        "checkpoint": checkpoint,
        "executado_em": moment.isoformat(),
        "chamada_openai": False,
        "motivo_chamada": call_reason,
        "canais_antes": list(current.get("canais") or []),
        "status": "sem_chamada",
    }
    if not call_needed and not args.force:
        write_audit(base_record)
        print(f"Guardião: {event_id}: {call_reason}. Sem custo OpenAI.")
        return 0

    model = os.environ.get("OPENAI_TRANSMISSION_MODEL", "").strip() or str(cfg.get("modelo_padrao") or "gpt-5.6-sol")
    dossier = build_dossier(game, current, live_links, manual, checkpoint, moment)
    payload = build_payload(dossier, cfg, model)
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if args.fixture_response:
        response = load_json(Path(args.fixture_response), {})
    else:
        if not api_key:
            base_record.update({"status": "erro", "erro": "OPENAI_API_KEY não configurada"})
            write_audit(base_record)
            raise GuardianError("OPENAI_API_KEY não configurada")
        response = call_openai(payload, api_key)
    parsed = response.get("_parsed") if isinstance(response.get("_parsed"), Mapping) else None
    if parsed is None:
        text = extract_output_text(response)
        parsed = json.loads(text) if text else {}
    actual_sources = collect_source_urls(response)
    accepted, reasons = validate_result(parsed or {}, event_id=event_id, current_live=live_links, actual_sources=actual_sources, cfg=cfg)

    record = dict(base_record)
    record["chamada_openai"] = True
    record["modelo"] = model
    record["fontes_web"] = sorted(actual_sources)
    if not accepted:
        record.update({"status": "nao_resolvido", "rejeicoes": reasons, "resumo": str((parsed or {}).get("summary") or "")[:700]})
        write_audit(record)
        print(f"Guardião: {event_id}: resposta não publicável: {'; '.join(reasons)}")
        return 0

    pruned_live, removed_youtube = prune_invalid_youtube(live, event_id, accepted["youtube"])
    if removed_youtube and not args.dry_run:
        atomic_json(LIVE, pruned_live)
        live = pruned_live

    overlay = load_json(OVERLAY, {"schema_version": 1, "jogos": {}})
    games = overlay.get("jogos") if isinstance(overlay.get("jogos"), dict) else {}
    before_channels = list(current.get("canais") or [])
    status = "confirmado" if set(before_channels) == set(accepted["canais"]) else "corrigido"
    entry = {
        "event_id": event_id,
        "rodada": int(game.get("rodada") or 0),
        "competicao_chave": str(game.get("competicao_chave") or ""),
        "competicao_nome": str(game.get("competicao_nome_curto") or game.get("competicao_nome") or ""),
        "mandante": team_name(game.get("mandante")),
        "visitante": team_name(game.get("visitante")),
        "data_iso": game.get("data_iso") or "",
        "status": status,
        "canais": accepted["canais"],
        "exclusivo": accepted["exclusivo"],
        "confianca": accepted["confianca"],
        "origem": f"OpenAI Web Search — Guardião {model}",
        "fontes": [{"url": u, "autoridade": "web_search_verificada"} for u in accepted["fontes"]],
        "youtube": accepted["youtube"],
        "resumo": accepted["resumo"],
        "checkpoint": checkpoint,
        "capturado_em": moment.isoformat(),
        "vigente_ate": (kickoff + dt.timedelta(hours=6)).isoformat(),
    }
    previous_overlay = copy.deepcopy(overlay)
    games[event_id] = entry
    overlay["schema_version"] = 1
    overlay["descricao"] = "Overlay verificado do Guardião IA. Precedência abaixo de override manual e acima das fontes automáticas/preservadas."
    overlay["jogos"] = games
    overlay["atualizado_em"] = moment.isoformat()
    changed = semantic_overlay(previous_overlay) != semantic_overlay(overlay)
    if changed and not args.dry_run:
        atomic_json(OVERLAY, overlay)

    # Acesso previsto serve só para auditoria humana; o consolidado recalcula com
    # a mesma função canônica usada pelo site após este script.
    preview = {"event_id": event_id, "canais": accepted["canais"]}
    preview["acessos"] = access_options_for_game(preview, live)
    record.update({
        "status": status,
        "canais_depois": accepted["canais"],
        "exclusivo": accepted["exclusivo"],
        "confianca": accepted["confianca"],
        "fontes_aceitas": accepted["fontes"],
        "youtube": accepted["youtube"],
        "youtube_removidos": removed_youtube,
        "overlay_alterado": changed,
        "resumo": accepted["resumo"],
    })
    write_audit(record)
    print(json.dumps({"ok": True, "event_id": event_id, "status": status, "canais": accepted["canais"], "overlay_alterado": changed, "preview_acessos": preview["acessos"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GuardianError as exc:
        print(f"ERRO GUARDIÃO: {exc}", file=sys.stderr)
        raise SystemExit(2)
