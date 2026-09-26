import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Gestão das definições aprovadas — a metade que faltava.
 *
 * O repo até aqui só ESPELHAVA templates: para criar um, o operador tinha que
 * sair do CRM e entrar no painel da plataforma. Este módulo escreve.
 *
 * Os contratos abaixo foram MEDIDOS contra a API real antes de o código
 * existir, e dois deles só apareceram porque o teste foi real e não com mock:
 *
 *  1. A API DEVOLVE `type` em maiúscula (`"BODY"`) e só ACEITA em minúscula:
 *     `400 Invalid discriminator value. Expected 'header' | 'body' | …`
 *     Sem normalizar, o ciclo ler → editar → gravar falha SEMPRE.
 *  2. Um template recém-criado nasce `PENDING` e a Meta recusa editá-lo:
 *     `400 Message templates can only be edited if they have been rejected.`
 *     A regra é dela; o código propaga em vez de replicar.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const credsRef: { current: unknown } = { current: null };
vi.mock("@/lib/channels/zernio/credentials", () => ({
  resolveZernioCreds: async () => credsRef.current,
  zernioCredsFromEnv: () => credsRef.current,
}));

import { zernioTemplateOps } from "@/lib/channels/zernio/templates";
import { capabilitiesOf } from "@/lib/channels/capabilities";

const CREDS = {
  accountId: "acc_1",
  apiKey: "sk_test",
  baseUrl: "https://zernio.com/api",
  source: "session" as const,
};

/**
 * A organização atravessa o seam de canal desde a issue #236: `sessionRef` é
 * identificador do PROVIDER e não identifica linha sozinho.
 */
const ORG = "00000000-0000-4000-8000-000000000236";

const responde = (payload: unknown, ok = true, status = 200) =>
  fetchMock.mockResolvedValueOnce({ ok, status, statusText: "x", json: async () => payload });

const ultima = () => ({
  url: String(fetchMock.mock.calls.at(-1)?.[0] ?? ""),
  init: (fetchMock.mock.calls.at(-1)?.[1] ?? {}) as { method?: string; body?: string },
});
const corpo = () => JSON.parse(ultima().init.body ?? "{}") as Record<string, unknown>;

beforeEach(() => {
  fetchMock.mockReset();
  credsRef.current = CREDS;
});

describe("capability", () => {
  it("o canal declara que SABE gerir definições — é o que a tela pergunta", () => {
    expect(capabilitiesOf("zernio").canManageTemplates).toBe(true);
  });

  it("o canal por QR declara que NÃO — não há WABA por trás", () => {
    expect(capabilitiesOf("waha").canManageTemplates).toBe(false);
  });

  it("é distinta de requiresTemplates: exigir template e poder criá-lo são coisas diferentes", () => {
    const qr = capabilitiesOf("waha");
    expect(qr.requiresTemplates).toBe(false);
    expect(qr.canManageTemplates).toBe(false);
    // O par que prova a independência: exige template E deixa criar.
    const bsp = capabilitiesOf("zernio");
    expect(bsp.requiresTemplates).toBe(true);
    expect(bsp.canManageTemplates).toBe(true);
  });
});

describe("list", () => {
  it("traduz para o vocabulário neutro, sem inventar campos", async () => {
    responde({
      templates: [
        { name: "cuenta_activa", language: "es", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY" }] },
      ],
    });
    const t = await zernioTemplateOps.list({ organizationId: ORG, sessionRef: "acc_1" });
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ name: "cuenta_activa", language: "es", status: "APPROVED" });
  });

  it("status desconhecido NÃO explode — o vocabulário da plataforma é aberto", async () => {
    responde({ templates: [{ name: "x", language: "es", status: "ALGO_NOVO", components: [] }] });
    const t = await zernioTemplateOps.list({ organizationId: ORG, sessionRef: "acc_1" });
    expect(t[0]!.status).toBe("ALGO_NOVO");
  });

  it("resposta sem templates devolve lista vazia, não undefined", async () => {
    responde({});
    await expect(zernioTemplateOps.list({ organizationId: ORG, sessionRef: "acc_1" })).resolves.toEqual([]);
  });
});

describe("create — a assimetria maiúscula/minúscula", () => {
  it("normaliza o `type` dos components para minúscula na ESCRITA", async () => {
    responde({ template: { name: "t", language: "es", status: "PENDING", components: [] } });
    await zernioTemplateOps.create({
      organizationId: ORG,
      sessionRef: "acc_1",
      draft: {
        name: "t",
        language: "es",
        category: "UTILITY",
        components: [{ type: "BODY", text: "oi" }, { type: "FOOTER", text: "rodapé" }],
      },
    });
    const comps = corpo().components as { type: string }[];
    expect(comps.map((c) => c.type)).toEqual(["body", "footer"]);
  });

  it("preserva TODO o resto do component — só a chave `type` é tocada", async () => {
    responde({ template: {} });
    await zernioTemplateOps.create({
      organizationId: ORG,
      sessionRef: "acc_1",
      draft: {
        name: "t",
        language: "es",
        category: "UTILITY",
        components: [{ type: "BODY", text: "oi {{1}}", example: { body_text: [["M"]] } }],
      },
    });
    expect((corpo().components as Record<string, unknown>[])[0]).toEqual({
      type: "body",
      text: "oi {{1}}",
      example: { body_text: [["M"]] },
    });
  });

  it("component sem `type` passa intacto em vez de quebrar", async () => {
    responde({ template: {} });
    await zernioTemplateOps.create({
      organizationId: ORG,
      sessionRef: "acc_1",
      draft: { name: "t", language: "es", category: "UTILITY", components: [{ texto: "x" }, null] },
    });
    expect(corpo().components).toEqual([{ texto: "x" }, null]);
  });

  it("manda accountId, nome, categoria e idioma", async () => {
    responde({ template: {} });
    await zernioTemplateOps.create({
      organizationId: ORG,
      sessionRef: "acc_1",
      draft: { name: "t", language: "es", category: "MARKETING", components: [] },
    });
    expect(corpo()).toMatchObject({
      accountId: "acc_1",
      name: "t",
      language: "es",
      category: "MARKETING",
    });
    expect(ultima().init.method).toBe("POST");
  });
});

describe("update e remove", () => {
  it("update normaliza o `type` igual ao create — senão o round-trip quebra", async () => {
    responde({ template: {} });
    await zernioTemplateOps.update({
      organizationId: ORG,
      sessionRef: "acc_1",
      name: "t",
      language: "es",
      patch: { components: [{ type: "BODY", text: "novo" }] },
    });
    expect((corpo().components as { type: string }[])[0]!.type).toBe("body");
    expect(ultima().init.method).toBe("PATCH");
  });

  it("remove usa DELETE e escapa o nome na URL", async () => {
    responde({ success: true });
    await zernioTemplateOps.remove({ organizationId: ORG, sessionRef: "acc_1", name: "a/b", language: "es" });
    expect(ultima().init.method).toBe("DELETE");
    expect(ultima().url).toContain("a%2Fb");
  });
});

describe("erros da plataforma", () => {
  it("a regra 'só edita se foi rejeitado' chega ao chamador com o texto dela", async () => {
    responde(
      { error: "Message templates can only be edited if they have been rejected." },
      false,
      400,
    );
    await expect(
      zernioTemplateOps.update({ organizationId: ORG, sessionRef: "acc_1", name: "t", language: "es", patch: { category: "UTILITY" } }),
    ).rejects.toThrow(/can only be edited/);
  });

  it("o `code` entra na mensagem — é o que diz ao operador o que corrigir", async () => {
    responde({ error: "nome já usado", code: "TEMPLATE_EXISTS" }, false, 400);
    await expect(
      zernioTemplateOps.create({
        organizationId: ORG,
        sessionRef: "acc_1",
        draft: { name: "t", language: "es", category: "UTILITY", components: [] },
      }),
    ).rejects.toThrow(/TEMPLATE_EXISTS/);
  });

  it("sem credencial falha nomeando o motivo, sem tocar a rede", async () => {
    credsRef.current = null;
    await expect(zernioTemplateOps.list({ organizationId: ORG, sessionRef: "acc_1" })).rejects.toThrow(
      /zernio_not_configured/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("o changelog de 28/08 do provedor", () => {
  it("o PATCH leva `language` no corpo — com variantes, editar sem idioma acerta a errada", async () => {
    responde({ template: {} });
    await zernioTemplateOps.update({
      organizationId: ORG,
      sessionRef: "acc_1",
      name: "promo",
      language: "es",
      patch: { category: "UTILITY" },
    });
    expect(corpo().language).toBe("es");
  });

  it("o DELETE sempre nomeia a variante — sem idioma, a API apaga TODAS", async () => {
    responde({ success: true });
    await zernioTemplateOps.remove({ organizationId: ORG, sessionRef: "acc_1", name: "promo", language: "es" });
    expect(ultima().url).toContain("language=es");
  });
});
