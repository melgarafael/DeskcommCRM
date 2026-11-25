/*
 * Janela do chat no site: o comportamento da conversa que roda DENTRO do iframe
 * `/chat/<chave>` (spec 36, F2).
 *
 * O HTML vem de lib/channels/webchat/janela-html.ts: a estrutura e a configuração em
 * `#webchat-config`. Daqui saem o que a estrutura não traz (aceite, coleta, botão de fechar,
 * linha de estado), a conversa com as rotas públicas de sessão, mensagens e eventos, e a
 * ponte com a página de fora: manda `pronto` e `fechar`, recebe `contexto`.
 *
 * JavaScript simples, sem módulo e sem build, servido como arquivo estático de public/.
 * Todo texto que vem do servidor, da configuração ou do visitante entra na tela como texto
 * puro. Os textos com acento estão escritos como escapes Unicode no código-fonte, então o
 * arquivo não depende da codificação com que o servidor o entrega.
 */
(function () {
  "use strict";

  var CHAVE = /^wck_[A-Za-z0-9_-]{1,64}$/;
  var CAMPOS = ["nome", "telefone", "email"];
  var NOMES_UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
  var LIMITE_TEXTO = 2000;
  var LIMITE_CONTEXTO = 200;
  var LIMITES_COLETA = { nome: 120, telefone: 30, email: 200 };
  var ESPERA_INICIAL_MS = 1000;
  var ESPERA_TETO_MS = 30000;
  var ESPERA_ENTRE_FLUXOS_MS = 1000;
  var ESPERA_PADRAO_MS = 60000;
  var PREFIXO_TOKEN = "webchat:";
  var ROTA_SESSAO = "/api/v1/webchat/sessao";
  var ROTA_MENSAGENS = "/api/v1/webchat/mensagens";
  var ROTA_EVENTOS = "/api/v1/webchat/eventos";
  var TELEFONE_INTERNACIONAL = /^\+[0-9]{8,15}$/;
  var SEPARADORES_DO_TELEFONE = /[\s().-]/g;
  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var POLITICA_HTTP = /^https?:\/\/\S+$/i;
  var ROTULOS = { nome: "Seu nome", telefone: "Seu telefone", email: "Seu e-mail" };
  var TIPOS = { nome: "text", telefone: "tel", email: "email" };
  var AUTOCOMPLETE = { nome: "name", telefone: "tel", email: "email" };
  var ESTADOS_DO_ATENDIMENTO = ["sem_agente", "aberto", "fechado"];
  var AVISO_SEM_AGENTE = "Recebemos sua mensagem. Nossa equipe responde por aqui.";
  var AVISO_FORA_SEM_VOLTA =
    "Estamos fora do horário de atendimento. Deixe sua mensagem que respondemos assim que voltarmos.";

  var ESTILO_VISITANTE = {
    alignSelf: "flex-end",
    maxWidth: "80%",
    background: "var(--cor)",
    color: "var(--cor-texto)",
    padding: ".5rem .7rem",
    borderRadius: "10px",
  };
  var ESTILO_ATENDENTE = {
    alignSelf: "flex-start",
    maxWidth: "80%",
    background: "#f3f4f6",
    color: "#1f2937",
    padding: ".5rem .7rem",
    borderRadius: "10px",
  };
  var ESTILO_BOTAO = {
    padding: ".55rem .9rem",
    border: "0",
    borderRadius: "8px",
    background: "var(--cor)",
    color: "var(--cor-texto)",
    font: "inherit",
    cursor: "pointer",
    alignSelf: "flex-start",
  };

  /* ---------- funções puras (testadas) ---------- */

  /** Só o que a página de fora manda, aparado e cortado em 200 caracteres por valor. */
  function normalizarContexto(dados) {
    var entrada = dados && typeof dados === "object" ? dados : {};
    var utmEntrada = entrada.utm && typeof entrada.utm === "object" ? entrada.utm : {};
    var utm = {};
    NOMES_UTM.forEach(function (nome) {
      var valor = textoCortado(utmEntrada[nome]).trim();
      if (valor) utm[nome] = valor;
    });
    return {
      href: textoCortado(entrada.href),
      referrer: textoCortado(entrada.referrer),
      utm: utm,
    };
  }

  function textoCortado(valor) {
    return typeof valor === "string" ? valor.slice(0, LIMITE_CONTEXTO) : "";
  }

  /** Só aceita a mensagem da página que embute a janela, com tipo `contexto`. */
  function aceitarMensagemDoPai(evento, pai) {
    var referencia = pai || window.parent;
    if (!evento || !referencia || evento.source !== referencia) return false;
    var dados = evento.data;
    return !!dados && typeof dados === "object" && dados.tipo === "contexto";
  }

  /**
   * Lê o `atendimento` da resposta de sessão. Fora do formato (estado desconhecido, `abre_em`
   * que não é data, `aviso` que não é texto não vazio), o campo inteiro é ignorado: nulo.
   */
  function lerAtendimento(bruto) {
    if (!bruto || typeof bruto !== "object") return null;
    if (ESTADOS_DO_ATENDIMENTO.indexOf(bruto.estado) === -1) return null;
    var abreEm = bruto.abre_em;
    if (abreEm !== null && (typeof abreEm !== "string" || isNaN(new Date(abreEm).getTime()))) {
      return null;
    }
    var aviso = bruto.aviso;
    if (aviso !== null && (typeof aviso !== "string" || aviso.trim() === "")) return null;
    return { estado: bruto.estado, abreEm: abreEm, aviso: aviso };
  }

  function doisDigitos(numero) {
    return numero < 10 ? "0" + numero : String(numero);
  }

  /** Quando o atendimento volta, no relógio do aparelho. Sem data válida, o texto sem hora. */
  function textoDaVolta(abreEm) {
    var data = abreEm ? new Date(abreEm) : null;
    if (!data || isNaN(data.getTime())) return AVISO_FORA_SEM_VOLTA;
    return (
      "Estamos fora do horário de atendimento. Voltamos às " +
      doisDigitos(data.getHours()) +
      ":" +
      doisDigitos(data.getMinutes()) +
      " de " +
      doisDigitos(data.getDate()) +
      "/" +
      doisDigitos(data.getMonth() + 1) +
      " (no horário do seu aparelho)."
    );
  }

  /**
   * Monta a mensagem do visitante. Texto vazio e texto acima do limite são recusados. Se
   * `anterior` tem o mesmo texto (reenvio da mesma mensagem), reaproveita o mensagem_id.
   */
  function montarMensagem(texto, anterior) {
    var limpo = typeof texto === "string" ? texto.trim() : "";
    if (limpo === "") return { ok: false, motivo: "vazio" };
    if (limpo.length > LIMITE_TEXTO) return { ok: false, motivo: "longo" };
    var id = anterior && anterior.id && anterior.texto === limpo ? anterior.id : gerarUuid();
    return { ok: true, id: id, texto: limpo };
  }

  function gerarUuid() {
    if (typeof crypto !== "undefined" && crypto && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = "";
    for (var i = 0; i < 16; i++) {
      hex += (bytes[i] + 0x100).toString(16).slice(1);
      if (i === 3 || i === 5 || i === 7 || i === 9) hex += "-";
    }
    return hex;
  }

  function modoDaColeta(coleta, campo) {
    var modo = coleta && coleta[campo];
    return modo === "oculto" || modo === "obrigatorio" ? modo : "opcional";
  }

  /**
   * Confere o formulário de coleta. Campo oculto não entra. Obrigatório vazio recusa.
   * Telefone só em formato internacional, depois de tirar separadores. E-mail com formato.
   * `contato` leva só o que foi preenchido, ou fica nulo.
   */
  function validarColeta(valores, coleta) {
    var erros = {};
    var contato = {};
    CAMPOS.forEach(function (campo) {
      var modo = modoDaColeta(coleta, campo);
      if (modo === "oculto") return;
      var bruto = String(valores[campo] == null ? "" : valores[campo]).trim();
      var obrigatorio = modo === "obrigatorio";
      if (campo === "telefone") {
        var limpo = bruto.replace(SEPARADORES_DO_TELEFONE, "");
        if (limpo === "") {
          if (obrigatorio) erros[campo] = "Informe seu telefone.";
        } else if (!TELEFONE_INTERNACIONAL.test(limpo)) {
          erros[campo] =
            "Use o telefone com + e o código do país, por exemplo +55 11 99999-9999.";
        } else {
          contato.telefone = limpo;
        }
      } else if (campo === "email") {
        if (bruto === "") {
          if (obrigatorio) erros[campo] = "Informe seu e-mail.";
        } else if (!EMAIL.test(bruto) || bruto.length > LIMITES_COLETA.email) {
          erros[campo] = "E-mail em formato inválido.";
        } else {
          contato.email = bruto;
        }
      } else {
        if (bruto === "") {
          if (obrigatorio) erros[campo] = "Informe seu nome.";
        } else if (bruto.length > LIMITES_COLETA.nome) {
          erros[campo] = "Nome muito longo: máximo de 120 caracteres.";
        } else {
          contato.nome = bruto;
        }
      }
    });
    return {
      ok: Object.keys(erros).length === 0,
      erros: erros,
      contato: Object.keys(contato).length > 0 ? contato : null,
    };
  }

  /**
   * Lê o corpo de um `text/event-stream`. Junta pedaços partidos, separa eventos por linha em
   * branco, entrega cada evento uma vez e ignora comentários (linhas que começam com `:`).
   * Resolve quando o fluxo acaba; rejeita se a leitura falhar.
   */
  function lerEventos(leitor, aoEvento) {
    var decodificador = new TextDecoder();
    var pendente = "";

    function despachar(bloco) {
      var nome = "message";
      var dados = [];
      var temDados = false;
      bloco.split("\n").forEach(function (linha) {
        if (linha === "" || linha.charAt(0) === ":") return;
        var dois = linha.indexOf(":");
        var campo = dois === -1 ? linha : linha.slice(0, dois);
        var valor = dois === -1 ? "" : linha.slice(dois + 1);
        if (valor.charAt(0) === " ") valor = valor.slice(1);
        if (campo === "event") nome = valor;
        else if (campo === "data") {
          dados.push(valor);
          temDados = true;
        }
      });
      if (temDados) aoEvento({ evento: nome, dados: dados.join("\n") });
    }

    function passo() {
      return leitor.read().then(function (lido) {
        if (lido.done) return undefined;
        var pedaco =
          typeof lido.value === "string"
            ? lido.value
            : decodificador.decode(lido.value, { stream: true });
        pendente = (pendente + pedaco).replace(/\r\n/g, "\n");
        var fim = pendente.indexOf("\n\n");
        while (fim !== -1) {
          var bloco = pendente.slice(0, fim);
          pendente = pendente.slice(fim + 2);
          despachar(bloco);
          fim = pendente.indexOf("\n\n");
        }
        return passo();
      });
    }

    return passo();
  }

  /* ---------- armazenamento do token (sempre dentro de try) ---------- */

  function armazenamentoDoNavegador() {
    try {
      return window.localStorage || null;
    } catch (erro) {
      return null;
    }
  }

  function lerTokenGuardado(arm, chave) {
    if (!arm) return null;
    try {
      var valor = arm.getItem(PREFIXO_TOKEN + chave);
      return typeof valor === "string" && valor !== "" ? valor : null;
    } catch (erro) {
      return null;
    }
  }

  function guardarTokenNo(arm, chave, token) {
    if (!arm) return;
    try {
      arm.setItem(PREFIXO_TOKEN + chave, token);
    } catch (erro) {
      // Sem armazenamento: a janela segue, só perde a continuidade.
    }
  }

  /** Apaga o token e a flag juntos: um token novo nunca herda a flag do anterior. */
  function apagarTokenNo(arm, chave) {
    if (!arm) return;
    try {
      arm.removeItem(PREFIXO_TOKEN + chave);
      arm.removeItem(chaveDaFlag(chave));
    } catch (erro) {
      // Sem armazenamento: nada a apagar.
    }
  }

  function apagarFlagIniciada(arm, chave) {
    if (!arm) return;
    try {
      arm.removeItem(chaveDaFlag(chave));
    } catch (erro) {
      // Sem armazenamento: nada a apagar.
    }
  }

  /** Marca de que o visitante já teve a primeira mensagem aceita pelo servidor. */
  function chaveDaFlag(chave) {
    return PREFIXO_TOKEN + chave + ":iniciada";
  }

  function lerFlagIniciada(arm, chave) {
    if (!arm) return false;
    try {
      return arm.getItem(chaveDaFlag(chave)) === "1";
    } catch (erro) {
      return false;
    }
  }

  function gravarFlagIniciada(arm, chave) {
    if (!arm) return;
    try {
      arm.setItem(chaveDaFlag(chave), "1");
    } catch (erro) {
      // Sem armazenamento: o aviso volta na próxima abertura, e só isso.
    }
  }

  /* ---------- DOM ---------- */

  function estilo(elemento, regras) {
    Object.keys(regras).forEach(function (nome) {
      elemento.style[nome] = regras[nome];
    });
  }

  function criar(doc, tag, classe, texto) {
    var elemento = doc.createElement(tag);
    if (classe) elemento.className = classe;
    if (texto !== undefined && texto !== null) elemento.textContent = texto;
    return elemento;
  }

  function botaoPrimario(doc, texto) {
    var botao = criar(doc, "button", null, texto);
    botao.type = "button";
    estilo(botao, ESTILO_BOTAO);
    return botao;
  }

  function horaLocal(em) {
    var data = em ? new Date(em) : new Date();
    if (isNaN(data.getTime())) return "";
    return data.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  function criarLinha(doc, tipo, texto, hora) {
    var linha = criar(doc, "div", "msg msg-" + tipo, null);
    estilo(linha, tipo === "visitante" ? ESTILO_VISITANTE : ESTILO_ATENDENTE);
    linha.style.whiteSpace = "pre-wrap";
    var p = criar(doc, "p", "msg-texto", texto);
    estilo(p, { margin: "0", whiteSpace: "pre-wrap", wordBreak: "break-word" });
    linha.appendChild(p);
    if (hora) {
      var span = criar(doc, "span", "msg-hora", hora);
      estilo(span, { fontSize: ".7rem", color: "#6b7280" });
      linha.appendChild(span);
    }
    return linha;
  }

  function montarInterface(doc) {
    var app = doc.getElementById("webchat-app");
    var main = doc.getElementById("webchat-mensagens");
    var form = doc.getElementById("webchat-form");
    var texto = doc.getElementById("webchat-texto");
    var enviar = doc.getElementById("webchat-enviar");
    var configNo = doc.getElementById("webchat-config");
    if (!app || !main || !form || !texto || !enviar || !configNo) return null;
    var rodape = form.parentNode;
    var aviso = rodape ? rodape.querySelector(".aviso") : null;
    var cabecalho = app.querySelector(".cabecalho");
    if (!rodape || !aviso || !cabecalho) return null;

    var passo = criar(doc, "div", "passo", null);
    app.insertBefore(passo, rodape);
    // Fora do rodapé: o status (reconexão, erro de envio) precisa aparecer também no aviso e na coleta.
    var status = criar(doc, "p", null, "");
    status.setAttribute("role", "status");
    estilo(status, { margin: "0 .8rem", fontSize: ".75rem", color: "#4b5563", minHeight: "0" });
    app.insertBefore(status, passo);

    return {
      app: app,
      main: main,
      rodape: rodape,
      form: form,
      texto: texto,
      enviar: enviar,
      configNo: configNo,
      cabecalho: cabecalho,
      aviso: aviso,
      passo: passo,
      status: status,
      marca: cabecalho.querySelector(".marca strong"),
    };
  }

  /** `/chat/<chave>` com ou sem barra final. Chave fora do formato: null. */
  function chaveDoCaminho(caminho) {
    var texto = String(caminho || "");
    if (texto.length > 1 && texto.charAt(texto.length - 1) === "/") texto = texto.slice(0, -1);
    var partes = texto.split("/");
    if (partes.length !== 3 || partes[0] !== "" || partes[1] !== "chat") return null;
    return CHAVE.test(partes[2]) ? partes[2] : null;
  }

  function lerConfig(no) {
    try {
      var valor = JSON.parse(no.textContent || "null");
      return valor && typeof valor === "object" ? valor : null;
    } catch (erro) {
      return null;
    }
  }

  /** Segundos do `Retry-After`, em milissegundos. Sem cabeçalho válido, um minuto. */
  function esperaDoRetryAfter(resp) {
    var valor =
      resp && resp.headers && typeof resp.headers.get === "function"
        ? parseInt(resp.headers.get("Retry-After"), 10)
        : NaN;
    return isFinite(valor) && valor >= 0 ? valor * 1000 : ESPERA_PADRAO_MS;
  }

  /* ---------- a janela ---------- */

  function iniciar(opcoes) {
    var o = opcoes || {};
    var doc = o.documento || document;
    var janela = o.janela || window;
    var pai = o.pai || window.parent;
    var fazerRequisicao =
      o.fetch ||
      function () {
        return window.fetch.apply(window, arguments);
      };
    var agendarDepois =
      o.agendar ||
      function (funcao, ms) {
        window.setTimeout(funcao, ms);
      };
    var armazenamento = "armazenamento" in o ? o.armazenamento : armazenamentoDoNavegador();
    var caminho = o.caminho !== undefined ? o.caminho : janela.location.pathname;

    var ui = montarInterface(doc);
    if (!ui) return null;

    var estado = {
      token: null,
      encerrado: false,
      conversa: false,
      primeiraEnviada: false,
      contato: null,
      enviando: false,
      ultimaFalha: null,
      tentativas: 0,
      contexto: null,
      fluxoIniciado: false,
      valoresColeta: null,
      // Nenhum envio deu 2xx nesta carga da janela: um 422 agora é o da primeira mensagem.
      cargaComEnvioOk: false,
      // Atendimento devolvido pela sessão (ou nulo). Cada aviso de horário sai uma vez por carga.
      atendimento: null,
      avisoForaMostrado: false,
      avisoSemAgenteMostrado: false,
    };
    var configLida = lerConfig(ui.configNo);
    var config = configLida || {};
    var chave = chaveDoCaminho(caminho);
    var recebidos = {};
    var respostasRapidasMostradas = false;
    var containerRespostasRapidas = null;

    /** Mostra os botões de respostas rápidas antes da primeira mensagem. */
    function mostrarRespostasRapidas() {
      if (respostasRapidasMostradas) return;
      if (estado.primeiraEnviada) return;
      var lista = config.respostasRapidas;
      if (!Array.isArray(lista) || lista.length === 0) return;
      respostasRapidasMostradas = true;
      var container = criar(doc, "div", null, null);
      estilo(container, { display: "flex", flexDirection: "column", gap: ".4rem", margin: ".8rem 0" });
      lista.forEach(function (texto) {
        var btn = criar(doc, "button", null, texto);
        btn.type = "button";
        estilo(btn, ESTILO_BOTAO);
        btn.addEventListener("click", function () {
          ui.texto.value = texto;
          enviarDoCampo();
          container.remove();
          respostasRapidasMostradas = false;
          containerRespostasRapidas = null;
        });
        container.appendChild(btn);
      });
      containerRespostasRapidas = container;
      ui.rodape.insertBefore(container, ui.form);
    }

    /** Remove a fileira de respostas rápidas após o primeiro envio. */
    function removerRespostasRapidas() {
      if (!containerRespostasRapidas) return;
      containerRespostasRapidas.remove();
      containerRespostasRapidas = null;
      respostasRapidasMostradas = false;
    }

    function agendar(funcao, ms) {
      if (!estado.encerrado) agendarDepois(funcao, ms);
    }

    function proximaEspera() {
      var espera = Math.min(ESPERA_INICIAL_MS * Math.pow(2, estado.tentativas), ESPERA_TETO_MS);
      estado.tentativas += 1;
      return espera;
    }

    function mostrarStatus(texto) {
      ui.status.textContent = texto || "";
    }

    function setReconectando(ligado) {
      mostrarStatus(ligado ? "Reconectando…" : "");
    }

    function atualizarControles() {
      ui.enviar.disabled = estado.enviando;
    }

    function trocarToken(novo) {
      estado.token = novo;
      guardarTokenNo(armazenamento, chave, novo);
    }

    function apagarToken() {
      estado.token = null;
      apagarTokenNo(armazenamento, chave);
    }

    function requisitar(url, metodo, corpo, token) {
      var cabecalhos = {};
      if (corpo !== null) cabecalhos["Content-Type"] = "application/json";
      if (token) cabecalhos.Authorization = "Bearer " + token;
      return fazerRequisicao(url, {
        method: metodo,
        headers: cabecalhos,
        body: corpo !== null ? JSON.stringify(corpo) : undefined,
        credentials: "omit",
        cache: "no-store",
      });
    }

    /** Resposta lida como JSON, com o status e a espera do `Retry-After`. */
    function pedirJson(url, metodo, corpo, token) {
      return requisitar(url, metodo, corpo, token).then(function (resp) {
        var lido = typeof resp.json === "function" ? resp.json() : Promise.resolve(null);
        return Promise.resolve(lido)
          .catch(function () {
            return null;
          })
          .then(function (json) {
            return {
              status: resp.status,
              ok: resp.ok === true,
              corpo: json,
              esperaMs: esperaDoRetryAfter(resp),
            };
          });
      });
    }

    function mostrarPasso(comAviso) {
      ui.passo.textContent = "";
      estilo(ui.passo, { display: "block", padding: ".8rem", borderTop: "1px solid #e5e7eb" });
      if (comAviso) ui.passo.appendChild(ui.aviso);
    }

    function indisponivel() {
      if (estado.encerrado) return;
      estado.encerrado = true;
      mostrarPasso(false);
      var aviso = criar(doc, "p", null, "Chat indisponível");
      aviso.setAttribute("role", "status");
      estilo(aviso, { margin: "0", color: "#4b5563" });
      ui.passo.appendChild(aviso);
      estilo(ui.rodape, { display: "none" });
    }

    function adicionarLinha(linha) {
      ui.main.appendChild(linha);
      ui.main.scrollTop = ui.main.scrollHeight;
    }

    function montarAviso() {
      var aviso = ui.aviso;
      aviso.textContent = "";
      var controlador = config.controlador && typeof config.controlador === "object" ? config.controlador : {};
      var nome =
        typeof controlador.razaoSocial === "string" && controlador.razaoSocial !== ""
          ? controlador.razaoSocial
          : (ui.marca && ui.marca.textContent) || "o responsável por este site";
      aviso.appendChild(
        doc.createTextNode(
          "Ao enviar a primeira mensagem, você concorda com o tratamento dos seus dados por ",
        ),
      );
      aviso.appendChild(criar(doc, "strong", null, nome));
      aviso.appendChild(doc.createTextNode("."));
      var politica = controlador.politicaUrl;
      if (typeof politica === "string" && POLITICA_HTTP.test(politica)) {
        aviso.appendChild(doc.createTextNode(" "));
        var link = criar(doc, "a", null, "Política de privacidade");
        link.setAttribute("href", politica);
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer");
        aviso.appendChild(link);
      }
    }

    function temCamposDeColeta() {
      return CAMPOS.some(function (campo) {
        return modoDaColeta(config.coleta, campo) !== "oculto";
      });
    }

    /* Passo 1: aviso e aceite. */
    function telaAceite() {
      estilo(ui.rodape, { display: "none" });
      mostrarPasso(true);
      var botao = botaoPrimario(doc, "Aceitar e continuar");
      botao.addEventListener("click", function () {
        if (temCamposDeColeta()) telaColeta();
        else telaConversa();
      });
      ui.passo.appendChild(botao);
      botao.focus();
    }

    /* Passo 2: coleta, só com os campos que não estão ocultos. */
    function telaColeta() {
      mostrarPasso(true);
      estilo(ui.rodape, { display: "none" });
      var anteriores = estado.valoresColeta || {};
      var campos = CAMPOS.filter(function (campo) {
        return modoDaColeta(config.coleta, campo) !== "oculto";
      });
      var formulario = criar(doc, "form", "coleta", null);
      formulario.setAttribute("novalidate", "");
      estilo(formulario, { display: "flex", flexDirection: "column", gap: ".5rem" });
      var entradas = {};
      var erros = {};

      campos.forEach(function (campo) {
        var modo = modoDaColeta(config.coleta, campo);
        var id = "webchat-coleta-" + campo;
        var rotulo = criar(
          doc,
          "label",
          null,
          ROTULOS[campo] + (modo === "obrigatorio" ? " (obrigatório)" : ""),
        );
        rotulo.setAttribute("for", id);
        var entrada = criar(doc, "input", null, null);
        entrada.id = id;
        entrada.name = campo;
        entrada.type = TIPOS[campo];
        entrada.setAttribute("autocomplete", AUTOCOMPLETE[campo]);
        entrada.maxLength = LIMITES_COLETA[campo];
        entrada.value = typeof anteriores[campo] === "string" ? anteriores[campo] : "";
        if (modo === "obrigatorio") entrada.setAttribute("aria-required", "true");
        var erro = criar(doc, "span", null, "");
        erro.id = id + "-erro";
        erro.setAttribute("role", "alert");
        entrada.setAttribute("aria-describedby", erro.id);
        estilo(erro, { color: "#b91c1c", fontSize: ".75rem" });
        entradas[campo] = entrada;
        erros[campo] = erro;
        var bloco = criar(doc, "div", null, null);
        bloco.appendChild(rotulo);
        bloco.appendChild(entrada);
        bloco.appendChild(erro);
        formulario.appendChild(bloco);
      });

      var continuar = botaoPrimario(doc, "Continuar");
      continuar.type = "submit";
      formulario.appendChild(continuar);

      formulario.addEventListener("submit", function (evento) {
        evento.preventDefault();
        var valores = {};
        campos.forEach(function (campo) {
          valores[campo] = entradas[campo].value;
        });
        estado.valoresColeta = valores;
        var resultado = validarColeta(valores, config.coleta);
        var primeiroComErro = null;
        campos.forEach(function (campo) {
          erros[campo].textContent = resultado.erros[campo] || "";
          if (resultado.erros[campo] && primeiroComErro === null) primeiroComErro = entradas[campo];
        });
        if (!resultado.ok) {
          if (primeiroComErro) primeiroComErro.focus();
          return;
        }
        estado.contato = resultado.contato;
        telaConversa();
      });

      ui.passo.appendChild(formulario);
      entradas[campos[0]].focus();
    }

    /* Passo 3: a conversa. Abre o fluxo de respostas. */
    function telaConversa() {
      estado.conversa = true;
      ui.passo.textContent = "";
      estilo(ui.passo, { display: "none" });
      ui.rodape.insertBefore(ui.aviso, ui.form);
      estilo(ui.rodape, { display: "block" });
      estilo(ui.form, { display: "flex" });
      mostrarStatus("");
      ui.texto.focus();
      // Respostas rápidas antes da primeira mensagem (somem após o primeiro envio).
      mostrarRespostasRapidas();
      // Voltar à coleta (422 na primeira mensagem) passa de novo por aqui: o fluxo abre uma vez só.
      if (!estado.fluxoIniciado) {
        estado.fluxoIniciado = true;
        assinarRespostas();
      }
      mostrarAvisoDeForaDoHorario();
    }

    /** Fora do horário: uma linha de atendente por carga, com o aviso do agente ou o texto padrão. */
    function mostrarAvisoDeForaDoHorario() {
      var at = estado.atendimento;
      if (!at || at.estado !== "fechado" || estado.avisoForaMostrado) return;
      estado.avisoForaMostrado = true;
      var texto = at.aviso !== null ? at.aviso : textoDaVolta(at.abreEm);
      adicionarLinha(criarLinha(doc, "atendente", texto, ""));
    }

    /** Sem agente: depois da primeira mensagem aceita, uma linha de atendente por carga. */
    function mostrarAvisoSemAgente() {
      var at = estado.atendimento;
      if (!at || at.estado !== "sem_agente" || estado.avisoSemAgenteMostrado) return;
      estado.avisoSemAgenteMostrado = true;
      adicionarLinha(criarLinha(doc, "atendente", AVISO_SEM_AGENTE, ""));
    }

    /** 422 na primeira mensagem: volta à coleta com o que foi digitado, ou ao aviso se não há campos. */
    function voltarParaPreenchimento() {
      if (temCamposDeColeta()) telaColeta();
      else telaAceite();
    }

    function criarLinhaDoVisitante(m) {
      var linha = criarLinha(doc, "visitante", m.texto, horaLocal(null));
      var estadoEl = criar(doc, "span", "msg-estado", null);
      estilo(estadoEl, { display: "block", fontSize: ".7rem", textAlign: "right", marginTop: ".2rem" });
      estadoEl.addEventListener("click", function () {
        if (m.estado === "falhou") enviarMensagem(m);
      });
      estadoEl.addEventListener("keydown", function (evento) {
        if ((evento.key === "Enter" || evento.key === " ") && m.estado === "falhou") {
          evento.preventDefault();
          enviarMensagem(m);
        }
      });
      linha.appendChild(estadoEl);
      m.estadoEl = estadoEl;
      atualizarEstado(m);
      return linha;
    }

    function atualizarEstado(m) {
      var falhou = m.estado === "falhou";
      m.estadoEl.textContent =
        m.estado === "enviada"
          ? "enviada"
          : falhou
            ? "não enviada — tentar de novo"
            : "enviando";
      m.estadoEl.tabIndex = falhou ? 0 : -1;
      if (falhou) m.estadoEl.setAttribute("role", "button");
      else m.estadoEl.removeAttribute("role");
      estilo(m.estadoEl, {
        color: falhou ? "#b91c1c" : "#6b7280",
        cursor: falhou ? "pointer" : "default",
        textDecoration: falhou ? "underline" : "none",
      });
    }

    function enviarMensagem(m) {
      if (estado.enviando || estado.encerrado) return;
      estado.enviando = true;
      mostrarStatus("");
      m.estado = "enviando";
      atualizarEstado(m);
      atualizarControles();

      var corpo = { mensagem_id: m.id, texto: m.texto };
      if (!estado.primeiraEnviada) {
        corpo.aceite = { versao: config.versaoDoAviso };
        if (estado.contato) corpo.contato = estado.contato;
      }

      pedirJson(ROTA_MENSAGENS, "POST", corpo, estado.token).then(
        function (r) {
          estado.enviando = false;
          atualizarControles();
          if (r.ok) {
            m.estado = "enviada";
            atualizarEstado(m);
            estado.primeiraEnviada = true;
            estado.cargaComEnvioOk = true;
            mostrarAvisoSemAgente();
            gravarFlagIniciada(armazenamento, chave);
            var novo = r.corpo && r.corpo.data && r.corpo.data.token_novo;
            if (typeof novo === "string" && novo !== "") trocarToken(novo);
            if (estado.ultimaFalha === m) estado.ultimaFalha = null;
            return;
          }
          m.estado = "falhou";
          atualizarEstado(m);
          estado.ultimaFalha = m;
          if (r.status === 401) {
            apagarToken();
            indisponivel();
            return;
          }
          if (r.status === 404) {
            indisponivel();
            return;
          }
          if (r.status === 422 && !estado.cargaComEnvioOk) {
            // Primeira mensagem da carga recusada: a flag (guardada ou não) não vale mais. Pede o
            // aceite de novo; o reenvio usa o mesmo mensagem_id (ultimaFalha).
            apagarFlagIniciada(armazenamento, chave);
            estado.primeiraEnviada = false;
            mostrarStatus("Confira os dados e tente de novo.");
            voltarParaPreenchimento();
            return;
          }
          if (r.status === 429) {
            mostrarStatus("Muitas mensagens em pouco tempo. Vou tentar de novo em instantes.");
            agendar(function () {
              if (m.estado === "falhou") enviarMensagem(m);
            }, r.esperaMs);
            return;
          }
          mostrarStatus(
            r.status === 422
              ? "Confira os dados e tente de novo."
              : "Não consegui enviar. Tente de novo.",
          );
        },
        function () {
          estado.enviando = false;
          atualizarControles();
          m.estado = "falhou";
          atualizarEstado(m);
          estado.ultimaFalha = m;
          mostrarStatus("Sem conexão. Tente de novo.");
        },
      );
    }

    function enviarDoCampo() {
      if (estado.enviando || estado.encerrado) return;
      var resultado = montarMensagem(ui.texto.value, estado.ultimaFalha);
      if (!resultado.ok) {
        mostrarStatus(
          resultado.motivo === "vazio"
            ? "Digite uma mensagem para enviar."
            : "A mensagem passou de " + LIMITE_TEXTO + " caracteres. Encurte o texto para enviar.",
        );
        return;
      }
      var m = estado.ultimaFalha && estado.ultimaFalha.id === resultado.id ? estado.ultimaFalha : null;
      if (!m) {
        m = { id: resultado.id, texto: resultado.texto, estado: "enviando" };
        m.linha = criarLinhaDoVisitante(m);
        adicionarLinha(m.linha);
      }
      ui.texto.value = "";
      removerRespostasRapidas();
      enviarMensagem(m);
    }

    function mostrarResposta(dados) {
      adicionarLinha(criarLinha(doc, "atendente", dados.texto, horaLocal(dados.em)));
      if (pai && typeof pai.postMessage === "function") pai.postMessage({ tipo: "resposta" }, "*");
    }

    function tratarEvento(ev) {
      estado.tentativas = 0;
      if (ev.evento !== "mensagem") return;
      var dados = null;
      try {
        dados = JSON.parse(ev.dados);
      } catch (erro) {
        return;
      }
      if (!dados || typeof dados.id !== "string" || typeof dados.texto !== "string") return;
      if (recebidos[dados.id] === true) return;
      recebidos[dados.id] = true;
      mostrarResposta(dados);
    }

    /** Fluxo de respostas. Fechar em ~60 s é normal: reconecta sem alarde. Erro: espera crescente. */
    function assinarRespostas() {
      if (estado.encerrado) return;
      requisitar(ROTA_EVENTOS, "GET", null, estado.token)
        .then(function (resp) {
          if (resp.status === 401) {
            apagarToken();
            indisponivel();
            return undefined;
          }
          if (resp.status === 429) {
            agendar(assinarRespostas, esperaDoRetryAfter(resp));
            return undefined;
          }
          if (resp.status >= 400 && resp.status < 500) {
            indisponivel();
            return undefined;
          }
          if (!resp.ok || !resp.body || typeof resp.body.getReader !== "function") {
            throw new Error("eventos");
          }
          setReconectando(false);
          return lerEventos(resp.body.getReader(), tratarEvento).then(function () {
            estado.tentativas = 0;
            agendar(assinarRespostas, ESPERA_ENTRE_FLUXOS_MS);
          });
        })
        .catch(function () {
          if (estado.encerrado) return;
          setReconectando(true);
          agendar(assinarRespostas, proximaEspera());
        });
    }

    /** Sessão: abre a janela com o token guardado (se houver) e recebe um token novo. */
    function abrirSessao() {
      if (estado.encerrado) return;
      pedirJson(ROTA_SESSAO, "POST", { chave: chave }, estado.token)
        .then(function (r) {
          if (r.status === 429) {
            agendar(abrirSessao, r.esperaMs);
            return;
          }
          if (r.status >= 400 && r.status < 500) {
            if (r.status === 401) apagarToken();
            indisponivel();
            return;
          }
          var dados = r.corpo && r.corpo.data;
          if (!r.ok || !dados || typeof dados.token !== "string") throw new Error("sessao");
          trocarToken(dados.token);
          estado.atendimento = lerAtendimento(dados.atendimento);
          estado.tentativas = 0;
          setReconectando(false);
          // Visitante que já teve a primeira mensagem aceita (flag e token) vai direto à conversa.
          if (estado.primeiraEnviada) telaConversa();
          else telaAceite();
        })
        .catch(function () {
          if (estado.encerrado) return;
          setReconectando(true);
          agendar(abrirSessao, proximaEspera());
        });
    }

    /* ----- montagem ----- */

    montarAviso();

    // Avatar: se config.avatar é uma URL https, mostra um círculo no início do cabeçalho.
    if (typeof config.avatar === "string" && config.avatar.startsWith("https://")) {
      var imgAvatar = criar(doc, "img", null, null);
      imgAvatar.setAttribute("src", config.avatar);
      imgAvatar.setAttribute("alt", "");
      estilo(imgAvatar, { width: "28px", height: "28px", borderRadius: "50%", objectFit: "cover" });
      ui.cabecalho.insertBefore(imgAvatar, ui.cabecalho.firstChild);
    }

    ui.main.setAttribute("role", "log");
    estilo(ui.form, { display: "none" });
    estilo(ui.rodape, { display: "none" });

    var fechar = criar(doc, "button", null, "×");
    fechar.type = "button";
    fechar.setAttribute("aria-label", "Fechar chat");
    estilo(fechar, {
      marginLeft: "auto",
      background: "transparent",
      border: "0",
      color: "inherit",
      font: "inherit",
      fontSize: "1.4rem",
      lineHeight: "1",
      padding: "0 .2rem",
      cursor: "pointer",
    });
    ui.cabecalho.appendChild(fechar);

    function fecharJanela() {
      if (pai && typeof pai.postMessage === "function") pai.postMessage({ tipo: "fechar" }, "*");
    }
    fechar.addEventListener("click", fecharJanela);
    doc.addEventListener("keydown", function (evento) {
      if (evento.key === "Escape" || evento.key === "Esc") fecharJanela();
    });

    ui.form.addEventListener("submit", function (evento) {
      evento.preventDefault();
      enviarDoCampo();
    });
    ui.texto.addEventListener("keydown", function (evento) {
      if (evento.key === "Enter" && !evento.shiftKey && !evento.isComposing) {
        evento.preventDefault();
        enviarDoCampo();
      }
    });

    janela.addEventListener("message", function (evento) {
      if (aceitarMensagemDoPai(evento, pai)) estado.contexto = normalizarContexto(evento.data);
    });

    if (!configLida || !chave) {
      indisponivel();
      return { contexto: function () { return estado.contexto; } };
    }

    if (config.saudacao) {
      adicionarLinha(criarLinha(doc, "atendente", String(config.saudacao), ""));
    }

    mostrarPasso(false);
    ui.passo.appendChild(criar(doc, "p", null, "Conectando…"));

    estado.token = lerTokenGuardado(armazenamento, chave);
    // Pula aviso e coleta só com a flag E com token: sem um dos dois, o aceite é pedido de novo.
    estado.primeiraEnviada = lerFlagIniciada(armazenamento, chave) && estado.token !== null;
    if (pai && typeof pai.postMessage === "function") pai.postMessage({ tipo: "pronto" }, "*");
    // Ajustes: autoAbrirSegundos e som (padrões 0 e false quando ausentes ou de tipo errado).
    var autoAbrir = config.autoAbrirSegundos;
    if (typeof autoAbrir !== "number" || autoAbrir % 1 !== 0 || autoAbrir < 0 || autoAbrir > 120) autoAbrir = 0;
    var som = typeof config.som === "boolean" ? config.som : false;
    if (pai && typeof pai.postMessage === "function") pai.postMessage({ tipo: "ajustes", autoAbrirSegundos: autoAbrir, som: som }, "*");
    abrirSessao();

    return { contexto: function () { return estado.contexto; } };
  }

  /* ---------- exposição para teste, ou início no navegador ---------- */

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      aceitarMensagemDoPai: aceitarMensagemDoPai,
      montarMensagem: montarMensagem,
      lerEventos: lerEventos,
      validarColeta: validarColeta,
      normalizarContexto: normalizarContexto,
      iniciar: iniciar,
    };
  } else if (typeof document !== "undefined") {
    iniciar();
  }
})();
