const FEEDBACK_INTERVAL_MS = 10 * 60_000;
const FEEDBACK_LIMIT = 50;
const META_KEY = 'feedback_notifier:last_run_at';

function text(value) { return String(value ?? '').trim(); }

export function feedbackNotifierConfigured(env) {
  return Boolean(text(env?.SUPABASE_URL) && text(env?.SUPABASE_SERVICE_ROLE_KEY) && text(env?.RESEND_API_KEY));
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function brDate(value) {
  const ms = Date.parse(text(value));
  if (!Number.isFinite(ms)) return text(value) || '(sem data)';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(ms));
}

const TYPE_LABEL = Object.freeze({
  sugestao: 'Sugestão', erro: 'Erro / Bug', elogio: 'Elogio', duvida: 'Dúvida', outro: 'Outro',
});

export function buildFeedbackEmail(feedback) {
  const type = text(feedback?.tipo).toLowerCase();
  const label = TYPE_LABEL[type] || type || '(sem tipo)';
  const message = text(feedback?.mensagem) || '(mensagem vazia)';
  const signature = text(feedback?.assinatura) || '(anônimo)';
  const page = text(feedback?.pagina) || '(sem página)';
  const visitor = text(feedback?.visitante_id) || '(sem id)';
  const userAgent = text(feedback?.user_agent) || '(sem UA)';
  const date = brDate(feedback?.criado_em);
  const id = text(feedback?.id) || '(sem id)';
  const subject = `[Fórmula do Gol] ${label} — ${message.slice(0, 60)}${message.length > 60 ? '…' : ''}`;
  const plain = [
    'Nova sugestão recebida no site Fórmula do Gol', '',
    `Tipo: ${label}`, `Recebido: ${date} (Brasília)`, `Página: ${page}`, `Assinatura: ${signature}`, '',
    'Mensagem:', message, '', `ID: ${id}`, `Visitante: ${visitor}`, `User-Agent: ${userAgent}`,
  ].join('\n');
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;color:#1a2530;background:#f4f6f8;padding:20px"><div style="max-width:620px;margin:auto;background:#fff;border-radius:12px;padding:22px"><div style="font-size:12px;color:#64748b">Fórmula do Gol · Nova sugestão</div><h2 style="margin:6px 0 18px">${escapeHtml(label)}</h2><div style="font-size:13px;color:#5a6975">Recebido em <strong>${escapeHtml(date)}</strong> (Brasília) · página ${escapeHtml(page)}</div><div style="margin:16px 0;padding:14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:9px;white-space:pre-wrap">${escapeHtml(message)}</div><div><strong>Assinatura:</strong> ${escapeHtml(signature)}</div><hr style="border:0;border-top:1px solid #eef2f6;margin:18px 0"><div style="font-size:12px;color:#64748b">ID: ${escapeHtml(id)}<br>Visitante: ${escapeHtml(visitor)}<br>User-Agent: ${escapeHtml(userAgent)}</div></div></body></html>`;
  return { subject, plain, html };
}

function supabaseHeaders(env) {
  const key = text(env.SUPABASE_SERVICE_ROLE_KEY);
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function metaGet(env, key) {
  const row = await env.DB.prepare('SELECT value FROM postgame_meta WHERE key=?').bind(key).first();
  return text(row?.value);
}

async function metaPut(env, key, value) {
  await env.DB.prepare(`INSERT INTO postgame_meta(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).bind(key, text(value)).run();
}

async function pendingFeedback(env) {
  const base = text(env.SUPABASE_URL).replace(/\/+$/, '');
  const url = new URL(`${base}/rest/v1/feedback_site`);
  url.searchParams.set('select', 'id,criado_em,tipo,mensagem,assinatura,pagina,visitante_id,user_agent,enviado_email');
  url.searchParams.set('enviado_email', 'eq.false');
  url.searchParams.set('order', 'criado_em.asc');
  url.searchParams.set('limit', String(FEEDBACK_LIMIT));
  const response = await fetch(url.toString(), { headers: supabaseHeaders(env) });
  if (!response.ok) throw new Error(`supabase_feedback_get_http_${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('supabase_feedback_payload_invalid');
  return rows;
}

async function markSent(env, id) {
  const base = text(env.SUPABASE_URL).replace(/\/+$/, '');
  const url = new URL(`${base}/rest/v1/feedback_site`);
  url.searchParams.set('id', `eq.${text(id)}`);
  const response = await fetch(url.toString(), {
    method: 'PATCH',
    headers: { ...supabaseHeaders(env), Prefer: 'return=minimal' },
    body: JSON.stringify({ enviado_email: true }),
  });
  if (!response.ok) throw new Error(`supabase_feedback_patch_http_${response.status}`);
}

async function sendEmail(env, feedback) {
  const email = buildFeedbackEmail(feedback);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${text(env.RESEND_API_KEY)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: text(env.EMAIL_REMETENTE || 'Fórmula do Gol <onboarding@resend.dev>'),
      to: [text(env.EMAIL_DESTINO || 'avisos@formuladogol.com.br')], subject: email.subject, text: email.plain, html: email.html,
    }),
  });
  if (!response.ok) throw new Error(`resend_feedback_http_${response.status}:${(await response.text()).slice(0, 200)}`);
}

export async function runFeedbackNotifier(env, now = Date.now()) {
  if (!feedbackNotifierConfigured(env)) return { ok: true, skipped: 'not_configured', sent: 0 };
  if (!env?.DB) return { ok: false, skipped: 'db_missing', sent: 0 };

  const last = Date.parse(await metaGet(env, META_KEY)) || 0;
  if (last && now - last < FEEDBACK_INTERVAL_MS) return { ok: true, skipped: 'throttled', sent: 0 };
  // Marca a janela antes da chamada externa para impedir tempestade de retries no cron de 1 minuto.
  await metaPut(env, META_KEY, new Date(now).toISOString());

  const rows = await pendingFeedback(env);
  let sent = 0;
  const errors = [];
  for (const row of rows) {
    try {
      await sendEmail(env, row);
      await markSent(env, row.id);
      sent += 1;
    } catch (error) {
      errors.push(`${text(row?.id) || '?'}:${text(error?.message || error).slice(0, 240)}`);
    }
  }
  return { ok: errors.length === 0, checked: rows.length, sent, errors: errors.slice(0, 10) };
}
