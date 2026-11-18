/**
 * QUEM PEDIU PARA PARAR LÊ A CONFIRMAÇÃO DE SAÍDA, MESMO COM FRASE PRÓPRIA (#3816).
 *
 * O #3816 deu ao tenant a frase do aviso de passagem (`ai_agents.config.aviso_de_handoff`).
 * Ela fala de PASSAGEM ("Já chamei o time, pode ficar tranquilo!"). Na primeira
 * versão, `textoDoAviso` devolvia a frase antes de olhar o motivo — e quem tinha
 * acabado de pedir para não receber mais mensagens lia "já chamei o time", no
 * lugar de "vou parar de te enviar mensagens".
 *
 * Medido nos DOIS emissores que levam a frase até o canal: o do turno
 * (`avisarLeadDaEscalacao`) e o do CRM (`avisarLeadDoCrm`). O envio é dublado; o
 * que se mede é o corpo que saiu.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const runBeforeSend = vi.hoisted(() => vi.fn());
const enviar = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({ runBeforeSend }));
vi.mock("@/lib/escalacao/disponibilidade", () => ({
  expectativaDeAtendimento: vi.fn(async () => ({ quem: null, frase: "" })),
}));
vi.mock("@/lib/agent-engine/guardrails/lgpd/legal-basis", () => ({
  deriveLgpdFromContact: vi.fn(() => ({})),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: (...args: unknown[]) => enviar(...args),
}));
vi.mock("@/lib/escalacao/atendentes", () => ({
  carregarRosterDeAtendimento: vi.fn(async () => []),
  podeAssumirAgora: vi.fn(() => false),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { avisarLeadDaEscalacao } from "@/lib/agent-engine/agent/aviso-de-escalacao";
import { avisarLeadDoCrm } from "@/lib/ai/handoff/aviso-ao-lead";

const FRASE = "Já chamei o time, pode ficar tranquilo!";
const FECHO_DO_OPT_OUT = "Encaminhei seu pedido para uma pessoa da equipe confirmar.";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const AGENTE = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  runBeforeSend.mockReset();
  runBeforeSend.mockResolvedValue({ status: "sent", outcome: { kind: "sent" }, trace: [] });
  enviar.mockReset();
  enviar.mockResolvedValue({ status: "sent", error_code: null });
});

describe("emissor do turno (`avisarLeadDaEscalacao`)", () => {
  const pool = { query: async () => ({ rows: [{ locale: "pt-BR" }] }) } as never;
  const ids = {
    tenantId: ORG,
    leadId: CONTATO,
    conversationId: CONVERSA,
    channelSessionId: "44444444-4444-4444-8444-444444444444",
    jobId: "job",
  };

  async function corpo(motivo: "suspeita_de_opt_out" | "pediu_humano"): Promise<string> {
    await avisarLeadDaEscalacao(pool, ids, {
      motivo,
      channel: {} as never,
      optedOutThisTurn: false,
      now: new Date("2026-11-10T13:00:00Z"),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      fraseConfigurada: FRASE,
    });
    expect(runBeforeSend).toHaveBeenCalledTimes(1);
    return (runBeforeSend.mock.calls[0]![0] as { body: string }).body;
  }

  it("opt-out com frase própria: sai a confirmação de saída, não a frase", async () => {
    const body = await corpo("suspeita_de_opt_out");
    expect(body).toContain(FECHO_DO_OPT_OUT);
    expect(body).not.toContain(FRASE);
  });

  it("controle: outro motivo com a mesma frase — a frase vence", async () => {
    expect(await corpo("pediu_humano")).toBe(FRASE);
  });
});

describe("emissor do CRM (`avisarLeadDoCrm`)", () => {
  /** Conversa com agente ativo, agente com a frase própria; a IA já falou. */
  function banco() {
    return {
      from(tabela: string) {
        const cadeia: Record<string, unknown> = {};
        let direcao = "";
        Object.assign(cadeia, {
          select: () => cadeia,
          eq: (coluna: string, valor: unknown) => {
            if (coluna === "direction") direcao = String(valor);
            return cadeia;
          },
          order: () => cadeia,
          limit: () =>
            Object.assign(
              Promise.resolve({
                data:
                  direcao === "outbound"
                    ? [{ metadata: null, created_at: new Date().toISOString(), status: "sent" }]
                    : null,
                error: null,
              }),
              { maybeSingle: async () => ({ data: null, error: null }) },
            ),
          maybeSingle: async () => {
            if (tabela === "organizations") return { data: { locale: "pt-BR" }, error: null };
            if (tabela === "conversations") return { data: { active_ai_agent_id: AGENTE }, error: null };
            if (tabela === "ai_agents") return { data: { config: { aviso_de_handoff: FRASE } }, error: null };
            throw new Error(`tabela inesperada: ${tabela}`);
          },
        });
        return cadeia;
      },
    } as never;
  }

  async function corpo(reason: string): Promise<string> {
    await avisarLeadDoCrm(banco(), {
      organizationId: ORG,
      conversationId: CONVERSA,
      contactId: CONTATO,
      reason,
    });
    expect(enviar).toHaveBeenCalledTimes(1);
    return (enviar.mock.calls[0] as unknown as [unknown, unknown, { body: string }])[2].body;
  }

  it("opt-out com frase própria no agente: sai a confirmação de saída, não a frase", async () => {
    const body = await corpo("suspected_optout");
    expect(body).toContain(FECHO_DO_OPT_OUT);
    expect(body).not.toContain(FRASE);
  });

  it("controle: quem pediu uma pessoa lê a frase do agente", async () => {
    expect(await corpo("requested_human")).toBe(FRASE);
  });
});
