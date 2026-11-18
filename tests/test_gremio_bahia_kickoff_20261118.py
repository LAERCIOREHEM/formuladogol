"""CBF official kickoff integrity: Grêmio x Bahia, event 401841312."""
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
ID = "401841312"
expected = "2026-11-18T21:30"
paths = [
    "jogos.json", "espn_eventos.json", "dados-br/calendario-completo.json",
    "dados-br/agenda-clubes-br.json", "dados-br/probabilidades-jogos.json",
    "dados-br/probabilidades-brasileirao.json", "dados-br/transmissoes-tv.json",
    "dados-br/transmissoes-guardiao.json", "dados-br/auditoria-transmissoes-aovivo.json",
]
def matching_records(x):
    if isinstance(x, dict):
        if str(x.get("event_id") or "") == ID:
            yield x
        for v in x.values():
            yield from matching_records(v)
    elif isinstance(x, list):
        for v in x:
            yield from matching_records(v)

for path in paths:
    payload = json.loads((ROOT / path).read_text(encoding="utf-8"))
    matches = list(matching_records(payload))
    assert matches, f"{path}: fixture absent"
    for match in matches:
        date = match.get("data_iso")
        if date:
            assert date.startswith(expected), (path,date)
            assert "2026-11-18T17:00" not in date, (path,date)
adjustments=json.loads((ROOT/"dados-br/ajustes-calendario.json").read_text(encoding="utf-8"))
official=[r for r in adjustments["ajustes"] if str(r.get("event_id"))==ID]
assert len(official)==1
assert official[0]["data_iso"]==expected
assert official[0]["fonte_calendario"].startswith("CBF oficial — tabela detalhada")
print("PASS: Grêmio x Bahia 21h30 BRT in 9 feeds + authoritative persistent override")
