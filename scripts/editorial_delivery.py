#!/usr/bin/env python3
"""Editorial delivery: remote CAS reservation before SMTP; never auto-retry ambiguous delivery."""
import base64
import hashlib
import html
import json
import os
import re
import smtplib
import ssl
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta
from email.message import EmailMessage
from email.utils import formataddr
from pathlib import Path

LEDGER = "dados-br/analises-notificacoes.json"
SITE = "https://formuladogol.com.br/analises/"
REQUIRED = ("SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "EMAIL_DESTINO", "GH_TOKEN", "GITHUB_REPOSITORY", "GITHUB_RUN_ID")
class Conflict(Exception): pass
class LedgerError(Exception): pass

def now():
    return datetime.now(timezone(timedelta(hours=-3))).replace(microsecond=0).isoformat()

def identity(row):
    key = str(row.get("id_editorial") or "").strip()
    if not key:
        slug = str(row.get("slug") or "")
        if slug.endswith(".html"): key = slug[:-5]
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,150}", key):
        raise LedgerError("invalid editorial identity")
    return key

def check_article(row):
    key=identity(row)
    if row.get("slug") != key+".html" or row.get("url") != SITE+key+".html":
        raise LedgerError("article identity / URL mismatch")
    return key

def validate(doc):
    if not isinstance(doc,dict) or doc.get("schema_version")!=2 or not isinstance(doc.get("notificacoes"),list) or not isinstance(doc.get("reservas",[]),list):
        raise LedgerError("invalid ledger schema")
    ids=set()
    for r in doc["notificacoes"]+doc.get("reservas",[]):
        k=identity(r)
        if k in ids:raise LedgerError("duplicate ledger identity")
        ids.add(k)
    if doc.get("total_notificacoes")!=len(doc["notificacoes"]):raise LedgerError("ledger count mismatch")
    for r in doc.get("reservas",[]):
        if not r.get("claim_id"):raise LedgerError("invalid reservation")
    return doc

class Remote:
    def __init__(self,env):
        repo=env["GITHUB_REPOSITORY"]
        if not re.fullmatch(r"[\w.-]+/[\w.-]+",repo):raise LedgerError("invalid repo")
        self.url=f"https://api.github.com/repos/{repo}/contents/{LEDGER}"
        self.headers={"Authorization":"Bearer "+env["GH_TOKEN"],"Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","User-Agent":"FDG-Editorial-Delivery/1.0"}
    def request(self,method,payload=None):
        url=self.url+("?ref=main" if method=="GET" else "")
        req=urllib.request.Request(url,data=json.dumps(payload).encode() if payload is not None else None,headers={**self.headers,"Content-Type":"application/json"},method=method)
        try:
            with urllib.request.urlopen(req,timeout=20) as res:return json.load(res)
        except urllib.error.HTTPError as exc:
            if method=="PUT" and exc.code in (409,422):raise Conflict() from None
            raise LedgerError(f"GitHub ledger HTTP {exc.code}") from None
        except (OSError,ValueError) as exc:
            raise LedgerError("GitHub ledger response uncertain: "+type(exc).__name__) from None
    def read(self):
        r=self.request("GET")
        if r.get("encoding")!="base64" or not re.fullmatch(r"[a-f0-9]{40}",str(r.get("sha",""))):raise LedgerError("bad ledger metadata")
        return validate(json.loads(base64.b64decode(r["content"]))),r["sha"]
    def write(self,doc,sha):
        validate(doc)
        raw=(json.dumps(doc,ensure_ascii=False,indent=2)+"\n").encode()
        r=self.request("PUT",{"message":"Registrar estado de notificacao editorial [skip ci]","branch":"main","sha":sha,"content":base64.b64encode(raw).decode()})
        if not r.get("commit",{}).get("sha"):raise LedgerError("unconfirmed remote commit")

def transaction(store,mutate):
    for attempt in range(4):
        doc,sha=store.read()
        result=mutate(doc)
        if not result:return False
        try:
            store.write(doc,sha)
            return True
        except Conflict:
            if attempt<3:time.sleep(.5*(attempt+1))
    raise LedgerError("ledger CAS conflicts exhausted")

def find(doc,key):
    for r in doc["notificacoes"]:
        if identity(r)==key:return "sent",r
    for r in doc.get("reservas",[]):
        if identity(r)==key:return "reserved",r
    return "new",None

def reserve(store,article,claim):
    key=check_article(article)
    def mutate(doc):
        if find(doc,key)[0]!="new":return False
        r={"id_editorial":key,"tipo":str(article.get("tipo") or "editorial"),"slug":article["slug"],"url":article["url"],"claim_id":claim,"reservado_em":now()}
        if article.get("rodada"):r["rodada"]=int(article["rodada"])
        doc.setdefault("reservas",[]).append(r)
        return True
    return transaction(store,mutate)

def complete(store,key,claim):
    def mutate(doc):
        state,r=find(doc,key)
        if state=="sent":return False
        if state!="reserved" or r["claim_id"]!=claim:raise LedgerError("claim ownership mismatch")
        doc["reservas"].remove(r)
        r["notificado_em"]=now()
        r["status"]="smtp_accepted"
        doc["notificacoes"].append(r)
        doc["notificacoes"].sort(key=lambda x:x.get("notificado_em",""))
        doc["total_notificacoes"]=len(doc["notificacoes"])
        return True
    return transaction(store,mutate)

def public_confirm(article,run):
    marker=f'data-fdg-editorial-id="{check_article(article)}"'
    for i in range(5):
        try:
            req=urllib.request.Request(article["url"]+"?deploy="+str(run),headers={"Cache-Control":"no-cache"})
            with urllib.request.urlopen(req,timeout=15) as res:
                if res.status==200 and marker in res.read(2_000_000).decode("utf8",errors="replace"):return True
        except (OSError,ValueError):pass
        if i<4:time.sleep(10)
    return False

def message(article,env):
    key=check_article(article)
    msg=EmailMessage()
    msg["From"]=formataddr(("Fórmula do Gol",env["SMTP_USER"]))
    msg["To"]=env["EMAIL_DESTINO"]
    msg["Subject"]=str(article.get("email_assunto") or "Fórmula do Gol: nova análise publicada")
    msg["Message-ID"]="<fdg-editorial-"+hashlib.sha256(key.encode()).hexdigest()+"@formuladogol.com.br>"
    call=str(article.get("email_chamada") or "Uma nova análise do Fórmula do Gol está no ar.")
    title=str(article["titulo"]);url=article["url"]
    msg.set_content(f"{call}\n\n{title}\n\n{url}")
    msg.add_alternative(f'<p>{html.escape(call)}</p><p><strong>{html.escape(title)}</strong></p><p><a href="{html.escape(url,quote=True)}">Abrir página publicada</a></p>',subtype="html")
    return msg

def smtp_connect(env):
    port=int(env["SMTP_PORT"]);ctx=ssl.create_default_context()
    srv=smtplib.SMTP_SSL(env["SMTP_HOST"],port,context=ctx,timeout=30) if port==465 else smtplib.SMTP(env["SMTP_HOST"],port,timeout=30)
    try:
        if port!=465:srv.ehlo();srv.starttls(context=ctx);srv.ehlo()
        srv.login(env["SMTP_USER"],env["SMTP_PASS"])
        return srv
    except Exception:
        srv.close()
        raise

def deliver(article,store,env,confirm=public_confirm,connect=smtp_connect):
    key=check_article(article)
    state,_=find(store.read()[0],key)
    if state!="new":
        if state=="reserved":print("::warning::Editorial "+key+" tem reserva persistente; revisar entrega, sem reenvio automático.")
        else:print("Editorial "+key+" já notificado; ignorado.")
        return state
    if not confirm(article,env["GITHUB_RUN_ID"]):
        print("::warning::Editorial "+key+" sem confirmação pública; envio pendente.")
        return "not_public"
    msg=message(article,env)
    claim=env["GITHUB_RUN_ID"]+":"+env.get("GITHUB_RUN_ATTEMPT","1")+":"+key
    srv=connect(env)  # Login failure is safe to retry next deployment; no claim yet.
    try:
        if not reserve(store,article,claim):return "already_reserved"
        # A durable acknowledgement is mandatory before the single SMTP attempt.
        try:
            refused=srv.send_message(msg)
            if refused:raise LedgerError("SMTP recipient refusal")
        except (OSError,smtplib.SMTPException,LedgerError,ValueError):
            print("::warning::Editorial "+key+" SMTP sem confirmação; reserva mantida; revisão manual necessária.")
            return "uncertain"
        try:
            complete(store,key,claim)
        except (LedgerError,OSError,ValueError):
            print("::warning::Editorial "+key+" aceito pelo SMTP; confirmação remota falhou; reserva impede reenvio.")
            return "accepted_unconfirmed"
        print("Página confirmada e e-mail aceito pelo SMTP: "+key)
        return "sent"
    finally:
        try:srv.quit()
        except (OSError,smtplib.SMTPException):srv.close()

def main():
    env=dict(os.environ)
    if any(not env.get(k,"").strip() for k in REQUIRED):
        print("::warning::Configuração editorial incompleta; nenhum SMTP iniciado.")
        return 0
    store=Remote(env)
    try:
        doc,_=store.read()
        articles=json.loads(Path("dados-br/analises.json").read_text(encoding="utf8"))["artigos"]
        # Never infer absence from a local checkout or an unavailable remote ledger.
        pending=[a for a in articles if find(doc,check_article(a))[0]!="sent"]
        if not pending:print("Nenhum editorial novo aguardando e-mail (registro remoto confirmado).")
        for article in sorted(pending,key=lambda a:(a.get("publicado_em",""),a.get("id_editorial",""))):
            try:deliver(article,store,env)
            except (LedgerError,OSError,ValueError,smtplib.SMTPException) as exc:
                print("::warning::Envio editorial bloqueado ("+type(exc).__name__+"); sem tentativa adicional neste deploy.")
    except (LedgerError,OSError,ValueError,KeyError,TypeError) as exc:
        print("::warning::Registro editorial indisponível ou inválido ("+type(exc).__name__+"); nenhum envio iniciado.")
    return 0
if __name__=="__main__":raise SystemExit(main())
