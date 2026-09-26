/** Rastreio de origem — captura de origem para links de WhatsApp. Sem dependências ou credenciais. */
(function () {
  "use strict";
  var script = document.currentScript;
  if (!script) return;
  var org = script.getAttribute("data-org") || "";
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(org)) return;
  var base;
  try {
    base = new URL(script.src);
    if (!/^https?:$/.test(base.protocol)) return;
  } catch {
    return;
  }
  function phone(value) {
    var digits = (value || "").replace(/\D/g, "");
    return /^[1-9][0-9]{7,14}$/.test(digits) ? digits : "";
  }
  var google = phone(script.getAttribute("data-google-whatsapp"));
  var meta = phone(script.getAttribute("data-meta-whatsapp"));
  if (!google && !meta) return;
  var key = "rastreio:v1:" + base.origin + ":" + org;
  // Uma instalação por página. Carregar o mesmo snippet duas vezes não duplica observadores.
  var installed = window.__rastreioCaptureV1 || (window.__rastreioCaptureV1 = {});
  if (installed[key]) return;
  installed[key] = true;
  var storage = script.getAttribute("data-storage") !== "none";
  var utms = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "utm_adset",
    "utm_ad",
    "utm_placement",
    "fbclid",
  ];
  function normalize(input) {
    var out = {};
    ["gclid", "gbraid", "wbraid"].forEach(function (name) {
      var value = input[name];
      if (typeof value === "string" && /^[A-Za-z0-9._~-]{1,512}$/.test(value.trim()))
        out[name] = value.trim();
    });
    utms.forEach(function (name) {
      var value = input[name];
      if (typeof value === "string" && value.trim() && !/[{}<>]/.test(value))
        out[name] = value.trim().slice(0, 200);
    });
    return out;
  }
  var origin = {};
  if (storage) {
    try {
      origin = normalize(JSON.parse(sessionStorage.getItem(key) || "{}") || {});
    } catch {
      /* Storage bloqueado: a página atual continua funcionando. */
    }
  }
  var lastUrl = "";
  function refresh() {
    if (lastUrl === location.href) return;
    lastUrl = location.href;
    var params = new URL(location.href).searchParams;
    var incoming = normalize(Object.fromEntries(params.entries()));
    // Nova origem substitui a anterior; nunca mistura o clique de uma campanha com outra.
    if (
      ["gclid", "gbraid", "wbraid"].concat(utms).some(function (name) {
        return params.has(name);
      })
    ) {
      origin = incoming;
      if (storage) {
        try {
          sessionStorage.setItem(key, JSON.stringify(origin));
        } catch {
          /* Melhor esforço. */
        }
      }
    }
  }
  refresh();
  function destination() {
    var isGoogle = Boolean(origin.gclid || origin.gbraid || origin.wbraid);
    var target = isGoogle ? google : meta;
    if (!target || !Object.keys(origin).length) return null;
    var url = new URL(
      "/api/v1/anuncios/" + (isGoogle ? "google" : "meta") + "/" + encodeURIComponent(org),
      base.origin,
    );
    Object.keys(origin).forEach(function (name) {
      url.searchParams.set(name, origin[name]);
    });
    return { phone: target, url: url.href };
  }
  var links = new WeakMap();
  function decorate(link) {
    if (!link || link.tagName !== "A") return;
    var previous = links.get(link);
    var href = link.getAttribute("href");
    var original = previous && href === previous.rewritten ? previous.original : href;
    if (!original) return;
    var target = destination();
    var url;
    try {
      url = new URL(original, location.href);
    } catch {
      return;
    }
    var number = "";
    if (
      /^https?:$/.test(url.protocol) &&
      url.hostname === "wa.me" &&
      /^\/[+0-9]+\/?$/.test(url.pathname)
    )
      number = phone(url.pathname);
    else if (
      /^https?:$/.test(url.protocol) &&
      /^(api|web)\.whatsapp\.com$/.test(url.hostname) &&
      /^\/send\/?$/.test(url.pathname)
    )
      number = phone(url.searchParams.get("phone"));
    else if (url.protocol === "whatsapp:" && url.hostname === "send")
      number = phone(url.searchParams.get("phone"));
    var rewritten =
      !link.hasAttribute("data-rastreio-ignorar") && target && number === target.phone
        ? target.url
        : original;
    links.set(link, { original: original, rewritten: rewritten });
    if (href !== rewritten) link.setAttribute("href", rewritten);
  }
  function scan(root) {
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    decorate(root);
    root.querySelectorAll("a[href]").forEach(decorate);
  }
  function update() {
    refresh();
    scan(document);
  }
  update();
  new MutationObserver(function (records) {
    refresh();
    records.forEach(function (record) {
      if (record.type === "attributes") decorate(record.target);
      else record.addedNodes.forEach(scan);
    });
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href", "data-rastreio-ignorar"],
  });
  // Executa antes da navegação normal; não cancela cliques nem handlers do site.
  ["click", "auxclick", "pointerdown", "contextmenu"].forEach(function (name) {
    document.addEventListener(
      name,
      function (event) {
        refresh();
        var el = event.target;
        if (el && el.closest) decorate(el.closest("a[href]"));
      },
      true,
    );
  });
  window.addEventListener("popstate", update);
  window.addEventListener("hashchange", update);
})();
