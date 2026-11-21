"""Público e renda do jogo Bahia x Coritiba, fonte oficial fotografada."""
import json, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"scripts"))
from gerar_estatisticas_competicao_brasileirao import merge_documented_attendance
EVENT="401841327"
verified=json.loads((ROOT/"dados-br/correcoes/publicos-verificados.json").read_text(encoding="utf-8"))
complement=json.loads((ROOT/"dados-br/publicos-complementares.json").read_text(encoding="utf-8"))
source=verified["jogos"][EVENT]
assert source["publico"] == 35113 and source["pagantes"] == 34799
assert source["renda"] == 1244687
breakdown=source["detalhamento_pagantes"]
assert breakdown["bilheteria"]+breakdown["corporativo"]+breakdown["socios"] == source["pagantes"]
assert source["pagantes"]+breakdown["nao_pagantes"]==source["publico"]
results=[{"event_id":EVENT,"mandante":{"nome":"Bahia"},"visitante":{"nome":"Coritiba"}}]
details={EVENT:{"publico":None,"publico_pagante":None,"renda":None,"gols":[{"id":"safe"}]}}
merged=merge_documented_attendance(details,complement,verified,results)
row=merged[EVENT]
assert (row["publico"],row["publico_pagante"],row["renda"])==(35113,34799,1244687)
assert row["gols"]==details[EVENT]["gols"],"não alterar os detalhes esportivos"
unchanged=merge_documented_attendance(merged,complement,verified,results)
assert unchanged==merged,"idempotência"
stale={EVENT:{"publico":1,"publico_pagante":1,"renda":1}}
corrected=merge_documented_attendance(stale,complement,verified,results)
assert all(corrected[EVENT][k]==row[k] for k in ("publico","publico_pagante","renda"))
print("OK: Fonte Nova 35.113 presentes, 34.799 pagantes e R$ 1.244.687; reconciliação idempotente")
