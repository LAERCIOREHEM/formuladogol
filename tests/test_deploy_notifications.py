#!/usr/bin/env python3
"""Regressões locais, sem rede/SMTP, para os incidentes do GitHub Pages."""
import unittest
from unittest.mock import patch

from scripts import deploy_notifications as n


def run(number, conclusion, *, path=n.WORKFLOW_PATH, branch="main", status="completed"):
    return {
        "run_number": number, "conclusion": conclusion, "path": path,
        "head_branch": branch, "status": status,
        "html_url": f"https://github.com/example/repo/actions/runs/{number}",
    }


def step(name, conclusion="success"):
    return {"name": name, "conclusion": conclusion}


PUBLISHED = [step("Deploy to GitHub Pages"), step(n.PUBLIC_SMOKE)]
EARLY_FAILED = [step("Validar LiveState ESPN compartilhado", "failure")]
PRECHECK_FAILED = [step("Conferir 20 jogos oficiais das rodadas finais (CBF)", "failure")]
DEPLOY_FAILED = [
    step("Deploy to GitHub Pages", "failure"),
    step("Repetir deploy no GitHub Pages", "failure"),
    step("Última tentativa de deploy no GitHub Pages", "failure"),
]
SMOKE_FAILED = [step("Deploy to GitHub Pages"), step(n.PUBLIC_SMOKE, "failure")]


class HistoryTest(unittest.TestCase):
    def test_previous_run_ignores_other_workflows_and_cancellations(self):
        rows = [
            run(41, "failure"), run(46, "success", path=".github/workflows/other.yml"),
            run(42, "cancelled"), run(44, "failure", status="in_progress"),
            run(43, "success"), run(46, "failure"), run(40, "failure", branch="dev"),
        ]
        self.assertEqual(n.previous_completed_run(rows, 45)["run_number"], 43)
        self.assertEqual(n.previous_completed_run(rows, 47)["run_number"], 46)

    def test_no_prior_valid_run(self):
        self.assertIsNone(n.previous_completed_run([run(2, "success")], 2))

    def test_first_failure_notified_once(self):
        prior = run(10, "success")
        failure = run(11, "failure")
        self.assertEqual(n.decision("failure", prior, PRECHECK_FAILED), "send_first_failure")
        self.assertEqual(n.decision("failure", failure, PRECHECK_FAILED), "suppress_duplicate")
        self.assertEqual(n.decision("failure", None, PRECHECK_FAILED), "send_first_failure")

    def test_recovery_only_after_real_success(self):
        prior = run(10, "failure")
        self.assertEqual(n.decision("recovery", prior, PUBLISHED), "send_recovery")
        self.assertEqual(n.decision("recovery", run(10, "success"), PUBLISHED), "no_active_incident")
        self.assertEqual(n.decision("recovery", prior, [step(n.PUBLIC_SMOKE)]), "not_certified")
        self.assertEqual(n.decision("recovery", prior, [step("Deploy to GitHub Pages")]), "not_certified")
        self.assertEqual(n.decision("recovery", None, PUBLISHED), "no_active_incident")


class ClassificationTest(unittest.TestCase):
    def test_prechecks_do_not_claim_pages_deploy_failed(self):
        detail = n.classify_failure(PRECHECK_FAILED)
        self.assertEqual(detail["kind"], "validacao")
        self.assertEqual(detail["stage"], PRECHECK_FAILED[0]["name"])
        title, body = n.build_message("failure", detail, "https://example.com", None)
        self.assertIn("validação bloqueou", title)
        self.assertIn("NÃO publicou", body)

    def test_deploy_retries_fail(self):
        detail = n.classify_failure(DEPLOY_FAILED)
        self.assertEqual(detail["kind"], "publicacao")
        self.assertFalse(detail["published"])

    def test_published_but_smoke_fails(self):
        detail = n.classify_failure(SMOKE_FAILED)
        self.assertEqual(detail["kind"], "certificacao")
        self.assertTrue(detail["published"])
        self.assertFalse(detail["public_certified"])

    def test_post_deploy_failure_is_not_publication_failure(self):
        detail = n.classify_failure(PUBLISHED + [step("Notificar buscadores via IndexNow", "failure")])
        self.assertEqual(detail["kind"], "pos_publicacao")
        self.assertEqual(detail["stage"], "Notificar buscadores via IndexNow")
        title, body = n.build_message("failure", detail, "https://example.com", None)
        self.assertIn("após publicação validada", title)
        self.assertIn("SITE", body.upper())

    def test_initial_retry_failure_does_not_claim_unpublished(self):
        steps = [
            step("Deploy to GitHub Pages", "failure"),
            step("Repetir deploy no GitHub Pages"),
            step(n.PUBLIC_SMOKE),
        ]
        self.assertTrue(n.recovery_certified(steps))

    def test_recovery_email_references_prior_run(self):
        subj, body = n.build_message("recovery", {}, "https://github.com/example/actions/runs/2", run(1, "failure"))
        self.assertIn("recuperado", subj)
        self.assertIn("/runs/1", body)
        self.assertIn("/runs/2", body)


class OrchestrationTest(unittest.TestCase):
    def setUp(self):
        self.env = {
            "GITHUB_REPOSITORY": "example/repo", "GITHUB_RUN_ID": "21",
            "GITHUB_RUN_NUMBER": "21", "GITHUB_TOKEN": "fake",
        }

    @patch.object(n, "smtp_send")
    @patch.object(n, "current_steps", return_value=PRECHECK_FAILED)
    @patch.object(n, "run_history", return_value=run(20, "failure"))
    def test_dedupe_never_calls_smtp(self, history, steps, mail):
        self.assertEqual(n.main("failure", env=self.env), 0)
        mail.assert_not_called()

    @patch.object(n, "smtp_send", return_value=True)
    @patch.object(n, "current_steps", return_value=PRECHECK_FAILED)
    @patch.object(n, "run_history", return_value=run(20, "success"))
    def test_initial_failure_sends_single_email(self, history, steps, mail):
        self.assertEqual(n.main("failure", env=self.env), 0)
        mail.assert_called_once()
        self.assertIn("validação bloqueou", mail.call_args[0][0])

    @patch.object(n, "smtp_send", return_value=True)
    @patch.object(n, "current_steps", return_value=PUBLISHED)
    @patch.object(n, "run_history", return_value=run(20, "failure"))
    def test_recovery_sends_only_when_certified(self, history, steps, mail):
        self.assertEqual(n.main("recovery", env=self.env), 0)
        mail.assert_called_once()
        self.assertIn("recuperado", mail.call_args[0][0])

    @patch.object(n, "smtp_send")
    @patch.object(n, "current_steps", side_effect=RuntimeError("GitHub API indisponível"))
    @patch.object(n, "run_history", return_value=run(20, "success"))
    def test_api_failure_is_fail_closed_without_spam(self, history, steps, mail):
        self.assertEqual(n.main("failure", env=self.env), 0)
        mail.assert_not_called()


if __name__ == "__main__":
    unittest.main()
