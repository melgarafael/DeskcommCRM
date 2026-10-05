/**
 * `crm_create_lead` passa `custom_fields` pela MESMA conferência do
 * `crm_update_lead` (#2234 — "a IA só grava o que o cliente disse").
 *
 * O #2297 deu ao `crm_create_lead` a chave `custom_fields` para o agente
 * conseguir cumprir a régua da etapa. Sem a conferência, a chave abria uma
 * porta lateral: o que o `crm_update_lead` recusa entrava pela criação.
 *
 * O que separa os desenhos: tirar a chamada de `conferirCamposPersonalizados`
 * do handler de criação deixa o campo recusado chegar ao insert (caso 1) e o
 * ensino não volta ao modelo. A cerca do fim vale para toda ferramenta que
 * venha a declarar `custom_fields`, não só para estas duas.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpContext } from "@/lib/mcp/types";

const criados = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@/app/api/v1/leads/_handler", async (original) => ({
  ...(await original<object>()),
  createLeadHandler: vi.fn(async (_sb: unknown, _ctx: unknown, input: Record<string, unknown>) => {
    criados.push(input);
    return { id: "lead-novo", ...input };
  }),
}));

vi.mock("@/lib/mcp/conferencia-de-campos", async (original) => ({
  ...(await original<object>()),
  conferirCamposPersonalizados: vi.fn(),
}));

import { conferirCamposPersonalizados } from "@/lib/mcp/conferencia-de-campos";
import { allTools } from "@/lib/mcp/tools";
import { crmCreateLead } from "@/lib/mcp/tools/leads";

const conferir = vi.mocked(conferirCamposPersonalizados);

const PIPE = "11111111-1111-4111-8111-111111111111";
const ETAPA = "22222222-2222-4222-8222-222222222222";

const ctx = {
  organizationId: "33333333-3333-4333-8333-333333333333",
  role: "ai_operator",
  actor: { type: "ai_agent", id: "agent-1", agent_id: "agent-1", role: "ai_operator" },
  requestId: "req-1",
  supabase: {},
  contatoDoTurno: "44444444-4444-4444-8444-444444444444",
} as unknown as McpContext;

const entrada = {
  pipeline_id: PIPE,
  stage_id: ETAPA,
  title: "Apartamento",
  custom_fields: { tipo_imovel: "apartamento", quartos: 1 },
};

beforeEach(() => {
  criados.length = 0;
  conferir.mockReset();
});

describe("crm_create_lead confere custom_fields (#2234 na criação)", () => {
  it("o campo que o cliente não disse NÃO chega ao insert, e o ensino volta ao modelo", async () => {
    conferir.mockResolvedValueOnce({
      custom_fields: { tipo_imovel: "apartamento" },
      recusados: [{ campo: "quartos", motivo: "cliente_nao_disse", mensagem: "Pergunte ao cliente." }],
      estado: "decidindo",
    });

    const r = (await crmCreateLead.handler(entrada as never, ctx)) as Record<string, unknown>;

    expect(conferir).toHaveBeenCalledWith(ctx, { pipelineId: PIPE }, entrada.custom_fields);
    expect(criados).toHaveLength(1);
    expect(criados[0]!.custom_fields).toEqual({ tipo_imovel: "apartamento" });
    expect(r.erro_de_ensino).toBe("Pergunte ao cliente.");
    expect(r.campos_nao_gravados).toHaveLength(1);
  });

  it("sem conferência (origem não é a IA) o pedido segue intacto (controle)", async () => {
    conferir.mockResolvedValueOnce({ recusados: [], estado: "nao_conferida" });

    const r = (await crmCreateLead.handler(entrada as never, ctx)) as Record<string, unknown>;

    expect(criados[0]!.custom_fields).toEqual(entrada.custom_fields);
    expect(r).not.toHaveProperty("erro_de_ensino");
  });
});

describe("cerca — toda ferramenta com custom_fields passa pela conferência", () => {
  it("nenhuma ferramenta declara custom_fields sem chamar conferirCamposPersonalizados", () => {
    const comCampos = allTools.filter((tool) => "custom_fields" in tool.inputSchema);
    // Controle: a cerca enxerga as duas que existem hoje — vazia, ela passaria calada.
    expect(comCampos.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["crm_create_lead", "crm_update_lead"]),
    );
    const semConferencia = comCampos
      .filter((tool) => !tool.handler.toString().includes("conferirCamposPersonalizados"))
      .map((tool) => tool.name);
    expect(semConferencia).toEqual([]);
  });
});
