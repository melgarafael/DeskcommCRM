import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/channels/graph-parceiro/credentials", () => ({
  resolveGraphPartnerCreds: vi.fn(),
  graphPartnerGraphBase: () => "https://cloud.example.test/v1",
}));

import { resolveGraphPartnerCreds } from "@/lib/channels/graph-parceiro/credentials";
import { graphPartnerTemplateOps } from "@/lib/channels/graph-parceiro/templates";

const CREDS = {
  channelSessionId: "sess-1",
  phoneNumberId: "106540352242922",
  wabaId: "366634483210360",
  token: "sk_live_abc",
};

const ESCOPO = { organizationId: "org-1", sessionRef: "106540352242922" };

/** Uma página da coleção de modelos, na forma em que a plataforma a devolve. */
const resposta = (data: unknown[]) =>
  new Response(JSON.stringify({ data }), { status: 200 });

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

  it("apaga UMA variante: resolve o id por nome+idioma e manda o hsm_id junto do name", async () => {
    // O que a plataforma diz (api-reference/whatsapp/templates/deletar-template):
    // sem `hsm_id` o DELETE leva TODOS os idiomas daquele nome; com `hsm_id`
    // "apenas aquela versão é removida, e o name continua obrigatório".
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        // O filtro `name` devolve o nome em TODOS os idiomas — dois ids.
        resposta([
          { id: "5400801403478858", name: "antigo", language: "pt_BR" },
          { id: "900000000000001", name: "antigo", language: "en_US" },
        ]),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));

    await graphPartnerTemplateOps.remove({ ...ESCOPO, name: "antigo", language: "pt_BR" });

    const [consulta] = fetchSpy.mock.calls[0]!;
    expect(String(consulta)).toContain("/message_templates?limit=100");
    expect(String(consulta)).toContain("fields=id,name,language");
    expect(String(consulta)).toContain("&name=antigo");
    const [url, init] = fetchSpy.mock.calls[1]!;
    expect(String(url)).toBe(
      "https://cloud.example.test/v1/366634483210360/message_templates?name=antigo&hsm_id=5400801403478858",
    );
    expect(init?.method).toBe("DELETE");
  });

  it("sem a variante na conta não há id — e sem id nada sai daqui", async () => {
    // O caminho antigo (DELETE pelo nome) apagaria o pt_BR junto com o en_US.
    // Aqui a consulta acha SÓ a en_US, e a recusa vem antes de qualquer DELETE.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(resposta([{ id: "900000000000001", name: "antigo", language: "en_US" }]));

    await expect(
      graphPartnerTemplateOps.remove({ ...ESCOPO, name: "antigo", language: "pt_BR" }),
    ).rejects.toThrow(/graph_partner_template_variante_ausente/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls.every(([url, init]) => init?.method !== "DELETE")).toBe(true);
  });

  it("⭐ edita a variante por ID — POST no nó dela, nunca na coleção", async () => {
    const NOVOS = [{ type: "BODY", text: "Oi {{1}}" }];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        resposta([
          { id: "777", name: "boas_vindas", language: "pt_BR" },
          { id: "888", name: "boas_vindas", language: "en_US" },
          { id: "999", name: "outro", language: "pt_BR" },
        ]),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: true, id: "777", name: "boas_vindas", category: "UTILITY" }),
          { status: 200 },
        ),
      );

    const r = await graphPartnerTemplateOps.update({
      ...ESCOPO,
      name: "boas_vindas",
      language: "pt_BR",
      patch: { components: NOVOS },
    });

    const [consulta] = fetchSpy.mock.calls[0]!;
    expect(String(consulta)).toContain("&name=boas_vindas");
    const [url, init] = fetchSpy.mock.calls[1]!;
    // O caminho da edição é SÓ o id, sem o waba_id (OpenAPI `editar-template`).
    expect(String(url)).toBe("https://cloud.example.test/v1/777");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ components: NOVOS });
    // O nó não devolve o idioma (ele identifica a variante e não muda): ele
    // volta de quem chamou, que o escolheu na tela.
    expect(r).toMatchObject({ name: "boas_vindas", language: "pt_BR" });
  });

  it("sem a variante escolhida a edição também não sai do lugar", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(resposta([{ id: "888", name: "boas_vindas", language: "en_US" }]));

    await expect(
      graphPartnerTemplateOps.update({
        ...ESCOPO,
        name: "boas_vindas",
        language: "pt_BR",
        patch: { components: [{ type: "BODY", text: "Oi" }] },
      }),
    ).rejects.toThrow(/graph_partner_template_variante_ausente/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(
      fetchSpy.mock.calls.every(([, init]) => (init as { method?: string } | undefined)?.method !== "POST"),
    ).toBe(true);
  });

  it("pagina pelo `next` do mesmo host, e nunca leva o token para outro", async () => {
    const pagina = (next: string | undefined, name: string) =>
      new Response(
        JSON.stringify({
          data: [{ name, language: "pt_BR", status: "APPROVED", components: [] }],
          ...(next ? { paging: { next } } : {}),
        }),
        { status: 200 },
      );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(pagina("https://cloud.example.test/v1/366634483210360/message_templates?after=X", "a"))
      .mockResolvedValueOnce(pagina("https://coletor.invalid/rouba?after=Y", "b"))
      .mockResolvedValueOnce(pagina(undefined, "c"));

    const r = await graphPartnerTemplateOps.list(ESCOPO);

    expect(r.map((t) => t.name)).toEqual(["a", "b"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.map(([u]) => new URL(String(u)).host)).toEqual([
      "cloud.example.test",
      "cloud.example.test",
    ]);
  });

  it("erro da API sobe com o código do status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "nome inválido" } }), { status: 400 }),
    );
    await expect(graphPartnerTemplateOps.list(ESCOPO)).rejects.toThrow(/graph_partner_template/);
  });
});
