#!/usr/bin/env python3
"""Detecta alteração publicável ignorando metadados voláteis em JSON.

Usado pelos workflows para impedir commit/deploy quando a execução só altera
carimbos de tempo, contadores operacionais ou auditorias sem conteúdo factual novo.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any

VOLATILE_KEYS = {
    "atualizado_em", "atualizado_em_br", "gerado_em", "gerado_em_br", "updated_at", "created_at",
    "consultado_em", "verificado_em", "executado_em", "capturado_em", "processado_em", "timestamp",
    "ultima_atualizacao", "ultima_execucao", "last_run_at", "last_checked_at", "checked_at",
}


def normalize(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: normalize(v) for k, v in sorted(value.items()) if str(k).lower() not in VOLATILE_KEYS}
    if isinstance(value, list):
        return [normalize(v) for v in value]
    return value


def material_equal(path: str, old: bytes, new: bytes) -> bool:
    if path.lower().endswith(".json"):
        try:
            a = normalize(json.loads(old.decode("utf-8")))
            b = normalize(json.loads(new.decode("utf-8")))
            return a == b
        except Exception:
            pass
    return old == new


def git(*args: str, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(["git", *args], check=check, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def candidate_files(paths: list[str]) -> list[str]:
    changed = git("diff", "--name-only", "HEAD", "--", *paths).stdout.decode().splitlines()
    untracked = git("ls-files", "--others", "--exclude-standard", "--", *paths).stdout.decode().splitlines()
    return sorted(set(x.strip() for x in [*changed, *untracked] if x.strip()))


def detect(paths: list[str]) -> list[str]:
    material: list[str] = []
    for rel in candidate_files(paths):
        current = Path(rel)
        if not current.exists():
            material.append(rel)
            continue
        new = current.read_bytes()
        old_run = git("show", f"HEAD:{rel}", check=False)
        if old_run.returncode != 0:
            material.append(rel)
            continue
        if not material_equal(rel, old_run.stdout, new):
            material.append(rel)
    return material


def self_test() -> None:
    old = json.dumps({"atualizado_em": "a", "x": 1, "nested": {"gerado_em": "x", "y": [1, 2]}}).encode()
    new = json.dumps({"atualizado_em": "b", "x": 1, "nested": {"gerado_em": "z", "y": [1, 2]}}).encode()
    assert material_equal("a.json", old, new)
    changed = json.dumps({"atualizado_em": "b", "x": 2, "nested": {"gerado_em": "z", "y": [1, 2]}}).encode()
    assert not material_equal("a.json", old, changed)
    assert material_equal("a.txt", b"same", b"same")
    assert not material_equal("a.txt", b"same", b"different")
    print("SELF-TEST OK: detector ignora apenas metadados voláteis em JSON.")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--paths", nargs="+", default=[])
    parser.add_argument("--github-output", default="")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    if not args.paths:
        parser.error("--paths exige ao menos um caminho")
    files = detect(args.paths)
    changed = bool(files)
    print("MATERIAL_CHANGE=" + ("true" if changed else "false"))
    if files:
        print("Arquivos materiais:")
        for f in files:
            print(f"- {f}")
    else:
        print("Nenhuma mudança material; timestamps/metadados isolados não publicam.")
    if args.github_output:
        with open(args.github_output, "a", encoding="utf-8") as fh:
            fh.write(f"changed={'true' if changed else 'false'}\n")
            fh.write("files=" + ",".join(files) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
