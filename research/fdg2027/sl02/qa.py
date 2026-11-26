"""Browser contract checks. No external network, no production polling."""
import asyncio,functools,hashlib,json,sys,threading,tempfile
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.async_api import async_playwright
WIDTHS=(320,360,390,430,768,1024,1440)
LABELS=["Estatísticas","Jogos","Ao vivo","Análises","Clubes","Mais"]
ROUTES=["stats/prob","stats/table","stats/performance","stats/players","stats/accuracy","games/next","games/results","live","articles","clubs","more","more/museum","more/sim"]
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*a):pass
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
                    await page.get_by_role("button",name="Série B · Em breve").click()
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                    if await page.get_by_role("tab").count()!=1:fail.append("B gating")
            if route=="stats/prob" and w==390 and theme=="dark" and zoom==100:
                await page.get_by_role("button",name="Comparativa",exact=True).click();await page.locator("#fdg-main[aria-busy=false]").wait_for()
                if await page.locator(".heat").count()!=180:fail.append("all indicators")
                await page.locator(".rank-button").first.click();await page.locator("#fdg-main[aria-busy=false]").wait_for()
                if not await page.get_by_text("Raio-X completo",exact=True).count():fail.append("club detail")
            await ctx.close()
        for route in ROUTES:
            for w in (390,1440):await test(route,w)
        for w in WIDTHS:
            if w not in (390,1440):
                for r in ("stats/prob","stats/table"):await test(r,w)
        await test("stats/prob",390,"light");await test("stats/table",1440,"light")
        for w in (320,768,1440):await test("stats/prob",w,zoom=200)
        await browser.close()
    report={"captures":len(findings),"measurements":findings,"page_errors":errors,"blocked_hosts":sorted(requests),"failures":fail,"native_zoom_200_certified":False,"zoom_note":"200% equivalent CSS viewport only; native zoom remains a separate acceptance gate.","publication":False}
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
