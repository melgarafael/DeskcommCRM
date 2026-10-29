// Curso DeskComm — navegação, leitura anotada, simulador e busca. Sem dependências.
(function () {
  "use strict";
  var D = JSON.parse(document.getElementById("dados").textContent);
  var W = D.largura, H = D.altura;
  var vista = document.getElementById("vista");
  var CHAVE_FEITOS = "curso-deskcomm:feitos";

  // ---------- utilidades ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function normalizar(s) {
    return String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  }
  function plural(n, um, varios) { return n + " " + (n === 1 ? um : varios); }
  function pct(v, total) { return (v / total) * 100 + "%"; }
  function feitos() {
    try { return JSON.parse(localStorage.getItem(CHAVE_FEITOS) || "[]"); } catch { return []; }
  }
  function marcarFeito(id) {
    try {
      var f = feitos();
      if (f.indexOf(id) < 0) { f.push(id); localStorage.setItem(CHAVE_FEITOS, JSON.stringify(f)); }
    } catch { /* armazenamento bloqueado: o progresso só não fica lembrado */ }
  }
  function modulo(id) { return D.modulos.filter(function (m) { return m.id === id; })[0]; }
  function licaoDe(m, id) { return m && m.licoes.filter(function (l) { return l.id === id; })[0]; }
  // a chave leva o módulo: ids de lição se repetem entre módulos (curso/licao.ts, chaveDoPasso)
  function captura(m, licao, passo) { return D.capturas[m.id + "--" + licao.id + "--" + passo.id]; }
  function tokenDaTela(href) { return "t." + href.slice(1).split("/").join("~"); }

  // ---------- a foto anotada ----------
  // Coordenadas vêm medidas pelo capturador, em pixels da tela de W×H; o SVG usa o mesmo
  // viewBox, então caixas e setas escalam junto com a foto em qualquer largura.
  var contadorDeMascara = 0;
  var P = 6, R = 22; // folga da caixa e raio do selo, em pixels da foto

  // Selo nunca cobre um alvo: ele procura, em ordem, um lugar livre FORA de todas as
  // caixas do passo e longe dos selos já postos. Sem lugar livre, fica no menos ruim.
  function livre(p, caixas, selos) {
    if (p[0] < R || p[1] < R || p[0] > W - R || p[1] > H - R) return false;
    for (var i = 0; i < caixas.length; i++) {
      var c = caixas[i];
      if (p[0] > c.x - R && p[0] < c.x + c.w + R && p[1] > c.y - R && p[1] < c.y + c.h + R) return false;
    }
    for (var j = 0; j < selos.length; j++) {
      if (Math.hypot(p[0] - selos[j][0], p[1] - selos[j][1]) < 2 * R + 4) return false;
    }
    return true;
  }
  function seta(de, ate) {
    var ang = Math.atan2(ate[1] - de[1], ate[0] - de[0]), t = 24, a = 0.45;
    var p1 = [ate[0] - t * Math.cos(ang - a), ate[1] - t * Math.sin(ang - a)];
    var p2 = [ate[0] - t * Math.cos(ang + a), ate[1] - t * Math.sin(ang + a)];
    var meio = [ate[0] - 0.8 * t * Math.cos(ang), ate[1] - 0.8 * t * Math.sin(ang)];
    return '<line class="seta-linha" x1="' + de[0] + '" y1="' + de[1] + '" x2="' + meio[0] + '" y2="' + meio[1] + '" vector-effect="non-scaling-stroke"/>' +
      '<polygon class="seta-ponta" points="' + ate.join(",") + " " + p1.join(",") + " " + p2.join(",") + '"/>';
  }
  /** Onde o selo (e, na seta, o rabo) de uma caixa fica: candidatos em volta, o primeiro livre vence. */
  function posicionar(c, tipo, caixas, selos) {
    var cx = c.x + c.w / 2, cy = c.y + c.h / 2, cands = [];
    if (tipo === "seta") {
      var L = 110, g = 10, d = L * 0.7;
      [["esq", [c.x - g, cy], [-L, 0]], ["cima", [cx, c.y - g], [0, -L]], ["dir", [c.x + c.w + g, cy], [L, 0]],
       ["baixo", [cx, c.y + c.h + g], [0, L]], ["ce", [c.x - g, c.y - g], [-d, -d]], ["cd", [c.x + c.w + g, c.y - g], [d, -d]],
       ["be", [c.x - g, c.y + c.h + g], [-d, d]], ["bd", [c.x + c.w + g, c.y + c.h + g], [d, d]]].forEach(function (k) {
        cands.push({ selo: [k[1][0] + k[2][0], k[1][1] + k[2][1]], ponta: k[1] });
      });
    } else {
      var f = R + 6;
      [[c.x - f, cy], [c.x - f, c.y - f + R], [cx, c.y - f], [c.x + c.w + f, cy], [cx, c.y + c.h + f],
       [c.x - f, c.y - f], [c.x + c.w + f, c.y - f]].forEach(function (p) { cands.push({ selo: p }); });
    }
    for (var i = 0; i < cands.length; i++) if (livre(cands[i].selo, caixas, selos)) return cands[i];
    var reserva = cands[0];
    reserva.selo = [Math.min(W - R, Math.max(R, reserva.selo[0])), Math.min(H - R, Math.max(R, reserva.selo[1]))];
    return reserva;
  }
  function figura(cap, opcoes) {
    opcoes = opcoes || {};
    var id = "m" + (++contadorDeMascara);
    var furos = "", contornos = "", setas = "", selos = "";
    if (!opcoes.limpa) {
      var caixas = cap.destaques.map(function (d) { return { x: d.x - P, y: d.y - P, w: d.w + 2 * P, h: d.h + 2 * P }; });
      var postos = [];
      cap.destaques.forEach(function (d, i) {
        var c = caixas[i];
        furos += '<rect x="' + c.x + '" y="' + c.y + '" width="' + c.w + '" height="' + c.h + '" rx="8" fill="#000"/>';
        if (d.tipo !== "numero") contornos += '<rect class="contorno" x="' + c.x + '" y="' + c.y + '" width="' + c.w + '" height="' + c.h + '" rx="8" vector-effect="non-scaling-stroke"/>';
        var lugar = posicionar(c, d.tipo, caixas, postos);
        if (d.tipo === "seta") setas += seta(lugar.selo, lugar.ponta);
        postos.push(lugar.selo);
        selos += '<span class="selo" style="left:' + pct(lugar.selo[0], W) + ";top:" + pct(lugar.selo[1], H) + '">' + (i + 1) + "</span>";
      });
    }
    var veu = cap.destaques.length && !opcoes.limpa
      ? '<defs><mask id="' + id + '"><rect width="' + W + '" height="' + H + '" fill="#fff"/>' + furos + "</mask></defs>" +
        '<rect class="veu" width="' + W + '" height="' + H + '" mask="url(#' + id + ')"/>'
      : "";
    return '<figure class="tela" style="--proporcao:' + W + "/" + H + '">' +
      '<img src="' + esc(cap.foto) + '" alt="' + esc(opcoes.alt || "") + '" loading="' + (opcoes.ansioso ? "eager" : "lazy") + '" width="' + W + '" height="' + H + '">' +
      '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" aria-hidden="true">' + veu + contornos + setas + "</svg>" +
      selos + (opcoes.extra || "") + "</figure>";
  }
  function legenda(cap) {
    if (!cap.destaques.length) return "";
    return '<ol class="legenda">' + cap.destaques.map(function (d, i) {
      return '<li><span class="selo">' + (i + 1) + "</span>" + esc(d.rotulo) + "</li>";
    }).join("") + "</ol>";
  }

  var demos = window.criarDemonstracoes({ dados: D, esc: esc, vista: vista, figura: figura, legenda: legenda });

  // ---------- menu lateral ----------
  function desenharMenu(rota) {
    var f = feitos();
    document.getElementById("menu-grupos").innerHTML = '<div><div class="grupo-titulo">Histórias na tela</div><ul class="grupo-itens"><li><a class="item-menu" href="#acao"' + (rota.demo ? ' aria-current="page"' : '') + '>Deskcomm em ação</a></li></ul></div>' + D.menu.map(function (g) {
      return '<div><div class="grupo-titulo">' + esc(g.grupo) + '</div><ul class="grupo-itens">' + g.itens.map(function (it) {
        var m = it.modulo && modulo(it.modulo);
        var ativo = m ? rota.mod === m.id : rota.tela === it.href;
        var link = '<a class="item-menu" href="' + esc("#" + (m ? "m." + m.id : tokenDaTela(it.href))) + '"' + (ativo ? ' aria-current="page"' : "") + ">" +
          "<span>" + esc(it.rotulo) + "</span>" +
          (m ? '<span class="qtd">' + plural(m.licoes.length, "lição", "lições") + "</span>" : '<span class="breve">em breve</span>') + "</a>";
        var sub = m && ativo ? '<ul class="sublicoes">' + m.licoes.map(function (l) {
          return '<li><a href="' + esc("#l." + m.id + "." + l.id) + '"' + (rota.licao === l.id ? ' aria-current="page"' : "") + ">" +
            (f.indexOf(m.id + "/" + l.id) >= 0 ? '<span class="feito" aria-label="concluída">✓</span>' : "") + esc(l.titulo) + "</a></li>";
        }).join("") + "</ul>" : "";
        return "<li>" + link + sub + "</li>";
      }).join("") + "</ul></div>";
    }).join("");
  }

  // ---------- vistas ----------
  function vistaInicio() {
    var m0 = D.modulos[0], l0 = m0.licoes[0], cap0 = captura(m0, l0, l0.passos[0]);
    var semCurso = [];
    D.menu.forEach(function (g) { g.itens.forEach(function (it) { if (!it.modulo) semCurso.push(it); }); });
    return '<div class="coluna">' +
      '<section class="abertura"><div class="coluna-texto" style="display:flex;flex-direction:column;gap:16px">' +
      '<span class="rotulo-mono">Curso em imagens · versão ' + esc(D.versao) + "</span>" +
      '<h1 class="titulo-pagina">Aprenda o DeskComm tela por tela.</h1>' +
      '<p class="subtitulo">Cada lição mostra o sistema de verdade, com setas apontando onde clicar e o que acontece depois. Leia no seu ritmo ou treine no simulador antes de atender um cliente.</p>' +
      '<div class="acoes"><a class="botao botao-primario" href="#l.' + m0.id + "." + l0.id + '">Começar pela ' + esc(m0.titulo) + '</a>' +
      '<a class="botao botao-secundario" href="#s.' + m0.id + "." + l0.id + '">Abrir o simulador</a></div></div>' +
      '<div class="abertura-figura">' + figura(cap0, { ansioso: true, alt: "Tela da " + m0.titulo + " do DeskComm" }) + "</div></section>" +
      '<section class="jornada-convite"><a class="cartao" href="#acao"><span class="rotulo-mono">Histórias na tela</span><h2>Deskcomm em ação</h2><p>Mostre a um cliente como um atendimento caminha pela operação. Escolha um negócio, apresente a história e aprenda a montar.</p><span>Escolher uma história →</span></a></section>' +
      '<section class="como">' +
      "<div><strong>O menu é o do sistema</strong><span>À esquerda estão os mesmos grupos e nomes que você vê no DeskComm. Clique numa tela para aprender sobre ela.</span></div>" +
      "<div><strong>Ler ou simular</strong><span>No modo Ler, cada passo tem a foto da tela e a explicação. No Simulador, você clica no lugar certo para avançar.</span></div>" +
      "<div><strong>Busque qualquer dúvida</strong><span>Digite na busca o que você quer fazer, como “transferir conversa” ou “nota interna”.</span></div></section>" +
      '<section style="display:flex;flex-direction:column;gap:14px"><h2 class="secao-titulo">Módulos</h2><div class="cartoes">' +
      D.modulos.map(function (m) {
        var n = m.licoes.reduce(function (a, l) { return a + l.passos.length; }, 0);
        return '<a class="cartao" href="#m.' + m.id + '"><span class="rotulo-mono">' + esc(grupoDaTela(m.tela)) + "</span><h3>" + esc(m.titulo) + "</h3><p>" + esc(m.resumo) + '</p><div class="rodape-cartao"><span>' + plural(m.licoes.length, "lição", "lições") + "</span><span>" + plural(n, "passo ilustrado", "passos ilustrados") + "</span></div></a>";
      }).join("") + "</div></section>" +
      // quando toda tela do menu já tem módulo, a seção some: título sobre lista vazia promete o que não há
      (semCurso.length
        ? '<section style="display:flex;flex-direction:column;gap:14px"><h2 class="secao-titulo">Próximos módulos</h2>' +
          '<p class="subtitulo">Estas telas ainda não têm lições. Por enquanto, veja para que cada uma serve.</p><ul class="em-breve">' +
          semCurso.map(function (it) { return "<li><strong>" + esc(it.rotulo) + "</strong><span>" + esc(it.descricao) + "</span></li>"; }).join("") +
          "</ul></section>"
        : "") +
      "</div>";
  }
  function grupoDaTela(href) {
    var g = D.menu.filter(function (g) { return g.itens.some(function (it) { return it.href === href; }); })[0];
    return g ? g.grupo : "";
  }
  function vistaTela(href) {
    var it = null, grupo = "";
    D.menu.forEach(function (g) { g.itens.forEach(function (i) { if (i.href === href) { it = i; grupo = g.grupo; } }); });
    if (!it) return vistaInicio();
    return '<div class="coluna"><div class="coluna-texto" style="display:flex;flex-direction:column;gap:14px">' +
      '<nav class="trilha"><a href="#inicio">Início</a><span>›</span><span>' + esc(grupo) + "</span></nav>" +
      '<h1 class="titulo-pagina">' + esc(it.rotulo) + '</h1><p class="subtitulo">' + esc(it.descricao) + "</p>" +
      '<p class="dica"><b>Em breve.</b> Esta tela ainda não tem lições ilustradas. Comece pelos módulos prontos enquanto preparamos este.</p>' +
      '<div class="acoes"><a class="botao botao-secundario" href="#inicio">Ver módulos prontos</a></div></div></div>';
  }
  function vistaModulo(m) {
    var f = feitos();
    return '<div class="coluna"><div class="coluna-texto" style="display:flex;flex-direction:column;gap:14px">' +
      '<nav class="trilha"><a href="#inicio">Início</a><span>›</span><span>' + esc(grupoDaTela(m.tela)) + "</span></nav>" +
      '<h1 class="titulo-pagina">' + esc(m.titulo) + '</h1><p class="subtitulo">' + esc(m.resumo) + "</p></div>" +
      '<div class="cartoes">' + m.licoes.map(function (l, i) {
        var ok = f.indexOf(m.id + "/" + l.id) >= 0;
        return '<a class="cartao" href="#l.' + m.id + "." + l.id + '"><span class="rotulo-mono">Lição ' + (i + 1) + (ok ? ' · <span class="feito">concluída</span>' : "") + "</span><h3>" + esc(l.titulo) + "</h3><p>" + esc(l.objetivo) + '</p><div class="rodape-cartao"><span>' + l.passos.length + " passos</span><span>Ler ou simular</span></div></a>";
      }).join("") + "</div></div>";
  }
  function cabecalhoLicao(m, l, modo) {
    var i = m.licoes.indexOf(l);
    return '<div class="cabeca-licao coluna-texto">' +
      '<nav class="trilha"><a href="#inicio">Início</a><span>›</span><a href="#m.' + m.id + '">' + esc(m.titulo) + "</a><span>›</span><span>Lição " + (i + 1) + " de " + m.licoes.length + "</span></nav>" +
      '<h1 class="titulo-pagina">' + esc(l.titulo) + '</h1><p class="subtitulo">' + esc(l.objetivo) + "</p>" +
      '<div class="alternador" role="tablist" aria-label="Modo da lição">' +
      '<a href="#l.' + m.id + "." + l.id + '"' + (modo === "ler" ? ' aria-current="page"' : "") + ">Ler</a>" +
      '<a href="#s.' + m.id + "." + l.id + '"' + (modo === "simular" ? ' aria-current="page"' : "") + ">Simular</a></div></div>";
  }
  function proximaLicao(m, l) {
    var i = m.licoes.indexOf(l);
    return m.licoes[i + 1] || null;
  }
  function vistaLicao(m, l) {
    var prox = proximaLicao(m, l);
    return '<div class="coluna">' + cabecalhoLicao(m, l, "ler") +
      l.passos.map(function (p, i) {
        var cap = captura(m, l, p);
        return '<section class="passo" id="passo-' + esc(p.id) + '"><div class="passo-num" aria-hidden="true">' + String(i + 1).padStart(2, "0") + "</div>" +
          '<div class="passo-corpo"><span class="rotulo-mono">Passo ' + (i + 1) + " de " + l.passos.length + "</span><h2>" + esc(p.titulo) + "</h2>" +
          '<p class="texto">' + esc(p.texto) + "</p>" + figura(cap, { alt: p.titulo, ansioso: i === 0 }) + '<div class="sob-figura">' + legenda(cap) + '<span class="ampliar-dica">Clique na foto para ampliar</span></div>' +
          (p.dica ? '<p class="dica"><b>Dica:</b> ' + esc(p.dica) + "</p>" : "") + "</div></section>";
      }).join("") +
      '<div class="fim-licao coluna-texto"><h2 class="secao-titulo">Pronto para praticar?</h2><p class="subtitulo">Refaça esta lição no simulador: você clica nos lugares certos, como faria no sistema.</p>' +
      '<div class="acoes"><a class="botao botao-primario" href="#s.' + m.id + "." + l.id + '">Treinar no simulador</a>' +
      '<button class="botao botao-secundario" type="button" id="marcar-feita">Marcar como concluída</button>' +
      (prox ? '<a class="botao botao-secundario" href="#l.' + m.id + "." + prox.id + '">Próxima: ' + esc(prox.titulo) + "</a>" : "") + "</div></div></div>";
  }

  // ---------- simulador ----------
  var sim = null;
  function vistaSimulador(m, l) {
    sim = { m: m, l: l, i: 0 };
    return '<div class="coluna">' + cabecalhoLicao(m, l, "simular") + '<div class="simulador" id="simulador"></div></div>';
  }
  function desenharSimulador() {
    var alvo = document.getElementById("simulador");
    if (!alvo || !sim) return;
    var l = sim.l, m = sim.m;
    if (sim.i >= l.passos.length) {
      marcarFeito(m.id + "/" + l.id);
      var prox = proximaLicao(m, l);
      alvo.innerHTML = figura(captura(m, l, l.passos[l.passos.length - 1]), { limpa: true, alt: "Fim da lição" }) +
        '<div class="painel"><span class="rotulo-mono">Lição concluída</span><h2>Você fez todos os passos.</h2><p>Agora é com você no sistema de verdade. Se esquecer algo, volte aqui ou use a busca.</p>' +
        '<div class="acoes">' + (prox ? '<a class="botao botao-primario" href="#s.' + m.id + "." + prox.id + '">Próxima lição</a>' : "") +
        '<button class="botao botao-secundario" type="button" data-sim="reiniciar">Repetir</button></div></div>';
      desenharMenu(rotaAtual());
      return;
    }
    var p = l.passos[sim.i], cap = captura(m, l, p);
    var botaoAlvo = cap.clicar
      ? '<button class="alvo-clique" type="button" data-sim="acertou" aria-label="Clique aqui para continuar" style="left:' + pct(cap.clicar.x - 4, W) + ";top:" + pct(cap.clicar.y - 4, H) + ";width:" + pct(cap.clicar.w + 8, W) + ";height:" + pct(cap.clicar.h + 8, H) + '"></button>'
      : "";
    alvo.innerHTML = figura(cap, { limpa: true, alt: p.titulo, extra: botaoAlvo, ansioso: true }) +
      '<div class="painel" aria-live="polite"><div class="progresso" aria-hidden="true">' +
      l.passos.map(function (_, k) { return '<span class="' + (k < sim.i ? "ok" : "") + '"></span>'; }).join("") + "</div>" +
      '<span class="rotulo-mono">Passo ' + (sim.i + 1) + " de " + l.passos.length + "</span><h2>" + esc(p.titulo) + "</h2><p>" + esc(p.texto) + "</p>" +
      (cap.clicar ? '<p class="rotulo-mono" style="text-transform:none;letter-spacing:0">Clique no ponto que está piscando para continuar.</p>' : "") +
      '<p class="recado" id="recado"></p><div class="acoes">' +
      (sim.i > 0 ? '<button class="botao botao-secundario" type="button" data-sim="voltar">Voltar</button>' : "") +
      '<button class="botao ' + (cap.clicar ? "botao-secundario" : "botao-primario") + '" type="button" data-sim="avancar">' + (cap.clicar ? "Pular" : "Continuar") + "</button></div></div>";
  }
  vista.addEventListener("click", function (e) {
    var b = e.target.closest("[data-sim]");
    if (b && sim) {
      var acao = b.getAttribute("data-sim");
      if (acao === "acertou" || acao === "avancar") sim.i++;
      else if (acao === "voltar") sim.i = Math.max(0, sim.i - 1);
      else if (acao === "reiniciar") sim.i = 0;
      desenharSimulador();
      return;
    }
    var ampliar = e.target.closest(".passo .tela, .jornada-foto .tela");
    if (ampliar) {
      var dlg = document.getElementById("ampliada");
      dlg.querySelector(".ampliada-conteudo").innerHTML = ampliar.outerHTML;
      dlg.showModal();
      return;
    }
    var tela = e.target.closest("#simulador .tela");
    if (tela && sim && captura(sim.m, sim.l, sim.l.passos[sim.i] || {})?.clicar) {
      tela.classList.remove("errou"); void tela.offsetWidth; tela.classList.add("errou");
      var r = document.getElementById("recado");
      if (r) r.textContent = "Ainda não é aí. Procure o ponto piscando na tela.";
      return;
    }
    if (e.target.id === "marcar-feita") {
      var rota = rotaAtual();
      marcarFeito(rota.mod + "/" + rota.licao);
      e.target.textContent = "Concluída ✓";
      desenharMenu(rota);
    }
  });

  // ---------- busca ----------
  var indice = [];
  D.modulos.forEach(function (m) {
    m.licoes.forEach(function (l) {
      indice.push({ onde: m.titulo, titulo: l.titulo, trecho: l.objetivo, href: "#l." + m.id + "." + l.id,
        campos: [[l.titulo, 6], [l.busca.join(" "), 5], [l.objetivo, 2]] });
      l.passos.forEach(function (p) {
        var cap = captura(m, l, p);
        indice.push({ onde: m.titulo + " › " + l.titulo, titulo: p.titulo, trecho: p.texto, href: "#l." + m.id + "." + l.id + "." + p.id,
          campos: [[p.titulo, 4], [p.texto + " " + (p.dica || ""), 1], [cap ? cap.destaques.map(function (d) { return d.rotulo; }).join(" ") : "", 2]] });
      });
    });
  });
  D.menu.forEach(function (g) {
    g.itens.forEach(function (it) {
      if (!it.modulo) indice.push({ onde: g.grupo + " · em breve", titulo: it.rotulo, trecho: it.descricao, href: "#" + tokenDaTela(it.href), campos: [[it.rotulo, 5], [it.descricao, 1]] });
    });
  });
  indice = indice.concat(demos.entradasBusca());
  indice.forEach(function (d) { d.campos = d.campos.map(function (c) { return [normalizar(c[0]), c[1]]; }); });

  // Todos os termos precisam aparecer (por prefixo de palavra); o peso do campo decide a ordem.
  function buscar(consulta) {
    var termos = normalizar(consulta).split(/[^a-z0-9]+/).filter(function (t) { return t.length > 1; });
    if (!termos.length) return [];
    return indice.map(function (d) {
      var total = 0;
      for (var i = 0; i < termos.length; i++) {
        var re = new RegExp("(^|[^a-z0-9])" + termos[i]), melhor = 0;
        d.campos.forEach(function (c) { if (re.test(c[0]) && c[1] > melhor) melhor = c[1]; });
        if (!melhor) return null;
        total += melhor;
      }
      return { d: d, nota: total };
    }).filter(Boolean).sort(function (a, b) { return b.nota - a.nota; }).slice(0, 8).map(function (r) { return r.d; });
  }
  var campoBusca = document.getElementById("busca"), lista = document.getElementById("resultados"), sel = -1, achados = [];
  function mostrarResultados() {
    achados = buscar(campoBusca.value); sel = achados.length ? 0 : -1;
    if (!campoBusca.value.trim()) { lista.hidden = true; campoBusca.setAttribute("aria-expanded", "false"); return; }
    lista.innerHTML = achados.length
      ? achados.map(function (d, i) {
          return '<li role="option" aria-selected="' + (i === sel) + '"><a href="' + d.href + '"><div class="res-onde">' + esc(d.onde) + '</div><div class="res-titulo">' + esc(d.titulo) + '</div><div class="res-trecho">' + esc(d.trecho) + "</div></a></li>";
        }).join("")
      : '<li class="res-vazio">Nada encontrado para “' + esc(campoBusca.value) + "”. Tente outra palavra, como “assumir” ou “etiqueta”.</li>";
    lista.hidden = false; campoBusca.setAttribute("aria-expanded", "true");
  }
  function fecharBusca() { lista.hidden = true; campoBusca.setAttribute("aria-expanded", "false"); }
  campoBusca.addEventListener("input", mostrarResultados);
  campoBusca.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!achados.length) return;
      e.preventDefault();
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + achados.length) % achados.length;
      Array.prototype.forEach.call(lista.children, function (li, i) { li.setAttribute("aria-selected", String(i === sel)); });
    } else if (e.key === "Enter" && sel >= 0) {
      location.hash = achados[sel].href; fecharBusca(); campoBusca.blur();
    } else if (e.key === "Escape") { fecharBusca(); campoBusca.blur(); }
  });
  lista.addEventListener("click", function (e) { if (e.target.closest("a")) fecharBusca(); });
  document.addEventListener("click", function (e) { if (!e.target.closest(".busca")) fecharBusca(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && document.activeElement !== campoBusca && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
      e.preventDefault(); campoBusca.focus();
    }
  });

  // ---------- menu no celular ----------
  var menu = document.getElementById("menu"), botaoMenu = document.getElementById("botao-menu");
  botaoMenu.addEventListener("click", function () {
    var aberto = menu.classList.toggle("aberto");
    botaoMenu.setAttribute("aria-expanded", String(aberto));
  });
  menu.addEventListener("click", function (e) {
    if (e.target.closest("a")) { menu.classList.remove("aberto"); botaoMenu.setAttribute("aria-expanded", "false"); }
  });

  // ---------- rotas (#inicio, #m.inbox, #l.inbox.licao[.passo], #s.inbox.licao, #t.app~radar) ----------
  function rotaAtual() {
    var h;
    try { h = decodeURIComponent(location.hash.slice(1)); } catch { h = "acao"; }
    var demo = demos.reconhecer(h);
    if (demo) return { tipo: "demonstracao", demo: demo };
    var partes = h.split(".");
    var r = { tipo: partes[0] || "inicio", mod: partes[1], licao: partes[2], passo: partes[3] };
    if (r.tipo === "t") r.tela = "/" + h.slice(2).split("~").join("/");
    return r;
  }
  function render() {
    var r = rotaAtual(), m = modulo(r.mod), l = licaoDe(m, r.licao), html;
    sim = null;
    if (r.demo) html = demos.render(r.demo);
    else if (r.tipo === "m" && m) html = vistaModulo(m);
    else if (r.tipo === "l" && l) html = vistaLicao(m, l);
    else if (r.tipo === "s" && l) html = vistaSimulador(m, l);
    else if (r.tipo === "t") html = vistaTela(r.tela);
    else html = vistaInicio();
    vista.innerHTML = html;
    desenharMenu(r);
    demos.posRender(r.demo || null);
    if (sim) desenharSimulador();
    var foco = r.passo && document.getElementById("passo-" + r.passo);
    if (foco) foco.scrollIntoView({ block: "start" }); else window.scrollTo(0, 0);
    var t = r.demo ? demos.titulo(r.demo) : l ? l.titulo : m ? m.titulo : "";
    document.title = t ? t + " · Curso DeskComm" : "Curso DeskComm";
  }
  var ampliada = document.getElementById("ampliada");
  ampliada.addEventListener("click", function (e) { if (e.target === ampliada || e.target.closest("[data-fechar]")) ampliada.close(); });
  window.addEventListener("hashchange", function () { if (ampliada.open) ampliada.close(); render(); });
  var datasFotos = (D.datas_das_fotos || []).map(function (data) { return data.split("-").reverse().join("/"); });
  document.getElementById("rodape").innerHTML = '<div class="coluna"><span>Material atualizado em ' + esc(D.gerado.split("-").reverse().join("/")) + ". Fotos das versões " + esc(D.versao) + (datasFotos.length ? ", capturadas em " + esc(datasFotos.join(" e ")) : "") + ", numa empresa de demonstração. Os nomes e conversas são fictícios.</span></div>";
  render();
})();
