"""Brasileirão R36: official champion proven by points and wins, not Monte Carlo."""
import json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"scripts"))
from gerar_probabilidades_brasileirao import champion_certified_by_points_wins
t=json.loads((ROOT/"tabela.json").read_text(encoding="utf-8"))["tabela"]
pending=json.loads((ROOT/"jogos.json").read_text(encoding="utf-8"))["jogos"]
remaining=[(g["mandante"]["nome"],g["visitante"]["nome"]) for g in pending if g.get("estado")!="post"]
standings={r["time"]:{"pontos":r["pontos"],"vitorias":r["vitorias"]} for r in t}
counts={k:0 for k in standings}
for a,b in remaining:
    counts[a]+=1
    counts[b]+=1
assert len(standings)==20
assert all(x["jogos"]+counts[x["time"]]==38 for x in t)
assert champion_certified_by_points_wins(standings,remaining)=="Flamengo"
assert champion_certified_by_points_wins({"A":{"pontos":80,"vitorias":24},"B":{"pontos":74,"vitorias":22}},[("A","B"),("A","B")]) is None
assert champion_certified_by_points_wins({"A":{"pontos":80,"vitorias":24},"B":{"pontos":74,"vitorias":21}},[("A","B"),("A","B"),("A","B")]) is None
p=json.loads((ROOT/"dados-br/probabilidades-brasileirao.json").read_text(encoding="utf-8"))
assert p["titulo_matematico_2026"]["confirmado"] and p["titulo_matematico_2026"]["campeao"]=="Flamengo"
assert sum(x["probabilidades_pct"]["campeao"] for x in p["clubes"])==100
for x in p["clubes"]:
    win=x["clube"]=="Flamengo"
    d=x["probabilidades_detalhes"]["campeao"]
    assert d["exibicao"]==("100%" if win else "0%"),x["clube"]
    assert d["certeza_estrutural"] is win
    assert d["impossivel_estruturalmente"] is (not win)
print("PASS: Flamengo is champion with 100% mathematical certainty")
