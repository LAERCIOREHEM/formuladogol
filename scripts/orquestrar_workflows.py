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
1. Primeira busca do player oficial tem prioridade perecível única; depois, Atualizar Brasileirão volta a ter prioridade máxima:
   - imediatamente quando a ESPN detectar FINAL ainda não incorporado;
   - contingência pós-jogo se a sonda falhar;
   - uma manutenção de segurança por dia.
   O início do jogo, sozinho, NÃO dispara atualização pesada.
   Placar/gol AO VIVO NÃO dispara pipeline pesado: a classificação live é
   calculada no navegador a partir do scoreboard ESPN.
2. Públicos pendentes:
   - primeira tentativa 30 min após o FINAL;
   - retentativas seguem o relógio por campo gravado pela própria camada de IA;
   - erro técnico usa backoff curto e não vira fracasso documental.
3. Melhores momentos:
   - primeira busca 10 min após o FINAL;
   - retentativas com backoff, sem rodar eternamente a cada 10 min.
4. Transmissão ao vivo:
   - apenas perto de jogo elegível, enquanto faltar player GE TV/SBT/CazéTV;
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
from datetime import datetime, timedelta, timezone
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
PUBLIC_AI_STATE_PATH = ROOT / "dados-br" / "estado-publicos-ia.json"
DETAILS_PATH = ROOT / "dados-br" / "jogos-detalhes.json"
MM_PATH = ROOT / "dados-br" / "melhores-momentos.json"
MM_MANUAL_PATH = ROOT / "dados-br" / "melhores-momentos-manual.json"
MM_COPA_PATH = ROOT / "dados-br" / "melhores-momentos-copa-do-brasil.json"
TV_PATH = ROOT / "dados-br" / "transmissoes-tv.json"
TV_AUDIT_PATH = ROOT / "dados-br" / "auditoria-transmissoes-tv.json"
GUARDIAN_PATH = ROOT / "dados-br" / "transmissoes-guardiao.json"
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
CONTINENTAL_EDITORIAL_LOCK_PATH = ROOT / "dados-br" / "estado-editorial-continentais.json"
# Somente arquivos que governam a decisão/geração/validação editorial entram no
# fingerprint. JSONs esportivos e outros artefatos mudam o tempo todo e NÃO
# podem destravar um erro determinístico por acidente.
CONTINENTAL_EDITORIAL_GUARD_FILES = (
    ".github/workflows/publicar-analise-continentais.yml",
    "scripts/gerar_analise_continental.py",
    "scripts/atualizar_competicoes_af_previsao.py",
    "scripts/validar_artefatos_analises.py",
    "scripts/orquestrar_workflows.py",
    "scripts/editorial_ia.py",
    "scripts/buscar_melhores_momentos_continentais.py",
    "cloudflare/orchestrator-worker/src/logic.js",
    "cloudflare/orchestrator-worker/src/orchestrator-state.js",
    "cloudflare/orchestrator-worker/src/sources.js",
)

WORKFLOW_MAIN = "Atualizar Brasileirao (ESPN)"
WORKFLOW_MM = "Buscar melhores momentos oficiais"
WORKFLOW_PUBLICOS = "Atualizar públicos do Brasileirão"
WORKFLOW_TRANSMISSOES = "Buscar transmissões dos clubes do Brasileirão"
WORKFLOW_GUARDIAN = "Guardião IA de transmissões"
WORKFLOW_EDITORIAL_RODADA = "Publicar análise editorial da rodada"
WORKFLOW_EDITORIAL_COPA = "Publicar análise editorial da Copa do Brasil"
WORKFLOW_EDITORIAL_CONTINENTAIS = "Publicar análise editorial continental"

REPO_WRITERS = {
    "Atualizar Brasileirao (ESPN)",
    "Atualizar Elencos Brasileirao (ESPN)",
    "Auditar modelos AF-Previsão",
    "Auditoria IA diária",
    "Buscar melhores momentos oficiais",
    "Atualizar públicos do Brasileirão",
    "Buscar transmissões dos clubes do Brasileirão",
    "Guardião IA de transmissões",
    "Publicar análise editorial da Copa do Brasil",
    "Publicar análise editorial continental",
    "Publicar análise editorial da rodada",
    "Revisar melhores momentos Brasileirão oficiais",
    # Faziam 'git push' sem estar registrados aqui: o orquestrador não os
    # enxergava e podia despachar um escritor concorrente, gerando falha de
    # push (non-fast-forward) e, por consequência, mais retentativas.
    "Apurar Apostas Brasileirão",
    "Deploy site (GitHub Pages)",
}

CUP_ARTICLES = {
    600: "copa-do-brasil-2026-classificados-quartas",
    700: "copa-do-brasil-2026-classificados-semifinal",
    800: "copa-do-brasil-2026-finalistas",
    900: "copa-do-brasil-2026-campeao",
}

DEFAULT_CONFIG: dict[str, Any] = {
    "timezone": "America/Sao_Paulo",
    "backoff_falhas": {
        "ativo": True,
        "falhas_para_pausar": 3,
        "espera_minutos": [15, 60, 240, 720],
        "teto_minutos": 1440,
    },
    "atualizar_brasileirao": {
        "sondagem_antes_minutos": 45,
        "sondagem_depois_minutos": 240,
        "retentativa_final_pendente_minutos": 15,
        "fallback_final_estimado_minutos": 130,
        "manutencao_diaria_apos": "05:10",
    },
    "publicos": {
        "primeira_tentativa_apos_final_minutos": 30,
        "intervalos_retentativa": [
            {"ate_horas": 2, "minutos": 30},
            {"ate_horas": 6, "minutos": 60},
            {"ate_horas": 12, "minutos": 90},
            {"ate_horas": 24, "minutos": 120},
            {"ate_horas": 48, "minutos": 180},
            {"ate_horas": 72, "minutos": 360},
            {"ate_horas": 168, "minutos": 720},
            {"ate_horas": 99999, "minutos": 720},
        ],
    },
    "melhores_momentos": {
        "primeira_tentativa_apos_final_minutos": 20,
        "intervalos_retentativa": [
            {"ate_horas": 0.75, "minutos": 25},
            {"ate_horas": 1.5, "minutos": 45},
            {"ate_horas": 3, "minutos": 90},
            {"ate_horas": 6, "minutos": 180},
            {"ate_horas": 12, "minutos": 360},
            {"ate_horas": 24, "minutos": 720},
            {"ate_horas": 99999, "minutos": 1440},
        ],
        "ignorar_rodada_zero": True,
    },
    "transmissoes": {
        "tv_diaria_apos": "06:30",
        "tv_intervalo_saudavel_horas": 168,
        "tv_intervalo_pendencia_horas": 24,
        "tv_intervalo_pendencia_30d_horas": 72,
        "tv_retentativa_critica_horas": 6,
        "aovivo_antes_minutos": 90,
        "aovivo_depois_minutos": 180,
        "aovivo_checkpoints_minutos": [-90, -15, 10],
        "guardiao_checkpoints_minutos": [-90, -15, 10],
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
    checkpoint: str = ""
    details: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "acao": self.action,
            "motivo": self.reason,
            "event_id": self.event_id,
            "rodada": self.round_number,
            "modo": self.mode,
            "checkpoint": self.checkpoint,
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


# Mapeia a ação decidida -> nome do workflow que ela dispara. Usado pelo
# circuit breaker: se o workflow-alvo vem falhando em série, não adianta
# despachar de novo a cada 10 minutos.
ACAO_PARA_WORKFLOW: dict[str, str] = {
    "atualizar_brasileirao": WORKFLOW_MAIN,
    "publicos": WORKFLOW_PUBLICOS,
    "melhores_momentos": WORKFLOW_MM,
    "transmissao_aovivo": WORKFLOW_TRANSMISSOES,
    "transmissoes_guardian": WORKFLOW_GUARDIAN,
    "transmissoes_tv": WORKFLOW_TRANSMISSOES,
    "editorial_rodada": WORKFLOW_EDITORIAL_RODADA,
    "editorial_copa_do_brasil": WORKFLOW_EDITORIAL_COPA,
    "editorial_continentais": WORKFLOW_EDITORIAL_CONTINENTAIS,
}


def falhas_consecutivas(runs: Sequence[Mapping[str, Any]], workflow_name: str, tz: ZoneInfo) -> tuple[int, datetime | None]:
    """Quantas execuções concluídas mais recentes do workflow terminaram em falha.

    Retorna (contagem, horário da falha mais recente). Para na primeira execução
    bem-sucedida. Execuções ainda em andamento são ignoradas.
    """
    concluidas: list[tuple[datetime, Mapping[str, Any]]] = []
    for run in runs:
        if str(run.get("name") or "") != workflow_name:
            continue
        if str(run.get("status") or "") != "completed":
            continue
        when = run_time(run, tz)
        if when:
            concluidas.append((when, run))
    concluidas.sort(key=lambda item: item[0], reverse=True)

    total = 0
    ultima: datetime | None = None
    for when, run in concluidas:
        if str(run.get("conclusion") or "") == "success":
            break
        # 'cancelled' e 'skipped' não contam como falha real do código.
        if str(run.get("conclusion") or "") not in {"failure", "timed_out", "startup_failure"}:
            break
        total += 1
        if ultima is None:
            ultima = when
    return total, ultima


def backoff_por_falha(
    decision: "Decision",
    *,
    config: Mapping[str, Any],
    runs: Sequence[Mapping[str, Any]],
    now: datetime,
    tz: ZoneInfo,
) -> "Decision":
    """Circuit breaker: segura o despacho de um workflow que está falhando em série.

    Sem isto, um erro determinístico (ex.: assert quebrado no self-test) faz o
    orquestrador redespachar o mesmo workflow a cada ciclo do cron externo,
    indefinidamente. Foi exatamente o que gerou ~1.370 execuções falhadas de
    'Publicar análise editorial da rodada'.
    """
    alvo = ACAO_PARA_WORKFLOW.get(decision.action)
    if not alvo:
        return decision

    # Editorial continental é uma publicação determinística e não pode entrar
    # em retry automático infinito. O estado persistente é gravado pelo próprio
    # workflow na primeira falha. Ele só fica obsoleto quando o CÓDIGO que
    # governa o editorial muda; commits rotineiros de dados não o destravam.
    if decision.action == "editorial_continentais":
        locked, state = editorial_continental_lock_active()
        if locked:
            run_url = str(state.get("run_url") or "").strip()
            suffix = f" Run com erro: {run_url}" if run_url else ""
            return Decision(
                "none",
                (
                    "Circuit breaker persistente: 'Publicar análise editorial continental' "
                    "está pausado após a última falha. Atualizações esportivas/JSONs não "
                    "reativam o workflow; é necessária correção no código de governança "
                    f"editorial.{suffix}"
                ),
            )

        # Fallback de segurança entre o instante da falha e o commit do arquivo
        # de lock. Evita redespacho imediato mesmo se a persistência falhar.
        current_sha = str(os.environ.get("GITHUB_SHA") or "").strip()
        _last_when, last = last_run(runs, alvo, tz)
        if last and str(last.get("status") or "") == "completed":
            conclusion = str(last.get("conclusion") or "")
            failed = conclusion in {"failure", "timed_out", "startup_failure"}
            failed_sha = str(last.get("head_sha") or "").strip()
            same_revision = bool(current_sha and failed_sha and current_sha == failed_sha)
            if failed and same_revision:
                return Decision(
                    "none",
                    (
                        "Circuit breaker travado: 'Publicar análise editorial continental' falhou "
                        "neste mesmo commit. Novas tentativas automáticas estão suspensas enquanto "
                        "o lock persistente é registrado ou até o código editorial ser corrigido."
                    ),
                )

    cfg = config.get("backoff_falhas") or {}
    if not bool(cfg.get("ativo", True)):
        return decision
    limite = int(cfg.get("falhas_para_pausar", 3))
    escala = [int(v) for v in (cfg.get("espera_minutos") or [15, 60, 240, 720])]
    teto = int(cfg.get("teto_minutos", 1440))

    total, ultima = falhas_consecutivas(runs, alvo, tz)
    if total < limite or ultima is None:
        return decision

    indice = min(total - limite, len(escala) - 1)
    espera = min(escala[indice], teto)
    liberado_em = ultima + timedelta(minutes=espera)
    if now >= liberado_em:
        return decision

    restante = int((liberado_em - now).total_seconds() // 60)
    return Decision(
        "none",
        (
            f"Backoff: '{alvo}' falhou {total}x seguidas; próxima tentativa em ~{restante} min. "
            f"Corrija a causa ou rode o workflow manualmente para resetar."
        ),
    )


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

    # O início de uma partida não justifica mais o pipeline pesado. Alterações
    # factuais de calendário entram pela manutenção/sonda; AO VIVO segue direto
    # da ESPN no navegador a cada 30 s.

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


def _money_number(value: Any) -> float | None:
    try:
        if value is None or isinstance(value, bool):
            return None
        if isinstance(value, (int, float)):
            n = float(value)
        else:
            text = str(value).strip().replace("R$", "").replace(" ", "")
            if not text:
                return None
            if "," in text:
                text = text.replace(".", "").replace(",", ".")
            n = float(text)
        return n if n > 0 else None
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
        detail_renda = _money_number((detail or {}).get("renda")) if isinstance(detail, Mapping) else None
        comp_renda = _money_number((complement or {}).get("renda")) if isinstance(complement, Mapping) else None
        faltando = []
        if detail_public is None and comp_public is None:
            faltando.append("publico")
        if detail_renda is None and comp_renda is None:
            faltando.append("renda")
        if not faltando:
            continue
        ended = result_final_time(row, tz)
        if ended is None or now < ended + timedelta(minutes=min_age):
            continue
        row["faltando_publicos"] = faltando
        pending.append((row, ended))
    pending.sort(key=lambda item: item[1], reverse=True)
    return pending


def public_state_due_info(
    event_id: str,
    campos_faltando: Sequence[str],
    now: datetime,
    tz: ZoneInfo,
) -> tuple[bool, datetime | None, bool]:
    """Alinha o orquestrador ao backoff por campo persistido pela camada IA.

    Retorna (tem_campo_vencido, proximo_horario_futuro, possui_estado).
    Uma política antiga é considerada vencida imediatamente para permitir a
    migração da busca restrita para a busca web ampla.
    """
    estado = load_json(PUBLIC_AI_STATE_PATH, {})
    try:
        policy = int(estado.get("search_policy_version") or 0) if isinstance(estado, Mapping) else 0
    except (TypeError, ValueError):
        policy = 0
    if policy < 3:
        return True, None, False
    jogos = estado.get("jogos") if isinstance(estado, Mapping) else {}
    row = jogos.get(event_id) if isinstance(jogos, Mapping) else None
    if not isinstance(row, Mapping):
        return True, None, False
    campos = row.get("campos") if isinstance(row.get("campos"), Mapping) else {}
    futuros: list[datetime] = []
    for campo in campos_faltando:
        st = campos.get(str(campo)) if isinstance(campos, Mapping) else None
        if not isinstance(st, Mapping):
            return True, None, True
        if st.get("status") == "resolved":
            # Artefatos discordantes: rode para reconciliar em vez de silenciar.
            return True, None, True
        next_at = parse_dt(st.get("proxima_tentativa"), tz)
        if next_at is None or now >= next_at:
            return True, next_at, True
        futuros.append(next_at)
    return False, min(futuros) if futuros else None, True


def public_decision(config: Mapping[str, Any], now: datetime, tz: ZoneInfo, runs: Sequence[Mapping[str, Any]]) -> Decision | None:
    del runs  # o relógio correto é o estado por campo, não a idade do último workflow.
    pending = pending_publics(config, now, tz)
    if not pending:
        return None

    vencidos: list[tuple[dict[str, Any], datetime, bool]] = []
    for row, ended in pending:
        event_id = str(row.get("event_id") or row.get("id") or "").strip()
        faltando = [str(x) for x in (row.get("faltando_publicos") or [])]
        due, next_at, tem_estado = public_state_due_info(event_id, faltando, now, tz)
        if due:
            vencidos.append((row, ended, tem_estado))

    if not vencidos:
        return None

    row, ended, tem_estado = min(vencidos, key=lambda item: item[1])
    event_id = str(row.get("event_id") or row.get("id") or "").strip()
    label = f"{team_name(row.get('mandante'))} x {team_name(row.get('visitante'))}".strip(" x")
    faltando = ",".join(row.get("faltando_publicos") or [])
    if tem_estado:
        motivo = (
            f"Retentativa de público/renda vencida: {label or event_id} segue com lacuna "
            f"({faltando}); relógio por campo liberou nova pesquisa."
        )
    else:
        motivo = (
            f"Primeira busca de público/renda: {label or event_id} terminou há "
            f"{int(minutes_since(ended, now))} min e segue com lacuna ({faltando})."
        )
    return Decision("publicos", motivo, event_id=event_id, mode="incremental")


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
        return False, "grade ausente; primeiro resolver TV pelo coletor determinístico"
    channels = {str(value).strip().casefold() for value in (item.get("canais") or []) if value}
    if channels & {"ge tv", "sbt", "cazétv", "cazetv"}:
        return True, "grade exige player oficial GE TV/SBT/CazéTV"
    return False, "grade não exige player oficial GE TV/SBT/CazéTV"


def transmission_live_decision(
    config: Mapping[str, Any],
    now: datetime,
    games: Sequence[Game],
    final_ids: set[str],
    tz: ZoneInfo,
    runs: Sequence[Mapping[str, Any]],
    *,
    only_never_checked: bool = False,
) -> Decision | None:
    cfg = config["transmissoes"]
    checkpoints = [int(v) for v in (cfg.get("aovivo_checkpoints_minutos") or [-90, -15, 10])]
    checkpoints = sorted(set(checkpoints))
    if not checkpoints:
        return None
    before = abs(min(checkpoints))
    after = max(checkpoints)
    linked = live_entries(LIVE_PATH) | live_entries(LIVE_MANUAL_PATH)
    candidates: list[tuple[Game, str, int]] = []
    for game in games:
        if game.event_id in final_ids:
            continue
        delta = (now - game.kickoff).total_seconds() / 60.0
        if delta < min(checkpoints) or delta > max(checkpoints):
            continue
        allowed, reason = live_search_allowed(game.event_id)
        if not allowed:
            continue
        resolved, missing = transmission_guardian_resolution(game.event_id)
        # Busca de player só existe se a grade o exige e ele ainda está ausente.
        if "player_integral_ausente" not in missing:
            continue
        last, _ = last_run(runs, WORKFLOW_TRANSMISSOES, tz, title_contains=f"aovivo · {game.event_id}")
        if only_never_checked and last is not None:
            continue
        last_delta = ((last - game.kickoff).total_seconds() / 60.0) if last is not None else None
        due = [cp for cp in checkpoints if cp <= delta and (last_delta is None or cp > last_delta)]
        if not due:
            continue
        candidates.append((game, reason, max(due)))
    if not candidates:
        return None
    candidates.sort(key=lambda item: abs((item[0].kickoff - now).total_seconds()))
    game, policy, checkpoint = candidates[0]
    label = f"T{checkpoint:+d}"
    return Decision(
        "transmissao_aovivo",
        f"Checkpoint {label} do player oficial para {game.label}; {policy}.",
        event_id=game.event_id,
        mode="aovivo",
        checkpoint=str(checkpoint),
    )


def _channel_key(value: Any) -> str:
    return str(value or "").strip().casefold()


def _strong_tv_confidence(value: Any) -> bool:
    return _channel_key(value) in {"confirmado", "confirmada", "alta", "high", "verified", "verificado"}


def _published_player_valid(row: Any) -> bool:
    if not isinstance(row, Mapping):
        return False
    candidates = [row.get("principal"), *((row.get("alternativas") or []) if isinstance(row.get("alternativas"), list) else [])]
    for item in candidates:
        if not isinstance(item, Mapping):
            continue
        url = str(item.get("url") or "").strip()
        title = str(item.get("titulo") or "").casefold()
        scope = str(item.get("escopo") or "").casefold()
        if not url.startswith(("http://", "https://")):
            continue
        if any(token in title for token in ("aquecimento", "pré-jogo", "pre-game", "melhores momentos")):
            continue
        if str(item.get("status") or "").casefold() in {"live", "upcoming"} or scope in {"partida", "match"}:
            return True
    return False


def transmission_guardian_resolution(event_id: str) -> tuple[bool, tuple[str, ...]]:
    """Retorna resolvido + lacunas; checkpoint sozinho nunca autoriza o Guardião."""
    tv = load_json(TV_PATH, {})
    guardian = load_json(GUARDIAN_PATH, {})
    live_auto = load_json(LIVE_PATH, {})
    live_manual = load_json(LIVE_MANUAL_PATH, {})
    tv_row = ((tv.get("jogos") or {}).get(event_id) if isinstance(tv, Mapping) else None) or {}
    guard_row = ((guardian.get("jogos") or {}).get(event_id) if isinstance(guardian, Mapping) else None) or {}
    live_row = ((live_manual.get("jogos") or {}).get(event_id) if isinstance(live_manual, Mapping) else None) or ((live_auto.get("jogos") or {}).get(event_id) if isinstance(live_auto, Mapping) else None) or {}

    missing: list[str] = []
    channels = sorted({_channel_key(value) for value in (tv_row.get("canais") or []) if str(value or "").strip()}) if isinstance(tv_row, Mapping) else []
    if not channels:
        missing.append("tv_ausente")

    try:
        guard_confidence = float(guard_row.get("confianca") or 0) if isinstance(guard_row, Mapping) else 0.0
    except (TypeError, ValueError):
        guard_confidence = 0.0
    guardian_strong = isinstance(guard_row, Mapping) and str(guard_row.get("status") or "").casefold() in {"confirmado", "corrigido"} and guard_confidence >= 0.9
    tv_strong = isinstance(tv_row, Mapping) and tv_row.get("estavel") is True and _strong_tv_confidence(tv_row.get("confianca"))
    if channels and not tv_strong and not guardian_strong:
        missing.append("fonte_fraca_ou_instavel")

    if guardian_strong and isinstance(guard_row.get("canais"), list) and guard_row.get("canais"):
        guardian_channels = sorted({_channel_key(value) for value in guard_row.get("canais") or [] if str(value or "").strip()})
        if channels and guardian_channels and channels != guardian_channels:
            missing.append("conflito_fontes")

    player_required = any(name in set(channels) for name in {"ge tv", "cazétv", "cazetv", "sbt"})
    guard_youtube = guard_row.get("youtube") if isinstance(guard_row, Mapping) else []
    guard_player = any(
        isinstance(item, Mapping) and item.get("valid_for_match") is True and str(item.get("url") or "").startswith(("http://", "https://"))
        for item in (guard_youtube or [])
    )
    if player_required and not (guard_player or _published_player_valid(live_row)):
        missing.append("player_integral_ausente")
    return not missing, tuple(sorted(set(missing)))


def transmission_guardian_decision(
    config: Mapping[str, Any],
    now: datetime,
    games: Sequence[Game],
    final_ids: set[str],
    tz: ZoneInfo,
    runs: Sequence[Mapping[str, Any]],
) -> Decision | None:
    cfg = config["transmissoes"]
    checkpoints = sorted(set(int(v) for v in (cfg.get("guardiao_checkpoints_minutos") or [-90, -15, 10])))
    if not checkpoints:
        return None
    candidates: list[tuple[Game, int, float]] = []
    for game in games:
        if game.event_id in final_ids:
            continue
        resolved, _guardian_missing = transmission_guardian_resolution(game.event_id)
        if resolved:
            continue
        delta = (now - game.kickoff).total_seconds() / 60.0
        if delta < min(checkpoints) or delta > max(checkpoints):
            continue
        last, _ = last_run(runs, WORKFLOW_GUARDIAN, tz, title_contains=game.event_id)
        last_delta = ((last - game.kickoff).total_seconds() / 60.0) if last is not None else None
        due = [cp for cp in checkpoints if cp <= delta and (last_delta is None or cp > last_delta)]
        if due:
            candidates.append((game, max(due), delta))
    if not candidates:
        return None
    candidates.sort(key=lambda item: abs(item[2]))
    game, checkpoint, _ = candidates[0]
    _resolved, guardian_missing = transmission_guardian_resolution(game.event_id)
    pendencias = ",".join(guardian_missing) or "reconciliar"
    return Decision(
        "transmissoes_guardian",
        f"Guardião de transmissão T{checkpoint:+d} para {game.label}; pendência real: {pendencias}.",
        event_id=game.event_id,
        mode="guardian",
        checkpoint=str(checkpoint),
    )


def tv_decision(
    config: Mapping[str, Any],
    now: datetime,
    tz: ZoneInfo,
    runs: Sequence[Mapping[str, Any]],
    audit_summary: Mapping[str, Any] | None = None,
) -> Decision | None:
    """Fallback manual NEED-DRIVEN para grade TV.

    A política canônica é a mesma do Cloudflare: jogos a mais de 72h não são
    pendência operacional. O fallback nunca faz manutenção preventiva de 14/30
    dias; só reage quando a auditoria comprova lacuna dentro de 72h.
    """
    cfg = config["transmissoes"]
    last, _ = last_run(runs, WORKFLOW_TRANSMISSOES, tz, title_contains="· tv")

    if audit_summary is None:
        audit = load_json(TV_AUDIT_PATH, {})
        summary_raw = audit.get("resumo") if isinstance(audit, Mapping) else {}
        summary = summary_raw if isinstance(summary_raw, Mapping) else {}
    else:
        summary = audit_summary

    try:
        critical = max(0, int(summary.get("jogos_criticos_sem_transmissao_72h") or 0))
    except (TypeError, ValueError):
        critical = 0
    if critical <= 0:
        return None

    age_minutes = minutes_since(last, now)
    critical_hours = float(cfg.get("tv_retentativa_critica_horas") or 6)
    if last is None or age_minutes >= critical_hours * 60:
        return Decision(
            "transmissoes_tv",
            f"Há {critical} jogo(s) dentro de 72h sem grade confirmada; fallback manual need-driven.",
            mode="tv",
        )
    return None


def round_editorial_decision(now: datetime) -> Decision | None:
    try:
        from gerar_analise_rodada import carregar_json as editorial_load
        from gerar_analise_rodada import estado_rodada, montar_dossie
        # CRÍTICO: o hash tem de ser calculado pela MESMA função que o gerador
        # usa para gravar 'hash_dossie' no manifesto. hash_dossie_publicavel()
        # exclui snapshot_antes_hash, snapshot_depois_hash e marco_af_id.
        # Calcular aqui um sha256 do dossiê inteiro produzia um valor que jamais
        # coincidia com o publicado, fazendo o orquestrador concluir "não
        # publicado" em todo ciclo e redespachar o editorial indefinidamente.
        from gerar_analise_rodada import hash_dossie_publicavel
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
        digest = hash_dossie_publicavel(dossier)
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


def editorial_continental_guard_fingerprint() -> str:
    """Identidade do código que governa o editorial continental.

    O fingerprint deliberadamente ignora snapshots/JSONs esportivos. Assim,
    commits automáticos de placar, tabela ou probabilidades não rearmam um
    workflow que falhou por defeito de código/contrato editorial.
    """
    digest = hashlib.sha256()
    for relative in CONTINENTAL_EDITORIAL_GUARD_FILES:
        path = ROOT / relative
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        try:
            digest.update(path.read_bytes())
        except OSError:
            digest.update(b"<missing>")
        digest.update(b"\0")
    return digest.hexdigest()


def editorial_continental_lock_active() -> tuple[bool, Mapping[str, Any]]:
    """Retorna se o circuit breaker persistente ainda vale para este código."""
    state = load_json(CONTINENTAL_EDITORIAL_LOCK_PATH, {})
    if not isinstance(state, Mapping) or not bool(state.get("bloqueado")):
        return False, state if isinstance(state, Mapping) else {}
    stored = str(state.get("guard_fingerprint") or "").strip()
    if not stored:
        # Estado antigo/corrompido: falha fechada para não voltar ao loop.
        return True, state
    return stored == editorial_continental_guard_fingerprint(), state


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



def continental_editorial_decision() -> Decision | None:
    try:
        from gerar_analise_continental import (
            SNAPS, MM_PATH, CONT_HISTORY_PATH, editorial_eligibility,
            build_ties, build_article, load as continental_load, current_stats_marks, stats_dossier
        )
        snapshots = {key: continental_load(path, {}) for key, path in SNAPS.items()}
        history = continental_load(CONT_HISTORY_PATH, {"marcos": []}) or {"marcos": []}
        eligibility = editorial_eligibility(snapshots, history)
        action = str(eligibility.get("action") or "none")
        rank = int(eligibility.get("rank") or 0)
        if action == "none" or not rank:
            return None
        if action == "baseline":
            return Decision(
                "editorial_continentais",
                f"{eligibility.get('reason') or 'Preservar fotografia estatística anterior às voltas.'}",
            )
        ties = [tie for comp, snap in snapshots.items() for tie in build_ties(comp, snap, rank)]
        if not ties:
            return None
        highlights = continental_load(MM_PATH, {"jogos": {}}) or {"jogos": {}}
        before, after, _ = current_stats_marks(rank, ties, history, snapshots)
        stats = stats_dossier(before, after) if before and after else {}
        expected = build_article(rank, ties, highlights, datetime.now(ZoneInfo("America/Sao_Paulo")).replace(microsecond=0), stats)
    except Exception:
        return None
    manifest = load_json(ANALYSES_PATH, {})
    article = next((item for item in (manifest.get("artigos") or []) if isinstance(item, Mapping) and item.get("id_editorial") == expected.get("id_editorial")), None)
    if article is None:
        return Decision("editorial_continentais", f"Fase continental {expected.get('fase_encerrada')} encerrada no recorte brasileiro e editorial ainda não existe.")
    if (
        str(article.get("hash_dossie") or "") != str(expected.get("hash_dossie") or "")
        or str(article.get("hash_melhores_momentos") or "") != str(expected.get("hash_melhores_momentos") or "")
        or str(article.get("hash_estatisticas") or "") != str(expected.get("hash_estatisticas") or "")
    ):
        return Decision("editorial_continentais", "Editorial continental publicado está desatualizado em relação aos confrontos, melhores momentos ou quadro estatístico.")
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

    # 0. Primeira tentativa do player é perecível e precisa de UMA chance
    # garantida. Depois dessa primeira busca, retentativas voltam para a
    # prioridade normal abaixo do pipeline esportivo, evitando starvation.
    live_first = transmission_live_decision(
        config, now, games, final_ids, tz, runs, only_never_checked=True
    )
    if live_first:
        return live_first

    guardian = transmission_guardian_decision(config, now, games, final_ids, tz, runs)
    if guardian:
        return guardian

    # 1. Dado esportivo sempre vence nas retentativas subsequentes.
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
    continental = continental_editorial_decision()
    if continental:
        return continental
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
        "checkpoint": decision.checkpoint,
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
    assert mm_retry_interval(0.5, config) == 25
    assert mm_retry_interval(1.0, config) == 45
    assert mm_retry_interval(3.0, config) == 90

    # --- Circuit breaker por falha repetida ---------------------------------
    def _run(conclusion: str, minutos_atras: int) -> dict[str, Any]:
        return {
            "name": WORKFLOW_EDITORIAL_RODADA,
            "status": "completed",
            "conclusion": conclusion,
            "created_at": (now - timedelta(minutes=minutos_atras)).astimezone(timezone.utc).isoformat(),
        }

    alvo = Decision("editorial_rodada", "teste", round_number="20")
    # Duas falhas: ainda abaixo do limite, despacha normalmente.
    runs_2 = [_run("failure", 5), _run("failure", 15)]
    assert backoff_por_falha(alvo, config=config, runs=runs_2, now=now, tz=tz).action == "editorial_rodada"
    assert falhas_consecutivas(runs_2, WORKFLOW_EDITORIAL_RODADA, tz)[0] == 2
    # Três falhas recentes: segura por 15 min.
    runs_3 = [_run("failure", 5), _run("failure", 15), _run("failure", 25)]
    travado = backoff_por_falha(alvo, config=config, runs=runs_3, now=now, tz=tz)
    assert travado.action == "none" and "Backoff" in travado.reason
    # Passada a espera, libera uma nova tentativa.
    runs_3_antigo = [_run("failure", 40), _run("failure", 50), _run("failure", 60)]
    assert backoff_por_falha(alvo, config=config, runs=runs_3_antigo, now=now, tz=tz).action == "editorial_rodada"
    # Um sucesso zera a contagem, mesmo com falhas mais antigas.
    runs_ok = [_run("success", 2), _run("failure", 5), _run("failure", 15), _run("failure", 25)]
    assert falhas_consecutivas(runs_ok, WORKFLOW_EDITORIAL_RODADA, tz)[0] == 0
    assert backoff_por_falha(alvo, config=config, runs=runs_ok, now=now, tz=tz).action == "editorial_rodada"
    # 'cancelled' não conta como falha de código.
    runs_cancel = [_run("cancelled", 5), _run("failure", 15), _run("failure", 25)]
    assert falhas_consecutivas(runs_cancel, WORKFLOW_EDITORIAL_RODADA, tz)[0] == 0
    # Escalonamento: 5 falhas -> espera de 240 min.
    runs_5 = [_run("failure", m) for m in (5, 15, 25, 35, 45)]
    assert backoff_por_falha(alvo, config=config, runs=runs_5, now=now, tz=tz).action == "none"
    # Ação 'none' nunca é afetada pelo breaker.
    assert backoff_por_falha(Decision("none", "x"), config=config, runs=runs_5, now=now, tz=tz).action == "none"
    assert mm_retry_interval(5.0, config) == 180
    assert mm_retry_interval(10.0, config) == 360
    assert mm_retry_interval(20.0, config) == 720
    assert mm_retry_interval(100.0, config) == 1440

    # Editorial continental: uma única falha trava novas tentativas. O lock
    # persistente continua ativo mesmo se main receber commits rotineiros de
    # dados; somente mudança no código governante altera o fingerprint.
    old_sha = os.environ.get("GITHUB_SHA")
    original_lock_path = globals()["CONTINENTAL_EDITORIAL_LOCK_PATH"]
    try:
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            fake_lock = Path(tmpdir) / "estado-editorial-continentais.json"
            globals()["CONTINENTAL_EDITORIAL_LOCK_PATH"] = fake_lock
            os.environ["GITHUB_SHA"] = "abc123"
            continental_target = Decision("editorial_continentais", "teste")
            failed_same_sha = [{
                "name": WORKFLOW_EDITORIAL_CONTINENTAIS,
                "status": "completed",
                "conclusion": "failure",
                "head_sha": "abc123",
                "created_at": (now - timedelta(minutes=2)).astimezone(timezone.utc).isoformat(),
            }]
            latched = backoff_por_falha(continental_target, config=config, runs=failed_same_sha, now=now, tz=tz)
            assert latched.action == "none" and "Circuit breaker travado" in latched.reason

            # Um run antigo em outro SHA não basta para travar se ainda não há
            # lock persistido.
            failed_old_sha = [dict(failed_same_sha[0], head_sha="old456")]
            assert backoff_por_falha(continental_target, config=config, runs=failed_old_sha, now=now, tz=tz).action == "editorial_continentais"

            current_fp = editorial_continental_guard_fingerprint()
            fake_lock.write_text(json.dumps({
                "schema_version": 1,
                "bloqueado": True,
                "guard_fingerprint": current_fp,
                "run_url": "https://example.invalid/run/1",
            }), encoding="utf-8")
            locked, _ = editorial_continental_lock_active()
            assert locked
            persistent = backoff_por_falha(continental_target, config=config, runs=[], now=now, tz=tz)
            assert persistent.action == "none" and "Circuit breaker persistente" in persistent.reason

            # Uma correção real em arquivo de governança produz fingerprint
            # diferente; o lock antigo deixa de valer. Commits de JSONs não
            # entram no fingerprint e, portanto, não têm esse efeito.
            fake_lock.write_text(json.dumps({
                "schema_version": 1,
                "bloqueado": True,
                "guard_fingerprint": "0" * 64,
            }), encoding="utf-8")
            locked, _ = editorial_continental_lock_active()
            assert not locked
            assert backoff_por_falha(continental_target, config=config, runs=[], now=now, tz=tz).action == "editorial_continentais"
    finally:
        globals()["CONTINENTAL_EDITORIAL_LOCK_PATH"] = original_lock_path
        if old_sha is None:
            os.environ.pop("GITHUB_SHA", None)
        else:
            os.environ["GITHUB_SHA"] = old_sha

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

        # A primeira busca de player exato não pode ser sufocada pelo pipeline
        # principal. Depois de um run aovivo para o evento, a prioridade volta
        # ao dado esportivo até vencer o backoff normal de transmissão.
        live_game = Game("live-1", "brasileirao", "bra.1", now + timedelta(minutes=20), "Mirassol", "Flamengo")
        original_live_allowed = globals()["live_search_allowed"]
        original_live_entries = globals()["live_entries"]
        original_guardian_resolution = globals()["transmission_guardian_resolution"]
        try:
            globals()["live_search_allowed"] = lambda event_id: (True, "grade exige CazéTV")
            globals()["live_entries"] = lambda path: set()
            globals()["transmission_guardian_resolution"] = lambda event_id: (False, ("player_integral_ausente",))
            first = transmission_live_decision(config, now, [live_game], set(), tz, [], only_never_checked=True)
            assert first and first.action == "transmissao_aovivo" and first.event_id == "live-1"
            prior_live_run = [{
                "name": WORKFLOW_TRANSMISSOES, "status": "completed", "conclusion": "success",
                "created_at": now.astimezone(timezone.utc).isoformat(),
                "display_title": "Transmissões · aovivo · live-1",
            }]
            assert transmission_live_decision(config, now, [live_game], set(), tz, prior_live_run, only_never_checked=True) is None
        finally:
            globals()["live_search_allowed"] = original_live_allowed
            globals()["live_entries"] = original_live_entries
            globals()["transmission_guardian_resolution"] = original_guardian_resolution

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

    # Política de transmissão: SBT precisa disparar a busca do player exato,
    # assim como GE TV/CazéTV; uma grade estável exclusiva sem esses alvos bloqueia.
    original_tv_path = globals()["TV_PATH"]
    import tempfile
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            fake_tv = Path(tmpdir) / "transmissoes-tv.json"
            globals()["TV_PATH"] = fake_tv
            fake_tv.write_text(json.dumps({"jogos": {"sbt-1": {"canais": ["SBT", "Disney+ / ESPN"], "estavel": True}}}), encoding="utf-8")
            allowed, reason = live_search_allowed("sbt-1")
            assert allowed and "SBT" in reason
            fake_tv.write_text(json.dumps({"jogos": {"pay-1": {"canais": ["Disney+ / ESPN"], "estavel": True, "exclusivo": True}}}), encoding="utf-8")
            allowed, _ = live_search_allowed("pay-1")
            assert not allowed
    finally:
        globals()["TV_PATH"] = original_tv_path

    # O Guardião só pode rodar por pendência factual; checkpoint vencido com
    # TV estável/resolvida precisa morrer no orquestrador.
    original_paths = {name: globals()[name] for name in ("TV_PATH", "GUARDIAN_PATH", "LIVE_PATH", "LIVE_MANUAL_PATH")}
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            root_tmp = Path(tmpdir)
            paths = {
                "TV_PATH": root_tmp / "tv.json",
                "GUARDIAN_PATH": root_tmp / "guardian.json",
                "LIVE_PATH": root_tmp / "live.json",
                "LIVE_MANUAL_PATH": root_tmp / "live-manual.json",
            }
            for name, path in paths.items():
                globals()[name] = path
            paths["GUARDIAN_PATH"].write_text('{"jogos":{}}', encoding="utf-8")
            paths["LIVE_PATH"].write_text('{"jogos":{}}', encoding="utf-8")
            paths["LIVE_MANUAL_PATH"].write_text('{"jogos":{}}', encoding="utf-8")

            paths["TV_PATH"].write_text(json.dumps({"jogos": {"premiere": {"canais": ["Premiere"], "estavel": True, "confianca": "confirmado"}}}), encoding="utf-8")
            resolved, missing = transmission_guardian_resolution("premiere")
            assert resolved and not missing

            paths["TV_PATH"].write_text(json.dumps({"jogos": {"getv": {"canais": ["GE TV"], "estavel": True, "confianca": "alta"}}}), encoding="utf-8")
            paths["LIVE_PATH"].write_text(json.dumps({"jogos": {"getv": {"principal": {"url": "https://youtube.com/watch?v=ok", "status": "live", "titulo": "A x B AO VIVO", "escopo": "partida"}}}}), encoding="utf-8")
            resolved, missing = transmission_guardian_resolution("getv")
            assert resolved and not missing

            paths["TV_PATH"].write_text('{"jogos":{}}', encoding="utf-8")
            resolved, missing = transmission_guardian_resolution("missing")
            assert not resolved and "tv_ausente" in missing
    finally:
        for name, path in original_paths.items():
            globals()[name] = path

    # TV futura no fallback segue a mesma política NEED-DRIVEN do Cloudflare:
    # somente lacuna dentro de 72h pode abrir workflow. Pendências mais distantes
    # permanecem como "a confirmar" sem manutenção preventiva.
    tx_cfg = deep_merge(DEFAULT_CONFIG, {"transmissoes": {"tv_retentativa_critica_horas": 6}})
    tx_now = datetime(2026, 8, 16, 12, 0, tzinfo=tz)
    healthy_summary = {"jogos_sem_transmissao_14d": 9, "jogos_sem_transmissao_fora_14d": 20, "jogos_criticos_sem_transmissao_72h": 0}
    recent_tv = [{
        "name": WORKFLOW_TRANSMISSOES, "status": "completed", "conclusion": "success",
        "created_at": "2026-08-15T15:00:00Z", "display_title": "Transmissões · tv · todos",
    }]
    assert tv_decision(tx_cfg, tx_now, tz, recent_tv, healthy_summary) is None
    old_tv = [{
        "name": WORKFLOW_TRANSMISSOES, "status": "completed", "conclusion": "success",
        "created_at": "2026-08-08T15:00:00Z", "display_title": "Transmissões · tv · todos",
    }]
    assert tv_decision(tx_cfg, tx_now, tz, old_tv, healthy_summary) is None
    critical_summary = {"jogos_sem_transmissao_14d": 1, "jogos_sem_transmissao_fora_14d": 0, "jogos_criticos_sem_transmissao_72h": 1}
    six_hours_tv = [{
        "name": WORKFLOW_TRANSMISSOES, "status": "completed", "conclusion": "success",
        "created_at": "2026-08-16T08:00:00Z", "display_title": "Transmissões · tv · todos",
    }]
    assert tv_decision(tx_cfg, tx_now, tz, six_hours_tv, critical_summary).action == "transmissoes_tv"


    # O orquestrador deve respeitar exatamente o próximo horário por campo da IA,
    # não um backoff aproximado baseado no último run do workflow.
    original_state_path = globals()["PUBLIC_AI_STATE_PATH"]
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            fake_state = Path(tmpdir) / "estado-publicos-ia.json"
            globals()["PUBLIC_AI_STATE_PATH"] = fake_state
            fake_state.write_text(json.dumps({
                "search_policy_version": 3,
                "jogos": {
                    "x": {
                        "campos": {
                            "publico": {
                                "status": "pending",
                                "proxima_tentativa": (tx_now + timedelta(minutes=20)).isoformat(),
                            }
                        }
                    }
                }
            }), encoding="utf-8")
            due, next_at, tem_estado = public_state_due_info("x", ["publico"], tx_now, tz)
            assert not due and tem_estado and next_at == tx_now + timedelta(minutes=20)
            due, _, _ = public_state_due_info("x", ["publico"], tx_now + timedelta(minutes=21), tz)
            assert due
    finally:
        globals()["PUBLIC_AI_STATE_PATH"] = original_state_path

    assert canonical_hash({"b": 2, "a": 1}) == canonical_hash({"a": 1, "b": 2})

    assert public_retry_interval(1.0, config) == 30
    assert public_retry_interval(5.0, config) == 60
    assert public_retry_interval(20.0, config) == 120
    assert public_retry_interval(100.0, config) == 720
    assert public_retry_interval(500.0, config) == 720

    # --- Contrato de hash entre orquestrador e gerador ----------------------
    # Este teste existe porque a divergência entre as duas formas de calcular o
    # hash do dossiê fez o orquestrador redespachar o editorial em laço, mesmo
    # com todos os runs terminando em sucesso. Se alguém voltar a calcular o
    # hash aqui de outro jeito, este teste quebra na hora.
    try:
        from gerar_analise_rodada import hash_dossie_publicavel as _hdp
    except Exception:
        _hdp = None
    if _hdp is not None:
        _d = {
            "rodada": 20,
            "jogos": [{"linha": "A 1 × 0 B"}],
            "snapshot_antes_hash": "aaa",
            "snapshot_depois_hash": "bbb",
            "marco_af_id": "ccc",
        }
        _d2 = dict(_d, snapshot_antes_hash="zzz", snapshot_depois_hash="yyy", marco_af_id="xxx")
        # Metadados de rastreabilidade não podem alterar o hash publicável.
        assert _hdp(_d) == _hdp(_d2), "hash_dossie_publicavel não pode depender de metadados AF"
        # E precisa diferir do sha256 ingênuo do dossiê inteiro — que era
        # exatamente o cálculo errado usado aqui antes.
        _ingenuo = hashlib.sha256(json.dumps(_d, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        assert _hdp(_d) != _ingenuo, "regressão: voltaram a usar o sha256 do dossiê inteiro"
        # Mudança factual real precisa mudar o hash.
        assert _hdp(dict(_d, jogos=[{"linha": "A 2 × 0 B"}])) != _hdp(_d)

    print("OK self-test: prioridade, tempo, backoff, contrato de hash, gol ao vivo sem pipeline pesado e decisão pós-FINAL.")
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
    decision = backoff_por_falha(decision, config=config, runs=runs, now=now, tz=tz)
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
