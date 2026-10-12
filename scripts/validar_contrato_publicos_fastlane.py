#!/usr/bin/env python3
"""Contract: the public Pages artifact is the authoritative D1 attendance seed.

Run from any working directory:
  python scripts/validar_contrato_publicos_fastlane.py
  python scripts/validar_contrato_publicos_fastlane.py --site-root _site
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = (
    'dados-br/publicos-complementares.json',
    'dados-br/correcoes/publicos-verificados.json',
)


def load(path: Path) -> dict:
    if not path.is_file():
        raise AssertionError(f'Arquivo obrigatório não publicado: {path}')
    obj = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(obj, dict) or not isinstance(obj.get('jogos'), dict):
        raise AssertionError(f'Contrato jogos inválido: {path}')
    return obj['jogos']


def check_data(root: Path) -> tuple[int, int]:
    public = load(root / REQUIRED[0]); verified = load(root / REQUIRED[1])
    # Verified corrections override the public snapshot per event_id in the Worker.
    # Do NOT reject an intermediate commit before the public consolidation workflow
    # has copied a new correction into publicos-complementares.json.
    for event_id, record in verified.items():
        if not isinstance(record, dict):
            raise AssertionError(f'Correção inválida: {event_id}')
        for field in ('publico', 'pagantes', 'renda'):
            if record.get(field) is not None and not isinstance(record[field], (int, float)):
                raise AssertionError(f'Correção não numérica: {event_id}.{field}')
    return len(public), len(verified)

def check_workflow() -> None:
    text = (ROOT / '.github/workflows/deploy.yml').read_text(encoding='utf-8')
    block = re.search(r'(?ms)^\s*PUBLIC_DATA=\(\n(?P<items>.*?)^\s*\)', text)
    if not block:
        raise AssertionError('PUBLIC_DATA não encontrado no workflow de Pages')
    items = {line.strip() for line in block.group('items').splitlines() if line.strip() and not line.strip().startswith('#')}
    for item in REQUIRED:
        if item not in items:
            raise AssertionError(f'Pages não publica {item} em PUBLIC_DATA')
    if 'mkdir -p _site/dados-br/correcoes' not in text:
        raise AssertionError('Pages não cria o diretório para correcoes/publicos-verificados.json')
    for item in REQUIRED:
        if f'_site/{item}' not in text:
            raise AssertionError(f'Pages não valida artefato _site/{item}')


def check_worker() -> None:
    text = (ROOT / 'cloudflare/push-worker/src/postgame-fastlane.js').read_text(encoding='utf-8')
    for item in REQUIRED:
        if f'${{base}}/{item}?t=${{stamp}}' not in text:
            raise AssertionError(f'Worker não consulta {item}')
        if re.search(re.escape(item) + r'.*\.catch\(\(\) => \(\{ jogos: \{\} \}\)\)', text):
            raise AssertionError(f'Worker silencia erro do snapshot {item}')
    if "await metaPut(env, 'static_seed_error', '');" not in text:
        raise AssertionError('Worker não limpa static_seed_error após sucesso')
    if "next.alert_status='suppressed_static_seed_unavailable'" not in text:
        raise AssertionError('Worker não suprime e-mail de SLA com snapshot indisponível')


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument('--site-root', help='Diretório _site gerado no workflow Pages')
    args = p.parse_args()
    check_workflow()
    check_worker()
    npublic, nverified = check_data(ROOT)
    if args.site_root:
        target = Path(args.site_root).resolve()
        a, b = check_data(target)
        # Verifica que o artefato é o mesmo snapshot da revisão em build.
        for item in REQUIRED:
            if (ROOT / item).read_bytes() != (target / item).read_bytes():
                raise AssertionError(f'Artefato Pages divergente do commit: {item}')
        print(f'Pages↔D1: PASS (repo {npublic}/{nverified}; _site {a}/{b})')
    else:
        print(f'Pages↔D1: PASS (repo {npublic} jogos; {nverified} correções verificadas)')


if __name__ == '__main__':
    main()
