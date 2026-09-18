#!/usr/bin/env python3
"""Camada dedicada de redação editorial com OpenAI.

Princípios:
- só é chamada depois que o gerador determinístico confirmou que há matéria elegível;
- recebe um pacote factual fechado e não pesquisa a web;
- devolve somente JSON estruturado;
- nunca altera placares, probabilidades ou qualquer cálculo do projeto;
- para continentais, usa uma segunda passagem de copy desk por padrão;
- se a API falhar, o gerador chamador pode usar seu fallback determinístico.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, Mapping, Sequence

DEFAULT_MODEL = "gpt-5.6-sol"
DEFAULT_REASONING = "high"
DEFAULT_MAX_OUTPUT_TOKENS = 12000
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


# Espelha a lista que cada gerador aplica na validação da saída.
_TERMOS_BANIDOS: dict[str, tuple[str, ...]] = {
    "continentais": (
        "dossiê",
        "snapshot",
        "a narrativa",
        "mergulhar",
        "jornada",
        "vale destacar",
        "o futebol nos ensina",
        "mais do que nunca",
    ),
    "copa_do_brasil": ("vale destacar", "a narrativa", "mergulhar", "jornada", "dossiê", "snapshot oficial"),
    "rodada": ("vale destacar", "a narrativa", "mergulhar", "jornada", "o futebol nos ensina", "mais do que nunca", "dossiê factual", "snapshot"),
}


def termos_proibidos_para_prompt(termos: Sequence[str]) -> str:
    """Repassa ao modelo a MESMA lista que o validador aplica na saída."""
    if not termos:
        return ""
    lista = ", ".join(f'"{t}"' for t in termos)
    return (
        f"PROIBIDO ESCREVER, em qualquer campo do JSON, os termos: {lista}. "
        "Eles reprovam o texto automaticamente. Ao se referir ao material de apoio, escreva "
        "'os números do Fórmula do Gol' ou simplesmente apresente o fato; nunca exponha nomes de arquivos, "
        "rotinas, hashes, processos internos ou o funcionamento da IA."
    )


def _base_instruction() -> str:
    return (
        "Você é o editor-chefe esportivo do Fórmula do Gol, com padrão de redação de uma mesa internacional de futebol. "
        "Escreva em português do Brasil com precisão, ritmo, hierarquia jornalística e leitura analítica dos números. "
        "A matéria deve parecer escrita por um editor esportivo sênior: abertura forte, desenvolvimento fluido, consequência esportiva clara e análise quantitativa útil. "
        "Use SOMENTE fatos e números presentes no pacote factual. Não invente jogadores, autores de gols, declarações, público, ambiente de estádio, tática, lesões, causas ou chaveamentos que não estejam explicitamente fornecidos. "
        "Não transforme o texto em relatório, ata, lista de placares ou documentação técnica. Sintetize os confrontos e explique por que os resultados importam. "
        "Quando houver probabilidades, diferencie com precisão a chance TOTAL de Libertadores da contribuição de uma via específica; nunca trate as duas como sinônimos. "
        "A manchete deve ter notícia e personalidade sem clickbait. A linha fina deve acrescentar contexto e consequência. "
        "Os parágrafos devem variar construção e tamanho; evite começar várias frases da mesma maneira. "
        "Priorize: fato mais relevante -> tensão/virada da fase -> quadro dos classificados e eliminados -> efeito nas probabilidades -> próximo desafio quando fornecido. "
        "Não explique metodologia no corpo salvo quando indispensável para evitar interpretação errada de um número. "
        "Entregue exclusivamente JSON compatível com o schema solicitado."
    )


def _specific_instruction(kind: str) -> str:
    if kind == "copa_do_brasil":
        return (
            "Para Copa do Brasil: trate o último confronto encerrado como gancho quando ele completar a fase; apresente todos os classificados logo no início; "
            "use os placares agregados relevantes; conecte explicitamente a classificação às probabilidades de Libertadores. Se o material trouxer uma regra "
            "de qualificação continental, explique-a com precisão. Em semifinal, diga 'avançar à final' ou 'vencer o confronto da semifinal', nunca 'vencer o próximo jogo' "
            "quando a fase for de ida e volta. Dê destaque aos maiores saltos e quedas de probabilidade sem confundir chance total de Libertadores com a via Copa do Brasil."
        )
    if kind == "brasileirao":
        return (
            "Para Brasileirão: a manchete deve refletir o principal acontecimento da rodada e, preferencialmente, nomear os clubes envolvidos. "
            "Cruze resultados com as maiores mudanças de título, Libertadores e rebaixamento. Use posição, pontos e percentuais quando ajudarem a explicar a notícia. "
            "Não faça uma seção para cada métrica por obrigação; construa uma matéria de rodada."
        )
    if kind == "continentais":
        return (
            "Para Libertadores/Sul-Americana, escreva uma matéria de fechamento de fase, não uma enumeração de sete confrontos. "
            "Primeiro audite o fechamento CONJUNTO do recorte brasileiro: a fase só está fechada quando todos os confrontos da fase que envolveram ao menos um clube brasileiro estão resolvidos; jogos exclusivamente estrangeiros não bloqueiam. "
            "Preencha o objeto auditoria estritamente com os classificados e eliminados recebidos. Se houver qualquer contradição factual, marque consistente=false e não tente conciliá-la por memória. "
            "Em confronto decidido nos pênaltis, o vencedor dos 90/120 minutos NÃO define o classificado: use exclusivamente classificado/vencedor_penaltis já auditado. "
            "Na prosa, escolha os dois ou três acontecimentos que realmente definiram a fase e trate os demais com síntese. Evite o molde repetitivo 'Na Libertadores..., No fim...'. "
            "A matéria ideal tem 4 seções e aproximadamente 450 a 800 palavras de prosa: (1) abertura/saldo brasileiro; (2) Libertadores; (3) Sul-Americana; (4) leitura das probabilidades e/ou semifinais. "
            "Mencione TODOS os clubes brasileiros participantes ao menos uma vez, mas não desperdice um parágrafo isolado para cada clube. "
            "Quando houver virada de confronto, derrota na volta com classificação no agregado ou decisão por pênaltis, use isso como matéria-prima editorial. "
            "Se 'contexto_verificado.proximos_confrontos' estiver presente, cite os confrontos da fase seguinte exatamente como fornecidos e não invente datas. "
            "Se houver movimentos de probabilidade, selecione apenas os mais informativos: maior alta, maior queda e um caso contraintuitivo relevante. "
            "O texto deve explicar o significado esportivo dos números, não apenas repeti-los. "
            "A IA não cria fatos, não decide placares, não altera classificados e não transforma partida pendente em encerrada."
        )
    raise EditorialAIError(f"tipo editorial desconhecido: {kind}")


def _schema_format(kind: str, schema: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "type": "json_schema",
        "name": f"editorial_fdg_{kind}",
        "strict": True,
        "schema": dict(schema),
    }


def _selected_model(model: str | None = None) -> str:
    return (model or os.environ.get("OPENAI_EDITORIAL_MODEL") or os.environ.get("OPENAI_MODEL") or DEFAULT_MODEL).strip()


def _reasoning() -> str:
    return (os.environ.get("OPENAI_EDITORIAL_REASONING") or DEFAULT_REASONING).strip()


def _max_tokens() -> int:
    try:
        return int(os.environ.get("OPENAI_EDITORIAL_MAX_TOKENS") or DEFAULT_MAX_OUTPUT_TOKENS)
    except ValueError:
        return DEFAULT_MAX_OUTPUT_TOKENS


def build_payload(kind: str, dossier: Mapping[str, Any], schema: Mapping[str, Any], model: str | None = None) -> dict[str, Any]:
    instruction = _base_instruction() + "\n\n" + _specific_instruction(kind)
    banidos = _TERMOS_BANIDOS.get(kind)
    if banidos:
        instruction += "\n\n" + termos_proibidos_para_prompt(banidos)
    return {
        "model": _selected_model(model),
        "store": False,
        "reasoning": {"effort": _reasoning()},
        "input": [
            {"role": "developer", "content": instruction},
            {
                "role": "user",
                "content": (
                    "Pacote factual auditado. Todo fato e número utilizável está abaixo; não complete lacunas por memória e não pesquise nada fora dele:\n"
                    + json.dumps(dossier, ensure_ascii=False, separators=(",", ":"))
                ),
            },
        ],
        "max_output_tokens": _max_tokens(),
        "text": {"format": _schema_format(kind, schema)},
    }


def build_review_payload(kind: str, dossier: Mapping[str, Any], draft: Mapping[str, Any], schema: Mapping[str, Any], model: str | None = None) -> dict[str, Any]:
    """Segunda passagem de copy desk sem abrir espaço para novos fatos."""
    instruction = (
        _base_instruction()
        + "\n\n"
        + _specific_instruction(kind)
        + "\n\nVocê agora atua como COPY DESK FINAL. Receberá o pacote factual e um rascunho já estruturado. "
        "Reescreva o rascunho para elevar clareza, ritmo, hierarquia, precisão e densidade informativa. "
        "Preserve EXATAMENTE os fatos auditados, os status de classificação e os números; não acrescente nenhum fato que não esteja no pacote. "
        "A auditoria do JSON final deve refletir somente o pacote factual, não sua opinião sobre o rascunho. "
        "Elimine redundância, enumeração mecânica e frases burocráticas. Dê ao texto uma abertura com notícia, transições naturais e um fechamento que aponte a consequência esportiva. "
        "Não imite a voz de nenhum jornalista específico; use apenas o padrão de qualidade de uma redação internacional de alto nível."
    )
    banidos = _TERMOS_BANIDOS.get(kind)
    if banidos:
        instruction += "\n\n" + termos_proibidos_para_prompt(banidos)
    return {
        "model": _selected_model(model),
        "store": False,
        "reasoning": {"effort": _reasoning()},
        "input": [
            {"role": "developer", "content": instruction},
            {
                "role": "user",
                "content": (
                    "PACOTE FACTUAL:\n"
                    + json.dumps(dossier, ensure_ascii=False, separators=(",", ":"))
                    + "\n\nRASCUNHO A SER EDITADO:\n"
                    + json.dumps(draft, ensure_ascii=False, separators=(",", ":"))
                ),
            },
        ],
        "max_output_tokens": _max_tokens(),
        "text": {"format": _schema_format(kind, schema)},
    }


def _call_structured(payload: Mapping[str, Any]) -> tuple[dict[str, Any], str]:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise EditorialAIError("OPENAI_API_KEY não configurada")
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        OPENAI_URL,
        data=body,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as raw:
            response = json.loads(raw.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:2000]
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
    return parsed, str(response.get("model") or payload.get("model") or "")


def _review_enabled(kind: str) -> bool:
    if kind != "continentais":
        return False
    value = (os.environ.get("OPENAI_EDITORIAL_REVIEW") or "1").strip().lower()
    return value not in {"0", "false", "no", "off"}


def generate_editorial(kind: str, dossier: Mapping[str, Any], schema: Mapping[str, Any]) -> tuple[dict[str, Any], str]:
    """Gera editorial estruturado; continentais passam por redação + copy desk."""
    payload = build_payload(kind, dossier, schema)
    draft, model = _call_structured(payload)
    if _review_enabled(kind):
        review_payload = build_review_payload(kind, dossier, draft, schema, model=model or None)
        reviewed, review_model = _call_structured(review_payload)
        return reviewed, f"openai:{review_model or model}:editorial-dedicado-v4:copydesk"
    return draft, f"openai:{model}:editorial-dedicado-v4"


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

    continental_schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {"titulo": {"type": "string"}},
        "required": ["titulo"],
    }
    dossier = {
        "classificados_brasileiros": ["Palmeiras"],
        "eliminados_brasileiros": ["Corinthians"],
        "contexto_verificado": {"proximos_confrontos": ["Fluminense x Palmeiras"]},
    }
    c_payload = build_payload("continentais", dossier, continental_schema, "gpt-5.6-sol")
    instruction = c_payload["input"][0]["content"]
    assert "copy" not in instruction.lower()  # primeira passagem continua sendo redação, não revisão
    assert "450 a 800 palavras" in instruction
    assert "proximos_confrontos" in instruction
    assert "vencedor dos 90/120 minutos NÃO define" in instruction
    review = build_review_payload("continentais", dossier, {"titulo": "Rascunho"}, continental_schema, "gpt-5.6-sol")
    assert "COPY DESK FINAL" in review["input"][0]["content"]
    assert _review_enabled("continentais") is True
    print("OK self-test: camada editorial v4, Structured Outputs e copy desk continental em duas passagens.")
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        raise SystemExit(self_test())
    print("Use este módulo a partir dos geradores editoriais; --self-test valida a camada offline.")
