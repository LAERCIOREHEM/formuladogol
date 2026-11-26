"""FDG 2027 E02-R4: offline audit, never a trained RAPM or production certificate."""
import argparse
import collections
import hashlib
import json
import math
import os
import re
import sys
from pathlib import Path

import player_data_discovery as base
import historical_r2 as r2
import historical_r3 as r3

VERSION = "E02-R4.1"
YEARS = ("2022", "2023", "2024", "2025", "2026")
NUMERIC = set(base.FIELDS) - {"id", "position", "starter"}
COUNT = NUMERIC - {"rating", "xg", "pass_accuracy"}

def ident(value):
    return str(value) if isinstance(value, int) and not isinstance(value, bool) and value > 0 else (
        value if isinstance(value, str) and re.fullmatch(r"[1-9][0-9]*", value) else None)

def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        n = float(value)
        return n if math.isfinite(n) else None
    except (ValueError, OverflowError):
        return None

def valid_field(k, v):
    if k == "id":
        return ident(v) is not None
    if k == "position":
        return v in ("G", "D", "M", "F")
    if k == "starter":
        return isinstance(v, bool)
    n = number(v)
    return n is not None and n >= 0 and (k not in COUNT or n.is_integer())

def clock(e):
    """Regulation minute and added-time order; no invented whistle times."""
    m = base.get(e, "time", "elapsed")
    x = base.get(e, "time", "extra")
    if not isinstance(m, int) or isinstance(m, bool) or not 0 <= m <= 90:
        return None
    if x is not None and (not isinstance(x, int) or isinstance(x, bool) or x < 0 or (x > 0 and m not in (45, 90))):
        return None
    return (m, x or 0)

def event_kind(e):
    typ, detail = base.norm(e.get("type")), base.norm(e.get("detail"))
    if typ == "subst":
        return "sub"
    if typ == "card" and detail in ("red card", "second yellow card", "yellow red card"):
        return "red"
    if typ == "goal":
        if detail in ("normal goal", "own goal", "penalty"):
            return "goal"
        return "ambiguous_goal"
    if typ == "var" and ("goal" in detail or "card" in detail or "penalty" in detail):
        return "var_review"
    if typ == "card" and detail == "yellow card":
        return "other"
    if typ == "var" and detail in ("goal confirmed", "penalty confirmed"):
        return "var_review"
    return "unknown"

def timeline(f):
    """Conservative regulation-clock candidate, not actual elapsed-time certification."""
    issues = collections.Counter()
    flags = collections.Counter()
    teams = {ident(base.get(f, "teams", s, "id")) for s in ("home", "away")}
    def fail(reason):
        issues[reason] += 1
        return {"candidate": False, "issues": dict(issues), "flags": dict(flags), "segments": []}
    if None in teams or len(teams) != 2:
        return fail("team_identity")
    if base.get(f, "fixture", "status", "short") != "FT":
        return fail("non_regulation_status")
    active, starts, ends = {}, {}, {}
    for g in base.arr(f.get("lineups")):
        t = ident(base.get(g, "team", "id"))
        ids = [ident(base.get(p, "player", "id")) for p in base.arr(g.get("startXI"))]
        if t not in teams or t in active or len(ids) != 11 or None in ids or len(set(ids)) != 11:
            return fail("invalid_xi")
        active[t] = set(ids)
        starts.update({(t, p): 0 for p in ids})
    if set(active) != teams or len({p for _, p in starts}) != 22:
        return fail("invalid_xi_identity")
    if not isinstance(f.get("events"), list):
        return fail("missing_events")
    if any(not isinstance(e, dict) for e in f["events"]):
        return fail("malformed_event")
    events, seen, goals = [], set(), collections.Counter()
    for i, e in enumerate(f["events"]):
        k, c = event_kind(e), clock(e)
        if k == "other":
            if c is None:
                flags["noncritical_clock_missing"] += 1
            continue
        if k in ("unknown", "ambiguous_goal", "var_review"):
            issues[k] += 1
            continue
        if c is None:
            issues["critical_clock_invalid"] += 1
            continue
        t = ident(base.get(e, "team", "id"))
        p = ident(base.get(e, "player", "id"))
        q = ident(base.get(e, "assist", "id")) if k == "sub" else None
        signature = (c, k, t, p, q, base.norm(e.get("detail")))
        if signature in seen:
            issues["duplicate_critical_event"] += 1
            continue
        seen.add(signature)
        if c[1]:
            flags["added_time_critical_event"] += 1
        if t not in teams or p is None:
            issues["critical_identity_missing"] += 1
            continue
        events.append((c, i, k, t, p, q))
    if issues:
        return {"candidate": False, "issues": dict(issues), "flags": dict(flags), "segments": []}
    # Clock precision is one minute. Do not assign a goal to a lineup that changes
    # in the same regulation minute, or infer an order for interdependent substitutions.
    groups = collections.defaultdict(list)
    for row in events:
        groups[row[0][0]].append(row)
    for minute, rows in groups.items():
        if any(x[2] == "goal" for x in rows) and any(x[2] != "goal" for x in rows):
            issues["goal_lineup_same_regulation_minute"] += 1
        if any(x[0][1] > 0 and x[2] != "goal" for x in rows):
            issues["added_time_lineup_exposure_unknown"] += 1
        if minute in (0, 90) and any(x[2] != "goal" for x in rows):
            issues["boundary_lineup_exposure_unknown"] += 1
        if minute == 0 and any(x[2] == "goal" for x in rows):
            issues["boundary_goal_exposure_unknown"] += 1
        if minute == 90 and any(x[2] == "goal" for x in rows):
            flags["final_minute_goal_regulation_proxy"] += 1
    if issues:
        return {"candidate": False, "issues": dict(issues), "flags": dict(flags), "segments": []}
    boundaries = {0, 90}
    goal_at = collections.defaultdict(collections.Counter)
    for c, event_index, k, t, p, q in sorted(events):
        m = c[0]
        if k == "goal":
            detail = base.norm(f["events"][event_index].get("detail"))
            if detail == "own goal":
                if not any(p in on_pitch for on_pitch in active.values()):
                    return fail("goal_player_not_on_pitch")
            elif p not in active[t]:
                return fail("goal_player_not_on_pitch")
            goals[t] += 1
            goal_at[m][t] += 1
            boundaries.add(m)
            continue
        if p not in active[t]:
            return fail("exit_not_on_pitch")
        if k == "sub" and (q is None or any(player == q for _, player in starts)):
            return fail("invalid_or_reused_entrant")
        if starts[(t, p)] >= m:
            return fail("zero_or_ambiguous_exposure")
        active[t].remove(p)
        ends[(t, p)] = m
        if k == "sub":
            active[t].add(q)
            starts[(t, q)] = m
        boundaries.add(m)
    for s in ("home", "away"):
        t = ident(base.get(f, "teams", s, "id"))
        score = base.get(f, "goals", s)
        if not isinstance(score, int) or isinstance(score, bool) or score < 0 or goals[t] != score:
            return fail("score_mismatch")
    intervals = {key: (a, ends.get(key, 90)) for key, a in starts.items()}
    observed = {}
    for g in base.arr(f.get("players")):
        t = ident(base.get(g, "team", "id"))
        for p in base.arr(g.get("players")):
            pid = ident(base.get(p, "player", "id"))
            stats = base.arr(p.get("statistics"))
            m = base.get(stats[0], "games", "minutes") if stats else None
            if t not in teams or pid is None or (t, pid) in observed:
                return fail("player_box_identity")
            observed[(t, pid)] = number(m)
            if (t, pid) in intervals:
                sub = base.get(stats[0], "games", "substitute") if stats else None
                if not isinstance(sub, bool) or sub == (starts[(t, pid)] == 0):
                    return fail("starter_box_conflict")
    if any(key not in observed or observed[key] is None for key in intervals):
        return fail("missing_active_minutes")
    if any(m is not None and m > 0 and key not in intervals for key, m in observed.items()):
        return fail("untracked_active_player")
    errors = [abs((b-a)-observed[key]) for key, (a,b) in intervals.items()]
    flags["minute_comparisons"] = len(errors)
    flags["max_abs_minute_error"] = max(errors, default=0)
    if any(e != 0 for e in errors):
        return fail("regulation_minutes_not_exact")
    ordered = sorted(boundaries)
    segments = []
    for a,b in zip(ordered, ordered[1:]):
        xi = {t: sorted(p for (team,p),(x,y) in intervals.items() if team == t and x <= a and y >= b) for t in sorted(teams)}
        if not all(7 <= len(v) <= 11 for v in xi.values()):
            return fail("on_pitch_count")
        # Goal at right boundary belongs to preceding interval; lineup is unchanged there.
        segments.append({"start": a, "end": b, "xi": xi, "goals": dict(goal_at[b])})
    if sum(s["end"]-s["start"] for s in segments) != 90:
        return fail("segment_duration")
    if sum(sum(s["goals"].values()) for s in segments) != sum(goals.values()):
        return fail("segment_goals")
    return {"candidate": True, "issues": {}, "flags": dict(flags), "segments": segments}

def metric_rows(f):
    for g in base.arr(f.get("players")):
        for p in base.normalize_football({"response": [g]}):
            if p.get("starter") is True or (number(p.get("minutes")) or 0) > 0:
                yield ident(base.get(g, "team", "id")), p

def add_coverage(bucket, p):
    bucket["rows"] += 1
    for field in base.FIELDS:
        value = p.get(field)
        bucket[field + ":present"] += int(base.present(value))
        bucket[field + ":valid_shape"] += int(valid_field(field, value))
        if field in NUMERIC:
            bucket[field + ":zero"] += int(number(value) == 0)

def audit(state):
    catalog, history = state["catalog"], state["historical"]
    attempts = state["attempts"]
    if set(catalog) != set(YEARS) or any(not isinstance(v, dict) for v in catalog.values()):
        raise ValueError("catalogue seasons")
    seen = set()
    out, private, identities = {}, {}, collections.defaultdict(set)
    for year in YEARS:
        cat = catalog[year]
        if not cat or len(cat) > 380 or (year != "2026" and len(cat) != 380):
            raise ValueError("catalogue size")
        counts, reasons, old_reasons, flag_totals = (collections.Counter() for _ in range(4))
        pending_reasons, pending_attempts, minute_error_bands = (collections.Counter() for _ in range(3))
        counts.update({k:0 for k in ("catalogued","r3_valid_players","r3_detailed","r3_candidates","r3_segments","r4_candidates","r4_segments","r3_to_r4_retained","r3_to_r4_gained","r3_to_r4_lost","A","B","C","D")})
        coverage = collections.defaultdict(collections.Counter)
        private_clubs = collections.defaultdict(collections.Counter)
        for fid, expected in sorted(cat.items()):
            if fid in seen or r2.football_id(expected) != fid or base.get(expected,"league","season") != int(year) or base.get(expected,"league","id") != 71:
                raise ValueError("catalogue identity")
            seen.add(fid)
            counts["catalogued"] += 1
            f = history.get(fid, {})
            valid, detailed = r3.assess(f, expected)
            counts["r3_valid_players"] += int(valid)
            counts["r3_detailed"] += int(detailed)
            attempt = attempts.get(fid, 0)
            if not isinstance(attempt, int) or isinstance(attempt, bool) or attempt < 0:
                raise ValueError("invalid attempt count")
            if not detailed:
                counts["r3_unresolved"] += 1
                counts["r3_exhausted"] += int(attempt >= 3)
                pending_attempts[str(attempt)] += 1
                if not valid:
                    pending_reasons["no_stored_fixture" if fid not in history else "stored_fixture_fails_r3_player_validation"] += 1
                else:
                    pending_reasons["valid_players_but_detail_incomplete"] += 1
            if not valid:
                counts["D"] += 1
                private[fid] = {"year": year, "class": "D", "attempts":attempt, "stored_fixture":fid in history, "issues": {"invalid_or_missing_players": 1}}
                continue
            old = r2.historical_timeline(f)
            old_reasons[old["reason"]] += 1
            counts["r3_candidates"] += int(old["candidate"])
            counts["r3_segments"] += old.get("segments", 0)
            result = timeline(f)
            rows = list(metric_rows(f))
            ids = [ident(p.get("id")) for _,p in rows]
            complete_core = bool(rows) and len(ids)==len(set(ids)) and all(valid_field(k,p.get(k)) for _,p in rows for k in ("id","position","starter","minutes"))
            candidate = detailed and result["candidate"] and complete_core
            if not complete_core:
                result["issues"]["individual_core_conflict"] = 1
            cls = "A" if candidate and complete_core else "B" if detailed and complete_core else "C"
            counts[cls] += 1
            counts["r4_candidates"] += int(candidate)
            counts["r4_segments"] += len(result["segments"]) if candidate else 0
            counts["r3_to_r4_retained"] += int(old["candidate"] and candidate)
            counts["r3_to_r4_gained"] += int(not old["candidate"] and candidate)
            counts["r3_to_r4_lost"] += int(old["candidate"] and not candidate)
            reasons.update(result["issues"])
            flag_totals.update({k:v for k,v in result["flags"].items() if k != "max_abs_minute_error"})
            error = result["flags"].get("max_abs_minute_error")
            if error is not None:
                minute_error_bands["0" if error == 0 else "0_to_1" if error <= 1 else "1_to_5" if error <= 5 else "over_5"] += 1
            for t,p in rows:
                pos = p.get("position") if valid_field("position",p.get("position")) else "unknown"
                add_coverage(coverage["all"], p)
                add_coverage(coverage[pos], p)
                add_coverage(private_clubs[str(t) + ":" + pos], p)
                if ident(p.get("id")) and base.norm(p.get("name")):
                    identities[ident(p["id"])].add(base.norm(p["name"]))
            private[fid] = {"year":year,"class":cls,"attempts":attempt,"r3_candidate":old["candidate"],
                            "r4_candidate":candidate,"issues":result["issues"],"flags":result["flags"],
                            "segments":result["segments"] if candidate else []}
        counts["r3_unresolved"] += 0
        counts["r3_exhausted"] += 0
        if (sum(counts[k] for k in "ABCD") != counts["catalogued"] or
                counts["r3_unresolved"] != counts["catalogued"] - counts["r3_detailed"] or
                sum(pending_attempts.values()) != counts["r3_unresolved"] or
                counts["r4_candidates"] != counts["A"] or
                counts["r3_to_r4_retained"] + counts["r3_to_r4_gained"] != counts["r4_candidates"] or
                counts["r3_to_r4_retained"] + counts["r3_to_r4_lost"] != counts["r3_candidates"]):
            raise ValueError("classification accounting")
        out[year] = {"counts":dict(counts),"r3_reasons":dict(old_reasons),"r4_issues_nonexclusive":dict(reasons),
                     "flags":dict(flag_totals),"field_counts_by_position":{k:dict(v) for k,v in sorted(coverage.items())},
                     "r3_pending_reasons":dict(pending_reasons),"r3_pending_attempt_histogram":dict(pending_attempts),
                     "r4_max_abs_minute_error_bands":dict(minute_error_bands)}
        private["club_coverage:" + year] = {k:dict(v) for k,v in sorted(private_clubs.items())}
    aggregate = {"schema":1,"version":VERSION,"clock":"regulation minute; exact box-minute agreement; not elapsed-time proof",
                 "seasons":out,"unique_provider_ids":len(identities),
                 "ids_with_multiple_normalized_names":sum(len(v)>1 for v in identities.values()),
                 "orphan_historical_records":len(set(history)-seen),
                 "rapm_trained":False,"rapm_certified":False,"cross_provider_mapping_certified":False,
                 "statistics_semantics_certified":False,"production_ready":False}
    return aggregate, {"schema":1,"version":VERSION,"fixtures_and_club_coverage":private}

def self_test():
    from copy import deepcopy
    def fixture():
        def person(i, m, sub=False):
            return {"player":{"id":i},"statistics":[{"games":{"minutes":m,"substitute":sub,"position":"M"}}]}
        return {"fixture":{"status":{"short":"FT"}},"teams":{"home":{"id":1},"away":{"id":2}},
                "goals":{"home":0,"away":0},"lineups":[{"team":{"id":t},"startXI":[{"player":{"id":i}} for i in range(t*100,t*100+11)]} for t in (1,2)],
                "events":[],"players":[{"team":{"id":t},"players":[person(i,90) for i in range(t*100,t*100+11)]} for t in (1,2)]}
    def event(k, detail, m, p, q=None, extra=None):
        return {"type":k,"detail":detail,"time":{"elapsed":m,"extra":extra},"team":{"id":1},"player":{"id":p},"assist":{"id":q}}
    f=fixture()
    assert timeline(f)["candidate"]
    f["events"]=[event("subst","Substitution 1",60,100,199)]
    f["players"][0]["players"][0]["statistics"][0]["games"]["minutes"]=60
    f["players"][0]["players"].append({"player":{"id":199},"statistics":[{"games":{"minutes":30,"position":"M","substitute":True}}]})
    assert timeline(f)["candidate"] and len(timeline(f)["segments"])==2
    g=deepcopy(f); g["events"].append(deepcopy(g["events"][0]))
    assert "duplicate_critical_event" in timeline(g)["issues"]
    g=deepcopy(f); g["events"].append(event("Goal","Normal Goal",60,101)); g["goals"]["home"]=1
    assert "goal_lineup_same_regulation_minute" in timeline(g)["issues"]
    g=fixture(); g["events"]=[event("Card","Red Card",70,100)]; g["players"][0]["players"][0]["statistics"][0]["games"]["minutes"]=70
    assert timeline(g)["candidate"]
    g=fixture(); g["events"]=[event("Goal","Normal Goal",55,100)]; g["goals"]["home"]=1
    assert timeline(g)["candidate"] and sum(sum(x["goals"].values()) for x in timeline(g)["segments"])==1
    g["goals"]["home"]=0; assert "score_mismatch" in timeline(g)["issues"]
    g=fixture(); g["events"]=[event("Goal","Normal Goal",90,100,extra=4)]; g["goals"]["home"]=1
    assert timeline(g)["candidate"] and timeline(g)["flags"]["final_minute_goal_regulation_proxy"]==1
    g=fixture(); g["events"]=[event("Goal","Normal Goal",55,999)]; g["goals"]["home"]=1
    assert "goal_player_not_on_pitch" in timeline(g)["issues"]
    g=fixture(); g["players"][0]["players"][0]["statistics"][0]["games"]["substitute"]=True
    assert "starter_box_conflict" in timeline(g)["issues"]
    g=fixture(); g["events"]=[event("Card","Yellow Card",None,100)]
    assert timeline(g)["candidate"] and timeline(g)["flags"]["noncritical_clock_missing"]==1
    g["events"]=[event("subst","Substitution 1",45,100,199,2)]
    assert "added_time_lineup_exposure_unknown" in timeline(g)["issues"]
    g["events"]=[event("VAR","Goal cancelled",44,100)]
    assert "var_review" in timeline(g)["issues"]
    g=fixture(); g["players"][0]["players"][0]["statistics"][0]["games"]["minutes"]=89
    assert "regulation_minutes_not_exact" in timeline(g)["issues"]
    assert not valid_field("goals",None) and valid_field("goals",0) and not valid_field("goals",True)
    assert clock(event("Goal","Normal Goal",45,100,extra=3))==(45,3)
    assert clock(event("Goal","Normal Goal",91,100)) is None
    from unittest.mock import patch
    f=fixture(); f["fixture"].update({"id":101,"date":"2026-01-01T00:00:00Z"}); f["league"]={"id":71,"season":2026}
    f["teams"]["home"]["name"]="Home"; f["teams"]["away"]["name"]="Away"
    missing=deepcopy(f); missing["fixture"]["id"]=102
    state={"catalog":{"2026":{"101":f,"102":missing}},"historical":{"101":f},"attempts":{"101":1,"102":3}}
    with patch.object(sys.modules[__name__],"YEARS",("2026",)):
        agg, priv=audit(state)
    c=agg["seasons"]["2026"]["counts"]
    assert c["A"]==1 and c["D"]==1 and c["r3_unresolved"]==1 and c["r3_exhausted"]==1
    assert agg["seasons"]["2026"]["r3_pending_reasons"]=={"no_stored_fixture":1}
    assert priv["fixtures_and_club_coverage"]["102"]["attempts"]==3
    print("PASS: R4 synthetic timeline, goals, substitutions, cards, clocks, missingness, pending accounting and fail-closed checks")

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--self-test",action="store_true")
    p.add_argument("--state",type=Path)
    p.add_argument("--report",type=Path)
    p.add_argument("--private",type=Path)
    p.add_argument("--source-run",type=int)
    a=p.parse_args()
    if a.self_test:
        self_test()
        return 0
    if not all((a.state,a.report,a.private,a.source_run)) or not a.state.is_file():
        return 2
    if len({x.resolve() for x in (a.state,a.report,a.private)}) != 3 or a.report.exists() or a.private.exists():
        return 2
    try:
        before=hashlib.sha256(a.state.read_bytes()).hexdigest()
        state=r2.load(a.state)
        aggregate, private=audit(state)
        if hashlib.sha256(a.state.read_bytes()).hexdigest()!=before:
            raise ValueError("input changed")
        metadata={"source_run_id":a.source_run,"input_sha256":before,"code_commit":os.getenv("GITHUB_SHA","local")}
        aggregate.update(metadata); private.update(metadata)
        for dest,data in ((a.report,aggregate),(a.private,private)):
            with dest.open("x",encoding="utf-8") as f:
                json.dump(data,f,sort_keys=True,separators=(",",":"),allow_nan=False)
        lines=["## FDG 2027 E02-R4 — offline audit","",
               "| Season | Catalogued | Detailed R3 | Pending | Exhausted | R3 candidates | R4 strict candidates |",
               "|---|---:|---:|---:|---:|---:|---:|"]
        for year,s in aggregate["seasons"].items():
            c=s["counts"]; lines.append("| "+" | ".join(map(str,[year,c["catalogued"],c["r3_detailed"],c["r3_unresolved"],c["r3_exhausted"],c["r3_candidates"],c["r4_candidates"]]))+" |")
        lines+=["","Regulation-clock candidates only. No RAPM trained. No production certification."]
        print("\n".join(lines))
        if os.getenv("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"],"a",encoding="utf-8") as f:
                f.write("\n".join(lines)+"\n")
        return 0
    except Exception:
        print("BLOCKED: offline audit failed; input was not intentionally modified. No private exception output.")
        return 2

if __name__=="__main__":
    sys.exit(main())
