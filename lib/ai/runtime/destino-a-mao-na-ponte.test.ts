// A PONTE CHAMA A GUARDA DO DESTINO EM TODA CRIAÇÃO DE NEGÓCIO (#4763, item 2).
//
// Antes, `lib/ai/runtime/tools.ts` só chamava `completarDestinoDoNegocio` quando
// o modelo passava `referencia_externa` — era essa condição que deixava o funil
// à mão passar sem item nenhum ser olhado. O caso medido (AU-9999) não trouxe
// referência: a chamada ia direto para o escopo de funil e o negócio nascia.
//
// O primeiro caso é o que fica vermelho se a condição voltar.

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  handler: vi.fn(),
  audit: vi.fn(),
  destino: vi.fn(),
}));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: fake.audit }));
vi.mock("@/lib/mcp/tools", () => {
  const def = {
    name: "crm_create_lead",
    category: "write",
    description: "Cria negócio sintético",
    inputSchema: {},
    requiresRole: "ai_operator",
    requiresScope: "mcp:write",
    handler: fake.handler,
  };
  return { allTools: [def], getToolByName: (id: string) => (id === def.name ? def : undefined) };
});
vi.mock("@/lib/leads/escopo-de-funil", () => ({
  podeChamarFerramenta: async () => ({ permitido: true }),
  recusaParaOModelo: () => null,
}));
// O escopo das escrituras tem suíte própria; aqui isolamos a ordem das guardas.
vi.mock("./escopo-das-escritas", () => ({
  escritaCabeNoTurno: async () => ({ permitido: true }),
}));
vi.mock("@/lib/external-db/receitas/destino-pela-referencia", () => ({
  completarDestinoDoNegocio: fake.destino,
  DECLARACAO_SEM_ITEM: "funil_a_mao_sem_item",
}));

import { pickToolsFromMcp } from "./tools";
import type { McpContext } from "@/lib/mcp/types";
import type { McpAuthResult } from "@/lib/mcp/auth";

const CONTATO = "33333333-3333-4333-8333-333333333333";
const FUNIL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ETAPA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function montar(contato: string | null = CONTATO) {
  const ctx = {
    organizationId: "22222222-2222-4222-8222-222222222222",
    requestId: "turno-sintetico",
    supabase: {},
  } as McpContext;
  const auth = { role: "ai_operator", scopes: ["mcp:write"] } as McpAuthResult;
  const tools = pickToolsFromMcp({
    ctx,
    auth,
    supabase: {} as never,
    ...(contato === null ? {} : { contatoDoTurno: contato }),
    toolIds: ["crm_create_lead"],
    handoffToolEnabled: false,
    handoffSignal: { triggered: false },
  });
  const execute = tools.crm_create_lead!.execute!;
  return (args: unknown) => execute(args, { toolCallId: "sintetico", messages: [], context: {} });
}

describe("a ponte chama a guarda do destino em toda criação", () => {
  beforeEach(() => {
    fake.handler.mockReset();
    fake.audit.mockReset();
    fake.audit.mockResolvedValue(undefined);
    fake.destino.mockReset();
  });

  it("sem referencia_externa: a guarda roda antes do handler e o negócio não nasce", async () => {
    fake.destino.mockResolvedValue({
      ok: false,
      resposta: { erro: "item_obrigatorio", mensagem: "informe o item" },
    });
    const execute = montar();

    const resultado = await execute({
      pipeline_id: FUNIL,
      stage_id: ETAPA,
      title: "Casa com piscina em Alphaville — AU-9999",
    });

    expect(resultado).toMatchObject({ erro: "item_obrigatorio" });
    expect(fake.handler).not.toHaveBeenCalled();
    expect(fake.destino).toHaveBeenCalledTimes(1);
    expect(fake.destino).toHaveBeenCalledWith(
      expect.anything(),
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({ pipeline_id: FUNIL, stage_id: ETAPA }),
      { turnoComContato: true },
    );
    // A chamada medida não trouxe referência nenhuma: é essa ausência que a
    // guarda passa a julgar pelo funil.
    const argsDaGuarda = fake.destino.mock.calls[0]![2] as Record<string, unknown>;
    expect("referencia_externa" in argsDaGuarda).toBe(false);
    expect(fake.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorMessage: "destino_do_interesse:item_obrigatorio",
      }),
    );
  });

  it("a declaração do negócio aberto à mão vai para a auditoria da chamada que deu certo", async () => {
    fake.destino.mockResolvedValue({ ok: true, declaracao: "funil_a_mao_sem_item" });
    fake.handler.mockResolvedValue({ lead: { id: "11111111-1111-4111-8111-111111111111" } });
    const execute = montar();

    await execute({ pipeline_id: FUNIL, stage_id: ETAPA, title: "Indicação do vizinho" });

    expect(fake.handler).toHaveBeenCalledTimes(1);
    expect(fake.audit).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, motivo: "funil_a_mao_sem_item" }),
    );
  });

  it("fora de um turno com contato, a guarda é chamada sem o contexto de conversa", async () => {
    fake.destino.mockResolvedValue({ ok: true });
    fake.handler.mockResolvedValue({ lead: { id: "11111111-1111-4111-8111-111111111111" } });
    const execute = montar(null);

    await execute({ pipeline_id: FUNIL, stage_id: ETAPA, title: "Negócio da integração" });

    expect(fake.destino).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { turnoComContato: false },
    );
  });
});
