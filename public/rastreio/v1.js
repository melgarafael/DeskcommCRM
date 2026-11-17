/** Rastreio de origem — captura de origem para links de WhatsApp. Sem dependências ou credenciais. */
(function () {
  "use strict";
  var script = document.currentScript;
  if (!script) return;
  var org = script.getAttribute("data-org") || "";
  var linkId = script.getAttribute("data-link-id") || "";
  if (linkId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(linkId))
    return;
  if (!linkId && !/^[a-zA-Z0-9_-]{1,100}$/.test(org)) return;
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
  var namedPhone = phone(script.getAttribute("data-whatsapp"));
  if (linkId ? !namedPhone : !google && !meta) return;
  var key = "rastreio:v1:" + base.origin + ":" + (linkId || org);
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
  // Parâmetros próprios de IDs: UTMs numéricas não são promovidas a IDs.
  // O servidor normaliza estes aliases para google_*_id ao guardar o recibo.
  var googleIds = [
    "google_campaign_id", "campaignid", "campaign_id",
    "google_adgroup_id", "adgroupid", "adgroup_id",
    "google_ad_id", "creative", "ad_id",
    "google_customer_id", "customerid", "customer_id",
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
      var googleOrigin = Boolean(out.gclid || out.gbraid || out.wbraid);
      if (
        typeof value !== "string" || !value.trim() || /[{}<>]/.test(value)
      ) return;
      if (googleOrigin && (
        value.trim().length > 200 || /[\u0000-\u001f\u007f]/.test(value) ||
        /(?:[a-z][a-z0-9+.-]*:\/\/|https?:|javascript:|data:|file:|mailto:|tel:|about:|www\.)/i.test(value)
      )) return;
      out[name] = value.trim().slice(0, 200);
    });
    googleIds.forEach(function (name) {
      if (!out.gclid && !out.gbraid && !out.wbraid) return;
      var value = input[name];
      if (typeof value !== "string") return;
      var customer = /customer/.test(name);
      var valid = customer
        ? /^(?:[0-9]{10}|[0-9]{3}-[0-9]{3}-[0-9]{4})$/.test(value.trim())
        : /^[0-9]{1,30}$/.test(value.trim());
      if (valid) out[name] = customer ? value.trim().replace(/-/g, "") : value.trim();
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
    var target = linkId ? namedPhone : isGoogle ? google : meta;
    if (!target || (!linkId && !Object.keys(origin).length)) return null;
    var url = new URL(
      linkId
        ? "/api/v1/rastreio/" + linkId
        : "/api/v1/anuncios/" + (isGoogle ? "google" : "meta") + "/" + encodeURIComponent(org),
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
  // Verificação explícita iniciada pelo administrador. Só retorna dados públicos
  // ao próprio CRM que hospeda o script; sem HTTP do servidor para URL arbitrária.
  var probe = new URLSearchParams(location.hash.slice(1)).get("rastreio-verificar");
  if (linkId && probe && /^[a-zA-Z0-9-]{16,80}$/.test(probe) && window.opener) {
    window.opener.postMessage(
      {
        type: "rastreio:v1:instalado",
        nonce: probe,
        linkId: linkId,
        buttons: Array.from(document.querySelectorAll("a[href]")).filter(function (el) {
          return el.href.indexOf(base.origin + "/api/v1/rastreio/" + linkId) === 0;
        }).length,
      },
      base.origin,
    );
  }
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
