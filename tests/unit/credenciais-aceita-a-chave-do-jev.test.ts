/**
 * POST /api/v1/ai/credentials ACEITA A CHAVE DO JEV — e continua recusando o resto.
 *
 * O Jev ficou fora de `PROVEDORES` de propósito (ele não conversa), mas a chave
 * dele se cadastra na mesma tela. Com o `z.enum` preso só em quem conversa, a
 * rota devolveria 422 e o cartão do Jev não teria onde guardar a chave — a
 * repetição exata do defeito da OpenRouter que a lista única veio fechar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/v1/ai/credentials/route";
import { guardarCredencial } from "@/lib/ai/credenciais/guardar";
import { requireRole } from "@/lib/auth/require-role";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/ai/credenciais/guardar", () => ({
  guardarCredencial: vi.fn(async () => ({ ok: true, id: "cred-jev", last4: "c0de" })),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      single: async () => ({ data: { id: "cred-jev", provider: "typesafe" }, error: null }),
    };
    return { from: () => chain };
  },
}));

const ORG = "11111111-1111-4111-8111-111111111111";

function postar(corpo: unknown) {
  return POST(
    new NextRequest("http://localhost/api/v1/ai/credentials", {
      method: "POST",
      body: JSON.stringify(corpo),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG, role: "admin", name: "Org" },
    user: { id: "actor", idioma: "pt-BR" },
  } as Awaited<ReturnType<typeof requireRole>>);
});

describe("POST /api/v1/ai/credentials", () => {
  it("aceita provider=typesafe e guarda pelo miolo de sempre (cifra, audita, valida)", async () => {
    const res = await postar({ provider: "typesafe", label: "Jev", api_key: "apikey_de_teste_123456" });
    expect(res.status).toBe(201);
    expect(guardarCredencial).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "typesafe", orgId: ORG, apiKey: "apikey_de_teste_123456" }),
    );
  });

  it("provedor que ninguém declarou segue recusado (a catraca não virou peneira)", async () => {
    const res = await postar({ provider: "foobar", label: "X", api_key: "chave-qualquer-123" });
    expect(res.status).toBe(422);
    expect(guardarCredencial).not.toHaveBeenCalled();
  });
});
