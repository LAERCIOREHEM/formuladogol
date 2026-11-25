import copy
import json
import sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"scripts"))
from af_matematica_libertadores import certify_cup_finalist_exclusion
def read(p):
    return json.loads((ROOT/p).read_text(encoding="utf-8"))
data=read("dados-br/probabilidades-brasileirao.json")
cup=read("dados-br/competicoes-af-previsao/copa-do-brasil.json")
config=read("dados-br/config-af-previsao.json")["execucao_2_5"]
teams=copy.deepcopy(data["clubes"])
original=copy.deepcopy(teams)
assert set(certify_cup_finalist_exclusion(teams,cup,config))=={"Grêmio","Palmeiras"}
g=next(t for t in teams if t["clube"]=="Grêmio")
before=next(t for t in original if t["clube"]=="Grêmio")
assert g["probabilidades_pct"]==before["probabilidades_pct"]
assert g["probabilidades_detalhes"]["rebaixamento"]==before["probabilidades_detalhes"]["rebaixamento"]
assert g["probabilidades_detalhes"]["libertadores"]==before["probabilidades_detalhes"]["libertadores"]
assert g["probabilidades_detalhes"]["sul_americana_base"]==before["probabilidades_detalhes"]["sul_americana_base"]
for d in [g["probabilidades_detalhes"]["sul_americana"],g["decomposicao_chances"]["sul_americana"]["total"],*g["decomposicao_chances"]["sul_americana"]["vias"].values()]:
    assert d["exibicao"]=="0%" and d["impossivel_estruturalmente"] is True and d["possivel_estruturalmente"] is False and d["limite_superior_95_regra_dos_tres_pct"] is None
assert all(t==o for t,o in zip(teams,original) if t["clube"] not in ("Grêmio","Palmeiras"))
assert certify_cup_finalist_exclusion(copy.deepcopy(original),{**cup,"eventos":[]},config)==[]
assert certify_cup_finalist_exclusion(copy.deepcopy(original),cup,{**config,"rebaixamento_a_partir_da_posicao":15})==[]
bad=copy.deepcopy(original)
next(t for t in bad if t["clube"]=="Grêmio")["probabilidades_pct"]["sul_americana"]=0.01
try:
    certify_cup_finalist_exclusion(bad,cup,config)
except ValueError:
    pass
else:
    raise AssertionError("contradição numérica não bloqueada")
print("PASS R37: finalistas Copa, zero estrutural, vias exclusivas e percentuais preservados")
