import { describe, expect, it, vi } from "vitest";

/**
 * MCP: `crm_get_contact` devolve os telefones da ficha para a IA (Spec 31, B1).
 *
 * O tipo e o WhatsApp do principal, e os extras com a forma da API (`tipo→type`,
 * `rotulo→label`, `origem→origin`), ordenados por `created_at`, SEM `wa_lid`.
 * O cliente do MCP é o administrador (service role, sem RLS): o filtro de
 * organização é conferido nas duas leituras.
 *
 * ─── SABOTAGEM (o que faz este arquivo ficar vermelho) ─────────────────────
 * - Devolver `wa_lid` em `additional_phones`: o caso "sem wa_lid" cai.
 * - Tirar o `.eq("organization_id", …)` de `contact_phones`: o caso "filtra
 *   por organização" cai (é o vazamento entre clientes que o banco não barra
 *   aqui, porque o service role ignora a RLS).
 * - Trocar `additional_phones` por `[]` fixo: o caso "com extras" cai.
 */

vi.mock("@/app/api/v1/contacts/_handler", () => ({
  getContactHandler: vi.fn(),
  listContactsHandler: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { getContactHandler } from "@/app/api/v1/contacts/_handler";
import { crmGetContact } from "@/lib/mcp/tools/contacts";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "33333333-3333-4333-8333-333333333333";

const CONTATO_DO_HANDLER = {
  id: CONTATO,
  organization_id: ORG,
  name: "Cliente",
  display_name: "Cliente",
  email: null,
  phone_number: "+5511999998888",
  tags: [],
  source: "manual",
  consent: {},
  is_blocked: false,
  is_anonymized: false,
  is_personal: false,
  cpf_available: false,
  created_at: "2026-10-01T00:00:00.000Z",
  last_activity_at: null,
};

const EXTRAS_DO_BANCO = [
  {
    phone_number: "+5511988887777",
    tipo: "celular",
    whatsapp: "sim",
    rotulo: "Trabalho",
    origem: "fusao",
    created_at: "2026-10-02T10:00:00.000Z",
    wa_lid: "999888777666",
  },
  {
    phone_number: "+551133334444",
    tipo: "fixo",
    whatsapp: "nao_sei",
    rotulo: null,
    origem: "manual",
    created_at: "2026-10-01T10:00:00.000Z",
    wa_lid: "111222333444",
  },
];

/** Banco falso: registra cada `eq` e devolve as linhas pedidas por tabela. */
function bancoComExtras(filtros: Array<{ tabela: string; coluna: string; valor: unknown }>, extras: unknown[]) {
  return {
    from: (tabela: string) => {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (coluna: string, valor: unknown) => {
          filtros.push({ tabela, coluna, valor });
          return q;
        },
        maybeSingle: async () => ({
          data: tabela === "contacts" ? { phone_type: "celular", phone_whatsapp: "sim" } : null,
          error: null,
        }),
        // Quem espera a leitura de `contact_phones` sem `order` (a tool ordena na memória).
        then: (ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) =>
          Promise.resolve({ data: tabela === "contact_phones" ? extras : [], error: null }).then(ok, erro),
      };
      return q;
    },
  };
}

function ctx(supabase: unknown) {
  return {
    supabase,
    organizationId: ORG,
    role: "agent",
    actor: { type: "user", id: "u-1" },
    apiTokenId: "tok-1",
    requestId: "req-1",
  } as never;
}

describe("crm_get_contact devolve os telefones da ficha", () => {
  it("devolve tipo e WhatsApp do principal e os extras na forma da API, sem wa_lid", async () => {
    vi.mocked(getContactHandler).mockResolvedValue(CONTATO_DO_HANDLER as never);
    const filtros: Array<{ tabela: string; coluna: string; valor: unknown }> = [];

    const r = (await crmGetContact.handler(
      { contact_id: CONTATO },
      ctx(bancoComExtras(filtros, EXTRAS_DO_BANCO)),
    )) as Record<string, unknown>;

    expect(r).toMatchObject({ id: CONTATO, phone_type: "celular", phone_whatsapp: "sim" });
    expect(r.additional_phones).toEqual([
      {
        phone_number: "+551133334444",
        type: "fixo",
        whatsapp: "nao_sei",
        label: null,
        origin: "manual",
        created_at: "2026-10-01T10:00:00.000Z",
      },
      {
        phone_number: "+5511988887777",
        type: "celular",
        whatsapp: "sim",
        label: "Trabalho",
        origin: "fusao",
        created_at: "2026-10-02T10:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(r)).not.toContain("wa_lid");
    expect(JSON.stringify(r)).not.toContain("999888777666");
  });

  it("filtra por organização nas duas leituras (o cliente é o service role)", async () => {
    vi.mocked(getContactHandler).mockResolvedValue(CONTATO_DO_HANDLER as never);
    const filtros: Array<{ tabela: string; coluna: string; valor: unknown }> = [];

    await crmGetContact.handler({ contact_id: CONTATO }, ctx(bancoComExtras(filtros, EXTRAS_DO_BANCO)));

    expect(filtros).toContainEqual({ tabela: "contacts", coluna: "organization_id", valor: ORG });
    expect(filtros).toContainEqual({ tabela: "contact_phones", coluna: "organization_id", valor: ORG });
    expect(filtros).toContainEqual({ tabela: "contact_phones", coluna: "contact_id", valor: CONTATO });
  });

  it("ficha sem extra devolve additional_phones []", async () => {
    vi.mocked(getContactHandler).mockResolvedValue(CONTATO_DO_HANDLER as never);

    const r = (await crmGetContact.handler(
      { contact_id: CONTATO },
      ctx(bancoComExtras([], [])),
    )) as Record<string, unknown>;

    expect(r.additional_phones).toEqual([]);
    expect(r.phone).toBe("+5511999998888");
  });
});
