#!/usr/bin/env python3
"""HOTFIX6: reconcilia campos documentais e remove pagantes falsos por event_id.

Não acessa rede, não estima pagantes, não altera placar. O status
'nao_divulgado' significa ausência de prova, não zero pagantes.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
VERIFIED = ROOT / 'dados-br/correcoes/publicos-verificados.json'
PUBLIC = ROOT / 'dados-br/publicos-complementares.json'
DETAILS = ROOT / 'dados-br/jogos-detalhes.json'
RESULTS = ROOT / 'resultados.json'
TARGETS = {
    '401841265': ('Chapecoense', 'Athletico-PR'),
    '401841266': ('Bahia', 'Mirassol'),
}


def read(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict):
        raise ValueError(f'JSON não é objeto: {path}')
    return data


def update(public: dict, details: dict, verified: dict, results: dict) -> int:
    games = {str(r.get('event_id')): r for r in results.get('resultados', [])}
    changed = 0
    for eid, expected in TARGETS.items():
        v = verified.get('jogos', {}).get(eid)
        if not isinstance(v, dict):
            raise ValueError(f'Correção verificada obrigatória ausente: {eid}')
        g = games.get(eid)
        if g:
            actual = ((g.get('mandante') or {}).get('nome'), (g.get('visitante') or {}).get('nome'))
            if actual != expected:
                raise ValueError(f'Identidade do evento {eid} divergente: {actual} != {expected}')
        if v.get('pagantes_status') != 'nao_divulgado':
            raise ValueError(f'Pagantes sem comprovação precisam estar marcados nao_divulgado: {eid}')
        for key in ('publico', 'renda', 'fonte_publico', 'fonte_renda'):
            if not v.get(key):
                raise ValueError(f'Correção documental incompleta: {eid}.{key}')
        p = public.setdefault('jogos', {}).setdefault(eid, {})
        for key, val in {
            'publico': v['publico'], 'publico_status': 'divulgado',
            'renda': v['renda'], 'renda_status': 'divulgado',
            'pagantes_status': 'nao_divulgado', 'tipo': 'presente',
            'fonte': v['fonte_publico'], 'fonte_publico': v['fonte_publico'],
            'fonte_renda': v['fonte_renda'],
            'origem': 'correção documental verificada',
            'verificado_em': v.get('verificado_em') or verified.get('verificado_em') or '',
        }.items():
            if p.get(key) != val:
                p[key] = val
                changed += 1
        for key in ('pagantes', 'publico_pagante', 'fonte_pagantes', 'fonte_publico_pagante'):
            if key in p:
                p.pop(key)
                changed += 1
        d = details.get('jogos', {}).get(eid)
        if isinstance(d, dict):
            for key, val in {
                'publico': v['publico'], 'publico_fonte': v['fonte_publico'],
                'publico_tipo': 'presente', 'renda': v['renda'],
            }.items():
                if d.get(key) != val:
                    d[key] = val
                    changed += 1
            for key in ('publico_pagante', 'pagantes'):
                if key in d:
                    d.pop(key)
                    changed += 1
    if changed and isinstance(details.get('jogos'), dict):
        details['total_com_publico_pagante'] = sum(
            1 for row in details['jogos'].values()
            if isinstance(row, dict) and isinstance(row.get('publico_pagante'), (int, float)) and row['publico_pagante'] > 0
        )
    return changed


def self_test() -> None:
    v = {'jogos': {
        '401841265': {'publico':3924,'renda':169490,'pagantes_status':'nao_divulgado','fonte_publico':'https://uol.com/chape','fonte_renda':'https://uol.com/chape'},
        '401841266': {'publico':28704,'renda':935545,'pagantes_status':'nao_divulgado','fonte_publico':'https://uol.com/bahia','fonte_renda':'https://uol.com/bahia'},
    }}
    p = {'jogos': {
        '401841265': {'publico':63300,'pagantes':58246,'renda':7006350,'fonte_pagantes':'https://ge.globo.com/errada'},
        '401841266': {'publico':28704,'pagantes':18982,'renda':1609117,'fonte_pagantes':'https://ge.globo.com/errada'},
    }}
    d = {'jogos': {'401841265': {'publico':63300,'publico_pagante':58246,'renda':7006350},'401841266': {'publico_pagante':18982,'renda':1609117}}}
    r = {'resultados': [
        {'event_id':'401841265','mandante':{'nome':'Chapecoense'},'visitante':{'nome':'Athletico-PR'}},
        {'event_id':'401841266','mandante':{'nome':'Bahia'},'visitante':{'nome':'Mirassol'}},
    ]}
    assert update(p, d, v, r) > 0
    assert update(p, d, v, r) == 0, 'idempotência obrigatória'
    assert p['jogos']['401841265']['publico'] == 3924
    assert p['jogos']['401841265']['renda'] == 169490
    assert 'pagantes' not in p['jogos']['401841265']
    assert p['jogos']['401841266']['renda'] == 935545
    assert 'pagantes' not in p['jogos']['401841266']
    assert 'publico_pagante' not in d['jogos']['401841265']
    assert 'publico_pagante' not in d['jogos']['401841266']
    print('HOTFIX6 curated public/revenue + paid-null regression: PASS')


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--self-test', action='store_true')
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.apply:
        ap.error('use --apply ou --self-test')
    public = read(PUBLIC)
    details = read(DETAILS)
    verified = read(VERIFIED)
    results = read(RESULTS)
    changed = update(public, details, verified, results)
    if changed:
        PUBLIC.write_text(json.dumps(public, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        DETAILS.write_text(json.dumps(details, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'HOTFIX6: reconciliação documental concluída; campos corrigidos/removidos={changed}')


if __name__ == '__main__':
    main()
