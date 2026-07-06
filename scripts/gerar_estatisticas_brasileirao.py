#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gerar_estatisticas_brasileirao.py — Estatísticas do Brasileirão v2.

Gera:
  - dados-br/estatisticas.json
  - dados-br/ranking-desempenho.json
  - dados-br/jogadores.json

Fontes:
  - tabela.json         (classificação ESPN, já normalizada)
  - resultados.json     (resultados finalizados ESPN)
  - espn_eventos.json   (índice de event_id ESPN)
  - ESPN summary/event detail, quando houver event_id

Importante:
  - Não altera módulo copa2026/.
  - Se a ESPN summary não trouxer gols/assistências, o script NÃO quebra nem inventa dados:
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



def atleta_info(no: Any) -> dict[str, str] | None:
    """Retorna nome/id/foto de atleta em formatos variados da ESPN."""
    if not isinstance(no, dict):
        return None
    base = no
    for chave in ("athlete", "player", "participant", "scorer"):
        if isinstance(no.get(chave), dict):
            base = no[chave]
            break
    candidatos = [
        base.get("displayName"), base.get("fullName"), base.get("name"), base.get("shortName"),
        no.get("displayName"), no.get("fullName"), no.get("name"), no.get("shortName"),
    ]
    nome = next((str(c).strip() for c in candidatos if c and len(str(c).strip()) > 1), "")
    if not nome:
        return None
    aid = str(base.get("id") or base.get("athleteId") or no.get("id") or no.get("athleteId") or "").strip()
    foto = ""
    headshot = base.get("headshot") or no.get("headshot")
    if isinstance(headshot, dict):
        foto = str(headshot.get("href") or headshot.get("url") or "").strip()
    elif isinstance(headshot, str):
        foto = headshot.strip()
    if not foto and aid.isdigit():
        foto = f"https://a.espncdn.com/i/headshots/soccer/players/full/{aid}.png"
    return {"nome": nome, "athlete_id": aid, "foto": foto}


def nome_atleta(no: Any) -> str | None:
    info = atleta_info(no)
    return info.get("nome") if info else None


def mapa_times_summary(data: dict[str, Any]) -> dict[str, str]:
    """Mapeia id/sigla/nomes ESPN -> nome canônico a partir do próprio summary."""
    mapa: dict[str, str] = {}

    def registrar(team: Any) -> None:
        if not isinstance(team, dict):
            return
        canonico = para_canonico(
            team.get("displayName"), team.get("shortDisplayName"), team.get("name"),
            team.get("location"), team.get("abbreviation"), team.get("slug"), team.get("id"),
        )
        if not canonico:
            return
        for k in ("id", "uid", "guid", "abbreviation", "displayName", "shortDisplayName", "name", "location", "slug"):
            v = str(team.get(k) or "").strip()
            if v:
                mapa[normalizar(v)] = canonico
                mapa[v] = canonico

    def andar(no: Any) -> None:
        if isinstance(no, dict):
            if isinstance(no.get("team"), dict):
                registrar(no["team"])
            # Alguns nós são o próprio time.
            if any(k in no for k in ("displayName", "abbreviation", "location")) and any(k in no for k in ("id", "uid", "slug", "name")):
                registrar(no)
            for v in no.values():
                andar(v)
        elif isinstance(no, list):
            for v in no:
                andar(v)

    andar(data.get("header") or {})
    andar(data.get("boxscore") or {})
    return mapa


def time_de_no(no: dict[str, Any], mapa_times: dict[str, str] | None = None) -> str | None:
    candidatos: list[Any] = []
    mapa_times = mapa_times or {}
    for chave in ("team", "club", "competitor"):
        obj = no.get(chave)
        if isinstance(obj, dict):
            candidatos.extend([
                obj.get("displayName"), obj.get("shortDisplayName"), obj.get("name"),
                obj.get("abbreviation"), obj.get("slug"), obj.get("location"), obj.get("id"), obj.get("uid"),
            ])
        elif obj:
            candidatos.append(obj)
    candidatos.extend([no.get("teamName"), no.get("teamAbbreviation"), no.get("teamId"), no.get("teamID")])
    for c in candidatos:
        if c is None or c == "":
            continue
        chave = str(c).strip()
        if chave in mapa_times:
            return mapa_times[chave]
        n = normalizar(chave)
        if n in mapa_times:
            return mapa_times[n]
    return para_canonico(*candidatos)


def procurar_listas_eventos(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Coleta apenas listas que costumam conter eventos, sem varrer estatísticas soltas."""
    chaves_evento = {
        "scoringplays", "scoringPlays", "commentary", "plays", "details",
        "incidents", "events", "matchEvents", "keyEvents", "allPlays",
    }
    saida: list[dict[str, Any]] = []
    vistos: set[int] = set()

    def andar(no: Any, chave_pai: str = "") -> None:
        if isinstance(no, dict):
            for k, v in no.items():
                if isinstance(v, list) and (k in chaves_evento or normalizar(k) in {normalizar(x) for x in chaves_evento}):
                    for item in v:
                        if isinstance(item, dict) and id(item) not in vistos:
                            vistos.add(id(item))
                            saida.append(item)
                # Só desce em áreas de jogo/evento; evita pegar tabelas de standings/estatísticas.
                if k in ("header", "competitions", "competition", "gamepackageJSON", "gameInfo") or k in chaves_evento:
                    andar(v, k)
        elif isinstance(no, list):
            for v in no:
                andar(v, chave_pai)

    andar(data)
    return saida


def texto_tipo_evento(no: dict[str, Any]) -> str:
    partes: list[str] = []
    tipo = no.get("type")
    if isinstance(tipo, dict):
        for k in ("text", "name", "displayName", "shortDisplayName", "description", "abbreviation", "id"):
            partes.append(str(tipo.get(k) or ""))
    elif tipo:
        partes.append(str(tipo))
    for k in ("playType", "scoringType", "eventType", "typeText", "headline"):
        partes.append(str(no.get(k) or ""))
    return " ".join(partes)


def texto_evento(no: dict[str, Any]) -> str:
    return " ".join(str(no.get(k) or "") for k in ("text", "description", "displayValue", "shortText", "note"))


def eh_evento_gol(no: dict[str, Any]) -> bool:
    tipo = normalizar(texto_tipo_evento(no))
    texto = normalizar(texto_evento(no))
    combinado = f"{tipo} {texto}".strip()
    if not combinado:
        return False
    rejeitar = [
        "goal difference", "goal differential", "goals for", "goals against", "expected goals",
        "shot on goal", "shots on goal", "yellow card", "red card", "substitution",
        "corner", "offside", "foul", "save", "attempt", "possession", "summary", "statistic",
    ]
    if any(x in combinado for x in rejeitar):
        return False
    tipo_tem_gol = bool(re.search(r"\b(goal|gol|own goal|penalty goal|gol contra)\b", tipo))
    texto_tem_gol = bool(re.search(r"\b(goal!|gol!|goal\s*-|gol\s*-|own goal|gol contra)\b", texto))
    # scoringPlays às vezes não traz texto rico, mas traz scoreValue/period/clock.
    score_value = no.get("scoreValue") or no.get("score_value") or no.get("scoringValue")
    return tipo_tem_gol or texto_tem_gol or (score_value not in (None, "") and "goal" in tipo)


def minuto_evento(no: dict[str, Any]) -> str:
    candidatos: list[Any] = [no.get("clock"), no.get("time"), no.get("displayClock"), no.get("timeDisplayValue"), no.get("minute")]
    for c in candidatos:
        if isinstance(c, dict):
            for k in ("displayValue", "displayClock", "value", "text"):
                if c.get(k) not in (None, ""):
                    return str(c.get(k))
        elif c not in (None, ""):
            return str(c)
    return ""


def atletas_do_evento(no: dict[str, Any]) -> list[dict[str, str]]:
    atletas: list[dict[str, str]] = []
    for chave in ("athletes", "athletesInvolved", "participants", "players"):
        if isinstance(no.get(chave), list):
            for a in no[chave]:
                info = atleta_info(a)
                if info:
                    info["papel"] = normalizar((a or {}).get("type") or (a or {}).get("role") or (a or {}).get("position") or "") if isinstance(a, dict) else ""
                    atletas.append(info)
    for chave in ("athlete", "player", "scorer"):
        if isinstance(no.get(chave), dict):
            info = atleta_info(no[chave])
            if info:
                info["papel"] = "scorer"
                atletas.append(info)
    # Dedup preservando ordem.
    dedup: list[dict[str, str]] = []
    vistos: set[str] = set()
    for a in atletas:
        chave = normalizar(a.get("nome")) + "|" + str(a.get("athlete_id") or "")
        if chave not in vistos:
            vistos.add(chave)
            dedup.append(a)
    return dedup


def parse_textual_scorer_assist(texto_original: str) -> tuple[str | None, list[str]]:
    texto = str(texto_original or "").strip()
    scorer: str | None = None
    assists: list[str] = []
    # Inglês ESPN: "Goal! Team 1, Team 0. Player (Team) right footed shot... Assisted by X."
    m = re.search(r"(?:Goal!|GOAL!|Gol!|GOL!)\s*.*?\.\s*([^.(,;]+?)(?:\s*\(|\s+(?:right|left|header|converte|marca|finaliza)|,|\.|$)", texto)
    if m:
        cand = m.group(1).strip()
        if 1 <= len(cand.split()) <= 5 and not re.search(r"\d", cand):
            scorer = cand
    # Formatos curtos: "Player - Goal".
    if not scorer:
        m = re.match(r"\s*([^,()\-–—]+?)\s*(?:\(|,|\-|–|—|$)", texto)
        if m:
            cand = m.group(1).strip()
            if 1 <= len(cand.split()) <= 5 and not re.search(r"\b(goal|gol|team|time)\b", normalizar(cand)):
                scorer = cand
    for padrao in (
        r"Assisted by\s+([^.,;()]+)",
        r"assist(?:ed|ência|encia)?\s+(?:by|de|por)\s+([^.,;()]+)",
        r"com assistência de\s+([^.,;()]+)",
    ):
        for m in re.finditer(padrao, texto, flags=re.I):
            nome = m.group(1).strip()
            if nome and 1 <= len(nome.split()) <= 5:
                assists.append(nome)
    return scorer, assists


def extrair_gols_summary(data: dict[str, Any], event_id: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Extrai gols/assistências do summary ESPN sem confundir estatística de tabela com gol."""
    mapa_times = mapa_times_summary(data)
    plays = [p for p in procurar_listas_eventos(data) if eh_evento_gol(p)]

    gols: list[dict[str, Any]] = []
    assistencias: list[dict[str, Any]] = []
    vistos: set[str] = set()

    for p in plays:
        texto = str(p.get("text") or p.get("description") or p.get("displayValue") or p.get("shortText") or "")
        minuto = minuto_evento(p)
        equipe = time_de_no(p, mapa_times)
        atletas = atletas_do_evento(p)

        scorer_info: dict[str, str] | None = None
        assist_infos: list[dict[str, str]] = []
        for a in atletas:
            papel = normalizar(a.get("papel") or "")
            if any(tok in papel for tok in ("assist", "assistance")):
                assist_infos.append(a)
            elif scorer_info is None:
                scorer_info = a

        for chave in ("assistAthletes", "assists", "assistants"):
            if isinstance(p.get(chave), list):
                for a in p[chave]:
                    info = atleta_info(a)
                    if info:
                        assist_infos.append(info)

        scorer_txt, assists_txt = parse_textual_scorer_assist(texto)
        if not scorer_info and scorer_txt:
            scorer_info = {"nome": scorer_txt, "athlete_id": "", "foto": ""}
        for nome in assists_txt:
            assist_infos.append({"nome": nome, "athlete_id": "", "foto": ""})

        if not scorer_info or not scorer_info.get("nome"):
            continue

        scorer = scorer_info["nome"].strip()
        chave_visto = f"{event_id}|{normalizar(scorer)}|{normalizar(str(minuto))}|{normalizar(texto)}"
        if chave_visto in vistos:
            continue
        vistos.add(chave_visto)

        gol_obj = {
            "event_id": event_id,
            "nome": scorer,
            "athlete_id": scorer_info.get("athlete_id", ""),
            "foto": scorer_info.get("foto", ""),
            "time": equipe or "",
            "escudo": escudo_time(equipe or "") if equipe else "",
            "minuto": str(minuto or ""),
            "descricao": texto,
        }
        gols.append(gol_obj)

        assist_dedup: dict[str, dict[str, str]] = {}
        for a in assist_infos:
            nome = str(a.get("nome") or "").strip()
            if nome and normalizar(nome) != normalizar(scorer):
                assist_dedup[normalizar(nome)] = a
        for a in assist_dedup.values():
            assistencias.append({
                "event_id": event_id,
                "nome": a.get("nome", ""),
                "athlete_id": a.get("athlete_id", ""),
                "foto": a.get("foto", ""),
                "time": equipe or "",
                "escudo": escudo_time(equipe or "") if equipe else "",
                "minuto": str(minuto or ""),
                "descricao": texto,
            })

    return gols, assistencias



def agregar_jogadores(eventos: list[dict[str, Any]], campo: str) -> list[dict[str, Any]]:
    cont: Counter[tuple[str, str]] = Counter()
    dados: dict[tuple[str, str], dict[str, str]] = {}
    eventos_por: dict[tuple[str, str], set[str]] = defaultdict(set)
    for e in eventos:
        nome = str(e.get("nome") or "").strip()
        time_nome = para_canonico(e.get("time")) or str(e.get("time") or "")
        if not nome:
            continue
        chave = (normalizar(nome), normalizar(time_nome))
        cont[chave] += 1
        if chave not in dados:
            dados[chave] = {
                "nome": nome,
                "time": time_nome,
                "athlete_id": str(e.get("athlete_id") or ""),
                "foto": str(e.get("foto") or ""),
            }
        elif not dados[chave].get("foto") and e.get("foto"):
            dados[chave]["foto"] = str(e.get("foto"))
        eventos_por[chave].add(str(e.get("event_id") or ""))

    saida: list[dict[str, Any]] = []
    for chave, qtd in cont.most_common():
        info = dados.get(chave, {})
        time_nome = info.get("time", "")
        foto = info.get("foto", "")
        aid = info.get("athlete_id", "")
        if not foto and aid.isdigit():
            foto = f"https://a.espncdn.com/i/headshots/soccer/players/full/{aid}.png"
        saida.append({
            "nome": info.get("nome") or chave[0].title(),
            "time": time_nome,
            "escudo": escudo_time(time_nome),
            "athlete_id": aid,
            "foto": foto,
            campo: qtd,
            "eventos": len(eventos_por[chave]),
        })
    saida.sort(key=lambda x: (-int(x.get(campo, 0)), normalizar(x.get("time")), normalizar(x.get("nome"))))
    return saida


def combinar_participacoes(artilharia: list[dict[str, Any]], garcons: list[dict[str, Any]]) -> list[dict[str, Any]]:
    mapa: dict[tuple[str, str], dict[str, Any]] = {}
    for lista, campo in ((artilharia, "gols"), (garcons, "assistencias")):
        for p in lista:
            chave = (normalizar(p.get("nome")), normalizar(p.get("time")))
            item = mapa.setdefault(chave, {
                "nome": p.get("nome", ""),
                "time": p.get("time", ""),
                "escudo": p.get("escudo", ""),
                "athlete_id": p.get("athlete_id", ""),
                "foto": p.get("foto", ""),
                "gols": 0,
                "assistencias": 0,
            })
            item[campo] = int(p.get(campo) or 0)
            if not item.get("foto") and p.get("foto"):
                item["foto"] = p.get("foto")
            if not item.get("athlete_id") and p.get("athlete_id"):
                item["athlete_id"] = p.get("athlete_id")
    saida = []
    for item in mapa.values():
        item["participacoes"] = int(item.get("gols") or 0) + int(item.get("assistencias") or 0)
        saida.append(item)
    saida.sort(key=lambda x: (-int(x.get("participacoes") or 0), -int(x.get("gols") or 0), normalizar(x.get("time")), normalizar(x.get("nome"))))
    return saida




def cache_jogadores_anterior() -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    antigo = ler_json("dados-br/jogadores.json", {})
    if not isinstance(antigo, dict):
        return {}, [], []
    processados = {}
    for p in antigo.get("summaries_processados") or []:
        eid = str((p or {}).get("event_id") or "").strip()
        if eid:
            processados[eid] = dict(p)
    gols = [dict(x) for x in antigo.get("eventos_gols") or [] if isinstance(x, dict)]
    assists = [dict(x) for x in antigo.get("eventos_assistencias") or [] if isinstance(x, dict)]
    return processados, gols, assists


def dedup_eventos_jogador(eventos: list[dict[str, Any]]) -> list[dict[str, Any]]:
    saida: list[dict[str, Any]] = []
    vistos: set[str] = set()
    for e in eventos:
        chave = "|".join([
            str(e.get("event_id") or ""),
            normalizar(e.get("nome")),
            normalizar(e.get("time")),
            normalizar(e.get("minuto")),
            normalizar(e.get("descricao")),
        ])
        if chave in vistos:
            continue
        vistos.add(chave)
        saida.append(e)
    return saida


def coletar_artilharia_assistencias(
    resultados: list[dict[str, Any]],
    avisos: list[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    ids = event_ids_resultados(resultados)
    if not ids:
        avisos.append("Nenhum event_id ESPN encontrado ainda em resultados.json/espn_eventos.json; artilharia e assistências ficam em espera até o próximo snapshot ESPN completo.")
        return [], [], [], [], []

    cache_proc, cache_gols, cache_assists = cache_jogadores_anterior()
    eventos_gols: list[dict[str, Any]] = [e for e in cache_gols if str(e.get("event_id") or "") in set(ids)]
    eventos_assist: list[dict[str, Any]] = [e for e in cache_assists if str(e.get("event_id") or "") in set(ids)]
    processados_mapa: dict[str, dict[str, Any]] = {eid: p for eid, p in cache_proc.items() if eid in set(ids)}

    faltantes = [eid for eid in ids if eid not in processados_mapa]
    limite = int(os.environ.get("BR_STATS_MAX_SUMMARIES", "90"))
    if len(faltantes) > limite:
        avisos.append(f"Coleta incremental: {len(faltantes)} summaries pendentes; esta execução buscará {limite}. O restante entra nos próximos workflows.")
        faltantes = faltantes[:limite]

    falhas = 0
    for i, eid in enumerate(faltantes, 1):
        url = URL_SUMMARY.format(event_id=urllib.parse.quote(eid))
        data = fetch_json(url, timeout=12, tentativas=1)
        if not data:
            falhas += 1
            continue
        gols, assists = extrair_gols_summary(data, eid)
        eventos_gols.extend(gols)
        eventos_assist.extend(assists)
        processados_mapa[eid] = {"event_id": eid, "gols": len(gols), "assistencias": len(assists)}
        if i % 10 == 0:
            print(f"  summaries novos processados: {i}/{len(faltantes)}")
        time.sleep(0.14)

    eventos_gols = dedup_eventos_jogador(eventos_gols)
    eventos_assist = dedup_eventos_jogador(eventos_assist)
    processados = [processados_mapa[eid] for eid in ids if eid in processados_mapa]

    if falhas:
        avisos.append(f"{falhas} summary/s da ESPN não responderam nesta execução; o robô manteve o cache anterior e tentará novamente no próximo workflow.")
    if processados and not eventos_gols:
        avisos.append("Summaries processados, mas nenhum evento de gol foi reconhecido com segurança. O robô evita inferências arriscadas e não confunde Goal Difference/Gols Pró com gols de jogador.")
    if processados and eventos_gols and not eventos_assist:
        avisos.append("Gols foram coletados, mas as assistências podem não estar disponíveis nos summaries da ESPN para todos os jogos.")
    if not processados:
        avisos.append("Nenhum summary foi processado nesta execução. Rode novamente o workflow quando a ESPN estiver respondendo.")
    if cache_proc:
        avisos.append(f"Cache preservado: {len(processados)} summaries já consolidados em dados-br/jogadores.json.")

    return (
        agregar_jogadores(eventos_gols, "gols"),
        agregar_jogadores(eventos_assist, "assistencias"),
        processados,
        eventos_gols,
        eventos_assist,
    )


def main() -> None:
    tabela = carregar_tabela()
    resultados = carregar_resultados()
    avisos: list[str] = []

    if not tabela:
        raise RuntimeError("tabela.json sem dados; rode atualizar_espn.py antes das estatísticas.")

    clubes = montar_clubes(tabela, resultados)
    ranking = gerar_ranking_desempenho(clubes)
    artilharia, garcons, eventos_processados, eventos_gols, eventos_assistencias = coletar_artilharia_assistencias(resultados, avisos)
    participacoes = combinar_participacoes(artilharia, garcons)

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
        "eventos_gols": eventos_gols[-200:],
        "eventos_assistencias": eventos_assistencias[-200:],
        "jogadores_arquivo": "dados-br/jogadores.json",
        "avisos": avisos,
    }

    payload_ranking = {
        "atualizado_em": payload_stats["atualizado_em"],
        "temporada": TEMPORADA,
        "fonte": "ESPN + tabela/resultados locais",
        "metodologia": "Índice de 0 a 100 ponderando aproveitamento geral, forma recente, saldo de gols, ataque, defesa e posição na tabela.",
        "ranking": ranking,
    }

    payload_jogadores = {
        "atualizado_em": payload_stats["atualizado_em"],
        "temporada": TEMPORADA,
        "fonte": "ESPN summary/event detail + snapshots locais",
        "metodologia": "Coleta evento a evento por summary ESPN; evita inferir artilharia a partir de estatísticas agregadas para não confundir Goal Difference/Gols Pró com gols de jogador.",
        "total_summaries_processados": len(eventos_processados),
        "artilharia": artilharia,
        "assistencias": garcons,
        "participacoes_gol": participacoes,
        "eventos_gols": eventos_gols[-300:],
        "eventos_assistencias": eventos_assistencias[-300:],
        "summaries_processados": eventos_processados,
        "avisos": avisos,
    }

    gravar_json_atomico("dados-br/estatisticas.json", payload_stats)
    gravar_json_atomico("dados-br/ranking-desempenho.json", payload_ranking)
    gravar_json_atomico("dados-br/jogadores.json", payload_jogadores)

    print("== ESTATÍSTICAS GERADAS ==")
    print(f"  clubes: {len(clubes)}")
    print(f"  resultados lidos: {len(resultados)}")
    print(f"  artilharia: {len(artilharia)} jogadores")
    print(f"  garçons: {len(garcons)} jogadores")
    print(f"  summaries processados: {len(eventos_processados)}")
    print(f"  participações em gols: {len(participacoes)} jogadores")
    print("  arquivo: dados-br/jogadores.json")
    if avisos:
        print("Avisos:")
        for a in avisos:
            print(f"  - {a}")


if __name__ == "__main__":
    main()
