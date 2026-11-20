#!/usr/bin/env python3
"""R35-R1 — aplicar PROVA matemática em snapshot AF existente, sem Monte Carlo.

Usar somente quando resultados.json, tabela.json e agenda são compatíveis
com o mesmo snapshot publicado; não modifica chances simuladas, ocorrências,
hash_entrada, pesos, rankings ou distribuição das posições.
"""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from af_matematica_libertadores import (
    upper_rank_bound, apply_g6_continental_certainty, cup_g6_guaranteed,
    self_test as mathematical_self_test,
)

TABLE = ROOT / "tabela.json"
CALENDAR = ROOT / "dados-br" / "calendario-completo.json"
RESULTS = ROOT / "resultados.json"
ODDS = ROOT / "dados-br" / "probabilidades-brasileirao.json"
CUP = ROOT / "dados-br" / "competicoes-af-previsao" / "copa-do-brasil.json"

def load(path):
    return json.loads(path.read_text(encoding="utf-8"))

def certify(detail, certain, reason):
    detail.update({
        "exibicao": "100%" if certain else "0%",
        "possivel_estruturalmente": bool(certain),
        "impossivel_estruturalmente": not certain,
        "certeza_estrutural": bool(certain),
        "motivo_certeza": reason if certain else None,
        "motivo_impossibilidade": reason if not certain else None,
        "limite_superior_95_regra_dos_tres_pct": None,
    })

def apply(*, save=False):
    table,calendar,results,odds,cup = map(load,(TABLE,CALENDAR,RESULTS,ODDS,CUP))
    rows=table.get("tabela",[])
    clubs=odds.get("clubes",[])
    assert len(rows)==len(clubs)==20, "AF/tabela: 20 clubes obrigatórios"
    assert int(odds.get("simulacao",{}).get("quantidade") or 0)==2_000_000, "Não reprojetar amostra"
    assert int(odds.get("base_corrente",{}).get("partidas_concluidas") or 0)==len(results.get("resultados",[])), "Dados esportivos dessincronizados"
    reference={x["time"]:(int(x["pontos"]),int(x["vitorias"]),int(x["jogos"])) for x in rows}
    for x in clubs:
        ref=reference.get(x["clube"])
        assert ref and ref==(int(x["pontos_atuais"]),int(x.get("vitorias_atuais",ref[1])),int(x["jogos_atuais"])), ("tabela e AF divergentes",x["clube"])
    pending=[
        x for x in calendar.get("jogos",[])
        if x.get("concluido") is not True and x.get("estado") not in ("post",)
    ]
    assert len(pending)==int(odds["base_corrente"]["partidas_restantes"]), "Calendário e AF divergentes"
    fixtures=[(x["mandante"],x["visitante"]) for x in pending]
    standing={name:{"pontos":p,"vitorias":v} for name,(p,v,_) in reference.items()}

    structural={}
    modified=[]
    for item in clubs:
        name=item["clube"]
        worst=upper_rank_bound(name,standing,fixtures)
        if worst is None:
            continue
        structural[name]={"g4":{"certo":worst<=4},"g6":{"certo":worst<=6}}
        rank_before=item.get("situacao_matematica",{}).get("limite_posicao_pior")
        if rank_before is not None and int(worst)<int(rank_before):
            item["situacao_matematica"]["limite_posicao_pior"]=worst
            item["situacao_matematica"]["fundamento_posicao_pior"]=(
                "Limite combinatório conservador com confrontos remanescentes e vitórias."
            )
            modified.append(name+":rank"+str(worst))
        for key,k in (("g4",4),("libertadores_base",5),("g6",6)):
            if worst>k:
                continue
            detail=item["probabilidades_detalhes"][key]
            occurrences=int(detail["ocorrencias"])
            if occurrences != 2_000_000:
                raise ValueError(f"{name} tem G{k} matemático mas apenas {occurrences} cenários no Monte Carlo; falha fechada")
            if detail.get("certeza_estrutural") is True:
                continue
            certify(detail,True,
                f"Certificação combinatória: pior classificação possível {worst}º; "
                "confrontos diretos, pontos e vitórias respeitados em todos os cenários.")
            modified.append(name+":"+key)

    if not cup_g6_guaranteed(cup,structural):
        raise AssertionError("G6 da Copa não está comprovado no snapshot corrente")
    guaranteed=apply_g6_continental_certainty(clubs,structural,cup,certify)
    modified.extend(team+":libertadores100" for team in guaranteed)
    flu=next(x for x in clubs if x["clube"]=="Fluminense")
    assert flu["probabilidades_detalhes"]["libertadores"]["certeza_estrutural"] is True
    assert flu["probabilidades_detalhes"]["libertadores"]["exibicao"]=="100%"
    assert int(flu["situacao_matematica"]["limite_posicao_pior"])<=6
    assert flu["probabilidades_pct"]["libertadores"]==100
    assert odds["simulacao"]["quantidade"]==2_000_000
    print(json.dumps({"hotfix":"R35-R1","proof":"PASS",
        "Fluminense":{"libertadores":"100% matemático",
                       "pior_posicao":flu["situacao_matematica"]["limite_posicao_pior"]},
        "alteracoes":modified},ensure_ascii=False))
    if save:
        ODDS.write_text(json.dumps(odds,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    return modified

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--self-test",action="store_true")
    parser.add_argument("--apply",action="store_true")
    args=parser.parse_args()
    if args.self_test:
        mathematical_self_test()
    else:
        apply(save=args.apply)

if __name__=="__main__":
    main()
