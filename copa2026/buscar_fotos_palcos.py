#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
buscar_fotos_palcos.py — baixa as fotos dos 16 estádios da aba SEDES.

Fonte: Wikipedia (pageimages) -> miniatura da página oficial de cada estádio,
com autor/licença lidos do Wikimedia Commons e gravados em
dados/palcos_creditos.json (alimenta o link "Créditos das imagens").

É um script de UMA rodada (rode local, com internet):
    python3 buscar_fotos_palcos.py
Idempotente: não rebaixa foto que já existe (use --forcar para rebaixar).
Sem internet? Valide a lógica:  python3 buscar_fotos_palcos.py --selftest

Depois de rodar, commite:  img/palcos/  e  dados/palcos_creditos.json
(As imagens dos mascotes/bola são OUTRO assunto: salve manualmente como
 img/palcos/mascote-maple.png, mascote-zayu.png, mascote-clutch.png e
 bola-trionda.png — a página degrada com elegância se faltarem.)
"""

import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

DIR = os.path.dirname(os.path.abspath(__file__))
IMG_DIR = os.path.join(DIR, "img", "palcos")
PALCOS_JSON = os.path.join(DIR, "dados", "palcos.json")
CRED_JSON = os.path.join(DIR, "dados", "palcos_creditos.json")

HEADERS = {"User-Agent": "bolao-copa2026-palcos/1.0 (+brasileirao2026almoco.com.br)",
           "Accept": "application/json,image/*,*/*"}

# id do palcos.json -> título do artigo na Wikipedia em inglês
ARTIGOS = {
    "dallas": "AT&T Stadium",
    "nyj": "MetLife Stadium",
    "cdmx": "Estadio Azteca",
    "atlanta": "Mercedes-Benz Stadium",
    "kc": "Arrowhead Stadium",
    "houston": "NRG Stadium",
    "la": "SoFi Stadium",
    "sf": "Levi's Stadium",
    "philly": "Lincoln Financial Field",
    "seattle": "Lumen Field",
    "boston": "Gillette Stadium",
    "miami": "Hard Rock Stadium",
    "vancouver": "BC Place",
    "monterrey": "Estadio BBVA",
    "guadalajara": "Estadio Akron",
    "toronto": "BMO Field",
}

WP_PAGEIMG = ("https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1"
              "&prop=pageimages&piprop=thumbnail|name&pithumbsize=640&titles={t}")
COMMONS_INFO = ("https://commons.wikimedia.org/w/api.php?action=query&format=json"
                "&prop=imageinfo&iiprop=extmetadata&titles=File:{f}")


def http_json(url, tentativas=3):
    for i in range(tentativas):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except Exception:
            time.sleep(1.5 * (i + 1))
    return None


def parse_pageimages(data):
    try:
        pages = (data.get("query") or {}).get("pages") or {}
    except Exception:
        return None
    for page in pages.values():
        if "missing" in page:
            continue
        thumb = (page.get("thumbnail") or {}).get("source")
        if thumb:
            return {"thumb": thumb, "file": page.get("pageimage")}
    return None


def limpa_html(s):
    return re.sub(r"<[^>]+>", "", str(s or "")).strip()


def parse_imageinfo(data):
    try:
        pages = (data.get("query") or {}).get("pages") or {}
    except Exception:
        return {}
    for page in pages.values():
        infos = page.get("imageinfo") or []
        if infos:
            meta = infos[0].get("extmetadata") or {}
            def mv(k):
                return limpa_html((meta.get(k) or {}).get("value"))
            return {"autor": mv("Artist") or mv("Credit"),
                    "licenca": mv("LicenseShortName") or mv("UsageTerms")}
    return {}


def baixar(url, dest, forcar=False):
    if os.path.exists(dest) and not forcar:
        return True
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=40) as r:
            dados = r.read()
        if not dados or len(dados) < 2000:
            return False
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        tmp = dest + ".tmp"
        with open(tmp, "wb") as f:
            f.write(dados)
        os.replace(tmp, dest)
        return True
    except Exception as e:
        print("  ! falha:", url, "(", e, ")")
        return False


def rodar(forcar=False):
    try:
        palcos = json.load(open(PALCOS_JSON, encoding="utf-8"))
    except Exception:
        print("ERRO: não li dados/palcos.json"); return 1
    nomes = {e["id"]: e.get("nomeReal") or e.get("nomeFifa") for e in palcos.get("estadios", [])}
    creditos, ok = [], 0
    for pid, artigo in ARTIGOS.items():
        dest = os.path.join(IMG_DIR, pid + ".jpg")
        if os.path.exists(dest) and not forcar:
            print("  = já tem:", pid); ok += 1
            continue
        achou = parse_pageimages(http_json(WP_PAGEIMG.format(t=urllib.parse.quote(artigo))) or {})
        if not achou:
            print("  ! sem imagem na Wikipedia:", artigo); continue
        if not baixar(achou["thumb"], dest, forcar=forcar):
            continue
        cred = {}
        if achou.get("file"):
            cred = parse_imageinfo(http_json(COMMONS_INFO.format(f=urllib.parse.quote(achou["file"].replace(" ", "_")))) or {})
        creditos.append({"id": pid, "nome": nomes.get(pid, artigo), "fonte": "Wikipedia/Wikimedia Commons",
                         "autor": cred.get("autor"), "licenca": cred.get("licenca")})
        ok += 1
        print("  ✓", pid, "<-", artigo)
        time.sleep(0.5)
    # mescla com créditos existentes (não perde os antigos ao re-rodar)
    antigos = []
    if os.path.exists(CRED_JSON):
        try:
            antigos = json.load(open(CRED_JSON, encoding="utf-8")).get("creditos", [])
        except Exception:
            antigos = []
    por_id = {c.get("id"): c for c in antigos if c.get("id")}
    for c in creditos:
        por_id[c["id"]] = c
    saida = {"_nota": "Créditos das fotos dos estádios (Wikipedia/Wikimedia Commons). Gerado por buscar_fotos_palcos.py.",
             "creditos": sorted(por_id.values(), key=lambda x: x.get("nome") or "")}
    tmp = CRED_JSON + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(saida, f, ensure_ascii=False, indent=1); f.write("\n")
    os.replace(tmp, CRED_JSON)
    print("✓ %d/16 fotos no repo | créditos: %d itens" % (ok, len(saida["creditos"])))
    return 0


def selftest():
    ok = True
    def checa(c, m):
        nonlocal ok
        print(("  ok  " if c else "  ERRO ") + m); ok = ok and c
    checa(len(ARTIGOS) == 16, "16 estádios mapeados")
    pg = {"query": {"pages": {"1": {"pageimage": "X.jpg", "thumbnail": {"source": "https://x/X_640.jpg"}}}}}
    r = parse_pageimages(pg)
    checa(r and r["thumb"].endswith("X_640.jpg") and r["file"] == "X.jpg", "parse_pageimages")
    checa(parse_pageimages({"query": {"pages": {"-1": {"missing": ""}}}}) is None, "pageimages missing -> None")
    ii = {"query": {"pages": {"1": {"imageinfo": [{"extmetadata": {"Artist": {"value": "<b>Autor X</b>"}, "LicenseShortName": {"value": "CC BY-SA 4.0"}}}]}}}}
    cr = parse_imageinfo(ii)
    checa(cr.get("autor") == "Autor X" and cr.get("licenca") == "CC BY-SA 4.0", "parse_imageinfo autor/licença")
    try:
        pj = json.load(open(PALCOS_JSON, encoding="utf-8"))
        ids = {e["id"] for e in pj.get("estadios", [])}
        checa(ids == set(ARTIGOS.keys()), "ids do palcos.json batem com o mapa de artigos")
    except Exception:
        checa(False, "palcos.json legível")
    print("\nSELFTEST:", "PASSOU ✅" if ok else "FALHOU ❌")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else rodar(forcar=("--forcar" in sys.argv)))
