#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Orquestrador determinístico dos workflows do Fórmula do Gol.

Objetivo
--------
Trocar relógios fixos por decisões baseadas no estado esportivo e nos artefatos
já publicados. O script NÃO chama OpenAI e NÃO modifica o repositório. Ele
apenas decide, em cada ciclo, qual é a única próxima ação útil.

Política resumida
-----------------
1. Atualizar Brasileirão tem prioridade máxima:
   - pré-jogo, se a base estiver antiga;
   - imediatamente quando a ESPN detectar FINAL ainda não incorporado;
   - uma manutenção de segurança por dia.
   Placar/gol AO VIVO NÃO dispara pipeline pesado: a classificação live é
   calculada no navegador a partir do scoreboard ESPN.
2. Públicos pendentes:
   - primeira tentativa 15 min após o FINAL;
   - retentativas com backoff, sem reprocessar o Brasileirão inteiro.
3. Melhores momentos:
   - primeira busca 10 min após o FINAL;
   - retentativas com backoff, sem rodar eternamente a cada 10 min.
4. Transmissão ao vivo:
   - apenas perto de jogo elegível, enquanto faltar player GE TV/CazéTV;
   - respeita grade exclusiva/estável já conhecida.
5. Editorial:
   - somente quando o fechamento está realmente elegível e o dossiê mudou.
6. TV futura:
   - cobertura completa nos próximos 14 dias: manutenção a cada 72h;
   - havendo jogo sem grade nos próximos 14 dias: no máximo uma vez a cada 24h;
   - pendência crítica <72h: retentativa extraordinária a cada 6h.

O workflow GitHub correspondente usa a decisão para disparar no máximo UM
workflow escritor por ciclo, evitando filas inúteis no grupo repo-write-main.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

CONFIG_PATH = ROOT / "dados-br" / "config-orquestrador.json"
AGENDA_PATH = ROOT / "dados-br" / "agenda-clubes-br.json"
RESULTS_PATH = ROOT / "resultados.json"
ESPN_EVENTS_PATH = ROOT / "espn_eventos.json"
STATUS_UPDATE_PATH = ROOT / "dados-br" / "status-atualizacao.json"
PUBLIC_COMPLEMENTS_PATH = ROOT / "dados-br" / "publicos-complementares.json"
PUBLIC_AUDIT_PATH = ROOT / "dados-br" / "auditoria-publicos.json"
DETAILS_PATH = ROOT / "dados-br" / "jogos-detalhes.json"
MM_PATH = ROOT / "dados-br" / "melhores-momentos.json"
MM_MANUAL_PATH = ROOT / "dados-br" / "melhores-momentos-manual.json"
MM_COPA_PATH = ROOT / "dados-br" / "melhores-momentos-copa-do-brasil.json"
TV_PATH = ROOT / "dados-br" / "transmissoes-tv.json"
TV_AUDIT_PATH = ROOT / "dados-br" / "auditoria-transmissoes-tv.json"
LIVE_PATH = ROOT / "dados-br" / "transmissoes-aovivo.json"
LIVE_MANUAL_PATH = ROOT / "dados-br" / "transmissoes-aovivo-manual.json"
ANALYSES_PATH = ROOT / "dados-br" / "analises.json"
ANALYSES_CONFIG_PATH = ROOT / "dados-br" / "config-analises.json"
HIST_PROB_PATH = ROOT / "dados-br" / "historico-probabilidades.json"
CUP_SNAPSHOT_PATH = ROOT / "dados-br" / "competicoes-af-previsao" / "copa-do-brasil.json"
CUP_HISTORY_PATH = ROOT / "dados-br" / "historico-probabilidades-continentais.json"
CONTINENTAL_PATHS = {
    "copa_do_brasil": CUP_SNAPSHOT_PATH,
    "libertadores": ROOT / "dados-br" / "competicoes-af-previsao" / "libertadores.json",
    "sul_americana": ROOT / "dados-br" / "competicoes-af-previsao" / "sul-americana.json",
}

WORKFLOW_MAIN = "Atualizar Brasileirao (ESPN)"
WORKFLOW_MM = "Buscar melhores momentos oficiais"
WORKFLOW_PUBLICOS = "Atualizar públicos do Brasileirão"
WORKFLOW_TRANSMISSOES = "Buscar transmissões dos clubes do Brasileirão"
WORKFLOW_EDITORIAL_RODADA = "Publicar análise editorial da rodada"
WORKFLOW_EDITORIAL_COPA = "Publicar análise editorial da Copa do Brasil"

REPO_WRITERS = {
    "Atualizar Brasileirao (ESPN)",
    "Atualizar Elencos Brasileirao (ESPN)",
    "Auditar modelos AF-Previsão",
    "Auditoria IA diária",
    "Buscar melhores momentos oficiais",
    "Atualizar públicos do Brasileirão",
    "Buscar transmissões dos clubes do Brasileirão",
    "Publicar análise editorial da Copa do Brasil",
    "Publicar análise editorial da rodada",
    "Revisar melhores momentos Brasileirão oficiais",
}

CUP_ARTICLES = {
    600: "copa-do-brasil-2026-classificados-quartas",
    700: "copa-do-brasil-2026-classificados-semifinal",
    800: "copa-do-brasil-2026-finalistas",
    900: "copa-do-brasil-2026-campeao",
}

DEFAULT_CONFIG: dict[str, Any] = {
    "timezone": "America/Sao_Paulo",
    "atualizar_brasileirao": {
        "sondagem_antes_minutos": 45,
        "sondagem_depois_minutos": 240,
        "intervalo_pre_jogo_minutos": 60,
        "retentativa_final_pendente_minutos": 10,
        "fallback_final_estimado_minutos": 105,
        "manutencao_diaria_apos": "05:10",
    },
    "publicos": {
        "primeira_tentativa_apos_final_minutos": 15,
        "intervalos_retentativa": [
            {"ate_horas": 2, "minutos": 30},
            {"ate_horas": 6, "minutos": 60},
            {"ate_horas": 24, "minutos": 120},
            {"ate_horas": 72, "minutos": 360},
            {"ate_horas": 168, "minutos": 720},
            {"ate_horas": 99999, "minutos": 1440},
        ],
    },
    "melhores_momentos": {
        "primeira_tentativa_apos_final_minutos": 10,
        "intervalos_retentativa": [
            {"ate_horas": 2, "minutos": 10},
            {"ate_horas": 6, "minutos": 30},
            {"ate_horas": 24, "minutos": 120},
            {"ate_horas": 72, "minutos": 360},
            {"ate_horas": 99999, "minutos": 720},
        ],
        "ignorar_rodada_zero": True,
    },
    "transmissoes": {
        "tv_diaria_apos": "06:30",
        "tv_intervalo_saudavel_horas": 72,
        "tv_intervalo_pendencia_horas": 24,
        "tv_retentativa_critica_horas": 6,
        "aovivo_antes_minutos": 90,
        "aovivo_depois_minutos": 180,
        "aovivo_intervalo_minutos": 10,
    },
    "github": {"branch": "main", "historico_runs": 100, "bloquear_se_writer_ativo": True},
}


def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return json.loads(json.dumps(default, ensure_ascii=False))


def deep_merge(base: Mapping[str, Any], override: Mapping[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, Mapping) and isinstance(out.get(key), Mapping):
            out[key] = deep_merge(out[key], value)  # type: ignore[arg-type]
        else:
            out[key] = value
    return out


def parse_dt(value: Any, tz: ZoneInfo) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=tz)
    return parsed.astimezone(tz)


def now_local(tz: ZoneInfo, override: str = "") -> datetime:
    raw = override or os.environ.get("FDG_AGORA", "")
    parsed = parse_dt(raw, tz) if raw else None
    return parsed or datetime.now(tz).replace(microsecond=0)


def minutes_since(moment: datetime | None, now: datetime) -> float:
    if moment is None:
        return 10**9
    return max(0.0, (now - moment).total_seconds() / 60.0)


def time_reached(now: datetime, hhmm: str) -> bool:
    try:
        hh, mm = [int(part) for part in hhmm.split(":", 1)]
    except (ValueError, AttributeError):
        return True
    return (now.hour, now.minute) >= (hh, mm)


@dataclass(frozen=True)
class Game:
    event_id: str
    competition: str
    league: str
    kickoff: datetime
    home: str
    away: str

    @property
    def label(self) -> str:
        return f"{self.home} x {self.away}"


@dataclass(frozen=True)
class Decision:
    action: str = "none"
    reason: str = "Nenhuma ação necessária neste ciclo."
    event_id: str = ""
    round_number: str = ""
    mode: str = ""
    details: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "acao": self.action,
            "motivo": self.reason,
            "event_id": self.event_id,
            "rodada": self.round_number,
            "modo": self.mode,
            "detalhes": list(self.details),
        }


def team_name(value: Any) -> str:
    if isinstance(value, Mapping):
        return str(value.get("nome") or value.get("name") or "").strip()
    return str(value or "").strip()


def load_agenda(tz: ZoneInfo) -> list[Game]:
    data = load_json(AGENDA_PATH, {})
    rows = data.get("jogos") if isinstance(data, Mapping) else []
    out: list[Game] = []
    for row in rows or []:
        if not isinstance(row, Mapping):
            continue
        event_id = str(row.get("event_id") or "").strip()
        kickoff = parse_dt(row.get("data_iso"), tz)
        league = str(row.get("espn_league") or "").strip()
        if not event_id or not kickoff or not league:
            continue
        out.append(
            Game(
                event_id=event_id,
                competition=str(row.get("competicao_chave") or "").strip(),
                league=league,
                kickoff=kickoff,
                home=team_name(row.get("mandante")),
                away=team_name(row.get("visitante")),
            )
        )
    return sorted(out, key=lambda g: (g.kickoff, g.event_id))


def known_final_ids() -> set[str]:
    final: set[str] = set()
    results = load_json(RESULTS_PATH, {})
    for row in (results.get("resultados") or []) if isinstance(results, Mapping) else []:
        event_id = str((row or {}).get("event_id") or (row or {}).get("id") or "").strip()
        if event_id:
            final.add(event_id)
    for path in CONTINENTAL_PATHS.values():
        snapshot = load_json(path, {})
        for row in (snapshot.get("eventos") or []) if isinstance(snapshot, Mapping) else []:
            if not isinstance(row, Mapping) or not row.get("concluido"):
                continue
            event_id = str(row.get("event_id") or "").strip()
            if event_id:
                final.add(event_id)
    return final


def score_value(value: Any) -> int | None:
    try:
        if value is None or str(value).strip() == "":
            return None
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return None


def espn_probe(
    games: Sequence[Game],
    now: datetime,
    before_minutes: int,
    after_minutes: int,
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    """Retorna estado/placar ESPN usando no máximo uma chamada por liga/data."""
    relevant = [
        game
        for game in games
        if game.kickoff - timedelta(minutes=before_minutes) <= now <= game.kickoff + timedelta(minutes=after_minutes)
    ]
    groups: dict[tuple[str, str], list[Game]] = {}
    for game in relevant:
        groups.setdefault((game.league, game.kickoff.strftime("%Y%m%d")), []).append(game)
    states: dict[str, dict[str, Any]] = {}
    errors: list[str] = []
    for (league, day), group in groups.items():
        quoted = urllib.parse.quote(league, safe=".")
        url = f"https://site.api.espn.com/apis/site/v2/sports/soccer/{quoted}/scoreboard?dates={day}&limit=100"
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (compatible; FormulaDoGol-Orquestrador/1.0)",
                "Accept": "application/json,text/plain,*/*",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=8) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
            errors.append(f"{league}/{day}: {type(exc).__name__}: {exc}")
            continue
        wanted = {game.event_id for game in group}
        for event in payload.get("events") or []:
            event_id = str(event.get("id") or "")
            if event_id not in wanted:
                continue
            status = event.get("status") or {}
            status_type = status.get("type") or {}
            state = str(status_type.get("state") or "").lower()
            completed = bool(status_type.get("completed"))
            if completed:
                state = "post"
            if state not in {"pre", "in", "post"}:
                state = ""
            home_score: int | None = None
            away_score: int | None = None
            competitions = event.get("competitions") or []
            competition = competitions[0] if competitions and isinstance(competitions[0], Mapping) else {}
            for competitor in competition.get("competitors") or []:
                if not isinstance(competitor, Mapping):
                    continue
                side = str(competitor.get("homeAway") or "").lower()
                score = score_value(competitor.get("score"))
                if side == "home":
                    home_score = score
                elif side == "away":
                    away_score = score
            states[event_id] = {
                "state": state,
                "home_score": home_score,
                "away_score": away_score,
                "detail": str(status_type.get("shortDetail") or status_type.get("detail") or ""),
            }
    return states, errors


def local_event_states() -> dict[str, dict[str, Any]]:
    """Estado publicado usado para detectar mudança factual sem rodar o pipeline pesado."""
    out: dict[str, dict[str, Any]] = {}

    espn = load_json(ESPN_EVENTS_PATH, {})
    for row in (espn.get("eventos") or []) if isinstance(espn, Mapping) else []:
        if not isinstance(row, Mapping):
            continue
        event_id = str(row.get("event_id") or "").strip()
        if not event_id:
            continue
        out[event_id] = {
            "state": str(row.get("estado") or "").lower(),
            "home_score": score_value(row.get("placar_mandante")),
            "away_score": score_value(row.get("placar_visitante")),
        }

    # Competições continentais não armazenam sempre o placar no mesmo nível,
    # mas o estado pre/in/post já é suficiente para disparar a atualização.
    for path in CONTINENTAL_PATHS.values():
        snapshot = load_json(path, {})
        for row in (snapshot.get("eventos") or []) if isinstance(snapshot, Mapping) else []:
            if not isinstance(row, Mapping):
                continue
            event_id = str(row.get("event_id") or "").strip()
            if not event_id:
                continue
            home = row.get("mandante") if isinstance(row.get("mandante"), Mapping) else {}
            away = row.get("visitante") if isinstance(row.get("visitante"), Mapping) else {}
            out.setdefault(
                event_id,
                {
                    "state": str(row.get("estado") or ("post" if row.get("concluido") else "pre")).lower(),
                    "home_score": score_value(row.get("placar_mandante") if row.get("placar_mandante") is not None else home.get("placar")),
                    "away_score": score_value(row.get("placar_visitante") if row.get("placar_visitante") is not None else away.get("placar")),
                },
            )
    return out


def github_runs(token: str, repository: str, branch: str, limit: int = 300) -> tuple[list[dict[str, Any]], str]:
    """Lê histórico suficiente para cobrir pelo menos um dia do próprio orquestrador."""
    if not token or not repository:
        return [], "histórico GitHub indisponível: token/repositório ausentes"
    target = max(1, min(int(limit or 300), 500))
    per_page = min(100, target)
    collected: list[dict[str, Any]] = []
    page = 1
    try:
        while len(collected) < target:
            query = urllib.parse.urlencode(
                {"branch": branch, "per_page": per_page, "page": page}
            )
            url = f"https://api.github.com/repos/{repository}/actions/runs?{query}"
            request = urllib.request.Request(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2026-03-10",
                    "User-Agent": "FormulaDoGol-Orquestrador/1.0",
                },
            )
            with urllib.request.urlopen(request, timeout=10) as response:
                payload = json.loads(response.read().decode("utf-8"))
            batch = payload.get("workflow_runs") if isinstance(payload, Mapping) else []
            batch = [dict(run) for run in (batch or []) if isinstance(run, Mapping)]
            collected.extend(batch)
            if len(batch) < per_page:
                break
            page += 1
        return collected[:target], ""
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
        return collected, f"histórico GitHub parcialmente indisponível: {type(exc).__name__}: {exc}"


def synthetic_runs_from_artifacts(tz: ZoneInfo) -> list[dict[str, Any]]:
    """Fallback conservador quando o histórico de Actions não puder ser lido."""
    rows: list[dict[str, Any]] = []

    def add(name: str, when: Any, title: str) -> None:
        dt = parse_dt(when, tz)
        if not dt:
            return
        rows.append(
            {
                "name": name,
                "status": "completed",
                "conclusion": "success",
                "created_at": dt.isoformat(),
                "run_started_at": dt.isoformat(),
                "display_title": title,
                "synthetic": True,
            }
        )

    status = load_json(STATUS_UPDATE_PATH, {})
    add(WORKFLOW_MAIN, status.get("ultimo_sucesso") if isinstance(status, Mapping) else None, "Atualizar · artefato local")

    mm = load_json(MM_PATH, {})
    add(WORKFLOW_MM, mm.get("atualizado_em") if isinstance(mm, Mapping) else None, "Melhores momentos · artefato local")

    publicos = load_json(PUBLIC_AUDIT_PATH, {})
    add(WORKFLOW_PUBLICOS, publicos.get("gerado_em") if isinstance(publicos, Mapping) else None, "Públicos · artefato local")

    tv = load_json(TV_AUDIT_PATH, {})
    add(
        WORKFLOW_TRANSMISSOES,
        tv.get("atualizado_em") if isinstance(tv, Mapping) else None,
        "Transmissões · tv · artefato local",
    )
    return rows


def run_time(run: Mapping[str, Any], tz: ZoneInfo) -> datetime | None:
    return parse_dt(run.get("run_started_at") or run.get("created_at") or run.get("updated_at"), tz)


def last_run(runs: Sequence[Mapping[str, Any]], workflow_name: str, tz: ZoneInfo, *, success_only: bool = False, title_contains: str = "") -> tuple[datetime | None, Mapping[str, Any] | None]:
    candidates: list[tuple[datetime, Mapping[str, Any]]] = []
    needle = title_contains.lower().strip()
    for run in runs:
        if str(run.get("name") or "") != workflow_name:
            continue
        if success_only and str(run.get("conclusion") or "") != "success":
            continue
        if needle and needle not in str(run.get("display_title") or "").lower():
            continue
        when = run_time(run, tz)
        if when:
            candidates.append((when, run))
    if not candidates:
        return None, None
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0]


def active_writer(runs: Sequence[Mapping[str, Any]], current_run_id: str = "") -> Mapping[str, Any] | None:
    for run in runs:
        if current_run_id and str(run.get("id") or "") == str(current_run_id):
            continue
        if str(run.get("name") or "") not in REPO_WRITERS:
            continue
        if str(run.get("status") or "") in {"queued", "in_progress", "waiting", "pending", "requested"}:
            return run
    return None


def main_update_decision(
    *,
    config: Mapping[str, Any],
    now: datetime,
    games: Sequence[Game],
    states: Mapping[str, Mapping[str, Any]],
    probe_errors: Sequence[str],
    final_ids: set[str],
    runs: Sequence[Mapping[str, Any]],
    tz: ZoneInfo,
) -> Decision | None:
    cfg = config["atualizar_brasileirao"]
    last_success, _ = last_run(runs, WORKFLOW_MAIN, tz, success_only=True)
    last_any, _ = last_run(runs, WORKFLOW_MAIN, tz)
    since_success = minutes_since(last_success, now)
    since_any = minutes_since(last_any, now)
    retry_final = int(cfg.get("retentativa_final_pendente_minutos") or 10)

    final_pending: list[Game] = []
    pre: list[Game] = []
    fallback_final: list[Game] = []
    before = int(cfg.get("sondagem_antes_minutos") or 45)
    after = int(cfg.get("sondagem_depois_minutos") or 240)
    estimated_final = int(cfg.get("fallback_final_estimado_minutos") or 105)

    for game in games:
        if not (game.kickoff - timedelta(minutes=before) <= now <= game.kickoff + timedelta(minutes=after)):
            continue
        known = game.event_id in final_ids
        probe = states.get(game.event_id) or {}
        state = str(probe.get("state") or "")
        if state == "post" and not known:
            final_pending.append(game)
        elif state == "pre" and game.kickoff >= now:
            pre.append(game)
        elif not state and not known and now >= game.kickoff + timedelta(minutes=estimated_final):
            fallback_final.append(game)

    if final_pending:
        labels = ", ".join(game.label for game in final_pending[:4])
        return Decision(
            "atualizar_brasileirao",
            f"ESPN marcou FINAL ainda não incorporado ao repositório: {labels}.",
            details=tuple(probe_errors[:3]),
        )

    # Se a sonda ESPN falhar, o relógio do jogo vira apenas uma contingência.
    if fallback_final and since_any >= retry_final:
        labels = ", ".join(game.label for game in fallback_final[:4])
        return Decision(
            "atualizar_brasileirao",
            f"Contingência pós-jogo: partida passou da duração estimada e o snapshot local ainda não registra FINAL: {labels}.",
            details=tuple(probe_errors[:3]),
        )

    # Gol, empate, virada e início AO VIVO não justificam o pipeline pesado.
    # Tabela e Estatísticas consultam o scoreboard ESPN no navegador a cada 30 s.

    pre_interval = int(cfg.get("intervalo_pre_jogo_minutos") or 60)
    imminent = [game for game in pre if game.kickoff <= now + timedelta(minutes=before)]
    if imminent and since_success >= pre_interval:
        labels = ", ".join(game.label for game in imminent[:4])
        return Decision(
            "atualizar_brasileirao",
            f"Pré-jogo: base será sincronizada antes do início de {labels}.",
        )

    maintenance_after = str(cfg.get("manutencao_diaria_apos") or "05:10")
    if time_reached(now, maintenance_after) and (last_success is None or last_success.date() < now.date()):
        return Decision(
            "atualizar_brasileirao",
            "Manutenção diária de segurança: ainda não houve atualização completa bem-sucedida hoje.",
        )
    return None



def public_retry_interval(age_hours: float, config: Mapping[str, Any]) -> int:
    rows = config.get("publicos", {}).get("intervalos_retentativa") or []
    for row in rows:
        try:
            if age_hours <= float(row.get("ate_horas")):
                return int(row.get("minutos"))
        except (TypeError, ValueError):
            continue
    return 1440


def _attendance_number(value: Any) -> int | None:
    try:
        if value is None or isinstance(value, bool):
            return None
        if isinstance(value, (int, float)):
            n = int(round(float(value)))
        else:
            digits = "".join(ch for ch in str(value) if ch.isdigit())
            if not digits:
                return None
            n = int(digits)
        return n if 100 <= n <= 250000 else None
    except (TypeError, ValueError):
        return None


def pending_publics(config: Mapping[str, Any], now: datetime, tz: ZoneInfo) -> list[tuple[dict[str, Any], datetime]]:
    results = load_json(RESULTS_PATH, {})
    rows = results.get("resultados") if isinstance(results, Mapping) else []
    details_payload = load_json(DETAILS_PATH, {})
    details = details_payload.get("jogos") if isinstance(details_payload, Mapping) else {}
    if not isinstance(details, Mapping):
        details = {}
    comp_payload = load_json(PUBLIC_COMPLEMENTS_PATH, {})
    complements = comp_payload.get("jogos") if isinstance(comp_payload, Mapping) else {}
    if not isinstance(complements, Mapping):
        complements = {}
    min_age = int(config.get("publicos", {}).get("primeira_tentativa_apos_final_minutos") or 15)
    pending: list[tuple[dict[str, Any], datetime]] = []
    for raw in rows or []:
        if not isinstance(raw, Mapping):
            continue
        row = dict(raw)
        event_id = str(row.get("event_id") or row.get("id") or "").strip()
        if not event_id:
            continue
        detail = details.get(event_id) if isinstance(details, Mapping) else None
        complement = complements.get(event_id) if isinstance(complements, Mapping) else None
        detail_public = _attendance_number((detail or {}).get("publico")) if isinstance(detail, Mapping) else None
        comp_public = _attendance_number((complement or {}).get("publico")) if isinstance(complement, Mapping) else None
        if detail_public is not None or comp_public is not None:
            continue
        ended = result_final_time(row, tz)
        if ended is None or now < ended + timedelta(minutes=min_age):
            continue
        pending.append((row, ended))
    pending.sort(key=lambda item: item[1], reverse=True)
    return pending


def public_decision(config: Mapping[str, Any], now: datetime, tz: ZoneInfo, runs: Sequence[Mapping[str, Any]]) -> Decision | None:
    pending = pending_publics(config, now, tz)
    if not pending:
        return None
    last, _ = last_run(runs, WORKFLOW_PUBLICOS, tz)
    first_due = list(pending) if last is None else [(row, ended) for row, ended in pending if ended > last]
    if first_due:
        row, ended = min(first_due, key=lambda item: item[1])
        event_id = str(row.get("event_id") or "")
        label = f"{team_name(row.get('mandante'))} x {team_name(row.get('visitante'))}".strip(" x")
        return Decision(
            "publicos",
            f"Primeira busca de público: {label or event_id} terminou há {int(minutes_since(ended, now))} min e segue sem público presente.",
            event_id=event_id,
            mode="incremental",
        )
    min_interval = min(public_retry_interval(minutes_since(ended, now) / 60.0, config) for _, ended in pending)
    if minutes_since(last, now) >= min_interval:
        oldest_row, oldest_end = min(pending, key=lambda item: item[1])
        event_id = str(oldest_row.get("event_id") or "")
        return Decision(
            "publicos",
            f"Retentativa de público: ainda há {len(pending)} jogo(s) finalizado(s) sem público; backoff atual {min_interval} min.",
            event_id=event_id,
            mode="incremental",
        )
    return None


def linked_mm_ids() -> set[str]:
    linked: set[str] = set()
    for path in (MM_PATH, MM_MANUAL_PATH):
        data = load_json(path, {})
        games = data.get("jogos") if isinstance(data, Mapping) else {}
        if isinstance(games, Mapping):
            for key, row in games.items():
                event_id = str((row or {}).get("event_id") or key or "").strip() if isinstance(row, Mapping) else str(key)
                if event_id:
                    linked.add(event_id)
    return linked


def result_final_time(row: Mapping[str, Any], tz: ZoneInfo) -> datetime | None:
    exact = parse_dt(row.get("finalizado_em"), tz)
    if exact:
        return exact
    kickoff = parse_dt(row.get("data_iso"), tz)
    return kickoff + timedelta(minutes=115) if kickoff else None


def mm_retry_interval(age_hours: float, config: Mapping[str, Any]) -> int:
    rows = config["melhores_momentos"].get("intervalos_retentativa") or []
    for row in rows:
        try:
            if age_hours <= float(row.get("ate_horas")):
                return int(row.get("minutos"))
        except (TypeError, ValueError):
            continue
    return 720


def pending_mm(config: Mapping[str, Any], now: datetime, tz: ZoneInfo) -> list[tuple[dict[str, Any], datetime]]:
    linked = linked_mm_ids()
    data = load_json(RESULTS_PATH, {})
    rows = data.get("resultados") if isinstance(data, Mapping) else []
    pending: list[tuple[dict[str, Any], datetime]] = []
    min_age = int(config["melhores_momentos"].get("primeira_tentativa_apos_final_minutos") or 10)
    ignore_zero = bool(config["melhores_momentos"].get("ignorar_rodada_zero", True))
    for raw in rows or []:
        if not isinstance(raw, Mapping):
            continue
        row = dict(raw)
        event_id = str(row.get("event_id") or row.get("id") or "").strip()
        if not event_id or event_id in linked:
            continue
        try:
            rodada = int(row.get("rodada") or 0)
        except (TypeError, ValueError):
            rodada = 0
        if ignore_zero and rodada <= 0:
            continue
        ended = result_final_time(row, tz)
        if ended is None or now < ended + timedelta(minutes=min_age):
            continue
        pending.append((row, ended))

    # Copa do Brasil: o próprio arquivo de highlights enumera event_ids concluídos
    # ainda sem vídeo. Usa kickoff+115min como final conservador quando necessário.
    cup_hl = load_json(MM_COPA_PATH, {})
    cup_pending = {str(value) for value in (cup_hl.get("pendentes") or []) if value}
    if cup_pending:
        cup = load_json(CUP_SNAPSHOT_PATH, {})
        for raw in cup.get("eventos") or []:
            if not isinstance(raw, Mapping) or not raw.get("concluido"):
                continue
            event_id = str(raw.get("event_id") or "")
            if event_id not in cup_pending:
                continue
            kickoff = parse_dt(raw.get("data_iso"), tz)
            ended = kickoff + timedelta(minutes=115) if kickoff else now - timedelta(minutes=min_age)
            if now >= ended + timedelta(minutes=min_age):
                row = {
                    "event_id": event_id,
                    "rodada": 0,
                    "mandante": raw.get("mandante"),
                    "visitante": raw.get("visitante"),
                    "competicao": "Copa do Brasil",
                }
                pending.append((row, ended))
    pending.sort(key=lambda item: item[1], reverse=True)
    return pending


def mm_decisions(config: Mapping[str, Any], now: datetime, tz: ZoneInfo, runs: Sequence[Mapping[str, Any]]) -> tuple[Decision | None, Decision | None]:
    pending = pending_mm(config, now, tz)
    if not pending:
        return None, None
    last, _ = last_run(runs, WORKFLOW_MM, tz)
    first_due: list[tuple[dict[str, Any], datetime]] = []
    if last is None:
        first_due = list(pending)
    else:
        first_due = [(row, ended) for row, ended in pending if ended > last]
    if first_due:
        row, ended = min(first_due, key=lambda item: item[1])
        event_id = str(row.get("event_id") or "")
        label = f"{team_name(row.get('mandante'))} x {team_name(row.get('visitante'))}".strip(" x")
        return (
            Decision(
                "melhores_momentos",
                f"Primeira tentativa de melhores momentos: {label or event_id} terminou há {int(minutes_since(ended, now))} min.",
                event_id=event_id,
                mode="incremental",
            ),
            None,
        )

    min_interval = min(
        mm_retry_interval(minutes_since(ended, now) / 60.0, config)
        for _, ended in pending
    )
    if minutes_since(last, now) >= min_interval:
        oldest_row, oldest_end = min(pending, key=lambda item: item[1])
        event_id = str(oldest_row.get("event_id") or "")
        return (
            None,
            Decision(
                "melhores_momentos",
                f"Retentativa de melhores momentos: ainda há {len(pending)} jogo(s) sem vídeo; backoff atual {min_interval} min.",
                event_id=event_id,
                mode="incremental",
                details=(f"pendência mais antiga: {int(minutes_since(oldest_end, now))} min",),
            ),
        )
    return None, None


def live_entries(path: Path) -> set[str]:
    data = load_json(path, {})
    games = data.get("jogos") if isinstance(data, Mapping) else {}
    if isinstance(games, Mapping):
        return {str(key) for key, value in games.items() if value}
    return set()


def live_search_allowed(event_id: str) -> tuple[bool, str]:
    tv = load_json(TV_PATH, {})
    games = tv.get("jogos") if isinstance(tv, Mapping) else {}
    item = games.get(event_id) if isinstance(games, Mapping) else None
    if not isinstance(item, Mapping):
        return True, "grade ainda não consolidada"
    channels = {str(value) for value in (item.get("canais") or []) if value}
    if channels & {"GE TV", "CazéTV"}:
        return True, "grade já indica GE TV/CazéTV"
    if item.get("exclusivo") is True:
        return False, "grade exclusiva confirmada sem GE TV/CazéTV"
    if channels & {"Globo", "Record"}:
        return True, "grade aberta pode ter direito digital"
    if item.get("estavel") is True:
        return False, "grade estável confirmada sem indício de GE TV/CazéTV"
    return True, "grade ainda não estável"


def transmission_live_decision(config: Mapping[str, Any], now: datetime, games: Sequence[Game], final_ids: set[str], tz: ZoneInfo, runs: Sequence[Mapping[str, Any]]) -> Decision | None:
    cfg = config["transmissoes"]
    before = int(cfg.get("aovivo_antes_minutos") or 90)
    after = int(cfg.get("aovivo_depois_minutos") or 180)
    interval = int(cfg.get("aovivo_intervalo_minutos") or 10)
    linked = live_entries(LIVE_PATH) | live_entries(LIVE_MANUAL_PATH)
    candidates: list[tuple[Game, str]] = []
    for game in games:
        if game.event_id in final_ids or game.event_id in linked:
            continue
        if not (game.kickoff - timedelta(minutes=before) <= now <= game.kickoff + timedelta(minutes=after)):
            continue
        allowed, reason = live_search_allowed(game.event_id)
        if allowed:
            candidates.append((game, reason))
    if not candidates:
        return None
    candidates.sort(key=lambda item: abs((item[0].kickoff - now).total_seconds()))
    game, policy = candidates[0]
    last, _ = last_run(runs, WORKFLOW_TRANSMISSOES, tz, title_contains=f"aovivo · {game.event_id}")
    if minutes_since(last, now) < interval:
        return None
    return Decision(
        "transmissao_aovivo",
        f"Player oficial ainda não localizado para {game.label}; {policy}.",
        event_id=game.event_id,
        mode="aovivo",
    )


def tv_decision(
    config: Mapping[str, Any],
    now: datetime,
    tz: ZoneInfo,
    runs: Sequence[Mapping[str, Any]],
    audit_summary: Mapping[str, Any] | None = None,
) -> Decision | None:
    """Agenda a varredura completa de TV com cadência proporcional à pendência.

    O orquestrador pode continuar sendo chamado a cada 10 minutos, mas o modo
    ``tv`` não acompanha essa cadência: cobertura saudável usa 72h; pendências
    em até 14 dias usam 24h; somente lacunas a menos de 72h autorizam retry de
    6h. Assim ``Transmissões · tv · todos`` deixa de gerar varredura diária
    quando a grade relevante já está completa.
    """
    cfg = config["transmissoes"]
    last, _ = last_run(runs, WORKFLOW_TRANSMISSOES, tz, title_contains="· tv")
    first_after = str(cfg.get("tv_diaria_apos") or "06:30")

    if audit_summary is None:
        audit = load_json(TV_AUDIT_PATH, {})
        summary_raw = audit.get("resumo") if isinstance(audit, Mapping) else {}
        summary = summary_raw if isinstance(summary_raw, Mapping) else {}
    else:
        summary = audit_summary

    def _count(key: str) -> int:
        try:
            return max(0, int(summary.get(key) or 0))
        except (TypeError, ValueError):
            return 0

    critical = _count("jogos_criticos_sem_transmissao_72h")
    missing_14d = _count("jogos_sem_transmissao_14d")
    age_minutes = minutes_since(last, now)
    critical_hours = float(cfg.get("tv_retentativa_critica_horas") or 6)
    pending_hours = float(cfg.get("tv_intervalo_pendencia_horas") or 24)
    healthy_hours = float(cfg.get("tv_intervalo_saudavel_horas") or 72)

    # Primeira execução: conserva a janela matinal para evitar varredura
    # desnecessária à meia-noite após um deploy/recriação de histórico.
    if last is None:
        if time_reached(now, first_after):
            return Decision("transmissoes_tv", "Primeira atualização da grade de TV ainda não executada.", mode="tv")
        return None

    # Lacuna realmente próxima merece prioridade e independe do horário-base.
    if critical > 0 and age_minutes >= critical_hours * 60:
        return Decision(
            "transmissoes_tv",
            f"Há {critical} jogo(s) nas próximas 72h sem grade confirmada; retentativa crítica após {critical_hours:g}h.",
            mode="tv",
        )

    if not time_reached(now, first_after):
        return None

    if missing_14d > 0 and age_minutes >= pending_hours * 60:
        return Decision(
            "transmissoes_tv",
            f"Há {missing_14d} jogo(s) nos próximos 14 dias sem grade; nova pesquisa após {pending_hours:g}h.",
            mode="tv",
        )

    if missing_14d == 0 and age_minutes >= healthy_hours * 60:
        return Decision(
            "transmissoes_tv",
            f"Cobertura dos próximos 14 dias completa; manutenção preventiva após {healthy_hours:g}h.",
            mode="tv",
        )
    return None


def round_editorial_decision(now: datetime) -> Decision | None:
    try:
        from gerar_analise_rodada import carregar_json as editorial_load
        from gerar_analise_rodada import estado_rodada, montar_dossie
    except Exception as exc:  # pragma: no cover - diagnóstico defensivo
        return None
    try:
        config = editorial_load(ANALYSES_CONFIG_PATH)
        eligible: list[int] = []
        for number in range(1, 39):
            state = estado_rodada(number, now, config)
            if state.get("elegivel"):
                eligible.append(number)
        if not eligible:
            return None
        rodada = max(eligible)
        state = estado_rodada(rodada, now, config)
        dossier = montar_dossie(rodada, state)
        digest = hashlib.sha256(json.dumps(dossier, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    except Exception:
        # Sem snapshot AF correspondente, ainda não há editorial válido a publicar.
        return None
    manifest = load_json(ANALYSES_PATH, {})
    article = next(
        (
            item
            for item in (manifest.get("artigos") or [])
            if isinstance(item, Mapping) and item.get("tipo") == "brasileirao_rodada" and int(item.get("rodada") or 0) == rodada
        ),
        None,
    )
    if article and str(article.get("hash_dossie") or "") == digest:
        return None
    status = "ainda não publicado" if not article else "dossiê mudou desde a última publicação"
    return Decision(
        "editorial_rodada",
        f"Rodada {rodada} está editorialmente fechada e {status}.",
        round_number=str(rodada),
    )


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def cup_editorial_decision() -> Decision | None:
    snapshot = load_json(CUP_SNAPSHOT_PATH, {})
    phase = snapshot.get("fase_atual") if isinstance(snapshot, Mapping) else {}
    try:
        rank = int((phase or {}).get("ordem") or 0)
    except (TypeError, ValueError):
        return None
    article_id = CUP_ARTICLES.get(rank)
    if not article_id or str((phase or {}).get("status") or "").lower() != "encerrada":
        return None
    manifest = load_json(ANALYSES_PATH, {})
    article = next(
        (item for item in (manifest.get("artigos") or []) if isinstance(item, Mapping) and item.get("id_editorial") == article_id),
        None,
    )
    if article is None:
        return Decision(
            "editorial_copa_do_brasil",
            f"Fase da Copa do Brasil encerrada (ordem {rank}) e editorial correspondente ainda não existe.",
        )
    highlights = load_json(MM_COPA_PATH, {})
    games = highlights.get("jogos") if isinstance(highlights, Mapping) else {}
    current_hash = canonical_hash(games if isinstance(games, Mapping) else {})
    if str(article.get("hash_melhores_momentos") or "") != current_hash:
        return Decision(
            "editorial_copa_do_brasil",
            "Editorial da Copa está publicado, mas os melhores momentos da fase mudaram; atualizar somente o necessário.",
        )
    return None


def decide(
    *,
    config: Mapping[str, Any],
    now: datetime,
    games: Sequence[Game],
    states: Mapping[str, Mapping[str, Any]],
    probe_errors: Sequence[str],
    runs: Sequence[Mapping[str, Any]],
    tz: ZoneInfo,
    current_run_id: str = "",
) -> Decision:
    if bool(config.get("github", {}).get("bloquear_se_writer_ativo", True)):
        active = active_writer(runs, current_run_id)
        if active:
            return Decision(
                "none",
                f"Aguardando workflow escritor já ativo: {active.get('name')} ({active.get('status')}).",
            )

    final_ids = known_final_ids()

    # 1. Dado esportivo sempre vence.
    main = main_update_decision(
        config=config,
        now=now,
        games=games,
        states=states,
        probe_errors=probe_errors,
        final_ids=final_ids,
        runs=runs,
        tz=tz,
    )
    if main:
        return main

    # 2. Público pendente é uma tarefa leve e independente do pipeline completo.
    publico = public_decision(config, now, tz, runs)
    if publico:
        return publico

    # 3. Primeira busca de vídeo deve acontecer logo após o primeiro snapshot FINAL.
    mm_first, mm_retry = mm_decisions(config, now, tz, runs)
    if mm_first:
        return mm_first

    # 4. Link ao vivo é janela perecível; não deve esperar editorial.
    live = transmission_live_decision(config, now, games, final_ids, tz, runs)
    if live:
        return live

    # 5/6. Editoriais só acordam quando existe algo publicável ou desatualizado.
    cup = cup_editorial_decision()
    if cup:
        return cup
    rodada = round_editorial_decision(now)
    if rodada:
        return rodada

    # 7. Depois da primeira busca, vídeos ausentes entram em backoff.
    if mm_retry:
        return mm_retry

    # 8. Grade futura: diária, com exceção de pendência crítica.
    tv = tv_decision(config, now, tz, runs)
    if tv:
        return tv

    detail = tuple(probe_errors[:3])
    return Decision("none", "Estado consistente; nenhum workflow pesado precisa rodar agora.", details=detail)


def write_github_output(path: str, decision: Decision) -> None:
    if not path:
        return
    safe_reason = decision.reason.replace("\n", " ").replace("\r", " ")
    values = {
        "acao": decision.action,
        "motivo": safe_reason,
        "event_id": decision.event_id,
        "rodada": decision.round_number,
        "modo": decision.mode,
    }
    with open(path, "a", encoding="utf-8") as handle:
        for key, value in values.items():
            handle.write(f"{key}={value}\n")


def self_test() -> int:
    tz = ZoneInfo("America/Sao_Paulo")
    now = datetime(2026, 8, 9, 21, 30, tzinfo=tz)
    config = deep_merge(DEFAULT_CONFIG, {})
    game = Game("1", "brasileirao", "bra.1", datetime(2026, 8, 9, 19, 30, tzinfo=tz), "Flamengo", "Vitória")

    # Helpers de tempo.
    assert parse_dt("2026-08-09T21:24:00-03:00", tz).hour == 21
    assert time_reached(now, "06:30")
    assert not time_reached(datetime(2026, 8, 9, 5, 0, tzinfo=tz), "06:30")
    assert mm_retry_interval(1.0, config) == 10
    assert mm_retry_interval(3.0, config) == 30
    assert mm_retry_interval(12.0, config) == 120
    assert mm_retry_interval(40.0, config) == 360
    assert mm_retry_interval(100.0, config) == 720

    # Último run e bloqueio de writer.
    runs = [
        {"name": WORKFLOW_MAIN, "status": "completed", "conclusion": "success", "created_at": "2026-08-09T23:00:00Z", "display_title": "Atualizar"},
        {"name": WORKFLOW_TRANSMISSOES, "status": "completed", "conclusion": "success", "created_at": "2026-08-09T10:00:00Z", "display_title": "Transmissões · tv"},
    ]
    last, _ = last_run(runs, WORKFLOW_MAIN, tz, success_only=True)
    assert last and last.astimezone(tz).hour == 20
    assert active_writer(runs) is None
    assert active_writer(runs + [{"name": WORKFLOW_MM, "status": "in_progress", "id": 99}]) is not None

    # FINAL desconhecido deve vencer qualquer manutenção.
    original_known = globals()["known_final_ids"]
    try:
        globals()["known_final_ids"] = lambda: set()
        decision = main_update_decision(
            config=config,
            now=now,
            games=[game],
            states={"1": {"state": "post", "home_score": 2, "away_score": 0}},
            probe_errors=[],
            final_ids=set(),
            runs=[],
            tz=tz,
        )
        assert decision and decision.action == "atualizar_brasileirao"

        # Gol novo durante a partida NÃO deve disparar workflow pesado; o browser
        # já atualiza classificação/estatísticas pelo scoreboard ESPN a cada 30 s.
        recent = [{"name": WORKFLOW_MAIN, "status": "completed", "conclusion": "success", "created_at": "2026-08-10T00:25:00Z"}]
        goal = main_update_decision(
            config=config,
            now=now,
            games=[game],
            states={"1": {"state": "in", "home_score": 1, "away_score": 0}},
            probe_errors=[],
            final_ids=set(),
            runs=recent,
            tz=tz,
        )
        assert goal is None
    finally:
        globals()["known_final_ids"] = original_known

    # Política de transmissão: exclusiva bloqueia, Globo mantém elegibilidade.
    # Teste puro via snapshots artificiais seria excessivo aqui; a função real
    # é exercida pelo --dry-run sobre o repositório no pacote de validação.
    # TV futura: o cron pode consultar a cada 10 min, mas a varredura completa
    # deve respeitar 72h quando saudável, 24h com pendência e 6h se crítica.
    tx_cfg = deep_merge(DEFAULT_CONFIG, {"transmissoes": {
        "tv_diaria_apos": "06:30",
        "tv_intervalo_saudavel_horas": 72,
        "tv_intervalo_pendencia_horas": 24,
        "tv_retentativa_critica_horas": 6,
    }})
    tx_now = datetime(2026, 8, 16, 12, 0, tzinfo=tz)
    healthy_summary = {"jogos_sem_transmissao_14d": 0, "jogos_criticos_sem_transmissao_72h": 0}
    recent_tv = [{
        "name": WORKFLOW_TRANSMISSOES, "status": "completed", "conclusion": "success",
        "created_at": "2026-08-15T15:00:00Z", "display_title": "Transmissões · tv · todos",
    }]
    assert tv_decision(tx_cfg, tx_now, tz, recent_tv, healthy_summary) is None
    old_tv = [{
        "name": WORKFLOW_TRANSMISSOES, "status": "completed", "conclusion": "success",
        "created_at": "2026-08-13T15:00:00Z", "display_title": "Transmissões · tv · todos",
    }]
    assert tv_decision(tx_cfg, tx_now, tz, old_tv, healthy_summary).action == "transmissoes_tv"
    pending_summary = {"jogos_sem_transmissao_14d": 2, "jogos_criticos_sem_transmissao_72h": 0}
    day_old_tv = [{
        "name": WORKFLOW_TRANSMISSOES, "status": "completed", "conclusion": "success",
        "created_at": "2026-08-15T14:00:00Z", "display_title": "Transmissões · tv · todos",
    }]
    assert tv_decision(tx_cfg, tx_now, tz, day_old_tv, pending_summary).action == "transmissoes_tv"
    critical_summary = {"jogos_sem_transmissao_14d": 1, "jogos_criticos_sem_transmissao_72h": 1}
    six_hours_tv = [{
        "name": WORKFLOW_TRANSMISSOES, "status": "completed", "conclusion": "success",
        "created_at": "2026-08-16T08:00:00Z", "display_title": "Transmissões · tv · todos",
    }]
    assert tv_decision(tx_cfg, tx_now, tz, six_hours_tv, critical_summary).action == "transmissoes_tv"

    assert canonical_hash({"b": 2, "a": 1}) == canonical_hash({"a": 1, "b": 2})

    assert public_retry_interval(1.0, config) == 30
    assert public_retry_interval(5.0, config) == 60
    assert public_retry_interval(20.0, config) == 120
    assert public_retry_interval(100.0, config) == 720
    assert public_retry_interval(500.0, config) == 1440

    print("OK self-test: prioridade, tempo, backoff, gol ao vivo sem pipeline pesado e decisão pós-FINAL.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="Não altera nada; apenas imprime a decisão (comportamento normal já é read-only).")
    parser.add_argument("--sem-rede", action="store_true", help="Não consulta ESPN/GitHub; útil para testes locais.")
    parser.add_argument("--agora", default="", help="Data/hora ISO para teste determinístico.")
    parser.add_argument("--github-output", default=os.environ.get("GITHUB_OUTPUT", ""))
    args = parser.parse_args()
    if args.self_test:
        return self_test()

    raw_config = load_json(CONFIG_PATH, {})
    config = deep_merge(DEFAULT_CONFIG, raw_config if isinstance(raw_config, Mapping) else {})
    tz = ZoneInfo(str(config.get("timezone") or "America/Sao_Paulo"))
    now = now_local(tz, args.agora)
    games = load_agenda(tz)

    before = int(config["atualizar_brasileirao"].get("sondagem_antes_minutos") or 45)
    after = int(config["atualizar_brasileirao"].get("sondagem_depois_minutos") or 240)
    if args.sem_rede:
        states, probe_errors = {}, ["sondagem ESPN desativada por --sem-rede"]
        runs = synthetic_runs_from_artifacts(tz)
        gh_error = "histórico GitHub desativado por --sem-rede; usando timestamps dos artefatos locais"
        probe_errors.append(gh_error)
    else:
        states, probe_errors = espn_probe(games, now, before, after)
        runs, gh_error = github_runs(
            os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or "",
            os.environ.get("GITHUB_REPOSITORY") or "",
            str(config.get("github", {}).get("branch") or "main"),
            int(config.get("github", {}).get("historico_runs") or 100),
        )
        if gh_error:
            probe_errors.append(gh_error)
            runs = list(runs) + synthetic_runs_from_artifacts(tz)

    decision = decide(
        config=config,
        now=now,
        games=games,
        states=states,
        probe_errors=probe_errors,
        runs=runs,
        tz=tz,
        current_run_id=os.environ.get("GITHUB_RUN_ID", ""),
    )
    payload = {
        "agora": now.isoformat(),
        "jogos_agenda": len(games),
        "jogos_sondados": len(states),
        "erros_sondagem": probe_errors,
        **decision.as_dict(),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    write_github_output(args.github_output, decision)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
