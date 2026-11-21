"""R36 CBF kickoff consistency (Botafogo x São Paulo). No network or AI needed."""
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
ID="401841326"
EXPECTED="2026-11-23T20:00"
SOURCES=("jogos.json","espn_eventos.json","dados-br/calendario-completo.json",
 "dados-br/agenda-clubes-br.json","dados-br/probabilidades-jogos.json",
 "dados-br/probabilidades-brasileirao.json","dados-br/transmissoes-tv.json",
 "dados-br/transmissoes-guardiao.json")
def records(value):
    if isinstance(value,dict):
        if str(value.get("event_id") or "")==ID:
            yield value
        for item in value.values():
            yield from records(item)
    elif isinstance(value,list):
        for item in value:
            yield from records(item)
for path in SOURCES:
    data=json.loads((ROOT/path).read_text(encoding="utf-8"))
    matches=[x for x in records(data) if "data_iso" in x]
    assert len(matches)==1,(path,len(matches))
    game=matches[0]
    assert str(game["data_iso"]).startswith(EXPECTED),(path,game["data_iso"])
    if "estado" in game:
        assert game["estado"]=="pre",(path,game["estado"])
    if "concluido" in game:
        assert game["concluido"] is False,path
corrections=json.loads((ROOT/"dados-br/ajustes-calendario.json").read_text(encoding="utf-8"))
official=[x for x in corrections["ajustes"] if str(x.get("event_id"))==ID]
assert len(official)==1
fix=official[0]
assert fix["data_iso"]==EXPECTED
assert fix["rodada"]==36 and fix["referencia_cbf"]==352
assert fix["fonte_calendario"].startswith("CBF oficial — tabela detalhada")
assert fix["origem_calendario"].startswith("https://www.cbf.com.br/")
print("CBF R36 23/11 20h: 8 feeds e correção permanente OK")
