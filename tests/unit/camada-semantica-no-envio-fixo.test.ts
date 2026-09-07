/**
 * A ESCOLHA DA ORGANIZAÇÃO TEM DE ALCANÇAR OS DOIS CHAMADORES — E SÓ UM DELES.
 *
 * ## O defeito que este arquivo existe para não deixar voltar
 *
 * O PR #346 unificou dois caminhos de envio sem LLM numa função só
 * (`sendFixedOutbound`), e escreveu no cabeçalho dela a razão de um deles:
 * texto de fluxo é do operador e não passa pela classificação semântica de
 * promessa, porque ela exige LLM e barrava o 1º outbound de captação sem BYOK.
 *
 * A razão está certa — para aquele chamador. O outro, a re-entrada
 * determinística por TEMPLATE, passava pela camada na `main` sempre que a
 * organização a ligava, pelo motivo escrito lá: "a re-entrada determinística
 * passa pela MESMA cadeia, então tem de honrar a MESMA preferência. Ler só no
 * inbound deixaria a camada ligada num caminho e desligada no outro, para a
 * mesma organização."
 *
 * Ao juntar os dois, a razão do primeiro passou a valer para o segundo em
 * silêncio. Medido no merge: `promiseSemantic`, `camadaLigada` e
 * `lerCamadasDaOrg` sumiram do arquivo (2/2/2 na base do PR → 0/0/0 no PR).
 *
 * ## Por que este teste, se já existe `camada-lida-no-motor.test.ts`
 *
 * Porque aquele mede TEXTO — ele mesmo declara isso no cabeçalho. Medido: com
 * o conserto aplicado e o chamador do template sabotado para `false`, ele
 * continua **3/3 verde**. Ele guarda que o knob é CITADO no arquivo; não guarda
 * QUAL chamador o recebe, que é exatamente onde o defeito mora.
 *
 * Este aqui guarda comportamento: dubla `runBeforeSend` e pergunta se
 * `classifyPromiseSemantic` chegou nele. E guarda os DOIS lados — porque um
 * teste que só exigisse a presença empurraria alguém a ligar a camada também no
 * texto de fluxo, desfazendo a decisão que o PR tomou com razão.
 *
 * A escolha da ORG entra ligada e o knob do ambiente entra DESLIGADO de
 * propósito: assim o verde só é possível se a preferência da organização tiver
 * viajado até a cadeia. Com os dois ligados, o teste passaria pelo motivo errado.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobRow } from "@/lib/agent-engine/queue/queue";

// O parâmetro é DECLARADO para que `mock.calls[0][0]` exista para o typechecker:
// sem ele o vitest infere a tupla vazia e o `pnpm typecheck` reprova o arquivo.
const runBeforeSend = vi.fn(async (_args: Record<string, unknown>) => ({
  status: "sent",
  outcome: {},
  trace: [],
}));
vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({ runBeforeSend }));

vi.mock("@/lib/agent-engine/agent/human-handoff", () => ({
  isLeadInHandoff: vi.fn(async () => false),
}));

vi.mock("@/lib/agent-engine/edge/crm/get-lead-context", () => ({
  getLeadContext: vi.fn(async () => ({
    ok: true,
    context: { contact: { is_blocked: false } },
    lgpd: { isAnonymized: false, isProspecting: false, legalBasis: {} },
  })),
}));

vi.mock("@/lib/agent-engine/agent/reentry-template", () => ({
  loadReentryTemplate: vi.fn(async () => ({ variants: ["oi, tudo bem?"] })),
  pickReentryVariant: vi.fn(() => "oi, tudo bem?"),
}));

vi.mock("@/lib/agent-engine/edge/crm/send-message", () => ({
  applySendOutcome: vi.fn(async () => undefined),
}));

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const CANAL = "canal-1";

const boundary = { organization_id: ORG, contact_id: LEAD, conversation_id: CONVERSA, service_revision: 1, demanda_id: null, demanda_revision: null };

function job(payload: Record<string, unknown>): JobRow {
  return {
    id: "job-1",
    organization_id: ORG,
    contact_id: LEAD,
    kind: "followup_turn",
    source_event_id: null,
    payload: { ...payload, service_boundary: boundary },
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

/** Pool mínimo: resolve a conversa e devolve a escolha da organização. */
function fakePool(camadaDaOrg: boolean) {
  const query = vi.fn(async (sql: string): Promise<{ rows: Array<Record<string, unknown>> }> => {
    if (sql.includes("d.fechada_em::text")) return { rows: [{ ...boundary, status: "open", demanda_fechada_em: null }] };
    if (/from org_guardrail_layers/.test(sql)) {
      return { rows: [{ layer: "promessa_semantica", enabled: camadaDaOrg }] };
    }
    if (/from conversations/.test(sql)) {
      return { rows: [{ id: CONVERSA, channel_session_id: CANAL, archived_at: null }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, query };
}

const ctx = { workerId: "w1" };

function deps() {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    crmCfg: {},
    llmCfg: {},
    // O knob do AMBIENTE fica DESLIGADO: se o teste ficar verde, foi a escolha
    // da organização que chegou até a cadeia, e não o default do worker.
    knobs: { promiseSemantic: { enabled: false } },
    channel: () => ({ send: vi.fn(async () => ({ ok: true })) }),
    completeFollowupTurn: vi.fn(async () => undefined),
  } as never;
}

let criarHandler: typeof import("@/lib/agent-engine/agent/followup-turn").createFollowupTurnHandler;

// Fora do relógio do `it()` pelo mesmo motivo de `followup-canal-arquivado`:
// o transform do grafo do agent-engine seria cronometrado como asserção.
beforeAll(async () => {
  ({ createFollowupTurnHandler: criarHandler } = await import(
    "@/lib/agent-engine/agent/followup-turn"
  ));
}, 60_000);

beforeEach(() => {
  runBeforeSend.mockClear();
});

function classificadorRecebido(): boolean {
  const arg = runBeforeSend.mock.calls[0]?.[0];
  return arg !== undefined && typeof arg.classifyPromiseSemantic === "function";
}

describe("camada semântica no envio fixo — a escolha da organização alcança quem deve", () => {
  it("⭐ re-entrada por TEMPLATE com a camada ligada na org: o classificador chega à cadeia", async () => {
    const { pool } = fakePool(true);
    await criarHandler(deps())(job({ mode: "template" }), pool, ctx);

    expect(runBeforeSend).toHaveBeenCalledTimes(1);
    expect(classificadorRecebido()).toBe(true);
  });

  it("re-entrada por TEMPLATE com a camada DESLIGADA na org: não chega (a escolha vale nos dois sentidos)", async () => {
    const { pool } = fakePool(false);
    await criarHandler(deps())(job({ mode: "template" }), pool, ctx);

    expect(runBeforeSend).toHaveBeenCalledTimes(1);
    expect(classificadorRecebido()).toBe(false);
  });

  it("⭐ texto de FLUXO nunca passa pela camada — nem com ela ligada na org", async () => {
    // A decisão do #346, e ela fica guardada: ligar a camada aqui barraria o 1º
    // outbound de captação de quem não tem BYOK.
    const { pool } = fakePool(true);
    await criarHandler(deps())(
      job({
        followup_enrollment_id: "11111111-1111-4111-8111-111111111111",
        node_id: "node-1",
        purpose: "send_message",
        fixed_body: "oi, tudo bem?",
      }),
      pool,
      ctx,
    );

    expect(runBeforeSend).toHaveBeenCalledTimes(1);
    expect(classificadorRecebido()).toBe(false);
  });

  it("controle positivo: a cadeia foi mesmo exercitada, com corpo e destino", async () => {
    // Sem isto, um refactor que deixasse de chamar `runBeforeSend` faria as três
    // asserções acima passarem por vacuidade — o `false` de instrumento morto é
    // idêntico ao `false` de camada desligada.
    const { pool } = fakePool(true);
    await criarHandler(deps())(job({ mode: "template" }), pool, ctx);

    const arg = runBeforeSend.mock.calls[0]?.[0];
    expect(arg, "runBeforeSend não foi chamado — instrumento morto").toBeDefined();
    if (arg === undefined) return;
    expect(arg.tenantId).toBe(ORG);
    expect(arg.leadId).toBe(LEAD);
    expect(arg.channelSessionId).toBe(CANAL);
    expect(arg.body).toBe("oi, tudo bem?");
  });
});
