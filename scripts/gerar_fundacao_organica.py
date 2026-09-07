#!/usr/bin/env python3
"""ORG-1: fundação orgânica do Fórmula do Gol.

Opera SOMENTE sobre o diretório público de build (normalmente _site):
- habilita preview grande de imagem em páginas indexáveis;
- pré-renderiza conteúdo útil do hub de Clubes;
- pré-renderiza um snapshot textual da página Ao vivo;
- pré-renderiza uma amostra útil da Agenda standalone;
- valida que o HTML resultante continua consistente.

Não altera dados esportivos, cálculos, JavaScript funcional ou páginas privadas.
"""
from __future__ import annotations

import argparse
import html
import json
import re
from pathlib import Path
from typing import Any
from datetime import datetime

MAX_IMAGE_TOKEN = "max-image-preview:large"
ORG1_MARK = "data-fdg-org1"


def load_json(root: Path, rel: str) -> Any:
    p = root / rel
    if not p.is_file():
        raise SystemExit(f"ORG-1: arquivo obrigatório ausente: {rel}")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception as exc:
        raise SystemExit(f"ORG-1: JSON inválido em {rel}: {exc}") from exc


def slugify(value: str) -> str:
    import unicodedata
    text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text


def esc(value: Any) -> str:
    return html.escape(str(value if value is not None else ""), quote=True)


def pct_display(item: dict[str, Any], key: str) -> str:
    det = (item.get("probabilidades_detalhes") or {}).get(key) or {}
    if det.get("exibicao"):
        return str(det["exibicao"])
    raw = (item.get("probabilidades_pct") or {}).get(key)
    if raw is None:
        return "—"
    return f"{float(raw):.1f}%".replace(".", ",")


def ensure_max_image_preview(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    m = re.search(r'<meta\s+name=["\']robots["\']\s+content=["\']([^"\']*)["\'][^>]*>', text, flags=re.I)
    if m:
        content = m.group(1)
        if "noindex" in content.lower() or MAX_IMAGE_TOKEN in content.lower():
            return False
        new_content = content.rstrip(" ,") + "," + MAX_IMAGE_TOKEN
        text = text[:m.start(1)] + new_content + text[m.end(1):]
    else:
        marker = re.search(r'<meta\s+name=["\']viewport["\'][^>]*>', text, flags=re.I)
        if not marker:
            return False
        insertion = f'\n  <meta name="robots" content="index,follow,{MAX_IMAGE_TOKEN}">'
        text = text[:marker.end()] + insertion + text[marker.end():]
    path.write_text(text, encoding="utf-8")
    return True


def public_indexable_html(root: Path):
    excluded_parts = {"bolao", "aniversariantes"}
    excluded_names = {"apostas.html", "regras.html", "alertas.html", "privacidade.html", "pwa-teste.html"}
    for path in sorted(root.rglob("*.html")):
        rel = path.relative_to(root)
        if any(part in excluded_parts for part in rel.parts):
            continue
        if rel.name in excluded_names:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        robots = re.search(r'<meta\s+name=["\']robots["\']\s+content=["\']([^"\']*)', text, flags=re.I)
        if robots and "noindex" in robots.group(1).lower():
            continue
        # páginas administrativas/palpites da Copa não entram no programa orgânico
        if rel.parts and rel.parts[0] == "copa2026" and rel.name in {"admin.html", "palpite.html", "palpites.html", "pontos.html", "regras.html"}:
            continue
        yield path


def prerender_clubes(root: Path) -> None:
    path = root / "clubes.html"
    text = path.read_text(encoding="utf-8")
    clubes = (load_json(root, "dados-br/clubes.json").get("clubes") or [])
    tabela = {x.get("time"): x for x in (load_json(root, "tabela.json").get("tabela") or [])}
    ranking = {x.get("time"): x for x in (load_json(root, "dados-br/ranking-desempenho.json").get("ranking") or [])}
    probs = {x.get("clube"): x for x in (load_json(root, "dados-br/probabilidades-brasileirao.json").get("clubes") or [])}
    if len(clubes) != 20:
        raise SystemExit(f"ORG-1: esperado 20 clubes, encontrado {len(clubes)}")

    cards = []
    for c in sorted(clubes, key=lambda x: str(x.get("nome") or "")):
        nome = str(c.get("nome") or "")
        t, r, p = tabela.get(nome, {}), ranking.get(nome, {}), probs.get(nome, {})
        slug = slugify(nome)
        escudo = c.get("escudo") or ""
        pos_proj = p.get("posicao_classificacao_projetada") or p.get("posicao_projetada") or "—"
        pts_proj = (p.get("pontos_projetados") or {}).get("media") or "—"
        cards.append(f'''<article class="club-card seo-prerender-club" data-clube="{esc(nome)}" {ORG1_MARK}="club-card">
          <a href="clubes.html#{esc(slug)}" aria-label="Ver dados de {esc(nome)}" style="color:inherit;text-decoration:none;display:block;position:relative;z-index:1">
            <div class="club-head">
              <img class="club-logo" src="{esc(escudo)}" alt="Escudo do {esc(nome)}" loading="lazy">
              <div><div class="club-name">{esc(nome)}</div><div class="club-sub">{esc(c.get('cidade') or '')}-{esc(c.get('uf') or '')} · {esc(c.get('apelido') or '')}</div></div>
            </div>
            <p>{esc(c.get('curiosidade') or c.get('momento') or '')}</p>
            <div class="club-kpis">
              <div class="kpi"><strong>{esc(t.get('pos') or '—')}º</strong><span>posição</span></div>
              <div class="kpi"><strong>{esc(t.get('pontos') if t.get('pontos') is not None else '—')}</strong><span>pontos</span></div>
              <div class="kpi"><strong>{esc(r.get('pos') or '—')}º</strong><span>AF-Score</span></div>
            </div>
            <p><strong>Projeção:</strong> {esc(pos_proj)}º · {esc(pts_proj)} pts · <strong>Título:</strong> {esc(pct_display(p, 'campeao'))}</p>
          </a>
        </article>''')
    payload = "\n".join(cards)
    pattern = r'(<section\s+class="grid-clubes"\s+id="grid-clubes"\s+aria-live="polite">)(.*?)(</section>)'
    new, count = re.subn(pattern, lambda m: m.group(1) + "\n" + payload + "\n" + m.group(3), text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit("ORG-1: container #grid-clubes não localizado")
    path.write_text(new, encoding="utf-8")


def prerender_live(root: Path) -> None:
    path = root / "aovivo.html"
    text = path.read_text(encoding="utf-8")
    jogos = load_json(root, "jogos.json").get("jogos") or []
    ativos = [j for j in jogos if str(j.get("estado") or "").lower() in {"in", "live"}]
    finalizados = [j for j in jogos if str(j.get("estado") or "").lower() == "post"][:3]
    escolhidos = ativos or finalizados
    rows = []
    for j in escolhidos[:6]:
        man = (j.get("mandante") or {}).get("nome") or "Mandante"
        vis = (j.get("visitante") or {}).get("nome") or "Visitante"
        pm = j.get("placar_mandante", 0)
        pv = j.get("placar_visitante", 0)
        status = j.get("status") or ("Ao vivo" if j in ativos else "Final")
        rows.append(f"<li><strong>{esc(man)} {esc(pm)} × {esc(pv)} {esc(vis)}</strong> · {esc(status)}</li>")
    lista = "".join(rows) if rows else "<li>Nenhuma partida do Brasileirão ao vivo neste snapshot.</li>"
    fallback = f'''<div class="live-loading panel" {ORG1_MARK}="live-snapshot"><div class="panel-inner">
      <h1 style="margin:0 0 10px">Futebol ao vivo — clubes do Brasileirão 2026</h1>
      <p>Placar e acompanhamento das partidas dos clubes da Série A. O painel interativo assume esta área assim que os dados ao vivo carregam.</p>
      <ul>{lista}</ul>
    </div></div>'''
    pattern = r'(<section\s+id="live-app"[^>]*>)(.*?)(</section>)'
    new, count = re.subn(pattern, lambda m: m.group(1) + "\n" + fallback + "\n" + m.group(3), text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit("ORG-1: container #live-app não localizado")
    path.write_text(new, encoding="utf-8")


def prerender_agenda(root: Path) -> None:
    path = root / "agenda.html"
    text = path.read_text(encoding="utf-8")
    dados = load_json(root, "dados-br/agenda-clubes-br.json")
    jogos = dados.get("jogos") or []
    futuros = [j for j in jogos if not j.get("concluido")][:12]
    rows = []
    for j in futuros:
        man = (j.get("mandante") or {}).get("nome") or "Mandante"
        vis = (j.get("visitante") or {}).get("nome") or "Visitante"
        bruto_data = str(j.get("data_iso") or "")
        try:
            dt = datetime.fromisoformat(bruto_data.replace("Z", "+00:00"))
            data = f"{dt.day:02d}/{dt.month:02d} · {dt.hour:02d}h{dt.minute:02d}"
        except ValueError:
            data = bruto_data[:16].replace("T", " ")
        comp = j.get("competicao_nome_curto") or j.get("competicao_nome") or "Futebol"
        rows.append(f"<li><strong>{esc(man)} × {esc(vis)}</strong> · {esc(comp)} · {esc(data)}</li>")
    fallback = f'''<div class="panel" {ORG1_MARK}="agenda-snapshot"><div class="panel-inner">
      <h1 style="margin:0 0 10px">Jogos dos clubes do Brasileirão 2026</h1>
      <p>Agenda dos clubes da Série A no Brasileirão, Copa do Brasil, Libertadores e Sul-Americana.</p>
      <ul>{''.join(rows) if rows else '<li>Agenda em atualização.</li>'}</ul>
    </div></div>'''
    pattern = r'(<section\s+id="agenda-app"[^>]*>)(.*?)(</section>)'
    new, count = re.subn(pattern, lambda m: m.group(1) + "\n" + fallback + "\n" + m.group(3), text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit("ORG-1: container #agenda-app não localizado")
    path.write_text(new, encoding="utf-8")


def validate(root: Path) -> None:
    # 1) Meta robots de páginas indexáveis.
    checked = 0
    for path in public_indexable_html(root):
        text = path.read_text(encoding="utf-8")
        m = re.search(r'<meta\s+name=["\']robots["\']\s+content=["\']([^"\']*)', text, flags=re.I)
        if not m or MAX_IMAGE_TOKEN not in m.group(1).lower():
            raise SystemExit(f"ORG-1: max-image-preview ausente em {path.relative_to(root)}")
        checked += 1

    # 2) Hub de clubes realmente pré-renderizado e coerente com as fontes.
    clubes_html = (root / "clubes.html").read_text(encoding="utf-8")
    cards = clubes_html.count(f'{ORG1_MARK}="club-card"')
    if cards != 20:
        raise SystemExit(f"ORG-1: pré-render de clubes divergente: {cards}/20")
    for c in load_json(root, "dados-br/clubes.json").get("clubes") or []:
        if f'data-clube="{esc(c.get("nome") or "")}"' not in clubes_html:
            raise SystemExit(f"ORG-1: clube ausente no HTML pré-renderizado: {c.get('nome')}")

    # 3) Snapshots de conteúdo dinâmico presentes.
    live = (root / "aovivo.html").read_text(encoding="utf-8")
    agenda = (root / "agenda.html").read_text(encoding="utf-8")
    if f'{ORG1_MARK}="live-snapshot"' not in live or "<h1" not in live:
        raise SystemExit("ORG-1: snapshot ao vivo ausente")
    if f'{ORG1_MARK}="agenda-snapshot"' not in agenda or "<h1" not in agenda:
        raise SystemExit("ORG-1: snapshot da agenda ausente")

    # 4) Guardas de segurança: páginas privadas continuam noindex.
    for rel in ("alertas.html", "privacidade.html", "jogos/index.html", "tabela/index.html", "resultados/index.html"):
        p = root / rel
        if not p.is_file():
            continue
        text = p.read_text(encoding="utf-8").lower()
        if 'name="robots"' not in text or "noindex" not in text:
            raise SystemExit(f"ORG-1: guarda noindex perdida em {rel}")

    print(f"ORG-1 VALIDATION PASS: {checked} páginas indexáveis com preview grande; 20 clubes pré-renderizados; agenda/live com fallback útil")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site-root", default="_site")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    root = Path(args.site_root).resolve()
    if not root.is_dir():
        raise SystemExit(f"ORG-1: diretório público inexistente: {root}")

    changed = 0
    for path in public_indexable_html(root):
        changed += int(ensure_max_image_preview(path))
    prerender_clubes(root)
    prerender_live(root)
    prerender_agenda(root)
    print(f"ORG-1: meta preview atualizada em {changed} página(s)")
    if args.check:
        validate(root)


if __name__ == "__main__":
    main()
