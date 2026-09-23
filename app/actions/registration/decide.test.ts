/**
 * A APROVAÇÃO do cadastro com aprovação (migration 0383, recorte do PR #714).
 *
 * Aprovar é o único ponto em que a empresa nasce nesse modo. O que estes casos
 * prendem: a empresa nasce só com aprovação, com o nome do PEDIDO (nunca do
 * cliente); recusar não cria nada; e o e-mail só vale se o provedor de auth já
 * o confirmou — o cliente administrativo daqui não tem `updateUserById`, então
 * qualquer tentativa de confirmar e-mail pelo servidor quebraria o caso.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { ensureTenantForUser } from "@/lib/auth/provision";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("next/headers", () => ({ headers: vi.fn(async () => ({ get: () => null })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/requirePlatformAdmin", () => ({
  requirePlatformAdmin: vi.fn(async () => ({ user: { id: "99999999-9999-4999-8999-999999999999" } })),
}));
vi.mock("@/lib/auth/provision", () => ({ ensureTenantForUser: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const PEDIDO = {
  id: "44444444-4444-4444-8444-444444444444",
  user_id: "11111111-1111-4111-8111-111111111111",
  requested_organization_name: "Clínica Boa Vista",
};

function banco({
  pedido = PEDIDO as typeof PEDIDO | null,
  emailConfirmado = true,
}: { pedido?: typeof PEDIDO | null; emailConfirmado?: boolean } = {}) {
  const atualizacao = vi.fn();
  const update = vi.fn((valores: Record<string, unknown>) => {
    atualizacao(valores);
    return { eq: () => ({ eq: async () => ({ error: null }) }) };
  });
  vi.mocked(createAdminClient).mockReturnValue({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: pedido, error: null }) }) }) }),
      update,
    }),
    auth: {
      admin: {
        getUserById: vi.fn(async () => ({
          data: {
            user: {
              id: PEDIDO.user_id,
              email: "dono@exemplo.com.br",
              email_confirmed_at: emailConfirmado ? "2026-09-22T10:00:00Z" : null,
            },
          },
        })),
      },
    },
  } as never);
  return { atualizacao };
}

describe("decideRegistrationRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ensureTenantForUser).mockResolvedValue({
      provisioned: true,
      organizationId: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("⭐ aprovar cria a empresa com o nome do pedido e fecha o pedido", async () => {
    const { atualizacao } = banco();
    const { decideRegistrationRequest } = await import("./decide");

    await expect(
      decideRegistrationRequest({ requestId: PEDIDO.id, decision: "approve" }),
    ).resolves.toEqual({ ok: true });

    const [usuario, opcoes] = vi.mocked(ensureTenantForUser).mock.calls[0]!;
    expect(usuario.id).toBe(PEDIDO.user_id);
    expect(usuario.user_metadata?.org_name).toBe("Clínica Boa Vista");
    expect(opcoes?.source).toBe("signup");
    expect(atualizacao).toHaveBeenCalledWith(expect.objectContaining({ status: "approved" }));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "registration.approved",
        organizationId: "22222222-2222-4222-8222-222222222222",
      }),
    );
  });

  it("⭐ recusar não cria empresa nenhuma", async () => {
    const { atualizacao } = banco();
    const { decideRegistrationRequest } = await import("./decide");

    await expect(
      decideRegistrationRequest({ requestId: PEDIDO.id, decision: "reject" }),
    ).resolves.toEqual({ ok: true });
    expect(ensureTenantForUser).not.toHaveBeenCalled();
    expect(atualizacao).toHaveBeenCalledWith(expect.objectContaining({ status: "rejected" }));
  });

  it("⭐ e-mail que o provedor não confirmou não vira empresa, e o servidor não o confirma", async () => {
    const { atualizacao } = banco({ emailConfirmado: false });
    const { decideRegistrationRequest } = await import("./decide");

    await expect(
      decideRegistrationRequest({ requestId: PEDIDO.id, decision: "approve" }),
    ).resolves.toEqual({ ok: false, error: "account_unavailable" });
    expect(ensureTenantForUser).not.toHaveBeenCalled();
    expect(atualizacao).not.toHaveBeenCalled();
  });

  it("pedido já decidido (ou inexistente) não é decidido de novo", async () => {
    banco({ pedido: null });
    const { decideRegistrationRequest } = await import("./decide");

    await expect(
      decideRegistrationRequest({ requestId: PEDIDO.id, decision: "approve" }),
    ).resolves.toEqual({ ok: false, error: "not_found" });
    expect(ensureTenantForUser).not.toHaveBeenCalled();
  });

  it("nenhum arquivo do cadastro com aprovação confirma e-mail pelo servidor", async () => {
    // O bloqueador publicado no #714: confirmar e-mail sem prova de posse.
    // A confirmação é do provedor de auth, pelo link que ele manda.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const arquivo of [
      "app/actions/registration/decide.ts",
      "lib/auth/registration-requests.ts",
      "app/actions/auth/recoverOrganization.ts",
      "app/actions/auth/signUp.ts",
    ]) {
      const fonte = readFileSync(join(process.cwd(), arquivo), "utf8");
      expect(fonte, arquivo).not.toMatch(/email_confirm\s*:|updateUserById/);
    }
  });

  it("id que não é uuid para no Zod", async () => {
    banco();
    const { decideRegistrationRequest } = await import("./decide");

    await expect(
      decideRegistrationRequest({ requestId: "1 or 1=1", decision: "approve" }),
    ).resolves.toEqual({ ok: false, error: "invalid_input" });
    expect(ensureTenantForUser).not.toHaveBeenCalled();
  });
});
