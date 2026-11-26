import unittest,tempfile,tarfile,io
from pathlib import Path
import engine as e
def sample(t=0,value=1,pos="D"):
    return {"t":t,"available":t+e.LAG,"m":90,"pos":pos,"x":0,"year":2022,"features":{"passes":value,"duel_ratio":value},"row_id":str(t)}
class TestEngine(unittest.TestCase):
    def test_null_not_zero(self):
        r={"values":{"passes":0},"quality":{"passes":"explicit_zero"},"raw":{"passes":0},"raw_present":{"passes":True},"m":90}
        self.assertEqual(e.feature(r,"passes"),0);r["quality"]["passes"]="explicit_null";self.assertIsNone(e.feature(r,"passes"))
    def test_future_and_same_game_excluded(self):
        m={"D":{"passes":{"lo":0,"hi":10,"center":0,"beta":0,"sd":1}}}
        r=sample();future=sample(e.LAG*2,9)
        self.assertIsNone(e.profile([r,future],"D",0,m)["rating"])
        self.assertEqual(e.profile([r],"D",e.LAG,m),e.profile([r,future],"D",e.LAG,m))
    def test_shrink_and_partial(self):
        m={"D":{"passes":{"lo":0,"hi":10,"center":0,"beta":0,"sd":1}}}
        a=e.profile([sample()],"D",e.LAG,m);b=e.profile([sample() for _ in range(20)],"D",e.LAG,m)
        self.assertGreater(b["rating"],a["rating"]);self.assertGreater(b["confidence"],a["confidence"]);self.assertIsNone(a["defense"])
        self.assertTrue(a["partial_axes"])
    def test_gate_ignores_future(self):
        data=[]
        for y in (2022,2023):
            for i in range(110):
                r=sample(i,i%5);r["year"]=y;data.append(r)
        cut=e.LAG+200;m,a=e.fit(data,cut);self.assertIn("passes",m["D"])
        r=sample(cut+100,10000);r["year"]=2024
        self.assertEqual(e.fit(data,cut),e.fit(data+[r],cut))
        for r in data[:100]:r["features"]["passes"]=None
        self.assertNotIn("passes",e.fit(data,cut)[0]["D"])
    def test_archive_reject_traversal(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"a.tar"
            with tarfile.open(p,"w") as t:
                i=tarfile.TarInfo("../bad");i.size=1;t.addfile(i,io.BytesIO(b"x"))
            with self.assertRaises(ValueError):e.extract(p,Path(d)/"out")
    def test_rating_bounds(self):
        self.assertEqual(e.score(0),50)
        self.assertGreater(e.score(1),50);self.assertLess(e.score(-1),50)
if __name__=="__main__":unittest.main(verbosity=2)
