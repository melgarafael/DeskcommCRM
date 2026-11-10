import { describe, expect, it, vi } from "vitest";

import { resolverContatoParaAgendamento } from "./resolver-contato";

vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: vi.fn(async () => null),
  encontrarContatoPorTelefoneComNome: vi.fn(),
}));

describe("resolverContatoParaAgendamento", () => {
  it("cria contato com os campos obrigatórios do cadastro", async () => {
    const insert = vi.fn(() => ({
      select: () => ({
        single: async () => ({ data: { id: "contact-1" }, error: null }),
      }),
    }));
    const supabase = {
      from: (tabela: string) => {
        expect(tabela).toBe("contacts");
        return { insert };
      },
    };

    const out = await resolverContatoParaAgendamento(
      supabase as never,
      "org-1",
      { client_name: "Maria", client_phone: "11999998888" },
      "user-1",
    );

    expect(out).toEqual({ contact_id: "contact-1", created: true });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: "org-1",
        created_by_user_id: "user-1",
        name: "Maria",
        phone_number: "+5511999998888",
        source: "manual",
        tags: [],
      }),
    );
  });
});
