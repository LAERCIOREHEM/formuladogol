#!/usr/bin/env python3
"""Gate final ORG-7 para impedir regressões na superfície orgânica pública."""
from __future__ import annotations

import argparse
import json
import re
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlparse

SITE = "https://formuladogol.com.br"
NS = "http://www.sitemaps.org/schemas/sitemap/0.9"
HUBS = {"/competicoes/", "/brasileirao/", "/copa-do-brasil/", "/libertadores/", "/sul-americana/", "/brasileirao-jogos.html"}


def load(path: Path, fallback):
    try: return json.loads(path.read_text(encoding="utf-8"))
    except Exception: return fallback


def slugify(value) -> str:
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()


def page_for(site: Path, url: str) -> Path:
    parsed = urlparse(url)
    rel = parsed.path.lstrip("/")
    if not rel:
        return site / "index.html"
    p = site / rel
    if parsed.path.endswith("/"):
        return p / "index.html"
    if p.is_dir():
        return p / "index.html"
    return p


def canonical_of(text: str) -> str:
    m = re.search(r'<link\s+rel="canonical"\s+href="([^"]+)"', text, re.I)
    if not m:
        m = re.search(r'<link\s+href="([^"]+)"\s+rel="canonical"', text, re.I)
    return m.group(1).strip() if m else ""


def validate(site: Path) -> dict[str,int]:
    problems=[]
    tree=ET.parse(site/"sitemap.xml")
    nodes=tree.getroot().findall(f"{{{NS}}}url")
    urls=[(n.findtext(f"{{{NS}}}loc") or "").strip() for n in nodes]
    if len(urls)!=len(set(urls)): problems.append("sitemap contém URLs duplicadas")
    if any(not u.startswith(SITE+"/") for u in urls): problems.append("sitemap contém URL externa")

    clubs=load(site/"dados-br/clubes.json",{}).get("clubes") or []
    expected_clubs={f"{SITE}/clube/{slugify(c.get('nome'))}/" for c in clubs}
    game_pages={p.parent.name for p in (site/"jogo").glob("*/index.html")}
    expected_games={f"{SITE}/jogo/{slug}/" for slug in game_pages}
    sitemap_set=set(urls)
    if len(expected_clubs)!=20: problems.append(f"esperados 20 clubes; recebido {len(expected_clubs)}")
    if not expected_clubs.issubset(sitemap_set): problems.append("há páginas de clube fora do sitemap")
    if not expected_games.issubset(sitemap_set): problems.append("há páginas de jogo fora do sitemap")
    for path in HUBS:
        if SITE+path not in sitemap_set: problems.append(f"hub ausente do sitemap: {path}")

    canonicals={}
    organic_urls=sorted(expected_clubs|expected_games|{SITE+p for p in HUBS})
    for url in organic_urls:
        p=page_for(site,url)
        if not p.is_file():
            problems.append(f"arquivo ausente: {url}"); continue
        text=p.read_text(encoding="utf-8")
        if text.count("<h1")!=1: problems.append(f"H1 != 1: {url}")
        if "max-image-preview:large" not in text: problems.append(f"max-image-preview ausente: {url}")
        if 'content="noindex' in text.lower(): problems.append(f"noindex indevido: {url}")
        canonical=canonical_of(text)
        if canonical!=url: problems.append(f"canonical divergente: {url} -> {canonical}")
        if canonical in canonicals and canonicals[canonical]!=url: problems.append(f"canonical duplicado: {canonical}")
        canonicals[canonical]=url
        if url in expected_clubs:
            if not re.search(r'\"@type\"\s*:\s*\"SportsTeam\"', text) or not re.search(r'\"@type\"\s*:\s*\"BreadcrumbList\"', text): problems.append(f"schema clube incompleto: {url}")
        if url in expected_games:
            if not re.search(r'\"@type\"\s*:\s*\"SportsEvent\"', text) or not re.search(r'\"@type\"\s*:\s*\"BreadcrumbList\"', text): problems.append(f"schema jogo incompleto: {url}")

    # Cobertura de linkagem: o hub clubes deve descobrir todos os clubes e o
    # arquivo do Brasileirão deve descobrir todas as páginas de jogo.
    club_hub=(site/"clubes.html").read_text(encoding="utf-8")
    linked_clubs={SITE+m for m in re.findall(r'href="(/clube/[^"#?]+/)"',club_hub)}
    if linked_clubs!=expected_clubs:
        problems.append(f"hub de clubes não cobre 20/20: {len(linked_clubs)}/{len(expected_clubs)}")
    archive=(site/"brasileirao-jogos.html").read_text(encoding="utf-8")
    linked_games={SITE+m for m in re.findall(r'href="(/jogo/[^"#?]+/)"',archive)}
    if linked_games!=expected_games:
        problems.append(f"arquivo de jogos não cobre todas as partidas: {len(linked_games)}/{len(expected_games)}")

    # ORG-7R: a malha precisa ser navegável também pelas superfícies de uso
    # diário, não apenas pelo sitemap e pelos clubes.
    root_index=(site/"index.html").read_text(encoding="utf-8")
    if '/brasileirao-jogos.html' not in root_index:
        problems.append("Jogos/Resultados não expõem o arquivo canônico do Brasileirão")
    if 'urlPaginaJogoBrasileirao' not in root_index:
        problems.append("helper de links para páginas individuais ausente no front principal")
    # Não valide o texto literal dos CTAs: o rótulo pode ser encurtado sem
    # remover a navegação. O contrato relevante é estrutural — Jogos e
    # Resultados precisam montar links para a URL individual calculada pelo
    # helper canônico.
    if 'href="${brEscapeAttr(paginaJogo)}"' not in root_index or 'href="${brEscapeAttr(paginaResultado)}"' not in root_index:
        problems.append("CTAs de páginas individuais ausentes em Jogos/Resultados")

    legacy=site/"brasileirao"/"jogos"/"index.html"
    if not legacy.is_file():
        problems.append("alias legado /brasileirao/jogos/ ausente")
    else:
        legacy_text=legacy.read_text(encoding="utf-8")
        if 'noindex,follow' not in legacy_text or 'brasileirao-jogos.html' not in legacy_text:
            problems.append("alias legado não aponta corretamente para a canônica")

    # Toda partida mantém links para ambos os clubes; isso fecha o ciclo de
    # linkagem arquivo -> jogo -> clube -> jogos recentes/próximos.
    for url in sorted(expected_games):
        text=page_for(site,url).read_text(encoding="utf-8")
        club_links=set(re.findall(r'href="(/clube/[^"#?]+/)"',text))
        if len(club_links)<2: problems.append(f"jogo sem links para os dois clubes: {url}")

    robots=(site/"robots.txt").read_text(encoding="utf-8")
    for sm in ("Sitemap: https://formuladogol.com.br/sitemap.xml","Sitemap: https://formuladogol.com.br/news-sitemap.xml"):
        if sm not in robots: problems.append(f"robots sem {sm}")

    # Heroes Discover dos artigos: presença física e largura mínima 1200px.
    manifest=load(site/"dados-br/analises.json",{})
    articles=manifest.get("artigos") or []
    try:
        from PIL import Image
    except Exception:
        Image=None
    for item in articles:
        url=str(item.get("url") or "")
        if not url.startswith(SITE+"/analises/"): continue
        p=page_for(site,url)
        if not p.is_file(): problems.append(f"artigo ausente: {url}"); continue
        text=p.read_text(encoding="utf-8")
        m=re.search(r'<meta property="og:image" content="([^"]+)"',text)
        if not m: problems.append(f"artigo sem og:image: {url}"); continue
        image_url=m.group(1)
        image_path=page_for(site,image_url) if image_url.endswith("/") else site/urlparse(image_url).path.lstrip("/")
        if not image_path.is_file(): problems.append(f"hero ausente: {image_url}")
        elif Image:
            with Image.open(image_path) as im:
                if im.width<1200: problems.append(f"hero <1200px: {image_url} ({im.width})")

    if problems:
        raise AssertionError("ORG-7 FINAL GATE FALHOU:\n"+"\n".join(problems[:100]))
    return {"sitemap":len(urls),"clubs":len(expected_clubs),"games":len(expected_games),"hubs":len(HUBS),"articles":len(articles)}


def main():
    ap=argparse.ArgumentParser(description="ORG-7 — gate final orgânico")
    ap.add_argument("--site-root",dest="site_root"); ap.add_argument("--site-dir",dest="site_dir"); ap.add_argument("--check",action="store_true")
    a=ap.parse_args(); site=Path(a.site_root or a.site_dir or "_site").resolve()
    if not site.is_dir(): raise SystemExit(f"ORG-7 ERRO: diretório ausente: {site}")
    stats=validate(site)
    print("ORG-7 FINAL PASS: "+", ".join(f"{k}={v}" for k,v in stats.items()))
    if a.check: print("ORG-7 FINAL CHECK PASS")

if __name__=="__main__": main()
