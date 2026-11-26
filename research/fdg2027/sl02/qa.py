"""Browser contract checks. No external network, no production polling."""
import asyncio,functools,hashlib,json,sys,threading,tempfile
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.async_api import async_playwright
WIDTHS=(320,360,390,430,768,1024,1440)
LABELS=["Estatísticas","Jogos","Ao vivo","Análises","Clubes","Mais"]
ROUTES=["more/method","stats/prob","stats/table","stats/performance","stats/players","stats/accuracy","games/next","games/results","live","articles","clubs","more","more/museum","more/sim"]
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*a):pass

async def native_zoom(p, out, origin):
    # Chromium tabs.setZoom changes actual browser page zoom, not deviceScaleFactor
    # or the CSS viewport. Headless persistent Chromium supports MV3 extensions.
    with tempfile.TemporaryDirectory() as t:
        root=Path(t);ext=root/"ext";ext.mkdir()
        (ext/"manifest.json").write_text(json.dumps({"manifest_version":3,"name":"SL02 Zoom QA","version":"1.0","permissions":["tabs"],"background":{"service_worker":"bg.js"}}))
        (ext/"bg.js").write_text("chrome.runtime.onInstalled.addListener(()=>{});")
        ctx=await p.chromium.launch_persistent_context(str(root/"profile"),headless=True,channel="chromium",
            args=["--disable-extensions-except="+str(ext),"--load-extension="+str(ext)],
            viewport={"width":640,"height":900},service_workers="allow")
        try:
            worker=ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker",timeout=12000)
            async def handle(r):
                if r.request.url.startswith(origin+"/") and r.request.method in ("GET","HEAD"):await r.continue_()
                else:await r.abort()
            await ctx.route("**/*",handle)
            page=ctx.pages[0] if ctx.pages else await ctx.new_page()
            await page.goto(origin+"/index.html#stats/prob")
            await page.locator("#fdg-main[aria-busy=false]").wait_for(timeout=15000)
            before=await page.evaluate("window.innerWidth")
            zoom=await worker.evaluate("""async url=>{const tabs=await chrome.tabs.query({});const tab=tabs.find(t=>t.url===url);if(!tab)throw Error('preview tab absent');await chrome.tabs.setZoom(tab.id,2);return await chrome.tabs.getZoom(tab.id)}""",page.url)
            await page.wait_for_timeout(400)
            m=await page.evaluate("""()=>{const n=document.querySelector('.fdg-nav');return {width:innerWidth,scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,navScroll:n.scrollWidth,navClient:n.clientWidth,labels:[...n.querySelectorAll('.nav-label')].map(x=>{let r=document.createRange();r.selectNodeContents(x);let a=r.getBoundingClientRect(),b=x.parentElement.getBoundingClientRect();return {text:x.textContent,inside:a.left>=b.left-1&&a.right<=b.right+1}})}}""")
            await page.screenshot(path=str(out/"native-browser-zoom-200.png"))
            return {"zoom":zoom,"before_css_width":before,**m,"certified":zoom==2 and m["width"]<=before*.55 and m["scroll"]<=m["client"]+1 and m["navScroll"]<=m["navClient"]+1 and all(x["inside"] for x in m["labels"]) and [x["text"] for x in m["labels"]]==LABELS}
        finally:await ctx.close()

async def run(site,out,origin):
    findings=[];errors=[];requests=set();fail=[]
    async with async_playwright() as p:
        browser=await p.chromium.launch()
        async def test(route,w,theme="dark",zoom=100):
            ctx=await browser.new_context(viewport={"width":w if zoom==100 else w//2,"height":900},device_scale_factor=1,service_workers="block")
            async def handle(r):
                if r.request.url.startswith(origin+"/") and r.request.method in ("GET","HEAD"):await r.continue_()
                else:requests.add(r.request.url.split("/")[2] if "://" in r.request.url else "other");await r.abort()
            await ctx.route("**/*",handle)
            page=await ctx.new_page();page.on("pageerror",lambda e:errors.append(str(e)))
            await page.goto(origin+"/index.html#"+route,wait_until="domcontentloaded")
            await page.locator("#fdg-main[aria-busy=false]").wait_for(timeout=20000)
            if theme=="light":await page.get_by_role("button",name="Alternar tema").click()
            label=route.replace("/","-")+"-"+str(w)+"-"+theme+"-"+str(zoom)
            m=await page.evaluate("""() => {const nav=document.querySelector('.fdg-nav');const labels=[...nav.querySelectorAll('.nav-label')].map(x=>{let a=x.getBoundingClientRect(),b=x.parentElement.getBoundingClientRect(),r=document.createRange();r.selectNodeContents(x);let t=r.getBoundingClientRect();return {text:x.textContent,client:x.clientWidth,scroll:x.scrollWidth,inside:t.left>=b.left-1&&t.right<=b.right+1,iconAbove:x.previousElementSibling.getBoundingClientRect().bottom<=a.top+1}});return {client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,navClient:nav.clientWidth,navScroll:nav.scrollWidth,columns:getComputedStyle(nav).gridTemplateColumns.split(' ').length,labels,active:nav.querySelectorAll('[aria-current=page]').length,empty:!!document.querySelector('#fdg-main .empty'),heading:document.querySelector('#fdg-main h1')?.textContent}}""")
            m.update(route=route,width=w,theme=theme,zoom_equivalent=zoom)
            if m["scroll"]>m["client"]+1:
                m["overflow_elements"]=await page.evaluate("""()=>[...document.querySelectorAll('body *')].map(x=>({tag:x.tagName,cls:String(x.className),text:x.textContent.slice(0,80),right:x.getBoundingClientRect().right,width:x.getBoundingClientRect().width})).filter(x=>x.right>document.documentElement.clientWidth+.5&&x.width>0).sort((a,b)=>b.right-a.right).slice(0,20)""")
                print("Overflow details",json.dumps(m["overflow_elements"],ensure_ascii=False),flush=True)
            await page.screenshot(path=str(out/(label+".png")),animations="disabled")
            findings.append(m)
            if [x["text"] for x in m["labels"]]!=LABELS or m["active"]!=1 or m["scroll"]>m["client"]+1 or m["navScroll"]>m["navClient"]+1 or not all(x["inside"] and x["iconAbove"] and x["scroll"]<=x["client"]+1 for x in m["labels"]):fail.append("overflow/nav:"+label)
            if zoom==100 and m["columns"]!=(6 if w>=900 else 3):fail.append("columns:"+label)
            if m["heading"]=="Dados indisponíveis":fail.append("data:"+label)
            if route=="stats/table":
                if await page.locator("tbody tr[data-club]").count()!=20:fail.append("table:"+label)
                if w==390 and theme=="dark" and zoom==100:
                    for recorte in ["Turno","Returno","Mandante","Visitante","Últimos 5","Últimos 10","Geral"]:
                        await page.get_by_role("button",name=recorte,exact=True).click()
                        await page.locator("#fdg-main[aria-busy=false]").wait_for()
                        if await page.locator("tbody tr[data-club]").count()!=20:fail.append("recorte:"+recorte)
                    await page.screenshot(path=str(out/"classificacao-recorte-geral-mobile.png"))
                    await page.get_by_role("button",name="Série B · Em breve").click()
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                    if await page.get_by_role("tab").count()!=1:fail.append("B gating")
                    await page.screenshot(path=str(out/"serie-b-indisponivel.png"))
            if route=="stats/prob" and w==390 and theme=="dark" and zoom==100:
                await page.get_by_role("button",name="Comparativa",exact=True).click();await page.locator("#fdg-main[aria-busy=false]").wait_for()
                if await page.locator(".heat:visible").count()!=180:fail.append("all indicators")
                await page.locator(".rank-button:visible").first.click();await page.locator("#fdg-main[aria-busy=false]").wait_for()
                if not await page.get_by_text("Raio-X completo",exact=True).count():fail.append("club detail")
                await page.screenshot(path=str(out/"comparativa-mobile-detail.png"))
            if route=="stats/prob" and w==1440 and theme=="dark" and zoom==100:
                await page.get_by_role("button",name="Comparativa",exact=True).click();await page.locator("#fdg-main[aria-busy=false]").wait_for()
                if await page.locator(".heat-cell:visible").count()!=180:fail.append("desktop matrix")
                await page.screenshot(path=str(out/"comparativa-desktop.png"))
            if route=="clubs" and w==390 and theme=="dark" and zoom==100:
                await page.get_by_role("button",name="Bahia",exact=False).first.click();await page.locator("#fdg-main[aria-busy=false]").wait_for()
                await page.get_by_role("button",name="Definir Meu Clube",exact=False).click();await page.locator("#fdg-main[aria-busy=false]").wait_for()
                if await page.evaluate("localStorage.getItem('fdg-sl02:club')")!="Bahia":fail.append("Meu Clube preference")
                await page.screenshot(path=str(out/"meu-clube-bahia.png"))
            await ctx.close()
        for route in ROUTES:
            for w in (390,1440):await test(route,w)
        for w in WIDTHS:
            if w not in (390,1440):
                for r in ("stats/prob","stats/table"):await test(r,w)
        await test("stats/prob",390,"light");await test("stats/table",1440,"light")
        for w in (320,768,1440):await test("stats/prob",w,zoom=200)

        aliases=[("/jogos/","Jogos do Brasileirão"),("/resultados/","Jogos do Brasileirão"),("/tabela/","Inteligência do campeonato"),
                 ("/index.html?view=tabela","Inteligência do campeonato"),("/index.html?view=resultados","Jogos do Brasileirão"),
                 ("/estatisticas.html#artilheiros","Inteligência do campeonato"),("/estatisticas.html#assistencias","Inteligência do campeonato"),
                 ("/estatisticas.html#metodologia-probabilidades","Acervo e ferramentas"),("/estatisticas.html#probabilidade-resumo-bahia","Inteligência do campeonato"),
                 ("/clubes.html#gr-mio","Meu Clube & Raio-X"),("/acuracia.html","Inteligência do campeonato"),("/analises/","Análises")]
        alias_ctx=await browser.new_context(viewport={"width":390,"height":900},service_workers="block",accept_downloads=True)
        async def alias_handle(r):
            if r.request.url.startswith(origin+"/") and r.request.method in ("GET","HEAD"):await r.continue_()
            else:await r.abort()
        await alias_ctx.route("**/*",alias_handle)
        alias_page=await alias_ctx.new_page()
        for uri,expected in aliases:
            try:
                res=await alias_page.goto(origin+uri)
                await alias_page.locator("#fdg-main[aria-busy=false]").wait_for(timeout=12000)
                head=await alias_page.locator("#fdg-main h1").text_content()
                if not res or res.status!=200 or head!=expected:fail.append("alias:"+uri)
                if "assistencias" in uri and await alias_page.get_by_role("button",name="Assistências",exact=True).get_attribute("aria-pressed")!="true":fail.append("assistências deep link")
                if "probabilidade-resumo-bahia" in uri and not await alias_page.get_by_text("Raio-X completo",exact=True).count():fail.append("probability club deep link")
                if "gr-mio" in uri and not await alias_page.get_by_role("link",name="Perfil original").count():fail.append("club alias")
            except Exception as e:fail.append("alias:"+uri+":"+str(e)[:160])
        # Simulated outcomes remain local and can be reset.
        await alias_page.goto(origin+"/index.html#more/sim")
        await alias_page.locator("#fdg-main[aria-busy=false]").wait_for()
        await alias_page.locator("[data-sim]").nth(0).fill("1")
        await alias_page.locator("[data-sim]").nth(1).fill("0")
        await alias_page.get_by_role("button",name="Simular",exact=True).click()
        await alias_page.locator("#fdg-main[aria-busy=false]").wait_for()
        if await alias_page.locator("tbody tr[data-club]").count()!=20:fail.append("simulator table")
        await alias_page.get_by_role("button",name="Limpar hipóteses").click()
        await alias_page.locator("#fdg-main[aria-busy=false]").wait_for()
        if await alias_page.locator("[data-sim]").first.input_value()!="":fail.append("simulator reset")
        # Shareable card: download actual generated PNG.
        await alias_page.goto(origin+"/index.html#clubs/Bahia")
        await alias_page.locator("#fdg-main[aria-busy=false]").wait_for()
        try:
            async with alias_page.expect_download(timeout=12000) as down:
                await alias_page.get_by_role("button",name="Compartilhar card").first.click()
            file=await down.value
            await file.save_as(str(out/"card-compartilhavel-bahia.png"))
            if not (out/"card-compartilhavel-bahia.png").read_bytes().startswith(b"\x89PNG\r\n\x1a\n"):fail.append("share PNG")
        except Exception as e:fail.append("share:"+str(e)[:160])
        await alias_ctx.close()

        await browser.close()
        try: zoom_native=await native_zoom(p,out,origin)
        except Exception as e:zoom_native={"certified":False,"error":str(e)[:500]}
        if not zoom_native["certified"]:fail.append("native browser zoom")
    report={"captures":len(findings),"alias_checks":len(aliases),"share_card_png_verified":(out/"card-compartilhavel-bahia.png").is_file(),"measurements":findings,"page_errors":errors,"blocked_hosts":sorted(requests),"failures":fail,"native_zoom_200_certified":zoom_native["certified"],"native_zoom_evidence":zoom_native,"publication":False}
    (out/"qa.json").write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print(json.dumps({k:v for k,v in report.items() if k!="measurements"},ensure_ascii=False))
    assert not fail,fail
    assert not errors,errors
def main():
    site,out=map(Path,sys.argv[1:]);out.mkdir(parents=True,exist_ok=True)
    server=ThreadingHTTPServer(("127.0.0.1",0),functools.partial(Quiet,directory=str(site)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:asyncio.run(run(site,out,f"http://127.0.0.1:{server.server_port}"))
    finally:server.shutdown();server.server_close()
if __name__=="__main__":main()
