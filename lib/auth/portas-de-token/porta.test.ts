// @vitest-environment node
/**
 * `portaDeToken` — a expressão que deixa uma rota de token passar pelo proxy
 * (Spec 33, fatias R).
 *
 * "Público" em `PUBLIC_PATHS` quer dizer "o proxy não decide": uma porta larga
 * demais torna pública, de carona, a rota irmã que segue só de sessão. Cada
 * regra de `porta.ts` que estreita a expressão tem aqui um caso que a nomeia, e
 * cada regra que RECUSA um modelo tem o caso que mostra a recusa.
 */
import { describe, expect, it } from "vitest";

import {
  FORMA_DE_UUID,
  caminhoDoModelo,
  portaDeToken,
  type ModeloDePorta,
} from "@/lib/auth/portas-de-token/porta";

const UUID = "3f2b8c1e-9a4d-4e7b-8c21-0d5e6f7a8b9c";
const OUTRO_UUID = "7a1c5e90-2b3d-4f68-9a0e-1c2d3e4f5a6b";

/** Modelo com um segmento que NÃO é id: a classe e a amostra que a cerca usa. */
function modeloDePagina(
  segmentos: Record<string, string>,
  amostras: Record<string, string>,
): ModeloDePorta {
  return { caminho: "/api/v1/paginas/[slug]", segmentos, amostras };
}

describe("portaDeToken — o caminho precisa ser de /api/v1", () => {
  it.each(["/api/v2/pipelines", "/api/v1", "/pipelines", "api/v1/pipelines", "/api/internal/pipelines"])(
    "recusa o modelo %s, que não começa por /api/v1/",
    (caminho) => {
      expect(() => portaDeToken(caminho)).toThrow("porta fora de /api/v1");
    },
  );

  it("recusa também o modelo em forma de objeto fora de /api/v1", () => {
    expect(() => portaDeToken({ caminho: "/api/v2/x", segmentos: {}, amostras: {} })).toThrow(
      "porta fora de /api/v1",
    );
  });
});

describe("portaDeToken — catch-all não ganha porta", () => {
  it("lança para um segmento [...slug]", () => {
    expect(() => portaDeToken("/api/v1/docs/[...slug]")).toThrow("catch-all não ganha porta");
  });

  it("lança para um segmento [[...slug]] (catch-all opcional)", () => {
    expect(() => portaDeToken("/api/v1/docs/[[...slug]]")).toThrow("catch-all não ganha porta");
  });
});

describe("portaDeToken — classe com alternativa não leva a âncora junto", () => {
  const porta = portaDeToken({
    caminho: "/api/v1/relatorios/[tipo]",
    segmentos: { tipo: "vendas|perdas" },
    amostras: { tipo: "vendas" },
  });

  it("aceita cada alternativa da classe", () => {
    expect(porta.test("/api/v1/relatorios/vendas")).toBe(true);
    expect(porta.test("/api/v1/relatorios/perdas")).toBe(true);
  });

  it.each([
    "/api/v1/relatorios/vendas/x",
    "/api/v1/relatorios/perdas/x",
    "/x/api/v1/relatorios/perdas",
    "/api/v1/relatorios/perdasx",
  ])("recusa %s: sem os parênteses, o | soltaria uma das pontas", (caminho) => {
    expect(porta.test(caminho)).toBe(false);
  });
});

describe("portaDeToken — o literal é escapado", () => {
  const LITERAIS: Array<[caminho: string, aceita: string, recusa: string]> = [
    ["/api/v1/export.csv", "/api/v1/export.csv", "/api/v1/exportXcsv"],
    ["/api/v1/a+b", "/api/v1/a+b", "/api/v1/aab"],
    ["/api/v1/follow-ups", "/api/v1/follow-ups", "/api/v1/followXups"],
  ];

  it.each(LITERAIS)("o modelo %s aceita só o literal, sem dar a nenhum caractere o sentido de regex", (caminho, aceita, recusa) => {
    const porta = portaDeToken(caminho);

    expect(porta.test(aceita)).toBe(true);
    expect(porta.test(recusa)).toBe(false);
  });
});

describe("portaDeToken — ancorada nos dois lados", () => {
  const porta = portaDeToken("/api/v1/contacts");

  it("a expressão começa com ^ e termina com $", () => {
    expect(porta.source.startsWith("^")).toBe(true);
    expect(porta.source.endsWith("$")).toBe(true);
  });

  it("aceita exatamente o caminho", () => {
    expect(porta.test("/api/v1/contacts")).toBe(true);
  });

  it.each([
    "/api/v1/contacts/",
    "/api/v1/contacts/x",
    "/api/v1/contactsx",
    "/x/api/v1/contacts",
    "x/api/v1/contacts",
    "/api/v1/contact",
  ])("recusa %s: sem âncora, o irmão ou o sub-path entraria de carona", (caminho) => {
    expect(porta.test(caminho)).toBe(false);
  });
});

describe("portaDeToken — segmento dinâmico sem declaração é forma de UUID", () => {
  const porta = portaDeToken("/api/v1/pipelines/[id]/stages");

  it("aceita um UUID em minúsculas", () => {
    expect(porta.test(`/api/v1/pipelines/${UUID}/stages`)).toBe(true);
  });

  it("aceita o mesmo UUID em maiúsculas", () => {
    expect(porta.test(`/api/v1/pipelines/${UUID.toUpperCase()}/stages`)).toBe(true);
  });

  it.each([
    ["um id que não é UUID", "/api/v1/pipelines/abc/stages"],
    ["um irmão literal no lugar do id", "/api/v1/pipelines/bulk/stages"],
    ["o id vazio", "/api/v1/pipelines//stages"],
    ["um sub-path depois de /stages", `/api/v1/pipelines/${UUID}/stages/x`],
    ["a barra no fim", `/api/v1/pipelines/${UUID}/stages/`],
    ["o pai, sem /stages", `/api/v1/pipelines/${UUID}`],
    ["um sufixo colado em /stages", `/api/v1/pipelines/${UUID}/stagesx`],
    ["um UUID com um caractere a mais", `/api/v1/pipelines/${UUID}0/stages`],
    ["um UUID com um caractere a menos", `/api/v1/pipelines/${UUID.slice(0, -1)}/stages`],
    ["um UUID com letra fora de hexadecimal", `/api/v1/pipelines/${UUID.slice(0, -1)}g/stages`],
  ])("recusa %s", (_motivo, caminho) => {
    expect(porta.test(caminho)).toBe(false);
  });

  it("FORMA_DE_UUID aceita um UUID e recusa o que não tem a forma", () => {
    const forma = new RegExp(`^${FORMA_DE_UUID}$`, "i");

    expect(forma.test(UUID)).toBe(true);
    expect(forma.test("abc")).toBe(false);
    expect(forma.test(`${UUID}0`)).toBe(false);
    expect(forma.test("")).toBe(false);
  });

  it("dois segmentos dinâmicos viram dois UUIDs, cada um no seu lugar", () => {
    const duas = portaDeToken("/api/v1/ai/agents/[id]/versions/[versionId]");

    expect(duas.test(`/api/v1/ai/agents/${UUID}/versions/${OUTRO_UUID}`)).toBe(true);
    expect(duas.test(`/api/v1/ai/agents/${UUID}/versions/abc`)).toBe(false);
    expect(duas.test(`/api/v1/ai/agents/abc/versions/${OUTRO_UUID}`)).toBe(false);
    expect(duas.test(`/api/v1/ai/agents/${UUID}/versions`)).toBe(false);
  });
});

describe("portaDeToken — segmento declarado com classe e amostra", () => {
  const classe = "[a-z0-9-]{1,40}";
  const modelo = modeloDePagina({ slug: classe }, { slug: "minha-pagina-1" });

  it("aceita a própria amostra no lugar do segmento", () => {
    expect(portaDeToken(modelo).test("/api/v1/paginas/minha-pagina-1")).toBe(true);
  });

  it.each([
    ["uma barra dentro do segmento", "/api/v1/paginas/a/b"],
    ["o segmento vazio", "/api/v1/paginas/"],
    ["um segmento acima do limite de 40", `/api/v1/paginas/${"a".repeat(41)}`],
    ["um caractere fora da classe", "/api/v1/paginas/a_b"],
    ["um sub-path depois do segmento", "/api/v1/paginas/minha-pagina-1/x"],
  ])("recusa %s", (_motivo, caminho) => {
    expect(portaDeToken(modelo).test(caminho)).toBe(false);
  });

  it("aceita o segmento no limite de 40 caracteres", () => {
    expect(portaDeToken(modelo).test(`/api/v1/paginas/${"a".repeat(40)}`)).toBe(true);
  });

  it("mistura: o [id] sem declaração continua UUID e o [slug] declarado usa a classe", () => {
    const mistura = portaDeToken({
      caminho: "/api/v1/clientes/[id]/paginas/[slug]",
      segmentos: { slug: classe },
      amostras: { slug: "minha-pagina-1" },
    });

    expect(mistura.test(`/api/v1/clientes/${UUID}/paginas/minha-pagina-1`)).toBe(true);
    expect(mistura.test("/api/v1/clientes/abc/paginas/minha-pagina-1")).toBe(false);
    expect(mistura.test(`/api/v1/clientes/${UUID}/paginas/a/b`)).toBe(false);
  });
});

describe("portaDeToken — o que a declaração não pode ser", () => {
  it.each(["[^/]+", ".+", "[a-z]*", "a/b"])(
    "lança para a classe larga %s",
    (classe) => {
      expect(() => portaDeToken(modeloDePagina({ slug: classe }, { slug: "abc" }))).toThrow(
        "classe larga demais: slug",
      );
    },
  );

  it("lança para um segmento declarado que não existe no caminho", () => {
    const modelo = modeloDePagina(
      { slug: "[a-z]{3}", outro: "[a-z]{3}" },
      { slug: "abc", outro: "abc" },
    );

    expect(() => portaDeToken(modelo)).toThrow("segmento outro não existe em /api/v1/paginas/[slug]");
  });

  it("lança para uma amostra de um segmento que não existe no caminho", () => {
    const modelo = modeloDePagina({ slug: "[a-z]{3}" }, { slug: "abc", fantasma: "x" });

    expect(() => portaDeToken(modelo)).toThrow("segmento fantasma não existe em /api/v1/paginas/[slug]");
  });

  it("lança quando o segmento tem classe e falta a amostra dele", () => {
    expect(() => portaDeToken(modeloDePagina({ slug: "[a-z]{3}" }, {}))).toThrow("falta a amostra de slug");
  });

  it.each(["a b", "a/b", "", "ab", "abcd"])(
    "lança quando a amostra %j não cabe na classe",
    (amostra) => {
      expect(() => portaDeToken(modeloDePagina({ slug: "[a-z]{3}" }, { slug: amostra }))).toThrow(
        "não cabe na classe de slug",
      );
    },
  );
});

describe("caminhoDoModelo", () => {
  it("devolve o próprio texto quando o modelo é uma string", () => {
    expect(caminhoDoModelo("/api/v1/pipelines/[id]/stages")).toBe("/api/v1/pipelines/[id]/stages");
  });

  it("devolve o campo caminho quando o modelo é um objeto", () => {
    expect(caminhoDoModelo(modeloDePagina({ slug: "[a-z]{3}" }, { slug: "abc" }))).toBe("/api/v1/paginas/[slug]");
  });
});
