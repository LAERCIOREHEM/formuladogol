#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gerar_auditoria_estatisticas_brasileirao.py

Audita os novos dados estatísticos do módulo Brasileirão e bloqueia regressões
gritantes antes do commit automático.

Saída:
  - dados-br/auditoria-estatisticas.json
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from atualizar_espn import CANONICOS, FUSO_BRASILIA  # type: ignore

OUT = ROOT / "dados-br" / "auditoria-estatisticas.json"

SUSPICIOUS = (
    "with a cross", "with the cross", "right footed", "left footed",
    "from the centre", "assisted by", "yellow card", "red card", "goal!",
)


def now_iso() -> str:
    return datetime.now(FUSO_BRASILIA).isoformat()


def norm(v: Any) -> str:
    s = unicodedata.normalize("NFD", str(v or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def read(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def main() -> None:
    leaders = read(ROOT / "dados-br" / "lideres-jogadores.json", {})
    leader_audit = read(ROOT / "dados-br" / "auditoria-lideres-jogadores.json", {})
    details = read(ROOT / "dados-br" / "jogos-detalhes.json", {})
    details_audit = read(ROOT / "dados-br" / "auditoria-jogos-detalhes.json", {})
    competition = read(ROOT / "dados-br" / "estatisticas-competicao.json", {})
    players = read(ROOT / "dados-br" / "jogadores.json", {})
    stats = read(ROOT / "dados-br" / "estatisticas.json", {})
    table = read(ROOT / "tabela.json", {})
    results = read(ROOT / "resultados.json", {})

    critical: list[str] = []
    warnings: list[str] = []

    goals = leaders.get("artilharia") or []
    assists = leaders.get("assistencias") or []
    if leaders.get("status") != "valido":
        critical.append("lideres-jogadores.json não está marcado como válido")
    if len(goals) < 5:
        critical.append(f"artilharia com apenas {len(goals)} jogadores")
    if len(assists) < 5:
        critical.append(f"assistências com apenas {len(assists)} jogadores")
    if goals and int(goals[0].get("gols") or 0) <= 0:
        critical.append("artilheiro líder sem gols positivos")
    if assists and int(assists[0].get("assistencias") or 0) <= 0:
        critical.append("líder de assistências sem valor positivo")

    suspicious_names = []
    for item in list(goals) + list(assists):
        name = str(item.get("nome") or "")
        if any(tok in norm(name) for tok in SUSPICIOUS):
            suspicious_names.append(name)
        if not item.get("time"):
            critical.append(f"jogador sem clube: {name}")
    if suspicious_names:
        critical.append("nomes contaminados por narração: " + ", ".join(sorted(set(suspicious_names))))

    table_rows = table.get("tabela") or []
    if len(table_rows) != 20:
        critical.append(f"tabela com {len(table_rows)} clubes, esperado 20")
    table_names = {str(x.get("time") or "") for x in table_rows}
    missing_teams = sorted(set(CANONICOS) - table_names)
    if missing_teams:
        critical.append("clubes ausentes da tabela: " + ", ".join(missing_teams))

    result_rows = results.get("resultados") or []
    detail_games = details.get("jogos") or {}
    if not isinstance(detail_games, dict):
        critical.append("jogos-detalhes.json sem objeto jogos")
        detail_games = {}
    finalized_ids = {str(x.get("event_id") or "") for x in result_rows if x.get("event_id")}
    detail_ids = set(detail_games)
    missing_details = sorted(finalized_ids - detail_ids)
    if len(missing_details) > max(10, int(len(finalized_ids) * 0.25)):
        critical.append(f"detalhes ausentes para {len(missing_details)} jogos finalizados")
    elif missing_details:
        warnings.append(f"detalhes ausentes para {len(missing_details)} jogos")

    with_public = sum(1 for g in detail_games.values() if (g or {}).get("publico") not in (None, "", 0, "0"))
    with_stats = sum(1 for g in detail_games.values() if (g or {}).get("stats") or (g or {}).get("estatisticas"))
    if with_stats == 0:
        critical.append("nenhum jogo com estatísticas detalhadas")
    if with_public == 0:
        warnings.append("nenhum público coletado ainda; conferir retorno da ESPN summary")

    comp_summary = competition.get("resumo") or {}
    if int(comp_summary.get("clubes") or 0) != 20:
        critical.append("estatisticas-competicao.json sem 20 clubes")
    club_goals = competition.get("gols_por_clube") or []
    if len(club_goals) != 20:
        critical.append(f"gols por clube com {len(club_goals)} itens, esperado 20")
    attendance = competition.get("publico") or {}
    if int(attendance.get("jogos_com_publico") or 0) != with_public:
        critical.append("contagem de jogos com público diverge entre detalhes e competição")

    if len(players.get("artilharia") or []) < 5 or len(players.get("assistencias") or []) < 5:
        critical.append("dados-br/jogadores.json não recebeu os rankings oficiais")
    if len(stats.get("artilharia") or []) < 5 or len(stats.get("garcons") or []) < 5:
        critical.append("dados-br/estatisticas.json não recebeu os rankings oficiais")

    status = "ok" if not critical else "erro"
    payload = {
        "gerado_em": now_iso(),
        "status": status,
        "resumo": {
            "clubes": len(table_rows),
            "jogos_finalizados": len(result_rows),
            "jogos_com_detalhes": len(detail_games),
            "jogos_com_estatisticas": with_stats,
            "jogos_com_publico": with_public,
            "artilheiros": len(goals),
            "assistentes": len(assists),
            "lider_gols": goals[0] if goals else None,
            "lider_assistencias": assists[0] if assists else None,
            "erros_criticos": len(critical),
            "avisos": len(warnings),
        },
        "fontes": {
            "lideres": leaders.get("fonte"),
            "lideres_aceitas": leaders.get("fonte_aceita"),
            "detalhes": details.get("fonte"),
            "competicao": competition.get("fonte"),
        },
        "auditorias_relacionadas": {
            "lideres": leader_audit.get("resumo"),
            "detalhes": {
                "total_processados": details_audit.get("total_processados"),
                "total_com_estatisticas": details_audit.get("total_com_estatisticas"),
                "total_com_publico": details_audit.get("total_com_publico"),
                "total_falhas": details_audit.get("total_falhas"),
            },
        },
        "jogos_sem_detalhes": missing_details,
        "nomes_suspeitos": suspicious_names,
        "erros_criticos": critical,
        "avisos": warnings,
    }
    write(OUT, payload)
    print(json.dumps(payload["resumo"], ensure_ascii=False, indent=2))
    if critical:
        raise RuntimeError("Auditoria de estatísticas falhou: " + " | ".join(critical))
    print(f"OK: auditoria em {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
