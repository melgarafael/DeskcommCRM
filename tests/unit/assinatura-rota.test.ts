/**
 * A porta da assinatura do emissor (#2066, PR #2079): `/api/v1/settings/assinatura`.
 *
 * Prova o que a rota faz com o settings: merge que preserva as outras chaves,
 * leitura que falhou não vira gravação, o nome da IA não pode carregar o que
 * quebra a linha `*Nome*\n` (asterisco, quebra de linha), e o papel mínimo.
 * A guarda de suporte é cobrada por `tests/unit/suporte-cobertura-de-efeitos.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const estado: { settings: Record<string, unknown>; erroDeLeitura: boolean; updates: unknown[] } = {
  settings: {},
  erroDeLeitura: false,
  updates: [],
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            estado.erroDeLeitura
              ? { data: null, error: { message: "falhou" } }
              : { data: { settings: estado.settings }, error: null },
        }),
      }),
      update: (patch: { settings: Record<string, unknown> }) => ({
        eq: async () => {
          estado.updates.push(patch);
          estado.settings = patch.settings;
          return { error: null };
        },
      }),
    }),
  }),
}));

const { GET, PATCH } = await import("@/app/api/v1/settings/assinatura/route");

function sessao(role: Role) {
  const user: AuthUser = {
    id: "22222222-2222-4222-8222-222222222222",
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) =>
    ROLE_RANK[role] >= ROLE_RANK[min]
      ? { ok: true, user, org: { orgId: ORG, name: "Org", role } }
      : { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) },
  );
}

const patch = (corpo: unknown) =>
  PATCH(
    new NextRequest("http://localhost/api/v1/settings/assinatura", {
      method: "PATCH",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
  );

beforeEach(() => {
  estado.settings = { routing: { mode: "round_robin" }, campanhas: { x: 1 } };
  estado.erroDeLeitura = false;
  estado.updates = [];
  vi.mocked(audit).mockClear();
});

describe("/api/v1/settings/assinatura", () => {
  it("GET sem a chave devolve o padrão: tudo desligado", async () => {
    sessao("manager");
    const corpo = await (await GET()).json();
    expect(corpo.data).toEqual({ humanos: false, ia: false, nome_ia: "Assistente Virtual" });
  });

  it("PATCH grava a chave SEM apagar as outras, e audita", async () => {
    sessao("manager");
    const res = await patch({ humanos: true, ia: true, nome_ia: "Bia" });
    expect(res.status).toBe(200);
    expect(estado.settings).toEqual({
      routing: { mode: "round_robin" },
      campanhas: { x: 1 },
      assinatura_mensagens: { humanos: true, ia: true, nome_ia: "Bia" },
    });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "settings.message_signature_updated", organizationId: ORG }),
    );
  });

  it.each([
    ["asterisco", { humanos: true, ia: true, nome_ia: "Bia*" }],
    ["quebra de linha", { humanos: true, ia: true, nome_ia: "Bia\nBot" }],
    ["nome vazio", { humanos: true, ia: true, nome_ia: "   " }],
    ["booleano como texto", { humanos: "true", ia: true, nome_ia: "Bia" }],
  ])("PATCH recusa %s (422) e não grava", async (_rotulo, corpo) => {
    sessao("manager");
    expect((await patch(corpo)).status).toBe(422);
    expect(estado.updates).toHaveLength(0);
  });

  it("leitura que falhou NÃO vira gravação (apagaria o settings inteiro)", async () => {
    sessao("manager");
    estado.erroDeLeitura = true;
    expect((await patch({ humanos: true, ia: false, nome_ia: "Bia" })).status).toBe(500);
    expect(estado.updates).toHaveLength(0);
  });

  it("atendente (agent) não liga a assinatura da organização", async () => {
    sessao("agent");
    expect((await patch({ humanos: true, ia: true, nome_ia: "Bia" })).status).toBe(403);
    expect(estado.updates).toHaveLength(0);
  });
});
