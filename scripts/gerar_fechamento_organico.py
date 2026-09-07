#!/usr/bin/env python3
"""ORG-7: fechamento da arquitetura orgânica do Fórmula do Gol.

Objetivos estritamente editoriais/SEO:
- criar um arquivo estático e indexável de partidas do Brasileirão, garantindo
  linkagem interna para todas as páginas /jogo/ com data confirmada;
- acrescentar links estruturais de clubes e do arquivo ao hub do Brasileirão;
- manter o sitemap sincronizado sem inventar datas ou partidas;
- não tocar em Push, AF-Previsão, AF-Score ou dados esportivos.
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
ARCHIVE_URL = f"{SITE}/brasileirao-jogos.html"
LEGACY_ARCHIVE_URL = f"{SITE}/brasileirao/jogos/"


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


def team_name(game: dict[str, Any], side: str) -> str:
    value = game.get(side)
    if isinstance(value, dict):
        return str(value.get("nome") or value.get("name") or "").strip()
    return str(value or "").strip()


def game_url(game: dict[str, Any]) -> str:
    if game.get("data_definir"):
        return ""
    dt = parse_dt(game.get("data_iso"))
    home = team_name(game, "mandante")
    away = team_name(game, "visitante")
    if not dt or not home or not away:
        return ""
    return f"/jogo/{slugify(home)}-x-{slugify(away)}-{dt:%Y-%m-%d}/"


def fmt_date(raw: Any) -> str:
    dt = parse_dt(raw)
    return dt.strftime("%d/%m/%Y · %H:%M") if dt else "Data a definir"


def result_score(result: dict[str, Any]) -> tuple[str, str] | None:
    # O manifesto público usa placar_mandante/visitante; mantém fallbacks
    # apenas para compatibilidade com snapshots antigos já publicados.
    keys = [
        ("placar_mandante", "placar_visitante"),
        ("gols_mandante", "gols_visitante"),
        ("home_score", "away_score"),
    ]
    for hk, ak in keys:
        if result.get(hk) is not None and result.get(ak) is not None:
            return str(result.get(hk)), str(result.get(ak))
    return None


def source_date(calendar_manifest: dict[str, Any]) -> str:
    for field in ("atualizado_em", "gerado_em", "atualizado_em_br"):
        dt = parse_dt(calendar_manifest.get(field))
        if dt:
            return dt.strftime("%Y-%m-%d")
    # fallback determinístico a partir da data mais recente das partidas;
    # não usa a data do deploy para evitar sinal artificial de frescor.
    dates = [parse_dt(g.get("data_iso")) for g in (calendar_manifest.get("jogos") or [])]
    dates = [d for d in dates if d]
    return max(dates).strftime("%Y-%m-%d") if dates else "2026-01-01"


def nav() -> str:
    return '''<nav class="nav" data-br-auth-menu aria-label="Menu principal"><a href="/estatisticas.html">📈 Estatísticas</a><a href="/jogos">⚽ Jogos</a><a href="/aovivo.html">🔴 Ao vivo</a><a href="/tabela">📊 Tabela</a><a href="/resultados">✅ Resultados</a><a href="/analises/">📰 Análises</a><a href="/clubes.html">🛡️ Clubes</a><a href="/museu.html">🏛️ Museu</a><a href="/copa2026/">🌎 Copa 2026</a></nav>'''


def render_archive(site: Path, calendar_manifest: dict[str, Any], results_manifest: dict[str, Any]) -> tuple[str, int]:
    games = calendar_manifest.get("jogos") or []
    confirmed = [g for g in games if game_url(g)]
    if len(games) != 380:
        raise AssertionError(f"ORG-7: calendário divergente; esperado 380, recebido {len(games)}")
    if not confirmed:
        raise AssertionError("ORG-7: nenhuma partida com data confirmada")

    results = results_manifest.get("resultados") or []
    result_map = {str(r.get("event_id") or "").strip(): r for r in results}
    groups: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for game in confirmed:
        groups[int(game.get("rodada") or 0)].append(game)
    for row in groups.values():
        row.sort(key=lambda g: (parse_dt(g.get("data_iso")) or datetime.max.replace(tzinfo=FUSO_BR), team_name(g, "mandante")))

    now = datetime.now(FUSO_BR)
    future_rounds = [int(g.get("rodada") or 0) for g in confirmed if (parse_dt(g.get("data_iso")) or now) >= now]
    focus_round = min(future_rounds) if future_rounds else max(groups)
    sections = []
    for rnd in sorted(groups):
        cards = []
        for game in groups[rnd]:
            home, away = team_name(game, "mandante"), team_name(game, "visitante")
            url = game_url(game)
            eid = str(game.get("event_id") or "").strip()
            result = result_map.get(eid) or {}
            score = result_score(result)
            status = f"{score[0]} × {score[1]} · Final" if score else "Pré-jogo"
            cards.append(f'''<article class="org7-match">
<a class="org7-match-main" href="{esc(url)}" aria-label="Abrir {esc(home)} x {esc(away)}">
<span class="org7-date">{esc(fmt_date(game.get('data_iso')))}</span>
<span class="org7-teams"><strong>{esc(home)}</strong><b>{esc(status)}</b><strong>{esc(away)}</strong></span>
</a>
<div class="org7-team-links"><a href="/clube/{slugify(home)}/">{esc(home)}</a><span>·</span><a href="/clube/{slugify(away)}/">{esc(away)}</a></div>
</article>''')
        open_attr = " open" if rnd == focus_round else ""
        sections.append(f'''<details class="org7-round"{open_attr}><summary><span>Rodada {rnd}</span><small>{len(cards)} partidas</small></summary><div class="org7-match-grid">{''.join(cards)}</div></details>''')

    lastmod = source_date(calendar_manifest)
    title = "Jogos do Brasileirão 2026: arquivo completo | Fórmula do Gol"
    desc = f"Arquivo das {len(confirmed)} partidas do Brasileirão 2026 com data confirmada, resultados e links para análises individuais e páginas dos clubes."
    schema = {
        "@context": "https://schema.org",
        "@graph": [
            {"@type": "CollectionPage", "@id": ARCHIVE_URL + "#page", "url": ARCHIVE_URL, "name": "Jogos do Brasileirão 2026", "description": desc, "inLanguage": "pt-BR", "isPartOf": {"@id": SITE + "/#website"}},
            {"@type": "BreadcrumbList", "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": "Fórmula do Gol", "item": SITE + "/"},
                {"@type": "ListItem", "position": 2, "name": "Brasileirão", "item": SITE + "/brasileirao/"},
                {"@type": "ListItem", "position": 3, "name": "Jogos", "item": ARCHIVE_URL},
            ]},
        ],
    }
    page = f'''<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{esc(title)}</title><meta name="description" content="{esc(desc)}"><meta name="robots" content="index,follow,max-image-preview:large"><link rel="canonical" href="{ARCHIVE_URL}"><meta property="og:type" content="website"><meta property="og:title" content="Jogos do Brasileirão 2026"><meta property="og:description" content="{esc(desc)}"><meta property="og:url" content="{ARCHIVE_URL}"><meta property="og:image" content="{SITE}/og-image-formula-do-gol-v2.jpg"><meta name="twitter:card" content="summary_large_image"><meta name="theme-color" content="#10b981"><link rel="stylesheet" href="/css/br-institucional.css?v=20260722-evolucao-af-score-v1"><link rel="stylesheet" href="/css/br-global.css?v=20260801-footer-institucional-v1"><link rel="stylesheet" href="/css/br-arquivo-jogos.css?v=20260907-org7-v1"><script async src="https://www.googletagmanager.com/gtag/js?id=G-3956SD5HFC"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){{dataLayer.push(arguments)}}gtag('js',new Date());gtag('config','G-3956SD5HFC',{{page_title:{json.dumps(title,ensure_ascii=False)},page_location:{json.dumps(ARCHIVE_URL)},page_path:'/brasileirao/jogos/'}});</script><script type="application/ld+json">{json.dumps(schema,ensure_ascii=False,separators=(',',':'))}</script></head><body><div class="container"><header class="hero"><img src="/img/header-formula-do-gol-v2.png" alt="Fórmula do Gol — A matemática por trás do futebol" fetchpriority="high"></header>{nav()}<main class="org7-page"><nav class="org7-breadcrumb" aria-label="Navegação estrutural"><a href="/">Fórmula do Gol</a><span>›</span><a href="/brasileirao/">Brasileirão</a><span>›</span><span>Jogos</span></nav><section class="org7-hero"><div class="org7-kicker">BRASILEIRÃO 2026</div><h1>Arquivo de jogos do Brasileirão 2026</h1><p>{esc(desc)}</p><div class="org7-actions"><a href="/brasileirao/">Probabilidades do campeonato</a><a href="/tabela">Tabela</a><a href="/resultados">Resultados</a><a href="/clubes.html">Clubes</a></div><div class="org7-updated">Calendário atualizado em {lastmod[8:10]}/{lastmod[5:7]}/{lastmod[:4]} · {len(confirmed)} partidas com data confirmada</div></section><section class="org7-index"><div class="org7-section-head"><div><div class="org7-kicker">RODADA A RODADA</div><h2>Todas as partidas com URL individual</h2></div></div>{''.join(sections)}</section></main><footer class="site-footer br-disclaimer"><nav class="br-footer-links"><a href="/sobre.html">ⓘ Sobre o Fórmula do Gol</a></nav><div class="br-footer-copy">Fórmula do Gol — site independente, informativo e sem fins lucrativos. Dados esportivos organizados a partir de fontes públicas; modelos, projeções e apresentação são próprios.</div></footer></div><script src="/js/br-menu.js?v=20260901-alertas-v1"></script></body></html>'''
    # ORG-7R: URL canônica em arquivo HTML de raiz. Isso elimina dependência
    # de resolução de diretório entre GitHub Pages e a camada Cloudflare.
    (site / "brasileirao-jogos.html").write_text(page, encoding="utf-8")

    # Mantém a rota anterior somente como alias de compatibilidade, fora do sitemap.
    legacy_target = site / "brasileirao" / "jogos"
    legacy_target.mkdir(parents=True, exist_ok=True)
    legacy_page = (
        '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="robots" content="noindex,follow">'
        f'<link rel="canonical" href="{ARCHIVE_URL}">'
        '<meta http-equiv="refresh" content="0;url=/brasileirao-jogos.html">'
        '<title>Jogos do Brasileirão 2026 | Fórmula do Gol</title></head>'
        '<body><p><a href="/brasileirao-jogos.html">Abrir arquivo de jogos do Brasileirão 2026</a></p></body></html>'
    )
    (legacy_target / "index.html").write_text(legacy_page, encoding="utf-8")
    return lastmod, len(confirmed)


def patch_brasileirao_hub(site: Path) -> None:
    path = site / "brasileirao" / "index.html"
    text = path.read_text(encoding="utf-8")
    if 'href="/brasileirao-jogos.html"' not in text:
        marker = '<a class="org6-btn" href="/jogos">Jogos</a>'
        replacement = marker + '<a class="org6-btn" href="/brasileirao-jogos.html">Arquivo de partidas</a>'
        if marker not in text:
            raise AssertionError("ORG-7: botão Jogos não encontrado no hub do Brasileirão")
        text = text.replace(marker, replacement, 1)
    # Torna os nomes dos cards caminhos reais para as páginas dos clubes.
    def link_card_name(match: re.Match[str]) -> str:
        name = html.unescape(match.group(1))
        return f'<strong><a class="org7-club-link" href="/clube/{slugify(name)}/">{match.group(1)}</a></strong>'
    text = re.sub(r'<strong>([^<]+)</strong><span class="accent">', lambda m: link_card_name(m) + '<span class="accent">', text)
    path.write_text(text, encoding="utf-8")


def update_sitemap(site: Path, lastmod: str) -> None:
    path = site / "sitemap.xml"
    ET.register_namespace("", NS)
    tree = ET.parse(path)
    root = tree.getroot()
    nodes = root.findall(f"{{{NS}}}url")
    existing = {(n.findtext(f"{{{NS}}}loc") or "").strip(): n for n in nodes}
    if LEGACY_ARCHIVE_URL in existing:
        root.remove(existing[LEGACY_ARCHIVE_URL])
        existing.pop(LEGACY_ARCHIVE_URL, None)
    if ARCHIVE_URL not in existing:
        node = ET.SubElement(root, f"{{{NS}}}url")
        ET.SubElement(node, f"{{{NS}}}loc").text = ARCHIVE_URL
        ET.SubElement(node, f"{{{NS}}}lastmod").text = lastmod
    else:
        lm = existing[ARCHIVE_URL].find(f"{{{NS}}}lastmod")
        if lm is None:
            lm = ET.SubElement(existing[ARCHIVE_URL], f"{{{NS}}}lastmod")
        lm.text = lastmod
    tree.write(path, encoding="utf-8", xml_declaration=True)


def validate(site: Path, expected_games: int) -> None:
    archive = site / "brasileirao-jogos.html"
    text = archive.read_text(encoding="utf-8")
    if text.count("<h1") != 1:
        raise AssertionError("ORG-7: arquivo de jogos sem H1 único")
    for required in (ARCHIVE_URL, "max-image-preview:large", '"@type":"CollectionPage"', '"@type":"BreadcrumbList"'):
        if required not in text:
            raise AssertionError(f"ORG-7: arquivo de jogos sem {required}")
    links = set(re.findall(r'href="(/jogo/[^"#?]+/)"', text))
    actual_pages = {"/" + str(p.relative_to(site)).replace("\\", "/").removesuffix("index.html") for p in (site / "jogo").glob("*/index.html")}
    if links != actual_pages:
        missing = sorted(actual_pages - links)[:10]
        extra = sorted(links - actual_pages)[:10]
        raise AssertionError(f"ORG-7: arquivo não cobre todas as páginas de jogo; missing={missing}, extra={extra}")
    if len(links) != expected_games:
        raise AssertionError(f"ORG-7: esperado {expected_games} links de jogo; recebido {len(links)}")
    hub = (site / "brasileirao" / "index.html").read_text(encoding="utf-8")
    if 'href="/brasileirao-jogos.html"' not in hub:
        raise AssertionError("ORG-7: hub do Brasileirão não aponta para arquivo")
    club_links = set(re.findall(r'href="(/clube/[^"#?]+/)"', hub))
    if len(club_links) < 8:
        raise AssertionError(f"ORG-7: linkagem de clubes no hub insuficiente: {len(club_links)}")
    sitemap = ET.parse(site / "sitemap.xml").getroot()
    urls = [(n.text or "").strip() for n in sitemap.findall(f"{{{NS}}}url/{{{NS}}}loc")]
    if urls.count(ARCHIVE_URL) != 1:
        raise AssertionError("ORG-7R: arquivo canônico deve aparecer exatamente uma vez no sitemap")
    if LEGACY_ARCHIVE_URL in urls:
        raise AssertionError("ORG-7R: rota antiga não deve permanecer no sitemap")


def build(site: Path, *, check: bool) -> dict[str, int]:
    calendar = load(site / "dados-br" / "calendario-completo.json", {})
    results = load(site / "resultados.json", {})
    lastmod, count = render_archive(site, calendar, results)
    patch_brasileirao_hub(site)
    update_sitemap(site, lastmod)
    validate(site, count)
    if check:
        print(f"ORG-7 PASS: arquivo orgânico com {count} partidas, linkagem interna integral e sitemap sincronizado")
        print("ORG-7 CHECK PASS")
    return {"games": count}


def main() -> None:
    parser = argparse.ArgumentParser(description="ORG-7 — fechamento orgânico e arquivo de partidas")
    parser.add_argument("--site-root", dest="site_root")
    parser.add_argument("--site-dir", dest="site_dir")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    site = Path(args.site_root or args.site_dir or "_site").resolve()
    if not site.is_dir():
        raise SystemExit(f"ORG-7 ERRO: diretório do site ausente: {site}")
    build(site, check=args.check)


if __name__ == "__main__":
    main()
