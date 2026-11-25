"""FDG 2027 E02: bounded, read-only player-data discovery. No production writes."""
import argparse
import collections
import datetime as dt
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

YEARS = (2022, 2023, 2024, 2025, 2026)
LIMITS = {"football": 20, "striker": 50, "espn": 12}
FIELDS = ("id", "position", "starter", "minutes", "goals", "assists", "shots",
          "shots_on_target", "passes", "pass_accuracy", "tackles", "interceptions",
          "duels_won", "saves", "rating", "xg", "minute_on", "minute_off")

def obj(x):
    return x if isinstance(x, dict) else {}

def arr(x):
    return x if isinstance(x, list) else []

def get(x, *keys):
    for k in keys:
        x = obj(x).get(k)
    return x

def present(x):
    return x is not None and x != ""

def norm(x):
    return " ".join(re.findall(r"[a-z0-9]+", unicodedata.normalize("NFKD", str(x or "")).encode("ascii", "ignore").decode().lower()))

def club(x):
    n = norm(x)
    aliases = {"se palmeiras": "palmeiras", "sociedade esportiva palmeiras": "palmeiras",
               "chapecoense af": "chapecoense", "chapecoense sc": "chapecoense",
               "associacao chapecoense de futebol": "chapecoense", "chapecoense sc af": "chapecoense",
               "atletico mineiro": "atletico mg", "atletico mg": "atletico mg",
               "athletico paranaense": "athletico pr", "atletico paranaense": "athletico pr",
               "red bull bragantino": "bragantino", "rb bragantino": "bragantino",
               "vasco da gama": "vasco", "flamengo rj": "flamengo", "santos fc": "santos",
               "botafogo rj": "botafogo", "sao paulo fc": "sao paulo"}
    return aliases.get(n, n)

def date_key(x):
    try:
        return dt.datetime.fromisoformat(str(x).replace("Z", "+00:00")).date().isoformat()
    except (ValueError, TypeError):
        return ""

def match_key(date, home, away):
    return (date_key(date), club(home), club(away))

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

class Probe:
    def __init__(self, keys, transport=None):
        self.keys = keys
        self.used = collections.Counter()
        self.blocked = set()
        self.calls = []
        self.auth = {"football": False, "striker": False}
        self.opener = urllib.request.build_opener(NoRedirect())
        self.transport = transport or self.http
        self.last_striker = None
        self.remaining = None

    def http(self, req):
        with self.opener.open(req, timeout=20) as r:
            return json.loads(r.read(16_000_001)), r.headers

    def call(self, source, endpoint, params=None, cost=1):
        if source in self.blocked or self.used[source] + cost > LIMITS[source]:
            return None
        key = self.keys.get(source)
        if source != "espn" and not key:
            self.blocked.add(source)
            return None
        if source == "football" and self.remaining is not None and self.remaining <= 0:
            self.blocked.add(source)
            return None
        params = params or {}
        if source == "football":
            url = "https://v3.football.api-sports.io/" + endpoint + "?" + urllib.parse.urlencode(params)
            req = urllib.request.Request(url, headers={"x-apisports-key": key})
        elif source == "striker":
            url = "https://mcp.strikerapi.com/v1/brazil/" + endpoint
            req = urllib.request.Request(url, data=json.dumps(params).encode(),
                headers={"x-api-key": key, "Content-Type": "application/json",
                         "x-idempotency-key": str(uuid.uuid4())}, method="POST")
            if self.last_striker is not None:
                time.sleep(max(0, 6.1 - (time.monotonic() - self.last_striker)))
            self.last_striker = time.monotonic()
        else:
            url = "https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/" + endpoint + "?" + urllib.parse.urlencode(params)
            req = urllib.request.Request(url, headers={"User-Agent": "FDG-E02-Discovery/1.0"})
        self.used[source] += cost  # charge attempts, even if provider refunds
        record = {"source": source, "endpoint": endpoint, "cost_reserved": cost, "status": "unknown"}
        self.calls.append(record)
        try:
            data, headers = self.transport(req)
            if source == "football":
                remaining = headers.get("x-ratelimit-requests-remaining")
                if remaining is not None and str(remaining).isdigit():
                    self.remaining = int(remaining)
                errors = obj(data).get("errors")
                if errors:
                    # Never log provider error bodies: may contain request data.
                    error_text = str(errors).lower()
                    if any(s in error_text for s in ("season", "plan", "subscription")):
                        record["status"] = "plan_or_season_restriction"
                    elif any(s in error_text for s in ("rate", "limit", "quota", "token", "key", "access", "auth")):
                        record["status"] = "auth_or_quota_error"
                        self.blocked.add(source)
                    else:
                        record["status"] = "provider_error"
                    return None
                if not isinstance(obj(data).get("response"), (list, dict)):
                    record["status"] = "schema_error"
                    return None
                self.auth[source] = True
            elif source == "striker":
                if not isinstance(data, dict) or data.get("error") or data.get("errors"):
                    record["status"] = "provider_or_schema_error"
                    return None
                self.auth[source] = True
            record["status"] = "ok"
            return data
        except urllib.error.HTTPError as e:
            record["status"] = "http_" + str(e.code)
            if e.code in (401, 402, 403, 429):
                self.blocked.add(source)
        except (OSError, ValueError, TypeError):
            record["status"] = "transport_or_json_error"
        return None

def normalize_football(data):
    rows = []
    for group in arr(obj(data).get("response")):
        team = get(group, "team", "name")
        for p in arr(group.get("players")):
            for s in arr(p.get("statistics"))[:1]:
                rows.append(dict(team=club(team), name=get(p, "player", "name"),
                    id=get(p, "player", "id"), position=get(s, "games", "position"),
                    minutes=get(s, "games", "minutes"), starter=(not get(s, "games", "substitute")) if isinstance(get(s, "games", "substitute"), bool) else None,
                    goals=get(s, "goals", "total"), assists=get(s, "goals", "assists"),
                    shots=get(s, "shots", "total"), shots_on_target=get(s, "shots", "on"),
                    passes=get(s, "passes", "total"), pass_accuracy=get(s, "passes", "accuracy"),
                    tackles=get(s, "tackles", "total"), interceptions=get(s, "tackles", "interceptions"),
                    duels_won=get(s, "duels", "won"), saves=get(s, "goals", "saves"),
                    rating=get(s, "games", "rating"), xg=s.get("xg")))
    return rows

def normalize_striker(data):
    g = obj(obj(data).get("game"))
    teams = {str(get(g, side, "team_id")): club(get(g, side, "name")) for side in ("home", "away")}
    rows = []
    for p in arr(obj(data).get("players")):
        row = {k: p.get(k) for k in FIELDS}
        row.update(team=teams.get(str(p.get("team_id")), ""), name=p.get("name"), id=p.get("player_id"))
        rows.append(row)
    return rows

def normalize_espn(data):
    rows = []
    for group in arr(obj(data).get("rosters")):
        team = group.get("team") or {}
        for p in arr(group.get("roster") or group.get("athletes")):
            athlete = obj(p.get("athlete"))
            starter = p.get("starter")
            rows.append(dict(team=club(team.get("displayName") or team.get("name")),
                name=athlete.get("displayName") or athlete.get("fullName"), id=athlete.get("id"),
                position=get(p, "position", "abbreviation") or get(athlete, "position", "abbreviation"),
                starter=starter if isinstance(starter, bool) else None,
                minutes=p.get("minutesPlayed") if isinstance(p.get("minutesPlayed"), (int, float)) else None))
    return rows

def coverage(rows):
    eligible = [p for p in rows if p.get("starter") is True or (isinstance(p.get("minutes"), (int,float)) and p["minutes"] > 0) or (isinstance(p.get("minute_on"), (int,float)) and p["minute_on"] >= 0)]
    return {"rows": len(rows), "active_rows": len(eligible),
            "filled_all": {f: sum(present(p.get(f)) for p in rows) for f in FIELDS},
            "filled_active": {f: sum(present(p.get(f)) for p in eligible) for f in FIELDS},
            "starter_counts": sorted(collections.Counter(p.get("team") for p in rows if p.get("starter") is True).values())}

def unique_pairs(a, b):
    def index(rows):
        idx = collections.defaultdict(list)
        for p in rows:
            if p.get("team") and norm(p.get("name")) and present(p.get("id")):
                idx[(p["team"], norm(p["name"]))].append(p["id"])
        return idx
    x, y = index(a), index(b)
    common = x.keys() & y.keys()
    good = [k for k in common if len(x[k]) == len(y[k]) == 1]
    return {"unique_exact_candidates": len(good), "ambiguous_shared_names": len(common)-len(good),
            "unmatched_left": len(x.keys()-y.keys()), "unmatched_right": len(y.keys()-x.keys()),
            "persisted_mappings": 0}

def football_key(f):
    return match_key(get(f,"fixture","date"), get(f,"teams","home","name"), get(f,"teams","away","name"))

def striker_key(g):
    return match_key(g.get("starts_at") or g.get("date"), get(g,"home","name"), get(g,"away","name"))

def espn_event_key(e):
    teams = arr(e.get("competitions"))
    if not teams:
        return ("","","")
    sides = {x.get("homeAway"): get(x,"team","displayName") for x in arr(teams[0].get("competitors"))}
    return match_key(e.get("date"), sides.get("home"), sides.get("away"))

def unique_match(items, fn, key):
    matched = [x for x in items if fn(x) == key]
    return matched[0] if len(matched) == 1 else None

def select_striker(games, year):
    valid = [g for g in games if str(g.get("season")) == str(year) and g.get("status") == "final" and "palmeiras" in striker_key(g)[1:]]
    if year == 2026:
        target = [g for g in valid if striker_key(g)[0] in ("2026-11-24","2026-11-25") and striker_key(g)[1:] == ("chapecoense","palmeiras")]
        if len(target) == 1:
            return target[0]
    return valid[0] if valid else None

def run(probe):
    report = {"schema": 1, "execution": "FDG-2027-E02", "utc": dt.datetime.now(dt.timezone.utc).isoformat(),
              "mode": "sample_only", "limits_per_run": LIMITS, "years": {}, "rights": "not_certified_for_redistribution"}
    league = probe.call("football","leagues",{"id":71})
    advertised = {}
    for item in arr(obj(league).get("response")):
        if get(item,"league","id") == 71:
            for season in arr(item.get("seasons")):
                advertised[str(season.get("year"))] = obj(season.get("coverage"))
    for year in YEARS:
        row = {}
        report["years"][str(year)] = row
        s = probe.call("striker","list_games",{"season":year,"team":"Palmeiras","status":"final","limit":50},2)
        sgames = arr(obj(s).get("games"))
        chosen = select_striker(sgames,year)
        f = probe.call("football","fixtures",{"league":71,"season":year,"status":"FT"})
        fg = arr(obj(f).get("response"))
        row.update(striker_sample_list_count=len(sgames), football_final_list_count=len(fg),
                   football_advertised_coverage=advertised.get(str(year),{}),
                   sample_selected=bool(chosen), exact_match=False)
        fallback = next((g for g in fg if "palmeiras" in football_key(g)[1:]), None)
        if not chosen and not fallback:
            continue
        key = striker_key(chosen) if chosen else football_key(fallback)
        row["sample_source"] = "striker" if chosen else "football_only"
        row["case_chapecoense_palmeiras"] = year == 2026 and key[0] in ("2026-11-24","2026-11-25") and key[1:] == ("chapecoense","palmeiras")
        sr = probe.call("striker","get_game",{"game_id":str(chosen["game_id"])},5) if chosen and chosen.get("game_id") else None
        # Validate identity before comparing. Never use odds or team_stats as player stats.
        sp = normalize_striker(sr) if striker_key(obj(obj(sr).get("game"))) == key else []
        row["striker"] = coverage(sp)
        fm = unique_match(fg,football_key,key)
        fp = []
        if fm and get(fm,"fixture","id"):
            fr = probe.call("football","fixtures/players",{"fixture":get(fm,"fixture","id")})
            fp = normalize_football(fr)
            row["exact_match"] = bool(chosen)
        row["football"] = coverage(fp)
        ep = []
        scoreboard = probe.call("espn","scoreboard",{"dates":key[0].replace("-",""),"limit":100})
        em = unique_match(arr(obj(scoreboard).get("events")),espn_event_key,key)
        if em and em.get("id"):
            ep = normalize_espn(probe.call("espn","summary",{"event":em["id"]}))
        row["espn"] = coverage(ep)
        row["identity_candidates"] = {"football_striker":unique_pairs(fp,sp),
            "espn_striker":unique_pairs(ep,sp), "espn_football":unique_pairs(ep,fp)}
        if year in (2024,2026) and chosen and chosen.get("game_id"):
            line = probe.call("striker","get_lineups",{"game_id":str(chosen["game_id"])},5)
            row["striker_lineup_endpoint_returned"] = bool(line)
    report["auth"] = probe.auth
    report["attempted_budget"] = {k:probe.used[k] for k in LIMITS}
    report["calls"] = probe.calls
    report["aggregate_coverage"] = {}
    for source in ("football","striker","espn"):
        summaries = [r.get(source,{}) for r in report["years"].values()]
        total = sum(r.get("rows",0) for r in summaries)
        active = sum(r.get("active_rows",0) for r in summaries)
        filled = {f:sum(r.get("filled_active",{}).get(f,0) for r in summaries) for f in FIELDS}
        report["aggregate_coverage"][source] = {
            "sampled_matches_with_rows":sum(r.get("rows",0)>0 for r in summaries),
            "rows":total,"active_rows":active,"filled_active":filled,
            "active_coverage_pct":{f:round(100*n/active,1) if active else None for f,n in filled.items()}
        }
    report["economic_scenario"] = {
        "striker_credits_per_game_stats":5,"striker_free_monthly_credits":500,
        "example_50_matches_stats_only_credits":250,
        "football_free_daily_requests":100,"paid_plan_required":"undetermined",
        "warning":"Estimates only; excludes retries, listings and additional endpoints. Check plan and rights."
    }
    report["production_ready"] = False
    report["decision"] = "review_coverage_and_rights_before_E03"
    return report

def self_test():
    assert present(0) and present(False) and not present(None)
    assert club("Chapecoense AF") == "chapecoense"
    assert unique_match([1,1],lambda x:x,1) is None
    assert unique_pairs([{"team":"a","name":"João","id":"1"}],[{"team":"a","name":"Joao","id":"2"}])["unique_exact_candidates"] == 1
    assert unique_pairs([{"team":"a","name":"João","id":"1"},{"team":"a","name":"Joao","id":"3"}],[{"team":"a","name":"Joao","id":"2"}])["ambiguous_shared_names"] == 1
    data = {"game":{"home":{"team_id":"1","name":"Palmeiras"},"away":{"team_id":"2","name":"Bahia"}},
            "players":[{"player_id":"42","team_id":"1","name":"Test","starter":True,"goals":0}],"team_stats":[{"passes":500}]}
    cov = coverage(normalize_striker(data))
    assert cov["filled_all"]["goals"] == 1 and cov["filled_all"]["passes"] == 0
    calls=[]
    def fake(req):
        calls.append(req)
        return {"response":[]}, {}
    p=Probe({"football":"fake"},fake)
    for _ in range(25):
        p.call("football","fixtures")
    assert len(calls)==20 and p.used["football"]==20
    p=Probe({},fake)
    assert p.call("striker","get_game",cost=5) is None and p.used["striker"]==0
    p=Probe({"football":"fake"},lambda req:({"errors":{"plan":"season unavailable"},"response":[]},{}))
    assert p.call("football","fixtures") is None and not p.auth["football"]
    p=Probe({"football":"fake"},lambda req:({"response":[]},{"x-ratelimit-requests-remaining":"0"}))
    p.call("football","fixtures")
    assert p.call("football","fixtures") is None and p.used["football"]==1
    print("PASS: budget, missing secrets, quota, nulls, individual vs collective, exact/ambiguous identity")

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--self-test",action="store_true")
    parser.add_argument("--output",default="e02-report.json")
    args=parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    keys={"football":os.getenv("API_FOOTBALL_KEY"),"striker":os.getenv("STRIKER_API_KEY")}
    if not all(keys.values()):
        print("BLOCKED: configure both required repository secrets.")
        return 2
    result=run(Probe(keys))
    Path(args.output).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
    summary=["## FDG 2027 E02 — Player Data Discovery", "",
             "Manual sample only; no production writes. No raw data or keys.", "",
             "| Season | Football rows | Striker rows | ESPN rows | Exact cross-match |",
             "|---|---:|---:|---:|---|"]
    for y,r in result["years"].items():
        summary.append(f"| {y} | {r.get('football',{}).get('rows',0)} | {r.get('striker',{}).get('rows',0)} | {r.get('espn',{}).get('rows',0)} | {r['exact_match']} |")
    summary.extend(["", "Attempted budgets: "+json.dumps(result["attempted_budget"]),
                    "Authenticated: "+json.dumps(result["auth"]),
                    "2026 target found: "+str(result["years"]["2026"].get("case_chapecoense_palmeiras",False)),
                    "Production readiness: NOT CERTIFIED. Inspect aggregate report for missing fields and identity candidates."])
    print("\n".join(summary))
    if os.getenv("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"],"a",encoding="utf-8") as f:
            f.write("\n".join(summary)+"\n")
    return 0 if all(result["auth"].values()) and any(r.get("striker",{}).get("rows",0) for r in result["years"].values()) and any(r.get("football",{}).get("rows",0) for r in result["years"].values()) else 2

if __name__ == "__main__":
    sys.exit(main())
