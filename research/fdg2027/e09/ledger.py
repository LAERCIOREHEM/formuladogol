"""E09.1 isolated reference ledger. No worker, network, push or production writes."""
import base64, contextlib, datetime as dt, hashlib, json, math, os, re, sqlite3, sys, time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/"e01"))
import foundation as f
VERSION="E09.1"
HEX=re.compile(r"^[0-9a-f]{64}$")
def raw(o):return json.dumps(o,sort_keys=True,separators=(",",":"),ensure_ascii=False,allow_nan=False).encode()
def sha(b):return hashlib.sha256(b).hexdigest()
def stamp(s):
    if not isinstance(s,str):raise ValueError("timestamp missing")
    d=dt.datetime.fromisoformat(s.replace("Z","+00:00"))
    if d.tzinfo is None:raise ValueError("timezone required")
    return int(d.timestamp()*1000)
def iso(t):return dt.datetime.fromtimestamp(t/1000,dt.timezone.utc).isoformat(timespec="milliseconds")
def hash_ok(s):return isinstance(s,str) and bool(HEX.fullmatch(s))
def forecast(blob):
    if not isinstance(blob,bytes) or not 0<len(blob)<=100000:raise ValueError("forecast bytes")
    p=json.loads(blob);v=p["probabilidades_pct"]
    nums=[v[k] for k in ("mandante","empate","visitante")]
    if any(type(x) not in (int,float) or not math.isfinite(x) or not 0<=x<=100 for x in nums) or abs(sum(nums)-100)>1e-7:raise ValueError("VED")
    rates=p["gols_esperados"]
    if any(type(rates[k]) not in (float,int) or not math.isfinite(rates[k]) or not 0<rates[k]<=12 for k in ("mandante","visitante")):raise ValueError("rates")
    top=p["placares_mais_provaveis"];modal=p["placar_modal"]
    if len(top)!=3 or len({(x["mandante"],x["visitante"]) for x in top})!=3 or any(type(x[k]) is not int or x[k]<0 or x[k]>100 for x in top for k in ("mandante","visitante")):raise ValueError("top3")
    chances=[x["probabilidade_pct"] for x in top]
    if any(type(x) not in (int,float) or not math.isfinite(x) or not 0<=x<=100 for x in chances) or any(a<b for a,b in zip(chances,chances[1:])) or any(modal[k]!=top[0][k] for k in ("mandante","visitante")):raise ValueError("modal")
    return p
def identity(season,provider,fixture):return f.identity("fixture",provider,fixture,season)
def lineup(p,home,away):
    if p["home_id"]!=home or p["away_id"]!=away:raise ValueError("team identity")
    a,b=p["home"],p["away"]
    if not isinstance(a,list) or not isinstance(b,list) or len(a)!=11 or len(b)!=11 or len(set(a+b))!=22:raise ValueError("22 unique IDs required")
    for v in a+b:f.token(v)
    return {"home_id":home,"away_id":away,"home":sorted(a),"away":sorted(b)}
class Ledger:
    def __init__(self,path,clock=None):
        p=Path(path).absolute();q=p.resolve()
        if p!=q or ROOT==q or ROOT in q.parents or q in ROOT.parents:raise ValueError("private external path")
        self.clock=clock or (lambda:time.time_ns()//1000000)
        self.db=sqlite3.connect(q,timeout=15,isolation_level=None)
        os.chmod(q,0o600)
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS fixtures(k TEXT PRIMARY KEY, meta BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS journal(k TEXT NOT NULL, seq INTEGER NOT NULL, body BLOB NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(k,seq), FOREIGN KEY(k) REFERENCES fixtures(k));
        CREATE TABLE IF NOT EXISTS receipts(k TEXT NOT NULL, event_id TEXT NOT NULL, signature TEXT NOT NULL, response BLOB NOT NULL, PRIMARY KEY(k,event_id), FOREIGN KEY(k) REFERENCES fixtures(k));
        CREATE TABLE IF NOT EXISTS cohort(k TEXT PRIMARY KEY, body BLOB NOT NULL, FOREIGN KEY(k) REFERENCES fixtures(k));
        CREATE TABLE IF NOT EXISTS manifest(id INTEGER PRIMARY KEY CHECK(id=1), body BLOB NOT NULL);
        """)
        for table in ("fixtures","journal","receipts","cohort","manifest"):
            for op in ("UPDATE","DELETE"):
                self.db.execute(f"CREATE TRIGGER IF NOT EXISTS {table}_{op} BEFORE {op} ON {table} BEGIN SELECT RAISE(ABORT,'append-only'); END")
    def close(self):self.db.close()
    @contextlib.contextmanager
    def tx(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:yield;self.db.execute("COMMIT")
        except BaseException:self.db.execute("ROLLBACK");raise
    def rows(self,k):
        rows=self.db.execute("SELECT seq,body,hash FROM journal WHERE k=? ORDER BY seq",(k,)).fetchall()
        prev=None;out=[]
        for i,(seq,b,h) in enumerate(rows,1):
            d=json.loads(b)
            if seq!=i or d["seq"]!=i or d["key"]!=k or d["previous"]!=prev or sha(b)!=h:raise ValueError("chain invalid")
            prev=h;out.append({**d,"hash":h})
        return out
    def add(self,k,kind,received,source,payload):
        rows=self.rows(k);prev=rows[-1]["hash"] if rows else None
        if rows and received<rows[-1]["received_ms"]:raise ValueError("clock rollback")
        d={"key":k,"seq":len(rows)+1,"previous":prev,"kind":kind,"received_ms":received,"source_ms":source,"payload":payload}
        b=raw(d);h=sha(b)
        self.db.execute("INSERT INTO journal VALUES(?,?,?,?)",(k,d["seq"],b,h))
        return {**d,"hash":h}
    def meta(self,k):
        row=self.db.execute("SELECT meta FROM fixtures WHERE k=?",(k,)).fetchone()
        if row is None:raise ValueError("unknown fixture")
        return json.loads(row[0])
    def state(self,k):
        rows=self.rows(k);snap=[r for r in rows if r["kind"] in ("initial","updated","xi_confirmed","xi_revised")]
        if not snap:raise ValueError("missing original")
        return rows,snap
    def register(self,season,provider,fixture,home,away,kickoff,source_at,blob):
        k=identity(season,provider,fixture);home=f.token(home);away=f.token(away)
        if home==away:raise ValueError("clubs")
        ko,src=stamp(kickoff),stamp(source_at);p=forecast(blob)
        if str(p["event_id"])!=fixture:raise ValueError("forecast fixture")
        m={"season":f.season(season),"provider":provider,"fixture":fixture,"home":home,"away":away,"kickoff_ms":ko}
        with self.tx():
            now=self.clock()
            if not src<=now<ko:raise ValueError("initial cutoff")
            old=self.db.execute("SELECT meta FROM fixtures WHERE k=?",(k,)).fetchone()
            if old:
                original=self.state(k)[1][0]
                if old[0]!=raw(m) or original["payload"]["forecast_sha256"]!=sha(blob):raise ValueError("immutable original conflict")
                return k
            self.db.execute("INSERT INTO fixtures VALUES(?,?)",(k,raw(m)))
            self.add(k,"initial",now,src,self.payload(blob,None))
        return k
    def payload(self,blob,xi):
        return {"model":"AF-Previsão 1.3","forecast_b64":base64.b64encode(blob).decode(),"forecast_sha256":sha(blob),"lineup_hash":xi,"delta":[0.,0.],"fallback":"E08_gate_not_passed","lineup_enabled":False,"public_write":False}
    def blob(self,s):
        b=base64.b64decode(s["payload"]["forecast_b64"],validate=True)
        if sha(b)!=s["payload"]["forecast_sha256"]:raise ValueError("forecast hash")
        return b
    def event(self,k,event_id,season,provider,fixture,kind,source_at,payload,expected_seq=None):
        if identity(season,provider,fixture)!=k:raise ValueError("cross fixture")
        f.token(event_id)
        if kind not in ("lineup","baseline","source_loss","rollback","kickoff"):raise ValueError("event kind")
        src=stamp(source_at) # must be source-provided; never substitute receipt.
        sig=sha(raw({"kind":kind,"source_ms":src,"payload":payload}))
        with self.tx():
            now=self.clock();m=self.meta(k);rows,snaps=self.state(k);last=snaps[-1]
            old=self.db.execute("SELECT signature,response FROM receipts WHERE k=? AND event_id=?",(k,event_id)).fetchone()
            if old:
                if old[0]!=sig:raise ValueError("event ID conflict")
                return {"status":"duplicate_event","original":json.loads(old[1])}
            if expected_seq is not None and expected_seq!=rows[-1]["seq"]:return {"status":"cas_conflict"}
            def done(status,rec=None):
                res={"status":status,"seq":rec["seq"] if rec else None}
                self.db.execute("INSERT INTO receipts VALUES(?,?,?,?)",(k,event_id,sig,raw(res)))
                return res
            if src>now or now<rows[-1]["received_ms"]:return done("invalid_clock")
            frozen=next((x for x in rows if x["kind"]=="frozen"),None)
            if frozen:return done("frozen")
            # Freeze at earliest observed kickoff or scheduled kickoff. Never change snapshots afterward.
            if kind=="kickoff" or now>=m["kickoff_ms"]:
                if kind=="kickoff" and src<rows[0]["source_ms"]:return done("stale_kickoff")
                cut=min(m["kickoff_ms"],src) if kind=="kickoff" else m["kickoff_ms"]
                valid=[x for x in snaps if x["received_ms"]<cut and x["source_ms"]<cut]
                rec=self.add(k,"frozen",now,src,{"original":snaps[0]["hash"],"latest":valid[-1]["hash"] if valid else None,"cutoff_ms":cut,"excluded_late_snapshots":len(snaps)-len(valid)})
                return done("frozen",rec)
            if src>=m["kickoff_ms"]:return done("late")
            if any(x["kind"]=="rollback" for x in rows):return done("rolled_back")
            if kind in ("source_loss","rollback"):
                rec=self.add(k,kind,now,src,{"reason":kind,"preserved_snapshot":last["hash"]})
                return done(kind,rec)
            if kind=="baseline":
                b=base64.b64decode(payload["forecast_b64"],validate=True);p=forecast(b)
                if str(p["event_id"])!=fixture or payload["model"]!="AF-Previsão 1.3":raise ValueError("baseline identity")
                if src<=max(x["source_ms"] for x in snaps if x["kind"] in ("initial","updated")):return done("stale_baseline")
                if sha(b)==last["payload"]["forecast_sha256"]:return done("duplicate_signature")
                rec=self.add(k,"updated",now,src,self.payload(b,last["payload"]["lineup_hash"]))
                return done("updated",rec)
            xi=lineup(payload,m["home"],m["away"]);h=sha(raw(xi))
            obs=[x for x in rows if x["kind"]=="xi_observed"]
            if obs and src<obs[-1]["source_ms"]:return done("stale_source")
            if obs and src==obs[-1]["source_ms"] and h!=obs[-1]["payload"]["lineup_hash"]:return done("source_conflict")
            if h==last["payload"]["lineup_hash"]:
                # A return to the confirmed XI cancels a pending different candidate.
                if not obs or obs[-1]["payload"]["lineup_hash"]!=h or src>obs[-1]["source_ms"]:self.add(k,"xi_observed",now,src,{"lineup_hash":h,"first_seen":now,"count":1,"xi":xi})
                return done("duplicate_signature")
            previous=obs[-1] if obs else None
            same=previous and previous["payload"]["lineup_hash"]==h and not any(x["kind"]=="source_loss" and x["seq"]>previous["seq"] for x in rows)
            first=previous["payload"]["first_seen"] if same else now
            count=previous["payload"]["count"]+1 if same else 1
            if same and now==previous["received_ms"]:return done("duplicate_observation")
            rec=self.add(k,"xi_observed",now,src,{"lineup_hash":h,"first_seen":first,"count":count,"xi":xi})
            if count<2 or now-first<20000:return done("pending",rec)
            typ="xi_revised" if last["payload"]["lineup_hash"] else "xi_confirmed"
            rec=self.add(k,typ,now,src,self.payload(self.blob(last),h))
            return done(typ,rec)
    def freeze_protocol(self,protocol_hash,baseline_hash,candidate_hash,trained_through,cohort_start):
        if not all(hash_ok(x) for x in (protocol_hash,baseline_hash,candidate_hash)):raise ValueError("hash")
        tr,cs=stamp(trained_through),stamp(cohort_start)
        with self.tx():
            now=self.clock()
            if not tr<now<cs:raise ValueError("prospective freeze chronology")
            b=raw({"season":"2027","protocol_hash":protocol_hash,"baseline_hash":baseline_hash,"candidate_hash":candidate_hash,"trained_through":tr,"cohort_start":cs,"frozen_at":now,"promotion":False})
            old=self.db.execute("SELECT body FROM manifest WHERE id=1").fetchone()
            if old:
                if old[0]!=b:raise ValueError("immutable protocol")
                return
            self.db.execute("INSERT INTO manifest VALUES(1,?)",(b,))
    def enroll(self,k,baseline_hash,candidate_hash,candidate_blob,source_at,feature_asof,eligible):
        # Called only by a future trusted adapter; no live adapter enabled by E09.
        src,feat=stamp(source_at),stamp(feature_asof)
        with self.tx():
            now=self.clock();m=self.meta(k);rows,snaps=self.state(k)
            man=self.db.execute("SELECT body FROM manifest WHERE id=1").fetchone()
            if not man:raise ValueError("unfrozen protocol")
            man=json.loads(man[0]);cut=m["kickoff_ms"]-86400000
            if m["season"]!="2027" or (baseline_hash,candidate_hash)!=(man["baseline_hash"],man["candidate_hash"]):raise ValueError("cohort identity")
            if not man["frozen_at"]<=now<=cut or not man["cohort_start"]<=m["kickoff_ms"] or not feat<=src<=now or not man["trained_through"]<cut or any(x["kind"] in ("frozen","rollback") for x in rows):raise ValueError("cohort cutoff")
            base=snaps[-1];b=self.blob(base)
            if base["received_ms"]>cut or base["source_ms"]>cut:raise ValueError("baseline cutoff")
            p=forecast(candidate_blob)
            if str(p["event_id"])!=m["fixture"]:raise ValueError("candidate identity")
            if type(eligible) is not bool or (not eligible and candidate_blob!=b):raise ValueError("prospective fallback")
            doc={"key":k,"cutoff_ms":cut,"received_ms":now,"source_ms":src,"feature_asof_ms":feat,"baseline_snapshot":base["hash"],"baseline_sha256":sha(b),"candidate_sha256":sha(candidate_blob),"candidate_b64":base64.b64encode(candidate_blob).decode(),"eligible":eligible,"protocol_sha256":sha(raw(man)),"shadow":True}
            self.db.execute("INSERT INTO cohort VALUES(?,?)",(k,raw(doc)))
            return sha(raw(doc))
