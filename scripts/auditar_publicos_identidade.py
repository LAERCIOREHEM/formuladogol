#!/usr/bin/env python3
"""R10R17-HF6 — auditoria offline de integridade factual/identidade de público e renda.

Não pesquisa a web. Varre TODOS os registros publicados e procura contaminações
estruturais que podem ser provadas pelo próprio repositório: event_id inexistente,
pagantes > presentes, fontes sem URL, URL documental com data muito distante do
jogo e divergência em relação a correções documentais verificadas.

A validação semântica online de cada nova fonte é responsabilidade do Match
Identity Gate + Factual Integrity Guard do Push Worker. Este arquivo é a segunda
trava determinística antes do commit e NÃO pesquisa a web.
"""
from __future__ import annotations
import argparse, json, re, unicodedata
from urllib.parse import urlsplit, unquote
from copy import deepcopy
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from postgame_factual_integrity import (
    INCIDENT_PUBLIC_REVENUE_COLLISION,
    inspect_factual_integrity,
)

ROOT = Path(__file__).resolve().parents[1]
RESULTADOS = ROOT / 'resultados.json'
PUBLICOS = ROOT / 'dados-br' / 'publicos-complementares.json'
CORRECOES = ROOT / 'dados-br' / 'correcoes' / 'publicos-verificados.json'
OUT = ROOT / 'dados-br' / 'auditoria-publicos-identidade.json'


def load(path: Path, fallback: Any) -> Any:
    try: return json.loads(path.read_text(encoding='utf-8'))
    except Exception: return deepcopy(fallback)

def num(v: Any) -> float | None:
    try:
        if v in (None, '') or isinstance(v, bool): return None
        n=float(v); return n if n >= 0 else None
    except Exception: return None

def url_date(url: str) -> date | None:
    m=re.search(r'/(20\d{2})/(\d{1,2})/(\d{1,2})(?:/|$)', str(url or ''))
    if not m: return None
    try: return date(int(m.group(1)),int(m.group(2)),int(m.group(3)))
    except ValueError: return None

def source_competition_conflict(url: str) -> str:
    """Bloqueia fonte de OUTRA competição por segmento de diretório, não slug."""
    try:
        path=unquote(urlsplit(str(url or '')).path).lower().replace('_','-')
    except ValueError:
        return ''
    m=re.search(r'(?:^|/)(copa-do-brasil|campeonato-carioca|campeonato-paulista|libertadores|sul-americana)(?:/|$)',path)
    return m.group(1) if m else ''

# Capacidade de estádio, não do mandante: jogos em campo neutro continuam válidos.
VERIFIED_STADIUM_CAPACITY = {'arena conda': 20089}
def stadium_capacity(game: dict[str,Any]) -> int | None:
    raw=str(game.get('estadio') or game.get('stadium') or '').lower()
    name=' '.join(''.join(c for c in unicodedata.normalize('NFD',raw) if not unicodedata.combining(c)).split())
    name=re.sub(r'^estadio\s+', '', name)
    return VERIFIED_STADIUM_CAPACITY.get(name)

def game_date(row: dict[str,Any]) -> date | None:
    raw=str(row.get('data_iso') or '')[:10]
    try: return date.fromisoformat(raw)
    except ValueError: return None

def source_fields(row: dict[str,Any]) -> dict[str,str]:
    return {
        'publico': str(row.get('fonte_publico') or row.get('fonte') or '').strip(),
        'pagantes': str(row.get('fonte_pagantes') or row.get('fonte_publico_pagante') or row.get('fonte') or '').strip(),
        'renda': str(row.get('fonte_renda') or row.get('fonte') or '').strip(),
    }

def audit_payload(resultados: dict[str,Any], publicos: dict[str,Any], correcoes: dict[str,Any]) -> dict[str,Any]:
    games={str(r.get('event_id') or ''):r for r in (resultados.get('resultados') or []) if isinstance(r,dict) and r.get('event_id')}
    rows=publicos.get('jogos') if isinstance(publicos.get('jogos'),dict) else {}
    verified=correcoes.get('jogos') if isinstance(correcoes.get('jogos'),dict) else {}
    critical=[]; warnings=[]; observations=[]; ok=[]
    for eid,row in sorted(rows.items()):
        if not isinstance(row,dict): continue
        issues=[]; warns=[]
        game=games.get(str(eid))
        if not game:
            observations.append({'event_id':str(eid),'tipo':'event_id_legado_ausente_em_resultados_atual'})
        p=num(row.get('publico')); paid=num(row.get('pagantes') if row.get('pagantes') is not None else row.get('publico_pagante')); rev=num(row.get('renda'))
        if p is not None and not (100 <= p <= 250000): issues.append(f'publico_fora_faixa:{p:g}')
        if paid is not None and p is not None and paid > p: issues.append(f'pagantes_maior_que_publico:{paid:g}>{p:g}')
        if rev is not None and not (0 < rev < 100_000_000): issues.append(f'renda_fora_faixa:{rev:g}')
        cap=stadium_capacity(game or {})
        if cap is not None and ((p is not None and p > cap) or (paid is not None and paid > cap)):
            issues.append(f'capacidade_estadio_excedida:{cap}:publico={p}:pagantes={paid}')

        factual=inspect_factual_integrity(p, paid, rev)
        for code in factual.get('critical') or []:
            issues.append(f'factual_integrity:{code}')
        for code in factual.get('warnings') or []:
            warns.append(f'factual_integrity:{code}')

        fields=source_fields(row)
        for field,value in (('publico',p),('pagantes',paid),('renda',rev)):
            if value is not None and not fields[field]: warns.append(f'{field}_sem_fonte')
        gd=game_date(game or {})
        if gd:
            for field,url in fields.items():
                if not url: continue
                if {'publico':p,'pagantes':paid,'renda':rev}[field] is not None:
                    mismatch=source_competition_conflict(url)
                    if mismatch: issues.append(f'{field}_url_competicao_incompativel:{mismatch}')
                sd=url_date(url)
                if sd:
                    delta=abs((sd-gd).days)
                    if delta > 30: issues.append(f'{field}_url_data_incompativel:{sd.isoformat()}:{gd.isoformat()}:{delta}d')
                    elif delta > 3: observations.append({'event_id':str(eid),'tipo':f'{field}_url_data_distante:{delta}d'})
        vr=verified.get(str(eid)) if isinstance(verified,dict) else None
        if isinstance(vr,dict):
            if vr.get('pagantes_status') == 'nao_divulgado' and paid is not None:
                issues.append('pagantes_nao_comprovados_deveriam_estar_ausentes')
            comparisons=(('publico','publico'),('pagantes','pagantes'),('renda','renda'))
            for rk,pk in comparisons:
                expected=num(vr.get(rk)); actual=num(row.get(pk))
                if expected is not None and actual != expected: issues.append(f'correcao_verificada_nao_aplicada:{pk}:{actual}->{expected}')
        item={'event_id':str(eid),'rodada':game.get('rodada') if game else None,'data_iso':game.get('data_iso') if game else '',
              'mandante':((game.get('mandante') or {}).get('nome') if isinstance(game.get('mandante'),dict) else '') if game else '',
              'visitante':((game.get('visitante') or {}).get('nome') if isinstance(game.get('visitante'),dict) else '') if game else '',
              'publico':row.get('publico'),'pagantes':row.get('pagantes'),'renda':row.get('renda'),'fontes':fields}
        # Duas partidas distintas da MESMA rodada com público e renda idênticos
        # exigem revisão: a janela de uma reportagem multijogo pode ter vazado.
        if game and p is not None and rev is not None:
            for other_eid,other_row in rows.items():
                if str(other_eid)==str(eid) or not isinstance(other_row,dict): continue
                other=games.get(str(other_eid))
                if not other or other.get('rodada')!=game.get('rodada'): continue
                if num(other_row.get('publico'))==p and num(other_row.get('renda'))==rev:
                    # Não é o mesmo evento replicado sob IDs diferentes.
                    participants=lambda g: (str((g.get('mandante') or {}).get('nome')),str((g.get('visitante') or {}).get('nome')))
                    if participants(game)!=participants(other):
                        issues.append(f'publico_renda_duplicados_outro_jogo:{other_eid}')
                        break
        if issues: critical.append({**item,'problemas':issues})
        elif warns: warnings.append({**item,'avisos':warns})
        else: ok.append(str(eid))
    return {
      'schema_version':2,'policy':'R10R17-HF6-match-field-capacity-guard',
      'gerado_em':datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
      'total_registros_publicos':len(rows),'total_ok':len(ok),'total_avisos':len(warnings),'total_criticos':len(critical),'total_observacoes':len(observations),
      'criticos':critical,'avisos':warnings,'observacoes':observations,'event_ids_ok':ok,
      'nota':'Auditoria offline completa e sem rede. Match Identity Gate prova a partida; Factual Integrity Guard prova coerência semântica mínima por campo antes da publicação.'
    }

def self_test() -> None:
    resultados={'resultados':[{'event_id':'x','data_iso':'2026-10-07T20:00','rodada':29,'mandante':{'nome':'Vitória'},'visitante':{'nome':'Chapecoense'}}]}
    publicos={'jogos':{'x':{'publico':1945,'renda':40605,'fonte':'https://uol.com.br/esporte/2025/06/02/errada.htm','fonte_renda':'https://uol.com.br/esporte/2025/06/02/errada.htm'}}}
    out=audit_payload(resultados,publicos,{'jogos':{}})
    assert out['total_criticos']==1 and 'url_data_incompativel' in ' '.join(out['criticos'][0]['problemas'])
    fixed={'jogos':{'x':{'publico':13934,'pagantes':13773,'renda':285132,'fonte':'https://site.com/2026/10/07/certa.htm','fonte_pagantes':'https://site.com/2026/10/07/certa.htm','fonte_renda':'https://site.com/2026/10/07/certa.htm'}}}
    ver={'jogos':{'x':{'publico':13934,'pagantes':13773,'renda':285132}}}
    out2=audit_payload(resultados,fixed,ver)
    assert out2['total_criticos']==0
    collision={'jogos':{'x':{'publico':15056,'renda':15056,'fonte':'https://site.com/2026/10/07/certa.htm','fonte_renda':'https://site.com/2026/10/07/certa.htm'}}}
    out3=audit_payload(resultados,collision,{'jogos':{}})
    assert out3['total_criticos']==1
    assert INCIDENT_PUBLIC_REVENUE_COLLISION in ' '.join(out3['criticos'][0]['problemas'])
    good={'jogos':{'x':{'publico':15056,'renda':708004.50,'fonte':'https://site.com/2026/10/07/certa.htm','fonte_renda':'https://site.com/2026/10/07/certa.htm'}}}
    out4=audit_payload(resultados,good,{'jogos':{'x':{'publico':15056,'renda':708004.50}}})
    assert out4['total_criticos']==0
    other_competition={'jogos':{'x':{'publico':53528,'renda':4106188.74,'fonte':'https://itatiaia.com.br/esportes/futebol/copa-do-brasil/grenal-sem-data'}}}
    out5=audit_payload(resultados,other_competition,{'jogos':{}})
    assert out5['total_criticos']==1 and 'url_competicao_incompativel:copa-do-brasil' in ' '.join(out5['criticos'][0]['problemas'])
    old_carioca={'jogos':{'x':{'renda':1245363,'fonte_renda':'https://ge.globo.com/Esportes/Noticias/Futebol/Campeonato_Carioca/0%2C%2CMUL1082422-9835%2C00.html'}}}
    out6=audit_payload(resultados,old_carioca,{'jogos':{}})
    assert out6['total_criticos']==1 and 'url_competicao_incompativel:campeonato-carioca' in ' '.join(out6['criticos'][0]['problemas'])
    legitimate_slug={'jogos':{'x':{'publico':53528,'renda':4106188.74,'fonte':'https://uol.com.br/esporte/2026/10/07/time-vinga-eliminacao-na-copa-do-brasil.htm'}}}
    assert audit_payload(resultados,legitimate_slug,{'jogos':{}})['total_criticos']==0
    chape={'event_id':'y','data_iso':'2026-10-12T19:30','rodada':30,'estadio':'Arena Condá','mandante':{'nome':'Chapecoense'},'visitante':{'nome':'Athletico-PR'}}
    fla={'event_id':'z','data_iso':'2026-10-11T17:30','rodada':30,'estadio':'Maracanã','mandante':{'nome':'Flamengo'},'visitante':{'nome':'Fluminense'}}
    both={'resultados':[chape,fla]}
    same={'jogos':{'y':{'publico':63300,'pagantes':58246,'renda':7006350,'fonte':'https://ge.globo.com/gato-mestre/2026/10/11/lista.ghtml'},'z':{'publico':63300,'pagantes':58246,'renda':7006350,'fonte':'https://ge.globo.com/gato-mestre/2026/10/11/lista.ghtml'}}}
    out7=audit_payload(both,same,{'jogos':{'y':{'publico':3924,'renda':169490,'pagantes_status':'nao_divulgado'}}})
    assert out7['total_criticos']>=1
    assert any('capacidade_estadio_excedida' in str(r['problemas']) for r in out7['criticos'])
    assert any('publico_renda_duplicados_outro_jogo' in str(r['problemas']) for r in out7['criticos'])
    assert any('pagantes_nao_comprovados' in str(r['problemas']) for r in out7['criticos'])
    fixed={'jogos':{'y':{'publico':3924,'renda':169490,'fonte':'https://uol.com.br/2026/10/12/ficha'},'z':{'publico':63300,'pagantes':58246,'renda':7006350,'fonte':'https://uol.com.br/2026/10/11/ficha'}}}
    out8=audit_payload(both,fixed,{'jogos':{'y':{'publico':3924,'renda':169490,'pagantes_status':'nao_divulgado'}}})
    assert out8['total_criticos']==0
    print('SELF-TEST OK: auditoria de identidade + competição + capacidade + duplicação + pagantes sem prova HF6')

def main() -> None:
    ap=argparse.ArgumentParser()
    ap.add_argument('--self-test',action='store_true')
    ap.add_argument('--fail-on-critical',action='store_true')
    ap.add_argument('--stdout',action='store_true')
    args=ap.parse_args()
    if args.self_test: self_test(); return
    payload=audit_payload(load(RESULTADOS,{}),load(PUBLICOS,{}),load(CORRECOES,{}))
    OUT.write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    if args.stdout: print(json.dumps(payload,ensure_ascii=False,indent=2))
    else: print(f"R10R16.1 sweep: {payload['total_registros_publicos']} registros; OK={payload['total_ok']}; avisos={payload['total_avisos']}; observações={payload['total_observacoes']}; críticos={payload['total_criticos']}")
    if args.fail_on_critical and payload['total_criticos']:
        raise SystemExit(3)
if __name__=='__main__': main()
