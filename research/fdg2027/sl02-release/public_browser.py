"""First visual activation: fail-closed schedule guard and real browser smoke.
Only reads public static assets from the FDG domain; no provider collection,
push, analytics, write requests or external APIs.
"""
import argparse,asyncio,json,time
from datetime import datetime,timedelta
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.parse import urlparse
from zoneinfo import ZoneInfo
HOST="https://formuladogol.com.br"
TZ=ZoneInfo("America/Sao_Paulo")
LABELS=["Estatísticas","Jogos","Ao vivo","Análises","Clubes","Mais"]
ICONS=["📊","⚽","🔴","📰","🛡️","☰"]
def read(path):
    req=Request(HOST+path+"?sl02_preflight="+str(int(time.time())),headers={"Cache-Control":"no-cache","User-Agent":"FDG-SL02-Release/1.0"})
    with urlopen(req,timeout=20) as r:return json.load(r)
def date(v):
    d=datetime.fromisoformat(v.replace("Z","+00:00"))
    return d.astimezone(TZ) if d.tzinfo else d.replace(tzinfo=TZ)
def guard(agenda,games,af,now,margin=75):
    assert af["concluidos"]+af["restantes"]==380
    assert len(games["jogos"])==af["restantes"],"Current schedule/AF mismatch"
    assert agenda["integridade_continental"]["status"]=="ok"
    assert date(agenda["periodo"]["inicio"])<=now<=date(agenda["periodo"]["fim"])
    upcoming=[]
    for g in agenda["jogos"]+games["jogos"]:
        assert g.get("estado") not in ("in","live","halftime"),"Live game: "+str(g.get("event_id"))
        if g.get("concluido") is True or g.get("estado")=="post" or g.get("adiado") is True or g.get("data_definir") is True:continue
        d=date(g["data_iso"])
        assert d>now,"Unresolved kickoff already elapsed: "+str(g.get("event_id"))
        upcoming.append(d)
    nxt=min(upcoming) if upcoming else None
    if nxt:assert nxt-now>=timedelta(minutes=margin),"Insufficient safe window: "+nxt.isoformat()
    return {"now":now.isoformat(),"next_kickoff":nxt.isoformat() if nxt else None,"margin_minutes":margin,"finals":af["concluidos"],"remaining":af["restantes"],"live":0}
def preflight():
    now=datetime.now(TZ)
    result=guard(read("/dados-br/agenda-clubes-br.json"),read("/jogos.json"),read("/dados-br/af-core-manifest.json"),now)
    print("SL02 SAFE WINDOW PASS",json.dumps(result),flush=True)
def selftest():
    now=date("2026-11-26T18:00:00-03:00")
    a={"periodo":{"inicio":"2026-11-26T00:00:00-03:00","fim":"2026-12-31T23:59:59-03:00"},"integridade_continental":{"status":"ok"},"jogos":[]}
    f={"concluidos":379,"restantes":1}
    game={"event_id":"fixture","data_iso":"2026-11-26T20:00","estado":"pre"}
    assert guard(a,{"jogos":[game]},f,now)["live"]==0
    for g in (dict(game,estado="in"),dict(game,data_iso="2026-11-26T18:30"),dict(game,data_iso="2026-11-26T17:59")):
        try:guard(a,{"jogos":[g]},f,now)
        except AssertionError:pass
        else:raise AssertionError("Unsafe kickoff allowed")
    print("SL02 schedule guard fixture PASS")
async def browser(out):
    from playwright.async_api import async_playwright
    from qa import MEASURE
    out.mkdir(parents=True,exist_ok=True)
    evidence=[]
    async with async_playwright() as p:
        b=await p.chromium.launch()
        for width,mobile in ((1440,False),(390,True),(320,True)):
            errors=[]
            ctx=await b.new_context(viewport={"width":width,"height":900},is_mobile=mobile,has_touch=mobile,device_scale_factor=1,service_workers="block")
            async def route(r):
                if r.request.url.startswith(HOST+"/") and r.request.method in ("GET","HEAD"):await r.continue_()
                else:await r.abort()
            await ctx.route("**/*",route)
            page=await ctx.new_page()
            page.on("pageerror",lambda e:errors.append(str(e)))
            await page.goto(HOST+"/?sl02_live="+str(int(time.time())),wait_until="domcontentloaded",timeout=35000)
            await page.locator("#fdg-main[aria-busy=false]").wait_for(timeout=30000)
            assert urlparse(page.url).hostname=="formuladogol.com.br"
            assert await page.locator("#fdg-main h1").text_content()!="Dados indisponíveis"
            assert await page.locator(".fdg-nav").count()==1
            m=await page.evaluate(MEASURE)
            assert m["columns"]==(3 if mobile else 6)
            assert m["client"]==width and m["scroll"]<=m["client"]+1 and m["navScroll"]<=m["navClient"]+1
            assert m["active"]==1 and m["visibleMenus"]==1
            assert [x["text"] for x in m["labels"]]==LABELS and [x["icon"] for x in m["labels"]]==ICONS
            assert all(x["inside"] and x["above"] for x in m["labels"])
            assert await page.get_by_text("2026 · Vigente",exact=True).count()==1
            assert await page.get_by_text("2027 · Em breve",exact=True).count()==1
            assert await page.locator(".rank-button:visible").count()==20
            assert await page.get_by_role("tab").count()==5
            await page.screenshot(path=str(out/f"producao-{width}-probabilidades.png"))
            await page.get_by_role("tab",name="Classificação",exact=True).click()
            await page.wait_for_function("location.hash==='#stats/table'&&document.querySelectorAll('tbody tr[data-club]').length===20&&document.querySelector('#fdg-main[aria-busy=false]')")
            await page.screenshot(path=str(out/f"producao-{width}-classificacao.png"))
            assert not errors,errors
            evidence.append({"viewport":width,"mobile_emulation":mobile,"url":page.url,"menu":m,"classificacao_clubes":20,"errors":errors})
            await ctx.close()
        await b.close()
    (out/"public-browser.json").write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding="utf-8")
    print("SL02 REAL PUBLIC BROWSER PASS",json.dumps(evidence,ensure_ascii=False),flush=True)
if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("action",choices=("self-test","preflight","browser"));p.add_argument("--output",type=Path)
    a=p.parse_args()
    if a.action=="self-test":selftest()
    elif a.action=="preflight":preflight()
    else:asyncio.run(browser(a.output))
