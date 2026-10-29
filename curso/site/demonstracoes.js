// Fábrica isolada: o curso continua dono da geometria, da busca e da navegação.
window.criarDemonstracoes = function (opcoes) {
  "use strict";
  var D = opcoes.dados, esc = opcoes.esc, vista = opcoes.vista;
  var nichos = D.nichos || [], atual = null;
  function reconhecer(hash) {
    var p = hash.replace(/^#/, "").split(".");
    if (["acao", "demo", "montagem"].indexOf(p[0]) < 0) return null;
    var n = nichos.find(function (n) { return n.id === p[1]; });
    var j = n && n.jornadas.find(function (j) { return j.id === p[2]; });
    if (p[0] === "acao" && p.length <= 2 && (!p[1] || n)) return { tipo: "acao", nicho: n };
    if (p[0] === "montagem" && p.length === 3 && j) return { tipo: "montagem", nicho: n, jornada: j };
    var i = j ? j.cenas.findIndex(function (c) { return c.id === p[3]; }) : -1;
    if (p[0] === "demo" && p.length === 4 && i >= 0) return { tipo: "demo", nicho: n, jornada: j, indice: i };
    return { tipo: "acao" };
  }
  function rota(n, j, i) { return "#demo." + n.id + "." + j.id + "." + j.cenas[i].id; }
  function tipo(j) { return j.tipo === "execucao-observada" ? "Execução observada" : "Roteiro demonstrativo"; }
  function trilha(n) {
    return '<nav class="trilha" aria-label="Caminho"><a href="#inicio">Curso</a><span>›</span><a href="#acao">Deskcomm em ação</a>' +
      (n ? '<span>›</span><a href="#acao.' + n.id + '">' + esc(n.titulo) + '</a>' : '') + '</nav>';
  }
  function catalogo(n) {
    return '<div class="coluna jornada-catalogo">' + trilha(n) +
      '<header class="coluna-texto"><span class="rotulo-mono">Do primeiro contato à continuidade</span><h1 class="titulo-pagina" id="demo-titulo-pagina">' + esc(n ? n.titulo : 'Deskcomm em ação') +
      '</h1><p class="subtitulo">' + esc(n ? n.resumo : 'Escolha um negócio e acompanhe uma história na tela. Depois, veja quais recursos fazem essa operação acontecer.') + '</p></header>' +
      (n ? '<div class="cartoes">' + n.jornadas.map(function (j, i) {
        return '<article class="cartao jornada-cartao"><span class="rotulo-mono">História ' + String(i + 1).padStart(2, '0') + ' · ' + tipo(j) + '</span><h2>' + esc(j.titulo) + '</h2><p>' + esc(j.contexto) + '</p><p><strong>O caminho:</strong> ' + esc(j.resultado) + '</p><div class="acoes"><a class="botao botao-primario" href="' + rota(n, j, 0) + '">Apresentar ao cliente</a><a href="#montagem.' + n.id + '.' + j.id + '">Entender a montagem</a></div></article>';
      }).join('') + '</div>' : '<div class="cartoes">' + nichos.map(function (n, i) {
        return '<a class="cartao" href="#acao.' + n.id + '"><span class="rotulo-mono">' + String(i + 1).padStart(2, '0') + ' / Negócios em ação</span><h2>' + esc(n.titulo) + '</h2><p>' + esc(n.resumo) + '</p><span class="rodape-cartao">' + n.jornadas.length + ' histórias →</span></a>';
      }).join('') + '</div>') + '</div>';
  }
  function render(r) {
    if (r.tipo === 'acao') return catalogo(r.nicho);
    var n = r.nicho, j = r.jornada;
    var cabeca = trilha(n) + '<header><span class="rotulo-mono">' + tipo(j) + ' · ' + esc(j.empresa) + '</span><h1 class="titulo-pagina" id="demo-titulo-pagina">' + esc(j.titulo) + '</h1><p class="subtitulo">' + esc(j.contexto) + '</p></header>';
    var modos = '<nav class="alternador" aria-label="Modo da história"><a href="' + rota(n, j, 0) + '"' + (r.tipo === 'demo' ? ' aria-current="page"' : '') + '>Apresentar ao cliente</a><a href="#montagem.' + n.id + '.' + j.id + '"' + (r.tipo === 'montagem' ? ' aria-current="page"' : '') + '>Entender a montagem</a></nav>';
    var nota = '<aside class="dica"><strong>' + tipo(j) + '.</strong> ' + esc(j.nota) + '</aside>';
    if (r.tipo === 'montagem') {
      return '<div class="coluna">' + cabeca + modos + nota + '<section class="jornada-requisitos"><h2>Antes de começar</h2><p class="texto">' + esc(j.dependencias) + '</p></section><section><h2>Aprenda a montar</h2><div class="cartoes">' + j.montagem.map(function (ref, i) {
        var m = D.modulos.find(function (m) { return m.id === ref.modulo; });
        var l = m.licoes.find(function (l) { return l.id === ref.licao; });
        return '<a class="cartao" href="#l.' + ref.modulo + '.' + ref.licao + '"><span class="rotulo-mono">' + (i + 1) + ' / ' + esc(m.titulo) + '</span><h3>' + esc(l.titulo) + '</h3><p>' + esc(ref.porque) + '</p><span>Ver lição →</span></a>';
      }).join('') + '</div></section><p class="texto"><strong>Ao final da história:</strong> ' + esc(j.resultado) + '</p></div>';
    }
    var i = r.indice, c = j.cenas[i], cap = D.capturas[c.captura];
    return '<div class="coluna jornada-apresentacao" id="jornada-apresentacao">' + cabeca + modos +
      '<div class="acoes jornada-ferramentas"><button class="botao botao-secundario" type="button" data-demo="tela">Tela cheia</button><button class="botao botao-secundario" type="button" data-demo="copiar">Copiar link desta cena</button><a href="#acao.' + n.id + '">Sair da apresentação</a><span role="status" id="demo-recado"></span></div>' +
      '<ol class="jornada-tempo" aria-label="Cenas da história">' + j.cenas.map(function (c, k) {
        return '<li><a href="' + rota(n, j, k) + '"' + (k === i ? ' aria-current="step"' : '') + '><span>' + String(k + 1).padStart(2, '0') + '</span>' + esc(c.titulo) + '</a></li>';
      }).join('') + '</ol><section class="jornada-cena"><div class="jornada-narrativa"><span class="rotulo-mono">Cena ' + (i + 1) + ' de ' + j.cenas.length + '</span><h2 id="demo-titulo-cena"><span class="visualmente-oculto">Cena ' + (i + 1) + ' de ' + j.cenas.length + ': </span>' + esc(c.titulo) + '</h2>' +
      [['O cliente', c.cliente], ['Na operação', c.operacao], ['Por que ajuda', c.valor]].map(function (p) { return '<div class="jornada-voz"><h3>' + p[0] + '</h3><p>' + esc(p[1]) + '</p></div>'; }).join('') + '</div><div class="jornada-foto">' + opcoes.figura(cap, { alt: c.titulo, ansioso: true }) + opcoes.legenda(cap) + '</div></section>' +
      '<nav class="acoes jornada-avancos" aria-label="Avançar pela história">' + (i ? '<a class="botao botao-secundario" data-demo-anterior href="' + rota(n, j, i - 1) + '">← Anterior</a>' : '<span>Início da história</span>') +
      (i < j.cenas.length - 1 ? '<a class="botao botao-primario" data-demo-proximo href="' + rota(n, j, i + 1) + '">Próxima cena →</a>' : '<a class="botao botao-primario" href="#montagem.' + n.id + '.' + j.id + '">Entender a montagem →</a>') + '</nav>' + nota + '</div>';
  }
  function sairTela() {
    document.body.classList.remove('demo-tela-cheia');
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {});
  }
  function posRender(r) {
    var anterior = atual;
    atual = r;
    // O main é o contêiner rolável no fullscreen nativo e um destino estável
    // de foco. Seu nome acessível identifica a nova cena, mesmo na mesma história.
    if (r) vista.setAttribute('aria-labelledby', r.tipo === 'demo' ? 'demo-titulo-cena' : 'demo-titulo-pagina');
    else vista.removeAttribute('aria-labelledby');
    if (r || anterior) {
      vista.focus({ preventScroll: true });
      vista.scrollTop = 0;
      vista.scrollLeft = 0;
    }
    if (!r || r.tipo !== 'demo') sairTela();
    else if (document.body.classList.contains('demo-tela-cheia')) {
      var b = vista.querySelector('[data-demo="tela"]');
      if (b) b.textContent = 'Sair da tela cheia';
    }
  }
  vista.addEventListener('click', async function (e) {
    var b = e.target.closest('[data-demo]');
    if (!b) return;
    var recado = document.getElementById('demo-recado');
    if (b.dataset.demo === 'copiar') {
      try {
        await navigator.clipboard.writeText(location.href);
        if (recado && recado.isConnected) recado.textContent = 'Link copiado.';
      } catch {
        if (recado && recado.isConnected) recado.textContent = 'Não foi possível copiar. Copie o endereço na barra do navegador.';
      }
    } else {
      if (document.fullscreenElement || document.body.classList.contains('demo-tela-cheia')) { sairTela(); b.textContent = 'Tela cheia'; return; }
      document.body.classList.add('demo-tela-cheia');
      b.textContent = 'Sair da tela cheia';
      try { if (vista.requestFullscreen) await vista.requestFullscreen(); } catch { /* o layout ampliado funciona mesmo sem permissão do navegador */ }
    }
  });
  document.addEventListener('fullscreenchange', function () {
    if (!document.fullscreenElement) {
      document.body.classList.remove('demo-tela-cheia');
      var b = vista.querySelector('[data-demo="tela"]');
      if (b) b.textContent = 'Tela cheia';
    }
  });
  document.addEventListener('keydown', function (e) {
    if (!atual || atual.tipo !== 'demo' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.target.closest('input,textarea,select,[contenteditable="true"],dialog[open]')) return;
    if (e.key === 'Escape') { sairTela(); var b = vista.querySelector('[data-demo="tela"]'); if (b) b.textContent = 'Tela cheia'; return; }
    var link = vista.querySelector(e.key === 'ArrowRight' ? '[data-demo-proximo]' : e.key === 'ArrowLeft' ? '[data-demo-anterior]' : 'nenhum-elemento');
    if (link) { e.preventDefault(); location.hash = link.hash; }
  });
  function entradasBusca() {
    var entradas = [];
    nichos.forEach(function (n) {
      entradas.push({ onde: 'Deskcomm em ação', titulo: n.titulo, trecho: n.resumo, href: '#acao.' + n.id, campos: [[n.titulo, 6], [n.resumo, 2]] });
      n.jornadas.forEach(function (j) {
        entradas.push({ onde: 'Deskcomm em ação › ' + n.titulo, titulo: j.titulo, trecho: j.contexto, href: rota(n, j, 0), campos: [[j.titulo, 6], [n.titulo, 5], [j.contexto + ' ' + j.resultado, 2]] });
      });
    });
    return entradas;
  }
  return { reconhecer: reconhecer, render: render, posRender: posRender, entradasBusca: entradasBusca,
    titulo: function (r) { return r.tipo === 'demo' ? 'Cena ' + (r.indice + 1) + ' de ' + r.jornada.cenas.length + ': ' + r.jornada.cenas[r.indice].titulo + ' · ' + r.jornada.titulo : r.jornada ? r.jornada.titulo : r.nicho ? r.nicho.titulo : 'Deskcomm em ação'; } };
};
