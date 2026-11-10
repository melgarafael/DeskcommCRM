import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/atendimento/fronteira-server", () => ({ guardServiceEffect: vi.fn(async () => {}) }));
vi.mock("@/lib/escalacao/disponibilidade", () => ({
  expectativaDeAtendimento: vi.fn(async () => ({ frase: "A equipe dará continuidade." })),
}));
vi.mock("@/lib/leads/agent-activity", () => ({ emitAgentActivityForContact: vi.fn(async () => true) }));
vi.mock("@/lib/agent-engine/cron/scheduler", () => ({ cancelPendingCronsForLead: vi.fn(async () => {}) }));

import { applyRequestHumanHandoff } from "@/lib/agent-engine/agent/human-handoff";
import { cancelPendingCronsForLead } from "@/lib/agent-engine/cron/scheduler";
import { FRASE_DO_MOTIVO } from "@/lib/escalacao/passagem";

const ids = { tenantId: "org-teste", leadId: "contato-teste", conversationId: "conversa-teste" };
const consultas: Array<{ sql: string; params: readonly unknown[] }> = [];
const db = {
  query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    consultas.push({ sql, params });
    return { rows: [], rowCount: 0 };
  }),
};
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };

async function passar(payload: unknown) {
  return applyRequestHumanHandoff(
    db as never,
    ids,
    {
      conversationSummary: "Pedido para finalização pela equipe.",
      contextoDoTurno: { checkpoint: null, pendentesDoCliente: ["Pode concluir o agendamento."] },
      avisoAoLead: { avisado: true },
      log: log as never,
    },
    payload,
  );
}

function consulta(padrao: RegExp) {
  const resultado = consultas.find(({ sql }) => padrao.test(sql));
  expect(resultado, `consulta esperada: ${padrao}`).toBeDefined();
  return resultado!;
}

describe("o motivo da passagem acionada pela ferramenta", () => {
  beforeEach(() => {
    consultas.length = 0;
    vi.clearAllMocks();
  });

  it("etapa crítica chega ao registro, ao briefing e à Central sem inventar pedido de atendente", async () => {
    const resultado = await passar({
      motivo_codigo: "critical_stage",
      por_que: "Os dados foram coletados, falta a equipe conferir disponibilidade e finalizar.",
      cliente_quer: "Concluir o agendamento",
    });
    expect(resultado).toMatchObject({ ok: true, status: "handoff_solicitado" });

    // INSERT real de registrarPassagem, com o briefing real (não dublês da montagem).
    const passagem = consulta(/insert into passagens_de_atendimento/).params;
    expect(passagem.slice(0, 7)).toEqual([
      ids.tenantId, ids.leadId, ids.conversationId, null, "engine", "ferramenta_do_modelo", "critical_stage",
    ]);
    expect(passagem[8]).toContain(`Por que a IA passou: ${FRASE_DO_MOTIVO.critical_stage}`);
    expect(passagem[8]).toContain("Concluir o agendamento");
    expect(passagem[8]).not.toContain(FRASE_DO_MOTIVO.requested_human);
    const central = consulta(/insert into agent_inbox_items/).params;
    expect(central[2]).toContain(FRASE_DO_MOTIVO.critical_stage);
    expect(central[2]).not.toContain("Concluir o agendamento");
    expect(central[2]).not.toContain(FRASE_DO_MOTIVO.requested_human);

    // Classificar não muda autoridade, isolamento ou o silêncio após a passagem.
    expect(consulta(/update contacts set force_human/).params).toEqual([ids.tenantId, ids.leadId]);
    const conversa = consulta(/update conversations/).params;
    expect(conversa.slice(0, 3)).toEqual([ids.tenantId, ids.conversationId, "infinity"]);
    expect(conversa[5]).toBe("{}");
    expect(cancelPendingCronsForLead).toHaveBeenCalledWith(db, ids.tenantId, ids.leadId);
    expect(log.info).toHaveBeenCalledWith(expect.any(String), {
      motivo_codigo: "critical_stage", origem: "ferramenta_do_modelo",
    });
  });

  // #3310: o motivo do cartão passa a ser o que foi DECLARADO. Ausência de
  // `motivo_codigo` e texto livre deixam de virar "o cliente pediu uma pessoa"
  // (o modelo é ensinado a declarar `requested_human` para o pedido de fato —
  // ver `PAYLOAD_TEACHING`); o que o chamador escreveu continua inteiro em
  // `conversations.last_handoff_reason`, que é a fonte do aviso ao lead.
  it.each([
    { payload: {}, motivo: "low_confidence", texto: "low_confidence" },
    { payload: { reason: "Texto do chamador antigo" }, motivo: "low_confidence", texto: "Texto do chamador antigo" },
    { payload: { por_que: "Pedido explícito", reason: "Sinônimo antigo" }, motivo: "low_confidence", texto: "Pedido explícito" },
    { payload: { motivo_codigo: "requested_human", por_que: "Quero falar com alguém" }, motivo: "requested_human", texto: "Quero falar com alguém" },
    { payload: { motivo_codigo: "critical_stage" }, motivo: "critical_stage", texto: "critical_stage" },
    { payload: { motivo_codigo: "critical_stage", reason: "Conclusão pela equipe" }, motivo: "critical_stage", texto: "Conclusão pela equipe" },
  ])("preserva o contrato para $payload", async ({ payload, motivo, texto }) => {
    expect((await passar(payload)).ok).toBe(true);
    expect(consulta(/insert into passagens_de_atendimento/).params[6]).toBe(motivo);
    expect(consulta(/update conversations/).params[3]).toBe(texto);
  });

  it.each(["inventado", "orcamento_de_ia", "suspected_optout", "caso_escalado", "verificacao_manual", "__proto__", "", null, 1])(
    "recusa motivo inválido ou reservado %j antes dos efeitos do wrapper",
    async (motivo_codigo) => {
      expect(await passar({ motivo_codigo })).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
      expect(db.query).not.toHaveBeenCalled();
      expect(cancelPendingCronsForLead).not.toHaveBeenCalled();
    },
  );

  it("não aceita IDs forjados junto com um motivo válido", async () => {
    expect(await passar({ motivo_codigo: "critical_stage", tenantId: "outra-org" })).toMatchObject({
      ok: false, error: { code: "invalid_payload" },
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("mantém a recusa de poluição de protótipo", async () => {
    const payload: unknown = JSON.parse('{"motivo_codigo":"critical_stage","__proto__":{"tenantId":"outra-org"}}');
    expect(await passar(payload)).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
    expect(db.query).not.toHaveBeenCalled();
  });
});
