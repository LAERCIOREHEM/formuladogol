import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from gerar_auditoria_calendario import normalizar_estadio_cbf,preservar_estadios_cbf_finais
from gerar_estatisticas_competicao_brasileirao import preservar_publico_publicado
from validar_recuperacao_estatistica_r36r7 import protect
assert normalizar_estadio_cbf("Estadio Beira-Rio")==normalizar_estadio_cbf("Beira-Rio")
assert normalizar_estadio_cbf("Beira-Rio")!=normalizar_estadio_cbf("Arena do Grêmio")
game={"rodada":36,"mandante":"Internacional","visitante":"Vitória","estado":"post","estadio":"Estadio Beira-Rio","data_iso":"2026-11-23T19:30","placar_mandante":2,"placar_visitante":5}
fix={**game,"estadio":"Beira-Rio","fonte_calendario":"CBF oficial — tabela detalhada","origem_calendario":"CBF"}
preservar_estadios_cbf_finais([game],[fix])
assert game["estadio"]=="Beira-Rio" and game["estado"]=="post" and game["placar_visitante"]==5
wrong={**game,"estadio":"Arena do Grêmio"}
preservar_estadios_cbf_finais([wrong],[fix])
assert wrong["estadio"]=="Arena do Grêmio"
row={**game,"event_id":"1","publico":40968,"renda":1706912,"tem_estatisticas":True}
old={"jogos":[row]}
r=preservar_publico_publicado({"1":{"stats":[1],"publico":None}},old,[row])
assert r["1"]["publico"]==40968 and r["1"]["renda"]==1706912 and r["1"]["stats"]==[1]
protect(old,{"jogos":[{**row,"publico":40969}]})
try:
    protect(old,{"jogos":[{**row,"renda":None}]})
except ValueError:
    pass
else:
    raise AssertionError("lost revenue accepted")
print("PASS R36-R7: CBF alias, true stadium mismatch, FINAL preservation, documentary attendance and regression guard")
