import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ warn: vi.fn(), validacao: vi.fn(), validacaoEscura: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: mocks.warn } }));

/**
 * A peça aplica DUAS folhas desde a #4463 (claro e escuro), então o dublê do
 * módulo precisa das duas leituras. `validacaoEscura` nasce vazia nos casos que
 * só olham a folha clara — vazio é `{ css: null, erro: null }`, que não soma
 * nada ao `<style>`.
 */
function dublar(claro: unknown, escuro: unknown = { css: null, erro: null }) {
  vi.doMock("@/lib/branding/css-personalizado", () => ({
    validacaoDoCssDaInstalacao:
      claro instanceof Error
        ? mocks.validacao.mockRejectedValue(claro)
        : mocks.validacao.mockResolvedValue(claro),
    validacaoDoCssEscuroDaInstalacao:
      escuro instanceof Error
        ? mocks.validacaoEscura.mockRejectedValue(escuro)
        : mocks.validacaoEscura.mockResolvedValue(escuro),
  }));
}

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/branding/css-personalizado");
  mocks.warn.mockReset();
  mocks.validacao.mockReset();
  mocks.validacaoEscura.mockReset();
});

async function folha(desligada = false) {
  const { folhaPersonalizadaDaInstalacao } = await import("./folha-personalizada");
  return folhaPersonalizadaDaInstalacao(desligada);
}

describe("a folha personalizada no layout raiz", () => {
  it("devolve a folha validada", async () => {
    dublar({ css: ":root:root .a { color: #123; }", erro: null });
    expect(await folha()).toBe(":root:root .a { color: #123; }");
  });

  it("aplica as duas folhas: a do escuro vai no mesmo <style>, com o escopo dela", async () => {
    dublar(
      { css: ":root:root .a { color: #123; }", erro: null },
      { css: ':root:root[data-theme="dark"] .a { color: #eee; }', erro: null },
    );
    expect(await folha()).toBe(
      ':root:root .a { color: #123; }\n:root:root[data-theme="dark"] .a { color: #eee; }',
    );
  });

  it("só a folha do escuro preenchida também é aplicada", async () => {
    dublar(
      { css: null, erro: null },
      { css: ':root:root[data-theme="dark"] .a { color: #eee; }', erro: null },
    );
    expect(await folha()).toBe(':root:root[data-theme="dark"] .a { color: #eee; }');
  });

  it("folha inválida no banco vira 'sem CSS' com aviso", async () => {
    dublar({ css: null, erro: "x" });
    expect(await folha()).toBeNull();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ codigo: "custom_css_invalid" }),
    );
  });

  it("folha do ESCURO inválida também segura a folha inteira, e o aviso diz qual campo", async () => {
    dublar({ css: ":root:root .a { color: #123; }", erro: null }, { css: null, erro: "x" });
    expect(await folha()).toBeNull();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ codigo: "custom_css_invalid", escopo: "escuro" }),
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
    dublar(new Error("banco fora"));
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
    dublar({ css: ":root:root .a { color: #123; }", erro: null });
    expect(await folha(true)).toBeNull();
    expect(mocks.validacao).not.toHaveBeenCalled();
    expect(mocks.validacaoEscura).not.toHaveBeenCalled();
  });
});
