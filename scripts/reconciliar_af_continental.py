#!/usr/bin/env python3
"""Garante que o AF publicado corresponda exatamente ao estado esportivo atual.

Este orquestrador elimina o estado intermediário "snapshots novos + AF antigo".
Quando o workflow já validou a coleta continental, qualquer divergência entre
os hashes obriga um novo cálculo. O gerador pode preservar o último AF em
falhas transitórias; aqui isso é detectado e uma segunda tentativa é feita sem
a trava temporal redundante, mas somente depois de validar o hash da auditoria
e a estrutura simulável dos três snapshots.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
SCRIPTS = ROOT / "scripts"

from scripts.af_previsao_continental import (  # noqa: E402
    ContinentalDataNotReady,
    validate_competition_snapshot_structure,
)
from scripts.gerar_probabilidades_brasileirao import (  # noqa: E402
    CONTINENTAL_AUDIT_PATH,
    OUTPUT_PATH,
    continental_snapshots_state_hash,
    current_publication_freshness,
    load_continental_snapshots,
)


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_outputs(values: dict[str, Any]) -> None:
    output = str(os.environ.get("GITHUB_OUTPUT") or "").strip()
    if not output:
        return
    with Path(output).open("a", encoding="utf-8", newline="\n") as handle:
        for key, value in values.items():
            safe = str(value).replace("\r", " ").replace("\n", " ")
            handle.write(f"{key}={safe}\n")


def validate_continental_transaction() -> tuple[dict[str, dict[str, Any]], str]:
    snapshots = load_continental_snapshots()
    expected = {"copa_do_brasil", "libertadores", "sul_americana"}
    if set(snapshots) != expected:
        raise RuntimeError(
            "snapshots continentais incompletos: "
            f"esperado={sorted(expected)} atual={sorted(snapshots)}"
        )

    for key in sorted(expected):
        snapshot = snapshots[key]
        if int(snapshot.get("schema_version") or 0) < 2 or snapshot.get("status") != "ok":
            raise RuntimeError(f"{key}: snapshot inválido para o AF")
        try:
            structural = validate_competition_snapshot_structure(snapshot)
        except ContinentalDataNotReady as exc:
            raise RuntimeError(f"{key}: snapshot não simulável: {exc}") from exc
        print(
            f"Preflight {key}: fase={structural.get('fase')} "
            f"chaves={structural.get('chaves')} ativos={structural.get('equipes_ativas')}"
        )

    current_hash = continental_snapshots_state_hash(snapshots)
    audit = load_json(CONTINENTAL_AUDIT_PATH)
    if int(audit.get("schema_version") or 0) < 2:
        raise RuntimeError("auditoria continental em schema antigo")
    if audit.get("status") != "ok" or audit.get("coleta_confiavel") is not True:
        raise RuntimeError("auditoria continental não confirmou uma coleta confiável")
    audit_hash = str(audit.get("hash_estado_depois") or "")
    if audit_hash != current_hash:
        raise RuntimeError(
            "hash da auditoria continental diverge dos snapshots atuais: "
            f"auditoria={audit_hash} snapshots={current_hash}"
        )
    return snapshots, current_hash


def published_continental_hash() -> str:
    if not OUTPUT_PATH.exists():
        return ""
    published = load_json(OUTPUT_PATH)
    return str((published.get("integracao_continental") or {}).get("hash_snapshots") or "")


def run_generator(simulations: int | None) -> None:
    # A validade da coleta foi provada imediatamente antes pelo hash da auditoria
    # e pelo preflight estrutural. A trava temporal do gerador é redundante aqui
    # e foi a fonte de preservações silenciosas do AF antigo em execuções longas.
    env = dict(os.environ)
    env.pop("AF_EXIGIR_COLETA_CONTINENTAL_ATUAL", None)

    subprocess.run(
        [sys.executable, str(SCRIPTS / "gerar_probabilidades_jogos.py")],
        cwd=ROOT,
        env=env,
        check=True,
    )
    command = [sys.executable, str(SCRIPTS / "gerar_probabilidades_brasileirao.py")]
    if simulations is not None:
        command.extend(["--simulacoes", str(simulations)])
    subprocess.run(command, cwd=ROOT, env=env, check=True)


def verify_consistency(expected_continental_hash: str) -> dict[str, Any]:
    freshness = current_publication_freshness()
    published_hash = published_continental_hash()
    reasons = list(freshness.get("motivos") or [])
    if published_hash != expected_continental_hash:
        reasons.append(
            "hash continental publicado continua divergente "
            f"(af={published_hash} atual={expected_continental_hash})"
        )
    return {
        "ok": bool(freshness.get("atualizado")) and not reasons,
        "freshness": freshness,
        "published_hash": published_hash,
        "reasons": reasons,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="refaz o AF mesmo se já estiver vigente")
    parser.add_argument("--simulacoes", type=int, default=None, help="somente para teste controlado")
    parser.add_argument("--max-attempts", type=int, default=2)
    args = parser.parse_args()

    _, current_hash = validate_continental_transaction()
    before = published_continental_hash()
    freshness_before = current_publication_freshness()
    if not freshness_before.get("estado_pronto"):
        raise RuntimeError(
            "base do Brasileirão não está pronta para recálculo: "
            + "; ".join(freshness_before.get("motivos") or ["motivo não informado"])
        )

    needs = args.force or before != current_hash or not freshness_before.get("atualizado")
    if not needs:
        print(f"AF já consistente com o estado atual: continental={current_hash}")
        write_outputs(
            {
                "af_updated": "false",
                "af_consistent": "true",
                "af_hash_continental": current_hash,
                "af_reason": "já vigente",
            }
        )
        return 0

    max_attempts = max(1, int(args.max_attempts))
    last_reasons: list[str] = []
    for attempt in range(1, max_attempts + 1):
        print(
            f"Recalculando AF — tentativa {attempt}/{max_attempts}; "
            f"continental publicado={before or 'ausente'} atual={current_hash}"
        )
        run_generator(args.simulacoes)
        check = verify_consistency(current_hash)
        if check["ok"]:
            print(
                "AF reconciliado com sucesso: "
                f"continental={current_hash}; hash_entrada={check['freshness'].get('hash_publicado')}"
            )
            write_outputs(
                {
                    "af_updated": "true",
                    "af_consistent": "true",
                    "af_hash_continental": current_hash,
                    "af_reason": "recalculado e validado",
                }
            )
            return 0
        last_reasons = [str(item) for item in check["reasons"]]
        print("::warning::AF ainda divergente após a tentativa: " + "; ".join(last_reasons))

    write_outputs(
        {
            "af_updated": "false",
            "af_consistent": "false",
            "af_hash_continental": current_hash,
            "af_reason": "; ".join(last_reasons) or "divergência não resolvida",
        }
    )
    raise RuntimeError(
        "não foi possível reconciliar o AF após tentativas controladas: "
        + "; ".join(last_reasons or ["motivo não informado"])
    )


if __name__ == "__main__":
    raise SystemExit(main())
