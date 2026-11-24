#!/usr/bin/env python3
"""R36-R4: consume explicit ESPN FINALs, never scrape a season in the urgent path."""
from __future__ import annotations
import argparse
import copy
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import timedelta
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import atualizar_espn as espn
from scripts.guard_stale_full_snapshot import verified_finals, validate_not_stale
from scripts.gerar_probabilidades_brasileirao import current_publication_freshness

def load(p):
    return json.loads((ROOT/p).read_text(encoding="utf-8"))

def identity(event):
    return (event.get("mandante_nome"),event.get("visitante_nome"))

def final_candidate(raw, known, now):
    """Explicit completed from ESPN + exact canonical ID and participants."""
    eid=str(raw.get("id") or "")
    previous=known.get(eid)
    if not previous or previous.get("estado")=="post" or previous.get("concluido") is True:
        return None
    st=espn.tipo_status(raw)
    if st.get("state")!="post" or st.get("completed") is not True:
        return None
    home,away=espn.competidores(raw)
    if (espn.canonico_competidor(home),espn.canonico_competidor(away))!=identity(previous):
        return None
    h,a=espn.placar_competidor(home),espn.placar_competidor(away)
    if any(type(v) is not int or v<0 for v in (h,a)):
        return None
    dt=previous.get("data_dt")
    observed=espn.parse_data_evento_brt(raw)
    if not dt or not observed or abs((observed-dt).total_seconds())>4*3600:
        return None
    if previous.get("data_definir") is True or dt>now-timedelta(minutes=90):
        return None
    status=espn.status_evento(raw).get("displayClock") or st.get("shortDetail") or "Encerrado"
    if espn._status_interrompido(st,status):
        return None
    result=copy.deepcopy(previous)
    result.update(estado="post",concluido=True,adiado=False,placar_mandante=h,placar_visitante=a,
                  status=status,fonte_resultado="ESPN",origem_resultado="ESPN scoreboard/summary")
    return result

def query_window(now):
    dates=espn.datas_url(now-timedelta(days=1),now+timedelta(days=1))
    candidates=espn._scoreboard_candidates(dates,limit=50)
    def query(pair):
        name,url=pair
        try:
            payload=espn.unwrap_scoreboard_payload(espn.fetch_json(url,timeout=5,tentativas=1))
            return name,[x for x in payload.get("events",[]) if isinstance(x,dict)]
        except Exception as e:
            print(f"::warning::R36-R4 {name}: {type(e).__name__}: {e}",flush=True)
            return name,[]
    pool=ThreadPoolExecutor(max_workers=len(candidates))
    tasks=[pool.submit(query,pair) for pair in candidates]
    done,pending=wait(tasks,timeout=15)
    for task in pending: task.cancel()
    pool.shutdown(wait=False,cancel_futures=True)
    result=[]
    for task in done:
        name,events=task.result()
        if events: espn.SCOREBOARD_SOURCE_USAGE.add(name)
        result.extend(events)
    return result

DETECTED_AT=""
def collect(event_id):
    global DETECTED_AT
    prior_ok,reason=espn.snapshot_local_sincronizado()
    if not prior_ok: raise RuntimeError(reason)
    old=load("resultados.json")
    old_final=verified_finals(old)
    if event_id and event_id in old_final:
        freshness=current_publication_freshness()
        if freshness.get("estado_pronto") is not True:
            raise RuntimeError("base local incoerente: "+str(freshness.get("motivos")))
        print("R36-R4: evento já incorporado; zero consultas externas")
        return []
    now=espn.agora_brt()
    previous=espn.carregar_eventos_normalizados_anteriores()
    # Preserve source metadata omitted by legacy normalized restore.
    original,_=espn.carregar_snapshot_eventos_anterior()
    for item in previous:
        for key in ("fonte_calendario","origem_calendario","fonte_evento","data_espn_original"):
            if key in original.get(item["event_id"],{}): item[key]=original[item["event_id"]][key]
    known={str(x["event_id"]):x for x in previous}
    if len(known)!=len(previous): raise RuntimeError("event_id duplicado")
    calendar=espn.carregar_calendario_canonico_por_mando()
    new={}
    raw_events=query_window(now)
    if not raw_events and not event_id:
        raise RuntimeError("janela ESPN vazia; recuperação externa necessária")
    for raw in raw_events:
        eid=str(raw.get("id") or "")
        candidate=final_candidate(raw,known,now)
        if not candidate: continue
        fixture=calendar.get(identity(candidate))
        if not fixture or int(fixture.get("rodada") or 0)!=int(candidate.get("rodada") or 0):
            raise RuntimeError("FINAL não corresponde à matriz CBF")
        if eid in new and any(new[eid][k]!=candidate[k] for k in ("placar_mandante","placar_visitante")):
            raise RuntimeError("fontes ESPN discordam sobre o FINAL "+eid)
        new[eid]=candidate
    if event_id and event_id not in new:
        # One bounded individual request, never a second complete season crawl.
        if event_id.isdigit() and event_id in known:
            payload=espn.fetch_json(f"{espn.URL_RESUMO_EVENTO}?event={event_id}",timeout=5,tentativas=1)
            raw=espn._evento_bruto_do_summary(payload,event_id)
            candidate=final_candidate(raw or {},known,now)
            if candidate:
                fixture=calendar.get(identity(candidate))
                if fixture and int(fixture.get("rodada") or 0)==int(candidate.get("rodada") or 0):
                    new[event_id]=candidate
        if event_id not in new: raise RuntimeError("FINAL do gatilho não certificado na janela curta")
    if not new:
        print("R36-R4: janela sem FINAL novo; mantendo base local")
        return []
    DETECTED_AT=espn.iso_agora_brt()
    merged=[new.get(x["event_id"],x) for x in previous]
    # Never let elapsed time alone promote an old IN to FINAL in this path.
    for item in merged:
        if item["event_id"] not in old_final and item["event_id"] not in new:
            if espn.evento_realmente_finalizado(item,now):
                raise RuntimeError("há possível FINAL sem confirmação explícita; reconciliação necessária")
    _,prev_stamp=espn.carregar_snapshot_eventos_anterior()
    games,results,events=espn.gerar_jogos_resultados_eventos(
        merged,original,prev_stamp,eventos_ja_normalizados=True,aplicar_manuais=False)
    validate_not_stale(results,old)
    finals=verified_finals(results)
    if set(finals)-set(old_final)!=set(new):
        raise RuntimeError("delta de FINALS não corresponde aos eventos confirmados")
    for eid,item in new.items():
        if finals[eid]!=(item["mandante_nome"],item["visitante_nome"],item["placar_mandante"],item["placar_visitante"]):
            raise RuntimeError("placar alterado ao serializar "+eid)
    table=espn.reconstruir_tabela_pelos_resultados(load("tabela.json"),results)
    if table is None or espn.diagnosticar_sincronia_tabela_resultados(table,results):
        raise RuntimeError("classificação reconstruída não fecha")
    table["atualizado_em"]=results["atualizado_em"]
    table["atualizado_em_br"]=results["atualizado_em_br"]
    # No external publish until the existing AF/Sporting Snapshot Integrity
    # checks certify the entire transaction and its 380-fixture partition.
    for path,data in (("tabela.json",table),("jogos.json",games),("resultados.json",results),("espn_eventos.json",events)):
        espn.gravar_json_atomico(ROOT/path,data)
    print("R36-R4 FINALS certificados: "+",".join(sorted(new)))
    return sorted(new)

def output(values):
    path=os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path,"a",encoding="utf-8") as f:
            for key,value in values.items(): f.write(f"{key}={value}\n")

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--event-id",default="")
    args=ap.parse_args()
    try:
        ids=collect(args.event_id)
        output({"sincronizado":"true","new_ids":",".join(ids),"motivo":"delta certificado",
                "detected_at":DETECTED_AT if ids else "",
                "results_ready_at":espn.iso_agora_brt() if ids else ""})
    except (ValueError,RuntimeError,OSError,TypeError,KeyError) as e:
        print(f"::warning::R36-R4 deferido: {e}")
        output({"sincronizado":"false","new_ids":"","motivo":"reconciliacao completa necessaria"})
    return 0

if __name__=="__main__":
    raise SystemExit(main())
