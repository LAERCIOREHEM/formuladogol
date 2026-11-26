import math, unittest
import numpy as np
import forecast_engine as f
class Tests(unittest.TestCase):
    def test_extremes(self):
        for h,a in ((.06,.08),(5.5,5),(12,12),(1.3,.8),(1.,1.)):
            d=f.matrix(h,a)
            self.assertLessEqual(d["tail_mass"],1.001e-12)
            self.assertAlmostEqual(sum(map(sum,d["matrix"])),1.,places=12)
            self.assertAlmostEqual(sum(d["ved"]),1.,places=12)
            self.assertAlmostEqual(sum(d["display_pct"]),100.)
            self.assertAlmostEqual(sum(d["ved_pct"]),100.)
    def test_symmetry(self):
        x=f.matrix(1.2,2.4)["ved"];y=f.matrix(2.4,1.2)["ved"]
        for a,b in zip(x,reversed(y)):self.assertAlmostEqual(a,b)
    def row(self,i):
        return {"t":i*86400,"cutoff":99999999,"features":{"x":float(i%7)},"baseline":{"rates":[1.5,1.],"map_rates":[1.4,1.],"ewma_pct":[0,0],"ved":[.5,.3,.2]},"label":{"home_goals":i%4,"away_goals":i%3}}
    def test_fallback(self):
        r=self.row(1)
        p,reason,_=f.apply(r,None)
        self.assertEqual(f.raw(p),f.raw(r["baseline"]))
        self.assertEqual(reason,"model_not_eligible")
        blob=b'{"v": 0, "x": 100}\n'
        self.assertIs(f.exact_fallback(blob),blob)
    def test_fit_and_guard(self):
        rows=[self.row(i) for i in range(150)]
        cutoff=200*86400
        m=f.fit(rows,("x",),cutoff)
        self.assertEqual(m["n"],150)
        self.assertLess(m["train_max_available"],cutoff)
        r=self.row(6);r["cutoff"]=cutoff-1
        self.assertEqual(f.apply(r,m)[1],"temporal_guard")
        r["cutoff"]=cutoff;r["features"]["x"]=None
        self.assertEqual(f.apply(r,m)[1],"missing_context")
        r["features"]["x"]=6.
        p,reason,d=f.apply(r,m)
        self.assertIsNone(reason)
        for i in range(2):
            self.assertAlmostEqual(p["rates"][i],r["baseline"]["rates"][i]*math.exp(d[i]))
            self.assertTrue(math.log(.9)<=d[i]<=math.log(1.1))
    def test_train_cutoff(self):
        self.assertIsNone(f.fit([self.row(i) for i in range(150)],("x",),100*86400))
    def test_no_lineup(self):
        self.assertNotIn("lineup",f.GROUPS)
        self.assertNotIn("gap_leader",f.GROUPS["competitive"])
if __name__=="__main__":unittest.main()
