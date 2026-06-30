#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
buscar_rostos_jogadores.py — povoamento INTELIGENTE das fotos dos jogadores.

Princípios (resolvem os 50 min / 10% do pipeline anterior):
  1) O ARQUIVO no disco é o cache. Se a foto do jogador já existe em
     img/jogadores/ -> nunca mais toca a rede para ele.
  2) MEMÓRIA dos ausentes. dados/rostos_estado.json guarda quem já foi
     checado e não tinha foto, com data; só re-tenta a cada N dias
     (--retry-dias, padrão 30). Assim a rodada CONVERGE e depois fica ociosa.
  3) Camadas, em ordem, parando na primeira que acha:
       a) ESPN headshot direto pelo id do atleta (determinístico).
       b) Wikipedia 'pageimages' (miniatura da página do jogador).
       c) Wikidata (wbsearchentities -> wbgetclaims P18 -> Commons), leve.
       d) Sem foto -> o FRONT desenha avatar de iniciais (nada é baixado).
  4) Downloads em PARALELO (pool de threads) + TETO DE TEMPO (--minutos) e de
     lote (--limite), para nunca estourar o GitHub Actions.
  5) Atribuição (autor + licença) salva para imagens do Wikimedia/Wikipedia,
     e exportada em dados/rostos_creditos.json para o link "Créditos das imagens".

Fluxo recomendado:
  - 1x pesado, LOCAL (sua máquina/servidor, sem limite, paralelo):
        python3 buscar_rostos_jogadores.py
    commita as imagens + estado.
  - Depois, manutenção leve no Actions:
        python3 buscar_rostos_jogadores.py --minutos 8 --limite 250

Sem rede? Valide a lógica:
        python3 buscar_rostos_jogadores.py --selftest
"""

import argparse
import concurrent.futures as futures
import json
import os
import re
import sys
import threading
import time
import unicodedata
import urllib.parse
import urllib.error
import urllib.request
from datetime import datetime, timezone, date

DIR = os.path.dirname(os.path.abspath(__file__))
DADOS = os.path.join(DIR, "dados")
IMG_DIR = os.path.join(DIR, "img", "jogadores")

SELECOES_JSON = os.path.join(DADOS, "selecoes.json")
ELENCOS_JSON = os.path.join(DADOS, "elencos.json")
ROSTOS_JSON = os.path.join(DADOS, "rostos.json")
ESTADO_JSON = os.path.join(DADOS, "rostos_estado.json")
CREDITOS_JSON = os.path.join(DADOS, "rostos_creditos.json")
RELATORIO_JSON = os.path.join(DADOS, "rostos_relatorio.json")

HEADERS = {
    "User-Agent": "bolao-copa2026-rostos/2.0 (+brasileirao2026almoco.com.br)",
    "Accept": "application/json,text/plain,*/*",
}

ESPN_HEADSHOT = "https://a.espncdn.com/i/headshots/soccer/players/full/{id}.png"
WP_PAGEIMG = ("https://{lang}.wikipedia.org/w/api.php?action=query&format=json&redirects=1"
              "&prop=pageimages&piprop=thumbnail|name&pithumbsize=200&titles={t}")
WB_SEARCH = ("https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json"
             "&language=en&uselang=en&type=item&limit=6&search={q}")
WB_CLAIMS = "https://www.wikidata.org/w/api.php?action=wbgetclaims&format=json&property=P18&entity={qid}"
COMMONS_FILEPATH = "https://commons.wikimedia.org/wiki/Special:FilePath/{file}?width=200"
COMMONS_INFO = ("https://commons.wikimedia.org/w/api.php?action=query&format=json"
                "&prop=imageinfo&iiprop=extmetadata&titles=File:{file}")

WP_LANGS = ["en", "pt", "es"]

# ------------------------------------------------------------------ utilidades
def agora_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

def hoje():
    return date.today().isoformat()

def norm(s):
    """Normalização IDÊNTICA ao normNome() do estatisticas.js (paridade de chave)."""
    s = unicodedata.normalize("NFD", str(s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()

def tokens(s):
    stop = {"de", "da", "do", "dos", "das", "del", "della", "van", "von", "bin",
            "al", "el", "jr", "junior", "ii", "iii", "dos", "the"}
    return [t for t in norm(s).split() if len(t) > 1 and t not in stop]

def chave(sigla, nome):
    return "%s|%s" % (str(sigla or "").upper(), norm(nome))

def nome_score(nome, label, descricao=""):
    a, b = tokens(nome), tokens(label)
    if not a or not b:
        return 0.0
    if norm(nome) == norm(label):
        return 1.0
    sa, sb = set(a), set(b)
    score = len(sa & sb) / max(1, len(sa | sb))
    if a[0] in sb:
        score += 0.10
    if a[-1] in sb:
        score += 0.22
    d = norm(descricao)
    if any(x in d for x in ("football", "soccer", "footballer", "futbol", "futebol", "goalkeeper")):
        score += 0.12
    return min(1.0, score)

def eh_footballer(descricao):
    d = norm(descricao)
    return any(x in d for x in ("football", "soccer", "footballer", "futbol", "futebol", "goalkeeper"))

# ------------------------------------------------------------------ HTTP
# --- Rate limit "educado" por host + retry com espera (Retry-After) ---------
_LIM_LOCK = threading.Lock()
_HOST_LOCK = {}
_HOST_ULT = {}

def _balde(host):
    h = (host or "").lower()
    if "wikipedia.org" in h or "wikimedia.org" in h or "wikidata.org" in h:
        return "wiki", 0.34          # ~3 req/s no total para todas as fontes wiki
    if "espncdn.com" in h or "espn.com" in h:
        return "espn", 0.05
    return host, 0.05

def _throttle(url):
    host = urllib.parse.urlparse(url).netloc
    chave, intervalo = _balde(host)
    with _LIM_LOCK:
        lock = _HOST_LOCK.setdefault(chave, threading.Lock())
    with lock:  # serializa o balde -> ritmo global educado mesmo com várias threads
        espera = _HOST_ULT.get(chave, 0.0) + intervalo - time.time()
        if espera > 0:
            time.sleep(espera)
        _HOST_ULT[chave] = time.time()

def http_bytes(url, timeout=25, tentativas=4):
    ultimo = None
    for i in range(tentativas):
        _throttle(url)
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                info = r.info()
                return r.read(), (info.get_content_type() if info else "") or "", r.geturl()
        except urllib.error.HTTPError as e:
            ultimo = e
            if e.code in (429, 503):           # too many requests / indisponível -> espera e re-tenta
                ra = e.headers.get("Retry-After") if e.headers else None
                espera = min(float(ra), 45) if (ra and str(ra).strip().isdigit()) else min(3.0 * (i + 1), 30)
                time.sleep(espera)
                continue
            if 500 <= e.code < 600:
                time.sleep(1.5 * (i + 1))
                continue
            raise                              # 404 etc.: não adianta re-tentar
        except Exception as e:
            ultimo = e
            time.sleep(1.0 * (i + 1))
    raise ultimo if ultimo else RuntimeError("falha http")

def http_json(url, timeout=25):
    try:
        data, _, _ = http_bytes(url, timeout=timeout)
        return json.loads(data.decode("utf-8", "replace"))
    except Exception:
        return None

def ext_por_mime(mime, url=""):
    mime = (mime or "").lower()
    m = {"image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
         "image/webp": ".webp", "image/gif": ".gif"}
    if mime in m:
        return m[mime]
    ext = os.path.splitext(urllib.parse.urlparse(url).path)[1].lower()
    return {".jpeg": ".jpg"}.get(ext, ext) if ext in (".jpg", ".jpeg", ".png", ".webp", ".gif") else ".jpg"

def arquivo_existe(rel_or_abs):
    if not rel_or_abs:
        return False
    p = rel_or_abs if os.path.isabs(rel_or_abs) else os.path.join(DIR, rel_or_abs)
    return os.path.exists(p)

def relpath_site(abs_path):
    return os.path.relpath(abs_path, DIR).replace(os.sep, "/")

def baixar(url, dest_base, forcar=False):
    """Baixa imagem para dest_base+<ext>. Reaproveita se já existe (cache)."""
    for ext in (".png", ".jpg", ".webp", ".gif"):
        if os.path.exists(dest_base + ext) and not forcar:
            return dest_base + ext
    try:
        data, mime, final = http_bytes(url)
    except Exception:
        return None
    if not data or len(data) < 1500:
        return None
    if mime and not mime.lower().startswith("image/"):
        return None
    dest = dest_base + ext_por_mime(mime, final)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, dest)
    return dest

# ------------------------------------------------------------------ parsers puros (testáveis)
def parse_pageimages(data):
    """Retorna {'thumb':url,'file':'Nome.jpg'} ou None a partir do JSON do pageimages."""
    try:
        pages = (data.get("query") or {}).get("pages") or {}
    except Exception:
        return None
    for page in pages.values():
        if "missing" in page:
            continue
        thumb = (page.get("thumbnail") or {}).get("source")
        arq = page.get("pageimage")
        if thumb:
            return {"thumb": thumb, "file": arq, "title": page.get("title")}
    return None

def parse_wbsearch(data, nome, min_conf=0.80):
    """Escolhe o melhor QID footballer pelo score do nome."""
    if not data:
        return None
    melhor, melhor_sc = None, 0.0
    for cand in (data.get("search") or []):
        label = cand.get("label") or ""
        desc = cand.get("description") or ""
        sc = nome_score(nome, label, desc)
        if eh_footballer(desc):
            sc += 0.05
        if sc > melhor_sc:
            melhor_sc, melhor = sc, cand
    if melhor and melhor_sc >= min_conf:
        return {"qid": melhor.get("id"), "label": melhor.get("label"),
                "descricao": melhor.get("description"), "confianca": round(melhor_sc, 3)}
    return None

def parse_p18(data):
    """Lê o nome do arquivo da claim P18 do wbgetclaims."""
    try:
        p18 = (data.get("claims") or {}).get("P18") or []
        return p18[0]["mainsnak"]["datavalue"]["value"]
    except Exception:
        return None

def commons_thumb_url(filename):
    return COMMONS_FILEPATH.format(file=urllib.parse.quote(filename.replace(" ", "_")))

def limpa_html(s):
    return re.sub(r"<[^>]+>", "", str(s or "")).strip()

def parse_imageinfo(data):
    """Extrai autor + licença do extmetadata do Commons."""
    try:
        pages = (data.get("query") or {}).get("pages") or {}
    except Exception:
        return {}
    for page in pages.values():
        infos = page.get("imageinfo") or []
        if not infos:
            continue
        meta = infos[0].get("extmetadata") or {}
        def mv(k):
            return limpa_html((meta.get(k) or {}).get("value"))
        return {"autor": mv("Artist") or mv("Credit"),
                "licenca": mv("LicenseShortName") or mv("UsageTerms")}
    return {}

# ------------------------------------------------------------------ camadas (rede)
def camada_espn(jog, forcar=False):
    aid = str(jog.get("id") or "").strip()
    if not aid:
        return None
    url = ESPN_HEADSHOT.format(id=urllib.parse.quote(aid))
    salvo = baixar(url, os.path.join(IMG_DIR, aid), forcar=forcar)
    if not salvo:
        return None
    return {"foto": relpath_site(salvo), "fonte": "ESPN", "credito": "ESPN",
            "licenca": None, "autor": None, "url": url, "confianca": 0.9}

def camada_wikipedia(jog, forcar=False):
    nome = str(jog.get("nome") or "").strip()
    if not nome:
        return None
    aid = str(jog.get("id") or norm(nome).replace(" ", "-"))
    for lang in WP_LANGS:
        data = http_json(WP_PAGEIMG.format(lang=lang, t=urllib.parse.quote(nome)))
        achou = parse_pageimages(data or {})
        if not achou:
            continue
        if nome_score(nome, achou.get("title") or nome) < 0.5:
            continue
        salvo = baixar(achou["thumb"], os.path.join(IMG_DIR, aid + "_wp"), forcar=forcar)
        if not salvo:
            continue
        cred = {"autor": None, "licenca": None}
        if achou.get("file"):
            cred = parse_imageinfo(http_json(COMMONS_INFO.format(file=urllib.parse.quote(achou["file"].replace(" ", "_")))) or {}) or cred
        return {"foto": relpath_site(salvo), "fonte": "Wikipedia", "credito": cred.get("autor") or "Wikipedia/Wikimedia",
                "autor": cred.get("autor"), "licenca": cred.get("licenca"),
                "url": achou["thumb"], "arquivo": achou.get("file"), "confianca": 0.8}
    return None

def camada_wikidata(jog, forcar=False, min_conf=0.80):
    nome = str(jog.get("nome") or "").strip()
    if not nome:
        return None
    cand = parse_wbsearch(http_json(WB_SEARCH.format(q=urllib.parse.quote(nome))) or {}, nome, min_conf=min_conf)
    if not cand:
        return None
    arq = parse_p18(http_json(WB_CLAIMS.format(qid=urllib.parse.quote(cand["qid"]))) or {})
    if not arq:
        return None
    aid = str(jog.get("id") or norm(nome).replace(" ", "-"))
    salvo = baixar(commons_thumb_url(arq), os.path.join(IMG_DIR, aid + "_wiki"), forcar=forcar)
    if not salvo:
        return None
    cred = parse_imageinfo(http_json(COMMONS_INFO.format(file=urllib.parse.quote(arq.replace(" ", "_")))) or {}) or {}
    return {"foto": relpath_site(salvo), "fonte": "Wikimedia Commons",
            "credito": cred.get("autor") or "Wikimedia Commons", "autor": cred.get("autor"),
            "licenca": cred.get("licenca"), "url": commons_thumb_url(arq), "arquivo": arq,
            "qid": cand.get("qid"), "confianca": cand.get("confianca")}

def resolver(sigla, jog, args, deadline):
    """Tenta as camadas em ordem; respeita o teto de tempo."""
    if deadline and time.time() > deadline:
        return ("skip", None)
    if not args.sem_espn:
        a = camada_espn(jog, forcar=args.forcar)
        if a:
            return ("ok", a)
    if not args.sem_wikipedia:
        a = camada_wikipedia(jog, forcar=args.forcar)
        if a:
            return ("ok", a)
    if not args.sem_wikimedia:
        a = camada_wikidata(jog, forcar=args.forcar, min_conf=args.min_conf)
        if a:
            return ("ok", a)
    return ("miss", None)

# ------------------------------------------------------------------ saídas
def reconstruir_rostos(elencos):
    mapa = {}
    for sigla, jogadores in (elencos.get("times") or {}).items():
        for p in jogadores or []:
            if p.get("foto"):
                mapa[chave(sigla, p.get("nome"))] = p["foto"]
    return {"_nota": "Mapa de rostos p/ artilheiros/assistências. Gerado de elencos.json.",
            "gerado_em": agora_iso(), "mapa": mapa}

def montar_creditos(elencos):
    itens = []
    for sigla, jogadores in (elencos.get("times") or {}).items():
        for p in jogadores or []:
            fonte = p.get("foto_fonte")
            if fonte in ("Wikipedia", "Wikimedia Commons") and (p.get("foto_autor") or p.get("foto_licenca")):
                itens.append({"nome": p.get("nome"), "selecao": sigla, "fonte": fonte,
                              "autor": p.get("foto_autor"), "licenca": p.get("foto_licenca"),
                              "url": p.get("foto_url_origem")})
    itens.sort(key=lambda x: (x["selecao"], x["nome"] or ""))
    return {"_nota": "Créditos das imagens de jogadores vindas de Wikipedia/Wikimedia Commons.",
            "gerado_em": agora_iso(), "fonte_padrao": "ESPN / Wikipedia / Wikimedia Commons",
            "creditos": itens}

def carregar_json(caminho, padrao):
    if not os.path.exists(caminho):
        return padrao
    try:
        with open(caminho, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return padrao

def escrever_json(caminho, obj):
    tmp = caminho + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, caminho)

def dias_desde(iso_d):
    try:
        d = date.fromisoformat((iso_d or "")[:10])
        return (date.today() - d).days
    except Exception:
        return 99999

# ------------------------------------------------------------------ execução
def rodar(args):
    selecoes = carregar_json(SELECOES_JSON, {"selecoes": []})
    elencos = carregar_json(ELENCOS_JSON, {"times": {}})
    estado = carregar_json(ESTADO_JSON, {"itens": {}})
    if "itens" not in estado:
        estado = {"itens": {}}

    esperadas = {s.get("id") for s in (selecoes.get("selecoes") or []) if s.get("id")}
    times = elencos.get("times") or {}
    faltando = sorted(esperadas - set(times.keys()))
    if len(esperadas) != 48 or faltando:
        print("ERRO: elencos.json não cobre as 48 seleções. Faltando:", ", ".join(faltando) or "(elencos vazio)")
        print("      Rode antes: python3 buscar_selecoes.py")
        return 2

    os.makedirs(IMG_DIR, exist_ok=True)
    est = estado["itens"]
    st = {"jogadores": 0, "ja_tinham": 0, "novas": 0, "sem_foto": 0, "pulados_memoria": 0,
          "skip_tempo": 0, "fontes": {"ESPN": 0, "Wikipedia": 0, "Wikimedia Commons": 0}}

    # 1) Monta a lista de trabalho aplicando o CACHE (arquivo) e a MEMÓRIA (estado)
    trabalho = []
    for sigla in sorted(times.keys()):
        for p in times[sigla] or []:
            st["jogadores"] += 1
            k = chave(sigla, p.get("nome"))
            if p.get("foto") and arquivo_existe(p.get("foto")) and not args.forcar:
                st["ja_tinham"] += 1
                est[k] = {"status": "ok", "fonte": p.get("foto_fonte") or "?", "foto": p.get("foto"), "ultimo": hoje()}
                continue
            e = est.get(k)
            if e and not args.forcar:
                if e.get("status") == "ok" and arquivo_existe(e.get("foto")):
                    p["foto"] = e.get("foto")
                    st["ja_tinham"] += 1
                    continue
                if e.get("status") == "sem_foto" and dias_desde(e.get("ultimo")) < args.retry_dias:
                    st["pulados_memoria"] += 1
                    st["sem_foto"] += 1
                    continue
            trabalho.append((sigla, p, k))

    if args.limite and len(trabalho) > args.limite:
        import random
        random.shuffle(trabalho)          # amostra diferente a cada rodada (varredura)
        trabalho = trabalho[:args.limite]
    print("→ %d jogadores no total | %d já tinham foto | %d pulados por memória | %d a processar agora"
          % (st["jogadores"], st["ja_tinham"], st["pulados_memoria"], len(trabalho)))

    deadline = (time.time() + args.minutos * 60) if args.minutos else 0

    # 2) Resolve em PARALELO (rede), aplicando resultados na thread principal
    resultados = {}
    if trabalho:
        with futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
            fut2key = {ex.submit(resolver, sg, p, args, deadline): (sg, p, k) for (sg, p, k) in trabalho}
            for fut in futures.as_completed(fut2key):
                sg, p, k = fut2key[fut]
                try:
                    status, achou = fut.result()
                except Exception as e:
                    status, achou = "miss", None
                resultados[k] = (status, achou, sg, p)

    for k, (status, achou, sg, p) in resultados.items():
        if status == "skip":
            st["skip_tempo"] += 1
            continue
        if status == "ok" and achou:
            p["foto"] = achou["foto"]
            p["foto_fonte"] = achou.get("fonte")
            p["foto_credito"] = achou.get("credito")
            p["foto_autor"] = achou.get("autor")
            p["foto_licenca"] = achou.get("licenca")
            p["foto_url_origem"] = achou.get("url")
            p["foto_confianca"] = achou.get("confianca")
            if achou.get("qid"):
                p["wikidata"] = achou["qid"]
            st["novas"] += 1
            st["fontes"][achou.get("fonte", "?")] = st["fontes"].get(achou.get("fonte", "?"), 0) + 1
            est[k] = {"status": "ok", "fonte": achou.get("fonte"), "foto": achou["foto"], "ultimo": hoje()}
        else:  # miss
            st["sem_foto"] += 1
            tent = (est.get(k, {}).get("tentativas") or 0) + 1
            est[k] = {"status": "sem_foto", "tentativas": tent, "ultimo": hoje()}

    # 3) Grava tudo
    elencos["rostos_atualizado_em"] = agora_iso()
    elencos["_nota_fotos"] = ("Fotos locais em img/jogadores. Camadas: ESPN, Wikipedia e Wikimedia Commons; "
                              "ausentes recebem avatar de iniciais no site.")
    escrever_json(ELENCOS_JSON, elencos)
    escrever_json(ROSTOS_JSON, reconstruir_rostos(elencos))
    escrever_json(CREDITOS_JSON, montar_creditos(elencos))
    escrever_json(ESTADO_JSON, {"_nota": "Cache de quem já tem foto e de quem foi checado sem foto (re-tenta após retry-dias).",
                                "gerado_em": agora_iso(), "itens": est})
    com_foto = sum(1 for sg in times for p in times[sg] if p.get("foto"))
    rel = {"_nota": "Cobertura de fotos. Ausência não é erro: o front usa avatar de iniciais.",
           "gerado_em": agora_iso(),
           "cobertura": {"selecoes": len(times), "jogadores": st["jogadores"], "com_foto": com_foto,
                         "fallback": st["jogadores"] - com_foto},
           "execucao": st}
    escrever_json(RELATORIO_JSON, rel)
    print("✓ +%d fotos novas (ESPN %d | Wikipedia %d | Commons %d) | com foto: %d/%d | fallback: %d | skip_tempo: %d"
          % (st["novas"], st["fontes"].get("ESPN", 0), st["fontes"].get("Wikipedia", 0),
             st["fontes"].get("Wikimedia Commons", 0), com_foto, st["jogadores"],
             st["jogadores"] - com_foto, st["skip_tempo"]))
    return 0

# ------------------------------------------------------------------ selftest (offline)
def selftest():
    ok = True
    def checa(c, m):
        nonlocal ok
        print(("  ok  " if c else "  ERRO ") + m)
        ok = ok and c

    # paridade de chave com o front
    checa(chave("ARG", "Lionel Messi") == "ARG|lionel messi", "chave SIGLA|nome-normalizado")
    checa(norm("Vinícius Júnior") == "vinicius junior" and norm("Mbappé") == "mbappe", "norm com acentos")

    # parse_pageimages
    pg = {"query": {"pages": {"1": {"title": "Lionel Messi", "pageimage": "Messi.jpg",
          "thumbnail": {"source": "https://x/Messi_200.jpg"}}}}}
    r = parse_pageimages(pg)
    checa(r and r["thumb"].endswith("Messi_200.jpg") and r["file"] == "Messi.jpg", "parse_pageimages acha miniatura")
    checa(parse_pageimages({"query": {"pages": {"-1": {"missing": ""}}}}) is None, "pageimages 'missing' -> None")

    # parse_wbsearch (escolhe footballer pelo score)
    wb = {"search": [
        {"id": "Q615", "label": "Lionel Messi", "description": "Argentine association football player"},
        {"id": "Q999", "label": "Lionel Messi (film)", "description": "2014 film"}]}
    sel = parse_wbsearch(wb, "Lionel Messi", min_conf=0.8)
    checa(sel and sel["qid"] == "Q615", "parse_wbsearch escolhe o jogador certo")
    fraco = parse_wbsearch({"search": [{"id": "Q1", "label": "Outro Nome", "description": "painter"}]}, "Lionel Messi")
    checa(fraco is None, "parse_wbsearch rejeita nome fraco")

    # parse_p18 + commons url
    p18 = {"claims": {"P18": [{"mainsnak": {"datavalue": {"value": "Lionel Messi 2018.jpg"}}}]}}
    checa(parse_p18(p18) == "Lionel Messi 2018.jpg", "parse_p18 lê arquivo")
    checa("Lionel_Messi_2018.jpg" in commons_thumb_url("Lionel Messi 2018.jpg"), "commons_thumb_url troca espaço por _")

    # parse_imageinfo (autor/licença)
    ii = {"query": {"pages": {"1": {"imageinfo": [{"extmetadata": {
        "Artist": {"value": "<a href=x>Foto Autor</a>"}, "LicenseShortName": {"value": "CC BY-SA 4.0"}}}]}}}}
    cr = parse_imageinfo(ii)
    checa(cr.get("autor") == "Foto Autor" and cr.get("licenca") == "CC BY-SA 4.0", "parse_imageinfo limpa HTML e lê licença")

    # memória de ausências (janela de retry)
    checa(dias_desde((date.today()).isoformat()) == 0, "dias_desde hoje = 0")
    checa(dias_desde("2000-01-01") > 30, "dias_desde antigo > 30")

    # reconstrução do rostos.json (só quem tem foto)
    el = {"times": {"BRA": [{"nome": "Alisson", "foto": "img/jogadores/1.png"},
                            {"nome": "Vinicius", "foto": None}]}}
    rec = reconstruir_rostos(el)
    checa(rec["mapa"].get("BRA|alisson") == "img/jogadores/1.png" and "BRA|vinicius" not in rec["mapa"],
          "reconstruir_rostos inclui só quem tem foto (chave casa com o front)")

    # créditos só p/ wiki com atribuição
    el2 = {"times": {"GER": [{"nome": "Manuel Neuer", "foto_fonte": "Wikimedia Commons",
                              "foto_autor": "Fulano", "foto_licenca": "CC BY 4.0", "foto_url_origem": "u"},
                             {"nome": "X", "foto_fonte": "ESPN"}]}}
    cre = montar_creditos(el2)
    checa(len(cre["creditos"]) == 1 and cre["creditos"][0]["selecao"] == "GER", "créditos só Wikipedia/Commons com autor/licença")

    print("\nSELFTEST:", "PASSOU ✅" if ok else "FALHOU ❌")
    return 0 if ok else 1

def main():
    ap = argparse.ArgumentParser(description="Povoa fotos dos jogadores (ESPN/Wikipedia/Wikimedia) com cache e fallback.")
    ap.add_argument("--forcar", action="store_true", help="reprocessa mesmo quem já tem foto")
    ap.add_argument("--sem-espn", action="store_true")
    ap.add_argument("--sem-wikipedia", action="store_true")
    ap.add_argument("--sem-wikimedia", action="store_true")
    ap.add_argument("--min-conf", type=float, default=0.80, help="confiança mínima no nome (Wikidata)")
    ap.add_argument("--workers", type=int, default=8, help="downloads em paralelo")
    ap.add_argument("--minutos", type=float, default=0, help="teto de tempo (0 = sem limite, p/ rodar local)")
    ap.add_argument("--limite", type=int, default=0, help="máx. de jogadores a processar nesta rodada (0 = todos)")
    ap.add_argument("--retry-dias", type=int, default=30, help="re-tenta 'sem foto' após N dias")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    return rodar(args)

if __name__ == "__main__":
    sys.exit(main())
