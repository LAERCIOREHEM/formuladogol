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
assert chap["situacao_matematica"]["limite_posicao_melhor"] > chap["situacao_matematica"]["limite_total_classificados"]
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

# Regressão integral: vaga-base confirmada implica Libertadores garantida e
# impossibilidade estrutural dos dois demais destinos (não basta 2M/2M).
for name in ("Flamengo", "Palmeiras"):
    team = next(row for row in data["clubes"] if row["clube"] == name)
    assert team["probabilidades_detalhes"]["libertadores_base"]["certeza_estrutural"] is True
    expected_destinations = {"libertadores": (100, "100%"), "sul_americana": (0, "0%"), "sem_competicao_continental": (0, "0%")}
    for field, (value, label) in expected_destinations.items():
        detail = team["probabilidades_detalhes"][field]
        assert (team["probabilidades_pct"][field], detail["exibicao"]) == (value, label), (name, field)
        assert detail["certeza_estrutural"] is (value == 100), (name, field)
        assert detail["impossivel_estruturalmente"] is (value == 0), (name, field)
        assert detail["motivo_certeza"] or detail["motivo_impossibilidade"], (name, field)
        assert team["decomposicao_chances"][field]["total"]["exibicao"] == label
    via = team["decomposicao_chances"]["libertadores"]["vias"]["via_brasileirao"]
    assert via["certeza_estrutural"] is True and via["exibicao"] == "100%"
    # Reproduz a origem do defeito num snapshot cru, preservando as chances.
    stale = copy.deepcopy(team)
    for field in expected_destinations:
        d = stale["probabilidades_detalhes"][field]
        d["exibicao"] = ">99,999%" if field == "libertadores" else "<0,001%"
        d["certeza_estrutural"] = False
        d["impossivel_estruturalmente"] = False
        d["possivel_estruturalmente"] = True
    prior_probabilities = copy.deepcopy(stale["probabilidades_pct"])
    proof_base = {name: {
        "rebaixamento": {"clubes_certos_acima": 0, "melhor_posicao_possivel": 1},
        "libertadores_base": {"certo": True, "motivo_certeza": "G5 garantido por limites de pontos"},
    }}
    apply_continental_mathematical_certainty([stale], proof_base, config)
    assert stale["probabilidades_pct"] == prior_probabilities
    assert stale["probabilidades_detalhes"]["libertadores"]["exibicao"] == "100%"
    assert stale["probabilidades_detalhes"]["sul_americana"]["exibicao"] == "0%"
    assert stale["probabilidades_detalhes"]["sem_competicao_continental"]["exibicao"] == "0%"

# O terceiro colocado tem no máximo a 9ª posição pelo limite de pontos.
# Portanto, ter vaga continental é certeza, mas Libertadores vs Sul-Americana
# ainda não está decidido: preservar as probabilidades integradas.
cruz = next(row for row in data["clubes"] if row["clube"] == "Cruzeiro")
assert cruz["situacao_matematica"]["vaga_continental_garantida"] is True
assert cruz["situacao_matematica"]["limite_posicao_pior"] <= 11
assert cruz["probabilidades_pct"]["sem_competicao_continental"] == 0
assert cruz["probabilidades_detalhes"]["sem_competicao_continental"]["exibicao"] == "0%"
assert cruz["probabilidades_detalhes"]["sem_competicao_continental"]["impossivel_estruturalmente"] is True
assert 0 < cruz["probabilidades_pct"]["libertadores"] < 100
assert 0 < cruz["probabilidades_pct"]["sul_americana"] < 100
cruz_replay = copy.deepcopy(cruz)
cruz_replay["probabilidades_detalhes"]["sem_competicao_continental"].update({
    "exibicao": "<0,001%", "impossivel_estruturalmente": False,
    "possivel_estruturalmente": True,
})
proof_g11 = {"Cruzeiro": {
    "rebaixamento": {
        "clubes_certos_acima": 1, "melhor_posicao_possivel": 2,
        "pior_posicao_possivel": 9,
    },
}}
apply_continental_mathematical_certainty([cruz_replay], proof_g11, config)
assert cruz_replay["probabilidades_detalhes"]["sem_competicao_continental"]["exibicao"] == "0%"
assert cruz_replay["probabilidades_pct"] == cruz["probabilidades_pct"]

# Sem prova de G11, zero em 2M simulações continua empírico.
flu = next(row for row in data["clubes"] if row["clube"] == "Fluminense")
assert flu["probabilidades_pct"]["sem_competicao_continental"] == 0
assert flu["probabilidades_detalhes"]["sem_competicao_continental"]["impossivel_estruturalmente"] is False

# Nunca declarar certeza matemática a partir de arredondamento ou 2M/2M.
for team in data["clubes"]:
    p = team["probabilidades_pct"]
    d = team["probabilidades_detalhes"]
    destinations = ("libertadores", "sul_americana", "sem_competicao_continental")
    assert abs(sum(p[key] for key in destinations) - 100) < 1e-5, team["clube"]
    for field in destinations + ("campeao", "g4", "g6", "rebaixamento"):
        detail = d[field]
        if detail.get("certeza_estrutural") is True:
            assert p[field] == 100 and detail["exibicao"] == "100%", (team["clube"], field)
        if detail.get("impossivel_estruturalmente") is True:
            assert p[field] == 0 and detail["exibicao"] == "0%", (team["clube"], field)

# A implementação só pode alterar os metadados estruturais e não os percentuais.
assert before["probabilidades_pct"] == chap["probabilidades_pct"]
assert sum(chap["probabilidades_pct"][key] for key in expected) == 100
print("PASS: Chapecoense 0/0/100 certificado; regeneração, copas e ausência de prova protegidas")
