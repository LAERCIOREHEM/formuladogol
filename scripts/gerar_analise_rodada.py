#!/usr/bin/env python3
"""Gera e valida as análises editoriais estáticas do Brasileirão.

Resultados, variações e tabelas são produzidos deterministicamente a partir dos
JSONs do site. Quando existe editorial da camada diária de IA, este script apenas
valida e publica o JSON já produzido; nunca chama a OpenAI diretamente.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


FUSO_BR = timezone(timedelta(hours=-3))
SITE = "https://formuladogol.com.br"
TEMPORADA = 2026
TOTAL_JOGOS_RODADA = 10
ARQUIVO_MANIFESTO = Path("dados-br/analises.json")
ARQUIVO_CONFIG = Path("dados-br/config-analises.json")
ARQUIVO_ACURACIA = Path("dados-br/acuracia-af-previsao.json")
CAMINHO_ANALISES = Path("analises")
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


def percentual(valor: float, possivel_matematicamente: bool | None = None) -> str:
    valor = float(valor)
    if valor == 0:
        if possivel_matematicamente is True:
            return "<0,001%"
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


def comparacao_percentual(
    antes: float,
    depois: float,
    possivel_antes: bool | None = None,
    possivel_depois: bool | None = None,
) -> tuple[str, str, str]:
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

    texto_antes = percentual(antes, possivel_antes)
    texto_depois = percentual(depois, possivel_depois)
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


def titulo_matematicamente_possivel(clube: dict[str, Any], lider_pontos: int) -> bool:
    """Distingue zero observado no Monte Carlo de impossibilidade matemática.

    Só crava impossibilidade quando nem vencendo todas as partidas restantes o
    clube alcançaria a pontuação atual do líder. Empates em pontos permanecem
    possíveis porque os critérios de desempate ainda podem decidir o campeonato.
    """
    if float(clube.get("campeao_pct") or 0) > 0:
        return True
    try:
        pontos = int(clube["pontos_atuais"])
        jogos = int(clube["jogos_atuais"])
    except (KeyError, TypeError, ValueError):
        return True
    if not 0 <= jogos <= 38:
        return True
    if jogos == 38:
        return int(clube.get("posicao_atual") or 0) == 1
    return pontos + 3 * (38 - jogos) >= lider_pontos


def libertadores_matematicamente_possivel(clube: dict[str, Any]) -> bool:
    if float(clube.get("libertadores_pct") or 0) > 0:
        return True
    total = (((clube.get("decomposicao_chances") or {}).get("libertadores") or {}).get("total") or {})
    if total.get("impossivel_estruturalmente") is True:
        return False
    if total.get("possivel_estruturalmente") is not None:
        return bool(total.get("possivel_estruturalmente"))
    return int(clube.get("jogos_atuais") or 0) < 38


def rebaixamento_matematicamente_possivel(clube: dict[str, Any]) -> bool:
    if float(clube.get("rebaixamento_pct") or 0) > 0:
        return True
    jogos = int(clube.get("jogos_atuais") or 0)
    if jogos < 38:
        return True
    return int(clube.get("posicao_atual") or 0) >= 17


def montar_dossie(rodada: int, estado: dict[str, Any]) -> dict[str, Any]:
    inicio, fim = snapshots_da_rodada(rodada)
    antes, depois = clube_por_nome(inicio), clube_por_nome(fim)
    if set(antes) != set(depois) or len(depois) != 20:
        raise ErroAnalise("Snapshots não contêm os mesmos vinte clubes")
    lider_antes = max(int(c.get("pontos_atuais") or 0) for c in antes.values())
    lider_depois = max(int(c.get("pontos_atuais") or 0) for c in depois.values())
    linhas = []
    for nome in depois:
        a, d = antes[nome], depois[nome]
        linhas.append({
            "clube": nome,
            "posicao_antes": int(a.get("posicao_atual") or 0),
            "posicao_depois": int(d.get("posicao_atual") or 0),
            "pontos_antes": int(a.get("pontos_atuais") or 0),
            "pontos_depois": int(d.get("pontos_atuais") or 0),
            "jogos_antes": int(a.get("jogos_atuais") or 0),
            "jogos_depois": int(d.get("jogos_atuais") or 0),
            "posicao_projetada_depois": int(d.get("posicao_projetada") or 0),
            "pontos_projetados_depois": int(d.get("pontos_projetados") or 0),
            "titulo_antes": float(a.get("campeao_pct") or 0),
            "titulo_depois": float(d.get("campeao_pct") or 0),
            "titulo_possivel_antes": titulo_matematicamente_possivel(a, lider_antes),
            "titulo_possivel_depois": titulo_matematicamente_possivel(d, lider_depois),
            "titulo_delta": float(d.get("campeao_pct") or 0) - float(a.get("campeao_pct") or 0),
            "libertadores_antes": float(a.get("libertadores_pct") or 0),
            "libertadores_depois": float(d.get("libertadores_pct") or 0),
            "libertadores_possivel_depois": libertadores_matematicamente_possivel(d),
            "libertadores_delta": float(d.get("libertadores_pct") or 0) - float(a.get("libertadores_pct") or 0),
            "sul_americana_antes": float(a.get("sul_americana_pct") or 0),
            "sul_americana_depois": float(d.get("sul_americana_pct") or 0),
            "sul_americana_delta": float(d.get("sul_americana_pct") or 0) - float(a.get("sul_americana_pct") or 0),
            "sem_continental_antes": max(0.0, 100.0 - float(a.get("libertadores_pct") or 0) - float(a.get("sul_americana_pct") or 0)),
            "sem_continental_depois": max(0.0, 100.0 - float(d.get("libertadores_pct") or 0) - float(d.get("sul_americana_pct") or 0)),
            "rebaixamento_antes": float(a.get("rebaixamento_pct") or 0),
            "rebaixamento_depois": float(d.get("rebaixamento_pct") or 0),
            "rebaixamento_possivel_depois": rebaixamento_matematicamente_possivel(d),
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
    alta_lib = maiores(dossie, "libertadores_delta", 1)[0]
    baixa_lib = maiores(dossie, "libertadores_delta", 1, False)[0]
    alerta_queda = maiores(dossie, "rebaixamento_delta", 1)[0]
    alivio_queda = maiores(dossie, "rebaixamento_delta", 1, False)[0]
    jogos = {j["mandante"]: j for j in dossie["jogos"]}
    if rodada == 20 and "Palmeiras" in jogos and "Flamengo" in jogos:
        return {
            "titulo": "Rodada 20 abre a porta, mas Flamengo aproveita só parte do tropeço do Palmeiras",
            "linha_fina": "O Atlético-MG derrubou o líder, o Flamengo parou no São Paulo e a rodada premiou Athletico-PR, Botafogo e Remo com avanços importantes nas projeções.",
            "secoes": [
                {
                    "titulo": "O líder caiu; o perseguidor hesitou",
                    "paragrafos": [
                        "A rodada ofereceu ao Flamengo a oportunidade mais clara de apertar a liderança, mas terminou com gosto ambíguo para os dois primeiros. O Palmeiras perdeu em casa para o Atlético-MG e abriu uma fresta no topo; o time rubro-negro, porém, ficou no empate com o São Paulo e aproveitou apenas parte do espaço deixado pelo rival.",
                        "A fotografia estatística mudou sem inverter a hierarquia. O Palmeiras segue como favorito porque a vantagem construída até aqui ainda pesa em grande parte das simulações. O Flamengo avançou, mas sua aproximação nasceu da combinação entre o revés do líder e o ponto que somou, não de uma virada completa na corrida pelo título. A disputa ficou mais viva; ainda não ficou equilibrada.",
                    ],
                },
                {
                    "titulo": "Três vitórias que mexeram no bloco continental",
                    "paragrafos": [
                        "Athletico-PR e Botafogo foram os vencedores com efeito mais nítido na corrida continental. O time paranaense venceu o Internacional e consolidou sua presença no grupo da frente. O Botafogo, por sua vez, venceu o Cruzeiro fora de casa e deu um salto relevante: somou pontos, ultrapassou concorrentes e transformou um confronto direto em ganho duplo na projeção de Libertadores.",
                        "O Atlético-MG produziu o resultado de maior repercussão ao derrubar o líder em seu estádio. Além do peso simbólico, a vitória melhorou simultaneamente seus caminhos: aproximou o clube da faixa continental e reduziu com força o risco de queda. São Paulo e Fluminense pontuaram fora de casa, mas os empates tiveram alcance mais limitado diante das vitórias de concorrentes diretos.",
                    ],
                },
                {
                    "titulo": "Na parte de baixo, vencer valeu muito mais do que resistir",
                    "paragrafos": [
                        "O Remo conseguiu a resposta mais valiosa entre os ameaçados. A vitória sobre o Vitória não resolveu sua temporada, mas retirou pressão imediata e reduziu sensivelmente o risco projetado de rebaixamento. O efeito inverso atingiu o adversário: sem pontuar, o Vitória perdeu margem para os times que vinham logo atrás e terminou a rodada mais exposto.",
                        "Santos e Chapecoense fizeram um empate que serviu pouco aos dois. A Chapecoense acrescentou um ponto, mas continua isolada na situação mais grave do campeonato. Para o Santos, ficar apenas no empate em casa teve custo maior, porque o risco de queda cresceu enquanto Remo e Atlético-MG venceram. O Internacional também saiu prejudicado: a derrota para o Athletico-PR aumentou a distância para a zona de alívio.",
                    ],
                },
                {
                    "titulo": "O que a rodada deixa para a sequência",
                    "paragrafos": [
                        "O principal recado está no contraste entre tabela e probabilidade. Um único fim de semana não apaga a vantagem acumulada pelo Palmeiras, mas mostrou que o líder ainda pode ceder terreno. Ao Flamengo cabe transformar a pressão estatística em vitórias; aos perseguidores do bloco continental, a rodada confirmou que confrontos diretos produzem movimentos maiores do que a simples soma de pontos.",
                        "Na metade inferior, a margem para tropeços diminuiu. O Remo provou como uma vitória altera rapidamente a leitura do risco, enquanto Santos, Vitória e Internacional sentiram o efeito contrário. As projeções não encerram nenhuma disputa: elas registram, com base no que já aconteceu e no calendário restante, quem saiu desta rodada com caminhos mais largos e quem passou a depender de uma reação mais urgente.",
                    ],
                },
            ],
        }
    return {
        "titulo": f"Rodada {rodada}: {alta['clube']} ganha espaço e {baixa['clube']} recua nas projeções",
        "linha_fina": "Os resultados alteraram as probabilidades de título, classificação continental e permanência no Brasileirão.",
        "secoes": [
            {
                "titulo": "A mudança central da rodada",
                "paragrafos": [
                    f"A rodada alterou o equilíbrio da disputa principal. {alta['clube']} registrou o avanço mais relevante na probabilidade de título, enquanto {baixa['clube']} perdeu terreno. O movimento não transforma automaticamente quem subiu em favorito nem elimina quem recuou; ele mostra como os resultados modificaram o conjunto de caminhos disponíveis até o fim do campeonato.",
                    "A leitura também não depende de uma partida isolada. O modelo recalcula todo o calendário restante e combina pontuação acumulada, quantidade de jogos disputados, mando de campo, força estimada e as vagas continentais ainda abertas. Por isso, dois clubes que somam o mesmo número de pontos podem terminar a rodada com mudanças diferentes nas projeções.",
                    "O dado mais importante é a direção do movimento, e não uma interpretação apressada de certeza. Ganhar probabilidade significa que o clube terminou a rodada com uma parcela maior dos desfechos simulados a seu favor; perder probabilidade indica que outros caminhos passaram a exigir uma combinação mais difícil de resultados.",
                ],
            },
            {
                "titulo": "A corrida continental ficou mais seletiva",
                "paragrafos": [
                    f"Na disputa por Libertadores, {alta_lib['clube']} foi o clube que mais ampliou sua presença nos cenários classificados. No sentido contrário, {baixa_lib['clube']} terminou a rodada com a perda mais acentuada. Essa faixa costuma reagir com força porque reúne times próximos, calendários diferentes e vias adicionais abertas pelas copas, o que torna cada ponto especialmente relevante.",
                    "Vitórias em confrontos diretos tendem a produzir movimentos maiores porque um clube avança ao mesmo tempo que impede o concorrente de pontuar. Empates podem preservar posição na tabela, mas nem sempre mantêm a mesma probabilidade quando adversários próximos vencem. A projeção continental, portanto, deve ser lida como uma corrida conjunta e não como uma sequência de avaliações isoladas.",
                    "A classificação atual continua sendo o registro oficial do campeonato, enquanto a probabilidade olha adiante. Essa diferença explica por que um time pode aparecer momentaneamente atrás na tabela e ainda conservar uma projeção melhor: jogos a cumprir, força estimada e confrontos restantes também influenciam a distribuição final.",
                ],
            },
            {
                "titulo": "A pressão mudou de endereço na parte de baixo",
                "paragrafos": [
                    f"Na luta contra o rebaixamento, {alerta_queda['clube']} recebeu o maior aumento de risco, enquanto {alivio_queda['clube']} conseguiu o alívio mais expressivo. A diferença resume a lógica da parte inferior: uma vitória pode devolver margem e confiança estatística, enquanto um tropeço ganha peso adicional quando concorrentes diretos aproveitam a mesma rodada.",
                    "As probabilidades não funcionam como sentença. Elas organizam os caminhos disponíveis depois de cada rodada e serão recalculadas sempre que um novo resultado alterar a base esportiva. O quadro permanece aberto, mas a comparação permite identificar quem ganhou alternativas para a sequência e quem passou a depender de uma reação mais rápida para reduzir a pressão.",
                ],
            },
        ],
    }


def schema_editorial() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "titulo": {"type": "string", "minLength": 35, "maxLength": 130},
            "linha_fina": {"type": "string", "minLength": 60, "maxLength": 220},
            "secoes": {
                "type": "array",
                "minItems": 3,
                "maxItems": 4,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "titulo": {"type": "string", "minLength": 18, "maxLength": 85},
                        "paragrafos": {
                            "type": "array",
                            "minItems": 2,
                            "maxItems": 3,
                            "items": {"type": "string", "minLength": 150, "maxLength": 760},
                        },
                    },
                    "required": ["titulo", "paragrafos"],
                },
            },
        },
        "required": ["titulo", "linha_fina", "secoes"],
    }


def resumo_editorial(dossie: dict[str, Any]) -> dict[str, Any]:
    return {
        "rodada": dossie["rodada"],
        "simulacoes": dossie["simulacoes"],
        "resultados": [
            {
                "partida": j["linha"],
                "mandante": j["mandante"],
                "visitante": j["visitante"],
            }
            for j in dossie["jogos"]
        ],
        "classificacao_e_probabilidades": sorted(
            [
                {
                    chave: c[chave]
                    for chave in (
                        "clube", "posicao_antes", "posicao_depois", "pontos_antes", "pontos_depois",
                        "jogos_antes", "jogos_depois", "posicao_projetada_depois", "pontos_projetados_depois",
                        "titulo_antes", "titulo_depois", "titulo_delta", "libertadores_antes",
                        "libertadores_depois", "libertadores_delta", "sul_americana_antes",
                        "sul_americana_depois", "sul_americana_delta", "sem_continental_antes",
                        "sem_continental_depois", "rebaixamento_antes",
                        "rebaixamento_depois", "rebaixamento_delta",
                    )
                }
                for c in dossie["clubes"]
            ],
            key=lambda c: (c["posicao_depois"], c["clube"]),
        ),
        "destaques_calculados": {
            "altas_titulo": [c["clube"] for c in maiores(dossie, "titulo_delta", 5)],
            "baixas_titulo": [c["clube"] for c in maiores(dossie, "titulo_delta", 5, reverso=False)],
            "altas_libertadores": [c["clube"] for c in maiores(dossie, "libertadores_delta", 5)],
            "baixas_libertadores": [c["clube"] for c in maiores(dossie, "libertadores_delta", 5, reverso=False)],
            "altas_risco_rebaixamento": [c["clube"] for c in maiores(dossie, "rebaixamento_delta", 5)],
            "quedas_risco_rebaixamento": [c["clube"] for c in maiores(dossie, "rebaixamento_delta", 5, reverso=False)],
        },
        "partidas_pendentes": dossie["estado"]["pendentes"],
    }


def hash_editorial(dossie: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(resumo_editorial(dossie), ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()


def editorial_gerado_pela_openai(origem: Any) -> bool:
    return str(origem or "").startswith("openai:")


def validar_editorial(editorial: dict[str, Any], dossie: dict[str, Any]) -> None:
    if set(editorial) != {"titulo", "linha_fina", "secoes"}:
        raise ErroAnalise("Editorial fora do schema esperado")
    secoes = editorial.get("secoes") or []
    if len(secoes) not in {3, 4} or any(set(secao) != {"titulo", "paragrafos"} for secao in secoes):
        raise ErroAnalise("Editorial incompleto")
    if any(len(secao.get("paragrafos") or []) not in {2, 3} for secao in secoes):
        raise ErroAnalise("Quantidade de parágrafos fora do padrão editorial")
    campos = [editorial["titulo"], editorial["linha_fina"]]
    for secao in secoes:
        campos.append(secao["titulo"])
        campos.extend(secao["paragrafos"])
    if not all(isinstance(x, str) and x.strip() for x in campos):
        raise ErroAnalise("Editorial incompleto")
    texto = " ".join(campos)
    texto_sem_rodada = texto.replace(str(dossie["rodada"]), "")
    if re.search(r"\d", texto_sem_rodada):
        raise ErroAnalise("A IA incluiu algarismos; conteúdo rejeitado para impedir dado não auditado")
    proibidos = ["vale destacar", "em um cenário", "a narrativa", "mergulhar", "jornada", "não apenas", "o futebol nos ensina", "mais do que nunca"]
    if any(frase in texto.casefold() for frase in proibidos):
        raise ErroAnalise("Editorial contém linguagem artificial proibida")
    clubes = {c["clube"] for c in dossie["clubes"]}
    conhecidos = [c for c in clubes if c.casefold() in texto.casefold()]
    if not conhecidos:
        raise ErroAnalise("Editorial não menciona nenhum clube do dossiê")
    total_palavras = len(re.findall(r"\b[\wÀ-ÿ-]+\b", " ".join(
        paragrafo for secao in secoes for paragrafo in secao["paragrafos"]
    )))
    if not 380 <= total_palavras <= 950:
        raise ErroAnalise(f"Editorial deve ter entre 380 e 950 palavras; recebeu {total_palavras}")


def esc(valor: Any) -> str:
    return html.escape(str(valor), quote=True)


def id_editorial_artigo(artigo: dict[str, Any]) -> str:
    identificador = normalizar_nome(artigo.get("id_editorial") or "")
    if identificador:
        return identificador
    rodada = int(artigo.get("rodada") or 0)
    return f"brasileirao-{TEMPORADA}-rodada-{rodada}" if rodada else normalizar_nome(artigo.get("slug") or "editorial")


def rotulo_menu_artigo(artigo: dict[str, Any]) -> str:
    rotulo = normalizar_nome(artigo.get("rotulo_menu") or "")
    if rotulo:
        return rotulo
    rodada = int(artigo.get("rodada") or 0)
    return f"R{rodada}" if rodada else "Análise"


def categoria_artigo(artigo: dict[str, Any]) -> str:
    categoria = normalizar_nome(artigo.get("categoria") or "")
    if categoria:
        return categoria
    rodada = int(artigo.get("rodada") or 0)
    return f"RODADA {rodada}" if rodada else "ANÁLISE"


def chave_ordenacao_artigo(artigo: dict[str, Any]) -> tuple[str, str]:
    return (str(artigo.get("publicado_em") or artigo.get("modificado_em") or ""), id_editorial_artigo(artigo))


def menu(prefixo: str, ativo: bool = False) -> str:
    itens = [
        ("📈", "Estatísticas", f"{prefixo}estatisticas.html"),
        ("⚽", "Jogos", f"{prefixo}jogos"),
        ("🔴", "Ao vivo", f"{prefixo}aovivo.html"),
        ("📊", "Tabela", f"{prefixo}tabela"),
        ("✅", "Resultados", f"{prefixo}resultados"),
        ("📰", "Análises", f"{prefixo}analises/"),
        ("🎯", "Acurácia", f"{prefixo}acuracia.html"),
        ("🛡️", "Clubes", f"{prefixo}clubes.html"),
        ("🏛️", "Museu", f"{prefixo}museu.html"),
        ("🌎", "Copa 2026", f"{prefixo}copa2026/"),
    ]
    links = []
    for icone, rotulo, href in itens:
        classe = ' class="active" aria-current="page"' if ativo and rotulo == "Análises" else ""
        marcador = ' data-br-acuracia="1"' if rotulo == "Acurácia" else ""
        links.append(f'      <a href="{href}"{classe}{marcador}>{icone} {rotulo}</a>')
    return '<nav class="nav" data-br-auth-menu aria-label="Menu principal">\n' + "\n".join(links) + "\n    </nav>"

def submenu_rodadas(
    artigos: list[dict[str, Any]],
    rodada_ativa: int | None = None,
    id_ativo: str | None = None,
) -> str:
    ativo = id_ativo or (f"brasileirao-{TEMPORADA}-rodada-{rodada_ativa}" if rodada_ativa else None)
    disponiveis: dict[str, dict[str, Any]] = {}
    for item in artigos:
        identificador = id_editorial_artigo(item)
        if identificador:
            disponiveis[identificador] = item
    if rodada_ativa and ativo not in disponiveis:
        disponiveis[ativo] = {
            "id_editorial": ativo,
            "rodada": rodada_ativa,
            "rotulo_menu": f"R{rodada_ativa}",
            "slug": slug_rodada(rodada_ativa),
            "publicado_em": "",
        }
    links = []
    for identificador, item in sorted(disponiveis.items(), key=lambda par: chave_ordenacao_artigo(par[1]), reverse=True):
        atual = ' class="active" aria-current="page"' if identificador == ativo else ""
        links.append(f'<a href="{esc(item.get("slug") or "")}"{atual}>{esc(rotulo_menu_artigo(item))}</a>')
    if not links:
        return ""
    return '<nav class="analysis-round-nav" aria-label="Arquivo de análises"><strong>ANÁLISES</strong><div>' + "".join(links) + "</div></nav>"

def valor_estatistica(valor: Any) -> str:
    texto = str(valor if valor is not None else "—")
    if re.fullmatch(r"-?\d+\.\d+%", texto):
        texto = texto.replace(".", ",")
    return texto


def youtube_video_id(valor: str) -> str:
    bruto = str(valor or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{6,20}", bruto):
        return bruto
    try:
        url = urlparse(bruto)
    except ValueError:
        return ""
    host = (url.hostname or "").lower().removeprefix("www.")
    video_id = ""
    if host == "youtu.be":
        video_id = next(iter(filter(None, url.path.split("/"))), "")
    elif host == "youtube.com" or host.endswith(".youtube.com"):
        video_id = (parse_qs(url.query).get("v") or [""])[0]
        partes = [parte for parte in url.path.split("/") if parte]
        if not video_id and len(partes) >= 2 and partes[0] in {"embed", "shorts", "live"}:
            video_id = partes[1]
    return video_id if re.fullmatch(r"[A-Za-z0-9_-]{6,20}", video_id) else ""


def renderizar_jogo(jogo: dict[str, Any]) -> str:
    video = jogo.get("melhores_momentos") or {}
    detalhes = jogo.get("detalhes") or {}
    meta = []
    if detalhes.get("estadio"):
        meta.append(f'<span>📍 {esc(detalhes["estadio"])}</span>')
    if detalhes.get("arbitro"):
        meta.append(f'<span>Árbitro: {esc(detalhes["arbitro"])}</span>')
    publico = detalhes.get("publico")
    if isinstance(publico, (int, float)) and publico > 0:
        meta.append(f'<span>Público: {int(publico):,}</span>'.replace(",", "."))
    estatisticas = detalhes.get("estatisticas") or []
    painel_estatisticas = ""
    botao_estatisticas = ""
    if estatisticas or meta:
        identificador = "stats-" + re.sub(r"[^A-Za-z0-9_-]", "-", str(jogo.get("event_id") or "jogo"))
        linhas = "".join(
            f'<tr><td>{esc(valor_estatistica(item.get("mandante")))}</td><th scope="row">{esc(item.get("nome"))}</th><td>{esc(valor_estatistica(item.get("visitante")))}</td></tr>'
            for item in estatisticas
        )
        tabela = ""
        if linhas:
            tabela = f'''<div class="analysis-game-stats-wrap"><table class="analysis-game-stats">
              <thead><tr><th>{esc(jogo['mandante'])}</th><th>Estatística</th><th>{esc(jogo['visitante'])}</th></tr></thead>
              <tbody>{linhas}</tbody></table></div>'''
        botao_estatisticas = f'<button type="button" class="analysis-stats-toggle" aria-expanded="false" aria-controls="{esc(identificador)}">▸ Estatísticas do jogo</button>'
        painel_estatisticas = f'''<div class="analysis-game-details" id="{esc(identificador)}" hidden>
          <div class="analysis-game-meta">{''.join(meta)}</div>{tabela}</div>'''
    botao_video = ""
    video_id = youtube_video_id(video.get("url") or "")
    if video_id:
        botao_video = (
            f'<button type="button" class="analysis-video" data-video-id="{esc(video_id)}" '
            f'data-video-title="{esc(video.get("titulo") or jogo["linha"])}" '
            f'data-video-source="{esc(video.get("fonte") or "YouTube")}">▶ Melhores momentos</button>'
        )
    return f'''<article class="analysis-game-card">
      <h3>{esc(jogo['linha'])}</h3>
      <div class="analysis-game-actions">{botao_estatisticas}{botao_video}</div>
      {painel_estatisticas}
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
  <link rel="stylesheet" href="../css/br-analises.css?v=20260807-acuracia-box-v1">
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-3956SD5HFC"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){{dataLayer.push(arguments)}}gtag('js',new Date());gtag('config','G-3956SD5HFC');gtag('config','AW-18273186827');gtag('event','ads_conversion_PAGE_VIEW_1',{{}});</script>
  <script type="application/ld+json">{json_ld}</script>
</head>'''


def tabela_comparativa(dossie: dict[str, Any]) -> str:
    linhas = sorted(dossie["clubes"], key=lambda c: (-c["pontos_depois"], -c["titulo_depois"], c["clube"]))
    corpo = []
    for c in linhas:
        classe_delta = "delta-up" if c["titulo_delta"] > 0 else "delta-down" if c["titulo_delta"] < 0 else "delta-flat"
        titulo_antes, titulo_depois, titulo_delta = comparacao_percentual(
            c["titulo_antes"],
            c["titulo_depois"],
            c["titulo_possivel_antes"],
            c["titulo_possivel_depois"],
        )
        corpo.append(f'''<tr>
          <th scope="row"><a href="../clubes.html#{esc(c['clube'].lower().replace(' ', '-'))}">{esc(c['clube'])}</a></th>
          <td>{c['pontos_depois']}</td>
          <td>{esc(titulo_antes)}</td><td>{esc(titulo_depois)}</td><td class="delta {classe_delta}">{esc(titulo_delta)}</td>
          <td>{esc(percentual(c['libertadores_depois'], c['libertadores_possivel_depois']))}</td><td>{esc(percentual(c['rebaixamento_depois'], c['rebaixamento_possivel_depois']))}</td>
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


def box_acuracia_rodada(rodada: int, dados: dict[str, Any] | None = None) -> str:
    """Retorna um box editorial apenas quando há um destaque agregado positivo.

    A página pública de Acurácia continua com a avaliação matemática completa;
    o editorial da rodada usa apenas sinais positivos suficientemente robustos,
    sem listar partidas individuais nem criar uma seção de erros.
    """
    if dados is None:
        try:
            dados = carregar_json(ARQUIVO_ACURACIA)
        except ErroAnalise:
            return ""
    jogos = dados.get("jogos") or {}
    alvo = next(
        (item for item in (jogos.get("por_rodada") or []) if int(item.get("rodada") or 0) == int(rodada)),
        None,
    )
    if not alvo:
        return ""

    destaques: list[str] = []
    amostra = int(alvo.get("maior_probabilidade_avaliada") or 0)
    taxa = alvo.get("taxa_confirmacao_pct")
    if amostra >= 5 and taxa is not None and float(taxa) >= 60.0:
        destaques.append(
            f'<strong>{esc(_numero_pt_br(_arredondar(float(taxa), 1), 1))}%</strong> '
            'das tendências de maior probabilidade da rodada se confirmaram.'
        )

    fortes = int(alvo.get("previsoes_fortes_60_total") or 0)
    taxa_fortes = alvo.get("taxa_fortes_60_pct")
    if fortes >= 2 and taxa_fortes is not None and float(taxa_fortes) >= 80.0:
        if abs(float(taxa_fortes) - 100.0) <= 1e-9:
            destaques.append(
                f'Todas as <strong>{fortes}</strong> previsões com confiança de 60% ou mais foram confirmadas.'
            )
        else:
            destaques.append(
                f'<strong>{esc(_numero_pt_br(_arredondar(float(taxa_fortes), 1), 1))}%</strong> '
                'das previsões com confiança de 60% ou mais foram confirmadas.'
            )

    if not destaques:
        return ""
    return (
        '<aside class="analysis-accuracy-box" aria-label="AF em prova">'
        '<div><span>🎯 AF EM PROVA</span><p>' + ' '.join(destaques) + '</p></div>'
        '<a href="../acuracia.html">Ver acurácia do AF-Previsão →</a>'
        '</aside>'
    )


def gerar_artigo(dossie: dict[str, Any], editorial: dict[str, Any], publicado: str, modificado: str, historico: list[dict[str, Any]]) -> tuple[str, dict[str, Any]]:
    rodada = dossie["rodada"]
    identificador = f"brasileirao-{TEMPORADA}-rodada-{rodada}"
    url = f"{SITE}/analises/{slug_rodada(rodada)}"
    titulo, linha_fina = editorial["titulo"], editorial["linha_fina"]
    nota_pendente = ""
    if dossie["estado"]["jogos_pendentes"]:
        jogos = ", ".join(f"{p['mandante']} × {p['visitante']}" for p in dossie["estado"]["pendentes"])
        nota_pendente = f'<aside class="analysis-note"><strong>Rodada com pendência:</strong> {esc(jogos)}. Esta página será atualizada na mesma URL após a realização da partida.</aside>'
    resultados = "".join(renderizar_jogo(jogo) for jogo in dossie["jogos"])
    secoes_editoriais = "\n".join(
        '<section class="analysis-copy-section">'
        f'<h3>{esc(secao["titulo"])}</h3>'
        + "".join(f"<p>{esc(paragrafo)}</p>" for paragrafo in secao["paragrafos"])
        + "</section>"
        for secao in editorial["secoes"]
    )
    html_final = cabecalho_html(titulo, linha_fina, url, "NewsArticle", publicado, modificado) + f'''
<body data-{MARCADOR}="{rodada}" data-fdg-editorial-id="{identificador}">
  <div class="container analysis-shell">
    <header class="hero" aria-label="Fórmula do Gol — A matemática por trás do futebol"><img src="../img/header-formula-do-gol-v2.png" alt="Fórmula do Gol — A matemática por trás do futebol" fetchpriority="high"></header>
    {menu('../', True)}
    {submenu_rodadas(historico, rodada, identificador)}
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
        {box_acuracia_rodada(rodada)}
        <section class="analysis-copy"><h2>O retrato da rodada</h2><div class="analysis-copy-sections">{secoes_editoriais}</div></section>
        <section><h2>Resultados considerados</h2><div class="analysis-results">{resultados}</div></section>
        <section><h2>Como as probabilidades mudaram</h2><p class="analysis-help">Comparação entre o último snapshot anterior e o fechamento editorial da rodada. No celular, arraste a tabela para o lado.</p><p class="analysis-percent-legend"><strong>Padrão dos percentuais:</strong> <b>0%</b> aparece somente quando o título já é matematicamente impossível; <b>&lt;0,001%</b> preserva uma possibilidade ainda existente, mas abaixo da resolução exibida — inclusive quando ela não ocorreu nas 2 milhões de simulações. Nas variações, <b>↑/↓ &lt;0,001 p.p.</b> identifica movimentos residuais sem criar zeros falsos.</p>{tabela_comparativa(dossie)}</section>
        <aside class="analysis-method"><strong>Leitura dos dados:</strong> as probabilidades são estimativas do AF-Previsão, calculadas em {dossie['simulacoes']:,} simulações e não representam certezas. A análise editorial utiliza somente um dossiê factual auditado; resultados e percentuais são inseridos diretamente dos JSONs do Fórmula do Gol.</aside>
        <nav class="analysis-next" aria-label="Mais conteúdo"><a href="./">← Todas as análises</a><a href="../estatisticas.html#probabilidades">Probabilidades atuais →</a></nav>
      </article>
    </main>
    {rodape('../')}
  </div>
  <script src="../js/br-menu.js?v=20260808-jogos-unificados-v1"></script>
  <script src="../js/br-analises.js?v=20260805-editorial-continental-v1"></script>
</body>
</html>'''.replace(f"{dossie['simulacoes']:,}", f"{dossie['simulacoes']:,}".replace(",", "."))
    metadados = {
        "tipo": "brasileirao_rodada",
        "id_editorial": identificador,
        "rotulo_menu": f"R{rodada}",
        "categoria": f"RODADA {rodada}",
        "rodada": rodada,
        "slug": slug_rodada(rodada),
        "url": url,
        "titulo": titulo,
        "linha_fina": linha_fina,
        "publicado_em": publicado,
        "modificado_em": modificado,
        "jogos_concluidos": dossie["estado"]["jogos_concluidos"],
        "jogos_pendentes": dossie["estado"]["jogos_pendentes"],
        "hash_dossie": hashlib.sha256(json.dumps(dossie, ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
        "email_assunto": f"Fórmula do Gol: análise da rodada {rodada} publicada",
        "email_chamada": f"A análise da rodada {rodada} do Brasileirão já está no ar.",
    }
    return html_final, metadados

def gerar_hub(artigos: list[dict[str, Any]]) -> str:
    ordenados = sorted(artigos, key=chave_ordenacao_artigo, reverse=True)
    cards = []
    for i, artigo in enumerate(ordenados):
        classe = " analysis-card-featured" if i == 0 else ""
        pendencia = " · edição parcial" if artigo.get("jogos_pendentes") else ""
        cards.append(
            f'<article class="analysis-card{classe}"><time datetime="{esc(artigo["publicado_em"])}">Publicado em {data_curta(artigo["publicado_em"])}</time>'
            f'<span>{esc(categoria_artigo(artigo))}{pendencia}</span><h2><a href="{esc(artigo["slug"])}">{esc(artigo["titulo"])}</a></h2>'
            f'<p>{esc(artigo["linha_fina"])}</p><a class="analysis-read" href="{esc(artigo["slug"])}">Ler análise →</a></article>'
        )
    titulo = "Análises do Fórmula do Gol"
    descricao = "Análises dos resultados do Brasileirão e dos torneios que alteram as chances continentais dos clubes da Série A."
    return cabecalho_html("Análises", descricao, f"{SITE}/analises/", "CollectionPage") + f'''
<body>
  <div class="container analysis-shell">
    <header class="hero" aria-label="Fórmula do Gol — A matemática por trás do futebol"><img src="../img/header-formula-do-gol-v2.png" alt="Fórmula do Gol — A matemática por trás do futebol" fetchpriority="high"></header>
    {menu('../', True)}
    {submenu_rodadas(artigos)}
    <main>
      <h1 class="analysis-page-title">{titulo}</h1>
      <section class="analysis-grid" aria-label="Arquivo de análises">{''.join(cards) if cards else '<p>Nenhuma análise publicada.</p>'}</section>
    </main>
    {rodape('../')}
  </div>
  <script src="../js/br-menu.js?v=20260808-jogos-unificados-v1"></script>
</body>
</html>'''

def atualizar_sitemap(artigos: list[dict[str, Any]]) -> None:
    ns = "http://www.sitemaps.org/schemas/sitemap/0.9"
    ET.register_namespace("", ns)
    caminho = Path("sitemap.xml")
    raiz = ET.parse(caminho).getroot()
    urls = {((no.find(f"{{{ns}}}loc").text or "").strip()): no for no in raiz.findall(f"{{{ns}}}url")}
    desejadas = [f"{SITE}/analises/"] + [a["url"] for a in sorted(artigos, key=chave_ordenacao_artigo)]
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
<rss version="2.0"><channel><title>Análises — Fórmula do Gol</title><link>{SITE}/analises/</link><description>Análises do Brasileirão e dos torneios que alteram as chances continentais dos clubes da Série A.</description><language>pt-BR</language><lastBuildDate>{agora_rfc}</lastBuildDate>{''.join(itens)}</channel></rss>'''


def carregar_manifesto() -> dict[str, Any]:
    if not ARQUIVO_MANIFESTO.exists():
        return {"schema_version": 2, "site": "Fórmula do Gol", "artigos": []}
    manifesto = carregar_json(ARQUIVO_MANIFESTO)
    artigos = manifesto.get("artigos") or []
    for artigo in artigos:
        artigo.setdefault("id_editorial", id_editorial_artigo(artigo))
        artigo.setdefault("rotulo_menu", rotulo_menu_artigo(artigo))
        artigo.setdefault("categoria", categoria_artigo(artigo))
        artigo.setdefault("tipo", "brasileirao_rodada" if int(artigo.get("rodada") or 0) else "editorial")
    manifesto["artigos"] = artigos
    return manifesto

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
    hash_dossie = hashlib.sha256(
        json.dumps(dossie, ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()
    hash_fatos_editoriais = hash_editorial(dossie)
    manifesto = carregar_manifesto()
    artigos = manifesto.get("artigos") or []
    anterior = next((a for a in artigos if int(a.get("rodada") or 0) == rodada), None)
    anterior_com_ia = bool(anterior and editorial_gerado_pela_openai(anterior.get("origem_editorial")))
    if (
        anterior
        and anterior.get("hash_dossie") == hash_dossie
        and not args.forcar
        and (anterior_com_ia or args.sem_ia)
    ):
        print(f"Rodada {rodada} já publicada com o mesmo dossiê; API e arquivos não foram acionados.")
        return 0

    editorial_anterior = anterior.get("editorial") if anterior else None
    reutilizar_editorial = bool(
        anterior
        and not args.forcar
        and (anterior_com_ia or args.sem_ia)
        and anterior.get("hash_editorial") == hash_fatos_editoriais
        and isinstance(editorial_anterior, dict)
    )
    if reutilizar_editorial:
        validar_editorial(editorial_anterior, dossie)
        editorial = editorial_anterior
        origem = str(anterior.get("origem_editorial") or "editorial_reutilizado")
        print(f"Fatos editoriais da rodada {rodada} inalterados; texto existente reutilizado sem chamar a API.")
    else:
        fallback = narrativa_segura(dossie)
        if args.editorial_json:
            try:
                candidato = json.loads(Path(args.editorial_json).read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise ErroAnalise(f"Editorial externo inválido: {exc}") from exc
            validar_editorial(candidato, dossie)
            if not re.search(rf"\b{rodada}\b", candidato["titulo"]):
                candidato["titulo"] = f"Rodada {rodada}: {candidato['titulo']}"
            editorial, origem = candidato, args.origem_editorial or "openai:auditoria-diaria"
        else:
            # A única chamada diária à OpenAI pertence a auditoria_ia_diaria.py.
            # Sem --editorial-json, este gerador sempre usa a contingência determinística.
            editorial, origem = fallback, "editorial_curado" if rodada == 20 else "deterministico"
    validar_editorial(editorial, dossie)
    publicado = anterior.get("publicado_em") if anterior else momento.replace(microsecond=0).isoformat()
    modificado = momento.replace(microsecond=0).isoformat()
    pagina, metadados = gerar_artigo(dossie, editorial, publicado, modificado, artigos)
    metadados["hash_editorial"] = hash_fatos_editoriais
    metadados["editorial"] = editorial
    metadados["origem_editorial"] = origem
    artigos = [a for a in artigos if not (a.get("tipo") == "brasileirao_rodada" and int(a.get("rodada") or 0) == rodada)] + [metadados]
    artigos.sort(key=chave_ordenacao_artigo)
    manifesto.update({"schema_version": 2, "site": "Fórmula do Gol", "temporada": TEMPORADA, "atualizado_em": modificado, "total_artigos": len(artigos), "artigos": artigos})
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
    assert editorial_gerado_pela_openai("openai:gpt-5.6-terra")
    assert not editorial_gerado_pela_openai("editorial_curado")
    assert percentual(0) == "0%"
    assert percentual(0, True) == "<0,001%"
    assert percentual(0, False) == "0%"
    assert titulo_matematicamente_possivel({"campeao_pct": 0, "pontos_atuais": 22, "jogos_atuais": 20}, 47)
    assert rebaixamento_matematicamente_possivel({"rebaixamento_pct": 0, "jogos_atuais": 20, "posicao_atual": 1})
    assert not rebaixamento_matematicamente_possivel({"rebaixamento_pct": 0, "jogos_atuais": 38, "posicao_atual": 1})
    assert not titulo_matematicamente_possivel(
        {"campeao_pct": 0, "pontos_atuais": 60, "jogos_atuais": 38, "posicao_atual": 2},
        60,
    )
    assert percentual(0.0005) == "<0,001%"
    assert percentual(0.0022) == "0,002%"
    assert percentual(77.5218) == "77,5%"
    assert percentual(99.9806) == ">99,9%"
    assert percentual(100) == "100%"
    assert youtube_video_id("https://www.youtube.com/watch?v=JDF3vatmswE") == "JDF3vatmswE"
    assert youtube_video_id("https://youtu.be/JDF3vatmswE") == "JDF3vatmswE"
    assert youtube_video_id("https://example.com/watch?v=JDF3vatmswE") == ""
    assert variacao(0) == "0 p.p."
    assert variacao(0.00045) == "↑ <0,001 p.p."
    assert variacao(-0.00005) == "↓ <0,001 p.p."
    assert comparacao_percentual(0.00745, 0.00555) == ("0,007%", "0,006%", "-0,001 p.p.")
    assert comparacao_percentual(0, 0.00005) == ("0%", "<0,001%", "↑ <0,001 p.p.")
    assert comparacao_percentual(0, 0.00005, True, True) == ("<0,001%", "<0,001%", "↑ <0,001 p.p.")
    assert comparacao_percentual(0, 0, False, False) == ("0%", "0%", "0 p.p.")
    assert comparacao_percentual(99.96, 99.97) == (">99,9%", ">99,9%", "↑ <0,1 p.p.")
    config = carregar_json(ARQUIVO_CONFIG)
    estado = estado_rodada(20, datetime(2026, 8, 2, 12, tzinfo=FUSO_BR), config)
    assert estado["elegivel"] and estado["jogos_concluidos"] == 10
    dossie = montar_dossie(20, estado)
    assert len(dossie["jogos"]) == 10 and len(dossie["clubes"]) == 20
    dossie_midias = json.loads(json.dumps(dossie, ensure_ascii=False))
    dossie_midias["jogos"][0]["melhores_momentos"]["titulo"] = "Título atualizado depois"
    assert hash_editorial(dossie_midias) == hash_editorial(dossie)
    assert hashlib.sha256(json.dumps(dossie_midias, ensure_ascii=False, sort_keys=True).encode()).hexdigest() != hashlib.sha256(json.dumps(dossie, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    gremio = next(c for c in dossie["clubes"] if c["clube"] == "Grêmio")
    assert gremio["titulo_possivel_antes"] and gremio["titulo_possivel_depois"]
    resultados = {j["linha"] for j in dossie["jogos"]}
    assert "Flamengo 1 × 1 São Paulo" in resultados
    assert "Palmeiras 1 × 2 Atlético-MG" in resultados
    assert "Vitória 0 × 4 Palmeiras" not in resultados
    editorial = narrativa_segura(dossie)
    validar_editorial(editorial, dossie)
    dossie_contingencia = dict(dossie, rodada=21)
    validar_editorial(narrativa_segura(dossie_contingencia), dossie_contingencia)
    pagina, meta = gerar_artigo(dossie, editorial, "2026-08-02T12:00:00-03:00", "2026-08-02T12:00:00-03:00", carregar_manifesto().get("artigos") or [])
    assert '"@type":"NewsArticle"' in pagina and f'data-{MARCADOR}="20"' in pagina and 'data-fdg-editorial-id="brasileirao-2026-rodada-20"' in pagina
    assert '<header class="hero" aria-label="Fórmula do Gol — A matemática por trás do futebol"><img src="../img/header-formula-do-gol-v2.png"' in pagina
    assert "header-formula-do-gol.png" not in pagina
    assert "br-analises.css?v=20260807-acuracia-box-v1" in pagina
    assert "br-analises.js?v=20260805-editorial-continental-v1" in pagina
    assert "Publicado em 02/08/2026" in pagina and "0,000%" not in pagina
    assert "0,007%</td><td>0,006%</td><td class=\"delta delta-down\">-0,001 p.p.</td>" in pagina
    assert re.search(
        r">Grêmio</a>\s*</th>\s*<td>22</td>\s*<td>&lt;0,001%</td><td>&lt;0,001%</td>",
        pagina,
    )
    assert "99,96%" not in pagina and "&gt;99,9%" in pagina
    assert "Padrão dos percentuais" in pagina and "analysis-round-nav" in pagina
    assert '<a href="../analises/" class="active" aria-current="page">📰 Análises</a>' in pagina
    assert pagina.index('📰 Análises') < pagina.index('🎯 Acurácia') < pagina.index('🛡️ Clubes')
    positivo = box_acuracia_rodada(20, {"jogos": {"por_rodada": [{
        "rodada": 20, "maior_probabilidade_avaliada": 10, "taxa_confirmacao_pct": 70.0,
        "previsoes_fortes_60_total": 3, "taxa_fortes_60_pct": 100.0,
    }]}})
    assert '70,0%' in positivo and 'Todas as <strong>3</strong>' in positivo and 'maiores erros' not in positivo.casefold()
    neutro = box_acuracia_rodada(20, {"jogos": {"por_rodada": [{
        "rodada": 20, "maior_probabilidade_avaliada": 10, "taxa_confirmacao_pct": 40.0,
        "previsoes_fortes_60_total": 2, "taxa_fortes_60_pct": 50.0,
    }]}})
    assert neutro == ""
    assert pagina.count('class="analysis-copy-section"') == 4
    assert "O líder caiu; o perseguidor hesitou" in pagina
    assert "A análise editorial utiliza somente um dossiê factual auditado" in pagina
    assert pagina.count('class="analysis-video"') == 10
    assert pagina.count('class="analysis-stats-toggle"') == 10
    assert pagina.count('class="analysis-game-details"') == 10
    assert "Placar e resumo" not in pagina and 'target="_blank"' not in pagina
    assert '<h3><a href="../resultados">' not in pagina
    assert meta["jogos_concluidos"] == 10
    hub = gerar_hub(carregar_manifesto().get("artigos") or [])
    assert '<header class="hero" aria-label="Fórmula do Gol — A matemática por trás do futebol"><img src="../img/header-formula-do-gol-v2.png"' in hub
    assert "header-formula-do-gol.png" not in hub
    assert '<h1 class="analysis-page-title">Análises do Fórmula do Gol</h1>' in hub
    assert "analysis-hub-head" not in hub
    assert "Publicado em 02/08/2026" in hub and "analysis-round-nav" in hub and ">ANÁLISES</strong>" in hub
    print("OK self-test: detector, fatos, percentuais, editorial e HTML.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rodada", type=int, choices=range(1, 39))
    parser.add_argument("--forcar", action="store_true", help="Gera mesmo fora da janela ou substitui conteúdo idêntico")
    parser.add_argument("--sem-ia", action="store_true", help="Compatibilidade: sem --editorial-json o editorial é sempre determinístico")
    parser.add_argument("--dry-run", action="store_true", help="Valida e mostra o resultado sem gravar arquivos")
    parser.add_argument("--editorial-json", help="Editorial já produzido por uma camada externa; não chama a OpenAI")
    parser.add_argument("--origem-editorial", default="", help="Rótulo de origem usado com --editorial-json")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    try:
        return self_test() if args.self_test else executar(args)
    except ErroAnalise as erro:
        print(f"ERRO: {erro}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
