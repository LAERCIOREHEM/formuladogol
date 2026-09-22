import assert from 'node:assert/strict';
import { sendMail, probeMail, mailConfig, encodeHeader, buildMime, maskAddress } from '../src/mailer.js';

// Servidor SMTP simulado em memória: responde como Zoho (SSL/465, AUTH PLAIN LOGIN).
function fakeSmtp({ password = 'segredo', authCaps = 'PLAIN LOGIN' } = {}) {
  const enc = new TextEncoder(); const dec = new TextDecoder();
  const log = { commands: [], data: '' };
  let push; let inData = false; let pending = '';
  const readable = new ReadableStream({ start(c) { push = (s) => c.enqueue(enc.encode(s)); } });
  const reply = (s) => push(`${s}\r\n`);
  const writable = new WritableStream({
    write(chunk) {
      pending += dec.decode(chunk);
      let i;
      while ((i = pending.indexOf('\r\n')) !== -1) {
        const line = pending.slice(0, i); pending = pending.slice(i + 2);
        if (inData) { if (line === '.') { inData = false; reply('250 aceito'); } else log.data += `${line}\r\n`; continue; }
        log.commands.push(line.startsWith('AUTH PLAIN ') ? 'AUTH PLAIN ***' : line);
        if (line.startsWith('EHLO')) reply(`250-smtp.zoho.com\r\n250-AUTH ${authCaps}\r\n250 SIZE 1000`);
        else if (line.startsWith('AUTH PLAIN ')) reply(atob(line.slice(11)).split('\u0000')[2] === password ? '235 ok' : '535 Authentication failed');
        else if (line.startsWith('MAIL FROM:')) reply('250 ok');
        else if (line.startsWith('RCPT TO:')) reply('250 ok');
        else if (line === 'DATA') { inData = true; reply('354 envie'); }
        else if (line === 'QUIT') reply('221 tchau');
        else reply('500 ?');
      }
    }
  });
  const connect = (addr, opts) => { log.addr = addr; log.opts = opts; setTimeout(() => reply('220 pronto'), 0); return { readable, writable, close: async () => {} }; };
  return { connect, log };
}

const env = { SMTP_HOST: 'smtp.zoho.com', SMTP_PORT: '465', SMTP_USER: 'avisos@formuladogol.com.br', SMTP_PASS: 'segredo', EMAIL_DESTINO_SUGESTOES: 'dono@exemplo.com' };

const ok = fakeSmtp();
assert.equal(await sendMail(env, { subject: 'Público não localizado — Flamengo x Bragantino', body: 'Corpo com acentuação.' }, { connect: ok.connect }), 'sent');
assert.equal(ok.log.opts.secureTransport, 'on', 'porta 465 usa SSL implícito');
assert.deepEqual(ok.log.addr, { hostname: 'smtp.zoho.com', port: 465 });
assert.ok(ok.log.commands.includes('MAIL FROM:<avisos@formuladogol.com.br>'), 'remetente = SMTP_USER (exigência do Zoho)');
assert.ok(ok.log.commands.includes('RCPT TO:<dono@exemplo.com>'), 'destino = EMAIL_DESTINO_SUGESTOES');
assert.match(ok.log.data, /Content-Type: text\/plain; charset=UTF-8/);

const bad = fakeSmtp();
const status = await sendMail({ ...env, SMTP_PASS: 'outra' }, { subject: 'x', body: 'y' }, { connect: bad.connect });
assert.match(status, /^smtp_error:auth:535/);
assert.ok(!status.includes('outra'));

const probe = fakeSmtp();
const p = await probeMail(env, { connect: probe.connect });
assert.equal(p.ok, true);
assert.ok(!probe.log.commands.some((c) => c.startsWith('MAIL FROM')), 'probe não envia mensagem');

assert.equal(mailConfig({ ...env, EMAIL_DESTINO: 'outro@x.com' }).to, 'outro@x.com', 'EMAIL_DESTINO tem precedência');
assert.equal(mailConfig({ RESEND_API_KEY: 'k', EMAIL_DESTINO: 'a@b.c' }).transport, 'resend');
assert.equal(mailConfig({}).transport, 'none');
assert.equal(await sendMail({}, { subject: 'x', body: 'y' }), 'not_configured');
assert.equal(maskAddress('antonio@exemplo.com'), 'a***@exemplo.com');

const longSubject = encodeHeader('⚠️ Fórmula do Gol: público/renda não localizados — Athletico-PR x Bahia');
for (const word of longSubject.split('\r\n ')) assert.ok(word.length <= 75, 'palavra codificada ≤ 75 caracteres');
assert.equal(encodeHeader('Teste simples'), 'Teste simples');
assert.match(buildMime({ from: 'a@b.c', to: 'd@e.f', subject: 's', body: 'b', date: new Date('2026-09-21T23:10:00Z') }), /Date: Mon, 21 Sep 2026 23:10:00 \+0000/);

console.log('mailer tests: PASS');
