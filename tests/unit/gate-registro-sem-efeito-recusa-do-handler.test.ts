import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * A RÉGUA DO TRAÇO É A MESMA DO GATE `registro_sem_efeito` (#4342).
 *
 * O gate não pergunta "a chamada lançou exceção?": pergunta "esta escrita
 * PRODUZIU EFEITO?", lendo o predicado único que a ponte das tools alimenta
 * (`lib/ai/runtime/efeito-das-escritas.ts`). Então a ponte — o único ponto que
 * decide o `success` do audit — é quem tem de reconhecer a recusa
 * `{ erro, mensagem }`. Se ela não reconhece, a recusa vira `produziu_efeito` e
 * o gate libera a fala que diz "já registrei".
 *
 * Mesmo caminho para a rota MCP externa (`lib/mcp/server.ts`) e para o traço
 * (`lib/agent-engine/agent/traco-do-turno.ts`): `lib/mcp/desfecho-da-chamada.ts`.
 */
const auditSpy = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: (e: unknown) => auditSpy(e) }));

const resposta = vi.hoisted(() => ({ atual: {} as unknown }));
const tool = vi.hoisted(() => ({
  name: "crm_create_lead",
  description: "cria negócio",
  /** Preenchido abaixo, depois do import de `z` — `vi.hoisted` roda antes dele. */
  inputSchema: {} as Record<string, unknown>,
  category: "write" as const,
  requiresRole: "agent" as const,
  requiresScope: "mcp:write" as const,
  handler: async () => resposta.atual,
}));
vi.mock("@/lib/mcp/tools", () => ({
  allTools: [tool],
  getToolByName: (nome: string) => (nome === tool.name ? tool : undefined),
}));

const { pickToolsFromMcp } = await import("@/lib/ai/runtime/tools");
const { criarEfeitoDasEscrituras } = await import("@/lib/ai/runtime/efeito-das-escritas");

tool.inputSchema = { pipeline_id: z.string().uuid() };

const ORG = "11111111-1111-4111-8111-111111111111";
const FUNIL = "44444444-4444-4444-8444-444444444444";

async function chamarCriarLead() {
  const efeitos = criarEfeitoDasEscrituras();
  const tools = pickToolsFromMcp({
    supabase: {} as never,
    ctx: { organizationId: ORG, requestId: "req-1" } as never,
    auth: {
      organizationId: ORG,
      role: "agent",
      actor: { type: "ai_agent", id: "a1" },
      apiTokenId: "tok",
      scopes: ["mcp:write"],
    } as never,
    toolIds: ["crm_create_lead"],
    handoffToolEnabled: false,
    pipelineIds: [FUNIL],
    handoffSignal: { triggered: false },
    efeitos,
  });
  const montada = tools.crm_create_lead as unknown as {
    execute: (a: unknown) => Promise<unknown>;
  };
  const devolvido = await montada.execute({ pipeline_id: FUNIL });
  return { devolvido, efeitos };
}

beforeEach(() => auditSpy.mockClear());

describe("ponte das tools — recusa do handler não é efeito (#4342)", () => {
  it("`{ erro: 'sem_destino', mensagem }` vira success:false e o gate lê `falhou`", async () => {
    resposta.atual = { erro: "sem_destino", mensagem: "nenhum negócio foi criado: a receita não tem funil." };

    const { devolvido, efeitos } = await chamarCriarLead();

    expect(auditSpy).toHaveBeenCalledOnce();
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorMessage: expect.stringContaining("sem_destino"),
      }),
    );
    // O PREDICADO que o gate consulta. Antes do conserto isto ficava
    // `produziu_efeito`, e o gate `registro_sem_efeito` liberava a fala.
    expect(efeitos.desfechoDe("crm_create_lead")).toBe("falhou");
    expect(efeitos.produziuEfeito("crm_create_lead")).toBe(false);
    // A recusa continua chegando ao modelo, intacta.
    expect(devolvido).toMatchObject({ erro: "sem_destino" });
  });

  it("CONTROLE POSITIVO: negócio criado grava success:true e o gate lê `produziu_efeito`", async () => {
    resposta.atual = { lead: { id: "33333333-3333-4333-8333-333333333333" } };

    const { efeitos } = await chamarCriarLead();

    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(efeitos.desfechoDe("crm_create_lead")).toBe("produziu_efeito");
    expect(efeitos.produziuEfeito("crm_create_lead")).toBe(true);
  });
});
