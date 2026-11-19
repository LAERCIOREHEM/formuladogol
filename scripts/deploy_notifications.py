#!/usr/bin/env python3
"""Notificações do deploy: deduplicação por histórico real do GitHub Actions.

Uma execução malsucedida informa somente o primeiro erro da sequência.
A próxima publicação integralmente certificada informa recuperação uma vez.
Sem novo banco, arquivo persistente, secrets extras ou marcações artificiais.
"""
from __future__ import annotations

import json
import os
import smtplib
import ssl
import sys
import urllib.error
import urllib.request
from email.message import EmailMessage
from email.utils import formataddr
from typing import Any
from urllib.parse import quote

WORKFLOW_PATH = ".github/workflows/deploy.yml"
PUBLISH_STEPS = frozenset({
    "Deploy to GitHub Pages",
    "Repetir deploy no GitHub Pages",
    "Última tentativa de deploy no GitHub Pages",
})
PUBLIC_SMOKE = "ORG-7R — smoke test público pós-deploy"
CBF_SMOKE = "Certificar horário CBF NA PRODUÇÃO — Grêmio x Bahia 21h30"
IGNORED_CONCLUSIONS = frozenset({"cancelled", "skipped", "neutral", "action_required"})
FAILURE_CONCLUSIONS = frozenset({"failure", "timed_out", "startup_failure"})
VALID_CONCLUSIONS = FAILURE_CONCLUSIONS | {"success"}
EMAIL_SECRETS = ("SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "EMAIL_DESTINO")


def previous_completed_run(runs: list[dict[str, Any]], current_number: int) -> dict[str, Any] | None:
    """Não comparar com execuções futuras, concorrentes ou canceladas."""
    eligible = [
        row for row in runs
        if row.get("path") == WORKFLOW_PATH
        and row.get("head_branch") == "main"
        and row.get("status") == "completed"
        and row.get("conclusion") in VALID_CONCLUSIONS
        and 0 < int(row.get("run_number") or 0) < current_number
    ]
    return max(eligible, key=lambda row: int(row["run_number"]), default=None)


def classify_failure(steps: list[dict[str, Any]]) -> dict[str, str | bool]:
    """Diferencia pré-publicação, publicação, smoke e pós-publicação."""
    published = any(s.get("name") in PUBLISH_STEPS and s.get("conclusion") == "success" for s in steps)
    public_certified = any(s.get("name") == PUBLIC_SMOKE and s.get("conclusion") == "success" for s in steps)
    failed = [
        s for s in steps
        if s.get("conclusion") == "failure"
        and s.get("name") not in PUBLISH_STEPS
        and "Notificação" not in str(s.get("name") or "")
    ]
    deploy_failed = any(s.get("name") in PUBLISH_STEPS and s.get("conclusion") == "failure" for s in steps)
    if not published:
        kind = "publicacao" if deploy_failed else "validacao"
    elif not public_certified:
        kind = "certificacao"
    else:
        kind = "pos_publicacao"
    # Evitar informar tentativa inicial recuperada como causa de um erro posterior.
    stage = str(failed[-1].get("name") or "") if failed else ""
    if not stage and deploy_failed:
        stage = "Implantação GitHub Pages"
    if not stage:
        stage = "Etapa não identificada pela API do GitHub"
    return {"kind": kind, "stage": stage, "published": published, "public_certified": public_certified}


def recovery_certified(steps: list[dict[str, Any]]) -> bool:
    published = any(s.get("name") in PUBLISH_STEPS and s.get("conclusion") == "success" for s in steps)
    return published and any(
        s.get("name") == PUBLIC_SMOKE and s.get("conclusion") == "success" for s in steps
    )


def decision(mode: str, previous: dict[str, Any] | None, steps: list[dict[str, Any]]) -> str:
    previous_failed = bool(previous and previous.get("conclusion") in FAILURE_CONCLUSIONS)
    if mode == "failure":
        return "suppress_duplicate" if previous_failed else "send_first_failure"
    if mode == "recovery":
        if not previous_failed:
            return "no_active_incident"
        return "send_recovery" if recovery_certified(steps) else "not_certified"
    raise ValueError("mode inválido")


def github_api(path: str, *, token: str, repo: str) -> Any:
    if not token:
        raise RuntimeError("GITHUB_TOKEN ausente (Actions Read obrigatório)")
    url = f"https://api.github.com/repos/{repo}/{path}"
    req = urllib.request.Request(
        url, headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "FDG-Deploy-Incident-Notifier/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"GitHub API HTTP {exc.code} ({path.split('?')[0]})") from None
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise RuntimeError(f"GitHub API indisponível ({type(exc).__name__})") from None


def run_history(*, token: str, repo: str, number: int) -> dict[str, Any] | None:
    # Lock repo-write-main serializa runs; 100 registros cobrem falhas consecutivas.
    data = github_api("actions/runs?per_page=100", token=token, repo=repo)
    rows = data.get("workflow_runs")
    if not isinstance(rows, list):
        raise RuntimeError("GitHub API retornou histórico inválido")
    # Se há mais de 100 runs, consultar próximas páginas para não esconder a
    # última execução deste workflow em um repositório com muitas automações.
    page = 1
    match = previous_completed_run(rows, number)
    while match is None and len(rows) == 100 and page < 10:
        page += 1
        data = github_api(f"actions/runs?per_page=100&page={page}", token=token, repo=repo)
        rows = data.get("workflow_runs")
        if not isinstance(rows, list):
            raise RuntimeError("Paginação GitHub Actions inválida")
        match = previous_completed_run(rows, number)
    if match is None and page == 10 and len(rows) == 100:
        raise RuntimeError("Histórico ultrapassou limite de 1000 runs; não é seguro deduplicar")
    return match


def current_steps(*, token: str, repo: str, run_id: int) -> list[dict[str, Any]]:
    data = github_api(f"actions/runs/{run_id}/jobs?per_page=100", token=token, repo=repo)
    jobs = data.get("jobs")
    if not isinstance(jobs, list):
        raise RuntimeError("GitHub API retornou lista de jobs inválida")
    matches = [j for j in jobs if j.get("name") == "Publicar GitHub Pages"]
    if len(matches) != 1 or not isinstance(matches[0].get("steps"), list):
        raise RuntimeError("Não foi possível identificar o job de publicação")
    return matches[0]["steps"]


def build_message(mode: str, detail: dict[str, str | bool], run_url: str,
                  previous: dict[str, Any] | None) -> tuple[str, str]:
    stage = detail.get("stage") or "Não identificada"
    if mode == "recovery":
        return (
            "Fórmula do GOL — deploy recuperado e site validado",
            "RECUPERAÇÃO CONFIRMADA\n\n"
            "Uma nova publicação do GitHub Pages foi concluída e o smoke test público passou.\n"
            "O incidente anterior de deploy foi encerrado.\n\n"
            f"Execução recuperada: {run_url}\n"
            f"Falha anterior: {previous.get('html_url', '') if previous else ''}\n"
            "Site: https://formuladogol.com.br/jogos\n",
        )
    category = str(detail.get("kind"))
    cases = {
        "validacao": (
            "Fórmula do GOL — validação bloqueou o deploy",
            "VALIDAÇÃO BLOQUEADA: esta execução NÃO publicou nova versão. "
            "A versão anteriormente publicada não foi substituída por ela.",
        ),
        "publicacao": (
            "Fórmula do GOL — falha na publicação do site",
            "PUBLICAÇÃO NÃO CONCLUÍDA: as tentativas de implantar a nova versão falharam. "
            "Não há confirmação de atualização do site nesta execução.",
        ),
        "certificacao": (
            "Fórmula do GOL — publicação sem certificação pública",
            "PUBLICAÇÃO EFETUADA, PORÉM NÃO CERTIFICADA: houve implantação, "
            "mas os testes públicos não passaram. O site requer verificação.",
        ),
        "pos_publicacao": (
            "Fórmula do GOL — falha após publicação validada",
            "PUBLICAÇÃO E SMOKE PÚBLICO APROVADOS: uma etapa posterior falhou. "
            "Isso não significa que o site deixou de funcionar.",
        ),
    }
    subject, explanation = cases[category]
    return subject, (
        "NOVO INCIDENTE DE DEPLOY\n\n"
        f"{explanation}\n\n"
        f"Etapa com falha: {stage}\n"
        f"Execução: {run_url}\n\n"
        "Próximas falhas consecutivas desse workflow não gerarão novos e-mails. "
        "Uma recuperação será comunicada quando a próxima publicação for validada.\n"
    )


def smtp_send(subject: str, body: str, env: dict[str, str]) -> bool:
    missing = [key for key in EMAIL_SECRETS if not str(env.get(key) or "").strip()]
    if missing:
        print("::warning::E-mail de deploy não enviado: secrets SMTP ausentes: " + ", ".join(missing))
        return False
    message = EmailMessage()
    message["From"] = formataddr(("Fórmula do Gol", env["SMTP_USER"]))
    message["To"] = env["EMAIL_DESTINO"]
    message["Subject"] = subject
    message.set_content(body)
    try:
        port = int(env["SMTP_PORT"])
        context = ssl.create_default_context()
        if port == 465:
            with smtplib.SMTP_SSL(env["SMTP_HOST"], port, context=context, timeout=30) as server:
                server.login(env["SMTP_USER"], env["SMTP_PASS"])
                server.send_message(message)
        else:
            with smtplib.SMTP(env["SMTP_HOST"], port, timeout=30) as server:
                server.ehlo()
                server.starttls(context=context)
                server.ehlo()
                server.login(env["SMTP_USER"], env["SMTP_PASS"])
                server.send_message(message)
        return True
    except (OSError, ValueError, smtplib.SMTPException) as exc:
        # Não transformar um deploy saudável em FAILED por falha no e-mail.
        print(f"::warning::Falha SMTP no alerta de deploy ({type(exc).__name__})")
        return False


def main(mode: str, *, env: dict[str, str] | None = None) -> int:
    env = dict(os.environ if env is None else env)
    if mode not in {"failure", "recovery"}:
        raise ValueError("Escolha failure ou recovery")
    try:
        repo = env["GITHUB_REPOSITORY"]
        run_id = int(env["GITHUB_RUN_ID"])
        number = int(env["GITHUB_RUN_NUMBER"])
        if "/" not in repo or run_id < 1 or number < 1:
            raise ValueError("contexto de execução inválido")
        token = env.get("GITHUB_TOKEN", "")
        previous = run_history(token=token, repo=repo, number=number)
        steps = current_steps(token=token, repo=repo, run_id=run_id)
        result = decision(mode, previous, steps)
        if result not in {"send_first_failure", "send_recovery"}:
            print(f"Deploy notifier: {result} — sem novo e-mail")
            return 0
        run_url = "https://github.com/" + quote(repo, safe="/") + "/actions/runs/" + str(run_id)
        detail = classify_failure(steps) if mode == "failure" else {}
        subject, body = build_message(mode, detail, run_url, previous)
        if smtp_send(subject, body, env):
            print(f"Deploy notifier: {result}, e-mail entregue ao servidor SMTP")
        else:
            print(f"::warning::Deploy notifier: {result}, sem confirmação de entrega SMTP")
    except (RuntimeError, KeyError, TypeError, ValueError) as exc:
        # Falha de API/metadata: não presumir ausência de incidente e
        # gerar spam. Aviso explícito no job, sem divulgar credenciais.
        print(f"::warning::Monitor de incidentes sem decisão segura: {exc}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Uso: deploy_notifications.py failure|recovery")
    raise SystemExit(main(sys.argv[1]))
