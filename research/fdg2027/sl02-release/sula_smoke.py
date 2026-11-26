"""Sul-Americana final regression respecting the two published rolling windows.

The historical event remains certified in the repository archive; the public
agenda and TV feed are not historical archives. No writes or provider calls.
"""
from datetime import datetime,timedelta
from pathlib import Path
import json,sys,time
from urllib.request import Request,urlopen
from urllib.parse import urlparse
ROOT=Path(__file__).resolve().parents[3]
HOST="https://formuladogol.com.br"
EVENT="401913961"
KICKOFF="2026-11-21T20:00:00-03:00"
K= datetime.fromisoformat(KICKOFF)
def parse(v):
    d=datetime.fromisoformat(v.replace("Z","+00:00"))
    assert d.tzinfo is not None,"Missing offset"
    return d
def load(path):return json.loads((ROOT/path).read_text(encoding="utf-8"))
def name(x,k):
    v=x[k]
    return v["nome"] if isinstance(v,dict) else v
def identity(x):
    assert str(x["event_id"])==EVENT
    assert parse(x["data_iso"])==K
    assert name(x,"mandante")=="Atlético-MG"
    assert name(x,"visitante")=="Boca Juniors"
def archive():
    games=load("dados-br/competicoes-af-previsao/sul-americana.json")["eventos"]
    rows=[x for x in games if str(x.get("event_id"))==EVENT]
    assert len(rows)==1,"Historical final absent or duplicate"
    g=rows[0];identity(g)
    assert g["fase"].split(",")[-1].strip()=="Final"
    return g
def verify(agenda,tv,manual,archived,cfg):
    identity(archived)
    start,end=map(parse,(agenda["periodo"]["inicio"],agenda["periodo"]["fim"]))
    generated=parse(agenda["gerado_em"])
    assert start<=generated<=end and end>=start,"Invalid agenda period"
    assert agenda["integridade_continental"]["status"]=="ok"
    assert not agenda["integridade_continental"]["faltantes"]
    matches=[x for x in agenda["jogos"] if str(x.get("event_id"))==EVENT]
    inside=start<=K<=end
    assert len(matches)==int(inside),("agenda event count",len(matches),"expected",int(inside))
    if inside:
        identity(matches[0])
        assert matches[0]["fase"].split(",")[-1].strip()=="Final"
    elif K<start:
        assert archived.get("concluido") is True and archived.get("estado")=="post","Historical final not certified"
        assert all(isinstance(archived[k]["placar"],int) for k in ("mandante","visitante"))
    else:raise AssertionError("Final outside future agenda horizon; not certified")
    policy=[x for x in manual["transmissoes"] if str(x.get("event_id"))==EVENT]
    assert len(policy)==1,"Historical editorial policy absent or duplicate"
    identity(policy[0])
    assert policy[0]["modo"]=="fixo" and policy[0]["exibicao_confirmada"]=="Disney+ Premium"
    assert urlparse(policy[0]["fonte_url"]).hostname in ("disneyplus.com","www.disneyplus.com")
    tv_now=parse(tv["atualizado_em"])
    tv_start=tv_now-timedelta(days=int(cfg["janela_passado_dias"]))
    tv_end=tv_now+timedelta(days=int(cfg["janela_futuro_dias"]))
    assert tv_start<=tv_now<=tv_end
    tv_required=tv_start<=K<=tv_end
    entry=tv["jogos"].get(EVENT)
    if tv_required or entry is not None:
        assert entry is not None,"TV coverage missing inside window"
        assert parse(entry["data_iso"])==K
        assert entry["exibicao_confirmada"]=="Disney+ Premium"
        assert any(urlparse(x.get("url","")).hostname in ("disneyplus.com","www.disneyplus.com") for x in entry["acessos"])
    elif K<tv_start:assert archived.get("concluido") is True,"Expired TV without certified final"
    else:raise AssertionError("Final outside future TV horizon; not certified")
    return {"agenda":"in-window" if inside else "historical","tv":"in-window" if tv_required else "historical","archive_final":archived.get("concluido") is True}
def self_test():
    # Source-derived real archive/policy. Synthetic windows are deliberately
    # independent of the day the test runs; no provider query.
    g=archive();identity(g);m=load("transmissoes.json");cfg=load("dados-br/config-transmissoes-tv.json")
    a=load("dados-br/agenda-clubes-br.json");t=load("dados-br/transmissoes-tv.json")
    print("CURRENT SOURCE:",verify(a,t,m,g,cfg))
    fixture=dict(g,fase="Final")
    before={"gerado_em":"2026-11-20T08:00:00-03:00","periodo":{"inicio":"2026-11-20T00:00:00-03:00","fim":"2026-12-31T23:59:59-03:00"},"integridade_continental":{"status":"ok","faltantes":[]},"jogos":[fixture]}
    future={"atualizado_em":"2026-11-20T08:00:00-03:00","jogos":{EVENT:{"data_iso":KICKOFF,"exibicao_confirmada":"Disney+ Premium","acessos":[{"url":"https://www.disneyplus.com/"}]}}}
    assert verify(before,future,m,g,cfg)["agenda"]=="in-window"
    for bad_a,bad_t in [(dict(before,jogos=[]),future),(dict(before,jogos=[fixture,fixture]),future),(before,dict(future,jogos={}))]:
        try:verify(bad_a,bad_t,m,g,cfg)
        except AssertionError:pass
        else:raise AssertionError("Regression accepted missing/duplicate in-window event")
    historical=dict(before,gerado_em="2026-11-25T08:00:00-03:00",periodo={"inicio":"2026-11-25T00:00:00-03:00","fim":"2026-12-31T23:59:59-03:00"},jogos=[])
    expired={"atualizado_em":"2026-11-25T08:00:00-03:00","jogos":{}}
    completed=dict(g,concluido=True,estado="post",mandante=dict(g["mandante"],placar=0),visitante=dict(g["visitante"],placar=2))
    assert verify(historical,expired,m,completed,cfg)["agenda"]=="historical"
    try:verify(historical,expired,m,dict(completed,concluido=False),cfg)
    except AssertionError:pass
    else:raise AssertionError("Historical missing final proof accepted")
    print("SULA WINDOW CONTRACT PASS: before, after, duplicate, missing TV, missing archive final")
def live():
    def read(path):
        req=Request(HOST+path+"?sula_verify="+str(int(time.time())),headers={"User-Agent":"FDG-Sula-Final-Smoke/2.0","Cache-Control":"no-cache"})
        with urlopen(req,timeout=20) as r:return r.read().decode("utf-8")
    for attempt in range(4):
        try:
            result=verify(json.loads(read("/dados-br/agenda-clubes-br.json")),json.loads(read("/dados-br/transmissoes-tv.json")),json.loads(read("/transmissoes.json")),archive(),load("dados-br/config-transmissoes-tv.json"))
            assert "jogosCompeticao.length && !temJogoNoPeriodo" in read("/index.html")
            assert "months.find((value) => value >= current)" in read("/js/br-agenda.js")
            print("LIVE PRODUCTION PASS",json.dumps(result),flush=True);return
        except Exception as e:
            print("Attempt",attempt+1,str(e),flush=True)
            if attempt==3:raise
            time.sleep(10)
if __name__=="__main__":
    if sys.argv[1:]==["--self-test"]:self_test()
    elif sys.argv[1:]==["--live"]:live()
    else:raise SystemExit("Choose --self-test or --live")
