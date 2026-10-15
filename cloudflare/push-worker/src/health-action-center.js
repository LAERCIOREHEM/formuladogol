/* R10R17.6 — HEALTH ACTION CENTER
   Diagnósticos e orientações determinísticas. Não chama provedores de IA,
   não expõe credenciais e não muda automaticamente limites financeiros. */

export const HEALTH_ACTION_CENTER_VERSION = 1;
export const HEALTH_YELLOW_CONFIRM_MS = 15 * 60_000;
const MAX_ERROR_ROWS = 5;

const str = (v) => String(v == null ? '' : v).trim();
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const age = (t, now) => { const v = Date.parse(str(t)); return Number.isFinite(v) ? Math.max(0, Math.floor((now - v) / 60_000)) : null; };
const ptAge = (mins) => mins == null ? 'idade não informada' : mins >= 60 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2,'0')}` : `${mins}min`;
const clean = (s, max = 200) => str(s)
  .replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ')
  .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
  .replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
  .slice(0,max);

export function buildActionCenter(snapshot = {}, now = Date.now()) {
  const indicators = Array.isArray(snapshot.indicators) ? snapshot.indicators : [];
  const result = { version: HEALTH_ACTION_CENTER_VERSION, requiresAttention: [], informational: [], generatedAt: new Date(now).toISOString() };
  const p = snapshot.providers || {};
  const failures = Array.isArray(snapshot.providerFailureRows) ? snapshot.providerFailureRows : [];
  const highlights = Array.isArray(snapshot.postgame?.highlightPendingRows) ? snapshot.postgame.highlightPendingRows : [];

  for (const ind of indicators) {
    const severity = str(ind.severity);
    if (severity === 'green') continue;
    const action = {
      id: str(ind.id), label: str(ind.label), severity,
      problem: clean(ind.detail, 320),
      impact: 'A saúde do componente precisa de confirmação; o site pode continuar operando.',
      responsibility: 'AUTO',
      recommendation: 'O Health Monitor continuará verificando. Se persistir, consultar o endpoint de saúde do componente.',
      evidence: [], nextCheck: 'Reavaliação automática no próximo ciclo de 5 minutos.',
      link: 'https://push.formuladogol.com.br/v1/health-monitor/status',
    };
    switch (action.id) {
      case 'github':
        action.impact = 'Despachos anômalos podem consumir recursos ou indicar orquestração indevida.';
        action.responsibility = 'MANUAL';
        action.recommendation = 'Abrir Actions, filtrar falhas e disparos inesperados; não executar novamente os workflows antes de identificar a origem.';
        action.link = 'https://github.com/LAERCIOREHEM/formuladogol/actions';
        break;
      case 'continentais':
        action.impact = 'Partida oficial ausente ou integridade da agenda sem confirmação.';
        action.responsibility = 'AUTO';
        action.recommendation = 'O Orchestrator deve atualizar a agenda; verificar conflitos de horário, clubes e IDs antes de alterar a correção documental.';
        action.link = 'https://formuladogol.com.br/agenda.html';
        break;
      case 'highlights': {
        action.impact = 'Melhores Momentos podem demorar a aparecer na página de resultados.';
        action.responsibility = 'AUTO';
        action.link = 'https://push.formuladogol.com.br/v1/postgame';
        const top = highlights.slice(0, 3);
        action.evidence = top.map(h => {
          const elapsed = age(h.finalAt, now);
          return clean(`${h.home} x ${h.away} [${h.eventId}] — ${ptAge(elapsed)} após FINAL; ${n(h.attempts)} tentativa(s); último erro: ${h.lastError || 'não informado'}; próxima busca: ${h.nextAt || 'a definir'}`, 420);
        });
        if (top.some(h => (age(h.finalAt,now) ?? 0) >= 12*60 && n(h.attempts) >= 5)) {
          action.responsibility = 'MANUAL';
          action.recommendation = 'Verificar se existe vídeo oficial da partida e se o canal/competição é elegível. Não inserir link não oficial. O Hunter continuará tentando automaticamente.';
        } else {
          action.recommendation = 'Nenhuma intervenção imediata. O Hunter continuará pesquisando vídeos oficiais; reavaliar somente se o prazo crescer ou a mesma falha se repetir.';
        }
        break;
      }
      case 'openai': {
        const byProvider = (p.byProvider || []).filter(v => n(v.failures)>0)
          .map(v => `${v.provider}: ${n(v.failures)} falha(s)/${n(v.calls)} chamada(s)`);
        action.evidence = [...byProvider.slice(0,4), ...failures.slice(0,MAX_ERROR_ROWS).map(v =>
          clean(`${v.provider}/${v.purpose}${v.eventId ? ` [${v.eventId}]` : ''} · HTTP ${v.httpStatus == null ? 'sem resposta' : v.httpStatus} · ${v.detail || 'detalhe não informado'} · ${v.recovered ? 'sucesso posterior no mesmo evento/finalidade' : 'sem recuperação comprovada'}`, 350))];
        const budget = snapshot.postgame?.cost?.budget || {};
        const pct = n(budget.monthPct);
        const failed = n(p.failures);
        const unresolved = snapshot.providerUnrecoveredFailures;
        action.impact = 'Falhas de provedores podem atrasar enriquecimento factual; o orçamento do Hunter pode limitar buscas pagas.';
        if (pct >= 100) {
          action.responsibility = 'MANUAL';
          action.recommendation = 'Orçamento mensal atingido. Revisar consumo e fontes; qualquer aumento do teto exige decisão explícita. Não aumentar automaticamente.';
        } else if (failed > 3 && (unresolved == null || n(unresolved)>0)) {
          action.responsibility = 'AUTO';
          action.recommendation = 'Consultar os HTTP/códigos de erro acima. O fallback continua ativo; intervir somente se houver tarefa sem resultado ou erro persistente de autenticação.';
        } else if (pct >= n(budget.warningPct || 80)) {
          action.responsibility = 'MANUAL';
          action.recommendation = 'Consumo próximo do teto mensal. Revisar buscas por evento e decidir se mantém o limite atual; não atualizar secrets nem ampliar orçamento sem diagnóstico.';
        } else {
          action.recommendation = 'Revisar logs de IA e confirmar se alguma tarefa continua pendente; não trocar chaves preventivamente.';
        }
        action.link = 'https://push.formuladogol.com.br/v1/health-monitor/status';
        break;
      }
      case 'postgame':
        action.impact = 'Público e renda podem permanecer ausentes ou aguardando classificação.';
        action.responsibility = 'AUTO';
        action.responsibility = snapshot.postgame?.budgetGuard>0?'MANUAL':'AUTO';
        action.recommendation = 'O Hunter mantém retentativas. Só considerar correção documental quando houver fonte oficial verificável; budget guard exige revisão de custos.';
        action.evidence = (snapshot.postgame?.pendingRows || []).slice(0,3).map(x => clean(`${x.home} x ${x.away} · ${x.status} · ${x.attempts} tentativa(s) · ${x.lastError || 'sem erro'}`,280));
        action.link = 'https://push.formuladogol.com.br/v1/postgame/status';
        break;
      case 'editorial':
        action.impact = 'Conteúdos editoriais ou transmissões podem ficar incompletos.';
        action.evidence = (snapshot.orchestrator?.errors || []).map(x=>clean(x,240));
        action.responsibility = 'AUTO';
        action.recommendation = 'Conferir erros do ciclo do Orchestrator e reexecutar apenas a tarefa afetada quando houver falha persistente.';
        break;
      case 'infra':
        action.impact = 'Falha no serviço de e-mail pode impedir alertas de recuperação.';
        action.responsibility = 'MANUAL';
        action.recommendation = 'Verificar binding Cloudflare Email, endereço destinatário e fallback; não enviar senhas por e-mail.';
        break;
      case 'site':
        action.impact = 'O site público pode estar indisponível.';
        action.responsibility = 'MANUAL';
        action.recommendation = 'Abrir o site e conferir GitHub Pages e DNS; observar HTTP e horário da última implantação.';
        action.link = 'https://formuladogol.com.br/';
        break;
      case 'live':
        action.impact = 'Atualização do placar ou prontidão das partidas pode estar atrasada.';
        action.responsibility = 'AUTO';
        action.recommendation = 'Conferir último polling e readiness no monitor; não reiniciar Durable Object durante jogo em andamento.';
        action.link = 'https://push.formuladogol.com.br/v1/monitor/status';
        break;
      default:
        if (severity === 'red') action.responsibility='MANUAL';
        break;
    }
    result.requiresAttention.push(action);
  }
  const dispatches = n(snapshot.orchestrator?.githubDispatchesLast24h);
  if (dispatches > 8 && !result.requiresAttention.some(a => a.id==='github')) {
    result.informational.push(`GitHub Actions: ${dispatches} disparos em 24h; quantidade isolada não comprova falha nem loop.`);
  }
  const fallback = n(snapshot.continentalAgenda?.fallbacks);
  if (fallback>0 && snapshot.continentalAgenda?.integrityOk===true) {
    result.informational.push(`CONMEBOL: ${fallback} fallback(s) documentais com cobertura íntegra; conciliar ID ESPN antes de cada jogo.`);
  }
  const postWait=n(snapshot.postgame?.pending)-n(snapshot.postgame?.overdue)-n(snapshot.postgame?.budgetGuard);
  if(postWait>0) result.informational.push(`Pós-jogo: ${postWait} pendência(s) ainda dentro do SLA de público/renda; Hunter em operação.`);
  const highlightWait = n(snapshot.postgame?.highlightPending) - n(snapshot.postgame?.highlightOverdue);
  if(highlightWait>0) result.informational.push(`Melhores Momentos: ${highlightWait} pendência(s) ainda no prazo de tolerância.`);
  if (n(p.failures)>0 && n(snapshot.providerUnrecoveredFailures)===0 && snapshot.providerUnrecoveredFailures != null) {
    result.informational.push(`IA: ${p.failures} falha(s) com sucesso posterior registrado no mesmo evento/finalidade; acompanhar sem intervenção.`);
  }
  return result;
}

export function healthYellowDecision(row, now = Date.now(), delayMs = HEALTH_YELLOW_CONFIRM_MS) {
  if (!row || str(row.status) === 'resolved') return 'observe';
  if (str(row.status) === 'open') return 'already_open';
  if (str(row.status) !== 'observing') return 'observe';
  const opened = Date.parse(str(row.opened_at));
  return Number.isFinite(opened) && now - opened >= delayMs ? 'send' : 'wait';
}

export function healthActionMessage(action, snapshot, {recovered = false, now = Date.now(), downgraded = false} = {}) {
  const isRed = action.severity === 'red';
  const title = recovered ? '✅ RECUPERADO' : downgraded ? '🟡 DESAGRAVADO' : isRed ? '🔴 CRÍTICO' : '🟡 ATENÇÃO';
  const evidence = Array.isArray(action.evidence) && action.evidence.length ? action.evidence.map(s=>`  - ${clean(s,450)}`) : ['  - Ver detalhes no endpoint de diagnóstico.'];
  return {
    subject: `[FDG][${recovered?'RECUPERADO':downgraded?'DESAGRAVADO':isRed?'CRÍTICO':'ATENÇÃO'}] ${action.label}`,
    body: [
      'FÓRMULA DO GOL — HEALTH ACTION CENTER',
      title, '',
      `Indicador: ${action.label}`,
      `Quando: ${new Date(now).toISOString()}`,
      `Diagnóstico: ${action.problem}`,
      `Impacto: ${action.impact}`,
      'Evidências:', ...evidence, '',
      recovered ? 'Providência: nenhuma; condição normalizada.' : `Responsável: ${action.responsibility==='MANUAL'?'AÇÃO MANUAL NECESSÁRIA':action.responsibility==='OBSERVE'?'APENAS ACOMPANHAMENTO':'CORREÇÃO/REAVALIAÇÃO AUTOMÁTICA'}`,
      recovered ? '' : `O que fazer: ${action.recommendation}`,
      recovered ? '' : `Próxima checagem: ${action.nextCheck}`,
      `Diagnóstico: ${action.link}`,
      '',
      `Estado geral: ${str(snapshot?.state).toUpperCase()}`,
      'Este alerta não executou novas buscas pagas de IA.',
    ].filter(Boolean).join('\n'),
  };
}

export function healthActionDigestLines(snapshot = {}) {
  const plan = snapshot.actionCenter || buildActionCenter(snapshot);
  const actions = plan.requiresAttention || [];
  const info = plan.informational || [];
  if (!actions.length && !info.length) return ['CENTRAL DE AÇÕES', 'Nenhuma providência necessária.'];
  const output = ['CENTRAL DE AÇÕES — diagnóstico e providências'];
  if (actions.length) {
    output.push(`${actions.length} alerta(s) que exigem acompanhamento:`);
    for (const a of actions) {
      output.push(`${a.severity==='red'?'🔴':'🟡'} ${a.label}: ${a.problem}`);
      output.push(`  IMPACTO: ${a.impact}`);
      if (a.evidence?.length) output.push(...a.evidence.slice(0,3).map(e=>`  EVIDÊNCIA: ${e}`));
      output.push(`  RESPONSÁVEL: ${a.responsibility==='MANUAL'?'AÇÃO MANUAL NECESSÁRIA':'ACOMPANHAMENTO AUTOMÁTICO'}`);
      output.push(`  O QUE FAZER: ${a.recommendation}`);
      output.push(`  VERIFICAR: ${a.link}`);
    }
  } else output.push('Nenhum incidente confirmado exige ação neste momento.');
  if (info.length) output.push('SITUAÇÕES CONTROLADAS (não reduzem a saúde geral):', ...info.map(e=>`  ℹ️ ${e}`));
  return output;
}
