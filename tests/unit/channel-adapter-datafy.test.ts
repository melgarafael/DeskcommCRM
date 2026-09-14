import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/channels/graph-parceiro/credentials", () => ({
  resolveGraphPartnerCreds: vi.fn(),
  graphPartnerGraphBase: () => "https://cloud.example.test/v1",
}));

import { datafyAdapter } from "@/lib/channels/adapters/datafy";
import { resolveGraphPartnerCreds } from "@/lib/channels/graph-parceiro/credentials";
import type { OutboundEnvelope } from "@/lib/channels/types";

const CREDS = {
  phoneNumberId: "106540352242922",
  token: "sk_live_abc",
  rootUrl: "https://cloud.example.test",
  source: "session" as const,
};

function envelope(over: Partial<OutboundEnvelope> = {}): OutboundEnvelope {
  return {
    organizationId: "org-1",
    sessionRef: "106540352242922",
    to: "5531999998888",
    kind: "text",
    body: "olá",
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(resolveGraphPartnerCreds).mockReset();
  vi.mocked(resolveGraphPartnerCreds).mockResolvedValue(CREDS);
  vi.restoreAllMocks();
});

describe("adapter datafy", () => {
  it("endereça por E.164 em dígitos e recusa grupo", () => {
    expect(datafyAdapter.resolveRecipient({ isGroup: false, groupChatId: null, phoneNumber: "+55 (31) 99999-8888", waIdentity: null })).toBe("5531999998888");
    expect(datafyAdapter.resolveRecipient({ isGroup: true, groupChatId: "g", phoneNumber: null, waIdentity: null })).toBeNull();
    expect(datafyAdapter.resolveRecipient({ isGroup: false, groupChatId: null, phoneNumber: null, waIdentity: null })).toBeNull();
  });

  it("envia texto pela base do parceiro com o token da sessão", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "wamid.X" }] }), { status: 200 }),
    );

    const r = await datafyAdapter.send(envelope());

    expect(r.externalId).toBe("wamid.X");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://cloud.example.test/v1/106540352242922/messages");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk_live_abc");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ messaging_product: "whatsapp", to: "5531999998888" });
    expect(body.text.body).toBe("olá");
  });

  it("sem credencial é NOOP (não lança)", async () => {
    vi.mocked(resolveGraphPartnerCreds).mockResolvedValue(null);
    const r = await datafyAdapter.send(envelope());
    expect(r.externalId).toBeNull();
  });

  it("erro da API vira exceção com o código do provider", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 131047, message: "window closed" } }), {
        status: 400,
      }),
    );
    await expect(datafyAdapter.send(envelope())).rejects.toThrow(/datafy_131047/);
  });

  it("checkHealth mapeia 401 para FAILED e rede para reachable=false", async () => {
    const health = datafyAdapter.checkHealth!;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
    expect(await health({ organizationId: "org-1", sessionRef: "1" })).toMatchObject({
      reachable: true,
      status: "FAILED",
    });

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    expect(await health({ organizationId: "org-1", sessionRef: "1" })).toMatchObject({
      reachable: false,
      status: null,
    });
  });
});
