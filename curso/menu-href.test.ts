// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInContext } from "node:vm";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

const pagina = readFileSync("curso/site/pagina.html", "utf8");
const app = readFileSync("curso/site/app.js", "utf8");
const demonstracoes = readFileSync("curso/site/demonstracoes.js", "utf8");
const janelas: JSDOM[] = [];

interface Opcoes {
  moduloId?: string;
  licaoId?: string;
  telaSemModulo?: string;
}

/**
 * Exercita o script real depois de ele ler o JSON do DOM. Os ids adversariais
 * são fixtures posteriores ao gerador, não conteúdo publicável pelo schema.
 * outside-only não carrega recursos nem executa atributos de evento.
 */
function abrirMenu(opcoes: Opcoes = {}) {
  const moduloId = opcoes.moduloId ?? "inbox";
  const licaoId = opcoes.licaoId ?? "conhecendo-a-tela";
  const telaSemModulo = opcoes.telaSemModulo ?? "/app/radar";
  const dom = new JSDOM(pagina, {
    url: `https://curso.example.invalid/#m.${encodeURIComponent(moduloId)}`,
    runScripts: "outside-only",
  });
  janelas.push(dom);
  const { window } = dom;
  window.scrollTo = () => undefined;
  const dados = window.document.getElementById("dados");
  if (!dados) throw new Error("Fixture sem o JSON do curso.");
  dados.textContent = JSON.stringify({
    largura: 1280,
    altura: 720,
    versao: "sintetica",
    gerado: "2026-10-26",
    capturas: {},
    nichos: [],
    modulos: [{
      id: moduloId,
      titulo: "Módulo sintético",
      tela: "/app/inbox",
      resumo: "Controle do menu.",
      licoes: [{ id: licaoId, titulo: "Lição sintética", objetivo: "Controle da sublição.", busca: [], passos: [] }],
    }],
    menu: [{
      grupo: "Atendimento",
      itens: [
        { href: "/app/inbox", rotulo: "Inbox", descricao: "Curso do Inbox.", modulo: moduloId },
        { href: telaSemModulo, rotulo: "Tela sem módulo", descricao: "Ainda sem lições.", modulo: null },
      ],
    }],
  });
  runInContext(demonstracoes, dom.getInternalVMContext());
  runInContext(app, dom.getInternalVMContext());
  const menu = window.document.getElementById("menu-grupos");
  if (!menu) throw new Error("Fixture sem o menu renderizado.");
  return menu;
}

afterEach(() => {
  janelas.splice(0).forEach((dom) => dom.window.close());
});

function linkDo(menu: HTMLElement, origem: "modulo" | "licao" | "tela") {
  const itens = menu.querySelectorAll<HTMLAnchorElement>("a.item-menu");
  const link = origem === "licao"
    ? menu.querySelector<HTMLAnchorElement>(".sublicoes a")
    : itens.item(origem === "modulo" ? 1 : 2);
  if (!link) throw new Error(`Menu sem o link de ${origem}.`);
  return link;
}

describe("hrefs do menu do curso", () => {
  it.each([
    ["inbox", "conhecendo-a-tela", "/app/radar", "#t.app~radar"],
    ["agente-ia", "configurar-um-agente", "/app/settings/tenant", "#t.app~settings~tenant"],
  ])("preserva os slugs e a navegação de %s", (moduloId, licaoId, telaSemModulo, hrefDaTela) => {
    const menu = abrirMenu({ moduloId, licaoId, telaSemModulo });
    expect(linkDo(menu, "modulo").getAttribute("href")).toBe(`#m.${moduloId}`);
    expect(linkDo(menu, "modulo").getAttribute("aria-current")).toBe("page");
    expect(linkDo(menu, "licao").getAttribute("href")).toBe(`#l.${moduloId}.${licaoId}`);
    expect(linkDo(menu, "tela").getAttribute("href")).toBe(hrefDaTela);
    const demonstracao = menu.querySelector("a.item-menu");
    expect(demonstracao?.getAttribute("href")).toBe("#acao");
    expect(demonstracao?.textContent).toBe("Deskcomm em ação");
  });

  for (const [caso, sufixo] of [
    ["aspas e metacaracteres", '<&>\'" data-injetado="marcador'],
    ["entidades literais", "&quot;&#34;&amp;"],
  ] as const) {
    it.each(["modulo", "licao", "tela"] as const)("mantém %s como dado com " + caso, (origem) => {
      const opcoes = origem === "modulo"
        ? { moduloId: `inbox${sufixo}` }
        : origem === "licao"
          ? { licaoId: `conhecendo-a-tela${sufixo}` }
          : { telaSemModulo: `/app/radar${sufixo}` };
      const esperado = origem === "modulo"
        ? `#m.inbox${sufixo}`
        : origem === "licao"
          ? `#l.inbox.conhecendo-a-tela${sufixo}`
          : `#t.app~radar${sufixo}`;
      const menu = abrirMenu(opcoes);
      expect(linkDo(menu, origem).getAttribute("href")).toBe(esperado);
      if (origem === "modulo") {
        expect(linkDo(menu, "licao").getAttribute("href")).toBe(`#l.inbox${sufixo}.conhecendo-a-tela`);
      }
      expect(menu.querySelector("[data-injetado]")).toBeNull();
    });
  }
});
