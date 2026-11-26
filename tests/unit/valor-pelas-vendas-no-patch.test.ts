/**
 * NEGÓCIO COM VENDA REGISTRADA: `value_cents` É DERIVADO NO SERVIDOR (#5228).
 *
 * Com ao menos uma venda registrada (`valor_pelas_vendas = true`), o gatilho da
 * migration 9450 grava a soma das vendas em `crm_leads.value_cents`. Só que o
 * gatilho dispara na tabela `vendas_registradas`, não num `UPDATE` de `crm_leads`.
 *
 * Sem esta guarda em `updateLeadHandler`, qualquer escritor que mande
 * `value_cents` (o diálogo "Editar", `crm_update_lead` do MCP, PATCH via token)
 * sobrescrevia a soma das vendas.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: () => "movido",
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));
vi.mock("@/lib/atendimento/origem", () => ({ observeServiceOrigin: async () => "humano" }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: async () => ({ error: null }) }),
}));

import { updateLeadHandler } from "@/app/api/v1/leads/_handler";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import type { HandlerCtx } from "@/lib/api/handlers/types";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PIPELINE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ETAPA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LEAD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function supabaseDaEdicao(estado: Record<string, unknown>) {
  const banco: Record<string, unknown> = { ...estado };
  const atualizacoes: Record<string, unknown>[] = [];
  const from = (tabela: string) => {
    if (tabela !== "crm_leads") throw new Error(`tabela inesperada: ${tabela}`);
    return {
      select: () => {
        const leitura: Record<string, unknown> = {};
        leitura.eq = () => leitura;
        leitura.maybeSingle = async () => ({ data: { ...banco }, error: null });
        return leitura;
      },
      update: (valores: Record<string, unknown>) => {
        atualizacoes.push(valores);
        const escrita: Record<string, unknown> = {};
        escrita.eq = () => escrita;
        escrita.select = () => escrita;
        escrita.maybeSingle = async () => {
          Object.assign(banco, valores);
          return { data: { ...banco }, error: null };
        };
        return escrita;
      },
    };
  };
  return {
    cliente: {
      from,
      rpc: () => ({ then: (fn: (r: { error: null }) => void) => Promise.resolve(fn({ error: null })) }),
    } as never,
    banco,
    atualizacoes,
  };
}

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: "11111111-1111-4111-8111-111111111111" },
  requestId: "req-5228",
  idioma: "pt-BR",
};

const BASE_LEAD = {
  id: LEAD,
  organization_id: ORG,
  contact_id: null,
  pipeline_id: PIPELINE,
  stage_id: ETAPA,
  status: "open",
  title: "Negócio com venda",
  description: null,
  value_cents: 10_000,
  valor_pelas_vendas: true,
  currency: "BRL",
  expected_close_date: null,
  owner_user_id: null,
  owner_agent_id: null,
  owner_kind: null,
  tags: [],
  custom_fields: {},
  recurring_value_cents: null,
  recurring_period: null,
  recurring_months: null,
  updated_at: "2026-11-24T12:00:00.000Z",
};

describe("#5228 — updateLeadHandler preserva soma das vendas", () => {
  beforeEach(() => vi.clearAllMocks());

  it("negócio com venda de R$ 100 (valor_pelas_vendas = true): PATCH com value_cents de 50 mantém 100", async () => {
    const db = supabaseDaEdicao(BASE_LEAD);

    const resultado = await updateLeadHandler(db.cliente, ctx, LEAD, {
      title: "Título atualizado",
      value_cents: 5_000,
    });

    const patch = db.atualizacoes.at(-1)!;
    expect(patch).not.toHaveProperty("value_cents");
    expect(patch.title).toBe("Título atualizado");
    expect(db.banco.value_cents).toBe(10_000);
    expect(resultado.value_cents).toBe(10_000);

    // Só o título mudou: a atividade não deve acusar alteração de Valor.
    expect(emitLeadActivity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(emitLeadActivity).mock.calls[0]?.[1].payload).toEqual({ fields: ["title"] });
  });

  it("controle — negócio sem venda (valor_pelas_vendas = false): PATCH com value_cents de 50 grava 50", async () => {
    const db = supabaseDaEdicao({ ...BASE_LEAD, valor_pelas_vendas: false });

    const resultado = await updateLeadHandler(db.cliente, ctx, LEAD, {
      value_cents: 5_000,
    });

    const patch = db.atualizacoes.at(-1)!;
    expect(patch.value_cents).toBe(5_000);
    expect(db.banco.value_cents).toBe(5_000);
    expect(resultado.value_cents).toBe(5_000);
  });
});
