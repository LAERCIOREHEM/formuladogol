#!/usr/bin/env python3
"""Hotfix idempotente do editorial da Rodada 28 de 2026.

Remove um trecho de metalinguagem/instruções internas que escapou para a matéria
publicada e marca o editorial como curado. O script altera somente a matéria da
R28 e seu registro em dados-br/analises.json.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

ARTICLE_ID = "brasileirao-2026-rodada-28"
ARTICLE_SLUG = "brasileirao-2026-rodada-28.html"
CLEAN_PARAGRAPH = (
    "Santos, Vasco e São Paulo completaram o grupo de maiores altas. "
    "O Santos venceu o Remo por 2 a 1, saltou para o oitavo lugar e elevou sua probabilidade total de Libertadores de 8,9% para 17,9%. "
    "O São Paulo, com o 1 a 0 sobre o Internacional, chegou a 19,1%; o Vasco avançou a 32,5% depois dos 5 a 0 sobre o Coritiba. "
    "Esses percentuais representam a chance total de classificação à Libertadores, sem atribuir o movimento a uma via específica de acesso."
)
LEAK_PATTERNS = (
    "schema editorial_fdg_",
    "editorial_fdg_",
    "solicitado pelo usuário",
    "solicitada pelo usuário",
    "desenvolvedor responsável",
    "nesta conversa digital",
    "nesta conversa",
    "api estruturada",
    "json compatível com o schema",
    "compatível com o schema",
    "instruções detalhadas de redação",
    "instruções do sistema",
    "prompt do sistema",
    "prompt do desenvolvedor",
)


class RepairError(RuntimeError):
    pass


def _assert_clean(value: Any, label: str) -> None:
    if isinstance(value, str):
        blob = value.casefold()
    else:
        blob = json.dumps(value, ensure_ascii=False, separators=(",", ":")).casefold()
    hit = next((pattern for pattern in LEAK_PATTERNS if pattern in blob), None)
    if hit:
        raise RepairError(f"{label} ainda contém vazamento interno: {hit}")


def _find_article(manifest: dict[str, Any]) -> dict[str, Any]:
    for article in manifest.get("artigos") or []:
        if article.get("id") == ARTICLE_ID or int(article.get("rodada") or 0) == 28:
            return article
    raise RepairError("artigo da Rodada 28 não encontrado no manifesto")


def _repair_manifest(manifest: dict[str, Any]) -> bool:
    article = _find_article(manifest)
    editorial = article.get("editorial")
    if not isinstance(editorial, dict):
        raise RepairError("editorial da Rodada 28 ausente no manifesto")

    changed = False
    found_target = False
    for section in editorial.get("secoes") or []:
        paragraphs = section.get("paragrafos") or []
        for idx, paragraph in enumerate(paragraphs):
            text = str(paragraph or "")
            if text.startswith("Santos, Vasco e São Paulo completaram o grupo de maiores altas."):
                found_target = True
                if text != CLEAN_PARAGRAPH:
                    paragraphs[idx] = CLEAN_PARAGRAPH
                    changed = True

    if not found_target:
        # Se já estiver corrigido por outra execução, o parágrafo deve existir em
        # algum lugar da estrutura; caso contrário, não arriscamos editar a matéria.
        blob = json.dumps(editorial, ensure_ascii=False)
        if CLEAN_PARAGRAPH not in blob:
            raise RepairError("parágrafo-alvo da Rodada 28 não foi localizado")

    if article.get("origem_editorial") != "editorial_curado:correcao-r28-v1":
        article["origem_editorial"] = "editorial_curado:correcao-r28-v1"
        changed = True

    _assert_clean(editorial, "manifesto R28")
    return changed


def _repair_html(text: str) -> tuple[str, bool]:
    pattern = re.compile(
        r"<p>\s*Santos, Vasco e São Paulo completaram o grupo de maiores altas\..*?</p>",
        flags=re.S,
    )
    replacement = f"<p>{CLEAN_PARAGRAPH}</p>"
    new_text, count = pattern.subn(replacement, text, count=1)
    if count == 0:
        if CLEAN_PARAGRAPH not in text:
            raise RepairError("parágrafo-alvo não encontrado no HTML da R28")
        new_text = text
    _assert_clean(new_text, "HTML R28")
    return new_text, new_text != text


def repair(root: Path) -> bool:
    manifest_path = root / "dados-br" / "analises.json"
    article_path = root / "analises" / ARTICLE_SLUG
    if not manifest_path.exists() or not article_path.exists():
        raise RepairError("manifesto ou HTML da Rodada 28 ausente")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    html = article_path.read_text(encoding="utf-8")

    manifest_changed = _repair_manifest(manifest)
    new_html, html_changed = _repair_html(html)

    if manifest_changed:
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if html_changed:
        article_path.write_text(new_html.rstrip() + "\n", encoding="utf-8")

    # Verificação pós-gravação, inclusive em execução idempotente.
    reread_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    reread_article = _find_article(reread_manifest)
    _assert_clean(reread_article.get("editorial") or {}, "manifesto R28 pós-gravação")
    _assert_clean(article_path.read_text(encoding="utf-8"), "HTML R28 pós-gravação")
    if CLEAN_PARAGRAPH not in json.dumps(reread_article.get("editorial") or {}, ensure_ascii=False):
        raise RepairError("parágrafo corrigido não persistiu no manifesto")
    if CLEAN_PARAGRAPH not in article_path.read_text(encoding="utf-8"):
        raise RepairError("parágrafo corrigido não persistiu no HTML")

    return manifest_changed or html_changed


def self_test() -> int:
    contaminated = (
        "Santos, Vasco e São Paulo completaram o grupo de maiores altas. O Santos venceu o Remo por 2 a 1. "
        "Esses percentuais representam a chance total conforme solicitado pelo usuário nesta conversa digital via API estruturada "
        "em JSON compatível com o schema editorial_fdg_brasileirao requerido pelo sistema e pelo desenvolvedor responsável."
    )
    manifest = {
        "schema_version": 2,
        "artigos": [
            {
                "id": ARTICLE_ID,
                "rodada": 28,
                "slug": ARTICLE_SLUG,
                "origem_editorial": "openai:gpt-5.6-sol:editorial-dedicado-v4",
                "editorial": {
                    "titulo": "Rodada 28: teste",
                    "linha_fina": "Teste.",
                    "secoes": [
                        {"titulo": "Cruzeiro e Fluminense avançam na corrida continental", "paragrafos": [contaminated]}
                    ],
                },
            }
        ],
    }
    html = f"<html><body><section><p>{contaminated}</p></section></body></html>\n"
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "dados-br").mkdir()
        (root / "analises").mkdir()
        (root / "dados-br" / "analises.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        (root / "analises" / ARTICLE_SLUG).write_text(html, encoding="utf-8")
        assert repair(root) is True
        assert repair(root) is False
        fixed_manifest = json.loads((root / "dados-br" / "analises.json").read_text(encoding="utf-8"))
        fixed_article = _find_article(fixed_manifest)
        assert fixed_article["origem_editorial"] == "editorial_curado:correcao-r28-v1"
        assert CLEAN_PARAGRAPH in json.dumps(fixed_article["editorial"], ensure_ascii=False)
        fixed_html = (root / "analises" / ARTICLE_SLUG).read_text(encoding="utf-8")
        assert CLEAN_PARAGRAPH in fixed_html
        _assert_clean(fixed_html, "self-test HTML")
    print("OK self-test: hotfix R28 remove vazamento, preserva conteúdo e é idempotente.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    try:
        changed = repair(args.root.resolve())
    except (RepairError, OSError, json.JSONDecodeError) as exc:
        print(f"ERRO: {exc}", file=sys.stderr)
        return 1
    print("R28 corrigida." if changed else "R28 já estava corrigida; nenhuma alteração necessária.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
