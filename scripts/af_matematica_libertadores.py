"""HOTFIX R35-R1: prova combinatória conservadora de G4/G5/G6.

Não simula gols nem altera o Monte Carlo. Para provar uma posição no Gk,
considera o cenário pior para o clube-alvo (perder todos os seus jogos)
e o cenário melhor para TODOS os rivais simultaneamente, com exceção dos
confrontos diretos entre rivais que obrigatoriamente repartem pontos.

Empate em pontos e vitórias é pessimisticamente contado como ultrapassagem,
pois o saldo de gols não está limitado nesse modelo. Portanto o limite é
superior seguro: pode deixar de certificar um fato, nunca certificar errado.
"""
from __future__ import annotations

from itertools import product

MAX_CONFLICT_GAMES = 11  # custo máximo 3**11, apenas em disputas próximas


def upper_rank_bound(name, standings, remaining_fixtures):
    """Retorna limite superior seguro de posição final, ou None por custo.

    standings: clube -> {pontos, vitorias}.
    remaining_fixtures: [(mandante, visitante), ...] com cada partida uma vez.
    """
    if name not in standings:
        return None
    all_games = [(a, b) for a, b in remaining_fixtures if a != b]
    games_per = {team: 0 for team in standings}
    for a, b in all_games:
        if a in games_per:
            games_per[a] += 1
        if b in games_per:
            games_per[b] += 1

    target_points = int(standings[name]["pontos"])
    target_wins = int(standings[name]["vitorias"])
    # Cenário pessimista: o alvo perde todos os jogos restantes.
    rivals = {}
    for other, row in standings.items():
        if other == name:
            continue
        max_points = int(row["pontos"]) + 3 * games_per[other]
        max_wins = int(row["vitorias"]) + games_per[other]
        if max_points > target_points or (
            max_points == target_points and max_wins >= target_wins
        ):
            rivals[other] = (max_points, max_wins)
    if not rivals:
        return 1

    # Para jogos contra o alvo, a vitória do adversário já está incluída
    # na hipótese pessimista. Jogos contra terceiros são vitórias fictícias
    # de cada rival (sobreaproximação proposital, portanto segura).
    # Só as partidas entre dois rivais precisam ser combinadas.
    conflicts = [(a, b) for a, b in all_games if a in rivals and b in rivals]
    if len(conflicts) > MAX_CONFLICT_GAMES:
        return None
    best_above = 0
    names = list(rivals)
    for outcomes in product((0, 1, 2), repeat=len(conflicts)):
        points = {team: rivals[team][0] for team in names}
        wins = {team: rivals[team][1] for team in names}
        for (a, b), result in zip(conflicts, outcomes):
            if result == 0:      # A vence: B não pode também ganhar
                points[b] -= 3
                wins[b] -= 1
            elif result == 2:    # B vence
                points[a] -= 3
                wins[a] -= 1
            else:                # empate concede 1 ponto, 0 vitórias
                points[a] -= 2
                points[b] -= 2
                wins[a] -= 1
                wins[b] -= 1
        above = sum(
            points[team] > target_points
            or (points[team] == target_points and wins[team] >= target_wins)
            for team in names
        )
        best_above = max(best_above, above)
        if best_above == len(rivals):
            break
    return best_above + 1


def certify_top_k(structural, standings, fixtures):
    """Anota provas suficientes sem apagar uma prova anterior."""
    for team in standings:
        worst = upper_rank_bound(team, standings, fixtures)
        if worst is None:
            continue
        current = structural.get(team) or {}
        for field, k in (("g4", 4), ("libertadores_base", 5), ("g6", 6)):
            item = current.get(field)
            if item is not None and worst <= k:
                item["certo"] = True
                item["possivel"] = True
                item["motivo_certeza"] = (
                    f"Certificação combinatória: no máximo {worst}º lugar; "
                    "todos os resultados restantes, confrontos diretos, "
                    "pontos e vitórias considerados, com demais desempates "
                    "tratados pessimisticamente."
                )
        relegation = current.get("rebaixamento")
        if relegation is not None:
            previous = int(relegation.get("pior_posicao_possivel") or 20)
            if worst < previous:
                relegation["pior_posicao_possivel"] = worst
                relegation["certificado_por_confrontos"] = True
    return structural


def cup_g6_guaranteed(cup_snapshot, structural):
    """Só afirma G6 após identificar os DOIS finalistas e Palmeiras G4.

    Um eventual rebaixamento do Grêmio não reduz o G6: suas vagas retornam
    ao Brasileirão. Não presume campeões de Libertadores/Sul-Americana.
    """
    events = [
        e for e in (cup_snapshot.get("eventos") or [])
        if int(e.get("fase_ordem") or 0) == 900
    ]
    if len(events) != 1:
        return False
    final = events[0]
    clubs = {
        str((final.get(side) or {}).get("nome") or "").strip()
        for side in ("mandante", "visitante")
    }
    return (
        clubs == {"Palmeiras", "Grêmio"}
        and (structural.get("Palmeiras") or {}).get("g4", {}).get("certo") is True
    )


def apply_g6_continental_certainty(teams, structural, cup_snapshot, certifier):
    """Converte uma prova de G6 + vaga regulamentar em 100% estrutural.

    Requer probabilidades de 100% nos 2 milhões de cenários, não altera
    as ocorrências, percentuais, rankings projetados nem estatísticas.
    """
    if not cup_g6_guaranteed(cup_snapshot, structural):
        return []
    certified = []
    for item in teams:
        name = item["clube"]
        proof = (structural.get(name) or {}).get("g6") or {}
        if proof.get("certo") is not True:
            continue
        p = item["probabilidades_pct"]
        if any(float(p.get(key, -1)) != expected for key, expected in (
            ("libertadores", 100), ("sul_americana", 0),
            ("sem_competicao_continental", 0),
        )):
            # Uma prova matemática não pode contradizer o universo de
            # simulações. Falha fechada em vez de maquiar percentuais.
            raise ValueError(f"G6 matemático contradiz AF continental: {name}")
        reason = (
            str(proof.get("motivo_certeza") or "G6 matematicamente garantido")
            + " O G6 dá vaga à Libertadores pelo repasse da Copa do Brasil "
              "(final Palmeiras x Grêmio); a fase exata ainda depende do cenário."
        )
        details = item["probabilidades_detalhes"]
        # G5 already enjoys a stronger independent proof: preserve its
        # specific cause and exclusive continental-route certification.
        if details.get("libertadores", {}).get("certeza_estrutural") is True:
            continue
        decomposed = item["decomposicao_chances"]
        for field in ("libertadores", "sul_americana", "sem_competicao_continental"):
            certain = field == "libertadores"
            certifier(details[field], certain, reason)
            certifier(decomposed[field]["total"], certain, reason)
        # Rotas ainda são probabilísticas: não certifica G5, via Copa ou
        # repasses individualmente sem conhecer a classificação final.
        item["situacao_matematica"] = {
            **item.get("situacao_matematica", {}),
            "destino_continental": "libertadores_confirmado",
            "fundamento_continental": reason,
            "limite_posicao_pior": int(
                (structural[name].get("rebaixamento") or {})
                .get("pior_posicao_possivel") or 6
            ),
        }
        certified.append(name)
    return certified


def certify_cup_finalist_exclusion(teams, cup_snapshot, config):
    """Prova de exclusão da Sula para finalistas elegíveis à Copa 2026.

    REC da Copa aplicado pelo alocador continental: se permanece na Série A,
    finalista recebe Libertadores (ou já está classificado); se rebaixado,
    sua vaga da Copa retorna e a posição não alcança a faixa continental.
    Não depende do número de ocorrências observadas, nem altera o Monte Carlo.
    """
    if cup_snapshot.get("status") != "ok" or cup_snapshot.get("temporada") != 2026:
        return []
    finals = [e for e in cup_snapshot.get("eventos", []) if int(e.get("fase_ordem") or 0) == 900]
    if len(finals) != 1:
        return []
    final = finals[0]
    names = {str((final.get(side) or {}).get("nome") or "") for side in ("mandante", "visitante")}
    if len(names) != 2 or "" in names or not names <= {t["clube"] for t in teams}:
        return []
    # Quatro vagas adicionais no máximo: dois finalistas e dois campeões
    # continentais. Repasses redistribuem, não criam vagas.
    max_rank = int(config.get("brasileirao_vagas_diretas", 4)) + int(config.get("brasileirao_vagas_preliminares", 1)) + 4 + int(config.get("sul_americana_vagas", 6))
    if int(config.get("rebaixamento_a_partir_da_posicao", 17)) <= max_rank:
        return []
    certified = []
    for item in teams:
        if item["clube"] not in names:
            continue
        p = item["probabilidades_pct"]
        detail = item["probabilidades_detalhes"]["sul_americana"]
        breakdown = item["decomposicao_chances"]["sul_americana"]
        targets = [detail, breakdown["total"], *breakdown["vias"].values()]
        if float(p["sul_americana"]) != 0 or any(int(d["ocorrencias"]) != 0 or float(d["percentual_estimado"]) != 0 for d in targets):
            raise ValueError(f"Prova de exclusão da Sul-Americana contradiz Monte Carlo: {item['clube']}")
        reason = (
            "Finalista da Copa do Brasil 2026: permanecendo na Série A 2027, "
            "tem direito à Libertadores ou já está classificado por outra via. "
            f"Se rebaixado, não pode exercer a vaga da Copa e termina fora do limite máximo de {max_rank} classificados continentais pelo campeonato. "
            "Em nenhum cenário a Sul-Americana é seu destino."
        )
        # Preserve stronger independent proofs already established for G5/G6.
        for d in targets:
            if d.get("impossivel_estruturalmente") is True and d.get("motivo_impossibilidade"):
                continue
            d.update(exibicao="0%", possivel_estruturalmente=False,
                     impossivel_estruturalmente=True, certeza_estrutural=False,
                     motivo_certeza=None, motivo_impossibilidade=reason,
                     limite_superior_95_regra_dos_tres_pct=None)
        item["situacao_matematica"] = {
            **item.get("situacao_matematica", {}),
            "sul_americana_impossivel_final_copa": True,
            "fundamento_sul_americana": reason,
        }
        certified.append(item["clube"])
    return certified


def self_test():
    data={
        "Flamengo":{"pontos":79,"vitorias":24},
        "Palmeiras":{"pontos":73,"vitorias":21},
        "Cruzeiro":{"pontos":63,"vitorias":19},
        "Fluminense":{"pontos":60,"vitorias":17},
        "Athletico-PR":{"pontos":54,"vitorias":15},
        "Bahia":{"pontos":54,"vitorias":14},
        "Atlético-MG":{"pontos":51,"vitorias":14},
    }
    fixtures=[
        ("Bahia","Coritiba"),("Bahia","Botafogo"),("Bahia","Atlético-MG"),
        ("Athletico-PR","Remo"),("Athletico-PR","Mirassol"),("Athletico-PR","São Paulo"),
        ("Atlético-MG","Corinthians"),("Atlético-MG","Vasco da Gama"),
        ("Fluminense","Mirassol"),("Fluminense","Cruzeiro"),("Bragantino","Fluminense"),
        ("Cruzeiro","Chapecoense"),("Cruzeiro","Internacional"),
    ]
    assert upper_rank_bound("Fluminense",data,fixtures)==6
    assert upper_rank_bound("Cruzeiro",data,fixtures)<=4
    # Sem confronto Bahia x Atlético, todos poderiam ganhar tudo;
    # não se certifica G6 onde a prova é insuficiente.
    different=[x for x in fixtures if set(x)!={"Bahia","Atlético-MG"}]
    different.append(("Bahia","Time neutro"))
    different.append(("Atlético-MG","Outro neutro"))
    assert upper_rank_bound("Fluminense",data,different)>=7
    cup={"eventos":[{"fase_ordem":900,"mandante":{"nome":"Grêmio"},
                    "visitante":{"nome":"Palmeiras"}}]}
    assert cup_g6_guaranteed(cup,{"Palmeiras":{"g4":{"certo":True}}})
    assert not cup_g6_guaranteed(cup,{"Palmeiras":{"g4":{"certo":False}}})
    print("R35-R1 combinatorial certification: PASS")


if __name__ == "__main__":
    self_test()
