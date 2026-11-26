import base64, concurrent.futures, json, sqlite3, tempfile, unittest
from pathlib import Path
from ledger import *
class Test(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/"ledger.db";self.t=stamp("2027-03-01T12:00:00Z");self.l=Ledger(self.path,lambda:self.t)
        self.ko="2027-03-03T12:00:00Z";self.b=self.make("1")
        self.k=self.l.register(2027,"espn","1","H","A",self.ko,iso(self.t-1000),self.b)
        self.x={"home_id":"H","away_id":"A","home":[f"h{i}" for i in range(11)],"away":[f"a{i}" for i in range(11)]}
    def tearDown(self):self.l.close();self.tmp.cleanup()
    def make(self,i):
        return json.dumps({"event_id":i,"probabilidades_pct":{"mandante":50,"empate":25,"visitante":25},"gols_esperados":{"mandante":1.5,"visitante":1.0},"placar_modal":{"mandante":1,"visitante":0},"placares_mais_provaveis":[{"mandante":1,"visitante":0,"probabilidade_pct":15},{"mandante":1,"visitante":1,"probabilidade_pct":14},{"mandante":2,"visitante":0,"probabilidade_pct":10}]},indent=2).encode()
    def send(self,i,x=None,kind="lineup",src=None,expected=None):
        return self.l.event(self.k,i,2027,"espn","1",kind,iso(self.t if src is None else src),self.x if x is None else x,expected)
    def confirm(self):
        self.assertEqual(self.send("a")["status"],"pending");self.t+=21000;self.assertEqual(self.send("b")["status"],"xi_confirmed")
    def test_confirmation_exact_fallback(self):
        self.confirm();r,s=self.l.state(self.k);self.assertEqual(self.l.blob(s[0]),self.l.blob(s[-1]));self.assertEqual(s[-1]["payload"]["delta"],[0.,0.])
    def test_duplicate_id(self):
        self.send("a");self.assertEqual(self.send("a")["status"],"duplicate_event");self.assertEqual(len(self.l.rows(self.k)),2)
    def test_order_invariant(self):
        self.confirm();self.t+=21000;self.x["home"].reverse();self.assertEqual(self.send("c")["status"],"duplicate_signature")
    def test_revision_and_reversion(self):
        self.confirm();orig=self.l.state(self.k)[1][-1]["payload"]["lineup_hash"];self.t+=21000;self.x["home"][0]="new";self.send("c");self.t+=21000;self.assertEqual(self.send("d")["status"],"xi_revised");self.t+=21000;self.x["home"][0]="h0";self.send("e");self.t+=21000;self.assertEqual(self.send("f")["status"],"xi_revised");self.assertEqual(self.l.state(self.k)[1][-1]["payload"]["lineup_hash"],orig)
    def test_stale_and_future(self):
        self.confirm();self.t+=21000;self.x["home"][0]="new";self.assertEqual(self.send("c",src=self.t-60000)["status"],"stale_source");self.assertEqual(self.send("d",src=self.t+1)["status"],"invalid_clock")
    def test_late_freeze(self):
        self.confirm();self.t=stamp(self.ko);self.assertEqual(self.send("c")["status"],"frozen");self.t+=1000;self.assertEqual(self.send("d")["status"],"frozen");r,s=self.l.state(self.k);self.assertEqual(r[-1]["payload"]["latest"],s[-1]["hash"])
    def test_early_actual_kickoff(self):
        self.assertEqual(self.send("ko",{},kind="kickoff")["status"],"frozen");self.assertEqual(self.send("a")["status"],"frozen")
    def test_identity_and_missing_source(self):
        with self.assertRaises(ValueError):self.l.event(self.k,"a",2026,"espn","1","lineup",iso(self.t),self.x)
        with self.assertRaises(ValueError):self.l.event(self.k,"a",2027,"espn","1","lineup",None,self.x)
        self.x["away"][0]="h0"
        with self.assertRaises(ValueError):self.send("b")
    def test_source_loss_and_rollback(self):
        self.send("a");self.t+=21000;self.send("loss",{},kind="source_loss");self.t+=21000;self.assertEqual(self.send("b")["status"],"pending");self.t+=21000;self.send("roll",{},kind="rollback");self.assertEqual(self.send("c")["status"],"rolled_back");self.assertEqual(len(self.l.state(self.k)[1]),1)
    def test_only_target(self):
        k2=self.l.register(2027,"espn","2","C","D",self.ko,iso(self.t),self.make("2"));before=self.l.rows(k2);self.confirm();self.assertEqual(before,self.l.rows(k2))
    def test_baseline_update_and_immutable(self):
        p=json.loads(self.b);p["gols_esperados"]["mandante"]=1.6;b=raw(p);self.t+=1000;self.assertEqual(self.send("u",{"forecast_b64":base64.b64encode(b).decode(),"model":"AF-Previsão 1.3"},kind="baseline")["status"],"updated");self.assertEqual(self.l.blob(self.l.state(self.k)[1][0]),self.b);self.assertEqual(self.l.blob(self.l.state(self.k)[1][-1]),b)
        with self.assertRaises(sqlite3.IntegrityError):self.l.db.execute("DELETE FROM journal")
    def test_concurrency(self):
        self.send("a");self.t+=21000
        def task(i):
            l=Ledger(self.path,lambda:self.t)
            try:return l.event(self.k,"b",2027,"espn","1","lineup",iso(self.t),self.x)["status"]
            finally:l.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:result=list(ex.map(task,range(12)))
        self.assertEqual(result.count("xi_confirmed"),1);self.assertEqual(result.count("duplicate_event"),11)
    def test_cas(self):
        self.send("a");self.assertEqual(self.send("b",expected=1)["status"],"cas_conflict")
    def test_prospective(self):
        self.t+=1000;self.l.freeze_protocol("a"*64,"b"*64,"c"*64,iso(self.t-2000),"2027-03-02T12:00:00Z")
        self.assertTrue(hash_ok(self.l.enroll(self.k,"b"*64,"c"*64,self.b,iso(self.t),iso(self.t),False)))
        with self.assertRaises(sqlite3.IntegrityError):self.l.enroll(self.k,"b"*64,"c"*64,self.b,iso(self.t),iso(self.t),False)
    def test_prospective_late(self):
        self.t+=1000;self.l.freeze_protocol("a"*64,"b"*64,"c"*64,iso(self.t-2000),"2027-03-02T12:00:00Z");self.t=stamp("2027-03-02T12:00:00Z")+1
        with self.assertRaises(ValueError):self.l.enroll(self.k,"b"*64,"c"*64,self.b,iso(self.t),iso(self.t),False)
if __name__=="__main__":unittest.main()
