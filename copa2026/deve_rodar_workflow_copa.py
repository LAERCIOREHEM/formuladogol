#!/usr/bin/env python3
"""
Guard técnico do workflow da COPA2026.

Objetivo: deixar o workflow pesado da Copa rodar apenas em janela real de jogo:
- começa 1h antes do horário oficial em Brasília;
- fica ativo durante jogo/atraso/prorrogação/pênaltis;
- depois que a ESPN marcar como encerrado (post), roda por mais 2h;
- se a ESPN/API falhar, usa fallback limitado para não derrubar atualização em dia de jogo;
- em dias sem jogo, como 08/07/2026, marca RUN_COPA=false.

Saída para GitHub Actions: RUN_COPA=true/false em $GITHUB_ENV.
Para testes locais: use AGORA_BRT=2026-07-08T12:00:00-03:00.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
AGENDA_PATH = ROOT / "dados" / "agenda_workflow_copa.json"
ESTADO_PATH = ROOT / "dados" / "workflow_copa_estado.json"
BRT = ZoneInfo("America/Sao_Paulo")
ESPN_API = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard"


def log(msg: str) -> None:
    print(msg, flush=True)


def parse_dt(value: str) -> datetime:
    return datetime.fromisoformat(value).astimezone(BRT)


def now_brt() -> datetime:
    raw = os.environ.get("AGORA_BRT", "").strip()
    if raw:
        return parse_dt(raw)
    return datetime.now(tz=BRT)


def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def ymd_espn(dt: datetime) -> str:
    return dt.astimezone(BRT).strftime("%Y%m%d")


def fetch_espn_events(ini: datetime, fim: datetime) -> list[dict[str, Any]]:
    # Busca do dia anterior ao dia seguinte para cobrir jogos que cruzam meia-noite em Brasília.
    d0 = ymd_espn(ini - timedelta(days=1))
    d1 = ymd_espn(fim + timedelta(days=1))
    url = f"{ESPN_API}?dates={d0}-{d1}&limit=200"
    req = urllib.request.Request(url, headers={"User-Agent": "COPA2026-workflow-guard/1.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    return payload.get("events") or []


def get_path(obj: Any, path: list[Any], default: Any = None) -> Any:
    cur = obj
    for key in path:
        if isinstance(cur, dict) and key in cur:
            cur = cur[key]
        elif isinstance(cur, list) and isinstance(key, int) and 0 <= key < len(cur):
            cur = cur[key]
        else:
            return default
    return cur if cur is not None else default


def event_state(ev: dict[str, Any]) -> str:
    return str(get_path(ev, ["competitions", 0, "status", "type", "state"], "pre") or "pre").lower()


def status_text(ev: dict[str, Any]) -> str:
    st = get_path(ev, ["competitions", 0, "status"], {}) or {}
    tp = st.get("type") or {}
    vals = [
        st.get("displayClock"), st.get("period"), st.get("detail"), st.get("shortDetail"),
        tp.get("id"), tp.get("name"), tp.get("description"), tp.get("detail"), tp.get("shortDetail"),
        tp.get("state"), tp.get("completed"),
    ]
    return " ".join(str(v) for v in vals if v not in (None, "")).lower()


def is_delay_or_live(ev: dict[str, Any]) -> bool:
    if event_state(ev) == "in":
        return True
    txt = status_text(ev)
    needles = (
        "delay", "delayed", "weather", "suspend", "suspended", "postpon", "adiad",
        "atras", "chuva", "clima", "interromp", "penalt", "shootout", "extra time",
        "overtime", "halftime", "half time", "intervalo",
    )
    return any(n in txt for n in needles)


def match_espn_event(jogo: dict[str, Any], events: list[dict[str, Any]]) -> dict[str, Any] | None:
    alvo = parse_dt(jogo["inicio_brt"])
    local = str(jogo.get("local") or "").lower()
    melhores: list[tuple[float, dict[str, Any]]] = []
    for ev in events:
        raw_date = ev.get("date")
        if not raw_date:
            continue
        try:
            ev_dt = datetime.fromisoformat(str(raw_date).replace("Z", "+00:00")).astimezone(BRT)
        except ValueError:
            continue
        dif = abs((ev_dt - alvo).total_seconds())
        if dif <= 20 * 60:
            score = dif
            venue = " ".join(str(x or "") for x in [
                get_path(ev, ["competitions", 0, "venue", "fullName"], ""),
                get_path(ev, ["competitions", 0, "venue", "displayName"], ""),
                get_path(ev, ["competitions", 0, "venue", "address", "city"], ""),
            ]).lower()
            if local and any(tok in venue for tok in local.replace("·", " ").split() if len(tok) >= 5):
                score -= 60
            melhores.append((score, ev))
    if not melhores:
        return None
    melhores.sort(key=lambda x: x[0])
    return melhores[0][1]


def set_env(run: bool, motivo: str) -> None:
    gh_env = os.environ.get("GITHUB_ENV")
    log(f"RUN_COPA={'true' if run else 'false'}")
    log(f"MOTIVO={motivo}")
    if gh_env:
        with open(gh_env, "a", encoding="utf-8") as f:
            f.write(f"RUN_COPA={'true' if run else 'false'}\n")
            f.write("RUN_COPA_MOTIVO<<EOF\n")
            f.write(motivo + "\n")
            f.write("EOF\n")


def main() -> int:
    agenda = load_json(AGENDA_PATH, {})
    estado = load_json(ESTADO_PATH, {"post_first_seen": {}})
    estado.setdefault("post_first_seen", {})

    if str(os.environ.get("FORCAR_EXECUCAO", "")).lower() in {"1", "true", "sim", "yes", "y"}:
        set_env(True, "execução manual forçada")
        return 0

    agora = now_brt()
    jogos = agenda.get("jogos") or []
    pre_h = float(agenda.get("pre_horas", 1))
    pos_h = float(agenda.get("pos_horas", 2))
    fallback_h = float(agenda.get("fallback_horas_apos_inicio", 4))
    hard_h = float(agenda.get("limite_duro_horas_apos_inicio", 8))

    candidatos: list[dict[str, Any]] = []
    proximo: tuple[datetime, dict[str, Any]] | None = None
    for jogo in jogos:
        ini = parse_dt(jogo["inicio_brt"])
        if ini > agora and (proximo is None or ini < proximo[0]):
            proximo = (ini, jogo)
        if ini - timedelta(hours=pre_h) <= agora <= ini + timedelta(hours=hard_h):
            candidatos.append(jogo)

    if not candidatos:
        if proximo:
            ini, jogo = proximo
            set_env(False, f"fora de janela; próximo jogo {jogo['id']} em {ini.strftime('%d/%m %H:%M BRT')}")
        else:
            set_env(False, "fora de janela; não há jogos futuros na agenda da Copa")
        return 0

    # Tenta ESPN para decidir o encerramento real. Se falhar, usa fallback limitado.
    events: list[dict[str, Any]] = []
    try:
        ini_busca = min(parse_dt(j["inicio_brt"]) for j in candidatos)
        fim_busca = max(parse_dt(j["inicio_brt"]) for j in candidatos)
        events = fetch_espn_events(ini_busca, fim_busca)
        log(f"ESPN: {len(events)} eventos carregados para conferência.")
    except Exception as exc:  # rede/API instável não pode derrubar janela de jogo
        log(f"AVISO: falha ao consultar ESPN ({exc}). Usando fallback por horário oficial.")

    alterou_estado = False
    motivos_true: list[str] = []
    motivos_false: list[str] = []

    for jogo in candidatos:
        ini = parse_dt(jogo["inicio_brt"])
        jid = jogo["id"]
        ev = match_espn_event(jogo, events) if events else None
        if ev:
            state = event_state(ev)
            if is_delay_or_live(ev):
                motivos_true.append(f"{jid} ativo/atrasado pela ESPN ({state})")
                continue
            if state == "pre":
                # Pré-jogo: roda de 1h antes até 2h após o horário caso a ESPN atrase o state.
                if agora <= ini + timedelta(hours=2):
                    motivos_true.append(f"{jid} pré-jogo pela ESPN")
                    continue
                motivos_false.append(f"{jid} ainda pre após tolerância")
                continue
            if state == "post":
                raw_seen = estado["post_first_seen"].get(jid)
                if raw_seen:
                    seen = parse_dt(raw_seen)
                else:
                    seen = agora
                    estado["post_first_seen"][jid] = seen.isoformat()
                    alterou_estado = True
                    log(f"Registrando encerramento ESPN de {jid}: {seen.isoformat()}")
                if agora <= seen + timedelta(hours=pos_h):
                    motivos_true.append(f"{jid} encerrado pela ESPN há menos de {pos_h:g}h")
                    continue
                motivos_false.append(f"{jid} encerrado pela ESPN há mais de {pos_h:g}h")
                continue
            # Estado estranho: se está dentro da janela dura, roda para não perder jogo.
            motivos_true.append(f"{jid} com status ESPN não padrão ({state})")
            continue

        # Sem evento ESPN casado: fallback por horário oficial, limitado.
        if agora <= ini + timedelta(hours=fallback_h):
            motivos_true.append(f"{jid} sem match ESPN, dentro do fallback por horário oficial")
        else:
            motivos_false.append(f"{jid} sem match ESPN e fora do fallback")

    if alterou_estado:
        save_json(ESTADO_PATH, estado)

    if motivos_true:
        set_env(True, "; ".join(motivos_true))
    else:
        set_env(False, "; ".join(motivos_false) or "fora de janela ativa")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
