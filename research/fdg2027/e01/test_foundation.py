import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
import foundation as f

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]

class FoundationTest(unittest.TestCase):
    def test_contract(self):
        for name, args, expected in json.loads((HERE/"test-vectors.json").read_text()):
            with self.subTest(name=name,args=args):
                if expected is None:
                    with self.assertRaises((ValueError,TypeError)):
                        getattr(f,name)(*args)
                else:
                    self.assertEqual(getattr(f,name)(*args),expected)

    def test_legacy_aliases_exist(self):
        for name in f.REG["legacy_assets"]:
            self.assertTrue((REPO/f.legacy_read_path(2026,name)).is_file(),name)
        self.assertFalse(f.REG["public_switch_enabled"])
        self.assertFalse(f.REG["production_write_enabled"])

    def test_private_paths_and_isolation(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)/"private"
            root.mkdir()
            paths = [f.private_path(root,REPO,y,"player_matches") for y in (2026,2027)]
            for y,p in zip((2026,2027),paths):
                p.parent.mkdir(parents=True)
                p.write_text(json.dumps({"competition":"bra.1","season":y}))
            self.assertNotEqual(*paths)
            for y,p in zip((2026,2027),paths):
                f.validate_envelope(y,json.loads(p.read_text()))
            with self.assertRaises(ValueError):
                f.private_path(REPO/"data",REPO,2027,"player_matches")
            target=paths[1].parent/"snapshot.json"
            target.symlink_to(paths[0])
            with self.assertRaises(ValueError):
                f.private_path(root,REPO,2027,"snapshot")

    def test_sqlite_namespace_collision(self):
        with sqlite3.connect(":memory:") as db:
            db.execute("CREATE TABLE shadow_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
            for y in (2026,2027):
                for domain in f.REG["namespace_domains"]:
                    db.execute("INSERT INTO shadow_state VALUES (?,?)",(f.namespace(y,domain,"same-id"),str(y)))
            for y in (2026,2027):
                for domain in f.REG["namespace_domains"]:
                    self.assertEqual(db.execute("SELECT v FROM shadow_state WHERE k=?",(f.namespace(y,domain,"same-id"),)).fetchone()[0],str(y))

if __name__=="__main__":
    unittest.main(verbosity=2)
