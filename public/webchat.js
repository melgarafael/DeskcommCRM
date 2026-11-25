/*
 * Bolha do chat no site (spec 36, F2).
 *
 * O operador cola uma linha no site do cliente:
 *   <script src="https://<crm>/webchat.js?k=wck_..." async></script>
 * O script cria uma bolha no canto da tela e um iframe com a janela do chat
 * (`/chat/<chave>`, ver lib/channels/webchat/janela-html.ts). A origem do CRM sai do
 * próprio `src` do script, nunca de parâmetro. Não grava nada no site: sem cookie, sem
 * localStorage, sem requisição de rede, sem <style> global. Sem avaliação de texto como código
 * e sem HTML montado por string.
 *
 * Escrito em JavaScript simples, sem módulo e sem build, porque é servido como arquivo
 * estático de public/ (como public/notify-sw.js e public/rastreio/v1.js).
 */
(function () {
  "use strict";

  var CHAVE = /^wck_[A-Za-z0-9_-]{1,64}$/;
  var NOMES_UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
  var LIMITE_DO_VALOR = 200;
  var LIMITE_DO_BADGE = 99;
  var LARGURA_TELA_CHEIA = 480;

  /** Origem (esquema + host + porta) do src do script. Só https, ou http em loopback. */
  function origemDoScript(src) {
    try {
      var url = new URL(src);
      var loopback = url.hostname === "localhost";
      if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return url.origin;
    } catch (erro) {
      // src que não é URL: não há origem
    }
    return null;
  }

  /** Chave do `?k=`, se bater o formato `wck_...`. Senão, null. */
  function chaveDoScript(src) {
    try {
      var chave = new URL(src).searchParams.get("k");
      return chave !== null && CHAVE.test(chave) ? chave : null;
    } catch (erro) {
      return null;
    }
  }

  /** Formato do `?f=`, se bater na lista fixa. Senão, null. */
  function formatoDoScript(src) {
    try {
      var f = new URL(src).searchParams.get("f");
      return f !== null && ["bolha", "painel", "embutido", "pagina"].indexOf(f) !== -1 ? f : null;
    } catch (erro) {
      return null;
    }
  }

  /** Função pura: devolve { autoAbrirSegundos, som } quando o dado é um `ajustes` válido. */
  function ajustesDaMensagem(dado) {
    if (!dado || typeof dado !== "object") return null;
    if (dado.tipo !== "ajustes") return null;
    var segundos = dado.autoAbrirSegundos;
    var som = dado.som;
    if (typeof segundos !== "number" || segundos % 1 !== 0 || segundos < 0 || segundos > 120) return null;
    if (typeof som !== "boolean") return null;
    return { autoAbrirSegundos: segundos, som: som };
  }

  /** Posição do `?p=`, se bater na lista fixa. Senão, null. */
  function posicaoDoScript(src) {
    try {
      var p = new URL(src).searchParams.get("p");
      return p !== null && ["direita", "esquerda"].indexOf(p) !== -1 ? p : null;
    } catch (erro) {
      return null;
    }
  }

  /**
   * Referrer reduzido a origem + caminho: sem query e sem fragmento, cortado em 200 caracteres.
   * Não é URL http(s) válida: string vazia.
   */
  function referrerLimpo(ref) {
    if (typeof ref !== "string" || ref === "") return "";
    try {
      var url = new URL(ref);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      return (url.origin + url.pathname).slice(0, LIMITE_DO_VALOR);
    } catch (erro) {
      return "";
    }
  }

  /**
   * O que vai ao iframe: `href` sem fragmento e sem parâmetro que não seja utm_*,
   * `referrer` reduzido a origem + caminho e os `utm_*` (aparados e cortados em 200 caracteres).
   * Token, e-mail e demais parâmetros do site não saem daqui.
   */
  function montarContexto(loc, doc) {
    var url = new URL(loc.href);
    var utm = {};
    NOMES_UTM.forEach(function (nome) {
      if (!url.searchParams.has(nome)) return;
      var valor = (url.searchParams.get(nome) || "").trim().slice(0, LIMITE_DO_VALOR);
      if (valor) utm[nome] = valor;
    });

    // Origem + caminho, sem userinfo (user:pass@) e sem fragmento; na query, só os utm_*.
    var base = url.protocol + "//" + url.host + url.pathname;
    var manter = new URLSearchParams();
    NOMES_UTM.forEach(function (nome) {
      if (Object.prototype.hasOwnProperty.call(utm, nome)) manter.set(nome, utm[nome]);
    });
    var consulta = manter.toString();

    return {
      href: consulta ? base + "?" + consulta : base,
      referrer: referrerLimpo(doc ? doc.referrer : ""),
      utm: utm,
    };
  }

  /** Só aceita a mensagem que vem da origem do CRM E da janela do iframe desta bolha. */
  function aceitarMensagem(evento, origemDoCrm, iframe) {
    if (!evento || !iframe || !origemDoCrm || origemDoCrm === "null") return false;
    if (evento.origin !== origemDoCrm) return false;
    if (!iframe.contentWindow) return false;
    return evento.source === iframe.contentWindow;
  }

  function estilo(elemento, regras) {
    Object.keys(regras).forEach(function (nome) {
      elemento.style[nome] = regras[nome];
    });
  }

  /** `src` do script que está rodando: o `currentScript`, ou o último `<script>` com `/webchat.js`. */
  function srcDoProprioScript() {
    if (document.currentScript && document.currentScript.src) return document.currentScript.src;
    var scripts = document.querySelectorAll("script[src]");
    var achado = null;
    for (var i = 0; i < scripts.length; i++) {
      if (/\/webchat\.js(\?|$)/.test(scripts[i].src)) achado = scripts[i].src;
    }
    return achado;
  }

  /** Seletor do elemento alvo do formato `embutido`, lido de `data-webchat-alvo` no próprio script. */
  function alvoDoScript(src) {
    try {
      var scripts = document.querySelectorAll("script[src]");
      for (var i = 0; i < scripts.length; i++) {
        if (/\/webchat\.js(\?|$)/.test(scripts[i].src)) {
          var alvo = scripts[i].getAttribute("data-webchat-alvo");
          if (typeof alvo === "string" && alvo !== "") return alvo;
        }
      }
    } catch (erro) {
      // ignora
    }
    return null;
  }

  function montar() {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    if (window.__webchatMontado) return;
    // Script no <head> sem defer: o corpo ainda não existe. Espera o DOM ficar pronto.
    if (!document.body && document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", montar, { once: true });
      return;
    }

    var src = srcDoProprioScript();
    if (!src) return;
    var origem = origemDoScript(src);
    var chave = chaveDoScript(src);
    var formato = formatoDoScript(src);
    var posicao = posicaoDoScript(src);
    var alvo = alvoDoScript(src);
    if (!origem || !chave) return;

    window.__webchatMontado = true;

    var aberto = false;
    var naoLidas = 0;
    var ajustesAgendado = false; // auto-abrir agendado no máximo uma vez
    var visitanteMexeu = false; // o visitante abriu ou fechou a bolha manualmente
    var visitanteInteragiu = false; // o visitante interagiu com a página (pointerdown/keydown)
    var contextoDoBip = null; // um AudioContext só por janela: o navegador limita quantos podem existir
    var somAtual = false; // valor de `som` do último `ajustes` válido

    // Iframe: a janela do chat. Começa escondido e só ganha tamanho ao abrir.
    var iframe = document.createElement("iframe");
    iframe.title = "Chat de atendimento";
    iframe.setAttribute("src", origem + "/chat/" + chave);
    iframe.setAttribute("allow", "");
    iframe.setAttribute("loading", "lazy");
    iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    iframe.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox",
    );
    estilo(iframe, {
      position: "fixed",
      border: "0",
      borderRadius: "12px",
      boxShadow: "0 12px 40px rgba(0, 0, 0, 0.25)",
      background: "#ffffff",
      zIndex: "2147483001",
      display: "none",
    });

    // Bolha: o botão fixo no canto. Mantém o contorno de foco do navegador.
    var bolha = document.createElement("button");
    bolha.type = "button";
    bolha.setAttribute("aria-label", "Abrir chat");
    bolha.setAttribute("aria-expanded", "false");
    bolha.textContent = "Chat";
    estilo(bolha, {
      position: "fixed",
      [posicao === "esquerda" ? "left" : "right"]: "20px",
      bottom: "20px",
      zIndex: "2147483000",
      height: "48px",
      padding: "0 18px",
      border: "0",
      borderRadius: "24px",
      background: "#1f2937",
      color: "#ffffff",
      font: "600 14px system-ui, -apple-system, Segoe UI, sans-serif",
      cursor: "pointer",
      boxShadow: "0 6px 20px rgba(0, 0, 0, 0.25)",
    });
    bolha.addEventListener("focus", function () {
      bolha.style.outline = "3px solid #93c5fd";
      bolha.style.outlineOffset = "2px";
    });
    bolha.addEventListener("blur", function () {
      bolha.style.outline = "";
      bolha.style.outlineOffset = "";
    });

    // Contador de não lidas, mostrado só com a bolha fechada.
    var badge = document.createElement("span");
    badge.setAttribute("aria-hidden", "true");
    estilo(badge, {
      position: "absolute",
      top: "-6px",
      right: "-6px",
      minWidth: "20px",
      height: "20px",
      padding: "0 6px",
      borderRadius: "10px",
      background: "#dc2626",
      color: "#ffffff",
      font: "700 12px system-ui, -apple-system, Segoe UI, sans-serif",
      lineHeight: "20px",
      textAlign: "center",
      display: "none",
    });
    bolha.appendChild(badge);

    // Só o tamanho e a visibilidade do iframe mudam ao abrir e fechar.
    function aplicarTamanho() {
      // No formato embutido o iframe fica dentro do elemento alvo: nunca fixo, sem sombra.
      if (formato === "embutido") {
        estilo(iframe, {
          position: "static",
          top: "auto",
          left: "auto",
          right: "auto",
          bottom: "auto",
          width: "100%",
          height: "600px",
          maxHeight: "none",
          borderRadius: "12px",
          boxShadow: "none",
        });
        return;
      }

      var telaCheia = window.innerWidth <= LARGURA_TELA_CHEIA;
      if (formato === "painel" && aberto) {
        if (telaCheia) {
          estilo(iframe, {
            top: "0",
            left: "0",
            right: "0",
            bottom: "0",
            width: "100%",
            height: "100%",
            maxHeight: "none",
            borderRadius: "0",
          });
        } else {
          estilo(iframe, {
            top: "0",
            bottom: "0",
            height: "100vh",
            width: "380px",
            maxHeight: "none",
            borderRadius: "0",
            left: posicao === "esquerda" ? "0" : "auto",
            right: posicao === "esquerda" ? "auto" : "0",
          });
        }
      } else if (telaCheia) {
        estilo(iframe, {
          top: "0",
          left: "0",
          right: "0",
          bottom: "0",
          width: "100%",
          height: "100%",
          maxHeight: "none",
          borderRadius: "0",
        });
      } else {
        estilo(iframe, {
          top: "auto",
          left: posicao === "esquerda" ? "20px" : "auto",
          right: posicao === "esquerda" ? "auto" : "20px",
          bottom: "88px",
          width: "380px",
          height: "600px",
          maxHeight: "calc(100vh - 110px)",
          borderRadius: "12px",
        });
      }
    }

    function atualizar() {
      iframe.style.display = aberto || formato === "embutido" ? "block" : "none";
      bolha.setAttribute("aria-expanded", aberto ? "true" : "false");
      bolha.setAttribute("aria-label", aberto ? "Fechar chat" : "Abrir chat");
      badge.textContent = String(naoLidas);
      badge.style.display = !aberto && formato !== "embutido" && naoLidas > 0 ? "block" : "none";
      aplicarTamanho();
    }

    // Contexto da página: enviado ao iframe quando ele carrega e quando ele pede.
    // O destino é a origem do CRM, nunca "*".
    function enviarContexto() {
      if (!iframe.contentWindow) return;
      var contexto = montarContexto(window.location, document);
      iframe.contentWindow.postMessage(
        { tipo: "contexto", href: contexto.href, referrer: contexto.referrer, utm: contexto.utm },
        origem,
      );
    }

    // Abrir leva o foco ao iframe; fechar devolve o foco à bolha.
    function abrirOuFechar(abrir) {
      aberto = abrir;
      visitanteMexeu = true;
      if (abrir) naoLidas = 0;
      atualizar();
      if (aberto) iframe.focus();
      else bolha.focus();
    }

    bolha.addEventListener("click", function () {
      if (formato === "pagina") {
        window.open(origem + "/chat/" + chave, "_blank", "noopener,noreferrer");
        return;
      }
      abrirOuFechar(!aberto);
    });

    // Esc no documento do site fecha o painel quando ele está aberto (não no embutido, que é sempre visível).
    document.addEventListener("keydown", function (evento) {
      if (evento.key === "Escape" && aberto && formato !== "embutido") abrirOuFechar(false);
    });

    // O visitante interagiu com a página: necessário para o som tocar.
    document.addEventListener("pointerdown", function () {
      visitanteInteragiu = true;
    });
    document.addEventListener("keydown", function () {
      visitanteInteragiu = true;
    });

    iframe.addEventListener("load", enviarContexto);

    window.addEventListener("message", function (evento) {
      if (!aceitarMensagem(evento, origem, iframe)) return;
      var dado = evento.data;
      if (!dado || typeof dado !== "object") return;

      if (dado.tipo === "pronto") {
        enviarContexto();
      } else if (dado.tipo === "fechar") {
        // Em `embutido` o botão × / a mensagem `fechar` da janela é ignorada.
        if (formato === "embutido") return;
        if (aberto) abrirOuFechar(false);
      } else if (
        dado.tipo === "nao-lidas" &&
        typeof dado.n === "number" &&
        dado.n % 1 === 0 &&
        dado.n >= 0 &&
        dado.n <= LIMITE_DO_BADGE
      ) {
        naoLidas = dado.n;
        atualizar();
      } else if (dado.tipo === "ajustes") {
        var a = ajustesDaMensagem(dado);
        if (!a || ajustesAgendado) return;
        somAtual = a.som;
        ajustesAgendado = true;
        if (a.autoAbrirSegundos > 0 && (formato === "bolha" || formato === "painel")) {
          setTimeout(function () {
            if (!aberto && !visitanteMexeu) {
              aberto = true;
              naoLidas = 0;
              atualizar();
            }
          }, a.autoAbrirSegundos * 1000);
        }
      } else if (dado.tipo === "resposta") {
        var visivel = aberto || formato === "embutido";
        if (!visivel) {
          naoLidas = Math.min(naoLidas + 1, LIMITE_DO_BADGE);
          atualizar();
        }
        if (formato !== "embutido" && somAtual && visitanteInteragiu) {
          contextoDoBip = tocarBip(contextoDoBip);
        }
      }
    });

    window.addEventListener("resize", aplicarTamanho);

    // Embutido: o iframe vive dentro do elemento alvo marcado no próprio script.
    // Sem alvo achado, seletor inválido ou elemento ausente: não cria nada e não lança.
    if (formato === "embutido") {
      var elementoAlvo = null;
      try {
        elementoAlvo = document.querySelector(alvo);
      } catch (erro) {
        // seletor inválido (ex: "[", "#[", etc.): não cria nada, sem erro
        return;
      }
      if (!elementoAlvo) return;
      elementoAlvo.appendChild(iframe);
      atualizar();
      return;
    }

    var raiz = document.body || document.documentElement;
    raiz.appendChild(iframe);
    raiz.appendChild(bolha);
    atualizar();
  }

  // Toca um bip curto (~0,15 s, 880 Hz) com Web Audio, sem arquivo de áudio nem rede.
  // Reaproveita o contexto recebido e devolve o que usou: criar um por resposta esgota o limite do navegador.
  function tocarBip(existente) {
    var contexto = existente || null;
    try {
      var AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return contexto;
      if (!contexto) contexto = new AudioContext();
      if (contexto.state === "suspended" && typeof contexto.resume === "function") contexto.resume();
      var oscilador = contexto.createOscillator();
      var ganho = contexto.createGain();
      oscilador.type = "sine";
      oscilador.frequency.setValueAtTime(880, contexto.currentTime);
      oscilador.connect(ganho);
      ganho.connect(contexto.destination);
      ganho.gain.setValueAtTime(0.1, contexto.currentTime);
      oscilador.start(contexto.currentTime);
      oscilador.stop(contexto.currentTime + 0.15);
    } catch (erro) {
      // sem áudio: não faz nada e não lança
    }
    return contexto;
  }

  // Exposição para o teste (Node/Vitest). Num navegador, `module` não existe e nada muda.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      origemDoScript: origemDoScript,
      chaveDoScript: chaveDoScript,
      formatoDoScript: formatoDoScript,
      posicaoDoScript: posicaoDoScript,
      alvoDoScript: alvoDoScript,
      montarContexto: montarContexto,
      aceitarMensagem: aceitarMensagem,
      ajustesDaMensagem: ajustesDaMensagem,
    };
  }

  montar();
})();
