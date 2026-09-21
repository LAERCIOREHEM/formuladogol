import assert from 'node:assert/strict';
import { buildFeedbackEmail, escapeHtml, feedbackNotifierConfigured } from '../src/feedback-notifier.js';

assert.equal(feedbackNotifierConfigured({}), false);
assert.equal(feedbackNotifierConfigured({ SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'k', RESEND_API_KEY: 'r' }), true);
assert.equal(escapeHtml('<b>&"\''), '&lt;b&gt;&amp;&quot;&#39;');
const mail = buildFeedbackEmail({
  id: 7, criado_em: '2026-09-21T12:00:00Z', tipo: 'sugestao', mensagem: '<script>alert(1)</script>',
  assinatura: 'Teste', pagina: '/agenda', visitante_id: 'abc', user_agent: 'UA',
});
assert.match(mail.subject, /Fórmula do Gol/);
assert.ok(!mail.html.includes('<script>alert(1)</script>'));
assert.ok(mail.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
assert.match(mail.plain, /<script>alert\(1\)<\/script>/);
console.log('feedback notifier: PASS');
