import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Credenciais from "@/lib/channels/graph-parceiro/credentials";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/channels/graph-parceiro/credentials", async (original) => ({
  ...(await original<typeof Credenciais>()),
  resolveGraphPartnerCreds: vi.fn(),
  graphPartnerGraphBase: () => "https://cloud.example.test/v1",
}));
vi.mock("@/lib/channels/meta/send-template-for-session", () => ({
  sendTemplateForSession: vi.fn(),
}));

import { datafyAdapter } from "@/lib/channels/adapters/datafy";
import { resolveGraphPartnerCreds } from "@/lib/channels/graph-parceiro/credentials";
import { sendTemplateForSession } from "@/lib/channels/meta/send-template-for-session";
import type { OutboundEnvelope } from "@/lib/channels/types";

/**
 * Adapter do canal Datafy (recorte do #1130, @vgamkt): o adapter oficial com
 * outro host e outro token — e que NÃO envia com o canal desligado.
 */
const CREDS = {
  channelSessionId: "sess-1",
  phoneNumberId: "106540352242922",
  wabaId: "366634483210360",
  token: "sk_live_abc",
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

const ORIGINAL = process.env.DATAFY_ENABLED;
beforeEach(() => {
  process.env.DATAFY_ENABLED = "true";
  vi.mocked(resolveGraphPartnerCreds).mockReset();
  vi.mocked(resolveGraphPartnerCreds).mockResolvedValue(CREDS);
  vi.mocked(sendTemplateForSession).mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL === undefined) delete process.env.DATAFY_ENABLED;
  else process.env.DATAFY_ENABLED = ORIGINAL;
});

describe("adapter datafy", () => {
  it("endereça por E.164 em dígitos e recusa grupo", () => {
    const base = { groupChatId: null, waIdentity: null };
    expect(datafyAdapter.resolveRecipient({ ...base, isGroup: false, phoneNumber: "+55 (31) 99999-8888" })).toBe(
      "5531999998888",
    );
    expect(datafyAdapter.resolveRecipient({ ...base, isGroup: true, groupChatId: "g", phoneNumber: null })).toBeNull();
    expect(datafyAdapter.resolveRecipient({ ...base, isGroup: false, phoneNumber: null })).toBeNull();
  });

  it("envia texto pela base do parceiro, com o token da sessão no header", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "wamid.X" }] }), { status: 200 }),
    );

    const r = await datafyAdapter.send(envelope());

    expect(r.externalId).toBe("wamid.X");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://cloud.example.test/v1/106540352242922/messages");
    expect(String(url)).not.toContain("sk_live");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk_live_abc");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ messaging_product: "whatsapp", to: "5531999998888" });
    expect(body.text.body).toBe("olá");
  });

  it("mídia sai no dialeto da Cloud API — áudio como nota de voz", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "wamid.A" }] }), { status: 200 }),
    );
    await datafyAdapter.send(envelope({ kind: "audio", body: undefined, media: { url: "https://m/a.ogg", mime: "audio/ogg" } }));
    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body));
    expect(body.audio).toEqual({ link: "https://m/a.ogg", voice: true });
  });

  it("sem credencial LANÇA o código de não configurado (o handler grava queued), nunca um sent sem id", async () => {
    vi.mocked(resolveGraphPartnerCreds).mockResolvedValue(null);
    await expect(datafyAdapter.send(envelope())).rejects.toThrow(/^datafy_not_configured/);
  });

  it("com o canal DESLIGADO na instalação não envia nem consulta credencial", async () => {
    process.env.DATAFY_ENABLED = "";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(datafyAdapter.send(envelope())).rejects.toThrow(/^datafy_not_configured/);
    expect(resolveGraphPartnerCreds).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    const saude = await datafyAdapter.checkHealth!({ organizationId: "org-1", sessionRef: "1" });
    expect(saude).toMatchObject({ reachable: false, status: null });
  });

  it("erro da API vira exceção com o código do provider", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 131047, message: "window closed" } }), { status: 400 }),
    );
    await expect(datafyAdapter.send(envelope())).rejects.toThrow(/datafy_131047/);
  });

  it("sendTemplate usa o transporte do parceiro (host + token), não o da Meta", async () => {
    vi.mocked(sendTemplateForSession).mockResolvedValue("wamid.T");

    const r = await datafyAdapter.sendTemplate!({
      organizationId: "org-1",
      sessionRef: "106540352242922",
      to: "5531999998888",
      name: "pedido_confirmado",
      language: "pt_BR",
      values: { "1": "João" },
    });

    expect(r.externalId).toBe("wamid.T");
    const chamada = vi.mocked(sendTemplateForSession).mock.calls[0];
    expect(chamada?.[1].transport).toEqual({
      phoneNumberId: "106540352242922",
      token: "sk_live_abc",
      graphBase: "https://cloud.example.test/v1",
      errorPrefix: "datafy",
    });
    expect(chamada?.[1].organizationId).toBe("org-1");
    // O espelho é por conexão: sem o escopo, o mesmo modelo espelhado pelo
    // canal oficial dá duas linhas e a consulta do envio falha.
    expect(chamada?.[1].channelSessionId).toBe("sess-1");
  });

  it("sendTemplate com o canal DESLIGADO não envia nem consulta credencial", async () => {
    process.env.DATAFY_ENABLED = "";
    await expect(
      datafyAdapter.sendTemplate!({
        organizationId: "org-1",
        sessionRef: "106540352242922",
        to: "5531999998888",
        name: "pedido_confirmado",
        language: "pt_BR",
        values: {},
      }),
    ).rejects.toThrow(/^datafy_not_configured/);
    expect(resolveGraphPartnerCreds).not.toHaveBeenCalled();
    expect(sendTemplateForSession).not.toHaveBeenCalled();
  });

  it("checkHealth mapeia 401 para FAILED e rede para reachable=false", async () => {
    const checkHealth = datafyAdapter.checkHealth!;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 401 }));
    expect(await checkHealth({ organizationId: "org-1", sessionRef: "1" })).toMatchObject({
      reachable: true,
      status: "FAILED",
    });

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("boom"));
    expect(await checkHealth({ organizationId: "org-1", sessionRef: "1" })).toMatchObject({
      reachable: false,
      status: null,
    });
  });
});
