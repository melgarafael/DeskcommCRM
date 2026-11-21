/**
 * Script da bolha do chat no site (`public/webchat.js`, spec 36, F2, Task 4).
 *
 * O arquivo é JavaScript de navegador, sem módulo. Carregado aqui com `createRequire`,
 * ele expõe as funções puras por `module.exports`. O teste de DOM roda no jsdom, que já é
 * o ambiente padrão deste repositório (`vitest.config.ts`).
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

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
}

const requerer = createRequire(import.meta.url);
const CAMINHO = fileURLToPath(new URL("../../public/webchat.js", import.meta.url));

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
    expect(iframe?.getAttribute("referrerpolicy")).toBe("no-referrer-when-downgrade");
    expect(iframe?.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox",
    );

    const bolha = document.querySelector("button");
    expect(bolha?.getAttribute("aria-label")).toBe("Abrir chat");
  });
});
