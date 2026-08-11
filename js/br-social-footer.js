(function (window, document) {
  "use strict";

  var STYLE_ID = "fdg-social-footer-css";
  var BLOCK_CLASS = "fdg-social-footer";
  var STYLE_URL = "/css/br-social-footer.css?v=20260811-social-v1";

  var NETWORKS = [
    {
      id: "instagram",
      label: "Instagram",
      title: "Fórmula do Gol no Instagram — @siteformuladogol",
      href: "https://www.instagram.com/siteformuladogol",
      icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.4" cy="6.7" r="1.2" fill="currentColor"/></svg>'
    },
    {
      id: "x",
      label: "X",
      title: "Fórmula do Gol no X — @siteformulagol",
      href: "https://x.com/siteformulagol",
      icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5 18.8 19.5M18.5 4.5 5.3 19.5" fill="none" stroke="currentColor" stroke-width="2.15" stroke-linecap="round"/></svg>'
    },
    {
      id: "youtube",
      label: "YouTube",
      title: "Fórmula do Gol no YouTube",
      href: "https://www.youtube.com/channel/UC4Yo6Wm1B-mt6gDpkTguEkQ",
      icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="5.5" width="19" height="13" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="m10 9 5 3-5 3z" fill="currentColor"/></svg>'
    },
    {
      id: "facebook",
      label: "Facebook",
      title: "Fórmula do Gol no Facebook",
      href: "https://www.facebook.com/profile.php?id=61593205074956",
      icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.2 21v-8h2.8l.5-3h-3.3V8.1c0-.9.3-1.6 1.7-1.6H18V3.8c-.7-.1-1.6-.2-2.6-.2-2.6 0-4.4 1.6-4.4 4.5V10H8v3h3v8z" fill="currentColor"/></svg>'
    }
  ];

  function shouldSkip() {
    var path = String(window.location && window.location.pathname || "").toLowerCase();
    return /\/copa2026\/admin(?:\.html)?\/?$/.test(path);
  }

  function ensureStylesheet() {
    if (document.getElementById(STYLE_ID)) return;
    var existing = document.querySelector('link[href*="br-social-footer.css"]');
    if (existing) {
      if (!existing.id) existing.id = STYLE_ID;
      return;
    }
    var link = document.createElement("link");
    link.id = STYLE_ID;
    link.rel = "stylesheet";
    link.href = STYLE_URL;
    document.head.appendChild(link);
  }

  function buildLink(item) {
    var a = document.createElement("a");
    a.className = "fdg-social-link fdg-social-link--" + item.id;
    a.href = item.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = item.title;
    a.setAttribute("aria-label", item.title + " (abre em nova aba)");

    var icon = document.createElement("span");
    icon.className = "fdg-social-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = item.icon;

    var label = document.createElement("span");
    label.className = "fdg-social-label";
    label.textContent = item.label;

    a.appendChild(icon);
    a.appendChild(label);
    return a;
  }

  function buildBlock() {
    var section = document.createElement("section");
    section.className = BLOCK_CLASS;
    section.setAttribute("aria-label", "Redes sociais oficiais do Fórmula do Gol");

    var title = document.createElement("div");
    title.className = "fdg-social-title";
    title.textContent = "Siga a Fórmula do Gol";

    var nav = document.createElement("nav");
    nav.className = "fdg-social-nav";
    nav.setAttribute("aria-label", "Redes sociais");

    NETWORKS.forEach(function (item) { nav.appendChild(buildLink(item)); });
    section.appendChild(title);
    section.appendChild(nav);
    return section;
  }

  function findFooter() {
    return document.querySelector("footer.site-footer, footer.copa-footer, footer.footer");
  }

  function mount() {
    if (shouldSkip() || document.querySelector("." + BLOCK_CLASS)) return;
    var footer = findFooter();
    if (!footer) return;
    ensureStylesheet();

    var block = buildBlock();
    var reference = footer.querySelector(".br-footer-copy, .rs-legal, .rodape-disclaimer-global");
    if (reference) footer.insertBefore(block, reference);
    else footer.insertBefore(block, footer.firstChild);
  }

  window.FDG_SOCIAL_FOOTER = {
    mount: mount,
    networks: NETWORKS.map(function (item) { return { id: item.id, label: item.label, href: item.href }; })
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})(window, document);
