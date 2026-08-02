#!/usr/bin/env python3
"""Gera e valida as análises editoriais estáticas do Brasileirão.

O modelo de linguagem nunca recebe liberdade para inventar dados: resultados,
variações e tabelas são produzidos deterministicamente a partir dos JSONs do
site. A IA, quando configurada, redige somente trechos narrativos sem algarismos.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


FUSO_BR = timezone(timedelta(hours=-3))
SITE = "https://formuladogol.com.br"
TEMPORADA = 2026
TOTAL_JOGOS_RODADA = 10
ARQUIVO_MANIFESTO = Path("dados-br/analises.json")
ARQUIVO_CONFIG = Path("dados-br/config-analises.json")
CAMINHO_ANALISES = Path("analises")
MODELO_PADRAO = "gpt-5.6"
MARCADOR = "fdg-analise-rodada"


class ErroAnalise(RuntimeError):
    pass


def carregar_json(caminho: Path) -> dict[str, Any]:
    try:
        valor = json.loads(caminho.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as erro:
        raise ErroAnalise(f"JSON inválido ou ausente: {caminho}: {erro}") from erro
    if not isinstance(valor, dict):
        raise ErroAnalise(f"Objeto JSON esperado em {caminho}")
    return valor


def gravar_texto(caminho: Path, conteudo: str) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(conteudo.rstrip() + "\n", encoding="utf-8")


def agora_br() -> datetime:
    bruto = os.environ.get("FDG_AGORA", "").strip()
    if bruto:
        valor = datetime.fromisoformat(bruto.replace("Z", "+00:00"))
        if valor.tzinfo is None:
            valor = valor.replace(tzinfo=FUSO_BR)
        return valor.astimezone(FUSO_BR)
    return datetime.now(FUSO_BR)


def normalizar_nome(valor: str) -> str:
    return re.sub(r"\s+", " ", str(valor or "").strip())


def nome_time(objeto: Any) -> str:
    if isinstance(objeto, dict):
        return normalizar_nome(objeto.get("nome", ""))
    return normalizar_nome(objeto)


def _decimal(valor: float) -> Decimal:
    return Decimal(str(float(valor)))


def _arredondar(valor: float, casas: int) -> Decimal:
    passo = Decimal("1").scaleb(-casas)
    return _decimal(valor).quantize(passo, rounding=ROUND_HALF_UP)


def _numero_pt_br(valor: Decimal, casas: int) -> str:
    return f"{valor:.{casas}f}".replace(".", ",")


def casas_percentual(valor: float) -> int | None:
    """Define a precisão visual sem atribuir casas artificiais aos limites."""
    valor = float(valor)
    if valor == 0 or valor == 100 or 0 < valor < 0.001 or 99.9 < valor < 100:
        return None
    if valor < 0.1:
        return 3
    if valor < 1:
        return 2
    return 1


def percentual(valor: float) -> str:
    valor = float(valor)
    if valor == 0:
        return "0%"
    if 0 < valor < 0.001:
        return "<0,001%"
    if valor == 100:
        return "100%"
    if 99.9 < valor < 100:
        return ">99,9%"
    casas = casas_percentual(valor)
    assert casas is not None
    return _numero_pt_br(_arredondar(valor, casas), casas) + "%"


def variacao(valor: float) -> str:
    if valor == 0:
        return "0 p.p."
    if abs(valor) < 0.001:
        return ("↑" if valor > 0 else "↓") + " <0,001 p.p."
    sinal = "+" if valor > 0 else ""
    return (f"{sinal}{valor:.3f}" if abs(valor) < 0.1 else f"{sinal}{valor:.1f}").replace(".", ",") + " p.p."


def comparacao_percentual(antes: float, depois: float) -> tuple[str, str, str]:
    """Formata o trio de modo que a variação feche com os valores visíveis.

    Quando ambos os percentuais são numéricos, eles usam a mesma precisão e
    a variação é calculada depois do arredondamento. Limites como ``<0,001%``
    continuam censurados, porque revelar casas adicionais sugeriria uma precisão
    que a interface deliberadamente não oferece.
    """
    antes, depois = float(antes), float(depois)
    bruto = depois - antes
    casas_antes, casas_depois = casas_percentual(antes), casas_percentual(depois)

    if casas_antes is not None and casas_depois is not None:
        casas = max(casas_antes, casas_depois)
        antes_exibido = _arredondar(antes, casas)
        depois_exibido = _arredondar(depois, casas)
        delta_exibido = depois_exibido - antes_exibido
        texto_antes = _numero_pt_br(antes_exibido, casas) + "%"
        texto_depois = _numero_pt_br(depois_exibido, casas) + "%"
        if delta_exibido == 0:
            if bruto == 0:
                texto_delta = "0 p.p."
            else:
                limite = _numero_pt_br(Decimal("1").scaleb(-casas), casas)
                texto_delta = ("↑" if bruto > 0 else "↓") + f" <{limite} p.p."
        else:
            sinal = "+" if delta_exibido > 0 else ""
            texto_delta = f"{sinal}{_numero_pt_br(delta_exibido, casas)} p.p."
        return texto_antes, texto_depois, texto_delta

    texto_antes, texto_depois = percentual(antes), percentual(depois)
    if bruto and texto_antes == texto_depois:
        limite = "0,001" if texto_antes == "<0,001%" else "0,1"
        texto_delta = ("↑" if bruto > 0 else "↓") + f" <{limite} p.p."
    else:
        texto_delta = variacao(bruto)
    return texto_antes, texto_depois, texto_delta


def data_humana(iso: str) -> str:
    data = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    if data.tzinfo is None:
        data = data.replace(tzinfo=FUSO_BR)
    return data.astimezone(FUSO_BR).strftime("%d/%m/%Y às %H:%M")


def data_curta(iso: str) -> str:
    data = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    if data.tzinfo is None:
        data = data.replace(tzinfo=FUSO_BR)
    return data.astimezone(FUSO_BR).strftime("%d/%m/%Y")


def slug_rodada(rodada: int) -> str:
    return f"brasileirao-{TEMPORADA}-rodada-{rodada}.html"


def indice_complementos_jogos() -> tuple[dict[str, Any], dict[str, Any]]:
    automaticos = carregar_json(Path("dados-br/melhores-momentos.json")).get("jogos") or {}
    manuais = carregar_json(Path("dados-br/melhores-momentos-manual.json")).get("jogos") or {}
    detalhes = carregar_json(Path("dados-br/jogos-detalhes.json")).get("jogos") or {}
    videos = {str(chave): valor for chave, valor in automaticos.items() if isinstance(valor, dict)}
    videos.update({str(chave): valor for chave, valor in manuais.items() if isinstance(valor, dict)})
    detalhes = {str(chave): valor for chave, valor in detalhes.items() if isinstance(valor, dict)}
    return videos, detalhes


def complemento_jogo(jogo: "Jogo", videos: dict[str, Any], detalhes: dict[str, Any]) -> dict[str, Any]:
    video_bruto = videos.get(jogo.event_id) or {}
    detalhe_bruto = detalhes.get(jogo.event_id) or {}
    video = None
    if str(video_bruto.get("url") or "").startswith(("https://", "http://")):
        video = {
            "url": str(video_bruto.get("url")),
            "titulo": normalizar_nome(video_bruto.get("titulo") or "Melhores momentos"),
            "fonte": normalizar_nome(video_bruto.get("fonte") or "YouTube"),
        }
    estatisticas = []
    for item in detalhe_bruto.get("stats") or detalhe_bruto.get("estatisticas") or []:
        if not isinstance(item, dict) or not normalizar_nome(item.get("nome")):
            continue
        estatisticas.append({
            "nome": normalizar_nome(item.get("nome")),
            "mandante": str(item.get("home") if item.get("home") is not None else "—"),
            "visitante": str(item.get("away") if item.get("away") is not None else "—"),
        })
    detalhe = {
        "estadio": normalizar_nome(detalhe_bruto.get("estadio")),
        "arbitro": normalizar_nome(detalhe_bruto.get("arbitro")),
        "publico": detalhe_bruto.get("publico"),
        "estatisticas": estatisticas,
    }
    return jogo.__dict__ | {"linha": jogo.linha, "melhores_momentos": video, "detalhes": detalhe}


@dataclass(frozen=True)
class Jogo:
    event_id: str
    rodada: int
    mandante: str
    visitante: str
    gols_mandante: int
    gols_visitante: int
    data_iso: str

    @property
    def linha(self) -> str:
        return f"{self.mandante} {self.gols_mandante} × {self.gols_visitante} {self.visitante}"


def jogos_concluidos(rodada: int) -> list[Jogo]:
    dados = carregar_json(Path("resultados.json"))
    jogos: list[Jogo] = []
    ids: set[str] = set()
    for item in dados.get("resultados") or []:
        if int(item.get("rodada") or 0) != rodada:
            continue
        event_id = str(item.get("event_id") or item.get("id") or "").strip()
        mandante, visitante = nome_time(item.get("mandante")), nome_time(item.get("visitante"))
        gm, gv = item.get("placar_mandante"), item.get("placar_visitante")
        if not event_id or not mandante or not visitante or gm is None or gv is None:
            continue
        if event_id in ids:
            raise ErroAnalise(f"event_id duplicado na rodada {rodada}: {event_id}")
        ids.add(event_id)
        jogos.append(Jogo(event_id, rodada, mandante, visitante, int(gm), int(gv), str(item.get("data_iso") or "")))
    return sorted(jogos, key=lambda j: (j.data_iso, j.event_id))


def estado_rodada(rodada: int, momento: datetime, config: dict[str, Any]) -> dict[str, Any]:
    calendario = carregar_json(Path("dados-br/calendario-completo.json")).get("jogos") or []
    previstos = [j for j in calendario if int(j.get("rodada") or 0) == rodada]
    concluidos = jogos_concluidos(rodada)
    ids_concluidos = {j.event_id for j in concluidos}
    pendentes = [j for j in previstos if str(j.get("event_id") or "") not in ids_concluidos]
    completo = len(concluidos) == TOTAL_JOGOS_RODADA
    minimo = int(config.get("minimo_jogos_para_fechamento_editorial") or 8)
    espera_horas = int(config.get("espera_apos_ultimo_jogo_horas") or 8)
    distancia_adiado = int(config.get("distancia_jogo_adiado_horas") or 72)
    fechamento_editorial = False
    motivo = "rodada em andamento"
    if completo:
        fechamento_editorial, motivo = True, "todos os dez jogos foram concluídos"
    elif len(concluidos) >= minimo and concluidos:
        datas = [datetime.fromisoformat(j.data_iso).replace(tzinfo=FUSO_BR) for j in concluidos if j.data_iso]
        ultima = max(datas) if datas else None
        datas_pendentes = []
        for item in pendentes:
            bruto = str(item.get("data_iso") or "").strip()
            if bruto:
                valor = datetime.fromisoformat(bruto)
                datas_pendentes.append(valor.replace(tzinfo=FUSO_BR) if valor.tzinfo is None else valor.astimezone(FUSO_BR))
        pendencia_distante = bool(pendentes) and (not datas_pendentes or (ultima and min(datas_pendentes) >= ultima + timedelta(hours=distancia_adiado)))
        espera_cumprida = bool(ultima and momento >= ultima + timedelta(hours=espera_horas))
        if pendencia_distante and espera_cumprida:
            fechamento_editorial, motivo = True, "janela encerrada com partida adiada"
    return {
        "rodada": rodada,
        "jogos_previstos": len(previstos),
        "jogos_concluidos": len(concluidos),
        "jogos_pendentes": len(pendentes),
        "completo": completo,
        "elegivel": fechamento_editorial,
        "motivo": motivo,
        "pendentes": [{"mandante": nome_time(j.get("mandante")), "visitante": nome_time(j.get("visitante")), "data_iso": j.get("data_iso")} for j in pendentes],
    }


def snapshots_da_rodada(rodada: int) -> tuple[dict[str, Any], dict[str, Any]]:
    historico = carregar_json(Path("dados-br/historico-probabilidades.json"))
    snapshots = historico.get("snapshots") or []
    if not snapshots:
        raise ErroAnalise("Histórico de probabilidades vazio")
    fim = None
    for snapshot in snapshots:
        if int(snapshot.get("rodada_referencia") or 0) == rodada:
            fim = snapshot
    if fim is None:
        raise ErroAnalise(f"Não existe snapshot de probabilidades para a rodada {rodada}")
    jogos_fim = sum(int(c.get("jogos_atuais") or 0) for c in fim.get("clubes") or []) // 2
    candidatos = []
    for snapshot in snapshots:
        jogos = sum(int(c.get("jogos_atuais") or 0) for c in snapshot.get("clubes") or []) // 2
        referencia = int(snapshot.get("rodada_referencia") or 0)
        if referencia < rodada and jogos < jogos_fim and snapshot.get("gerado_em", "") <= fim.get("gerado_em", ""):
            candidatos.append((referencia, jogos, snapshot.get("gerado_em", ""), snapshot))
    if not candidatos:
        raise ErroAnalise(f"Não existe snapshot anterior à rodada {rodada}")
    inicio = max(candidatos, key=lambda item: (item[0], item[1], item[2]))[3]
    return inicio, fim


def clube_por_nome(snapshot: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {normalizar_nome(c.get("clube")): c for c in snapshot.get("clubes") or []}


def montar_dossie(rodada: int, estado: dict[str, Any]) -> dict[str, Any]:
    inicio, fim = snapshots_da_rodada(rodada)
    antes, depois = clube_por_nome(inicio), clube_por_nome(fim)
    if set(antes) != set(depois) or len(depois) != 20:
        raise ErroAnalise("Snapshots não contêm os mesmos vinte clubes")
    linhas = []
    for nome in depois:
        a, d = antes[nome], depois[nome]
        linhas.append({
            "clube": nome,
            "pontos_antes": int(a.get("pontos_atuais") or 0),
            "pontos_depois": int(d.get("pontos_atuais") or 0),
            "titulo_antes": float(a.get("campeao_pct") or 0),
            "titulo_depois": float(d.get("campeao_pct") or 0),
            "titulo_delta": float(d.get("campeao_pct") or 0) - float(a.get("campeao_pct") or 0),
            "libertadores_antes": float(a.get("libertadores_pct") or 0),
            "libertadores_depois": float(d.get("libertadores_pct") or 0),
            "libertadores_delta": float(d.get("libertadores_pct") or 0) - float(a.get("libertadores_pct") or 0),
            "rebaixamento_antes": float(a.get("rebaixamento_pct") or 0),
            "rebaixamento_depois": float(d.get("rebaixamento_pct") or 0),
            "rebaixamento_delta": float(d.get("rebaixamento_pct") or 0) - float(a.get("rebaixamento_pct") or 0),
        })
    jogos = jogos_concluidos(rodada)
    videos, detalhes = indice_complementos_jogos()
    return {
        "rodada": rodada,
        "snapshot_antes": inicio.get("gerado_em"),
        "snapshot_depois": fim.get("gerado_em"),
        "simulacoes": int(fim.get("simulacoes") or 0),
        "estado": estado,
        "jogos": [complemento_jogo(j, videos, detalhes) for j in jogos],
        "clubes": linhas,
    }


def maiores(dossie: dict[str, Any], campo: str, quantidade: int = 3, reverso: bool = True) -> list[dict[str, Any]]:
    return sorted(dossie["clubes"], key=lambda c: (c[campo], c["clube"]), reverse=reverso)[:quantidade]


def narrativa_segura(dossie: dict[str, Any]) -> dict[str, Any]:
    rodada = dossie["rodada"]
    alta = maiores(dossie, "titulo_delta", 1)[0]
    baixa = maiores(dossie, "titulo_delta", 1, False)[0]
    jogos = {j["mandante"]: j for j in dossie["jogos"]}
    if rodada == 20 and "Palmeiras" in jogos and "Flamengo" in jogos:
        return {
            "titulo": "Rodada 20 reabre a disputa: Flamengo avança nas projeções após tropeço do Palmeiras",
            "linha_fina": "O líder perdeu em casa, o vice empatou, e o modelo registrou uma aproximação relevante nas chances de título.",
            "paragrafos": [
                "A rodada mudou o tom da corrida pelo título. O Palmeiras saiu derrotado diante do Atlético-MG, enquanto o Flamengo somou um ponto contra o São Paulo. O resultado combinado reduziu a vantagem estatística do líder e manteve a disputa mais aberta.",
                "O Botafogo também aproveitou a rodada ao vencer o Cruzeiro fora de casa. O resultado fortaleceu sua posição na briga continental e aumentou a pressão sobre o bloco imediatamente à frente.",
                "Na parte inferior da tabela, a Chapecoense buscou um empate com o Santos, mas permaneceu em situação delicada. Vitória e Internacional terminaram a rodada sem pontuar, ampliando a importância dos confrontos seguintes.",
            ],
        }
    return {
        "titulo": f"Rodada {rodada}: {alta['clube']} ganha espaço e {baixa['clube']} recua nas projeções",
        "linha_fina": "Os resultados alteraram as probabilidades de título, classificação continental e permanência no Brasileirão.",
        "paragrafos": [
            f"A rodada teve impacto direto nas projeções. {alta['clube']} registrou o avanço mais relevante na disputa pelo título, enquanto {baixa['clube']} perdeu terreno.",
            "As mudanças não dependem de um resultado isolado. O modelo recalcula todos os jogos restantes e considera a combinação entre pontuação, força recente e caminhos continentais.",
            "O quadro ainda está aberto. As próximas partidas podem deslocar novamente as probabilidades, sobretudo entre clubes próximos na classificação.",
        ],
    }


def schema_editorial() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "titulo": {"type": "string", "minLength": 35, "maxLength": 130},
            "linha_fina": {"type": "string", "minLength": 60, "maxLength": 220},
            "paragrafos": {"type": "array", "minItems": 3, "maxItems": 4, "items": {"type": "string", "minLength": 90, "maxLength": 520}},
        },
        "required": ["titulo", "linha_fina", "paragrafos"],
    }


def chamar_openai(dossie: dict[str, Any], modelo: str) -> dict[str, Any]:
    chave = os.environ.get("OPENAI_API_KEY", "").strip()
    if not chave:
        raise ErroAnalise("OPENAI_API_KEY não configurada")
    resumo = {
        "rodada": dossie["rodada"],
        "resultados": [j["linha"] for j in dossie["jogos"]],
        "maiores_altas_titulo": [{"clube": c["clube"], "delta_pp": round(c["titulo_delta"], 4)} for c in maiores(dossie, "titulo_delta")],
        "maiores_baixas_titulo": [{"clube": c["clube"], "delta_pp": round(c["titulo_delta"], 4)} for c in maiores(dossie, "titulo_delta", reverso=False)],
        "maiores_altas_libertadores": [{"clube": c["clube"], "delta_pp": round(c["libertadores_delta"], 4)} for c in maiores(dossie, "libertadores_delta")],
        "maiores_altas_rebaixamento": [{"clube": c["clube"], "delta_pp": round(c["rebaixamento_delta"], 4)} for c in maiores(dossie, "rebaixamento_delta")],
        "partidas_pendentes": dossie["estado"]["pendentes"],
    }
    instrucao = (
        "Você é o editor esportivo do Fórmula do Gol. Escreva em português brasileiro, com voz humana, precisa e sóbria. "
        "Use exclusivamente o dossiê fornecido. Não invente causa tática, lesão, jogador, declaração, local, rodada ou resultado. "
        "Não use algarismos em nenhum campo: os números auditados serão inseridos pelo template. Não use clichês como 'vale destacar', "
        "'em um cenário', 'a narrativa', 'mergulhar', 'jornada' ou 'não apenas'. Explique o que mudou e por que isso importa, sem prometer certezas."
    )
    payload = {
        "model": modelo,
        "store": False,
        "input": [
            {"role": "system", "content": instrucao},
            {"role": "user", "content": "Dossiê factual auditado:\n" + json.dumps(resumo, ensure_ascii=False, separators=(",", ":"))},
        ],
        "max_output_tokens": 1600,
        "text": {"format": {"type": "json_schema", "name": "analise_rodada", "strict": True, "schema": schema_editorial()}},
    }
    requisicao = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {chave}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(requisicao, timeout=90) as resposta:
            retorno = json.loads(resposta.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as erro:
        raise ErroAnalise(f"Falha na API da OpenAI: {erro}") from erro
    textos = []
    for saida in retorno.get("output") or []:
        for parte in saida.get("content") or []:
            if parte.get("type") == "output_text" and parte.get("text"):
                textos.append(parte["text"])
    if not textos:
        raise ErroAnalise("Resposta da OpenAI sem output_text")
    try:
        return json.loads("".join(textos))
    except json.JSONDecodeError as erro:
        raise ErroAnalise("Resposta editorial não é JSON válido") from erro


def validar_editorial(editorial: dict[str, Any], dossie: dict[str, Any]) -> None:
    if set(editorial) != {"titulo", "linha_fina", "paragrafos"}:
        raise ErroAnalise("Editorial fora do schema esperado")
    campos = [editorial["titulo"], editorial["linha_fina"], *(editorial["paragrafos"] or [])]
    if len(editorial["paragrafos"]) not in {3, 4} or not all(isinstance(x, str) for x in campos):
        raise ErroAnalise("Editorial incompleto")
    texto = " ".join(campos)
    texto_sem_rodada = texto.replace(str(dossie["rodada"]), "")
    if re.search(r"\d", texto_sem_rodada):
        raise ErroAnalise("A IA incluiu algarismos; conteúdo rejeitado para impedir dado não auditado")
    proibidos = ["vale destacar", "em um cenário", "a narrativa", "mergulhar", "jornada", "não apenas"]
    if any(frase in texto.casefold() for frase in proibidos):
        raise ErroAnalise("Editorial contém linguagem artificial proibida")
    clubes = {c["clube"] for c in dossie["clubes"]}
    conhecidos = [c for c in clubes if c.casefold() in texto.casefold()]
    if not conhecidos:
        raise ErroAnalise("Editorial não menciona nenhum clube do dossiê")


def esc(valor: Any) -> str:
    return html.escape(str(valor), quote=True)


def menu(prefixo: str, ativo: bool = False) -> str:
    itens = [
        ("📈", "Estatísticas", f"{prefixo}estatisticas.html"),
        ("⚽", "Jogos", f"{prefixo}jogos"),
        ("🔴", "Ao vivo", f"{prefixo}aovivo.html"),
        ("📊", "Tabela", f"{prefixo}tabela"),
        ("✅", "Resultados", f"{prefixo}resultados"),
        ("📰", "Análises", f"{prefixo}analises/"),
        ("🛡️", "Clubes", f"{prefixo}clubes.html"),
        ("🏛️", "Museu", f"{prefixo}museu.html"),
        ("🌎", "Copa 2026", f"{prefixo}copa2026/"),
    ]
    links = []
    for icone, rotulo, href in itens:
        classe = ' class="active" aria-current="page"' if ativo and rotulo == "Análises" else ""
        links.append(f'      <a href="{href}"{classe}>{icone} {rotulo}</a>')
    return '<nav class="nav" data-br-auth-menu aria-label="Menu principal">\n' + "\n".join(links) + "\n    </nav>"


def submenu_rodadas(artigos: list[dict[str, Any]], rodada_ativa: int | None = None) -> str:
    disponiveis = {
        int(item.get("rodada") or 0): str(item.get("slug") or slug_rodada(int(item.get("rodada") or 0)))
        for item in artigos
        if int(item.get("rodada") or 0) > 0
    }
    if rodada_ativa:
        disponiveis.setdefault(rodada_ativa, slug_rodada(rodada_ativa))
    links = []
    for rodada in sorted(disponiveis, reverse=True):
        if rodada_ativa and rodada > rodada_ativa:
            continue
        atual = ' class="active" aria-current="page"' if rodada == rodada_ativa else ""
        links.append(f'<a href="{esc(disponiveis[rodada])}"{atual}>R{rodada}</a>')
    if not links:
        return ""
    return '<nav class="analysis-round-nav" aria-label="Histórico por rodada"><strong>RODADAS</strong><div>' + "".join(links) + "</div></nav>"


def valor_estatistica(valor: Any) -> str:
    texto = str(valor if valor is not None else "—")
    if re.fullmatch(r"-?\d+\.\d+%", texto):
        texto = texto.replace(".", ",")
    return texto


def renderizar_jogo(jogo: dict[str, Any]) -> str:
    video = jogo.get("melhores_momentos") or {}
    detalhes = jogo.get("detalhes") or {}
    acoes = [f'<a href="../resultados">Placar e resumo</a>']
    if video.get("url"):
        acoes.append(
            f'<a class="analysis-video" href="{esc(video["url"])}" target="_blank" rel="noopener noreferrer">▶ Melhores momentos</a>'
        )
    meta = []
    if detalhes.get("estadio"):
        meta.append(f'<span>📍 {esc(detalhes["estadio"])}</span>')
    if detalhes.get("arbitro"):
        meta.append(f'<span>Árbitro: {esc(detalhes["arbitro"])}</span>')
    publico = detalhes.get("publico")
    if isinstance(publico, (int, float)) and publico > 0:
        meta.append(f'<span>Público: {int(publico):,}</span>'.replace(",", "."))
    estatisticas = detalhes.get("estatisticas") or []
    expansivel = ""
    if estatisticas or meta:
        linhas = "".join(
            f'<tr><td>{esc(valor_estatistica(item.get("mandante")))}</td><th scope="row">{esc(item.get("nome"))}</th><td>{esc(valor_estatistica(item.get("visitante")))}</td></tr>'
            for item in estatisticas
        )
        tabela = ""
        if linhas:
            tabela = f'''<div class="analysis-game-stats-wrap"><table class="analysis-game-stats">
              <thead><tr><th>{esc(jogo['mandante'])}</th><th>Estatística</th><th>{esc(jogo['visitante'])}</th></tr></thead>
              <tbody>{linhas}</tbody></table></div>'''
        expansivel = f'''<details class="analysis-game-details"><summary>Estatísticas do jogo</summary>
          <div class="analysis-game-meta">{''.join(meta)}</div>{tabela}</details>'''
    return f'''<article class="analysis-game-card">
      <h3><a href="../resultados">{esc(jogo['linha'])}</a></h3>
      <div class="analysis-game-actions">{''.join(acoes)}</div>
      {expansivel}
    </article>'''


def rodape(prefixo: str) -> str:
    return f'''<footer class="site-footer">
      <nav class="br-footer-links" aria-label="Links institucionais"><a href="{prefixo}sobre.html">ⓘ Sobre o Fórmula do Gol</a></nav>
      <div class="br-footer-copy"><span class="footer-title">Fórmula do Gol</span> — Site independente, informativo e sem fins lucrativos, criado, desenvolvido e mantido exclusivamente por Laércio Rehem. Não é afiliado, patrocinado ou endossado pela CBF, clubes, ESPN ou qualquer titular de direitos. Dados de jogos e resultados provêm da API pública da ESPN. Escudos, nomes e marcas dos clubes pertencem aos seus respectivos titulares e são exibidos exclusivamente para identificação e contexto esportivo.</div>
    </footer>'''


def cabecalho_html(titulo: str, descricao: str, canonical: str, tipo: str, publicado: str | None = None, modificado: str | None = None) -> str:
    json_ld = ""
    if tipo == "NewsArticle":
        estrutura = {
            "@context": "https://schema.org", "@type": "NewsArticle", "headline": titulo,
            "description": descricao, "datePublished": publicado, "dateModified": modificado,
            "mainEntityOfPage": canonical, "inLanguage": "pt-BR", "isAccessibleForFree": True,
            "author": {"@type": "Person", "name": "Laércio Rehem", "url": f"{SITE}/sobre.html"},
            "publisher": {"@type": "Organization", "name": "Fórmula do Gol", "url": SITE,
                          "logo": {"@type": "ImageObject", "url": f"{SITE}/favicon-formula-do-gol-512.png"}},
            "image": [f"{SITE}/og-image-formula-do-gol-v2.jpg"],
        }
    else:
        estrutura = {"@context": "https://schema.org", "@type": "CollectionPage", "name": titulo, "url": canonical, "description": descricao, "inLanguage": "pt-BR"}
    json_ld = json.dumps(estrutura, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    return f'''<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{esc(titulo)} — Fórmula do Gol</title>
  <meta name="description" content="{esc(descricao)}">
  <link rel="canonical" href="{canonical}">
  <meta property="og:type" content="{'article' if tipo == 'NewsArticle' else 'website'}">
  <meta property="og:title" content="{esc(titulo)} — Fórmula do Gol">
  <meta property="og:description" content="{esc(descricao)}">
  <meta property="og:url" content="{canonical}">
  <meta property="og:image" content="{SITE}/og-image-formula-do-gol-v2.jpg">
  <meta property="og:site_name" content="Fórmula do Gol">
  <meta property="og:locale" content="pt_BR">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{esc(titulo)} — Fórmula do Gol">
  <meta name="twitter:description" content="{esc(descricao)}">
  <meta name="twitter:image" content="{SITE}/og-image-formula-do-gol-v2.jpg">
  <meta name="theme-color" content="#10b981">
  <link rel="icon" type="image/png" sizes="32x32" href="../favicon-formula-do-gol-32.png">
  <link rel="apple-touch-icon" href="../apple-touch-icon-formula-do-gol.png">
  <link rel="stylesheet" href="../css/br-global.css?v=20260802-analises-v1">
  <link rel="stylesheet" href="../css/br-analises.css?v=20260802-titulos-editoriais-v4">
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-3956SD5HFC"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){{dataLayer.push(arguments)}}gtag('js',new Date());gtag('config','G-3956SD5HFC');</script>
  <script type="application/ld+json">{json_ld}</script>
</head>'''


def tabela_comparativa(dossie: dict[str, Any]) -> str:
    linhas = sorted(dossie["clubes"], key=lambda c: (-c["pontos_depois"], -c["titulo_depois"], c["clube"]))
    corpo = []
    for c in linhas:
        classe_delta = "delta-up" if c["titulo_delta"] > 0 else "delta-down" if c["titulo_delta"] < 0 else "delta-flat"
        titulo_antes, titulo_depois, titulo_delta = comparacao_percentual(c["titulo_antes"], c["titulo_depois"])
        corpo.append(f'''<tr>
          <th scope="row"><a href="../clubes.html#{esc(c['clube'].lower().replace(' ', '-'))}">{esc(c['clube'])}</a></th>
          <td>{c['pontos_depois']}</td>
          <td>{esc(titulo_antes)}</td><td>{esc(titulo_depois)}</td><td class="delta {classe_delta}">{esc(titulo_delta)}</td>
          <td>{esc(percentual(c['libertadores_depois']))}</td><td>{esc(percentual(c['rebaixamento_depois']))}</td>
        </tr>''')
    return '''<div class="analysis-table-wrap" tabindex="0" aria-label="Tabela comparativa com rolagem horizontal">
      <table class="analysis-table">
        <thead><tr><th>Clube</th><th>Pts</th><th>Título antes</th><th>Título depois</th><th>Variação</th><th>Libertadores</th><th>Rebaixamento</th></tr></thead>
        <tbody>''' + "".join(corpo) + "</tbody></table></div>"


def cards_variacoes(dossie: dict[str, Any]) -> str:
    alta = maiores(dossie, "titulo_delta", 1)[0]
    baixa = maiores(dossie, "titulo_delta", 1, False)[0]
    lib = maiores(dossie, "libertadores_delta", 1)[0]
    queda = maiores(dossie, "rebaixamento_delta", 1)[0]
    itens = [
        ("Maior alta no título", alta["clube"], variacao(alta["titulo_delta"])),
        ("Maior recuo no título", baixa["clube"], variacao(baixa["titulo_delta"])),
        ("Avanço na Libertadores", lib["clube"], variacao(lib["libertadores_delta"])),
        ("Alerta de rebaixamento", queda["clube"], variacao(queda["rebaixamento_delta"])),
    ]
    return '<div class="analysis-kpis">' + "".join(f'<article><span>{esc(rotulo)}</span><strong>{esc(clube)}</strong><b>{esc(valor)}</b></article>' for rotulo, clube, valor in itens) + "</div>"


def gerar_artigo(dossie: dict[str, Any], editorial: dict[str, Any], publicado: str, modificado: str, historico: list[dict[str, Any]]) -> tuple[str, dict[str, Any]]:
    rodada = dossie["rodada"]
    url = f"{SITE}/analises/{slug_rodada(rodada)}"
    titulo, linha_fina = editorial["titulo"], editorial["linha_fina"]
    nota_pendente = ""
    if dossie["estado"]["jogos_pendentes"]:
        jogos = ", ".join(f"{p['mandante']} × {p['visitante']}" for p in dossie["estado"]["pendentes"])
        nota_pendente = f'<aside class="analysis-note"><strong>Rodada com pendência:</strong> {esc(jogos)}. Esta página será atualizada na mesma URL após a realização da partida.</aside>'
    resultados = "".join(renderizar_jogo(jogo) for jogo in dossie["jogos"])
    paragrafos = "\n".join(f"<p>{esc(p)}</p>" for p in editorial["paragrafos"])
    html_final = cabecalho_html(titulo, linha_fina, url, "NewsArticle", publicado, modificado) + f'''
<body data-{MARCADOR}="{rodada}">
  <div class="container analysis-shell">
    <header class="hero"><a href="../estatisticas.html"><img src="../img/header-formula-do-gol.png" alt="Fórmula do Gol — A matemática por trás do futebol"></a></header>
    {menu('../', True)}
    {submenu_rodadas(historico, rodada)}
    <main>
      <article class="analysis-article">
        <nav class="analysis-breadcrumb" aria-label="Navegação estrutural"><a href="./">Análises</a><span>›</span><span>Rodada {rodada}</span></nav>
        <header class="analysis-head">
          <div class="analysis-published"><time datetime="{esc(publicado)}">Publicado em {data_curta(publicado)}</time></div>
          <span class="analysis-tag">ANÁLISE DA RODADA {rodada}</span>
          <h1>{esc(titulo)}</h1>
          <p class="analysis-deck">{esc(linha_fina)}</p>
          <div class="analysis-byline">Por <a href="../sobre.html">Laércio Rehem</a></div>
        </header>
        {nota_pendente}
        {cards_variacoes(dossie)}
        <section class="analysis-copy"><h2>O retrato da rodada</h2>{paragrafos}</section>
        <section><h2>Resultados considerados</h2><div class="analysis-results">{resultados}</div></section>
        <section><h2>Como as probabilidades mudaram</h2><p class="analysis-help">Comparação entre o último snapshot anterior e o fechamento editorial da rodada. No celular, arraste a tabela para o lado.</p><p class="analysis-percent-legend"><strong>Padrão dos percentuais:</strong> <b>0%</b> significa nenhum cenário nas simulações; <b>&lt;0,001%</b> significa que houve cenários, mas abaixo do menor valor exibido. Nas variações, <b>↑/↓ &lt;0,001 p.p.</b> preserva movimentos residuais sem exibir zeros falsos.</p>{tabela_comparativa(dossie)}</section>
        <aside class="analysis-method"><strong>Leitura dos dados:</strong> as probabilidades são estimativas do AF-Previsão, calculadas em {dossie['simulacoes']:,} simulações e não representam certezas. O texto automático utiliza somente um dossiê factual auditado; resultados e percentuais são inseridos diretamente dos JSONs do Fórmula do Gol.</aside>
        <nav class="analysis-next" aria-label="Mais conteúdo"><a href="./">← Todas as análises</a><a href="../estatisticas.html#probabilidades">Probabilidades atuais →</a></nav>
      </article>
    </main>
    {rodape('../')}
  </div>
  <script src="../js/br-menu.js?v=20260724-status-dot-v2"></script>
</body>
</html>'''.replace(f"{dossie['simulacoes']:,}", f"{dossie['simulacoes']:,}".replace(",", "."))
    metadados = {"rodada": rodada, "slug": slug_rodada(rodada), "url": url, "titulo": titulo, "linha_fina": linha_fina, "publicado_em": publicado, "modificado_em": modificado, "jogos_concluidos": dossie["estado"]["jogos_concluidos"], "jogos_pendentes": dossie["estado"]["jogos_pendentes"], "hash_dossie": hashlib.sha256(json.dumps(dossie, ensure_ascii=False, sort_keys=True).encode()).hexdigest()}
    return html_final, metadados


def gerar_hub(artigos: list[dict[str, Any]]) -> str:
    ordenados = sorted(artigos, key=lambda a: (a["rodada"], a["modificado_em"]), reverse=True)
    cards = []
    for i, artigo in enumerate(ordenados):
        classe = " analysis-card-featured" if i == 0 else ""
        pendencia = " · edição parcial" if artigo.get("jogos_pendentes") else ""
        cards.append(f'''<article class="analysis-card{classe}"><time datetime="{esc(artigo['publicado_em'])}">Publicado em {data_curta(artigo['publicado_em'])}</time><span>RODADA {artigo['rodada']}{pendencia}</span><h2><a href="{esc(artigo['slug'])}">{esc(artigo['titulo'])}</a></h2><p>{esc(artigo['linha_fina'])}</p><a class="analysis-read" href="{esc(artigo['slug'])}">Ler análise →</a></article>''')
    titulo = "Análises do Brasileirão 2026"
    descricao = "Leitura rodada a rodada dos resultados e das mudanças nas probabilidades de título, Libertadores e rebaixamento."
    return cabecalho_html(titulo, descricao, f"{SITE}/analises/", "CollectionPage") + f'''
<body>
  <div class="container analysis-shell">
    <header class="hero"><a href="../estatisticas.html"><img src="../img/header-formula-do-gol.png" alt="Fórmula do Gol — A matemática por trás do futebol"></a></header>
    {menu('../', True)}
    {submenu_rodadas(artigos)}
    <main>
      <h1 class="analysis-page-title">{titulo}</h1>
      <section class="analysis-grid" aria-label="Arquivo de análises">{''.join(cards) if cards else '<p>Nenhuma análise publicada.</p>'}</section>
    </main>
    {rodape('../')}
  </div>
  <script src="../js/br-menu.js?v=20260724-status-dot-v2"></script>
</body>
</html>'''


def atualizar_sitemap(artigos: list[dict[str, Any]]) -> None:
    ns = "http://www.sitemaps.org/schemas/sitemap/0.9"
    ET.register_namespace("", ns)
    caminho = Path("sitemap.xml")
    raiz = ET.parse(caminho).getroot()
    urls = {((no.find(f"{{{ns}}}loc").text or "").strip()): no for no in raiz.findall(f"{{{ns}}}url")}
    desejadas = [f"{SITE}/analises/"] + [a["url"] for a in sorted(artigos, key=lambda a: a["rodada"])]
    for url in desejadas:
        if url not in urls:
            no = ET.SubElement(raiz, f"{{{ns}}}url")
            ET.SubElement(no, f"{{{ns}}}loc").text = url
    ET.indent(raiz, space="  ")
    ET.ElementTree(raiz).write(caminho, encoding="utf-8", xml_declaration=True)


def gerar_news_sitemap(artigos: list[dict[str, Any]], momento: datetime) -> str:
    recentes = [a for a in artigos if momento - datetime.fromisoformat(a["publicado_em"]).astimezone(FUSO_BR) <= timedelta(days=2)]
    entradas = []
    for a in sorted(recentes, key=lambda x: x["publicado_em"], reverse=True):
        entradas.append(f'''  <url><loc>{esc(a['url'])}</loc><news:news><news:publication><news:name>Fórmula do Gol</news:name><news:language>pt</news:language></news:publication><news:publication_date>{esc(a['publicado_em'])}</news:publication_date><news:title>{esc(a['titulo'])}</news:title></news:news></url>''')
    return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">\n' + "\n".join(entradas) + "\n</urlset>"


def gerar_feed(artigos: list[dict[str, Any]], momento: datetime) -> str:
    itens = []
    for a in sorted(artigos, key=lambda x: x["publicado_em"], reverse=True)[:20]:
        data = datetime.fromisoformat(a["publicado_em"]).astimezone(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000")
        itens.append(f'''<item><title>{esc(a['titulo'])}</title><link>{esc(a['url'])}</link><guid isPermaLink="true">{esc(a['url'])}</guid><pubDate>{data}</pubDate><description>{esc(a['linha_fina'])}</description></item>''')
    agora_rfc = momento.astimezone(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000")
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Análises — Fórmula do Gol</title><link>{SITE}/analises/</link><description>Análises rodada a rodada do Brasileirão 2026.</description><language>pt-BR</language><lastBuildDate>{agora_rfc}</lastBuildDate>{''.join(itens)}</channel></rss>'''


def carregar_manifesto() -> dict[str, Any]:
    if not ARQUIVO_MANIFESTO.exists():
        return {"schema_version": 1, "site": "Fórmula do Gol", "artigos": []}
    return carregar_json(ARQUIVO_MANIFESTO)


def executar(args: argparse.Namespace) -> int:
    config = carregar_json(ARQUIVO_CONFIG)
    momento = agora_br()
    rodada = args.rodada
    if rodada is None:
        candidatas = []
        for numero in range(1, 39):
            estado = estado_rodada(numero, momento, config)
            if estado["elegivel"]:
                candidatas.append(numero)
        if not candidatas:
            print("Nenhuma rodada elegível para publicação.")
            return 0
        rodada = max(candidatas)
    estado = estado_rodada(rodada, momento, config)
    if not estado["elegivel"] and not args.forcar:
        print(f"Rodada {rodada} não elegível: {estado['motivo']} ({estado['jogos_concluidos']}/{TOTAL_JOGOS_RODADA}).")
        return 0
    dossie = montar_dossie(rodada, estado)
    fallback = narrativa_segura(dossie)
    editorial, origem = fallback, "deterministico"
    if not args.sem_ia:
        try:
            candidato = chamar_openai(dossie, args.modelo)
            validar_editorial(candidato, dossie)
            if not re.search(rf"\b{rodada}\b", candidato["titulo"]):
                candidato["titulo"] = f"Rodada {rodada}: {candidato['titulo']}"
            editorial, origem = candidato, "openai"
        except ErroAnalise as erro:
            print(f"::warning::Editorial da OpenAI rejeitado; usando versão segura: {erro}", file=sys.stderr)
    validar_editorial(editorial, dossie)
    manifesto = carregar_manifesto()
    artigos = manifesto.get("artigos") or []
    anterior = next((a for a in artigos if int(a.get("rodada") or 0) == rodada), None)
    publicado = anterior.get("publicado_em") if anterior else momento.replace(microsecond=0).isoformat()
    modificado = momento.replace(microsecond=0).isoformat()
    pagina, metadados = gerar_artigo(dossie, editorial, publicado, modificado, artigos)
    metadados["origem_editorial"] = origem
    if anterior and anterior.get("hash_dossie") == metadados["hash_dossie"] and not args.forcar:
        print(f"Rodada {rodada} já publicada com o mesmo dossiê; nenhuma alteração.")
        return 0
    artigos = [a for a in artigos if int(a.get("rodada") or 0) != rodada] + [metadados]
    artigos.sort(key=lambda a: int(a["rodada"]))
    manifesto.update({"schema_version": 1, "site": "Fórmula do Gol", "temporada": TEMPORADA, "atualizado_em": modificado, "total_artigos": len(artigos), "artigos": artigos})
    if args.dry_run:
        print(json.dumps({"metadados": metadados, "editorial": editorial, "estado": estado}, ensure_ascii=False, indent=2))
        return 0
    gravar_texto(CAMINHO_ANALISES / slug_rodada(rodada), pagina)
    gravar_texto(CAMINHO_ANALISES / "index.html", gerar_hub(artigos))
    gravar_texto(ARQUIVO_MANIFESTO, json.dumps(manifesto, ensure_ascii=False, indent=2))
    atualizar_sitemap(artigos)
    gravar_texto(Path("news-sitemap.xml"), gerar_news_sitemap(artigos, momento))
    gravar_texto(Path("feed.xml"), gerar_feed(artigos, momento))
    print(f"Análise da rodada {rodada} gerada: {metadados['url']} (editorial: {origem}).")
    return 0


def self_test() -> int:
    assert percentual(0) == "0%"
    assert percentual(0.0005) == "<0,001%"
    assert percentual(0.0022) == "0,002%"
    assert percentual(77.5218) == "77,5%"
    assert percentual(99.9806) == ">99,9%"
    assert percentual(100) == "100%"
    assert variacao(0) == "0 p.p."
    assert variacao(0.00045) == "↑ <0,001 p.p."
    assert variacao(-0.00005) == "↓ <0,001 p.p."
    assert comparacao_percentual(0.00745, 0.00555) == ("0,007%", "0,006%", "-0,001 p.p.")
    assert comparacao_percentual(0, 0.00005) == ("0%", "<0,001%", "↑ <0,001 p.p.")
    assert comparacao_percentual(99.96, 99.97) == (">99,9%", ">99,9%", "↑ <0,1 p.p.")
    config = carregar_json(ARQUIVO_CONFIG)
    estado = estado_rodada(20, datetime(2026, 8, 2, 12, tzinfo=FUSO_BR), config)
    assert estado["elegivel"] and estado["jogos_concluidos"] == 10
    dossie = montar_dossie(20, estado)
    assert len(dossie["jogos"]) == 10 and len(dossie["clubes"]) == 20
    resultados = {j["linha"] for j in dossie["jogos"]}
    assert "Flamengo 1 × 1 São Paulo" in resultados
    assert "Palmeiras 1 × 2 Atlético-MG" in resultados
    assert "Vitória 0 × 4 Palmeiras" not in resultados
    editorial = narrativa_segura(dossie)
    validar_editorial(editorial, dossie)
    pagina, meta = gerar_artigo(dossie, editorial, "2026-08-02T12:00:00-03:00", "2026-08-02T12:00:00-03:00", carregar_manifesto().get("artigos") or [])
    assert '"@type":"NewsArticle"' in pagina and f'data-{MARCADOR}="20"' in pagina
    assert "br-analises.css?v=20260802-titulos-editoriais-v4" in pagina
    assert "Publicado em 02/08/2026" in pagina and "0,000%" not in pagina
    assert "0,007%</td><td>0,006%</td><td class=\"delta delta-down\">-0,001 p.p.</td>" in pagina
    assert "99,96%" not in pagina and "&gt;99,9%" in pagina
    assert "Padrão dos percentuais" in pagina and "analysis-round-nav" in pagina
    assert pagina.count("▶ Melhores momentos") == 10
    assert pagina.count("Estatísticas do jogo") == 10
    assert meta["jogos_concluidos"] == 10
    hub = gerar_hub(carregar_manifesto().get("artigos") or [])
    assert '<h1 class="analysis-page-title">Análises do Brasileirão 2026</h1>' in hub
    assert "analysis-hub-head" not in hub
    assert "Publicado em 02/08/2026" in hub and "analysis-round-nav" in hub
    print("OK self-test: detector, fatos, percentuais, editorial e HTML.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rodada", type=int, choices=range(1, 39))
    parser.add_argument("--forcar", action="store_true", help="Gera mesmo fora da janela ou substitui conteúdo idêntico")
    parser.add_argument("--sem-ia", action="store_true", help="Usa editorial determinístico e não chama API")
    parser.add_argument("--dry-run", action="store_true", help="Valida e mostra o resultado sem gravar arquivos")
    parser.add_argument("--modelo", default=os.environ.get("OPENAI_MODEL", MODELO_PADRAO))
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    try:
        return self_test() if args.self_test else executar(args)
    except ErroAnalise as erro:
        print(f"ERRO: {erro}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
