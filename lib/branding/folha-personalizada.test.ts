import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ warn: vi.fn(), validacao: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: mocks.warn } }));

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/branding/css-personalizado");
  mocks.warn.mockReset();
  mocks.validacao.mockReset();
});

async function folha(desligada = false) {
  const { folhaPersonalizadaDaInstalacao } = await import("./folha-personalizada");
  return folhaPersonalizadaDaInstalacao(desligada);
}

describe("a folha personalizada no layout raiz", () => {
  it("devolve a folha validada", async () => {
    vi.doMock("@/lib/branding/css-personalizado", () => ({
      validacaoDoCssDaInstalacao: mocks.validacao.mockResolvedValue({
        css: ":root:root .a { color: #123; }",
        erro: null,
      }),
    }));
    expect(await folha()).toBe(":root:root .a { color: #123; }");
  });

  it("folha inválida no banco vira 'sem CSS' com aviso", async () => {
    vi.doMock("@/lib/branding/css-personalizado", () => ({
      validacaoDoCssDaInstalacao: mocks.validacao.mockResolvedValue({ css: null, erro: "x" }),
    }));
    expect(await folha()).toBeNull();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ codigo: "custom_css_invalid" }),
    );
  });

  // O caso da imagem standalone sem o PostCSS: o import do validador falha.
  it("validador que não carrega vira 'sem CSS' com aviso, nunca exceção", async () => {
    vi.doMock("@/lib/branding/css-personalizado", () => {
      throw new Error("Cannot find module 'postcss'");
    });
    expect(await folha()).toBeNull();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ codigo: "custom_css_unavailable" }),
    );
  });

  it("leitura que falha também não lança", async () => {
    vi.doMock("@/lib/branding/css-personalizado", () => ({
      validacaoDoCssDaInstalacao: mocks.validacao.mockRejectedValue(new Error("banco fora")),
    }));
    expect(await folha()).toBeNull();
  });

  // O import dinâmico só protege se ninguém no caminho do layout importar o
  // validador estaticamente — senão o PostCSS volta a ser carregado com o layout.
  it("nem o layout raiz nem esta peça importam o validador estaticamente", () => {
    for (const arquivo of ["app/layout.tsx", "lib/branding/folha-personalizada.ts"]) {
      expect(readFileSync(arquivo, "utf8"), arquivo).not.toMatch(
        /^import[^;]*["'](?:@\/lib\/branding|\.)\/css-personalizado["']/m,
      );
    }
  });

  it("desligada (?sem_css=1) não aplica nem consulta a folha", async () => {
    vi.doMock("@/lib/branding/css-personalizado", () => ({
      validacaoDoCssDaInstalacao: mocks.validacao,
    }));
    expect(await folha(true)).toBeNull();
    expect(mocks.validacao).not.toHaveBeenCalled();
  });
});
