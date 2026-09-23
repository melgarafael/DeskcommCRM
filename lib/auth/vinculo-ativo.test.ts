/**
 * `vinculoAtivo`: falha de leitura NÃO vira o mesmo `null` de "não pertence a
 * organização nenhuma".
 *
 * A volta da entrada com Google bifurca entrada × cadastro por este `null`. Se
 * um erro de leitura chegasse como `null`, o resto da rota trataria quem já é de
 * casa como primeiro acesso — e numa instalação aberta entregaria organização
 * nova (com `role: "admin"`) a quem já tinha uma. O contraste está no próprio
 * módulo: `vinculoVivo` faz `if (error) throw` pela mesma razão.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  linha: null as { organization_id: string } | null,
  erro: null as { message: string } | null,
  filtros: [] as unknown[][],
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const chain = {
        select: () => chain,
        eq: (...args: unknown[]) => {
          h.filtros.push(args);
          return chain;
        },
        is: (...args: unknown[]) => {
          h.filtros.push(args);
          return chain;
        },
        limit: () => chain,
        maybeSingle: async () => ({ data: h.linha, error: h.erro }),
      };
      return chain;
    },
  }),
}));

import { vinculoAtivo } from "./provision";

describe("vinculoAtivo", () => {
  beforeEach(() => {
    h.linha = null;
    h.erro = null;
    h.filtros = [];
  });

  it('falha de leitura LANÇA — não devolve o `null` de "não há vínculo"', async () => {
    h.erro = { message: "conexão caiu" };

    await expect(vinculoAtivo("u1")).rejects.toThrow(/vínculo ativo/);
  });

  it("conta sem vínculo continua devolvendo `null` — o caso legítimo não muda", async () => {
    await expect(vinculoAtivo("u1")).resolves.toBeNull();
  });

  it("vínculo vivo devolve o id da organização, e a leitura filtra revogado", async () => {
    h.linha = { organization_id: "org-1" };

    await expect(vinculoAtivo("u1")).resolves.toBe("org-1");
    expect(h.filtros).toEqual([
      ["user_id", "u1"],
      ["revoked_at", null],
    ]);
  });
});
