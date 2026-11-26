import unittest
from certification import *
class Test(unittest.TestCase):
    def test_unknown_blocks(self):self.assertEqual(len(decide({})["blocked"]),len(GATES))
    def test_truthiness_not_authority(self):self.assertFalse(decide(dict.fromkeys(GATES,1))["production_ready"])
    def test_each_gate_required(self):
        for k in GATES:
            e=dict.fromkeys(GATES,True);e[k]=False
            self.assertEqual(decide(e)["blocked"],[k])
    def test_no_activation_even_with_all_gates(self):
        d=decide(dict.fromkeys(GATES,True));self.assertTrue(d["production_ready"]);self.assertFalse(d["activation_performed"]);self.assertFalse(d["promotion_performed"]);self.assertEqual(d["current"],CURRENT)
    def test_rollback(self):self.assertTrue(rollback_drill()["reference_flag_restore"])
    def test_repository(self):self.assertEqual(repository_core()["clubs"],20)
    def test_tampered_manifest(self):
        m=jsonfile(ROOT/"dados-br/af-core-manifest.json");s=jsonfile(ROOT/"dados-br/af-core-snapshot.json");m["revision"]="0"*64
        with self.assertRaises(AssertionError):validate_core(m,s)
    def test_duplicate_fixture(self):
        m=jsonfile(ROOT/"dados-br/af-core-manifest.json");s=jsonfile(ROOT/"dados-br/af-core-snapshot.json");rows=s["files"]["resultados.json"]["resultados"];rows[1]["event_id"]=rows[0]["event_id"]
        with self.assertRaises(AssertionError):validate_core(m,s)
    def test_cross_model(self):
        m=jsonfile(ROOT/"dados-br/af-core-manifest.json");s=jsonfile(ROOT/"dados-br/af-core-snapshot.json");s["files"][CORE[7]]["versao_modelo"]="AF-Previsão 2.0"
        with self.assertRaises(AssertionError):validate_core(m,s)
    def test_season(self):
        with self.assertRaises(ValueError):f.public_season(2027)
        self.assertEqual(f.continental_rule_state(2027),"unverified")
if __name__=="__main__":unittest.main()
