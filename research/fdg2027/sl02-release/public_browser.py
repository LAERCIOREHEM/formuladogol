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
    from qa import MEASURE,live_layout,display_probability,player_totals,player_key
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
            # R1: confirm the actual public revision, responsive default and original AF values.
            assert await page.locator('script[src*="/sl02/app.js?v=sl02-ux-hf1-1"]').count()==1
            assert await page.locator("#sl02-pulse-details").count()==1
            assert not await page.locator("#sl02-pulse-details").evaluate("(e)=>e.open")
            assert not await page.locator("#sl02-freshness").is_visible()
            assert not await page.locator("#r1-prob-legend").evaluate("(e)=>e.open")
            assert not await page.locator(".prob-metrics").count()
            assert await page.get_by_role("tab").count()==5
            source=await page.evaluate("""async()=>{const r=await fetch('/dados-br/probabilidades-brasileirao.json',{cache:'no-cache'});if(!r.ok)throw Error('AF public '+r.status);return r.json()}""")
            assert source["temporada"]==2026 and "1.3" in source["versao_modelo"] and source["simulacao"]["quantidade"]==2000000
            indicators=["campeao","g4","g6","libertadores","sul_americana","sem_competicao_continental","rebaixamento"]
            expected={c["clube"]:{k:display_probability(c["probabilidades_detalhes"][k]) for k in indicators} for c in source["clubes"]}
            assert len(expected)==20
            default="Compacta" if mobile else "Comparativa"
            assert await page.get_by_role("button",name=default,exact=True).get_attribute("aria-pressed")=="true"
            density=await page.locator(".r1-compact-scroll" if mobile else ".hf-table-scroll").first.evaluate("(e)=>({top:e.getBoundingClientRect().top,first:e.querySelector('tbody tr').getBoundingClientRect().bottom,viewport:innerHeight,width:e.clientWidth,scroll:e.scrollWidth,pulse:document.querySelector('#sl02-pulse').getBoundingClientRect().height})")
            assert density["first"]<=density["viewport"],density
            if mobile:
                assert density["scroll"]<=density["width"]+1,density
                compact=await page.locator(".r1-compact tbody tr[data-prob-club]").evaluate_all("(rows)=>Object.fromEntries(rows.map(r=>[r.dataset.probClub,r.querySelector('.heat-cell').textContent]))")
                selected=await page.locator("select[data-change=indicator]").input_value()
                assert compact=={k:v[selected] for k,v in expected.items()}
            await page.screenshot(path=str(out/f"producao-{width}-probabilidades.png"))
            await page.locator("#sl02-pulse-details summary").click()
            assert await page.locator("#sl02-pulse .fdg-pulse-grid").is_visible()
            await page.locator("#sl02-pulse-details summary").click()
            await page.get_by_role("button",name="Comparativa",exact=True).click()
            await page.locator("#fdg-main[aria-busy=false]").wait_for()
            assert await page.locator(".hf-matrix tbody tr").count()==20
            assert await page.locator(".hf-matrix .heat-cell").count()==140
            actual=await page.locator(".hf-matrix tbody tr").evaluate_all("(rows)=>Object.fromEntries(rows.map(r=>[r.dataset.probClub,Object.fromEntries([...r.querySelectorAll('.heat-cell')].map(c=>[c.dataset.indicator,c.textContent]))]))")
            assert actual==expected,"Public AF comparison values differ from source"
            if mobile:
                await page.get_by_role("button",name="Compacta",exact=True).click()
                await page.locator("#fdg-main[aria-busy=false]").wait_for()
            await page.get_by_role("button",name="Alternar tema").click()
            assert await page.locator("html").get_attribute("data-theme")=="light"
            await page.evaluate("scrollTo(0,0)")
            await page.screenshot(path=str(out/f"producao-{width}-probabilidades-claro.png"))
            await page.get_by_role("button",name="Alternar tema").click()
            await page.get_by_role("tab",name="Classificação",exact=True).click()
            await page.wait_for_function("location.hash==='#stats/table'&&document.querySelectorAll('tbody tr[data-club]').length===20&&document.querySelector('#fdg-main[aria-busy=false]')")
            assert await page.locator(".hf-standings thead th").count()==10
            await page.screenshot(path=str(out/f"producao-{width}-classificacao.png"))
            await page.get_by_role("tab",name="Jogadores",exact=True).click()
            await page.locator("#fdg-main[aria-busy=false]").wait_for()
            leaders=await page.evaluate("async()=>{const r=await fetch('/dados-br/lideres-jogadores.json',{cache:'no-cache'});if(!r.ok)throw Error('public players '+r.status);return r.json()}")
            assert await page.locator(".ux-player-table tbody tr").count()==len(leaders["artilharia"])
            await page.get_by_role("button",name="Participações em gols",exact=True).click()
            await page.locator("#fdg-main[aria-busy=false]").wait_for()
            player_rows=await page.locator(".ux-player-table tbody tr").evaluate_all("(rows)=>rows.map(r=>({name:r.querySelector('.ux-player-name>strong').textContent,club:r.querySelector('.ux-player-name .team>span:last-child').textContent,values:[...r.querySelectorAll('td')].slice(1).map(t=>Number(t.textContent))}))")
            assert len(player_rows)==len(player_totals(leaders))
            assert {player_key(p["name"],p["club"]):tuple(p["values"]) for p in player_rows}==player_totals(leaders)
            await page.screenshot(path=str(out/f"producao-{width}-participacoes.png"))
            await page.goto(HOST+"/aovivo.html?sl02_hf2="+str(int(time.time())),wait_until="domcontentloaded",timeout=35000)
            await page.locator(".fdg-nav").wait_for(timeout=20000)
            await page.wait_for_timeout(350)
            live=await live_layout(page,width)
            await page.screenshot(path=str(out/f"producao-{width}-ao-vivo.png"))
            assert not errors,errors
            evidence.append({"viewport":width,"mobile_emulation":mobile,"url":page.url,"menu":m,"classificacao_clubes":20,"live_layout":live,"default_view":default,"density":density,"af_values_verified":140,"season":source["temporada"],"model":source["versao_modelo"],"finals":source["base_corrente"]["partidas_concluidas"],"errors":errors})
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
