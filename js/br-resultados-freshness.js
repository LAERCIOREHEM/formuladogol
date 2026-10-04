(function (root) {
  'use strict';

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function toMs(value) {
    if (value == null || value === '') return NaN;
    if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
    const raw = text(value);
    if (!raw) return NaN;
    const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?(?:\s+BRT)?$/i);
    if (br) {
      const [, dd, mm, yyyy, hh, min, sec = '00'] = br;
      const iso = `${yyyy}-${mm}-${dd}T${hh}:${min}:${sec}-03:00`;
      const ms = Date.parse(iso);
      return Number.isFinite(ms) ? ms : NaN;
    }
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : NaN;
  }

  function latestEntry(entries) {
    let best = null;
    for (const entry of entries || []) {
      const value = entry && typeof entry === 'object' && 'value' in entry ? entry.value : entry;
      const ms = toMs(value);
      if (!Number.isFinite(ms)) continue;
      if (!best || ms > best.ms) {
        best = {
          ms,
          value,
          source: entry && typeof entry === 'object' ? text(entry.source) : ''
        };
      }
    }
    return best;
  }

  function latestTimestamp(values) {
    const best = latestEntry((values || []).map((value) => ({ value })));
    return best ? new Date(best.ms).toISOString() : null;
  }

  function formatBrt(value) {
    const ms = toMs(value);
    if (!Number.isFinite(ms)) return '';
    const parts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(ms));
    const get = (type) => (parts.find((part) => part.type === type) || {}).value || '';
    return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')} BRT`;
  }

  function effectiveUpdate(state) {
    const s = state || {};
    const entries = [
      { value: s.resultadosMeta && s.resultadosMeta.atualizado_em, source: 'resultado' },
      { value: s.melhoresMomentosMeta && s.melhoresMomentosMeta.atualizado_em, source: 'melhores-momentos' },
      { value: s.jogosDetalhesMeta && s.jogosDetalhesMeta.gerado_em, source: 'detalhes-estatisticas-publico' }
    ];

    for (const row of Object.values(s.postgameFastlane || {})) {
      if (!row || typeof row !== 'object') continue;
      if (row.public_status === 'resolved' && (Number(row.publico) > 0 || Number(row.renda) > 0)) {
        entries.push({ value: row.public_last_at, source: `publico-renda:${text(row.event_id)}` });
      }
      if (row.highlight_status === 'resolved' && row.highlight) {
        entries.push({ value: row.highlight_last_at, source: `melhores-momentos-fastlane:${text(row.event_id)}` });
        entries.push({ value: row.highlight.resolved_at, source: `melhores-momentos-fastlane:${text(row.event_id)}` });
        entries.push({ value: row.highlight.published_at, source: `melhores-momentos-publicacao:${text(row.event_id)}` });
      }
    }

    const best = latestEntry(entries);
    if (!best) {
      const fallback = text(s.resultadosMeta && s.resultadosMeta.atualizado_em_br);
      return { iso: null, br: fallback, source: fallback ? 'resultado-br-fallback' : '', ms: NaN };
    }
    return {
      iso: new Date(best.ms).toISOString(),
      br: formatBrt(best.ms),
      source: best.source,
      ms: best.ms
    };
  }

  root.BRResultadosFreshness = Object.freeze({
    toMs,
    latestTimestamp,
    formatBrt,
    effectiveUpdate
  });
})(globalThis);
