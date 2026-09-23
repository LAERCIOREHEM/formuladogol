#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Mapping

DIRECT_OPENAI_RESPONSES = "https://api.openai.com/v1/responses"
FDG_API_USER_AGENT = "FormulaDoGol-Automation/2026.09 (+https://formuladogol.com.br)"


class OpenAITransportError(RuntimeError):
    """Falha de transporte/autenticação antes de validar a resposta OpenAI."""


def openai_responses_url() -> str:
    account = (os.environ.get("FDG_AI_GATEWAY_ACCOUNT_ID") or "").strip()
    gateway = (os.environ.get("FDG_AI_GATEWAY_ID") or "default").strip() or "default"
    if not account:
        return DIRECT_OPENAI_RESPONSES
    return f"https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/openai/responses"


def gateway_metadata(component: str, purpose: str = "") -> str:
    return json.dumps(
        {
            "project": "formula-do-gol",
            "component": component,
            "purpose": purpose or component,
            "provider": "openai",
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def is_gateway_url(url: str) -> bool:
    return str(url or "").startswith("https://gateway.ai.cloudflare.com/")


def is_cloudflare_1010(status: int | None, detail: str) -> bool:
    text = str(detail or "").lower()
    return int(status or 0) == 403 and (
        "error code: 1010" in text
        or "error 1010" in text
        or ("1010" in text and "cloudflare" in text)
    )


def openai_headers(api_key: str, component: str, purpose: str, *, gateway: bool) -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        # Python urllib envia Python-urllib/x.y por padrão. Cloudflare pode
        # recusá-lo com 403 / error 1010 antes da requisição chegar ao gateway.
        "User-Agent": FDG_API_USER_AGENT,
    }
    if gateway:
        headers.update(
            {
                "cf-aig-collect-log-payload": "false",
                "cf-aig-no-wholesale": "true",
                "cf-aig-metadata": gateway_metadata(component, purpose),
            }
        )
    return headers


def _post_json(
    url: str,
    payload: Mapping[str, Any],
    api_key: str,
    *,
    timeout: int,
    component: str,
    purpose: str,
) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=openai_headers(api_key, component, purpose, gateway=is_gateway_url(url)),
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as raw:
            body = raw.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:2000]
        error = OpenAITransportError(f"OpenAI HTTP {exc.code}: {detail}")
        error.status = exc.code  # type: ignore[attr-defined]
        error.detail = detail  # type: ignore[attr-defined]
        error.url = url  # type: ignore[attr-defined]
        raise error from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise OpenAITransportError(f"Falha de transporte OpenAI: {exc}") from exc

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise OpenAITransportError("OpenAI/AI Gateway devolveu JSON inválido") from exc
    if not isinstance(parsed, dict):
        raise OpenAITransportError("OpenAI/AI Gateway não devolveu objeto JSON")
    return parsed


def post_openai_responses(
    payload: Mapping[str, Any],
    api_key: str,
    *,
    timeout: int,
    component: str,
    purpose: str,
) -> dict[str, Any]:
    """Chama OpenAI via AI Gateway, com proteção específica para CF 1010.

    403/error 1010 é um bloqueio de assinatura/User-Agent no edge da Cloudflare,
    antes de chegar ao provedor. Nesse caso específico, a chamada é repetida UMA
    vez diretamente em api.openai.com para preservar a operação. Outros erros não
    acionam fallback, evitando chamadas pagas duplicadas.
    """
    primary = openai_responses_url()
    try:
        response = _post_json(
            primary,
            payload,
            api_key,
            timeout=timeout,
            component=component,
            purpose=purpose,
        )
        response["_fdg_transport"] = {
            "route": "ai_gateway" if is_gateway_url(primary) else "direct",
            "gatewayFallback": False,
        }
        return response
    except OpenAITransportError as exc:
        status = getattr(exc, "status", None)
        detail = getattr(exc, "detail", str(exc))
        if not (is_gateway_url(primary) and is_cloudflare_1010(status, detail)):
            raise

        response = _post_json(
            DIRECT_OPENAI_RESPONSES,
            payload,
            api_key,
            timeout=timeout,
            component=component,
            purpose=purpose,
        )
        response["_fdg_transport"] = {
            "route": "direct_fallback_cf1010",
            "gatewayFallback": True,
            "gatewayStatus": int(status or 0),
            "gatewayError": str(detail)[:500],
        }
        return response


def self_test() -> int:
    headers = openai_headers("sk-test", "self-test", "transport", gateway=True)
    assert headers["User-Agent"] == FDG_API_USER_AGENT
    assert not headers["User-Agent"].lower().startswith("python-urllib")
    assert headers["cf-aig-no-wholesale"] == "true"
    assert "cf-aig-metadata" in headers
    direct_headers = openai_headers("sk-test", "self-test", "transport", gateway=False)
    assert "cf-aig-no-wholesale" not in direct_headers
    assert is_cloudflare_1010(403, "error code: 1010")
    assert not is_cloudflare_1010(403, "invalid_api_key")
    assert not is_cloudflare_1010(429, "1010")
    print("Self-test AI Gateway transport: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(self_test())
