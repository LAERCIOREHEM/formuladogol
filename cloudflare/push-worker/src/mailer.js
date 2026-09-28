// Envio de e-mail do Worker.
//
// Transporte principal: Cloudflare Email Service via binding nativo `EMAIL`.
// Fallback 1: SMTP direto (SSL na 465, ou STARTTLS nas demais portas),
// reaproveitando SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS.
// Fallback 2: Resend, quando RESEND_API_KEY existir.
// Destino: EMAIL_DESTINO ou EMAIL_DESTINO_SUGESTOES.
//
// `cloudflare:sockets` é importado sob demanda: assim este módulo continua
// carregável pelos testes em Node, que injetam o próprio `connect`.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEFAULT_TIMEOUT_MS = 15_000;
const HELO_NAME = 'formuladogol.com.br';
const FROM_NAME = 'Fórmula do Gol';

function text(value) { return String(value ?? '').trim(); }

export function mailConfig(env = {}) {
  const to = text(env.EMAIL_DESTINO) || text(env.EMAIL_DESTINO_SUGESTOES);
  const from = text(env.EMAIL_REMETENTE) || 'saude@formuladogol.com.br';
  const port = Number(text(env.SMTP_PORT) || 465) || 465;
  const smtp = { host: text(env.SMTP_HOST), port, user: text(env.SMTP_USER), pass: text(env.SMTP_PASS) };
  const cloudflareReady = Boolean(to && env?.EMAIL && typeof env.EMAIL.send === 'function');
  const smtpReady = Boolean(smtp.host && smtp.user && smtp.pass && to);
  const resendReady = Boolean(text(env.RESEND_API_KEY) && to);
  const transport = cloudflareReady ? 'cloudflare-email' : (smtpReady ? 'smtp' : (resendReady ? 'resend' : 'none'));
  const fallbacks = [smtpReady ? 'smtp' : '', resendReady ? 'resend' : ''].filter(Boolean);
  return { to, from, smtp, cloudflareReady, smtpReady, resendReady, transport, fallbacks, configured: cloudflareReady || smtpReady || resendReady };
}

export function maskAddress(value) {
  const raw = text(value);
  const at = raw.indexOf('@');
  if (at < 1) return raw ? '***' : '';
  return `${raw[0]}***${raw.slice(at)}`;
}

// ------------------------------------------------------------------ MIME
function base64Bytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function base64Utf8(value) { return base64Bytes(encoder.encode(String(value))); }

function isAscii(value) { return /^[\x20-\x7e]*$/.test(value); }

// RFC 2047: palavras codificadas de no máximo 75 caracteres, sem partir
// caracteres multibyte ao meio, dobradas com CRLF + espaço.
export function encodeHeader(value) {
  const raw = String(value ?? '').replace(/[\r\n]+/g, ' ');
  if (isAscii(raw) && raw.length <= 70) return raw;
  const words = [];
  let chunk = '';
  for (const ch of raw) {
    if (encoder.encode(chunk + ch).length > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${base64Utf8(w)}?=`).join('\r\n ');
}

function wrap76(value) { return String(value).match(/.{1,76}/g)?.join('\r\n') || ''; }

export function rfc5322Date(date = new Date()) {
  const d = new Date(date);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

export function buildMime({ from, to, subject, body, date = new Date(), messageId = '' }) {
  const id = messageId || `<${Date.now()}.${Math.random().toString(36).slice(2, 10)}@${HELO_NAME}>`;
  return [
    `From: ${encodeHeader(FROM_NAME)} <${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${rfc5322Date(date)}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(base64Utf8(String(body ?? '').replace(/\r?\n/g, '\r\n'))),
  ].join('\r\n');
}

function dotStuff(raw) { return raw.split('\r\n').map((line) => (line.startsWith('.') ? `.${line}` : line)).join('\r\n'); }

// ------------------------------------------------------------------ SMTP
class SmtpError extends Error {}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new SmtpError(`${label}:timeout`)), ms); })
  ]).finally(() => clearTimeout(timer));
}

class SmtpConnection {
  constructor(socket, timeoutMs) { this.timeoutMs = timeoutMs; this.attach(socket); }
  attach(socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.buffer = '';
  }
  async upgrade() {
    this.reader.releaseLock();
    this.writer.releaseLock();
    this.attach(this.socket.startTls());
  }
  async write(data) { await this.writer.write(encoder.encode(data)); }
  async reply(stage) {
    const deadline = Date.now() + this.timeoutMs;
    const lines = [];
    for (;;) {
      let idx;
      while ((idx = this.buffer.indexOf('\r\n')) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        lines.push(line);
        const m = /^(\d{3})(.?)/.exec(line);
        if (m && m[2] !== '-') return { code: Number(m[1]), lines };
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new SmtpError(`${stage}:timeout`);
      const chunk = await withTimeout(this.reader.read(), left, stage);
      if (chunk.done) throw new SmtpError(`${stage}:conexao_encerrada`);
      this.buffer += decoder.decode(chunk.value, { stream: true });
    }
  }
  async command(line, expected, stage) {
    if (line != null) await this.write(`${line}\r\n`);
    const r = await this.reply(stage);
    if (!expected.includes(r.code)) {
      const last = String(r.lines[r.lines.length - 1] || '').slice(0, 160);
      throw new SmtpError(`${stage}:${last}`);
    }
    return r;
  }
  async close() {
    try { this.reader.releaseLock(); } catch (_) {}
    try { this.writer.releaseLock(); } catch (_) {}
    try { await this.socket.close(); } catch (_) {}
  }
}

async function resolveConnect(deps) {
  if (typeof deps?.connect === 'function') return deps.connect;
  const mod = await import('cloudflare:sockets');
  return mod.connect;
}

// Executa a sessão. Com `probeOnly`, para depois do login: valida host,
// TLS e credenciais sem enviar mensagem nenhuma.
export async function smtpDeliver(cfg, envelope, deps = {}) {
  const connect = await resolveConnect(deps);
  const timeoutMs = Number(deps.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const implicitTls = cfg.port === 465;
  const socket = connect({ hostname: cfg.host, port: cfg.port }, { secureTransport: implicitTls ? 'on' : 'starttls', allowHalfOpen: false });
  const c = new SmtpConnection(socket, timeoutMs);
  try {
    await c.command(null, [220], 'greeting');
    let ehlo = await c.command(`EHLO ${HELO_NAME}`, [250], 'ehlo');
    if (!implicitTls) {
      await c.command('STARTTLS', [220], 'starttls');
      await c.upgrade();
      ehlo = await c.command(`EHLO ${HELO_NAME}`, [250], 'ehlo_tls');
    }
    const auth = ehlo.lines.find((l) => /^250[ -]AUTH\b/i.test(l)) || '';
    if (/\bLOGIN\b/i.test(auth) && !/\bPLAIN\b/i.test(auth)) {
      await c.command('AUTH LOGIN', [334], 'auth');
      await c.command(base64Utf8(cfg.user), [334], 'auth_user');
      await c.command(base64Utf8(cfg.pass), [235], 'auth_pass');
    } else {
      await c.command(`AUTH PLAIN ${base64Utf8(`\u0000${cfg.user}\u0000${cfg.pass}`)}`, [235], 'auth');
    }
    if (!envelope) {
      await c.command('QUIT', [221], 'quit').catch(() => {});
      return 'probe_ok';
    }
    await c.command(`MAIL FROM:<${cfg.user}>`, [250], 'mail_from');
    await c.command(`RCPT TO:<${envelope.to}>`, [250, 251], 'rcpt_to');
    await c.command('DATA', [354], 'data');
    await c.write(`${dotStuff(envelope.raw)}\r\n.\r\n`);
    await c.command(null, [250], 'data_end');
    await c.command('QUIT', [221], 'quit').catch(() => {});
    return 'sent';
  } finally {
    await c.close();
  }
}

// ------------------------------------------------------------------ API
// Retorna 'sent', 'not_configured', 'smtp_error:<etapa>:<resposta>',
// 'http_<status>' ou 'error:<mensagem>'. Nunca lança exceção e nunca inclui
// a senha na mensagem de erro.
export async function sendMail(env, message, deps = {}) {
  const cfg = mailConfig(env);
  const subject = text(message?.subject);
  const body = String(message?.body ?? '');
  const errors = [];

  // 1) Cloudflare Email Service — transporte nativo, sem socket SMTP.
  if (cfg.cloudflareReady) {
    try {
      await env.EMAIL.send({
        to: cfg.to,
        from: { email: cfg.from, name: FROM_NAME },
        subject,
        text: body,
      });
      return 'sent';
    } catch (error) {
      const code = text(error?.code || 'error');
      const msg = text(error?.message || error).slice(0, 140);
      errors.push(`cloudflare_email:${code}:${msg}`);
    }
  }

  // 2) Fallback SMTP — mantém a contingência existente (Zoho).
  if (cfg.smtpReady) {
    try {
      const raw = buildMime({ from: cfg.smtp.user, to: cfg.to, subject, body });
      const status = await smtpDeliver(cfg.smtp, { to: cfg.to, raw }, deps);
      if (status === 'sent') return 'sent';
      errors.push(`smtp:${text(status)}`);
    } catch (error) {
      errors.push(`smtp:${text(error?.message || error).replaceAll(cfg.smtp.pass, '***').slice(0, 180)}`);
    }
  }

  // 3) Último fallback: Resend via HTTPS, quando configurado.
  if (cfg.resendReady) {
    try {
      const fetchImpl = deps.fetch || globalThis.fetch;
      const from = text(env.EMAIL_REMETENTE_RESEND || env.EMAIL_REMETENTE || `${FROM_NAME} <onboarding@resend.dev>`);
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${text(env.RESEND_API_KEY)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [cfg.to], subject, text: body })
      });
      if (response.ok) return 'sent';
      errors.push(`resend:http_${response.status}`);
    } catch (error) {
      errors.push(`resend:${text(error?.message || error).slice(0, 120)}`);
    }
  }

  if (!cfg.configured) return 'not_configured';
  return `mail_error:${errors.join('|').slice(0, 420) || 'sem_transporte_disponivel'}`;
}

// Probe sem envio: o binding nativo é considerado pronto quando está presente.
// SMTP só é testado ativamente quando ele é o transporte primário.
export async function probeMail(env, deps = {}) {
  const cfg = mailConfig(env);
  if (cfg.cloudflareReady) {
    return { transport: 'cloudflare-email', ok: true, status: 'binding_ready', fallbacks: cfg.fallbacks };
  }
  if (cfg.transport !== 'smtp') {
    return { transport: cfg.transport, ok: cfg.transport === 'resend', status: cfg.transport === 'resend' ? 'resend_ready' : 'not_configured', fallbacks: cfg.fallbacks };
  }
  try {
    const status = await smtpDeliver(cfg.smtp, null, deps);
    return { transport: 'smtp', ok: status === 'probe_ok', status, fallbacks: cfg.fallbacks };
  } catch (error) {
    return { transport: 'smtp', ok: false, status: `smtp_error:${text(error?.message || error).replaceAll(cfg.smtp.pass, '***').slice(0, 200)}`, fallbacks: cfg.fallbacks };
  }
}
