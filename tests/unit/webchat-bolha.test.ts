/**
 * Script da bolha do chat no site (`public/webchat.js`, spec 36, F2, Task 4).
 *
 * O arquivo é JavaScript de navegador, sem módulo. Carregado aqui com `createRequire`,
 * ele expõe as funções puras por `module.exports`. O teste de DOM roda no jsdom, que já é
 * o ambiente padrão deste repositório (`vitest.config.ts`).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

interface ModuloDaBolha {
  origemDoScript: (src: string) => string | null;
  chaveDoScript: (src: string) => string | null;
  montarContexto: (
    loc: { href: string },
    doc: { referrer: string },
  ) => { href: string; referrer: string; utm: Record<string, string> };
  aceitarMensagem: (
    evento: { origin: string; source: unknown },
    origemDoCrm: string,
    iframe: { contentWindow: unknown },
  ) => boolean;
  formatoDoScript: (src: string) => string | null;
  posicaoDoScript: (src: string) => string | null;
  alvoDoScript: (src: string) => string | null;
  /** Fazenda pura: devolve { autoAbrirSegundos, som } quando o dado é um `ajustes` válido. */
  ajustesDaMensagem: (dado: unknown) => { autoAbrirSegundos: number; som: boolean } | null;
}

// import.meta.url não é um file: dentro do jsdom; a raiz do repositório é o cwd do vitest.
const CAMINHO = resolve(process.cwd(), "public/webchat.js");
const requerer = createRequire(CAMINHO);

function carregarModulo(): ModuloDaBolha {
  return requerer(CAMINHO) as ModuloDaBolha;
}

const modulo = carregarModulo();

describe("montarContexto", () => {
  it("devolve só href, referrer e os utm_*, sem fragmento nem outros parâmetros", () => {
    const contexto = modulo.montarContexto(
      { href: "https://loja.exemplo.com.br/produto?token=x&utm_source=g&q=1#secao" },
      { referrer: "https://busca.exemplo.com.br/" },
    );

    expect(contexto.utm).toEqual({ utm_source: "g" });
    expect(contexto.referrer).toBe("https://busca.exemplo.com.br/");
    expect(contexto.href).toBe("https://loja.exemplo.com.br/produto?utm_source=g");
    expect(contexto.href).not.toContain("#");
    expect(contexto.href).not.toContain("token");
    expect(contexto.href).not.toContain("q=1");
  });

  it("guarda as cinco chaves utm_* e ignora outros nomes", () => {
    const contexto = modulo.montarContexto(
      {
        href: "https://loja.exemplo.com.br/?utm_source=a&utm_medium=b&utm_campaign=c&utm_term=d&utm_content=e&utm_id=f",
      },
      { referrer: "" },
    );

    expect(contexto.utm).toEqual({
      utm_source: "a",
      utm_medium: "b",
      utm_campaign: "c",
      utm_term: "d",
      utm_content: "e",
    });
  });

  it("apara o valor e corta utm acima de 200 caracteres", () => {
    const longo = "a".repeat(250);
    const contexto = modulo.montarContexto(
      { href: `https://loja.exemplo.com.br/?utm_source=${longo}&utm_medium=%20%20%20` },
      { referrer: "" },
    );

    expect(contexto.utm.utm_source).toHaveLength(200);
    expect(contexto.utm.utm_source).toBe("a".repeat(200));
    expect(contexto.utm).not.toHaveProperty("utm_medium");
  });

  it("reduz o referrer a origem e caminho, sem query nem fragmento", () => {
    const contexto = modulo.montarContexto(
      { href: "https://loja.exemplo.com.br/" },
      { referrer: "https://busca.exemplo.com.br/resultado?token=abc#x" },
    );

    expect(contexto.referrer).toBe("https://busca.exemplo.com.br/resultado");
    expect(contexto.referrer).not.toContain("token");
    expect(contexto.referrer).not.toContain("#");
  });

  it("referrer inválido ou que não é http(s) vira vazio", () => {
    const ruim = (ref: string) =>
      modulo.montarContexto({ href: "https://loja.exemplo.com.br/" }, { referrer: ref }).referrer;

    expect(ruim("nao e url")).toBe("");
    expect(ruim("javascript:alert(1)")).toBe("");
  });

  it("referrer vazio continua vazio", () => {
    expect(
      modulo.montarContexto({ href: "https://loja.exemplo.com.br/" }, { referrer: "" }).referrer,
    ).toBe("");
  });

  it("corta o referrer reduzido em 200 caracteres", () => {
    const caminho = "a".repeat(300);
    const contexto = modulo.montarContexto(
      { href: "https://loja.exemplo.com.br/" },
      { referrer: `https://busca.exemplo.com.br/${caminho}?q=1` },
    );

    expect(contexto.referrer).toHaveLength(200);
    expect(contexto.referrer.startsWith("https://busca.exemplo.com.br/")).toBe(true);
  });

  it("sem parâmetro algum devolve utm vazio e href sem query", () => {
    const contexto = modulo.montarContexto(
      { href: "https://loja.exemplo.com.br/contato" },
      { referrer: "" },
    );

    expect(contexto).toEqual({
      href: "https://loja.exemplo.com.br/contato",
      referrer: "",
      utm: {},
    });
  });
});

describe("aceitarMensagem", () => {
  const iframe = { contentWindow: { janela: "do chat" } };
  const origemDoCrm = "https://crm.exemplo.com.br";

  it("é verdadeiro só com origin e source certos", () => {
    expect(
      modulo.aceitarMensagem(
        { origin: origemDoCrm, source: iframe.contentWindow },
        origemDoCrm,
        iframe,
      ),
    ).toBe(true);
  });

  it("é falso com origin diferente", () => {
    expect(
      modulo.aceitarMensagem(
        { origin: "https://outro.exemplo.com.br", source: iframe.contentWindow },
        origemDoCrm,
        iframe,
      ),
    ).toBe(false);
  });

  it("é falso com source diferente", () => {
    expect(
      modulo.aceitarMensagem(
        { origin: origemDoCrm, source: { janela: "outra" } },
        origemDoCrm,
        iframe,
      ),
    ).toBe(false);
  });

  it('é falso com origem "null"', () => {
    const semOrigem = { contentWindow: null };
    expect(modulo.aceitarMensagem({ origin: "null", source: null }, "null", semOrigem)).toBe(false);
    expect(modulo.aceitarMensagem({ origin: "null", source: null }, origemDoCrm, semOrigem)).toBe(
      false,
    );
  });

  it("é falso quando o iframe ainda não tem janela", () => {
    expect(
      modulo.aceitarMensagem({ origin: origemDoCrm, source: null }, origemDoCrm, {
        contentWindow: null,
      }),
    ).toBe(false);
  });
});

describe("chaveDoScript", () => {
  it("aceita a chave no formato wck_", () => {
    expect(modulo.chaveDoScript("https://crm.exemplo.com.br/webchat.js?k=wck_abc-_1")).toBe(
      "wck_abc-_1",
    );
  });

  it.each([
    ["sem ?k=", "https://crm.exemplo.com.br/webchat.js"],
    ["k vazio", "https://crm.exemplo.com.br/webchat.js?k="],
    ["sem prefixo wck_", "https://crm.exemplo.com.br/webchat.js?k=abc"],
    ["só o prefixo", "https://crm.exemplo.com.br/webchat.js?k=wck_"],
    ["com espaço", "https://crm.exemplo.com.br/webchat.js?k=wck_a%20b"],
    ["com barra", "https://crm.exemplo.com.br/webchat.js?k=wck_a%2Fb"],
    ["longa demais", `https://crm.exemplo.com.br/webchat.js?k=wck_${"a".repeat(65)}`],
  ])("rejeita a chave (%s)", (_nome, src) => {
    expect(modulo.chaveDoScript(src)).toBeNull();
  });
});

describe("origemDoScript", () => {
  it("devolve a origem do src e ignora os parâmetros", () => {
    expect(
      modulo.origemDoScript("https://crm.exemplo.com.br/webchat.js?k=wck_abc&token=x"),
    ).toBe("https://crm.exemplo.com.br");
  });

  it("mantém a porta do loopback em http", () => {
    expect(modulo.origemDoScript("http://localhost:3000/webchat.js?k=wck_abc")).toBe(
      "http://localhost:3000",
    );
  });

  it("recusa http fora do loopback e src inválido", () => {
    expect(modulo.origemDoScript("http://crm.exemplo.com.br/webchat.js?k=wck_abc")).toBeNull();
    expect(modulo.origemDoScript("nao-e-url")).toBeNull();
  });
});

describe("formato e posição - funções puras", () => {
  it("formatoDoScript aceita só os quatro formatos da lista fixa", () => {
    expect(modulo.formatoDoScript("https://crm.exemplo.com.br/webchat.js?k=wck_abc&f=bolha")).toBe("bolha");
    expect(modulo.formatoDoScript("https://crm.exemplo.com.br/webchat.js?k=wck_abc&f=painel")).toBe("painel");
    expect(modulo.formatoDoScript("https://crm.exemplo.com.br/webchat.js?k=wck_abc&f=embutido")).toBe("embutido");
    expect(modulo.formatoDoScript("https://crm.exemplo.com.br/webchat.js?k=wck_abc&f=pagina")).toBe("pagina");
  });

  it.each([
    ["f ausente", "https://crm.exemplo.com.br/webchat.js?k=wck_abc"],
    ["f fora da lista", "https://crm.exemplo.com.br/webchat.js?k=wck_abc&f=qualquer_coisa"],
    ["f vazio", "https://crm.exemplo.com.br/webchat.js?k=wck_abc&f="],
  ])("formatoDoScript devolve null para %s", (_nome, src) => {
    expect(modulo.formatoDoScript(src)).toBeNull();
  });

  it("posicaoDoScript aceita direita e esquerda", () => {
    expect(modulo.posicaoDoScript("https://crm.exemplo.com.br/webchat.js?k=wck_abc&p=direita")).toBe("direita");
    expect(modulo.posicaoDoScript("https://crm.exemplo.com.br/webchat.js?k=wck_abc&p=esquerda")).toBe("esquerda");
  });

  it.each([
    ["p ausente", "https://crm.exemplo.com.br/webchat.js?k=wck_abc"],
    ["p fora da lista", "https://crm.exemplo.com.br/webchat.js?k=wck_abc&p=centro"],
    ["p vazio", "https://crm.exemplo.com.br/webchat.js?k=wck_abc&p="],
  ])("posicaoDoScript devolve null para %s", (_nome, src) => {
    expect(modulo.posicaoDoScript(src)).toBeNull();
  });

  it("alvoDoScript lê o data-webchat-alvo do script", () => {
    const script = document.createElement("script");
    script.src = "https://crm.exemplo.com.br/webchat.js?k=wck_abc&f=embutido";
    script.setAttribute("data-webchat-alvo", "#webchat-aqui");
    document.head.appendChild(script);
    try {
      expect(modulo.alvoDoScript(script.src)).toBe("#webchat-aqui");
    } finally {
      script.remove();
    }
  });

  it("alvoDoScript devolve null sem data-webchat-alvo", () => {
    const script = document.createElement("script");
    script.src = "https://crm.exemplo.com.br/webchat.js?k=wck_abc&f=embutido";
    document.head.appendChild(script);
    try {
      expect(modulo.alvoDoScript(script.src)).toBeNull();
    } finally {
      script.remove();
    }
  });
});

describe("montagem no DOM", () => {
  const SRC_CRM = "https://crm.exemplo.com.br/webchat.js";

  afterEach(() => {
    document.querySelectorAll("script[src], iframe, button").forEach((el) => el.remove());
    delete (window as unknown as Record<string, unknown>).__webchatMontado;
    delete requerer.cache[requerer.resolve(CAMINHO)];
  });

  function montarComSrc(src: string): void {
    const script = document.createElement("script");
    script.src = src;
    document.head.appendChild(script);
    delete requerer.cache[requerer.resolve(CAMINHO)];
    requerer(CAMINHO);
  }

  it("chave ausente no ?k= não cria nada", () => {
    montarComSrc(SRC_CRM);

    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("button")).toBeNull();
  });

  it("chave fora do formato não cria nada", () => {
    montarComSrc(`${SRC_CRM}?k=wck_a/b`);

    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("button")).toBeNull();
  });

  it("chave válida cria a bolha e o iframe com os atributos fixos", () => {
    montarComSrc(`${SRC_CRM}?k=wck_abc`);

    const iframe = document.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("src")).toBe("https://crm.exemplo.com.br/chat/wck_abc");
    expect(iframe?.getAttribute("title")).toBeTruthy();
    expect(iframe?.getAttribute("allow")).toBe("");
    expect(iframe?.getAttribute("loading")).toBe("lazy");
    expect(iframe?.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
    expect(iframe?.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox",
    );

    const bolha = document.querySelector("button");
    expect(bolha?.getAttribute("aria-label")).toBe("Abrir chat");
  });

  function montarNoDom(): {
    bolha: HTMLButtonElement;
    iframe: HTMLIFrameElement;
    janela: { postMessage: ReturnType<typeof vi.fn> };
  } {
    montarComSrc(`${SRC_CRM}?k=wck_abc`);
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    const bolha = document.querySelector("button") as HTMLButtonElement;
    // jsdom não garante janela real no iframe: a janela de teste é um espião.
    const janela = { postMessage: vi.fn() };
    Object.defineProperty(iframe, "contentWindow", { value: janela, configurable: true });
    return { bolha, iframe, janela };
  }

  function dispararMensagem(data: unknown, origin: string, source: unknown): void {
    const evento = new Event("message");
    Object.defineProperty(evento, "data", { value: data });
    Object.defineProperty(evento, "origin", { value: origin });
    Object.defineProperty(evento, "source", { value: source });
    window.dispatchEvent(evento);
  }

  const ORIGEM_CRM = "https://crm.exemplo.com.br";

  it("mensagem com origin forjada é ignorada, mesmo com a janela certa", () => {
    const { bolha, iframe, janela } = montarNoDom();
    fireEvent.click(bolha);

    dispararMensagem({ tipo: "fechar" }, "https://atacante.exemplo.com", janela);

    expect(iframe.style.display).toBe("block");
  });

  it("mensagem com source forjada é ignorada, mesmo com a origem certa", () => {
    const { bolha, iframe } = montarNoDom();
    fireEvent.click(bolha);

    dispararMensagem({ tipo: "fechar" }, ORIGEM_CRM, {});

    expect(iframe.style.display).toBe("block");
  });

  it("nao-lidas com origem ou source forjadas não mexe no badge", () => {
    const { bolha, janela } = montarNoDom();
    const badge = bolha.querySelector("span") as HTMLSpanElement;

    dispararMensagem({ tipo: "nao-lidas", n: 7 }, "https://atacante.exemplo.com", janela);
    dispararMensagem({ tipo: "nao-lidas", n: 7 }, ORIGEM_CRM, {});

    expect(badge.style.display).toBe("none");
    expect(badge.textContent).toBe("0");
  });

  it("nao-lidas com n inteiro de 0 a 99 atualiza o badge", () => {
    const { bolha, janela } = montarNoDom();
    const badge = bolha.querySelector("span") as HTMLSpanElement;

    dispararMensagem({ tipo: "nao-lidas", n: 5 }, ORIGEM_CRM, janela);
    expect(badge.textContent).toBe("5");
    expect(badge.style.display).toBe("block");

    dispararMensagem({ tipo: "nao-lidas", n: 99 }, ORIGEM_CRM, janela);
    expect(badge.textContent).toBe("99");

    dispararMensagem({ tipo: "nao-lidas", n: 0 }, ORIGEM_CRM, janela);
    expect(badge.style.display).toBe("none");
  });

  it.each([
    ["fracionário", 1.5],
    ["negativo", -1],
    ["100", 100],
    ["string", "5"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("nao-lidas com n inválido (%s) é ignorado", (_nome, n) => {
    const { bolha, janela } = montarNoDom();
    const badge = bolha.querySelector("span") as HTMLSpanElement;

    dispararMensagem({ tipo: "nao-lidas", n }, ORIGEM_CRM, janela);

    expect(badge.style.display).toBe("none");
    expect(badge.textContent).toBe("0");
  });

  it("fechar válido fecha o painel e devolve aria-expanded", () => {
    const { bolha, iframe, janela } = montarNoDom();
    fireEvent.click(bolha);
    expect(bolha.getAttribute("aria-expanded")).toBe("true");

    dispararMensagem({ tipo: "fechar" }, ORIGEM_CRM, janela);

    expect(iframe.style.display).toBe("none");
    expect(bolha.getAttribute("aria-expanded")).toBe("false");
  });

  it("pronto responde com o contexto e o targetOrigin é a origem do CRM, nunca '*'", () => {
    const { iframe, janela } = montarNoDom();

    dispararMensagem({ tipo: "pronto" }, ORIGEM_CRM, janela);
    expect(janela.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ tipo: "contexto" }),
      ORIGEM_CRM,
    );

    iframe.dispatchEvent(new Event("load"));
    expect(janela.postMessage.mock.calls.length).toBe(2);
    for (const chamada of janela.postMessage.mock.calls) {
      expect(chamada[1]).toBe(ORIGEM_CRM);
      expect(chamada[1]).not.toBe("*");
    }
  });

  it("clique alterna aria-expanded, visibilidade e o rótulo", () => {
    const { bolha, iframe } = montarNoDom();

    fireEvent.click(bolha);
    expect(iframe.style.display).toBe("block");
    expect(bolha.getAttribute("aria-expanded")).toBe("true");
    expect(bolha.getAttribute("aria-label")).toBe("Fechar chat");

    fireEvent.click(bolha);
    expect(iframe.style.display).toBe("none");
    expect(bolha.getAttribute("aria-expanded")).toBe("false");
    expect(bolha.getAttribute("aria-label")).toBe("Abrir chat");
  });

  it("Esc fecha o painel aberto", () => {
    const { bolha, iframe } = montarNoDom();
    fireEvent.click(bolha);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(iframe.style.display).toBe("none");
  });

  it("segunda execução do script não cria um segundo botão", () => {
    montarNoDom();
    // Sem apagar `__webchatMontado`: é a segunda carga do mesmo script.
    delete requerer.cache[requerer.resolve(CAMINHO)];
    requerer(CAMINHO);

    expect(document.querySelectorAll("button").length).toBe(1);
    expect(document.querySelectorAll("iframe").length).toBe(1);
  });

  it("espera o DOMContentLoaded quando o corpo ainda não existe", () => {
    const corpo = document.body;
    Object.defineProperty(document, "readyState", { configurable: true, get: () => "loading" });
    corpo.remove();
    try {
      montarComSrc(`${SRC_CRM}?k=wck_abc`);
      expect(document.querySelector("iframe")).toBeNull();
    } finally {
      document.documentElement.appendChild(corpo);
      delete (document as unknown as Record<string, unknown>).readyState;
    }

    document.dispatchEvent(new Event("DOMContentLoaded"));

    expect(document.querySelector("iframe")).not.toBeNull();
  });

  it("o arquivo não contém eval(, new Function, innerHTML, console.log, fetch(, document.cookie", () => {
    const texto = readFileSync(CAMINHO, "utf8");
    for (const proibido of [
      "eval(",
      "new Function",
      "innerHTML",
      "console.log",
      "fetch(",
      "document.cookie",
    ]) {
      expect(texto).not.toContain(proibido);
    }
  });
});

describe("formato e posição - montagem no DOM", () => {
  const SRC_CRM = "https://crm.exemplo.com.br/webchat.js";

  afterEach(() => {
    document.querySelectorAll("script[src], iframe, button, div").forEach((el) => el.remove());
    delete (window as unknown as Record<string, unknown>).__webchatMontado;
    delete requerer.cache[requerer.resolve(CAMINHO)];
  });

  function montarComSrc(src: string): void {
    const script = document.createElement("script");
    script.src = src;
    document.head.appendChild(script);
    delete requerer.cache[requerer.resolve(CAMINHO)];
    requerer(CAMINHO);
  }

  function montarComSrcEAttr(src: string, attrNome: string, attrValor: string): void {
    const script = document.createElement("script");
    script.src = src;
    script.setAttribute(attrNome, attrValor);
    document.head.appendChild(script);
    delete requerer.cache[requerer.resolve(CAMINHO)];
    requerer(CAMINHO);
  }

  it("bolha padrão fica à direita (right: 20px)", () => {
    montarComSrc(`${SRC_CRM}?k=wck_abc`);
    const bolha = document.querySelector("button") as HTMLButtonElement;
    expect(bolha).not.toBeNull();
    expect(bolha.style.right).toBe("20px");
    expect(bolha.style.left).toBe("");
  });

  it("posicao esquerda coloca a bolha à esquerda (left: 20px)", () => {
    montarComSrc(`${SRC_CRM}?k=wck_abc&p=esquerda`);
    const bolha = document.querySelector("button") as HTMLButtonElement;
    expect(bolha).not.toBeNull();
    expect(bolha.style.left).toBe("20px");
    expect(bolha.style.right).toBe("");
  });

  it("posicao esquerda abre o cartão do chat à esquerda, e a direita o abre à direita", () => {
    montarComSrc(`${SRC_CRM}?k=wck_abc&p=esquerda`);
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    const cartao = document.querySelector("iframe") as HTMLIFrameElement;
    expect(cartao.style.left).toBe("20px");
    expect(cartao.style.right).toBe("auto");
  });

  it("sem posicao o cartão do chat abre à direita", () => {
    montarComSrc(`${SRC_CRM}?k=wck_abc`);
    fireEvent.click(document.querySelector("button") as HTMLButtonElement);
    const cartao = document.querySelector("iframe") as HTMLIFrameElement;
    expect(cartao.style.right).toBe("20px");
    expect(cartao.style.left).toBe("auto");
  });

  it("valor de p fora da lista cai no padrão direita", () => {
    montarComSrc(`${SRC_CRM}?k=wck_abc&p=centro`);
    const bolha = document.querySelector("button") as HTMLButtonElement;
    expect(bolha.style.right).toBe("20px");
    expect(bolha.style.left).toBe("");
  });

  it("valor de f fora da lista cai no padrão bolha (cria bolha e iframe)", () => {
    montarComSrc(`${SRC_CRM}?k=wck_abc&f=qualquer_coisa`);
    expect(document.querySelector("button")).not.toBeNull();
    expect(document.querySelector("iframe")).not.toBeNull();
  });

  it("painel aberto ocupa a altura da tela e 380px colado na lateral direita", () => {
    montarComSrc(`${SRC_CRM}?k=wck_abc&f=painel`);
    const bolha = document.querySelector("button") as HTMLButtonElement;
    fireEvent.click(bolha);
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.style.height).toBe("100vh");
    expect(iframe.style.width).toBe("380px");
    expect(iframe.style.right).toBe("0px");
    expect(iframe.style.left).toBe("auto");
    expect(iframe.style.top).toBe("0px");
    expect(iframe.style.bottom).toBe("0px");
  });

  it("painel aberto com posicao esquerda fica colado na lateral esquerda", () => {
    montarComSrc(`${SRC_CRM}?k=wck_abc&f=painel&p=esquerda`);
    const bolha = document.querySelector("button") as HTMLButtonElement;
    fireEvent.click(bolha);
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.style.left).toBe("0px");
    expect(iframe.style.right).toBe("auto");
    expect(iframe.style.height).toBe("100vh");
    expect(iframe.style.width).toBe("380px");
  });

  it("embutido sem alvo não cria nada e não lança", () => {
    expect(() => montarComSrc(`${SRC_CRM}?k=wck_abc&f=embutido`)).not.toThrow();
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("button")).toBeNull();
  });

  it("embutido com seletor inválido não lança e não cria nada", () => {
    expect(() =>
      montarComSrcEAttr(`${SRC_CRM}?k=wck_abc&f=embutido`, "data-webchat-alvo", "[["),
    ).not.toThrow();
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("button")).toBeNull();
  });

  it("embutido com alvo cria o iframe dentro do elemento alvo e sem bolha", () => {
    const alvo = document.createElement("div");
    alvo.id = "webchat-aqui";
    document.body.appendChild(alvo);
    try {
      montarComSrcEAttr(`${SRC_CRM}?k=wck_abc&f=embutido`, "data-webchat-alvo", "#webchat-aqui");
      const iframe = document.querySelector("iframe") as HTMLIFrameElement;
      expect(iframe).not.toBeNull();
      expect(alvo.contains(iframe)).toBe(true);
      expect(document.querySelector("button")).toBeNull();
    } finally {
      alvo.remove();
    }
  });

  it("pagina chama window.open com noopener,noreferrer e não abre o painel", () => {
    const openSpy = vi.spyOn(window, "open");
    try {
      montarComSrc(`${SRC_CRM}?k=wck_abc&f=pagina`);
      const bolha = document.querySelector("button") as HTMLButtonElement;
      fireEvent.click(bolha);
      expect(openSpy).toHaveBeenCalledWith(
        "https://crm.exemplo.com.br/chat/wck_abc",
        "_blank",
        "noopener,noreferrer",
      );
      // não abre o painel: o iframe continua escondido
      const iframe = document.querySelector("iframe");
      expect(iframe?.style.display).toBe("none");
    } finally {
      openSpy.mockRestore();
    }
  });
});

/** --- Tarefa 10b: ajustes, auto-abrir, badge e som --- */

describe("ajustesDaMensagem (Tarefa 10b)", () => {
  it("devolve { autoAbrirSegundos, som } quando o dado é um ajustes válido", () => {
    expect(modulo.ajustesDaMensagem({ tipo: "ajustes", autoAbrirSegundos: 30, som: true })).toEqual(
      { autoAbrirSegundos: 30, som: true },
    );
  });

  it("aceita autoAbrirSegundos 0 e 120", () => {
    expect(modulo.ajustesDaMensagem({ tipo: "ajustes", autoAbrirSegundos: 0, som: false })).toEqual(
      { autoAbrirSegundos: 0, som: false },
    );
    expect(modulo.ajustesDaMensagem({ tipo: "ajustes", autoAbrirSegundos: 120, som: true })).toEqual(
      { autoAbrirSegundos: 120, som: true },
    );
  });

  it.each([
    ["autoAbrir 121", { tipo: "ajustes", autoAbrirSegundos: 121, som: false }],
    ["autoAbrir -1", { tipo: "ajustes", autoAbrirSegundos: -1, som: false }],
    ["autoAbrir 1.5", { tipo: "ajustes", autoAbrirSegundos: 1.5, som: false }],
    ["autoAbrir texto", { tipo: "ajustes", autoAbrirSegundos: "30", som: false }],
    ["som não booleano", { tipo: "ajustes", autoAbrirSegundos: 0, som: "sim" }],
    ["som número", { tipo: "ajustes", autoAbrirSegundos: 0, som: 1 }],
    ["tipo errado", { tipo: "nao-lidas", n: 1 }],
    ["sem tipo", { autoAbrirSegundos: 0, som: false }],
  ])("recusa dado inválido (%s)", (_nome, dado) => {
    expect(modulo.ajustesDaMensagem(dado)).toBeNull();
  });
});

describe("ajustes e resposta - comportamento da bolha (Tarefa 10b)", () => {
  const SRC_CRM = "https://crm.exemplo.com.br/webchat.js";
  const ORIGEM_CRM = "https://crm.exemplo.com.br";
  let janelaAtual: { postMessage: ReturnType<typeof vi.fn> } | null = null;

  afterEach(() => {
    document.querySelectorAll("script[src], iframe, button").forEach((el) => el.remove());
    delete (window as unknown as Record<string, unknown>).__webchatMontado;
    delete requerer.cache[requerer.resolve(CAMINHO)];
    vi.useRealTimers();
    try {
      delete (window as unknown as Record<string, unknown>).AudioContext;
    } catch {
      // ignorar
    }
  });

  function montarComSrc(src: string): void {
    const script = document.createElement("script");
    script.src = src;
    document.head.appendChild(script);
    delete requerer.cache[requerer.resolve(CAMINHO)];
    requerer(CAMINHO);
  }

  function montarComSrcEAttr(src: string, attrNome: string, attrValor: string): void {
    const script = document.createElement("script");
    script.src = src;
    script.setAttribute(attrNome, attrValor);
    document.head.appendChild(script);
    delete requerer.cache[requerer.resolve(CAMINHO)];
    requerer(CAMINHO);
  }

  function montarNoDom(formatoparam: string): {
    bolha: HTMLButtonElement;
    iframe: HTMLIFrameElement;
    janela: { postMessage: ReturnType<typeof vi.fn> };
  } {
    const f = formatoparam === "embutido" ? `${SRC_CRM}?k=wck_abc&f=embutido` : `${SRC_CRM}?k=wck_abc&f=${formatoparam}`;
    if (formatoparam === "embutido") {
      const alvo = document.createElement("div");
      alvo.id = "webchat-aqui";
      document.body.appendChild(alvo);
      montarComSrcEAttr(f, "data-webchat-alvo", "#webchat-aqui");
    } else {
      montarComSrc(f);
    }
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    const bolha = document.querySelector("button") as HTMLButtonElement;
    const janela = { postMessage: vi.fn() };
    Object.defineProperty(iframe, "contentWindow", { value: janela, configurable: true });
    janelaAtual = janela;
    return { bolha, iframe, janela };
  }

  function dispararMensagem(data: unknown, origin: string, source?: unknown): void {
    const evento = new Event("message");
    Object.defineProperty(evento, "data", { value: data });
    Object.defineProperty(evento, "origin", { value: origin });
    Object.defineProperty(evento, "source", { value: source === undefined ? janelaAtual : source });
    window.dispatchEvent(evento);
  }

  // ---------- auto-abrir ----------

  it("auto-abrir abre após N segundos no formato bolha", () => {
    vi.useFakeTimers();
    const { bolha, iframe } = montarNoDom("bolha");
    dispararMensagem({ tipo: "ajustes", autoAbrirSegundos: 5, som: false }, ORIGEM_CRM);
    expect(iframe.style.display).toBe("none");
    vi.advanceTimersByTime(5000);
    expect(iframe.style.display).toBe("block");
    expect(bolha.getAttribute("aria-expanded")).toBe("true");
  });

  it("auto-abrir com 0 nunca abre sozinho", () => {
    vi.useFakeTimers();
    const { iframe } = montarNoDom("bolha");
    dispararMensagem({ tipo: "ajustes", autoAbrirSegundos: 0, som: false }, ORIGEM_CRM);
    vi.advanceTimersByTime(60000);
    expect(iframe.style.display).toBe("none");
  });

  it("auto-abrir não abre se o visitante já clicou na bolha", () => {
    vi.useFakeTimers();
    const { bolha, iframe } = montarNoDom("bolha");
    dispararMensagem({ tipo: "ajustes", autoAbrirSegundos: 5, som: false }, ORIGEM_CRM);
    fireEvent.click(bolha);
    expect(iframe.style.display).toBe("block");
    vi.advanceTimersByTime(5000);
    // já está aberto; não deve fechar nem reabrir
    expect(iframe.style.display).toBe("block");
  });

  it("auto-abrir em formato embutido não mexe no iframe: fica no alvo e sempre visível", () => {
    vi.useFakeTimers();
    const { iframe } = montarNoDom("embutido");
    dispararMensagem({ tipo: "ajustes", autoAbrirSegundos: 5, som: false }, ORIGEM_CRM);
    vi.advanceTimersByTime(5000);
    expect(iframe.style.display).toBe("block");
    expect(iframe.style.position).toBe("static");
    expect(iframe.parentElement?.id).toBe("webchat-aqui");
  });

  it("auto-abrir não abre em formato pagina", () => {
    vi.useFakeTimers();
    const { iframe } = montarNoDom("pagina");
    dispararMensagem({ tipo: "ajustes", autoAbrirSegundos: 5, som: false }, ORIGEM_CRM);
    vi.advanceTimersByTime(5000);
    expect(iframe.style.display).toBe("none");
  });

  it("segundo ajustes não reagenda o auto-abrir", () => {
    vi.useFakeTimers();
    const { iframe } = montarNoDom("bolha");
    dispararMensagem({ tipo: "ajustes", autoAbrirSegundos: 5, som: false }, ORIGEM_CRM);
    dispararMensagem({ tipo: "ajustes", autoAbrirSegundos: 5, som: false }, ORIGEM_CRM);
    vi.advanceTimersByTime(5000);
    // abriu uma vez só (continua aberto; não fecha e reabre)
    expect(iframe.style.display).toBe("block");
  });

  // ---------- badge ----------

  it("resposta com bolha fechada sobe o badge", () => {
    const { bolha } = montarNoDom("bolha");
    const badge = bolha.querySelector("span") as HTMLSpanElement;
    dispararMensagem({ tipo: "resposta" }, ORIGEM_CRM);
    expect(badge.textContent).toBe("1");
    expect(badge.style.display).toBe("block");
  });

  it("badge para no teto 99", () => {
    const { bolha } = montarNoDom("bolha");
    const badge = bolha.querySelector("span") as HTMLSpanElement;
    for (let i = 0; i < 120; i++) {
      dispararMensagem({ tipo: "resposta" }, ORIGEM_CRM);
    }
    expect(badge.textContent).toBe("99");
  });

  it("abrir a bolha zera o badge", () => {
    const { bolha } = montarNoDom("bolha");
    const badge = bolha.querySelector("span") as HTMLSpanElement;
    dispararMensagem({ tipo: "resposta" }, ORIGEM_CRM);
    expect(badge.textContent).toBe("1");
    fireEvent.click(bolha);
    expect(badge.textContent).toBe("0");
    expect(badge.style.display).toBe("none");
  });

  it("resposta com bolha aberta não conta", () => {
    const { bolha } = montarNoDom("bolha");
    const badge = bolha.querySelector("span") as HTMLSpanElement;
    fireEvent.click(bolha);
    dispararMensagem({ tipo: "resposta" }, ORIGEM_CRM);
    expect(badge.textContent).toBe("0");
    expect(badge.style.display).toBe("none");
  });

  it("abrir e fechar não reativa o badge antigo", () => {
    const { bolha, iframe } = montarNoDom("bolha");
    const badge = bolha.querySelector("span") as HTMLSpanElement;
    // 3 respostas com a bolha fechada
    dispararMensagem({ tipo: "resposta" }, ORIGEM_CRM);
    dispararMensagem({ tipo: "resposta" }, ORIGEM_CRM);
    dispararMensagem({ tipo: "resposta" }, ORIGEM_CRM);
    expect(badge.textContent).toBe("3");

    // abrir zera o contador
    fireEvent.click(bolha);
    expect(badge.textContent).toBe("0");
    expect(badge.style.display).toBe("none");

    // fechar: o contador não volta a 3 (fica escondido, texto 0)
    fireEvent.click(bolha);
    expect(badge.textContent).toBe("0");
    expect(badge.style.display).toBe("none");
    expect(iframe.style.display).toBe("none");
  });

  it("som toca com a bolha aberta (AudioContext instanciado) e badge não sobe", () => {
    const instanciados: unknown[] = [];
    class AudioContextDuble {
      constructor() {
        instanciados.push("constructor");
      }
      createOscillator() {
        return { start: () => {}, stop: () => {}, disconnect: () => {}, type: "", frequency: { setValueAtTime: () => {} } };
      }
      createGain() {
        return { gain: { setValueAtTime: () => {} }, connect: () => {} };
      }
      close() {
        return Promise.resolve();
      }
    }
    Object.defineProperty(window, "AudioContext", {
      value: AudioContextDuble,
      configurable: true,
      writable: true,
    });
    const { bolha } = montarNoDom("bolha");
    const badge = bolha.querySelector("span") as HTMLSpanElement;
    dispararMensagem({ tipo: "ajustes", autoAbrirSegundos: 0, som: true }, ORIGEM_CRM);
    document.dispatchEvent(new Event("pointerdown"));
    fireEvent.click(bolha); // abre a bolha
    dispararMensagem({ tipo: "resposta" }, ORIGEM_CRM);
    expect(instanciados).toHaveLength(1);
    // com a bolha aberta o badge não sobe
    expect(badge.textContent).toBe("0");
    expect(badge.style.display).toBe("none");
  });

  // ---------- som ----------

  it("som toca bip com interação prévia (AudioContext instanciado)", () => {
    const instanciados: unknown[] = [];
    class AudioContextDuble {
      constructor() {
        instanciados.push("constructor");
      }
      createOscillator() {
        return { start: () => {}, stop: () => {}, disconnect: () => {}, type: "", frequency: { setValueAtTime: () => {} } };
      }
      createGain() {
        return { gain: { setValueAtTime: () => {} }, connect: () => {} };
      }
      close() {
        return Promise.resolve();
      }
    }
    Object.defineProperty(window, "AudioContext", {
      value: AudioContextDuble,
      configurable: true,
      writable: true,
    });
    const { bolha } = montarNoDom("bolha");
    dispararMensagem({ tipo: "ajustes", autoAbrirSegundos: 0, som: true }, ORIGEM_CRM);
    document.dispatchEvent(new Event("pointerdown"));
    dispararMensagem({ tipo: "resposta" }, ORIGEM_CRM);
    expect(instanciados).toHaveLength(1);
  });

  it("duas respostas tocam dois bips com um AudioContext só", () => {
    const instanciados: unknown[] = [];
    const bips: unknown[] = [];
    class AudioContextDuble {
      currentTime = 0;
      destination = {};
      constructor() {
        instanciados.push("constructor");
      }
      createOscillator() {
        return { start: () => bips.push("start"), stop: () => {}, connect: () => {}, type: "", frequency: { setValueAtTime: () => {} } };
      }
      createGain() {
        return { gain: { setValueAtTime: () => {} }, connect: () => {} };
      }
    }
    Object.defineProperty(window, "AudioContext", { value: AudioContextDuble, configurable: true, writable: true });
    montarNoDom("bolha");
    dispararMensagem({ tipo: "ajustes", autoAbrirSegundos: 0, som: true }, ORIGEM_CRM);
    document.dispatchEvent(new Event("pointerdown"));
    dispararMensagem({ tipo: "resposta" }, ORIGEM_CRM);
    dispararMensagem({ tipo: "resposta" }, ORIGEM_CRM);
    expect(bips).toHaveLength(2);
    expect(instanciados).toHaveLength(1);
  });

  // ---------- embutido ----------

  it("embutido: iframe visível, position static e width 100% depois de montar", () => {
    const { iframe } = montarNoDom("embutido");
    expect(iframe.style.display).toBe("block");
    expect(iframe.style.position).toBe("static");
    expect(iframe.style.width).toBe("100%");
  });

  it("embutido: resposta não sobe contador nem toca bip", () => {
    const instanciados: unknown[] = [];
    class AudioContextDuble {
      constructor() {
        instanciados.push("constructor");
      }
      createOscillator() {
        return { start: () => {}, stop: () => {}, disconnect: () => {}, type: "", frequency: { setValueAtTime: () => {} } };
      }
      createGain() {
        return { gain: { setValueAtTime: () => {} }, connect: () => {} };
      }
      close() {
        return Promise.resolve();
      }
    }
    Object.defineProperty(window, "AudioContext", {
      value: AudioContextDuble,
      configurable: true,
      writable: true,
    });
    const { iframe } = montarNoDom("embutido");
    dispararMensagem({ tipo: "ajustes", autoAbrirSegundos: 0, som: true }, ORIGEM_CRM);
    document.dispatchEvent(new Event("pointerdown"));
    dispararMensagem({ tipo: "resposta" }, ORIGEM_CRM);
    // no embutido não há bolha nem contador (a janela está sempre à vista) e não há bip
    expect(document.querySelector("button")).toBeNull();
    expect(iframe.style.display).toBe("block");
    expect(instanciados).toHaveLength(0);
  });

  it("embutido: Escape no documento não muda o display do iframe", () => {
    const { iframe } = montarNoDom("embutido");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(iframe.style.display).toBe("block");
  });

  it("som true sem interação prévia não toca", () => {
    const instanciados: unknown[] = [];
    class AudioContextDuble {
      constructor() {
        instanciados.push("constructor");
      }
    }
    Object.defineProperty(window, "AudioContext", {
      value: AudioContextDuble,
      configurable: true,
      writable: true,
    });
    const { bolha } = montarNoDom("bolha");
    dispararMensagem({ tipo: "ajustes", autoAbrirSegundos: 0, som: true }, ORIGEM_CRM);
    dispararMensagem({ tipo: "resposta" }, ORIGEM_CRM);
    expect(instanciados).toHaveLength(0);
  });

  it("som false não toca mesmo com interação", () => {
    const instanciados: unknown[] = [];
    class AudioContextDuble {
      constructor() {
        instanciados.push("constructor");
      }
    }
    Object.defineProperty(window, "AudioContext", {
      value: AudioContextDuble,
      configurable: true,
      writable: true,
    });
    const { bolha } = montarNoDom("bolha");
    dispararMensagem({ tipo: "ajustes", autoAbrirSegundos: 0, som: false }, ORIGEM_CRM);
    document.dispatchEvent(new Event("pointerdown"));
    dispararMensagem({ tipo: "resposta" }, ORIGEM_CRM);
    expect(instanciados).toHaveLength(0);
  });

  it("sem AudioContext não lança", () => {
    const { bolha } = montarNoDom("bolha");
    const original = (window as unknown as Record<string, unknown>).AudioContext;
    try {
      delete (window as unknown as Record<string, unknown>).AudioContext;
      dispararMensagem({ tipo: "ajustes", autoAbrirSegundos: 0, som: true }, ORIGEM_CRM);
      document.dispatchEvent(new Event("pointerdown"));
      dispararMensagem({ tipo: "resposta" }, ORIGEM_CRM);
    } finally {
      if (original) {
        Object.defineProperty(window, "AudioContext", { value: original, configurable: true });
      }
    }
  });

  // ---------- cercas para ajustes e resposta ----------

  it("ajustes de origem forjada é ignorado", () => {
    const { bolha } = montarNoDom("bolha");
    const badge = bolha.querySelector("span") as HTMLSpanElement;
    dispararMensagem({ tipo: "ajustes", autoAbrirSegundos: 5, som: false }, "https://atacante.exemplo.com");
    vi.useFakeTimers();
    vi.advanceTimersByTime(60000);
    expect(badge.style.display).toBe("none");
  });

  it("resposta de outra janela é ignorada", () => {
    const { bolha } = montarNoDom("bolha");
    const badge = bolha.querySelector("span") as HTMLSpanElement;
    dispararMensagem({ tipo: "resposta" }, ORIGEM_CRM, {});
    expect(badge.textContent).toBe("0");
    expect(badge.style.display).toBe("none");
  });

  it("ajustes de source forjada não abre nem muda nada", () => {
    const { iframe } = montarNoDom("bolha");
    dispararMensagem({ tipo: "ajustes", autoAbrirSegundos: 5, som: false }, ORIGEM_CRM, {});
    vi.useFakeTimers();
    vi.advanceTimersByTime(60000);
    expect(iframe.style.display).toBe("none");
  });
});
