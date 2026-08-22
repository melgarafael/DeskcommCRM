import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/v1/admin/tenants — o e-mail do responsável era coletado, entrava
 * no hash do audit, e NENHUM convite saía: o tenant nascia sem ninguém capaz
 * de logar nele. Este teste prova que o convite agora é disparado sempre, e
 * que a criação de assinatura Asaas só roda com BILLING_MODE=asaas (default
 * "disabled" — self-host nunca chama a Asaas).
 */

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({
  requirePlatformAdmin: vi.fn(async () => ({ user: { id: "admin-1" } })),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/invite-token", () => ({
  signInviteToken: vi.fn(() => "fake-token"),
  INVITE_TTL_SECONDS: 86400,
}));
vi.mock("@/lib/email/templates/invite", () => ({
  buildInviteEmail: vi.fn(() => ({ subject: "s", html: "h", text: "t" })),
}));
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: vi.fn(async () => ({ nome: "Genesisia" })),
}));

const sendEmailMock = vi.fn(async () => ({ ok: true }));
vi.mock("@/lib/email/resend", () => ({ sendEmail: (...args: unknown[]) => sendEmailMock(...args) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";

function orgBuilder() {
  return {
    insert: () => ({
      select: () => ({
        single: async () => ({
          data: { id: ORG_ID, slug: "loja-da-maria", display_name: "Loja da Maria" },
          error: null,
        }),
      }),
    }),
  };
}

let adminClientImpl: () => Record<string, unknown>;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => adminClientImpl(),
}));

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("https://app.test/api/v1/admin/tenants", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const baseBody = {
  display_name: "Loja da Maria",
  slug: "loja-da-maria",
  owner_email: "dona@loja.com",
  plan: "standard" as const,
};

describe("POST /api/v1/admin/tenants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmailMock.mockResolvedValue({ ok: true });
    delete process.env.BILLING_MODE;
    // Este sandbox tem um .env real (credenciais de produção) cujo formato
    // não bate mais com o schema atual de lib/env.ts (ex.: NUVEMSHOP_ENABLED
    // fora de "true"/"false") — o setup de teste carrega esse arquivo antes
    // dos placeholders, e falha ao validar. Sobrescrever aqui não toca o
    // arquivo `.env`; só corrige o que ESTE teste, isolado, precisa para
    // importar lib/env.ts com vi.resetModules().
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test-placeholder.invalid";
    process.env.NEXT_PUBLIC_APP_URL = "https://test-placeholder.invalid";
    process.env.NEXT_PUBLIC_ADMIN_URL = "https://test-placeholder.invalid";
    process.env.NUVEMSHOP_ENABLED = "false";
    process.env.INTERNAL_AGENT_RUN_STUB = "false";
    adminClientImpl = () => ({ from: (table: string) => (table === "organizations" ? orgBuilder() : {}) });
  });

  it("sempre convida o responsável, mesmo sem plan_id", async () => {
    vi.resetModules();
    const { POST } = await import("./route");
    const res = await POST(makeRequest(baseBody));
    const json = (await res.json()) as { data: { owner_invite_dispatched: boolean } };

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0]?.[0]).toMatchObject({ to: "dona@loja.com" });
    expect(json.data.owner_invite_dispatched).toBe(true);
  });

  it("não cria assinatura Asaas quando BILLING_MODE é o default (disabled)", async () => {
    vi.resetModules();
    const { POST } = await import("./route");
    const res = await POST(
      makeRequest({
        ...baseBody,
        cnpj: "00.000.000/0001-00",
        plan_id: "33333333-3333-4333-8333-333333333333",
      }),
    );
    const json = (await res.json()) as { data: { billing_error: string | null } };

    // Sem BILLING_MODE=asaas, isBillingEnabled() é falso e o bloco de billing
    // nem tenta rodar — billing_error fica null, não populado por uma falha.
    expect(json.data.billing_error).toBeNull();
  });

  it("recusa plan_id sem CNPJ quando billing está habilitado", async () => {
    process.env.BILLING_MODE = "asaas";
    vi.resetModules();
    const { POST } = await import("./route");
    const res = await POST(
      makeRequest({
        ...baseBody,
        plan_id: "33333333-3333-4333-8333-333333333333",
      }),
    );

    expect(res.status).toBe(400);
  });
});
