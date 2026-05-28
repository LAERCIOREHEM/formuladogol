#!/usr/bin/env python3
"""
Verifica aniversariantes do dia APENAS na lista TUPAL (membros_tupal.json)
e envia aviso por e-mail via Resend para uma lista de destinatários.

Roda 1x por dia pelo GitHub Actions.

Secrets esperados no GitHub:
- RESEND_API_KEY: chave da API do Resend (re_...)
- EMAIL_REMETENTE: ex. TUPAL <tupal@brasileirao2026almoco.com.br>
- EMAIL_DESTINATARIOS_TUPAL: e-mails separados por vírgula

Observação:
- O envio é feito individualmente, um e-mail por destinatário.
  Assim ninguém vê a lista dos demais destinatários.
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta
from urllib.parse import quote


FUSO_BRASILIA = timezone(timedelta(hours=-3))


def agora_brasilia():
    return datetime.now(FUSO_BRASILIA)


def ler_arquivo_membros(nome_arquivo):
    if not os.path.exists(nome_arquivo):
        print(f"ERRO: {nome_arquivo} não encontrado.")
        return []
    try:
        with open(nome_arquivo, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data.get("membros", [])
    except Exception as e:
        print(f"Erro ao ler {nome_arquivo}: {e}")
        return []


def aniversariantes_de_hoje(membros):
    hoje = agora_brasilia()
    resultado = []
    for m in membros:
        aniv = m.get("aniversario")
        if not aniv:
            continue
        if aniv.get("dia") == hoje.day and aniv.get("mes") == hoje.month:
            resultado.append(m)
    return resultado


def link_whatsapp(nome):
    msg = f"Parabéns, {nome}! Tudo de bom no seu dia!"
    return f"https://wa.me/?text={quote(msg)}"


def montar_html_email(aniv_tupal):
    total = len(aniv_tupal)
    titulo = "Aniversariante TUPAL de hoje!" if total == 1 else f"{total} aniversariantes TUPAL de hoje!"

    cards = ""
    for p in aniv_tupal:
        nome = p.get("nome", "?")
        link = link_whatsapp(nome)
        cards += f"""
      <div style="background:#fff7ed; border:1px solid #fdba74; border-radius:10px; padding:14px; margin-bottom:10px;">
        <div style="font-size:18px; font-weight:700; color:#c2410c; margin-bottom:8px;">{nome}</div>
        <a href="{link}" style="display:inline-block; background:#22c55e; color:white; padding:9px 16px; border-radius:8px; text-decoration:none; font-weight:600; font-size:13px;">
          Mandar parabéns no WhatsApp
        </a>
      </div>
"""

    html = f"""<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif; background:#f5f5f5; padding:20px; margin:0;">
  <div style="max-width:580px; margin:0 auto; background:white; border-radius:12px; padding:24px; box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <h1 style="font-size:22px; margin:0 0 6px; color:#1f2937;">🎂 {titulo}</h1>
    <p style="font-size:13px; color:#6b7280; margin:0 0 20px;">Aviso automático da lista TUPAL</p>

    <h2 style="font-size:14px; font-weight:700; color:#92400e; text-transform:uppercase; letter-spacing:0.8px; margin:0 0 12px; padding-bottom:6px; border-bottom:2px solid #f59e0b;">
      TUPAL - {total} aniversariante(s)
    </h2>
{cards}
    <p style="font-size:12px; color:#9ca3af; margin:20px 0 0; padding-top:16px; border-top:1px solid #e5e7eb;">
      Clique no botão e o WhatsApp abrirá com a mensagem pronta.
    </p>
    <p style="font-size:11px; color:#d1d5db; margin:12px 0 0; text-align:center;">
      <a href="https://brasileirao2026almoco.com.br" style="color:#9ca3af;">brasileirao2026almoco.com.br</a>
    </p>
  </div>
</body>
</html>"""
    return html


def enviar_email_resend(api_key, remetente, destinatario, assunto, html_corpo):
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
            "User-Agent": "TUPALAniversarios/1.0 (+https://brasileirao2026almoco.com.br)",
            "Accept": "application/json",
        },
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=20) as resp:
        body = resp.read().decode("utf-8")
        return resp.getcode(), body


def parse_destinatarios(valor):
    return [e.strip() for e in valor.replace(";", ",").split(",") if e.strip()]


def main():
    inicio = agora_brasilia()
    print("=" * 70)
    print("Verificação de aniversariantes TUPAL")
    print("=" * 70)
    print(f"Início: {inicio.strftime('%d/%m/%Y %H:%M:%S BRT')}")

    api_key = os.environ.get("RESEND_API_KEY", "").strip()
    remetente = os.environ.get("EMAIL_REMETENTE", "TUPAL <tupal@brasileirao2026almoco.com.br>").strip()
    destinatarios = parse_destinatarios(os.environ.get("EMAIL_DESTINATARIOS_TUPAL", ""))

    if not api_key:
        print("ERRO: secret RESEND_API_KEY não configurado.")
        sys.exit(1)
    if not destinatarios:
        print("ERRO: secret EMAIL_DESTINATARIOS_TUPAL não configurado.")
        sys.exit(1)

    print(f"Remetente: {remetente}")
    print(f"Destinatários configurados: {len(destinatarios)}")

    membros_tupal = ler_arquivo_membros("membros_tupal.json")
    print(f"Membros TUPAL carregados: {len(membros_tupal)}")

    aniv_tupal = aniversariantes_de_hoje(membros_tupal)
    print(f"Aniversariantes TUPAL hoje: {len(aniv_tupal)}")
    for a in aniv_tupal:
        print(f"  - {a.get('nome')}")

    if not aniv_tupal:
        print("Nenhum aniversariante TUPAL hoje. Nada a enviar.")
        return

    nomes = ", ".join(a.get("nome", "?") for a in aniv_tupal)
    assunto = f"TUPAL: aniversário de {nomes} hoje"
    html_email = montar_html_email(aniv_tupal)

    erros = 0
    for destinatario in destinatarios:
        print(f"Enviando para {destinatario}...")
        try:
            status, body = enviar_email_resend(api_key, remetente, destinatario, assunto, html_email)
            print(f"  OK HTTP {status}: {body[:200]}")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else ""
            print(f"  ERRO HTTP {e.code}: {body[:500]}")
            erros += 1
        except Exception as e:
            print(f"  ERRO {type(e).__name__}: {e}")
            erros += 1

        # Pausa para respeitar o limite do Resend no plano atual.
        time.sleep(0.5)

    if erros:
        print(f"Concluído com {erros} erro(s).")
        sys.exit(1)

    print("Todos os e-mails foram enviados com sucesso.")


if __name__ == "__main__":
    main()
