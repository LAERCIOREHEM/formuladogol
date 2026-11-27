"""Real derived payload regression, 14 viewport/theme cases. No network delivery."""
import asyncio,functools,json,sys,threading
from pathlib import Path
from http.server import ThreadingHTTPServer
from playwright.async_api import async_playwright
from abrir_previa import Handler
async def run(site):
    data=json.loads((site/"sl02/af-player.json").read_text())
    assert data["publication"]=="EXPERIMENTAL_DERIVED"
    rows=data["seasons"]["2026"]["rows"]
    assert len(rows)==239
    server=ThreadingHTTPServer(("127.0.0.1",0),functools.partial(Handler,directory=str(site)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    host=f"http://127.0.0.1:{server.server_port}"
    passed=0
    try:
        async with async_playwright() as p:
            b=await p.chromium.launch()
            for w in (320,360,390,430,768,1024,1440):
                for theme in ("dark","light"):
                    page=await b.new_page(viewport={"width":w,"height":920})
                    errors=[];page.on("pageerror",lambda e:errors.append(str(e)))
                    async def block(route):
                        if route.request.url.startswith(host+"/"):await route.continue_()
                        else:await route.abort()
                    await page.route("**/*",block)
                    await page.add_init_script("localStorage.setItem('fdg-sl02:theme',"+json.dumps(theme)+")")
                    await page.goto(host+"/estatisticas.html#stats/players")
                    await page.locator(".afp-ranking").wait_for(timeout=30000)
                    assert await page.locator(".afp-ranking tbody tr").count()==len(rows)
                    assert await page.get_by_role("button",name="AF-Player",exact=True).get_attribute("aria-pressed")=="true"
                    assert await page.locator(".afp-ranking .ux-player-primary").first.is_visible()
                    assert await page.evaluate("document.documentElement.scrollWidth<=innerWidth+1")
                    assert await page.locator(".afp-ranking .ux-player-scroll").evaluate("(e)=>e.scrollWidth<=e.clientWidth+1")
                    assert await page.locator("html").get_attribute("data-theme")==theme
                    assert await page.get_by_text("Experimental",exact=False).first.is_visible()
                    await page.locator("select[data-change=afpPosition]").select_option("F")
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                    assert await page.locator(".afp-ranking tbody tr").count()==sum(r["position"]=="F" for r in rows)
                    await page.locator(".afp-player-name").first.click()
                    await page.locator(".afp-detail").wait_for()
                    assert await page.locator(".afp-axes span").count()==5
                    await page.locator("select[data-change=afpMin]").select_option("900")
                    await page.locator("#fdg-main[aria-busy=false]").wait_for()
                    assert await page.locator(".afp-ranking tbody tr").count()==sum(r["position"]=="F" and r["minute_band"]>=900 for r in rows)
                    assert not errors,errors
                    assert await page.evaluate("document.documentElement.scrollWidth<=innerWidth+1")
                    await page.close();passed+=1
            await b.close()
    finally:server.shutdown();server.server_close()
    print("AFP real public candidate PASS:",passed,"viewport/theme combinations; 239 real scores, filters, Raio-X, no page or table overflow")
if __name__=="__main__":asyncio.run(run(Path(sys.argv[1])))
