import copy
import unittest
from unittest.mock import Mock,patch
from scripts import editorial_delivery as d

A={"id_editorial":"brasileirao-2026-rodada-37","tipo":"brasileirao_rodada","rodada":37,"slug":"brasileirao-2026-rodada-37.html","url":d.SITE+"brasileirao-2026-rodada-37.html","titulo":"Teste","email_assunto":"Teste"}
ENV={"GITHUB_RUN_ID":"123","SMTP_USER":"sender@example.com","EMAIL_DESTINO":"receiver@example.com"}
class Store:
    def __init__(self):self.doc={"schema_version":2,"notificacoes":[],"total_notificacoes":0};self.rev=0;self.fail=None
    def read(self):return copy.deepcopy(self.doc),str(self.rev)
    def write(self,doc,sha):
        if self.fail:self.fail()
        if sha!=str(self.rev):raise d.Conflict()
        self.doc=copy.deepcopy(doc);self.rev+=1
class TestEditorial(unittest.TestCase):
    def setUp(self):
        self.store=Store();self.smtp=Mock();self.smtp.send_message.return_value={}
        self.connect=Mock(return_value=self.smtp);self.confirm=Mock(return_value=True)
    def deliver(self,a=A):return d.deliver(a,self.store,ENV,self.confirm,self.connect)
    def test_first_send_then_repeat_and_revision(self):
        self.assertEqual(self.deliver(),"sent")
        self.assertEqual(self.deliver(dict(A,titulo="Revisão")),"sent") # already sent status
        self.smtp.send_message.assert_called_once();self.assertEqual(self.store.doc["total_notificacoes"],1)
        self.assertEqual(self.store.doc["reservas"],[])
    def test_reservation_persisted_before_smtp(self):
        def send(msg):
            self.assertEqual(d.find(self.store.doc,A["id_editorial"])[0],"reserved")
            return {}
        self.smtp.send_message.side_effect=send
        self.deliver();self.smtp.send_message.assert_called_once()
    def test_uncertain_smtp_no_retry(self):
        self.smtp.send_message.side_effect=OSError("lost acknowledgement")
        self.assertEqual(self.deliver(),"uncertain")
        self.assertEqual(self.deliver(),"reserved");self.smtp.send_message.assert_called_once()
    def test_finalization_failure_blocks_future_send(self):
        def send(msg):
            self.store.fail=lambda:(_ for _ in ()).throw(d.LedgerError("unavailable"))
            return {}
        self.smtp.send_message.side_effect=send
        self.assertEqual(self.deliver(),"accepted_unconfirmed")
        self.store.fail=None
        self.assertEqual(self.deliver(),"reserved");self.smtp.send_message.assert_called_once()
    def test_cas_failure_no_send(self):
        self.store.fail=lambda:(_ for _ in ()).throw(d.LedgerError("unavailable"))
        with self.assertRaises(d.LedgerError):self.deliver()
        self.smtp.send_message.assert_not_called()
    def test_lost_claim_ack_no_send(self):
        orig=self.store.write
        def lost(doc,sha):
            orig(doc,sha);raise d.LedgerError("lost ack")
        self.store.write=lost
        with self.assertRaises(d.LedgerError):self.deliver()
        self.assertEqual(self.deliver(),"reserved");self.smtp.send_message.assert_not_called()
    def test_conflicting_claim_no_send(self):
        orig=self.store.write
        def conflict(doc,sha):
            self.store.write=orig
            d.reserve(self.store,A,"other-run")
            raise d.Conflict()
        self.store.write=conflict
        with patch.object(d.time,"sleep"):self.assertEqual(self.deliver(),"already_reserved")
        self.smtp.send_message.assert_not_called()
    def test_unpublished_no_claim_or_smtp(self):
        self.confirm.return_value=False
        self.assertEqual(self.deliver(),"not_public");self.connect.assert_not_called();self.assertEqual(self.store.rev,0)
    def test_legacy_and_next_round(self):
        old=dict(A,id_editorial="brasileirao-2026-rodada-36",slug="brasileirao-2026-rodada-36.html",url=d.SITE+"brasileirao-2026-rodada-36.html",rodada=36,notificado_em="2026-11-25T22:14:35-03:00")
        self.store.doc["notificacoes"]=[old];self.store.doc["total_notificacoes"]=1
        self.deliver(old);self.deliver(A)
        self.smtp.send_message.assert_called_once();self.assertEqual(self.store.doc["total_notificacoes"],2)
    def test_login_failure_does_not_reserve(self):
        self.connect.side_effect=OSError("login")
        with self.assertRaises(OSError):self.deliver()
        self.assertEqual(self.store.rev,0)
    def test_stable_message_id(self):
        self.assertEqual(d.message(A,ENV)["Message-ID"],d.message(dict(A,titulo="Revisão"),ENV)["Message-ID"])
    def test_corrupt_ledger_and_url(self):
        with self.assertRaises(d.LedgerError):d.validate({"schema_version":2,"notificacoes":[A,A],"total_notificacoes":2})
        with self.assertRaises(d.LedgerError):self.deliver(dict(A,url="https://example.org"))
        self.smtp.send_message.assert_not_called()
if __name__=="__main__":unittest.main()
