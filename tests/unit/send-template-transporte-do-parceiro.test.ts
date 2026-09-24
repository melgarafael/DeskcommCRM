import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/channels/meta/credentials", () => ({ resolveMetaCreds: vi.fn() }));

import { resolveMetaCreds } from "@/lib/channels/meta/credentials";
import { sendTemplateForSession } from "@/lib/channels/meta/send-template-for-session";

/**
 * Modelo pelo canal parceiro Graph-compatível (recorte do #1130): com transporte
 * explícito, sai pelo host e token do PARCEIRO — nunca pela credencial da Meta —
 * e confere a definição da conexão dona dela.
 */
const LINHA = {
  name: "boas_vindas",
  language: "pt_BR",
  status: "APPROVED",
  contract_hash: "h",
  components: [{ type: "BODY", text: "Olá, tudo bem?" }],
};

let filtros: [string, unknown][] = [];
const db = {
  from: () => {
    const q = {
      select: () => q,
      eq: (coluna: string, valor: unknown) => {
        filtros.push([coluna, valor]);
        return q;
      },
      maybeSingle: async () => ({ data: LINHA, error: null }),
    };
    return q;
  },
} as unknown as SupabaseClient;

const ENVIO = {
  organizationId: "org-1",
  sessionRef: "PN",
  to: "5531999998888",
  name: "boas_vindas",
  language: "pt_BR",
  values: {},
  channelSessionId: "sess-1",
  transport: {
    phoneNumberId: "PN",
    token: "sk_live_parceiro",
    graphBase: "https://cloud.example.test/v1",
    errorPrefix: "datafy",
  },
};

beforeEach(() => {
  filtros = [];
  vi.mocked(resolveMetaCreds).mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("modelo com transporte do parceiro", () => {
  it("sai pelo host e token do parceiro, sem consultar a credencial da Meta", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.P" }] }), { status: 200 }));

    expect(await sendTemplateForSession(db, ENVIO)).toBe("wamid.P");

    expect(resolveMetaCreds).not.toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://cloud.example.test/v1/PN/messages");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk_live_parceiro");
    expect(filtros).toContainEqual(["channel_session_id", "sess-1"]);
  });

  it("a recusa da plataforma sobe com o prefixo do canal", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 132001, message: "template does not exist" } }), { status: 400 }),
    );
    await expect(sendTemplateForSession(db, ENVIO)).rejects.toThrow(/^datafy_132001/);
  });
});
