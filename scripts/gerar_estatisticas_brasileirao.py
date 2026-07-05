#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gerar_estatisticas_brasileirao.py — Estatísticas do Brasileirão v2.

Gera:
  - dados-br/estatisticas.json
  - dados-br/ranking-desempenho.json

Fontes:
  - tabela.json         (classificação ESPN, já normalizada)
  - resultados.json     (resultados finalizados ESPN)
  - espn_eventos.json   (índice de event_id ESPN)
  - ESPN summary/event detail, quando houver event_id

Importante:
  - Não altera módulo copa2026/.
  - Se a ESPN summary não trouxer gols/assistências, o script NÃO quebra:
    ele publica ataque, defesa, forma e desempenho e deixa aviso editorial.
  - Só usa biblioteca padrão.
"""
from __future__ import annotations

import json
import math
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    from atualizar_espn import (  # type: ignore
        CANONICOS,
        ESCUDOS_TIMES,
        FUSO_BRASILIA,
        HEADERS,
        normalizar,
        para_canonico,
    )
except Exception:  # pragma: no cover - fallback para execução isolada
    FUSO_BRASILIA = timezone(timedelta(hours=-3))
    CANONICOS = []
    ESCUDOS_TIMES = {}
    HEADERS = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}

    def normalizar(nome: Any) -> str:
        s = unicodedata.normalize("NFD", str(nome or ""))
        s = "".join(c for c in s if unicodedata.category(c) != "Mn")
        s = re.sub(r"[^a-z0-9\- ]", " ", s.lower())
        return re.sub(r"\s+", " ", s).strip()

    def para_canonico(*candidatos: Any) -> str | None:
        return str(candidatos[0]) if candidatos and candidatos[0] else None

TEMPORADA = int(os.environ.get("BRASILEIRAO_TEMPORADA", "2026"))
URL_SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/summary?event={event_id}"


def agora_brt() -> datetime:
    return datetime.now(FUSO_BRASILIA)


def iso_agora_brt() -> str:
    return agora_brt().isoformat()


def ler_json(caminho: str | Path, default: Any) -> Any:
    p = ROOT / caminho
    if not p.exists():
        return default
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        print(f"Aviso: não foi possível ler {caminho}: {e}")
        return default


def gravar_json_atomico(caminho: str | Path, payload: dict[str, Any]) -> None:
    p = ROOT / caminho
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(p)


def escudo_time(nome: str) -> str:
    return (ESCUDOS_TIMES.get(nome) or {}).get("escudo", "")


def sigla_time(nome: str) -> str:
    return (ESCUDOS_TIMES.get(nome) or {}).get("sigla", normalizar(nome)[:3].upper())


def parse_data_iso(v: Any) -> datetime | None:
    if not v:
        return None
    s = str(v)
    try:
        if s.endswith("Z"):
            return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(FUSO_BRASILIA)
        d = datetime.fromisoformat(s)
        if d.tzinfo is None:
            d = d.replace(tzinfo=FUSO_BRASILIA)
        return d.astimezone(FUSO_BRASILIA)
    except ValueError:
        return None


def placar(r: dict[str, Any]) -> tuple[int | None, int | None]:
    def conv(x: Any) -> int | None:
        if x is None or x == "":
            return None
        try:
            return int(x)
        except (TypeError, ValueError):
            return None
    return conv(r.get("placar_mandante")), conv(r.get("placar_visitante"))


def nome_mandante(r: dict[str, Any]) -> str | None:
    m = r.get("mandante") or {}
    return para_canonico(m.get("nome") if isinstance(m, dict) else m)


def nome_visitante(r: dict[str, Any]) -> str | None:
    v = r.get("visitante") or {}
    return para_canonico(v.get("nome") if isinstance(v, dict) else v)


def pontos_do_time(r: dict[str, Any], time_nome: str) -> int | None:
    mand = nome_mandante(r)
    vis = nome_visitante(r)
    pm, pv = placar(r)
    if mand is None or vis is None or pm is None or pv is None:
        return None
    if time_nome == mand:
        return 3 if pm > pv else 1 if pm == pv else 0
    if time_nome == vis:
        return 3 if pv > pm else 1 if pv == pm else 0
    return None


def letra_resultado(r: dict[str, Any], time_nome: str) -> str | None:
    p = pontos_do_time(r, time_nome)
    if p is None:
        return None
    return "V" if p == 3 else "E" if p == 1 else "D"


def carregar_tabela() -> list[dict[str, Any]]:
    payload = ler_json("tabela.json", {"tabela": []})
    linhas = payload.get("tabela") if isinstance(payload, dict) else []
    saida = []
    for l in linhas or []:
        nome = para_canonico(l.get("time")) or str(l.get("time") or "")
        if not nome:
            continue
        obj = dict(l)
        obj["time"] = nome
        obj["escudo"] = obj.get("escudo") or escudo_time(nome)
        obj["sigla"] = obj.get("sigla") or sigla_time(nome)
        saida.append(obj)
    return saida


def carregar_resultados() -> list[dict[str, Any]]:
    payload = ler_json("resultados.json", {"resultados": []})
    resultados = payload.get("resultados") if isinstance(payload, dict) else []
    validos: list[dict[str, Any]] = []
    for r in resultados or []:
        mand = nome_mandante(r)
        vis = nome_visitante(r)
        pm, pv = placar(r)
        dt = parse_data_iso(r.get("data_iso"))
        if not mand or not vis or pm is None or pv is None or not dt:
            continue
        rr = dict(r)
        rr["_mand"] = mand
        rr["_vis"] = vis
        rr["_pm"] = pm
        rr["_pv"] = pv
        rr["_dt"] = dt
        validos.append(rr)
    validos.sort(key=lambda x: x["_dt"])
    return validos


def resultados_por_time(resultados: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    mapa: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in resultados:
        mapa[r["_mand"]].append(r)
        mapa[r["_vis"]].append(r)
    for lista in mapa.values():
        lista.sort(key=lambda x: x["_dt"])
    return mapa


def split_casa_fora(resultados: list[dict[str, Any]], time_nome: str, lado: str) -> dict[str, int]:
    jogos = [r for r in resultados if (lado == "mandante" and r["_mand"] == time_nome) or (lado == "visitante" and r["_vis"] == time_nome)]
    pts = gp = gc = v = e = d = 0
    for r in jogos:
        if lado == "mandante":
            pro, contra = r["_pm"], r["_pv"]
        else:
            pro, contra = r["_pv"], r["_pm"]
        gp += pro
        gc += contra
        if pro > contra:
            pts += 3; v += 1
        elif pro == contra:
            pts += 1; e += 1
        else:
            d += 1
    j = len(jogos)
    return {
        "jogos": j,
        "pontos": pts,
        "vitorias": v,
        "empates": e,
        "derrotas": d,
        "gp": gp,
        "gc": gc,
        "sg": gp - gc,
        "aproveitamento": round(100 * pts / (3 * j)) if j else 0,
    }


def sequencia_atual(lista: list[dict[str, Any]], time_nome: str) -> dict[str, Any]:
    letras = [letra_resultado(r, time_nome) for r in lista]
    letras = [l for l in letras if l]
    if not letras:
        return {"tipo": "sem dados", "quantidade": 0, "texto": "sem jogos suficientes"}
    ultimo = letras[-1]
    qtd = 0
    for l in reversed(letras):
        if l == ultimo:
            qtd += 1
        else:
            break
    mapa = {"V": "vitória(s)", "E": "empate(s)", "D": "derrota(s)"}
    return {"tipo": ultimo, "quantidade": qtd, "texto": f"{qtd} {mapa.get(ultimo, 'jogo(s)')} seguida(s)"}


def montar_clubes(tabela: list[dict[str, Any]], resultados: list[dict[str, Any]]) -> list[dict[str, Any]]:
    por_time = resultados_por_time(resultados)
    clubes: list[dict[str, Any]] = []
    for l in tabela:
        nome = l["time"]
        lista = por_time.get(nome, [])
        ultimos = lista[-5:]
        forma = [letra_resultado(r, nome) for r in ultimos]
        forma = [f for f in forma if f]
        pontos_ult5 = sum(pontos_do_time(r, nome) or 0 for r in ultimos)
        jogos_ult5 = len(ultimos)
        aproveit_ult5 = round(100 * pontos_ult5 / (3 * jogos_ult5)) if jogos_ult5 else 0

        obj = {
            "time": nome,
            "escudo": l.get("escudo") or escudo_time(nome),
            "sigla": l.get("sigla") or sigla_time(nome),
            "pos": int(l.get("pos") or 0),
            "pontos": int(l.get("pontos") or 0),
            "jogos": int(l.get("jogos") or 0),
            "vitorias": int(l.get("vitorias") or 0),
            "empates": int(l.get("empates") or 0),
            "derrotas": int(l.get("derrotas") or 0),
            "gp": int(l.get("gp") or 0),
            "gc": int(l.get("gc") or 0),
            "sg": int(l.get("sg") or 0),
            "aproveitamento": int(l.get("aproveitamento") or 0),
            "forma_ultimos5": forma,
            "pontos_ultimos5": pontos_ult5,
            "aproveitamento_ultimos5": aproveit_ult5,
            "mandante": split_casa_fora(resultados, nome, "mandante"),
            "visitante": split_casa_fora(resultados, nome, "visitante"),
            "sequencia": sequencia_atual(lista, nome),
        }
        clubes.append(obj)
    return clubes


def score_desempenho(c: dict[str, Any]) -> int:
    aproveitamento = float(c.get("aproveitamento") or 0)
    forma = float(c.get("aproveitamento_ultimos5") or 0)
    jogos = max(1, int(c.get("jogos") or 1))
    saldo_por_jogo = float(c.get("sg") or 0) / jogos
    ataque_por_jogo = float(c.get("gp") or 0) / jogos
    defesa_por_jogo = float(c.get("gc") or 0) / jogos
    pos = int(c.get("pos") or 20)
    bonus_posicao = max(0, 21 - pos) * 0.7
    bruto = (
        aproveitamento * 0.50
        + forma * 0.22
        + min(18, max(-10, saldo_por_jogo * 8))
        + min(8, ataque_por_jogo * 3)
        - min(7, defesa_por_jogo * 2)
        + bonus_posicao
    )
    return max(0, min(100, int(round(bruto))))


def gerar_ranking_desempenho(clubes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ranking = []
    for c in clubes:
        score = score_desempenho(c)
        forma_txt = "".join(c.get("forma_ultimos5") or []) or "sem forma recente"
        justificativa = (
            f"{c.get('aproveitamento', 0)}% de aproveitamento, saldo {c.get('sg', 0)}, "
            f"forma {forma_txt} e {c.get('pontos_ultimos5', 0)} ponto(s) nos últimos {len(c.get('forma_ultimos5') or [])} jogos."
        )
        ranking.append({
            "time": c["time"],
            "escudo": c.get("escudo", ""),
            "sigla": c.get("sigla", ""),
            "score": score,
            "pos_tabela": c.get("pos"),
            "pontos": c.get("pontos"),
            "jogos": c.get("jogos"),
            "sg": c.get("sg"),
            "gp": c.get("gp"),
            "gc": c.get("gc"),
            "aproveitamento": c.get("aproveitamento"),
            "forma_ultimos5": c.get("forma_ultimos5"),
            "justificativa": justificativa,
        })
    ranking.sort(key=lambda x: (-x["score"], int(x.get("pos_tabela") or 99), normalizar(x["time"])))
    for i, item in enumerate(ranking, 1):
        item["pos"] = i
    return ranking


def fetch_json(url: str, timeout: int = 25, tentativas: int = 2) -> dict[str, Any] | None:
    ultimo: Exception | None = None
    for i in range(1, tentativas + 1):
        try:
            sep = "&" if "?" in url else "?"
            req = urllib.request.Request(f"{url}{sep}_={int(time.time())}", headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout + (i - 1) * 10) as resp:
                charset = resp.headers.get_content_charset() or "utf-8"
                return json.loads(resp.read().decode(charset, errors="replace"))
        except Exception as e:  # noqa: BLE001
            ultimo = e
            if i < tentativas:
                time.sleep(1.5 * i)
    print(f"Aviso: falha ao buscar {url}: {ultimo}")
    return None


def event_ids_resultados(resultados: list[dict[str, Any]]) -> list[str]:
    ids: list[str] = []
    for r in resultados:
        eid = str(r.get("event_id") or r.get("id") or "").strip()
        if eid and eid not in ids:
            ids.append(eid)
    # Fallback pelo índice geral, se resultados.json ainda for legado.
    eventos = ler_json("espn_eventos.json", {"eventos": []}).get("eventos") or []
    for ev in eventos:
        estado = str(ev.get("estado") or "").lower()
        pm, pv = ev.get("placar_mandante"), ev.get("placar_visitante")
        if estado == "post" or (pm is not None and pv is not None):
            eid = str(ev.get("event_id") or "").strip()
            if eid and eid not in ids:
                ids.append(eid)
    return ids


def procurar_dicts(no: Any, pred, achados: list[dict[str, Any]]) -> None:
    if isinstance(no, dict):
        try:
            if pred(no):
                achados.append(no)
        except Exception:
            pass
        for v in no.values():
            procurar_dicts(v, pred, achados)
    elif isinstance(no, list):
        for v in no:
            procurar_dicts(v, pred, achados)


def nome_atleta(no: Any) -> str | None:
    if not isinstance(no, dict):
        return None
    candidatos = [
        no.get("displayName"), no.get("fullName"), no.get("name"), no.get("shortName"),
        (no.get("athlete") or {}).get("displayName") if isinstance(no.get("athlete"), dict) else None,
        (no.get("player") or {}).get("displayName") if isinstance(no.get("player"), dict) else None,
    ]
    for c in candidatos:
        if c and len(str(c).strip()) > 1:
            return str(c).strip()
    return None


def time_de_no(no: dict[str, Any]) -> str | None:
    candidatos: list[Any] = []
    for chave in ("team", "club", "competitor"):
        obj = no.get(chave)
        if isinstance(obj, dict):
            candidatos.extend([obj.get("displayName"), obj.get("shortDisplayName"), obj.get("name"), obj.get("abbreviation"), obj.get("slug")])
    candidatos.extend([no.get("teamName"), no.get("teamAbbreviation")])
    return para_canonico(*candidatos)


def extrair_gols_summary(data: dict[str, Any], event_id: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Extrai gols/assistências de forma tolerante a variações da ESPN."""
    plays: list[dict[str, Any]] = []

    # Caminho principal em vários esportes da ESPN.
    for chave in ("scoringPlays", "scoringplays"):
        if isinstance(data.get(chave), list):
            plays.extend([p for p in data[chave] if isinstance(p, dict)])

    # Caminhos alternativos: drives/competitions/details/comentary.
    def parece_gol(no: dict[str, Any]) -> bool:
        texto = " ".join(str(no.get(k) or "") for k in ("type", "text", "description", "displayName", "shortDisplayName"))
        n = normalizar(texto)
        return any(tok in n.split() or tok in n for tok in ("goal", "gol", "penalty goal", "own goal")) and not any(x in n for x in ("yellow", "red card", "substitution"))

    procurar_dicts(data, parece_gol, plays)

    gols: list[dict[str, Any]] = []
    assistencias: list[dict[str, Any]] = []
    vistos: set[str] = set()

    for p in plays:
        texto = str(p.get("text") or p.get("description") or p.get("displayName") or "")
        minuto = p.get("clock") or p.get("time") or p.get("displayClock") or ""
        equipe = time_de_no(p)

        atletas: list[dict[str, Any]] = []
        for chave in ("athletes", "participants", "players"):
            if isinstance(p.get(chave), list):
                atletas.extend([a for a in p[chave] if isinstance(a, dict)])
        for chave in ("athlete", "player", "scorer"):
            if isinstance(p.get(chave), dict):
                atletas.append(p[chave])

        scorer = None
        assists: list[str] = []
        for a in atletas:
            papel = normalizar(a.get("type") or a.get("role") or a.get("position") or a.get("displayName") or "")
            nome = nome_atleta(a)
            if not nome:
                continue
            if any(tok in papel for tok in ("assist", "assistance")):
                assists.append(nome)
            elif scorer is None:
                scorer = nome

        # Algumas respostas trazem assistAthletes/assistants.
        for chave in ("assistAthletes", "assists", "assistants"):
            if isinstance(p.get(chave), list):
                for a in p[chave]:
                    nome = nome_atleta(a)
                    if nome:
                        assists.append(nome)

        # Fallback textual bem conservador para padrões "Nome (assistência de X)".
        if not scorer and texto:
            m = re.match(r"\s*([^,()\-–—]+?)\s*(?:\(|,|\-|–|—|$)", texto)
            if m and len(m.group(1).strip().split()) <= 4:
                scorer = m.group(1).strip()

        if not scorer:
            continue

        chave_visto = f"{event_id}|{normalizar(scorer)}|{normalizar(str(minuto))}|{normalizar(texto)}"
        if chave_visto in vistos:
            continue
        vistos.add(chave_visto)

        gols.append({
            "event_id": event_id,
            "nome": scorer,
            "time": equipe or "",
            "minuto": str(minuto or ""),
            "descricao": texto,
        })
        for a in dict.fromkeys(assists):
            if normalizar(a) != normalizar(scorer):
                assistencias.append({
                    "event_id": event_id,
                    "nome": a,
                    "time": equipe or "",
                    "minuto": str(minuto or ""),
                    "descricao": texto,
                })

    return gols, assistencias


def agregar_jogadores(eventos: list[dict[str, Any]], campo: str) -> list[dict[str, Any]]:
    cont = Counter()
    times: dict[tuple[str, str], str] = {}
    eventos_por: dict[tuple[str, str], set[str]] = defaultdict(set)
    for e in eventos:
        nome = str(e.get("nome") or "").strip()
        time_nome = para_canonico(e.get("time")) or str(e.get("time") or "")
        if not nome:
            continue
        chave = (normalizar(nome), normalizar(time_nome))
        cont[chave] += 1
        times[chave] = time_nome
        eventos_por[chave].add(str(e.get("event_id") or ""))
    saida = []
    for (nome_norm, _time_norm), qtd in cont.most_common():
        # Reusa primeira grafia que apareceu no evento.
        nome_real = next((str(e.get("nome")) for e in eventos if normalizar(e.get("nome")) == nome_norm), nome_norm.title())
        time_nome = times.get((nome_norm, _time_norm), "")
        saida.append({
            "nome": nome_real,
            "time": time_nome,
            "escudo": escudo_time(time_nome),
            campo: qtd,
            "eventos": len(eventos_por[(nome_norm, _time_norm)]),
        })
    saida.sort(key=lambda x: (-int(x.get(campo, 0)), normalizar(x.get("time")), normalizar(x.get("nome"))))
    return saida


def coletar_artilharia_assistencias(resultados: list[dict[str, Any]], avisos: list[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    ids = event_ids_resultados(resultados)
    if not ids:
        avisos.append("Nenhum event_id ESPN encontrado ainda em resultados.json/espn_eventos.json; artilharia e assistências ficam em espera até o próximo snapshot ESPN completo.")
        return [], [], []

    limite = int(os.environ.get("BR_STATS_MAX_SUMMARIES", "80"))
    if len(ids) > limite:
        avisos.append(f"Coleta de summaries limitada a {limite} eventos nesta execução para evitar excesso de chamadas à ESPN.")
        ids = ids[-limite:]

    eventos_gols: list[dict[str, Any]] = []
    eventos_assist: list[dict[str, Any]] = []
    processados: list[dict[str, Any]] = []

    for i, eid in enumerate(ids, 1):
        url = URL_SUMMARY.format(event_id=urllib.parse.quote(eid))
        data = fetch_json(url, timeout=22, tentativas=2)
        if not data:
            continue
        gols, assists = extrair_gols_summary(data, eid)
        eventos_gols.extend(gols)
        eventos_assist.extend(assists)
        processados.append({"event_id": eid, "gols": len(gols), "assistencias": len(assists)})
        if i % 10 == 0:
            print(f"  summaries processados: {i}/{len(ids)}")
        time.sleep(0.18)

    if not eventos_gols:
        avisos.append("A ESPN respondeu aos summaries, mas o robô não encontrou eventos de gol em formato reconhecível. A página continua exibindo ataque/defesa/desempenho.")
    if not eventos_assist:
        avisos.append("Assistências podem não estar disponíveis nos summaries da ESPN para todos os jogos; quando vierem, o ranking de garçons será preenchido automaticamente.")

    return agregar_jogadores(eventos_gols, "gols"), agregar_jogadores(eventos_assist, "assistencias"), processados


def main() -> None:
    tabela = carregar_tabela()
    resultados = carregar_resultados()
    avisos: list[str] = []

    if not tabela:
        raise RuntimeError("tabela.json sem dados; rode atualizar_espn.py antes das estatísticas.")

    clubes = montar_clubes(tabela, resultados)
    ranking = gerar_ranking_desempenho(clubes)
    artilharia, garcons, eventos_processados = coletar_artilharia_assistencias(resultados, avisos)

    melhor_ataque = sorted(clubes, key=lambda c: (-int(c.get("gp") or 0), int(c.get("jogos") or 99), normalizar(c["time"])))
    melhor_defesa = sorted(clubes, key=lambda c: (int(c.get("gc") or 999), -int(c.get("sg") or 0), normalizar(c["time"])))
    lider_geral = min(clubes, key=lambda c: int(c.get("pos") or 99))
    time_em_alta = ranking[0] if ranking else {}

    payload_stats = {
        "atualizado_em": iso_agora_brt(),
        "temporada": TEMPORADA,
        "fonte": "ESPN + snapshots locais",
        "total_resultados_lidos": len(resultados),
        "total_eventos_processados": len(eventos_processados),
        "resumo": {
            "lider_geral": lider_geral,
            "melhor_ataque": melhor_ataque[0] if melhor_ataque else {},
            "melhor_defesa": melhor_defesa[0] if melhor_defesa else {},
            "time_em_alta": time_em_alta,
        },
        "artilharia": artilharia,
        "garcons": garcons,
        "melhor_ataque": melhor_ataque,
        "melhor_defesa": melhor_defesa,
        "clubes": clubes,
        "ranking_desempenho": ranking,
        "eventos_processados": eventos_processados,
        "avisos": avisos,
    }

    payload_ranking = {
        "atualizado_em": payload_stats["atualizado_em"],
        "temporada": TEMPORADA,
        "fonte": "ESPN + tabela/resultados locais",
        "metodologia": "Índice de 0 a 100 ponderando aproveitamento geral, forma recente, saldo de gols, ataque, defesa e posição na tabela.",
        "ranking": ranking,
    }

    gravar_json_atomico("dados-br/estatisticas.json", payload_stats)
    gravar_json_atomico("dados-br/ranking-desempenho.json", payload_ranking)

    print("== ESTATÍSTICAS GERADAS ==")
    print(f"  clubes: {len(clubes)}")
    print(f"  resultados lidos: {len(resultados)}")
    print(f"  artilharia: {len(artilharia)} jogadores")
    print(f"  garçons: {len(garcons)} jogadores")
    print(f"  summaries processados: {len(eventos_processados)}")
    if avisos:
        print("Avisos:")
        for a in avisos:
            print(f"  - {a}")


if __name__ == "__main__":
    main()
