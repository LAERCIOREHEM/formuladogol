#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
buscar_rostos_jogadores.py — enriquecimento de fotos dos jogadores da Copa 2026

Objetivo:
  - Ler dados/elencos.json já gerado pela ESPN.
  - Preservar todas as fotos existentes.
  - Tentar preencher fotos faltantes em camadas:
      1) ESPN headshot direto pelo id do atleta.
      2) Wikidata/Wikimedia Commons, com validação conservadora de nome.
      3) Fallback visual do site, sem quebrar card nenhum.
  - Atualizar:
      dados/elencos.json
      dados/rostos.json
      dados/rostos_relatorio.json
      img/jogadores/*

Importante:
  - Não consulta mecanismo de busca genérico de imagens.
  - Não salva foto se a confiança do nome for baixa.
  - Não aborta por jogador sem foto: fallback é esperado.
  - Aborta se o arquivo de elencos não tiver as 48 seleções.
"""

import argparse
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timezone

DIR = os.path.dirname(os.path.abspath(__file__))
DADOS = os.path.join(DIR, "dados")
IMG_DIR = os.path.join(DIR, "img", "jogadores")

SELECOES_JSON = os.path.join(DADOS, "selecoes.json")
ELENCOS_JSON = os.path.join(DADOS, "elencos.json")
ROSTOS_JSON = os.path.join(DADOS, "rostos.json")
RELATORIO_JSON = os.path.join(DADOS, "rostos_relatorio.json")

HEADERS = {
    "User-Agent": "bolao-copa2026-rostos/1.0 (+brasileirao2026almoco.com.br)",
    "Accept": "application/json,text/plain,*/*",
}

ESPN_HEADSHOT = "https://a.espncdn.com/i/headshots/soccer/players/full/{id}.png"
WIKIDATA_SEARCH = "https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&uselang=en&type=item&limit=5&search={q}"
WIKIDATA_ENTITY = "https://www.wikidata.org/wiki/Special:EntityData/{qid}.json"
COMMONS_INFO = "https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|mime|extmetadata&titles=File:{file}"

def agora_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

def norm(s):
    s = unicodedata.normalize("NFKD", str(s or ""))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^a-zA-Z0-9 ]+", " ", s).lower()
    return re.sub(r"\s+", " ", s).strip()

def tokens_nome(s):
    stop = {"de", "da", "do", "dos", "das", "del", "della", "van", "von", "bin", "al", "el", "jr", "junior", "ii", "iii"}
    return [t for t in norm(s).split() if len(t) > 1 and t not in stop]

def chave_rosto(sigla, nome):
    return "%s|%s" % (str(sigla or "").upper(), norm(nome))

def nome_score(nome, label, descricao=""):
    a = tokens_nome(nome)
    b = tokens_nome(label)
    d = tokens_nome(descricao)
    if not a or not b:
        return 0.0
    if norm(nome) == norm(label):
        return 1.0

    set_a, set_b = set(a), set(b)
    inter = len(set_a & set_b)
    union = max(1, len(set_a | set_b))
    score = inter / union

    if a[0] in set_b:
        score += 0.12
    if a[-1] in set_b:
        score += 0.22

    desc = " ".join(d)
    if any(x in desc for x in ["football", "soccer", "futbol", "futebol"]):
        score += 0.12

    return min(1.0, score)

def http_bytes(url, timeout=25):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
        info = r.info()
        ctype = info.get_content_type() if info else ""
        final_url = r.geturl()
    return data, ctype, final_url

def http_json(url, timeout=25, tentativas=2):
    ultimo = None
    for i in range(tentativas):
        try:
            data, _, _ = http_bytes(url, timeout=timeout)
            return json.loads(data.decode("utf-8", "replace"))
        except Exception as e:
            ultimo = e
            time.sleep(0.8 * (i + 1))
    return None

def escrever_json(caminho, obj):
    tmp = caminho + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, caminho)

def carregar_json(caminho, padrao):
    if not os.path.exists(caminho):
        return padrao
    with open(caminho, "r", encoding="utf-8") as f:
        return json.load(f)

def ext_por_mime(mime, url=""):
    mime = (mime or "").lower()
    if mime in ("image/jpeg", "image/jpg"):
        return ".jpg"
    if mime == "image/png":
        return ".png"
    if mime == "image/webp":
        return ".webp"
    if mime == "image/gif":
        return ".gif"
    ext = os.path.splitext(urllib.parse.urlparse(url).path)[1].lower()
    if ext in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
        return ".jpg" if ext == ".jpeg" else ext
    return ".jpg"

def salvar_imagem(url, dest_base, forcar=False):
    for ext in (".png", ".jpg", ".webp", ".gif"):
        if os.path.exists(dest_base + ext) and not forcar:
            return dest_base + ext

    try:
        data, mime, final_url = http_bytes(url)
    except Exception:
        return None

    if not data or len(data) < 2048:
        return None
    if mime and not mime.lower().startswith("image/"):
        return None

    ext = ext_por_mime(mime, final_url)
    dest = dest_base + ext
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, dest)
    return dest

def relpath_site(abs_path):
    return os.path.relpath(abs_path, DIR).replace(os.sep, "/")

def tentar_espn_direto(jogador, forcar=False):
    aid = str(jogador.get("id") or "").strip()
    if not aid:
        return None
    url = ESPN_HEADSHOT.format(id=urllib.parse.quote(aid))
    dest = os.path.join(IMG_DIR, aid)
    salvo = salvar_imagem(url, dest, forcar=forcar)
    if not salvo:
        return None
    return {
        "foto": relpath_site(salvo),
        "fonte": "ESPN",
        "origem": "espn-headshot-direto",
        "credito": "ESPN",
        "licenca": None,
        "url": url,
        "confianca": 0.90,
    }

def wikidata_candidates(nome):
    url = WIKIDATA_SEARCH.format(q=urllib.parse.quote(nome))
    data = http_json(url)
    if not data:
        return []
    return data.get("search") or []

def wikidata_entity(qid):
    data = http_json(WIKIDATA_ENTITY.format(qid=urllib.parse.quote(qid)))
    if not data:
        return None
    return (data.get("entities") or {}).get(qid)

def claim_p18(entity):
    claims = (entity or {}).get("claims") or {}
    p18 = claims.get("P18") or []
    if not p18:
        return None
    try:
        return p18[0]["mainsnak"]["datavalue"]["value"]
    except Exception:
        return None

def commons_image_info(filename):
    title = urllib.parse.quote(filename.replace(" ", "_"))
    data = http_json(COMMONS_INFO.format(file=title))
    if not data:
        return None
    pages = (data.get("query") or {}).get("pages") or {}
    for page in pages.values():
        infos = page.get("imageinfo") or []
        if infos:
            return infos[0]
    return None

def meta_val(meta, chave):
    try:
        v = (meta or {}).get(chave) or {}
        return re.sub(r"<[^>]+>", "", str(v.get("value") or "")).strip()
    except Exception:
        return ""

def tentar_wikimedia(jogador, forcar=False, min_conf=0.86):
    nome = str(jogador.get("nome") or "").strip()
    if not nome:
        return None

    melhor = None
    for cand in wikidata_candidates(nome):
        qid = cand.get("id")
        label = cand.get("label") or ""
        desc = cand.get("description") or ""
        score = nome_score(nome, label, desc)
        if score < min_conf:
            continue

        ent = wikidata_entity(qid)
        filename = claim_p18(ent)
        if not filename:
            continue

        info = commons_image_info(filename)
        if not info:
            continue

        mime = (info.get("mime") or "").lower()
        if mime and not mime.startswith("image/"):
            continue

        url = info.get("url")
        if not url:
            continue

        meta = info.get("extmetadata") or {}
        autor = meta_val(meta, "Artist") or meta_val(meta, "Credit")
        licenca = meta_val(meta, "LicenseShortName") or meta_val(meta, "UsageTerms")
        credito = meta_val(meta, "Credit")

        melhor = {
            "qid": qid,
            "arquivo": filename,
            "url": url,
            "label": label,
            "descricao": desc,
            "autor": autor,
            "licenca": licenca,
            "credito": credito,
            "confianca": round(score, 3),
        }
        break

    if not melhor:
        return None

    aid = str(jogador.get("id") or norm(nome).replace(" ", "-"))
    dest_base = os.path.join(IMG_DIR, aid + "_wiki")
    salvo = salvar_imagem(melhor["url"], dest_base, forcar=forcar)
    if not salvo:
        return None

    return {
        "foto": relpath_site(salvo),
        "fonte": "Wikimedia Commons",
        "origem": "wikidata-p18",
        "credito": melhor.get("credito") or melhor.get("autor") or "Wikimedia Commons",
        "autor": melhor.get("autor"),
        "licenca": melhor.get("licenca"),
        "url": melhor.get("url"),
        "qid": melhor.get("qid"),
        "arquivo": melhor.get("arquivo"),
        "confianca": melhor.get("confianca"),
    }

def reconstruir_rostos(elencos, existente=None):
    mapa = {}
    for sigla, jogadores in (elencos.get("times") or {}).items():
        for p in jogadores or []:
            foto = p.get("foto")
            if foto:
                mapa[chave_rosto(sigla, p.get("nome"))] = foto
    obj = {
        "_nota": "Mapa de rostos para artilheiros/assistências. Gerado automaticamente a partir de elencos.json.",
        "gerado_em": agora_iso(),
        "mapa": mapa,
    }
    if isinstance(existente, dict):
        for k, v in existente.items():
            if k not in obj and k != "mapa":
                obj[k] = v
    return obj

def validar_48(elencos, selecoes):
    esperadas = {s.get("id") for s in (selecoes.get("selecoes") or []) if s.get("id")}
    times = set((elencos.get("times") or {}).keys())
    faltando = sorted(esperadas - times)
    return len(esperadas), faltando

def rodar(args):
    selecoes = carregar_json(SELECOES_JSON, {"selecoes": []})
    elencos = carregar_json(ELENCOS_JSON, {"times": {}})
    rostos_old = carregar_json(ROSTOS_JSON, {"mapa": {}})

    total_sel, faltando = validar_48(elencos, selecoes)
    if total_sel != 48 or faltando:
        print("ERRO: elencos.json não cobre as 48 seleções. Faltando:", ", ".join(faltando))
        return 2

    stats = {
        "selecoes": len(elencos.get("times") or {}),
        "jogadores": 0,
        "ja_tinham_foto": 0,
        "adicionados_espn": 0,
        "adicionados_wikimedia": 0,
        "sem_foto": 0,
        "erros": [],
        "fontes": {"ESPN": 0, "Wikimedia Commons": 0},
    }

    max_wiki = int(os.environ.get("MAX_WIKIDATA_ROSTOS", "0") or "0")
    wiki_usados = 0

    for sigla in sorted((elencos.get("times") or {}).keys()):
        jogadores = elencos["times"].get(sigla) or []
        for p in jogadores:
            stats["jogadores"] += 1
            if p.get("foto") and not args.forcar:
                stats["ja_tinham_foto"] += 1
                continue

            achou = None
            if not args.sem_espn:
                achou = tentar_espn_direto(p, forcar=args.forcar)
                if achou:
                    stats["adicionados_espn"] += 1
                    stats["fontes"]["ESPN"] += 1

            if not achou and not args.sem_wikimedia:
                if max_wiki and wiki_usados >= max_wiki:
                    pass
                else:
                    try:
                        achou = tentar_wikimedia(p, forcar=args.forcar, min_conf=args.min_conf)
                        wiki_usados += 1
                        time.sleep(args.wikimedia_pausa)
                    except Exception as e:
                        stats["erros"].append("%s|%s: %s" % (sigla, p.get("nome"), e))
                        achou = None
                    if achou:
                        stats["adicionados_wikimedia"] += 1
                        stats["fontes"]["Wikimedia Commons"] += 1

            if achou:
                p["foto"] = achou["foto"]
                p["foto_fonte"] = achou.get("fonte")
                p["foto_origem"] = achou.get("origem")
                p["foto_credito"] = achou.get("credito")
                p["foto_licenca"] = achou.get("licenca")
                p["foto_confianca"] = achou.get("confianca")
                if achou.get("url"):
                    p["foto_url_origem"] = achou.get("url")
                if achou.get("qid"):
                    p["wikidata"] = achou.get("qid")
            else:
                if args.forcar:
                    p["foto"] = None
                stats["sem_foto"] += 1

    elencos["_nota_fotos"] = (
        "Fotos locais em img/jogadores quando disponíveis. "
        "Fontes: ESPN e Wikimedia Commons, com fallback visual no site para ausentes."
    )
    elencos["rostos_atualizado_em"] = agora_iso()

    rostos = reconstruir_rostos(elencos, rostos_old)
    rel = {
        "_nota": "Relatório de cobertura de fotos dos jogadores. Ausência de foto não é erro; o front usa fallback.",
        "gerado_em": agora_iso(),
        "config": {
            "sem_espn": args.sem_espn,
            "sem_wikimedia": args.sem_wikimedia,
            "min_conf": args.min_conf,
            "max_wikidata_rostos": max_wiki,
        },
        "cobertura": stats,
    }

    escrever_json(ELENCOS_JSON, elencos)
    escrever_json(ROSTOS_JSON, rostos)
    escrever_json(RELATORIO_JSON, rel)

    print("Seleções:", stats["selecoes"])
    print("Jogadores:", stats["jogadores"])
    print("Já tinham foto:", stats["ja_tinham_foto"])
    print("Novas ESPN:", stats["adicionados_espn"])
    print("Novas Wikimedia:", stats["adicionados_wikimedia"])
    print("Sem foto/fallback:", stats["sem_foto"])
    print("Relatório:", os.path.relpath(RELATORIO_JSON, DIR))
    return 0

def selftest():
    assert norm("Manuel Neuer") == "manuel neuer"
    assert nome_score("Manuel Neuer", "Manuel Neuer", "German footballer") >= 0.99
    assert nome_score("Manuel Neuer", "Manuel Peter Neuer", "German footballer") >= 0.86
    assert nome_score("Manuel Neuer", "Manuel Akanji", "Swiss footballer") < 0.86

    elencos = {"times": {"GER": [{"nome": "Manuel Neuer", "foto": "img/jogadores/123.png"}]}}
    rostos = reconstruir_rostos(elencos, {})
    assert rostos["mapa"]["GER|manuel neuer"] == "img/jogadores/123.png"

    selecoes = {"selecoes": [{"id": "T%02d" % i} for i in range(48)]}
    el48 = {"times": {"T%02d" % i: [] for i in range(48)}}
    total, faltando = validar_48(el48, selecoes)
    assert total == 48 and not faltando
    print("SELFTEST OK")
    return 0

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--forcar", action="store_true", help="reprocessa fotos já existentes")
    ap.add_argument("--sem-espn", action="store_true", help="não tenta ESPN headshot direto")
    ap.add_argument("--sem-wikimedia", action="store_true", help="não tenta Wikidata/Wikimedia")
    ap.add_argument("--min-conf", type=float, default=0.86, help="confiança mínima para aceitar foto do Wikidata")
    ap.add_argument("--wikimedia-pausa", type=float, default=0.20, help="pausa entre chamadas Wikidata/Wikimedia")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return selftest()
    return rodar(args)

if __name__ == "__main__":
    sys.exit(main())
