const WRITER_NAMES = new Set([
  'Atualizar Brasileirao (ESPN)',
  'Atualizar Elencos Brasileirao (ESPN)',
  'Auditar modelos AF-Previsão',
  'Auditoria IA diária',
  'Buscar melhores momentos oficiais',
  'Atualizar públicos do Brasileirão',
  'Buscar transmissões dos clubes do Brasileirão',
  'Publicar análise editorial da Copa do Brasil',
  'Publicar análise editorial continental',
  'Publicar análise editorial da rodada',
  'Revisar melhores momentos Brasileirão oficiais',
  'Apurar Apostas Brasileirão',
  'Deploy site (GitHub Pages)',
]);

function repoParts(env) {
  const [owner, repo] = String(env.GITHUB_REPOSITORY || '').split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY inválido');
  return { owner, repo };
}

function headers(env) {
  const token = String(env.GITHUB_TOKEN || '').trim();
  if (!token) throw new Error('secret GITHUB_TOKEN ausente no Worker');
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'FormulaDoGol-Orchestrator/1.0',
    'Content-Type': 'application/json',
  };
}

export async function activeWriter(env) {
  const { owner, repo } = repoParts(env);
  const branch = encodeURIComponent(String(env.GITHUB_BRANCH || 'main'));
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs?branch=${branch}&per_page=50`;
  const response = await fetch(url, { headers: headers(env) });
  if (!response.ok) throw new Error(`GitHub runs HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
  const payload = await response.json();
  return (payload?.workflow_runs || []).find((run) => WRITER_NAMES.has(String(run?.name || '')) && ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(String(run?.status || ''))) || null;
}

export async function dispatchWorkflow(env, workflow, inputs = {}) {
  const { owner, repo } = repoParts(env);
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  const body = {
    ref: String(env.GITHUB_BRANCH || 'main'),
    inputs: Object.fromEntries(Object.entries(inputs).filter(([, value]) => value !== undefined && value !== null && String(value) !== '')),
  };
  const response = await fetch(url, { method: 'POST', headers: headers(env), body: JSON.stringify(body) });
  if (response.status !== 204) throw new Error(`workflow_dispatch ${workflow} HTTP ${response.status}: ${(await response.text()).slice(0, 600)}`);
  return { ok: true, workflow, inputs: body.inputs };
}

export function dispatchSpec(decision) {
  switch (decision?.action) {
    case 'atualizar_brasileirao':
      return { workflow: 'atualizar-brasileirao.yml', inputs: {} };
    case 'publicos':
      return { workflow: 'atualizar-publicos-brasileirao.yml', inputs: {} };
    case 'melhores_momentos':
      return { workflow: 'buscar-melhores-momentos-getv.yml', inputs: { modo: 'incremental', event_id: decision.eventId || '' } };
    case 'transmissao_aovivo':
      return { workflow: 'buscar-transmissoes-aovivo-brasileirao.yml', inputs: { modo: 'aovivo', event_id: decision.eventId || '' } };
    case 'transmissoes_tv':
      return { workflow: 'buscar-transmissoes-aovivo-brasileirao.yml', inputs: { modo: 'tv' } };
    case 'editorial_copa_do_brasil':
      return { workflow: 'publicar-analise-copa-do-brasil.yml', inputs: {} };
    case 'editorial_continentais':
      return { workflow: 'publicar-analise-continentais.yml', inputs: {} };
    case 'editorial_rodada':
      return { workflow: 'publicar-analise-rodada.yml', inputs: { rodada: String(decision.round || '') } };
    default:
      throw new Error(`ação sem workflow: ${decision?.action || 'none'}`);
  }
}
