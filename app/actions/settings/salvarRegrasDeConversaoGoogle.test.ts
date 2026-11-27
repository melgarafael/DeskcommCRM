import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  audit: vi.fn(),
  pode: vi.fn(),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "ator" }),
  resolveActiveOrg: async () => ({ orgId: "org-sessao" }),
  mfaEmDivida: async () => false,
}));
vi.mock("@/lib/auth/pode-administrar-empresa", () => ({ podeAdministrarEmpresa: mocks.pode }));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/http/ip-do-cliente", () => ({ ipDoCliente: () => null }));

import { salvarRegrasDeConversaoGoogle } from "./salvarRegrasDeConversaoGoogle";

const stage = "11111111-1111-4111-8111-111111111111";
const regra = {
  stage_id: stage,
  enabled: true,
  label: "Contato",
  google_action_id: "42",
  category: "CONTACT" as const,
  included_in_conversions: true,
  channel: "todos" as const,
};
let consultas: Array<{ tabela: string; filtros: Record<string, unknown>; campos?: string; operacao?: "update" }>;
let existentes: Array<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  consultas = [];
  existentes = [
    {
      id: "antiga",
      stage_id: stage,
      event_name: "QualifiedLead",
      label: "Legado",
      google_action_id: "1",
      google_customer_id: null,
    },
  ];
  mocks.pode.mockReturnValue(true);
  mocks.upsert.mockResolvedValue({ error: null });
  mocks.admin.mockReturnValue({
    from: (tabela: string) => {
      const filtros: Record<string, unknown> = {};
      const consulta: (typeof consultas)[number] = { tabela, filtros };
      consultas.push(consulta);
      const q = {
        select: (campos: string) => {
          consulta.campos = campos;
          return q;
        },
        eq: (k: string, v: unknown) => {
          filtros[k] = v;
          return q;
        },
        in: (k: string, v: unknown) => {
          filtros[k] = v;
          return Promise.resolve({ data: [{ id: stage }], error: null });
        },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({
            data: existentes,
            error: null,
          }).then(resolve),
        maybeSingle: async () => ({ data: { google_customer_id: "123-456-7890" }, error: null }),
        upsert: mocks.upsert,
        update: (v: unknown) => {
          consulta.operacao = "update";
          mocks.update(v);
          return q;
        },
      };
      return q;
    },
  });
});

describe("regras Google por etapa e destino", () => {
  it("permite duas contas na etapa, preserva a identidade do evento e desliga só a chave que saiu", async () => {
    expect(
      await salvarRegrasDeConversaoGoogle([
        { ...regra, google_customer_id: "1234567890" },
        { ...regra, google_customer_id: "111-222-3333", google_action_id: "77" },
      ]),
    ).toEqual({ ok: true });
    expect(mocks.upsert).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          organization_id: "org-sessao",
          event_name: "QualifiedLead",
          google_customer_id: "1234567890",
          google_login_customer_id: null,
        }),
        expect.objectContaining({
          organization_id: "org-sessao",
          event_name: "QualifiedLead",
          google_customer_id: "1112223333",
          google_action_id: "77",
        }),
      ],
      { onConflict: "organization_id,stage_id,google_customer_id" },
    );
    expect(consultas.find((c) => c.tabela === "google_ads_conversion_rules" && c.operacao === "update")?.filtros.id)
      .toEqual(["antiga"]);
    expect(
      consultas.every(
        (c) => c.filtros.organization_id === "org-sessao" || Object.keys(c.filtros).length === 0,
      ),
    ).toBe(true);
    expect(consultas.map((c) => c.tabela)).not.toContain("google_ads_reporting_accounts");
  });

  it("recusa duas regras para o mesmo destino normalizado antes de acessar o banco", async () => {
    expect(
      await salvarRegrasDeConversaoGoogle([
        { ...regra, google_customer_id: "111-222-3333" },
        { ...regra, google_customer_id: "1112223333" },
      ]),
    ).toMatchObject({ ok: false, error: "validation_failed" });
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("pausa a regra legada sem rede externa nem credencial de Google Ads", async () => {
    expect(await salvarRegrasDeConversaoGoogle([{ ...regra, enabled: false }])).toEqual({
      ok: true,
    });
    expect(mocks.upsert).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          enabled: false,
          google_customer_id: null,
          google_login_customer_id: null,
        }),
      ],
      expect.anything(),
    );
    expect(consultas.map((c) => c.tabela)).toEqual([
      "google_ads_conversion_rules",
      "google_ads_conversion_rules",
    ]);
  });

  it("rejeita global A mais explícita A antes de qualquer escrita, consultando só o ID nativo scoped", async () => {
    expect(
      await salvarRegrasDeConversaoGoogle([
        regra,
        { ...regra, google_customer_id: "1234567890", google_action_id: "77" },
      ]),
    ).toMatchObject({ ok: false, error: "validation_failed" });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(consultas.filter((c) => c.tabela === "ad_platform_connections")).toEqual([
      {
        tabela: "ad_platform_connections",
        campos: "google_customer_id",
        filtros: { organization_id: "org-sessao", platform: "google_ads" },
      },
    ]);
  });

  it("aceita global A mais explícita B na mesma etapa", async () => {
    expect(
      await salvarRegrasDeConversaoGoogle([
        regra,
        { ...regra, google_customer_id: "1112223333", google_action_id: "77" },
      ]),
    ).toEqual({ ok: true });
    expect(mocks.upsert).toHaveBeenCalledWith(
      [
        expect.objectContaining({ google_customer_id: null }),
        expect.objectContaining({ google_customer_id: "1112223333" }),
      ],
      expect.anything(),
    );
  });

  it.each([
    { global: true, explicita: false },
    { global: false, explicita: true },
  ])("preserva regras pausadas sem resolver o ID global (%j)", async (ativa) => {
    existentes.push({ ...existentes[0], id: "explicita", google_customer_id: "1234567890" });
    expect(
      await salvarRegrasDeConversaoGoogle([
        { ...regra, enabled: ativa.global },
        {
          ...regra,
          enabled: ativa.explicita,
          google_customer_id: "1234567890",
          google_action_id: "77",
        },
      ]),
    ).toEqual({ ok: true });
    expect(mocks.upsert).toHaveBeenCalledWith(
      [
        expect.objectContaining({ google_customer_id: null, enabled: ativa.global }),
        expect.objectContaining({ google_customer_id: "1234567890", enabled: ativa.explicita }),
      ],
      expect.anything(),
    );
    expect(consultas.some((c) => c.tabela === "ad_platform_connections")).toBe(false);
  });
});
