import unittest,tempfile
from pathlib import Path
import canonical as c
class TestCanonical(unittest.TestCase):
    def test_semantics(self):
        for k,v,p,w in [("goals",None,True,(None,"explicit_null")),("goals",None,False,(None,"absent")),("goals",0,True,(0,"explicit_zero")),("goals",True,True,(None,"invalid_shape")),("pass_accuracy",34,True,(None,"unit_or_definition_unverified")),("minutes",95,True,(None,"minute_convention_unverified")),("minutes",0,True,(0,"zero_exposure")),("starter",False,True,(True,"valid_shape")),("rating","7.5",True,(7.5,"benchmark_only"))]:self.assertEqual(c.normalize(k,v,p),w)
    def test_row(self):
        p={"player":{"id":1,"name":"Test"}};s={"games":{"position":"F","minutes":90,"substitute":False},"goals":{"total":0},"shots":{"total":1,"on":2}}
        r=c.row("2026","3","2",p,s,"x","y","B")
        self.assertEqual(r["raw"]["shots_on_target"],2);self.assertIsNone(r["values"]["shots_on_target"]);self.assertEqual(r["values"]["goals"],0)
        self.assertFalse(r["raw_present"]["assists"]);self.assertFalse(r["af_player_exploratory_candidate"]);self.assertFalse(r["pregame_availability_certified"])
        s["shots"]["on"]=1;self.assertTrue(c.row("2026","3","2",p,s,"x","y","B")["af_player_exploratory_candidate"])
        s["games"]["minutes"]=0;self.assertFalse(c.row("2026","3","2",p,s,"x","y","B")["individual_core_valid"])
    def test_identity(self):
        r=c.row("2026","3","2",{"player":{"id":1,"name":"Test"}},{"games":{"position":"F","minutes":90,"substitute":False}},"x","y","B")
        idx=c.roster_index({"elencos":{"Bahia":[{"id":"123","nome":"Test","posicao":"Atacante"}]}})
        x=c.identity_review("2026",[r],{r["club_id"]:"Bahia"},idx)[0]
        self.assertEqual(x["mapping_status"],"review_unique_name_club_position");self.assertIsNone(x["verified_cross_provider_id"])
    def test_determinism(self):
        with tempfile.TemporaryDirectory() as d:
            a=Path(d)/"a";b=Path(d)/"b";c.write(a,{"b":0,"a":None});c.write(b,{"a":None,"b":0});self.assertEqual(c.sha(a),c.sha(b))
            with self.assertRaises(FileExistsError):c.write(a,{})
        self.assertEqual(c.timestamp("2026-01-01T09:00:00-03:00"),"2026-01-01T12:00:00+00:00")
    def test_binding(self):
        with self.assertRaises(ValueError):c.build({},{"input_sha256":"wrong"},{},"x",Path("/tmp/not-written"),"expected","roster")
if __name__=="__main__":unittest.main(verbosity=2)
