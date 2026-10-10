/**
 * R1 — o envio INLINE de texto fixo do follow-up (`enviarTextoFixoPendente`, o
 * atalho "sem cron e sem agent-worker") BYPASSA `executarTurnoDoAgente`, então
 * precisa do gate de elegibilidade por conta própria. Sem isto, um fluxo de
 * follow-up com nó de texto fixo mandaria mensagem para uma conversa que o gate
 * `allowlist` barra.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageHandler = vi.fn(async (..._a: unknown[]) => ({ id: "msg-1",status:"sent" }));
const decidir = vi.fn();
const completeTurnForEnrollment = vi.fn(async (..._a: unknown[]) => {});

vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: (...a: unknown[]) => sendMessageHandler(...a) }));
vi.mock("@/lib/automation/start-conversation", () => ({
  ensureConversation: async () => "conv-1",
  sessaoProntaParaEnvio: async () => "sess-1",
}));
vi.mock("@/lib/ai/elegibilidade/consulta-supabase", () => ({
  decidirElegibilidadeDaConversaViaSupabase: (...a: unknown[]) => decidir(...a),
}));
vi.mock("@/lib/followup/turn-bridge", () => ({
  completeTurnForEnrollment: (...a: unknown[]) => completeTurnForEnrollment(...a),
}));
vi.mock("@/lib/followup/engine", () => ({ createSupabaseAdminClient: () => ({}) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { enviarTextoFixoPendente } from "./enviar-texto-fixo";
import { OrgNaoOperanteError } from "@/lib/organizacao/operante";

const boundary = { organization_id: "org-1", contact_id: "contact-1", conversation_id: "conv-1", service_revision: 1, demanda_id: null, demanda_revision: null };
const JOB = {
  id: "job-1",
  organization_id: "org-1",
  contact_id: "contact-1",
  payload: { service_boundary: boundary, fixed_body: "Oi, tudo bem?", followup_enrollment_id: "enr-1", node_id: "node-1" },
};

const statusUpdates: string[] = [];
const filtrosRunAfter: { op: string; col: string; v: string }[] = [];
const settleCalls: Record<string, unknown>[] = [];

/**
 * Configuração por trás do stub `admin()` — as leituras que o atalho faz para
 * decidir se pode enviar. O padrão é "tudo aberto" (janela 0h–24h, sem faixa
 * publicada) para que os casos que não falam de horário continuem medindo só o
 * que vieram medir; os casos de janela mudam ESTE objeto.
 */
const CONFIG = {
  /** `null` = a conversa não tem canal — não há janela do canal a consultar. */
  sessao: "sess-1" as string | null,
  fuso: "America/Sao_Paulo" as string | null,
  knobs: {
    throttle_ms: null as number | null,
    jitter_max_ms: 0 as number | null,
    window_start_hour: 0 as number | null,
    window_end_hour: 24 as number | null,
    allow_sunday: true as boolean | null,
    timezone: null as string | null,
    warmup_daily_caps: null as unknown,
  },
  /** `ai_agent_versions.followup` da versão publicada — `null` = sem faixa. */
  followup: null as unknown,
};

function reiniciarConfig() {
  CONFIG.sessao = "sess-1";
  CONFIG.fuso = "America/Sao_Paulo";
  CONFIG.knobs = {
    throttle_ms: null,
    jitter_max_ms: 0,
    window_start_hour: 0,
    window_end_hour: 24,
    allow_sunday: true,
    timezone: null,
    warmup_daily_caps: null,
  };
  CONFIG.followup = null;
}

/** Admin stub: job_queue (select pending / claim / status) + followup_enrollments. */
function admin() {
  const make = (table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      _table: table,
      _upd: null as Record<string, unknown> | null,
      select: () => chain,
      eq: () => chain,
      lte: (col: string, v: string) => (filtrosRunAfter.push({ op: "lte", col, v }), chain),
      lt: (col: string, v: string) => (filtrosRunAfter.push({ op: "lt", col, v }), chain),
      in: () => chain,
      single: () => Promise.resolve({data:table==="send_ledger"?{id:"ledger-1"}:{settings:{}},error:null}),
      insert: () => chain,
      order: () => chain,
      limit: () => chain,
      update: (p: Record<string, unknown>) => {
        chain._upd = p;
        if (table === "job_queue" && typeof p.status === "string") statusUpdates.push(p.status);
        return chain;
      },
      maybeSingle: () => {
        if (table === "job_queue" && chain._upd) return Promise.resolve({ data: { id: JOB.id, locked_by:chain._upd.locked_by, locked_at:chain._upd.locked_at }, error: null });
        if (table === "followup_enrollments")
          return Promise.resolve({ data: { current_node_id: "node-1",status:"active",revision:1,agent_id:"ag-1" }, error: null });
        if (table === "conversations") return Promise.resolve({ data: { channel_session_id: CONFIG.sessao }, error: null });
        if (table === "channel_knobs") return Promise.resolve({ data: CONFIG.knobs, error: null });
        if (table === "organizations") return Promise.resolve({ data: { timezone: CONFIG.fuso }, error: null });
        if (table === "ai_agents") return Promise.resolve({ data: { published_version_id: "v1" }, error: null });
        if (table === "ai_agent_versions") return Promise.resolve({ data: { followup: CONFIG.followup }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then: (r: (v: unknown) => unknown) => {
        if (table === "job_queue" && !chain._upd) {
          return Promise.resolve({ data: [JOB], error: null }).then(r);
        }
        return Promise.resolve({ data: null, error: null }).then(r);
      },
    };
    return chain;
  };
  return { from: (t: string) => make(t), rpc: async (name:string,args:Record<string,unknown>) => {
    if(name==="fn_followup_inline_settle") {statusUpdates.push(args.p_done?"done":"pending");settleCalls.push(args);return {data:true,error:null};}
    if(name==="fn_followup_turno_descartado") {statusUpdates.push(`descartado:${args.p_org}:${args.p_job}`);return {data:true,error:null};}
    if(name==="fn_appointment_enrollment_current" || name==="fn_followup_job_current") return {data:true,error:null};
    return {data:{...boundary,status:"open",demanda_fechada_em:null},error:null};
  }} as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  statusUpdates.length = 0;
  filtrosRunAfter.length = 0;
  settleCalls.length = 0;
  reiniciarConfig();
});

describe("enviarTextoFixoPendente · gate de elegibilidade", () => {
  it("conversa NÃO elegível → NÃO envia, job vira 'done'", async () => {
    decidir.mockResolvedValue({ permite: false, motivo: "sem_autorizacao", bloqueioPorAllowlist: true });
    const enviados = await enviarTextoFixoPendente(admin());
    expect(enviados).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(statusUpdates).toContain("done");
  });

  it("conversa elegível → envia normalmente", async () => {
    decidir.mockResolvedValue({ permite: true, motivo: "autorizado", bloqueioPorAllowlist: false });
    const enviados = await enviarTextoFixoPendente(admin());
    expect(enviados).toBe(1);
    expect(sendMessageHandler).toHaveBeenCalledOnce();
  });

  it("erro ao ler elegibilidade → NÃO envia, job volta pra 'pending' (fail-closed)", async () => {
    decidir.mockRejectedValue(new Error("db down"));
    const enviados = await enviarTextoFixoPendente(admin());
    expect(enviados).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(statusUpdates).toContain("pending");
  });
});

it.each(["queued","failed"])("%s não conta envio nem avança o fluxo",async status=>{
 decidir.mockResolvedValue({permite:true});sendMessageHandler.mockResolvedValueOnce({id:"msg-1",status});
 expect(await enviarTextoFixoPendente(admin())).toBe(0);
 expect(completeTurnForEnrollment).not.toHaveBeenCalled();expect(statusUpdates).toContain("pending");
});

it("org suspensa entre o gate e o envio → job encerrado (done), sem reenvio nem avanço do fluxo", async () => {
  decidir.mockResolvedValue({ permite: true, motivo: "gate_aberto", bloqueioPorAllowlist: false });
  sendMessageHandler.mockRejectedValueOnce(new OrgNaoOperanteError("org-1"));
  expect(await enviarTextoFixoPendente(admin())).toBe(0);
  expect(completeTurnForEnrollment).not.toHaveBeenCalled();
  expect(statusUpdates).toContain("done");
  expect(statusUpdates).not.toContain("pending");
  // O evento vem ANTES do settle: sem ele, a reativação lê o job cancelado como
  // worker morto e o dead-man mata a inscrição (action_turn_never_completed).
  expect(statusUpdates).toEqual(["running", "descartado:org-1:job-1", "done"]);
});

it("falha que não é suspensão NÃO grava turn_discarded", async () => {
  decidir.mockResolvedValue({ permite: true });
  sendMessageHandler.mockRejectedValueOnce(new Error("canal fora"));
  await enviarTextoFixoPendente(admin());
  expect(statusUpdates.some((s) => s.startsWith("descartado"))).toBe(false);
});

// O banco grava run_after em µs; o JS lê o relógio em ms. Job gravado com
// run_after=now() há menos de 1 ms (ex.: ...00.000500Z com o JS em ...00.000Z)
// está vencido, e o filtro não pode escondê-lo: o corte é o FIM do ms corrente.
it("filtro de vencimento cobre o milissegundo corrente inteiro (run_after em µs)", async () => {
  vi.useFakeTimers({ now: new Date("2026-09-26T10:04:46.558Z"), toFake: ["Date"] });
  try {
    decidir.mockResolvedValue({ permite: true });
    await enviarTextoFixoPendente(admin());
  } finally {
    vi.useRealTimers();
  }
  const run = filtrosRunAfter.filter((f) => f.col === "run_after");
  expect(run.length).toBeGreaterThanOrEqual(2); // seleção e reivindicação
  for (const f of run) expect(f).toEqual({ op: "lt", col: "run_after", v: "2026-09-26T10:04:46.559Z" });
});

/**
 * #2658 — o atalho inline era o ÚNICO caminho de envio do follow-up que não
 * consultava nenhuma régua de horário. Um fluxo com espera fixa + texto fixo
 * inscrito às 13h tocava às 03h: a janela de disparo do canal (8h–18h) e a
 * faixa do agente (seg–sex, 8h–18h) estavam configuradas, e as DUAS eram
 * ignoradas — nenhum `action_deferred` gravado.
 *
 * As âncoras são fixas e o fuso da org (America/Sao_Paulo) difere de UTC, então
 * a asserção de horário não é identidade: 04:00Z é 01:00 local.
 */
describe("enviarTextoFixoPendente · janela de disparo (#2658)", () => {
  const FAIXA_SEG_A_SEX = { send_window: { start: "08:00", end: "18:00", weekdays: [1, 2, 3, 4, 5] } };

  /** Pinos: canal 8h–18h (a tela de Proteção de envio) + faixa seg–sex 8h–18h. */
  function configurarJanelaReal() {
    CONFIG.knobs = {
      throttle_ms: null,
      jitter_max_ms: 0,
      window_start_hour: 8,
      window_end_hour: 18,
      allow_sunday: true,
      timezone: null,
      warmup_daily_caps: null,
    };
    CONFIG.followup = FAIXA_SEG_A_SEX;
  }

  async function comRelogoEm<T>(instanteISO: string, corpo: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ now: new Date(instanteISO), toFake: ["Date"] });
    try {
      return await corpo();
    } finally {
      vi.useRealTimers();
    }
  }

  it("03h da madrugada (canal 8h–18h) → NÃO envia, adia para a abertura e registra o motivo", async () => {
    configurarJanelaReal();
    decidir.mockResolvedValue({ permite: true, motivo: "autorizado" });
    // 2026-10-08 é quinta; 04:00Z = 01:00 de Brasília. A abertura de hoje é
    // 08:00 local = 11:00Z.
    const enviados = await comRelogoEm("2026-10-08T04:00:00Z", () => enviarTextoFixoPendente(admin()));

    expect(enviados).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    // O adiamento VOLTA para o enrollment: sem `action_deferred` o dead-man lê
    // a espera como worker morto e marca `dead` um envio que ainda vai sair.
    expect(completeTurnForEnrollment).toHaveBeenCalledOnce();
    expect(completeTurnForEnrollment.mock.calls[0]![4]).toEqual({
      kind: "deferred",
      until: new Date("2026-10-08T11:00:00Z"),
      reason: "outside_window",
    });
    // E o job volta pra `pending` com `run_after` na abertura, SEM gastar
    // tentativa (p_hold) — o envio sai sozinho quando a janela abrir.
    const settle = settleCalls.at(-1)!;
    expect(settle.p_done).toBe(false);
    expect(settle.p_retry_at).toBe("2026-10-08T11:00:00.000Z");
    expect(settle.p_hold).toBe(true);
    expect(statusUpdates).toContain("pending");
    expect(statusUpdates).not.toContain("done");
  });

  it("canal aberto mas SÁBADO (faixa seg–sex) → adia para segunda, motivo da faixa", async () => {
    configurarJanelaReal();
    decidir.mockResolvedValue({ permite: true, motivo: "autorizado" });
    // 2026-10-10 é sábado; 13:00Z = 10:00 local — dentro da janela do canal,
    // fora da faixa do agente. A próxima abertura da faixa é segunda 08:00
    // local = 2026-10-12T11:00Z.
    const enviados = await comRelogoEm("2026-10-10T13:00:00Z", () => enviarTextoFixoPendente(admin()));

    expect(enviados).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(completeTurnForEnrollment.mock.calls[0]![4]).toEqual({
      kind: "deferred",
      until: new Date("2026-10-12T11:00:00Z"),
      reason: "followup_send_window",
    });
    expect(settleCalls.at(-1)!.p_retry_at).toBe("2026-10-12T11:00:00.000Z");
  });

  it("DENTRO da janela do canal e da faixa → envia normalmente (não regride)", async () => {
    configurarJanelaReal();
    decidir.mockResolvedValue({ permite: true, motivo: "autorizado" });
    // Quinta 10:00 local — as duas réguas abertas.
    const enviados = await comRelogoEm("2026-10-08T13:00:00Z", () => enviarTextoFixoPendente(admin()));

    expect(enviados).toBe(1);
    expect(sendMessageHandler).toHaveBeenCalledOnce();
    expect(completeTurnForEnrollment.mock.calls[0]![4]).toEqual({ kind: "sent" });
    expect(settleCalls.at(-1)!.p_done).toBe(true);
  });

  it("sem faixa publicada no agente → só o canal decide (comportamento antigo preservado)", async () => {
    configurarJanelaReal();
    CONFIG.followup = null;
    decidir.mockResolvedValue({ permite: true, motivo: "autorizado" });
    // Sábado 10:00 local: sem faixa, a única régua é a do canal — que está
    // aberta.
    const enviados = await comRelogoEm("2026-10-10T13:00:00Z", () => enviarTextoFixoPendente(admin()));

    expect(enviados).toBe(1);
    expect(sendMessageHandler).toHaveBeenCalledOnce();
  });
});
