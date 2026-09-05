import { beforeEach, describe, expect, it, vi } from "vitest";

import { MOEDA_PADRAO } from "@/lib/money";

import { moedaDaOrganizacao } from "./moeda-da-org";

function supabaseCom(data: unknown, error: unknown = null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data, error }),
        }),
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("moedaDaOrganizacao", () => {
  it("devolve a moeda declarada", async () => {
    const moeda = await moedaDaOrganizacao(supabaseCom({ currency: "MXN" }), "org-1");
    expect(moeda).toBe("MXN");
  });

  it("cai no padrão quando a linha não vem, e o fallback é audível", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const moeda = await moedaDaOrganizacao(supabaseCom(null), "org-1");

    expect(moeda).toBe(MOEDA_PADRAO);
    // ⚠️ O CASO QUE O REVISOR ACHOU: a leitura falhando degradava para 'BRL'
    // no MESMO silêncio que a migração 0208 diz ter corrigido — "o dado está
    // certo e o rótulo mente". Falhar calado aqui não deixa o produto sem
    // salvar (comportamento correto, documentado no cabeçalho do arquivo),
    // mas precisa deixar RASTRO: sem isto, uma organização em MXN com RLS
    // negando a leitura grava cada produto novo em BRL, e ninguém percebe até
    // o cliente reclamar do preço errado.
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0]).toContain("moeda-da-org");
  });

  it("cai no padrão quando a query devolve erro, e o fallback é audível", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const moeda = await moedaDaOrganizacao(
      supabaseCom(null, { message: "permission denied" }),
      "org-1",
    );

    expect(moeda).toBe(MOEDA_PADRAO);
    expect(spy).toHaveBeenCalledOnce();
  });
});
