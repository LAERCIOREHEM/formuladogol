"""E11 isolated transactional governance; no provider, Cloudflare or mail transport."""
import contextlib, datetime as dt, hashlib, json, math, os, sqlite3, sys, time
from pathlib import Path
from zoneinfo import ZoneInfo
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[2]
sys.path.insert(0,str(HERE.parent/"e01"))
import foundation as f
P=json.loads((HERE/"policy.json").read_text())
def raw(x):return json.dumps(x,sort_keys=True,separators=(",",":"),allow_nan=False).encode()
def sha(x):return hashlib.sha256(raw(x)).hexdigest()
def day(t):return dt.datetime.fromtimestamp(t,dt.timezone.utc).date().isoformat()
def month(t):return day(t)[:7]
def br(t):return dt.datetime.fromtimestamp(t,ZoneInfo(P["report_timezone"]))
def integer(x):return type(x) is int and x>=0
def num(x):return type(x) in (int,float) and math.isfinite(x) and x>=0
def mode(cost,t):
    fresh=cost and 0<=t-cost["at"]<=P["cost"]["stale_seconds"]
    c=P["cost"];v=cost.get("daily_usd") if fresh else None
    d1=bool(fresh and ((cost.get("d1_reads") is not None and cost["d1_reads"]>=c["d1_reads_warning"]) or (cost.get("d1_writes") is not None and cost["d1_writes"]>=c["d1_writes_warning"])))
    m="secondary_paused" if d1 or v is not None and v>=c["secondary_pause_usd"] else "optional_paused" if v is not None and v>=c["optional_pause_usd"] else "observe" if v is not None and v>=c["observe_usd"] else "normal" if v is not None else "unverified"
    return {"mode":m,"essential_allowed":True,"optional_allowed":m not in ("optional_paused","secondary_paused"),"secondary_allowed":m!="secondary_paused","billing_verified":v is not None,"daily_usd":v,"month_usd":cost.get("month_usd") if fresh else None,"monthly_warning":bool(fresh and cost.get("projected_usd") is not None and cost["projected_usd"]>=c["monthly_projection_warning"]),"d1_anomaly":d1,"as_of":cost["at"] if cost else None,"metrics":{k:cost.get(k) if fresh else None for k in ("d1_reads","d1_writes","worker_cpu_ms","worker_requests")}}
class Governance:
    def __init__(self,path,clock=None):
        p=Path(path).absolute();q=p.resolve()
        if p!=q or q==ROOT or ROOT in q.parents or q in ROOT.parents:raise ValueError("external private workspace required")
        self.clock=clock or (lambda:int(time.time()))
        self.db=sqlite3.connect(q,timeout=15,isolation_level=None);os.chmod(q,0o600)
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS quota(provider TEXT PRIMARY KEY, body BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, key TEXT NOT NULL, provider TEXT NOT NULL, lane TEXT NOT NULL, t INT NOT NULL, units INT NOT NULL, attempt INT NOT NULL, status TEXT NOT NULL, finished INT, retry_at INT, UNIQUE(key,attempt));
        CREATE INDEX IF NOT EXISTS calls_usage ON calls(provider,t,lane);
        CREATE TABLE IF NOT EXISTS circuits(provider TEXT PRIMARY KEY, reason TEXT NOT NULL, until_t INT NOT NULL);
        CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY, body BLOB NOT NULL, hash TEXT NOT NULL, expiry INT NOT NULL);
        CREATE TABLE IF NOT EXISTS checkpoints(key TEXT PRIMARY KEY, cursor TEXT NOT NULL, version INT NOT NULL, done INT NOT NULL);
        CREATE TABLE IF NOT EXISTS cost(id INTEGER PRIMARY KEY CHECK(id=1),body BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,body BLOB NOT NULL);
        """)
    def close(self):self.db.close()
    @contextlib.contextmanager
    def tx(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:yield;self.db.execute("COMMIT")
        except BaseException:self.db.execute("ROLLBACK");raise
    def read(self,sql,args=()):
        row=self.db.execute(sql,args).fetchone();return json.loads(row[0]) if row else None
    def put(self,table,key,body):
        self.db.execute(f"INSERT INTO {table} VALUES(?,?) ON CONFLICT DO UPDATE SET body=excluded.body",(key,raw(body)))
    def observe_quota(self,provider,headers,source_at,verified):
        # Trusted adapter required; never infer missing header values or query provider automatically.
        if provider not in ("api-football","strikerapi") or verified is not True:raise ValueError("quota evidence")
        now=self.clock()
        if not integer(source_at) or not 0<=now-source_at<=P["quota_fresh_seconds"]:raise ValueError("quota stale")
        h={str(k).lower():v for k,v in headers.items()}
        def parse(k):
            v=h.get(k)
            if type(v) is str and v.isascii() and v.isdecimal():v=int(v)
            if not integer(v):raise ValueError("missing or invalid header")
            return v
        if provider=="api-football":
            lim,rem,ml,mr=[parse(k) for k in ("x-ratelimit-requests-limit","x-ratelimit-requests-remaining","x-ratelimit-limit","x-ratelimit-remaining")]
            if rem>lim or mr>ml or not lim or not ml:raise ValueError("inconsistent headers")
            body={"at":source_at,"period":day(now),"limit":lim,"remaining":rem,"minute_limit":ml,"minute_remaining":mr,"minute":source_at//60}
        else:
            # Normalized trusted account evidence, NOT claimed actual StrikerAPI header names.
            lim,rem=parse("verified-monthly-limit"),parse("verified-monthly-remaining")
            if not lim or rem>lim:raise ValueError("balance")
            body={"at":source_at,"period":month(now),"limit":lim,"remaining":rem}
        with self.tx():
            old=self.read("SELECT body FROM quota WHERE provider=?",(provider,))
            if old and source_at<=old["at"]:raise ValueError("nonmonotonic quota evidence")
            if old and body["period"]==old["period"]:body["remaining"]=min(body["remaining"],old["remaining"])
            if old and provider=="api-football" and body["minute"]==old["minute"]:body["minute_remaining"]=min(body["minute_remaining"],old["minute_remaining"])
            self.put("quota",provider,body)
    def key(self,season,provider,fixture,operation,revision):
        # The operation contract must bind every response-affecting parameter in revision.
        for v in (fixture,operation,revision):f.token(v)
        if provider not in ("api-football","strikerapi"):raise ValueError("provider")
        return f.namespace(season,"cache",sha([provider,fixture,operation,revision]))
    def cost(self):return mode(self.read("SELECT body FROM cost WHERE id=1"),self.clock())
    def observe_cost(self,at,**metrics):
        allowed=("daily_usd","month_usd","projected_usd","d1_reads","d1_writes","worker_cpu_ms","worker_requests")
        if set(metrics)-set(allowed) or not integer(at) or at>self.clock() or any(v is not None and not num(v) for v in metrics.values()):raise ValueError("cost observation")
        body={"at":at,**{k:metrics.get(k) for k in allowed}}
        with self.tx():
            old=self.read("SELECT body FROM cost WHERE id=1")
            if old and old["at"]>=at:raise ValueError("stale cost")
            self.put("cost",1,body)
            d=mode(body,self.clock());severity={"optional_paused":2,"secondary_paused":3}.get(d["mode"])
            if severity:self.alert("cost:"+br(self.clock()).date().isoformat()+":"+str(severity),{"kind":"cost","mode":d["mode"],"essential_allowed":True})
    def alert(self,key,body):
        self.db.execute("INSERT OR IGNORE INTO outbox VALUES(?,?)",(key,raw(body)))
    def usage(self,provider,start,lane=None):
        q="SELECT COALESCE(SUM(units),0) FROM calls WHERE provider=? AND t>=?"
        args=[provider,start]
        if lane:q+=" AND lane=?";args.append(lane)
        return self.db.execute(q,args).fetchone()[0]
    def reserve(self,call_id,season,provider,fixture,operation,revision,lane="research",attempt=1):
        f.token(call_id)
        if lane not in ("research","operational") or attempt not in (1,2):raise ValueError("lane/attempt")
        if provider in P["essential"]:return {"status":"essential_bypass","allowed":True,"reservation":False}
        k=self.key(season,provider,fixture,operation,revision);now=self.clock()
        if provider=="strikerapi" and operation!="get_game":raise ValueError("unsupported credit contract")
        units=5 if provider=="strikerapi" else 1
        def deny(reason):return {"status":reason,"allowed":False}
        with self.tx():
            old=self.db.execute("SELECT key,provider,lane,attempt,status FROM calls WHERE id=?",(call_id,)).fetchone()
            if old:
                if old[:4]!=(k,provider,lane,attempt):raise ValueError("idempotency conflict")
                return deny("duplicate_reservation")
            c=self.db.execute("SELECT body,hash,expiry FROM cache WHERE key=?",(k,)).fetchone()
            if c and now<c[2]:
                body=json.loads(c[0])
                if sha(body)!=c[1]:raise ValueError("cache corruption")
                return {"status":"cache_hit","allowed":False,"data":body}
            prev=self.db.execute("SELECT attempt,status,retry_at,lane FROM calls WHERE key=? ORDER BY attempt DESC LIMIT 1",(k,)).fetchone()
            if prev and (prev[0]+1!=attempt or prev[1] not in ("timeout","transient") or now<prev[2] or prev[3]!=lane):return deny("inflight_or_retry_blocked")
            if not prev and attempt!=1:return deny("missing_first_attempt")
            if not self.cost()["optional_allowed"]:return deny("cost_containment")
            circuit=self.db.execute("SELECT reason,until_t FROM circuits WHERE provider=?",(provider,)).fetchone()
            if circuit and now<circuit[1]:return deny("circuit_"+circuit[0])
            quota=self.read("SELECT body FROM quota WHERE provider=?",(provider,))
            if not quota or not 0<=now-quota["at"]<=P["quota_fresh_seconds"] or quota["period"]!=(day(now) if provider=="api-football" else month(now)):return deny("quota_unverified")
            if provider=="api-football":
                start=int(dt.datetime.fromisoformat(day(now)).replace(tzinfo=dt.timezone.utc).timestamp());p=P["football"]
                if self.usage(provider,start)+units>p["local_shared_day"] or self.usage(provider,start,lane)+units>p["local_"+lane+"_day"]:return deny("local_daily_limit")
                if quota["remaining"]-units<p["remaining_reserve"]:return deny("provider_reserve")
                if quota["minute"]!=now//60 or quota["minute_remaining"]<units:return deny("minute_unverified_or_empty")
                if self.usage(provider,now//60*60)+units>min(p["local_minute"],quota["minute_limit"]) or self.usage(provider,now)+units>p["local_second"]:return deny("local_rate_limit")
                quota["minute_remaining"]-=units
            else:
                # No live use in E11. A verified normalized balance is insufficient to activate it.
                return deny("striker_live_disabled")
            quota["remaining"]-=units;self.put("quota",provider,quota)
            self.db.execute("INSERT INTO calls VALUES(?,?,?,?,?,?,?,?,?,?)",(call_id,k,provider,lane,now,units,attempt,"reserved",None,None))
            return {"status":"reserved","allowed":True,"reservation":True,"key":k,"units":units}
    def finish(self,call_id,status,data=None,ttl=300,retry_after=None):
        if status not in ("ok","timeout","transient","429","quota","suspended","auth","invalid"):raise ValueError("status")
        now=self.clock()
        with self.tx():
            row=self.db.execute("SELECT key,provider,status,attempt,t FROM calls WHERE id=?",(call_id,)).fetchone()
            if not row:raise ValueError("unknown reservation")
            k,p,old,attempt,started=row
            if old!="reserved":return {"status":"duplicate_completion"}
            if now<started:raise ValueError("clock")
            retry=now+P["backoff_seconds"]*2**(attempt-1) if status in ("timeout","transient") else None
            if status=="ok":
                if not isinstance(data,dict) or len(raw(data))>1000000 or type(ttl) is not int or not 0<ttl<=P["cache_max_seconds"]:raise ValueError("cache contract")
                if data.get("competition")!="bra.1" or data.get("cache_key")!=k:raise ValueError("response identity")
                self.db.execute("INSERT INTO cache VALUES(?,?,?,?) ON CONFLICT DO UPDATE SET body=excluded.body,hash=excluded.hash,expiry=excluded.expiry",(k,raw(data),sha(data),now+ttl))
            if status in ("429","quota","suspended","auth"):
                if status=="429":
                    delay=retry_after if integer(retry_after) else 60;until=now+max(60,delay)
                else:until=253402300799 # explicit reconciliation, never automatic reopen
                self.db.execute("INSERT INTO circuits VALUES(?,?,?) ON CONFLICT DO UPDATE SET reason=excluded.reason,until_t=MAX(circuits.until_t,excluded.until_t)",(p,status,until))
                self.alert("provider:"+p+":"+day(now)+":"+status,{"kind":"provider","provider":p,"reason":status})
            self.db.execute("UPDATE calls SET status=?,finished=?,retry_at=? WHERE id=?",(status,now,retry,call_id))
            return {"status":status,"retry_at":retry if attempt<P["max_attempts"] else None}
    def reconcile(self,provider,verified,reason):
        # Administrative shadow acknowledgement; evidence must be fresh, no reset of counters.
        if verified is not True or not isinstance(reason,str) or not reason.strip():raise ValueError("explicit evidence")
        with self.tx():
            now=self.clock();q=self.read("SELECT body FROM quota WHERE provider=?",(provider,))
            if not q or not 0<=now-q["at"]<=P["quota_fresh_seconds"] or q["remaining"]<=P["football"]["remaining_reserve"] or q["period"]!=(day(now) if provider=="api-football" else month(now)):raise ValueError("quota not recovered")
            self.db.execute("DELETE FROM circuits WHERE provider=?",(provider,))
            self.alert("reconcile:"+provider+":"+str(now),{"kind":"reconciled","provider":provider})
    def checkpoint(self,season,job,expected,cursor,done=False):
        k=f.namespace(season,"workflow",job);f.token(cursor)
        if type(expected) is not int or expected<0 or type(done) is not bool:raise ValueError("checkpoint")
        with self.tx():
            old=self.db.execute("SELECT cursor,version,done FROM checkpoints WHERE key=?",(k,)).fetchone()
            if old and (old[1]!=expected or old[2] or old[0]==cursor):return False
            if not old and expected!=0:return False
            self.db.execute("INSERT INTO checkpoints VALUES(?,?,?,?) ON CONFLICT DO UPDATE SET cursor=excluded.cursor,version=excluded.version,done=excluded.done",(k,cursor,expected+1,int(done)))
            return True
    def digest(self,coverage=None,pending=None,health=None):
        now=self.clock();b=br(now)
        if not P["report_hour"]<=b.hour<P["report_recovery_end"]:return None
        key="digest:"+b.date().isoformat()
        with self.tx():
            if self.db.execute("SELECT 1 FROM outbox WHERE id=?",(key,)).fetchone():return None
            start=int(dt.datetime.fromisoformat(day(now)).replace(tzinfo=dt.timezone.utc).timestamp());ms=int(dt.datetime.fromisoformat(month(now)+"-01").replace(tzinfo=dt.timezone.utc).timestamp())
            d={"date_brt":b.date().isoformat(),"day_utc":day(now),"health":health,"coverage":coverage,"pending":pending,"cost":self.cost(),"provider_usage":{p:{"day":self.usage(p,start),"month":self.usage(p,ms),"observed_quota":self.read("SELECT body FROM quota WHERE provider=?",(p,))} for p in ("api-football","strikerapi")},"alerts":self.db.execute("SELECT COUNT(*) FROM outbox WHERE id NOT LIKE 'digest:%'").fetchone()[0],"delivery":"shadow_outbox_only"}
            self.alert(key,d);return d
