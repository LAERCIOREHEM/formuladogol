"""Independent statistical publication gate: no AF, calendar or third-party writes."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))

def require(ok, message):
    if not ok:
        raise ValueError(message)

def name(value):
    return str(value.get("nome") if isinstance(value, dict) else value or "")

def key(row):
    return str(row.get("event_id") or "")

def score(row):
    return (name(row.get("mandante")), name(row.get("visitante")),
            row.get("placar_mandante"), row.get("placar_visitante"))

def index(rows):
    result = {key(r): r for r in rows}
    require("" not in result and len(result) == len(rows), "duplicate or missing event ID")
    return result

def protect(previous, candidate):
    old, new = index(previous.get("jogos", [])), index(candidate.get("jogos", []))
    for eid, row in old.items():
        # A final corrigido exige revisão explícita, não substituição silenciosa.
        require(eid in new, "previous game lost: "+eid)
        for field in ("publico", "publico_pagante", "renda"):
            if isinstance(row.get(field), (int, float)) and row[field] > 0:
                require(isinstance(new[eid].get(field), (int, float)) and new[eid][field] > 0,
                        f"documented {field} lost: {eid}")
        if row.get("tem_estatisticas"):
            require(new[eid].get("tem_estatisticas"), "boxscore regressed: "+eid)

def certify(root=ROOT, baseline=None):
    def load(p):
        return read(root / p)
    results=index(load("resultados.json")["resultados"])
    n=len(results)
    require(0 < n <= 380 and all(r.get("estado")=="post" for r in results.values()), "invalid FINAL ledger")
    table=load("tabela.json")["tabela"]
    require(len(table)==20 and len({r["time"] for r in table})==20, "invalid table")
    clubs={r["time"]:[0,0,0,0,0,0,0] for r in table}
    for r in results.values():
        home,away,x,y=score(r)
        require(home in clubs and away in clubs and home!=away and type(x)==int and type(y)==int and min(x,y)>=0, "invalid score")
        for club,gf,ga in ((home,x,y),(away,y,x)):
            vals=[1,gf,ga,3 if gf>ga else 1 if gf==ga else 0,int(gf>ga),int(gf==ga),int(gf<ga)]
            clubs[club]=[a+b for a,b in zip(clubs[club],vals)]
    for row in table:
        require(clubs[row["time"]]==[row[k] for k in ("jogos","gp","gc","pontos","vitorias","empates","derrotas")], "table mismatch: "+row["time"])
    details=load("dados-br/jogos-detalhes.json")["jogos"]
    require(set(details)==set(results), "missing details: "+str(sorted(set(results)-set(details))))
    for eid, r in results.items():
        d=details[eid]
        require(score(r)==score(d) and bool(d.get("stats") or d.get("estatisticas")) and bool(d.get("jogadores")) and d.get("validacao_eventos",{}).get("ok") is True, "invalid detail: "+eid)
    audit=load("dados-br/auditoria-jogos-detalhes.json")
    for k in ("total_resultados_lidos","total_processados","total_com_estatisticas","total_eventos_validados","total_com_jogadores"):
        require(audit.get(k)==n, f"{k}: {audit.get(k)} != {n}")
    require(audit.get("total_inconsistencias_eventos")==0 and audit.get("total_eventos_pendentes_detalhes")==0, "event audit failed")
    leaders=load("dados-br/lideres-jogadores.json")
    require(leaders.get("status")=="valido","leaders invalid")
    for kind,field in (("artilharia","gols"),("assistencias","assistencias")):
        c=leaders["completude"][kind]
        require(c.get("jogos_lidos")==n and c.get("jogos_com_escalacoes")==n and c.get("jogos_pendentes_detalhes")==0 and c.get("jogos_invalidos_ignorados")==0 and c.get("eventos_locais_autoritativos") is True and c.get("aparicoes_locais_autoritativas") is True and leaders["preservado_de_execucao_anterior"][kind] is False, "incomplete "+kind)
        require(sum(r[field] for r in leaders[kind])==c["total_eventos_contabilizados"],"leader total mismatch "+kind)
        if kind=="artilharia":
            require(c["total_eventos_contabilizados"]+c["gols_contra_ignorados"]==sum(r["placar_mandante"]+r["placar_visitante"] for r in results.values()),"goals mismatch")
    comp=load("dados-br/estatisticas-competicao.json")
    games=index(comp["jogos"])
    require(set(games)==set(results) and all(score(games[e])==score(r) and games[e].get("tem_estatisticas") is True for e,r in results.items()),"competition mismatch")
    require(comp["resumo"]["jogos_finalizados"]==comp["resumo"]["jogos_com_estatisticas"]==n,"competition counts")
    if baseline is not None:
        protect(baseline,comp)
    audit=load("dados-br/auditoria-estatisticas.json")
    require(audit["status"]=="ok" and audit["resumo"]["jogos_finalizados"]==audit["resumo"]["jogos_com_estatisticas"]==n and audit["resumo"]["erros_criticos"]==0,"statistical audit")
    stats=load("dados-br/estatisticas.json")
    require(stats["total_resultados_lidos"]==stats["total_eventos_processados"]==n,"general stats")
    ranking=load("dados-br/ranking-desempenho.json")["ranking"]
    require(len(ranking)==20 and {x["time"] for x in ranking}==set(clubs) and all(x["jogos"]==clubs[x["time"]][0] and x["metricas"]["jogos_com_boxscore"]==x["jogos"] for x in ranking),"ranking coverage")
    print(f"PASS R36-R7: {n}/{n} FINALs, boxscores, lineups, goals, assists, competition and ranking; public={comp['resumo']['jogos_com_publico']}; revenue={comp['resumo']['jogos_com_renda']}")
    return n

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--baseline",type=Path)
    p.add_argument("--protect-only",action="store_true")
    args=p.parse_args()
    baseline=read(args.baseline) if args.baseline else None
    if args.protect_only:
        require(baseline is not None,"baseline required")
        protect(baseline,read(ROOT/"dados-br/estatisticas-competicao.json"))
        print("PASS R36-R7 monotonic statistical publication")
    else:
        certify(baseline=baseline)
if __name__=="__main__":
    main()
