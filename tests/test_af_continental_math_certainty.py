#!/usr/bin/env python3
"""Regression: structural proof must win over all continental Monte Carlo display strings."""
import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from gerar_probabilidades_brasileirao import apply_continental_mathematical_certainty

data = json.loads((ROOT / "dados-br/probabilidades-brasileirao.json").read_text(encoding="utf-8"))
chap = next(row for row in data["clubes"] if row["clube"] == "Chapecoense")
expected = {"libertadores": "0%", "sul_americana": "0%", "sem_competicao_continental": "100%"}
for field, display in expected.items():
    assert chap["probabilidades_detalhes"][field]["exibicao"] == display, field
    assert chap["decomposicao_chances"][field]["total"]["exibicao"] == display, field
    assert chap["probabilidades_detalhes"][field]["certeza_estrutural"] == (display == "100%")
    assert chap["probabilidades_detalhes"][field]["impossivel_estruturalmente"] == (display == "0%")
    assert chap["probabilidades_detalhes"][field]["limite_superior_95_regra_dos_tres_pct"] is None
assert chap["situacao_matematica"]["destino_continental"] == "sem_competicao_confirmado"
assert chap["situacao_matematica"]["limite_posicao_melhor"] == 17
assert chap["situacao_matematica"]["limite_total_classificados"] == 15
assert chap["probabilidades_detalhes"]["rebaixamento"]["certeza_estrutural"] is True
assert chap["probabilidades_detalhes"]["rebaixamento"]["exibicao"] == "100%"
assert all(d["exibicao"] == "0%" for d in chap["decomposicao_chances"]["libertadores"]["vias"].values())
assert all(d["exibicao"] == "0%" for d in chap["decomposicao_chances"]["sul_americana"]["vias"].values())

config = {
    "brasileirao_vagas_diretas": 4,
    "brasileirao_vagas_preliminares": 1,
    "sul_americana_vagas": 6,
}
proof = {"Chapecoense": {"rebaixamento": {
    "clubes_certos_acima": 16, "melhor_posicao_possivel": 17, "maximo_pontos": 36
}}}

# Reproduz exatamente a inconsistência anterior: dados numéricos 0/0/100,
# mas detalhes exibem <0,001% e >99,999% por não receber a prova.
before = copy.deepcopy(chap)
for key in ("libertadores", "sul_americana", "sem_competicao_continental"):
    detail = before["probabilidades_detalhes"][key]
    detail["exibicao"] = ">99,999%" if key == "sem_competicao_continental" else "<0,001%"
    detail["certeza_estrutural"] = False
    detail["impossivel_estruturalmente"] = False
    detail["possivel_estruturalmente"] = True
    before["decomposicao_chances"][key]["total"] = detail
for route in before["decomposicao_chances"]["libertadores"]["vias"].values():
    if route["impossivel_estruturalmente"] is False:
        route["exibicao"] = "<0,001%"
for route in before["decomposicao_chances"]["sul_americana"]["vias"].values():
    route["exibicao"] = "<0,001%"
apply_continental_mathematical_certainty([before], proof, config)
for key, label in expected.items():
    assert before["probabilidades_detalhes"][key]["exibicao"] == label, (key,before["probabilidades_detalhes"][key])
    assert before["decomposicao_chances"][key]["total"]["exibicao"] == label
assert before["situacao_matematica"]["destino_continental"] == "sem_competicao_confirmado"

# Contraexemplo: clube rebaixado que segue disputando um título de copa.
# Não se deve zerar a chance continental apenas porque foi rebaixado.
still_in_cup = copy.deepcopy(before)
still_in_cup["decomposicao_chances"]["libertadores"]["vias"]["via_copa_do_brasil"]["impossivel_estruturalmente"] = False
still_in_cup["decomposicao_chances"]["libertadores"]["vias"]["via_copa_do_brasil"]["exibicao"] = "<0,001%"
still_in_cup["probabilidades_detalhes"]["libertadores"]["exibicao"] = "<0,001%"
still_in_cup.pop("situacao_matematica",None)
apply_continental_mathematical_certainty([still_in_cup], proof, config)
assert still_in_cup["probabilidades_detalhes"]["libertadores"]["exibicao"] == "<0,001%"
assert not still_in_cup.get("situacao_matematica")

# Cenário sem prova: melhor posição 15 ou mais alta ainda pode ter vaga.
not_proven = copy.deepcopy(still_in_cup)
for route in ("via_copa_do_brasil", "via_titulo_libertadores", "via_titulo_sul_americana"):
    not_proven["decomposicao_chances"]["libertadores"]["vias"][route]["impossivel_estruturalmente"] = True
proof15 = {"Chapecoense": {"rebaixamento": {
    "clubes_certos_acima": 14, "melhor_posicao_possivel": 15, "maximo_pontos": 36
}}}
apply_continental_mathematical_certainty([not_proven], proof15, config)
assert not_proven["probabilidades_detalhes"]["libertadores"]["exibicao"] == "<0,001%"

# A implementação só pode alterar os metadados estruturais e não os percentuais.
assert before["probabilidades_pct"] == chap["probabilidades_pct"]
assert sum(chap["probabilidades_pct"][key] for key in expected) == 100
print("PASS: Chapecoense 0/0/100 certificado; regeneração, copas e ausência de prova protegidas")
