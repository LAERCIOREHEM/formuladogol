// Envio de e-mail do Worker.
//
// Transporte principal: SMTP direto (SSL na 465, ou STARTTLS nas demais portas)
// pela API de sockets TCP da Cloudflare, reaproveitando os mesmos secrets que já
// entregam os avisos de sugestão pelo GitHub (Zoho): SMTP_HOST, SMTP_PORT,
// SMTP_USER, SMTP_PASS. Destino: EMAIL_DESTINO ou EMAIL_DESTINO_SUGESTOES.
// Transporte alternativo: Resend, só se RESEND_API_KEY existir.
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
  const port = Number(text(env.SMTP_PORT) || 465) || 465;
  const smtp = { host: text(env.SMTP_HOST), port, user: text(env.SMTP_USER), pass: text(env.SMTP_PASS) };
  const smtpReady = Boolean(smtp.host && smtp.user && smtp.pass && to);
  const resendReady = Boolean(text(env.RESEND_API_KEY) && to);
  return { to, smtp, transport: smtpReady ? 'smtp' : (resendReady ? 'resend' : 'none'), configured: smtpReady || resendReady };
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
  if (cfg.transport === 'smtp') {
    try {
      const raw = buildMime({ from: cfg.smtp.user, to: cfg.to, subject, body });
      return await smtpDeliver(cfg.smtp, { to: cfg.to, raw }, deps);
    } catch (error) {
      return `smtp_error:${text(error?.message || error).replaceAll(cfg.smtp.pass, '***').slice(0, 200)}`;
    }
  }
  if (cfg.transport === 'resend') {
    try {
      const fetchImpl = deps.fetch || globalThis.fetch;
      const from = text(env.EMAIL_REMETENTE || `${FROM_NAME} <onboarding@resend.dev>`);
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${text(env.RESEND_API_KEY)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [cfg.to], subject, text: body })
      });
      return response.ok ? 'sent' : `http_${response.status}`;
    } catch (error) {
      return `error:${text(error?.message || error).slice(0, 120)}`;
    }
  }
  return 'not_configured';
}

// Valida transporte e credenciais sem enviar e-mail.
export async function probeMail(env, deps = {}) {
  const cfg = mailConfig(env);
  if (cfg.transport !== 'smtp') return { transport: cfg.transport, ok: cfg.transport === 'resend', status: cfg.transport === 'resend' ? 'resend_nao_testado' : 'not_configured' };
  try {
    const status = await smtpDeliver(cfg.smtp, null, deps);
    return { transport: 'smtp', ok: status === 'probe_ok', status };
  } catch (error) {
    return { transport: 'smtp', ok: false, status: `smtp_error:${text(error?.message || error).replaceAll(cfg.smtp.pass, '***').slice(0, 200)}` };
  }
}
