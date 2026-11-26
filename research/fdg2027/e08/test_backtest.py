import unittest, math
import backtest as b
class Test(unittest.TestCase):
    def row(self,i=0):
        return {"year":2025,"t":1735689600+i*7*86400,"label":{"home_goals":1,"away_goals":0}}
    def pred(self,v):
        return {"ved":v,"modal":[1,0],"top3":[[1,0,.2],[1,1,.1],[0,0,.1]]}
    def test_perfect(self):
        self.assertEqual(b.scores(self.pred([1.,0.,0.]),1,0),{"brier":0.,"log_loss":-0.,"ved":1,"exact":1,"top3":1})
    def test_brier(self):
        s=b.scores(self.pred([.5,.25,.25]),1,0)
        self.assertAlmostEqual(s["brier"],.375);self.assertAlmostEqual(s["log_loss"],math.log(2))
    def test_tie(self):
        self.assertEqual(b.scores(self.pred([.4,.4,.2]),1,0)["ved"],1)
    def test_invalid(self):
        with self.assertRaises(ValueError):b.scores(self.pred([.2,.2,.2]),1,0)
    def test_calibration(self):
        c=b.calibration([[1,0,0],[0,1,0]],[0,1]);self.assertEqual(c["macro_ece"],0.)
    def test_bootstrap_exact(self):
        p=self.pred([.5,.25,.25]);x=[(self.row(i),p,p) for i in range(12)]
        c=b.paired_ci(x);self.assertEqual(c["clusters"],12);self.assertEqual(c["intervals"]["brier"],[0.,0.]);self.assertEqual(c,b.paired_ci(x))
    def test_empty(self):
        self.assertEqual(b.summary([]),{"n":0})
    def test_min_xi(self):
        self.assertEqual(b.PROTOCOL["lineup"]["min_training"],b.f.MIN_N)
        self.assertFalse(b.PROTOCOL["lineup"]["operational"])
    def test_gate(self):
        p=self.pred([.5,.25,.25]);x=[(self.row(i),p,p) for i in range(12)]
        s={"all":b.summary(x),"ci":b.paired_ci(x)}
        self.assertFalse(b.gate({"2025":{"competitive":s},"2026":{"competitive":s}},s)["pass"])
if __name__=="__main__":unittest.main()
