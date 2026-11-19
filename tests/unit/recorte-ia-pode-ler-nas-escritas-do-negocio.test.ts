/**
 * #4669 — a resposta das ferramentas de ESCRITA do negócio também é lida pelo
 * modelo: create/update/move/retomar devolvem a linha inteira do lead
 * (`select *`), com `custom_fields` dentro. No turno, só sai a chave que o dono
 * do funil marcou "A IA pode ler"; fora dele (token de pessoa), a ficha inteira.
 *
 * Os handlers REST são dublês que devolvem a linha como o `select *` devolveria;
 * o que está sob teste é a ferramenta, que é onde o recorte mora.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn().mockResolvedValue(undefined),
  isServiceRoleConfigured: () => false,
}));

const CONTATO = "c0000000-0000-4000-8000-0000000000aa";
const FUNIL_ID = "e0000000-0000-4000-8000-000000000001";
const LEAD_ID = "d0000000-0000-4000-8000-000000000001";
const ETAPA = "55555555-5555-4555-8555-555555555551";
const CUSTOM = { documento: "cnh-digital.pdf", observacao_interna: "proposta de outro fornecedor" };

const linhaDoLead = vi.hoisted(() => () => ({
  id: "d0000000-0000-4000-8000-000000000001",
  organization_id: "22222222-2222-4222-8222-222222222222",
  pipeline_id: "e0000000-0000-4000-8000-000000000001",
  contact_id: "c0000000-0000-4000-8000-0000000000aa",
  title: "Pedido #1",
  custom_fields: {
    documento: "cnh-digital.pdf",
    observacao_interna: "proposta de outro fornecedor",
  },
}));
vi.mock("@/app/api/v1/leads/_handler", () => ({
  listLeadsHandler: vi.fn(),
  getLeadHandler: vi.fn(),
  createLeadHandler: vi.fn(async () => linhaDoLead()),
  updateLeadHandler: vi.fn(async () => linhaDoLead()),
  moveLeadHandler: vi.fn(async () => linhaDoLead()),
  retomarLeadHandler: vi.fn(async () => linhaDoLead()),
}));

import {
  crmCreateLead,
  crmMoveLeadStage,
  crmRetomarLead,
  crmUpdateLead,
} from "@/lib/mcp/tools/leads";
import type { McpContext } from "@/lib/mcp/types";

const FUNIL = {
  fields: [
    { key: "documento", label: "Documento", type: "text", ia_pode_ler: true },
    { key: "observacao_interna", label: "Observação interna", type: "text", ia_pode_ler: false },
  ],
};

/** Só o `settings` do funil é lido do banco: `.from().select().eq().maybeSingle()`. */
function makeCtx(cima: Partial<McpContext> = {}): McpContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: { settings: FUNIL }, error: null }),
  };
  return {
    organizationId: "22222222-2222-4222-8222-222222222222",
    role: "agent",
    actor: { type: "user", id: "11111111-1111-4111-8111-111111111111" },
    requestId: "req",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: { from: () => chain } as any,
    ...cima,
  } as McpContext;
}

const ferramentas: Array<[string, (ctx: McpContext) => Promise<unknown>]> = [
  [
    "crm_create_lead",
    (ctx) =>
      crmCreateLead.handler(
        { pipeline_id: FUNIL_ID, stage_id: ETAPA, title: "Pedido #1", contact_id: CONTATO } as Parameters<
          typeof crmCreateLead.handler
        >[0],
        ctx,
      ),
  ],
  [
    "crm_update_lead",
    (ctx) =>
      crmUpdateLead.handler(
        { lead_id: LEAD_ID, title: "Pedido #1" } as Parameters<typeof crmUpdateLead.handler>[0],
        ctx,
      ),
  ],
  [
    "crm_move_lead_stage",
    (ctx) =>
      crmMoveLeadStage.handler(
        { lead_id: LEAD_ID, to_stage_id: ETAPA } as Parameters<typeof crmMoveLeadStage.handler>[0],
        ctx,
      ),
  ],
  [
    "crm_retomar_lead",
    (ctx) =>
      crmRetomarLead.handler(
        { lead_id: LEAD_ID } as Parameters<typeof crmRetomarLead.handler>[0],
        ctx,
      ),
  ],
];

describe("escritas do negócio — a resposta no turno só traz o campo marcado \"A IA pode ler\" (#4669)", () => {
  it.each(ferramentas)("%s no turno: a chave desmarcada não vem", async (_nome, chamar) => {
    const res = (await chamar(makeCtx({ contatoDoTurno: CONTATO, role: "ai_operator" }))) as {
      lead: Record<string, unknown>;
    };
    expect(res.lead.custom_fields).toEqual({ documento: "cnh-digital.pdf" });
    // O resto da linha continua: o recorte é do campo, não do negócio.
    expect(res.lead.title).toBe("Pedido #1");
  });

  it.each(ferramentas)("%s fora do turno: a ficha volta inteira", async (_nome, chamar) => {
    const res = (await chamar(makeCtx())) as { lead: Record<string, unknown> };
    expect(res.lead.custom_fields).toEqual(CUSTOM);
  });
});
