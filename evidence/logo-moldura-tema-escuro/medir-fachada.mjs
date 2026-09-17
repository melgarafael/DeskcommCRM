/**
 * Mede a moldura do logo na FACHADA (`app/(public)/layout.tsx`) — a superfície 2
 * do PR #659 — contra o `next start` de produção já buildado.
 *
 * Por que este script existe ao lado da spec: o daemon do Docker desta máquina
 * travou (o socket ACEITA conexão e nunca responde), então Supabase local está
 * fora e a spec Playwright não carrega — o `loadCreds()` dela semeia pelo banco.
 * A fachada, porém, não precisa de banco: `marcaDaInstalacao()` devolve `null`
 * quando a consulta falha (ela não lança), e a resolução cai na camada do
 * AMBIENTE — que é a semente `APP_LOGO_URL` documentada em CLAUDE.md, não um
 * atalho de teste. O caminho de produto exercitado é o mesmo; o que muda é a
 * camada que ganhou a resolução.
 *
 * Tudo aqui é medido por ferramenta: `getComputedStyle` e `getBoundingClientRect`.
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3007";
const ROTULO = process.argv[3] ?? "com-logo";
const EVID = "/Users/rafaelmelgaco/wt/qa-logo/evidence/logo-moldura-tema-escuro";
mkdirSync(EVID, { recursive: true });

const px = (s) => Number.parseFloat(s) || 0;

function canais(cor) {
  const m = String(cor).match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/);
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
}
const fundoEClaro = (c) => {
  const k = canais(c);
  return !!k && k.a >= 0.9 && k.r >= 200 && k.g >= 200 && k.b >= 200;
};
const fundoETransparente = (c) => {
  const k = canais(c);
  return !!k && k.a === 0;
};

const resultados = {};

const navegador = await chromium.launch();
try {
  for (const tema of ["dark", "light"]) {
    const ctx = await navegador.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    // O que o navegador de quem escolheu escuro e saiu da conta já faz sozinho:
    // `THEME_INIT_SCRIPT` (app/layout.tsx) lê esta chave no <head>.
    await p.addInitScript((t) => window.localStorage.setItem("deskcomm-theme", t), tema);
    await p.goto(`${BASE}/login`, { waitUntil: "networkidle" });

    const temaReal = await p.evaluate(() => document.documentElement.getAttribute("data-theme"));

    // A âncora: qual ramo a fachada desenhou.
    const temImgEnviada = (await p.getByTestId("logo-da-fachada").count()) > 0;
    const temMarcaDoProduto =
      (await p.getByRole("img", { name: "DeskcommCRM" }).count()) > 0 && !temImgEnviada;

    let medida = null;
    if (temImgEnviada) {
      const alvo = p.getByTestId("logo-da-fachada");
      await alvo.waitFor({ state: "visible", timeout: 15000 });
      medida = await alvo.evaluate((el) => {
        const pai = el.parentElement;
        const cs = getComputedStyle(pai);
        const rp = pai.getBoundingClientRect();
        const rl = el.getBoundingClientRect();
        return {
          tagDoPai: pai.tagName.toLowerCase(),
          classeDoPai: pai.className,
          fundo: cs.backgroundColor,
          padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft],
          sombra: cs.boxShadow,
          raio: cs.borderRadius,
          caixaDoPai: { x: rp.x, y: rp.y, largura: rp.width, altura: rp.height },
          caixaDoLogo: { x: rl.x, y: rl.y, largura: rl.width, altura: rl.height },
          naturalWidth: el.naturalWidth,
        };
      });
      medida.padding = medida.padding.map(px);
    } else if (temMarcaDoProduto) {
      // A marca do PRODUTO: a negação é sobre TODA a cadeia até o <body>, não só
      // o pai — uma moldura em qualquer avô pintaria igual na tela.
      const alvo = p.getByRole("img", { name: "DeskcommCRM" }).first();
      await alvo.waitFor({ state: "visible", timeout: 15000 });
      medida = await alvo.evaluate((el) => {
        const cadeia = [];
        let no = el;
        while (no && no.tagName.toLowerCase() !== "body") {
          const cs = getComputedStyle(no);
          cadeia.push({
            tag: no.tagName.toLowerCase(),
            classe: typeof no.className === "string" ? no.className : "",
            fundo: cs.backgroundColor,
            padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
          });
          no = no.parentElement;
        }
        const r = el.getBoundingClientRect();
        return { cadeia, caixa: { x: r.x, y: r.y, largura: r.width, altura: r.height } };
      });
    }

    // A geometria do CARTÃO de acesso — a régua de "não quebrou o que já existia"
    // nesta superfície: o cartão não pode se mover para quem não enviou logo.
    const cartao = await p
      .locator("form")
      .first()
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, largura: r.width, altura: r.height };
      });

    const nome = `fachada-${ROTULO}-${tema}`;
    await p.screenshot({ path: join(EVID, `${nome}.png`), fullPage: true });
    resultados[tema] = { temaReal, temImgEnviada, temMarcaDoProduto, medida, cartao };
    await ctx.close();
  }
} finally {
  await navegador.close();
}

writeFileSync(
  join(EVID, `fachada-${ROTULO}.json`),
  JSON.stringify(resultados, null, 2) + "\n",
  "utf8",
);

// ── O veredito, com o número ao lado ────────────────────────────────────────
const linhas = [];
let falhas = 0;
const afirmar = (ok, texto) => {
  if (!ok) falhas++;
  linhas.push(`${ok ? "VERDE " : "VERMELHO"}  ${texto}`);
};

for (const tema of ["dark", "light"]) {
  const r = resultados[tema];
  afirmar(r.temaReal === tema, `<html data-theme> = ${r.temaReal} (pedido: ${tema})`);
  if (ROTULO === "com-logo") {
    afirmar(r.temImgEnviada, `${tema}: a fachada desenhou o logo ENVIADO`);
    const m = r.medida;
    if (!m) continue;
    afirmar(m.naturalWidth > 0, `${tema}: o bitmap baixou (naturalWidth=${m.naturalWidth})`);
    if (tema === "dark") {
      afirmar(fundoEClaro(m.fundo), `dark: moldura pintada — background-color=${m.fundo}`);
      afirmar(
        m.padding.every((v) => v > 0),
        `dark: moldura com folga — padding=[${m.padding}]`,
      );
      afirmar(m.sombra !== "none", `dark: moldura com sombra — box-shadow=${m.sombra.slice(0, 60)}`);
      afirmar(
        m.caixaDoPai.largura > m.caixaDoLogo.largura &&
          m.caixaDoPai.altura > m.caixaDoLogo.altura &&
          m.caixaDoPai.x <= m.caixaDoLogo.x &&
          m.caixaDoPai.y <= m.caixaDoLogo.y,
        `dark: a moldura CONTÉM o logo — moldura=${JSON.stringify(m.caixaDoPai)} logo=${JSON.stringify(m.caixaDoLogo)}`,
      );
    } else {
      afirmar(fundoETransparente(m.fundo), `light: SEM moldura — background-color=${m.fundo}`);
      afirmar(
        m.padding.every((v) => v === 0),
        `light: SEM folga — padding=[${m.padding}]`,
      );
      afirmar(m.sombra === "none", `light: SEM sombra — box-shadow=${m.sombra}`);
    }
  } else {
    afirmar(r.temMarcaDoProduto, `${tema}: a fachada desenhou a marca do PRODUTO (svg inline)`);
    afirmar(!r.temImgEnviada, `${tema}: nenhuma <img> enviada na fachada`);
    // ⚠️ SÓ NO ESCURO, e a primeira versão deste script errou aqui: no tema
    // CLARO o fundo da própria página (`bg-background`) é `rgb(250,249,246)`, que
    // é claro por definição — a sonda acusava a página de ser a moldura. A régua
    // "nenhum ancestral claro" só separa moldura de não-moldura contra um fundo
    // escuro; no claro ela não mede nada.
    if (tema === "dark") {
      const comMoldura = (r.medida?.cadeia ?? []).filter((n) => fundoEClaro(n.fundo));
      afirmar(
        comMoldura.length === 0,
        `dark: NENHUM ancestral da marca do produto tem fundo claro — ${JSON.stringify(comMoldura)}`,
      );
    }
  }
}

// ── A regressão, e ela só vale para quem NÃO enviou logo ────────────────────
//
// ⚠️ Esta asserção estava mal escopada na primeira versão deste script, e o
// vermelho que ela deu era MEU, não do produto: com logo enviado, a moldura
// acrescenta `dark:py-2` (8px em cima e 8px embaixo) à caixa do logo, o bloco de
// acesso é centrado verticalmente, e o cartão desce 8px no tema escuro. Isso é
// a TROCA que o #659 declara e que o dono aceitou ("moldura desnecessária" é
// melhor que "logo invisível") — não é regressão, é o preço, e medi-lo é o que
// permite discuti-lo.
//
// A condição do dono — "não quebra o visual que já existe" — é sobre quem NUNCA
// enviou logo. Para esses, o deslocamento tem de ser ZERO, e é só aí que a
// igualdade é exigida.
const deslocamento = {
  dx: resultados.dark.cartao.x - resultados.light.cartao.x,
  dy: resultados.dark.cartao.y - resultados.light.cartao.y,
  dLargura: resultados.dark.cartao.largura - resultados.light.cartao.largura,
  dAltura: resultados.dark.cartao.altura - resultados.light.cartao.altura,
};
if (ROTULO === "sem-logo") {
  // A marca do PRODUTO ocupa o MESMO retângulo nos dois temas. É a régua que
  // funciona nos dois (ao contrário de "nenhum ancestral claro"): se o chip do
  // #659 tivesse vazado para este ramo, o `dark:py-*` moveria a marca no escuro
  // e só no escuro.
  const c = resultados.dark.medida?.caixa;
  const d = resultados.light.medida?.caixa;
  afirmar(
    !!c && !!d && JSON.stringify(c) === JSON.stringify(d),
    `a marca do PRODUTO ocupa o mesmo retângulo nos dois temas — dark=${JSON.stringify(c)} light=${JSON.stringify(d)}`,
  );
  afirmar(
    deslocamento.dx === 0 &&
      deslocamento.dy === 0 &&
      deslocamento.dLargura === 0 &&
      deslocamento.dAltura === 0,
    `SEM logo enviado, o cartão de acesso NÃO se move entre os temas — deslocamento=${JSON.stringify(deslocamento)}`,
  );
} else {
  linhas.push(
    `MEDIDO   com logo enviado, o cartão desce no escuro (o preço declarado do #659) — deslocamento=${JSON.stringify(deslocamento)}`,
  );
}
resultados.deslocamentoDoCartao = deslocamento;
writeFileSync(
  join(EVID, `fachada-${ROTULO}.json`),
  JSON.stringify(resultados, null, 2) + "\n",
  "utf8",
);

console.log(`\n── FACHADA (${ROTULO}) ──`);
for (const l of linhas) console.log(l);
console.log(`\nfalhas=${falhas}`);
process.exit(falhas === 0 ? 0 : 1);
