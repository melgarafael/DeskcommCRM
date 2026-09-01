import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: vi.fn() }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn(async () => ({ ok: true })) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "abcdef0123456789abcdef0123456789";
const SECRET = "webhook-secret";

function assinar(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

function makeAdminStub(opts: {
  cred?: { organization_id: string; webhook_secret_encrypted: string } | null;
  updateResult?: { id: string; lead_id: string | null; amount_cents: number } | null;
}) {
  return {
    from(table: string) {
      if (table === "payment_credentials") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: opts.cred ?? null, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "payments") {
        return {
          update: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  select: () => ({
                    maybeSingle: async () => ({ data: opts.updateResult ?? null, error: null }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function req(body: string, signature: string | null): NextRequest {
  const headers: Record<string, string> = {};
  if (signature) headers["x-signature"] = signature;
  return new NextRequest("http://localhost/api/v1/webhooks/payments/paysuite/" + TOKEN, {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /api/v1/webhooks/payments/paysuite/[token]", () => {
  it("404 para token curto (nunca emitido por nós)", async () => {
    const { POST } = await import("./route");
    const res = await POST(req("{}", null), { params: Promise.resolve({ token: "ab" }) });
    expect(res.status).toBe(404);
  });

  it("404 quando o token não resolve credencial nenhuma", async () => {
    vi.mocked(createAdminClient).mockReturnValue(makeAdminStub({ cred: null }) as never);
    const { POST } = await import("./route");
    const res = await POST(req("{}", "sig"), { params: Promise.resolve({ token: TOKEN }) });
    expect(res.status).toBe(404);
  });

  it("401 quando a assinatura é inválida", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub({ cred: { organization_id: ORG_ID, webhook_secret_encrypted: "enc" } }) as never,
    );
    vi.mocked(decryptWebhookSecret).mockResolvedValue(SECRET);
    const { POST } = await import("./route");
    const body = JSON.stringify({ event: "payment.success", data: { id: "x" } });
    const res = await POST(req(body, "assinatura-errada"), { params: Promise.resolve({ token: TOKEN }) });
    expect(res.status).toBe(401);
  });

  it("401 quando o segredo não decifra (chave de cifra indisponível)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub({ cred: { organization_id: ORG_ID, webhook_secret_encrypted: "enc" } }) as never,
    );
    vi.mocked(decryptWebhookSecret).mockResolvedValue(null);
    const { POST } = await import("./route");
    const body = JSON.stringify({ event: "payment.success", data: { id: "x" } });
    const res = await POST(req(body, assinar(body)), { params: Promise.resolve({ token: TOKEN }) });
    expect(res.status).toBe(401);
  });

  it("200 'ignorado' para evento desconhecido, mesmo com assinatura válida", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub({ cred: { organization_id: ORG_ID, webhook_secret_encrypted: "enc" } }) as never,
    );
    vi.mocked(decryptWebhookSecret).mockResolvedValue(SECRET);
    const { POST } = await import("./route");
    const body = JSON.stringify({ event: "payment.refunded", data: { id: "x" } });
    const res = await POST(req(body, assinar(body)), { params: Promise.resolve({ token: TOKEN }) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { status: string; reason: string } };
    expect(json.data.reason).toBe("evento_desconhecido");
  });

  it("200 'ignorado' quando não há payments correspondente (não reentrega para sempre)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub({
        cred: { organization_id: ORG_ID, webhook_secret_encrypted: "enc" },
        updateResult: null,
      }) as never,
    );
    vi.mocked(decryptWebhookSecret).mockResolvedValue(SECRET);
    const { POST } = await import("./route");
    const body = JSON.stringify({ event: "payment.success", data: { id: "nao-existe" } });
    const res = await POST(req(body, assinar(body)), { params: Promise.resolve({ token: TOKEN }) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { reason: string } };
    expect(json.data.reason).toBe("pagamento_nao_encontrado");
  });

  it("200 'processed' e emite atividade de pagamento confirmado no lead", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub({
        cred: { organization_id: ORG_ID, webhook_secret_encrypted: "enc" },
        updateResult: { id: "pay-1", lead_id: "lead-1", amount_cents: 150000 },
      }) as never,
    );
    vi.mocked(decryptWebhookSecret).mockResolvedValue(SECRET);
    const { POST } = await import("./route");
    const body = JSON.stringify({ event: "payment.success", data: { id: "prov-1" } });
    const res = await POST(req(body, assinar(body)), { params: Promise.resolve({ token: TOKEN }) });
    expect(res.status).toBe(200);
    expect(vi.mocked(emitLeadActivity)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ leadId: "lead-1", type: "payment_confirmed" }),
    );
  });
});
