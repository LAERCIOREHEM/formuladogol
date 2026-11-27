"""Owner-authorized publication of original analytical scores, not provider statistics."""
import collections as C,hashlib,json,re,sys,unicodedata
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
def norm(s):return " ".join(re.sub(r"[^a-z0-9]+"," ",unicodedata.normalize("NFKD",str(s or "")).encode("ascii","ignore").decode().lower()).split())
def read(p):return json.loads(p.read_text(encoding="utf8"))
def encode(d):return (json.dumps(d,ensure_ascii=False,sort_keys=True,separators=(",",":"),allow_nan=False)+"\n").encode()
def export(source,roster,out):
    assert source["publication"]=="PRIVATE_RESEARCH" and source["version"]=="AFP-R1.1"
    s=source["seasons"]["2026"];assert s["coverage"]["catalogued"]==362 and s["coverage"]["detailed"]==340 and sum(r["eligible"] for r in s["rows"])==370
    roles={"goleiro":"G","defensor":"D","meio campista":"M","meia":"M","atacante":"F"}
    idx=C.defaultdict(list)
    for club,players in roster["elencos"].items():
        for p in players:
            role=roles.get(norm(p.get("posicao")))
            if role and p.get("id"):idx[(norm(club),norm(p["nome"]),role)].append((str(p["id"]),club,p["nome"]))
    candidates=[]
    for r in s["rows"]:
        if not r["eligible"] or r["identity_review"]!="candidate_unique":continue
        hits=idx[(norm(r["club"]),norm(r["name"]),r["position"])]
        if len(hits)!=1:continue
        pid,club,name=hits[0]
        row={k:r[k] for k in ("position","rating","confidence","offense","defense","partial_axes")}
        row.update(name=name,club=club,minute_band=max(x for x in (450,900,1350,1800) if r["season_minutes"]>=x))
        candidates.append((pid,row))
    counts=C.Counter(pid for pid,r in candidates)
    rows=[r for pid,r in candidates if counts[pid]==1]
    for pos in ("G","D","M","F"):
        g=sorted((r for r in rows if r["position"]==pos),key=lambda r:r["rating"]);i=0
        assert g
        while i<len(g):
            j=i+1
            while j<len(g) and g[j]["rating"]==g[i]["rating"]:j+=1
            for r in g[i:j]:r.update(position_rank=len(g)-j+1,percentile=round(100*(i+j)/(2*len(g)),3))
            i=j
    rows.sort(key=lambda r:(-r["percentile"],r["position"],-r["rating"],r["name"]))
    payload=encode({"schema":1,"version":"AFP-R1.1","publication":"EXPERIMENTAL_DERIVED","as_of":source["as_of"],"seasons":{"2026":{"as_of":s["as_of"],"coverage":{"catalogued":362,"detailed":340},"rows":rows}}})
    cert={"schema":1,"decision":"EXPERIMENTAL_OWNER_AUTHORIZED","version":"AFP-R1.1","source_run":46063800576,"source_artifact_sha256":"e961baad5ba48ccceecb2b080d79200f1964bf54a0ad7d932326a4ffb4f19591","data_sha256":hashlib.sha256(payload).hexdigest(),"owner_authorization":"2026-11-27T20:38:52Z","rights_status":"TERMS_REVIEWED_NO_LICENSE_ASSERTED","semantic_status":"EXPERIMENTAL","identity_status":"UNIQUE_ROSTER_MATCH_NOT_VERIFIED","terms_url":"https://www.api-football.com/terms"}
    sys.path.insert(0,str(ROOT/"research/fdg2027/sl02-release"))
    from afp_public import validate_experimental
    validate_experimental(payload,cert)
    out.mkdir(parents=True,exist_ok=True)
    (out/"approved-ranking.json").write_bytes(payload);(out/"approved-release.json").write_bytes(encode(cert))
    print("AFP experimental export: "+json.dumps({"eligible_private":370,"published":len(rows),"roles":dict(C.Counter(r["position"] for r in rows)),"sha256":cert["data_sha256"]}))
if __name__=="__main__":export(read(Path(sys.argv[1])),read(ROOT/"dados-br/elencos.json"),Path(sys.argv[2]))
