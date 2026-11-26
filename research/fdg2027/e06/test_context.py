import unittest
import context_engine as c
class TestContext(unittest.TestCase):
    def test_calendar_prior_only(self):
        t=100*c.DAY
        prior=[{"year":2026,"t":t-3*c.DAY},{"year":2026,"t":t},{"year":2025,"t":t-c.DAY}]
        a=c.calendar(prior,t,2026);self.assertEqual(a["rest_days"],3);self.assertEqual(a["games_7d"],1)
        self.assertIsNone(c.calendar([],t,2026)["rest_days"])
    def test_objectives_strict_bounds(self):
        tab={str(i):(0,38) for i in range(20)};tab["0"]=(1,38)
        self.assertTrue(c.state_for(tab,"0",2026)["conditional_title_clinched"])
        self.assertTrue(c.state_for(tab,"1",2026)["conditional_title_impossible"])
        self.assertFalse(c.state_for(tab,"1",2026)["conditional_bottom4_certain"])
        self.assertIsNone(c.state_for({"0":(1,1)},"0",2026))
    def test_workload_missing_and_lag(self):
        t=100*c.DAY;h=[{"year":2026,"t":t-8*c.DAY,"minutes":(990,800)},{"year":2026,"t":t-c.DAY,"minutes":(0,0)}]
        self.assertEqual(c.workload(h,t,2026),(990,800,1));h[0]["minutes"]=None
        self.assertEqual(c.workload(h,t,2026),(None,None,1))
    def test_prior_rotation(self):
        t=100*c.DAY;h=[{"year":2026,"t":t-15*c.DAY,"rotation":2},{"year":2026,"t":t-8*c.DAY,"rotation":4},{"year":2026,"t":t,"rotation":11}]
        self.assertEqual(c.prior_rotation(h,t,2026),(3,2))
    def test_fallback(self):
        r={"elo_diff":1,"features":{"rest_days":None}}
        self.assertEqual(c.predict(r,(.2,.5),{"normalization":{"rest_days":(0,1,0,0)},"coefficients":{"rest_days":1}}),.7)
    def test_ridge_and_ablation(self):
        train=[{"elo_diff":0.,"features":{"rest_days":float(i%5)},"label":{"goal_diff":i%5}} for i in range(200)]
        b=c.basefit(train);m=c.fit(train,("rest_days",),b)
        self.assertIsNotNone(m);self.assertLess(c.evaluate(train,b,m)["context_mae"],c.evaluate(train,b,m)["baseline_mae"])
        self.assertIsNone(c.fit(train[:10],("rest_days",),b))
    def test_minutes_missing(self):
        self.assertIsNone(c.game_minutes([]))
        rr=[{"player_id":str(i),"values":{"starter":True,"minutes":90}} for i in range(11)]
        self.assertEqual(c.game_minutes(rr),(990,990));rr[0]["values"]["minutes"]=None;self.assertIsNone(c.game_minutes(rr))
if __name__=="__main__":unittest.main(verbosity=2)
