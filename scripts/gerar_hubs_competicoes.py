#!/usr/bin/env python3
"""ORG-6: hubs orgânicos de competições + expansão editorial/Discover.

Também valida o retorno dos mascotes às 20 páginas de clubes. O script opera
somente sobre o artefato público (_site): não recalcula AF-Previsão/AF-Score.
"""
from __future__ import annotations

import argparse
import html
import json
import re
import textwrap
import unicodedata
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

SITE = "https://formuladogol.com.br"
NS = "http://www.sitemaps.org/schemas/sitemap/0.9"
FUSO_BR = timezone(timedelta(hours=-3))
HUBS = {
    "/competicoes/": ("Competições de futebol acompanhadas | Fórmula do Gol", 0.82),
    "/brasileirao/": ("Brasileirão 2026: chances e projeções | Fórmula do Gol", 0.92),
    "/copa-do-brasil/": ("Copa do Brasil 2026: fase e classificados | Fórmula do Gol", 0.86),
    "/libertadores/": ("Libertadores 2026: brasileiros e quartas | Fórmula do Gol", 0.86),
    "/sul-americana/": ("Sul-Americana 2026: brasileiros e quartas | Fórmula do Gol", 0.86),
}


def load(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def esc(v: Any) -> str:
    return html.escape(str(v if v is not None else ""), quote=True)


def slugify(v: Any) -> str:
    s = unicodedata.normalize("NFKD", str(v or "")).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()


def parse_dt(v: Any) -> datetime | None:
    s = str(v or "").strip()
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=FUSO_BR)
    return d.astimezone(FUSO_BR)


def source_date(*payloads: Any) -> str:
    vals: list[datetime] = []
    for p in payloads:
        if isinstance(p, dict):
            for k in ("atualizado_em", "gerado_em", "calculado_em", "referencia_esportiva_em", "modificado_em"):
                d = parse_dt(p.get(k))
                if d:
                    vals.append(d); break
    return max(vals).date().isoformat() if vals else "2026-09-07"


def fmt_date(v: Any, with_time: bool = False) -> str:
    d = parse_dt(v)
    if not d:
        return "Data a confirmar"
    return d.strftime("%d/%m/%Y · %H:%M" if with_time else "%d/%m/%Y")


def pct_detail(club: dict[str, Any], key: str) -> str:
    detail = (club.get("probabilidades_detalhes") or {}).get(key) or {}
    if detail.get("exibicao"):
        return str(detail["exibicao"])
    try:
        n = float((club.get("probabilidades_pct") or {}).get(key))
    except (TypeError, ValueError):
        return "—"
    if n == 0: return "0%"
    if 0 < n < .001: return "<0,001%"
    return f"{n:.1f}%".replace(".", ",")


def shield_map(clubs: list[dict[str, Any]]) -> dict[str, str]:
    return {str(c.get("nome") or ""): str(c.get("escudo") or "/img/escudo-neutro.svg") for c in clubs}


def club_chips(names: list[str], shields: dict[str, str]) -> str:
    if not names:
        return '<div class="org6-empty">Nenhum clube da Série A 2026 está identificado neste recorte.</div>'
    return "".join(
        f'<a class="org6-club" href="/clube/{slugify(n)}/"><img src="{esc(shields.get(n, "/img/escudo-neutro.svg"))}" alt="" loading="lazy"><span>{esc(n)}</span></a>'
        for n in sorted(dict.fromkeys(names), key=str.casefold)
    )


def current_phase_clubs(payload: dict[str, Any], serie_a_names: set[str]) -> list[str]:
    phase = payload.get("fase_atual") or {}
    order = phase.get("ordem")
    events = [e for e in (payload.get("eventos") or []) if e.get("fase_ordem") == order]
    if phase.get("status") != "encerrada":
        out = []
        for e in events:
            for side in ("mandante", "visitante"):
                t = e.get(side) or {}
                n = str(t.get("nome") or "")
                if n in serie_a_names:
                    out.append(n)
        return sorted(set(out), key=str.casefold)

    # Fase encerrada: agrega ida/volta para identificar quem segue vivo.
    pairs: dict[tuple[str, str], dict[str, Any]] = {}
    for e in events:
        a = str((e.get("mandante") or {}).get("nome") or "")
        b = str((e.get("visitante") or {}).get("nome") or "")
        if not a or not b: continue
        key = tuple(sorted((a,b)))
        row = pairs.setdefault(key, {a: 0, b: 0, "winners": []})
        try: row[a] += int((e.get("mandante") or {}).get("placar") or 0)
        except Exception: pass
        try: row[b] += int((e.get("visitante") or {}).get("placar") or 0)
        except Exception: pass
        if e.get("vencedor"): row["winners"].append(str(e["vencedor"]))
    winners = []
    for (a,b), row in pairs.items():
        if row[a] > row[b]: w = a
        elif row[b] > row[a]: w = b
        elif row["winners"]: w = row["winners"][-1]
        else: continue
        if w in serie_a_names: winners.append(w)
    return sorted(set(winners), key=str.casefold)


def phase_matches(payload: dict[str, Any], limit: int = 8) -> str:
    phase = payload.get("fase_atual") or {}
    order = phase.get("ordem")
    events = [e for e in (payload.get("eventos") or []) if e.get("fase_ordem") == order and not e.get("concluido")]
    events.sort(key=lambda e: str(e.get("data_iso") or ""))
    cards=[]
    for e in events[:limit]:
        h=str((e.get("mandante") or {}).get("nome") or "")
        a=str((e.get("visitante") or {}).get("nome") or "")
        if h.startswith("TBD") or a.startswith("TBD"): continue
        cards.append(f'<article class="org6-match"><small>{esc(fmt_date(e.get("data_iso"), True))} · {esc(e.get("estadio") or "Estádio a confirmar")}</small><strong>{esc(h)} × {esc(a)}</strong></article>')
    return "".join(cards) or '<div class="org6-empty">Não há partida futura com adversários definidos neste estágio da fonte atual.</div>'


def article_matches(articles: list[dict[str, Any]], kind: str) -> list[dict[str, Any]]:
    out=[]
    for a in articles:
        t=str(a.get("tipo") or "")
        blob=json.dumps(a,ensure_ascii=False).casefold()
        if kind=="brasileirao" and t=="brasileirao_rodada": out.append(a)
        elif kind=="copa" and (t=="copa_do_brasil_fase" or "copa do brasil" in blob): out.append(a)
        elif kind in {"libertadores","sul"} and ("continentais" in t or kind.replace("sul","sul-americana") in blob): out.append(a)
    out.sort(key=lambda a: str(a.get("publicado_em") or ""), reverse=True)
    return out[:4]


def articles_html(articles: list[dict[str, Any]]) -> str:
    if not articles: return '<div class="org6-empty">Ainda não há editorial publicado para este recorte.</div>'
    return "".join(
        f'<article class="org6-article"><small>{esc(a.get("categoria") or "ANÁLISE")} · {esc(fmt_date(a.get("publicado_em")))}</small><a href="/analises/{esc(a.get("slug") or "")}">{esc(a.get("titulo") or "Análise")}</a><p>{esc(a.get("linha_fina") or "")}</p></article>'
        for a in articles
    )


def nav() -> str:
    return '''<nav class="nav" data-br-auth-menu aria-label="Menu principal"><a href="/estatisticas.html">📈 Estatísticas</a><a href="/jogos">⚽ Jogos</a><a href="/aovivo.html">🔴 Ao vivo</a><a href="/tabela">📊 Tabela</a><a href="/resultados">✅ Resultados</a><a href="/analises/">📰 Análises</a><a href="/clubes.html">🛡️ Clubes</a><a href="/museu.html">🏛️ Museu</a><a href="/copa2026/">🌎 Copa 2026</a></nav>'''


def topic_nav(active: str = "") -> str:
    links=[("competicoes","/competicoes/","Competições"),("brasileirao","/brasileirao/","Brasileirão"),("copa","/copa-do-brasil/","Copa do Brasil"),("libertadores","/libertadores/","Libertadores"),("sul","/sul-americana/","Sul-Americana")]
    return '<nav class="org6-topic-nav" aria-label="Competições acompanhadas">'+''.join(f'<a href="{u}"'+(' class="active" aria-current="page"' if k==active else '')+f'>{esc(l)}</a>' for k,u,l in links)+'</nav>'


def jsonld(title: str, description: str, canonical: str, crumb: str) -> str:
    obj={"@context":"https://schema.org","@graph":[
        {"@type":"CollectionPage","@id":canonical+"#page","url":canonical,"name":title.replace(" | Fórmula do Gol",""),"description":description,"inLanguage":"pt-BR","isPartOf":{"@id":SITE+"/#website"}},
        {"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Fórmula do Gol","item":SITE+"/"},{"@type":"ListItem","position":2,"name":"Competições","item":SITE+"/competicoes/"},{"@type":"ListItem","position":3,"name":crumb,"item":canonical}]}
    ]}
    return json.dumps(obj,ensure_ascii=False,separators=(",",":"))


def shell(title: str, description: str, route: str, crumb: str, body: str, updated: str, active: str) -> str:
    canonical=SITE+route
    return f'''<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{esc(title)}</title><meta name="description" content="{esc(description)}"><meta name="robots" content="index,follow,max-image-preview:large"><link rel="canonical" href="{canonical}"><meta property="og:type" content="website"><meta property="og:title" content="{esc(title.replace(' | Fórmula do Gol',''))}"><meta property="og:description" content="{esc(description)}"><meta property="og:url" content="{canonical}"><meta property="og:image" content="{SITE}/og-image-formula-do-gol-v2.jpg"><meta name="twitter:card" content="summary_large_image"><meta name="theme-color" content="#10b981"><link rel="stylesheet" href="/css/br-institucional.css?v=20260722-evolucao-af-score-v1"><link rel="stylesheet" href="/css/br-global.css?v=20260801-footer-institucional-v1"><link rel="stylesheet" href="/css/br-competicoes.css?v=20260907-org6-v1"><script async src="https://www.googletagmanager.com/gtag/js?id=G-3956SD5HFC"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){{dataLayer.push(arguments)}}gtag('js',new Date());gtag('config','G-3956SD5HFC',{{page_title:{json.dumps(title,ensure_ascii=False)},page_location:{json.dumps(canonical)},page_path:{json.dumps(route)}}});</script><script type="application/ld+json">{jsonld(title,description,canonical,crumb)}</script></head><body><div class="container"><header class="hero"><img src="/img/header-formula-do-gol-v2.png" alt="Fórmula do Gol — A matemática por trás do futebol" fetchpriority="high"></header>{nav()}<main class="org6-page"><nav class="org6-breadcrumb" aria-label="Navegação estrutural"><a href="/">Fórmula do Gol</a><span>›</span><a href="/competicoes/">Competições</a><span>›</span><span>{esc(crumb)}</span></nav>{topic_nav(active)}{body}</main><footer class="site-footer br-disclaimer"><nav class="br-footer-links"><a href="/sobre.html">ⓘ Sobre o Fórmula do Gol</a></nav><div class="br-footer-copy">Fórmula do Gol — site independente, informativo e sem fins lucrativos. Dados esportivos organizados a partir de fontes públicas; modelos, projeções e apresentação são próprios.</div></footer></div><script src="/js/br-menu.js?v=20260901-alertas-v1"></script></body></html>'''


def render_comp_index(comp_payloads: dict[str,dict[str,Any]], br: dict[str,Any], analyses: list[dict[str,Any]]) -> str:
    rows=[]
    rows.append(("Brasileirão 2026","/brasileirao/","temporada em andamento",f"{len(br.get('clubes') or [])} clubes · AF-Previsão com {((br.get('simulacao') or {}).get('simulacoes') or 2000000):,} universos".replace(",","."),""))
    for key,url,label in [("copa","/copa-do-brasil/","Copa do Brasil"),("libertadores","/libertadores/","Libertadores"),("sul","/sul-americana/","Sul-Americana")]:
        p=comp_payloads[key]; phase=p.get("fase_atual") or {}; summary=p.get("resumo") or {}
        rows.append((label,url,str(phase.get("nome") or "fase atual"),f"{summary.get('finalizados',0)} jogos finalizados · {summary.get('pendentes',0)} pendentes","closed" if phase.get("status")=="encerrada" else ""))
    rows.append(("Copa do Mundo 2026","/copa2026/","módulo próprio","Agenda, seleções, estádios, estatísticas e acompanhamento ao vivo",""))
    cards=''.join(f'<a class="org6-comp-card" href="{u}"><h3>{esc(n)}</h3><span class="org6-status {c}">{esc(st)}</span><p>{esc(desc)}</p></a>' for n,u,st,desc,c in rows)
    latest=articles_html(sorted(analyses,key=lambda a:str(a.get("publicado_em") or ""),reverse=True)[:4])
    return f'''<section class="org6-hero"><div class="org6-kicker">HUB DE COMPETIÇÕES</div><h1>Competições acompanhadas pelo Fórmula do Gol</h1><p class="org6-deck">Acesso direto aos recortes esportivos que alimentam o AF-Previsão e o conteúdo editorial: Brasileirão, Copa do Brasil, Libertadores, Sul-Americana e o módulo da Copa 2026.</p><div class="org6-updated">Dados atualizados a partir das fontes esportivas do próprio projeto.</div></section><section class="org6-section"><div class="org6-section-head"><div><div class="org6-kicker">ACESSO DIRETO</div><h2>Escolha a competição</h2></div></div><div class="org6-comp-grid">{cards}</div></section><section class="org6-section"><div class="org6-section-head"><div><div class="org6-kicker">EDITORIAL</div><h2>Análises mais recentes</h2></div><a class="org6-btn" href="/analises/">Todas as análises</a></div><div class="org6-articles">{latest}</div></section>'''


def render_brasileirao(br: dict[str,Any], table: dict[str,Any], analyses: list[dict[str,Any]], shields: dict[str,str]) -> str:
    clubs=br.get("clubes") or []
    title_sorted=sorted(clubs,key=lambda c:float((c.get("probabilidades_pct") or {}).get("campeao") or 0),reverse=True)[:5]
    releg_sorted=sorted(clubs,key=lambda c:float((c.get("probabilidades_pct") or {}).get("rebaixamento") or 0),reverse=True)[:4]
    cards=''.join(f'<article class="org6-card"><small>{i}º candidato ao título</small><strong>{esc(c.get("clube"))}</strong><span class="accent">{esc(pct_detail(c,"campeao"))}</span><span>Proj. {esc(c.get("posicao_classificacao_projetada") or c.get("posicao_projetada"))}º · {esc((c.get("pontos_projetados") or {}).get("media") if isinstance(c.get("pontos_projetados"),dict) else c.get("pontos_projetados"))} pts</span></article>' for i,c in enumerate(title_sorted,1))
    risk=''.join(f'<article class="org6-card"><small>Risco de rebaixamento</small><strong>{esc(c.get("clube"))}</strong><span class="accent">{esc(pct_detail(c,"rebaixamento"))}</span></article>' for c in releg_sorted)
    sim=(br.get("simulacao") or {}).get("simulacoes") or 2000000
    return f'''<section class="org6-hero"><div class="org6-kicker">BRASILEIRÃO 2026</div><h1>Probabilidades e projeções do Brasileirão 2026</h1><p class="org6-deck">Retrato atual da Série A a partir do AF-Previsão. As probabilidades exibidas são as mesmas publicadas nas páginas dos clubes; este hub apenas organiza o recorte por competição.</p><div class="org6-actions"><a class="org6-btn primary" href="/tabela">Tabela</a><a class="org6-btn" href="/jogos">Jogos</a><a class="org6-btn" href="/resultados">Resultados</a><a class="org6-btn" href="/clubes.html">Clubes</a></div><div class="org6-updated">Atualizado em {esc(fmt_date(br.get('gerado_em')))} · {int(sim):,} simulações por atualização</div></section><section class="org6-section"><div class="org6-section-head"><div><div class="org6-kicker">TÍTULO</div><h2>Quem aparece na frente nas simulações</h2></div></div><div class="org6-grid">{cards}</div></section><section class="org6-section"><div class="org6-section-head"><div><div class="org6-kicker">PERMANÊNCIA</div><h2>Maiores riscos de rebaixamento</h2></div></div><div class="org6-grid">{risk}</div></section><section class="org6-section"><div class="org6-section-head"><div><div class="org6-kicker">EDITORIAL</div><h2>Leituras recentes do campeonato</h2></div><a class="org6-btn" href="/analises/">Arquivo completo</a></div><div class="org6-articles">{articles_html(article_matches(analyses,'brasileirao'))}</div></section>'''.replace(f"{int(sim):,}",f"{int(sim):,}".replace(",","."))


def render_knockout(payload: dict[str,Any], key: str, title: str, desc: str, analyses: list[dict[str,Any]], shields: dict[str,str], serie_names:set[str]) -> str:
    phase=payload.get("fase_atual") or {}; summary=payload.get("resumo") or {}; val=payload.get("validacao_af") or {}
    active=current_phase_clubs(payload,serie_names)
    cards=''.join([
        f'<article class="org6-card"><small>Fase de referência</small><strong>{esc(phase.get("nome") or "—")}</strong><span>{esc("encerrada" if phase.get("status")=="encerrada" else "em andamento")}</span></article>',
        f'<article class="org6-card"><small>Jogos coletados</small><strong>{esc(summary.get("eventos",0))}</strong><span>{esc(summary.get("finalizados",0))} finalizados · {esc(summary.get("pendentes",0))} pendentes</span></article>',
        f'<article class="org6-card"><small>Equipes no recorte AF</small><strong>{esc(val.get("equipes_ativas","—"))}</strong><span>estado usado na integração continental</span></article>',
        f'<article class="org6-card"><small>Série A 2026 na competição</small><strong>{esc(summary.get("equipes_serie_a_2026","—"))}</strong><span>participantes identificados na coleta</span></article>',
    ])
    kind={"copa":"copa","libertadores":"libertadores","sul":"sul"}[key]
    status_text="classificados para a fase seguinte" if phase.get("status")=="encerrada" else "clubes da Série A no estágio atual"
    return f'''<section class="org6-hero"><div class="org6-kicker">{esc(title.upper())} · 2026</div><h1>{esc(title)} 2026</h1><p class="org6-deck">{esc(desc)}</p><div class="org6-updated">Fonte atualizada em {esc(fmt_date(payload.get('gerado_em')))} · estágio de referência: {esc(phase.get('nome') or '—')}</div></section><section class="org6-section"><div class="org6-section-head"><div><div class="org6-kicker">ESTADO ATUAL</div><h2>O que a fonte esportiva registra</h2></div></div><div class="org6-grid">{cards}</div></section><section class="org6-section"><div class="org6-section-head"><div><div class="org6-kicker">CLUBES BRASILEIROS</div><h2>{esc(status_text.title())}</h2></div><span class="org6-subtle">apenas clubes da Série A 2026</span></div><div class="org6-clubs">{club_chips(active,shields)}</div></section><section class="org6-section"><div class="org6-section-head"><div><div class="org6-kicker">AGENDA DA FASE</div><h2>Próximos confrontos com adversários definidos</h2></div></div><div class="org6-matches">{phase_matches(payload)}</div></section><section class="org6-section"><div class="org6-section-head"><div><div class="org6-kicker">EDITORIAL</div><h2>Análises relacionadas</h2></div><a class="org6-btn" href="/analises/">Arquivo completo</a></div><div class="org6-articles">{articles_html(article_matches(analyses,kind))}</div></section>'''


def fit_font(draw, text: str, max_w: int, start: int, min_size: int, bold: bool=True):
    from PIL import ImageFont
    paths = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"]
    for size in range(start,min_size-1,-2):
        font=None
        for p in paths:
            try: font=ImageFont.truetype(p,size); break
            except OSError: pass
        if font is None: font=ImageFont.load_default()
        if draw.textbbox((0,0),text,font=font)[2] <= max_w: return font
    return font


def wrap_pixels(draw, text: str, font, max_w: int, max_lines: int) -> list[str]:
    words=str(text).split(); lines=[]; cur=""
    for w in words:
        test=(cur+" "+w).strip()
        if draw.textbbox((0,0),test,font=font)[2] <= max_w: cur=test
        else:
            if cur: lines.append(cur)
            cur=w
            if len(lines)>=max_lines-1: break
    if cur and len(lines)<max_lines: lines.append(cur)
    used=len(" ".join(lines).split())
    if used < len(words) and lines: lines[-1]=lines[-1].rstrip(" .")+"…"
    return lines


def generate_hero(article: dict[str,Any], target: Path) -> None:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError as e:
        raise SystemExit("ORG-6 ERRO: Pillow é obrigatório para os cards editoriais Discover") from e
    W,H=1600,900
    im=Image.new("RGB",(W,H),(7,21,29)); px=im.load()
    for y in range(H):
        t=y/(H-1); base=(7+int(6*t),21+int(15*t),29+int(12*t))
        for x in range(W):
            glow=max(0,1-(((x-1250)/700)**2+((y-180)/500)**2))
            px[x,y]=(min(255,base[0]+int(25*glow)),min(255,base[1]+int(70*glow)),min(255,base[2]+int(22*glow)))
    d=ImageDraw.Draw(im)
    d.rounded_rectangle((78,70,1522,830),radius=42,fill=(8,25,34),outline=(67,105,73),width=3)
    d.rounded_rectangle((115,112,455,168),radius=26,fill=(35,82,44))
    def font(size,bold=True):
        p="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
        try:return ImageFont.truetype(p,size)
        except OSError:return ImageFont.load_default()
    kicker=str(article.get("categoria") or "ANÁLISE").upper()
    d.text((140,126),kicker[:42],font=font(28),fill=(203,255,133))
    title=str(article.get("titulo") or "Análise do Fórmula do Gol")
    title_font=font(76)
    lines=wrap_pixels(d,title,title_font,1320,4)
    y=225
    for line in lines:
        d.text((125,y),line,font=title_font,fill=(245,249,251)); y+=92
    deck=str(article.get("linha_fina") or "Dados, probabilidades e cenários produzidos pelo Fórmula do Gol.")
    deck_font=font(34,False)
    for line in wrap_pixels(d,deck,deck_font,1310,3):
        d.text((128,y+18),line,font=deck_font,fill=(178,198,209)); y+=47
    date=fmt_date(article.get("publicado_em"))
    d.line((125,760,1475,760),fill=(53,82,91),width=2)
    d.text((125,785),f"FÓRMULA DO GOL  ·  AF-PREVISÃO  ·  {date}",font=font(25),fill=(184,255,60))
    target.parent.mkdir(parents=True,exist_ok=True)
    im.save(target,"JPEG",quality=84,optimize=True,progressive=True)


def patch_analyses(site: Path, articles: list[dict[str,Any]]) -> None:
    css='<link rel="stylesheet" href="/css/br-competicoes.css?v=20260907-org6-v1">'
    index=site/"analises/index.html"
    txt=index.read_text(encoding="utf-8")
    if css not in txt: txt=txt.replace("</head>","  "+css+"\n</head>",1)
    txt=re.sub(r'<!-- ORG-6:TOPICS:START -->.*?<!-- ORG-6:TOPICS:END -->','',txt,flags=re.S)
    topics='<!-- ORG-6:TOPICS:START --><nav class="analysis-topic-nav" aria-label="Explorar por competição"><a href="/competicoes/">Competições</a><a href="/brasileirao/">Brasileirão</a><a href="/copa-do-brasil/">Copa do Brasil</a><a href="/libertadores/">Libertadores</a><a href="/sul-americana/">Sul-Americana</a></nav><!-- ORG-6:TOPICS:END -->'
    txt=txt.replace('</h1>', '</h1>'+topics,1)
    index.write_text(txt,encoding="utf-8")
    for a in articles:
        slug=str(a.get("slug") or ""); p=site/"analises"/slug
        if not p.is_file(): continue
        ident=slugify(a.get("id_editorial") or Path(slug).stem)
        rel=f"/img/analises/{ident}.jpg"; abs_img=SITE+rel
        generate_hero(a,site/rel.lstrip("/"))
        s=p.read_text(encoding="utf-8")
        if css not in s: s=s.replace("</head>","  "+css+"\n</head>",1)
        s=s.replace(SITE+"/og-image-formula-do-gol-v2.jpg",abs_img)
        s=re.sub(r'<!-- ORG-6:TOPICS:START -->.*?<!-- ORG-6:TOPICS:END -->','',s,flags=re.S)
        s=re.sub(r'<!-- ORG-6:HERO:START -->.*?<!-- ORG-6:HERO:END -->','',s,flags=re.S)
        topic='<!-- ORG-6:TOPICS:START --><nav class="analysis-topic-nav" aria-label="Explorar por competição"><a href="/competicoes/">Competições</a><a href="/brasileirao/">Brasileirão</a><a href="/copa-do-brasil/">Copa do Brasil</a><a href="/libertadores/">Libertadores</a><a href="/sul-americana/">Sul-Americana</a></nav><!-- ORG-6:TOPICS:END -->'
        s=s.replace('<article class="analysis-article">','<article class="analysis-article">'+topic,1)
        hero=f'<!-- ORG-6:HERO:START --><figure class="analysis-discover-hero"><img src="{rel}" alt="Card da análise: {esc(a.get("titulo") or "")}" width="1600" height="900" fetchpriority="high"><figcaption>Card editorial do Fórmula do Gol baseado em análise e dados próprios.</figcaption></figure><!-- ORG-6:HERO:END -->'
        m=re.search(r'(<header class="(?:analysis-head|analysis-article-header)">.*?</header>)',s,flags=re.S)
        if m: s=s[:m.end()]+hero+s[m.end():]
        p.write_text(s,encoding="utf-8")


def update_sitemap(site: Path, dates: dict[str,str]) -> None:
    p=site/"sitemap.xml"; ET.register_namespace("",NS); root=ET.parse(p).getroot()
    for node in list(root.findall(f"{{{NS}}}url")):
        loc=node.find(f"{{{NS}}}loc")
        if loc is not None and (loc.text or "").replace(SITE,"") in HUBS: root.remove(node)
    for route,(_,priority) in HUBS.items():
        node=ET.SubElement(root,f"{{{NS}}}url")
        for tag,text in (("loc",SITE+route),("lastmod",dates[route]),("changefreq","daily"),("priority",str(priority))):
            e=ET.SubElement(node,f"{{{NS}}}{tag}"); e.text=text
    ET.ElementTree(root).write(p,encoding="utf-8",xml_declaration=True)


def validate(site: Path, clubs: list[dict[str,Any]], mascotes: dict[str,Any], articles: list[dict[str,Any]]) -> None:
    from PIL import Image
    titles=set(); canon=set()
    for route in HUBS:
        p=site/route.strip("/")/"index.html"; assert p.is_file(),route
        s=p.read_text(encoding="utf-8"); assert s.count("<h1") == 1,route
        assert "max-image-preview:large" in s and "br-competicoes.css" in s
        t=re.search(r"<title>(.*?)</title>",s,re.S).group(1); c=re.search(r'<link rel="canonical" href="([^"]+)"',s).group(1)
        assert t not in titles and c not in canon; titles.add(t); canon.add(c)
        for block in re.findall(r'<script type="application/ld\+json">(.*?)</script>',s,re.S): json.loads(block)
    sm=ET.parse(site/"sitemap.xml").getroot(); urls=[x.text for x in sm.findall(f".//{{{NS}}}loc")]
    for route in HUBS: assert urls.count(SITE+route)==1
    for club in clubs:
        n=str(club.get("nome") or ""); page=site/"clube"/slugify(n)/"index.html"; s=page.read_text(encoding="utf-8")
        info=mascotes.get(n) or {}; src="/"+str(info.get("arquivo") or "").lstrip("/")
        assert src != "/" and src in s and 'class="club-mascot"' in s, f"mascote ausente: {n}"
        assert (site/src.lstrip("/")).is_file(),f"asset mascote ausente: {n}"
    idx=(site/"analises/index.html").read_text(encoding="utf-8"); assert "analysis-topic-nav" in idx
    for a in articles:
        slug=str(a.get("slug") or ""); p=site/"analises"/slug; assert p.is_file()
        s=p.read_text(encoding="utf-8"); ident=slugify(a.get("id_editorial") or Path(slug).stem); rel=f"/img/analises/{ident}.jpg"
        assert "analysis-discover-hero" in s and rel in s and "analysis-topic-nav" in s
        img=site/rel.lstrip("/"); assert img.is_file()
        with Image.open(img) as im: assert im.width>=1200 and im.width/im.height > 1.7
        assert SITE+rel in s
    print(f"ORG-6 PASS: {len(HUBS)} hubs, {len(clubs)} mascotes e {len(articles)} cards editoriais Discover validados")


def build(site: Path, repo: Path, check: bool) -> None:
    data=site/"dados-br" if (site/"dados-br").is_dir() else repo/"dados-br"
    clubs_manifest=load(data/"clubes.json",{}); clubs=clubs_manifest.get("clubes") or []; assert len(clubs)==20
    mascotes=load(data/"mascotes.json",{}).get("mascotes") or {}; assert len(mascotes)==20
    analyses_manifest=load(data/"analises.json",{}); articles=analyses_manifest.get("artigos") or []
    br=load(data/"probabilidades-brasileirao.json",{}); table=load(site/"tabela.json",{})
    comp_dir=repo/"dados-br/competicoes-af-previsao"
    comps={"copa":load(comp_dir/"copa-do-brasil.json",{}),"libertadores":load(comp_dir/"libertadores.json",{}),"sul":load(comp_dir/"sul-americana.json",{})}
    if any(not p for p in comps.values()): raise SystemExit("ORG-6 ERRO: fontes continentais ausentes")
    shields=shield_map(clubs); serie_names=set(shields)
    pages={
        "/competicoes/": ("Competições",render_comp_index(comps,br,articles),source_date(br,*comps.values(),analyses_manifest),"competicoes"),
        "/brasileirao/": ("Brasileirão",render_brasileirao(br,table,articles,shields),source_date(br,table,analyses_manifest),"brasileirao"),
        "/copa-do-brasil/": ("Copa do Brasil",render_knockout(comps["copa"],"copa","Copa do Brasil","Fase, clubes brasileiros, calendário coletado e análises da Copa do Brasil organizados a partir da mesma base usada na integração continental do AF-Previsão.",articles,shields,serie_names),source_date(comps["copa"],analyses_manifest),"copa"),
        "/libertadores/": ("Libertadores",render_knockout(comps["libertadores"],"libertadores","CONMEBOL Libertadores","Situação dos clubes brasileiros, confrontos e contexto da Libertadores usados pelo Fórmula do Gol na integração continental das projeções.",articles,shields,serie_names),source_date(comps["libertadores"],analyses_manifest),"libertadores"),
        "/sul-americana/": ("Sul-Americana",render_knockout(comps["sul"],"sul","CONMEBOL Sul-Americana","Situação dos clubes brasileiros, confrontos e contexto da Sul-Americana usados pelo Fórmula do Gol na integração continental das projeções.",articles,shields,serie_names),source_date(comps["sul"],analyses_manifest),"sul"),
    }
    descriptions={
        "/competicoes/":"Brasileirão, Copa do Brasil, Libertadores, Sul-Americana e Copa 2026 em um hub do Fórmula do Gol.",
        "/brasileirao/":"Probabilidades de título, rebaixamento, projeções e análises do Brasileirão 2026 pelo AF-Previsão.",
        "/copa-do-brasil/":"Fase, classificados, clubes da Série A e análises da Copa do Brasil 2026 no Fórmula do Gol.",
        "/libertadores/":"Libertadores 2026: brasileiros, quartas de final, agenda e análises no Fórmula do Gol.",
        "/sul-americana/":"Sul-Americana 2026: brasileiros, quartas de final, agenda e análises no Fórmula do Gol.",
    }
    dates={}
    for route,(crumb,body,updated,active) in pages.items():
        title=HUBS[route][0]; target=site/route.strip("/")/"index.html"; target.parent.mkdir(parents=True,exist_ok=True)
        target.write_text(shell(title,descriptions[route],route,crumb,body,updated,active),encoding="utf-8"); dates[route]=updated
    patch_analyses(site,articles)
    update_sitemap(site,dates)
    if check: validate(site,clubs,mascotes,articles); print("ORG-6 CHECK PASS")


def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--site-root","--site-dir",dest="site",default="_site"); ap.add_argument("--repo-root",default="."); ap.add_argument("--check",action="store_true"); a=ap.parse_args()
    site=Path(a.site).resolve(); repo=Path(a.repo_root).resolve()
    if not site.is_dir(): raise SystemExit(f"ORG-6 ERRO: site ausente: {site}")
    build(site,repo,a.check)

if __name__=="__main__": main()
