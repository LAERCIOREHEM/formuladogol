#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
completar_publicos_ia.py

Camada de resgate para o público presente das partidas do Brasileirão.

Por que existe
--------------
O coletor determinístico (atualizar_publicos_brasileirao.py) depende da matéria
CONSOLIDADA da rodada no ge/Gato Mestre ("Veja os públicos da Nª rodada"), que
só é publicada depois que a rodada inteira termina. Enquanto isso, a reportagem
de CADA jogo já traz a ficha técnica com público e renda poucas horas após o
apito final. Este script cobre exatamente essa janela: usa a API da OpenAI com
web_search para localizar e ler a fonte por partida, e devolve o número.

Princípios (iguais aos do coletor determinístico)
-------------------------------------------------
  * só preenche lacuna; nunca sobrescreve público já existente;
  * público PRESENTE ou TOTAL; pagante nunca vira presente;
  * a URL declarada pelo modelo precisa constar nas fontes que a própria
    ferramenta web devolveu, e o domínio precisa estar na allowlist;
  * uma única requisição por execução, com teto de chamadas de ferramenta;
  * partida sem público divulgado após N tentativas é marcada como esgotada,
    o que faz o orquestrador parar de disparar o workflow em loop.

Saídas:
  - dados-br/publicos-complementares.json  (mesmo formato do coletor)
  - dados-br/jogos-detalhes.json           (propagação sem rede)
  - dados-br/estado-publicos-ia.json       (tentativas, esgotados, auditoria)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from atualizar_publicos_brasileirao import (  # noqa: E402
    numero_publico,
    numero_renda,
    propagar_publicos_para_detalhes,
)

RESULTADOS = ROOT / "resultados.json"
DETALHES = ROOT / "dados-br" / "jogos-detalhes.json"
COMPLEMENTOS = ROOT / "dados-br" / "publicos-complementares.json"
ESTADO = ROOT / "dados-br" / "estado-publicos-ia.json"

FUSO_BRASILIA = timezone(timedelta(hours=-3))
OPENAI_URL = "https://api.openai.com/v1/responses"
DEFAULT_MODEL = "gpt-5.6-terra"

# Público e renda são ficha técnica, não interpretação editorial. Quem publica
# primeiro é a imprensa regional e os portais dos clubes — e a allowlist curta
# da auditoria diária deixava tudo isso de fora, cegando a busca para matérias
# que qualquer pessoa acha no Google em dez segundos. A proteção real não é o
# domínio: é a validação determinística mais abaixo (URL precisa constar entre
# as páginas efetivamente lidas, faixa de sanidade, confiança mínima, pagante
# nunca vira presente, nunca sobrescreve valor existente).
ALLOWED_WEB_DOMAINS = (
    # oficiais e agências
    "cbf.com.br",
    "ge.globo.com",
    "globoesporte.globo.com",
    "sportv.globo.com",
    "oglobo.globo.com",
    "espn.com.br",
    "uol.com.br",
    "folha.uol.com.br",
    "band.uol.com.br",
    "lance.com.br",
    "gazetaesportiva.com",
    "terra.com.br",
    "r7.com",
    "estadao.com.br",
    "metropoles.com",
    "cnnbrasil.com.br",
    # imprensa regional: costuma publicar a ficha técnica primeiro
    "bahianoticias.com.br",
    "itatiaia.com.br",
    "otempo.com.br",
    "em.com.br",
    "gauchazh.clicrbs.com.br",
    "nsctotal.com.br",
    "diariodonordeste.verdesmares.com.br",
    "opovo.com.br",
    "correiobraziliense.com.br",
    "gp1.com.br",
    "oliberal.com",
    "acritica.com",
    # portais oficiais dos clubes
    "santosfc.com.br",
    "palmeiras.com.br",
    "flamengo.com.br",
    "corinthians.com.br",
    "saopaulofc.net",
    "fluminense.com.br",
    "vasco.com.br",
    "botafogo.com.br",
    "cruzeiro.com.br",
    "atletico.com.br",
    "internacional.com.br",
    "gremio.net",
    "esporteclubebahia.com.br",
    "ecvitoria.com.br",
    "athleticoparanaense.com",
    "coritiba.com.br",
    "chapecoense.com",
    "redbullbragantino.com.br",
    "mirassolfc.com.br",
    "remo.com.br",
)

MIN_CONFIANCA = 0.90
MAX_PUBLICO = 250_000
GRACE_HORAS_PADRAO = 2.0
MAX_TENTATIVAS_PADRAO = 8
MAX_JOGOS_PADRAO = 10


class PublicoIAError(RuntimeError):
    pass


# --------------------------------------------------------------------------- #
# utilidades locais
# --------------------------------------------------------------------------- #
def agora_brt() -> datetime:
    return datetime.now(FUSO_BRASILIA).replace(microsecond=0)


def carregar_json(path: Path, padrao: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return json.loads(json.dumps(padrao))


def salvar_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def normalizar_url(valor: Any) -> str:
    try:
        parsed = urllib.parse.urlsplit(str(valor or "").strip())
    except ValueError:
        return ""
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    host = parsed.netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    caminho = parsed.path.rstrip("/") or "/"
    return f"https://{host}{caminho}"


def dominio_permitido(url: str) -> bool:
    try:
        host = urllib.parse.urlsplit(url).netloc.lower()
    except ValueError:
        return False
    if host.startswith("www."):
        host = host[4:]
    return any(host == d or host.endswith("." + d) for d in ALLOWED_WEB_DOMAINS)


def parse_dt(valor: Any) -> datetime | None:
    texto = str(valor or "").strip()
    if not texto:
        return None
    try:
        dt = datetime.fromisoformat(texto.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=FUSO_BRASILIA)
    return dt.astimezone(FUSO_BRASILIA)


def nome_time(valor: Any) -> str:
    if isinstance(valor, Mapping):
        return str(valor.get("nome") or valor.get("sigla") or "").strip()
    return str(valor or "").strip()


# --------------------------------------------------------------------------- #
# seleção das pendências
# --------------------------------------------------------------------------- #
def pendencias(
    *,
    grace_horas: float,
    max_tentativas: int,
    max_jogos: int,
    agora: datetime,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    resultados = carregar_json(RESULTADOS, {})
    linhas = resultados.get("resultados") if isinstance(resultados, Mapping) else []
    detalhes = carregar_json(DETALHES, {})
    jogos_det = detalhes.get("jogos") if isinstance(detalhes, Mapping) else {}
    comp = carregar_json(COMPLEMENTOS, {})
    jogos_comp = comp.get("jogos") if isinstance(comp, Mapping) else {}
    estado = carregar_json(ESTADO, {})
    tentativas = estado.get("jogos") if isinstance(estado, Mapping) else {}
    if not isinstance(tentativas, dict):
        tentativas = {}

    pendentes: list[dict[str, Any]] = []
    for bruto in linhas or []:
        if not isinstance(bruto, Mapping):
            continue
        event_id = str(bruto.get("event_id") or bruto.get("id") or "").strip()
        if not event_id:
            continue
        det = jogos_det.get(event_id) if isinstance(jogos_det, Mapping) else None
        cmp_ = jogos_comp.get(event_id) if isinstance(jogos_comp, Mapping) else None
        if not isinstance(det, Mapping) or det.get("placar_mandante") is None:
            continue
        # Público e renda são lacunas INDEPENDENTES. Antes, assim que o público
        # entrava a partida saía da fila para sempre e a renda nunca era
        # buscada de novo — foi assim que Grêmio x Chapecoense ficou pela
        # metade. Agora a partida permanece elegível enquanto faltar qualquer
        # um dos dois, e o dossiê diz ao modelo exatamente o que procurar.
        tem_publico = (
            numero_publico(det.get("publico")) is not None
            or numero_publico((cmp_ or {}).get("publico")) is not None
        )
        tem_renda = (
            numero_renda(det.get("renda")) is not None
            or numero_renda((cmp_ or {}).get("renda")) is not None
        )
        faltando = [campo for campo, presente in (("publico", tem_publico), ("renda", tem_renda)) if not presente]
        if not faltando:
            continue
        estado_jogo = tentativas.get(event_id) if isinstance(tentativas.get(event_id), Mapping) else {}
        if estado_jogo.get("esgotado") is True:
            continue
        if int(estado_jogo.get("tentativas") or 0) >= max_tentativas:
            continue
        inicio = parse_dt(det.get("data_iso")) or parse_dt(bruto.get("data_iso"))
        if inicio is None:
            continue
        horas = (agora - inicio).total_seconds() / 3600.0
        if horas < grace_horas:
            continue
        pendentes.append({
            "event_id": event_id,
            "rodada": int(det.get("rodada") or bruto.get("rodada") or 0),
            "data_iso": str(det.get("data_iso") or ""),
            "mandante": nome_time(det.get("mandante") or bruto.get("mandante")),
            "visitante": nome_time(det.get("visitante") or bruto.get("visitante")),
            "estadio": str(det.get("estadio") or ""),
            "placar": f"{det.get('placar_mandante')}x{det.get('placar_visitante')}",
            "horas_desde_inicio": round(horas, 1),
            "tentativas_anteriores": int(estado_jogo.get("tentativas") or 0),
            "faltando": faltando,
        })

    pendentes.sort(key=lambda item: item["data_iso"], reverse=True)
    return pendentes[: max(1, int(max_jogos))], estado


# --------------------------------------------------------------------------- #
# camada OpenAI
# --------------------------------------------------------------------------- #
def schema_resposta() -> dict[str, Any]:
    item = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "event_id": {"type": "string", "minLength": 1, "maxLength": 40},
            "encontrado": {"type": "boolean"},
            "publico": {"anyOf": [{"type": "integer", "minimum": 100, "maximum": MAX_PUBLICO}, {"type": "null"}]},
            "tipo": {"type": "string", "enum": ["presente", "total", "indefinido"]},
            "pagantes": {"anyOf": [{"type": "integer", "minimum": 1, "maximum": MAX_PUBLICO}, {"type": "null"}]},
            "renda": {"anyOf": [{"type": "number", "minimum": 0}, {"type": "null"}]},
            "fonte_url": {"type": "string", "maxLength": 1200},
            "fonte_url_renda": {"type": "string", "maxLength": 1200},
            "confianca": {"type": "number", "minimum": 0, "maximum": 1},
            "justificativa": {"type": "string", "minLength": 3, "maxLength": 400},
        },
        "required": [
            "event_id", "encontrado", "publico", "tipo",
            "pagantes", "renda", "fonte_url", "fonte_url_renda", "confianca", "justificativa",
        ],
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {"jogos": {"type": "array", "items": item, "maxItems": 20}},
        "required": ["jogos"],
    }


def montar_payload(pendentes: Sequence[Mapping[str, Any]], model: str, max_tool_calls: int) -> dict[str, Any]:
    instrucao = (
        "Você localiza PÚBLICO e RENDA de partidas do Campeonato Brasileiro Série A já encerradas. "
        "O campo 'faltando' de cada partida diz exatamente o que está em falta: busque TODOS os itens "
        "listados ali, não apenas o primeiro. Público e renda têm o mesmo peso. "
        "Se a primeira página trouxer só um dos dois, faça uma NOVA busca para o outro — a renda costuma "
        "aparecer na ficha técnica sob rótulos como 'Renda', 'Renda bruta' ou 'Borderô', muitas vezes numa "
        "matéria diferente daquela que traz o público. Quando a renda vier de outra página, informe a URL "
        "dela em 'fonte_url_renda'; quando vier da mesma, repita a URL. "
        "Para CADA partida, busque a reportagem do jogo ou a ficha técnica em fontes esportivas "
        "reconhecidas. Regras inegociáveis: "
        "(1) informe como 'presente' apenas o público presente/total declarado pela fonte; "
        "(2) NUNCA converta público pagante em presente — se a fonte só traz pagantes, preencha 'pagantes' "
        "e deixe 'publico' nulo com tipo 'indefinido'; "
        "(3) fonte_url deve ser a URL exata da página que você efetivamente leu e que declara o número; "
        "(4) se não encontrar algum número, devolva-o como nulo — não estime, não interpole, não use "
        "capacidade do estádio, preço médio de ingresso nem média histórica; devolver público sem renda "
        "é aceitável, mas só depois de procurar a renda de verdade em mais de uma fonte; "
        "(5) confianca reflete a certeza de que o número pertence àquela partida específica "
        "(confira mandante, visitante, data e placar antes de responder). "
        "Responda exatamente no JSON Schema, uma entrada por event_id recebido."
    )
    dossie = {
        "competicao": "Campeonato Brasileiro Série A 2026",
        "instrucao_busca": "Procure a ficha técnica da partida (público e renda) em reportagens pós-jogo.",
        "partidas": list(pendentes),
    }
    return {
        "model": model,
        "store": False,
        "reasoning": {"effort": "low"},
        "input": [
            {"role": "developer", "content": instrucao},
            {"role": "user", "content": "Partidas sem público:\n" + json.dumps(dossie, ensure_ascii=False, separators=(",", ":"))},
        ],
        "max_output_tokens": 4000,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "publicos_brasileirao",
                "strict": True,
                "schema": schema_resposta(),
            }
        },
        "tools": [{
            "type": "web_search",
            "search_context_size": "medium",
            "filters": {"allowed_domains": list(ALLOWED_WEB_DOMAINS)},
        }],
        "tool_choice": "auto",
        "max_tool_calls": int(max_tool_calls),
        "include": ["web_search_call.action.sources"],
    }


def extrair_texto(resposta: Mapping[str, Any]) -> str:
    partes: list[str] = []
    for item in resposta.get("output") or []:
        if not isinstance(item, Mapping):
            continue
        for bloco in item.get("content") or []:
            if isinstance(bloco, Mapping) and bloco.get("type") == "output_text" and bloco.get("text"):
                partes.append(str(bloco["text"]))
    return "".join(partes)


def coletar_fontes(resposta: Mapping[str, Any]) -> set[str]:
    urls: set[str] = set()
    for item in resposta.get("output") or []:
        if not isinstance(item, Mapping):
            continue
        if item.get("type") == "web_search_call":
            acao = item.get("action") or {}
            if isinstance(acao, Mapping):
                for fonte in acao.get("sources") or []:
                    if isinstance(fonte, Mapping):
                        alvo = normalizar_url(fonte.get("url"))
                        if alvo:
                            urls.add(alvo)
        for bloco in item.get("content") or []:
            if not isinstance(bloco, Mapping):
                continue
            for anotacao in bloco.get("annotations") or []:
                if not isinstance(anotacao, Mapping):
                    continue
                candidato = anotacao.get("url")
                if not candidato and isinstance(anotacao.get("url_citation"), Mapping):
                    candidato = anotacao["url_citation"].get("url")
                alvo = normalizar_url(candidato)
                if alvo:
                    urls.add(alvo)
    return urls


def chamar_openai(payload: Mapping[str, Any], api_key: str, timeout: int = 210) -> dict[str, Any]:
    req = urllib.request.Request(
        OPENAI_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as bruto:
            resposta = json.loads(bruto.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detalhe = exc.read().decode("utf-8", errors="replace")[:600]
        raise PublicoIAError(f"OpenAI HTTP {exc.code}: {detalhe}") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise PublicoIAError(f"Falha na chamada OpenAI: {exc}") from exc
    if not isinstance(resposta, dict):
        raise PublicoIAError("OpenAI não devolveu objeto JSON")
    if resposta.get("status") == "incomplete":
        raise PublicoIAError(f"Resposta incompleta: {resposta.get('incomplete_details') or 'sem detalhe'}")
    texto = extrair_texto(resposta)
    if not texto:
        raise PublicoIAError("OpenAI não devolveu output_text")
    try:
        resposta["_parsed"] = json.loads(texto)
    except json.JSONDecodeError as exc:
        raise PublicoIAError("output_text não é JSON válido") from exc
    return resposta


# --------------------------------------------------------------------------- #
# validação determinística
# --------------------------------------------------------------------------- #
def validar(
    propostas: Sequence[Mapping[str, Any]],
    pendentes: Sequence[Mapping[str, Any]],
    fontes_web: set[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    por_id = {str(p["event_id"]): p for p in pendentes}
    aceitos: list[dict[str, Any]] = []
    rejeitados: list[dict[str, Any]] = []

    for bruto in propostas or []:
        if not isinstance(bruto, Mapping):
            continue
        item = dict(bruto)
        event_id = str(item.get("event_id") or "")
        motivos: list[str] = []

        if event_id not in por_id:
            rejeitados.append({"event_id": event_id, "motivos": ["event_id fora da lista de pendências"]})
            continue
        if item.get("encontrado") is not True:
            rejeitados.append({"event_id": event_id, "motivos": ["modelo declarou que não encontrou"], "nao_e_erro": True})
            continue

        faltando = set(por_id[event_id].get("faltando") or ["publico", "renda"])
        publico = numero_publico(item.get("publico"))
        renda_bruta = numero_renda(item.get("renda"))
        # Quando só a renda está em falta, exigir público seria descartar a
        # resposta útil e deixar a partida pela metade para sempre.
        if "publico" in faltando:
            if publico is None:
                motivos.append("público ausente ou fora da faixa de sanidade")
            if item.get("tipo") not in {"presente", "total"}:
                motivos.append("tipo não é presente/total")
        elif publico is None and renda_bruta is None:
            motivos.append("nada aproveitável: renda continua ausente")

        try:
            confianca = float(item.get("confianca") or 0)
        except (TypeError, ValueError):
            confianca = 0.0
        if confianca < MIN_CONFIANCA:
            motivos.append(f"confiança {confianca:.2f} abaixo de {MIN_CONFIANCA:.2f}")

        def checar_fonte(url_bruta: Any, rotulo: str) -> str:
            alvo = normalizar_url(url_bruta)
            if not alvo:
                motivos.append(f"{rotulo} inválida")
            elif not dominio_permitido(alvo):
                motivos.append(f"{rotulo}: domínio fora da allowlist")
            elif alvo not in fontes_web:
                motivos.append(f"{rotulo} não consta entre as páginas efetivamente lidas pela busca")
            else:
                return alvo
            return ""

        fonte = checar_fonte(item.get("fonte_url"), "fonte_url") if publico is not None else ""
        if publico is None and "publico" not in faltando:
            # Só a renda estava faltando: a fonte principal não é exigida.
            motivos = [m for m in motivos if not m.startswith("fonte_url")]

        pagantes = numero_publico(item.get("pagantes"))
        if pagantes is not None and publico is not None and pagantes > publico:
            motivos.append("pagantes maior que público presente")
            pagantes = None

        renda = renda_bruta
        fonte_renda = ""
        if renda is not None:
            bruta_renda = item.get("fonte_url_renda") or item.get("fonte_url")
            fonte_renda = checar_fonte(bruta_renda, "fonte_url_renda")
            if not fonte_renda:
                # Renda sem fonte verificável é descartada, mas não invalida o
                # público, que tem fonte própria já checada acima.
                motivos = [m for m in motivos if not m.startswith("fonte_url_renda")]
                renda = None

        if motivos:
            rejeitados.append({"event_id": event_id, "motivos": motivos, "proposta": item})
            continue

        registro: dict[str, Any] = {
            "origem": "openai:web_search",
            "fonte_adicional": "Camada de IA sobre reportagem do jogo",
            "confianca": round(confianca, 3),
        }
        if publico is not None:
            registro["tipo"] = str(item.get("tipo"))
            registro["fonte"] = fonte
            registro["publico_status"] = "divulgado"
            registro["publico"] = publico
        if pagantes is not None:
            registro["pagantes"] = pagantes
            registro["pagantes_status"] = "divulgado"
        if renda is not None:
            registro["renda"] = renda
            registro["renda_status"] = "divulgado"
            registro["fonte_renda"] = fonte_renda or fonte
        if not registro.get("fonte"):
            registro["fonte"] = fonte or fonte_renda
        aceitos.append({"event_id": event_id, "registro": registro, "justificativa": str(item.get("justificativa") or "")})

    return aceitos, rejeitados


# --------------------------------------------------------------------------- #
# gravação
# --------------------------------------------------------------------------- #
def aplicar(aceitos: Sequence[Mapping[str, Any]]) -> int:
    if not aceitos:
        return 0
    comp = carregar_json(COMPLEMENTOS, {"jogos": {}})
    jogos = comp.get("jogos") if isinstance(comp.get("jogos"), dict) else {}
    gravados = 0
    for item in aceitos:
        event_id = str(item["event_id"])
        atual = dict(jogos.get(event_id) or {}) if isinstance(jogos.get(event_id), Mapping) else {}
        novo_reg = dict(item["registro"])
        # Complementa campo a campo: jamais sobrescreve um valor já existente,
        # mas preenche o que falta. É o que permite a renda chegar depois do
        # público, numa execução seguinte, sem apagar nada.
        mudou = False
        for chave, valor in novo_reg.items():
            if chave in {"publico", "renda", "pagantes"}:
                if atual.get(chave) not in (None, "", 0):
                    continue
            elif atual.get(chave) not in (None, ""):
                if chave not in {"confianca", "origem", "fonte_adicional"}:
                    continue
            atual[chave] = valor
            mudou = True
        if mudou:
            jogos[event_id] = atual
            gravados += 1
    if not gravados:
        return 0
    comp["jogos"] = jogos
    comp["atualizado_em"] = agora_brt().isoformat()
    salvar_json(COMPLEMENTOS, comp)

    detalhes = carregar_json(DETALHES, {})
    novo, alteracoes, _ = propagar_publicos_para_detalhes(detalhes, comp)
    if alteracoes:
        salvar_json(DETALHES, novo)
    return gravados


def atualizar_estado(
    estado: dict[str, Any],
    pendentes: Sequence[Mapping[str, Any]],
    aceitos: Sequence[Mapping[str, Any]],
    rejeitados: Sequence[Mapping[str, Any]],
    max_tentativas: int,
    erro: str,
    agora: datetime,
) -> dict[str, Any]:
    jogos = estado.get("jogos") if isinstance(estado.get("jogos"), dict) else {}
    resolvidos = {str(a["event_id"]) for a in aceitos}
    for p in pendentes:
        event_id = str(p["event_id"])
        if event_id in resolvidos:
            jogos.pop(event_id, None)
            continue
        anterior = jogos.get(event_id) if isinstance(jogos.get(event_id), Mapping) else {}
        tentativas = int(anterior.get("tentativas") or 0) + 1
        registro = {
            "tentativas": tentativas,
            "ultima_tentativa": agora.isoformat(),
            "rodada": p.get("rodada"),
            "partida": f"{p.get('mandante')} x {p.get('visitante')}",
            "esgotado": tentativas >= max_tentativas,
        }
        if registro["esgotado"]:
            registro["motivo"] = "público não divulgado por nenhuma fonte permitida após o limite de tentativas"
        jogos[event_id] = registro
    estado["jogos"] = jogos
    estado["gerado_em"] = agora.isoformat()
    estado["ultima_execucao"] = {
        "pendentes_avaliados": len(pendentes),
        "aceitos": len(aceitos),
        "rejeitados": len([r for r in rejeitados if not r.get("nao_e_erro")]),
        "nao_encontrados": len([r for r in rejeitados if r.get("nao_e_erro")]),
        "erro": erro,
    }
    estado["esgotados"] = sorted(k for k, v in jogos.items() if isinstance(v, Mapping) and v.get("esgotado"))
    return estado


# --------------------------------------------------------------------------- #
# self-test
# --------------------------------------------------------------------------- #
def self_test() -> int:
    # As URLs de fontes_web chegam normalizadas por coletar_fontes(); o teste
    # precisa usar a mesma forma, senão compara maçã com laranja.
    fontes = {normalizar_url("https://ge.globo.com/futebol/times/fluminense/noticia/2026/08/22/exemplo.ghtml")}
    pend = [{"event_id": "1", "rodada": 24, "data_iso": "2026-08-22T16:00",
             "mandante": "Fluminense", "visitante": "Remo", "estadio": "Maracanã",
             "placar": "2x0", "horas_desde_inicio": 14.0, "tentativas_anteriores": 0,
             "faltando": ["publico", "renda"]}]
    URL = normalizar_url("https://ge.globo.com/futebol/times/fluminense/noticia/2026/08/22/exemplo.ghtml")

    ok = [{"event_id": "1", "encontrado": True, "publico": 41234, "tipo": "presente",
           "pagantes": 38000, "renda": 2100000.0,
           "fonte_url": URL, "fonte_url_renda": URL,
           "confianca": 0.97, "justificativa": "ficha técnica da partida"}]
    aceitos, rejeitados = validar(ok, pend, fontes)
    assert len(aceitos) == 1 and not rejeitados, (aceitos, rejeitados)
    assert aceitos[0]["registro"]["publico"] == 41234
    assert aceitos[0]["registro"]["pagantes"] == 38000

    fora = [dict(ok[0], fonte_url="https://exemplo-aleatorio.com/x", fonte_url_renda="https://exemplo-aleatorio.com/x")]
    _, rej = validar(fora, pend, fontes)
    assert rej and any("allowlist" in m for m in rej[0]["motivos"]), rej

    nao_lida = [dict(ok[0], fonte_url="https://ge.globo.com/outra/materia.ghtml",
                     fonte_url_renda="https://ge.globo.com/outra/materia.ghtml")]
    _, rej = validar(nao_lida, pend, fontes)
    assert rej and any("efetivamente lidas" in m for m in rej[0]["motivos"])

    # Renda de OUTRA página, também lida pela busca: aceita as duas fontes.
    URL2 = normalizar_url("https://www.uol.com.br/esporte/2026/08/30/ficha.htm")
    duas = [dict(ok[0], fonte_url_renda=URL2)]
    ac, rej = validar(duas, pend, fontes | {URL2})
    assert len(ac) == 1 and not rej, (ac, rej)
    assert ac[0]["registro"]["fonte_renda"] == URL2

    # Renda com fonte não lida: descarta SÓ a renda, preserva o público.
    renda_ruim = [dict(ok[0], fonte_url_renda="https://ge.globo.com/inventada.ghtml")]
    ac, rej = validar(renda_ruim, pend, fontes)
    assert len(ac) == 1 and not rej, (ac, rej)
    assert ac[0]["registro"]["publico"] == 41234
    assert "renda" not in ac[0]["registro"], "renda sem fonte verificável não pode entrar"

    # Partida onde SÓ a renda falta: resposta sem público continua aproveitável.
    so_renda_pend = [dict(pend[0], faltando=["renda"])]
    so_renda = [{"event_id": "1", "encontrado": True, "publico": None, "tipo": "indefinido",
                 "pagantes": None, "renda": 1850000.0,
                 "fonte_url": "", "fonte_url_renda": URL2,
                 "confianca": 0.95, "justificativa": "ficha técnica traz apenas a renda"}]
    ac, rej = validar(so_renda, so_renda_pend, fontes | {URL2})
    assert len(ac) == 1 and not rej, (ac, rej)
    assert ac[0]["registro"]["renda"] == 1850000.0
    assert "publico" not in ac[0]["registro"]

    baixa = [dict(ok[0], confianca=0.5)]
    _, rej = validar(baixa, pend, fontes)
    assert rej and any("confiança" in m for m in rej[0]["motivos"])

    so_pagante = [dict(ok[0], publico=None, tipo="indefinido")]
    _, rej = validar(so_pagante, pend, fontes)
    assert rej and any("público ausente" in m for m in rej[0]["motivos"])

    invertido = [dict(ok[0], publico=30000, pagantes=38000)]
    _, rej = validar(invertido, pend, fontes)
    assert rej and any("pagantes maior" in m for m in rej[0]["motivos"])

    nada = [dict(ok[0], encontrado=False, publico=None)]
    ac, rej = validar(nada, pend, fontes)
    assert not ac and rej[0].get("nao_e_erro") is True

    agora = datetime(2026, 8, 23, 12, 0, tzinfo=FUSO_BRASILIA)
    estado: dict[str, Any] = {}
    for _ in range(3):
        estado = atualizar_estado(estado, pend, [], [], max_tentativas=3, erro="", agora=agora)
    assert estado["jogos"]["1"]["tentativas"] == 3
    assert estado["jogos"]["1"]["esgotado"] is True
    assert estado["esgotados"] == ["1"]

    estado = atualizar_estado(estado, pend, [{"event_id": "1"}], [], max_tentativas=3, erro="", agora=agora)
    assert "1" not in estado["jogos"], "jogo resolvido deve sair do estado de tentativas"

    payload = montar_payload(pend, DEFAULT_MODEL, 4)
    assert payload["tools"][0]["filters"]["allowed_domains"] == list(ALLOWED_WEB_DOMAINS)
    assert payload["text"]["format"]["strict"] is True
    assert payload["max_tool_calls"] == 4

    # Estado tem de sobreviver mesmo quando não há chave nem pendência: é o único
    # rastro auditável de que a camada rodou.
    vazio = atualizar_estado({}, [], [], [], max_tentativas=8, erro="OPENAI_API_KEY ausente", agora=agora)
    assert vazio["ultima_execucao"]["erro"] == "OPENAI_API_KEY ausente"
    assert vazio["gerado_em"] == agora.isoformat()

    print("Self-test completar_publicos_ia: OK")
    return 0


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main() -> int:
    parser = argparse.ArgumentParser(description="Completa público das partidas usando a camada de IA com busca web.")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="Consulta e valida, mas não grava artefatos.")
    parser.add_argument("--grace-horas", type=float, default=GRACE_HORAS_PADRAO)
    parser.add_argument("--max-tentativas", type=int, default=MAX_TENTATIVAS_PADRAO)
    parser.add_argument("--max-jogos", type=int, default=MAX_JOGOS_PADRAO)
    parser.add_argument(
        "--reabrir-esgotados",
        action="store_true",
        help=(
            "Zera o marcador de esgotado e o contador de tentativas. Use quando a causa "
            "das falhas anteriores foi corrigida (por exemplo, ampliação da allowlist de "
            "fontes): sem isto, jogos abandonados por um defeito antigo nunca voltam a ser tentados."
        ),
    )
    args = parser.parse_args()

    if args.self_test:
        return self_test()

    agora = agora_brt()

    if args.reabrir_esgotados and not args.dry_run:
        estado_atual = carregar_json(ESTADO, {})
        jogos_estado = estado_atual.get("jogos") if isinstance(estado_atual.get("jogos"), dict) else {}
        reabertos = [k for k, v in jogos_estado.items() if isinstance(v, Mapping) and v.get("esgotado")]
        if reabertos or jogos_estado:
            estado_atual["jogos"] = {}
            estado_atual["esgotados"] = []
            estado_atual["reaberto_em"] = agora.isoformat()
            salvar_json(ESTADO, estado_atual)
            print(f"Reabertos {len(reabertos)} jogo(s) esgotado(s); contadores zerados.")

    pendentes, estado = pendencias(
        grace_horas=args.grace_horas,
        max_tentativas=args.max_tentativas,
        max_jogos=args.max_jogos,
        agora=agora,
    )

    def encerrar(motivo: str, *, contar_tentativa: bool) -> int:
        """Sempre deixa rastro em disco: sem isto não há como auditar a camada."""
        if args.dry_run:
            print(f"[dry-run] {motivo}")
            print("novos=false")
            return 0
        if contar_tentativa:
            novo_estado = atualizar_estado(estado, pendentes, [], [], args.max_tentativas, motivo, agora)
        else:
            novo_estado = dict(estado)
            novo_estado.setdefault("jogos", estado.get("jogos") or {})
            novo_estado["gerado_em"] = agora.isoformat()
            novo_estado["ultima_execucao"] = {
                "pendentes_avaliados": len(pendentes),
                "aceitos": 0,
                "rejeitados": 0,
                "nao_encontrados": 0,
                "erro": motivo,
            }
            novo_estado["esgotados"] = sorted(
                k for k, v in (novo_estado.get("jogos") or {}).items()
                if isinstance(v, Mapping) and v.get("esgotado")
            )
        salvar_json(ESTADO, novo_estado)
        print(motivo)
        print("novos=false")
        return 0

    if not pendentes:
        # "Nenhuma elegível" é ambíguo e já escondeu um defeito: pode ser que
        # nada esteja faltando, ou que tudo tenha sido marcado como esgotado.
        # O log precisa dizer qual dos dois.
        jogos_estado = estado.get("jogos") if isinstance(estado.get("jogos"), dict) else {}
        esgotados = [k for k, v in jogos_estado.items() if isinstance(v, Mapping) and v.get("esgotado")]
        if esgotados:
            print(f"::warning::{len(esgotados)} partida(s) marcada(s) como esgotada(s) e fora da fila: "
                  f"{', '.join(sorted(esgotados)[:6])}. Se a causa das falhas foi corrigida, "
                  f"rode com --reabrir-esgotados.")
            return encerrar(
                f"Nenhuma partida elegível: {len(esgotados)} esgotada(s), o resto já tem público.",
                contar_tentativa=False,
            )
        return encerrar("Nenhuma partida elegível: todas as partidas finalizadas já têm público.",
                        contar_tentativa=False)

    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        print("ERRO DE CONFIGURAÇÃO: OPENAI_API_KEY não chegou ao runner.", file=sys.stderr)
        print("Verifique Settings > Secrets and variables > Actions > Repository secrets.", file=sys.stderr)
        # Falha de configuração não consome tentativa: a partida continua elegível.
        return encerrar("OPENAI_API_KEY ausente no ambiente do workflow", contar_tentativa=False)

    model = os.environ.get("OPENAI_PUBLICOS_MODEL", os.environ.get("OPENAI_MODEL", DEFAULT_MODEL)).strip() or DEFAULT_MODEL
    max_tool_calls = min(20, max(4, len(pendentes) * 4))

    print(f"Consultando {len(pendentes)} partida(s) sem público (modelo {model}, até {max_tool_calls} buscas).")
    for p in pendentes:
        print(f"  - {p['event_id']} R{p['rodada']} {p['mandante']} x {p['visitante']} ({p['horas_desde_inicio']}h)")

    erro = ""
    aceitos: list[dict[str, Any]] = []
    rejeitados: list[dict[str, Any]] = []
    try:
        resposta = chamar_openai(montar_payload(pendentes, model, max_tool_calls), api_key)
        fontes_web = coletar_fontes(resposta)
        propostas = (resposta.get("_parsed") or {}).get("jogos") or []
        aceitos, rejeitados = validar(propostas, pendentes, fontes_web)
    except PublicoIAError as exc:
        erro = str(exc)[:500]
        print(f"Camada de IA falhou: {erro}", file=sys.stderr)

    gravados = 0
    if aceitos and not args.dry_run:
        gravados = aplicar(aceitos)

    for item in aceitos:
        print(f"  ACEITO  {item['event_id']}: {item['registro']['publico']} ({item['registro']['tipo']}) — {item['registro']['fonte']}")
    for item in rejeitados:
        rotulo = "sem fonte" if item.get("nao_e_erro") else "REJEITADO"
        print(f"  {rotulo} {item.get('event_id')}: {'; '.join(item.get('motivos') or [])}")

    if not args.dry_run:
        estado = atualizar_estado(estado, pendentes, aceitos, rejeitados, args.max_tentativas, erro, agora)
        salvar_json(ESTADO, estado)

    print(f"novos={'true' if gravados else 'false'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
