/**
 * ESPERAR A JANELA ABRIR NÃO PODE SER LIDO COMO "O WORKER MORREU".
 *
 * ## O defeito, e de quem ele é
 *
 * O nó `action` tem um dead-man: se o turno de envio não fechar depois de
 * `MAX_ACTION_RECHECKS` rechecks, o motor marca o enrollment `dead` com
 * `action_turn_never_completed` e abre um aviso na Central. Ele existe para o
 * worker morto, e está certo em existir.
 *
 * O que ele não sabia distinguir é a espera LEGÍTIMA. Quando a cadeia de envio
 * recusa por `outside_window`, o turno re-agenda o job para a abertura da
 * janela e devolve "adiado" — e esse "adiado" não voltava para o enrollment:
 * `runFlowDrivenTurn` chamava `completeFollowupTurn` no caminho enviado e no
 * recusado, e no adiado não chamava ninguém. Do lado do motor, o turno
 * simplesmente nunca fechava; ele rechecava, gastava o orçamento e matava um
 * enrollment cujo envio ainda ia acontecer — com um motivo falso escrito no
 * dossiê e o aviso "Um fluxo de follow-up parou de tentar" na tela de quem
 * tinha configurado exatamente aquele horário.
 *
 * O orçamento é de TEMPO, não de tentativas (o backoff de `atrasoDoRecheck`
 * cresce até 1h), e dá ~11,25h. As esperas que a `main` já suporta passam
 * disso com folga: janela anti-ban 7h-22h com `allow_sunday=false` fecha 33h
 * de sábado a segunda, e a faixa de envio por agente (PR #1134) permite um
 * único dia da semana — 159h. Subir o teto não resolve a classe: não existe
 * número que vença uma espera que o operador configura.
 *
 * ## O conserto que este arquivo guarda, e por que são TRÊS asserções
 *
 * O turno passou a DIZER que estacionou (`{kind:'deferred', until}`), a ponte
 * passou a estacionar o enrollment nesse instante em vez de deixá-lo rechecando,
 * e o dead-man passou a contar a ociosidade DESDE a última prova de vida. Os
 * três são um conserto só, e cada bloco abaixo prende um deles: tirar qualquer
 * um, sozinho, tem de deixar este arquivo vermelho.
 *
 * ## O que este arquivo NÃO prova
 *
 * Nada com Postgres real (a ponte de produção passa por `fn_followup_apply_step`,
 * que só o `test:db` exercita), nada pela tela, e nada sobre o job re-agendado
 * chegar a enviar — isso é da fila, não do motor.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { runFollowupTick, type AdminClient, type FollowupJobRequest } from "@/lib/followup/engine";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import {
  EVENTO_ACAO_ADIADA,
  MAX_ACTION_RECHECKS,
  type EnrollmentEventRef,
  type EnrollmentRow,
} from "@/lib/followup/node-handlers";
import { completeTurnForEnrollment, type TurnBridgeAdminClient } from "@/lib/followup/turn-bridge";

// ---------------------------------------------------------------------------
// Bloco 1 — o turno REPORTA o adiamento (a origem do silêncio)
// ---------------------------------------------------------------------------

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const CANAL = "canal-1";

/** Sexta 18:00 → segunda 09:00, o padrão de fábrica do editor de faixa: 63h. */
const SEXTA_18H = new Date("2026-09-18T21:00:00.000Z");
const SEGUNDA_09H = new Date("2026-09-21T12:00:00.000Z");

const JANELA_ABERTA = { status: "sent", outcome: { kind: "sent" }, trace: [] };
const chain = vi.fn(async (_args: Record<string, unknown>) => JANELA_ABERTA as unknown as Record<string, unknown>);
vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({
  runBeforeSend: (args: Record<string, unknown>) => chain(args),
}));

vi.mock("@/lib/agent-engine/agent/human-handoff", () => ({ isLeadInHandoff: vi.fn(async () => false) }));

vi.mock("@/lib/agent-engine/edge/crm/get-lead-context", () => ({
  getLeadContext: vi.fn(async () => ({
    ok: true,
    context: { contact: { is_blocked: false } },
    lgpd: { isAnonymized: false, isProspecting: false, legalBasis: {} },
  })),
}));

// O re-agendamento é o OUTRO lado da corda e tem dono próprio (F3-01). Aqui ele
// é dublado porque o que se mede é o RETORNO ao enrollment, não o cron.
const scheduleCronJob = vi.fn(async () => undefined);
vi.mock("@/lib/agent-engine/cron/scheduler", () => ({ scheduleCronJob }));

const boundary = {
  organization_id: ORG,
  contact_id: LEAD,
  conversation_id: CONVERSA,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};

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
    run_after: SEXTA_18H,
    attempts: 1,
    max_attempts: 3,
    last_error: null,
    locked_by: "w1",
    locked_at: SEXTA_18H,
    created_at: SEXTA_18H,
  } as JobRow;
}

function fakePool() {
  const query = vi.fn(async (sql: string): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }> => {
    if (sql.includes("d.fechada_em::text")) return { rows: [{ ...boundary, status: "open", demanda_fechada_em: null }] };
    if (/from conversations/.test(sql)) return { rows: [{ id: CONVERSA, channel_session_id: CANAL, archived_at: null }] };
    // A inscrição viva que o handler consulta ANTES do envio (guard da #1913).
    if (sql.includes("select current_node_id, status from followup_enrollments")) {
      return { rows: [{ current_node_id: "a1", status: "active" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { query } as never;
}

const PAYLOAD_DE_FLUXO = {
  followup_enrollment_id: "11111111-1111-4111-8111-111111111111",
  node_id: "a1",
  purpose: "send_message",
  fixed_body: "oi, tudo bem?",
};

let criarHandler: typeof import("@/lib/agent-engine/agent/followup-turn").createFollowupTurnHandler;

beforeAll(async () => {
  ({ createFollowupTurnHandler: criarHandler } = await import("@/lib/agent-engine/agent/followup-turn"));
}, 60_000);

beforeEach(() => {
  // `mockClear` NÃO desfaz `mockImplementation` — sem repor a janela aberta, o
  // veto do caso anterior vazava para o controle positivo e ele acusava um
  // defeito que não existia.
  chain.mockReset();
  chain.mockImplementation(async () => JANELA_ABERTA as unknown as Record<string, unknown>);
  scheduleCronJob.mockClear();
});

function depsComCallback() {
  const completeFollowupTurn = vi.fn(async () => undefined);
  const deps = {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    crmCfg: {},
    llmCfg: {},
    knobs: {},
    channel: () => ({ send: vi.fn(async () => ({ ok: true })) }),
    completeFollowupTurn,
  } as never;
  return { deps, completeFollowupTurn };
}

describe("o turno de envio devolve o ADIAMENTO ao enrollment", () => {
  it("⭐ janela fechada: o enrollment é avisado, com o instante da abertura", async () => {
    chain.mockImplementation(async () => ({
      status: "vetoed",
      code: "outside_window",
      nextAllowedAt: SEGUNDA_09H,
      trace: [],
    }) as unknown as Record<string, unknown>);
    const { deps, completeFollowupTurn } = depsComCallback();

    await criarHandler(deps)(job(PAYLOAD_DE_FLUXO), fakePool(), { workerId: "w1" });

    expect(completeFollowupTurn, "o adiamento não voltou para o enrollment").toHaveBeenCalledTimes(1);
    const entrada = (completeFollowupTurn.mock.calls[0] as unknown[])[1] as {
      result: { kind: string; until?: Date };
    };
    expect(entrada.result.kind).toBe("deferred");
    expect(entrada.result.until?.toISOString()).toBe(SEGUNDA_09H.toISOString());
  });

  it("controle positivo: com a janela ABERTA o mesmo caminho reporta 'sent'", async () => {
    // Sem isto, um handler que parasse de chamar o callback deixaria o caso
    // acima vermelho por morte do instrumento, e não por regressão do conserto.
    const { deps, completeFollowupTurn } = depsComCallback();

    await criarHandler(deps)(job(PAYLOAD_DE_FLUXO), fakePool(), { workerId: "w1" });

    expect(chain).toHaveBeenCalledTimes(1);
    expect(completeFollowupTurn).toHaveBeenCalledTimes(1);
    const entrada = (completeFollowupTurn.mock.calls[0] as unknown[])[1] as { result: { kind: string } };
    expect(entrada.result.kind).toBe("sent");
  });
});

// ---------------------------------------------------------------------------
// Bloco 2 e 3 — a ponte estaciona, e o dead-man não gasta orçamento com espera
// ---------------------------------------------------------------------------

const GRAFO: FlowGraph = {
  nodes: [
    { id: "a1", type: "action", label: "Mensagem", position: { x: 0, y: 0 }, config: { mode: "text", body: "oi" } },
    { id: "e1", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [{ id: "a1-e1", source: "a1", target: "e1", priority: 0, condition: { type: "always" } }],
};

const GRAFO_CONFIRMACAO: FlowGraph = {
  nodes: [
    {
      id: "m1",
      type: "match_reply",
      label: "Confere o nome",
      position: { x: 0, y: 0 },
      config: {
        branches: [{ id: "ok", label: "Ok", op: "eq", pattern: "sim" }],
        grace_timeout_ms: 900_000,
        save_to: { kind: "contact_name" },
        if_exists: "confirm",
      },
    },
    { id: "e1", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [{ id: "m1-e1", source: "m1", target: "e1", priority: 0, condition: { type: "always" } }],
};

interface EventoGravado {
  node_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  idempotency_key: string | null;
}

/** Motor + ponte sobre a MESMA loja em memória — é o par que o defeito usava. */
function loja(inicial: Partial<EnrollmentRow> = {}, grafo: FlowGraph = GRAFO) {
  let agora = SEXTA_18H;
  const enrollment: EnrollmentRow = {
    id: "enr-1",
    organization_id: ORG,
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: LEAD,
    conversation_id: null,
    current_node_id: grafo.nodes[0]!.id,
    status: "active",
    next_eval_at: SEXTA_18H.toISOString(),
    claimed_until: null,
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    steps_taken: 0,
    outcome: null,
    cancel_reason: null,
    started_at: SEXTA_18H.toISOString(),
    completed_at: null,
    updated_at: SEXTA_18H.toISOString(),
    ...inicial,
  };
  const events: EventoGravado[] = [];
  const jobs: FollowupJobRequest[] = [];
  const avisos: Array<{ title: string; body: string }> = [];

  const db: TurnBridgeAdminClient & AdminClient = {
    async claimDueEnrollments() {
      const vencido = enrollment.next_eval_at !== null && Date.parse(enrollment.next_eval_at) <= agora.getTime();
      const andando = enrollment.status === "active" || enrollment.status === "waiting_reply";
      return vencido && andando ? [{ ...enrollment }] : [];
    },
    async loadEnrollmentById() {
      return { ...enrollment };
    },
    async loadFlowGraph() {
      return grafo;
    },
    async loadLeadFacts() {
      return { lead_stage: null, tags: [] };
    },
    async loadEnrollmentEvents() {
      return events.map((e): EnrollmentEventRef => ({
        node_id: e.node_id,
        idempotency_key: e.idempotency_key,
        event_type: e.event_type,
        payload: e.payload,
      }));
    },
    async loadLastInboundBody() {
      return null;
    },
    async insertEnrollmentEvent(evento) {
      if (events.some((e) => e.idempotency_key !== null && e.idempotency_key === evento.idempotency_key)) {
        return { inserted: false };
      }
      events.push({
        node_id: evento.node_id,
        event_type: evento.event_type,
        payload: evento.payload,
        idempotency_key: evento.idempotency_key,
      });
      return { inserted: true };
    },
    async updateEnrollment(_id, _org, patch) {
      Object.assign(enrollment, patch);
    },
    async loadFlowPointerName() {
      return "Fluxo de teste";
    },
    async insertDeadInboxItem(item) {
      avisos.push({ title: item.title, body: item.body });
    },
    async persistirRespostaFollowup() {
      /* o fluxo de teste não captura resposta */
    },
  };

  return {
    db,
    enrollment,
    events,
    jobs,
    avisos,
    relogio: () => agora,
    avancaPara: (quando: Date) => {
      agora = quando;
    },
    tick: () => runFollowupTick({ db, clock: () => agora, enqueueJob: async (j) => void jobs.push(j) }),
  };
}

describe("a ponte ESTACIONA o enrollment em vez de deixá-lo rechecando", () => {
  it("⭐ grava o adiamento e joga o próximo olhar para a abertura da janela — sem avançar nem completar", async () => {
    const l = loja({ current_node_id: "a1", steps_taken: 4 });

    await completeTurnForEnrollment(
      l.db,
      ORG,
      "enr-1",
      "a1",
      { kind: "deferred", until: SEGUNDA_09H, reason: "outside_window" },
      () => SEXTA_18H,
      "job-1",
    );

    expect(l.events).toHaveLength(1);
    expect(l.events[0]!.event_type).toBe(EVENTO_ACAO_ADIADA);
    // A chave do PASSO continua livre: quem a gasta é a conclusão do envio.
    expect(l.events[0]!.idempotency_key).not.toBe("a1:4");
    expect(l.enrollment.next_eval_at).toBe(SEGUNDA_09H.toISOString());
    expect(l.enrollment.current_node_id).toBe("a1");
    expect(l.enrollment.status).toBe("active");
    expect(l.enrollment.steps_taken).toBe(4);
  });

  it("o MESMO job adiando duas vezes é um adiamento só (retry pós-crash)", async () => {
    const l = loja({ current_node_id: "a1", steps_taken: 4 });
    const adiar = () =>
      completeTurnForEnrollment(
        l.db,
        ORG,
        "enr-1",
        "a1",
        { kind: "deferred", until: SEGUNDA_09H, reason: "outside_window" },
        () => SEXTA_18H,
        "job-1",
      );

    await adiar();
    await adiar();

    expect(l.events).toHaveLength(1);
  });

  it("na pergunta de confirmação, a carência só começa DEPOIS de a janela abrir", async () => {
    // Estacionar em `until` cru faria o motor ler o silêncio como "não
    // respondeu" no instante exato em que a pergunta sai.
    const l = loja({ current_node_id: "m1", steps_taken: 2 }, GRAFO_CONFIRMACAO);

    await completeTurnForEnrollment(
      l.db,
      ORG,
      "enr-1",
      "m1",
      { kind: "deferred", until: SEGUNDA_09H, reason: "outside_window" },
      () => SEXTA_18H,
      "job-1",
    );

    expect(l.enrollment.next_eval_at).toBe(new Date(SEGUNDA_09H.getTime() + 900_000).toISOString());
  });
});

describe("o dead-man da ação mede ociosidade, não espera", () => {
  it("⭐ o fim de semana inteiro passa e o enrollment continua vivo no nó de envio", async () => {
    const l = loja();

    // 1º tick: o motor pede o envio.
    await l.tick();
    expect(l.jobs).toHaveLength(1);
    expect(l.events.map((e) => e.event_type)).toEqual(["turn_enqueued"]);

    // O worker roda, a janela está fechada, ele re-agenda e AVISA.
    await completeTurnForEnrollment(
      l.db,
      ORG,
      "enr-1",
      "a1",
      { kind: "deferred", until: SEGUNDA_09H, reason: "outside_window" },
      l.relogio,
      "job-1",
    );

    // O relógio anda até a abertura, tick a tick, como o cron faria.
    for (let i = 0; i < 400 && l.relogio().getTime() < SEGUNDA_09H.getTime(); i++) {
      const resumo = await l.tick();
      expect(resumo.dead, `enrollment morto ${i} ticks depois do adiamento`).toBe(0);
      const proximo = l.enrollment.next_eval_at;
      const salto = proximo !== null ? Math.max(Date.parse(proximo), l.relogio().getTime() + 60_000) : l.relogio().getTime() + 60_000;
      l.avancaPara(new Date(Math.min(salto, SEGUNDA_09H.getTime())));
    }

    expect(l.enrollment.status).toBe("active");
    expect(l.enrollment.current_node_id).toBe("a1");
    expect(l.avisos, "abriu aviso de 'parou de tentar' para quem só esperava a janela").toHaveLength(0);
    // Um único job: o adiamento NÃO pode ter re-enfileirado um segundo envio.
    expect(l.jobs).toHaveLength(1);
  });

  it("⭐ adiamentos seguidos NÃO somam contra o orçamento — cada um é prova de vida nova", async () => {
    // O caso das duas janelas que se compõem: a faixa do agente abre, a
    // anti-ban do canal ainda não, o job volta e adia de novo. Se cada
    // adiamento contasse, `MAX_ACTION_RECHECKS` deles matariam um enrollment em
    // que o worker esteve vivo o tempo inteiro — e o número de adiamentos é do
    // operador, não nosso.
    const l = loja();
    await l.tick();

    for (let volta = 0; volta < MAX_ACTION_RECHECKS + 2; volta++) {
      const abertura = new Date(l.relogio().getTime() + 3_600_000);
      await completeTurnForEnrollment(
        l.db,
        ORG,
        "enr-1",
        "a1",
        { kind: "deferred", until: abertura, reason: "outside_window" },
        l.relogio,
        `job-${volta}`,
      );
      expect(l.enrollment.next_eval_at, `volta ${volta}: o motor não estacionou`).toBe(abertura.toISOString());
      l.avancaPara(abertura);
      const resumo = await l.tick();
      expect(resumo.dead, `enrollment morto no ${volta + 1}º adiamento, com o worker vivo`).toBe(0);
    }

    expect(l.enrollment.status).toBe("active");
    expect(l.avisos).toHaveLength(0);
  });

  it("controle: sem adiamento nenhum, o dead-man continua matando o turno que nunca fecha", async () => {
    // A metade que não pode ser afrouxada. Worker morto = nenhum evento de
    // prova de vida; o orçamento é gasto e o enrollment tem de morrer.
    const l = loja();
    await l.tick();
    for (let i = 0; i < MAX_ACTION_RECHECKS + 2 && l.enrollment.status === "active"; i++) {
      const proximo = l.enrollment.next_eval_at;
      if (proximo !== null) l.avancaPara(new Date(Date.parse(proximo)));
      await l.tick();
    }

    expect(l.enrollment.status).toBe("dead");
    expect(l.enrollment.cancel_reason).toBe("action_turn_never_completed");
    expect(l.avisos).toHaveLength(1);
  });

  it("controle: depois de um adiamento, o orçamento recomeça — e ainda assim acaba", async () => {
    // Prova de vida não é imunidade: ela zera o contador, e a ociosidade DEPOIS
    // dela volta a ser medida. Sem isto, "não conta adiamento" viraria "nunca
    // morre" para quem adiou uma vez.
    const l = loja();
    await l.tick();
    await completeTurnForEnrollment(
      l.db,
      ORG,
      "enr-1",
      "a1",
      { kind: "deferred", until: SEGUNDA_09H, reason: "outside_window" },
      l.relogio,
      "job-1",
    );
    l.avancaPara(SEGUNDA_09H);

    for (let i = 0; i < MAX_ACTION_RECHECKS + 3 && l.enrollment.status === "active"; i++) {
      const proximo = l.enrollment.next_eval_at;
      if (proximo !== null) l.avancaPara(new Date(Math.max(Date.parse(proximo), l.relogio().getTime())));
      await l.tick();
    }

    expect(l.enrollment.status).toBe("dead");
    expect(l.enrollment.cancel_reason).toBe("action_turn_never_completed");
  });
});
