(function () {
  'use strict';

  const PUSH = window.FormulaDoGolPush;
  if (!PUSH) return;

  const DEFAULTS = Object.freeze({
    goals: true,
    overturnedGoals: true,
    finalWhistle: false,
    allGames: false,
    teams: [],
    games: []
  });
  const state = {
    loaded: false,
    loading: false,
    subscription: null,
    preferences: { ...DEFAULTS },
    clubs: [],
    agenda: [],
    error: ''
  };

  function text(value) { return String(value == null ? '' : value).trim(); }
  function escapeHtml(value) {
    return text(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }
  function slug(value) {
    return text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function teamTokenFromAgenda(teamName) {
    const target = slug(teamName);
    if (!target) return '';
    for (const game of state.agenda || []) {
      for (const side of [game.mandante, game.visitante]) {
        if (!side || slug(side.nome || side.name) !== target) continue;
        const espnId = text(side.espn_id || side.espnId || side.id);
        if (espnId) return `espn:${espnId}`;
      }
    }
    return '';
  }
  function canonicalTeamToken(teamId, teamName) {
    const raw = text(teamId);
    if (/^(?:espn|abbr|team):[A-Za-z0-9._:-]+$/i.test(raw)) return raw;
    const name = teamName || teamId;
    const espn = teamTokenFromAgenda(name);
    if (espn) return espn;
    const target = slug(name);
    const club = (state.clubs || []).find((item) => slug(item?.nome) === target);
    const abbr = text(club?.sigla).toUpperCase();
    if (abbr) return `abbr:${abbr}`;
    return `team:${target}`;
  }
  function uniq(values, max) {
    return [...new Set((Array.isArray(values) ? values : []).map((v) => text(v)).filter(Boolean))].slice(0, max);
  }
  function normalizePreferences(value) {
    const src = value || {};
    return {
      goals: src.goals !== false,
      overturnedGoals: src.overturnedGoals !== false,
      finalWhistle: false,
      allGames: src.allGames === true,
      teams: uniq(src.teams, 10),
      games: uniq(src.games, 30)
    };
  }
  function clonePreferences() {
    return normalizePreferences(JSON.parse(JSON.stringify(state.preferences || DEFAULTS)));
  }
  function hasScope(prefs = state.preferences) {
    return Boolean(prefs.allGames || prefs.teams.length || prefs.games.length);
  }

  function iosNeedsInstall() {
    return Boolean(window.FormulaDoGolPWA?.isIOS?.() && !window.FormulaDoGolPWA?.isStandalone?.());
  }

  function showMessage(message, type = 'info') {
    let node = document.getElementById('fdg-alert-toast');
    if (!node) {
      node = document.createElement('div');
      node.id = 'fdg-alert-toast';
      node.className = 'fdg-alert-toast';
      node.setAttribute('role', 'status');
      node.setAttribute('aria-live', 'polite');
      document.body.appendChild(node);
    }
    node.className = `fdg-alert-toast is-${type}`;
    node.textContent = message;
    node.hidden = false;
    clearTimeout(showMessage._timer);
    showMessage._timer = setTimeout(() => { node.hidden = true; }, 4200);
  }

  async function ensureLoaded(force = false) {
    if (state.loaded && !force) return state;
    if (state.loading) {
      await new Promise((resolve) => {
        const timer = setInterval(() => { if (!state.loading) { clearInterval(timer); resolve(); } }, 30);
      });
      return state;
    }
    state.loading = true;
    try {
      state.subscription = await PUSH.getSubscription().catch(() => null);
      const result = await PUSH.getPreferences().catch(() => null);
      state.preferences = normalizePreferences(result?.preferences || DEFAULTS);
      state.error = '';
      state.loaded = true;
    } catch (error) {
      state.error = text(error?.message || error);
      state.loaded = true;
    } finally {
      state.loading = false;
    }
    return state;
  }

  async function persist(next, activating) {
    const prefs = normalizePreferences(next);
    if (activating && iosNeedsInstall()) {
      window.FormulaDoGolPWA?.openInstallHelp?.();
      throw new Error('No iPhone, abra o Fórmula do Gol pelo ícone instalado na Tela de Início para ativar os alertas.');
    }
    if (activating && !PUSH.supported()) throw new Error('Este navegador não oferece Web Push neste contexto.');

    if (activating && !state.subscription) {
      await PUSH.subscribe({ preferences: prefs });
      state.subscription = await PUSH.getSubscription();
    } else if (state.subscription) {
      await PUSH.savePreferences(prefs);
    } else {
      // Sem assinatura não há necessidade de gravar uma preferência inativa no backend.
      state.preferences = prefs;
      updateSurfaces();
      return prefs;
    }
    state.preferences = prefs;
    state.error = '';
    updateSurfaces();
    renderManager();
    return prefs;
  }

  async function toggleGame(eventId) {
    await ensureLoaded();
    const id = text(eventId);
    if (!id) return;
    const next = clonePreferences();
    const current = new Set(next.games);
    const adding = !current.has(id);
    if (adding) current.add(id); else current.delete(id);
    next.games = [...current].slice(0, 30);
    await persist(next, adding);
    showMessage(adding ? 'Alertas desta partida ativados.' : 'Alertas desta partida desativados.', 'success');
  }

  async function toggleTeam(teamId, teamName) {
    await ensureLoaded();
    const id = canonicalTeamToken(teamId, teamName);
    if (!id) return;
    const next = clonePreferences();
    const current = new Set(next.teams);
    const adding = !current.has(id);
    if (adding) current.add(id); else current.delete(id);
    next.teams = [...current].slice(0, 10);
    await persist(next, adding);
    showMessage(adding ? `Alertas de ${teamName || id} ativados.` : `Alertas de ${teamName || id} desativados.`, 'success');
  }

  async function setAllGames(enabled) {
    await ensureLoaded();
    const next = clonePreferences();
    next.allGames = Boolean(enabled);
    await persist(next, Boolean(enabled));
    showMessage(enabled ? 'Alertas de todos os jogos ativados.' : 'Alertas de todos os jogos desativados.', 'success');
  }

  async function setEventType(key, enabled) {
    await ensureLoaded();
    const next = clonePreferences();
    if (key === 'goals') next.goals = Boolean(enabled);
    if (key === 'overturnedGoals') next.overturnedGoals = Boolean(enabled);
    if (!state.subscription && hasScope(next)) {
      await persist(next, true);
    } else {
      await persist(next, false);
    }
    showMessage('Preferência atualizada.', 'success');
  }

  async function disableDevice() {
    await ensureLoaded();
    if (!state.subscription) return;
    try { await PUSH.savePreferences({ ...DEFAULTS, teams: [], games: [] }); } catch (_) {}
    await PUSH.unsubscribe();
    state.subscription = null;
    state.preferences = normalizePreferences(DEFAULTS);
    updateSurfaces();
    renderManager();
    try { await PUSH.clearBadge(); } catch (_) {}
    showMessage('Notificações desativadas neste aparelho.', 'success');
  }

  function gameButtonHtml(eventId, compact = false) {
    const active = state.preferences.games.includes(text(eventId));
    return `<button type="button" class="fdg-alert-button${active ? ' is-active' : ''}${compact ? ' is-compact' : ''}" data-fdg-game-alert="${escapeHtml(eventId)}" aria-pressed="${active ? 'true' : 'false'}">${active ? '🔔 Alerta ativo' : '🔔 Receber alertas'}</button>`;
  }

  function teamButtonHtml(teamId, teamName) {
    const id = canonicalTeamToken(teamId, teamName);
    const active = state.preferences.teams.includes(id);
    return `<button type="button" class="fdg-alert-button${active ? ' is-active' : ''}" data-fdg-team-alert="${escapeHtml(id)}" data-fdg-team-name="${escapeHtml(teamName || id)}" aria-pressed="${active ? 'true' : 'false'}">${active ? '🔔 Alertas do clube ativos' : '🔔 Receber alertas deste clube'}</button>`;
  }

  function updateGameSlots() {
    document.querySelectorAll('[data-fdg-game-alert-slot]').forEach((slot) => {
      const eventId = text(slot.getAttribute('data-event-id'));
      if (!eventId) return;
      const card = slot.closest('.jogo-card, .agenda-game');
      if (card?.classList.contains('post')) { if (slot.innerHTML) slot.innerHTML = ''; return; }
      const html = gameButtonHtml(eventId, true);
      if (slot.innerHTML !== html) slot.innerHTML = html;
    });
  }

  function updateTeamSlots() {
    document.querySelectorAll('[data-fdg-team-alert-slot]').forEach((slot) => {
      const teamId = text(slot.getAttribute('data-team-id'));
      const teamName = text(slot.getAttribute('data-team-name'));
      if (!teamId) return;
      const html = teamButtonHtml(teamId, teamName);
      if (slot.innerHTML !== html) slot.innerHTML = html;
    });
  }

  function currentLiveEventId() {
    const app = document.getElementById('live-app');
    const fromApp = text(app?.dataset?.eventId);
    if (fromApp) return fromApp;
    const active = document.querySelector('.live-game-tab.active[data-game-id]');
    if (active) return text(active.getAttribute('data-game-id'));
    return text(new URLSearchParams(location.search).get('event'));
  }

  function updateLiveSlot() {
    const slot = document.getElementById('fdg-live-alert-action');
    if (!slot) return;
    const eventId = currentLiveEventId();
    const ended = Boolean(document.querySelector('#live-app .live-state-badge.post'));
    slot.hidden = !eventId || ended;
    const html = (!eventId || ended) ? '' : gameButtonHtml(eventId, false);
    if (slot.innerHTML !== html) slot.innerHTML = html;
  }

  function updateSurfaces() {
    updateGameSlots();
    updateTeamSlots();
    updateLiveSlot();
  }

  async function fetchJson(url, fallback) {
    try {
      const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (_) {
      return fallback;
    }
  }

  function formatGameDate(iso) {
    const date = new Date(iso || '');
    if (!Number.isFinite(date.getTime())) return 'Data a confirmar';
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    }).format(date);
  }

  async function loadManagerData() {
    const [clubs, agenda] = await Promise.all([
      fetchJson('/dados-br/clubes.json', { clubes: [] }),
      fetchJson('/dados-br/agenda-clubes-br.json', { jogos: [] })
    ]);
    state.clubs = Array.isArray(clubs?.clubes) ? clubs.clubes.slice().sort((a, b) => text(a.nome).localeCompare(text(b.nome), 'pt-BR')) : [];
    state.agenda = Array.isArray(agenda?.jogos) ? agenda.jogos.slice().sort((a, b) => text(a.data_iso).localeCompare(text(b.data_iso))) : [];
  }

  function managerStatusHtml() {
    const permission = 'Notification' in window ? Notification.permission : 'unsupported';
    if (iosNeedsInstall()) return '<div class="fdg-alert-status is-warning"><strong>Instalação necessária no iPhone.</strong><span>Adicione o Fórmula do Gol à Tela de Início e abra pelo ícone para ativar Web Push.</span></div>';
    if (permission === 'denied') return '<div class="fdg-alert-status is-error"><strong>Notificações bloqueadas.</strong><span>Reative a permissão do Fórmula do Gol nas configurações do navegador/sistema.</span></div>';
    if (!state.subscription) return '<div class="fdg-alert-status"><strong>Alertas ainda não ativados neste aparelho.</strong><span>Escolha um clube, uma partida ou “Todos os jogos”. A permissão será solicitada somente após sua ação.</span></div>';
    if (!hasScope()) return '<div class="fdg-alert-status is-warning"><strong>Notificações autorizadas, mas nenhum jogo está selecionado.</strong><span>Escolha abaixo quando deseja receber os alertas.</span></div>';
    return '<div class="fdg-alert-status is-ok"><strong>Alertas ativos neste aparelho.</strong><span>O Fórmula do Gol pode enviar notificações mesmo com o site fechado.</span></div>';
  }

  function renderTeams() {
    if (!state.clubs.length) return '<div class="fdg-alert-empty">Clubes indisponíveis no momento.</div>';
    return `<div class="fdg-alert-team-grid">${state.clubs.map((club) => {
      const id = canonicalTeamToken('', club.nome);
      const active = state.preferences.teams.includes(id);
      return `<button type="button" class="fdg-alert-team${active ? ' is-active' : ''}" data-fdg-team-alert="${escapeHtml(id)}" data-fdg-team-name="${escapeHtml(club.nome)}" aria-pressed="${active ? 'true' : 'false'}">
        <img src="${escapeHtml(club.escudo || '/img/escudo-neutro.svg')}" alt="" loading="lazy">
        <span>${escapeHtml(club.nome)}</span><strong>${active ? '🔔' : '＋'}</strong>
      </button>`;
    }).join('')}</div>`;
  }

  function renderGames() {
    const now = Date.now();
    const horizon = now + 14 * 24 * 60 * 60_000;
    const selected = new Set(state.preferences.games);
    const games = state.agenda.filter((game) => {
      const id = text(game.event_id || game.id);
      const when = Date.parse(game.data_iso || '');
      return selected.has(id) || (Number.isFinite(when) && when >= now - 3 * 60 * 60_000 && when <= horizon && game.concluido !== true);
    });
    if (!games.length) return '<div class="fdg-alert-empty">Não há partidas disponíveis nesta janela.</div>';
    return `<div class="fdg-alert-game-list">${games.map((game) => {
      const id = text(game.event_id || game.id);
      const active = selected.has(id);
      const home = text(game.mandante?.nome || game.mandante || 'Mandante');
      const away = text(game.visitante?.nome || game.visitante || 'Visitante');
      return `<article class="fdg-alert-game${active ? ' is-active' : ''}">
        <div><small>${escapeHtml(game.competicao_nome_curto || game.competicao_nome || '')} · ${escapeHtml(formatGameDate(game.data_iso))}</small><strong>${escapeHtml(home)} × ${escapeHtml(away)}</strong></div>
        <button type="button" class="fdg-alert-button is-compact${active ? ' is-active' : ''}" data-fdg-game-alert="${escapeHtml(id)}" aria-pressed="${active ? 'true' : 'false'}">${active ? '🔔 Ativo' : '🔔 Alertar'}</button>
      </article>`;
    }).join('')}</div>`;
  }

  function renderManager() {
    const root = document.getElementById('fdg-alertas-app');
    if (!root || !state.loaded) return;
    const p = state.preferences;
    root.innerHTML = `
      ${managerStatusHtml()}
      <section class="panel fdg-alert-panel"><div class="panel-inner">
        <div class="fdg-alert-section-head"><div><div class="kicker">Escopo</div><h2>Quais jogos avisar?</h2></div></div>
        <button type="button" class="fdg-alert-all${p.allGames ? ' is-active' : ''}" data-fdg-all-games aria-pressed="${p.allGames ? 'true' : 'false'}">
          <span><strong>🔔 Todos os jogos</strong><small>Brasileirão, Copa do Brasil, Libertadores e Sul-Americana monitorados pelo Fórmula do Gol.</small></span><b>${p.allGames ? 'Ativado' : 'Desativado'}</b>
        </button>
        <p class="fdg-alert-note">“Todos os jogos” pode gerar muitas notificações. Você também pode acompanhar somente seus clubes ou partidas específicas.</p>
      </div></section>
      <section class="panel fdg-alert-panel"><div class="panel-inner">
        <div class="fdg-alert-section-head"><div><div class="kicker">Meu time</div><h2>Clubes favoritos</h2></div><span>${p.teams.length}/10</span></div>
        ${renderTeams()}
      </div></section>
      <section class="panel fdg-alert-panel"><div class="panel-inner">
        <div class="fdg-alert-section-head"><div><div class="kicker">Partidas</div><h2>Jogos específicos</h2></div><span>${p.games.length}/30</span></div>
        ${renderGames()}
      </div></section>
      <section class="panel fdg-alert-panel"><div class="panel-inner">
        <div class="fdg-alert-section-head"><div><div class="kicker">Tipos</div><h2>O que receber?</h2></div></div>
        <label class="fdg-alert-switch"><span><strong>⚽ Gols</strong><small>Autor, minuto e placar atualizado.</small></span><input type="checkbox" data-fdg-type="goals" ${p.goals ? 'checked' : ''}><i></i></label>
        <label class="fdg-alert-switch"><span><strong>🚫 Gols anulados</strong><small>Correção automática quando o placar é revertido após a confirmação.</small></span><input type="checkbox" data-fdg-type="overturnedGoals" ${p.overturnedGoals ? 'checked' : ''}><i></i></label>
      </div></section>
      <section class="panel fdg-alert-panel fdg-alert-danger"><div class="panel-inner">
        <h2>Este aparelho</h2>
        <p>As escolhas ficam associadas anonimamente a este navegador/aparelho. Não há conta, login ou senha.</p>
        <div class="fdg-alert-actions"><a class="fdg-alert-link" href="/privacidade.html">Política de privacidade</a><button type="button" class="fdg-alert-disable" data-fdg-disable ${state.subscription ? '' : 'disabled'}>Desativar notificações neste aparelho</button></div>
      </div></section>`;
  }

  async function initManager() {
    const root = document.getElementById('fdg-alertas-app');
    if (!root) return;
    root.innerHTML = '<div class="fdg-alert-loading">Carregando preferências…</div>';
    await ensureLoaded();
    if (!state.clubs.length || !state.agenda.length) await loadManagerData();
    renderManager();
  }

  document.addEventListener('click', async (event) => {
    const game = event.target.closest('[data-fdg-game-alert]');
    const team = event.target.closest('[data-fdg-team-alert]');
    const all = event.target.closest('[data-fdg-all-games]');
    const disable = event.target.closest('[data-fdg-disable]');
    if (!game && !team && !all && !disable) return;
    event.preventDefault();
    event.stopPropagation();
    const button = game || team || all || disable;
    if (button.disabled) return;
    button.disabled = true;
    try {
      if (game) await toggleGame(game.getAttribute('data-fdg-game-alert'));
      else if (team) await toggleTeam(team.getAttribute('data-fdg-team-alert'), team.getAttribute('data-fdg-team-name'));
      else if (all) await setAllGames(!state.preferences.allGames);
      else if (disable) await disableDevice();
    } catch (error) {
      showMessage(text(error?.message || error), 'error');
    } finally {
      button.disabled = false;
      updateSurfaces();
      renderManager();
    }
  });

  document.addEventListener('change', async (event) => {
    const input = event.target.closest('[data-fdg-type]');
    if (!input) return;
    input.disabled = true;
    try {
      await setEventType(input.getAttribute('data-fdg-type'), input.checked);
    } catch (error) {
      input.checked = !input.checked;
      showMessage(text(error?.message || error), 'error');
    } finally {
      input.disabled = false;
      renderManager();
    }
  });

  document.addEventListener('fdg:live-game-changed', updateLiveSlot);
  window.addEventListener('hashchange', () => setTimeout(updateTeamSlots, 30));

  const observer = new MutationObserver(() => {
    if (!state.loaded) return;
    updateSurfaces();
  });

  document.addEventListener('DOMContentLoaded', async () => {
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-event-id', 'data-team-id'] });
    await ensureLoaded();
    await loadManagerData();
    updateSurfaces();
    await initManager();
  }, { once: true });

  window.FormulaDoGolAlerts = Object.freeze({
    ensureLoaded, toggleGame, toggleTeam, setAllGames, disableDevice, updateSurfaces,
    get preferences() { return clonePreferences(); }
  });
})();
