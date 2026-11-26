"""Read-only migration inventory: print paths, categories and match counts, not source text."""
import json
import re
import subprocess
from pathlib import Path
from collections import Counter

ROOT=Path(__file__).resolve().parents[3]
PATTERNS={
    "year_2026":re.compile(r"(?<!\d)2026(?!\d)"),
    "legacy_paths":re.compile(r"dados-br/|(?:jogos|resultados|tabela|espn_eventos)\.json"),
    "season_configuration":re.compile(r"BRASILEIRAO_TEMPORADA|\btemporada\b|\bseason\b",re.I),
    "cache_or_state":re.compile(r"cacheKey|cache\.put|cache\.match|storage\.(?:get|put)|event_key|eventKey|localStorage|indexedDB",re.I),
    "database":re.compile(r"CREATE TABLE|PRIMARY KEY|\.prepare\(|supabase",re.I),
    "notification":re.compile(r"lineup_confirmed|notification|push-dispatch|dedup",re.I)
}
def group(p):
    if p.startswith(".github/workflows/"): return "workflows"
    if p.startswith("cloudflare/"): return "workers_d1"
    if p.startswith("supabase/"): return "supabase"
    if p.startswith("js/") or p.endswith((".html",".js",".mjs")): return "frontend"
    if p.endswith(".py"): return "python"
    if p.endswith(".sql"): return "sql"
    return "other"

def inventory():
    paths=subprocess.check_output(["git","ls-files","-z"],cwd=ROOT).decode().split("\0")
    entries=[]
    scanned=Counter()
    for p in paths:
        if not p or p.startswith(("research/","tests/","copa2026/","analises/","img/")): continue
        if not p.endswith((".js",".mjs",".py",".sql",".yml",".yaml",".html",".jsonc")): continue
        path=ROOT/p
        if not path.is_file() or path.is_symlink(): continue
        source=path.read_text(encoding="utf-8",errors="replace")
        g=group(p); scanned[g]+=1
        counts={k:len(v.findall(source)) for k,v in PATTERNS.items()}
        if any(counts.values()): entries.append({"path":p,"group":g,"signals":{k:v for k,v in counts.items() if v}})
    return {"schema":1,"head":subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT,text=True).strip(),"scanned":dict(scanned),"matched_files":len(entries),"entries":entries,"limitations":"Lexical inventory only; hits are migration review candidates, not verified defects."}

if __name__=="__main__":
    print(json.dumps(inventory(),indent=2))
