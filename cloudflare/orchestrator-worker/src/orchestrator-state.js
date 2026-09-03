import {
  POLICY,
  actionKey,
  brDateKey,
  continentalDecision,
  cupEditorialDecision,
  latestEligibleRound,
  liveCheckpointDue,
  liveLinkedIds,
  liveSearchAllowed,
  localFinalIds,
  minutesBetween,
  mmRetryInterval,
  normalizeAgenda,
  parseDate,
  pendingHighlights,
  pendingPublicsFromAudit,
  publicRetryInterval,
  relevantSportsGames,
  resultFinalTime,
  timeReached,
  tvCoverage,
  tvIntervalHours,
} from './logic.js';
import { activeWriter, dispatchSpec, dispatchWorkflow } from './github.js';
import { fetchSiteBundle, probeEspn, repositoryFallbacks } from './sources.js';

// O caminho rápido roda a cada minuto e precisa ser extremamente barato:
// a agenda já contém event_id, competição, horário e o estado local concluído.
// Os snapshots pesados ficam para a avaliação lenta (5 min).
const FAST_PATHS = [
  'dados-br/agenda-clubes-br.json',
];

const SLOW_PATHS = [
  'resultados.json',
  'dados-br/competicoes-af-previsao/copa-do-brasil.json',
  'dados-br/competicoes-af-previsao/libertadores.json',
  'dados-br/competicoes-af-previsao/sul-americana.json',
  'dados-br/status-atualizacao.json',
  'dados-br/estado-publicos-ia.json',
  'dados-br/auditoria-publicos.json',
  'dados-br/melhores-momentos.json',
  'dados-br/melhores-momentos-manual.json',
  'dados-br/auditoria-melhores-momentos.json',
  'dados-br/melhores-momentos-copa-do-brasil.json',
  'dados-br/transmissoes-aovivo.json',
  'dados-br/transmissoes-aovivo-manual.json',
  'dados-br/transmissoes-tv.json',
  'dados-br/auditoria-transmissoes-tv.json',
  'dados-br/calendario-completo.json',
  'dados-br/config-analises.json',
  'dados-br/analises.json',
  'dados-br/historico-probabilidades-continentais.json',
];

function data(bundle, path, fallback = {}) {
  const row = bundle?.[path];
  return row?.data ?? fallback;
}

function bundleErrors(bundle) {
  return Object.entries(bundle || {}).filter(([, row]) => row?.error).map(([path, row]) => `${path}: ${row.error}`);
}
function bundleReady(bundle, paths) {
  return paths.every((path) => Boolean(bundle?.[path]) && !bundle[path]?.error && bundle[path]?.data != null);
}


function gameLabel(game) {
  return `${game?.home || '?'} x ${game?.away || '?'}`;
}

function toIso(value) {
  const d = parseDate(value);
  return d ? d.toISOString() : '';
}

function isAfter(a, b) {
  const da = parseDate(a);
  const db = parseDate(b);
  return Boolean(da && db && da.getTime() >= db.getTime());
}

function dueFromLast(last, now, intervalMinutes) {
  if (!last) return true;
  return minutesBetween(last, now) >= Number(intervalMinutes || 0);
}

function cupPendingHighlights(cup, cupHighlights, now) {
  const pendingIds = new Set((cupHighlights?.pendentes || []).map(String));
  if (!pendingIds.size) return [];
  const rows = [];
  for (const event of cup?.eventos || []) {
    const eventId = String(event?.event_id || '');
    if (!eventId || !pendingIds.has(eventId) || !event?.concluido) continue;
    const kickoff = parseDate(event?.data_iso);
    const ended = kickoff ? new Date(kickoff.getTime() + 115 * 60000) : new Date(parseDate(now).getTime() - POLICY.melhoresMomentos.firstAfterFinalMinutes * 60000);
    if (minutesBetween(ended, now) < POLICY.melhoresMomentos.firstAfterFinalMinutes) continue;
    rows.push({ eventId, ended, ageMinutes: minutesBetween(ended, now), row: event, round: 0 });
  }
  return rows;
}

export class OrchestratorState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.busy = false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/tick') {
      if (request.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
      const result = await this.tick();
      return Response.json(result);
    }
    if (url.pathname === '/status') {
      return Response.json(await this.status());
    }
    if (url.pathname === '/history') {
      return Response.json({ ok: true, history: (await this.state.storage.get('history')) || [] });
    }
    return new Response('not_found', { status: 404 });
  }

  async status() {
    const status = (await this.state.storage.get('status')) || {};
    const history = (await this.state.storage.get('history')) || [];
    return {
      ok: true,
      engine: 'fdg-cloudflare-orchestrator',
      version: String(this.env.ORCHESTRATOR_VERSION || '1.0.1'),
      mode: String(this.env.ORCHESTRATOR_MODE || 'shadow'),
      ...status,
      recentDecisions: history.slice(-10).reverse(),
    };
  }

  async record(status, historyItem = null) {
    await this.state.storage.put('status', status);
    if (!historyItem) return;
    const history = (await this.state.storage.get('history')) || [];
    const signature = JSON.stringify([historyItem.action, historyItem.eventId || '', historyItem.round || '', historyItem.checkpoint ?? '', historyItem.result || '', historyItem.reason || '']);
    const last = history.at(-1);
    const lastSig = last ? JSON.stringify([last.action, last.eventId || '', last.round || '', last.checkpoint ?? '', last.result || '', last.reason || '']) : '';
    if (signature === lastSig && minutesBetween(last?.at, historyItem.at) < 15) return;
    history.push(historyItem);
    await this.state.storage.put('history', history.slice(-60));
  }

  async storageDate(key) {
    const value = await this.state.storage.get(key);
    return parseDate(value);
  }

  async candidateAllowedByRetry(candidate, now) {
    const key = `dispatch:${actionKey(candidate)}`;
    const last = await this.storageDate(key);
    const retry = Number(candidate.retryMinutes || 0);
    return { allowed: dueFromLast(last, now, retry), key, last };
  }

  async dispatchCandidate(candidate, now) {
    const mode = String(this.env.ORCHESTRATOR_MODE || 'shadow').toLowerCase();
    const retry = await this.candidateAllowedByRetry(candidate, now);
    if (!retry.allowed) {
      return { result: 'cooldown', reason: `cooldown ${candidate.retryMinutes} min ainda ativo`, candidate };
    }
    if (mode !== 'active') {
      return { result: 'shadow', reason: 'SHADOW: decisão registrada sem chamar GitHub', candidate };
    }

    const writer = await activeWriter(this.env);
    if (writer) {
      return {
        result: 'blocked_writer',
        reason: `writer ativo: ${writer.name} (${writer.status})`,
        candidate,
      };
    }

    const spec = dispatchSpec(candidate);
    await dispatchWorkflow(this.env, spec.workflow, spec.inputs);
    const updates = { [retry.key]: now.toISOString() };
    for (const [key, value] of Object.entries(candidate.stateUpdates || {})) updates[key] = value;
    await Promise.all(Object.entries(updates).map(([key, value]) => this.state.storage.put(key, value)));
    return { result: 'dispatched', reason: `${spec.workflow} solicitado ao GitHub`, candidate, workflow: spec.workflow };
  }

  async tick() {
    if (this.busy) return { ok: true, skipped: 'busy' };
    this.busy = true;
    const now = new Date();
    const mode = String(this.env.ORCHESTRATOR_MODE || 'shadow').toLowerCase();
    const errors = [];
    let candidate = null;
    let dispatchResult = { result: 'none', reason: 'nenhuma ação útil' };
    let slowEvaluated = false;
    let relevantCount = 0;
    let hints = {};

    try {
      const fastBundle = await fetchSiteBundle(this.env, FAST_PATHS);
      errors.push(...bundleErrors(fastBundle));
      const agendaPayload = data(fastBundle, 'dados-br/agenda-clubes-br.json', { jogos: [] });
      const games = normalizeAgenda(agendaPayload);
      const relevant = relevantSportsGames(games, now);
      relevantCount = relevant.length;
      const espn = relevant.length ? await probeEspn(relevant) : { states: new Map(), errors: [] };
      errors.push(...espn.errors);

      for (const game of relevant) {
        // Fail closed: só existe candidato quando a agenda pública foi lida e
        // ainda marca o jogo como não concluído.
        if (!bundleReady(fastBundle, ['dados-br/agenda-clubes-br.json'])) continue;
        if (espn.states.get(game.eventId)?.state !== 'post' || game.concluded) continue;
        candidate = {
          action: 'atualizar_brasileirao', eventId: game.eventId,
          reason: `ESPN marcou FINAL ainda não incorporado: ${gameLabel(game)}.`,
          retryMinutes: POLICY.sports.finalRetryMinutes,
        };
        break;
      }

      if (!candidate && espn.errors.length) {
        for (const game of relevant) {
          if (!bundleReady(fastBundle, ['dados-br/agenda-clubes-br.json'])) continue;
          if (game.concluded || espn.states.has(game.eventId)) continue;
          const elapsed = (now.getTime() - game.kickoff.getTime()) / 60000;
          const cupLike = /copa|libert|sul/i.test(game.competition);
          const fallback = cupLike ? 160 : 130;
          if (elapsed < fallback) continue;
          candidate = {
            action: 'atualizar_brasileirao', eventId: game.eventId,
            reason: `Contingência pós-jogo: ESPN indisponível e ${gameLabel(game)} ultrapassou ${fallback} min sem FINAL publicado.`,
            retryMinutes: POLICY.sports.finalRetryMinutes,
          };
          break;
        }
      }

      if (!candidate) {
        const lastSlow = await this.storageDate('meta:lastSlowEval');
        if (!lastSlow || minutesBetween(lastSlow, now) >= POLICY.slowEvalMinutes) {
          slowEvaluated = true;
          const slowBundle = await fetchSiteBundle(this.env, SLOW_PATHS);
          errors.push(...bundleErrors(slowBundle));
          const slow = await this.slowDecision({ now, games, bundle: slowBundle, fastBundle });
          hints = slow?.hints || (await this.state.storage.get('meta:lastHints')) || {};
          candidate = slow?.action && slow.action !== 'none' ? slow : null;
          if (candidate?.hints) delete candidate.hints;
          await this.state.storage.put('meta:lastSlowEval', now.toISOString());
          await this.state.storage.put('meta:lastHints', hints);
        } else {
          hints = (await this.state.storage.get('meta:lastHints')) || {};
        }
      }

      if (candidate) dispatchResult = await this.dispatchCandidate(candidate, now);

      const status = {
        lastTickAt: now.toISOString(),
        mode,
        relevantSportsGames: relevantCount,
        slowEvaluated,
        candidate: candidate ? {
          action: candidate.action,
          eventId: candidate.eventId || '',
          round: candidate.round || '',
          checkpoint: candidate.checkpoint ?? null,
          reason: candidate.reason,
        } : null,
        result: dispatchResult.result,
        resultReason: dispatchResult.reason,
        errors: errors.slice(0, 12),
        hints,
      };
      const historyItem = candidate ? {
        at: now.toISOString(), action: candidate.action, eventId: candidate.eventId || '', round: candidate.round || '',
        checkpoint: candidate.checkpoint ?? null, reason: candidate.reason, result: dispatchResult.result,
      } : (errors.length ? { at: now.toISOString(), action: 'none', reason: errors[0], result: 'degraded' } : null);
      await this.record(status, historyItem);
      return { ok: true, ...status };
    } catch (error) {
      const message = `${error?.name || 'Error'}: ${error?.message || error}`;
      errors.push(message);
      const status = {
        lastTickAt: now.toISOString(), mode, relevantSportsGames: relevantCount, slowEvaluated,
        candidate: null, result: 'error', resultReason: message, errors: errors.slice(0, 12), hints,
      };
      await this.record(status, { at: now.toISOString(), action: 'none', reason: message, result: 'error' });
      return { ok: false, ...status };
    } finally {
      this.busy = false;
    }
  }

  async slowDecision({ now, games, bundle, fastBundle }) {
    const results = data(bundle, 'resultados.json', { resultados: [] });
    const cup = data(bundle, 'dados-br/competicoes-af-previsao/copa-do-brasil.json', { eventos: [] });
    const lib = data(bundle, 'dados-br/competicoes-af-previsao/libertadores.json', { eventos: [] });
    const sula = data(bundle, 'dados-br/competicoes-af-previsao/sul-americana.json', { eventos: [] });
    const finalIds = localFinalIds(results, cup, lib, sula);
    const statusUpdate = data(bundle, 'dados-br/status-atualizacao.json', {});
    const aiState = data(bundle, 'dados-br/estado-publicos-ia.json', {});
    const publicAudit = data(bundle, 'dados-br/auditoria-publicos.json', {});
    const mmAuto = data(bundle, 'dados-br/melhores-momentos.json', { jogos: {} });
    const mmManual = data(bundle, 'dados-br/melhores-momentos-manual.json', { jogos: {} });
    const mmAudit = data(bundle, 'dados-br/auditoria-melhores-momentos.json', {});
    const cupHighlights = data(bundle, 'dados-br/melhores-momentos-copa-do-brasil.json', { jogos: {}, pendentes: [] });
    const liveAuto = data(bundle, 'dados-br/transmissoes-aovivo.json', { jogos: {} });
    const liveManual = data(bundle, 'dados-br/transmissoes-aovivo-manual.json', { jogos: {} });
    const tv = data(bundle, 'dados-br/transmissoes-tv.json', { jogos: {} });
    const tvAudit = data(bundle, 'dados-br/auditoria-transmissoes-tv.json', {});
    const calendar = data(bundle, 'dados-br/calendario-completo.json', { jogos: [] });
    const analysisConfig = data(bundle, 'dados-br/config-analises.json', {});
    const analyses = data(bundle, 'dados-br/analises.json', { artigos: [] });
    const contHistory = data(bundle, 'dados-br/historico-probabilidades-continentais.json', { marcos: [] });
    const hints = {};
    const ready = (...paths) => bundleReady(bundle, paths);
    const fastReady = (...paths) => bundleReady(fastBundle, paths);

    const degraded = [...bundleErrors(bundle), ...bundleErrors(fastBundle)];
    if (degraded.length) hints.fontesDegradadas = degraded.slice(0, 12);
    const repositorySources = [...repositoryFallbacks(bundle), ...repositoryFallbacks(fastBundle)];
    if (repositorySources.length) hints.fontesRepositorio = repositorySources.slice(0, 20);

    // 1) Manutenção diária: apenas se o snapshot publicado ainda não registra sucesso hoje.
    const lastMainSuccess = parseDate(statusUpdate?.ultimo_sucesso || statusUpdate?.atualizado_em);
    const today = brDateKey(now);
    if (ready('dados-br/status-atualizacao.json') && timeReached(now, POLICY.sports.dailyAfter) && (!lastMainSuccess || brDateKey(lastMainSuccess) !== today)) {
      const key = `daily-main:${today}`;
      const last = await this.storageDate(key);
      if (!last || minutesBetween(last, now) >= POLICY.sports.dailyRetryMinutes) {
        return {
          action: 'atualizar_brasileirao', reason: 'Manutenção diária: ainda não há atualização completa bem-sucedida hoje.',
          retryMinutes: POLICY.sports.dailyRetryMinutes,
          stateUpdates: { [key]: now.toISOString() }, hints,
        };
      }
    }

    // 2) Player oficial: checkpoints em vez de polling uniforme de 10 em 10 min.
    const liveSourcesReady = ready('dados-br/transmissoes-aovivo.json', 'dados-br/transmissoes-aovivo-manual.json', 'dados-br/transmissoes-tv.json');
    const linkedLive = liveLinkedIds(liveAuto, liveManual);
    const liveCandidates = [];
    for (const game of liveSourcesReady ? games : []) {
      if (finalIds.has(game.eventId) || linkedLive.has(game.eventId)) continue;
      const delta = (now.getTime() - game.kickoff.getTime()) / 60000;
      if (delta < POLICY.transmissoes.liveCheckpointsMinutes[0] || delta > POLICY.transmissoes.liveCheckpointsMinutes.at(-1)) continue;
      const policy = liveSearchAllowed(game.eventId, tv);
      if (!policy.allowed) continue;
      const lastCheckpoint = await this.state.storage.get(`livecp:${game.eventId}`);
      const cp = liveCheckpointDue(game, now, typeof lastCheckpoint === 'number' ? lastCheckpoint : null);
      if (cp == null) continue;
      liveCandidates.push({ game, cp, policy: policy.reason, delta });
    }
    liveCandidates.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
    if (liveCandidates.length) {
      const { game, cp, policy } = liveCandidates[0];
      return {
        action: 'transmissao_aovivo', eventId: game.eventId, checkpoint: cp,
        reason: `Checkpoint T${cp >= 0 ? '+' : ''}${cp} do player oficial para ${gameLabel(game)}; ${policy}.`,
        retryMinutes: 1,
        stateUpdates: { [`livecp:${game.eventId}`]: cp }, hints,
      };
    }

    // 3) Públicos: primeira busca após +15 min e backoff por event_id.
    const publicSourcesReady = ready(
      'resultados.json', 'dados-br/estado-publicos-ia.json', 'dados-br/auditoria-publicos.json',
    );
    const publics = publicSourcesReady ? pendingPublicsFromAudit({ results, audit: publicAudit, aiState, now }) : [];
    const publicAuditTime = parseDate(publicAudit?.gerado_em || publicAudit?.atualizado_em);
    let nextPublicDue = null;
    for (const item of publics) {
      let last = await this.storageDate(`public:${item.eventId}`);
      if (!last && publicAuditTime && isAfter(publicAuditTime, item.ended)) last = publicAuditTime;
      const interval = last ? publicRetryInterval(item.ageMinutes / 60) : 0;
      const due = last ? new Date(last.getTime() + interval * 60000) : item.ended;
      if (!nextPublicDue || due < nextPublicDue) nextPublicDue = due;
      if (!last || dueFromLast(last, now, interval)) {
        const updates = {};
        for (const pending of publics) updates[`public:${pending.eventId}`] = now.toISOString();
        hints.publicos = { pending: publics.length, nextDueAt: now.toISOString() };
        return {
          action: 'publicos', eventId: item.eventId,
          reason: last
            ? `Retentativa de público: ${publics.length} jogo(s) seguem pendentes; backoff ${interval} min.`
            : `Primeira busca de público para ${item.eventId}; FINAL há ${Math.round(item.ageMinutes)} min.`,
          retryMinutes: Math.max(1, interval || 1), stateUpdates: updates, hints,
        };
      }
    }
    if (nextPublicDue) hints.publicos = { pending: publics.length, nextDueAt: nextPublicDue.toISOString() };

    // 4) Melhores momentos: busca por jogo e backoff esparso.
    const mmSourcesReady = ready(
      'resultados.json', 'dados-br/melhores-momentos.json', 'dados-br/melhores-momentos-manual.json',
      'dados-br/auditoria-melhores-momentos.json',
    );
    const mmPending = mmSourcesReady ? pendingHighlights({ results, auto: mmAuto, manual: mmManual, now }) : [];
    const mmAuditTime = parseDate(mmAudit?.atualizado_em || mmAudit?.gerado_em);
    let nextMmDue = null;
    for (const item of mmPending) {
      let last = await this.storageDate(`mm:${item.eventId}`);
      if (!last && mmAuditTime && isAfter(mmAuditTime, item.ended)) last = mmAuditTime;
      const interval = last ? mmRetryInterval(item.ageMinutes / 60) : 0;
      const due = last ? new Date(last.getTime() + interval * 60000) : item.ended;
      if (!nextMmDue || due < nextMmDue) nextMmDue = due;
      if (!last || dueFromLast(last, now, interval)) {
        hints.melhoresMomentos = { pending: mmPending.length, nextDueAt: now.toISOString() };
        return {
          action: 'melhores_momentos', eventId: item.eventId,
          reason: last
            ? `Melhores momentos ainda ausentes para ${item.eventId}; backoff atual ${interval} min.`
            : `Primeira busca dirigida de melhores momentos para ${item.eventId}.`,
          retryMinutes: Math.max(1, interval || 1), stateUpdates: { [`mm:${item.eventId}`]: now.toISOString() }, hints,
        };
      }
    }
    if (nextMmDue) hints.melhoresMomentos = { pending: mmPending.length, nextDueAt: nextMmDue.toISOString() };

    const cupMmSourcesReady = ready('dados-br/competicoes-af-previsao/copa-do-brasil.json',
      'dados-br/melhores-momentos-copa-do-brasil.json', 'dados-br/auditoria-melhores-momentos.json');
    const cupMm = cupMmSourcesReady ? cupPendingHighlights(cup, cupHighlights, now) : [];
    if (cupMm.length) {
      const item = cupMm[0];
      let last = await this.storageDate(`mmcup:${item.eventId}`);
      if (!last && mmAuditTime && isAfter(mmAuditTime, item.ended)) last = mmAuditTime;
      const interval = last ? mmRetryInterval(item.ageMinutes / 60) : 0;
      if (!last || dueFromLast(last, now, interval)) {
        return {
          action: 'melhores_momentos', eventId: '',
          reason: `Copa do Brasil: melhores momentos ainda pendentes para ${item.eventId}.`,
          retryMinutes: Math.max(1, interval || 1), stateUpdates: { [`mmcup:${item.eventId}`]: now.toISOString() }, hints,
        };
      }
    }

    // 5) Editoriais: só quando o estado esportivo fecha a unidade editorial.
    const cupEditorial = ready('dados-br/competicoes-af-previsao/copa-do-brasil.json', 'dados-br/analises.json')
      ? await cupEditorialDecision(cup, analyses, cupHighlights) : null;
    if (cupEditorial) {
      return {
        action: 'editorial_copa_do_brasil', reason: `Copa do Brasil: ${cupEditorial.reason}.`,
        retryMinutes: POLICY.editorial.retryMinutes,
        stateUpdates: { [`editorial:cup:${cupEditorial.rank}`]: now.toISOString() }, hints,
      };
    }

    const cont = ready(
      'dados-br/competicoes-af-previsao/libertadores.json',
      'dados-br/competicoes-af-previsao/sul-americana.json',
      'dados-br/analises.json', 'dados-br/historico-probabilidades-continentais.json',
    )
      ? continentalDecision({ libertadores: lib, sul_americana: sula }, analyses, contHistory) : null;
    if (cont) {
      return {
        action: 'editorial_continentais', reason: `Continental: ${cont.reason}.`,
        retryMinutes: POLICY.editorial.retryMinutes,
        stateUpdates: { [`editorial:continental:${cont.kind}:${cont.rank}`]: now.toISOString() }, hints,
      };
    }

    const round = ready(
      'resultados.json', 'dados-br/calendario-completo.json', 'dados-br/config-analises.json', 'dados-br/analises.json',
    ) ? latestEligibleRound(calendar, results, analyses, now, analysisConfig) : null;
    if (round) {
      return {
        action: 'editorial_rodada', round: round.round,
        reason: `Rodada ${round.round} fechada editorialmente (${round.reason}); ${round.completed} jogo(s) concluído(s).`,
        retryMinutes: POLICY.editorial.retryMinutes,
        stateUpdates: { [`editorial:round:${round.round}`]: now.toISOString() }, hints,
      };
    }

    // 6) Grade futura: 6h crítica, 24h <14d, 72h pendência 15-30d, 7 dias se mês completo.
    const coverage = tvCoverage(games, tv, now, 30);
    const intervalHours = tvIntervalHours(coverage);
    let lastTv = await this.storageDate('tv:last');
    if (!lastTv) lastTv = parseDate(tvAudit?.atualizado_em);
    const nextTv = lastTv ? new Date(lastTv.getTime() + intervalHours * 3600000) : now;
    hints.transmissoesTv = {
      missing30d: coverage.missing30d,
      missing14d: coverage.missing14d,
      critical72h: coverage.critical72h,
      intervalHours,
      nextDueAt: nextTv.toISOString(),
    };
    const critical = coverage.critical72h > 0;
    if ((critical || timeReached(now, POLICY.transmissoes.tvAfter)) && (!lastTv || hoursSince(lastTv, now) >= intervalHours)) {
      return {
        action: 'transmissoes_tv',
        reason: coverage.critical72h
          ? `${coverage.critical72h} jogo(s) nas próximas 72h sem grade; retry crítico ${intervalHours}h.`
          : coverage.missing14d
            ? `${coverage.missing14d} jogo(s) em 14 dias sem grade; nova busca após ${intervalHours}h.`
            : coverage.missing30d
              ? `${coverage.missing30d} jogo(s) em 30 dias sem grade; manutenção após ${intervalHours}h.`
              : `Grade dos próximos 30 dias completa; manutenção semanal (${intervalHours}h).`,
        retryMinutes: intervalHours * 60,
        stateUpdates: { 'tv:last': now.toISOString() }, hints,
      };
    }

    return { action: 'none', reason: 'Estado consistente; nenhum workflow pesado precisa rodar.', retryMinutes: 0, hints };
  }
}

function hoursSince(last, now) {
  return minutesBetween(last, now) / 60;
}
