#!/usr/bin/env python3
"""
Script que verifica aniversariantes do dia e envia email via Resend.com.

Roda 1x por dia (08:00 BRT = 11:00 UTC) pelo GitHub Actions.
Lê membros.json do repositório, filtra aniversariantes do dia,
e dispara email pro admin com link pronto do WhatsApp.

Variáveis de ambiente esperadas (configuradas como secrets no GitHub):
- RESEND_API_KEY: chave da API do Resend (re_...)
- EMAIL_DESTINO: email pra receber o aviso (ex: laercio.caixa@gmail.com)
- EMAIL_REMETENTE: opcional, default 'onboarding@resend.dev'
"""

import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta
from urllib.parse import quote


FUSO_BRASILIA = timezone(timedelta(hours=-3))


def agora_brasilia():
    return datetime.now(FUSO_BRASILIA)


def ler_membros():
    """Lê membros.json do diretório atual."""
    if not os.path.exists("membros.json"):
        print("AVISO: membros.json nao encontrado.")
        return []
    try:
        with open("membros.json", "r", encoding="utf-8") as f:
            data = json.load(f)
        return data.get("membros", [])
    except Exception as e:
        print(f"Erro ao ler membros.json: {e}")
        return []


def aniversariantes_de_hoje(membros):
    """Filtra membros que fazem aniversário HOJE em Brasília."""
    hoje = agora_brasilia()
    dia_hoje = hoje.day
    mes_hoje = hoje.month

    resultado = []
    for m in membros:
        aniv = m.get("aniversario")
        if not aniv:
            continue
        if aniv.get("dia") == dia_hoje and aniv.get("mes") == mes_hoje:
            resultado.append(m)
    return resultado


def link_whatsapp(nome):
    """Gera link wa.me com mensagem pré-pronta."""
    msg = f"Parabens, {nome}! Tudo de bom no seu dia!"
    return f"https://wa.me/?text={quote(msg)}"


def montar_html_email(aniversariantes):
    """Monta corpo HTML do email."""
    n = len(aniversariantes)
    titulo = "Aniversariante de hoje!" if n == 1 else f"{n} aniversariantes de hoje!"

    html = f"""<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; background:#f5f5f5; padding:20px; margin:0;">
  <div style="max-width:560px; margin:0 auto; background:white; border-radius:12px; padding:24px; box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <h1 style="font-size:22px; margin:0 0 16px; color:#1f2937;">&#127874; {titulo}</h1>
    <p style="font-size:14px; color:#6b7280; margin:0 0 20px;">Bolao Brasileirao 2026 - Almoco de Sexta</p>
"""
    for p in aniversariantes:
        nome = p.get("nome", "?")
        link = link_whatsapp(nome)
        html += f"""
    <div style="background:#fdf2f8; border:1px solid #f9a8d4; border-radius:10px; padding:16px; margin-bottom:12px;">
      <div style="font-size:18px; font-weight:600; color:#db2777; margin-bottom:10px;">{nome}</div>
      <a href="{link}" style="display:inline-block; background:#22c55e; color:white; padding:10px 18px; border-radius:8px; text-decoration:none; font-weight:500; font-size:14px;">
        Mandar parabens no WhatsApp
      </a>
    </div>
"""
    html += """
    <p style="font-size:12px; color:#9ca3af; margin:20px 0 0; padding-top:16px; border-top:1px solid #e5e7eb;">
      Clique no botao e o WhatsApp abrira com a mensagem ja pronta. Escolha o grupo do almoco e envie.
    </p>
    <p style="font-size:11px; color:#d1d5db; margin:12px 0 0; text-align:center;">
      <a href="https://brasileirao2026almoco.com.br" style="color:#9ca3af;">brasileirao2026almoco.com.br</a>
    </p>
  </div>
</body>
</html>"""
    return html


def enviar_email_resend(api_key, remetente, destinatario, assunto, html_corpo):
    """Envia email via API do Resend."""
    payload = {
        "from": remetente,
        "to": [destinatario],
        "subject": assunto,
        "html": html_corpo,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        body = resp.read().decode("utf-8")
        status = resp.getcode()
        return status, body


def main():
    inicio = agora_brasilia()
    print("=" * 70)
    print("Verificacao de aniversariantes do dia")
    print("=" * 70)
    print(f"Inicio: {inicio.strftime('%d/%m/%Y %H:%M:%S BRT')}")
    print()

    api_key = os.environ.get("RESEND_API_KEY", "").strip()
    destino = os.environ.get("EMAIL_DESTINO", "").strip()
    remetente = os.environ.get("EMAIL_REMETENTE", "onboarding@resend.dev").strip()

    if not api_key:
        print("ERRO: variavel RESEND_API_KEY nao configurada.")
        sys.exit(1)
    if not destino:
        print("ERRO: variavel EMAIL_DESTINO nao configurada.")
        sys.exit(1)

    print(f"Remetente: {remetente}")
    print(f"Destinatario: {destino}")
    print()

    membros = ler_membros()
    print(f"Total de membros carregados: {len(membros)}")

    aniversariantes = aniversariantes_de_hoje(membros)
    print(f"Aniversariantes hoje: {len(aniversariantes)}")
    for a in aniversariantes:
        print(f"  - {a.get('nome')}")

    if not aniversariantes:
        print("\nNenhum aniversariante hoje. Nada a enviar.")
        return

    print("\nMontando email...")
    html_email = montar_html_email(aniversariantes)
    nomes = ", ".join(a.get("nome", "?") for a in aniversariantes)
    assunto = f"Hoje: aniversario de {nomes}"

    print(f"Enviando email para {destino}...")
    try:
        status, body = enviar_email_resend(api_key, remetente, destino, assunto, html_email)
        print(f"Status HTTP: {status}")
        print(f"Resposta: {body[:300]}")
        if 200 <= status < 300:
            print("\nEmail enviado com sucesso!")
        else:
            print(f"\nERRO: status {status}")
            sys.exit(1)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else ""
        print(f"ERRO HTTP {e.code}: {body}")
        sys.exit(1)
    except Exception as e:
        print(f"ERRO: {type(e).__name__}: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
