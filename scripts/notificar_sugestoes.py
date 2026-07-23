"""
notificar_sugestoes.py — Envia por e-mail cada sugestão nova recebida no site.

Fluxo:
  1. Lê da tabela public.feedback_site do Supabase todas as linhas com
     enviado_email = false (as pendentes).
  2. Para cada uma, monta um e-mail HTML e envia via SMTP do Zoho.
  3. Após confirmar envio, marca enviado_email = true no Supabase.

Se algum envio falhar, a linha correspondente NÃO é marcada — na próxima
execução do workflow ela será reprocessada. Isso garante que nenhuma
sugestão se perca por falha transitória de SMTP ou rede.

Variáveis de ambiente esperadas (via secrets do GitHub Actions):
  SUPABASE_URL              — https://xxxxx.supabase.co (sem barra no fim)
  SUPABASE_SERVICE_ROLE_KEY — service_role key (acesso administrativo)
  SMTP_HOST                 — smtp.zoho.com
  SMTP_PORT                 — 465
  SMTP_USER                 — laercio.rehem@formuladogol.com.br
  SMTP_PASS                 — App Password gerada no painel do Zoho
  EMAIL_DESTINO_SUGESTOES   — destino final das notificações
"""
from __future__ import annotations

import json
import os
import smtplib
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

# ---------------------------------------------------------------------------
# Configuração via variáveis de ambiente
# ---------------------------------------------------------------------------

def env_obrigatorio(nome: str) -> str:
    valor = os.environ.get(nome, "").strip()
    if not valor:
        print(f"::error::Variável de ambiente obrigatória ausente: {nome}", file=sys.stderr)
        sys.exit(2)
    return valor


SUPABASE_URL = env_obrigatorio("SUPABASE_URL").rstrip("/")
SUPABASE_KEY = env_obrigatorio("SUPABASE_SERVICE_ROLE_KEY")
SMTP_HOST = env_obrigatorio("SMTP_HOST")
SMTP_PORT = int(env_obrigatorio("SMTP_PORT"))
SMTP_USER = env_obrigatorio("SMTP_USER")
SMTP_PASS = env_obrigatorio("SMTP_PASS")
EMAIL_DESTINO = env_obrigatorio("EMAIL_DESTINO_SUGESTOES")

# Nome que aparece como remetente no cliente de e-mail.
NOME_REMETENTE = "Sugestões · Fórmula do Gol"
FUSO_BR = timezone(timedelta(hours=-3))

# Colunas que precisamos ler da tabela.
COLUNAS = (
    "id,criado_em,tipo,mensagem,assinatura,pagina,visitante_id,user_agent"
)

# Rótulos legíveis para o campo `tipo` (esses valores foram definidos no
# br-feedback.js do site). Se um tipo novo surgir, o dicionário devolve o
# próprio código como fallback.
ROTULO_TIPO = {
    "sugestao": "💡 Sugestão",
    "erro": "🐛 Erro / Bug",
    "elogio": "❤️ Elogio",
    "duvida": "❓ Dúvida",
    "outro": "📝 Outro",
}


# ---------------------------------------------------------------------------
# Utilidades HTTP para o Supabase (REST/PostgREST)
# ---------------------------------------------------------------------------

def _headers_supabase() -> dict[str, str]:
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }


def buscar_pendentes() -> list[dict]:
    """Retorna as sugestões com enviado_email=false, ordenadas por data."""
    params = {
        "select": COLUNAS + ",enviado_email",
        "enviado_email": "eq.false",
        "order": "criado_em.asc",
        "limit": "200",  # trava de segurança contra flood
    }
    url = f"{SUPABASE_URL}/rest/v1/feedback_site?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers=_headers_supabase(), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            corpo = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        print(f"::error::Supabase respondeu {e.code} ao buscar pendentes: {e.read().decode('utf-8', 'replace')}",
              file=sys.stderr)
        sys.exit(3)
    dados = json.loads(corpo)
    if not isinstance(dados, list):
        print(f"::error::Formato inesperado do Supabase: {corpo[:200]}", file=sys.stderr)
        sys.exit(3)
    return dados


def marcar_como_enviado(feedback_id) -> bool:
    """PATCH em feedback_site setando enviado_email=true. Retorna True em sucesso."""
    params = {"id": f"eq.{feedback_id}"}
    url = f"{SUPABASE_URL}/rest/v1/feedback_site?{urllib.parse.urlencode(params)}"
    payload = json.dumps({"enviado_email": True}).encode("utf-8")
    headers = {**_headers_supabase(), "Prefer": "return=minimal"}
    req = urllib.request.Request(url, data=payload, headers=headers, method="PATCH")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return 200 <= resp.status < 300
    except urllib.error.HTTPError as e:
        print(f"::warning::Falhou marcar id={feedback_id} como enviado: {e.code}", file=sys.stderr)
        return False


# ---------------------------------------------------------------------------
# Montagem do e-mail
# ---------------------------------------------------------------------------

def formatar_data(iso_string: str) -> str:
    """Converte '2026-07-23T10:30:15.123456+00:00' para '23/07/2026 07:30:15' (BRT)."""
    if not iso_string:
        return "(sem data)"
    try:
        # Suporta '...Z' também
        iso_string = iso_string.replace("Z", "+00:00")
        dt = datetime.fromisoformat(iso_string)
        return dt.astimezone(FUSO_BR).strftime("%d/%m/%Y %H:%M:%S")
    except Exception:
        return iso_string


def escapar_html(texto: str) -> str:
    """Escape seguro para injetar em HTML sem risco de XSS na caixa de entrada."""
    if texto is None:
        return ""
    return (
        str(texto)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def montar_email(fb: dict) -> EmailMessage:
    tipo_raw = str(fb.get("tipo") or "").strip().lower()
    tipo_rotulo = ROTULO_TIPO.get(tipo_raw, tipo_raw or "(sem tipo)")
    data_fmt = formatar_data(fb.get("criado_em") or "")
    mensagem = str(fb.get("mensagem") or "").strip() or "(mensagem vazia)"
    assinatura = str(fb.get("assinatura") or "").strip() or "(anônimo)"
    pagina = str(fb.get("pagina") or "").strip() or "(sem página)"
    visitante_id = str(fb.get("visitante_id") or "").strip() or "(sem id)"
    user_agent = str(fb.get("user_agent") or "").strip() or "(sem UA)"
    feedback_id = fb.get("id")

    assunto = f"[Fórmula do Gol] {tipo_rotulo} — {mensagem[:60]}{'…' if len(mensagem) > 60 else ''}"

    # Versão texto (fallback para clientes que não renderizam HTML).
    corpo_texto = (
        f"Nova sugestão recebida no site Fórmula do Gol\n"
        f"{'=' * 55}\n\n"
        f"Tipo:       {tipo_rotulo}\n"
        f"Recebido:   {data_fmt} (Brasília)\n"
        f"Página:     {pagina}\n"
        f"Assinatura: {assinatura}\n\n"
        f"Mensagem:\n{mensagem}\n\n"
        f"{'-' * 55}\n"
        f"Metadados técnicos\n"
        f"  ID:         {feedback_id}\n"
        f"  Visitante:  {visitante_id}\n"
        f"  User-Agent: {user_agent}\n"
    )

    # Versão HTML — layout limpo e responsivo.
    corpo_html = f"""<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a2530;">
  <div style="max-width:620px;margin:24px auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.06);">
    <div style="padding:18px 22px;background:linear-gradient(135deg,#0a1820,#07140f);color:#eaffad;">
      <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;opacity:.85;">Fórmula do Gol · Nova sugestão</div>
      <div style="font-size:19px;font-weight:900;margin-top:4px;">{escapar_html(tipo_rotulo)}</div>
    </div>
    <div style="padding:20px 22px 6px;">
      <div style="font-size:13px;color:#5a6975;margin-bottom:14px;">
        Recebido em <strong>{escapar_html(data_fmt)}</strong> (Brasília) · página <code style="background:#f0f3f6;padding:2px 6px;border-radius:4px;font-size:12px;">{escapar_html(pagina)}</code>
      </div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:14px;">
        <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#64748b;margin-bottom:6px;">Mensagem</div>
        <div style="font-size:15px;line-height:1.5;white-space:pre-wrap;color:#1a2530;">{escapar_html(mensagem)}</div>
      </div>
      <div style="font-size:13px;color:#334155;">
        <strong>Assinatura:</strong> {escapar_html(assinatura)}
      </div>
    </div>
    <div style="padding:14px 22px 22px;border-top:1px solid #eef2f6;margin-top:14px;">
      <div style="font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;margin-bottom:8px;">Metadados técnicos</div>
      <table style="width:100%;font-size:12px;color:#475569;border-collapse:collapse;">
        <tr><td style="padding:3px 0;width:110px;color:#94a3b8;">ID do feedback</td><td style="padding:3px 0;font-family:'SF Mono',Menlo,Consolas,monospace;">{escapar_html(str(feedback_id))}</td></tr>
        <tr><td style="padding:3px 0;color:#94a3b8;">Visitante</td><td style="padding:3px 0;font-family:'SF Mono',Menlo,Consolas,monospace;">{escapar_html(visitante_id)}</td></tr>
        <tr><td style="padding:3px 0;color:#94a3b8;vertical-align:top;">User-Agent</td><td style="padding:3px 0;font-family:'SF Mono',Menlo,Consolas,monospace;word-break:break-all;">{escapar_html(user_agent)}</td></tr>
      </table>
    </div>
  </div>
  <div style="text-align:center;font-size:11px;color:#94a3b8;margin:8px 0 24px;">
    Notificação automática · workflow notificar-sugestoes.yml
  </div>
</body></html>"""

    msg = EmailMessage()
    msg["From"] = formataddr((NOME_REMETENTE, SMTP_USER))
    msg["To"] = EMAIL_DESTINO
    msg["Subject"] = assunto
    msg["Message-ID"] = make_msgid(domain="formuladogol.com.br")
    # Reply-To vazio; se um dia coletarmos e-mail do usuário, dá pra encaminhar aqui.
    msg.set_content(corpo_texto)
    msg.add_alternative(corpo_html, subtype="html")
    return msg


# ---------------------------------------------------------------------------
# Envio SMTP (Zoho)
# ---------------------------------------------------------------------------

def enviar_smtp(mensagens: list[EmailMessage]) -> list[bool]:
    """Envia todas as mensagens numa única conexão SSL/SMTP.

    Retorna lista de bool na mesma ordem: True se enviou, False se falhou.
    Uma falha em uma mensagem NÃO derruba as demais.
    """
    resultados: list[bool] = [False] * len(mensagens)
    if not mensagens:
        return resultados

    contexto = ssl.create_default_context()
    try:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=contexto, timeout=30) as servidor:
            servidor.login(SMTP_USER, SMTP_PASS)
            for i, msg in enumerate(mensagens):
                try:
                    servidor.send_message(msg)
                    resultados[i] = True
                except Exception as e:
                    print(f"::warning::Falha ao enviar mensagem #{i}: {e}", file=sys.stderr)
    except smtplib.SMTPAuthenticationError as e:
        print(f"::error::Falha de autenticação SMTP: {e}. Verifique SMTP_USER e SMTP_PASS.",
              file=sys.stderr)
        sys.exit(4)
    except Exception as e:
        print(f"::error::Erro na conexão SMTP com {SMTP_HOST}:{SMTP_PORT}: {e}", file=sys.stderr)
        sys.exit(4)
    return resultados


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    pendentes = buscar_pendentes()
    if not pendentes:
        print("Nenhuma sugestão pendente. Nada a enviar.")
        return 0

    print(f"Encontradas {len(pendentes)} sugestão(ões) pendente(s). Preparando envio...")
    mensagens = [montar_email(fb) for fb in pendentes]
    resultados = enviar_smtp(mensagens)

    enviadas = 0
    falhadas = 0
    marcacoes_falhadas = 0
    for fb, sucesso in zip(pendentes, resultados):
        if sucesso:
            enviadas += 1
            if not marcar_como_enviado(fb["id"]):
                marcacoes_falhadas += 1
        else:
            falhadas += 1

    print(f"Enviadas: {enviadas} · Falhadas: {falhadas} · Marcações falhadas: {marcacoes_falhadas}")

    # Falha marcada como sucesso do workflow, mas exit code 5 sinaliza a marcação
    # residual (pode gerar duplicata na próxima rodada — vale investigar).
    if marcacoes_falhadas > 0:
        print("::warning::Algumas mensagens foram enviadas mas não conseguimos marcá-las no Supabase.",
              file=sys.stderr)
        return 5
    if falhadas > 0:
        # Envio parcial: linhas não marcadas serão reprocessadas na próxima rodada.
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
