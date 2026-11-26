import unittest
import lineup as l
def xi(prefix="p"):
    return tuple((prefix+str(i),r) for i,r in enumerate("GDDDDMMMFFF"))
def prof(v=60,c=80):
    return {"rating":v,"offense":v,"defense":v,"confidence":c}
class TestLineup(unittest.TestCase):
    def test_same_xi_cancels(self):
        x=xi();r=l.compare(x,x,{p:prof() for p in x})
        self.assertEqual(r["raw_delta"],0);self.assertEqual(r["status"],"supported")
    def test_swap_and_fallback(self):
        x=xi();y=x[:-1]+(("new","F"),);p={k:prof() for k in x+y};p["new","F"]=prof(80)
        r=l.compare(y,x,p);self.assertGreater(r["applied_delta"],0);self.assertEqual(r["rotation_slots"],1)
        p["new","F"]=prof(99,1);r=l.compare(y,x,p)
        self.assertIsNone(r["raw_delta"]);self.assertEqual(r["applied_delta"],0)
    def test_formation_change(self):
        x=xi();y=x[:-1]+(("new","M"),);r=l.compare(y,x,{k:prof() for k in x+y})
        self.assertEqual(r["status"],"role_mix_changed")
    def test_habitual_prior_only(self):
        x=xi();at=100*l.e.LAG
        prior=[{"xi":x,"year":2026,"t":at-i*l.e.LAG,"fixture_id":str(i)} for i in (4,3,2)]
        self.assertEqual(l.habitual(prior,at,2026,"c",{})[0],x)
        future={"xi":xi("future"),"year":2026,"t":at,"fixture_id":"f"}
        self.assertEqual(l.habitual(prior+[future],at,2026,"c",{})[0],x)
        self.assertIsNone(l.habitual(prior,at,2026,"c",{x[0][0]:"other"})[0])
    def test_observed_xi(self):
        rr=[{"player_id":p,"values":{"starter":True,"position":r},"quality":{"starter":"valid_shape"}} for p,r in xi()]
        self.assertEqual(len(l.observed_xi(rr)),11);self.assertIsNone(l.observed_xi(rr[:-1]))
    def test_fallback_prediction(self):
        r={"elo_diff":.5,"lineup_diff":0,"supported":False}
        self.assertEqual(l.prediction(r,(.2,.4,1,1,2)),(.4,.4))
    def test_no_training_future(self):
        self.assertEqual(l.baseline_fit([]),(0.,0.,0.,0.,0.))
if __name__=="__main__":unittest.main(verbosity=2)
