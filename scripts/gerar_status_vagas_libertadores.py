#!/usr/bin/env python3
"""Public payload: compact, factual Libertadores 2027 qualification inputs.

GitHub Pages deliberately does not expose entire continental AF snapshots.
Only the final teams/winners required for the table's deterministic visual
zone are exported. This is not an eligibility estimate or a new simulation.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT/'dados-br'/'competicoes-af-previsao'
TARGET=ROOT/'dados-br'/'vagas-libertadores-2027.json'

def load(path):
    return json.loads(path.read_text(encoding='utf-8'))

def compact(source):
    events=[
      e for e in source.get('eventos',[])
      if int(e.get('fase_ordem') or 0)==900
    ]
    return {
      'status':source.get('status','indisponivel'),
      'gerado_em':source.get('gerado_em'),
      'eventos':[{
         'fase_ordem':900,
         'mandante':{'nome':str((e.get('mandante') or {}).get('nome') or '')},
         'visitante':{'nome':str((e.get('visitante') or {}).get('nome') or '')},
         'estado':str(e.get('estado') or ''),
         'concluido':e.get('concluido') is True,
         'vencedor':str(e.get('vencedor') or ''),
       } for e in events],
    }

def build():
    payload={'schema_version':1,'temporada':2027,'fonte':'AF-Previsão — snapshots continentais oficiais'}
    for key,path in (
        ('copa','copa-do-brasil.json'),
        ('libertadores','libertadores.json'),
        ('sulamericana','sul-americana.json'),
    ):
        payload[key]=compact(load(BASE/path))
    return payload

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--self-test',action='store_true')
    args=ap.parse_args()
    data=build()
    for key in ('copa','libertadores','sulamericana'):
        assert len(data[key]['eventos'])<=1,(key,'finais sobrepostas sem autoridade')
    assert len(data['copa']['eventos'])==1,'final da Copa do Brasil ausente'
    finale=data['copa']['eventos'][0]
    assert finale['mandante']['nome'] and finale['visitante']['nome']
    raw=json.dumps(data,ensure_ascii=False,separators=(',',':'))+'\n'
    if not args.self_test:
        TARGET.write_text(raw,encoding='utf-8')
    print(json.dumps({'r35_r1':'public_zone_inputs','mode':'test' if args.self_test else 'publish',
                      'bytes':len(raw.encode('utf-8')),
                      'finalistas':[finale['mandante']['nome'],finale['visitante']['nome']]},
                     ensure_ascii=False))

if __name__=='__main__':
    main()
