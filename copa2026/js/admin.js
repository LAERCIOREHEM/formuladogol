/* =========================================================================
   admin.js — Área do organizador do Bolão Copa 2026
   MVP local: a lista de participantes fica em localStorage ('copa2026_roster').
   Em produção, os pontos [SUPABASE] indicam onde trocar pelo banco (PIN com hash).
   ========================================================================= */
(function () {
  "use strict";

  const KEY = "copa2026_roster";
  const $ = s => document.querySelector(s);

  function getRoster() { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { return []; } }
  function setRoster(r) { localStorage.setItem(KEY, JSON.stringify(r)); }

  // PIN de 6 dígitos, único na lista
  function novoPin(usados) {
    let p; do { p = String(Math.floor(100000 + Math.random() * 900000)); } while (usados.has(p));
    usados.add(p); return p;
  }

  // quem já enviou palpite (lê as chaves dos usuários no localStorage)
  function jaEnviou(nome) {
    const raw = localStorage.getItem("copa2026_user_" + nome.trim().toLowerCase());
    if (!raw) return false;
    try { return !!JSON.parse(raw).palpite; } catch (e) { return false; }
  }

  function gerar() {
    const nomes = $("#nomes").value.split("\n").map(s => s.trim()).filter(Boolean);
    if (!nomes.length) { alerta("Digite ao menos um nome (um por linha)."); return; }
    const atual = getRoster();
    const porNome = {}; atual.forEach(r => porNome[r.nome.toLowerCase()] = r);
    const usados = new Set(atual.map(r => r.pin));
    const final = [];
    nomes.forEach(n => {
      const existente = porNome[n.toLowerCase()];
      // mantém o PIN de quem já existia; gera só para os novos
      if (existente) final.push(existente);
      else final.push({ nome: n, pin: novoPin(usados) });
    });
    // [SUPABASE] em produção: gravar nome + crypt(pin) na tabela 'participantes'.
    setRoster(final);
    render();
    alerta(final.length + " participante(s) na lista. PINs prontos para enviar.", true);
  }

  function resetPin(nome) {
    const r = getRoster(); const usados = new Set(r.map(x => x.pin));
    const item = r.find(x => x.nome === nome); if (!item) return;
    usados.delete(item.pin); item.pin = novoPin(usados);
    setRoster(r); render();
  }

  function remover(nome) {
    if (!confirm("Remover " + nome + " da lista?")) return;
    setRoster(getRoster().filter(x => x.nome !== nome)); render();
  }

  function linkBase() { return location.href.replace(/admin\.html.*$/, "index.html"); }

  function textoWhatsApp(item) {
    return "🏆 *Bolão Copa 2026*\n\n" +
      "Oi, " + item.nome + "! Seus dados de acesso:\n" +
      "*PIN:* " + item.pin + "\n\n" +
      "Acesse: " + linkBase() + "\n" +
      "É só entrar com seu nome e esse PIN. Você pode trocar o PIN depois, se quiser.\n" +
      "Trava dos palpites: 10/06 às 23h59.";
  }

  function copiar(txt, btn) {
    navigator.clipboard.writeText(txt).then(() => {
      const antigo = btn.textContent; btn.textContent = "Copiado ✓";
      setTimeout(() => btn.textContent = antigo, 1400);
    }).catch(() => alerta("Não consegui copiar. Selecione o texto manualmente."));
  }

  function copiarTudo() {
    const r = getRoster();
    if (!r.length) return;
    const txt = r.map(i => i.nome + ": PIN " + i.pin).join("\n");
    copiar("Bolão Copa 2026 — acessos\n" + txt, $("#btn-copiar-tudo"));
  }

  function alerta(msg, ok) {
    const e = $("#msg"); e.textContent = msg;
    e.className = "msg " + (ok ? "ok" : "erro"); e.classList.remove("oculto");
  }

  function render() {
    const r = getRoster();
    $("#contador").textContent = r.length ? r.length + " participante(s)" : "Nenhum participante ainda";
    $("#btn-copiar-tudo").style.display = r.length ? "inline-block" : "none";
    const tb = $("#lista"); tb.innerHTML = "";
    r.forEach(item => {
      const enviou = jaEnviou(item.nome);
      const tr = document.createElement("tr");
      tr.innerHTML =
        '<td>' + item.nome + '</td>' +
        '<td class="pin">' + item.pin + '</td>' +
        '<td>' + (enviou ? '<span class="tag ok">enviou ✓</span>' : '<span class="tag">aguardando</span>') + '</td>' +
        '<td class="acoes-td"></td>';
      const td = tr.querySelector(".acoes-td");
      const bW = botao("WhatsApp", () => copiar(textoWhatsApp(item), bW));
      const bR = botao("Resetar PIN", () => resetPin(item.nome), "sec");
      const bX = botao("Remover", () => remover(item.nome), "del");
      td.append(bW, bR, bX);
      tb.appendChild(tr);
    });
  }

  function botao(txt, fn, tipo) {
    const b = document.createElement("button");
    b.textContent = txt; b.className = "mini " + (tipo || ""); b.onclick = fn; return b;
  }

  function limparTudo() {
    if (!confirm("Apagar TODA a lista de participantes? (não dá para desfazer)")) return;
    localStorage.removeItem(KEY); render(); alerta("Lista apagada.", true);
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("#btn-gerar").onclick = gerar;
    $("#btn-copiar-tudo").onclick = copiarTudo;
    $("#btn-limpar").onclick = limparTudo;
    render();
  });
})();
