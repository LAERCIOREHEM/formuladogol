#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
baixar_elencos_local.py — execução local pesada dos elencos do Brasileirão.

Como usar no seu computador, a partir da raiz do repositório:

    python scripts/baixar_elencos_local.py

O script usa apenas biblioteca padrão do Python. Ele consulta a ESPN, gera/atualiza:

    dados-br/elencos.json

Depois disso, faça commit desse JSON no GitHub. O workflow de madrugada também existe,
mas esta execução local é a melhor para a primeira carga completa com fotos dos jogadores.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Garante que o import funcione rodando pela raiz do repositório ou de dentro da pasta scripts.
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from buscar_elencos_brasileirao import main  # noqa: E402


if __name__ == "__main__":
    print("== CARGA LOCAL DE ELENCOS DO BRASILEIRÃO ==")
    print("Gerando dados-br/elencos.json a partir do roster ESPN...")
    main()
    print("OK. Agora suba dados-br/elencos.json para o GitHub.")
