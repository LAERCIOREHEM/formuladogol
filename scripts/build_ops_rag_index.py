#!/usr/bin/env python3
"""Build the FDG operational RAG index from the canonical operations corpus.

R10R17 deliberately keeps retrieval deterministic and outside the sporting
critical path. The index contains operational contracts, runbooks and incident
records only; it never indexes live sporting facts as an authority source.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import re
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs/operations/RAG-MANIFEST.json"
DEFAULT_OUTPUT = ROOT / "dados-br/ops-rag-index.json"
MAX_CHARS = 1400
MIN_CHARS = 120


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", text).strip().lower()


def tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9][a-z0-9._:-]{1,}", norm(text))


def expand_collections(patterns: list[str]) -> list[Path]:
    found: set[Path] = set()
    for pattern in patterns:
        for raw in glob.glob(str(ROOT / pattern), recursive=True):
            p = Path(raw)
            if p.is_file() and p.suffix.lower() in {".md", ".txt", ".json"}:
                found.add(p.resolve())
    return sorted(found, key=lambda p: p.relative_to(ROOT).as_posix())


def split_markdown(text: str) -> list[tuple[str, str]]:
    sections: list[tuple[str, str]] = []
    heading = "Documento"
    buf: list[str] = []

    def flush() -> None:
        nonlocal buf
        body = "\n".join(buf).strip()
        if body:
            sections.append((heading, body))
        buf = []

    for line in text.splitlines():
        m = re.match(r"^#{1,6}\s+(.+?)\s*$", line)
        if m:
            flush()
            heading = m.group(1).strip()
        else:
            buf.append(line)
    flush()
    return sections or [("Documento", text.strip())]


def chunk_section(heading: str, body: str) -> list[tuple[str, str]]:
    paras = [re.sub(r"\s+", " ", p).strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
    if not paras:
        paras = [re.sub(r"\s+", " ", body).strip()]
    out: list[tuple[str, str]] = []
    current = ""
    for para in paras:
        if len(para) > MAX_CHARS:
            pieces = [para[i:i+MAX_CHARS] for i in range(0, len(para), MAX_CHARS)]
        else:
            pieces = [para]
        for piece in pieces:
            candidate = f"{current}\n\n{piece}".strip() if current else piece
            if current and len(candidate) > MAX_CHARS:
                out.append((heading, current))
                current = piece
            else:
                current = candidate
    if current:
        out.append((heading, current))
    return out


def build() -> dict:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    patterns = manifest.get("collections") or []
    paths = expand_collections(patterns)
    if not paths:
        raise SystemExit("RAG corpus vazio: nenhuma collection resolveu arquivos.")

    chunks: list[dict] = []
    source_hasher = hashlib.sha256()
    for path in paths:
        rel = path.relative_to(ROOT).as_posix()
        raw = path.read_text(encoding="utf-8")
        source_hasher.update(rel.encode())
        source_hasher.update(b"\0")
        source_hasher.update(raw.encode())
        source_hasher.update(b"\0")
        section_pairs = split_markdown(raw) if path.suffix.lower() == ".md" else [(path.name, raw)]
        seq = 0
        for heading, body in section_pairs:
            for h, piece in chunk_section(heading, body):
                clean = piece.strip()
                if len(clean) < MIN_CHARS and chunks and chunks[-1]["path"] == rel:
                    chunks[-1]["text"] = (chunks[-1]["text"] + "\n\n" + clean).strip()
                    chunks[-1]["token_count"] = len(tokens(chunks[-1]["text"]))
                    continue
                seq += 1
                cid = hashlib.sha256(f"{rel}\n{h}\n{seq}\n{clean}".encode()).hexdigest()[:16]
                chunks.append({
                    "id": cid,
                    "path": rel,
                    "heading": h,
                    "scope": "incidents" if "/incidents/" in f"/{rel}" else "runbooks" if "/runbooks/" in f"/{rel}" else "operations",
                    "text": clean,
                    "token_count": len(tokens(clean)),
                })

    corpus_token_count = sum(c["token_count"] for c in chunks)
    source_sha = source_hasher.hexdigest()
    return {
        "schema_version": 1,
        "runtime": "fdg-ops-rag",
        "runtime_version": 1,
        "retrieval": "deterministic_bm25_lexical",
        "authority": "diagnosis_and_context_only",
        "source_sha256": source_sha,
        "source_count": len(paths),
        "chunk_count": len(chunks),
        "token_count": corpus_token_count,
        "sources": [p.relative_to(ROOT).as_posix() for p in paths],
        "chunks": chunks,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", default=str(DEFAULT_OUTPUT))
    ap.add_argument("--check", action="store_true", help="validate an existing index against the corpus")
    args = ap.parse_args()
    output = Path(args.output)
    if not output.is_absolute():
        output = ROOT / output
    data = build()
    if args.check:
        if not output.exists():
            raise SystemExit(f"RAG index ausente: {output}")
        existing = json.loads(output.read_text(encoding="utf-8"))
        keys = ("schema_version", "runtime", "runtime_version", "retrieval", "authority", "source_sha256", "source_count", "chunk_count", "token_count", "sources", "chunks")
        if any(existing.get(k) != data.get(k) for k in keys):
            raise SystemExit("RAG index diverge do corpus canônico; regenere com build_ops_rag_index.py")
        print(f"OPS RAG INDEX OK: {data['source_count']} fontes · {data['chunk_count']} chunks · sha={data['source_sha256'][:12]}")
        return 0
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"OPS RAG INDEX: {output.relative_to(ROOT) if output.is_relative_to(ROOT) else output} · {data['source_count']} fontes · {data['chunk_count']} chunks · sha={data['source_sha256'][:12]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
