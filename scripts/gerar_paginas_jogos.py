#!/usr/bin/env python3
"""ORG-5: gera páginas SEO estáticas para partidas do Brasileirão 2026.

O gerador lê apenas fontes já publicadas pelo Fórmula do Gol e escreve no
artefato público (_site). Não recalcula AF-Previsão, AF-Score ou qualquer dado
esportivo. Uma partida só recebe URL indexável quando possui data confirmada.
"""
from __future__ import annotations

import argparse
import html
import json
import re
import unicodedata
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

SITE = "https://formuladogol.com.br"
NS = "http://www.sitemaps.org/schemas/sitemap/0.9"
FUSO_BR = timezone(timedelta(hours=-3))


def load(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def esc(value: Any) -> str:
    return html.escape(str(value if value is not None else ""), quote=True)


def slugify(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()


def parse_dt(raw: Any) -> datetime | None:
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        value = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=FUSO_BR)
    return value.astimezone(FUSO_BR)


def date_key(raw: Any) -> str:
    dt = parse_dt(raw)
    return dt.strftime("%Y-%m-%d") if dt else ""


def fmt_date(raw: Any) -> str:
    dt = parse_dt(raw)
    if not dt:
        return "Data a confirmar"
    dias = ("segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado", "domingo")
    return f"{dias[dt.weekday()]}, {dt:%d/%m/%Y} · {dt:%H:%M}"


def fmt_short_date(raw: Any) -> str:
    dt = parse_dt(raw)
    return dt.strftime("%d/%m/%Y") if dt else "—"


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


def pct(value: Any) -> str:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return "—"
    if n == 0:
        return "0%"
    if 0 < n < 0.001:
        return "<0,001%"
    if n >= 99.999:
        return ">99,999%"
    if n < 0.1:
        return f"{n:.3f}%".replace(".", ",")
    return f"{n:.1f}%".replace(".", ",")


def team_name(game: dict[str, Any], side: str) -> str:
    value = game.get(side)
    if isinstance(value, dict):
        return str(value.get("nome") or value.get("name") or "").strip()
    return str(value or "").strip()


def confirmed_game_url(game: dict[str, Any]) -> str:
    if game.get("data_definir"):
        return ""
    day = date_key(game.get("data_iso"))
    home = team_name(game, "mandante")
    away = team_name(game, "visitante")
    if not day or not home or not away:
        return ""
    return f"/jogo/{slugify(home)}-x-{slugify(away)}-{day}/"


def absolute_logo(raw: Any) -> str:
    value = str(raw or "").strip()
    if not value:
        return f"{SITE}/favicon-formula-do-gol-192.png"
    if value.startswith("/"):
        return SITE + value
    return value


def normalize_event_id(value: Any) -> str:
    return str(value or "").strip()


def latest_safe_prediction(history: list[dict[str, Any]], kickoff: datetime | None) -> dict[str, Any]:
    candidates: list[tuple[datetime, dict[str, Any]]] = []
    if not kickoff:
        return {}
    for item in history:
        generated = parse_dt(item.get("gerado_em_modelo") or item.get("gerado_em"))
        if generated and generated <= kickoff:
            candidates.append((generated, item))
    if not candidates:
        return {}
    candidates.sort(key=lambda pair: pair[0])
    return candidates[-1][1]


def prediction_display(pred: dict[str, Any]) -> dict[str, str]:
    if not pred:
        return {}
    direct = pred.get("exibicao") or {}
    if isinstance(direct, dict) and direct:
        return {
            "mandante": str(direct.get("mandante") or "—"),
            "empate": str(direct.get("empate") or "—"),
            "visitante": str(direct.get("visitante") or "—"),
        }
    values = pred.get("probabilidades_exibicao_pct") or pred.get("probabilidades_pct") or {}
    return {
        "mandante": pct(values.get("mandante")),
        "empate": pct(values.get("empate")),
        "visitante": pct(values.get("visitante")),
    }


def compact_title(home: str, away: str, completed: bool, hs: Any, as_: Any) -> str:
    if completed and hs is not None and as_ is not None:
        base = f"{home} {hs} x {as_} {away} | Fórmula do Gol"
    else:
        base = f"{home} x {away} — Brasileirão | Fórmula do Gol"
    if len(base) <= 68:
        return base
    # Times com nomes longos: preserva os dois clubes e corta apenas a marcação de competição.
    return f"{home} x {away} | Fórmula do Gol"


def current_team_card(name: str, club: dict[str, Any], table: dict[str, Any], prob: dict[str, Any], rank: dict[str, Any]) -> str:
    pos = prob.get("posicao_atual", table.get("pos", rank.get("pos", "—")))
    points = prob.get("pontos_atuais", table.get("pontos", rank.get("pontos", "—")))
    games = prob.get("jogos_atuais", table.get("jogos", rank.get("jogos", "—")))
    projected = prob.get("posicao_classificacao_projetada", prob.get("posicao_projetada", "—"))
    score = rank.get("score", rank.get("indice_final", "—"))
    champion = ((prob.get("probabilidades_detalhes") or {}).get("campeao") or {}).get("exibicao")
    if not champion:
        champion = pct((prob.get("probabilidades_pct") or {}).get("campeao"))
    return f'''
      <article class="game-team-context">
        <a class="game-team-head" href="/clube/{slugify(name)}/">
          <img src="{esc(club.get('escudo'))}" alt="Escudo do {esc(name)}" loading="lazy">
          <div><strong>{esc(name)}</strong><span>{esc(pos)}º · {esc(points)} pts · {esc(games)} jogos</span></div>
        </a>
        <div class="game-team-metrics">
          <span><small>AF-Score</small><b>{esc(fmt_decimal(score))}</b></span>
          <span><small>Proj. final</small><b>{esc(projected)}º</b></span>
          <span><small>Título</small><b>{esc(champion)}</b></span>
        </div>
      </article>'''


def render_stats(details: dict[str, Any]) -> str:
    stats = details.get("estatisticas") or details.get("stats") or []
    if not stats:
        return '<div class="game-empty">Estatísticas detalhadas ainda não estão disponíveis para esta partida.</div>'
    rows = []
    for item in stats:
        name = item.get("nome") or item.get("name") or "Estatística"
        home = item.get("home", "—")
        away = item.get("away", "—")
        note = item.get("note") or ""
        rows.append(
            f'<tr><td>{esc(home)}</td><th>{esc(name)}{f"<small>{esc(note)}</small>" if note else ""}</th><td>{esc(away)}</td></tr>'
        )
    return '<div class="game-table-scroll"><table class="game-stats"><tbody>' + "".join(rows) + "</tbody></table></div>"


def render_goals(details: dict[str, Any], home: str, away: str) -> str:
    goals = details.get("gols") or []
    if not goals:
        return '<div class="game-empty">Não há eventos de gol individualizados nesta fonte.</div>'
    cards = []
    for goal in goals:
        assists = goal.get("assistencias") or []
        assist_text = ""
        if assists:
            assist_text = " · assistência: " + ", ".join(str(x) for x in assists if x)
        team = str(goal.get("time") or "")
        side_class = " home" if team == home else (" away" if team == away else "")
        cards.append(
            f'<div class="goal-row{side_class}"><span class="goal-minute">{esc(goal.get("minuto") or "—")}</span>'
            f'<div><strong>⚽ {esc(goal.get("jogador") or "Gol")}</strong><small>{esc(team)}{esc(assist_text)}</small></div></div>'
        )
    return '<div class="goal-list">' + "".join(cards) + "</div>"


def render_transmission(tv: dict[str, Any]) -> str:
    channels = tv.get("canais") or []
    access = tv.get("acessos") or []
    if not channels and not access:
        return '<div class="game-empty">Transmissão não informada nesta fonte.</div>'
    channel_html = "".join(f'<span class="game-chip">{esc(ch)}</span>' for ch in channels)
    links = []
    for item in access[:6]:
        url = str(item.get("url") or "").strip()
        if not url.startswith(("https://", "http://")):
            continue
        links.append(f'<a class="game-btn secondary" href="{esc(url)}" rel="noopener noreferrer" target="_blank">{esc(item.get("nome") or "Acesso oficial")}</a>')
    return f'<div class="game-chips">{channel_html}</div><div class="game-actions">{"".join(links)}</div>'


def result_answer(home: str, away: str, hs: Any, as_: Any) -> str:
    try:
        h = int(hs)
        a = int(as_)
    except (TypeError, ValueError):
        return f"{home} e {away} já se enfrentaram nesta partida do Brasileirão 2026."
    if h > a:
        return f"O {home} venceu o {away} por {h} a {a}."
    if a > h:
        return f"O {away} venceu o {home} por {a} a {h}."
    return f"{home} e {away} empataram por {h} a {a}."


def upcoming_answer(home: str, away: str, pred: dict[str, Any]) -> str:
    display = prediction_display(pred)
    if display:
        return (
            f"Antes do jogo, o AF-Previsão aponta {display['mandante']} para vitória do {home}, "
            f"{display['empate']} para empate e {display['visitante']} para vitória do {away}."
        )
    return f"{home} e {away} têm confronto confirmado pelo Brasileirão 2026; a previsão pré-jogo ainda não está disponível."


def render_page(
    game: dict[str, Any],
    *,
    result: dict[str, Any],
    details: dict[str, Any],
    current_pred: dict[str, Any],
    historical_pred: dict[str, Any],
    tv: dict[str, Any],
    club_map: dict[str, dict[str, Any]],
    table_map: dict[str, dict[str, Any]],
    prob_map: dict[str, dict[str, Any]],
    rank_map: dict[str, dict[str, Any]],
    related: list[dict[str, Any]],
    updated_at: str,
) -> tuple[str, str, str]:
    home = team_name(game, "mandante")
    away = team_name(game, "visitante")
    url_path = confirmed_game_url(game)
    if not url_path:
        raise ValueError("partida sem URL confirmada")
    canonical = SITE + url_path
    slug = url_path.rstrip("/").split("/")[-1]
    completed = bool(game.get("concluido") or result)
    hs = result.get("placar_mandante", details.get("placar_mandante")) if completed else None
    as_ = result.get("placar_visitante", details.get("placar_visitante")) if completed else None
    stadium = result.get("estadio") or details.get("estadio") or game.get("estadio") or "Estádio a confirmar"
    round_no = game.get("rodada", result.get("rodada", "—"))
    kickoff = game.get("data_iso") or result.get("data_iso")
    title = compact_title(home, away, completed, hs, as_)

    pred = historical_pred if completed else current_pred
    pred_display = prediction_display(pred)
    modal = pred.get("placar_modal") or {}
    expected_goals = pred.get("gols_esperados") or {}
    pred_generated = pred.get("gerado_em_modelo") or pred.get("gerado_em") or ""
    if completed:
        answer = result_answer(home, away, hs, as_)
        description = f"{home} x {away} no Brasileirão 2026: resultado {hs} a {as_}, gols, estatísticas, público e dados do jogo."
    else:
        answer = upcoming_answer(home, away, pred)
        description = f"{home} x {away} pelo Brasileirão 2026: data, horário, estádio, probabilidades AF-Previsão, contexto dos clubes e transmissão."

    home_club = club_map.get(home, {"nome": home})
    away_club = club_map.get(away, {"nome": away})
    home_logo = absolute_logo(home_club.get("escudo"))
    away_logo = absolute_logo(away_club.get("escudo"))

    if completed and hs is not None and as_ is not None:
        central = f'<div class="game-score"><strong>{esc(hs)}</strong><span>×</span><strong>{esc(as_)}</strong></div><div class="game-status final">FINAL</div>'
    else:
        central = '<div class="game-score pre"><span>×</span></div><div class="game-status">PRÉ-JOGO</div>'

    if pred_display:
        prob_html = f'''
        <div class="game-prob-grid">
          <div><small>{esc(home)}</small><strong>{esc(pred_display['mandante'])}</strong><span>vitória</span></div>
          <div><small>Empate</small><strong>{esc(pred_display['empate'])}</strong><span>resultado</span></div>
          <div><small>{esc(away)}</small><strong>{esc(pred_display['visitante'])}</strong><span>vitória</span></div>
        </div>'''
        extras = []
        if expected_goals:
            extras.append(f"Gols esperados: {fmt_decimal(expected_goals.get('mandante'), 2)} × {fmt_decimal(expected_goals.get('visitante'), 2)}")
        if modal and modal.get("mandante") is not None and modal.get("visitante") is not None:
            extras.append(f"Placar modal: {modal.get('mandante')} × {modal.get('visitante')}")
        if pred_generated:
            extras.append(f"Snapshot: {fmt_date(pred_generated)}")
        prob_note = " · ".join(extras)
        prob_footer = f'<p class="game-note">{esc(prob_note)}</p>' if prob_note else ""
    else:
        if completed:
            msg = "Não existe snapshot pré-jogo preservado e publicável para esta partida; nenhuma probabilidade foi reconstruída retroativamente."
        else:
            msg = "A previsão AF-Previsão ainda não está disponível para esta partida."
        prob_html = f'<div class="game-empty">{esc(msg)}</div>'
        prob_footer = ""

    detail_facts = []
    if details.get("publico") is not None:
        detail_facts.append(("Público", fmt_int(details.get("publico"))))
    if details.get("publico_pagante") is not None:
        detail_facts.append(("Pagantes", fmt_int(details.get("publico_pagante"))))
    if details.get("renda") is not None:
        try:
            renda = "R$ " + f"{float(details.get('renda')):,.0f}".replace(",", ".")
        except (TypeError, ValueError):
            renda = "—"
        detail_facts.append(("Renda", renda))
    if details.get("arbitro"):
        detail_facts.append(("Árbitro", details.get("arbitro")))
    facts_html = "".join(f'<div class="game-fact"><small>{esc(k)}</small><strong>{esc(v)}</strong></div>' for k, v in detail_facts)
    if not facts_html:
        facts_html = '<div class="game-empty">Público, renda e arbitragem ainda não estão disponíveis nesta fonte.</div>'

    related_cards = []
    for other in related[:6]:
        other_url = confirmed_game_url(other)
        if not other_url:
            continue
        oh = team_name(other, "mandante")
        oa = team_name(other, "visitante")
        related_cards.append(
            f'<a class="related-game" href="{esc(other_url)}"><small>R{esc(other.get("rodada", "—"))} · {esc(fmt_short_date(other.get("data_iso")))}</small><strong>{esc(oh)} × {esc(oa)}</strong></a>'
        )
    related_html = "".join(related_cards) or '<div class="game-empty">Nenhuma partida relacionada com data confirmada.</div>'

    status_url = "/aovivo.html?event=" + esc(game.get("event_id")) if not completed else "/resultados"
    status_label = "🔴 Abrir Ao vivo" if not completed else "✅ Ver resultados"

    structured = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "SportsEvent",
                "@id": canonical + "#event",
                "name": f"{home} x {away} — Brasileirão 2026",
                "url": canonical,
                "startDate": (parse_dt(kickoff).isoformat() if parse_dt(kickoff) else str(kickoff or "")),
                "eventStatus": "https://schema.org/EventCompleted" if completed else "https://schema.org/EventScheduled",
                "sport": "Football",
                "location": {"@type": "Place", "name": str(stadium)},
                "homeTeam": {"@type": "SportsTeam", "name": home, "url": f"{SITE}/clube/{slugify(home)}/", "logo": home_logo},
                "awayTeam": {"@type": "SportsTeam", "name": away, "url": f"{SITE}/clube/{slugify(away)}/", "logo": away_logo},
                "description": description,
            },
            {
                "@type": "BreadcrumbList",
                "itemListElement": [
                    {"@type": "ListItem", "position": 1, "name": "Fórmula do Gol", "item": SITE + "/"},
                    {"@type": "ListItem", "position": 2, "name": "Jogos", "item": SITE + "/jogos"},
                    {"@type": "ListItem", "position": 3, "name": f"{home} x {away}", "item": canonical},
                ],
            },
        ],
    }
    json_ld = json.dumps(structured, ensure_ascii=False, separators=(",", ":"))

    nav = '''<nav class="nav" data-br-auth-menu aria-label="Menu principal"><a href="/estatisticas.html">📈 Estatísticas</a><a href="/jogos" class="active" aria-current="page">⚽ Jogos</a><a href="/aovivo.html">🔴 Ao vivo</a><a href="/tabela">📊 Tabela</a><a href="/resultados">✅ Resultados</a><a href="/analises/">📰 Análises</a><a href="/clubes.html">🛡️ Clubes</a><a href="/museu.html">🏛️ Museu</a><a href="/copa2026/">🌎 Copa 2026</a></nav>'''

    page = f'''<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{esc(title)}</title>
  <meta name="description" content="{esc(description)}">
  <meta name="robots" content="index,follow,max-image-preview:large">
  <link rel="canonical" href="{canonical}">
  <meta property="og:type" content="article">
  <meta property="og:title" content="{esc(title.replace(' | Fórmula do Gol', ''))}">
  <meta property="og:description" content="{esc(description)}">
  <meta property="og:url" content="{canonical}">
  <meta property="og:image" content="{SITE}/og-image-formula-do-gol-v2.jpg">
  <meta property="article:modified_time" content="{esc(updated_at)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="theme-color" content="#10b981">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="stylesheet" href="/css/br-institucional.css?v=20260722-evolucao-af-score-v1">
  <link rel="stylesheet" href="/css/br-global.css?v=20260801-footer-institucional-v1">
  <link rel="stylesheet" href="/css/br-alertas.css?v=20260905-push-resiliencia-v1">
  <link rel="stylesheet" href="/css/br-jogo.css?v=20260907-org5-v1">
  <script type="application/ld+json">{json_ld}</script>
</head>
<body>
<div class="container">
  <header class="hero"><img src="/img/header-formula-do-gol-v2.png" alt="Fórmula do Gol — A matemática por trás do futebol" fetchpriority="high"></header>
  {nav}
  <main class="game-page">
    <a class="game-back" href="/jogos">← Voltar para Jogos</a>

    <section class="game-hero-card">
      <div class="game-kicker">Brasileirão 2026 · Rodada {esc(round_no)}</div>
      <h1>{esc(home)} x {esc(away)}</h1>
      <div class="game-main-score">
        <a class="game-side" href="/clube/{slugify(home)}/"><img src="{esc(home_logo)}" alt="Escudo do {esc(home)}"><strong>{esc(home)}</strong><span>Mandante</span></a>
        <div class="game-center">{central}</div>
        <a class="game-side" href="/clube/{slugify(away)}/"><img src="{esc(away_logo)}" alt="Escudo do {esc(away)}"><strong>{esc(away)}</strong><span>Visitante</span></a>
      </div>
      <div class="game-meta-line"><span>📅 {esc(fmt_date(kickoff))}</span><span>🏟️ {esc(stadium)}</span><span>R{esc(round_no)}</span><span>↻ Atualizado {esc(fmt_date(updated_at))}</span></div>
      <p class="game-answer"><strong>{esc(answer)}</strong></p>
      <div class="game-actions"><a class="game-btn" href="{status_url}">{status_label}</a><span data-fdg-game-alert-slot data-event-id="{esc(game.get('event_id'))}"></span></div>
    </section>

    <nav class="game-anchor-nav" aria-label="Atalhos da página"><a href="#previsao">Previsão</a><a href="#dados">Dados</a><a href="#clubes">Clubes</a><a href="#transmissao">Transmissão</a><a href="#relacionados">Relacionados</a></nav>

    <section id="previsao" class="game-section section-anchor">
      <div class="game-section-head"><div><div class="game-kicker">AF-Previsão</div><h2>{'Probabilidades pré-jogo preservadas' if completed else 'Probabilidades do confronto'}</h2></div></div>
      {prob_html}{prob_footer}
    </section>

    <section id="dados" class="game-section section-anchor">
      <div class="game-section-head"><div><div class="game-kicker">Partida</div><h2>{'Gols e estatísticas' if completed else 'Informações confirmadas'}</h2></div></div>
      {'<div class="game-two"><div><h3>Gols</h3>' + render_goals(details, home, away) + '</div><div><h3>Resumo operacional</h3><div class="game-facts">' + facts_html + '</div></div></div><div class="game-stats-wrap"><h3>Estatísticas do jogo</h3>' + render_stats(details) + '</div>' if completed else '<div class="game-facts"><div class="game-fact"><small>Data</small><strong>' + esc(fmt_date(kickoff)) + '</strong></div><div class="game-fact"><small>Estádio</small><strong>' + esc(stadium) + '</strong></div><div class="game-fact"><small>Rodada</small><strong>' + esc(round_no) + '</strong></div></div>'}
    </section>

    <section id="clubes" class="game-section section-anchor">
      <div class="game-section-head"><div><div class="game-kicker">Contexto atual</div><h2>Como chegam os clubes no snapshot atual</h2></div></div>
      <div class="game-two">
        {current_team_card(home, home_club, table_map.get(home, {}), prob_map.get(home, {}), rank_map.get(home, {}))}
        {current_team_card(away, away_club, table_map.get(away, {}), prob_map.get(away, {}), rank_map.get(away, {}))}
      </div>
      <p class="game-note">O contexto dos clubes representa o snapshot atual do site; para partidas já encerradas, ele não pretende reconstruir retroativamente a situação da tabela no dia do jogo.</p>
    </section>

    <section id="transmissao" class="game-section section-anchor">
      <div class="game-section-head"><div><div class="game-kicker">Onde acompanhar</div><h2>Transmissão e alertas</h2></div><a class="game-btn secondary" href="/alertas.html">Configurar alertas</a></div>
      {render_transmission(tv)}
    </section>

    <section id="relacionados" class="game-section section-anchor">
      <div class="game-section-head"><div><div class="game-kicker">Navegação</div><h2>Outros jogos de {esc(home)} e {esc(away)}</h2></div></div>
      <div class="related-grid">{related_html}</div>
    </section>
  </main>

  <footer class="site-footer br-disclaimer"><nav class="br-footer-links"><a href="/sobre.html">ⓘ Sobre o Fórmula do Gol</a></nav><div class="br-footer-copy">Fórmula do Gol — site independente, informativo e sem fins lucrativos. Dados esportivos organizados a partir de fontes públicas; modelos, projeções e apresentação são próprios.</div></footer>
</div>
<script src="/js/br-config.js?v=20260723-copa-publica-v1"></script>
<script src="/js/br-menu.js?v=20260901-alertas-v1"></script>
<script src="/js/br-push.js?v=20260905-push-resiliencia-v1" defer></script>
<script src="/js/br-alertas.js?v=20260905-push-resiliencia-v1" defer></script>
</body>
</html>
'''
    return slug, canonical, page


def update_sitemap(site_dir: Path, canonicals: list[str], fallback_lastmod: str) -> None:
    path = site_dir / "sitemap.xml"
    if not path.is_file():
        raise SystemExit("ORG-5 ERRO: sitemap.xml ausente")
    ET.register_namespace("", NS)
    tree = ET.parse(path)
    root = tree.getroot()
    by_loc: dict[str, ET.Element] = {}
    for node in root.findall(f"{{{NS}}}url"):
        loc = node.find(f"{{{NS}}}loc")
        if loc is not None and (loc.text or "").strip():
            by_loc[loc.text.strip()] = node
    wanted = set(canonicals)
    # Remove apenas URLs ORG-5 antigas; outras superfícies pertencem a outros geradores.
    for loc, node in list(by_loc.items()):
        if loc.startswith(SITE + "/jogo/") and loc not in wanted:
            root.remove(node)
            by_loc.pop(loc, None)
    for canonical in sorted(wanted):
        if canonical in by_loc:
            continue
        node = ET.SubElement(root, f"{{{NS}}}url")
        loc = ET.SubElement(node, f"{{{NS}}}loc")
        loc.text = canonical
        lm = ET.SubElement(node, f"{{{NS}}}lastmod")
        lm.text = fallback_lastmod
    ET.indent(root, space="  ")
    tree.write(path, encoding="utf-8", xml_declaration=True)


def validate(site_dir: Path, games: list[dict[str, Any]], canonicals: list[str]) -> None:
    expected = []
    for game in games:
        path = confirmed_game_url(game)
        if not path:
            continue
        expected.append((game, site_dir / path.strip("/") / "index.html", SITE + path))
    if len(expected) != len(canonicals):
        raise AssertionError("contagem interna de URLs ORG-5 divergente")
    if len(set(canonicals)) != len(canonicals):
        raise AssertionError("canonicals ORG-5 duplicados")

    problems: list[str] = []
    for game, page, canonical in expected:
        if not page.is_file():
            problems.append(f"ausente: {page}")
            continue
        text = page.read_text(encoding="utf-8")
        if text.count("<h1") != 1:
            problems.append(f"{canonical}: H1 != 1")
        if f'<link rel="canonical" href="{canonical}">' not in text:
            problems.append(f"{canonical}: canonical ausente")
        if 'max-image-preview:large' not in text:
            problems.append(f"{canonical}: max-image-preview ausente")
        if '"@type":"SportsEvent"' not in text:
            problems.append(f"{canonical}: SportsEvent ausente")
        if '"@type":"BreadcrumbList"' not in text:
            problems.append(f"{canonical}: BreadcrumbList ausente")
        home = team_name(game, "mandante")
        away = team_name(game, "visitante")
        if f'/clube/{slugify(home)}/' not in text or f'/clube/{slugify(away)}/' not in text:
            problems.append(f"{canonical}: link de clube ausente")
        if game.get("concluido"):
            # Regra anti-alucinação: uma página antiga sem snapshot não pode afirmar
            # que reconstruiu probabilidade inexistente.
            if "probabilidades pré-jogo preservadas" not in text.lower():
                problems.append(f"{canonical}: seção histórica ausente")
    if problems:
        raise AssertionError("ORG-5 validação falhou:\n" + "\n".join(problems[:50]))

    tree = ET.parse(site_dir / "sitemap.xml")
    urls = [
        (node.text or "").strip()
        for node in tree.getroot().findall(f"{{{NS}}}url/{{{NS}}}loc")
    ]
    sitemap_games = {u for u in urls if u.startswith(SITE + "/jogo/")}
    if sitemap_games != set(canonicals):
        missing = sorted(set(canonicals) - sitemap_games)[:5]
        extra = sorted(sitemap_games - set(canonicals))[:5]
        raise AssertionError(f"ORG-5 sitemap divergente; missing={missing}, extra={extra}")


def build(site_dir: Path, *, check: bool) -> dict[str, Any]:
    data = site_dir / "dados-br"
    calendar_manifest = load(data / "calendario-completo.json", {})
    result_manifest = load(site_dir / "resultados.json", {})
    details_manifest = load(data / "jogos-detalhes.json", {})
    current_prob_manifest = load(data / "probabilidades-jogos.json", {})
    history_manifest = load(data / "historico-probabilidades-jogos.json", {})
    tv_manifest = load(data / "transmissoes-tv.json", {})
    clubs_manifest = load(data / "clubes.json", {})
    table_manifest = load(site_dir / "tabela.json", {})
    br_prob_manifest = load(data / "probabilidades-brasileirao.json", {})
    ranking_manifest = load(data / "ranking-desempenho.json", {})

    calendar = calendar_manifest.get("jogos") or []
    results = result_manifest.get("resultados") or []
    details_map = details_manifest.get("jogos") or {}
    current_probs = current_prob_manifest.get("jogos") or []
    history = history_manifest.get("previsoes") or []
    tv_map = tv_manifest.get("jogos") or {}
    clubs = clubs_manifest.get("clubes") or []
    table = table_manifest.get("tabela") or []
    br_probs = br_prob_manifest.get("clubes") or []
    ranking = ranking_manifest.get("ranking") or []

    update_candidates = []
    for manifest in (calendar_manifest, result_manifest, details_manifest, current_prob_manifest, history_manifest, tv_manifest, clubs_manifest, table_manifest, br_prob_manifest, ranking_manifest):
        if not isinstance(manifest, dict):
            continue
        for field in ("atualizado_em", "gerado_em", "calculado_em", "atualizado_em_br"):
            value = parse_dt(manifest.get(field))
            if value:
                update_candidates.append(value)
                break
    updated_at = max(update_candidates).isoformat() if update_candidates else datetime.now(FUSO_BR).replace(microsecond=0).isoformat()

    if len(calendar) != 380:
        raise SystemExit(f"ORG-5 ERRO: calendário esperado com 380 partidas; recebido {len(calendar)}")

    confirmed = [g for g in calendar if confirmed_game_url(g)]
    if not confirmed:
        raise SystemExit("ORG-5 ERRO: nenhuma partida com data confirmada")

    result_map = {normalize_event_id(g.get("event_id")): g for g in results}
    current_prob_map = {normalize_event_id(g.get("event_id")): g for g in current_probs}
    history_map: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in history:
        eid = normalize_event_id(item.get("event_id"))
        if eid:
            history_map[eid].append(item)
    club_map = {str(c.get("nome") or "").strip(): c for c in clubs}
    table_map = {str(c.get("time") or "").strip(): c for c in table}
    br_prob_map = {str(c.get("clube") or "").strip(): c for c in br_probs}
    rank_map = {str(c.get("time") or "").strip(): c for c in ranking}

    related_index: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for g in confirmed:
        related_index[team_name(g, "mandante")].append(g)
        related_index[team_name(g, "visitante")].append(g)
    for values in related_index.values():
        values.sort(key=lambda g: (date_key(g.get("data_iso")), int(g.get("rodada") or 0)))

    root = site_dir / "jogo"
    root.mkdir(parents=True, exist_ok=True)
    wanted_dirs: set[str] = set()
    canonicals: list[str] = []
    historical_safe = 0
    completed_count = 0
    upcoming_count = 0

    for game in confirmed:
        eid = normalize_event_id(game.get("event_id"))
        result = result_map.get(eid) or {}
        completed = bool(game.get("concluido") or result)
        if completed:
            completed_count += 1
        else:
            upcoming_count += 1
        kickoff = parse_dt(game.get("data_iso"))
        historical_pred = latest_safe_prediction(history_map.get(eid, []), kickoff) if completed else {}
        if historical_pred:
            historical_safe += 1
        current_pred = current_prob_map.get(eid) or {}
        home = team_name(game, "mandante")
        away = team_name(game, "visitante")
        related = [
            g for g in (related_index.get(home, []) + related_index.get(away, []))
            if normalize_event_id(g.get("event_id")) != eid
        ]
        # Deduplica porque um confronto entre os mesmos dois clubes aparece nas duas listas.
        unique_related: dict[str, dict[str, Any]] = {}
        for item in related:
            unique_related[normalize_event_id(item.get("event_id"))] = item
        def related_key(item: dict[str, Any]) -> tuple[float, str]:
            moment = parse_dt(item.get("data_iso"))
            distance = abs((moment - kickoff).total_seconds()) if moment and kickoff else float("inf")
            return distance, date_key(item.get("data_iso"))

        ordered_related = sorted(unique_related.values(), key=related_key)
        slug, canonical, page = render_page(
            game,
            result=result,
            details=details_map.get(eid) or {},
            current_pred=current_pred,
            historical_pred=historical_pred,
            tv=tv_map.get(eid) or {},
            club_map=club_map,
            table_map=table_map,
            prob_map=br_prob_map,
            rank_map=rank_map,
            related=ordered_related,
            updated_at=updated_at,
        )
        target = root / slug
        target.mkdir(parents=True, exist_ok=True)
        (target / "index.html").write_text(page, encoding="utf-8")
        wanted_dirs.add(slug)
        canonicals.append(canonical)

    # Como _site é recriado a cada deploy, isto normalmente não remove nada; a
    # limpeza garante idempotência também em execução local repetida.
    for child in root.iterdir():
        if child.is_dir() and child.name not in wanted_dirs:
            import shutil
            shutil.rmtree(child)

    source_date = date_key(calendar_manifest.get("gerado_em")) or datetime.now(FUSO_BR).strftime("%Y-%m-%d")
    update_sitemap(site_dir, canonicals, source_date)
    validate(site_dir, confirmed, canonicals)

    if check:
        print(
            "ORG-5 PASS: "
            f"{len(canonicals)} páginas de jogo, {completed_count} concluídas, "
            f"{upcoming_count} futuras, {historical_safe} concluídas com snapshot pré-jogo seguro, sitemap e SEO validados"
        )
        print("ORG-5 CHECK PASS")
    return {
        "pages": len(canonicals),
        "completed": completed_count,
        "upcoming": upcoming_count,
        "historical_safe": historical_safe,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="ORG-5 — páginas estáticas de partidas do Brasileirão")
    parser.add_argument("--site-root", dest="site_root")
    parser.add_argument("--site-dir", dest="site_dir")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    raw = args.site_root or args.site_dir or "_site"
    site_dir = Path(raw).resolve()
    if not site_dir.is_dir():
        raise SystemExit(f"ORG-5 ERRO: diretório do site ausente: {site_dir}")
    build(site_dir, check=args.check)


if __name__ == "__main__":
    main()
