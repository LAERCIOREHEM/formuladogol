#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
buscar_clubes_jogadores.py — preenche o clube atual dos jogadores em elencos.json.

Uso recomendado:
  python3 buscar_clubes_jogadores.py --selftest
  python3 buscar_clubes_jogadores.py

Princípios:
  - workflow MANUAL, sem cron: clube é dado de manutenção, não dado ao vivo;
  - cache em dados/clubes_jogadores_cache.json;
  - nunca usa a seleção nacional como fallback de clube;
  - se não encontrar clube seguro, deixa vazio;
  - fontes em camadas: Wikidata SPARQL em lote, Wikidata Search/Entity e Wikipedia infobox.

Saídas:
  - dados/elencos.json com campo "clube" nos jogadores quando encontrado;
  - dados/clubes_jogadores_cache.json;
  - dados/clubes_jogadores_relatorio.json.
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
import urllib.error
from datetime import datetime, timezone, date

DIR = os.path.dirname(os.path.abspath(__file__))
DADOS = os.path.join(DIR, "dados")
ELENCOS_JSON = os.path.join(DADOS, "elencos.json")
SELECOES_JSON = os.path.join(DADOS, "selecoes.json")
CACHE_JSON = os.path.join(DADOS, "clubes_jogadores_cache.json")
RELATORIO_JSON = os.path.join(DADOS, "clubes_jogadores_relatorio.json")

HEADERS = {
    "User-Agent": "copa26-clubes-jogadores/1.0 (+brasileirao2026almoco.com.br; contato: site)",
    "Accept": "application/json,text/plain,*/*",
}

WD_SPARQL = "https://query.wikidata.org/sparql"
WD_SEARCH = "https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&type=item&limit=5&language={lang}&uselang={lang}&search={q}"
WD_ENTITY = "https://www.wikidata.org/wiki/Special:EntityData/{qid}.json"
WD_GETENT = "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels|descriptions|sitelinks&languages=en|pt|es|fr&ids={ids}"
WP_REV = "https://{lang}.wikipedia.org/w/api.php?action=query&format=json&prop=revisions&rvprop=content&rvslots=main&titles={title}"

# Propriedades Wikidata usadas
P_MEMBER_OF_TEAM = "P54"
P_START = "P580"
P_END = "P582"
P_OCCUPATION = "P106"
Q_ASSOCIATION_FOOTBALL_PLAYER = "Q937857"

BUSCA_LANGS = ["en", "pt", "es", "fr"]

ALIASES_SELECOES_EN = {
    "argentina", "brazil", "brasil", "france", "spain", "germany", "england", "netherlands",
    "united states", "usa", "usmnt", "mexico", "canada", "colombia", "uruguay", "paraguay",
    "ecuador", "morocco", "algeria", "tunisia", "egypt", "senegal", "ghana", "ivory coast",
    "cote d ivoire", "south africa", "dr congo", "democratic republic of the congo", "congo dr",
    "portugal", "belgium", "switzerland", "austria", "croatia", "sweden", "norway", "scotland",
    "czechia", "czech republic", "turkey", "turkiye", "bosnia", "bosnia and herzegovina",
    "saudi arabia", "qatar", "iran", "iraq", "jordan", "japan", "south korea", "korea republic",
    "australia", "new zealand", "uzbekistan", "panama", "haiti", "curacao", "cape verde", "cabo verde",
}


def agora_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def norm(s):
    s = unicodedata.normalize("NFD", str(s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def tokens(s):
    stop = {"de", "da", "do", "dos", "das", "del", "della", "van", "von", "bin", "al", "el", "jr", "junior", "ii", "iii", "the"}
    return [t for t in norm(s).split() if len(t) > 1 and t not in stop]


def nome_score(nome, label, desc=""):
    a = tokens(nome)
    b = tokens(label)
    if not a or not b:
        return 0.0
    if norm(nome) == norm(label):
        base = 1.0
    else:
        sa, sb = set(a), set(b)
        base = len(sa & sb) / max(1, len(sa | sb))
        if a[0] in sb:
            base += 0.10
        if a[-1] in sb:
            base += 0.22
    d = norm(desc)
    if any(x in d for x in ("footballer", "football player", "soccer player", "futebolista", "futbolista", "goalkeeper")):
        base += 0.15
    return min(1.0, base)


def carregar_json(caminho, padrao):
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


def tempo_esgotando(inicio, max_minutos, margem_seg=90):
    """Retorna True quando está perto do limite autoimposto.

    O workflow do GitHub tem timeout próprio. Este limite interno serve para
    encerrar com sucesso, gravar JSONs parciais e permitir o commit, em vez de
    perder tudo quando o GitHub mata o job.
    """
    if not max_minutos or max_minutos <= 0:
        return False
    return (time.monotonic() - inicio) >= max(0, (max_minutos * 60) - margem_seg)


def resumo_final(elencos, jogadores, agora, rel, encerrado_por_tempo=False):
    total_com = 0
    por_sel = {}
    for sigla, lista in (elencos.get("times") or {}).items():
        qtd = sum(1 for p in lista if p.get("clube"))
        por_sel[sigla] = {"jogadores": len(lista), "com_clube": qtd, "faltando": max(0, len(lista) - qtd)}
        total_com += qtd
    rel["com_clube_total"] = total_com
    rel["faltando_total"] = len(jogadores) - total_com
    rel["por_selecao"] = por_sel
    if encerrado_por_tempo:
        rel["encerrado_por_tempo"] = True
        rel["nota_execucao"] = "Execução encerrada antes do timeout do GitHub para preservar e publicar resultado parcial. Rode novamente para continuar."
    return rel


def salvar_parcial(elencos, cache, rel, jogadores, agora, motivo):
    elencos["clubes_atualizado_em"] = agora
    elencos["_nota_clubes"] = "Campo clube preenchido por buscar_clubes_jogadores.py. Se não houver clube seguro, o front não exibe fallback de seleção."
    cache["gerado_em"] = agora
    cache["_nota"] = "Cache de clube atual por jogador. Chave principal = id ESPN."
    rel["ultimo_checkpoint_em"] = agora_iso()
    rel["ultimo_checkpoint_motivo"] = motivo
    resumo_final(elencos, jogadores, agora, rel, encerrado_por_tempo=(motivo == "limite_tempo"))
    escrever_json(ELENCOS_JSON, elencos)
    escrever_json(CACHE_JSON, cache)
    escrever_json(RELATORIO_JSON, rel)


def http_json(url, timeout=30, tentativas=3, data=None, headers=None):
    ultimo = None
    for i in range(tentativas):
        try:
            req = urllib.request.Request(url, headers={**HEADERS, **(headers or {})}, data=data)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            ultimo = e
            if e.code in (429, 503):
                ra = e.headers.get("Retry-After") if e.headers else None
                espera = min(float(ra), 45) if (ra and str(ra).strip().isdigit()) else min(4 * (i + 1), 30)
                time.sleep(espera)
                continue
            if 500 <= e.code < 600:
                time.sleep(1.5 * (i + 1))
                continue
            return None
        except Exception as e:
            ultimo = e
            time.sleep(1.0 * (i + 1))
    if ultimo:
        return None
    return None


def post_sparql(query, timeout=45):
    body = urllib.parse.urlencode({"query": query, "format": "json"}).encode("utf-8")
    headers = {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/sparql-results+json"}
    return http_json(WD_SPARQL, timeout=timeout, tentativas=3, data=body, headers=headers)


def qid_from_value(value):
    if not isinstance(value, dict):
        return None
    if value.get("id"):
        return value.get("id")
    nid = value.get("numeric-id")
    return ("Q%s" % nid) if nid else None


def claim_entity_qid(claim):
    try:
        val = claim["mainsnak"]["datavalue"]["value"]
        return qid_from_value(val)
    except Exception:
        return None


def qualifier_time(claim, prop):
    try:
        qs = claim.get("qualifiers") or {}
        arr = qs.get(prop) or []
        if not arr:
            return None
        val = arr[0]["datavalue"]["value"]
        return val.get("time")
    except Exception:
        return None


def ano_de_time(t):
    if not t:
        return None
    m = re.search(r"([+-]?\d{4})", str(t))
    if not m:
        return None
    try:
        return int(m.group(1))
    except Exception:
        return None


def label_entity(entity, prefer="pt"):
    labels = (entity or {}).get("labels") or {}
    for lang in [prefer, "pt", "en", "es", "fr"]:
        if lang in labels and labels[lang].get("value"):
            return labels[lang]["value"]
    return ""


def desc_entity(entity):
    descs = (entity or {}).get("descriptions") or {}
    for lang in ["pt", "en", "es", "fr"]:
        if lang in descs and descs[lang].get("value"):
            return descs[lang]["value"]
    return ""


def carregar_aliases_selecoes():
    aliases = set(ALIASES_SELECOES_EN)
    data = carregar_json(SELECOES_JSON, {"selecoes": []})
    for s in data.get("selecoes") or []:
        for v in [s.get("id"), s.get("nome"), s.get("nome_en"), s.get("pais")]:
            if v:
                aliases.add(norm(v))
    return {x for x in aliases if x}


def eh_time_nacional(label, aliases):
    n = norm(label)
    if not n:
        return True
    if n in aliases:
        return True
    ruim = [
        "national football team", "national soccer team", "national team", "national under", "under 17", "under 18",
        "under 19", "under 20", "under 21", "under 23", "u 17", "u 18", "u 19", "u 20", "u 21",
        "u 23", "olympic football team", "olympic team", "youth national", "selecao nacional", "seleccion nacional",
        "equipa nacional", "equipe nationale", "nazionale", "federation", "federacao", "fifa world cup",
    ]
    if any(x in n for x in ruim):
        return True
    # Ex.: "Brazil Olympic football team", "Argentina under-20 national football team"
    if any(a and a in n for a in aliases) and any(x in n for x in ("under", "u 20", "u 21", "olympic", "national")):
        return True
    return False


def entidade_jogador_valida(entity):
    claims = (entity or {}).get("claims") or {}
    if P_MEMBER_OF_TEAM not in claims:
        return False
    # Se tiver P106 association football player, ótimo. Se não tiver, ainda aceita se houver P54,
    # pois alguns itens são incompletos, mas a escolha final exige time válido.
    for cl in claims.get(P_OCCUPATION) or []:
        if claim_entity_qid(cl) == Q_ASSOCIATION_FOOTBALL_PLAYER:
            return True
    return True


def buscar_entidade(qid):
    if not qid:
        return None
    data = http_json(WD_ENTITY.format(qid=urllib.parse.quote(qid)), timeout=30)
    try:
        return data["entities"][qid]
    except Exception:
        return None


def labels_qids(qids):
    qids = [q for q in dict.fromkeys(qids) if q]
    out = {}
    for i in range(0, len(qids), 50):
        bloco = qids[i:i + 50]
        data = http_json(WD_GETENT.format(ids="|".join(bloco)), timeout=30)
        for qid, ent in ((data or {}).get("entities") or {}).items():
            out[qid] = label_entity(ent) or qid
    return out


def selecionar_clube_de_claims(entity, aliases, label_cache=None):
    claims = (entity or {}).get("claims") or {}
    stmts = claims.get(P_MEMBER_OF_TEAM) or []
    if not stmts:
        return None
    qids = []
    for st in stmts:
        q = claim_entity_qid(st)
        if q:
            qids.append(q)
    labels = dict(label_cache or {})
    faltam = [q for q in qids if q not in labels]
    if faltam:
        labels.update(labels_qids(faltam))
    hoje_ano = date.today().year
    candidatos = []
    for st in stmts:
        if st.get("rank") == "deprecated":
            continue
        qid = claim_entity_qid(st)
        if not qid:
            continue
        label = labels.get(qid) or qid
        if eh_time_nacional(label, aliases):
            continue
        ini = ano_de_time(qualifier_time(st, P_START))
        fim = ano_de_time(qualifier_time(st, P_END))
        atual = (fim is None or fim >= hoje_ano)
        if not atual:
            continue
        score = 100
        if fim is None:
            score += 25
        if ini:
            score += min(max(ini - 1990, 0), 50)
        if any(x in norm(label) for x in (" fc", " cf", " sc", " ac", " athletic", "united", "city", "club", "futbol", "football", "soccer")):
            score += 10
        candidatos.append({"qid": qid, "label": label, "score": score, "inicio": ini, "fim": fim})
    if not candidatos:
        return None
    candidatos.sort(key=lambda x: (x["score"], x.get("inicio") or 0), reverse=True)
    c = candidatos[0]
    return {"clube": c["label"], "clube_wikidata": c["qid"], "confianca": 0.92 if c.get("fim") is None else 0.82}


def buscar_wikidata_search(nome, aliases):
    vistos = set()
    for lang in BUSCA_LANGS:
        data = http_json(WD_SEARCH.format(lang=lang, q=urllib.parse.quote(nome)), timeout=25)
        for item in (data or {}).get("search") or []:
            qid = item.get("id")
            if not qid or qid in vistos:
                continue
            vistos.add(qid)
            label = item.get("label") or ""
            desc = item.get("description") or ""
            if nome_score(nome, label, desc) < 0.55:
                continue
            ent = buscar_entidade(qid)
            if not entidade_jogador_valida(ent):
                continue
            res = selecionar_clube_de_claims(ent, aliases)
            if res:
                res["wikidata"] = qid
                res["fonte"] = "Wikidata Search/P54"
                res["confianca"] = min(0.90, res.get("confianca", 0.85))
                return res
            time.sleep(0.10)
    return None


def strip_wiki_markup(txt):
    txt = re.sub(r"<!--.*?-->", "", txt, flags=re.S)
    txt = re.sub(r"\{\{.*?\}\}", "", txt, flags=re.S)
    txt = re.sub(r"\[\[([^\]|]+)\|([^\]]+)\]\]", r"\2", txt)
    txt = re.sub(r"\[\[([^\]]+)\]\]", r"\1", txt)
    txt = re.sub(r"<.*?>", "", txt)
    txt = txt.replace("&nbsp;", " ")
    return re.sub(r"\s+", " ", txt).strip()


def wikipedia_currentclub(entity, aliases):
    sitelinks = (entity or {}).get("sitelinks") or {}
    targets = []
    for key, lang in [("enwiki", "en"), ("ptwiki", "pt"), ("eswiki", "es"), ("frwiki", "fr")]:
        if key in sitelinks and sitelinks[key].get("title"):
            targets.append((lang, sitelinks[key]["title"]))
    campos = [
        "currentclub", "current club", "club", "team", "clubeatual", "clube atual", "clube", "equipoactual", "clubactual",
        "equipo", "equipe actuelle", "club actuel",
    ]
    for lang, title in targets:
        data = http_json(WP_REV.format(lang=lang, title=urllib.parse.quote(title)), timeout=30)
        pages = ((data or {}).get("query") or {}).get("pages") or {}
        wikitext = ""
        for p in pages.values():
            revs = p.get("revisions") or []
            if not revs:
                continue
            slots = revs[0].get("slots") or {}
            if "main" in slots:
                wikitext = slots["main"].get("*") or slots["main"].get("content") or ""
            else:
                wikitext = revs[0].get("*") or ""
        if not wikitext:
            continue
        for campo in campos:
            pat = re.compile(r"^\s*\|\s*" + re.escape(campo) + r"\s*=\s*(.+)$", re.I | re.M)
            m = pat.search(wikitext)
            if not m:
                continue
            val = strip_wiki_markup(m.group(1).split("\n")[0])
            val = re.sub(r"\s*\(.*?\)\s*", " ", val).strip()
            if val and not eh_time_nacional(val, aliases) and len(val) <= 60:
                return {"clube": val, "fonte": "Wikipedia infobox", "confianca": 0.68}
    return None


def buscar_com_qid(qid, aliases, usar_wikipedia=True):
    ent = buscar_entidade(qid)
    if not ent or not entidade_jogador_valida(ent):
        return None
    res = selecionar_clube_de_claims(ent, aliases)
    if res:
        res["wikidata"] = qid
        res["fonte"] = "Wikidata P54"
        return res
    if usar_wikipedia:
        res = wikipedia_currentclub(ent, aliases)
        if res:
            res["wikidata"] = qid
            return res
    return None


def limpar_clube_invalido(p, aliases):
    c = p.get("clube") or p.get("club") or p.get("time") or p.get("team")
    if c and eh_time_nacional(str(c), aliases):
        for k in ["clube", "clube_fonte", "clube_confianca", "clube_atualizado_em", "clube_wikidata"]:
            p.pop(k, None)
        return True
    return False


def chave_cache(sigla, p):
    aid = str(p.get("id") or "").strip()
    if aid:
        return "id:%s" % aid
    return "%s|%s" % (sigla, norm(p.get("nome")))


def flatten_jogadores(elencos):
    out = []
    for sigla, lista in (elencos.get("times") or {}).items():
        for p in lista or []:
            out.append((sigla, p))
    return out


def sparql_literal(s):
    return '"' + str(s).replace('\\', '\\\\').replace('"', '\\"') + '"'


def preencher_lote_sparql(pendentes, aliases, rel, batch_size=45, inicio=None, max_minutos=0):
    """Primeira camada: consulta Wikidata em lotes por label exato. Retorna dict chave_cache->resultado."""
    achados = {}
    for i in range(0, len(pendentes), batch_size):
        if inicio is not None and tempo_esgotando(inicio, max_minutos, margem_seg=240):
            print("⚠️ Interrompendo SPARQL em lote por limite interno de tempo; salvarei o que já foi encontrado.")
            rel["sparql_interrompido_por_tempo"] = True
            break
        bloco = pendentes[i:i + batch_size]
        names = []
        key_by_name = {}
        for sigla, p in bloco:
            nome = str(p.get("nome") or "").strip()
            if not nome:
                continue
            names.append(nome)
            key_by_name.setdefault(norm(nome), []).append(chave_cache(sigla, p))
        if not names:
            continue
        values = " ".join(sparql_literal(n) for n in sorted(set(names)))
        query = """
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX p: <http://www.wikidata.org/prop/>
PREFIX ps: <http://www.wikidata.org/prop/statement/>
PREFIX pq: <http://www.wikidata.org/prop/qualifier/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?inputString ?person ?personLabel ?team ?teamLabel ?start ?end WHERE {
  VALUES ?inputString { %s }
  ?person rdfs:label ?label.
  FILTER(STR(?label) = ?inputString)
  FILTER(LANG(?label) IN ("en","pt","es","fr"))
  ?person wdt:P106 wd:Q937857.
  ?person p:P54 ?st.
  ?st ps:P54 ?team.
  OPTIONAL { ?st pq:P580 ?start. }
  OPTIONAL { ?st pq:P582 ?end. }
  FILTER(!BOUND(?end) || ?end >= NOW())
  SERVICE wikibase:label { bd:serviceParam wikibase:language "pt,en,es,fr". ?person rdfs:label ?personLabel. ?team rdfs:label ?teamLabel. }
}
""" % values
        data = post_sparql(query, timeout=60)
        bindings = (((data or {}).get("results") or {}).get("bindings") or [])
        por_chave = {}
        for b in bindings:
            inp = b.get("inputString", {}).get("value") or ""
            label = b.get("teamLabel", {}).get("value") or ""
            if not label or eh_time_nacional(label, aliases):
                continue
            person_uri = b.get("person", {}).get("value") or ""
            team_uri = b.get("team", {}).get("value") or ""
            qid = person_uri.rsplit("/", 1)[-1] if person_uri else None
            team_qid = team_uri.rsplit("/", 1)[-1] if team_uri else None
            ini = ano_de_time(b.get("start", {}).get("value"))
            fim = ano_de_time(b.get("end", {}).get("value"))
            score = 100 + (25 if fim is None else 0) + (min(max((ini or 1990) - 1990, 0), 50))
            res = {"clube": label, "fonte": "Wikidata SPARQL/P54", "confianca": 0.88 if fim is None else 0.78, "wikidata": qid, "clube_wikidata": team_qid, "_score": score}
            for key in key_by_name.get(norm(inp), []):
                if key not in por_chave or res["_score"] > por_chave[key]["_score"]:
                    por_chave[key] = res
        for key, res in por_chave.items():
            res.pop("_score", None)
            achados[key] = res
        rel["lotes_sparql"] += 1
        rel["linhas_sparql"] += len(bindings)
        time.sleep(0.35)
    return achados


def aplicar_resultado(p, res, agora):
    if not res or not res.get("clube"):
        for k in ["clube", "clube_fonte", "clube_confianca", "clube_atualizado_em", "clube_wikidata"]:
            p.pop(k, None)
        return
    p["clube"] = res["clube"]
    p["clube_fonte"] = res.get("fonte") or "Wikidata/Wikipedia"
    p["clube_confianca"] = round(float(res.get("confianca") or 0.70), 2)
    p["clube_atualizado_em"] = agora
    if res.get("wikidata"):
        p["wikidata"] = res.get("wikidata")
    if res.get("clube_wikidata"):
        p["clube_wikidata"] = res.get("clube_wikidata")


def rodar(args):
    aliases = carregar_aliases_selecoes()
    elencos = carregar_json(ELENCOS_JSON, {"times": {}})
    cache = carregar_json(CACHE_JSON, {"itens": {}})
    itens = cache.setdefault("itens", {})
    jogadores = flatten_jogadores(elencos)
    agora = agora_iso()
    rel = {
        "gerado_em": agora,
        "total_jogadores": len(jogadores),
        "mantidos_cache": 0,
        "mantidos_existentes": 0,
        "novos": 0,
        "sem_clube": 0,
        "invalidos_removidos": 0,
        "lotes_sparql": 0,
        "linhas_sparql": 0,
        "fontes": {},
        "sem_clube_amostra": [],
        "processados_nesta_rodada": 0,
        "pendentes_iniciais": 0,
        "limite_minutos": args.max_minutos,
        "checkpoint_cada": args.checkpoint_cada,
    }

    inicio_execucao = time.monotonic()

    # Limpa qualquer lixo anterior do tipo "Brasil/Argentina" como clube.
    for _, p in jogadores:
        if limpar_clube_invalido(p, aliases):
            rel["invalidos_removidos"] += 1

    pendentes = []
    for sigla, p in jogadores:
        key = chave_cache(sigla, p)
        c = str(p.get("clube") or "").strip()
        if c and not args.force and not eh_time_nacional(c, aliases):
            rel["mantidos_existentes"] += 1
            continue
        cached = itens.get(key) or {}
        if cached.get("clube") and not args.force and not eh_time_nacional(cached["clube"], aliases):
            aplicar_resultado(p, cached, cached.get("atualizado_em") or agora)
            rel["mantidos_cache"] += 1
            continue
        if cached.get("sem_clube") and not args.force and cached.get("atualizado_em"):
            # Cache negativo: evita repetir tudo em execuções próximas.
            rel["sem_clube"] += 1
            if len(rel["sem_clube_amostra"]) < 20:
                rel["sem_clube_amostra"].append({"selecao": sigla, "nome": p.get("nome")})
            continue
        pendentes.append((sigla, p))

    if args.limite and args.limite > 0:
        pendentes = pendentes[:args.limite]

    rel["pendentes_iniciais"] = len(pendentes)
    print("→ Jogadores: %d | pendentes para busca: %d | limite interno: %s min" % (len(jogadores), len(pendentes), args.max_minutos or "sem limite"))

    achados_sparql = preencher_lote_sparql(pendentes, aliases, rel, batch_size=args.batch, inicio=inicio_execucao, max_minutos=args.max_minutos)
    # Já salva se o SPARQL em lote encontrou algo, para não perder esta parte se a execução parar depois.
    if achados_sparql:
        for sigla, p in pendentes:
            key = chave_cache(sigla, p)
            res0 = achados_sparql.get(key)
            if res0 and not p.get("clube"):
                aplicar_resultado(p, res0, agora)
                cache_item = dict(res0)
                cache_item["nome"] = p.get("nome")
                cache_item["selecao"] = sigla
                cache_item["atualizado_em"] = agora
                itens[key] = cache_item
                rel["novos"] += 1
                fonte = res0.get("fonte") or "desconhecida"
                rel["fontes"][fonte] = rel["fontes"].get(fonte, 0) + 1
        salvar_parcial(elencos, cache, rel, jogadores, agora, "pos_sparql")

    processados = 0
    for sigla, p in pendentes:
        key = chave_cache(sigla, p)
        if p.get("clube") and not args.force:
            processados += 1
            rel["processados_nesta_rodada"] = processados
            continue
        res = None
        qid = p.get("wikidata")
        if True:
            if qid:
                res = buscar_com_qid(qid, aliases, usar_wikipedia=not args.sem_wikipedia)
            if not res:
                res = buscar_wikidata_search(p.get("nome") or "", aliases)
            if not res and qid and not args.sem_wikipedia:
                ent = buscar_entidade(qid)
                res = wikipedia_currentclub(ent, aliases)
        if res and res.get("clube") and not eh_time_nacional(res["clube"], aliases):
            aplicar_resultado(p, res, agora)
            cache_item = dict(res)
            cache_item["nome"] = p.get("nome")
            cache_item["selecao"] = sigla
            cache_item["atualizado_em"] = agora
            itens[key] = cache_item
            rel["novos"] += 1
            fonte = res.get("fonte") or "desconhecida"
            rel["fontes"][fonte] = rel["fontes"].get(fonte, 0) + 1
        else:
            for k in ["clube", "clube_fonte", "clube_confianca", "clube_atualizado_em", "clube_wikidata"]:
                p.pop(k, None)
            itens[key] = {"nome": p.get("nome"), "selecao": sigla, "sem_clube": True, "atualizado_em": agora}
            rel["sem_clube"] += 1
            if len(rel["sem_clube_amostra"]) < 20:
                rel["sem_clube_amostra"].append({"selecao": sigla, "nome": p.get("nome")})
        processados += 1
        rel["processados_nesta_rodada"] = processados
        if processados % 25 == 0:
            print("  processados %d/%d | novos=%d | sem=%d" % (processados, len(pendentes), rel["novos"], rel["sem_clube"]))
        if args.checkpoint_cada and args.checkpoint_cada > 0 and processados % args.checkpoint_cada == 0:
            salvar_parcial(elencos, cache, rel, jogadores, agora, "checkpoint_%d" % processados)
            print("  ✓ checkpoint salvo em %d/%d" % (processados, len(pendentes)))
        if tempo_esgotando(inicio_execucao, args.max_minutos):
            print("⚠️ Limite interno de tempo se aproximando. Salvando parcial e encerrando com sucesso para permitir commit.")
            salvar_parcial(elencos, cache, rel, jogadores, agora, "limite_tempo")
            print("✓ Parcial salvo. Rode o workflow novamente para continuar do cache.")
            return 0
        time.sleep(args.sleep)

    # Contagem final real após aplicar.
    salvar_parcial(elencos, cache, rel, jogadores, agora, "final")
    print("✓ Clubes: %d/%d jogadores com clube. Novos nesta rodada: %d." % (rel.get("com_clube_total"), len(jogadores), rel["novos"]))
    print("  Relatório: dados/clubes_jogadores_relatorio.json")
    return 0


def selftest():
    ok = True
    aliases = {"brasil", "brazil", "argentina", "france"}
    def checa(cond, msg):
        nonlocal ok
        print(("  ok  " if cond else "  ERRO ") + msg)
        if not cond:
            ok = False
    checa(eh_time_nacional("Brazil national football team", aliases), "ignora seleção nacional")
    checa(eh_time_nacional("Argentina", aliases), "ignora nome puro da seleção")
    checa(not eh_time_nacional("Inter Miami CF", aliases), "aceita clube real")
    checa(not eh_time_nacional("Manchester City", aliases), "aceita clube com City")
    ent = {"claims": {"P54": [
        {"mainsnak": {"datavalue": {"value": {"id": "Q79800"}}}, "qualifiers": {}},
        {"mainsnak": {"datavalue": {"value": {"id": "Q32494"}}}, "qualifiers": {"P582": [{"datavalue": {"value": {"time": "+2018-01-01T00:00:00Z"}}}]}},
    ]}}
    # Monkey patch labels_qids só para este teste offline.
    global labels_qids
    old = labels_qids
    labels_qids = lambda qids: {"Q79800": "Inter Miami CF", "Q32494": "Argentina national football team"}
    res = selecionar_clube_de_claims(ent, aliases)
    labels_qids = old
    checa(res and res.get("clube") == "Inter Miami CF", "seleciona clube atual e ignora seleção")
    checa(nome_score("Neymar Jr", "Neymar", "Brazilian footballer") >= 0.55, "score aceita nome futebolístico próximo")
    print("\nSELFTEST:", "PASSOU ✅" if ok else "FALHOU ❌")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--force", action="store_true", help="ignora cache e tenta buscar novamente")
    ap.add_argument("--limite", type=int, default=0, help="limita quantidade de pendentes pesquisados nesta rodada")
    ap.add_argument("--batch", type=int, default=45, help="tamanho do lote SPARQL")
    ap.add_argument("--sleep", type=float, default=0.08, help="pausa curta entre jogadores no fallback")
    ap.add_argument("--sem-wikipedia", action="store_true", help="não tenta fallback por infobox Wikipedia")
    ap.add_argument("--max-minutos", type=int, default=55, help="limite interno em minutos para salvar parcial antes do timeout do GitHub")
    ap.add_argument("--checkpoint-cada", type=int, default=25, help="salva JSONs a cada N jogadores processados")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    return rodar(args)

if __name__ == "__main__":
    sys.exit(main())
