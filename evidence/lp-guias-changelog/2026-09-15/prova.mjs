// Rode da raiz do repositório: o @playwright/test vem do node_modules do projeto.
import { chromium } from "@playwright/test";
const BASE = process.env.BASE || "http://localhost:3217";
const OUT = process.env.OUT;
const achados = []; const ok = [];
const falha = (m) => { achados.push(m); console.log("  ✗ " + m); };
const passa = (m) => { ok.push(m); console.log("  ✓ " + m); };
const checa = (cond, m) => (cond ? passa(m) : falha(m));
const IDIOMAS = [
  { id: "pt-BR", home: "/", guias: "/guias", changelog: "/changelog", guiasLabel: "Guias para devs", curto: "Guias" },
  { id: "en", home: "/en", guias: "/en/guides", changelog: "/en/changelog", guiasLabel: "Dev guides", curto: "Guides" },
  { id: "es", home: "/es", guias: "/es/guias", changelog: "/es/changelog", guiasLabel: "Guías para devs", curto: "Guías" },
];
const LARGURAS = [360, 390, 640, 768, 900, 1024, 1100, 1180, 1280, 1440];

async function vazamentos(page, rotulo) {
  const r = await page.evaluate(() => {
    const txt = document.body.innerText;
    const padroes = [/\bundefined\b/, /\bNaN\b/, /\[object Object\]/, /\{v\}|\{d\}|\{n\}/, /\bnull\b(?![-_])/];
    const achou = padroes.filter((p) => p.test(txt)).map(String);
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    // Duas origens: caixa que passa da tela, e TEXTO que transborda a própria caixa (a caixa não cresce).
    const nome = (e) => e.tagName + "." + String(e.className?.baseVal ?? e.className).slice(0, 60);
    const dentroDeRolagem = (e) => { for (let x = e.parentElement; x; x = x.parentElement) if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(x).overflowX)) return true; return false; };
    const largos = overflow > 0 ? [
      ...[...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(e).position !== "fixed" && !dentroDeRolagem(e)).map((e) => "caixa " + nome(e)),
      ...[...document.querySelectorAll("body *")].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === "visible" && e.getBoundingClientRect().left + e.scrollWidth > window.innerWidth + 1).map((e) => "texto " + nome(e) + " \"" + e.textContent.slice(0, 20) + "\""),
    ].slice(0, 6) : [];
    return { achou, overflow, largos };
  });
  checa(r.achou.length === 0, `${rotulo}: sem vazamento de string (${r.achou.join(",") || "nenhum"})`);
  checa(r.overflow <= 0, `${rotulo}: sem rolagem horizontal (excesso ${r.overflow}px ${r.largos.join(" | ")})`);
}

(async () => {
  // A régua vem da FONTE, não de um número escrito à mão: releases novas mudam a contagem.
  const md = await (await fetch("https://raw.githubusercontent.com/melgarafael/DeskcommCRM/main/CHANGELOG.md")).text();
  const VERSOES = [...md.matchAll(/^## \[(\d+\.\d+\.\d+)\] \u2014 \d{4}-\d{2}-\d{2}$/gm)].map((m) => m[1]);
  const N = VERSOES.length, ULTIMA = VERSOES[0], PENULTIMA = VERSOES[1];
  console.log(`régua: ${N} versões no CHANGELOG, mais nova v${ULTIMA}`);
  const browser = await chromium.launch();
  const erros = [];
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], ...(process.env.BYPASS ? { extraHTTPHeaders: { "x-vercel-protection-bypass": process.env.BYPASS, "x-vercel-set-bypass-cookie": "true" } } : {}) });
  const nova = async (w) => {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: w, height: 900 });
    p.on("console", (m) => { if (m.type() === "error" || /hydrat/i.test(m.text())) erros.push(`${p.url()} console: ${m.text().slice(0, 200)}`); });
    p.on("pageerror", (e) => erros.push(`${p.url()} pageerror: ${e.message}`));
    p.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("translate.goog")) erros.push(`${r.status()} ${r.url()}`); });
    return p;
  };

  // 1. Cabeçalho da home em todas as larguras e idiomas
  for (const L of IDIOMAS) {
    console.log(`\n== cabeçalho ${L.id}`);
    for (const w of LARGURAS) {
      const p = await nova(w);
      await p.goto(BASE + L.home, { waitUntil: "networkidle" });
      const m = await p.evaluate(() => {
        const h = document.querySelector("header");
        const hb = h.getBoundingClientRect();
        const botao = [...h.querySelectorAll("a")].find((a) => a.getAttribute("href")?.match(/\/(guias|en\/guides|es\/guias)$/));
        const bb = botao.getBoundingClientRect();
        const cx = bb.left + bb.width / 2, cy = bb.top + bb.height / 2;
        const topo = document.elementFromPoint(cx, cy);
        const visivelTexto = [...botao.querySelectorAll("span")].filter((s) => getComputedStyle(s).display !== "none").map((s) => s.textContent);
        const filhos = [...h.querySelectorAll("a, nav, button")].filter((e) => getComputedStyle(e).display !== "none").map((e) => e.getBoundingClientRect());
        const maisAlto = Math.max(...filhos.map((r) => r.height));
        const foraDaTela = filhos.filter((r) => r.right > window.innerWidth + 0.5 || r.left < -0.5).length;
        const nav = h.querySelector("nav:not([aria-label])");
        const navLinhas = nav && getComputedStyle(nav).display !== "none" ? [...nav.querySelectorAll("a")].map((a) => a.getBoundingClientRect().height) : [];
        return { alturaHeader: hb.height, botao: { w: bb.width, h: bb.height, right: bb.right }, clicavel: botao.contains(topo), visivelTexto, ariaLabel: botao.getAttribute("aria-label"), maisAlto, foraDaTela, navLinhas };
      });
      const r = `${L.id} ${w}px`;
      checa(m.alturaHeader === 57, `${r}: cabeçalho com 56px + 1px de borda, como o original (${m.alturaHeader})`);
      checa(m.botao.w > 0 && m.clicavel, `${r}: botão dos guias visível e clicável (${Math.round(m.botao.w)}x${m.botao.h})`);
      checa(m.foraDaTela === 0, `${r}: nada do cabeçalho fora da tela`);
      checa(m.maisAlto <= 40, `${r}: nenhum item do cabeçalho quebra linha (mais alto ${m.maisAlto}px)`);
      checa(m.navLinhas.every((x) => x <= 24), `${r}: links da nav em uma linha (${m.navLinhas.join(",") || "nav oculta"})`);
      const esperado = w >= 1280 ? [L.guiasLabel] : w >= 640 ? [L.curto] : [];
      checa(JSON.stringify(m.visivelTexto) === JSON.stringify(esperado), `${r}: rótulo do botão ${JSON.stringify(m.visivelTexto)} (esperado ${JSON.stringify(esperado)}), aria-label "${m.ariaLabel}"`);
      if ([360, 900, 1280].includes(w)) await p.screenshot({ path: `${OUT}/home-cabecalho-${L.id}-${w}.png`, clip: { x: 0, y: 0, width: w, height: 56 } });
      await vazamentos(p, `home ${r}`);
      await p.close();
    }
  }

  // 2. Jornada: da home para os guias, pelo botão
  for (const L of IDIOMAS) {
    console.log(`\n== jornada guias ${L.id}`);
    for (const w of [360, 1280]) {
      const p = await nova(w);
      await p.goto(BASE + L.home, { waitUntil: "networkidle" });
      await p.locator("header").getByRole("link", { name: L.guiasLabel }).click(); // nome acessível = aria-label, em qualquer largura
      await p.waitForURL(BASE + L.guias);
      checa(p.url() === BASE + L.guias, `${L.id} ${w}px: botão do cabeçalho leva a ${L.guias}`);
      const lang = await p.getAttribute("html", "lang");
      checa(lang === L.id, `${L.id}: html lang=${lang}`);
      const canonical = await p.getAttribute('link[rel="canonical"]', "href");
      checa(canonical?.endsWith(L.guias), `${L.id}: canonical da página é ela mesma (${canonical})`);
      const fontes = await p.evaluate(async () => { await document.fonts.ready; return { h1: getComputedStyle(document.querySelector("h1")).fontFamily, mono: getComputedStyle(document.querySelector("pre")).fontFamily, carregadas: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family) }; });
      checa(/atkinson/i.test(fontes.h1) && fontes.carregadas.some((f) => /atkinson/i.test(f)), `${L.id}: título na Atkinson Hyperlegible, carregada`);
      checa(/plex/i.test(fontes.mono) && fontes.carregadas.some((f) => /plex/i.test(f)), `${L.id}: comandos na IBM Plex Mono, carregada`);
      await p.screenshot({ path: `${OUT}/guias-${L.id}-${w}.png`, fullPage: true });
      await vazamentos(p, `guias ${L.id} ${w}px`);

      // filtro de público
      const cartoes = p.locator("#guias article");
      checa((await cartoes.count()) === 6, `${L.id}: seis cartões de guia`);
      const botoesFiltro = p.locator("#guias [role=group] button");
      await botoesFiltro.nth(2).click();
      const visiveis = await p.locator("#guias article:visible").count();
      checa(visiveis === 2, `${L.id} ${w}px: filtro "para quem programa" mostra 2 guias (${visiveis})`);
      await botoesFiltro.nth(1).click();
      checa((await p.locator("#guias article:visible").count()) === 4, `${L.id} ${w}px: filtro "quem usa o CRM" mostra 4 guias`);
      await botoesFiltro.nth(0).click();

      // abas
      const abas = p.locator("[role=tab]");
      checa((await abas.count()) === 5, `${L.id}: cinco abas de assistente`);
      await abas.nth(1).scrollIntoViewIfNeeded();
      await abas.nth(1).click();
      checa(await p.locator("#painel-codex").isVisible(), `${L.id} ${w}px: aba Codex abre o painel do Codex`);
      checa(await p.locator("#painel-codex").getByText("$deskcomm-prompt").isVisible(), `${L.id}: painel do Codex mostra $deskcomm-prompt`);
      await p.keyboard.press("ArrowRight");
      checa(await p.locator("#painel-cursor").isVisible(), `${L.id}: seta para a direita vai para a aba Cursor`);
      await p.keyboard.press("End");
      checa(await p.locator("#painel-opencode").isVisible(), `${L.id}: End vai para a última aba`);
      const abaVisivel = await p.evaluate(() => { const t = document.querySelector("[role=tab][aria-selected=true]").getBoundingClientRect(); return t.right <= window.innerWidth + 1 && t.left >= -1; });
      checa(abaVisivel, `${L.id} ${w}px: aba selecionada visível na faixa de abas`);

      // copiar o comando de instalação
      const botaoCopiar = p.locator("#instalar button").first();
      await botaoCopiar.scrollIntoViewIfNeeded();
      await botaoCopiar.click();
      const area = await p.evaluate(() => navigator.clipboard.readText());
      checa(area === "curl -fsSL https://raw.githubusercontent.com/melgarafael/DeskcommCRM/main/scripts/instalar-guias.sh | bash", `${L.id} ${w}px: copiar põe o comando exato na área de transferência`);
      await p.screenshot({ path: `${OUT}/guias-instalar-${L.id}-${w}.png` });

      // FAQ abre
      const faq = p.locator("details").first();
      await faq.locator("summary").click();
      checa(await faq.evaluate((d) => d.open), `${L.id}: pergunta do FAQ abre`);

      // seletor de idioma leva à MESMA página (só visível >= 768)
      if (w >= 768) {
        const outro = IDIOMAS.find((x) => x.id !== L.id);
        // Pelo hreflang, não pelo aria-label da nav: o rótulo é traduzido em cada idioma.
        await p.locator('header a[hreflang="' + outro.id + '"]').click();
        await p.waitForURL(BASE + outro.guias);
        checa(p.url() === BASE + outro.guias, `${L.id}: seletor de idioma leva a ${outro.guias}`);
        await p.goBack();
      }
      // âncora "Instalar" do cabeçalho vai à home
      const cta = await p.locator("header a.bg-accent-600").getAttribute("href");
      checa(cta === `${L.home === "/" ? "" : L.home}#instalar` || cta === `${L.home}#instalar`, `${L.id}: CTA do cabeçalho fora da home aponta para ${cta}`);
      await p.close();
    }
  }

  // 3. Changelog
  for (const L of IDIOMAS) {
    console.log(`\n== changelog ${L.id}`);
    for (const w of [360, 768, 1280]) {
      const p = await nova(w);
      await p.goto(BASE + L.home, { waitUntil: "domcontentloaded" });
      await p.locator("footer").getByRole("link", { name: "Changelog" }).click();
      await p.waitForURL(BASE + L.changelog);
      checa(p.url() === BASE + L.changelog, `${L.id} ${w}px: link do rodapé leva a ${L.changelog}`);
      await p.screenshot({ path: `${OUT}/changelog-${L.id}-${w}.png`, fullPage: false });
      await vazamentos(p, `changelog ${L.id} ${w}px`);
      const cards = p.locator("ol > li > a[href*='/changelog/']");
      const total = await cards.count();
      checa(total === N, `${L.id}: ${N} versões listadas (${total})`);
      const busca = p.locator("input[type=search]");
      await busca.fill("whatsapp");
      const comBusca = await cards.count();
      checa(comBusca > 0 && comBusca < N, `${L.id} ${w}px: busca "whatsapp" filtra (${comBusca})`);
      await busca.fill("instalacao");
      const semAcento = await cards.count();
      checa(semAcento > 0, `${L.id}: busca sem acento acha "instalação" (${semAcento})`);
      await busca.fill("zzzz-nao-existe");
      checa((await cards.count()) === 0, `${L.id}: busca sem resultado esvazia`);
      const limpar = p.getByRole("button", { name: { "pt-BR": "Limpar filtros", en: "Clear filters", es: "Limpiar filtros" }[L.id] });
      checa(await limpar.isVisible(), `${L.id}: "limpar filtros" aparece no vazio`);
      await limpar.click();
      checa((await cards.count()) === N, `${L.id}: limpar volta às ${N}`);
      const filtroAtencao = p.locator("[role=group] button").nth(1);
      await filtroAtencao.click();
      const atencao = await cards.count();
      checa(atencao >= 1 && atencao < N, `${L.id} ${w}px: filtro "requer atenção" (${atencao} versões)`);
      await filtroAtencao.click();
      // filtro sticky não cobre o conteúdo nem sai da tela
      const sticky = await p.evaluate(() => { const s = document.querySelector("input[type=search]").closest(".sticky").getBoundingClientRect(); return { w: s.width, right: s.right, h: s.height }; });
      checa(sticky.right <= w + 1, `${L.id} ${w}px: barra de filtros cabe na largura (altura ${Math.round(sticky.h)}px)`);
      // hero: abrir a mais recente
      await p.locator("main section a").first().click();
      // Predicado sobre o caminho, e não RegExp montada com a versão: nada a escapar.
      await p.waitForURL((u) => u.pathname.endsWith(`/changelog/${ULTIMA}`), { waitUntil: "load" });
      checa(p.url().endsWith(`/changelog/${ULTIMA}`), `${L.id} ${w}px: cartão da mais recente abre a v${ULTIMA}`);
      await vazamentos(p, `versão ${ULTIMA} ${L.id} ${w}px`);
      const artigoLang = await p.getAttribute("article", "lang");
      checa(artigoLang === "pt-BR", `${L.id}: texto da versão marcado lang=pt-BR`);
      if (L.id !== "pt-BR") {
        const traduzir = p.locator("a[href*='translate.goog']");
        checa(await traduzir.isVisible(), `${L.id}: aviso de idioma com link de tradução visível`);
        const href = await traduzir.getAttribute("href");
        checa(href.includes(`/changelog/${ULTIMA}`) && href.includes(`_x_tr_tl=${L.id}`), `${L.id}: link de tradução aponta para esta versão (${href})`);
      }
      await p.screenshot({ path: `${OUT}/versao-${ULTIMA}-${L.id}-${w}.png`, fullPage: false });
      const anterior = p.locator("article nav a").first();
      await anterior.scrollIntoViewIfNeeded();
      await anterior.click();
      await p.waitForURL((u) => u.pathname.endsWith(`/changelog/${PENULTIMA}`), { waitUntil: "load" });
      checa(p.url().endsWith(`/changelog/${PENULTIMA}`), `${L.id} ${w}px: "versão anterior" leva à v${PENULTIMA}`);
      await p.close();
    }
  }

  // 4. Versões manuais com formatos irregulares
  for (const [v, oq] of [["1.0.0", "seções por domínio"], ["1.3.0", "citação e código"], ["1.6.0", "Corrigido repetido"], ["1.2.1", "introdução"]]) {
    const p = await nova(1280);
    await p.goto(`${BASE}/changelog/${v}`, { waitUntil: "networkidle" });
    const m = await p.evaluate(() => ({ secoes: [...document.querySelectorAll("article section[id]")].map((s) => s.id), ids: [...document.querySelectorAll("[id]")].map((e) => e.id), blockquote: document.querySelectorAll("article blockquote").length, pre: document.querySelectorAll("article pre").length, asteriscos: /\*\*/.test(document.querySelector("article").innerText), intro: !!document.querySelector("article > section[aria-label]") }));
    const dup = m.ids.filter((x, i) => m.ids.indexOf(x) !== i);
    checa(dup.length === 0, `v${v} (${oq}): ids únicos (${dup.slice(0, 3).join(",") || "ok"})`);
    checa(!m.asteriscos, `v${v}: nenhum ** cru sobrando no texto`);
    if (v === "1.3.0") checa(m.blockquote > 0 && m.pre > 0, `v1.3.0: citação (${m.blockquote}) e bloco de código (${m.pre}) renderizados`);
    if (v === "1.2.1") checa(m.intro, "v1.2.1: introdução antes das seções aparece");
    if (v === "1.0.0") checa(m.secoes.length >= 9, `v1.0.0: seções por domínio (${m.secoes.length})`);
    await p.screenshot({ path: `${OUT}/versao-${v}.png`, fullPage: false });
    await vazamentos(p, `v${v}`);
    await p.close();
  }

  // 5. Âncora de volta para a home a partir de /changelog
  {
    const p = await nova(1280);
    await p.goto(`${BASE}/changelog`, { waitUntil: "domcontentloaded" });
    await p.locator("header nav:not([aria-label]) a").nth(2).click();
    await p.waitForURL(`${BASE}/#instalar`);
    const y = await p.evaluate(() => document.getElementById("instalar").getBoundingClientRect().top);
    checa(p.url() === `${BASE}/#instalar` && Math.abs(y) < 120, `âncora "Instalar" de /changelog chega à seção na home (topo ${Math.round(y)}px)`);
    await p.close();
  }

  await browser.close();
  console.log(`\n== erros de console/rede: ${erros.length}`);
  [...new Set(erros)].slice(0, 30).forEach((e) => console.log("  ! " + e));
  console.log(`\nRESULTADO: ${ok.length} verdes, ${achados.length} vermelhos`);
  process.exit(achados.length || erros.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
