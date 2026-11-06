import { beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ handler: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: fake.audit }));
vi.mock("@/lib/mcp/tools", () => {
  const def = {
    name: "crm_book_appointment",
    category: "write",
    description: "Reserva sintética",
    inputSchema: {},
    requiresRole: "ai_operator",
    requiresScope: "mcp:write",
    handler: fake.handler,
  };
  return { allTools: [def], getToolByName: (id: string) => (id === def.name ? def : undefined) };
});
// A suíte de escopo de funil mede a autorização. Aqui isolamos o resultado da ponte.
vi.mock("@/lib/leads/escopo-de-funil", () => ({
  podeChamarFerramenta: async () => ({ permitido: true }),
  recusaParaOModelo: () => null,
}));
import { pickToolsFromMcp } from "./tools";
import { criarEfeitoDasEscrituras } from "./efeito-das-escritas";
import type { McpContext } from "@/lib/mcp/types";
import type { McpAuthResult } from "@/lib/mcp/auth";

const contactId = "33333333-3333-4333-8333-333333333333";
const resultado = {
  marcado: true,
  compromisso: {
    id: "11111111-1111-4111-8111-111111111111",
    status: "confirmed",
    revision: 1,
    starts_at: "2026-12-10T13:00:00Z",
    ends_at: "2026-12-10T13:30:00Z",
  },
};
function montar() {
  const efeitos = criarEfeitoDasEscrituras();
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
    contatoDoTurno: contactId,
    toolIds: ["crm_book_appointment"],
    handoffToolEnabled: false,
    handoffSignal: { triggered: false },
    efeitos,
  });
  const execute = tools.crm_book_appointment!.execute!;
  return {
    efeitos,
    execute: (args: unknown) =>
      execute(args, { toolCallId: "sintetico", messages: [], context: {} }),
  };
}

describe("a ponte alimenta o comprovante a partir do resultado, após as guardas", () => {
  beforeEach(() => {
    fake.handler.mockReset();
    fake.audit.mockReset();
    fake.audit.mockResolvedValue(undefined);
  });

  it("recibo é o retorno real, mesmo quando argumentos trazem comprovante fabricado", async () => {
    fake.handler.mockResolvedValue(resultado);
    const { efeitos, execute } = montar();
    await execute({
      contact_id: contactId,
      compromisso: { ...resultado.compromisso, starts_at: "2099-01-01T10:00:00Z" },
    });
    expect(efeitos.recibosDeAgendamento()).toEqual([resultado.compromisso]);
    expect(efeitos.produziuEfeito("crm_book_appointment")).toBe(true);
  });

  it("recusa de contato na guarda não chama o handler nem publica recibo", async () => {
    fake.handler.mockResolvedValue(resultado);
    const { efeitos, execute } = montar();
    await execute({ contact_id: "55555555-5555-4555-8555-555555555555" });
    expect(fake.handler).not.toHaveBeenCalled();
    expect(efeitos.recibosDeAgendamento()).toEqual([]);
  });

  it.each([
    { marcado: false, compromisso: resultado.compromisso },
    { marcado: true, compromisso: { ...resultado.compromisso, status: "pending" } },
    { resultado_incerto: true, compromisso: resultado.compromisso },
  ])("um retorno posterior sem confirmação retira o comprovante: %j", async (segundo) => {
    fake.handler.mockResolvedValueOnce(resultado).mockResolvedValueOnce(segundo);
    const { efeitos, execute } = montar();
    await execute({ contact_id: contactId });
    expect(efeitos.recibosDeAgendamento()).toHaveLength(1);
    await execute({ contact_id: contactId });
    expect(efeitos.recibosDeAgendamento()).toEqual([]);
  });

  it("exceção posterior retira comprovante sem apagar o efeito monotônico", async () => {
    fake.handler
      .mockResolvedValueOnce(resultado)
      .mockRejectedValueOnce(new Error("falha sintética"));
    const { efeitos, execute } = montar();
    await execute({ contact_id: contactId });
    await expect(execute({ contact_id: contactId })).resolves.toEqual({ error: "falha sintética" });
    expect(efeitos.recibosDeAgendamento()).toEqual([]);
    expect(efeitos.produziuEfeito("crm_book_appointment")).toBe(true);
  });

  it("retorno atrasado de outra tentativa não ressuscita o recibo após falha nova", async () => {
    let resolver: (r: unknown) => void = () => {
      throw new Error("handler ainda não começou");
    };
    const iniciou = Promise.withResolvers<void>();
    fake.handler
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolver = resolve;
            iniciou.resolve();
          }),
      )
      .mockResolvedValueOnce({ marcado: false });
    const { efeitos, execute } = montar();
    const primeira = execute({ contact_id: contactId });
    await iniciou.promise;
    await execute({ contact_id: contactId });
    resolver(resultado);
    await primeira;
    expect(efeitos.recibosDeAgendamento()).toEqual([]);
  });
});
