#!/usr/bin/env python3
"""ORG-4: gera páginas completas e únicas para os 20 clubes da Série A 2026.

O gerador opera no artefato público (_site), sem recalcular qualquer modelo.
Todos os números são lidos das fontes já publicadas pelo Fórmula do Gol.
"""
from __future__ import annotations

import argparse
import html
import json
import re
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any
import xml.etree.ElementTree as ET

SITE = "https://formuladogol.com.br"
SITEMAP_NS = "http://www.sitemaps.org/schemas/sitemap/0.9"


def load(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def esc(value: Any) -> str:
    return html.escape(str(value if value is not None else ""), quote=True)


def slugify(value: str) -> str:
    text = unicodedata.normalize("NFKD", str(value)).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()


def game_page_url(game: dict[str, Any], *, require_brasileirao: bool = False) -> str:
    """Retorna a rota ORG-5 apenas quando a partida tem data confirmada."""
    if game.get("data_definir"):
        return ""
    if require_brasileirao:
        key = str(game.get("competicao_chave") or "").strip().lower()
        label = str(game.get("competicao_nome_curto") or game.get("competicao_nome") or "").lower()
        if key and key != "brasileirao" and "brasileir" not in label:
            return ""
    raw = str(game.get("data_iso") or "").strip()
    if len(raw) < 10:
        return ""
    home = team_name(game, "mandante")
    away = team_name(game, "visitante")
    if not home or not away:
        return ""
    return f"/jogo/{slugify(home)}-x-{slugify(away)}-{raw[:10]}/"


def fmt_date(raw: Any, *, short: bool = False) -> str:
    value = str(raw or "").strip()
    if not value:
        return "Data a confirmar"
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt.strftime("%d/%m/%Y" if short else "%d/%m/%Y · %H:%M")
    except ValueError:
        return value[:10] if short else value[:16].replace("T", " · ")


def fmt_int(value: Any) -> str:
    try:
        return f"{int(round(float(value))):,}".replace(",", ".")
    except (TypeError, ValueError):
        return "—"


def fmt_decimal(value: Any, digits: int = 1) -> str:
    try:
        return f"{float(value):.{digits}f}".replace(".", ",")
    except (TypeError, ValueError):
        return "—"


def fmt_currency(value: Any) -> str:
    try:
        return "R$ " + f"{int(round(float(value))):,}".replace(",", ".")
    except (TypeError, ValueError):
        return "—"


def pct_number(value: Any, *, zero_as_floor: bool = False) -> str:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return "—"
    if n == 0:
        return "<0,001%" if zero_as_floor else "0%"
    if 0 < n < 0.001:
        return "<0,001%"
    if n > 99.999:
        return ">99,999%"
    digits = 3 if n < 0.1 else (2 if n < 1 else 1)
    return f"{n:.{digits}f}%".replace(".", ",")


def probability_display(prob: dict[str, Any], key: str) -> str:
    details = (prob.get("probabilidades_detalhes") or {}).get(key) or {}
    if details.get("exibicao"):
        return str(details["exibicao"])
    return pct_number((prob.get("probabilidades_pct") or {}).get(key))


def team_name(game: dict[str, Any], side: str) -> str:
    raw = game.get(side)
    if isinstance(raw, dict):
        return str(raw.get("nome") or "")
    return str(raw or "")


def game_has_club(game: dict[str, Any], club_name: str) -> bool:
    return club_name in {team_name(game, "mandante"), team_name(game, "visitante")}


def normalize_result_games(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        arr = payload.get("resultados") or payload.get("jogos") or []
    else:
        arr = payload
    return arr if isinstance(arr, list) else []


def latest_sources_date(paths: list[Path]) -> str:
    values: list[datetime] = []
    for path in paths:
        if not path.is_file():
            continue
        payload = load(path, {})
        if isinstance(payload, dict):
            for key in ("atualizado_em", "gerado_em", "calculado_em", "referencia_esportiva_em"):
                raw = str(payload.get(key) or "").strip()
                if not raw:
                    continue
                try:
                    values.append(datetime.fromisoformat(raw.replace("Z", "+00:00")))
                    break
                except ValueError:
                    pass
    if values:
        return max(values).date().isoformat()
    return datetime.now().date().isoformat()


def numeric_delta(current: Any, previous: Any, *, digits: int = 1, suffix: str = "") -> str:
    try:
        delta = float(current) - float(previous)
    except (TypeError, ValueError):
        return "—"
    if abs(delta) < 10 ** (-(digits + 1)):
        return f"0{suffix}"
    sign = "+" if delta > 0 else "−"
    return f"{sign}{fmt_decimal(abs(delta), digits)}{suffix}"


def position_delta(current: Any, previous: Any) -> tuple[str, str]:
    try:
        cur, prev = int(current), int(previous)
    except (TypeError, ValueError):
        return "—", "sem comparação"
    if cur == prev:
        return "0", "posição projetada estável"
    places = abs(prev - cur)
    if cur < prev:
        return f"+{places}", f"subiu {places} posição" + ("" if places == 1 else "es")
    return f"−{places}", f"caiu {places} posição" + ("" if places == 1 else "es")


def render_empty(text: str) -> str:
    return f'<div class="club-empty">{esc(text)}</div>'


def route_label(key: str) -> str:
    return {
        "via_brasileirao": "Via Brasileirão",
        "via_copa_do_brasil": "Via Copa do Brasil",
        "via_titulo_libertadores": "Via título da Libertadores",
        "via_titulo_sul_americana": "Via título da Sul-Americana",
        "via_repasse": "Via repasse de vagas",
    }.get(key, key.replace("_", " ").title())


def render_page(
    *,
    club: dict[str, Any],
    table: dict[str, Any],
    prob: dict[str, Any],
    rank: dict[str, Any],
    hist: list[dict[str, Any]],
    marcos: list[dict[str, Any]],
    agenda: list[dict[str, Any]],
    game_probs: dict[str, dict[str, Any]],
    results: list[dict[str, Any]],
    leaders: dict[str, Any],
    estat: dict[str, Any],
    accuracy: dict[str, Any],
    analyses: list[dict[str, Any]],
) -> tuple[str, str, str]:
    name = str(club.get("nome") or "").strip()
    slug = slugify(name)
    canonical = f"{SITE}/clube/{slug}/"
    title = f"{name} 2026: chances, projeção e jogos | Fórmula do Gol"
    description = (
        f"{name} no Brasileirão 2026: posição, pontos, probabilidades, AF-Score, AF-Previsão, "
        "jogos, jogadores, público, renda, resultados e evolução do modelo."
    )

    points_current = prob.get("pontos_atuais", table.get("pontos", "—"))
    games_current = prob.get("jogos_atuais", table.get("jogos", rank.get("jogos", "—")))
    pos_current = prob.get("posicao_atual", table.get("pos", "—"))
    pts_obj = prob.get("pontos_projetados")
    projected_points = (pts_obj or {}).get("media") if isinstance(pts_obj, dict) else pts_obj
    if projected_points is None:
        projected_points = "—"
    projected_pos = prob.get("posicao_classificacao_projetada") or prob.get("posicao_projetada") or "—"
    median_pos = prob.get("posicao_projetada_mediana", "—")
    faixa = prob.get("faixa_posicao_80") or {}
    faixa_text = f"{faixa.get('melhor', '—')}º–{faixa.get('pior', '—')}º"

    title_p = probability_display(prob, "campeao")
    lib_p = probability_display(prob, "libertadores")
    sula_p = probability_display(prob, "sul_americana")
    releg_p = probability_display(prob, "rebaixamento")

    score = rank.get("indice_final", rank.get("score", "—"))
    answer = (
        f"{name} está em {pos_current}º lugar com {points_current} pontos após {games_current} jogos. "
        f"O AF-Previsão projeta {projected_points} pontos e {projected_pos}º lugar; a chance de título é {title_p}, "
        f"a de Libertadores é {lib_p} e a de rebaixamento é {releg_p}."
    )

    # O que mudou: compara o cálculo atual ao marco fechado mais recente disponível.
    previous = None
    previous_label = "marco anterior"
    previous_date = ""
    for marker in reversed(marcos):
        row = next((x for x in (marker.get("clubes") or []) if x.get("clube") == name), None)
        if row:
            previous = row
            previous_label = str(marker.get("rotulo") or previous_label)
            previous_date = str(marker.get("referencia_em") or "")[:10]
            break
    if previous:
        pos_delta_value, pos_delta_text = position_delta(projected_pos, previous.get("posicao_projetada"))
        prev_title = previous.get("campeao_pct")
        prev_lib = previous.get("libertadores_pct")
        prev_releg = previous.get("rebaixamento_pct")
        change_cards = f'''
        <div class="club-change-grid">
          <div class="club-change-card"><small>Posição projetada</small><strong>{esc(pos_delta_value)}</strong><span>{esc(pos_delta_text)}</span></div>
          <div class="club-change-card"><small>Pontos projetados</small><strong>{esc(numeric_delta(projected_points, previous.get('pontos_projetados'), digits=0))}</strong><span>vs. {esc(previous_label)}</span></div>
          <div class="club-change-card"><small>Chance de título</small><strong>{esc(numeric_delta((prob.get('probabilidades_pct') or {}).get('campeao'), prev_title, digits=1, suffix=' p.p.'))}</strong><span>vs. {esc(previous_label)}</span></div>
          <div class="club-change-card"><small>Libertadores</small><strong>{esc(numeric_delta((prob.get('probabilidades_pct') or {}).get('libertadores'), prev_lib, digits=1, suffix=' p.p.'))}</strong><span>vs. {esc(previous_label)}</span></div>
          <div class="club-change-card"><small>Rebaixamento</small><strong>{esc(numeric_delta((prob.get('probabilidades_pct') or {}).get('rebaixamento'), prev_releg, digits=1, suffix=' p.p.'))}</strong><span>vs. {esc(previous_label)}</span></div>
        </div>'''
        change_note = f"Comparação com {previous_label}" + (f" ({previous_date})" if previous_date else "") + "."
    else:
        change_cards = render_empty("Não há marco anterior suficiente para calcular a variação deste clube.")
        change_note = "A comparação aparece quando existir um marco histórico compatível."

    # Distribuição de posições.
    distribution = prob.get("distribuicao_posicoes_pct") or []
    position_cells = "".join(
        f'<div class="position-cell"><span class="pos-num">{i}º</span><span class="pos-bar"><i style="width:{min(100, max(0, float(value or 0))):.6f}%"></i></span><span class="pos-pct">{esc(pct_number(value, zero_as_floor=True))}</span></div>'
        for i, value in enumerate(distribution[:20], 1)
    )

    # Vias continentais, sem somar ou recalcular nada.
    decomp = prob.get("decomposicao_chances") or {}
    lib_routes = ((decomp.get("libertadores") or {}).get("vias") or {})
    route_cards = []
    for key, detail in lib_routes.items():
        display = detail.get("exibicao") or pct_number(detail.get("percentual_estimado"))
        possible = detail.get("possivel_estruturalmente") is not False
        reason = detail.get("motivo_impossibilidade")
        status = "via disponível" if possible else (reason or "via indisponível")
        route_cards.append(
            f'<div class="club-route-card{" is-off" if not possible else ""}"><small>{esc(route_label(key))}</small><strong>{esc(display)}</strong><span>{esc(status)}</span></div>'
        )
    routes_html = "".join(route_cards) or render_empty("A decomposição das vias continentais ainda não está disponível.")

    # Próximos jogos e probabilidades pré-jogo quando existirem.
    club_agenda = [g for g in agenda if game_has_club(g, name)]
    upcoming = [g for g in club_agenda if not g.get("concluido")][:6]
    game_cards = []
    for game in upcoming:
        event_id = str(game.get("event_id") or "")
        gp = game_probs.get(event_id) or {}
        probline = ""
        if gp:
            ex = gp.get("exibicao") or {}
            probline = (
                f'<div class="game-probs"><span>{esc(team_name(game, "mandante"))} {esc(ex.get("mandante", "—"))}</span>'
                f'<span>Empate {esc(ex.get("empate", "—"))}</span>'
                f'<span>{esc(team_name(game, "visitante"))} {esc(ex.get("visitante", "—"))}</span></div>'
            )
        game_cards.append(f'''
          <div class="game-card">
            <div class="game-meta">{esc(game.get('competicao_nome_curto') or game.get('competicao_nome') or 'Futebol')} · {esc(fmt_date(game.get('data_iso')))}</div>
            <div class="game-match"><span>{esc(team_name(game, 'mandante'))}</span><span>×</span><span>{esc(team_name(game, 'visitante'))}</span></div>
            {probline}
            <div class="game-actions">{f'<a class="club-btn" href="{esc(game_page_url(game, require_brasileirao=True))}">Análise do jogo</a>' if game_page_url(game, require_brasileirao=True) else ''}<a class="club-btn secondary" href="/jogos">Ver jogos</a><span data-fdg-game-alert-slot data-event-id="{esc(event_id)}"></span></div>
          </div>''')
    games_html = "".join(game_cards) or render_empty("Nenhum próximo jogo está mapeado neste snapshot.")

    live = next((g for g in club_agenda if str(g.get("estado") or "").lower() in {"in", "live"}), None)
    live_html = ""
    if live:
        live_html = f'<div class="club-live-callout" data-club-live-box data-event-id="{esc(live.get("event_id"))}" data-state="in"><a class="club-btn" href="/aovivo.html?event={esc(live.get("event_id"))}">🔴 Acompanhar {esc(name)} ao vivo</a></div>'

    # Últimos resultados do Brasileirão.
    club_results = [g for g in results if game_has_club(g, name)]
    club_results.sort(key=lambda g: str(g.get("data_iso") or ""), reverse=True)
    result_cards = []
    for game in club_results[:6]:
        result_cards.append(f'''
          <div class="result-card">
            <small>R{esc(game.get('rodada', '—'))} · {esc(fmt_date(game.get('data_iso'), short=True))}</small>
            <div class="result-score"><span>{esc(team_name(game, 'mandante'))}</span><strong>{esc(game.get('placar_mandante', '—'))} × {esc(game.get('placar_visitante', '—'))}</strong><span>{esc(team_name(game, 'visitante'))}</span></div>
            <em>{esc(game.get('estadio') or 'Estádio não informado')}</em>
            {f'<div class="game-actions"><a class="club-btn secondary" href="{esc(game_page_url(game))}">Ver partida</a></div>' if game_page_url(game) else ''}
          </div>''')
    results_html = "".join(result_cards) or render_empty("Ainda não há resultados mapeados para este clube.")

    # Jogadores.
    scorers = [x for x in (leaders.get("artilharia") or []) if x.get("time") == name][:5]
    assists = [x for x in (leaders.get("assistencias") or []) if x.get("time") == name][:5]
    scorer_map = {x.get("nome"): x for x in scorers}
    assist_map = {x.get("nome"): x for x in assists}
    # Ordem determinística: não iterar um set sem ordenação, pois empates em
    # G+A fariam o HTML variar entre processos Python por causa do hash seed.
    names = sorted(set(scorer_map) | set(assist_map), key=lambda value: str(value).casefold())
    ga_rows = []
    for player_name in names:
        s = scorer_map.get(player_name) or {}
        a = assist_map.get(player_name) or {}
        goals = int(s.get("gols") or 0)
        ast = int(a.get("assistencias") or 0)
        games = max(int(s.get("jogos") or 0), int(a.get("jogos") or 0))
        ga_rows.append((player_name, goals, ast, games))
    ga_rows.sort(key=lambda row: (-(row[1] + row[2]), -row[1], -row[2], str(row[0]).casefold()))
    ga_rows = ga_rows[:5]

    def player_cards(rows: list[dict[str, Any]], key: str) -> str:
        if not rows:
            return render_empty("Sem dados individuais suficientes.")
        return "".join(
            f'<div class="player-card"><strong>{esc(x.get("nome"))}</strong><span>{esc(x.get("jogos", "—"))} jogos</span><em>{esc(x.get(key, 0))}</em></div>'
            for x in rows
        )

    ga_html = "".join(
        f'<div class="player-card"><strong>{esc(player)}</strong><span>{goals} G · {ast} A · {games} jogos</span><em>{goals + ast}</em></div>'
        for player, goals, ast, games in ga_rows
    ) or render_empty("Sem dados combinados suficientes.")

    # AF-Score e histórico.
    score_components = [
        ("Ataque", rank.get("ataque")),
        ("Defesa", rank.get("defesa")),
        ("Domínio", rank.get("dominio")),
        ("Eficiência", rank.get("eficiencia")),
        ("Disciplina", rank.get("disciplina")),
    ]
    components_html = "".join(
        f'<div class="club-metric"><small>{esc(label)}</small><strong>{esc(fmt_decimal(value))}</strong><span>componente AF-Score</span></div>'
        for label, value in score_components
    )

    history_cards: list[tuple[str, Any, Any]] = []
    for target in (5, 10, 15, 20):
        snapshot = next((s for s in hist if int(s.get("jogos_por_clube") or 0) == target), None)
        if not snapshot:
            continue
        row = next((x for x in (snapshot.get("ranking") or []) if x.get("time") == name), None)
        if row:
            history_cards.append((f"APÓS {target} JOGOS", row.get("pos", "—"), row.get("indice_final", row.get("score", "—"))))
    history_cards.append((f"ATUAL · {rank.get('jogos', games_current)} JOGOS", rank.get("pos", "—"), score))
    af_history_html = "".join(
        f'<div class="timeline-card{" current" if i == len(history_cards) - 1 else ""}"><small>{esc(label)}</small><strong>{esc(pos)}º · {esc(fmt_decimal(value))}</strong><span>posição · AF-Score</span></div>'
        for i, (label, pos, value) in enumerate(history_cards)
    )

    # Evolução AF-Previsão em marcos fechados + atual.
    forecast_rows = []
    for marker in marcos:
        row = next((x for x in (marker.get("clubes") or []) if x.get("clube") == name), None)
        if not row:
            continue
        display = row.get("exibicao") or {}
        forecast_rows.append((
            marker.get("rotulo", "—"),
            str(marker.get("referencia_em") or "")[:10],
            row.get("posicao_projetada", "—"),
            row.get("pontos_projetados", "—"),
            display.get("campeao") or pct_number(row.get("campeao_pct")),
            display.get("libertadores") or pct_number(row.get("libertadores_pct")),
            display.get("sul_americana") or pct_number(row.get("sul_americana_pct")),
            display.get("rebaixamento") or pct_number(row.get("rebaixamento_pct")),
        ))
    forecast_rows.append((
        "ATUAL",
        "",
        projected_pos,
        projected_points,
        title_p,
        lib_p,
        sula_p,
        releg_p,
    ))
    forecast_html = "".join(
        f'<tr class="{"current" if row[0] == "ATUAL" else ""}"><td><strong>{esc(row[0])}</strong><br><span class="club-subtle">{esc(row[1])}</span></td><td>{esc(row[2])}º</td><td>{esc(row[3])}</td><td>{esc(row[4])}</td><td>{esc(row[5])}</td><td>{esc(row[6])}</td><td>{esc(row[7])}</td></tr>'
        for row in forecast_rows
    )

    # Público/renda: exclusivamente jogos em que o clube é mandante.
    public_rows = [x for x in ((estat.get("publico") or {}).get("ranking") or []) if x.get("mandante") == name]
    public_values = [int(x.get("publico")) for x in public_rows if x.get("publico") is not None]
    revenues = [float(x.get("renda")) for x in public_rows if x.get("renda") is not None]
    public_total = sum(public_values)
    public_avg = round(public_total / len(public_values)) if public_values else 0
    public_max = max(public_values) if public_values else 0
    revenue_total = sum(revenues)
    revenue_max = max(revenues) if revenues else 0

    # Acurácia: timeline auditável do próprio clube.
    accuracy_rows = ((accuracy.get("timeline_clubes") or {}).get(name) or [])
    accuracy_cards = []
    for row in accuracy_rows[-6:]:
        probs = row.get("probabilidades_pct") or {}
        accuracy_cards.append(
            f'<div class="timeline-card"><small>{esc(fmt_date(row.get("gerado_em"), short=True))}</small><strong>{esc(row.get("posicao_projetada", "—"))}º · {esc(row.get("pontos_projetados", "—"))} pts</strong><span>Título {esc(pct_number(probs.get("campeao")))} · Lib {esc(pct_number(probs.get("libertadores")))}</span></div>'
        )
    accuracy_html = "".join(accuracy_cards) or render_empty("Ainda não há histórico de acurácia suficiente para este clube.")

    # Análises relacionadas.
    related = [a for a in analyses if name.casefold() in json.dumps(a, ensure_ascii=False).casefold()][:5]
    analyses_html = "".join(
        f'<div class="analysis-card"><a href="{esc(a.get("url") or ("/analises/" + str(a.get("slug") or "")))}">{esc(a.get("titulo"))}</a><p>{esc(a.get("linha_fina") or "")}</p></div>'
        for a in related
    ) or render_empty("Ainda não há análise editorial relacionada a este clube no manifesto atual.")

    # Competições futuras efetivamente presentes no calendário agregado.
    competitions: dict[str, int] = {}
    for game in club_agenda:
        label = str(game.get("competicao_nome_curto") or game.get("competicao_nome") or "Futebol")
        competitions[label] = competitions.get(label, 0) + 1
    competitions_html = "".join(
        f'<div class="competition-chip"><strong>{esc(label)}</strong><span>{count} jogo' + ('s' if count != 1 else '') + ' mapeado' + ('s' if count != 1 else '') + '</span></div>'
        for label, count in sorted(competitions.items())
    ) or render_empty("Nenhuma competição com jogo futuro está mapeada neste snapshot.")

    # Identidade completa usando apenas dados do cadastro do clube.
    facts = [
        ("Nome completo", club.get("nome_completo")),
        ("Cidade / UF", f"{club.get('cidade', '')} · {club.get('uf', '')}".strip(" ·")),
        ("Estádio", club.get("estadio")),
        ("Capacidade", fmt_int(club.get("capacidade")) if club.get("capacidade") else "—"),
        ("Fundação", club.get("fundacao")),
        ("Apelido", club.get("apelido")),
        ("Mascote", club.get("mascote")),
        ("Títulos brasileiros", club.get("titulos_brasileiros")),
        ("Torcida", club.get("torcida")),
    ]
    identity_html = "".join(
        f'<div class="fact"><small>{esc(label)}</small><strong>{esc(value if value not in (None, "") else "—")}</strong></div>'
        for label, value in facts
    )
    identity_texts = "".join(
        f'<p class="club-identity-note"><strong>{esc(label)}:</strong> {esc(value)}</p>'
        for label, value in (("Momento", club.get("momento")), ("Curiosidade", club.get("curiosidade")))
        if value
    )

    # Campanha usa diretamente o ranking oficial, que replica a base estatística já publicada.
    campaign = {
        "Jogos": rank.get("jogos", games_current),
        "Pontos": rank.get("pontos", points_current),
        "Gols pró": rank.get("gp", table.get("gp", "—")),
        "Gols contra": rank.get("gc", table.get("gc", "—")),
        "Saldo": rank.get("sg", table.get("sg", "—")),
        "Aproveitamento": f"{rank.get('aproveitamento', '—')}%" if rank.get("aproveitamento") is not None else "—",
    }
    campaign_html = "".join(
        f'<div class="club-metric"><small>{esc(label)}</small><strong>{esc(value)}</strong></div>' for label, value in campaign.items()
    )

    shield = club.get("escudo") or "/img/escudo-neutro.svg"
    absolute_logo = str(shield)
    if absolute_logo.startswith("/"):
        absolute_logo = SITE + absolute_logo

    json_ld = json.dumps({
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "SportsTeam",
                "@id": canonical + "#team",
                "name": name,
                "url": canonical,
                "logo": absolute_logo,
                "sport": "Football",
                "memberOf": {"@type": "SportsOrganization", "name": "Campeonato Brasileiro Série A"},
            },
            {
                "@type": "BreadcrumbList",
                "itemListElement": [
                    {"@type": "ListItem", "position": 1, "name": "Fórmula do Gol", "item": SITE + "/"},
                    {"@type": "ListItem", "position": 2, "name": "Clubes", "item": SITE + "/clubes.html"},
                    {"@type": "ListItem", "position": 3, "name": name, "item": canonical},
                ],
            },
        ],
    }, ensure_ascii=False)

    nav = '''<nav class="nav" data-br-auth-menu aria-label="Menu principal"><a href="/estatisticas.html">📈 Estatísticas</a><a href="/jogos">⚽ Jogos</a><a href="/aovivo.html">🔴 Ao vivo</a><a href="/tabela">📊 Tabela</a><a href="/resultados">✅ Resultados</a><a href="/analises/">📰 Análises</a><a href="/clubes.html" class="active" aria-current="page">🛡️ Clubes</a><a href="/museu.html">🏛️ Museu</a><a href="/copa2026/">🌎 Copa 2026</a></nav>'''

    page = f'''<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{esc(title)}</title>
  <meta name="description" content="{esc(description)}">
  <meta name="robots" content="index,follow,max-image-preview:large">
  <link rel="canonical" href="{canonical}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="{esc(title.replace(' | Fórmula do Gol', ''))}">
  <meta property="og:description" content="{esc(description)}">
  <meta property="og:url" content="{canonical}">
  <meta property="og:image" content="{SITE}/og-image-formula-do-gol-v2.jpg">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="theme-color" content="#10b981">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="stylesheet" href="/css/br-institucional.css?v=20260722-evolucao-af-score-v1">
  <link rel="stylesheet" href="/css/br-global.css?v=20260801-footer-institucional-v1">
  <link rel="stylesheet" href="/css/br-alertas.css?v=20260905-push-resiliencia-v1">
  <link rel="stylesheet" href="/css/br-clube.css?v=20260907-org4r-mobile-v1">
  <script type="application/ld+json">{json_ld}</script>
</head>
<body>
<div class="container">
  <header class="hero"><img src="/img/header-formula-do-gol-v2.png" alt="Fórmula do Gol — A matemática por trás do futebol" fetchpriority="high"></header>
  {nav}
  <main class="club-page">
    <a class="club-back" href="/clubes.html">← Voltar para Clubes</a>
    <section class="club-hero-card">
      <div class="club-identity">
        <img class="club-shield" src="{esc(shield)}" alt="Escudo do {esc(name)}">
        <div><div class="club-name-row"><h1>{esc(name)}</h1></div><div class="club-now"><span>{esc(pos_current)}º lugar</span><span>{esc(points_current)} pts</span><span>{esc(games_current)} jogos</span><span>AF-Score {esc(fmt_decimal(score))}</span></div></div>
        <div class="club-projection"><small>Projeção final</small><strong>{esc(projected_points)} pts</strong><span>posição projetada: {esc(projected_pos)}º · faixa 80%: {esc(faixa_text)}</span></div>
      </div>
      {live_html}
    </section>

    <nav class="club-nav" aria-label="Atalhos da página"><a data-club-anchor href="#resumo">Resumo</a><a data-club-anchor href="#mudou">O que mudou</a><a data-club-anchor href="#probabilidades">Probabilidades</a><a data-club-anchor href="#jogos">Jogos</a><a data-club-anchor href="#jogadores">Jogadores</a><a data-club-anchor href="#evolucao">Evolução</a><a data-club-anchor href="#mais">Mais</a></nav>

    <section id="resumo" class="club-section section-anchor">
      <div class="club-section-head"><div><div class="club-kicker">Resumo atual</div><h2>Como está o {esc(name)} agora?</h2></div></div>
      <p class="club-answer"><strong>{esc(answer)}</strong></p>
      <div class="club-grid" style="margin-top:12px">
        <div class="club-metric"><small>Campeão</small><strong class="accent">{esc(title_p)}</strong></div>
        <div class="club-metric"><small>Posição projetada</small><strong class="accent">{esc(projected_pos)}º</strong></div>
        <div class="club-metric"><small>Faixa provável</small><strong>{esc(faixa_text)}</strong></div>
        <div class="club-metric"><small>Libertadores</small><strong>{esc(lib_p)}</strong></div>
        <div class="club-metric"><small>Sul-Americana</small><strong>{esc(sula_p)}</strong></div>
        <div class="club-metric"><small>Rebaixamento</small><strong>{esc(releg_p)}</strong></div>
      </div>
    </section>

    <section id="mudou" class="club-section section-anchor">
      <div class="club-section-head"><div><div class="club-kicker">Leitura comparativa</div><h2>O que mudou para o {esc(name)}?</h2></div><span class="club-subtle">{esc(change_note)}</span></div>
      {change_cards}
    </section>

    <section id="probabilidades" class="club-section section-anchor">
      <div class="club-section-head"><div><div class="club-kicker">AF-Previsão</div><h2>Distribuição das 20 posições</h2></div><span class="club-subtle">projeção: {esc(projected_pos)}º · mediana: {esc(median_pos)}º</span></div>
      <div class="positions-grid">{position_cells}</div>
    </section>

    <section class="club-section">
      <div class="club-section-head"><div><div class="club-kicker">Caminhos continentais</div><h2>Vias para a Libertadores do {esc(name)}</h2></div><span class="club-subtle">probabilidades já consolidadas pelo AF-Previsão</span></div>
      <div class="club-route-grid">{routes_html}</div>
    </section>

    <section id="jogos" class="club-section section-anchor">
      <div class="club-section-head"><div><div class="club-kicker">Agenda</div><h2>Próximos jogos do {esc(name)}</h2></div><a class="club-btn secondary" href="/jogos">Ver agenda completa</a></div>
      <div class="game-list">{games_html}</div>
    </section>

    <section class="club-section">
      <div class="club-section-head"><div><div class="club-kicker">Resultados</div><h2>Últimos resultados do {esc(name)} no Brasileirão</h2></div><a class="club-btn secondary" href="/resultados">Ver resultados completos</a></div>
      <div class="result-grid">{results_html}</div>
    </section>

    <section class="club-section">
      <div class="alert-box"><div><h3>Receba os gols do {esc(name)}</h3><p>Use o sistema de alertas já existente do Fórmula do Gol para acompanhar os eventos deste clube.</p></div><div class="fdg-team-alert-slot" data-fdg-team-alert-slot data-team-id="{esc(slug)}" data-team-name="{esc(name)}"></div></div>
    </section>

    <section id="jogadores" class="club-section section-anchor">
      <div class="club-section-head"><div><div class="club-kicker">Jogadores</div><h2>Artilheiros, garçons e participações em gols</h2></div></div>
      <div class="club-three"><div><h3>Artilheiros</h3>{player_cards(scorers, 'gols')}</div><div><h3>Garçons</h3>{player_cards(assists, 'assistencias')}</div><div class="ga-column"><h3>Gols + assistências</h3>{ga_html}</div></div>
    </section>

    <section class="club-section">
      <div class="club-section-head"><div><div class="club-kicker">AF-Score · componentes</div><h2>Como é formado o AF-Score atual do {esc(name)}</h2></div><span class="club-subtle">sem recálculo: valores do ranking oficial</span></div>
      <div class="club-grid club-grid-five">{components_html}</div>
    </section>

    <section id="evolucao" class="club-section section-anchor">
      <div class="club-section-head"><div><div class="club-kicker">AF-Score · {esc(name)}</div><h2>Evolução do Ranking de Desempenho</h2></div></div>
      <div class="timeline-cards">{af_history_html}</div>
    </section>

    <section class="club-section">
      <div class="club-section-head"><div><div class="club-kicker">AF-Previsão · {esc(name)}</div><h2>Evolução da previsão</h2></div><span class="club-subtle">marcos fechados + cálculo atual</span></div>
      <div class="table-scroll"><table class="club-table"><thead><tr><th>Referência</th><th>Pos.</th><th>Pts</th><th>Título</th><th>Libertadores</th><th>Sul-Americana</th><th>Queda</th></tr></thead><tbody>{forecast_html}</tbody></table></div>
    </section>

    <section id="mais" class="club-section section-anchor">
      <div class="club-section-head"><div><div class="club-kicker">Campanha</div><h2>Desempenho do {esc(name)}</h2></div></div>
      <div class="club-grid">{campaign_html}</div>
    </section>

    <section class="club-section">
      <div class="club-section-head"><div><div class="club-kicker">Torcida no estádio</div><h2>Público e renda como mandante</h2></div><span class="club-subtle">somente partidas com {esc(name)} como mandante</span></div>
      <div class="club-grid">
        <div class="club-metric"><small>Jogos com público</small><strong>{len(public_values)}</strong></div>
        <div class="club-metric"><small>Público total</small><strong>{fmt_int(public_total)}</strong></div>
        <div class="club-metric"><small>Média</small><strong>{fmt_int(public_avg)}</strong></div>
        <div class="club-metric"><small>Maior público</small><strong>{fmt_int(public_max)}</strong></div>
        <div class="club-metric"><small>Renda total</small><strong>{fmt_currency(revenue_total)}</strong></div>
        <div class="club-metric"><small>Maior renda</small><strong>{fmt_currency(revenue_max)}</strong></div>
      </div>
    </section>

    <section class="club-section">
      <div class="club-section-head"><div><div class="club-kicker">Competições</div><h2>Competições no calendário atual do {esc(name)}</h2></div><span class="club-subtle">derivado da agenda agregada disponível</span></div>
      <div class="competition-grid">{competitions_html}</div>
    </section>

    <section class="club-section">
      <div class="club-section-head"><div><div class="club-kicker">Acurácia</div><h2>Evolução registrada do modelo para o {esc(name)}</h2></div><a class="club-btn secondary" href="/acuracia.html">Ver acurácia completa</a></div>
      <p class="club-answer">Esta faixa usa os snapshots históricos preservados em acuracia-af-previsao.json; ela mostra como a projeção publicada para o clube evoluiu ao longo da temporada.</p>
      <div class="accuracy-timeline">{accuracy_html}</div>
    </section>

    <section class="club-section">
      <div class="club-section-head"><div><div class="club-kicker">Análises</div><h2>Conteúdo relacionado ao {esc(name)}</h2></div><a class="club-btn secondary" href="/analises/">Todas as análises</a></div>
      <div class="analysis-list">{analyses_html}</div>
    </section>

    <section class="club-section">
      <div class="club-section-head"><div><div class="club-kicker">Identidade</div><h2>Sobre o {esc(name)}</h2></div></div>
      <div class="club-identity-facts">{identity_html}</div>{identity_texts}
    </section>
  </main>

  <footer class="site-footer br-disclaimer"><nav class="br-footer-links"><a href="/sobre.html">ⓘ Sobre o Fórmula do Gol</a></nav><div class="br-footer-copy">Fórmula do Gol — site independente, informativo e sem fins lucrativos. Dados esportivos organizados a partir de fontes públicas; modelos, projeções e apresentação são próprios.</div></footer>
</div>
<script src="/js/br-config.js?v=20260723-copa-publica-v1"></script>
<script src="/js/br-menu.js?v=20260901-alertas-v1"></script>
<script src="/js/br-clube.js?v=20260907-org4-v1" defer></script>
<script src="/js/br-push.js?v=20260905-push-resiliencia-v1" defer></script>
<script src="/js/br-alertas.js?v=20260905-push-resiliencia-v1" defer></script>
</body>
</html>
'''
    return slug, canonical, page


def update_sitemap(site_dir: Path, canonicals: list[str], lastmod: str) -> None:
    path = site_dir / "sitemap.xml"
    if not path.is_file():
        raise SystemExit("ORG-4: sitemap.xml ausente no artefato público")
    ET.register_namespace("", SITEMAP_NS)
    tree = ET.parse(path)
    root = tree.getroot()
    ns = f"{{{SITEMAP_NS}}}"
    wanted = set(canonicals)
    for node in list(root.findall(f"{ns}url")):
        loc = node.find(f"{ns}loc")
        value = (loc.text or "").strip() if loc is not None else ""
        if value.startswith(SITE + "/clube/"):
            root.remove(node)
    for canonical in canonicals:
        node = ET.SubElement(root, f"{ns}url")
        ET.SubElement(node, f"{ns}loc").text = canonical
        ET.SubElement(node, f"{ns}lastmod").text = lastmod
        ET.SubElement(node, f"{ns}changefreq").text = "daily"
        ET.SubElement(node, f"{ns}priority").text = "0.9"
    ET.indent(root, space="  ")
    tree.write(path, encoding="utf-8", xml_declaration=True)
    check_tree = ET.parse(path)
    urls = [(x.find(f"{ns}loc").text or "").strip() for x in check_tree.getroot().findall(f"{ns}url")]
    missing = wanted - set(urls)
    duplicates = [url for url in wanted if urls.count(url) != 1]
    if missing or duplicates:
        raise SystemExit(f"ORG-4: sitemap inválido; missing={sorted(missing)}, duplicates={sorted(duplicates)}")


def validate_pages(site_dir: Path, clubs: list[dict[str, Any]]) -> None:
    expected_slugs = {slugify(str(c.get("nome") or "")) for c in clubs}
    if len(expected_slugs) != 20:
        raise SystemExit(f"ORG-4: slugs não são 20 e únicos: {sorted(expected_slugs)}")
    titles: set[str] = set()
    canonicals: set[str] = set()
    required_labels = (
        "Resumo atual",
        "O que mudou",
        "Distribuição das 20 posições",
        "Vias para a Libertadores",
        "Próximos jogos",
        "Últimos resultados",
        "Receba os gols",
        "Artilheiros, garçons",
        "AF-Score · componentes",
        "Evolução do Ranking de Desempenho",
        "Evolução da previsão",
        "Campanha",
        "Público e renda como mandante",
        "Competições no calendário atual",
        "Evolução registrada do modelo",
        "Conteúdo relacionado",
        "Identidade",
    )
    for club in clubs:
        name = str(club.get("nome") or "")
        slug = slugify(name)
        path = site_dir / "clube" / slug / "index.html"
        if not path.is_file():
            raise SystemExit(f"ORG-4: página ausente: {path.relative_to(site_dir)}")
        text = path.read_text(encoding="utf-8")
        h1s = re.findall(r"<h1\b", text, flags=re.I)
        if len(h1s) != 1:
            raise SystemExit(f"ORG-4: {slug} tem {len(h1s)} H1")
        title_match = re.search(r"<title>(.*?)</title>", text, flags=re.S | re.I)
        title = html.unescape(title_match.group(1).strip()) if title_match else ""
        if not (53 <= len(title) <= 62):
            raise SystemExit(f"ORG-4: title de {slug} fora de 53–62 caracteres: {len(title)} {title!r}")
        canonical = f"{SITE}/clube/{slug}/"
        if f'rel="canonical" href="{canonical}"' not in text:
            raise SystemExit(f"ORG-4: canonical inválido em {slug}")
        if canonical in canonicals or title in titles:
            raise SystemExit(f"ORG-4: title/canonical duplicado em {slug}")
        titles.add(title)
        canonicals.add(canonical)
        if text.count('class="position-cell"') != 20:
            raise SystemExit(f"ORG-4: {slug} não tem exatamente 20 posições")
        if 'data-fdg-team-alert-slot' not in text:
            raise SystemExit(f"ORG-4: alerta do clube ausente em {slug}")
        if 'SportsTeam' not in text or 'BreadcrumbList' not in text:
            raise SystemExit(f"ORG-4: JSON-LD incompleto em {slug}")
        if 'max-image-preview:large' not in text:
            raise SystemExit(f"ORG-4: max-image-preview ausente em {slug}")
        for label in required_labels:
            if label not in text:
                raise SystemExit(f"ORG-4: seção/label ausente em {slug}: {label}")
        if "← Voltar para Clubes" not in text:
            raise SystemExit(f"ORG-4: botão Voltar ausente em {slug}")
        if name not in text:
            raise SystemExit(f"ORG-4: nome do clube ausente em {slug}")
    # Garante que o ID defeituoso histórico do Grêmio não vaze para a rota.
    if (site_dir / "clube" / "gr-mio").exists():
        raise SystemExit("ORG-4: rota incorreta /clube/gr-mio/ encontrada")


def render(site_dir: Path, repo_root: Path) -> None:
    data = site_dir / "dados-br" if (site_dir / "dados-br").is_dir() else repo_root / "dados-br"
    clubs = (load(data / "clubes.json", {}).get("clubes") or [])
    if len(clubs) != 20:
        raise SystemExit(f"ORG-4: esperado 20 clubes, encontrado {len(clubs)}")

    tables_payload = load(site_dir / "tabela.json" if (site_dir / "tabela.json").is_file() else repo_root / "tabela.json", {})
    tables = {x.get("time"): x for x in (tables_payload.get("tabela") or [])}
    probs_payload = load(data / "probabilidades-brasileirao.json", {})
    probs = {x.get("clube"): x for x in (probs_payload.get("clubes") or [])}
    ranking_payload = load(data / "ranking-desempenho.json", {})
    rankings = {x.get("time"): x for x in (ranking_payload.get("ranking") or [])}
    hist = load(data / "historico-ranking-desempenho.json", {}).get("snapshots") or []
    marcos = load(data / "marcos-af-previsao.json", {}).get("marcos") or []
    agenda = load(data / "agenda-clubes-br.json", {}).get("jogos") or []
    game_probs_payload = load(data / "probabilidades-jogos.json", {})
    game_probs = {str(x.get("event_id")): x for x in (game_probs_payload.get("jogos") or []) if x.get("event_id")}
    results_path = site_dir / "resultados.json" if (site_dir / "resultados.json").is_file() else repo_root / "resultados.json"
    results = normalize_result_games(load(results_path, {}))
    leaders = load(data / "lideres-jogadores.json", {})
    estat = load(data / "estatisticas-competicao.json", {})
    accuracy = load(data / "acuracia-af-previsao.json", {})
    analyses = load(data / "analises.json", {}).get("artigos") or []

    missing = []
    for club in clubs:
        name = club.get("nome")
        for label, mapping in (("tabela", tables), ("probabilidades", probs), ("ranking", rankings)):
            if name not in mapping:
                missing.append(f"{name}:{label}")
    if missing:
        raise SystemExit("ORG-4: dados centrais ausentes: " + ", ".join(missing))

    # Limpa apenas páginas de clubes antigas geradas por ORG anterior.
    club_root = site_dir / "clube"
    if club_root.exists():
        for child in club_root.iterdir():
            if child.is_dir() and child.name not in {slugify(str(c.get("nome") or "")) for c in clubs}:
                import shutil
                shutil.rmtree(child)

    canonicals: list[str] = []
    for club in sorted(clubs, key=lambda x: str(x.get("nome") or "").casefold()):
        name = str(club.get("nome") or "")
        slug, canonical, page = render_page(
            club=club,
            table=tables[name],
            prob=probs[name],
            rank=rankings[name],
            hist=hist,
            marcos=marcos,
            agenda=agenda,
            game_probs=game_probs,
            results=results,
            leaders=leaders,
            estat=estat,
            accuracy=accuracy,
            analyses=analyses,
        )
        target = site_dir / "clube" / slug / "index.html"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(page, encoding="utf-8")
        canonicals.append(canonical)

    source_paths = [
        data / "clubes.json",
        data / "ranking-desempenho.json",
        data / "historico-ranking-desempenho.json",
        data / "probabilidades-brasileirao.json",
        data / "marcos-af-previsao.json",
        data / "agenda-clubes-br.json",
        data / "probabilidades-jogos.json",
        data / "lideres-jogadores.json",
        data / "estatisticas-competicao.json",
        data / "acuracia-af-previsao.json",
        data / "analises.json",
        results_path,
    ]
    update_sitemap(site_dir, canonicals, latest_sources_date(source_paths))
    validate_pages(site_dir, clubs)
    print("ORG-4 PASS: 20 páginas completas, 20 slugs únicos, 20 canonicals, sitemap, SEO e conteúdo estrutural validados")


def main() -> None:
    ap = argparse.ArgumentParser(description="Gera e valida as 20 páginas completas de clubes (ORG-4).")
    ap.add_argument("--site-dir", "--site-root", dest="site_dir", default="_site")
    ap.add_argument("--repo-root", default=".")
    ap.add_argument("--check", action="store_true", help="gera idempotentemente e executa os gates ORG-4")
    args = ap.parse_args()
    render(Path(args.site_dir).resolve(), Path(args.repo_root).resolve())
    if args.check:
        print("ORG-4 CHECK PASS")


if __name__ == "__main__":
    main()
