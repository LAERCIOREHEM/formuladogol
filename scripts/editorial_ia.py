#!/usr/bin/env python3
"""Camada dedicada de redação editorial com OpenAI.

Princípios:
- só é chamada depois que o gerador determinístico confirmou que há matéria elegível;
- recebe um dossiê factual fechado e não pesquisa a web;
- devolve somente JSON estruturado;
- nunca altera placares, probabilidades ou qualquer cálculo do projeto;
- se a API falhar, o gerador chamador pode usar seu fallback determinístico.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, Mapping

DEFAULT_MODEL = "gpt-5.6-sol"
DEFAULT_REASONING = "high"
DEFAULT_MAX_OUTPUT_TOKENS = 9000
OPENAI_URL = "https://api.openai.com/v1/responses"


class EditorialAIError(RuntimeError):
    pass


def _extract_output_text(response: Mapping[str, Any]) -> str:
    chunks: list[str] = []
    for item in response.get("output") or []:
        if not isinstance(item, Mapping):
            continue
        for part in item.get("content") or []:
            if isinstance(part, Mapping) and part.get("type") == "output_text" and part.get("text"):
                chunks.append(str(part["text"]))
    return "".join(chunks).strip()


def _base_instruction() -> str:
    return (
        "Você é o editor-chefe esportivo do Fórmula do Gol. Escreva como um jornalista esportivo brasileiro experiente, "
        "com domínio de manchetes, SEO, marketing editorial e leitura de probabilidades. O objetivo é transformar um fechamento "
        "esportivo já auditado em uma matéria que tenha notícia, hierarquia, consequência e chamariz, sem sensacionalismo vazio. "
        "Use SOMENTE fatos e números presentes no dossiê. Não invente jogadores, autores de gols, declarações, ambiente de estádio, "
        "desempenho tático, causas ou chaveamentos que o dossiê não informe. Números são bem-vindos: placares, agregados, percentuais "
        "e variações devem aparecer quando forem jornalisticamente relevantes. Abra pelo fato mais forte, não por metodologia. "
        "A metodologia e a auditabilidade pertencem ao rodapé da página e não devem dominar a redação. Evite linguagem de relatório, "
        "frases burocráticas como 'o quadro ficou definido', clichês vazios, autoelogio do modelo e explicações sobre o próprio processo de IA. "
        "A manchete deve nomear clubes e o acontecimento central sempre que possível. A linha fina deve acrescentar consequência, não repetir o título. "
        "Priorize: fato novo -> protagonistas -> consequência esportiva -> probabilidades -> próximo objetivo. "
        "Entregue exclusivamente o JSON compatível com o schema solicitado."
    )


def _specific_instruction(kind: str) -> str:
    if kind == "copa_do_brasil":
        return (
            "Para Copa do Brasil: trate o último confronto encerrado como gancho quando ele completar a fase; apresente todos os classificados logo no início; "
            "use os placares agregados relevantes; conecte explicitamente a classificação às probabilidades de Libertadores. Se o dossiê trouxer uma regra "
            "de qualificação continental, explique-a com precisão. Em semifinal, diga 'avançar à final' ou 'vencer o confronto da semifinal', nunca 'vencer o próximo jogo' "
            "quando a fase for de ida e volta. Dê destaque aos maiores saltos e quedas de probabilidade sem confundir chance total de Libertadores com a via Copa do Brasil."
        )
    if kind == "brasileirao":
        return (
            "Para Brasileirão: a manchete deve refletir o principal acontecimento da rodada e, preferencialmente, nomear os clubes envolvidos. "
            "Cruze resultados com as maiores mudanças de título, Libertadores e rebaixamento. Use posição, pontos e percentuais quando ajudarem a explicar a notícia. "
            "Não faça uma seção para cada métrica por obrigação; construa uma narrativa de rodada."
        )
    if kind == "continentais":
        return (
            "Para Libertadores/Sul-Americana: destaque quem avançou e quem caiu, use agregados e decisões por pênaltis quando constarem no dossiê, e conecte o resultado "
            "ao impacto nas probabilidades dos clubes brasileiros. Não espere nem mencione jogos exclusivamente estrangeiros como lacuna se o dossiê disser que o recorte brasileiro encerrou."
        )
    raise EditorialAIError(f"tipo editorial desconhecido: {kind}")


def build_payload(kind: str, dossier: Mapping[str, Any], schema: Mapping[str, Any], model: str | None = None) -> dict[str, Any]:
    selected_model = (model or os.environ.get("OPENAI_EDITORIAL_MODEL") or os.environ.get("OPENAI_MODEL") or DEFAULT_MODEL).strip()
    reasoning = (os.environ.get("OPENAI_EDITORIAL_REASONING") or DEFAULT_REASONING).strip()
    try:
        max_tokens = int(os.environ.get("OPENAI_EDITORIAL_MAX_TOKENS") or DEFAULT_MAX_OUTPUT_TOKENS)
    except ValueError:
        max_tokens = DEFAULT_MAX_OUTPUT_TOKENS
    instruction = _base_instruction() + "\n\n" + _specific_instruction(kind)
    return {
        "model": selected_model,
        "store": False,
        "reasoning": {"effort": reasoning},
        "input": [
            {"role": "developer", "content": instruction},
            {
                "role": "user",
                "content": (
                    "Dossiê factual auditado. Todo número utilizável está aqui; não complete lacunas por memória:\n"
                    + json.dumps(dossier, ensure_ascii=False, separators=(",", ":"))
                ),
            },
        ],
        "max_output_tokens": max_tokens,
        "text": {
            "format": {
                "type": "json_schema",
                "name": f"editorial_fdg_{kind}",
                "strict": True,
                "schema": dict(schema),
            }
        },
    }


def generate_editorial(kind: str, dossier: Mapping[str, Any], schema: Mapping[str, Any]) -> tuple[dict[str, Any], str]:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise EditorialAIError("OPENAI_API_KEY não configurada")
    payload = build_payload(kind, dossier, schema)
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        OPENAI_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as raw:
            response = json.loads(raw.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1500]
        raise EditorialAIError(f"OpenAI HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise EditorialAIError(f"falha ao chamar OpenAI: {exc}") from exc
    if not isinstance(response, dict):
        raise EditorialAIError("resposta OpenAI em formato inesperado")
    if response.get("status") == "incomplete":
        raise EditorialAIError(f"resposta OpenAI incompleta: {response.get('incomplete_details') or 'sem detalhe'}")
    text = _extract_output_text(response)
    if not text:
        raise EditorialAIError("OpenAI não retornou output_text")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise EditorialAIError(f"JSON editorial inválido: {exc}") from exc
    if not isinstance(parsed, dict):
        raise EditorialAIError("editorial OpenAI não é objeto JSON")
    model = str(response.get("model") or payload["model"])
    return parsed, f"openai:{model}:editorial-dedicado-v2"


def self_test() -> int:
    schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "titulo": {"type": "string"},
            "linha_fina": {"type": "string"},
            "secoes": {"type": "array", "items": {"type": "object"}},
        },
        "required": ["titulo", "linha_fina", "secoes"],
    }
    payload = build_payload("copa_do_brasil", {"classificados": ["Time A"], "placar": "3 x 1"}, schema, "gpt-5.6-terra")
    assert payload["model"] == "gpt-5.6-terra"
    assert payload["reasoning"]["effort"] == DEFAULT_REASONING
    assert payload["text"]["format"]["type"] == "json_schema"
    assert payload["text"]["format"]["strict"] is True
    assert "não complete lacunas" in payload["input"][1]["content"]
    assert "avançar à final" in payload["input"][0]["content"]
    assert "api.openai.com" in OPENAI_URL
    print("OK self-test: camada editorial dedicada, schema estruturado e prompt factual.")
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        raise SystemExit(self_test())
    print("Use este módulo a partir dos geradores editoriais; --self-test valida a camada offline.")
