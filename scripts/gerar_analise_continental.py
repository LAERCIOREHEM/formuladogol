#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import sys
import unicodedata
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Mapping, Sequence

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))
from gerar_analise_rodada import (
    SITE,
    CAMINHO_ANALISES,
    cabecalho_html,
    menu,
    rodape,
    submenu_rodadas,
    sincronizar_submenus_artigos,
    gerar_hub,
    gerar_feed,
    gerar_news_sitemap,
    atualizar_sitemap,
    gravar_texto,
    agora_br,
    data_curta,
)
from editorial_ia import EditorialAIError, generate_editorial


SNAPS = {
    'libertadores': ROOT / 'dados-br/competicoes-af-previsao/libertadores.json',
    'sul_americana': ROOT / 'dados-br/competicoes-af-previsao/sul-americana.json',
}
MM_PATH = ROOT / 'dados-br/melhores-momentos-continentais.json'
MM_VERIFIED_PATH = ROOT / 'dados-br/correcoes/melhores-momentos-continentais-verificados.json'
EDITORIAL_CONTEXT_PATH = ROOT / 'dados-br/correcoes/contexto-editorial-continentais-2026.json'
MANIFEST = ROOT / 'dados-br/analises.json'
PROB_PATH = ROOT / 'dados-br/probabilidades-brasileirao.json'
GLOBAL_HISTORY_PATH = ROOT / 'dados-br/historico-probabilidades.json'
CONT_HISTORY_PATH = ROOT / 'dados-br/historico-probabilidades-continentais.json'
PHASES = {
    600: ('Oitavas de final', 'oitavas', 'QF'),
    700: ('Quartas de final', 'quartas', 'SF'),
    800: ('Semifinal', 'semifinal', 'FINAL'),
    900: ('Final', 'final', 'CAMPEÃO'),
}
COMP_NAMES = {'libertadores': 'Libertadores', 'sul_americana': 'Sul-Americana'}
KNOWN_SHOOTOUTS = {
    '401874156': {'winner': 'Fluminense', 'winner_score': 5, 'loser_score': 4},
    '401874142': {'winner': 'Liga de Quito', 'winner_score': 5, 'loser_score': 4},
}
RENDER_VERSION = 10


class ContinentalEditorialError(RuntimeError):
    pass


class ContinentalEditorialVeto(ContinentalEditorialError):
    """A IA detectou incoerência factual no pacote já fechado deterministicamente."""


def load(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return default


def load_verified_mm() -> dict[str, Any]:
    """Combina coleta automática com vínculos verificados manualmente.

    O arquivo de correções vence apenas para os event_ids que contém. Isso
    impede que uma busca automática posterior substitua um vídeo já auditado.
    """
    base = load(MM_PATH, {'jogos': {}}) or {'jogos': {}}
    verified = load(MM_VERIFIED_PATH, {'jogos': {}}) or {'jogos': {}}
    merged = dict(base)
    merged_games = dict(base.get('jogos') or {})
    for event_id, video in (verified.get('jogos') or {}).items():
        if isinstance(video, Mapping):
            merged_games[str(event_id)] = dict(video)
    merged['jogos'] = merged_games
    merged['correcoes_verificadas'] = sorted(str(key) for key in (verified.get('jogos') or {}))
    return merged


def editorial_verified_context(rank: int) -> dict[str, Any]:
    data = load(EDITORIAL_CONTEXT_PATH, {}) or {}
    phases = data.get('fases') or {}
    item = phases.get(str(rank)) or phases.get(rank) or {}
    return dict(item) if isinstance(item, Mapping) else {}


def canon(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    ).hexdigest()


def mark_hash(mark: Mapping[str, Any]) -> str:
    return canon({key: value for key, value in mark.items() if key != 'hash_marco'})


def esc(value: Any) -> str:
    return html.escape(str(value or ''), quote=True)


def team_key(side: Mapping[str, Any]) -> str:
    return str(side.get('espn_id') or side.get('nome') or '')


def br(side: Mapping[str, Any]) -> bool:
    return bool(side.get('serie_a_2026'))


def nm(side: Mapping[str, Any]) -> str:
    return str(side.get('nome') or side.get('nome_espn') or '').strip()


def _event_dt(event: Mapping[str, Any]) -> datetime | None:
    try:
        value = str(event.get('data_iso') or '').strip()
        return datetime.fromisoformat(value) if value else None
    except Exception:
        return None


def effective_phase_rank(snapshot: Mapping[str, Any], event: Mapping[str, Any]) -> int:
    """Rank editorial robusto à promoção falsa da volta para ``Final``.

    A final de Libertadores/Sul-Americana é jogo único. Se uma partida marcada
    como perna 2 pertence ao mesmo confronto de uma perna 1 recente já
    identificada como oitavas/quartas/semi, a identidade do confronto prevalece
    sobre o rótulo isolado da ESPN. A função é somente uma visão editorial; o
    coletor também corrige o snapshot na origem.
    """
    raw_rank = int(event.get('fase_ordem') or 0)
    if int(event.get('perna') or 0) != 2:
        return raw_rank
    event_when = _event_dt(event)
    if event_when is None:
        return raw_rank
    key = tie_key(event)
    candidates: list[tuple[datetime, int]] = []
    for other in snapshot.get('eventos') or []:
        if other is event or tie_key(other) != key or int(other.get('perna') or 0) != 1:
            continue
        rank = int(other.get('fase_ordem') or 0)
        if rank not in {600, 700, 800}:
            continue
        when = _event_dt(other)
        if when is None or when >= event_when or event_when - when > timedelta(days=35):
            continue
        candidates.append((when, rank))
    if not candidates:
        return raw_rank
    return max(candidates, key=lambda item: item[0])[1]


def phase_events(snapshot: Mapping[str, Any], rank: int) -> list[dict[str, Any]]:
    return [
        e for e in snapshot.get('eventos') or []
        if effective_phase_rank(snapshot, e) == rank
        and (br(e.get('mandante') or {}) or br(e.get('visitante') or {}))
    ]


def ranks_with_brazilians(snaps: Mapping[str, Mapping[str, Any]]) -> list[int]:
    return sorted({
        effective_phase_rank(snapshot, e)
        for snapshot in snaps.values()
        for e in snapshot.get('eventos') or []
        if effective_phase_rank(snapshot, e) in PHASES
        and (br(e.get('mandante') or {}) or br(e.get('visitante') or {}))
    })


def tie_key(event: Mapping[str, Any]) -> tuple[str, str]:
    return tuple(sorted((team_key(event.get('mandante') or {}), team_key(event.get('visitante') or {}))))


def penalty_resolution(event: Mapping[str, Any]) -> tuple[str, dict[str, int] | None]:
    """Retorna o vencedor da disputa de pênaltis, nunca o vencedor do jogo."""
    raw = event.get('penaltis')
    scores: dict[str, int] | None = None
    if isinstance(raw, Mapping):
        try:
            home = int(raw.get('mandante')) if raw.get('mandante') is not None else None
            away = int(raw.get('visitante')) if raw.get('visitante') is not None else None
        except (TypeError, ValueError):
            home = away = None
        if home is not None and away is not None:
            scores = {'mandante': home, 'visitante': away}
    winner = str(event.get('vencedor_penaltis') or '').strip()
    if not winner and scores is not None:
        home_name = nm(event.get('mandante') or {})
        away_name = nm(event.get('visitante') or {})
        if scores['mandante'] > scores['visitante']:
            winner = home_name
        elif scores['visitante'] > scores['mandante']:
            winner = away_name
    # Compatibilidade histórica: somente overrides explicitamente auditados por
    # event_id podem preencher uma disputa antiga sem placar estruturado. Isto
    # não reabre a inferência perigosa por ``vencedor`` dos 90 minutos.
    if not winner:
        known = KNOWN_SHOOTOUTS.get(str(event.get('event_id') or ''))
        if known:
            winner = str(known.get('winner') or '').strip()
            home_name = nm(event.get('mandante') or {})
            ws, ls = int(known['winner_score']), int(known['loser_score'])
            scores = {
                'mandante': ws if home_name == winner else ls,
                'visitante': ls if home_name == winner else ws,
            }
    return winner, scores


def build_ties(comp: str, snapshot: Mapping[str, Any], rank: int) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for event in phase_events(snapshot, rank):
        groups.setdefault(tie_key(event), []).append(event)
    out: list[dict[str, Any]] = []
    for legs in groups.values():
        legs = sorted(legs, key=lambda e: (int(e.get('perna') or 0), str(e.get('data_iso') or '')))
        teams = {team_key(x): x for e in legs for x in (e.get('mandante') or {}, e.get('visitante') or {})}
        names = list(teams.values())
        if len(names) != 2:
            continue
        a, b = names[0], names[1]
        agg = {team_key(a): 0, team_key(b): 0}
        for event in legs:
            agg[team_key(event['mandante'])] += int((event['mandante'] or {}).get('placar') or 0)
            agg[team_key(event['visitante'])] += int((event['visitante'] or {}).get('placar') or 0)
        last = legs[-1]
        # O classificado de um mata-mata de ida e volta é definido pelo
        # AGREGADO, não pelo vencedor isolado da partida de volta. A ESPN
        # preenche ``vencedor`` como vencedor do jogo; em Fluminense x
        # Platense (quartas/2026), por exemplo, o Platense venceu a volta por
        # 2 a 1, mas o Fluminense avançou por 3 a 2 no agregado.
        winner = ''
        penalty_winner, penalty_scores = penalty_resolution(last)
        if len(legs) >= 2 and agg[team_key(a)] != agg[team_key(b)]:
            winner = nm(a) if agg[team_key(a)] > agg[team_key(b)] else nm(b)
        elif len(legs) >= 2 and bool(last.get('penaltis')):
            # Agregado empatado: somente o vencedor EXPLÍCITO da disputa pode
            # classificar alguém. ``last.vencedor`` representa os 90/120 min e
            # nunca é aceito como atalho (LDU 3x2 Palmeiras; Palmeiras 4x3 pen.).
            winner = penalty_winner
        elif len(legs) < 2:
            # Final em jogo único: se houver empate e pênaltis, usa a disputa;
            # caso contrário, o vencedor factual da partida.
            if int((last.get('mandante') or {}).get('placar') or 0) == int((last.get('visitante') or {}).get('placar') or 0) and bool(last.get('penaltis')):
                winner = penalty_winner
            else:
                winner = str(last.get('vencedor') or '').strip()
        loser = next((x for x in (nm(a), nm(b)) if winner and x != winner), '')
        brazilian = [nm(x) for x in (a, b) if br(x)]
        out.append({
            'competicao': comp,
            'fase_ordem': rank,
            'times': [nm(a), nm(b)],
            'team_objs': [a, b],
            'pernas': legs,
            'agregado': [agg[team_key(a)], agg[team_key(b)]],
            'vencedor': winner,
            'eliminado': loser,
            'brasileiros': brazilian,
            'br_classificados': [x for x in brazilian if x == winner],
            'penaltis': bool(last.get('penaltis')),
            'vencedor_penaltis': penalty_winner,
            'placar_penaltis': penalty_scores,
        })
    return sorted(out, key=lambda tie: (tie['competicao'], tie['times'][0], tie['times'][1]))


def phase_materialized_for_survivors(snaps: Mapping[str, Mapping[str, Any]], rank: int) -> bool:
    prev = rank - 100
    if prev not in PHASES:
        return True
    for comp, snapshot in snaps.items():
        current = phase_events(snapshot, rank)
        prev_ties = build_ties(comp, snapshot, prev)
        prev_br_winners = {winner for tie in prev_ties for winner in tie['br_classificados']}
        if not prev_br_winners:
            continue
        current_br_teams = {
            nm(side)
            for event in current
            for side in (event.get('mandante') or {}, event.get('visitante') or {})
            if br(side)
        }
        # A fase seguinte só está materializada quando TODOS os brasileiros que
        # sobreviveram à fase anterior já aparecem em algum confronto atual.
        # Isso evita baseline/publicação com uma semifinal parcialmente exposta.
        if not prev_br_winners.issubset(current_br_teams):
            return False
    return True


def rank_has_complete_two_leg_ties(snaps: Mapping[str, Mapping[str, Any]], rank: int) -> bool:
    """Exige ida+volta completas para fases eliminatórias em dois jogos.

    Esse guard evita que um rótulo degradado da ESPN (por exemplo, um jogo
    recém-finalizado aparecer como ``Final``) seja interpretado como uma fase
    inteira. Para oitavas/quartas/semifinais, todo confronto brasileiro precisa
    ter exatamente as duas pernas materializadas e concluídas antes do editorial.
    """
    if rank == 900:
        # As finais continentais são partida única e não pertencem a este guard.
        return True
    found = False
    for comp, snapshot in snaps.items():
        events = phase_events(snapshot, rank)
        if not events:
            continue
        found = True
        ties = build_ties(comp, snapshot, rank)
        if not ties:
            return False
        event_ids = {str(event.get('event_id') or '') for event in events}
        tie_event_ids = {
            str(event.get('event_id') or '')
            for tie in ties
            for event in tie.get('pernas') or []
        }
        if event_ids != tie_event_ids:
            return False
        for tie in ties:
            legs = list(tie.get('pernas') or [])
            leg_numbers = {int(event.get('perna') or 0) for event in legs}
            if len(legs) != 2 or leg_numbers != {1, 2}:
                return False
            if not all(bool(event.get('concluido')) for event in legs):
                return False
            # Uma chave empatada no agregado sem vencedor explícito da disputa
            # não está factualmente resolvida, ainda que a fonte marque FINAL.
            if not str(tie.get('vencedor') or '').strip() or not str(tie.get('eliminado') or '').strip():
                return False
    return found


def open_editorial_rank(history: Mapping[str, Any]) -> int | None:
    """Retorna a fase cujo marco ANTES existe, mas o marco DEPOIS ainda não.

    O marco anterior é criado após todas as idas. Ele passa a funcionar como
    âncora imutável da edição seguinte. Assim, uma classificação errada de um
    único evento não pode promover o editorial para semifinal/final enquanto a
    fase ancorada ainda estiver em disputa.
    """
    marks = {str((item or {}).get('id') or '') for item in history.get('marcos') or []}
    open_ranks: list[int] = []
    for rank in PHASES:
        before_id, after_id = mark_ids(rank)
        if before_id in marks and after_id not in marks:
            open_ranks.append(rank)
    return max(open_ranks) if open_ranks else None


def editorial_eligibility(
    snaps: Mapping[str, Mapping[str, Any]],
    history: Mapping[str, Any],
) -> dict[str, Any]:
    """Decide se o workflow deve fazer algo sem gerar/publicar conteúdo.

    A decisão é deliberadamente conservadora:
      * ``baseline``: todas as idas terminaram e falta preservar o marco antes;
      * ``publish``: a fase ancorada terminou integralmente para os brasileiros;
      * ``none``: ainda há partida pendente ou a estrutura ida/volta está incompleta.
    """
    anchored_rank = open_editorial_rank(history)
    if anchored_rank:
        events = [
            event
            for snapshot in snaps.values()
            for event in phase_events(snapshot, anchored_rank)
        ]
        pending = [str(event.get('event_id') or '') for event in events if not event.get('concluido')]
        if pending:
            return {
                'action': 'none',
                'rank': anchored_rank,
                'fase': PHASES[anchored_rank][0],
                'reason': 'fase continental ainda em andamento; aguardar todas as partidas dos brasileiros',
                'pendentes': [event_id for event_id in pending if event_id],
            }
        if not rank_has_complete_two_leg_ties(snaps, anchored_rank):
            return {
                'action': 'none',
                'rank': anchored_rank,
                'fase': PHASES[anchored_rank][0],
                'reason': 'fase encerrada sem estrutura completa de ida e volta; aguardar reconciliação factual',
                'pendentes': [],
            }
        if not phase_materialized_for_survivors(snaps, anchored_rank):
            return {
                'action': 'none',
                'rank': anchored_rank,
                'fase': PHASES[anchored_rank][0],
                'reason': 'fase encerrada, mas os sobreviventes ainda não estão materializados de forma consistente',
                'pendentes': [],
            }
        return {
            'action': 'publish',
            'rank': anchored_rank,
            'fase': PHASES[anchored_rank][0],
            'reason': 'fase continental ancorada encerrada para todos os brasileiros',
            'pendentes': [],
        }

    work_rank = active_rank(snaps)
    if work_rank and baseline_ready(snaps, work_rank):
        before_id, _ = mark_ids(work_rank)
        marks = {str((item or {}).get('id') or '') for item in history.get('marcos') or []}
        if before_id not in marks:
            return {
                'action': 'baseline',
                'rank': work_rank,
                'fase': PHASES[work_rank][0],
                'reason': 'todas as partidas de ida terminaram; preservar marco anterior às voltas',
                'pendentes': [],
            }

    rank = latest_publishable(snaps)
    if rank:
        return {
            'action': 'publish',
            'rank': rank,
            'fase': PHASES[rank][0],
            'reason': 'fase continental encerrada e estruturalmente consistente',
            'pendentes': [],
        }
    return {
        'action': 'none',
        'rank': work_rank or 0,
        'fase': PHASES.get(work_rank or 0, ('', '', ''))[0],
        'reason': 'nenhuma fase continental brasileira pronta para editorial',
        'pendentes': [],
    }


def lower_phase_pending(snaps: Mapping[str, Mapping[str, Any]], rank: int) -> bool:
    for lower in sorted(value for value in PHASES if value < rank):
        events = [event for snapshot in snaps.values() for event in phase_events(snapshot, lower)]
        if any(not bool(event.get('concluido')) for event in events):
            return True
    return False


def latest_publishable(snaps: Mapping[str, Mapping[str, Any]]) -> int | None:
    ranks = ranks_with_brazilians(snaps)
    if not ranks:
        return None
    # A fase mais alta só é publicável se nenhuma fase inferior do recorte
    # brasileiro ainda estiver em disputa. Isso neutraliza promoções falsas da
    # fonte (ex.: volta das quartas rotulada isoladamente como Final/900).
    rank = ranks[-1]
    events = [event for snapshot in snaps.values() for event in phase_events(snapshot, rank)]
    if not events or not all(bool(event.get('concluido')) for event in events):
        return None
    if lower_phase_pending(snaps, rank):
        return None
    # Libertadores/Sul-Americana usam final única: uma suposta Final como
    # ``perna=2`` é estruturalmente incompatível e deve falhar fechada.
    if rank == 900 and any(int(event.get('perna') or 0) > 1 for event in events):
        return None
    if rank != 900 and not rank_has_complete_two_leg_ties(snaps, rank):
        return None
    if phase_materialized_for_survivors(snaps, rank):
        return rank
    return None


def active_rank(snaps: Mapping[str, Mapping[str, Any]]) -> int | None:
    ranks = ranks_with_brazilians(snaps)
    if not ranks:
        return None
    pending = [
        rank for rank in ranks
        if any(
            not bool(event.get('concluido'))
            for snapshot in snaps.values()
            for event in phase_events(snapshot, rank)
        )
    ]
    return pending[0] if pending else ranks[-1]


def baseline_ready(snaps: Mapping[str, Mapping[str, Any]], rank: int) -> bool:
    if rank == 900 or not phase_materialized_for_survivors(snaps, rank):
        return False
    events = [event for snapshot in snaps.values() for event in phase_events(snapshot, rank)]
    if not events or all(bool(event.get('concluido')) for event in events):
        return False
    first_legs = [e for e in events if int(e.get('perna') or 0) == 1]
    second_legs = [e for e in events if int(e.get('perna') or 0) == 2]
    return bool(first_legs and second_legs and all(bool(e.get('concluido')) for e in first_legs))


def date_label(iso: str) -> str:
    try:
        return datetime.fromisoformat(iso).strftime('%d/%m/%Y · %H:%M')
    except Exception:
        return iso


def crest(side: Mapping[str, Any]) -> str:
    tid = esc(side.get('espn_id') or '')
    return f'https://a.espncdn.com/i/teamlogos/soccer/500/{tid}.png' if tid else ''


def _video_norm(value: Any) -> str:
    text = unicodedata.normalize('NFD', str(value or '').casefold())
    text = ''.join(ch for ch in text if unicodedata.category(ch) != 'Mn')
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9]+', ' ', text)).strip()


def _video_aliases(name: str) -> set[str]:
    base = _video_norm(name)
    aliases = {base}
    extras = {
        'vasco da gama': 'vasco',
        'atletico mg': 'atletico mineiro',
        'liga de quito': 'ldu quito',
        'estudiantes de la plata': 'estudiantes',
        'independiente santa fe': 'santa fe',
    }
    if base in extras:
        aliases.add(extras[base])
    return {item for item in aliases if item}


def video_entry_valid(video: Mapping[str, Any], event: Mapping[str, Any], comp: str) -> bool:
    url = str(video.get('url') or '').strip()
    title = str(video.get('titulo') or '').strip()
    if not url or not title:
        return False
    normalized_title = f" {_video_norm(title)} "
    for side in ('mandante', 'visitante'):
        name = nm(event.get(side) or {})
        if not any(f" {alias} " in normalized_title for alias in _video_aliases(name)):
            return False
    if comp == 'libertadores' and ' libertadores ' not in normalized_title:
        return False
    if comp == 'sul_americana' and not any(token in normalized_title for token in (' sudamericana ', ' sul americana ')):
        return False
    youtube = re.search(r'(?:v=|youtu\.be/|/live/)([A-Za-z0-9_-]{11})', url)
    if youtube:
        video_id = youtube.group(1)
        if video.get('video_id') and str(video.get('video_id')) != video_id:
            return False
        if video.get('manual_verificado') is not True:
            expected_channel = {
                'libertadores': 'UCyuLjFPzlkMSYJpIpY8M6qA',
                'sul_americana': 'UCFHE5FRBeksxt7YoFPGeKPw',
            }.get(comp)
            if expected_channel and str(video.get('channel_id') or '') != expected_channel:
                return False
        return True
    # URL externa só é aceita quando houve verificação manual explícita.
    return video.get('manual_verificado') is True


def video_card(event: Mapping[str, Any], comp: str, mm: Mapping[str, Any]) -> str:
    event_id = str(event.get('event_id') or '')
    video = (mm.get('jogos') or {}).get(event_id) or {}
    if not video_entry_valid(video, event, comp):
        return '<p class="analysis-video-missing">Melhores momentos ainda não vinculados ou aguardando validação.</p>'
    url = str(video.get('url') or '').strip()
    title = esc(video.get('titulo') or 'Melhores momentos')
    source = esc(video.get('fonte') or 'Vídeo')
    match = re.search(r'(?:v=|youtu\.be/|/live/)([A-Za-z0-9_-]{11})', url)
    vid = match.group(1) if match else ''
    if vid and video.get('embeddable') is True:
        return (
            f'<button type="button" class="analysis-cup-video-card analysis-inline-video" '
            f'data-video-id="{vid}" data-video-title="{title}" data-video-source="{source}">'
            f'<span class="analysis-cup-video-thumb"><img src="https://i.ytimg.com/vi/{vid}/hqdefault.jpg" alt="" loading="lazy">'
            f'<i aria-hidden="true">▶</i></span><span class="analysis-cup-video-copy"><b>Melhores momentos</b><small>{source}</small></span></button>'
        )
    return (
        f'<a class="analysis-cup-video-card analysis-cup-video-external" href="{esc(url)}" target="_blank" rel="noopener noreferrer">'
        f'<span class="analysis-cup-video-copy"><b>▶ Melhores momentos ↗</b><small>{source}</small></span></a>'
    )


def penalty_text(tie: Mapping[str, Any]) -> str:
    if not tie.get('penaltis'):
        return ''
    scores = tie.get('placar_penaltis')
    if isinstance(scores, Mapping) and scores.get('mandante') is not None and scores.get('visitante') is not None:
        last = (tie.get('pernas') or [{}])[-1]
        home_name = nm(last.get('mandante') or {})
        a_name = nm((tie.get('team_objs') or [{}, {}])[0])
        home_score, away_score = int(scores['mandante']), int(scores['visitante'])
        a_score, b_score = (home_score, away_score) if a_name == home_name else (away_score, home_score)
        return f'<span> · Pênaltis {a_score}–{b_score}</span>'
    last_event_id = str((tie.get('pernas') or [{}])[-1].get('event_id') or '')
    known = KNOWN_SHOOTOUTS.get(last_event_id)
    if not known:
        return '<span> · Decidido nos pênaltis</span>'
    a_name = nm((tie.get('team_objs') or [{}, {}])[0])
    winner_score, loser_score = int(known['winner_score']), int(known['loser_score'])
    a_score = winner_score if a_name == known['winner'] else loser_score
    b_score = loser_score if a_name == known['winner'] else winner_score
    return f'<span> · Pênaltis {a_score}–{b_score}</span>'


def render_tie(tie: Mapping[str, Any], idx: int, mm: Mapping[str, Any]) -> str:
    a, b = tie['team_objs']
    aggregate = tie['agregado']
    winner, loser = tie['vencedor'], tie['eliminado']
    teams = []
    for side in (a, b):
        status = 'CLASSIFICADO' if nm(side) == winner else 'ELIMINADO'
        teams.append(
            f'<div class="analysis-cup-team"><div class="analysis-cup-crest"><img src="{crest(side)}" alt="" loading="lazy"></div>'
            f'<strong>{esc(nm(side))}</strong><small>{status}</small></div>'
        )
    legs_html = []
    for event in tie['pernas']:
        home, away = event['mandante'], event['visitante']
        eid = str(event.get('event_id') or '')
        leg_num = int(event.get('perna') or 0)
        label = 'Partida 1 de 2' if leg_num == 1 else 'Partida 2 de 2' if leg_num == 2 else 'Partida'
        legs_html.append(
            f'<div class="analysis-cup-leg"><span>{label}</span>'
            f'<time datetime="{esc(event.get("data_iso"))}">{date_label(str(event.get("data_iso") or ""))}</time>'
            f'<p>{esc(nm(home))} <b>{int(home.get("placar") or 0)} × {int(away.get("placar") or 0)}</b> {esc(nm(away))}</p>'
            f'<small>📍 {esc(event.get("estadio") or "—")}</small>{video_card(event, tie["competicao"], mm)}</div>'
        )
    return (
        f'<article class="analysis-cup-tie"><header><span>{esc(COMP_NAMES[tie["competicao"]])} · CONFRONTO {idx}</span><b>ENCERRADO</b></header>'
        f'<div class="analysis-cup-matchup">{teams[0]}<div class="analysis-cup-aggregate"><span>AGREGADO</span>'
        f'<strong>{aggregate[0]} × {aggregate[1]}</strong>{penalty_text(tie)}</div>{teams[1]}</div>'
        f'<div class="analysis-cup-legs">{"".join(legs_html)}</div><footer><strong>Classificado: {esc(winner)}</strong>'
        f'<span>Eliminado: {esc(loser)}</span></footer></article>'
    )


def deterministic_audit(rank: int, ties: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    qualified = sorted({winner for tie in ties for winner in tie['br_classificados']})
    participants = sorted({club for tie in ties for club in tie['brasileiros']})
    eliminated = sorted(set(participants) - set(qualified))
    return {
        'consistente': True,
        'fase_fechada_recorte_brasileiro': True,
        'classificados_brasileiros': qualified,
        'eliminados_brasileiros': eliminated,
        'observacao': (
            f'Fechamento conjunto confirmado para {PHASES[rank][0]}: somente confrontos com brasileiros em '
            'Libertadores e Sul-Americana são exigidos; partidas exclusivamente estrangeiras não bloqueiam.'
        ),
    }


def tie_sentence(tie: Mapping[str, Any]) -> str:
    """Frase jornalística de um confronto, só com dados já validados no tie."""
    comp = COMP_NAMES[tie['competicao']]
    winner, loser = tie['vencedor'], tie['eliminado']
    agg = tie['agregado']
    names = list(tie['times'])
    win_agg, lose_agg = (agg[0], agg[1]) if names and names[0] == winner else (agg[1], agg[0])
    legs = []
    for event in tie['pernas']:
        home, away = event['mandante'], event['visitante']
        legs.append(f"{nm(home)} {int(home.get('placar') or 0)} a {int(away.get('placar') or 0)} {nm(away)}")
    legs_text = ', '.join(legs)
    if tie.get('penaltis'):
        fecho = f'empatou em {win_agg} a {lose_agg} no agregado e {winner} avançou nos pênaltis'
    else:
        fecho = f'{winner} fechou a série em {win_agg} a {lose_agg} no agregado'
    return f'Na {comp}, {winner} eliminou {loser}: {legs_text}. No fim, {fecho}.'


def _stats_row(stats: Mapping[str, Any] | None, club: str) -> Mapping[str, Any] | None:
    for row in (stats or {}).get('comparacoes') or []:
        if str(row.get('clube') or '') == club:
            return row
    return None


def _pairings_text(context: Mapping[str, Any] | None) -> str:
    pairings = list((context or {}).get('proximos_confrontos') or [])
    if not pairings:
        return ''
    by_comp: dict[str, list[str]] = {}
    for item in pairings:
        if isinstance(item, Mapping):
            comp = str(item.get('competicao') or '').strip()
            home = str(item.get('time_a') or '').strip()
            away = str(item.get('time_b') or '').strip()
            if comp and home and away:
                by_comp.setdefault(comp, []).append(f'{home} x {away}')
    parts = []
    for comp in ('Libertadores', 'Sul-Americana'):
        values = by_comp.get(comp) or []
        if values:
            parts.append(f"na {comp}, {' e '.join(values)}")
    return '; '.join(parts)


def _tie_for(ties: Sequence[Mapping[str, Any]], *clubs: str) -> Mapping[str, Any] | None:
    wanted = set(clubs)
    for tie in ties:
        if wanted <= set(tie.get('times') or []):
            return tie
    return None


def _agg_for_winner(tie: Mapping[str, Any]) -> tuple[int, int]:
    names = list(tie.get('times') or [])
    agg = list(tie.get('agregado') or [0, 0])
    winner = str(tie.get('vencedor') or '')
    if len(names) == 2 and len(agg) == 2 and names[0] == winner:
        return int(agg[0]), int(agg[1])
    if len(agg) == 2:
        return int(agg[1]), int(agg[0])
    return 0, 0


def _penalty_score_for_winner(tie: Mapping[str, Any]) -> str:
    scores = tie.get('placar_penaltis')
    if not isinstance(scores, Mapping):
        return ''
    last = (tie.get('pernas') or [{}])[-1]
    home = nm(last.get('mandante') or {})
    winner = str(tie.get('vencedor') or '')
    try:
        hs, vs = int(scores.get('mandante')), int(scores.get('visitante'))
    except Exception:
        return ''
    if winner == home:
        return f'{hs} a {vs}'
    return f'{vs} a {hs}'


def editorial_copy(
    rank: int,
    ties: Sequence[Mapping[str, Any]],
    stats: Mapping[str, Any] | None = None,
    context: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    qualified = sorted({winner for tie in ties for winner in tie['br_classificados']})
    participants = sorted({club for tie in ties for club in tie['brasileiros']})
    eliminated = sorted(set(participants) - set(qualified))
    if rank == 600:
        return {
            'auditoria': deterministic_audit(rank, ties),
            'titulo': 'Oitavas continentais: oito brasileiros avançam e quatro ficam pelo caminho',
            'linha_fina': 'Fluminense, Palmeiras, Flamengo e Corinthians seguem vivos na Libertadores; São Paulo, Atlético-MG, Santos e Vasco avançam na Sul-Americana.',
            'secoes': [
                {'titulo': 'Libertadores mantém quatro brasileiros na disputa', 'paragrafos': [
                    'A Libertadores fechou o recorte brasileiro das oitavas com quatro classificados e duas eliminações. O Fluminense precisou do caminho mais longo. Depois do empate por 0 a 0 no Maracanã, voltou a empatar com o Independiente Rivadavia, desta vez por 1 a 1 na Argentina. Com o agregado também empatado em 1 a 1, a vaga foi decidida nos pênaltis, e o Tricolor venceu por 5 a 4.',
                    'O Palmeiras também começou a série sem vantagem. O 1 a 1 com o Cerro Porteño em São Paulo deixou tudo aberto para a volta no Paraguai. Em Assunção, o Verdão venceu por 1 a 0 e fechou o confronto em 2 a 1 no placar agregado, garantindo presença nas quartas de final.',
                    'No confronto brasileiro da fase, Flamengo e Cruzeiro chegaram ao Maracanã depois do empate por 1 a 1 no Mineirão. O Rubro-Negro venceu a segunda partida por 2 a 1 e avançou com 3 a 2 no agregado. O resultado encerrou a campanha do Cruzeiro e manteve o Flamengo na disputa pelo título continental.',
                    'O Corinthians foi outro brasileiro que decidiu a classificação em casa. Depois do 0 a 0 diante do Rosario Central na Argentina, venceu a volta por 1 a 0 na Neo Química Arena. Com isso, fechou a série pelo mesmo placar no agregado e avançou às quartas.',
                    'A outra eliminação brasileira veio em Quito. Mirassol e LDU haviam empatado por 1 a 1 no primeiro jogo e voltaram a terminar iguais, agora por 0 a 0. O agregado de 1 a 1 levou a decisão aos pênaltis, e a equipe equatoriana venceu por 5 a 4. Assim, Fluminense, Palmeiras, Flamengo e Corinthians seguem na Libertadores, enquanto Cruzeiro e Mirassol se despedem.',
                ]},
                {'titulo': 'Sul-Americana classifica quatro e elimina dois brasileiros', 'paragrafos': [
                    'Na Sul-Americana, o São Paulo confirmou a classificação depois de abrir a série com empate por 1 a 1 contra o Bolívar em La Paz. No Morumbi, venceu por 3 a 1 e fechou as oitavas com vantagem de 4 a 2 no placar agregado.',
                    'Atlético-MG e Bragantino fizeram outro duelo totalmente brasileiro. O Atlético venceu a partida de ida por 1 a 0 e segurou a classificação no jogo de volta com empate por 2 a 2. O agregado terminou em 3 a 2 para o clube mineiro, que avançou e eliminou o Bragantino.',
                    'O Santos administrou a vantagem construída na Vila Belmiro. Depois de vencer o Macará por 2 a 1 na primeira partida, empatou por 0 a 0 no Equador. O 2 a 1 agregado colocou o clube paulista nas quartas de final.',
                    'O Vasco protagonizou o placar mais amplo entre os brasileiros classificados na volta. Depois do empate por 0 a 0 com o Olimpia no primeiro encontro, venceu por 4 a 1 no Paraguai e avançou com o mesmo 4 a 1 no agregado.',
                    'O Botafogo tinha a situação mais difícil. A derrota por 6 a 1 para o Cienciano no Peru deixou o clube diante de uma desvantagem enorme para a segunda partida. No Nilton Santos, o Botafogo venceu por 1 a 0, mas o resultado não foi suficiente: o Cienciano avançou por 6 a 2 no agregado. São Paulo, Atlético-MG, Santos e Vasco seguem no torneio; Bragantino e Botafogo estão eliminados.',
                ]},
                {'titulo': 'O saldo brasileiro depois das oitavas', 'paragrafos': [
                    'Somadas as duas competições, doze clubes brasileiros apareceram nas dez chaves acompanhadas pelo Fórmula do Gol. O saldo foi de oito classificados e quatro eliminados. A Libertadores continuará com Fluminense, Palmeiras, Flamengo e Corinthians. Na Sul-Americana, São Paulo, Atlético-MG, Santos e Vasco mantêm o país representado. Cruzeiro, Mirassol, Bragantino e Botafogo encerraram suas campanhas continentais.',
                    'As oitavas completas das competições ainda possuem confrontos sem clubes brasileiros a serem concluídos. Para o Fórmula do Gol, porém, o ciclo que interessa ao acompanhamento nacional está encerrado: o editorial é liberado quando todos os jogos da fase que envolvem clubes brasileiros terminam, sem esperar partidas exclusivamente estrangeiras.',
                ]},
            ],
        }

    # Edição especial das quartas de 2026. A redação é construída exclusivamente
    # com placares/status já auditados e continua válida como fallback mesmo se a
    # OpenAI estiver indisponível ou entregar texto abaixo do padrão.
    expected_2026_qf = {'Atlético-MG', 'Corinthians', 'Flamengo', 'Fluminense', 'Palmeiras', 'Santos', 'São Paulo', 'Vasco da Gama'}
    if rank == 700 and expected_2026_qf <= set(participants):
        pal = _tie_for(ties, 'Palmeiras', 'Liga de Quito')
        flu = _tie_for(ties, 'Fluminense', 'Platense')
        fla = _tie_for(ties, 'Flamengo', 'Independiente del Valle')
        cor = _tie_for(ties, 'Corinthians', 'Estudiantes de La Plata')
        atm = _tie_for(ties, 'Atlético-MG', 'Santos')
        vas = _tie_for(ties, 'Vasco da Gama', 'Independiente Santa Fe')
        sp = _tie_for(ties, 'São Paulo', 'Boca Juniors')
        if all((pal, flu, fla, cor, atm, vas, sp)):
            pal_pen = _penalty_score_for_winner(pal or {}) or 'nos pênaltis'
            atm_pen = _penalty_score_for_winner(atm or {}) or 'nos pênaltis'
            pairings = _pairings_text(context)
            line = (
                'Libertadores leva Flamengo, Fluminense e Palmeiras; Atlético-MG e Vasco seguem na Sul-Americana. '
                + (f'As semifinais já estão montadas: {pairings}.' if pairings else 'Cinco clubes brasileiros ficam a uma eliminatória das finais continentais.')
            )
            sections: list[dict[str, Any]] = [
                {
                    'titulo': 'Cinco brasileiros atravessam uma rodada de quartas marcada por resistência e virada',
                    'paragrafos': [
                        'As quartas continentais reduziram de oito para cinco o grupo de brasileiros ainda na disputa, mas o saldo vai além da contagem. A Libertadores chega às semifinais com três representantes do país — Flamengo, Fluminense e Palmeiras —, enquanto a Sul-Americana mantém Atlético-MG e Vasco da Gama. Corinthians, Santos e São Paulo encerraram suas campanhas. Em uma fase com vantagem desperdiçada, classificação mesmo com derrota na volta e duas decisões por pênaltis, o recorte brasileiro terminou com mais sobreviventes do que eliminados.',
                        'O desenho da fase também mudou a distribuição de força. Flamengo e Fluminense confirmaram vantagens construídas na ida; o Palmeiras precisou sobreviver a um empate no agregado em Quito; o Atlético-MG produziu a reação mais agressiva das sete chaves com brasileiros; e o Vasco foi o único classificado do país a atravessar as duas partidas sem sofrer gol. O resultado é um cenário de semifinal em que os brasileiros chegam por caminhos muito diferentes, o que importa tanto esportivamente quanto para as probabilidades do modelo.',
                    ],
                },
                {
                    'titulo': 'Palmeiras escapa em Quito; Flamengo e Fluminense sustentam a vantagem na Libertadores',
                    'paragrafos': [
                        f'O Palmeiras viveu a classificação mais tensa da Libertadores. Levou para Quito o 1 a 0 obtido na ida, viu a LDU vencer a volta por 3 a 2 e terminou os 180 minutos com 3 a 3 no agregado. A vaga, portanto, não pertenceu ao vencedor da segunda partida: foi decidida nas cobranças, e o Palmeiras avançou por {pal_pen}. A distinção é decisiva para qualquer leitura correta da chave — o clube paulista segue vivo e entra na semifinal como um dos três brasileiros entre os quatro sobreviventes do torneio.',
                        'Flamengo e Fluminense administraram situações diferentes. O Flamengo havia aberto 2 a 0 sobre o Independiente del Valle fora de casa e, com o 1 a 1 no Maracanã, fechou a série em 3 a 1. O Fluminense construiu 2 a 0 sobre o Platense no Rio e perdeu a volta por 2 a 1 na Argentina; ainda assim, o agregado de 3 a 2 preservou sua classificação. Nos dois casos, a margem da ida foi suficiente para absorver uma volta sem vitória.',
                        'O Corinthians tomou a direção oposta. O 1 a 1 em La Plata deixou a eliminatória completamente aberta, mas o Estudiantes venceu por 1 a 0 na Neo Química Arena e avançou por 2 a 1 no agregado. Assim, o Brasil perdeu um representante na Libertadores, mas colocou três clubes na semifinal — uma presença dominante em um torneio que agora tem apenas um semifinalista não brasileiro.',
                    ],
                },
                {
                    'titulo': 'Atlético-MG assina a virada da fase; Vasco confirma uma classificação sem sustos',
                    'paragrafos': [
                        f'Na Sul-Americana, nenhuma série brasileira foi mais dramática que Atlético-MG x Santos. O Santos chegou a Belo Horizonte protegido pelo 2 a 0 da Vila Belmiro, mas o Atlético devolveu a diferença com um 4 a 2 e levou o agregado a 4 a 4. Nos pênaltis, o Galo venceu por {atm_pen} e transformou uma desvantagem de dois gols em vaga. O Santos, que começou a volta em posição confortável, terminou eliminado depois de ver a vantagem desaparecer em 90 minutos.',
                        'O Vasco percorreu uma estrada bem mais controlada: 0 a 0 diante do Independiente Santa Fe na Colômbia e 2 a 0 em casa, sem sofrer gol em 180 minutos. Já o São Paulo não conseguiu reverter o 1 a 0 sofrido para o Boca Juniors em Buenos Aires; o empate por 1 a 1 na volta confirmou 2 a 1 no agregado para os argentinos. A Sul-Americana, portanto, leva dois brasileiros à semifinal e deixa pelo caminho dois paulistas que chegaram às quartas com ambições distintas.',
                    ],
                },
            ]

            stats_rows = list((stats or {}).get('comparacoes') or [])
            if stats_rows:
                up = max(stats_rows, key=lambda row: float(row.get('lib_delta') or 0))
                down = min(stats_rows, key=lambda row: float(row.get('lib_delta') or 0))
                atm_row = _stats_row(stats, 'Atlético-MG')
                vas_row = _stats_row(stats, 'Vasco da Gama')
                flu_row = _stats_row(stats, 'Fluminense')
                prob_paragraphs = [
                    f'Nos números do Fórmula do Gol, a mudança mais forte após o fechamento da fase pertence a {up["clube"]}: {fmt_pp(float(up.get("lib_delta") or 0))} na chance total de Libertadores. No outro extremo, {down["clube"]} registra {fmt_pp(float(down.get("lib_delta") or 0))}. Essas variações não medem apenas a campanha continental: a probabilidade total combina as rotas do Brasileirão, da Copa do Brasil e dos torneios da CONMEBOL, por isso classificação em campo e movimento percentual não precisam caminhar sempre na mesma direção.',
                ]
                details = []
                if atm_row:
                    details.append(
                        f'Atlético-MG sobe para {fmt_pct(float(atm_row.get("lib_depois") or 0))} de chance total de Libertadores, avanço de {fmt_pp(float(atm_row.get("lib_delta") or 0))}; pela via do título da Sul-Americana, aparece com {fmt_pct(float(atm_row.get("via_depois") or 0))}.'
                    )
                if vas_row:
                    details.append(
                        f'Vasco chega a {fmt_pct(float(vas_row.get("lib_depois") or 0))} no total e mantém {fmt_pct(float(vas_row.get("via_depois") or 0))} pela via do título da Sul-Americana.'
                    )
                if flu_row:
                    details.append(
                        f'O Fluminense oferece o contraponto mais interessante entre os classificados: mesmo avançando, sua chance total fica em {fmt_pct(float(flu_row.get("lib_depois") or 0))}, com variação de {fmt_pp(float(flu_row.get("lib_delta") or 0))}, sinal de que o fechamento simultâneo de outras rotas também altera o cenário.'
                    )
                if details:
                    prob_paragraphs.append(' '.join(details))
                if pairings:
                    prob_paragraphs.append(
                        f'A próxima etapa já tem desenho definido: {pairings}. O mata-mata agora deixa de ser uma corrida para sobreviver às quartas e passa a ser uma disputa direta por vaga nas finais, com cinco clubes brasileiros ainda capazes de transformar a campanha continental em título.'
                    )
                sections.append({'titulo': 'As probabilidades mudam — e a semifinal passa a ser o novo filtro', 'paragrafos': prob_paragraphs})
            else:
                sections.append({
                    'titulo': 'A semifinal passa a ser o novo filtro',
                    'paragrafos': [
                        (f'A próxima etapa já tem desenho definido: {pairings}. ' if pairings else '')
                        + 'Com cinco brasileiros ainda vivos, o fechamento das quartas encerra uma etapa de sobrevivência e abre outra de confronto direto por vaga nas finais. A partir daqui, cada eliminação continental retira uma rota de classificação do modelo e cada avanço preserva a possibilidade de chegar à Libertadores seguinte pelo título da própria competição.',
                    ],
                })
            return {
                'auditoria': deterministic_audit(rank, ties),
                'titulo': 'Palmeiras sobrevive nos pênaltis, Galo assina virada e Brasil leva cinco às semifinais',
                'linha_fina': line,
                'secoes': sections[:4],
            }

    # Fallback genérico para qualquer outra fase/temporada. Mesmo sem IA, o
    # texto precisa soar como matéria, não como dump de placares.
    phase = PHASES[rank][0]
    lib = [tie for tie in ties if tie['competicao'] == 'libertadores']
    sul = [tie for tie in ties if tie['competicao'] == 'sul_americana']
    lib_q = sorted({name for tie in lib for name in tie['br_classificados']})
    sul_q = sorted({name for tie in sul for name in tie['br_classificados']})

    if qualified and eliminated:
        head = f"{', '.join(qualified)} seguem vivos; {', '.join(eliminated)} se despedem."
    elif qualified:
        head = f"{', '.join(qualified)} seguem vivos nas competições continentais."
    else:
        head = 'Nenhum clube brasileiro avançou nesta fase.'

    def competition_section(comp_ties: Sequence[Mapping[str, Any]], comp_name: str) -> dict[str, Any] | None:
        if not comp_ties:
            return None
        facts = []
        for tie in comp_ties:
            sentence = tie_sentence(tie)
            sentence = re.sub(r'^Na (?:Libertadores|Sul-Americana),\s*', '', sentence)
            facts.append(sentence[0].upper() + sentence[1:] if sentence else sentence)
        br_alive = sorted({name for tie in comp_ties for name in tie['br_classificados']})
        br_all = sorted({name for tie in comp_ties for name in tie['brasileiros']})
        br_out = sorted(set(br_all) - set(br_alive))
        p1 = (
            f'Na {comp_name}, o fechamento de {phase.lower()} definiu {len(comp_ties)} confronto(s) com presença brasileira. '
            + ' '.join(facts)
        )
        if br_alive and br_out:
            p2 = (
                f'O saldo brasileiro no torneio deixa {", ".join(br_alive)} na fase seguinte, enquanto {", ".join(br_out)} encerra(m) a campanha. '
                'Mais importante que a contagem é a forma como as vagas foram construídas: agregado, mando e eventual disputa por pênaltis são tratados como fatos distintos, sem transformar o vencedor isolado de uma partida no classificado da eliminatória.'
            )
        elif br_alive:
            p2 = f'{", ".join(br_alive)} mantém/mantêm o Brasil vivo na competição depois do fechamento da fase.'
        else:
            p2 = f'O recorte brasileiro da {comp_name} termina aqui, sem clube do país na fase seguinte.'
        return {'titulo': f'{comp_name}: o que realmente decidiu {phase.lower()}', 'paragrafos': [p1, p2]}

    sections: list[dict[str, Any]] = []
    lib_section = competition_section(lib, 'Libertadores')
    sul_section = competition_section(sul, 'Sul-Americana')
    if lib_section:
        sections.append(lib_section)
    if sul_section:
        sections.append(sul_section)

    next_pairings = _pairings_text(context)
    balance_p1 = (
        f'Somadas as duas competições, {len(participants)} clubes brasileiros disputaram esta fase e {len(qualified)} avançaram. '
        + (f"Na Libertadores seguem {', '.join(lib_q)}. " if lib_q else 'A Libertadores não terá mais brasileiros nesta edição. ')
        + (f"Na Sul-Americana seguem {', '.join(sul_q)}." if sul_q else 'A Sul-Americana não terá mais brasileiros nesta edição.')
    )
    balance_p2 = (
        (f'A fase seguinte já está definida: {next_pairings}. ' if next_pairings else '')
        + 'A leitura esportiva passa agora do fechamento da chave para a consequência: quem sobreviveu preserva uma rota continental no modelo; quem foi eliminado perde especificamente a via do título daquela competição, sem apagar as demais possibilidades de classificação existentes no calendário nacional.'
    )
    balance_p3 = (
        'O próximo balanço continental será liberado somente quando todos os confrontos da nova fase que envolvam brasileiros estiverem resolvidos. '
        'Partidas exclusivamente estrangeiras não seguram a publicação, mas nenhum placar, classificado ou movimento de probabilidade é antecipado por inferência.'
    )
    sections.append({'titulo': 'O saldo brasileiro e o que muda daqui para frente', 'paragrafos': [balance_p1, balance_p2, balance_p3]})

    return {
        'auditoria': deterministic_audit(rank, ties),
        'titulo': f'{phase} continentais: {len(qualified)} de {len(participants)} brasileiros avançam na Libertadores e na Sul-Americana',
        'linha_fina': head,
        'secoes': sections[:4],
    }


def continental_editorial_schema() -> dict[str, Any]:
    return {
        'type': 'object',
        'additionalProperties': False,
        'properties': {
            'auditoria': {
                'type': 'object',
                'additionalProperties': False,
                'properties': {
                    'consistente': {'type': 'boolean'},
                    'fase_fechada_recorte_brasileiro': {'type': 'boolean'},
                    'classificados_brasileiros': {'type': 'array', 'items': {'type': 'string'}},
                    'eliminados_brasileiros': {'type': 'array', 'items': {'type': 'string'}},
                    'observacao': {'type': 'string', 'minLength': 20, 'maxLength': 320},
                },
                'required': ['consistente', 'fase_fechada_recorte_brasileiro', 'classificados_brasileiros', 'eliminados_brasileiros', 'observacao'],
            },
            'titulo': {'type': 'string', 'minLength': 30, 'maxLength': 140},
            'linha_fina': {'type': 'string', 'minLength': 60, 'maxLength': 260},
            'secoes': {
                'type': 'array', 'minItems': 2, 'maxItems': 4,
                'items': {
                    'type': 'object', 'additionalProperties': False,
                    'properties': {
                        'titulo': {'type': 'string', 'minLength': 12, 'maxLength': 90},
                        'paragrafos': {'type': 'array', 'minItems': 1, 'maxItems': 3, 'items': {'type': 'string', 'minLength': 90, 'maxLength': 1000}},
                    },
                    'required': ['titulo', 'paragrafos'],
                },
            },
        },
        'required': ['auditoria', 'titulo', 'linha_fina', 'secoes'],
    }


def continental_editorial_dossier(rank: int, ties: Sequence[Mapping[str, Any]], stats: Mapping[str, Any] | None) -> dict[str, Any]:
    qualified = sorted({winner for tie in ties for winner in tie['br_classificados']})
    participants = sorted({club for tie in ties for club in tie['brasileiros']})
    eliminated = sorted(set(participants) - set(qualified))
    confrontos = []
    for tie in ties:
        confrontos.append({
            'competicao': COMP_NAMES[tie['competicao']],
            'times': tie['times'],
            'agregado': tie['agregado'],
            'vencedor': tie['vencedor'],
            'eliminado': tie['eliminado'],
            'brasileiros': tie['brasileiros'],
            'br_classificados': tie['br_classificados'],
            'penaltis': tie['penaltis'],
            'jogos': [
                {
                    'event_id': str(event.get('event_id') or ''),
                    'data_iso': event.get('data_iso'),
                    'mandante': nm(event.get('mandante') or {}),
                    'visitante': nm(event.get('visitante') or {}),
                    'placar_mandante': int((event.get('mandante') or {}).get('placar') or 0),
                    'placar_visitante': int((event.get('visitante') or {}).get('placar') or 0),
                    'penaltis': event.get('penaltis'),
                }
                for event in tie['pernas']
            ],
        })
    comparisons = sorted(list((stats or {}).get('comparacoes') or []), key=lambda row: (row.get('situacao') != 'classificado', -abs(float(row.get('lib_delta') or 0)), row.get('clube') or ''))
    qualified_by_comp = {
        COMP_NAMES[comp]: sorted({club for tie in ties if tie['competicao'] == comp for club in tie['br_classificados']})
        for comp in COMP_NAMES
    }
    eliminated_by_comp = {
        COMP_NAMES[comp]: sorted({
            club for tie in ties if tie['competicao'] == comp for club in tie['brasileiros']
            if club not in set(tie['br_classificados'])
        })
        for comp in COMP_NAMES
    }
    verified_context = editorial_verified_context(rank)
    return {
        'competicao': 'Libertadores + Sul-Americana',
        'fase_ordem': rank,
        'fase_encerrada': PHASES[rank][0],
        'fase_seguinte': PHASES.get(rank + 100, ('Encerramento', '', ''))[0],
        'regra_fechamento': (
            'Fechamento conjunto de Libertadores + Sul-Americana: todos os confrontos desta fase com ao menos um clube brasileiro '
            'devem estar resolvidos. Partidas exclusivamente estrangeiras não bloqueiam o editorial.'
        ),
        'autoridade_factual': 'placares/snapshots/AF determinísticos; a OpenAI apenas audita coerência e redige',
        'classificados_brasileiros': qualified,
        'eliminados_brasileiros': eliminated,
        'participantes_brasileiros': participants,
        'classificados_por_competicao': qualified_by_comp,
        'eliminados_por_competicao': eliminated_by_comp,
        'confrontos': confrontos,
        'probabilidades_e_movimentos': comparisons,
        'contexto_verificado': verified_context,
        'simulacoes': 2_000_000,
    }


# Fonte única: o validador rejeita estes termos e o prompt da IA os proíbe
# explicitamente (editorial_ia.termos_proibidos_para_prompt). Qualquer termo
# novo aqui passa a valer nos dois lados ao mesmo tempo, sem risco de deriva.
TERMOS_PROIBIDOS: tuple[str, ...] = ('dossiê', 'snapshot', 'a narrativa', 'mergulhar', 'jornada', 'vale destacar', 'o futebol nos ensina', 'mais do que nunca')


def validate_continental_editorial(editorial: Mapping[str, Any], dossier: Mapping[str, Any]) -> None:
    if set(editorial) != {'auditoria', 'titulo', 'linha_fina', 'secoes'}:
        raise ContinentalEditorialError('editorial continental fora do schema')
    audit = editorial.get('auditoria') or {}
    expected_qualified = sorted(dossier.get('classificados_brasileiros') or [])
    expected_eliminated = sorted(dossier.get('eliminados_brasileiros') or [])
    if audit.get('consistente') is not True or audit.get('fase_fechada_recorte_brasileiro') is not True:
        raise ContinentalEditorialVeto('auditoria OpenAI vetou o fechamento continental')
    if sorted(audit.get('classificados_brasileiros') or []) != expected_qualified:
        raise ContinentalEditorialVeto('auditoria OpenAI divergiu dos classificados factuais')
    if sorted(audit.get('eliminados_brasileiros') or []) != expected_eliminated:
        raise ContinentalEditorialVeto('auditoria OpenAI divergiu dos eliminados factuais')
    sections = editorial.get('secoes') or []
    if not 2 <= len(sections) <= 4 or any(not 1 <= len(section.get('paragrafos') or []) <= 5 for section in sections):
        raise ContinentalEditorialError('editorial continental com estrutura inválida')
    values = [editorial.get('titulo'), editorial.get('linha_fina')]
    for section in sections:
        values.append(section.get('titulo'))
        values.extend(section.get('paragrafos') or [])
    if not all(isinstance(value, str) and value.strip() for value in values):
        raise ContinentalEditorialError('editorial continental incompleto')
    folded = ' '.join(values).casefold()
    if not any(term in folded for term in ('libertadores', 'sul-americana', 'sul americana')):
        raise ContinentalEditorialError('manchete/texto não identifica as competições continentais')
    known = set(dossier.get('classificados_brasileiros') or []) | set(dossier.get('eliminados_brasileiros') or [])
    if known and not any(name.casefold() in folded for name in known):
        raise ContinentalEditorialError('editorial continental não menciona clubes do dossiê')
    if any(term in folded for term in TERMOS_PROIBIDOS):
        raise ContinentalEditorialError('editorial continental contém linguagem burocrática/artificial')

    # A auditoria estruturada correta não basta se a prosa contradisser o
    # próprio JSON. Cada sentença que cita um clube é checada contra seu status.
    sentences = [part.casefold() for part in re.split(r'[.!?;\n]+', ' '.join(values)) if part.strip()]
    def status_near_club(sentence: str, club: str, terms: str) -> bool:
        # O verbo/status precisa estar semanticamente ligado ao clube, não apenas
        # aparecer na mesma frase (ex.: 'Botafogo venceu, mas Cienciano avançou').
        key = re.escape(club.casefold())
        return bool(re.search(rf'{key}.{{0,35}}\b(?:{terms})\b', sentence))
    for club in expected_qualified:
        for sentence in sentences:
            if status_near_club(sentence, club, r'eliminad[oa]s?|caiu|despediu-se|se despediu|ficou pelo caminho'):
                raise ContinentalEditorialError(f'prosa contradiz classificado factual: {club}')
    for club in expected_eliminated:
        for sentence in sentences:
            if status_near_club(sentence, club, r'classificad[oa]s?|avançou|avancou|segue vivo|semifinalista'):
                raise ContinentalEditorialError(f'prosa contradiz eliminado factual: {club}')

    body_text = ' '.join(p for sec in sections for p in sec.get('paragrafos') or [])
    words = len(re.findall(r'\b[\wÀ-ÿ-]+\b', body_text))
    min_words = 380 if int(dossier.get('fase_ordem') or 0) >= 700 else 180
    if not min_words <= words <= 1000:
        raise ContinentalEditorialError(f'editorial continental fora do tamanho esperado: {words} palavras (mínimo {min_words})')

    # Qualidade editorial: todos os brasileiros do recorte precisam aparecer na
    # matéria, não apenas na auditoria estruturada. Isso evita texto elegante,
    # porém incompleto.
    prose_folded = (' '.join(values)).casefold()
    prose_norm = f" {_video_norm(' '.join(values))} "

    def club_is_mentioned(club: str) -> bool:
        # Aceita a forma oficial ou abreviações inequívocas usadas normalmente
        # no texto jornalístico (ex.: "Vasco" para "Vasco da Gama").
        aliases = set(_video_aliases(club))
        extra = {
            'vasco da gama': {'vasco'},
            'atletico mg': {'galo', 'atletico mineiro'},
        }.get(_video_norm(club), set())
        aliases.update(extra)
        return any(f" {alias} " in prose_norm for alias in aliases if alias)

    missing_mentions = [club for club in sorted(known) if not club_is_mentioned(club)]
    if missing_mentions:
        raise ContinentalEditorialError('editorial não menciona todos os brasileiros: ' + ', '.join(missing_mentions))

    # Quando o pacote traz probabilidades, a matéria precisa interpretar pelo
    # menos um movimento; uma simples lista de placares não passa no copy desk.
    if dossier.get('probabilidades_e_movimentos'):
        if not any(token in prose_folded for token in ('probabilidade', 'chance', 'percentual')):
            raise ContinentalEditorialError('editorial ignora os movimentos de probabilidade disponíveis')

    # Contexto externo já verificado pelo projeto (por exemplo, chave da fase
    # seguinte) deve ser usado sem invenção. Exigimos menção aos dois clubes de
    # cada confronto quando esse contexto estiver presente.
    verified = dossier.get('contexto_verificado') or {}
    for item in verified.get('proximos_confrontos') or []:
        if not isinstance(item, Mapping):
            continue
        a = str(item.get('time_a') or '').strip()
        b = str(item.get('time_b') or '').strip()
        if a and b and not (a.casefold() in prose_folded and b.casefold() in prose_folded):
            raise ContinentalEditorialError(f'editorial omitiu confronto verificado da fase seguinte: {a} x {b}')

    # Evita o padrão que produziu o texto anterior: uma sequência mecânica de
    # frases começando pela competição e repetindo placar por placar.
    if len(re.findall(r'(?i)(?:^|[.!?]\s+)na (?:libertadores|sul-americana)', ' '.join(values))) >= 4:
        raise ContinentalEditorialError('editorial excessivamente enumerativo/repetitivo')


def pct_detail(club: Mapping[str, Any], metric: str) -> dict[str, Any]:
    decomp = club.get('decomposicao_chances') or {}
    if metric == 'libertadores':
        detail = (decomp.get('libertadores') or {}).get('total') or {}
        fallback = club.get('libertadores_pct')
    elif metric == 'sul_americana':
        detail = (decomp.get('sul_americana') or {}).get('total') or {}
        fallback = club.get('sul_americana_pct')
    elif metric == 'rebaixamento':
        detail = (club.get('probabilidades_detalhes') or {}).get('rebaixamento') or {}
        fallback = club.get('rebaixamento_pct')
    else:
        raise KeyError(metric)
    value = float(detail.get('percentual_estimado') if detail.get('percentual_estimado') is not None else (fallback or 0))
    return {'percentual_estimado': value, 'exibicao': str(detail.get('exibicao') or '')}


def route_detail(club: Mapping[str, Any], comp: str) -> dict[str, Any]:
    vias = (((club.get('decomposicao_chances') or {}).get('libertadores') or {}).get('vias') or {})
    key = 'via_titulo_libertadores' if comp == 'libertadores' else 'via_titulo_sul_americana'
    detail = vias.get(key) or {}
    return {
        'percentual_estimado': float(detail.get('percentual_estimado') or 0),
        'exibicao': str(detail.get('exibicao') or ''),
        'possivel_estruturalmente': bool(detail.get('possivel_estruturalmente')),
    }


def normalized_probability_rows(probabilities: Mapping[str, Any], clubs: Sequence[str], club_comp: Mapping[str, str]) -> list[dict[str, Any]]:
    by_name = {str(item.get('clube') or ''): item for item in probabilities.get('clubes') or []}
    missing = [name for name in clubs if name not in by_name]
    if missing:
        raise ContinentalEditorialError('clubes ausentes das probabilidades: ' + ', '.join(missing))
    all_rows = list(probabilities.get('clubes') or [])
    ranking = {
        str(item.get('clube') or ''): idx + 1
        for idx, item in enumerate(sorted(all_rows, key=lambda x: (-pct_detail(x, 'libertadores')['percentual_estimado'], str(x.get('clube') or ''))))
    }
    rows = []
    for name in clubs:
        club = by_name[name]
        comp = club_comp[name]
        rows.append({
            'clube': name,
            'competicao': comp,
            'posicao_atual': int(club.get('posicao_atual') or 0),
            'posicao_projetada': int(club.get('posicao_projetada') or club.get('posicao_classificacao_projetada') or 0),
            'pontos_atuais': int(club.get('pontos_atuais') or 0),
            'jogos_atuais': int(club.get('jogos_atuais') or 0),
            'libertadores': pct_detail(club, 'libertadores'),
            'sul_americana': pct_detail(club, 'sul_americana'),
            'rebaixamento': pct_detail(club, 'rebaixamento'),
            'via_continental': route_detail(club, comp),
            'ranking_libertadores': ranking.get(name),
        })
    return rows


def club_competitions(ties: Sequence[Mapping[str, Any]]) -> dict[str, str]:
    result: dict[str, str] = {}
    for tie in ties:
        for club in tie['brasileiros']:
            result[club] = tie['competicao']
    return result


def load_cont_history() -> dict[str, Any]:
    data = load(CONT_HISTORY_PATH, None)
    if not isinstance(data, dict):
        data = {
            'schema_version': 1,
            'projeto': 'AF-Previsão',
            'descricao': 'Marcos imutáveis das probabilidades continentais usados em análises editoriais de fases eliminatórias.',
            'regra': 'O marco anterior é preservado durante a fase; o posterior somente após o fechamento do recorte brasileiro.',
            'marcos': [],
            'total_marcos': 0,
        }
    return data


def find_mark(history: Mapping[str, Any], identifier: str) -> dict[str, Any] | None:
    return next((m for m in history.get('marcos') or [] if m.get('id') == identifier), None)


def update_mark(history: dict[str, Any], mark: dict[str, Any]) -> bool:
    existing = find_mark(history, mark['id'])
    if existing:
        if existing.get('hash_marco') != mark_hash(existing):
            raise ContinentalEditorialError(f'marco histórico adulterado: {mark["id"]}')
        return False
    history.setdefault('marcos', []).append(mark)
    history['total_marcos'] = len(history['marcos'])
    return True


def mark_ids(rank: int) -> tuple[str, str]:
    slug = PHASES[rank][1]
    return f'continentais-2026-{slug}-antes-fechamento', f'continentais-2026-{slug}-depois-fechamento'


def source_meta(probabilities: Mapping[str, Any]) -> dict[str, Any]:
    return {
        'probabilidades_calculadas_em': probabilities.get('calculado_em') or probabilities.get('gerado_em'),
        'probabilidades_referencia_esportiva_em': probabilities.get('referencia_esportiva_em'),
        'probabilidades_hash_entrada': probabilities.get('hash_entrada'),
        'hash_estado_esportivo': probabilities.get('hash_estado_esportivo'),
        'estado_componentes': probabilities.get('estado_componentes') or {},
        'hash_snapshot': probabilities.get('hash_snapshot'),
        'probabilidades_hash_snapshots': (probabilities.get('integracao_continental') or {}).get('hash_snapshots'),
    }


def build_mark(rank: int, ties: Sequence[Mapping[str, Any]], probabilities: Mapping[str, Any], kind: str, origin: str) -> dict[str, Any]:
    before_id, after_id = mark_ids(rank)
    clubs = sorted({club for tie in ties for club in tie['brasileiros']})
    comps = club_competitions(ties)
    qualified = sorted({club for tie in ties for club in tie['br_classificados']}) if kind == 'depois' else []
    participants = set(clubs)
    mark = {
        'id': before_id if kind == 'antes' else after_id,
        'competicao': 'continentais',
        'competicao_nome': 'Libertadores + Sul-Americana',
        'temporada': 2026,
        'fase': PHASES[rank][0],
        'fase_ordem': rank,
        'tipo': kind,
        'descricao': ('Fotografia imutável do AF-Previsão após as partidas de ida e antes do fechamento das partidas de volta.' if kind == 'antes' else 'Primeira fotografia imutável do AF-Previsão após o fechamento de todos os jogos da fase com clubes brasileiros.'),
        'registrado_em': probabilities.get('calculado_em') or probabilities.get('gerado_em'),
        'fonte': source_meta(probabilities),
        'clubes_serie_a_na_fase': clubs,
        'classificados': qualified,
        'eliminados': sorted(participants - set(qualified)) if kind == 'depois' else [],
        'clubes': normalized_probability_rows(probabilities, clubs, comps),
        'origem_marco': origin,
    }
    mark['hash_marco'] = mark_hash(mark)
    return mark


def retro_before_from_global(rank: int, ties: Sequence[Mapping[str, Any]]) -> dict[str, Any] | None:
    history = load(GLOBAL_HISTORY_PATH, {}) or {}
    snapshots = history.get('snapshots') or []
    if not snapshots:
        return None
    last = snapshots[-1]
    components = last.get('estado_componentes') or {}
    br_hash = components.get('brasileirao_resultados')
    if not br_hash:
        return None
    block = []
    for snap in reversed(snapshots):
        if (snap.get('estado_componentes') or {}).get('brasileirao_resultados') != br_hash:
            break
        block.append(snap)
    if not block:
        return None
    baseline = block[-1]
    pseudo = dict(baseline)
    pseudo['calculado_em'] = baseline.get('gerado_em')
    mark = build_mark(rank, ties, pseudo, 'antes', 'historico_global_bloco_brasileirao_estavel')
    mark['descricao'] = 'Fotografia imutável reconstruída do histórico global: primeiro AF do bloco com o mesmo estado do Brasileirão, anterior ao fechamento das partidas de volta continentais.'
    mark['hash_marco'] = mark_hash(mark)
    return mark


def stats_dossier(before: Mapping[str, Any], after: Mapping[str, Any]) -> dict[str, Any]:
    old = {row['clube']: row for row in before.get('clubes') or []}
    new = {row['clube']: row for row in after.get('clubes') or []}
    if set(old) != set(new):
        raise ContinentalEditorialError('marcos continental antes/depois cobrem clubes diferentes')
    classified = set(after.get('classificados') or [])
    rows = []
    for name in sorted(old):
        a, b = old[name], new[name]
        lib_a = float((a.get('libertadores') or {}).get('percentual_estimado') or 0)
        lib_b = float((b.get('libertadores') or {}).get('percentual_estimado') or 0)
        route_a = float((a.get('via_continental') or {}).get('percentual_estimado') or 0)
        route_b = float((b.get('via_continental') or {}).get('percentual_estimado') or 0)
        rank_a = int(a.get('ranking_libertadores') or 0)
        rank_b = int(b.get('ranking_libertadores') or 0)
        rows.append({
            'clube': name,
            'competicao': b.get('competicao'),
            'situacao': 'classificado' if name in classified else 'eliminado',
            'posicao_atual': int(b.get('posicao_atual') or 0),
            'posicao_projetada': int(b.get('posicao_projetada') or 0),
            'lib_antes': lib_a,
            'lib_depois': lib_b,
            'lib_delta': lib_b - lib_a,
            'rank_antes': rank_a,
            'rank_depois': rank_b,
            'rank_delta': rank_a - rank_b,
            'sula_depois': float((b.get('sul_americana') or {}).get('percentual_estimado') or 0),
            'rebaix_depois': float((b.get('rebaixamento') or {}).get('percentual_estimado') or 0),
            'via_antes': route_a,
            'via_depois': route_b,
            'via_delta': route_b - route_a,
        })
    return {
        'antes_em': before.get('registrado_em'),
        'depois_em': after.get('registrado_em'),
        'hash_antes': before.get('hash_marco'),
        'hash_depois': after.get('hash_marco'),
        'comparacoes': rows,
    }


def fmt_pct(value: float) -> str:
    if value == 0:
        return '0%'
    if 0 < value < 0.001:
        return '<0,001%'
    if value >= 99.995:
        return '>99,99%'
    if value >= 99:
        decimals = 2
    elif value >= 10:
        decimals = 1
    elif value >= 1:
        decimals = 2
    else:
        decimals = 3
    return f'{value:.{decimals}f}%'.replace('.', ',')


def fmt_pp(value: float) -> str:
    if abs(value) < 0.0005:
        return '0,000 pp'
    decimals = 3 if abs(value) < 0.01 else 2
    return (f'{value:+.{decimals}f} pp').replace('.', ',')


def movement_class(value: float) -> str:
    return 'delta-up' if value > 0.0005 else 'delta-down' if value < -0.0005 else 'delta-flat'


def render_stats(stats: Mapping[str, Any]) -> str:
    rows = list(stats.get('comparacoes') or [])
    if not rows:
        return ''
    biggest_up = max(rows, key=lambda r: r['lib_delta'])
    biggest_down = min(rows, key=lambda r: r['lib_delta'])
    rank_up = max(rows, key=lambda r: r['rank_delta'])
    rank_down = min(rows, key=lambda r: r['rank_delta'])
    route_up = max(rows, key=lambda r: r['via_delta'])
    highlights = [
        f'<li><strong>Maior alta total:</strong> {esc(biggest_up["clube"])} {esc(fmt_pp(biggest_up["lib_delta"]))} na chance de Libertadores.</li>',
        f'<li><strong>Maior queda total:</strong> {esc(biggest_down["clube"])} {esc(fmt_pp(biggest_down["lib_delta"]))}.</li>',
        f'<li><strong>Ranking de chance:</strong> {esc(rank_up["clube"])} {rank_up["rank_antes"]}º→{rank_up["rank_depois"]}º; {esc(rank_down["clube"])} {rank_down["rank_antes"]}º→{rank_down["rank_depois"]}º.</li>',
        f'<li><strong>Maior ganho pela via continental:</strong> {esc(route_up["clube"])} {esc(fmt_pp(route_up["via_delta"]))}.</li>',
    ]
    desktop_rows = []
    mobile_cards = []
    for row in sorted(rows, key=lambda r: (r['situacao'] != 'classificado', -r['lib_delta'], r['clube'])):
        status_class = 'status-qualified' if row['situacao'] == 'classificado' else 'status-eliminated'
        status = 'Classificado' if row['situacao'] == 'classificado' else 'Eliminado'
        route_name = 'Título Lib.' if row['competicao'] == 'libertadores' else 'Título Sula'
        desktop_rows.append(
            f'<tr><th scope="row">{esc(row["clube"])}</th><td><span class="analysis-status {status_class}">{status}</span></td>'
            f'<td>{row["posicao_atual"]}º → {row["posicao_projetada"]}º</td>'
            f'<td>{esc(fmt_pct(row["lib_depois"]))}</td><td class="delta {movement_class(row["lib_delta"])}">{esc(fmt_pp(row["lib_delta"]))}</td>'
            f'<td>{row["rank_antes"]}º → {row["rank_depois"]}º</td><td>{esc(fmt_pct(row["sula_depois"]))}</td>'
            f'<td>{esc(fmt_pct(row["rebaix_depois"]))}</td><td>{esc(route_name)}: {esc(fmt_pct(row["via_depois"]))} <span class="delta {movement_class(row["via_delta"])}">({esc(fmt_pp(row["via_delta"]))})</span></td></tr>'
        )
        mobile_cards.append(
            f'<article class="analysis-movement-card"><header><a href="../estatisticas.html#probabilidades">{esc(row["clube"])}</a><span>{status}</span></header>'
            f'<div class="analysis-movement-card-grid">'
            f'<div class="analysis-move-metric"><span class="analysis-move-label">Série A atual → proj.</span><b class="analysis-move-current">{row["posicao_atual"]}º → {row["posicao_projetada"]}º</b></div>'
            f'<div class="analysis-move-metric"><span class="analysis-move-label">Libertadores</span><b class="analysis-move-current">{esc(fmt_pct(row["lib_depois"]))}</b><span class="analysis-move-delta {movement_class(row["lib_delta"])}">{esc(fmt_pp(row["lib_delta"]))}</span></div>'
            f'<div class="analysis-move-metric"><span class="analysis-move-label">Ranking chance Lib.</span><b class="analysis-move-current">{row["rank_antes"]}º → {row["rank_depois"]}º</b></div>'
            f'<div class="analysis-move-metric"><span class="analysis-move-label">Sul-Americana</span><b class="analysis-move-current">{esc(fmt_pct(row["sula_depois"]))}</b></div>'
            f'<div class="analysis-move-metric"><span class="analysis-move-label">Rebaixamento</span><b class="analysis-move-current">{esc(fmt_pct(row["rebaix_depois"]))}</b></div>'
            f'<div class="analysis-move-metric"><span class="analysis-move-label">{esc(route_name)}</span><b class="analysis-move-current">{esc(fmt_pct(row["via_depois"]))}</b><span class="analysis-move-delta {movement_class(row["via_delta"])}">{esc(fmt_pp(row["via_delta"]))}</span></div>'
            f'</div></article>'
        )
    return (
        '<section class="analysis-movements"><h2>O que mudou nas probabilidades depois das partidas de volta</h2>'
        '<p class="analysis-help">Comparação do AF-Previsão entre a fotografia anterior ao fechamento das voltas e o primeiro estado após todos os jogos com brasileiros. As posições são do Brasileirão; o ranking mede a ordem dos 20 clubes pela chance total de Libertadores.</p>'
        f'<p class="analysis-snapshot-line"><span>Antes: {esc(data_curta(str(stats.get("antes_em") or "")))}</span><span>Depois: {esc(data_curta(str(stats.get("depois_em") or "")))}</span></p>'
        f'<ul class="analysis-movement-highlights">{"".join(highlights)}</ul>'
        '<p class="analysis-percent-legend"><strong>Como ler:</strong> a chance total de Libertadores combina todas as vias do modelo. A <b>via continental</b> mostra somente o caminho pelo título da competição em que o clube estava nesta fase. Assim, um eliminado pode ter alta na chance total por outras rotas, mas sua via continental passa a 0%.</p>'
        '<div class="analysis-table-wrap analysis-movement-desktop" tabindex="0" aria-label="Probabilidades dos clubes brasileiros após as oitavas continentais">'
        '<table class="analysis-table analysis-cup-prob-table"><thead><tr><th>Clube</th><th>Situação</th><th>Série A</th><th>Libertadores</th><th>Δ</th><th>Ranking Lib.</th><th>Sul-Americana</th><th>Rebaix.</th><th>Via continental</th></tr></thead><tbody>'
        + ''.join(desktop_rows) + '</tbody></table></div>'
        f'<div class="analysis-movement-mobile">{"".join(mobile_cards)}</div></section>'
    )


def build_article(rank: int, ties: Sequence[Mapping[str, Any]], mm: Mapping[str, Any], now: datetime, stats: Mapping[str, Any] | None = None, content: Mapping[str, Any] | None = None, origin: str = 'deterministico-jornalistico') -> dict[str, Any]:
    phase, slug_phase, menu_label = PHASES[rank]
    content = dict(content or editorial_copy(rank, ties))
    article_id = f'continentais-2026-{slug_phase}-brasileiros'
    slug = article_id + '.html'
    qualified = sorted({winner for tie in ties for winner in tie['br_classificados']})
    participants = sorted({club for tie in ties for club in tie['brasileiros']})
    eliminated = sorted(set(participants) - set(qualified))
    linked = sum(1 for tie in ties for event in tie['pernas'] if video_entry_valid(((mm.get('jogos') or {}).get(str(event.get('event_id') or '')) or {}), event, tie['competicao']))
    dossier = {'render_version': RENDER_VERSION, 'fase_ordem': rank, 'confrontos': ties, 'mm': mm.get('jogos') or {}, 'estatisticas': stats or {}}
    return {
        'tipo': 'continentais_fase',
        'id_editorial': article_id,
        'rotulo_menu': f'CONT · {menu_label}',
        'categoria': f'LIBERTADORES + SUL-AMERICANA · {phase.upper()}',
        'competicao': 'Libertadores + Sul-Americana',
        'fase_encerrada': phase,
        'fase_seguinte': PHASES.get(rank + 100, ('Encerramento', '', ''))[0],
        'slug': slug,
        'url': f'{SITE}/analises/{slug}',
        'titulo': content['titulo'],
        'linha_fina': content['linha_fina'],
        'publicado_em': now.isoformat(),
        'modificado_em': now.isoformat(),
        'jogos_concluidos': sum(len(tie['pernas']) for tie in ties),
        'jogos_pendentes': 0,
        'confrontos': len(ties),
        'classificados': qualified,
        'eliminados': eliminated,
        'clubes_brasileiros': participants,
        'hash_dossie': canon(dossier),
        'hash_editorial': canon(content),
        'hash_melhores_momentos': canon(mm.get('jogos') or {}),
        'hash_estatisticas': canon(stats or {}),
        'melhores_momentos_vinculados': linked,
        'editorial': content,
        'auditoria_factual': content.get('auditoria') or {},
        'email_assunto': f'Fórmula do Gol: fechamento continental de {phase}',
        'email_chamada': f'{phase} encerradas para os brasileiros. Veja classificados, agregados, melhores momentos e o impacto nas probabilidades.',
        'origem_editorial': origin,
        'hash_editorial_contexto': canon(continental_editorial_dossier(rank, ties, stats)),
    }


def render_page(article: Mapping[str, Any], ties: Sequence[Mapping[str, Any]], mm: Mapping[str, Any], all_articles: Sequence[Mapping[str, Any]], stats: Mapping[str, Any] | None = None) -> str:
    title = article['titulo']
    desc = article['linha_fina']
    published = article['publicado_em']
    modified = article['modificado_em']
    url = article['url']
    article_id = article['id_editorial']
    sections = ''.join(
        '<section class="analysis-copy-section"><h3>' + esc(section['titulo']) + '</h3>'
        + ''.join('<p>' + esc(paragraph) + '</p>' for paragraph in section['paragrafos'])
        + '</section>'
        for section in article['editorial']['secoes']
    )
    groups = []
    for comp in ('libertadores', 'sul_americana'):
        comp_ties = [tie for tie in ties if tie['competicao'] == comp]
        if not comp_ties:
            continue
        cards = ''.join(render_tie(tie, idx + 1, mm) for idx, tie in enumerate(comp_ties))
        groups.append(
            f'<section><h2>{esc(COMP_NAMES[comp])}: todos os confrontos dos brasileiros</h2>'
            f'<p class="analysis-help">{len(comp_ties)} confronto(s), com ida, volta, agregado e melhores momentos das duas partidas quando vinculados.</p>'
            f'<div class="analysis-cup-ties">{cards}</div></section>'
        )
    navigation_history = [item for item in all_articles if item.get('id_editorial') != article_id]
    navigation_history.append({'id_editorial': article_id, 'rotulo_menu': article['rotulo_menu'], 'slug': article['slug'], 'publicado_em': published})
    stats_html = render_stats(stats or {})
    head = cabecalho_html(title, desc, url, 'NewsArticle', published, modified).replace(
        'br-analises.css?v=20260811-movimentos-v1', 'br-analises.css?v=20260904-editorial-v2'
    )
    return head + f'''
<body data-fdg-editorial-id="{esc(article_id)}" data-fdg-analise-competicao="continentais">
  <div class="container analysis-shell">
    <header class="hero" aria-label="Fórmula do Gol — A matemática por trás do futebol"><img src="../img/header-formula-do-gol-v2.png" alt="Fórmula do Gol — A matemática por trás do futebol"></header>
    {menu('../', True)}
    {submenu_rodadas(navigation_history, id_ativo=article_id)}
    <main>
      <article class="analysis-article">
        <header class="analysis-article-header">
          <div class="analysis-kicker"><span>ANÁLISE</span><span>•</span><time datetime="{esc(published)}">{esc(data_curta(published))}</time></div>
          <span class="analysis-tag">{esc(article['categoria'])}</span>
          <h1>{esc(title)}</h1>
          <p class="analysis-deck">{esc(desc)}</p>
          <div class="analysis-byline">Por <a href="../sobre.html">Laércio Rehem</a></div>
        </header>
        <section class="analysis-copy"><h2>O fechamento continental dos brasileiros</h2><div class="analysis-copy-sections">{sections}</div></section>
        {''.join(groups)}
        {stats_html}
        <aside class="analysis-method"><strong>Leitura dos dados:</strong> placares, mando, fase e classificados vêm dos snapshots esportivos persistidos pelo projeto. As probabilidades são estimativas do AF-Previsão em 2.000.000 de simulações. A comparação estatística usa marcos imutáveis anterior e posterior ao fechamento das partidas de volta, identificados por hash.</aside>
        <nav class="analysis-next" aria-label="Mais conteúdo"><a href="./">← Todas as análises</a><a href="../estatisticas.html#probabilidades">Probabilidades do Brasileirão 2026 →</a></nav>
      </article>
    </main>
    {rodape('../')}
  </div>
  <script src="../js/br-menu.js?v=20260901-alertas-v1"></script>
  <script src="/js/br-social-footer.js?v=20260811-social-v2-tiktok" defer></script>
  <script src="../js/br-analises.js?v=20260821-continentais-v2" defer></script>
</body>
</html>'''


AF_SNAPSHOT_FILES = {
    'copa_do_brasil': ROOT / 'dados-br/competicoes-af-previsao/copa-do-brasil.json',
    'libertadores': ROOT / 'dados-br/competicoes-af-previsao/libertadores.json',
    'sul_americana': ROOT / 'dados-br/competicoes-af-previsao/sul-americana.json',
}


def _canonical_hash_payload(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False
    ).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def _continental_snapshots_state_hash_lightweight() -> str:
    """Reproduz o hash esportivo do AF sem importar o motor NumPy.

    O editorial só precisa provar que o arquivo público de probabilidades foi
    calculado sobre os mesmos snapshots persistidos. Importar o simulador para
    isso criava uma dependência desnecessária de NumPy no workflow editorial.
    """
    snapshots: dict[str, Mapping[str, Any]] = {}
    for key, path in AF_SNAPSHOT_FILES.items():
        data = load(path)
        if not isinstance(data, Mapping):
            raise ContinentalEditorialError(f'snapshot continental ausente ou inválido: {path.relative_to(ROOT)}')
        snapshots[key] = data

    stable: dict[str, Any] = {}
    for key, snapshot in sorted(snapshots.items()):
        stable[key] = {
            'status': snapshot.get('status'),
            'temporada': snapshot.get('temporada'),
            'competicao': snapshot.get('competicao'),
            'fase_atual': snapshot.get('fase_atual'),
            'eventos': snapshot.get('eventos') or [],
        }
    return _canonical_hash_payload(stable)


def validate_probability_alignment(snaps: Mapping[str, Mapping[str, Any]], ties: Sequence[Mapping[str, Any]], probabilities: Mapping[str, Any]) -> None:
    """Impede editorial com AF anterior ao último resultado continental."""
    # O hash publicado pelo AF cobre o universo continental inteiro usado nas
    # 2.000.000 de simulações (Copa do Brasil + Libertadores + Sul-Americana).
    # Esta validação é deliberadamente leve: não importa o simulador nem NumPy.
    # O editorial recebe apenas Lib/Sula, mas o hash precisa incluir também a
    # Copa do Brasil para ser idêntico ao produzido pelo AF-Previsão.
    try:
        current_hash = _continental_snapshots_state_hash_lightweight()
    except Exception as exc:
        raise ContinentalEditorialError(f'não foi possível calcular hash continental atual: {exc}') from exc
    af_hash = str((probabilities.get('integracao_continental') or {}).get('hash_snapshots') or '')
    if not current_hash or af_hash != current_hash:
        raise ContinentalEditorialError(
            f'AF-Previsão ainda não incorporou os snapshots continentais atuais: af={af_hash or "ausente"} atual={current_hash}'
        )
    by_name = {str(item.get('clube') or ''): item for item in probabilities.get('clubes') or []}
    for tie in ties:
        comp = str(tie.get('competicao') or '')
        qualified = set(tie.get('br_classificados') or [])
        for club in tie.get('brasileiros') or []:
            item = by_name.get(club)
            if not item:
                raise ContinentalEditorialError(f'AF-Previsão sem clube continental: {club}')
            route = route_detail(item, comp)
            possible = bool(route.get('possivel_estruturalmente'))
            value = float(route.get('percentual_estimado') or 0)
            if club in qualified:
                if not possible:
                    raise ContinentalEditorialError(f'AF-Previsão marcou classificado como estruturalmente eliminado: {club}')
            else:
                if possible or abs(value) > 1e-12:
                    raise ContinentalEditorialError(f'AF-Previsão ainda mantém via continental para eliminado: {club}')


def update_phase_cycle_state(history: dict[str, Any], rank: int, ties: Sequence[Mapping[str, Any]], *, status: str) -> bool:
    survivors = sorted({winner for tie in ties for winner in tie.get('br_classificados') or []})
    participants = sorted({club for tie in ties for club in tie.get('brasileiros') or []})
    eliminated = sorted(set(participants) - set(survivors))
    next_rank = rank + 100 if rank + 100 in PHASES else 0
    state = {
        'fase_ordem': rank,
        'fase': PHASES[rank][0],
        'status': status,
        'brasileiros_participantes': participants,
        'brasileiros_vivos': survivors,
        'brasileiros_eliminados': eliminated,
        'proxima_fase_ordem': next_rank,
        'proxima_fase': PHASES[next_rank][0] if next_rank else None,
        'regra_fechamento': 'Libertadores + Sul-Americana em conjunto; somente confrontos com brasileiros bloqueiam o fechamento.',
    }
    if history.get('estado_ciclo') == state:
        return False
    history['estado_ciclo'] = state
    return True


def current_stats_marks(rank: int, ties: Sequence[Mapping[str, Any]], history: dict[str, Any], snaps: Mapping[str, Mapping[str, Any]] | None = None) -> tuple[dict[str, Any] | None, dict[str, Any] | None, bool]:
    before_id, after_id = mark_ids(rank)
    before = find_mark(history, before_id)
    after = find_mark(history, after_id)
    changed = False
    if before is None:
        before = retro_before_from_global(rank, ties)
        if before is not None:
            changed |= update_mark(history, before)
    if after is None:
        probabilities = load(PROB_PATH, {}) or {}
        if snaps is not None:
            validate_probability_alignment(snaps, ties, probabilities)
        after = build_mark(rank, ties, probabilities, 'depois', 'primeira_fotografia_pos_fechamento')
        changed |= update_mark(history, after)
    return before, after, changed


def capture_baseline(rank: int, ties: Sequence[Mapping[str, Any]], history: dict[str, Any]) -> bool:
    before_id, _ = mark_ids(rank)
    if find_mark(history, before_id):
        return False
    probabilities = load(PROB_PATH, {}) or {}
    mark = build_mark(rank, ties, probabilities, 'antes', 'primeira_fotografia_apos_idas')
    changed = update_mark(history, mark)
    changed |= update_phase_cycle_state(history, rank, ties, status='aguardando_voltas')
    return changed


def publish(dry: bool = False, force_rank: int = 0, usar_ia: bool = False, sem_ia: bool = False) -> int:
    snaps = {key: load(path, {}) or {} for key, path in SNAPS.items()}
    history = load_cont_history()
    eligibility = editorial_eligibility(snaps, history)
    rank = force_rank or (int(eligibility.get('rank') or 0) if eligibility.get('action') == 'publish' else 0)

    if not rank:
        work_rank = int(eligibility.get('rank') or 0)
        if eligibility.get('action') == 'baseline' and work_rank:
            ties = [tie for comp, snap in snaps.items() for tie in build_ties(comp, snap, work_rank)]
            changed = capture_baseline(work_rank, ties, history)
            if changed and not dry:
                CONT_HISTORY_PATH.write_text(json.dumps(history, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            print('OK: marco anterior continental preservado.' if changed else 'NONE: marco anterior continental já preservado.')
            return 0
        print('NONE: nenhuma fase continental brasileira pronta para editorial.')
        return 0

    ties = [tie for comp, snap in snaps.items() for tie in build_ties(comp, snap, rank)]
    if not ties or not all(all(event.get('concluido') for event in tie['pernas']) for tie in ties):
        print('NONE: fase ainda não concluída no recorte brasileiro.')
        return 0

    before, after, history_changed = current_stats_marks(rank, ties, history, snaps)
    if not before or not after:
        raise ContinentalEditorialError('não foi possível formar os marcos estatísticos anterior e posterior')
    stats = stats_dossier(before, after)
    history_changed |= update_phase_cycle_state(history, rank, ties, status='aguardando_proxima_fase')
    mm = load_verified_mm()
    now = agora_br().replace(microsecond=0)
    manifest = load(MANIFEST, {'schema_version': 2, 'site': 'Fórmula do Gol', 'artigos': []}) or {'schema_version': 2, 'site': 'Fórmula do Gol', 'artigos': []}
    articles = list(manifest.get('artigos') or [])
    phase, slug_phase, _ = PHASES[rank]
    article_id = f'continentais-2026-{slug_phase}-brasileiros'
    old = next((item for item in articles if item.get('id_editorial') == article_id), None)
    editorial_context = continental_editorial_dossier(rank, ties, stats)
    context_hash = canon(editorial_context)
    fallback = editorial_copy(rank, ties, stats, editorial_verified_context(rank))
    content: Mapping[str, Any] = fallback
    origin = 'deterministico-jornalistico'
    if old and old.get('hash_editorial_contexto') == context_hash and str(old.get('origem_editorial') or '').startswith('openai:') and isinstance(old.get('editorial'), Mapping):
        content = dict(old['editorial'])
        content.setdefault('auditoria', deterministic_audit(rank, ties))
        origin = str(old.get('origem_editorial'))
        validate_continental_editorial(content, editorial_context)
        print('Dossiê continental inalterado: editorial OpenAI preservado sem nova chamada.')
    elif usar_ia and not sem_ia:
        try:
            generated, origin = generate_editorial('continentais', editorial_context, continental_editorial_schema())
            validate_continental_editorial(generated, editorial_context)
            content = generated
            print(f'Editorial continental gerado pela camada dedicada ({origin}).')
        except ContinentalEditorialVeto:
            raise
        except EditorialAIError as exc:
            print(f'::warning title=Editorial IA indisponível::Fallback continental determinístico aplicado. {exc}')
            content = fallback
            origin = 'deterministico-jornalistico-contingencia'
        except ContinentalEditorialError as exc:
            print(f'::warning title=Editorial IA inválido::Fallback continental determinístico aplicado. {exc}')
            content = fallback
            origin = 'deterministico-jornalistico-contingencia'
    try:
        validate_continental_editorial(content, editorial_context)
    except ContinentalEditorialError as exc:
        if content is fallback:
            # Fallback determinístico reprovado pelo próprio validador: isso é
            # defeito de código, não conteúdo ruim da IA. Falha com mensagem
            # inequívoca em vez de repetir o erro genérico da camada de IA.
            raise ContinentalEditorialError(f'FALLBACK DETERMINÍSTICO INVÁLIDO (corrija editorial_copy): {exc}') from exc
        raise
    article = build_article(rank, ties, mm, now, stats, content, origin)
    same = bool(old and old.get('hash_dossie') == article['hash_dossie'] and old.get('hash_melhores_momentos') == article['hash_melhores_momentos'] and old.get('hash_estatisticas') == article['hash_estatisticas'] and old.get('hash_editorial') == article['hash_editorial'])
    if same and not history_changed:
        print('NONE: editorial continental já está atualizado.')
        return 0
    if old:
        article['publicado_em'] = old.get('publicado_em') or article['publicado_em']
        articles = [article if item.get('id_editorial') == article['id_editorial'] else item for item in articles]
    else:
        articles.append(article)
    articles.sort(key=lambda item: str(item.get('publicado_em') or ''), reverse=True)
    if dry:
        print(json.dumps({'article': article, 'stats': stats}, ensure_ascii=False, indent=2))
        return 0
    if history_changed:
        CONT_HISTORY_PATH.write_text(json.dumps(history, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    manifest['artigos'] = articles
    manifest['total_artigos'] = len(articles)
    manifest['atualizado_em'] = now.isoformat()
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    CAMINHO_ANALISES.mkdir(exist_ok=True)
    gravar_texto(CAMINHO_ANALISES / article['slug'], render_page(article, ties, mm, articles, stats))
    sincronizar_submenus_artigos(articles)
    gravar_texto(CAMINHO_ANALISES / 'index.html', gerar_hub(articles))
    atualizar_sitemap(articles)
    gravar_texto(ROOT / 'news-sitemap.xml', gerar_news_sitemap(articles, now))
    gravar_texto(ROOT / 'feed.xml', gerar_feed(articles, now))
    print(f"OK: {article['slug']} publicado com {len(ties)} confrontos, {article['melhores_momentos_vinculados']} link(s) de melhores momentos e quadro estatístico pós-fase.")
    return 0


def self_test() -> None:
    snaps = {key: load(path, {}) or {} for key, path in SNAPS.items()}
    # O corpus real serve como fixture histórica das oitavas já publicadas.
    # Não usamos latest_publishable(snaps) aqui: quando a fase seguinte começa a
    # ser materializada, a resposta correta da função passa a ser None até seu
    # fechamento, sem invalidar o editorial histórico das oitavas.
    ties = [tie for comp, snap in snaps.items() for tie in build_ties(comp, snap, 600)]
    assert len(ties) == 10
    qualified = {winner for tie in ties for winner in tie['br_classificados']}
    assert len(qualified) == 8 and {'Flamengo', 'Palmeiras', 'Corinthians', 'Fluminense', 'São Paulo', 'Atlético-MG', 'Santos', 'Vasco da Gama'} <= qualified
    assert sum(len(tie['pernas']) for tie in ties) == 20
    mm = load_verified_mm()
    linked = sum(1 for tie in ties for event in tie['pernas'] if str(event.get('event_id') or '') in (mm.get('jogos') or {}))
    assert linked >= 10

    # Regressão editorial das quartas/2026: todos os 14 jogos do recorte
    # brasileiro precisam possuir vínculo de vídeo validado por partida.
    qf_ties = [tie for comp, snap in snaps.items() for tie in build_ties(comp, snap, 700)]
    if len(qf_ties) == 7:
        mm_qf = load_verified_mm()
        qf_legs = [(tie, event) for tie in qf_ties for event in tie['pernas']]
        assert len(qf_legs) == 14
        invalid_videos = [
            str(event.get('event_id') or '')
            for tie, event in qf_legs
            if not video_entry_valid(
                (mm_qf.get('jogos') or {}).get(str(event.get('event_id') or '')) or {},
                event,
                str(tie.get('competicao') or ''),
            )
        ]
        assert not invalid_videos, f'melhores momentos não validados nas quartas: {invalid_videos}'

        qf_context = editorial_verified_context(700)
        # O fallback premium precisa passar no mesmo copy desk do conteúdo OpenAI.
        validate_continental_editorial(
            editorial_copy(700, qf_ties, context=qf_context),
            continental_editorial_dossier(700, qf_ties, {}),
        )

    fake = {key: {'eventos': []} for key in snaps}
    # Regressão 2026-09-18: o fallback determinístico precisa passar no MESMO
    # validador aplicado à saída da IA. Ele continha "snapshots", termo da lista
    # proibida, e derrubava o workflow sempre que a IA falhava.
    fixture_dossier = continental_editorial_dossier(600, ties, {})
    validate_continental_editorial(editorial_copy(600, ties), fixture_dossier)
    for rank_check in PHASES:
        # Cada rank precisa passar no validador REAL, não só na lista de termos:
        # o fallback genérico também nascia curto demais (109 palavras).
        validate_continental_editorial(
            editorial_copy(rank_check, ties, context=editorial_verified_context(rank_check)),
            continental_editorial_dossier(rank_check, ties, {}),
        )

    assert latest_publishable(fake) is None
    # Regra terminal: sem brasileiro na fase seguinte não há novo editorial.
    no_br = {key: {'eventos': [{'fase_ordem': 700, 'mandante': {'serie_a_2026': False}, 'visitante': {'serie_a_2026': False}, 'concluido': True}]} for key in snaps}
    assert latest_publishable(no_br) is None
    # Próxima fase: após todas as idas, o gerador deve preservar o marco antes das voltas.
    side_br = {'espn_id': '1', 'nome': 'Brasileiro', 'serie_a_2026': True, 'placar': 1}
    side_x = {'espn_id': '2', 'nome': 'Rival', 'serie_a_2026': False, 'placar': 0}
    future = {'libertadores': {'eventos': [
        {'fase_ordem': 700, 'perna': 1, 'data_iso': '2026-09-01T21:30:00-03:00', 'mandante': dict(side_br), 'visitante': dict(side_x), 'concluido': True},
        {'fase_ordem': 700, 'perna': 2, 'data_iso': '2026-09-08T21:30:00-03:00', 'mandante': dict(side_x), 'visitante': dict(side_br), 'concluido': False},
    ]}, 'sul_americana': {'eventos': []}}
    assert latest_publishable(future) is None and baseline_ready(future, 700) is True

    # Regressão 2026-09-15: uma volta recém-finalizada não pode ser promovida
    # artificialmente para "Final" enquanto outras quartas brasileiras seguem
    # pendentes. O marco ANTES das quartas ancora a fase correta.
    history = {'marcos': [{'id': mark_ids(700)[0]}]}
    distorted = {
        'libertadores': {'eventos': [
            {'event_id': 'q1a', 'fase_ordem': 700, 'perna': 1, 'data_iso': '2026-09-08T19:00:00-03:00', 'mandante': dict(side_br), 'visitante': dict(side_x), 'concluido': True},
            {'event_id': 'q1b', 'fase_ordem': 900, 'perna': 2, 'data_iso': '2026-09-15T19:00:00-03:00', 'mandante': dict(side_x), 'visitante': dict(side_br), 'concluido': True},
            {'event_id': 'q2a', 'fase_ordem': 700, 'perna': 1, 'data_iso': '2026-09-09T19:00:00-03:00', 'mandante': {'espn_id': '3', 'nome': 'Brasileiro 2', 'serie_a_2026': True, 'placar': 1}, 'visitante': {'espn_id': '4', 'nome': 'Rival 2', 'serie_a_2026': False, 'placar': 0}, 'concluido': True},
            {'event_id': 'q2b', 'fase_ordem': 700, 'perna': 2, 'data_iso': '2026-09-16T19:00:00-03:00', 'mandante': {'espn_id': '4', 'nome': 'Rival 2', 'serie_a_2026': False, 'placar': 0}, 'visitante': {'espn_id': '3', 'nome': 'Brasileiro 2', 'serie_a_2026': True, 'placar': 0}, 'concluido': False},
        ]},
        'sul_americana': {'eventos': []},
    }
    guard = editorial_eligibility(distorted, history)
    assert guard['action'] == 'none' and guard['rank'] == 700 and guard['pendentes'] == ['q2b']
    # Mesmo sem o marco histórico, a fase inferior pendente vence a falsa
    # promoção para 900 e mantém as quartas como fase operacional ativa.
    assert latest_publishable(distorted) is None
    assert active_rank(distorted) == 700
    unanchored = editorial_eligibility(distorted, {'marcos': []})
    assert unanchored['action'] == 'baseline' and unanchored['rank'] == 700

    # Fechamento CONJUNTO: quando todos os confrontos com brasileiros terminam,
    # uma volta degradada para 900 continua pertencendo às quartas e partida
    # exclusivamente estrangeira não bloqueia o editorial.
    closed_joint = {
        'libertadores': {'eventos': [
            {'event_id': 'jl1', 'fase_ordem': 700, 'perna': 1, 'data_iso': '2026-09-10T21:30:00-03:00', 'mandante': dict(side_x), 'visitante': dict(side_br), 'concluido': True, 'vencedor': 'Brasileiro'},
            {'event_id': 'jl2', 'fase_ordem': 900, 'perna': 2, 'data_iso': '2026-09-17T21:30:00-03:00', 'mandante': dict(side_br), 'visitante': dict(side_x), 'concluido': True, 'vencedor': 'Brasileiro'},
            {'event_id': 'foreign', 'fase_ordem': 700, 'perna': 2, 'data_iso': '2026-09-18T21:30:00-03:00', 'mandante': {'espn_id': 'f1', 'nome': 'Estrangeiro A', 'serie_a_2026': False}, 'visitante': {'espn_id': 'f2', 'nome': 'Estrangeiro B', 'serie_a_2026': False}, 'concluido': False},
        ]},
        'sul_americana': {'eventos': []},
    }
    closed = editorial_eligibility(closed_joint, history)
    assert closed['action'] == 'publish' and closed['rank'] == 700 and closed['pendentes'] == []

    # Regressão Fluminense x Platense (quartas/2026): o vencedor da volta
    # pode ser diferente do classificado do confronto. O agregado tem
    # precedência absoluta quando não está empatado.
    flu = {'espn_id': 'flu', 'nome': 'Fluminense', 'serie_a_2026': True, 'placar': 0}
    pla = {'espn_id': 'pla', 'nome': 'Platense', 'serie_a_2026': False, 'placar': 0}
    aggregate_case = {'eventos': [
        {'event_id': 'flu1', 'fase_ordem': 700, 'perna': 1, 'data_iso': '2026-09-08T19:00:00-03:00',
         'mandante': {**flu, 'placar': 2}, 'visitante': {**pla, 'placar': 0}, 'concluido': True, 'vencedor': 'Fluminense'},
        {'event_id': 'flu2', 'fase_ordem': 900, 'perna': 2, 'data_iso': '2026-09-15T19:00:00-03:00',
         'mandante': {**pla, 'placar': 2}, 'visitante': {**flu, 'placar': 1}, 'concluido': True, 'vencedor': 'Platense'},
    ]}
    aggregate_tie = build_ties('libertadores', aggregate_case, 700)[0]
    assert aggregate_tie['agregado'] in ([3, 2], [2, 3])
    assert aggregate_tie['vencedor'] == 'Fluminense'
    assert aggregate_tie['br_classificados'] == ['Fluminense']
    assert aggregate_tie['eliminado'] == 'Platense'

    # Regressão Palmeiras x LDU (quartas/2026): a LDU venceu a volta por 3x2,
    # mas o Palmeiras venceu os pênaltis por 4x3. ``vencedor`` da partida não
    # pode eliminar o clube que ganhou a disputa.
    pal = {'espn_id': 'pal', 'nome': 'Palmeiras', 'serie_a_2026': True, 'placar': 0}
    ldu = {'espn_id': 'ldu', 'nome': 'Liga de Quito', 'serie_a_2026': False, 'placar': 0}
    pal_case = {'eventos': [
        {'event_id': '401912527', 'fase_ordem': 700, 'perna': 1, 'data_iso': '2026-09-09T19:00:00-03:00',
         'mandante': {**pal, 'placar': 1}, 'visitante': {**ldu, 'placar': 0}, 'concluido': True, 'vencedor': 'Palmeiras', 'penaltis': False},
        {'event_id': '401912525', 'fase_ordem': 700, 'perna': 2, 'data_iso': '2026-09-16T19:00:00-03:00',
         'mandante': {**ldu, 'placar': 3}, 'visitante': {**pal, 'placar': 2}, 'concluido': True, 'vencedor': 'Liga de Quito',
         'penaltis': {'mandante': 3, 'visitante': 4}, 'vencedor_penaltis': 'Palmeiras'},
    ]}
    pal_tie = build_ties('libertadores', pal_case, 700)[0]
    assert pal_tie['agregado'] in ([3, 3],)
    assert pal_tie['vencedor'] == 'Palmeiras' and pal_tie['eliminado'] == 'Liga de Quito'
    assert pal_tie['vencedor_penaltis'] == 'Palmeiras'

    # Empate no agregado decidido nos pênaltis continua usando o vencedor
    # explícito da volta, preservando o caso das oitavas do próprio Flu.
    pen_case = {'eventos': [
        {'event_id': 'pen1', 'fase_ordem': 600, 'perna': 1, 'data_iso': '2026-08-11T19:00:00-03:00',
         'mandante': {**flu, 'placar': 0}, 'visitante': {**pla, 'placar': 0}, 'concluido': True, 'vencedor': None},
        {'event_id': 'pen2', 'fase_ordem': 600, 'perna': 2, 'data_iso': '2026-08-18T19:00:00-03:00',
         'mandante': {**pla, 'placar': 1}, 'visitante': {**flu, 'placar': 1}, 'concluido': True, 'vencedor': None,
         'penaltis': {'mandante': 4, 'visitante': 5}, 'vencedor_penaltis': 'Fluminense'},
    ]}
    pen_tie = build_ties('libertadores', pen_case, 600)[0]
    assert pen_tie['vencedor'] == 'Fluminense' and pen_tie['br_classificados'] == ['Fluminense']

    context = continental_editorial_dossier(600, ties, {'comparacoes': []})
    deterministic = editorial_copy(600, ties)
    validate_continental_editorial(deterministic, context)
    assert deterministic['auditoria']['consistente'] is True
    assert sorted(deterministic['auditoria']['classificados_brasileiros']) == sorted(context['classificados_brasileiros'])
    cycle_history: dict[str, Any] = {}
    assert update_phase_cycle_state(cycle_history, 600, ties, status='aguardando_proxima_fase') is True
    assert cycle_history['estado_ciclo']['proxima_fase_ordem'] == 700
    assert set(cycle_history['estado_ciclo']['brasileiros_vivos']) == set(context['classificados_brasileiros'])

    # A próxima fase não pode ser considerada materializada com apenas parte
    # dos brasileiros sobreviventes já exposta pela fonte.
    a = {'espn_id': 'a', 'nome': 'A', 'serie_a_2026': True, 'placar': 1}
    b = {'espn_id': 'b', 'nome': 'B', 'serie_a_2026': True, 'placar': 1}
    xa = {'espn_id': 'xa', 'nome': 'XA', 'serie_a_2026': False, 'placar': 0}
    xb = {'espn_id': 'xb', 'nome': 'XB', 'serie_a_2026': False, 'placar': 0}
    ya = {'espn_id': 'ya', 'nome': 'YA', 'serie_a_2026': False, 'placar': 0}
    partial_next = {'libertadores': {'eventos': [
        {'event_id': 'a1', 'fase_ordem': 700, 'perna': 1, 'data_iso': '2026-09-10T19:00:00-03:00', 'mandante': dict(a), 'visitante': dict(xa), 'concluido': True, 'vencedor': 'A'},
        {'event_id': 'a2', 'fase_ordem': 700, 'perna': 2, 'data_iso': '2026-09-17T19:00:00-03:00', 'mandante': dict(xa), 'visitante': dict(a), 'concluido': True, 'vencedor': 'A'},
        {'event_id': 'b1', 'fase_ordem': 700, 'perna': 1, 'data_iso': '2026-09-10T21:30:00-03:00', 'mandante': dict(b), 'visitante': dict(xb), 'concluido': True, 'vencedor': 'B'},
        {'event_id': 'b2', 'fase_ordem': 700, 'perna': 2, 'data_iso': '2026-09-17T21:30:00-03:00', 'mandante': dict(xb), 'visitante': dict(b), 'concluido': True, 'vencedor': 'B'},
        {'event_id': 'sa1', 'fase_ordem': 800, 'perna': 1, 'data_iso': '2026-10-13T19:00:00-03:00', 'mandante': dict(a), 'visitante': dict(ya), 'concluido': True},
        {'event_id': 'sa2', 'fase_ordem': 800, 'perna': 2, 'data_iso': '2026-10-20T19:00:00-03:00', 'mandante': dict(ya), 'visitante': dict(a), 'concluido': False},
    ]}, 'sul_americana': {'eventos': []}}
    assert phase_materialized_for_survivors(partial_next, 800) is False
    assert baseline_ready(partial_next, 800) is False

    print('OK: self-test editorial continental.')


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--fase-ordem', type=int, default=0)
    parser.add_argument('--usar-ia', action='store_true', help='Usa OpenAI somente quando o fechamento continental estiver elegível')
    parser.add_argument('--sem-ia', action='store_true', help='Força o fallback jornalístico determinístico')
    parser.add_argument('--eligibility', action='store_true', help='Imprime a decisão de elegibilidade sem gerar ou alterar arquivos')
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    if args.eligibility:
        snaps = {key: load(path, {}) or {} for key, path in SNAPS.items()}
        history = load_cont_history()
        print(json.dumps(editorial_eligibility(snaps, history), ensure_ascii=False, sort_keys=True))
        return 0
    return publish(args.dry_run, args.fase_ordem, args.usar_ia, args.sem_ia)


if __name__ == '__main__':
    raise SystemExit(main())
