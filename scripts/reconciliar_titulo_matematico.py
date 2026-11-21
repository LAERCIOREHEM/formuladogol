#!/usr/bin/env python3
"""Selo matemático do título por pontos/vitórias, sem repetir Monte Carlo."""
import argparse
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
ODDS=ROOT/"dados-br/probabilidades-brasileirao.json"
CBF="https://www.cbf.com.br/futebol-brasileiro/noticias/campeonato-brasileiro-serie-a/a/flamengo-conquista-brasileirao-2026"

def load(name):
    return json.loads((ROOT/name).read_text(encoding="utf-8"))

def certify(odds, table, games):
    standings={x["time"]:x for x in table.get("tabela",[]) if x.get("time")}
    clubs={x["clube"]:x for x in odds.get("clubes",[]) if x.get("clube")}
    if len(standings)!=20 or len(clubs)!=20 or set(standings)!=set(clubs):
        return odds,"incomplete_clubs"
    pending=[x for x in games.get("jogos",[]) if x.get("estado")!="post" and not x.get("concluido")]
    remaining={name:0 for name in standings}
    for game in pending:
        a=(game.get("mandante") or {}).get("nome")
        b=(game.get("visitante") or {}).get("nome")
        if a not in remaining or b not in remaining or a==b:
            return odds,"invalid_fixture"
        remaining[a]+=1
        remaining[b]+=1
    if any(int(row["jogos"])+remaining[name]!=38 for name,row in standings.items()):
        return odds,"incomplete_38_round_schedule"
    if (odds.get("base_corrente") or {}).get("partidas_restantes")!=len(pending):
        return odds,"stale_probability_fixture_count"
    if any(int(clubs[name]["pontos_atuais"])!=int(row["pontos"]) or
           int(clubs[name]["jogos_atuais"])!=int(row["jogos"])
           for name,row in standings.items()):
        return odds,"stale_probability_standings"

    winners=[]
    for name,row in standings.items():
        points,wins=int(row["pontos"]),int(row["vitorias"])
        if all(other==name or int(rival["pontos"])+3*remaining[other]<points or
               (int(rival["pontos"])+3*remaining[other]==points and
                int(rival["vitorias"])+remaining[other]<wins)
               for other,rival in standings.items()):
            winners.append(name)
    if len(winners)!=1:
        return odds,"title_not_yet_certifiable"
    winner=winners[0]
    simulations=int((odds.get("simulacao") or {}).get("quantidade") or 0)
    if simulations<1:
        raise ValueError("invalid_simulations")
    for name,item in clubs.items():
        expected=simulations if name==winner else 0
        actual=item["probabilidades_detalhes"]["campeao"]["ocorrencias"]
        raw=item["probabilidades_pct"]["campeao"]
        if actual!=expected or raw!=(100 if name==winner else 0):
            raise ValueError(f"certified winner conflicts with Monte Carlo: {name}")
    leader=standings[winner]
    reason=(f"Título matematicamente assegurado: {winner}, {leader['pontos']} pontos e "
            f"{leader['vitorias']} vitórias. Nenhum adversário pode ultrapassar ou "
            "igualar esses pontos e vitórias, mesmo vencendo todas as partidas restantes.")
    for name,item in clubs.items():
        certain=name==winner
        item["probabilidades_detalhes"]["campeao"].update({
            "exibicao":"100%" if certain else "0%",
            "possivel_estruturalmente":certain,
            "impossivel_estruturalmente":not certain,
            "certeza_estrutural":certain,
            "motivo_certeza":reason if certain else None,
            "motivo_impossibilidade":None if certain else reason,
            "limite_superior_95_regra_dos_tres_pct":None,
        })
        if certain:
            item["situacao_matematica"]={**item.get("situacao_matematica",{}),
                "titulo":"campeao_confirmado","fundamento_titulo":reason}
    if winner=="Flamengo" and odds.get("temporada")==2026:
        odds["titulo_matematico_2026"]={"campeao":winner,"confirmado":True,
            "probabilidade_pct":100,"rodada":36,"criterio":"pontos e vitórias",
            "fonte":CBF,"fundamento":reason}
    highlight=(odds.get("destaques") or {}).get("maior_chance_titulo")
    if isinstance(highlight,dict) and highlight.get("clube")==winner:
        highlight.update({"probabilidade_pct":100,"certeza_estrutural":True,
            "situacao":"Campeão brasileiro de 2026"})
    return odds,winner

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--apply",action="store_true")
    parser.add_argument("--self-test",action="store_true")
    args=parser.parse_args()
    odds=load("dados-br/probabilidades-brasileirao.json")
    table=load("tabela.json")
    games=load("jogos.json")
    before=json.dumps(odds,ensure_ascii=False,sort_keys=True)
    updated,status=certify(odds,table,games)
    if args.self_test:
        assert status=="Flamengo",status
        assert updated["titulo_matematico_2026"]["confirmado"]
        assert updated["clubes"][0]["probabilidades_detalhes"]["campeao"]["certeza_estrutural"]
        tampered=json.loads(json.dumps(games))
        tampered["jogos"]=tampered["jogos"][:-1]
        _,state=certify(load("dados-br/probabilidades-brasileirao.json"),table,tampered)
        assert state=="incomplete_38_round_schedule",state
    if args.apply and before!=json.dumps(updated,ensure_ascii=False,sort_keys=True):
        tmp=ODDS.with_suffix(".tmp")
        tmp.write_text(json.dumps(updated,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
        tmp.replace(ODDS)
    print(json.dumps({"certificado":status,"alterado":before!=json.dumps(updated,ensure_ascii=False,sort_keys=True)},ensure_ascii=False))
if __name__=="__main__":
    main()
