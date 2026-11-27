import unittest
import build
class Contract(unittest.TestCase):
    def test_eligibility(self):
        r=dict(rating=52,season_minutes=450,confidence=25,last_match_at="2026-11-20T00:00:00+00:00")
        t=build.e.stamp("2026-11-25T00:00:00+00:00")
        self.assertTrue(build.eligible(r,2026,t))
        for k,v in (("rating",None),("rating",101),("confidence",24.99),("season_minutes",449),("last_match_at","2026-07-01T00:00:00+00:00")):
            self.assertFalse(build.eligible(dict(r,**{k:v}),2026,t))
    def test_percentiles(self):
        def row(n,p,r,ok=True):return dict(name=n,club="C",position=p,rating=r,eligible=ok,percentile=None,position_rank=None)
        a=build.percentiles([row("A","G",60),row("B","G",60),row("C","G",40),row("D","F",80),row("E","G",99,False)])
        m={r["name"]:r for r in a}
        self.assertEqual(m["A"]["position_rank"],1);self.assertEqual(m["B"]["percentile"],m["A"]["percentile"])
        self.assertEqual(m["C"]["position_rank"],3);self.assertEqual(m["D"]["position_rank"],1)
        self.assertIsNone(m["E"]["percentile"])
    def test_gate(self):
        self.assertEqual(build.POL["publication"],"BLOCKED")
        for k in ("rights_verified","identity_verified","semantic_certified","public_release_authorized"):self.assertFalse(build.POL[k])
        self.assertEqual(build.POL["af_previsao"],"1.3");self.assertFalse(build.POL["season_2027_active"])
if __name__=="__main__":unittest.main()
