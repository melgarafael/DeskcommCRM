import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O `lead_id` que o assistente manda é, às vezes, o id do CONTATO.
 *
 * No motor do agente "lead" é o contato (`job.contact_id`); nas ferramentas do
 * catálogo `lead_id` é o NEGÓCIO. Medido em produção: o assistente fechou um
 * pedido, chamou `crm_update_lead` duas vezes com o id do contato — as duas
 * recusadas — e o pedido confirmado ficou sem valor nem dados de entrega.
 *
 * A asserção é sobre a CADEIA: monta a ferramenta como o turno monta
 * (`pickToolsFromMcp`), executa com o id do contato e lê o que chegou ao
 * handler do negócio.
 */

vi.mock("@/app/api/v1/leads/_handler", async (original) => ({
  ...(await original<typeof import("@/app/api/v1/leads/_handler")>()),
  updateLeadHandler: vi.fn(),
}));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn().mockResolvedValue(undefined) }));

const { updateLeadHandler } = await import("@/app/api/v1/leads/_handler");
const { pickToolsFromMcp, leadIdDoContatoDoTurno } = await import("@/lib/ai/runtime/tools");

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const NEGOCIO = "33333333-3333-4333-8333-333333333333";
const OUTRO = "55555555-5555-4555-8555-555555555555";
const FUNIL = "44444444-4444-4444-8444-444444444444";

const negocio = (id: string, status = "open", lastActivityAt = "2026-09-24T02:38:00.000Z") => ({
  id, organization_id: ORG, pipeline_id: FUNIL, status,
  last_activity_at: lastActivityAt, created_at: "2026-09-24T02:18:00.000Z",
});

/** Responde as duas perguntas que a ponte faz a `crm_leads`: por contato e por id. */
function banco(negociosDoContato: ReturnType<typeof negocio>[], opts: { erro?: boolean } = {}) {
  const consultas: string[] = [];
  return {
    consultas,
    supabase: {
      from(tabela: string) {
        const filtros: Record<string, unknown> = {};
        const q = {
          select: () => q,
          eq: (coluna: string, valor: unknown) => { filtros[coluna] = valor; return q; },
          maybeSingle: async () => {
            consultas.push(`${tabela}:id`);
            const achado = negociosDoContato.find((n) => n.id === filtros.id);
            return { data: achado ? { pipeline_id: achado.pipeline_id } : null, error: null };
          },
          then: (ok: (r: unknown) => unknown) => {
            consultas.push(`${tabela}:contato`);
            return ok(opts.erro ? { data: null, error: { message: "timeout" } } : { data: negociosDoContato, error: null });
          },
        };
        return q;
      },
    },
  };
}

function montar(supabase: unknown, contatoDoTurno?: string) {
  const ator = { type: "ai_agent", id: "ag-1", role: "ai_operator" };
  return pickToolsFromMcp({
    toolIds: ["crm_update_lead"],
    auth: { organizationId: ORG, role: "ai_operator", scopes: ["mcp:read", "mcp:write"], actor: ator, apiTokenId: "tok-1" },
    ctx: { organizationId: ORG, role: "ai_operator", actor: ator, apiTokenId: "tok-1", requestId: "req-1", supabase },
    supabase,
    pipelineIds: [FUNIL],
    handoffToolEnabled: false,
    handoffSignal: { triggered: false },
    ...(contatoDoTurno ? { contatoDoTurno } : {}),
  } as never);
}

async function executar(supabase: unknown, contatoDoTurno: string | undefined, leadId: string) {
  const ferramenta = montar(supabase, contatoDoTurno).crm_update_lead!;
  return ferramenta.execute!({ lead_id: leadId, value_cents: 12_500_000 }, { toolCallId: "c1", messages: [] } as never);
}

beforeEach(() => {
  vi.mocked(updateLeadHandler).mockReset().mockResolvedValue({ id: NEGOCIO } as never);
});

describe("a ponte traduz o contato do turno para o negócio aberto", () => {
  it("id do contato do turno chega ao handler como o id do NEGÓCIO", async () => {
    const { supabase } = banco([negocio(NEGOCIO)]);
    await executar(supabase, CONTATO, CONTATO);
    expect(vi.mocked(updateLeadHandler).mock.calls[0]![2]).toBe(NEGOCIO);
  });

  it("id de negócio de verdade passa intacto, sem consulta por contato", async () => {
    const b = banco([negocio(NEGOCIO)]);
    await executar(b.supabase, CONTATO, NEGOCIO);
    expect(vi.mocked(updateLeadHandler).mock.calls[0]![2]).toBe(NEGOCIO);
    expect(b.consultas).not.toContain("crm_leads:contato");
  });

  it("sem contato do turno (chamada de fora do motor), nada é traduzido", async () => {
    expect(await leadIdDoContatoDoTurno({} as never, ORG, undefined, CONTATO)).toBeNull();
  });
});

describe("quando a tradução não é dela, devolve o id como veio", () => {
  it("dois negócios abertos: a escolha não é do runtime", async () => {
    const { supabase } = banco([negocio(NEGOCIO), negocio(OUTRO)]);
    expect(await leadIdDoContatoDoTurno(supabase as never, ORG, CONTATO, CONTATO)).toBeNull();
  });

  // Sem empate, `resolveActiveLeadForContact` escolhe o mais recente (OUTRO).
  // A tradução não pode escolher: a escrita cairia num cartão por palpite.
  it("dois negócios abertos com atividades diferentes: também não escolhe o mais recente", async () => {
    const { supabase } = banco([negocio(NEGOCIO), negocio(OUTRO, "open", "2026-09-24T02:39:00.000Z")]);
    expect(await leadIdDoContatoDoTurno(supabase as never, ORG, CONTATO, CONTATO)).toBeNull();
  });

  it("falha de leitura não vira palpite", async () => {
    const { supabase } = banco([negocio(NEGOCIO)], { erro: true });
    expect(await leadIdDoContatoDoTurno(supabase as never, ORG, CONTATO, CONTATO)).toBeNull();
  });

  it("contato sem negócio aberto: nada a traduzir", async () => {
    const { supabase } = banco([negocio(NEGOCIO, "won")]);
    expect(await leadIdDoContatoDoTurno(supabase as never, ORG, CONTATO, CONTATO)).toBeNull();
  });
});
