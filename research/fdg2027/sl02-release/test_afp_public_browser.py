"""Exercise approved and tampered AFP data via test-only browser interception. Never write fixture to site."""
import asyncio,functools,hashlib,json,sys,threading
from pathlib import Path
from http.server import ThreadingHTTPServer
from playwright.async_api import async_playwright
from abrir_previa import Handler
from afp_public import validate
from test_afp_public import fixture
async def run(site):
    payload,cert=fixture()
    d=json.loads(payload)
    r=d["seasons"]["2026"]["rows"][0]
    r["club"]="Flamengo"
    payload=json.dumps(d).encode();cert["data_sha256"]=hashlib.sha256(payload).hexdigest()
    validate(payload,cert)
    digest=cert["data_sha256"]
    original=(site/"estatisticas.html").read_text()
    actual_present=(site/"sl02/af-player.json").exists()
    server=ThreadingHTTPServer(("127.0.0.1",0),functools.partial(Handler,directory=str(site)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    host=f"http://127.0.0.1:{server.server_port}"
    try:
        async with async_playwright() as p:
            b=await p.chromium.launch()
            for width in (390,1440):
                for mode in ("absent","approved","tampered"):
                    page=await b.new_page(viewport={"width":width,"height":920});errors=[];afp_requests=[]
                    page.on("pageerror",lambda e:errors.append(str(e)))
                    async def intercept(route):
                        u=route.request.url
                        if not u.startswith(host+"/"):await route.abort();return
                        if "/estatisticas.html" in u:
                            import re
                            clean=re.sub(r' data-fdg-afp-sha256="[0-9a-f]{64}"', "", original)
                            if mode=="absent":
                                await route.fulfill(status=200,content_type="text/html",body=clean);return
                            html=clean.replace("<body class=",'<body data-fdg-afp-sha256="'+digest+'" class=',1)
                            await route.fulfill(status=200,content_type="text/html",body=html);return
                        if "/sl02/af-player.json" in u:
                            afp_requests.append(u)
                            await route.fulfill(status=200,content_type="application/json",body=payload if mode=="approved" else payload+b" ");return
                        await route.continue_()
                    await page.route("**/*",intercept)
                    await page.goto(host+"/estatisticas.html#stats/players")
                    await page.locator("#fdg-main[aria-busy=false]").wait_for(timeout=30000)
                    if mode=="approved":
                        await page.locator(".afp-ranking").wait_for()
                        assert await page.get_by_role("button",name="AF-Player",exact=True).get_attribute("aria-pressed")=="true"
                        assert await page.locator(".afp-ranking tbody tr").count()==1
                        await page.locator(".afp-player-name").click()
                        assert await page.locator(".afp-detail").count()==1
                        await page.locator("select[data-change=afpPosition]").select_option("D")
                        assert await page.locator(".afp-ranking tbody tr").count()==0
                        await page.get_by_role("button",name="Artilharia",exact=True).click()
                        await page.locator("#fdg-main[aria-busy=false]").wait_for()
                        assert not await page.locator(".afp-ranking").count()
                    else:
                        assert not await page.locator(".afp-ranking").count()
                        assert await page.get_by_role("button",name="Artilharia",exact=True).get_attribute("aria-pressed")=="true"
                    assert bool(afp_requests)==(mode!="absent")
                    assert not errors,errors
                    assert await page.evaluate("document.documentElement.scrollWidth<=innerWidth+1")
                    await page.close()
            await b.close()
    finally:server.shutdown();server.server_close()
    print("AFP integration PASS: absent, approved, tampered; 390/1440; no fixture written")
if __name__=="__main__":asyncio.run(run(Path(sys.argv[1])))
