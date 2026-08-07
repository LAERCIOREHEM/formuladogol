#!/usr/bin/env python3
"""Gera o editorial especial de encerramento do AF-Previsão 2026.

O artigo é determinístico e só nasce quando o Brasileirão já possui posição e
pontuação finais suficientes para aferir a faixa central de 80%. O conteúdo
editorial destaca exclusivamente indicadores positivos/relevantes, enquanto a
página /acuracia.html permanece como fonte matemática completa.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from copy import deepcopy
from pathlib import Path
from typing import Any, Mapping

from gerar_analise_rodada import (
    ARQUIVO_MANIFESTO,
    CAMINHO_ANALISES,
    SITE,
    TEMPORADA,
    agora_br,
    cabecalho_html,
    carregar_manifesto,
    chave_ordenacao_artigo,
    esc,
    gerar_feed,
    gerar_hub,
    gerar_news_sitemap,
    gravar_texto,
    menu,
    rodape,
    submenu_rodadas,
    atualizar_sitemap,
)

ACCURACY_PATH = Path("dados-br/acuracia-af-previsao.json")
SLUG = f"af-previsao-{TEMPORADA}-balanco-temporada.html"
EDITORIAL_ID = f"af-previsao-{TEMPORADA}-balanco-temporada"
URL = f"{SITE}/analises/{SLUG}"


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"objeto JSON esperado em {path}")
    return value


def pt_pct(value: Any) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "—"
    return f"{number:.1f}%".replace(".", ",")


def audit_digest(data: Mapping[str, Any]) -> str:
    relevant = {
        "jogos": data.get("jogos"),
        "classificacao": data.get("classificacao"),
        "eventos_temporada": data.get("eventos_temporada"),
        "integridade": data.get("integridade"),
        "escopo_publico": data.get("escopo_publico"),
    }
    raw = json.dumps(relevant, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def positive_highlights(data: Mapping[str, Any]) -> list[dict[str, str]]:
    highlights: list[dict[str, str]] = []
    range_data = (((data.get("classificacao") or {}).get("faixa_80") or {}))
    if range_data.get("status") == "concluido":
        for key, label in (("posicao", "Posição final"), ("pontos", "Pontuação final")):
            headline = ((range_data.get(key) or {}).get("destaque") or {})
            value = headline.get("cobertura_pct")
            if value is not None and float(value) >= 80.0:
                highlights.append({
                    "label": f"{label} dentro da faixa de 80%",
                    "value": pt_pct(value),
                    "detail": f"Referência: projeções após {int(headline.get('apos_jogos') or 0)} jogos.",
                })

    games = data.get("jogos") or {}
    top = games.get("maior_probabilidade") or {}
    top_rate = top.get("taxa_confirmacao_pct")
    if int(top.get("amostra") or 0) >= 20 and top_rate is not None and float(top_rate) >= 60.0:
        highlights.append({
            "label": "Tendência de maior probabilidade confirmada",
            "value": pt_pct(top_rate),
            "detail": f"Painel agregado de {int(top.get('amostra') or 0)} partidas auditáveis.",
        })

    events = data.get("eventos_temporada") or {}
    if events.get("status") == "concluido":
        labels = {"campeao": "Campeão", "libertadores": "Libertadores", "sul_americana": "Sul-Americana"}
        for key in ("campeao", "libertadores", "sul_americana"):
            high = (((events.get("eventos") or {}).get(key) or {}).get("alta_confianca_80") or {})
            rate = high.get("taxa_confirmacao_pct")
            if int(high.get("amostra") or 0) >= 1 and rate is not None and float(rate) >= 80.0:
                highlights.append({
                    "label": f"{labels[key]} · previsões ≥80%",
                    "value": pt_pct(rate),
                    "detail": "Primeira entrada na faixa de alta confiança, antes de uma certeza de 100%.",
                })
    return highlights


def eligible(data: Mapping[str, Any]) -> bool:
    range_done = (((data.get("classificacao") or {}).get("faixa_80") or {}).get("status") == "concluido")
    outcomes_done = (data.get("eventos_temporada") or {}).get("status") == "concluido"
    return bool(range_done and outcomes_done)


def editorial_payload(data: Mapping[str, Any]) -> dict[str, Any]:
    highlights = positive_highlights(data)
    scope = data.get("escopo_publico") or {}
    sections: list[dict[str, Any]] = []

    range_data = (((data.get("classificacao") or {}).get("faixa_80") or {}))
    range_lines = []
    for key, noun in (("posicao", "posições finais"), ("pontos", "pontuações finais")):
        headline = ((range_data.get(key) or {}).get("destaque") or {})
        if headline.get("cobertura_pct") is not None and float(headline["cobertura_pct"]) >= 80.0:
            range_lines.append(
                f"{pt_pct(headline['cobertura_pct'])} das {noun} avaliadas terminaram dentro da faixa central de 80% projetada pelo AF no marco após {int(headline.get('apos_jogos') or 0)} jogos."
            )
    if range_lines:
        sections.append({"titulo": "A faixa de 80% em teste real", "paragrafos": range_lines})

    games = data.get("jogos") or {}
    top = games.get("maior_probabilidade") or {}
    paragraphs = []
    if int(top.get("amostra") or 0) >= 20 and top.get("taxa_confirmacao_pct") is not None and float(top["taxa_confirmacao_pct"]) >= 60.0:
        paragraphs.append(
            f"No painel agregado dos jogos, {pt_pct(top['taxa_confirmacao_pct'])} das tendências de maior probabilidade se confirmaram nas {int(top.get('amostra') or 0)} partidas com previsão pré-jogo auditável."
        )
    strong = games.get("alta_confianca_80") or {}
    if int(strong.get("amostra") or 0) >= 3 and strong.get("taxa_confirmacao_pct") is not None and float(strong["taxa_confirmacao_pct"]) >= 80.0:
        paragraphs.append(
            f"Entre as probabilidades de jogo que chegaram a 80% ou mais, a taxa de confirmação foi de {pt_pct(strong['taxa_confirmacao_pct'])}."
        )
    if paragraphs:
        sections.append({"titulo": "Probabilidade transformada em resultado", "paragrafos": paragraphs})

    events = data.get("eventos_temporada") or {}
    event_lines = []
    if events.get("status") == "concluido":
        labels = {"campeao": "campeão", "libertadores": "Libertadores", "sul_americana": "Sul-Americana"}
        for key in ("campeao", "libertadores", "sul_americana"):
            high = (((events.get("eventos") or {}).get(key) or {}).get("alta_confianca_80") or {})
            rate = high.get("taxa_confirmacao_pct")
            if int(high.get("amostra") or 0) >= 1 and rate is not None and float(rate) >= 80.0:
                event_lines.append(
                    f"Nas previsões de {labels[key]} que entraram na faixa de confiança de 80% ou mais antes da certeza factual, {pt_pct(rate)} se confirmaram."
                )
    if event_lines:
        sections.append({"titulo": "Quando o AF entrou em alta confiança", "paragrafos": event_lines})

    sections.append({
        "titulo": "Uma série pública que começa no meio do campeonato",
        "paragrafos": [
            "A auditoria não reconstrói retrospectivamente previsões que não foram registradas antes dos eventos. Por isso, o balanço de 2026 considera somente a série auditável disponível a partir da segunda metade do Brasileirão.",
            "A página Acurácia preserva a timeline por clube, a calibração agregada e os marcos de posição e pontos para que a evolução do AF-Previsão continue verificável nas temporadas seguintes.",
        ],
    })

    return {
        "titulo": f"AF-Previsão {TEMPORADA}: o balanço da temporada",
        "linha_fina": "O histórico auditável transforma as projeções do Fórmula do Gol em uma aferição prática de calibração, posição, pontos e faixas de confiança.",
        "secoes": sections,
        "destaques": highlights,
        "inicio_historico": scope.get("inicio_historico_classificacao"),
    }


def render_page(editorial: Mapping[str, Any], published: str, modified: str, articles: list[dict[str, Any]]) -> str:
    cards = "".join(
        '<article><span>' + esc(item["label"]) + '</span><strong>' + esc(item["value"]) + '</strong><small>' + esc(item["detail"]) + '</small></article>'
        for item in editorial.get("destaques") or []
    )
    highlights_html = f'<div class="analysis-kpis analysis-accuracy-final-kpis">{cards}</div>' if cards else ""
    sections = "".join(
        '<section class="analysis-copy-section"><h3>' + esc(section["titulo"]) + '</h3>'
        + "".join('<p>' + esc(paragraph) + '</p>' for paragraph in section.get("paragrafos") or [])
        + '</section>'
        for section in editorial.get("secoes") or []
    )
    head = cabecalho_html(
        str(editorial["titulo"]), str(editorial["linha_fina"]), URL, "NewsArticle", published, modified
    )
    return head + f'''
<body data-fdg-editorial-id="{EDITORIAL_ID}" data-fdg-acuracia-temporada="{TEMPORADA}">
  <div class="container analysis-shell">
    <header class="hero" aria-label="Fórmula do Gol — A matemática por trás do futebol"><img src="../img/header-formula-do-gol-v2.png" alt="Fórmula do Gol — A matemática por trás do futebol" fetchpriority="high"></header>
    {menu('../', True)}
    {submenu_rodadas(articles, id_ativo=EDITORIAL_ID)}
    <main>
      <article class="analysis-article">
        <nav class="analysis-breadcrumb" aria-label="Navegação estrutural"><a href="./">Análises</a><span>›</span><span>Acurácia {TEMPORADA}</span></nav>
        <header class="analysis-head">
          <div class="analysis-published"><time datetime="{esc(published)}">Publicado ao encerramento do Brasileirão {TEMPORADA}</time></div>
          <span class="analysis-tag">🎯 AF EM PROVA · BALANÇO {TEMPORADA}</span>
          <h1>{esc(editorial['titulo'])}</h1>
          <p class="analysis-deck">{esc(editorial['linha_fina'])}</p>
          <div class="analysis-byline">Por <a href="../sobre.html">Laércio Rehem</a></div>
        </header>
        {highlights_html}
        <section class="analysis-copy"><h2>O que a temporada mostrou</h2><div class="analysis-copy-sections">{sections}</div></section>
        <aside class="analysis-method"><strong>Escopo auditável:</strong> o histórico público do AF-Previsão começa na segunda metade do Brasileirão 2026. Nenhum dado anterior é reconstruído com conhecimento posterior dos resultados.</aside>
        <nav class="analysis-next" aria-label="Mais conteúdo"><a href="../acuracia.html">← Acurácia do AF-Previsão</a><a href="../estatisticas.html#probabilidades">Probabilidades atuais →</a></nav>
      </article>
    </main>
    {rodape('../')}
  </div>
  <script src="../js/br-menu.js?v=20260807-acuracia-v1"></script>
  <script src="../js/br-analises.js?v=20260805-editorial-continental-v1"></script>
</body>
</html>'''


def build_metadata(editorial: Mapping[str, Any], published: str, modified: str, digest: str) -> dict[str, Any]:
    return {
        "tipo": "acuracia_temporada",
        "id_editorial": EDITORIAL_ID,
        "rotulo_menu": f"AF {TEMPORADA}",
        "categoria": "ACURÁCIA",
        "temporada": TEMPORADA,
        "slug": SLUG,
        "url": URL,
        "titulo": editorial["titulo"],
        "linha_fina": editorial["linha_fina"],
        "publicado_em": published,
        "modificado_em": modified,
        "hash_editorial": digest,
        "editorial": deepcopy(dict(editorial)),
        "origem_editorial": "acuracia_deterministica",
    }


def generate(dry_run: bool = False) -> int:
    data = load_json(ACCURACY_PATH)
    if not eligible(data):
        print("Balanço de acurácia ainda não elegível: temporada 2026 sem todos os desfechos necessários.")
        return 0

    manifesto = carregar_manifesto()
    articles = list(manifesto.get("artigos") or [])
    previous = next((item for item in articles if item.get("id_editorial") == EDITORIAL_ID), None)
    digest = audit_digest(data)
    if previous and previous.get("hash_editorial") == digest and (CAMINHO_ANALISES / SLUG).exists():
        print("Balanço de acurácia já está atualizado.")
        return 0

    editorial = editorial_payload(data)
    moment = agora_br().replace(microsecond=0).isoformat()
    published = str((previous or {}).get("publicado_em") or moment)
    modified = moment
    metadata = build_metadata(editorial, published, modified, digest)
    merged = [item for item in articles if item.get("id_editorial") != EDITORIAL_ID] + [metadata]
    merged.sort(key=chave_ordenacao_artigo)
    page = render_page(editorial, published, modified, merged)

    if dry_run:
        print(json.dumps({"metadados": metadata, "destaques": editorial.get("destaques")}, ensure_ascii=False, indent=2))
        return 0

    manifesto.update({
        "schema_version": max(2, int(manifesto.get("schema_version") or 0)),
        "site": "Fórmula do Gol",
        "temporada": TEMPORADA,
        "atualizado_em": modified,
        "total_artigos": len(merged),
        "artigos": merged,
    })
    gravar_texto(CAMINHO_ANALISES / SLUG, page)
    gravar_texto(CAMINHO_ANALISES / "index.html", gerar_hub(merged))
    gravar_texto(ARQUIVO_MANIFESTO, json.dumps(manifesto, ensure_ascii=False, indent=2))
    atualizar_sitemap(merged)
    gravar_texto(Path("news-sitemap.xml"), gerar_news_sitemap(merged, agora_br()))
    gravar_texto(Path("feed.xml"), gerar_feed(merged, agora_br()))
    print(f"Balanço final de acurácia gerado: {URL}")
    return 0


def self_test() -> int:
    synthetic = {
        "escopo_publico": {"inicio_historico_classificacao": "2026-07-17T22:05:00-03:00"},
        "integridade": {"hash_final_temporada": "abc"},
        "jogos": {
            "maior_probabilidade": {"amostra": 200, "confirmadas": 132, "taxa_confirmacao_pct": 66.0},
            "alta_confianca_80": {"amostra": 10, "confirmadas": 9, "taxa_confirmacao_pct": 90.0},
        },
        "classificacao": {"faixa_80": {
            "status": "concluido",
            "posicao": {"destaque": {"apos_jogos": 35, "amostra": 20, "dentro_faixa": 17, "cobertura_pct": 85.0}},
            "pontos": {"destaque": {"apos_jogos": 35, "amostra": 20, "dentro_faixa": 18, "cobertura_pct": 90.0}},
        }},
        "eventos_temporada": {"status": "concluido", "eventos": {
            "campeao": {"alta_confianca_80": {"amostra": 1, "confirmadas": 1, "taxa_confirmacao_pct": 100.0}},
            "libertadores": {"alta_confianca_80": {"amostra": 5, "confirmadas": 5, "taxa_confirmacao_pct": 100.0}},
            "sul_americana": {"alta_confianca_80": {"amostra": 4, "confirmadas": 3, "taxa_confirmacao_pct": 75.0}},
        }},
    }
    assert eligible(synthetic)
    editorial = editorial_payload(synthetic)
    labels = " ".join(item["label"] for item in editorial["destaques"])
    assert "Posição final" in labels and "Pontuação final" in labels and "Libertadores" in labels
    assert "Sul-Americana · previsões ≥80%" not in labels
    page = render_page(editorial, "2026-12-06T19:00:00-03:00", "2026-12-06T19:00:00-03:00", [])
    assert 'data-fdg-acuracia-temporada="2026"' in page
    assert "85,0%" in page and "90,0%" in page
    assert "maiores erros" not in page.casefold() and "pior previsão" not in page.casefold()
    assert page.index("📰 Análises") < page.index("🎯 Acurácia") < page.index("🛡️ Clubes")
    print("Self-test balanço final de acurácia: OK")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    return generate(dry_run=args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
