#!/usr/bin/env python3
from __future__ import annotations
import os

DIRECT_OPENAI_RESPONSES = "https://api.openai.com/v1/responses"

def openai_responses_url() -> str:
    account=(os.environ.get("FDG_AI_GATEWAY_ACCOUNT_ID") or "").strip()
    gateway=(os.environ.get("FDG_AI_GATEWAY_ID") or "default").strip() or "default"
    if not account:
        return DIRECT_OPENAI_RESPONSES
    return f"https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/openai/responses"

def gateway_metadata(component: str, purpose: str = "") -> str:
    import json
    return json.dumps({"project":"formula-do-gol","component":component,"purpose":purpose or component,"provider":"openai"},ensure_ascii=False,separators=(",",":"))
