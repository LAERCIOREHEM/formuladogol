"""Offline release QA against the assembled operational candidate; no network delivery."""
from __future__ import annotations
import asyncio,functools,hashlib,json,re,shutil,sys,tempfile,threading
from pathlib import Path
from http.server import ThreadingHTTPServer
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright
from abrir_previa import Handler
from overlay import snapshot,rollback,sha
LABELS=["Estatísticas","Jogos","Ao vivo","Análises","Clubes","Mais"]
ICONS=["📊","⚽","🔴","📰","🛡️","☰"]
WIDTHS=(320,360,390,430,768,1024,1440)
ROUTES=["stats/prob","stats/table","stats/performance","stats/players","stats/accuracy","games/next","games/results","articles","clubs","more","more/museum","more/sim","more/method"]
NATIVE=["/jogos","/resultados","/tabela","/aovivo.html","/acuracia.html","/clubes.html","/analises/","/museu.html","/agenda.html","/alertas.html","/sobre.html","/copa2026/","/estatisticas-completas.html"]
def readj(site,rel):return json.loads((site/rel).read_text())
def verify_static(base,site,backup):
    b=snapshot(base);c=snapshot(site);ledger=readj(backup,"rollback.json")
    assert all(c[k]==v for k,v in b.items() if not k.endswith(".html"))
    assert set(b)<=set(c)
    for rel in ["manifest.webmanifest","sw.js","robots.txt","sitemap.xml","news-sitemap.xml","CNAME","js/br-data-pulse.js","js/br-data-refresh.js","js/br-af-core-snapshot.js","js/br-data-manifest.js","js/br-pwa.js","js/br-push.js","js/br-aovivo.js","js/br-estatisticas.js","js/br-acuracia.js","dados-br/af-core-manifest.json"]:assert b[rel]==c[rel],rel
    for rel in [k for k in b if k.endswith(".html")]:
        old=BeautifulSoup((base/rel).read_text(),"html.parser")
        new=BeautifulSoup((site/rel).read_text(),"html.parser")
        oldcan=[x.get("href") for x in old.select('link[rel=canonical]')]
        newcan=[x.get("href") for x in new.select('link[rel=canonical]')]
        assert oldcan==newcan,("canonical",rel,oldcan,newcan)
        if rel!="estatisticas.html":
            old_scripts=[x.get("src") for x in old.select("script[src]")]
            new_scripts=[x.get("src") for x in new.select("script[src]") if "sl02/shell.js" not in x.get("src","")]
            assert old_scripts==new_scripts,("script preserved",rel)
        if rel not in ("jogos/index.html","tabela/index.html","resultados/index.html"):
            assert len(new.select("[data-fdg-release-shell], [data-fdg-shell]"))==1,("one global shell",rel)
            for nav in new.select("nav.nav,nav.menu"):
                assert nav.has_attr("data-fdg-oldnav"),("legacy global menu visible",rel)
    p=readj(site,"dados-br/probabilidades-brasileirao.json")
    audit=readj(site,"dados-br/auditoria-probabilidades.json")
    m=readj(site,"dados-br/af-core-manifest.json")
    r=readj(site,"resultados.json")["resultados"];t=readj(site,"tabela.json")["tabela"]
    assert p["temporada"]==2026 and "1.3" in p["versao_modelo"]
    assert p["hash_entrada"]==audit["hash_entrada"]==m["hash_entrada"]
    assert len(t)==20 and len(r)==m["concluidos"] and sum(x["jogos"] for x in t)==2*len(r)
    assert len(p["clubes"])==20 and p["simulacao"]["quantidade"]==2000000
    extremes=0
    for club in p["clubes"]:
        for k,d in club["probabilidades_detalhes"].items():
            if d["exibicao"]=="0%":assert d["impossivel_estruturalmente"] is True and d["motivo_impossibilidade"];extremes+=1
            elif d["exibicao"]=="100%":assert d["certeza_estrutural"] is True and d["motivo_certeza"];extremes+=1
    manifest=readj(site,"dados-br/fdg-data-pulse.json")
    assert all(sha(site/k)==v["sha256"] for k,v in manifest["files"].items())
    assert readj(site,"sl02/history-slim.json")["source_sha256"]==sha(site/"dados-br/historico-probabilidades.json")
    assert (site/"copa2026/index.html").is_file() and (site/"museu.html").is_file()
    assert (site/"estatisticas-completas.html").is_file()
    # Demonstrate rollback with a synthetic newer public data revision, never
    # mutate the deliverable or claim these test fixture bytes are real data.
    with tempfile.TemporaryDirectory() as td:
        rt=Path(td)/"site";shutil.copytree(site,rt)
        fixture=rt/"dados-br/status-atualizacao.json"
        j=json.loads(fixture.read_text());j["_sl02_rollback_test_only"]="newer data retained"
        fixture.write_text(json.dumps(j));new_hash=sha(fixture)
        rollback(rt,backup)
        after=snapshot(rt)
        assert sha(fixture)==new_hash
        assert all(after[k]==v for k,v in b.items() if k!="dados-br/status-atualizacao.json")
        assert set(after)==set(b)
    return {"public_files_before":len(b),"public_files_after":len(c),"protected_unchanged":ledger["protected_count"],"html_original_paths":sum(k.endswith(".html") for k in b),"canonical_preserved":True,"native_script_lists_preserved":True,"finals":len(r),"remaining":m["restantes"],"probability_indicators":sum(len(x["probabilidades_detalhes"]) for x in p["clubes"]),"structural_extremes":extremes,"data_manifest_entries":len(manifest["files"]),"rollback_newer_data_preserved":True,"source_revision":m["revision"]}
MEASURE="""()=>{const n=document.querySelector('.fdg-nav');if(!n)return null;const labels=[...n.querySelectorAll('.nav-label')].map(x=>{const t=document.createRange();t.selectNodeContents(x);const a=t.getBoundingClientRect(),b=x.parentElement.getBoundingClientRect();return{text:x.textContent,icon:x.previousElementSibling.textContent,inside:a.left>=b.left-1&&a.right<=b.right+1&&a.top>=b.top-1&&a.bottom<=b.bottom+1,above:x.previousElementSibling.getBoundingClientRect().bottom<=x.getBoundingClientRect().top+1}});return{client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,navClient:n.clientWidth,navScroll:n.scrollWidth,columns:getComputedStyle(n).gridTemplateColumns.split(' ').length,labels,active:n.querySelectorAll('[aria-current=page]').length,visibleMenus:[...document.querySelectorAll('.fdg-nav,nav.nav,nav.menu')].filter(e=>e.getClientRects().length&&getComputedStyle(e).display!=='none').length}}"""
async def run_browser(site,out,origin):
    rows=[];errors=[];fail=[];blocked=set();local_requests={}
    def validate(m,label,w=None,doc=True):
        if not m:fail.append("menu missing:"+label);return
        if [x["text"] for x in m["labels"]]!=LABELS or [x["icon"] for x in m["labels"]]!=ICONS or not all(x["inside"] and x["above"] for x in m["labels"]) or m["active"]!=1 or m["visibleMenus"]!=1 or m["navScroll"]>m["navClient"]+1:fail.append("menu:"+label)
        if w and m["columns"]!=(6 if w>=900 else 3 if w>=291 else 2 if w>=191 else 1):fail.append("columns:"+label)
        if doc and m["scroll"]>m["client"]+1:fail.append("document overflow:"+label)
    async with async_playwright() as p:
        browser=await p.chromium.launch()
        async def handle(r):
            u=r.request.url
            if u.startswith(origin+"/") and r.request.method in ("GET","HEAD"):
                k=u.split("?",1)[0].removeprefix(origin);local_requests[k]=local_requests.get(k,0)+1;await r.continue_()
            else:blocked.add(u.split("/")[2] if "://" in u else "other");await r.abort()
        async def one(route,w,theme="dark",native=False):
            ctx=await browser.new_context(viewport={"width":w,"height":920},service_workers="block")
            await ctx.route("**/*",handle)
            page=await ctx.new_page()
            # Legacy sources can report preexisting offline errors; separately
            # track app errors and native exceptions without treating them as proof of delivery.
            page.on("pageerror",lambda e:errors.append({"route":route,"message":str(e)[:220],"native":native}))
            url=origin+(route if native else "/estatisticas.html#"+route)
            try:
                await page.goto(url,wait_until="domcontentloaded",timeout=25000)
                await page.locator(".fdg-nav").wait_for(timeout=20000)
                if not native:await page.locator("#fdg-main[aria-busy=false]").wait_for(timeout=25000)
                if theme=="light":await page.get_by_role("button",name="Alternar tema").click()
                await page.wait_for_timeout(120)
                m=await page.evaluate(MEASURE)
                label=("native-" if native else "")+route.strip("/").replace("/","-").replace(".","-")+"-"+str(w)+"-"+theme
                validate(m,label,w,doc=not native)
                if not native:
                    if await page.locator("#fdg-main h1").text_content()=="Dados indisponíveis":fail.append("data:"+label)
                    if route=="stats/table" and await page.locator("tbody tr[data-club]").count()!=20:fail.append("20 clubs:"+label)
                    if route=="stats/prob":
                        if not await page.locator("#sl02-pulse .fdg-pulse").count():fail.append("Data Pulse:"+label)
                        if await page.locator(".prob-metrics").count():fail.append("duplicated metrics:"+label)
                        if await page.get_by_role("button",name="Comparativa",exact=True).get_attribute("aria-pressed")!="true":fail.append("default comparativa:"+label)
                        if await page.locator(".hf-view button").first.inner_text()!="Comparativa":fail.append("mode order:"+label)
                        if await page.locator(".hf-matrix .heat-cell").count()!=140:fail.append("seven indicators:"+label)
                        if await page.locator(".hf-matrix th[data-indicator]").count()!=7:fail.append("indicator columns:"+label)
                        if await page.locator(".hf-matrix th[data-indicator$='_base']").count():fail.append("base exposed:"+label)
                        if not await page.locator(".heat-cell[data-level=certain]").count() or not await page.locator(".heat-cell[data-level=zero]").count():fail.append("structural semantics:"+label)
                        palette=await page.locator(".hf-matrix tbody tr").first.locator(".heat-cell").evaluate_all("(els)=>els.map(e=>getComputedStyle(e).getPropertyValue('--rgb').trim())")
                        if len(set(palette))!=7:fail.append("semantic palette:"+label)
                        # Verify every displayed value against the unchanged published AF output.
                        expected=readj(site,"dados-br/probabilidades-brasileirao.json")["clubes"]
                        rendered=await page.locator(".hf-matrix tbody tr").evaluate_all("(rows)=>Object.fromEntries(rows.map(r=>[r.dataset.probClub,Object.fromEntries([...r.querySelectorAll('.heat-cell')].map(e=>[e.dataset.indicator,e.textContent]))]))")
                        if any(rendered.get(c["clube"],{}).get(k)!=c["probabilidades_detalhes"][k]["exibicao"] for c in expected for k in rendered.get(c["clube"],{})) or len(rendered)!=20:fail.append("AF values:"+label)
                    if route=="stats/table":
                        if await page.locator(".hf-standings thead th").count()!=10:fail.append("full classification:"+label)
                        if await page.locator(".hf-standings .wide-only").count():fail.append("hidden classification:"+label)
                        # Both ends of the internal scroll must remain usable; sticky identity stays visible.
                        sc=page.locator(".hf-table-scroll")
                        x=await sc.evaluate("(e)=>{const a=e.querySelector('tbody .hf-sticky');const b=a.getBoundingClientRect().left;e.scrollLeft=e.scrollWidth;return {before:b,after:a.getBoundingClientRect().left,max:e.scrollWidth-e.clientWidth,left:e.scrollLeft}}")
                        if abs(x["before"]-x["after"])>2 or abs(x["max"]-x["left"])>2:fail.append("classification sticky/scroll:"+label)
                        await sc.evaluate("(e)=>e.scrollLeft=0")
                    if w>=320:
                        brand=await page.locator(".brandline").evaluate("(e)=>{const a=e.querySelector('a').getBoundingClientRect(),b=e.querySelector('button').getBoundingClientRect();return {gap:b.left-a.right,width:a.width}}")
                        if brand["gap"]>15 or brand["gap"]<0 or brand["width"]<100:fail.append("banner width:"+label)
                m.update(route=route,width=w,theme=theme,native=native,url=page.url)
                rows.append(m)
                await page.screenshot(path=str(out/(label+".png")),animations="disabled")
                if route=="stats/table" and w==390 and theme=="dark" and not native:
                    for key in ("Turno","Returno","Mandante","Visitante","Últimos 5","Últimos 10","Geral"):
                        await page.get_by_role("button",name=key,exact=True).click()
                        await page.locator("#fdg-main[aria-busy=false]").wait_for()
                        if await page.locator("tbody tr[data-club]").count()!=20:fail.append("recorte:"+key)
                    await page.get_by_role("button",name="Série B · Em breve").click()
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                    assert await page.get_by_role("tab").count()==1
                if route=="stats/prob" and w==390 and theme=="dark" and not native:
                    await page.get_by_role("button",name="Comparativa",exact=True).click()
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                    if await page.locator(".heat-cell:visible").count()!=140:fail.append("compare mobile")
                    await page.locator(".hf-matrix .hf-club-button").first.click()
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                    if not await page.get_by_text("Raio-X completo",exact=True).count():fail.append("detail")
                    await page.get_by_role("button",name="Visão rápida",exact=True).click()
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                    if await page.locator(".rank-button:visible").count()!=20:fail.append("quick mode")
                if route=="stats/prob" and w==1440 and theme=="dark" and not native:
                    await page.get_by_role("button",name="Comparativa",exact=True).click()
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                    if await page.locator(".heat-cell:visible").count()!=140:fail.append("compare desktop")
                    await page.screenshot(path=str(out/"comparativa-integrada.png"))
                if route=="clubs" and w==390 and not native:
                    await page.get_by_role("button",name="Bahia",exact=False).first.click()
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                    await page.get_by_role("button",name="Definir Meu Clube",exact=False).click()
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                    if await page.evaluate("localStorage.getItem('fdg-sl02:club')")!="Bahia":fail.append("Meu Clube")
            except Exception as e:fail.append(route+":"+str(e)[:240])
            finally:await ctx.close()
        # All approved viewports; native shell measured separately from legacy
        # content layout (whose existing horizontal scroll remains visible in report).
        for route in ROUTES:
            for w in (390,1440):await one(route,w)
        for w in WIDTHS:
            if w not in (390,1440):
                for route in ("stats/prob","stats/table"):await one(route,w)
        await one("stats/prob",390,"light");await one("stats/table",1440,"light")
        await one("stats/prob",160);await one("stats/prob",384);await one("stats/prob",720)
        for route in NATIVE:
            for w in (390,1440):await one(route,w,native=True)
        # Representative generated club, match, article pages must retain native scripts and global shell.
        for rel in ("clube","jogo","analises"):
            candidates=sorted((site/rel).rglob("*.html"))
            selected=next((x for x in candidates if x.parent!=site/rel or x.name!="index.html"),None)
            if selected:await one("/"+selected.relative_to(site).as_posix(),390,native=True)
        # Actual keyboard activation, native SW registration at local origin and no permission grants.
        ctx=await browser.new_context(viewport={"width":390,"height":900},service_workers="allow",accept_downloads=True)
        await ctx.route("**/*",handle);page=await ctx.new_page()
        await page.goto(origin+"/estatisticas.html#stats/prob")
        await page.locator("#fdg-main[aria-busy=false]").wait_for()
        await page.get_by_role("tab",name="Probabilidades",exact=True).focus()
        await page.keyboard.press("ArrowRight")
        await page.wait_for_function("location.hash==='#stats/table'&&document.querySelector('#fdg-main[aria-busy=false]')")
        if await page.locator("tbody tr[data-club]").count()!=20:fail.append("keyboard tab")
        pwa=await page.evaluate("""async()=>{try{let r=await navigator.serviceWorker.getRegistration();if(!r)r=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;return {scope:r.scope,script:r.active?.scriptURL||r.installing?.scriptURL,permission:Notification.permission}}catch(e){return {error:String(e)}}}""")
        if not pwa.get("scope","").startswith(origin+"/") or not pwa.get("script","").split("?")[0].endswith("/sw.js") or pwa.get("permission")=="granted":fail.append("local PWA registration")
        await page.goto(origin+"/estatisticas.html#clubs/Bahia")
        await page.locator("#fdg-main[aria-busy=false]").wait_for()
        try:
            async with page.expect_download(timeout=12000) as d:await page.get_by_role("button",name="Compartilhar card").first.click()
            await (await d.value).save_as(str(out/"card-bahia.png"))
            assert (out/"card-bahia.png").read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
        except Exception as e:fail.append("share:"+str(e)[:140])
        await ctx.close()
        # A browser context changes revision with a mocked *local* manifest,
        # not an external API. A failed fetch must keep the last-good view.
        ctx=await browser.new_context(viewport={"width":390,"height":900},service_workers="block")
        toggle={"failed":False}
        async def fail_manifest(r):
            if toggle["failed"]:await r.fulfill(status=503,body="fixture outage")
            else:await handle(r)
        await ctx.route("**/*",handle);await ctx.route("**/dados-br/fdg-data-pulse.json*",fail_manifest)
        page=await ctx.new_page()
        await page.goto(origin+"/estatisticas.html#stats/prob")
        await page.locator("#fdg-main[aria-busy=false]").wait_for()
        await page.wait_for_timeout(300);toggle["failed"]=True
        await page.evaluate("window.dispatchEvent(new Event('online'))")
        try:
            await page.get_by_text("Sem certificação da revisão atual",exact=False).wait_for(timeout=12000)
            if await page.locator(".hf-matrix tbody tr").count()!=20:fail.append("last-good missing")
        except Exception as e:fail.append("last-good status:"+str(e)[:100])
        await ctx.close()
        await browser.close()
        # Genuine browser zoom using Chromium extension API, not device scale factor.
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);ext=root/"ext";ext.mkdir()
            (ext/"manifest.json").write_text(json.dumps({"manifest_version":3,"name":"SL02 Zoom QA","version":"1.0","permissions":["tabs"],"background":{"service_worker":"bg.js"}}))
            (ext/"bg.js").write_text("chrome.runtime.onInstalled.addListener(()=>{});")
            ctx=await p.chromium.launch_persistent_context(str(root/"profile"),headless=True,channel="chromium",args=["--disable-extensions-except="+str(ext),"--load-extension="+str(ext)],viewport={"width":640,"height":900})
            try:
                worker=ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker",timeout=12000)
                await ctx.route("**/*",handle);page=ctx.pages[0] if ctx.pages else await ctx.new_page()
                await page.goto(origin+"/estatisticas.html#stats/prob");await page.locator("#fdg-main[aria-busy=false]").wait_for()
                before=await page.evaluate("innerWidth")
                level=await worker.evaluate("""async url=>{let tab=(await chrome.tabs.query({})).find(t=>t.url===url);await chrome.tabs.setZoom(tab.id,2);return chrome.tabs.getZoom(tab.id)}""",page.url)
                await page.wait_for_timeout(350)
                zoom=await page.evaluate(MEASURE);validate(zoom,"native200",320)
                zoom.update(level=level,before=before)
                if level!=2 or zoom["client"]>before*.55:fail.append("native zoom")
                await page.screenshot(path=str(out/"zoom-nativo-200.png"))
            finally:await ctx.close()
    app_errors=[x for x in errors if not x["native"]]
    report={"measurements":rows,"captures":len(list(out.glob("*.png"))),"browser_cases":len(rows),"failures":fail,"app_errors":app_errors,"native_errors": [x for x in errors if x["native"]],"native_document_overflow":[{"route":x["route"],"width":x["width"],"overflow":x["scroll"]-x["client"]} for x in rows if x["native"] and x["scroll"]>x["client"]+1],"native_zoom":zoom,"pwa_local":pwa,"blocked_external_hosts":sorted(blocked),"local_request_counts":local_requests,"external_requests_delivered":0}
    return report
def main():
    base,site,backup,out=map(Path,sys.argv[1:]);out.mkdir(parents=True)
    static=verify_static(base,site,backup)
    server=ThreadingHTTPServer(("127.0.0.1",0),functools.partial(Handler,directory=str(site)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:browser=asyncio.run(run_browser(site,out,f"http://127.0.0.1:{server.server_port}"))
    finally:server.shutdown();server.server_close()
    report={"static":static,"browser":browser,"publication":False,"cost_real_verified":False}
    (out/"release-qa.json").write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print(json.dumps({"static":static,"browser":{k:v for k,v in browser.items() if k not in ("measurements","local_request_counts")}},ensure_ascii=False),flush=True)
    assert not browser["failures"],browser["failures"]
    assert not browser["app_errors"],browser["app_errors"]
if __name__=="__main__":main()
