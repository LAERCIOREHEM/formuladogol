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
def validate_experimental(payload,certificate):
    if set(certificate)!={"schema","decision","version","source_run","source_artifact_sha256","data_sha256","owner_authorization","rights_status","semantic_status","identity_status","terms_url"}:raise ValueError("AFP experimental certificate shape")
    if certificate["schema"]!=1 or certificate["decision"]!="EXPERIMENTAL_OWNER_AUTHORIZED" or certificate["version"]!="AFP-R1.1" or certificate["source_run"]!=46063800576 or certificate["source_artifact_sha256"]!="e961baad5ba48ccceecb2b080d79200f1964bf54a0ad7d932326a4ffb4f19591":raise ValueError("AFP source")
    if certificate["owner_authorization"]!="2026-11-27T20:38:52Z" or certificate["rights_status"]!="TERMS_REVIEWED_NO_LICENSE_ASSERTED" or certificate["semantic_status"]!="EXPERIMENTAL" or certificate["identity_status"]!="UNIQUE_ROSTER_MATCH_NOT_VERIFIED" or certificate["terms_url"]!="https://www.api-football.com/terms":raise ValueError("AFP experimental disclosure")
    if certificate["data_sha256"]!=hashlib.sha256(payload).hexdigest():raise ValueError("AFP digest")
    d=json.loads(payload)
    if set(d)!={"schema","version","publication","as_of","seasons"} or d["schema"]!=1 or d["version"]!="AFP-R1.1" or d["publication"]!="EXPERIMENTAL_DERIVED" or set(d["seasons"])!={"2026"}:raise ValueError("AFP experimental schema")
    s=d["seasons"]["2026"]
    if set(s)!={"as_of","coverage","rows"} or not isinstance(s["as_of"],str) or not isinstance(d["as_of"],str) or s["coverage"]!={"catalogued":362,"detailed":340} or not 0<len(s["rows"])<=370:raise ValueError("AFP coverage")
    fields={"name","club","position","rating","confidence","percentile","position_rank","minute_band","offense","defense","partial_axes"}
    seen=set();groups={}
    for r in s["rows"]:
        if set(r)!=fields or r["position"] not in ("G","D","M","F") or not all(isinstance(r[k],str) and 0<len(r[k])<=128 for k in ("name","club")):raise ValueError("AFP fields")
        key=(r["name"].casefold(),r["club"].casefold(),r["position"])
        if key in seen:raise ValueError("AFP ambiguous identity")
        seen.add(key)
        if not all(number(r[k]) for k in ("rating","confidence","percentile")) or r["confidence"]<25 or r["minute_band"] not in (450,900,1350,1800) or type(r["position_rank"]) is not int:raise ValueError("AFP experimental scores")
        if not all(r[k] is None or number(r[k]) for k in ("offense","defense")) or type(r["partial_axes"]) is not bool or r["partial_axes"]!=(r["offense"] is None or r["defense"] is None):raise ValueError("AFP axes")
        groups.setdefault(r["position"],[]).append(r)
    for g in groups.values():
        g.sort(key=lambda r:r["rating"])
        i=0
        while i<len(g):
            j=i+1
            while j<len(g) and g[j]["rating"]==g[i]["rating"]:j+=1
            for r in g[i:j]:
                if r["position_rank"]!=len(g)-j+1 or abs(r["percentile"]-round(100*(i+j)/(2*len(g)),3))>0.0001:raise ValueError("AFP experimental rank")
            i=j
    return d
def approved_payload(root=AFP):
    cert=root/"approved-release.json";data=root/"approved-ranking.json"
    if not cert.exists() and not data.exists():return None
    if not cert.is_file() or not data.is_file() or cert.is_symlink() or data.is_symlink():raise ValueError("AFP incomplete release")
    payload=data.read_bytes()
    certificate=json.loads(cert.read_text())
    if certificate.get("decision")=="EXPERIMENTAL_OWNER_AUTHORIZED":validate_experimental(payload,certificate)
    else:validate(payload,certificate)
    return payload
