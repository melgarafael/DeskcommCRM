/**
 * O PASSO DE FLUXO MANDA O MODELO APROVADO DO CANAL.
 *
 * ## O defeito
 *
 * O modo `template` do passo de ação só lia `message_templates` — os textos
 * prontos de Ajustes → Modelos. Texto livre é exatamente o que o canal oficial
 * recusa quando a janela de 24 h fechou, e é aí que um fluxo de reengajamento
 * fala. Um fluxo apontado para um modelo APROVADO (`meta_templates`) passava na
 * validação, era publicado, e morria no primeiro disparo com "o template_id do
 * passo não existe nesta organização". Medido numa instalação real: o passo
 * "Última oportunidade (plantilla)" de um remarketing nunca teria saído.
 *
 * O irmão do defeito: `fallback_template_id` da mensagem por IA ("se a IA não
 * conseguir escrever, mandar este modelo") era gravado, validado no publish e
 * nunca lido por ninguém em runtime.
 *
 * ## O que este arquivo prende
 *
 * - modelo aprovado sai COMO MODELO: a cadeia recebe `isTemplate` (só o gate da
 *   janela o deixa passar) e o canal recebe nome e idioma;
 * - modelo que não pode sair (pendente, com variável) pula o passo com o motivo,
 *   sem tocar na cadeia — em vez de a fila re-tentar até matar a inscrição;
 * - o plano B da IA sai com a janela FECHADA e só com ela: aberta, a IA escreve;
 * - controle: texto pronto continua saindo como texto.
 *
 * ## O que NÃO prova
 *
 * Nada com Postgres real nem com a plataforma: que o canal aceita o modelo é do
 * adapter (`sendTemplate`), não deste turno.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobRow } from "@/lib/agent-engine/queue/queue";

const runBeforeSend = vi.fn(async (args: Record<string, unknown>) => {
  await (args.send as (b: string) => Promise<unknown>)(args.body as string);
  return { status: "sent", outcome: { kind: "sent" }, trace: [] };
});
vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({ runBeforeSend }));

vi.mock("@/lib/agent-engine/agent/human-handoff", () => ({ isLeadInHandoff: vi.fn(async () => false) }));

vi.mock("@/lib/agent-engine/edge/crm/get-lead-context", () => ({
  getLeadContext: vi.fn(async () => ({
    ok: true,
    context: { contact: { is_blocked: false } },
    lgpd: { isAnonymized: false, isProspecting: false, legalBasis: {} },
  })),
}));

const runAgentTurn = vi.fn(async () => undefined);
vi.mock("@/lib/agent-engine/agent/inbound-turn", async (original) => ({
  ...(await original<typeof import("@/lib/agent-engine/agent/inbound-turn")>()),
  runAgentTurn,
}));
vi.mock("@/lib/agent-engine/edge/crm/send-ledger", () => ({
  resultadoDoEnvioDoFollowup: vi.fn(async () => ({ kind: "sent" })),
}));

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const CANAL = "canal-1";
const MODELO_ID = "22222222-2222-4222-8222-222222222222";
const HORA = 3_600_000;

const boundary = { organization_id: ORG, contact_id: LEAD, conversation_id: CONVERSA, service_revision: 1, demanda_id: null, demanda_revision: null };

function job(payload: Record<string, unknown>): JobRow {
  return {
    id: "job-1",
    organization_id: ORG,
    contact_id: LEAD,
    kind: "followup_turn",
    source_event_id: null,
    payload: {
      followup_enrollment_id: "11111111-1111-4111-8111-111111111111",
      node_id: "passo",
      purpose: "send_message",
      ...payload,
      service_boundary: boundary,
    },
    status: "running",
    priority: 0,
    run_after: new Date(),
    attempts: 1,
    max_attempts: 3,
    last_error: null,
    locked_by: "w1",
    locked_at: new Date(),
    created_at: new Date(),
  } as JobRow;
}

const CORPO = "¡Hola! ¿Seguís pensando en el Pico? Sale ₲125.000. ¿Te lo reservamos?";

interface Cenario {
  /** corpo em `message_templates` (texto pronto) */
  texto?: string;
  /** a linha do modelo do canal, ou ausente */
  modelo?: { status: string; texto?: string };
  /** último inbound da conversa, em horas atrás (`null` = nunca escreveu) */
  ultimoInboundHa?: number | null;
}

function fakePool(c: Cenario) {
  const query = vi.fn(async (sql: string): Promise<{ rows: Array<Record<string, unknown>> }> => {
    if (sql.includes("d.fechada_em::text")) return { rows: [{ ...boundary, status: "open", demanda_fechada_em: null }] };
    // A ordem importa: a definição da conexão e a janela citam outras tabelas no corpo.
    if (/from meta_templates t/.test(sql)) {
      return c.modelo
        ? { rows: [{ components: [{ type: "BODY", text: c.modelo.texto ?? CORPO }], parameter_format: "POSITIONAL", status: c.modelo.status }] }
        : { rows: [] };
    }
    if (/select name, language from meta_templates/.test(sql)) {
      return c.modelo ? { rows: [{ name: "recordatorio_pico", language: "es" }] } : { rows: [] };
    }
    if (/from message_templates/.test(sql)) return { rows: c.texto ? [{ body: c.texto }] : [] };
    if (/from channel_sessions s/.test(sql)) {
      const ha = c.ultimoInboundHa;
      return {
        rows: [{ provider: "zernio", last_inbound_at: ha === null || ha === undefined ? null : new Date(Date.now() - ha * HORA) }],
      };
    }
    if (/from conversations/.test(sql)) return { rows: [{ id: CONVERSA, channel_session_id: CANAL, archived_at: null }] };
    return { rows: [] };
  });
  return { query } as never;
}

function deps() {
  const send = vi.fn(async (_input: Record<string, unknown>) => ({ ok: true }));
  const completeFollowupTurn = vi.fn(async () => undefined);
  const d = {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    crmCfg: {},
    llmCfg: {},
    knobs: {},
    channel: () => ({ send }),
    completeFollowupTurn,
  } as never;
  return { d, send, completeFollowupTurn };
}

function resultado(completeFollowupTurn: ReturnType<typeof vi.fn>): { kind: string; reason?: string } {
  const entrada = (completeFollowupTurn.mock.calls[0] as unknown[] | undefined)?.[1] as { result: { kind: string; reason?: string } } | undefined;
  return entrada?.result ?? { kind: "(não chamou)" };
}

let criarHandler: typeof import("@/lib/agent-engine/agent/followup-turn").createFollowupTurnHandler;

beforeAll(async () => {
  ({ createFollowupTurnHandler: criarHandler } = await import("@/lib/agent-engine/agent/followup-turn"));
}, 60_000);

beforeEach(() => {
  runBeforeSend.mockClear();
  runAgentTurn.mockClear();
});

describe("passo `template` apontado para um modelo aprovado do canal", () => {
  it("⭐ sai como MODELO: a cadeia sabe que é modelo e o canal recebe nome e idioma", async () => {
    const { d, send, completeFollowupTurn } = deps();
    await criarHandler(d)(job({ template_id: MODELO_ID }), fakePool({ modelo: { status: "APPROVED" }, ultimoInboundHa: 72 }), { workerId: "w1" });

    expect(runBeforeSend).toHaveBeenCalledTimes(1);
    const cadeia = runBeforeSend.mock.calls[0]![0];
    expect(cadeia.isTemplate).toBe(true);
    expect(cadeia.body).toBe(CORPO);
    expect(send.mock.calls[0]![0].template).toEqual({ name: "recordatorio_pico", language: "es", values: {} });
    expect(resultado(completeFollowupTurn).kind).toBe("sent");
  });

  it("modelo ainda em análise: o passo é pulado com o motivo, sem tocar na cadeia", async () => {
    const { d, completeFollowupTurn } = deps();
    await criarHandler(d)(job({ template_id: MODELO_ID }), fakePool({ modelo: { status: "PENDING" } }), { workerId: "w1" });

    expect(runBeforeSend).not.toHaveBeenCalled();
    const r = resultado(completeFollowupTurn);
    expect(r.kind).toBe("skipped");
    expect(r.reason).toContain("PENDING");
  });

  it("modelo com variável: pulado — o fluxo não tem de onde tirar o {{1}}", async () => {
    const { d, completeFollowupTurn } = deps();
    await criarHandler(d)(
      job({ template_id: MODELO_ID }),
      fakePool({ modelo: { status: "APPROVED", texto: "Hola {{1}}, ¿seguís interesado?" } }),
      { workerId: "w1" },
    );

    expect(runBeforeSend).not.toHaveBeenCalled();
    expect(resultado(completeFollowupTurn).kind).toBe("skipped");
  });

  it("controle: texto pronto de Ajustes → Modelos continua saindo como TEXTO", async () => {
    const { d, send } = deps();
    await criarHandler(d)(job({ template_id: MODELO_ID }), fakePool({ texto: "oi, tudo bem?" }), { workerId: "w1" });

    expect(runBeforeSend).toHaveBeenCalledTimes(1);
    expect(runBeforeSend.mock.calls[0]![0].isTemplate).toBeUndefined();
    expect(send.mock.calls[0]![0].template).toBeUndefined();
  });
});

describe("plano B da mensagem por IA (`fallback_template_id`)", () => {
  const PASSO_IA = { prompt_hint: "Retomá la charla", fallback_template_id: MODELO_ID };

  it("⭐ janela de 24 h FECHADA: sai o modelo aprovado e a IA não é chamada", async () => {
    const { d, send, completeFollowupTurn } = deps();
    await criarHandler(d)(job(PASSO_IA), fakePool({ modelo: { status: "APPROVED" }, ultimoInboundHa: 30 }), { workerId: "w1" });

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(runBeforeSend.mock.calls[0]![0].isTemplate).toBe(true);
    expect(send.mock.calls[0]![0].template).toEqual({ name: "recordatorio_pico", language: "es", values: {} });
    expect(resultado(completeFollowupTurn).kind).toBe("sent");
  });

  it("⭐ janela ABERTA: a IA escreve, como sempre — o plano B não passa na frente", async () => {
    const { d } = deps();
    await criarHandler(d)(job(PASSO_IA), fakePool({ modelo: { status: "APPROVED" }, ultimoInboundHa: 2 }), { workerId: "w1" });

    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(runBeforeSend).not.toHaveBeenCalled();
  });

  it("plano B apontado para texto pronto (legado): segue para a IA, que é o que sempre fez", async () => {
    // Texto livre seria recusado pela mesma janela fechada — trocá-lo pela IA
    // não perderia nada, e pular a IA por ele seria regressão.
    const { d } = deps();
    await criarHandler(d)(job(PASSO_IA), fakePool({ texto: "oi", ultimoInboundHa: 30 }), { workerId: "w1" });

    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });
});
