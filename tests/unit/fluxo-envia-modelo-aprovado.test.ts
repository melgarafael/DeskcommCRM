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
 * - modelo que não pode sair (pendente, variável sem origem ou vazia) pula o
 *   passo com o motivo, sem tocar na cadeia — em vez de a fila re-tentar até
 *   matar a inscrição;
 * - modelo com variável e o mapa do passo: cada `{{n}}` sai com o nome do
 *   contato ou o campo do negócio, lidos na hora, no corpo E no que o canal recebe;
 * - o plano B da IA sai com a janela FECHADA e só com ela: aberta, a IA escreve;
 * - controle: texto pronto continua saindo como texto.
 *
 * ## O que NÃO prova
 *
 * Nada com Postgres real nem com a plataforma: que o canal aceita o modelo é do
 * adapter (`sendTemplate`), não deste turno.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

const CORPO = "Olá! Ainda pensando na cafeteira? Sai por R$ 169,90. Quer que a gente reserve?";

interface Cenario {
  /** corpo em `message_templates` (texto pronto) */
  texto?: string;
  /** a linha do modelo do canal, ou ausente */
  modelo?: { status: string; texto?: string };
  /** último inbound da conversa, em horas atrás (`null` = nunca escreveu) */
  ultimoInboundHa?: number | null;
  /** o contato, para as variáveis de nome */
  contato?: { name: string | null; display_name?: string | null };
  /** `custom_fields` do negócio mais recente */
  negocio?: Record<string, unknown>;
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
      return c.modelo ? { rows: [{ name: "lembrete_cafeteira", language: "es" }] } : { rows: [] };
    }
    if (/from message_templates/.test(sql)) return { rows: c.texto ? [{ body: c.texto }] : [] };
    if (/from channel_sessions s/.test(sql)) {
      const ha = c.ultimoInboundHa;
      return {
        rows: [{ provider: "zernio", last_inbound_at: ha === null || ha === undefined ? null : new Date(Date.now() - ha * HORA) }],
      };
    }
    if (/from conversations/.test(sql)) return { rows: [{ id: CONVERSA, channel_session_id: CANAL, archived_at: null }] };
    if (/select name, display_name from contacts/.test(sql)) {
      return { rows: c.contato ? [{ display_name: null, ...c.contato }] : [] };
    }
    if (/select custom_fields from crm_leads/.test(sql)) return { rows: c.negocio ? [{ custom_fields: c.negocio }] : [] };
    // A inscrição viva que o handler consulta ANTES do envio (guard da #1913).
    if (sql.includes("select current_node_id, status from followup_enrollments")) {
      return { rows: [{ current_node_id: "passo", status: "active" }] };
    }
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

// Relógio fixo DENTRO da janela anti-ban de disparo: desde a #3108 o passo de IA
// lê essa janela antes do turno, e com o relógio real os casos de "a IA
// escreve" viravam adiamento depois das 22h. Só o `Date` é falso, para a
// janela de 24 h (medida contra `Date.now()`) andar junto.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T15:00:00.000Z")); // terça, 12h em São Paulo
});
afterAll(() => {
  vi.useRealTimers();
});

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
    expect(send.mock.calls[0]![0].template).toEqual({ name: "lembrete_cafeteira", language: "es", values: {} });
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

  it("modelo com variável e SEM origem escolhida no passo: pulado, e o motivo diz qual", async () => {
    const { d, completeFollowupTurn } = deps();
    await criarHandler(d)(
      job({ template_id: MODELO_ID }),
      fakePool({ modelo: { status: "APPROVED", texto: "Hola {{1}}, ¿seguís interesado?" } }),
      { workerId: "w1" },
    );

    expect(runBeforeSend).not.toHaveBeenCalled();
    const r = resultado(completeFollowupTurn);
    expect(r.kind).toBe("skipped");
    expect(r.reason).toContain("{{1}} sem origem");
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
    expect(send.mock.calls[0]![0].template).toEqual({ name: "lembrete_cafeteira", language: "es", values: {} });
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

describe("passo `template` com variáveis, preenchidas pelo contato e pelo negócio", () => {
  const PEDIDO = "Olá {{1}}! Recebemos seu pedido: {{2}} por {{3}}.";
  const MAPA = {
    "1": { kind: "contact_first_name" },
    "2": { kind: "lead_custom", key: "produto_nome" },
    "3": { kind: "lead_custom", key: "preco_texto" },
  };
  const NEGOCIO = { produto_nome: "Cafeteira Elétrica", preco_texto: "R$ 189,90", produto: "cafeteira-eletrica" };

  it("⭐ cada {{n}} sai com o dado do contato e do negócio — no corpo e no que o canal recebe", async () => {
    const { d, send, completeFollowupTurn } = deps();
    await criarHandler(d)(
      job({ template_id: MODELO_ID, template_values: MAPA }),
      fakePool({ modelo: { status: "APPROVED", texto: PEDIDO }, contato: { name: "Maria José Pereira" }, negocio: NEGOCIO }),
      { workerId: "w1" },
    );

    expect(runBeforeSend).toHaveBeenCalledTimes(1);
    const cadeia = runBeforeSend.mock.calls[0]![0];
    expect(cadeia.isTemplate).toBe(true);
    // Os gates de conteúdo avaliam o texto que o cliente lê, não o marcador.
    expect(cadeia.body).toBe("Olá Maria! Recebemos seu pedido: Cafeteira Elétrica por R$ 189,90.");
    expect(send.mock.calls[0]![0].template).toEqual({
      name: "lembrete_cafeteira",
      language: "es",
      values: { "1": "Maria", "2": "Cafeteira Elétrica", "3": "R$ 189,90" },
    });
    expect(resultado(completeFollowupTurn).kind).toBe("sent");
  });

  it("campo vazio no negócio deste contato: pulado, sem parâmetro em branco, e o motivo nomeia o campo", async () => {
    const { d, completeFollowupTurn } = deps();
    await criarHandler(d)(
      job({ template_id: MODELO_ID, template_values: MAPA }),
      fakePool({
        modelo: { status: "APPROVED", texto: PEDIDO },
        contato: { name: "Maria" },
        negocio: { preco_texto: "R$ 189,90" },
      }),
      { workerId: "w1" },
    );

    expect(runBeforeSend).not.toHaveBeenCalled();
    const r = resultado(completeFollowupTurn);
    expect(r.kind).toBe("skipped");
    expect(r.reason).toContain('campo "produto_nome" do negócio');
  });

  it("contato sem nome de gente (só o número): o {{1}} do nome não sai em branco", async () => {
    const { d, completeFollowupTurn } = deps();
    await criarHandler(d)(
      job({ template_id: MODELO_ID, template_values: MAPA }),
      fakePool({ modelo: { status: "APPROVED", texto: PEDIDO }, contato: { name: "+5511987654321" }, negocio: NEGOCIO }),
      { workerId: "w1" },
    );

    expect(runBeforeSend).not.toHaveBeenCalled();
    expect(resultado(completeFollowupTurn).reason).toContain("primeiro nome do contato");
  });

  it("valor com quebra de linha vira uma linha só — a plataforma recusa parâmetro com \\n", async () => {
    const { d, send } = deps();
    await criarHandler(d)(
      job({ template_id: MODELO_ID, template_values: MAPA }),
      fakePool({
        modelo: { status: "APPROVED", texto: PEDIDO },
        contato: { name: "Ana" },
        negocio: { ...NEGOCIO, produto_nome: "Cafeteira\n   elétrica   inox" },
      }),
      { workerId: "w1" },
    );

    const enviado = send.mock.calls[0]![0].template as { values: Record<string, string> };
    expect(enviado.values["2"]).toBe("Cafeteira elétrica inox");
  });

  it("o plano B da IA não tem mapa: modelo com variável segue recusado ali", async () => {
    const { d, completeFollowupTurn } = deps();
    await criarHandler(d)(
      job({ prompt_hint: "Retomá la charla", fallback_template_id: MODELO_ID }),
      fakePool({ modelo: { status: "APPROVED", texto: PEDIDO }, ultimoInboundHa: 30, contato: { name: "Ana" }, negocio: NEGOCIO }),
      { workerId: "w1" },
    );

    expect(runBeforeSend).not.toHaveBeenCalled();
    expect(resultado(completeFollowupTurn).kind).toBe("skipped");
  });
});

/**
 * #2734 — passo de texto fixo com MÍDIA, no caminho do worker (`runFlowDrivenTurn`).
 * O outro caminho, o atalho inline, está em `lib/followup/enviar-texto-fixo.test.ts`.
 *
 * Sabotagem prevista: apagar o bloco `passo.midia !== undefined && janelaFechada(...)`
 * de `followup-turn.ts` deixa vermelho o caso da janela fechada — a mídia sai pela
 * cadeia e o canal é chamado.
 */
describe("passo de texto fixo com mídia (#2734)", () => {
  const URL_DA_MIDIA = "https://cdn.exemplo.com/oferta.png";

  it("⭐ janela de 24 h FECHADA: o passo é pulado com o motivo e o canal não é chamado — nem com o texto", async () => {
    const { d, send, completeFollowupTurn } = deps();
    await criarHandler(d)(
      job({ fixed_body: "Olha a oferta", fixed_media_url: URL_DA_MIDIA }),
      fakePool({ ultimoInboundHa: 30 }),
      { workerId: "w1" },
    );

    expect(send).not.toHaveBeenCalled();
    expect(runBeforeSend).not.toHaveBeenCalled();
    const r = resultado(completeFollowupTurn);
    expect(r.kind).toBe("skipped");
    expect(r.reason).toContain("janela de 24 horas");
  });

  it("URL de tipo que não é imagem nem PDF: o passo é RECUSADO com o motivo, sem tocar na cadeia", async () => {
    const { d, send, completeFollowupTurn } = deps();
    await criarHandler(d)(
      job({ fixed_body: "Segue o contrato", fixed_media_url: "https://cdn.exemplo.com/contrato.docx" }),
      fakePool({ ultimoInboundHa: 2 }),
      { workerId: "w1" },
    );

    expect(send).not.toHaveBeenCalled();
    expect(runBeforeSend).not.toHaveBeenCalled();
    const r = resultado(completeFollowupTurn);
    expect(r.kind).toBe("skipped");
    expect(r.reason).toContain("imagem");
  });

  it("controle: janela ABERTA — sai como mídia, com o texto de legenda", async () => {
    const { d, send, completeFollowupTurn } = deps();
    await criarHandler(d)(
      job({ fixed_body: "Olha a oferta", fixed_media_url: URL_DA_MIDIA }),
      fakePool({ ultimoInboundHa: 2 }),
      { workerId: "w1" },
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ body: "Olha a oferta", media: { url: URL_DA_MIDIA, mime: "image/png", type: "image" } });
    expect(resultado(completeFollowupTurn).kind).toBe("sent");
  });
});
