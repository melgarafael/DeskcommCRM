import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as NomeInformado from "@/lib/contacts/nome-informado";
import type * as TelefoneAplicado from "@/lib/contacts/telefone-aplicado";

/**
 * O NOME QUE ENTROU SOZINHO DEIXA LINHA NA TIMELINE (#3784), como o telefone (#2593).
 *
 * A auditoria `contact.field_auto_applied` só aparece em `/app/audit`, restrita
 * a gerentes e fora da ficha; quem atende lê a timeline do contato.
 *
 * SABOTAGEM: tirar a chamada de `registrarNomeAplicadoNaTimeline` do ramo
 * `nome.aplicado` em `lib/mcp/tools/contacts.ts` — o primeiro caso cai.
 */

const { audit, registrarNomeInformado, origemConfiavelDoNome, emitLeadActivity, registrarNomeAplicadoNaTimeline } =
  vi.hoisted(() => ({
    audit: vi.fn(async (_entrada: unknown) => undefined),
    registrarNomeInformado: vi.fn(),
    origemConfiavelDoNome: vi.fn(),
    emitLeadActivity: vi.fn(async (_db: unknown, _a: unknown) => ({ ok: true })),
    registrarNomeAplicadoNaTimeline: vi.fn(async (_db: unknown, _p: unknown) => true),
  }));
vi.mock("@/lib/audit", () => ({ audit }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/atendimento/fronteira-server", () => ({
  currentExecutionJob: () => null,
  currentExecutionBoundary: () => null,
  guardServiceEffect: async () => undefined,
}));
vi.mock("@/lib/contacts/telefone-aplicado", async (original) => ({
  ...(await original<typeof TelefoneAplicado>()),
  registrarNomeAplicadoNaTimeline,
}));
vi.mock("@/lib/contacts/nome-informado", async (original) => ({
  ...(await original<typeof NomeInformado>()),
  registrarNomeInformado,
  origemConfiavelDoNome,
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const LEAD = "44444444-4444-4444-8444-444444444444";
const AGENTE = "55555555-5555-4555-8555-555555555555";

describe("o handler da ferramenta", () => {
  beforeEach(() => {
    registrarNomeAplicadoNaTimeline.mockClear();
    registrarNomeInformado.mockReset();
    origemConfiavelDoNome.mockReset();
  });

  async function chamar() {
    const { crmProposeContactField } = await import("@/lib/mcp/tools/contacts");
    return crmProposeContactField.handler(
      { contact_id: CONTATO, campo: "name", valor: "Maria Silva" },
      {
        organizationId: ORG,
        role: "agent",
        actor: { type: "ai_agent", id: "run-1", agent_id: AGENTE, role: "agent" },
        apiTokenId: "tok",
        requestId: "req-1",
        supabase: { marcador: "db" } as never,
      } as never,
    );
  }

  it("nome aplicado: grava a linha na timeline com o agente que aplicou", async () => {
    origemConfiavelDoNome.mockReturnValue({
      organizationId: ORG, contactId: CONTATO, conversationId: "c", messageId: "m", serviceRevision: 1,
    });
    registrarNomeInformado.mockResolvedValue({ aplicado: true, nome: "Maria Silva" });
    const r = (await chamar()) as { motivo?: string };
    expect(r.motivo).toBe("aplicado_automaticamente");
    expect(registrarNomeAplicadoNaTimeline).toHaveBeenCalledTimes(1);
    expect(registrarNomeAplicadoNaTimeline.mock.calls[0]?.[1]).toEqual({
      organizationId: ORG, contactId: CONTATO, nome: "Maria Silva", agentId: AGENTE,
    });
  });

  it("nome NÃO aplicado: nenhuma linha de aplicado", async () => {
    origemConfiavelDoNome.mockReturnValue(null);
    await chamar().catch(() => undefined);
    expect(registrarNomeAplicadoNaTimeline).not.toHaveBeenCalled();
  });
});

describe("registrarNomeAplicadoNaTimeline", () => {
  function db(leads: unknown[]) {
    return {
      from(tabela: string) {
        const q = {
          select: () => q, eq: () => q, limit: () => q,
          maybeSingle: async () => ({ data: tabela === "crm_pipelines" ? { id: "p" } : null, error: null }),
          then: (ok: (r: unknown) => unknown) => Promise.resolve({ data: leads, error: null }).then(ok),
        };
        return q;
      },
    } as never;
  }
  const aberto = { id: LEAD, organization_id: ORG, pipeline_id: "p", status: "open", last_activity_at: null, created_at: "2026-01-01" };

  beforeEach(() => emitLeadActivity.mockClear());

  it("pendura no negócio aberto, com campo name e sem o texto da mensagem", async () => {
    const { registrarNomeAplicadoNaTimeline: real } =
      await vi.importActual<typeof TelefoneAplicado>("@/lib/contacts/telefone-aplicado");
    expect(await real(db([aberto]), { organizationId: ORG, contactId: CONTATO, nome: "Maria Silva", agentId: AGENTE })).toBe(true);
    const a = emitLeadActivity.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(a).toMatchObject({
      organizationId: ORG, leadId: LEAD, contactId: CONTATO, type: "contact_field_auto_applied",
      payload: { campo: "name", nome: "Maria Silva", automatico: true },
    });
    expect(a.payload).not.toHaveProperty("trecho");
  });

  it("sem negócio aberto não inventa linha e não lança", async () => {
    const { registrarNomeAplicadoNaTimeline: real } =
      await vi.importActual<typeof TelefoneAplicado>("@/lib/contacts/telefone-aplicado");
    expect(await real(db([]), { organizationId: ORG, contactId: CONTATO, nome: "Maria Silva" })).toBe(false);
    expect(emitLeadActivity).not.toHaveBeenCalled();
  });
});
