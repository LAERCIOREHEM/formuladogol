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



def carregar_jogos_detalhes() -> dict[str, Any]:
    payload = ler_json("dados-br/jogos-detalhes.json", {"jogos": {}})
    return payload if isinstance(payload, dict) else {"jogos": {}}


def numero_estatistica(valor: Any) -> float | None:
    if valor is None or valor == "":
        return None
    s = str(valor).strip().replace("%", "").replace(",", ".")
    s = re.sub(r"[^0-9.\-]", "", s)
    if not s or s in {".", "-", "-."}:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


def normalizar_faixa(valor: float | None, minimo: float, maximo: float, inverter: bool = False) -> float:
    if valor is None or not math.isfinite(float(valor)) or maximo == minimo:
        base = 0.50
    else:
        base = clamp01((float(valor) - minimo) / (maximo - minimo))
    if inverter:
        base = 1.0 - base
    return base * 100.0


def stat_por_nome(stats: list[dict[str, Any]], nome: str, lado: str) -> float | None:
    alvo = normalizar(nome)
    for st in stats or []:
        if normalizar(st.get("nome")) == alvo:
            return numero_estatistica(st.get(lado))
    return None


def soma_segura(valores: list[float | None]) -> float:
    return sum(float(v) for v in valores if v is not None and math.isfinite(float(v)))


def media_segura(total: float, jogos: int) -> float:
    return round(total / jogos, 3) if jogos else 0.0


def agregar_metricas_avancadas(clubes: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    """Agrega boxscore ESPN por clube para o Ranking Vivo.

    Usa dados-br/jogos-detalhes.json quando disponível. Se ainda não houver o
    arquivo, o ranking continua funcionando com os dados de tabela/resultados.
    """
    detalhes = carregar_jogos_detalhes()
    jogos = detalhes.get("jogos") if isinstance(detalhes.get("jogos"), dict) else {}

    base: dict[str, dict[str, Any]] = {}
    for c in clubes:
        nome = c["time"]
        base[nome] = {
            "time": nome,
            "jogos_com_boxscore": 0,
            "posse_total": 0.0,
            "finalizacoes": 0.0,
            "finalizacoes_contra": 0.0,
            "chutes_gol": 0.0,
            "chutes_gol_contra": 0.0,
            "bloqueados": 0.0,
            "escanteios": 0.0,
            "escanteios_contra": 0.0,
            "faltas": 0.0,
            "amarelos": 0.0,
            "vermelhos": 0.0,
            "impedimentos": 0.0,
            "defesas": 0.0,
            "passes_certos": 0.0,
            "precisao_passe_total": 0.0,
            "aproveitamento_chutes_total": 0.0,
        }

    for det in (jogos or {}).values():
        if not isinstance(det, dict):
            continue
        mand = para_canonico(det.get("mandante")) or str(det.get("mandante") or "")
        vist = para_canonico(det.get("visitante")) or str(det.get("visitante") or "")
        stats = det.get("stats") or det.get("estatisticas") or []
        if not mand or not vist or not isinstance(stats, list):
            continue
        for time_nome, lado, lado_adv in ((mand, "home", "away"), (vist, "away", "home")):
            if time_nome not in base:
                continue
            b = base[time_nome]
            b["jogos_com_boxscore"] += 1
            b["posse_total"] += stat_por_nome(stats, "Posse", lado) or 0
            b["finalizacoes"] += stat_por_nome(stats, "Finalizações", lado) or 0
            b["finalizacoes_contra"] += stat_por_nome(stats, "Finalizações", lado_adv) or 0
            b["chutes_gol"] += stat_por_nome(stats, "Chutes no gol", lado) or 0
            b["chutes_gol_contra"] += stat_por_nome(stats, "Chutes no gol", lado_adv) or 0
            b["bloqueados"] += stat_por_nome(stats, "Chutes bloqueados", lado) or 0
            b["escanteios"] += stat_por_nome(stats, "Escanteios", lado) or 0
            b["escanteios_contra"] += stat_por_nome(stats, "Escanteios", lado_adv) or 0
            b["faltas"] += stat_por_nome(stats, "Faltas", lado) or 0
            b["amarelos"] += stat_por_nome(stats, "Amarelos", lado) or 0
            b["vermelhos"] += stat_por_nome(stats, "Vermelhos", lado) or 0
            b["impedimentos"] += stat_por_nome(stats, "Impedimentos", lado) or 0
            b["defesas"] += stat_por_nome(stats, "Defesas", lado) or 0
            b["passes_certos"] += stat_por_nome(stats, "Passes certos", lado) or 0
            b["precisao_passe_total"] += stat_por_nome(stats, "Precisão de passe", lado) or 0
            b["aproveitamento_chutes_total"] += stat_por_nome(stats, "Aproveitamento dos chutes", lado) or 0

    for nome, b in base.items():
        j = int(b.get("jogos_com_boxscore") or 0)
        b["posse_media"] = media_segura(b["posse_total"], j)
        b["finalizacoes_media"] = media_segura(b["finalizacoes"], j)
        b["finalizacoes_contra_media"] = media_segura(b["finalizacoes_contra"], j)
        b["chutes_gol_media"] = media_segura(b["chutes_gol"], j)
        b["chutes_gol_contra_media"] = media_segura(b["chutes_gol_contra"], j)
        b["escanteios_media"] = media_segura(b["escanteios"], j)
        b["escanteios_saldo_media"] = media_segura(b["escanteios"] - b["escanteios_contra"], j)
        b["faltas_media"] = media_segura(b["faltas"], j)
        b["amarelos_media"] = media_segura(b["amarelos"], j)
        b["vermelhos_media"] = media_segura(b["vermelhos"], j)
        b["cartoes_media"] = media_segura(b["amarelos"] + 3 * b["vermelhos"], j)
        b["passes_certos_media"] = media_segura(b["passes_certos"], j)
        b["precisao_passe_media"] = media_segura(b["precisao_passe_total"], j)
        b["aproveitamento_chutes_media"] = media_segura(b["aproveitamento_chutes_total"], j)

    auditoria = {
        "fonte_boxscore": detalhes.get("fonte") or "dados-br/jogos-detalhes.json",
        "total_jogos_detalhados": len(jogos or {}),
        "total_com_estatisticas": detalhes.get("total_com_estatisticas") or len(jogos or {}),
        "clubes_com_boxscore": sum(1 for b in base.values() if int(b.get("jogos_com_boxscore") or 0) > 0),
    }
    return base, auditoria


def componentes_desempenho(c: dict[str, Any], avancadas: dict[str, Any]) -> dict[str, Any]:
    jogos = max(1, int(c.get("jogos") or avancadas.get("jogos_com_boxscore") or 1))
    gp = float(c.get("gp") or 0)
    gc = float(c.get("gc") or 0)
    sg = float(c.get("sg") or 0)
    aproveitamento = float(c.get("aproveitamento") or 0)
    aproveitamento_ult5 = float(c.get("aproveitamento_ultimos5") or 0)
    jogos_sem_sofrer = 0

    # A contagem de jogos sem sofrer gol vem da tabela agregada quando possível:
    # usa GC/J apenas como proxy defensivo se o detalhe do jogo ainda não estiver completo.
    gols_pro_pj = gp / jogos
    gols_contra_pj = gc / jogos
    saldo_pj = sg / jogos
    finalizacoes = float(avancadas.get("finalizacoes_media") or 0)
    finalizacoes_contra = float(avancadas.get("finalizacoes_contra_media") or 0)
    chutes_gol = float(avancadas.get("chutes_gol_media") or 0)
    chutes_gol_contra = float(avancadas.get("chutes_gol_contra_media") or 0)
    posse = float(avancadas.get("posse_media") or 50)
    passes = float(avancadas.get("passes_certos_media") or 0)
    precisao_passe = float(avancadas.get("precisao_passe_media") or 80)
    escanteios_saldo = float(avancadas.get("escanteios_saldo_media") or 0)
    aproveitamento_chutes = float(avancadas.get("aproveitamento_chutes_media") or 0)
    faltas = float(avancadas.get("faltas_media") or 0)
    cartoes = float(avancadas.get("cartoes_media") or 0)
    vermelhos = float(avancadas.get("vermelhos_media") or 0)

    # Se a ESPN ainda não tiver boxscore, usa proxies para não deixar o índice vazio.
    if not int(avancadas.get("jogos_com_boxscore") or 0):
        finalizacoes = 9 + gols_pro_pj * 4
        finalizacoes_contra = 9 + gols_contra_pj * 4
        chutes_gol = 2 + gols_pro_pj * 1.7
        chutes_gol_contra = 2 + gols_contra_pj * 1.7
        aproveitamento_chutes = max(8, min(35, gols_pro_pj * 12))
        passes = 360
        precisao_passe = 80
        faltas = 12
        cartoes = 2.0

    ataque = round(
        normalizar_faixa(gols_pro_pj, 0.60, 2.20) * 0.40
        + normalizar_faixa(chutes_gol, 2.0, 6.2) * 0.25
        + normalizar_faixa(finalizacoes, 8.0, 18.0) * 0.20
        + normalizar_faixa(aproveitamento_chutes, 22.0, 46.0) * 0.15
    )
    defesa = round(
        normalizar_faixa(gols_contra_pj, 0.55, 2.15, inverter=True) * 0.45
        + normalizar_faixa(chutes_gol_contra, 2.0, 6.2, inverter=True) * 0.25
        + normalizar_faixa(finalizacoes_contra, 8.0, 18.0, inverter=True) * 0.20
        + normalizar_faixa(saldo_pj, -1.10, 1.30) * 0.10
    )
    dominio = round(
        normalizar_faixa(posse, 42.0, 60.0) * 0.35
        + normalizar_faixa(precisao_passe, 74.0, 90.0) * 0.25
        + normalizar_faixa(passes, 280.0, 570.0) * 0.20
        + normalizar_faixa(escanteios_saldo, -2.2, 3.2) * 0.20
    )
    eficiencia = round(
        aproveitamento * 0.44
        + normalizar_faixa(aproveitamento_ult5, 20.0, 85.0) * 0.22
        + normalizar_faixa(aproveitamento_chutes, 22.0, 46.0) * 0.20
        + normalizar_faixa(saldo_pj, -1.10, 1.30) * 0.14
    )
    disciplina = round(
        normalizar_faixa(cartoes, 1.0, 4.1, inverter=True) * 0.46
        + normalizar_faixa(faltas, 8.0, 18.5, inverter=True) * 0.34
        + normalizar_faixa(vermelhos, 0.0, 0.28, inverter=True) * 0.20
    )
    indice = round(ataque * 0.23 + defesa * 0.23 + dominio * 0.18 + eficiencia * 0.26 + disciplina * 0.10)

    return {
        "ataque": max(0, min(100, ataque)),
        "defesa": max(0, min(100, defesa)),
        "dominio": max(0, min(100, dominio)),
        "eficiencia": max(0, min(100, eficiencia)),
        "disciplina": max(0, min(100, disciplina)),
        "indice_final": max(0, min(100, indice)),
        "metricas": {
            "gols_pro_jogo": round(gols_pro_pj, 2),
            "gols_contra_jogo": round(gols_contra_pj, 2),
            "saldo_por_jogo": round(saldo_pj, 2),
            "posse_media": round(posse, 1),
            "finalizacoes_media": round(finalizacoes, 1),
            "finalizacoes_contra_media": round(finalizacoes_contra, 1),
            "chutes_gol_media": round(chutes_gol, 1),
            "chutes_gol_contra_media": round(chutes_gol_contra, 1),
            "passes_certos_media": round(passes, 1),
            "precisao_passe_media": round(precisao_passe, 1),
            "escanteios_saldo_media": round(escanteios_saldo, 1),
            "aproveitamento_chutes_media": round(aproveitamento_chutes, 1),
            "faltas_media": round(faltas, 1),
            "cartoes_media": round(cartoes, 2),
            "jogos_com_boxscore": int(avancadas.get("jogos_com_boxscore") or 0),
        },
    }


def gerar_ranking_desempenho(clubes: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    avancadas_por_time, auditoria = agregar_metricas_avancadas(clubes)
    ranking = []
    for c in clubes:
        av = avancadas_por_time.get(c["time"], {})
        comp = componentes_desempenho(c, av)
        forma_txt = "".join(c.get("forma_ultimos5") or []) or "sem forma recente"
        metricas = comp.get("metricas") or {}
        justificativa = (
            f"Índice {comp['indice_final']}: ataque {comp['ataque']}, defesa {comp['defesa']}, "
            f"domínio {comp['dominio']}, eficiência {comp['eficiencia']} e disciplina {comp['disciplina']}. "
            f"Tabela: {c.get('aproveitamento', 0)}% de aproveitamento, SG {c.get('sg', 0)} e forma {forma_txt}."
        )
        ranking.append({
            "time": c["time"],
            "escudo": c.get("escudo", ""),
            "sigla": c.get("sigla", ""),
            "score": comp["indice_final"],
            "indice_final": comp["indice_final"],
            "ataque": comp["ataque"],
            "defesa": comp["defesa"],
            "dominio": comp["dominio"],
            "eficiencia": comp["eficiencia"],
            "disciplina": comp["disciplina"],
            "metricas": metricas,
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
    ranking.sort(key=lambda x: (-int(x["indice_final"]), int(x.get("pos_tabela") or 99), normalizar(x["time"])))
    for i, item in enumerate(ranking, 1):
        item["pos"] = i
    auditoria["clubes_no_ranking"] = len(ranking)
    auditoria["metodologia"] = "Ataque 23%, defesa 23%, domínio 18%, eficiência 26% e disciplina 10%. Boxscore ESPN quando disponível; tabela/resultados como fallback."
    return ranking, auditoria

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
    """Retorna nome/id de atleta em formatos variados da ESPN. Fotos foram desativadas no site."""
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
    return {"nome": nome, "athlete_id": aid}


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
            scorer_info = {"nome": scorer_txt, "athlete_id": ""}
        for nome in assists_txt:
            assist_infos.append({"nome": nome, "athlete_id": ""})

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
            }
        eventos_por[chave].add(str(e.get("event_id") or ""))

    saida: list[dict[str, Any]] = []
    for chave, qtd in cont.most_common():
        info = dados.get(chave, {})
        time_nome = info.get("time", "")
        aid = info.get("athlete_id", "")
        saida.append({
            "nome": info.get("nome") or chave[0].title(),
            "time": time_nome,
            "escudo": escudo_time(time_nome),
            "athlete_id": aid,
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
                "gols": 0,
                "assistencias": 0,
            })
            item[campo] = int(p.get(campo) or 0)
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
    ranking, auditoria_ranking = gerar_ranking_desempenho(clubes)
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
        "metodologia": "Índice de 0 a 100 com cinco dimensões: ataque (23%), defesa (23%), domínio (18%), eficiência (26%) e disciplina (10%). Usa boxscore ESPN por jogo quando disponível e tabela/resultados como fallback seguro.",
        "categorias": {"ataque": 23, "defesa": 23, "dominio": 18, "eficiencia": 26, "disciplina": 10},
        "auditoria_arquivo": "dados-br/auditoria-ranking-desempenho.json",
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
    gravar_json_atomico("dados-br/auditoria-ranking-desempenho.json", {"gerado_em": payload_stats["atualizado_em"], **auditoria_ranking})
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
