import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { validateGraphPartnerCredentials } from "@/lib/channels/graph-parceiro/validate-credentials";
import { verifyGraphPartnerSignature } from "@/lib/channels/graph-parceiro/webhook";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateGraphPartnerCredentials — descoberta via /me", () => {
  it("descobre número e WABA pelo token e confirma o número", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ phone_number_id: "106540352242922", waba_id: "366634483210360", business_id: "123" }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ display_phone_number: "5531999998888", verified_name: "Loja", quality_rating: "GREEN" }),
          { status: 200 },
        ),
      );

    const r = await validateGraphPartnerCredentials({ token: "sk_live_x", rootUrl: "https://cloud.example.test" });

    expect(r).toEqual({
      ok: true,
      phoneNumberId: "106540352242922",
      wabaId: "366634483210360",
      businessId: "123",
      displayPhoneNumber: "5531999998888",
      verifiedName: "Loja",
      qualityRating: "GREEN",
    });
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://cloud.example.test/me");
    expect(String(fetchSpy.mock.calls[1]![0])).toContain("/v1/106540352242922?fields=");
  });

  it("401 vira recusa de token; rede vira mensagem de indisponibilidade", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 401 }));
    expect(await validateGraphPartnerCredentials({ token: "x", rootUrl: "https://x" })).toEqual({
      ok: false,
      motivo: "Token recusado pelo Datafy.",
    });

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("boom"));
    const r = await validateGraphPartnerCredentials({ token: "x", rootUrl: "https://x" });
    expect(r.ok).toBe(false);
  });

  it("token sem phone_number_id no /me é recusado", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ waba_id: "1" }), { status: 200 }),
    );
    const r = await validateGraphPartnerCredentials({ token: "x", rootUrl: "https://x" });
    expect(r.ok).toBe(false);
  });
});

describe("verifyGraphPartnerSignature", () => {
  const secret = "whsec_test_1234567890";
  const ts = "1700000000";
  const body = '{"object":"whatsapp_business_account"}';

  it("aceita a assinatura correta (HMAC de timestamp.corpo)", () => {
    const sig = "sha256=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    expect(verifyGraphPartnerSignature(body, sig, ts, secret)).toBe(true);
  });

  it("recusa assinatura errada, ausente e secret diferente", () => {
    const sig = "sha256=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    expect(verifyGraphPartnerSignature(body, sig, ts, "outro-secret")).toBe(false);
    expect(verifyGraphPartnerSignature(body, null, ts, secret)).toBe(false);
    expect(verifyGraphPartnerSignature(body, sig, null, secret)).toBe(false);
    expect(verifyGraphPartnerSignature(body, "sha1=abc", ts, secret)).toBe(false);
  });
});
