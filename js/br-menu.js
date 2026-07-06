
(function () {
  function centerActive(nav) {
    if (!nav) return;
    var active = nav.querySelector('.active');
    if (!active) return;
    var left = active.offsetLeft - (nav.clientWidth / 2) + (active.offsetWidth / 2);
    if (!Number.isFinite(left)) return;
    try { nav.scrollTo({ left: Math.max(0, left), behavior: 'smooth' }); }
    catch (e) { nav.scrollLeft = Math.max(0, left); }
  }

  function wireNav(nav) {
    if (!nav || nav.dataset.brMenuReady === '1') return;
    nav.dataset.brMenuReady = '1';
    setTimeout(function () { centerActive(nav); }, 80);
    setTimeout(function () { centerActive(nav); }, 450);

    nav.addEventListener('click', function (ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('a,button') : null;
      if (!el) return;
      var view = el.getAttribute('data-br-view');
      if (view) {
        try { sessionStorage.setItem('brViewInicial', view); } catch (e) {}
      }
      setTimeout(function () { centerActive(nav); }, 120);
    });

    var obs = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].attributeName === 'class') {
          setTimeout(function () { centerActive(nav); }, 30);
          break;
        }
      }
    });
    Array.prototype.forEach.call(nav.querySelectorAll('a,button'), function (item) {
      obs.observe(item, { attributes: true, attributeFilter: ['class'] });
    });
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('.nav'), wireNav);
  }

  window.BR_CENTER_ACTIVE_NAV = function () {
    Array.prototype.forEach.call(document.querySelectorAll('.nav'), centerActive);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
