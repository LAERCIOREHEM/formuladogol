import hashlib,json,tempfile,unittest
from pathlib import Path
from afp_public import approved_payload,validate
def fixture():
    r={"name":"Synthetic test only","club":"Synthetic club","position":"G","rating":55,"confidence":40,"percentile":50,"position_rank":1,"season_minutes":450,"season_games":5,"offense":None,"defense":55,"partial_axes":True}
    b=json.dumps({"schema":1,"version":"AFP-R1.1","publication":"CERTIFIED_DERIVED","as_of":"2026-11-25T00:00:00Z","seasons":{"2026":{"as_of":"2026-11-25T00:00:00Z","coverage":{"catalogued":360,"detailed":338},"rows":[r]}}}).encode()
    c={"schema":1,"version":"AFP-R1.1","decision":"APPROVED","data_sha256":hashlib.sha256(b).hexdigest()}
    for k in ("rights_review","identity_review","semantic_review","owner_release_authorization"):c[k]={"approved":True,"evidence_sha256":"a"*64}
    return b,c
class Contract(unittest.TestCase):
    def test_absent(self):
        with tempfile.TemporaryDirectory() as d:self.assertIsNone(approved_payload(Path(d)))
    def test_integrity(self):
        b,c=fixture();self.assertTrue(validate(b,c))
        with self.assertRaises(ValueError):validate(b+b" ",c)
        c["rights_review"]["approved"]=False
        with self.assertRaises(ValueError):validate(b,c)
    def test_raw_rejected(self):
        b,c=fixture();o=json.loads(b);o["seasons"]["2026"]["rows"][0]["provider_id"]="private"
        b=json.dumps(o).encode();c["data_sha256"]=hashlib.sha256(b).hexdigest()
        with self.assertRaises(ValueError):validate(b,c)
if __name__=="__main__":unittest.main()
