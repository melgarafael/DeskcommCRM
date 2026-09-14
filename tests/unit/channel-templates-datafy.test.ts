import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/channels/graph-parceiro/credentials", () => ({
  resolveGraphPartnerCreds: vi.fn(),
}));

import { resolveGraphPartnerCreds } from "@/lib/channels/graph-parceiro/credentials";
import { graphPartnerTemplateOps } from "@/lib/channels/graph-parceiro/templates";

const CREDS = {
  phoneNumberId: "106540352242922",
  wabaId: "366634483210360",
  token: "sk_live_abc",
  rootUrl: "https://cloud.example.test",
  source: "session" as const,
};

const ESCOPO = { organizationId: "org-1", sessionRef: "106540352242922" };

beforeEach(() => {
  vi.mocked(resolveGraphPartnerCreds).mockReset();
  vi.mocked(resolveGraphPartnerCreds).mockResolvedValue(CREDS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("modelos do parceiro Graph-compatível", () => {
  it("lista pela WABA, com o token do parceiro, e traduz o vocabulário", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              name: "pedido_confirmado",
              language: "pt_BR",
              status: "APPROVED",
              category: "UTILITY",
              components: [{ type: "BODY", text: "Olá {{1}}" }],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const r = await graphPartnerTemplateOps.list(ESCOPO);

    expect(r).toEqual([
      {
        name: "pedido_confirmado",
        language: "pt_BR",
        status: "APPROVED",
        category: "UTILITY",
        components: [{ type: "BODY", text: "Olá {{1}}" }],
        rejectedReason: null,
        parameterFormat: null,
      },
    ]);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("/v1/366634483210360/message_templates");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk_live_abc");
  });

  it("cria na coleção da WABA com os componentes em MAIÚSCULA", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ name: "novo", language: "pt_BR", status: "PENDING" }), {
        status: 200,
      }),
    );

    const r = await graphPartnerTemplateOps.create({
      ...ESCOPO,
      draft: {
        name: "novo",
        language: "pt_BR",
        category: "UTILITY",
        components: [{ type: "BODY", text: "Olá" }],
      },
    });

    expect(r.status).toBe("PENDING");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://cloud.example.test/v1/366634483210360/message_templates");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    expect(body.components[0].type).toBe("BODY");
    expect(body.name).toBe("novo");
  });

  it("apaga pelo nome", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    await graphPartnerTemplateOps.remove({ ...ESCOPO, name: "antigo" });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("/message_templates?name=antigo");
    expect(init?.method).toBe("DELETE");
  });

  it("erro da API sobe com o código do status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "nome inválido" } }), { status: 400 }),
    );
    await expect(graphPartnerTemplateOps.list(ESCOPO)).rejects.toThrow(/graph_partner_template/);
  });
});
