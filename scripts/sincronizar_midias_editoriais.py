#!/usr/bin/env python3
"""Sincroniza somente os botões de Melhores Momentos em editoriais já publicados.

A fonte da verdade continua sendo dados-br/melhores-momentos*.json. O script não
reescreve título, linha fina, texto editorial, probabilidades, estatísticas nem
metadados do artigo; altera exclusivamente o conteúdo de .analysis-game-actions
para refletir a mídia atual do jogo.
"""
from __future__ import annotations

import argparse
import html
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from gerar_analise_rodada import (  # noqa: E402
    ARQUIVO_CONFIG,
    CAMINHO_ANALISES,
    agora_br,
    carregar_json,
    carregar_manifesto,
    estado_rodada,
    montar_dossie,
    renderizar_jogo,
)

CARD_RE = re.compile(r'<article class="analysis-game-card">.*?</article>', re.S)
H3_RE = re.compile(r'<h3>(.*?)</h3>', re.S)
ACTIONS_RE = re.compile(r'<div class="analysis-game-actions">.*?</div>', re.S)
VIDEO_RE = re.compile(r'class="analysis-video(?:\s|\")')


def _acao_de_html(renderizado: str) -> str:
    m = ACTIONS_RE.search(renderizado)
    if not m:
        raise RuntimeError("renderizar_jogo não produziu analysis-game-actions")
    return m.group(0)


def _linha_do_card(card: str) -> str:
    m = H3_RE.search(card)
    if not m:
        return ""
    return html.unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip()


def _substituir_acoes(html_artigo: str, acoes_por_linha: dict[str, str]) -> tuple[str, int, int]:
    encontrados = 0
    alterados = 0

    def repl(match: re.Match[str]) -> str:
        nonlocal encontrados, alterados
        card = match.group(0)
        linha = _linha_do_card(card)
        if linha not in acoes_por_linha:
            return card
        encontrados += 1
        desejada = acoes_por_linha[linha]
        atual = ACTIONS_RE.search(card)
        if not atual:
            raise RuntimeError(f"Card sem analysis-game-actions: {linha}")
        if atual.group(0) == desejada:
            return card
        alterados += 1
        return card[: atual.start()] + desejada + card[atual.end() :]

    return CARD_RE.sub(repl, html_artigo), encontrados, alterados


def sincronizar_rodada(rodada: int, *, dry_run: bool = False) -> dict[str, Any]:
    manifesto = carregar_manifesto()
    artigo = next(
        (
            item
            for item in (manifesto.get("artigos") or [])
            if item.get("tipo") == "brasileirao_rodada" and int(item.get("rodada") or 0) == rodada
        ),
        None,
    )
    if not artigo:
        return {"rodada": rodada, "publicado": False, "alterados": 0, "motivo": "editorial não publicado"}

    pagina = CAMINHO_ANALISES / str(artigo.get("slug") or f"brasileirao-2026-rodada-{rodada}.html")
    if not pagina.is_file():
        raise RuntimeError(f"Editorial publicado no manifesto, mas HTML ausente: {pagina}")

    config = carregar_json(ARQUIVO_CONFIG)
    estado = estado_rodada(rodada, agora_br(), config)
    dossie = montar_dossie(rodada, estado)
    acoes_por_linha = {jogo["linha"]: _acao_de_html(renderizar_jogo(jogo)) for jogo in dossie["jogos"]}

    original = pagina.read_text(encoding="utf-8")
    atualizado, encontrados, alterados = _substituir_acoes(original, acoes_por_linha)
    esperado = len(dossie["jogos"])
    if encontrados != esperado:
        raise RuntimeError(
            f"R{rodada}: cards encontrados no editorial ({encontrados}) divergem dos jogos do dossiê ({esperado})"
        )

    if alterados and not dry_run:
        pagina.write_text(atualizado, encoding="utf-8")

    return {
        "rodada": rodada,
        "publicado": True,
        "jogos": esperado,
        "alterados": alterados,
        "arquivo": str(pagina),
        "videos_antes": len(VIDEO_RE.findall(original)),
        "videos_depois": len(VIDEO_RE.findall(atualizado)),
    }


def sincronizar_todos(*, dry_run: bool = False) -> list[dict[str, Any]]:
    manifesto = carregar_manifesto()
    rodadas = sorted(
        {
            int(item.get("rodada") or 0)
            for item in (manifesto.get("artigos") or [])
            if item.get("tipo") == "brasileirao_rodada" and int(item.get("rodada") or 0) > 0
        }
    )
    return [sincronizar_rodada(rodada, dry_run=dry_run) for rodada in rodadas]


def self_test() -> int:
    base = '''<article class="analysis-game-card">
      <h3>Internacional 1 × 1 Remo</h3>
      <div class="analysis-game-actions"><button type="button" class="analysis-stats-toggle">▸ Estatísticas do jogo</button></div>
      <div class="analysis-game-details"><p>Texto que não pode mudar.</p></div>
    </article>'''
    desejada = '<div class="analysis-game-actions"><button type="button" class="analysis-stats-toggle">▸ Estatísticas do jogo</button><button type="button" class="analysis-video" data-video-id="q6Sn-QgweWM">▶ Melhores momentos</button></div>'
    novo, encontrados, alterados = _substituir_acoes(base, {"Internacional 1 × 1 Remo": desejada})
    assert encontrados == 1 and alterados == 1
    assert 'data-video-id="q6Sn-QgweWM"' in novo
    assert '<p>Texto que não pode mudar.</p>' in novo
    removido, encontrados2, alterados2 = _substituir_acoes(novo, {
        "Internacional 1 × 1 Remo": '<div class="analysis-game-actions"><button type="button" class="analysis-stats-toggle">▸ Estatísticas do jogo</button></div>'
    })
    assert encontrados2 == 1 and alterados2 == 1
    assert 'analysis-video' not in removido
    assert '<p>Texto que não pode mudar.</p>' in removido
    print("OK self-test: sincronização altera somente analysis-game-actions e suporta inclusão/remoção de vídeo.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rodada", type=int, choices=range(1, 39))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    resultados = [sincronizar_rodada(args.rodada, dry_run=args.dry_run)] if args.rodada else sincronizar_todos(dry_run=args.dry_run)
    alterados = sum(int(item.get("alterados") or 0) for item in resultados)
    for item in resultados:
        print(item)
    print(f"Sincronização editorial de mídias concluída: {alterados} card(s) alterado(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
