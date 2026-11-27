"""Fail-closed AFP delivery adapter. No public data exists until separately approved."""
import hashlib,json,math,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
AFP=ROOT/"research/fdg2027/afp-r1"
HEX=re.compile(r"^[0-9a-f]{64}$")
FIELDS={"name","club","position","rating","confidence","percentile","position_rank","season_minutes","season_games","offense","defense","partial_axes"}
def number(v):return type(v) in (int,float) and math.isfinite(v) and 0<=v<=100
def validate(payload,certificate):
    if certificate.get("schema")!=1 or certificate.get("decision")!="APPROVED" or certificate.get("version")!="AFP-R1.1":raise ValueError("AFP release not approved")
    for k in ("rights_review","identity_review","semantic_review","owner_release_authorization"):
        v=certificate.get(k)
        if not isinstance(v,dict) or v.get("approved") is not True or not isinstance(v.get("evidence_sha256"),str) or not HEX.fullmatch(v["evidence_sha256"]):raise ValueError("AFP evidence missing: "+k)
    if certificate.get("data_sha256")!=hashlib.sha256(payload).hexdigest():raise ValueError("AFP release digest")
    d=json.loads(payload)
    if set(d)!={"schema","version","publication","as_of","seasons"} or d["schema"]!=1 or d["version"]!="AFP-R1.1" or d["publication"]!="CERTIFIED_DERIVED" or not isinstance(d["as_of"],str):raise ValueError("AFP public schema")
    if "2026" not in d["seasons"] or not d["seasons"]["2026"]["rows"]:raise ValueError("AFP current ranking missing")
    for y,s in d["seasons"].items():
        if y not in ("2024","2025","2026") or set(s)!={"as_of","coverage","rows"} or not isinstance(s["as_of"],str) or set(s["coverage"])!={"catalogued","detailed"}:raise ValueError("AFP season schema")
        c=s["coverage"]
        if not all(type(c[k]) is int for k in c) or not 0<c["detailed"]<=c["catalogued"]<=380:raise ValueError("AFP coverage")
        seen=set();groups={}
        for r in s["rows"]:
            if set(r)!=FIELDS or not all(isinstance(r[k],str) and 0<len(r[k])<=128 for k in ("name","club")) or r["position"] not in ("G","D","M","F"):raise ValueError("AFP row schema")
            key=(r["name"].casefold(),r["club"].casefold(),r["position"])
            if key in seen:raise ValueError("AFP duplicate identity")
            seen.add(key)
            if not all(number(r[k]) for k in ("rating","confidence","percentile")) or r["confidence"]<25:raise ValueError("AFP scores")
            if not all(r[k] is None or number(r[k]) for k in ("offense","defense")) or type(r["partial_axes"]) is not bool or r["partial_axes"]!=(r["offense"] is None or r["defense"] is None):raise ValueError("AFP axes")
            if not all(type(r[k]) is int and r[k]>=1 for k in ("position_rank","season_minutes","season_games")) or r["season_minutes"]<450 or r["season_minutes"]>90*r["season_games"] or r["season_games"]>38:raise ValueError("AFP exposure")
            groups.setdefault(r["position"],[]).append(r)
        for g in groups.values():
            g.sort(key=lambda r:r["rating"])
            i=0
            while i<len(g):
                j=i+1
                while j<len(g) and g[j]["rating"]==g[i]["rating"]:j+=1
                for r in g[i:j]:
                    if r["position_rank"]!=len(g)-j+1 or abs(r["percentile"]-round(100*(i+j)/(2*len(g)),3))>0.0001:raise ValueError("AFP rank integrity")
                i=j
    return d
def approved_payload(root=AFP):
    cert=root/"approved-release.json";data=root/"approved-ranking.json"
    if not cert.exists() and not data.exists():return None
    if not cert.is_file() or not data.is_file() or cert.is_symlink() or data.is_symlink():raise ValueError("AFP incomplete release")
    payload=data.read_bytes()
    validate(payload,json.loads(cert.read_text()))
    return payload
