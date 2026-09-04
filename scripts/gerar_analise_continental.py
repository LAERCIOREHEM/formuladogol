#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import sys
from datetime import datetime
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
RENDER_VERSION = 8


class ContinentalEditorialError(RuntimeError):
    pass


def load(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return default


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


def phase_events(snapshot: Mapping[str, Any], rank: int) -> list[dict[str, Any]]:
    return [
        e for e in snapshot.get('eventos') or []
        if int(e.get('fase_ordem') or 0) == rank
        and (br(e.get('mandante') or {}) or br(e.get('visitante') or {}))
    ]


def ranks_with_brazilians(snaps: Mapping[str, Mapping[str, Any]]) -> list[int]:
    return sorted({
        int(e.get('fase_ordem') or 0)
        for snapshot in snaps.values()
        for e in snapshot.get('eventos') or []
        if int(e.get('fase_ordem') or 0) in PHASES
        and (br(e.get('mandante') or {}) or br(e.get('visitante') or {}))
    })


def tie_key(event: Mapping[str, Any]) -> tuple[str, str]:
    return tuple(sorted((team_key(event.get('mandante') or {}), team_key(event.get('visitante') or {}))))


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
        winner = str(last.get('vencedor') or '').strip()
        if not winner and len(legs) >= 2 and agg[team_key(a)] != agg[team_key(b)]:
            winner = nm(a) if agg[team_key(a)] > agg[team_key(b)] else nm(b)
        if not winner:
            for event in reversed(legs):
                if event.get('vencedor'):
                    winner = str(event['vencedor'])
                    break
        loser = next((x for x in (nm(a), nm(b)) if x != winner), '')
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
        if prev_br_winners and not current:
            return False
    return True


def latest_publishable(snaps: Mapping[str, Mapping[str, Any]]) -> int | None:
    ranks = ranks_with_brazilians(snaps)
    if not ranks:
        return None
    # Só a fase brasileira mais avançada pode gerar uma nova edição. Se ela já
    # começou e ainda está em disputa, não voltamos artificialmente à fase anterior.
    rank = ranks[-1]
    events = [event for snapshot in snaps.values() for event in phase_events(snapshot, rank)]
    if events and all(bool(event.get('concluido')) for event in events) and phase_materialized_for_survivors(snaps, rank):
        return rank
    return None


def active_rank(snaps: Mapping[str, Mapping[str, Any]]) -> int | None:
    ranks = ranks_with_brazilians(snaps)
    return ranks[-1] if ranks else None


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


def video_card(event_id: str, mm: Mapping[str, Any]) -> str:
    video = (mm.get('jogos') or {}).get(str(event_id)) or {}
    url = str(video.get('url') or '').strip()
    title = esc(video.get('titulo') or 'Melhores momentos')
    source = esc(video.get('fonte') or 'Vídeo')
    if not url:
        return '<p class="analysis-video-missing">Melhores momentos ainda não vinculados.</p>'
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
            f'<small>📍 {esc(event.get("estadio") or "—")}</small>{video_card(eid, mm)}</div>'
        )
    return (
        f'<article class="analysis-cup-tie"><header><span>{esc(COMP_NAMES[tie["competicao"]])} · CONFRONTO {idx}</span><b>ENCERRADO</b></header>'
        f'<div class="analysis-cup-matchup">{teams[0]}<div class="analysis-cup-aggregate"><span>AGREGADO</span>'
        f'<strong>{aggregate[0]} × {aggregate[1]}</strong>{penalty_text(tie)}</div>{teams[1]}</div>'
        f'<div class="analysis-cup-legs">{"".join(legs_html)}</div><footer><strong>Classificado: {esc(winner)}</strong>'
        f'<span>Eliminado: {esc(loser)}</span></footer></article>'
    )


def editorial_copy(rank: int, ties: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    qualified = sorted({winner for tie in ties for winner in tie['br_classificados']})
    participants = sorted({club for tie in ties for club in tie['brasileiros']})
    eliminated = sorted(set(participants) - set(qualified))
    if rank == 600:
        return {
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
    phase = PHASES[rank][0]
    return {
        'titulo': f'{phase} continentais: brasileiros definem seus caminhos na Libertadores e Sul-Americana',
        'linha_fina': f'Fechamento dos confrontos de {phase.lower()} que envolveram clubes brasileiros nas duas competições continentais.',
        'secoes': [
            {'titulo': f'O fechamento de {phase.lower()}', 'paragrafos': [
                f'Os confrontos de {phase.lower()} com participação brasileira estão concluídos. O Fórmula do Gol considera somente as chaves que tiveram ao menos um clube da Série A 2026 e não espera partidas exclusivamente estrangeiras para encerrar o editorial.',
                f'Nesta fase, {len(participants)} brasileiro(s) participaram do recorte e {len(qualified)} avançaram. Os placares de ida, volta, agregado e eventuais decisões por pênaltis são apresentados a partir dos snapshots oficiais do projeto.',
            ]},
            {'titulo': 'Quem segue e quem se despede', 'paragrafos': [
                ('Classificados: ' + ', '.join(qualified) + '.') if qualified else 'Nenhum clube brasileiro avançou nesta fase.',
                ('Eliminados: ' + ', '.join(eliminated) + '.') if eliminated else 'Nenhum clube brasileiro foi eliminado nesta fase.',
            ]},
            {'titulo': 'Próxima fase', 'paragrafos': [
                'O gerador só voltará a publicar quando existir uma nova fase eliminatória materializada nos snapshots com participação de clube brasileiro e todos os jogos desse recorte estiverem encerrados.',
                'Se não houver brasileiro na fase seguinte, não será criado novo editorial continental.',
            ]},
        ],
    }


def continental_editorial_schema() -> dict[str, Any]:
    return {
        'type': 'object',
        'additionalProperties': False,
        'properties': {
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
        'required': ['titulo', 'linha_fina', 'secoes'],
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
    return {
        'competicao': 'Libertadores + Sul-Americana',
        'fase_ordem': rank,
        'fase_encerrada': PHASES[rank][0],
        'fase_seguinte': PHASES.get(rank + 100, ('Encerramento', '', ''))[0],
        'classificados_brasileiros': qualified,
        'eliminados_brasileiros': eliminated,
        'participantes_brasileiros': participants,
        'confrontos': confrontos,
        'probabilidades_e_movimentos': comparisons,
        'simulacoes': 2_000_000,
    }


def validate_continental_editorial(editorial: Mapping[str, Any], dossier: Mapping[str, Any]) -> None:
    if set(editorial) != {'titulo', 'linha_fina', 'secoes'}:
        raise ContinentalEditorialError('editorial continental fora do schema')
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
    forbidden = ('dossiê', 'snapshot', 'a narrativa', 'mergulhar', 'jornada')
    if any(term in folded for term in forbidden):
        raise ContinentalEditorialError('editorial continental contém linguagem burocrática/artificial')
    words = len(re.findall(r'\b[\wÀ-ÿ-]+\b', ' '.join(p for sec in sections for p in sec.get('paragrafos') or [])))
    if not 180 <= words <= 1000:
        raise ContinentalEditorialError(f'editorial continental fora do tamanho esperado: {words} palavras')


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
    linked = sum(1 for tie in ties for event in tie['pernas'] if ((mm.get('jogos') or {}).get(str(event.get('event_id') or '')) or {}).get('url'))
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


def current_stats_marks(rank: int, ties: Sequence[Mapping[str, Any]], history: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any] | None, bool]:
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
        after = build_mark(rank, ties, probabilities, 'depois', 'primeira_fotografia_pos_fechamento')
        changed |= update_mark(history, after)
    return before, after, changed


def capture_baseline(rank: int, ties: Sequence[Mapping[str, Any]], history: dict[str, Any]) -> bool:
    before_id, _ = mark_ids(rank)
    if find_mark(history, before_id):
        return False
    probabilities = load(PROB_PATH, {}) or {}
    mark = build_mark(rank, ties, probabilities, 'antes', 'primeira_fotografia_apos_idas')
    return update_mark(history, mark)


def publish(dry: bool = False, force_rank: int = 0, usar_ia: bool = False, sem_ia: bool = False) -> int:
    snaps = {key: load(path, {}) or {} for key, path in SNAPS.items()}
    history = load_cont_history()
    rank = force_rank or latest_publishable(snaps)

    if not rank:
        work_rank = active_rank(snaps)
        if work_rank and baseline_ready(snaps, work_rank):
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

    before, after, history_changed = current_stats_marks(rank, ties, history)
    if not before or not after:
        raise ContinentalEditorialError('não foi possível formar os marcos estatísticos anterior e posterior')
    stats = stats_dossier(before, after)
    mm = load(MM_PATH, {'jogos': {}}) or {'jogos': {}}
    now = agora_br().replace(microsecond=0)
    manifest = load(MANIFEST, {'schema_version': 2, 'site': 'Fórmula do Gol', 'artigos': []}) or {'schema_version': 2, 'site': 'Fórmula do Gol', 'artigos': []}
    articles = list(manifest.get('artigos') or [])
    phase, slug_phase, _ = PHASES[rank]
    article_id = f'continentais-2026-{slug_phase}-brasileiros'
    old = next((item for item in articles if item.get('id_editorial') == article_id), None)
    editorial_context = continental_editorial_dossier(rank, ties, stats)
    context_hash = canon(editorial_context)
    fallback = editorial_copy(rank, ties)
    content: Mapping[str, Any] = fallback
    origin = 'deterministico-jornalistico'
    if old and old.get('hash_editorial_contexto') == context_hash and str(old.get('origem_editorial') or '').startswith('openai:') and isinstance(old.get('editorial'), Mapping):
        content = old['editorial']
        origin = str(old.get('origem_editorial'))
        validate_continental_editorial(content, editorial_context)
        print('Dossiê continental inalterado: editorial OpenAI preservado sem nova chamada.')
    elif usar_ia and not sem_ia:
        try:
            generated, origin = generate_editorial('continentais', editorial_context, continental_editorial_schema())
            validate_continental_editorial(generated, editorial_context)
            content = generated
            print(f'Editorial continental gerado pela camada dedicada ({origin}).')
        except (EditorialAIError, ContinentalEditorialError) as exc:
            print(f'::warning title=Editorial IA indisponível::Fallback continental determinístico aplicado. {exc}')
            content = fallback
            origin = 'deterministico-jornalistico-contingencia'
    validate_continental_editorial(content, editorial_context)
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
    mm = load(MM_PATH, {'jogos': {}}) or {'jogos': {}}
    linked = sum(1 for tie in ties for event in tie['pernas'] if str(event.get('event_id') or '') in (mm.get('jogos') or {}))
    assert linked >= 10
    fake = {key: {'eventos': []} for key in snaps}
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
    context = continental_editorial_dossier(600, ties, {'comparacoes': []})
    validate_continental_editorial(editorial_copy(600, ties), context)
    print('OK: self-test editorial continental.')


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--fase-ordem', type=int, default=0)
    parser.add_argument('--usar-ia', action='store_true', help='Usa OpenAI somente quando o fechamento continental estiver elegível')
    parser.add_argument('--sem-ia', action='store_true', help='Força o fallback jornalístico determinístico')
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    return publish(args.dry_run, args.fase_ordem, args.usar_ia, args.sem_ia)


if __name__ == '__main__':
    raise SystemExit(main())
