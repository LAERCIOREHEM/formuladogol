#!/usr/bin/env python3
"""Valida o arquivo editorial do Fórmula do Gol, localmente ou no pacote do Pages."""
from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path


class Parser(HTMLParser):
    pass


def editorial_id(article: dict) -> str:
    value = str(article.get("id_editorial") or "").strip()
    if value:
        return value
    round_number = int(article.get("rodada") or 0)
    return f"brasileirao-2026-rodada-{round_number}" if round_number else ""


def validate(root: Path) -> None:
    manifest_path = root / "dados-br" / "analises.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    articles = manifest.get("artigos") or []
    assert int(manifest.get("schema_version") or 0) >= 2, "manifesto editorial precisa usar schema 2"
    assert manifest.get("total_artigos") == len(articles) >= 1, "manifesto editorial vazio ou divergente"
    ids, slugs, urls = set(), set(), set()
    hub = (root / "analises" / "index.html").read_text(encoding="utf-8")
    Parser().feed(hub)
    assert "analysis-round-nav" in hub, "hub sem arquivo interno de análises"

    for article in articles:
        identifier = editorial_id(article)
        slug = str(article.get("slug") or "")
        url = str(article.get("url") or "")
        assert identifier and identifier not in ids, f"id editorial ausente ou duplicado: {identifier!r}"
        assert slug and slug not in slugs, f"slug editorial ausente ou duplicado: {slug!r}"
        assert url and url not in urls, f"URL editorial ausente ou duplicada: {url!r}"
        ids.add(identifier); slugs.add(slug); urls.add(url)
        assert article.get("hash_editorial"), f"{slug}: hash editorial ausente"
        assert isinstance(article.get("editorial"), dict), f"{slug}: conteúdo editorial ausente"
        assert article.get("rotulo_menu") and article.get("categoria"), f"{slug}: metadados de navegação ausentes"
        page = root / "analises" / slug
        text = page.read_text(encoding="utf-8")
        Parser().feed(text)
        assert '"@type":"NewsArticle"' in text, f"{slug}: NewsArticle ausente"
        assert f'data-fdg-editorial-id="{identifier}"' in text, f"{slug}: marcador editorial genérico ausente"
        assert article["titulo"] in text, f"{slug}: título divergente"
        assert "analysis-round-nav" in text, f"{slug}: navegação interna ausente"
        assert "analysis-copy-section" in text, f"{slug}: corpo editorial ausente"
        assert slug in hub, f"{slug}: card ausente do hub"
        assert str(article["rotulo_menu"]) in hub, f"{slug}: subaba ausente do hub"
        assert "0,000%" not in text, f"{slug}: percentual proibido"

        article_type = str(article.get("tipo") or "")
        if article_type == "brasileirao_rodada":
            round_number = int(article.get("rodada") or 0)
            assert round_number > 0, f"{slug}: rodada inválida"
            assert f'data-fdg-analise-rodada="{round_number}"' in text, f"{slug}: marcador de rodada ausente"
            assert text.count('class="analysis-game-card"') == int(article.get("jogos_concluidos") or 0), f"{slug}: jogos divergentes"
            assert "Padrão dos percentuais" in text, f"{slug}: explicação de percentuais ausente"
        elif article_type == "copa_do_brasil_fase":
            confrontos = int(article.get("confrontos") or 0)
            classificados = article.get("classificados") or []
            assert confrontos in {1, 2, 4, 8}, f"{slug}: quantidade de confrontos inválida: {confrontos}"
            assert len(classificados) == confrontos, f"{slug}: classificados/vencedor incompatíveis com a fase"
            assert len(set(classificados)) == len(classificados), f"{slug}: classificados duplicados"
            assert text.count('class="analysis-cup-tie"') == confrontos, f"{slug}: cards de confronto divergentes"
            assert article.get("fase_encerrada") and article.get("fase_seguinte"), f"{slug}: metadados da fase ausentes"
            assert 'data-fdg-analise-competicao="copa-do-brasil"' in text, f"{slug}: marcador da competição ausente"
            assert "Tabela do Brasileirão" not in text and "analysis-kpis" not in text, f"{slug}: layout indevidamente herdado da rodada"
            if 'class="analysis-status status-eliminated"' in text:
                assert re.search(r"Via Copa.*0%", text, flags=re.I | re.S), f"{slug}: eliminação sem zero explícito"
            expected_videos = int(article.get("melhores_momentos_vinculados") or 0)
            inline_ids = re.findall(r'data-video-id="([A-Za-z0-9_-]{11})"', text)
            external_ids = re.findall(r'class="analysis-cup-video-card analysis-cup-video-external"[^>]+href="https://www\.youtube\.com/watch\?v=([A-Za-z0-9_-]{11})"', text)
            video_ids = inline_ids + external_ids
            assert len(video_ids) == expected_videos, f"{slug}: quantidade de vídeos diverge do manifesto ({len(video_ids)}/{expected_videos})"
            assert len(video_ids) == len(set(video_ids)), f"{slug}: vídeo de melhores momentos duplicado"
            total_cards = text.count('class="analysis-cup-video-card analysis-inline-video"') + text.count('class="analysis-cup-video-card analysis-cup-video-external"')
            assert total_cards == expected_videos, f"{slug}: cards de vídeo divergentes"
            assert '<iframe' not in ''.join(re.findall(r'<div class="analysis-cup-legs">.*?</div>\s*</article>', text, flags=re.S)), f"{slug}: iframe carregado antes do clique; lazy-load quebrado"
        elif article_type == "acuracia_temporada":
            temporada = int(article.get("temporada") or 2026)
            assert f'data-fdg-acuracia-temporada="{temporada}"' in text, f"{slug}: marcador do balanço de acurácia ausente"
            assert "AF-Previsão" in text, f"{slug}: balanço sem referência ao AF-Previsão"
            assert "faixa" in text.lower() and "80%" in text, f"{slug}: balanço sem destaque para a faixa central de 80%"
            assert "segunda metade" in text.lower(), f"{slug}: escopo histórico de 2026 não declarado"
            proibidos = ("maiores erros", "piores previsões", "placar exato")
            assert not any(item in text.lower() for item in proibidos), f"{slug}: conteúdo negativo/fora do escopo no balanço público"
        else:
            raise AssertionError(f"{slug}: tipo editorial desconhecido: {article_type}")

    history_path = root / "dados-br" / "historico-probabilidades-continentais.json"
    if history_path.exists():
        history = json.loads(history_path.read_text(encoding="utf-8"))
        assert history.get("total_marcos") == len(history.get("marcos") or []), "histórico continental divergente"
        mark_ids = [item.get("id") for item in history.get("marcos") or []]
        assert len(mark_ids) == len(set(mark_ids)), "histórico continental com ids duplicados"
        assert "copa-do-brasil-2026-oitavas-antes-jogos-de-volta" in mark_ids, "fotografia anterior não preservada"

    for xml in ("sitemap.xml", "news-sitemap.xml", "feed.xml"):
        ET.parse(root / xml)
    sitemap = (root / "sitemap.xml").read_text(encoding="utf-8")
    assert "https://formuladogol.com.br/analises/" in sitemap, "hub ausente do sitemap"
    for article in articles:
        assert article["url"] in sitemap, f"URL ausente do sitemap: {article['url']}"
    print(f"OK: {len(articles)} análise(s), histórico, HTML e XML validados em {root}.")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("."))
    args = parser.parse_args()
    try:
        validate(args.root.resolve())
    except (AssertionError, OSError, json.JSONDecodeError, ET.ParseError) as exc:
        print(f"ERRO: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
