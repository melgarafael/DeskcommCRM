import { expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.test" } }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    org: { orgId: "trusted" },
    user: { idioma: "pt-BR" },
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: vi.fn(async () => "encrypted") }));
vi.mock("@/lib/channels/connect", () => ({
  PARTNER_CHANNEL_LABEL: "Parceiro",
  findPartnerSession: vi.fn(async () => null),
  validatePartnerCredentials: vi.fn(async () => ({
    ok: true,
    phoneNumber: null,
    displayName: "Teste",
  })),
  savePartnerSession: vi.fn(async () => ({ error: "private SQL detail", code: "P4020" })),
}));
import { POST } from "./route";
import { savePartnerSession } from "@/lib/channels/connect";
it("preserves quota code from storage and does not return a webhook secret on failure", async () => {
  const response = await POST(
    new NextRequest("https://crm.test/api", {
      method: "POST",
      body: JSON.stringify({ account_id: "account", api_key: "test-only-key" }),
    }),
  );
  const body = await response.json();
  expect(response.status).toBe(409);
  expect(body.error.code).toBe("subscription_resource_limit");
  expect(body.error.message).toContain("Planos e assinatura");
  expect(body.data).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain("private SQL detail");
  expect(savePartnerSession).toHaveBeenCalledWith(
    {},
    expect.objectContaining({ organizationId: "trusted" }),
  );
});
