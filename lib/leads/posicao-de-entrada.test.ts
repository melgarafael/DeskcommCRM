import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));

import { lerPosicaoDeEntrada } from "./posicao-de-entrada";

function admin(resposta: { data: unknown; error: { message: string } | null }) {
  const b = {
    select: () => b,
    eq: () => b,
    order: (_c: string, o: { ascending: boolean }) => {
      expect(o.ascending).toBe(true);
      return b;
    },
    limit: () => b,
    maybeSingle: async () => resposta,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: () => b } as any;
}

describe("lerPosicaoDeEntrada (#3461)", () => {
  it("um passo acima do primeiro da etapa; 1000 na etapa vazia", async () => {
    expect(await lerPosicaoDeEntrada(admin({ data: { position_in_stage: "2000" }, error: null }), "o", "s")).toBe(1000);
    expect(await lerPosicaoDeEntrada(admin({ data: null, error: null }), "o", "s")).toBe(1000);
  });

  it("leitura com erro devolve null (quem chama move sem posição)", async () => {
    expect(await lerPosicaoDeEntrada(admin({ data: null, error: { message: "x" } }), "o", "s")).toBeNull();
  });
});
