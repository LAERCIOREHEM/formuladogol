"""Verify private artifacts, guardian source and frozen decision, no real enrollment."""
import argparse, json, os, subprocess, sys
from pathlib import Path
from ledger import ROOT,sha,raw,VERSION,forecast
HERE=Path(__file__).resolve().parent
def read(p):return json.loads(p.read_bytes())
def main():
    p=argparse.ArgumentParser()
    for k in ("backtest","e08-report","forecast","e07-report","output","report"):p.add_argument("--"+k,type=Path,required=True)
    a=p.parse_args();lock=read(HERE/"source-lock.json");paths=(a.backtest,a.e08_report,a.forecast,a.e07_report);before=[sha(p.read_bytes()) for p in paths]
    d,r,x,y=map(read,paths)
    if r["code_commit"]!=lock["e08_commit"] or y["code_commit"]!=lock["e07_commit"] or r["private_sha256"]!=before[0] or y["private_sha256"]!=before[2] or r["source_private_sha256"]!=before[2]:raise ValueError("artifact binding")
    if d["version"]!="E08.1" or x["version"]!="E07.1" or d["decision"]!=r["decision"] or d["decision"]["pass"] or d["decision"]["promotion"] or r["lineup_enabled"] or r["production_ready"] or x["lineup_enabled"] or x["production_ready"]:raise ValueError("promotion gate")
    protocol=ROOT/"research/fdg2027/e08/protocol.json"
    if sha(protocol.read_bytes())!=r["protocol_sha256"] or read(protocol)!=d["protocol"]:raise ValueError("protocol drift")
    if r["source_manifest_sha256"]!=y["source_manifest_sha256"] or len(x["records"])!=1120 or r["paired"]!=740:raise ValueError("cohort binding")
    g=ROOT/"cloudflare/push-worker/src/readiness-guardian.js";s=g.read_text()
    findings={"one_shot_confirmation":"if (num(match?.lineupConfirmedAt, 0) > 0) return" in s,"positional_team_fallback":"i === 0 ? 'home' : i === 1 ? 'away'" in s,"truncation_to_11":"starters.slice(0, 11)" in s,"name_fallback":"p.id || norm(p.name)" in s,"source_timestamp_not_in_lineup_snapshot":"return { home: assign.home, away: assign.away, signature: stableKey(signature) }" in s}
    if not all(findings.values()):raise ValueError("guardian audit drift")
    # Read-only documentary baseline at E07 commit; never simulate provider receipt for these rows.
    snapshot=subprocess.check_output(["git","show",lock["e07_commit"]+":dados-br/probabilidades-jogos.json"],cwd=ROOT)
    snap=json.loads(snapshot)
    if sha(snapshot)!=y["baseline_provenance"]["published"]["snapshot_sha256"] or snap["versao_modelo"]!="AF-Previsão 1.3":raise ValueError("baseline document")
    for row in snap["jogos"]:forecast(raw(row))
    if before!=[sha(p.read_bytes()) for p in paths]:raise ValueError("input mutation")
    private={"version":VERSION,"source_hashes":before,"protocol_sha256":r["protocol_sha256"],"guardian_sha256":sha(g.read_bytes()),"guardian_findings":findings,"historical_snapshot_sha256":sha(snapshot),"documentary_baseline_rows":len(snap["jogos"]),"e08_decision":d["decision"],"prospective_contract":d["protocol"]["prospective"],"production_ready":False,"lineup_enabled":False,"prospective_started":False,"live_adapter_enabled":False}
    for path in (a.output,a.report):
        q=path.resolve()
        if q.exists() or q==ROOT or ROOT in q.parents or q in ROOT.parents:raise ValueError("private output")
    a.output.write_bytes(raw(private)+b"\n")
    rep={k:v for k,v in private.items() if k!="source_hashes"};rep.update(private_sha256=sha(a.output.read_bytes()),code_commit=os.getenv("GITHUB_SHA","local"),api_requests=0,live_events=0,real_enrollments=0,source_e08_commit=lock["e08_commit"],source_e07_commit=lock["e07_commit"])
    a.report.write_bytes(raw(rep)+b"\n");print("E09 AGGREGATE",json.dumps(rep,sort_keys=True))
if __name__=="__main__":main()
