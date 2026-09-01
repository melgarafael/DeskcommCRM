import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { createPayment, PaySuiteApiError } from "@/lib/payments/paysuite/client";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: vi.fn() }));
vi.mock("@/lib/payments/paysuite/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/paysuite/client")>(
    "@/lib/payments/paysuite/client",
  );
  return { ...actual, createPayment: vi.fn() };
});
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn(async () => ({ ok: true })) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const LEAD_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "11111111-1111-4111-8111-111111111111";

function req(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/leads/${LEAD_ID}/charge`, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID } as AuthUser,
    org: { orgId: ORG_ID, name: "Org", role: "agent" },
  } as never);
});

function stubSessionClient(lead: Record<string, unknown> | null) {
  vi.mocked(createClient).mockResolvedValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: lead, error: null }),
          }),
        }),
      }),
    }),
  } as never);
}

function stubAdminClient(opts: {
  cred: { api_token_encrypted: string; webhook_path_token: string; status: string } | null;
  insertedRow?: { id: string; checkout_url: string; status: string };
}) {
  vi.mocked(createAdminClient).mockReturnValue({
    from: (table: string) => {
      if (table === "payment_credentials") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: opts.cred, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "payments") {
        return {
          insert: () => ({
            select: () => ({
              single: async () => ({ data: opts.insertedRow ?? null, error: opts.insertedRow ? null : { message: "boom" } }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as never);
}

const LEAD = { id: LEAD_ID, title: "Negócio X", value_cents: 150000, contact_id: null };
const CRED = { api_token_encrypted: "enc", webhook_path_token: "wpt123", status: "healthy" };

describe("POST /api/v1/leads/[id]/charge", () => {
  it("cria a cobrança e devolve o checkout_url", async () => {
    stubSessionClient(LEAD);
    stubAdminClient({
      cred: CRED,
      insertedRow: { id: "pay-1", checkout_url: "https://pay.example/abc", status: "pending" },
    });
    vi.mocked(decryptWebhookSecret).mockResolvedValue("tok_real");
    vi.mocked(createPayment).mockResolvedValue({ id: "prov-1", checkoutUrl: "https://pay.example/abc" });

    const { POST } = await import("./route");
    const res = await POST(req({}), { params: Promise.resolve({ id: LEAD_ID }) });

    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { checkout_url: string } };
    expect(json.data.checkout_url).toBe("https://pay.example/abc");
    expect(vi.mocked(createPayment)).toHaveBeenCalledWith(
      "tok_real",
      expect.objectContaining({ amount: "1500.00" }),
    );
    expect(vi.mocked(emitLeadActivity)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "payment_charge_created" }),
    );
  });

  it("422 quando o PaySuite não está configurado para a organização", async () => {
    stubSessionClient(LEAD);
    stubAdminClient({ cred: null });

    const { POST } = await import("./route");
    const res = await POST(req({}), { params: Promise.resolve({ id: LEAD_ID }) });

    expect(res.status).toBe(422);
  });

  it("422 quando o lead não tem valor e nenhum amount_cents foi passado", async () => {
    stubSessionClient({ ...LEAD, value_cents: null });
    stubAdminClient({ cred: CRED });

    const { POST } = await import("./route");
    const res = await POST(req({}), { params: Promise.resolve({ id: LEAD_ID }) });

    expect(res.status).toBe(422);
  });

  it("404 quando o lead não existe na organização ativa", async () => {
    stubSessionClient(null);

    const { POST } = await import("./route");
    const res = await POST(req({}), { params: Promise.resolve({ id: LEAD_ID }) });

    expect(res.status).toBe(404);
  });

  it("502 quando o PaySuite recusa a criação da cobrança", async () => {
    stubSessionClient(LEAD);
    stubAdminClient({ cred: CRED });
    vi.mocked(decryptWebhookSecret).mockResolvedValue("tok_real");
    vi.mocked(createPayment).mockRejectedValue(new PaySuiteApiError(401, "unauthorized"));

    const { POST } = await import("./route");
    const res = await POST(req({}), { params: Promise.resolve({ id: LEAD_ID }) });

    expect(res.status).toBe(502);
  });
});
