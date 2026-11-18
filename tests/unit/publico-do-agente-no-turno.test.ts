/**
 * O PÚBLICO DO AGENTE **NO TURNO DE VERDADE** (#3722).
 *
 * Os testes da régua (`publico-do-gatilho.test.ts`) provam a decisão e os de
 * `agent-config.test.ts` provam QUEM é escolhido. Nenhum dos dois prova a
 * LIGAÇÃO que faz o defeito da issue sumir: o turno com `config: null` por
 * causa do público termina em SILÊNCIO, em vez de cair no agente genérico —
 * que não tem público nenhum e voltaria a vender para o cliente com contrato.
 *
 * Este arquivo roda `runAgentTurn` (o caminho de produção, com a abertura real
 * e o portão no lugar em que ele mora) e mede o desfecho de cada turno:
 *
 *  - silenciado: o turno RESOLVE sem chegar ao modelo, com o motivo no log;
 *  - CONTROLE (sem o sinal): a mesma resolução sem o marcador atravessa até a
 *    primeira chamada de modelo, que para por falta de config de LLM na org
 *    (`/config LLM/`). É a prova de que quem cala é o portão do público, e não
 *    o `config: null` por acidente.
 *
 * Remover o portão de `inbound-turn.ts` deixa o primeiro caso VERMELHO — ele
 * passa a lançar `/config LLM/`, que é exatamente o genérico assumindo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  passagem: vi.fn(),
  emHandoff: vi.fn(),
  aviso: vi.fn(),
  cancel: vi.fn(),
}));

// Só os EFEITOS do handoff são dublados; as detecções seguem as reais (o que se
// prova aqui é o silêncio, não a detecção).
vi.mock("@/lib/agent-engine/agent/human-handoff", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isLeadInHandoff: mocks.emHandoff,
  performHumanHandoff: mocks.passagem,
}));
vi.mock("@/lib/agent-engine/agent/aviso-de-escalacao", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  avisarLeadDaEscalacao: mocks.aviso,
}));
vi.mock("@/lib/agent-engine/cron/scheduler", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  cancelPendingCronsForLead: mocks.cancel,
}));

import { runAgentTurn } from "@/lib/agent-engine/agent/inbound-turn";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const CANAL = "44444444-4444-4444-8444-444444444444";
const JOB = "55555555-5555-4555-8555-555555555555";
const MENSAGEM = "66666666-6666-4666-8666-666666666666";

const CONTATO_LINHA = {
  name: "Cliente com contrato",
  display_name: null,
  email: null,
  phone_number: "5511999999999",
  tags: ["cliente ativo"],
  is_blocked: false,
  is_personal: false,
  source: "whatsapp",
  consent: null,
  is_anonymized: false,
};

/** O mínimo que a abertura real consulta; o resto cai em `rows: []`. */
function poolDaConversa() {
  return {
    query: vi.fn(async (sql: string) => {
      if (/from contacts where organization_id = \$1 and id = \$2/.test(sql)) {
        return { rows: [CONTATO_LINHA] };
      }
      if (sql.includes("playbook_pointers")) {
        return { rows: [{ layer: "platform", version_id: "v1", content: "plataforma" }] };
      }
      return { rows: [] };
    }),
  } as never;
}

function logFalso() {
  const info = vi.fn();
  return { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn(), infoChamado: info };
}

/**
 * O turno REAL, com a resolução que a seleção devolveria.
 *
 * `silencioPeloPublico` é o que `escolherAgenteDoNumero` produz quando o
 * motivo é `publico_barrou` — e é o único sinal que separa "nenhum agente
 * atende este público" de "não há agente publicado" (que segue no genérico).
 */
async function turno(
  pool: never,
  log: ReturnType<typeof logFalso>,
  silencioPeloPublico: boolean,
): Promise<void> {
  const job = {
    id: JOB,
    organization_id: ORG,
    contact_id: CONTATO,
    kind: "inbound_turn",
    payload: {},
    attempts: 1,
    claimed_by: "w",
    claimed_at: new Date(),
  };
  const deps = {
    log,
    llmCfg: {},
    crmCfg: {},
    knobs: { maxSteps: 1 },
    clock: () => new Date("2026-10-06T15:00:00Z"),
    channel: () => ({ send: vi.fn(async () => ({ kind: "sent" })) }),
  };
  await runAgentTurn(deps as never, job as never, pool, { workerId: "w" }, {
    resolvedAgent: {
      config: null,
      routerId: null,
      intentName: null,
      confidence: null,
      outcome: "no_router",
      ...(silencioPeloPublico ? { silencioPeloPublico: true } : {}),
    },
    channelSessionId: CANAL,
    conversationId: CONVERSA,
    inboundMessageId: MENSAGEM,
    buildOpening: () => "",
  } as never);
}

const mensagensDeLog = (log: ReturnType<typeof logFalso>): string[] =>
  log.infoChamado.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.emHandoff.mockResolvedValue(false);
  mocks.aviso.mockResolvedValue({ avisado: true });
  mocks.passagem.mockResolvedValue(undefined);
  mocks.cancel.mockResolvedValue(0);
});

describe("turno REAL — o público que barra cala o turno (e o genérico não assume)", () => {
  it("nenhum agente elegível: o turno encerra sem modelo e com o motivo no log", async () => {
    const log = logFalso();
    await expect(turno(poolDaConversa(), log, true)).resolves.toBeUndefined();
    expect(
      mensagensDeLog(log).some((m) => m.includes("turno pulado") && m.includes("público")),
      "o motivo do silêncio tem de estar no log — sem ele o operador não descobre por que o cliente ficou sem resposta",
    ).toBe(true);
    expect(mocks.passagem, "público barrado não é passagem para humano").not.toHaveBeenCalled();
  });

  it("CONTROLE — sem o marcador do público, o mesmo turno cai no genérico (/config LLM/)", async () => {
    // É o comportamento de ANTES do conserto: config null e sem o sinal ⇒ o
    // turno segue no agente genérico. Sem esta metade, o primeiro caso
    // passaria com o portão removido.
    await expect(turno(poolDaConversa(), logFalso(), false)).rejects.toThrow(/config LLM/);
  });
});
