#!/usr/bin/env python3
"""Recupera atomicamente a verdade esportiva das Quartas continentais 2026.

Incidente coberto:
- vencedor dos 90 minutos foi confundido com vencedor da disputa por pênaltis;
- Palmeiras foi indevidamente marcado como eliminado;
- o AF derivado desse estado contaminado zerou a via de título da Libertadores;
- o editorial e alguns vínculos de melhores momentos passaram a refletir fatos errados.

A correção NÃO edita probabilidades. Ela restaura snapshots canônicos, invalida apenas
os artefatos derivados contaminados e exige novo AF antes de reconstruir o editorial.
"""
from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from pathlib import Path
from typing import Any, Mapping

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from atualizar_competicoes_af_previsao import (  # noqa: E402
    COMPETITIONS,
    AUDIT_PATH,
    build_snapshot_from_normalized,
    load_existing_snapshots,
    normalize_text,
    now_brt,
    snapshots_state_hash,
    write_json_atomic,
)
from gerar_analise_continental import (  # noqa: E402
    CONT_HISTORY_PATH,
    MANIFEST,
    MM_PATH,
    PROB_PATH,
    build_ties,
    route_detail,
    video_entry_valid,
)

CANON_PATH = ROOT / "dados-br" / "correcoes" / "continentais-2026-quartas-canonico.json"
SNAP_PATHS = {
    "libertadores": ROOT / "dados-br" / "competicoes-af-previsao" / "libertadores.json",
    "sul_americana": ROOT / "dados-br" / "competicoes-af-previsao" / "sul-americana.json",
}
ARTICLE_ID = "continentais-2026-quartas-brasileiros"
ARTICLE_PATH = ROOT / "analises" / f"{ARTICLE_ID}.html"
AFTER_MARK = "continentais-2026-quartas-depois-fechamento"
RANK = 700


def load(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return copy.deepcopy(default)


def write(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def side_name(event: Mapping[str, Any], side: str) -> str:
    item = event.get(side) or {}
    return str(item.get("nome") or item.get("nome_espn") or "").strip()


def pair_key_names(a: str, b: str) -> tuple[str, str]:
    return tuple(sorted((normalize_text(a), normalize_text(b))))


def pair_key_event(event: Mapping[str, Any]) -> tuple[str, str]:
    return pair_key_names(side_name(event, "mandante"), side_name(event, "visitante"))


def is_placeholder(name: str) -> bool:
    token = normalize_text(name)
    return not token or token in {"tbd", "a definir", "por definir", "winner", "vencedor"} or token.startswith("tbd ") or token.startswith("winner of ") or token.startswith("vencedor de ")


def canonical() -> dict[str, Any]:
    data = load(CANON_PATH, {}) or {}
    if int(data.get("schema_version") or 0) != 1 or int(data.get("fase_ordem") or 0) != RANK:
        raise RuntimeError("arquivo canônico das Quartas ausente ou inválido")
    events = data.get("eventos") or []
    if len(events) != 16 or len({str(item.get("event_id") or "") for item in events}) != 16:
        raise RuntimeError("arquivo canônico precisa conter exatamente 16 partidas únicas das Quartas (8 Libertadores + 8 Sul-Americana)")
    return data


def _match_winner(home: str, away: str, hg: int, ag: int) -> str | None:
    if hg > ag:
        return home
    if ag > hg:
        return away
    return None


def patch_event(event: dict[str, Any], fact: Mapping[str, Any], source_url: str) -> None:
    expected_home = str(fact.get("mandante") or "")
    expected_away = str(fact.get("visitante") or "")
    if pair_key_event(event) != pair_key_names(expected_home, expected_away):
        raise RuntimeError(
            f"{event.get('event_id')}: clubes divergentes do registro canônico: "
            f"snapshot={side_name(event,'mandante')} x {side_name(event,'visitante')} "
            f"canon={expected_home} x {expected_away}"
        )
    # Exige também o mando exato: evita aplicar placar na perna errada.
    if normalize_text(side_name(event, "mandante")) != normalize_text(expected_home) or normalize_text(side_name(event, "visitante")) != normalize_text(expected_away):
        raise RuntimeError(f"{event.get('event_id')}: mando divergente do registro canônico")

    hg = int(fact["placar_mandante"])
    ag = int(fact["placar_visitante"])
    event["estado"] = "post"
    event["concluido"] = True
    event["status"] = "Finalizado"
    event["fase"] = "Quartas de final"
    event["fase_ordem"] = RANK
    event["perna"] = int(fact["perna"])
    event["mandante"]["placar"] = hg
    event["visitante"]["placar"] = ag

    match_winner = _match_winner(expected_home, expected_away, hg, ag)
    expected_match_winner = fact.get("vencedor_partida")
    if normalize_text(expected_match_winner) != normalize_text(match_winner):
        raise RuntimeError(f"{event.get('event_id')}: vencedor do jogo incoerente no arquivo canônico")
    event["vencedor"] = match_winner
    event["mandante"]["vencedor"] = bool(match_winner and normalize_text(match_winner) == normalize_text(expected_home))
    event["visitante"]["vencedor"] = bool(match_winner and normalize_text(match_winner) == normalize_text(expected_away))

    pen = fact.get("penaltis")
    if isinstance(pen, Mapping):
        ph, pa = int(pen["mandante"]), int(pen["visitante"])
        pw = str(pen.get("vencedor") or "").strip()
        calculated = expected_home if ph > pa else expected_away if pa > ph else ""
        if not pw or normalize_text(pw) != normalize_text(calculated):
            raise RuntimeError(f"{event.get('event_id')}: placar/vencedor dos pênaltis incoerente")
        event["penaltis"] = {"mandante": ph, "visitante": pa}
        event["vencedor_penaltis"] = pw
    else:
        event["penaltis"] = False
        event.pop("vencedor_penaltis", None)

    event["correcao_integridade"] = {
        "incidente": "continentais-2026-quartas-20260918",
        "fonte": "CONMEBOL",
        "url": source_url,
        "regra": "vencedor do jogo e vencedor dos pênaltis são fatos distintos",
    }


def sanitize_future_stage(events: list[dict[str, Any]], comp: str, canon_data: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Mantém semifinal somente se a grade já estiver integralmente materializada e correta.

    Fase parcial, placeholder ou emparelhamento contaminado é removido do snapshot
    recuperado. O AF então parte das Quartas concluídas e simula a chave seguinte.
    Uma coleta futura pode materializar novamente as semifinais corretas.
    """
    expected_pairs = {
        pair_key_names(pair[0], pair[1])
        for pair in ((canon_data.get("semifinais_esperadas") or {}).get(comp) or [])
    }
    stage = [e for e in events if int(e.get("fase_ordem") or 0) == 800]
    materialized = [e for e in stage if not is_placeholder(side_name(e, "mandante")) and not is_placeholder(side_name(e, "visitante"))]
    if not stage:
        return events

    grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for e in materialized:
        grouped.setdefault(pair_key_event(e), []).append(e)
    complete = (
        set(grouped) == expected_pairs
        and len(expected_pairs) == 2
        and all(len(items) == 2 and {int(x.get("perna") or 0) for x in items} == {1, 2} for items in grouped.values())
    )
    if complete:
        return [e for e in events if int(e.get("fase_ordem") or 0) != 800 or pair_key_event(e) in expected_pairs]

    # Semifinal parcial não pode governar o AF; remove a fase inteira.
    return [e for e in events if int(e.get("fase_ordem") or 0) != 800]


def apply_snapshot_repair(canon_data: Mapping[str, Any]) -> tuple[str, str]:
    all_before = load_existing_snapshots()
    before_hash = snapshots_state_hash(all_before) if all_before else ""
    spec_by_key = {spec.key: spec for spec in COMPETITIONS}
    sources = canon_data.get("fontes") or {}
    facts_by_comp: dict[str, list[Mapping[str, Any]]] = {"libertadores": [], "sul_americana": []}
    for item in canon_data.get("eventos") or []:
        facts_by_comp[str(item["competicao"])].append(item)

    for comp, path in SNAP_PATHS.items():
        snapshot = load(path, {}) or {}
        if not snapshot:
            raise RuntimeError(f"snapshot ausente: {path}")
        events = copy.deepcopy(snapshot.get("eventos") or [])
        by_id = {str(e.get("event_id") or ""): e for e in events}
        for fact in facts_by_comp[comp]:
            eid = str(fact["event_id"])
            event = by_id.get(eid)
            if event is None:
                raise RuntimeError(f"{comp}: event_id canônico ausente no snapshot: {eid}")
            patch_event(event, fact, str(sources.get(comp) or ""))

        # Qualquer falsa Final materializada nesta janela é impossível antes das semis.
        events = [
            e for e in events
            if not (
                int(e.get("fase_ordem") or 0) >= 900
                and str(e.get("data_iso") or "") >= "2026-09-08"
                and not is_placeholder(side_name(e, "mandante"))
                and not is_placeholder(side_name(e, "visitante"))
            )
        ]
        events = sanitize_future_stage(events, comp, canon_data)
        collection = dict(snapshot.get("coleta") or {})
        collection.update({
            "modo": "recuperacao_canônica",
            "recuperacao_incidente": "continentais-2026-quartas-20260918",
            "fonte_recuperacao": sources.get(comp),
        })
        rebuilt = build_snapshot_from_normalized(spec_by_key[comp], events, collection=collection)
        # Overrides de agenda podem carregar objetos de time antigos (placar 0).
        # A correção canônica é aplicada POR ÚLTIMO para que horário/estádio nunca
        # possam reescrever placares já auditados.
        rebuilt_by_id = {str(e.get("event_id") or ""): e for e in rebuilt.get("eventos") or []}
        for fact in facts_by_comp[comp]:
            patch_event(rebuilt_by_id[str(fact["event_id"])], fact, str(sources.get(comp) or ""))
        write_json_atomic(path, rebuilt)

    all_after = load_existing_snapshots()
    after_hash = snapshots_state_hash(all_after)
    return before_hash, after_hash


def write_recovery_audit(before_hash: str, after_hash: str, canon_data: Mapping[str, Any]) -> None:
    now = now_brt().isoformat()
    existing = load(AUDIT_PATH, {}) or {}
    rows = []
    for spec in COMPETITIONS:
        path = ROOT / "dados-br" / "competicoes-af-previsao" / spec.filename
        snap = load(path, {}) or {}
        rows.append({
            "competicao": spec.key,
            "status": "recuperado_canonico" if spec.key in SNAP_PATHS else "preservado",
            "arquivo": str(path.relative_to(ROOT)),
            "gerado_em": snap.get("gerado_em"),
            "fallback_seguro_para_af": True,
            "motivos_fallback": [],
            "alertas_fallback": [],
        })
    audit = {
        "schema_version": 2,
        "projeto": "AF-Previsão Continental",
        "etapa": "Recuperação de integridade — Quartas continentais 2026",
        "gerado_em": now,
        "status": "ok",
        "coleta_confiavel": True,
        "mudanca_esportiva": before_hash != after_hash,
        "hash_estado_antes": before_hash,
        "hash_estado_depois": after_hash,
        "fonte": "CONMEBOL — reconciliação canônica auditada",
        "temporada": 2026,
        "competicoes": rows,
        "falhas": [],
        "falhas_bloqueantes": [],
        "fontes_totalmente_atualizadas": True,
        "snapshots_prontos_para_af": True,
        "recuperacao_integridade": {
            "incidente": "continentais-2026-quartas-20260918",
            "arquivo_canonico": str(CANON_PATH.relative_to(ROOT)),
            "fontes": canon_data.get("fontes") or {},
            "regra": "probabilidades nunca são editadas manualmente; novo AF é obrigatório após a restauração factual",
        },
        "auditoria_anterior": {
            "gerado_em": existing.get("gerado_em"),
            "hash_estado_depois": existing.get("hash_estado_depois"),
        },
    }
    write_json_atomic(AUDIT_PATH, audit)


def invalidate_derived_state() -> dict[str, int]:
    removed_marks = 0
    history = load(CONT_HISTORY_PATH, {}) or {}
    marks = list(history.get("marcos") or [])
    clean_marks = [m for m in marks if str((m or {}).get("id") or "") != AFTER_MARK]
    removed_marks = len(marks) - len(clean_marks)
    history["marcos"] = clean_marks
    history["total_marcos"] = len(clean_marks)
    state = history.get("estado_ciclo")
    if isinstance(state, Mapping) and int(state.get("fase_ordem") or 0) == RANK:
        history.pop("estado_ciclo", None)
    write(CONT_HISTORY_PATH, history)

    # Não apaga probabilidades: o workflow seguinte precisa recalculá-las a partir
    # dos snapshots corrigidos. Remove apenas o artigo contaminado do manifesto.
    manifest = load(MANIFEST, {"schema_version": 2, "artigos": []}) or {"schema_version": 2, "artigos": []}
    articles = list(manifest.get("artigos") or [])
    clean_articles = [x for x in articles if str((x or {}).get("id_editorial") or "") != ARTICLE_ID]
    removed_articles = len(articles) - len(clean_articles)
    manifest["artigos"] = clean_articles
    manifest["total_artigos"] = len(clean_articles)
    write(MANIFEST, manifest)
    if ARTICLE_PATH.exists():
        ARTICLE_PATH.unlink()

    # Remove vínculos automáticos incorretos; overrides manuais explícitos ficam.
    mm = load(MM_PATH, {"schema_version": 1, "jogos": {}}) or {"schema_version": 1, "jogos": {}}
    games = dict(mm.get("jogos") or {})
    snaps = {k: load(p, {}) or {} for k, p in SNAP_PATHS.items()}
    event_index = {
        str(e.get("event_id") or ""): (comp, e)
        for comp, snap in snaps.items()
        for e in snap.get("eventos") or []
        if int(e.get("fase_ordem") or 0) == RANK
    }
    removed_videos = 0
    for eid, entry in list(games.items()):
        pair = event_index.get(str(eid))
        if not pair or (entry or {}).get("manual_verificado") is True:
            continue
        comp, event = pair
        if not video_entry_valid(entry or {}, event, comp):
            games.pop(eid, None)
            removed_videos += 1
    mm["jogos"] = games
    write(MM_PATH, mm)
    return {"marcos": removed_marks, "artigos": removed_articles, "videos": removed_videos}


def expected_status(canon_data: Mapping[str, Any]) -> tuple[set[str], set[str]]:
    qualified = set()
    eliminated = set()
    for names in (canon_data.get("classificados_brasileiros") or {}).values():
        qualified.update(names or [])
    for names in (canon_data.get("eliminados_brasileiros") or {}).values():
        eliminated.update(names or [])
    return qualified, eliminated


def validate_snapshot_truth(canon_data: Mapping[str, Any]) -> None:
    expected_q, expected_e = expected_status(canon_data)
    q: set[str] = set()
    participants: set[str] = set()
    total_ties = 0
    for comp, path in SNAP_PATHS.items():
        snap = load(path, {}) or {}
        ties = build_ties(comp, snap, RANK)
        total_ties += len(ties)
        for tie in ties:
            q.update(tie.get("br_classificados") or [])
            participants.update(tie.get("brasileiros") or [])
            if not tie.get("vencedor") or not tie.get("eliminado"):
                raise RuntimeError(f"confronto sem classificado factual: {tie.get('times')}")
    eliminated = participants - q
    if total_ties != 7:
        raise RuntimeError(f"esperados 7 confrontos brasileiros nas Quartas; atual={total_ties}")
    if q != expected_q or eliminated != expected_e:
        raise RuntimeError(
            f"verdade esportiva divergente: classificados={sorted(q)} eliminados={sorted(eliminated)} "
            f"esperado_classificados={sorted(expected_q)} esperado_eliminados={sorted(expected_e)}"
        )

    # Casos que originaram o incidente.
    lib = load(SNAP_PATHS["libertadores"], {}) or {}
    pal = next(t for t in build_ties("libertadores", lib, RANK) if "Palmeiras" in t.get("times", []))
    pen = pal.get("placar_penaltis") or {}
    if pal.get("vencedor") != "Palmeiras" or {int(pen.get("mandante", -1)), int(pen.get("visitante", -1))} != {3, 4}:
        raise RuntimeError(f"Palmeiras ainda não está resolvido corretamente: {pal}")
    fla = next(t for t in build_ties("libertadores", lib, RANK) if "Flamengo" in t.get("times", []))
    if sorted(fla.get("agregado") or []) != [1, 3] or fla.get("vencedor") != "Flamengo":
        raise RuntimeError(f"Flamengo x IDV ainda está incoerente: {fla}")
    # Embora o editorial feche apenas pelo recorte brasileiro, o AF precisa da
    # chave estrangeira já encerrada para conhecer o adversário real do Galo.
    sul = load(SNAP_PATHS["sul_americana"], {}) or {}
    foreign_events = [e for e in sul.get("eventos") or [] if str(e.get("event_id") or "") in {"401913074", "401913072"}]
    if len(foreign_events) != 2 or not all(bool(e.get("concluido")) for e in foreign_events):
        raise RuntimeError("City Torque x Cienciano ainda não foi consolidado no snapshot")
    foreign_agg = {}
    for e in foreign_events:
        for side in ("mandante", "visitante"):
            name = side_name(e, side)
            foreign_agg[name] = foreign_agg.get(name, 0) + int((e.get(side) or {}).get("placar") or 0)
    if foreign_agg.get("Montevideo City Torque") != 3 or foreign_agg.get("Cienciano del Cusco") != 2:
        raise RuntimeError(f"City Torque x Cienciano com agregado incorreto: {foreign_agg}")


def validate_af(canon_data: Mapping[str, Any]) -> None:
    probs = load(PROB_PATH, {}) or {}
    snapshots = load_existing_snapshots()
    current_hash = snapshots_state_hash(snapshots)
    af_hash = str((probs.get("integracao_continental") or {}).get("hash_snapshots") or "")
    if af_hash != current_hash:
        raise RuntimeError(f"AF ainda não incorporou snapshots corrigidos: af={af_hash} atual={current_hash}")
    by_name = {str(x.get("clube") or ""): x for x in probs.get("clubes") or []}
    expected_q, expected_e = expected_status(canon_data)
    comp_by_club: dict[str, str] = {}
    for comp, names in (canon_data.get("classificados_brasileiros") or {}).items():
        for name in names or []:
            comp_by_club[name] = comp
    for comp, names in (canon_data.get("eliminados_brasileiros") or {}).items():
        for name in names or []:
            comp_by_club[name] = comp
    for club in sorted(expected_q | expected_e):
        item = by_name.get(club)
        if not item:
            raise RuntimeError(f"AF sem clube esperado: {club}")
        route = route_detail(item, comp_by_club[club])
        possible = bool(route.get("possivel_estruturalmente"))
        value = float(route.get("percentual_estimado") or 0)
        if club in expected_q:
            if not possible:
                raise RuntimeError(f"AF marcou classificado como estruturalmente eliminado: {club}")
            # Com 2 milhões de simulações é possível, embora improvável, observar zero.
            # O requisito duro é estrutural: a via precisa existir.
        else:
            if possible or abs(value) > 1e-12:
                raise RuntimeError(f"AF ainda mantém via de título para eliminado: {club} ({route})")


def validate_article(canon_data: Mapping[str, Any]) -> None:
    expected_q, expected_e = expected_status(canon_data)
    manifest = load(MANIFEST, {}) or {}
    article = next((x for x in manifest.get("artigos") or [] if str(x.get("id_editorial") or "") == ARTICLE_ID), None)
    if not article:
        raise RuntimeError("editorial continental corrigido não foi criado")
    if set(article.get("classificados") or []) != expected_q:
        raise RuntimeError(f"editorial com classificados errados: {article.get('classificados')}")
    if set(article.get("eliminados") or []) != expected_e:
        raise RuntimeError(f"editorial com eliminados errados: {article.get('eliminados')}")
    if not ARTICLE_PATH.exists():
        raise RuntimeError("HTML do editorial corrigido ausente")
    html = ARTICLE_PATH.read_text(encoding="utf-8")
    flat = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()
    must = [
        "Classificado: Palmeiras",
        "Flamengo 1 × 1 Independiente del Valle",
        "Pênaltis 4–3",
    ]
    for token in must:
        if token not in flat:
            raise RuntimeError(f"editorial não contém fato obrigatório: {token}")
    # O status visual é validado no HTML, sem achatar os cards: no texto plano
    # "Classificado: Palmeiras Eliminado: Liga de Quito" colocaria as palavras
    # lado a lado e produziria falso positivo.
    if not re.search(r"Palmeiras</strong><small>CLASSIFICADO", html, flags=re.I):
        raise RuntimeError("card do Palmeiras não está marcado como CLASSIFICADO")
    if re.search(r"Palmeiras</strong><small>ELIMINADO", html, flags=re.I):
        raise RuntimeError("card do Palmeiras ainda está marcado como ELIMINADO")
    bad_patterns = [
        r"Palmeiras\s+e\s+Santos\s+caem",
        r"Flamengo\s+1\s*[×x]\s*0\s+Independiente del Valle",
    ]
    for pattern in bad_patterns:
        if re.search(pattern, flat, flags=re.I):
            raise RuntimeError(f"editorial ainda contém afirmação contaminada: {pattern}")


def self_test() -> None:
    c = canonical()
    q, e = expected_status(c)
    assert q == {"Flamengo", "Fluminense", "Palmeiras", "Atlético-MG", "Vasco da Gama"}
    assert e == {"Corinthians", "Santos", "São Paulo"}
    fact = next(x for x in c["eventos"] if x["event_id"] == "401912525")
    assert fact["vencedor_partida"] == "Liga de Quito"
    assert fact["penaltis"]["vencedor"] == "Palmeiras" and fact["penaltis"]["visitante"] == 4
    fact2 = next(x for x in c["eventos"] if x["event_id"] == "401912526")
    assert (fact2["placar_mandante"], fact2["placar_visitante"]) == (1, 1)
    foreign = next(x for x in c["eventos"] if x["event_id"] == "401913072")
    assert (foreign["placar_mandante"], foreign["placar_visitante"]) == (3, 0)
    assert foreign["vencedor_partida"] == "Montevideo City Torque"
    print("OK: self-test recuperação de integridade continental.")


def apply() -> None:
    c = canonical()
    before, after = apply_snapshot_repair(c)
    validate_snapshot_truth(c)
    write_recovery_audit(before, after, c)
    removed = invalidate_derived_state()
    print(
        "OK: verdade esportiva restaurada; "
        f"hash {before or 'ausente'} -> {after}; derivados invalidados={removed}. "
        "Novo AF é obrigatório antes do editorial."
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--validate-before-af", action="store_true")
    parser.add_argument("--validate-after-af", action="store_true")
    parser.add_argument("--validate-article", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
    if args.apply:
        apply()
    c = canonical()
    if args.validate_before_af:
        validate_snapshot_truth(c)
        print("OK: snapshots das Quartas representam a verdade canônica.")
    if args.validate_after_af:
        validate_snapshot_truth(c)
        validate_af(c)
        print("OK: AF recalculado sobre a verdade canônica, sem via estrutural contaminada.")
    if args.validate_article:
        validate_snapshot_truth(c)
        validate_af(c)
        validate_article(c)
        print("OK: editorial e AF coerentes com os resultados canônicos.")
    if not any(vars(args).values()):
        parser.error("informe uma ação")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
