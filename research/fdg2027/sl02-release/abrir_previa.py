"""Loopback-only preview host. No external connections or publication."""
from pathlib import Path
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from functools import partial
import threading,webbrowser
CSP="default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'"
class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("X-Robots-Tag","noindex, nofollow")
        self.send_header("Content-Security-Policy",CSP)
        self.send_header("Cache-Control","no-store")
        super().end_headers()
def main():
    root=Path(__file__).resolve().parent
    server=ThreadingHTTPServer(("127.0.0.1",0),partial(Handler,directory=str(root)))
    url="http://127.0.0.1:"+str(server.server_port)+"/"
    print("FDG SL02 - preview local:",url,flush=True)
    print("Sem conexões externas, publicação ou notificações reais. Feche esta janela para encerrar.",flush=True)
    threading.Timer(.3,lambda:webbrowser.open(url)).start()
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()
if __name__=="__main__":main()
