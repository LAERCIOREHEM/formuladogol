#!/usr/bin/env python3
"""Compila os blocos ``python - <<'PY'`` dos workflows antes da coleta pesada."""
from __future__ import annotations

import argparse
import re
import textwrap
from pathlib import Path

START_RE = re.compile(r"^\s*python(?:3)?\s+-\s+<<-?['\"]?PY['\"]?\s*$")
END_RE = re.compile(r"^\s*PY\s*$")


def extract_blocks(text: str) -> list[tuple[int, str]]:
    lines = text.splitlines()
    blocks: list[tuple[int, str]] = []
    index = 0
    while index < len(lines):
        if not START_RE.match(lines[index]):
            index += 1
            continue
        start_line = index + 2
        index += 1
        content: list[str] = []
        while index < len(lines) and not END_RE.match(lines[index]):
            content.append(lines[index])
            index += 1
        if index >= len(lines):
            raise SyntaxError(f"heredoc Python iniciado na linha {start_line - 1} sem terminador PY")
        blocks.append((start_line, textwrap.dedent("\n".join(content)) + "\n"))
        index += 1
    return blocks


def validate(path: Path) -> int:
    blocks = extract_blocks(path.read_text(encoding="utf-8"))
    if not blocks:
        raise ValueError(f"{path}: nenhum bloco Python embutido encontrado")
    for number, (line, source) in enumerate(blocks, start=1):
        compile(source, f"{path}:bloco-{number}:linha-{line}", "exec")
    return len(blocks)


def self_test() -> None:
    valid = """run: |\n  python - <<'PY'\n  for item in [1]:\n      print(item)\n  PY\n"""
    blocks = extract_blocks(valid)
    assert len(blocks) == 1
    compile(blocks[0][1], "self-test-valid", "exec")
    invalid = """run: |\n  python - <<'PY'\n  for item in [1]:\n  print(item)\n  PY\n"""
    try:
        compile(extract_blocks(invalid)[0][1], "self-test-invalid", "exec")
    except IndentationError:
        pass
    else:
        raise AssertionError("o validador não detectou a indentação inválida")
    print("Self-test dos blocos Python embutidos: OK")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("workflow", nargs="?", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    if args.workflow is None:
        parser.error("informe o arquivo de workflow")
    total = validate(args.workflow)
    print(f"Blocos Python embutidos compilados: {total} OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
