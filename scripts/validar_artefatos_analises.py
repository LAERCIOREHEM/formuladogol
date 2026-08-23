#!/usr/bin/env python3
"""Valida o arquivo editorial do Fórmula do Gol, localmente ou no pacote do Pages."""
from __future__ import annotations

import argparse
import hashlib
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
    ids, slugs, urls, title_keys = set(), set(), set(), set()
    hub = (root / "analises" / "index.html").read_text(encoding="utf-8")
    Parser().feed(hub)
    assert "analysis-round-nav" in hub, "hub sem arquivo interno de análises"
    menu_slugs = [str(article.get("slug") or "") for article in articles]
    menu_labels = [str(article.get("rotulo_menu") or "") for article in articles]

    milestones_path = root / "dados-br" / "marcos-af-previsao.json"
    assert milestones_path.exists(), "marcos públicos do AF-Previsão ausentes"
    milestones = json.loads(milestones_path.read_text(encoding="utf-8"))
    milestone_rows = milestones.get("marcos") or []
    assert milestones.get("total_marcos") == len(milestone_rows), "marcos AF-Previsão divergentes"
    milestone_by_round = {
        int(item.get("rodada") or 0): item
        for item in milestone_rows
        if item.get("tipo") == "brasileirao_fechamento"
    }
    milestone_ids = [str(item.get("id") or "") for item in milestone_rows]
    assert all(milestone_ids) and len(milestone_ids) == len(set(milestone_ids)), "marcos AF-Previsão com ids ausentes/duplicados"
    for milestone in milestone_rows:
        clubs = milestone.get("clubes") or []
        assert len(clubs) == 20 and len({str(row.get("clube") or "") for row in clubs}) == 20, f"{milestone.get('id')}: marco sem vinte clubes"
        canonical = json.dumps(clubs, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        assert milestone.get("hash_20_clubes") == hashlib.sha256(canonical.encode("utf-8")).hexdigest(), f"{milestone.get('id')}: hash dos vinte clubes divergente"

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
        title = str(article["titulo"])
        description = str(article.get("linha_fina") or "")
        title_key = re.sub(r"^rodada\s+\d+\s*:\s*", "", title.casefold()).strip()
        assert title_key not in title_keys, f"{slug}: manchete editorial repetida: {title!r}"
        title_keys.add(title_key)
        assert f"<title>{title} — Fórmula do Gol</title>" in text, f"{slug}: <title> divergente do manifesto"
        assert f"<h1>{title}</h1>" in text, f"{slug}: H1 divergente do manifesto"
        assert f'meta name="description" content="{description}"' in text, f"{slug}: meta description divergente"
        assert f'meta property="og:title" content="{title} — Fórmula do Gol"' in text, f"{slug}: og:title divergente"
        assert f'meta name="twitter:title" content="{title} — Fórmula do Gol"' in text, f"{slug}: twitter:title divergente"
        assert 'Probabilidades do Brasileirão 2026 →' in text, f"{slug}: âncora SEO para probabilidades ausente"
        assert "analysis-round-nav" in text, f"{slug}: navegação interna ausente"
        nav_match = re.search(r'<nav class="analysis-round-nav" aria-label="Arquivo de análises">(.*?)</nav>', text, flags=re.S)
        assert nav_match, f"{slug}: bloco de navegação interna inválido"
        nav_html = nav_match.group(1)
        for menu_slug, menu_label in zip(menu_slugs, menu_labels):
            assert nav_html.count(f'href="{menu_slug}"') == 1, f"{slug}: subaba {menu_slug} ausente ou duplicada"
            assert menu_label in nav_html, f"{slug}: rótulo {menu_label!r} ausente da navegação"
        assert nav_html.count('aria-current="page"') == 1, f"{slug}: página ativa precisa ser única"
        assert re.search(rf'href="{re.escape(slug)}" class="active" aria-current="page"', nav_html), f"{slug}: artigo atual não está marcado como ativo"
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
            milestone = milestone_by_round.get(round_number)
            assert milestone is not None, f"{slug}: editorial sem marco público imutável da R{round_number}"
            af_meta = article.get("af_marco") or {}
            assert af_meta.get("marco_id") == milestone.get("id"), f"{slug}: marco editorial diverge da evolução pública"
            assert af_meta.get("snapshot_depois_hash") == (milestone.get("fonte") or {}).get("hash_snapshot"), f"{slug}: snapshot DEPOIS diverge do marco público"
            assert af_meta.get("hash_20_clubes_depois") == milestone.get("hash_20_clubes"), f"{slug}: os 20 clubes do editorial divergem do marco público"
            assert af_meta.get("snapshot_antes_hash"), f"{slug}: snapshot ANTES não está auditado"
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
        elif article_type == "continentais_fase":
            confrontos = int(article.get("confrontos") or 0)
            assert confrontos >= 1, f"{slug}: editorial continental sem confrontos"
            assert article.get("fase_encerrada"), f"{slug}: fase continental ausente"
            assert 'data-fdg-analise-competicao="continentais"' in text, f"{slug}: marcador continental ausente"
            assert text.count('class="analysis-cup-tie"') == confrontos, f"{slug}: confrontos continentais divergentes"
            assert "Partida 1 de 2" in text or "PARTIDA 1 DE 2" in text, f"{slug}: identificação da ida ausente"
            assert "Partida 2 de 2" in text or "PARTIDA 2 DE 2" in text, f"{slug}: identificação da volta ausente"
            assert "AGREGADO" in text, f"{slug}: agregado ausente"
            expected_videos = int(article.get("melhores_momentos_vinculados") or 0)
            total_cards = text.count('class="analysis-cup-video-card analysis-inline-video"') + text.count('class="analysis-cup-video-card analysis-cup-video-external"')
            assert total_cards == expected_videos, f"{slug}: melhores momentos continentais divergentes ({total_cards}/{expected_videos})"
            assert len(article.get("classificados") or []) <= len(article.get("clubes_brasileiros") or []), f"{slug}: classificados continentais inválidos"
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
