import concurrent.futures,tempfile,unittest
from governance import *
class Test(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/"g.db";self.t=int(dt.datetime(2027,3,1,11,0,tzinfo=dt.timezone.utc).timestamp());self.g=Governance(self.path,lambda:self.t);self.observe()
    def tearDown(self):self.g.close();self.tmp.cleanup()
    def observe(self,remaining=7000):
        self.g.observe_quota("api-football",{"x-ratelimit-requests-limit":"7500","x-ratelimit-requests-remaining":str(remaining),"x-ratelimit-limit":"300","x-ratelimit-remaining":"300"},self.t,True)
    def call(self,id="one",fixture="1",season=2027,attempt=1,lane="research",provider="api-football"):
        return self.g.reserve(id,season,provider,fixture,"get_game","v1",lane,attempt)
    def tick(self,n=1):self.t+=n
    def test_bypass(self):
        self.g.observe_cost(self.t,daily_usd=100)
        for p in P["essential"]:self.assertTrue(self.call(provider=p)["allowed"])
        self.assertEqual(self.call()["status"],"cost_containment")
    def test_quota_missing(self):
        with self.assertRaises(ValueError):self.g.observe_quota("api-football",{},self.t,True)
        self.tick(121);self.assertEqual(self.call()["status"],"quota_unverified")
    def test_no_quota_inflation(self):
        self.tick();self.observe(50);self.tick();self.observe(7500);self.assertEqual(self.g.read("SELECT body FROM quota WHERE provider='api-football'")["remaining"],50)
    def test_reserve_floor(self):
        self.tick();self.observe(10);self.assertEqual(self.call()["status"],"provider_reserve")
    def test_idempotency(self):
        self.assertTrue(self.call()["allowed"]);self.assertEqual(self.call()["status"],"duplicate_reservation")
        with self.assertRaises(ValueError):self.call(fixture="2")
    def test_cache_isolation(self):
        x=self.call();data={"competition":"bra.1","cache_key":x["key"],"value":7};self.g.finish("one","ok",data);self.tick()
        self.assertEqual(self.call("two")["status"],"cache_hit");self.assertTrue(self.call("three",season=2026)["allowed"])
    def test_cache_identity(self):
        self.call()
        with self.assertRaises(ValueError):self.g.finish("one","ok",{"competition":"other"})
    def test_timeout_retry(self):
        self.call();self.g.finish("one","timeout");self.tick(10);self.assertEqual(self.call("two",attempt=2)["status"],"inflight_or_retry_blocked");self.tick(20);self.assertTrue(self.call("two",attempt=2)["allowed"]);self.assertIsNone(self.g.finish("two","transient")["retry_at"])
    def test_429(self):
        self.call();self.g.finish("one","429",retry_after=90);self.tick(1);self.assertEqual(self.call("two","2")["status"],"circuit_429")
        self.tick(90);self.observe();self.assertTrue(self.call("two","2")["allowed"])
    def test_suspend_and_recovery(self):
        self.call();self.g.finish("one","suspended");self.tick(1);self.assertEqual(self.call("two","2")["status"],"circuit_suspended")
        with self.assertRaises(ValueError):self.g.reconcile("api-football",False,"evidence")
        self.observe();self.g.reconcile("api-football",True,"verified");self.assertTrue(self.call("two","2")["allowed"])
    def test_concurrent(self):
        def work(i):
            g=Governance(self.path,lambda:self.t)
            try:return g.reserve("i"+str(i),2027,"api-football","1","get_game","v1")["allowed"]
            finally:g.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:res=list(ex.map(work,range(12)))
        self.assertEqual(sum(res),1)
    def test_local_minute(self):
        for i in range(5):
            self.assertTrue(self.call(str(i),str(i))["allowed"]);self.tick()
        self.assertEqual(self.call("six","6")["status"],"local_rate_limit")
    def test_daily_and_utc(self):
        for i in range(150):
            self.assertTrue(self.call(str(i),str(i))["allowed"]);self.tick(60);self.observe()
        self.assertEqual(self.call("over","over")["status"],"local_daily_limit")
        self.t=int(dt.datetime(2027,3,2,0,0,tzinfo=dt.timezone.utc).timestamp());self.observe();self.assertTrue(self.call("new","new")["allowed"])
    def test_shared_lanes(self):
        for i in range(100):
            self.assertTrue(self.call(str(i),str(i),lane="operational")["allowed"]);self.tick(60);self.observe()
        self.assertEqual(self.call("over","over",lane="operational")["status"],"local_daily_limit");self.assertTrue(self.call("research","research")["allowed"])
    def test_striker_disabled(self):
        self.g.observe_quota("strikerapi",{"verified-monthly-limit":500,"verified-monthly-remaining":500},self.t,True)
        self.assertEqual(self.call(provider="strikerapi")["status"],"striker_live_disabled")
    def test_checkpoint(self):
        self.assertTrue(self.g.checkpoint(2027,"job",0,"page1"));self.assertFalse(self.g.checkpoint(2027,"job",0,"page2"));self.assertTrue(self.g.checkpoint(2027,"job",1,"page2",True));self.assertFalse(self.g.checkpoint(2027,"job",2,"page3"))
    def test_checkpoint_rewind(self):
        self.assertTrue(self.g.checkpoint(2027,"job",0,"page1"));self.assertTrue(self.g.checkpoint(2027,"job",1,"page2"));self.assertFalse(self.g.checkpoint(2027,"job",2,"page1"))
    def test_cross_midnight_quota(self):
        self.t=int(dt.datetime(2027,3,2,0,0,tzinfo=dt.timezone.utc).timestamp());h={"x-ratelimit-requests-limit":"7500","x-ratelimit-requests-remaining":"7000","x-ratelimit-limit":"300","x-ratelimit-remaining":"300"}
        with self.assertRaises(ValueError):self.g.observe_quota("api-football",h,self.t-1,True)
    def test_cost_modes(self):
        for v,m in [(1,"normal"),(2,"observe"),(5,"optional_paused"),(10,"secondary_paused")]:
            self.g.observe_cost(self.t,daily_usd=v);self.assertEqual(self.g.cost()["mode"],m);self.tick()
        self.tick(3601);self.assertEqual(self.g.cost()["mode"],"unverified");self.assertIsNone(self.g.cost()["daily_usd"])
    def test_d1(self):
        self.g.observe_cost(self.t,d1_reads=5000000000);self.assertEqual(self.g.cost()["mode"],"secondary_paused");self.assertFalse(self.g.cost()["billing_verified"])
    def test_digest(self):
        self.g.observe_cost(self.t,daily_usd=5);self.tick();self.g.observe_cost(self.t,daily_usd=6)
        x=self.g.digest(coverage={"known":3},pending=1,health="yellow");self.assertEqual(x["alerts"],1);self.assertEqual(x["delivery"],"shadow_outbox_only");self.assertIsNone(self.g.digest())
    def test_digest_window(self):
        self.tick(4*3600);self.assertIsNone(self.g.digest())
if __name__=="__main__":unittest.main()
