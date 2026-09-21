import {
  POLICY,
  actionKey,
  brasileiraoSourceGate,
  continentalAgendaSignature,
  continentalDecision,
  continentalEligibility,
  continentalNextCheck,
  cupEditorialDecision,
  latestEligibleRound,
  liveCheckpointDue,
  guardianCheckpointDue,
  guardianResolution,
  liveLinkedIds,
  liveSearchAllowed,
  localFinalIds,
  minutesBetween,
  mmRetryInterval,
  normalizeAgenda,
  parseDate,
  pendingHighlights,
  pendingContinentalHighlights,
  pendingPublicsFromAudit,
  publicPendingFingerprint,
  relevantSportsGames,
  resultFinalTime,
  espnDay,
  tvCoverage,
  tvCheckpointDue,
} from './logic.js';
import { activeWriter, dispatchSpec, dispatchWorkflow } from './github.js';
import { fetchPostgameFastlane, fetchSiteBundle, probeEspn, probeEspnAvailability, repositoryFallbacks } from './sources.js';

// O Worker acorda a cada 5 minutos. O caminho rápido continua compacto:
// agenda + status operacional autoritativo. O status permite interromper
// imediatamente novos dispatches pesados quando a ESPN preservou snapshot.
const FAST_PATHS = [
  'dados-br/agenda-clubes-br.json',
  'dados-br/status-atualizacao.json',
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
  'dados-br/melhores-momentos-continentais.json',
  'dados-br/transmissoes-aovivo.json',
  'dados-br/transmissoes-aovivo-manual.json',
  'dados-br/transmissoes-tv.json',
  'dados-br/transmissoes-guardiao.json',
  'dados-br/auditoria-transmissoes-tv.json',
  'dados-br/calendario-completo.json',
  'dados-br/config-analises.json',
  'dados-br/analises.json',
  'dados-br/historico-probabilidades-continentais.json',
  'dados-br/estado-editorial-continentais.json',
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

function agendaRuntimeSignature(games) {
  return games.map((g) => `${g.eventId}|${g.kickoff?.toISOString?.() || ''}|${g.concluded ? 1 : 0}`).sort().join(';');
}

function minDate(...values) {
  const dates = values.flat().map(parseDate).filter(Boolean);
  return dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
}

function nextTransmissionBoundary(games, now) {
  const t = parseDate(now)?.getTime() ?? Date.now();
  const future = [];
  for (const game of games || []) {
    if (!game?.kickoff || game.concluded) continue;
    for (const cp of POLICY.transmissoes.tvCheckpointsMinutes || []) {
      const at = game.kickoff.getTime() + cp * 60000;
      if (at > t) future.push(new Date(at));
    }
    for (const cp of POLICY.transmissoes.liveCheckpointsMinutes || []) {
      const at = game.kickoff.getTime() + cp * 60000;
      if (at > t) future.push(new Date(at));
    }
  }
  return future.length ? new Date(Math.min(...future.map((d) => d.getTime()))) : null;
}

function boundedNextSlowAt(now, games, hints = {}, afterAction = false) {
  const floor = new Date(now.getTime() + 5 * 60000);
  const cap = new Date(now.getTime() + (afterAction ? 20 : 60) * 60000);
  const transmission = nextTransmissionBoundary(games, now);
  const hinted = minDate(
    hints?.publicos?.nextDueAt,
    hints?.melhoresMomentos?.nextDueAt,
    hints?.editorialContinental?.nextCheckAt,
    transmission,
  );
  if (!hinted) return cap;
  if (hinted < floor) return floor;
  return hinted < cap ? hinted : cap;
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
    const ageMinutes = minutesBetween(ended, now);
    if (ageMinutes < POLICY.melhoresMomentos.firstAfterFinalMinutes) continue;
    if (ageMinutes > POLICY.melhoresMomentos.automaticWindowMinutes) continue;
    rows.push({ eventId, ended, ageMinutes, row: event, round: 0 });
  }
  return rows;
}

function nextRelevantGame(games, now) {
  const t = parseDate(now)?.getTime() ?? Date.now();
  return (games || [])
    .filter((game) => game?.kickoff && !game.concluded && game.kickoff.getTime() >= t)
    .sort((a, b) => a.kickoff - b.kickoff)[0] || null;
}

function fastlaneRowsById(rows) {
  return new Map((rows || []).map((row) => [String(row?.event_id || ''), row]).filter(([id]) => id));
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function concretePublicPayload(item, fastlaneRow) {
  if (!fastlaneRow || typeof fastlaneRow !== 'object') return null;
  const missing = new Set((item?.missingFields || []).map(String));
  const values = {};
  if (missing.has('publico')) {
    const value = positiveNumber(fastlaneRow.publico);
    if (value != null) values.publico = value;
  }
  if (missing.has('renda')) {
    const value = positiveNumber(fastlaneRow.renda);
    if (value != null) values.renda = value;
  }
  const paid = Number(fastlaneRow.publico_pagante);
  if (Number.isFinite(paid) && paid >= 0) values.publico_pagante = paid;
  const material = Object.keys(values).some((key) => key === 'publico' || key === 'renda');
  if (!material) return null;
  return {
    values,
    sources: fastlaneRow.public_sources || {},
    fingerprint: JSON.stringify({ values, sources: fastlaneRow.public_sources || {} }),
  };
}

function concreteHighlightPayload(fastlaneRow) {
  const highlight = fastlaneRow?.highlight;
  const url = String(highlight?.url || '').trim();
  if (!url) return null;
  const videoId = String(highlight?.video_id || '').trim();
  return { highlight, fingerprint: `${videoId}|${url}` };
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
      version: String(this.env.ORCHESTRATOR_VERSION || '2.0.0'),
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

  async postgameLedger(eventId) {
    const key = `postgame-ledger:${String(eventId || '')}`;
    const value = (await this.state.storage.get(key)) || {};
    return { key, value: value && typeof value === 'object' ? value : {} };
  }

  async postgameDispatchAllowed(eventId, kind) {
    const { value } = await this.postgameLedger(eventId);
    const slot = value?.[kind] && typeof value[kind] === 'object' ? value[kind] : {};
    return {
      allowed: slot.resolved !== true && Number(slot.dispatches || 0) < Number(POLICY[kind === 'public' ? 'publicos' : 'melhoresMomentos'].maxGithubDispatchesPerEvent || 2),
      dispatches: Number(slot.dispatches || 0),
      resolved: slot.resolved === true,
    };
  }

  async notePostgameDispatch(candidate, now) {
    const kind = String(candidate?.ledgerKind || '');
    if (!['public', 'highlight'].includes(kind)) return;
    const ids = Array.isArray(candidate?.eventIds) && candidate.eventIds.length
      ? candidate.eventIds.map(String)
      : [String(candidate?.eventId || '')].filter(Boolean);
    for (const eventId of ids) {
      const { key, value } = await this.postgameLedger(eventId);
      const slot = value?.[kind] && typeof value[kind] === 'object' ? value[kind] : {};
      const fingerprint = String(candidate?.ledgerFingerprints?.[eventId] || candidate?.fingerprint || '');
      const next = {
        ...value,
        eventId,
        [kind]: {
          ...slot,
          resolved: false,
          dispatches: Number(slot.dispatches || 0) + 1,
          lastDispatchedAt: now.toISOString(),
          lastFingerprint: fingerprint,
        },
      };
      await this.state.storage.put(key, next);
    }
  }

  async reconcilePostgameLedgers(publicPendingIds, highlightPendingIds) {
    if (typeof this.state.storage.list !== 'function') return;
    const rows = await this.state.storage.list({ prefix: 'postgame-ledger:' });
    for (const [key, raw] of rows.entries()) {
      const value = raw && typeof raw === 'object' ? { ...raw } : {};
      const eventId = String(value.eventId || key.slice('postgame-ledger:'.length));
      let changed = false;
      if (value.public && value.public.resolved !== true && !publicPendingIds.has(eventId)) {
        value.public = { ...value.public, resolved: true, resolvedAt: new Date().toISOString() };
        changed = true;
      }
      if (value.highlight && value.highlight.resolved !== true && !highlightPendingIds.has(eventId)) {
        value.highlight = { ...value.highlight, resolved: true, resolvedAt: new Date().toISOString() };
        changed = true;
      }
      if (changed) await this.state.storage.put(key, value);
    }
  }

  async githubDispatchesLast24h(now, currentResult = '') {
    const history = (await this.state.storage.get('history')) || [];
    const floor = now.getTime() - 24 * 60 * 60 * 1000;
    let count = history.filter((item) => item?.result === 'dispatched' && (parseDate(item?.at)?.getTime() || 0) >= floor).length;
    if (currentResult === 'dispatched') count += 1;
    return count;
  }

  async candidateAllowedByRetry(candidate, now) {
    const key = `dispatch:${actionKey(candidate)}`;
    const last = await this.storageDate(key);
    if (candidate?.idempotency === 'state') return { allowed: !last, key, last, permanent: true };
    const retry = Number(candidate.retryMinutes || 0);
    return { allowed: dueFromLast(last, now, retry), key, last, permanent: false };
  }

  async dispatchCandidate(candidate, now) {
    const mode = String(this.env.ORCHESTRATOR_MODE || 'shadow').toLowerCase();
    const retry = await this.candidateAllowedByRetry(candidate, now);
    if (!retry.allowed) {
      return {
        result: retry.permanent ? 'duplicate_state' : 'cooldown',
        reason: retry.permanent
          ? 'estado factual idêntico já foi despachado; aguardar mudança real de agenda/snapshot'
          : `cooldown ${candidate.retryMinutes} min ainda ativo`,
        candidate,
      };
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
    await this.notePostgameDispatch(candidate, now);
    const updates = { [retry.key]: now.toISOString() };
    for (const [key, value] of Object.entries(candidate.stateUpdates || {})) updates[key] = value;
    await Promise.all(Object.entries(updates).map(([key, value]) => this.state.storage.put(key, value)));
    return { result: 'dispatched', reason: `${spec.workflow} solicitado ao GitHub`, candidate, workflow: spec.workflow };
  }

  async brasileiraoSourceRuntime(statusUpdate, now) {
    const external = brasileiraoSourceGate(statusUpdate);
    const key = 'br:sourceBreaker';
    const stored = (await this.state.storage.get(key)) || {};

    if (!external.open) {
      const closed = {
        state: 'closed', externalOpen: false, reason: '', fingerprint: external.fingerprint,
        lastProbeAt: stored.lastProbeAt || '', lastProbeOk: true, halfOpenDispatched: false,
      };
      await this.state.storage.put(key, closed);
      return { ...closed, blocked: false, recoveryEligible: false, legacy: external.legacy };
    }

    let runtime = stored?.fingerprint === external.fingerprint
      ? { ...stored }
      : { state: 'open', halfOpenDispatched: false, lastProbeAt: '', lastProbeOk: false };
    runtime.externalOpen = true;
    runtime.reason = external.reason;
    runtime.fingerprint = external.fingerprint;
    runtime.legacy = external.legacy;

    const lastProbe = parseDate(runtime.lastProbeAt);
    const due = !lastProbe || minutesBetween(lastProbe, now) >= POLICY.sports.sourceProbeMinutes;
    if (due) {
      const probe = await probeEspnAvailability({ league: 'bra.1', day: espnDay(now) });
      runtime.lastProbeAt = now.toISOString();
      runtime.lastProbeOk = probe.ok;
      runtime.lastProbeSource = probe.source || '';
      runtime.lastProbeError = probe.error || '';
      if (probe.ok) {
        if (!(runtime.state === 'half_open' && runtime.halfOpenDispatched === true)) {
          runtime.state = 'half_open';
          runtime.halfOpenDispatched = false;
        }
      } else {
        runtime.state = 'open';
        runtime.halfOpenDispatched = false;
      }
    }

    const blocked = runtime.state === 'open' || (runtime.state === 'half_open' && runtime.halfOpenDispatched === true);
    const recoveryEligible = runtime.state === 'half_open' && runtime.halfOpenDispatched !== true;
    await this.state.storage.put(key, runtime);
    return { ...runtime, blocked, recoveryEligible };
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
      const statusUpdateFast = data(fastBundle, 'dados-br/status-atualizacao.json', {});
      const games = normalizeAgenda(agendaPayload);
      const relevant = relevantSportsGames(games, now);
      relevantCount = relevant.length;
      const brSource = await this.brasileiraoSourceRuntime(statusUpdateFast, now);
      const probeGames = relevant.filter((game) => !(game.league === 'bra.1' && brSource.blocked));
      const espn = probeGames.length ? await probeEspn(probeGames) : { states: new Map(), errors: [], sources: {} };
      errors.push(...espn.errors);

      for (const game of relevant) {
        // Fail closed: só existe candidato quando a agenda pública foi lida e
        // ainda marca o jogo como não concluído.
        if (!bundleReady(fastBundle, ['dados-br/agenda-clubes-br.json'])) continue;
        if (game.league === 'bra.1' && brSource.blocked) continue;
        if (espn.states.get(game.eventId)?.state !== 'post' || game.concluded) continue;
        candidate = {
          action: 'atualizar_brasileirao', eventId: game.eventId,
          reason: `ESPN marcou FINAL ainda não incorporado: ${gameLabel(game)}.`,
          retryMinutes: POLICY.sports.finalRetryMinutes,
          brSourceSensitive: game.league === 'bra.1',
        };
        break;
      }

      if (!candidate && espn.errors.length) {
        for (const game of relevant) {
          if (!bundleReady(fastBundle, ['dados-br/agenda-clubes-br.json'])) continue;
          if (game.league === 'bra.1' && brSource.blocked) continue;
          if (game.concluded || espn.states.has(game.eventId)) continue;
          const elapsed = (now.getTime() - game.kickoff.getTime()) / 60000;
          const cupLike = /copa|libert|sul/i.test(game.competition);
          const fallback = cupLike ? 160 : 130;
          if (elapsed < fallback) continue;
          candidate = {
            action: 'atualizar_brasileirao', eventId: game.eventId,
            reason: `Contingência pós-jogo: ESPN indisponível e ${gameLabel(game)} ultrapassou ${fallback} min sem FINAL publicado.`,
            retryMinutes: POLICY.sports.finalRetryMinutes,
            brSourceSensitive: game.league === 'bra.1',
          };
          break;
        }
      }

      if (!candidate) {
        const lastSlow = await this.storageDate('meta:lastSlowEval');
        const nextSlowAt = await this.storageDate('meta:nextSlowEvalAt');
        const currentAgendaSignature = agendaRuntimeSignature(games);
        const priorAgendaSignature = String((await this.state.storage.get('meta:agendaSignature')) || '');
        const agendaChanged = priorAgendaSignature !== currentAgendaSignature;
        const dueByClock = !nextSlowAt || nextSlowAt.getTime() <= now.getTime();
        const legacyDue = !lastSlow || minutesBetween(lastSlow, now) >= POLICY.slowEvalMinutes;
        if (agendaChanged || dueByClock || (!nextSlowAt && legacyDue)) {
          slowEvaluated = true;
          const slowBundle = await fetchSiteBundle(this.env, SLOW_PATHS);
          errors.push(...bundleErrors(slowBundle));
          const slow = await this.slowDecision({ now, games, bundle: slowBundle, fastBundle, brSource });
          hints = slow?.hints || (await this.state.storage.get('meta:lastHints')) || {};
          candidate = slow?.action && slow.action !== 'none' ? slow : null;
          if (candidate?.hints) delete candidate.hints;
          const nextAt = boundedNextSlowAt(now, games, hints, Boolean(candidate));
          await this.state.storage.put('meta:lastSlowEval', now.toISOString());
          await this.state.storage.put('meta:nextSlowEvalAt', nextAt.toISOString());
          await this.state.storage.put('meta:agendaSignature', currentAgendaSignature);
          await this.state.storage.put('meta:lastHints', { ...hints, nextSlowEvalAt: nextAt.toISOString() });
          hints = { ...hints, nextSlowEvalAt: nextAt.toISOString() };
        } else {
          hints = (await this.state.storage.get('meta:lastHints')) || {};
          hints = { ...hints, nextSlowEvalAt: nextSlowAt?.toISOString?.() || '' };
        }
      }

      // OPEN -> HALF_OPEN precisa de uma única execução pesada mesmo que a
      // janela esportiva que causou a falha já tenha saído do fast path. O
      // próprio status OPEN comprova que uma atualização anterior ficou
      // incompleta; o probe saudável autoriza exatamente uma recuperação.
      if (!candidate && brSource.externalOpen && brSource.recoveryEligible) {
        candidate = {
          action: 'atualizar_brasileirao',
          reason: 'Probe resiliente da ESPN voltou saudável; fechar circuit breaker com uma única atualização de recuperação.',
          retryMinutes: POLICY.sports.finalRetryMinutes,
          brSourceSensitive: true,
        };
      }

      if (candidate?.action === 'atualizar_brasileirao' && candidate.brSourceSensitive !== false && brSource.externalOpen) {
        if (brSource.blocked) {
          hints.brasileiraoSourceBreaker = {
            state: brSource.state, reason: brSource.reason, lastProbeAt: brSource.lastProbeAt || '',
            lastProbeOk: brSource.lastProbeOk === true, lastProbeSource: brSource.lastProbeSource || '',
            action: 'blocked',
          };
          candidate = null;
          dispatchResult = { result: 'source_breaker_open', reason: 'ESPN do Brasileirão indisponível; GitHub Action pesada bloqueada até probe saudável.' };
        } else if (brSource.recoveryEligible) {
          candidate.sourceRecovery = true;
          candidate.reason = `HALF_OPEN ESPN: probe resiliente voltou saudável; tentativa única de recuperação. ${candidate.reason}`;
        }
      }

      if (candidate) {
        dispatchResult = await this.dispatchCandidate(candidate, now);
        if (candidate.sourceRecovery && dispatchResult.result === 'dispatched') {
          const updatedBreaker = { ...brSource, state: 'half_open', halfOpenDispatched: true, lastHeavyAttemptAt: now.toISOString() };
          await this.state.storage.put('br:sourceBreaker', updatedBreaker);
          brSource.state = 'half_open';
          brSource.halfOpenDispatched = true;
          brSource.blocked = true;
          brSource.recoveryEligible = false;
        }
      }

      hints.brasileiraoSourceBreaker = hints.brasileiraoSourceBreaker || {
        state: brSource.state, externalOpen: brSource.externalOpen === true, reason: brSource.reason || '',
        lastProbeAt: brSource.lastProbeAt || '', lastProbeOk: brSource.lastProbeOk === true,
        lastProbeSource: brSource.lastProbeSource || '', halfOpenDispatched: brSource.halfOpenDispatched === true,
      };

      const nextGame = nextRelevantGame(games, now);
      const pendingPostgameTasks = Number(hints?.publicos?.automaticPending || 0)
        + Number(hints?.melhoresMomentos?.automaticPending || 0);
      const hoursToNext = nextGame ? minutesBetween(now, nextGame.kickoff) / 60 : Infinity;
      const workloadMode = candidate
        ? 'active'
        : relevantCount > 0
          ? 'live_window'
          : pendingPostgameTasks > 0
            ? 'postgame'
            : (!nextGame || hoursToNext > POLICY.transmissoes.tvWindowHours ? 'dormant' : 'pre_game');
      const githubDispatchesLast24h = await this.githubDispatchesLast24h(now, dispatchResult.result);

      const status = {
        lastTickAt: now.toISOString(),
        mode,
        workloadMode,
        nextRelevantMatchAt: nextGame?.kickoff?.toISOString?.() || '',
        pendingPostgameTasks,
        githubDispatchesLast24h,
        relevantSportsGames: relevantCount,
        slowEvaluated,
        candidate: candidate ? {
          action: candidate.action,
          eventId: candidate.eventId || '',
          eventIds: candidate.eventIds || [],
          round: candidate.round || '',
          checkpoint: candidate.checkpoint ?? null,
          reason: candidate.reason,
        } : null,
        result: dispatchResult.result,
        resultReason: dispatchResult.reason,
        brasileiraoSource: hints.brasileiraoSourceBreaker,
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

  async slowDecision({ now, games, bundle, fastBundle, brSource = {} }) {
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
    const continentalHighlights = data(bundle, 'dados-br/melhores-momentos-continentais.json', { jogos: {} });
    const liveAuto = data(bundle, 'dados-br/transmissoes-aovivo.json', { jogos: {} });
    const liveManual = data(bundle, 'dados-br/transmissoes-aovivo-manual.json', { jogos: {} });
    const tv = data(bundle, 'dados-br/transmissoes-tv.json', { jogos: {} });
    const guardian = data(bundle, 'dados-br/transmissoes-guardiao.json', { jogos: {} });
    const tvAudit = data(bundle, 'dados-br/auditoria-transmissoes-tv.json', {});
    const calendar = data(bundle, 'dados-br/calendario-completo.json', { jogos: [] });
    const analysisConfig = data(bundle, 'dados-br/config-analises.json', {});
    const analyses = data(bundle, 'dados-br/analises.json', { artigos: [] });
    const contHistory = data(bundle, 'dados-br/historico-probabilidades-continentais.json', { marcos: [] });
    const contLock = data(bundle, 'dados-br/estado-editorial-continentais.json', { bloqueado: false });
    const hints = {};
    const ready = (...paths) => bundleReady(bundle, paths);
    const fastReady = (...paths) => bundleReady(fastBundle, paths);

    const degraded = [...bundleErrors(bundle), ...bundleErrors(fastBundle)];
    if (degraded.length) hints.fontesDegradadas = degraded.slice(0, 12);
    const repositorySources = [...repositoryFallbacks(bundle), ...repositoryFallbacks(fastBundle)];
    if (repositorySources.length) hints.fontesRepositorio = repositorySources.slice(0, 20);

    // 1) Sem manutenção diária cega. O pipeline pesado só nasce de mudança
    // esportiva observável ou de uma tarefa concreta abaixo.

    // 2) Player oficial: NEED-DRIVEN. O relógio só define quando tentar;
    // a elegibilidade factual vem da grade TV. Premiere/SporTV/Globo/Record/
    // Prime/Paramount/Disney não abrem busca de YouTube. Player já resolvido
    // encerra definitivamente os checkpoints posteriores para aquele snapshot.
    const liveSourcesReady = ready('dados-br/transmissoes-aovivo.json', 'dados-br/transmissoes-aovivo-manual.json', 'dados-br/transmissoes-tv.json');
    const liveCandidates = [];
    for (const game of liveSourcesReady ? games : []) {
      if (finalIds.has(game.eventId)) continue;
      const delta = (now.getTime() - game.kickoff.getTime()) / 60000;
      const cps = POLICY.transmissoes.liveCheckpointsMinutes;
      if (delta < cps[0] || delta > cps.at(-1)) continue;
      const policy = liveSearchAllowed(game.eventId, tv);
      if (!policy.allowed) continue;
      const resolution = guardianResolution({ eventId: game.eventId, tv, liveAuto, liveManual, guardian });
      if (!resolution.playerRequired || resolution.playerResolved) continue;
      const lastCheckpoint = await this.state.storage.get(`livecp:${game.eventId}`);
      const cp = liveCheckpointDue(game, now, typeof lastCheckpoint === 'number' ? lastCheckpoint : null);
      if (cp == null) continue;
      liveCandidates.push({ game, cp, policy: policy.reason, delta, resolution });
    }
    liveCandidates.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
    if (liveCandidates.length) {
      const { game, cp, policy, resolution } = liveCandidates[0];
      return {
        action: 'transmissao_aovivo', eventId: game.eventId, checkpoint: cp,
        fingerprint: resolution.fingerprint,
        reason: `Player necessário T${cp >= 0 ? '+' : ''}${cp} para ${gameLabel(game)}; ${policy}; player integral ainda ausente.`,
        retryMinutes: 1,
        stateUpdates: { [`livecp:${game.eventId}`]: cp }, hints,
      };
    }

    // 2b) Guardião IA: checkpoint é apenas janela de oportunidade. Antes de
    // abrir uma Action, o Worker prova que existe pendência factual real. Jogos
    // já resolvidos não voltam a rodar em T-90/T-15/T+10. Alvos simultâneos no
    // mesmo checkpoint são consolidados em uma única auditoria.
    const guardianSourcesReady = ready(
      'dados-br/transmissoes-tv.json', 'dados-br/transmissoes-aovivo.json',
      'dados-br/transmissoes-aovivo-manual.json', 'dados-br/transmissoes-guardiao.json',
    );
    const guardianCandidates = [];
    for (const game of guardianSourcesReady ? games : []) {
      if (finalIds.has(game.eventId)) continue;
      const delta = (now.getTime() - game.kickoff.getTime()) / 60000;
      const cps = POLICY.transmissoes.guardianCheckpointsMinutes;
      if (delta < cps[0] || delta > cps.at(-1)) continue;
      const resolution = guardianResolution({ eventId: game.eventId, tv, liveAuto, liveManual, guardian });
      if (resolution.resolved) continue;
      const lastCheckpoint = await this.state.storage.get(`guardiancp:${game.eventId}`);
      const cp = guardianCheckpointDue(game, now, typeof lastCheckpoint === 'number' ? lastCheckpoint : null);
      if (cp == null) continue;
      guardianCandidates.push({ game, cp, delta, resolution });
    }
    guardianCandidates.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
    if (guardianCandidates.length) {
      const primary = guardianCandidates[0];
      const batch = guardianCandidates.filter((row) => row.cp === primary.cp).slice(0, 8);
      const eventIds = batch.map((row) => row.game.eventId);
      const updates = Object.fromEntries(batch.map((row) => [`guardiancp:${row.game.eventId}`, row.cp]));
      const missing = [...new Set(batch.flatMap((row) => row.resolution.missing))].sort();
      return {
        action: 'transmissoes_guardian', eventIds, eventId: eventIds.length === 1 ? eventIds[0] : '', checkpoint: primary.cp,
        fingerprint: batch.map((row) => `${row.game.eventId}:${row.resolution.fingerprint}`).sort().join(';'),
        reason: `Guardião T${primary.cp >= 0 ? '+' : ''}${primary.cp}: ${eventIds.length} jogo(s) com pendência real (${missing.join(', ')}).`,
        retryMinutes: 1,
        stateUpdates: updates, hints,
      };
    }

    // 3/4) Pós-jogo do Brasileirão: o Cloudflare Fastlane faz toda a
    // perseguição. GitHub só consolida descoberta concreta já gravada no D1,
    // dentro das primeiras 24h e com teto de dois dispatches por jogo/tipo.
    const publicSourcesReady = ready(
      'resultados.json', 'dados-br/estado-publicos-ia.json', 'dados-br/auditoria-publicos.json',
    );
    const publicsAll = publicSourcesReady ? pendingPublicsFromAudit({ results, audit: publicAudit, aiState, now }) : [];
    const publicAutomatic = publicsAll.filter((item) => item.ageMinutes <= POLICY.publicos.automaticWindowMinutes);

    const mmSourcesReady = ready(
      'resultados.json', 'dados-br/melhores-momentos.json', 'dados-br/melhores-momentos-manual.json',
      'dados-br/auditoria-melhores-momentos.json',
    );
    const mmPendingAll = mmSourcesReady ? pendingHighlights({ results, auto: mmAuto, manual: mmManual, now }) : [];
    const mmAutomatic = mmPendingAll.filter((item) => item.ageMinutes <= POLICY.melhoresMomentos.automaticWindowMinutes);
    const mmAuditTime = parseDate(mmAudit?.atualizado_em || mmAudit?.gerado_em);

    const postgameIds = [...new Set([
      ...publicAutomatic.map((item) => String(item.eventId)),
      ...mmAutomatic.map((item) => String(item.eventId)),
    ])];
    const fastlane = postgameIds.length ? await fetchPostgameFastlane(this.env, postgameIds) : { rows: [], error: '' };
    const fastlaneById = fastlaneRowsById(fastlane.rows);
    hints.postgameFastlane = { queried: postgameIds.length, rows: fastlane.rows.length, error: fastlane.error || '' };

    await this.reconcilePostgameLedgers(
      new Set(publicsAll.map((item) => String(item.eventId))),
      new Set(mmPendingAll.map((item) => String(item.eventId))),
    );

    let publicConcreteReady = 0;
    let publicCapped = 0;
    for (const item of publicAutomatic) {
      const eventId = String(item.eventId);
      const concrete = concretePublicPayload(item, fastlaneById.get(eventId));
      if (!concrete) continue;
      publicConcreteReady += 1;
      const ledger = await this.postgameDispatchAllowed(eventId, 'public');
      if (!ledger.allowed) { publicCapped += 1; continue; }
      hints.publicos = {
        pending: publicsAll.length,
        automaticPending: publicAutomatic.length,
        historicalPending: Math.max(0, publicsAll.length - publicAutomatic.length),
        concreteReady: publicConcreteReady, capped: publicCapped, target: eventId, nextDueAt: now.toISOString(),
      };
      return {
        action: 'publicos', eventId, eventIds: [eventId], fastlane: true, ledgerKind: 'public',
        ledgerFingerprints: { [eventId]: concrete.fingerprint }, fingerprint: concrete.fingerprint,
        missingFields: item.missingFields || [],
        reason: `Fastlane encontrou dado concreto de público/renda para ${eventId}; consolidar uma única vez no repositório.`,
        retryMinutes: POLICY.publicos.githubRetryMinutes, hints,
      };
    }
    hints.publicos = {
      pending: publicsAll.length,
      automaticPending: publicAutomatic.length,
      historicalPending: Math.max(0, publicsAll.length - publicAutomatic.length),
      concreteReady: publicConcreteReady, capped: publicCapped,
    };

    const mmConcrete = [];
    let mmCapped = 0;
    for (const item of mmAutomatic) {
      const eventId = String(item.eventId);
      const concrete = concreteHighlightPayload(fastlaneById.get(eventId));
      if (!concrete) continue;
      const ledger = await this.postgameDispatchAllowed(eventId, 'highlight');
      if (!ledger.allowed) { mmCapped += 1; continue; }
      mmConcrete.push({ eventId, concrete });
    }
    if (mmConcrete.length) {
      const batch = mmConcrete.slice(0, 8);
      const eventIds = batch.map((item) => item.eventId);
      const ledgerFingerprints = Object.fromEntries(batch.map((item) => [item.eventId, item.concrete.fingerprint]));
      const fingerprint = eventIds.map((id) => `${id}:${ledgerFingerprints[id]}`).sort().join(';');
      hints.melhoresMomentos = {
        pending: mmPendingAll.length, automaticPending: mmAutomatic.length,
        historicalPending: Math.max(0, mmPendingAll.length - mmAutomatic.length),
        concreteReady: mmConcrete.length, capped: mmCapped, nextDueAt: now.toISOString(),
      };
      return {
        action: 'melhores_momentos', eventIds, eventId: eventIds.length === 1 ? eventIds[0] : '',
        fastlane: true, ledgerKind: 'highlight', ledgerFingerprints, fingerprint,
        reason: `Fastlane encontrou melhores momentos concretos para ${eventIds.length} jogo(s); consolidar em lote no repositório.`,
        retryMinutes: POLICY.melhoresMomentos.githubRetryMinutes, hints,
      };
    }
    hints.melhoresMomentos = {
      pending: mmPendingAll.length, automaticPending: mmAutomatic.length,
      historicalPending: Math.max(0, mmPendingAll.length - mmAutomatic.length),
      concreteReady: 0, capped: mmCapped,
    };

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

    // 4c) CONMEBOL: vídeos são independentes do editorial. Só jogos
    // continentais RECÉM-encerrados (janela de 24h) podem abrir este workflow;
    // mudanças de vídeo nunca reabrem IA editorial.
    const contMmReady = ready(
      'dados-br/competicoes-af-previsao/libertadores.json',
      'dados-br/competicoes-af-previsao/sul-americana.json',
      'dados-br/melhores-momentos-continentais.json',
    );
    const contMmPending = contMmReady
      ? pendingContinentalHighlights({ libertadores: lib, sul_americana: sula }, continentalHighlights, now)
      : [];
    if (contMmPending.length) {
      const item = contMmPending[0];
      const stateKey = `mmcont:${item.eventId}`;
      const last = await this.storageDate(stateKey);
      const interval = last ? mmRetryInterval(item.ageMinutes / 60) : 0;
      if (!last || dueFromLast(last, now, interval)) {
        hints.melhoresMomentosContinentais = {
          pending: contMmPending.length,
          eventId: item.eventId,
          rank: item.rank,
          nextDueAt: now.toISOString(),
        };
        return {
          action: 'melhores_momentos_continentais',
          eventId: item.eventId,
          phaseRank: item.rank,
          reason: `CONMEBOL: melhores momentos ainda ausentes para ${item.home || '?'} x ${item.away || '?'} (${item.eventId}); pipeline de vídeo independente do editorial.`,
          retryMinutes: Math.max(1, interval || 1),
          stateUpdates: { [stateKey]: now.toISOString() },
          hints,
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

    // Editorial continental tem relógio próprio. O cron global continua em 5 min,
    // mas este módulo só volta a decidir quando a agenda muda ou a janela
    // esportiva prevista vence. Isso impede workflow no escuro entre fases.
    const continentalPaths = [
      'dados-br/competicoes-af-previsao/libertadores.json',
      'dados-br/competicoes-af-previsao/sul-americana.json',
      'dados-br/analises.json',
      'dados-br/historico-probabilidades-continentais.json',
      'dados-br/estado-editorial-continentais.json',
    ];
    if (ready(...continentalPaths)) {
      const guardStored = String(contLock?.guard_fingerprint || '').trim();
      const guardCurrent = String(this.env.CONTINENTAL_GUARD_FINGERPRINT || '').trim();
      const breakerActive = Boolean(contLock?.bloqueado) && (!guardStored || !guardCurrent || guardStored === guardCurrent);
      if (breakerActive) {
        hints.editorialContinental = {
          state: 'circuit_breaker',
          blocked: true,
          runUrl: String(contLock?.run_url || ''),
          reason: 'falha anterior ainda pertence à versão atual da governança; zero dispatch automático',
        };
      } else {
        const snaps = { libertadores: lib, sul_americana: sula };
        const agendaSignature = continentalAgendaSignature(games);
        const storedAgendaSignature = String((await this.state.storage.get('continental:agendaSignature')) || '');
        const nextCheckAt = await this.storageDate('continental:nextCheckAt');
        const sleeping = storedAgendaSignature === agendaSignature && nextCheckAt && nextCheckAt.getTime() > now.getTime();

        if (sleeping) {
          hints.editorialContinental = {
            state: 'sleeping',
            nextCheckAt: nextCheckAt.toISOString(),
            reason: 'agenda continental inalterada; aguardar próxima janela esportiva útil',
          };
        } else {
          const eligibility = continentalEligibility(snaps, contHistory);
          const cont = continentalDecision(snaps, analyses, contHistory);
          if (cont) {
            return {
              action: 'editorial_continentais',
              reason: `Continental: ${cont.reason}.`,
              retryMinutes: POLICY.editorial.retryMinutes,
              idempotency: 'state',
              signature: cont.signature,
              stateUpdates: {
                [`editorial:continental:${cont.kind}:${cont.rank}`]: now.toISOString(),
                'continental:agendaSignature': agendaSignature,
                'continental:nextCheckAt': now.toISOString(),
              },
              hints,
            };
          }

          const plan = continentalNextCheck(eligibility, games, now);
          await this.state.storage.put('continental:agendaSignature', agendaSignature);
          await this.state.storage.put('continental:nextCheckAt', plan.nextCheckAt.toISOString());
          hints.editorialContinental = {
            state: plan.degraded ? 'daily_fallback' : 'scheduled',
            rank: Number(eligibility?.rank || 0),
            phase: String(eligibility?.phase || ''),
            pending: eligibility?.pending || [],
            nextCheckAt: plan.nextCheckAt.toISOString(),
            reason: `${eligibility?.reason || 'sem ação editorial'}; ${plan.reason}`,
          };
        }

        if (Boolean(contLock?.bloqueado) && guardStored && guardCurrent && guardStored !== guardCurrent) {
          hints.editorialContinental = {
            ...(hints.editorialContinental || {}),
            staleCircuitBreaker: true,
            staleBreakerReason: 'fingerprint mudou após correção de governança; lock antigo não bloqueia a versão nova',
          };
        }
      }
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

    // 6) Grade futura: somente uma lacuna REAL dentro de 72h é operacional.
    // Jogos mais distantes ficam simplesmente "a confirmar" e NÃO abrem Action.
    // Para cada event_id há no máximo tentativas determinísticas em T-72h, T-24h e T-6h.
    const coverage = tvCoverage(games, tv, now);
    const tvCandidates = [];
    for (const row of coverage.missing) {
      const game = row.game;
      if (finalIds.has(game.eventId)) continue;
      const lastCheckpoint = await this.state.storage.get(`tvcp:${game.eventId}`);
      const cp = tvCheckpointDue(game, now, typeof lastCheckpoint === 'number' ? lastCheckpoint : null);
      if (cp == null) continue;
      tvCandidates.push({ game, cp, hours: row.hours });
    }
    tvCandidates.sort((a, b) => a.hours - b.hours);
    hints.transmissoesTv = {
      windowHours: POLICY.transmissoes.tvWindowHours,
      missing72h: coverage.missing72h,
      critical24h: coverage.critical24h,
      critical6h: coverage.critical6h,
      nextTargets: tvCandidates.slice(0, 5).map((row) => ({ eventId: row.game.eventId, checkpoint: row.cp, hours: Math.round(row.hours * 10) / 10 })),
    };
    if (tvCandidates.length) {
      const { game, cp } = tvCandidates[0];
      return {
        action: 'transmissoes_tv', eventId: game.eventId, checkpoint: cp,
        fingerprint: `tv-ausente:${game.eventId}:T${cp}`,
        reason: `Grade ausente para ${gameLabel(game)} dentro da janela operacional; tentativa determinística T${cp >= 0 ? '+' : ''}${cp}.`,
        retryMinutes: 1,
        stateUpdates: { [`tvcp:${game.eventId}`]: cp, 'tv:last': now.toISOString() }, hints,
      };
    }

    return { action: 'none', reason: 'Estado consistente; nenhum workflow pesado precisa rodar.', retryMinutes: 0, hints };
  }
}

function hoursSince(last, now) {
  return minutesBetween(last, now) / 60;
}
