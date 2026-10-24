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
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import { OrgNaoOperanteError } from "@/lib/organizacao/operante";
import { CHANNEL_CAPABILITIES, PROVIDERS_DE_MENSAGEM } from "@/lib/channels/capabilities";

const boundary = { organization_id: "org-1", contact_id: "contact-1", conversation_id: "conv-1", service_revision: 1, demanda_id: null, demanda_revision: null };
const JOB = {
  id: "job-1",
  organization_id: "org-1",
  contact_id: "contact-1",
  payload: { service_boundary: boundary, fixed_body: "Oi, tudo bem?", followup_enrollment_id: "enr-1", node_id: "node-1" },
};

const statusUpdates: string[] = [];
/** Linhas gravadas em `pacing_ledger` — é por aqui que se prova que o envio foi CONTABILIZADO. */
const ledgerInserts: Record<string, unknown>[] = [];
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
    /** `null` = idade 0, o degrau mais conservador do warm-up (teto de 20/dia). */
    number_activated_at: null as string | null,
  },
  /** `ai_agent_versions.followup` da versão publicada — `null` = sem faixa. */
  followup: null as unknown,
  /** Estado do `pacing_ledger` deste número — o freio anti-ban do texto fixo. */
  ritmo: {
    ultimoEnvioIso: null as string | null,
    doDia: 0,
  },
  /** #2734 — `channel_sessions.provider`; `null` = a leitura não acha a sessão (sem régua de 24 h). */
  provider: null as string | null,
  /** #2734 — `conversations.last_inbound_at` (ISO), para a janela de 24 h. */
  ultimoInbound: null as string | null,
  /** #2877 — `org_guardrail_layers.restricao_comercial`; `"falha"` = a leitura estoura. */
  camadaComercial: false as boolean | "falha",
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
    number_activated_at: null,
  };
  CONFIG.followup = null;
  CONFIG.ritmo = { ultimoEnvioIso: null, doDia: 0 };
  CONFIG.provider = null;
  CONFIG.ultimoInbound = null;
  CONFIG.camadaComercial = false;
  JOB.payload.fixed_body = "Oi, tudo bem?";
  delete (JOB.payload as Record<string, unknown>).fixed_media_url;
}

/** Congela o relógio num instante — as réguas de horário e de ritmo leem `Date`. */
async function comRelogoEm<T>(instanteISO: string, corpo: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ now: new Date(instanteISO), toFake: ["Date"] });
  try {
    return await corpo();
  } finally {
    vi.useRealTimers();
  }
}

/** Admin stub: job_queue (select pending / claim / status) + followup_enrollments. */
function admin(revogado = false, falhaDeLeitura: Error | null = null) {
  const make = (table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      _table: table,
      _upd: null as Record<string, unknown> | null,
      select: () => chain,
      eq: () => chain,
      lte: (col: string, v: string) => (filtrosRunAfter.push({ op: "lte", col, v }), chain),
      lt: (col: string, v: string) => (filtrosRunAfter.push({ op: "lt", col, v }), chain),
      // `lerEstadoDoPacing` conta as linhas do dia com `.gte("sent_at", …)`.
      // Sem este método o freio de ritmo estourava TypeError e o job caía no
      // catch do drain — foi o que quebrou sete casos deste arquivo.
      gte: () => chain,
      in: () => chain,
      single: () => Promise.resolve({data:table==="send_ledger"?{id:"ledger-1"}:{settings:{}},error:null}),
      insert: (p: Record<string, unknown>) => {
        if (table === "pacing_ledger") ledgerInserts.push(p);
        return chain;
      },
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
        if (table === "conversations") return Promise.resolve({ data: { channel_session_id: CONFIG.sessao, last_inbound_at: CONFIG.ultimoInbound }, error: null });
        if (table === "channel_sessions") return Promise.resolve({ data: CONFIG.provider ? { provider: CONFIG.provider } : null, error: null });
        if (table === "channel_knobs") return Promise.resolve({ data: CONFIG.knobs, error: null });
        if (table === "pacing_ledger")
          return Promise.resolve({
            data: CONFIG.ritmo.ultimoEnvioIso ? { sent_at: CONFIG.ritmo.ultimoEnvioIso } : null,
            error: null,
          });
        if (table === "org_guardrail_layers")
          return Promise.resolve(CONFIG.camadaComercial === "falha"
            ? { data: null, error: { message: "offline" } }
            : { data: { enabled: CONFIG.camadaComercial }, error: null });
        if (table === "organizations") return Promise.resolve({ data: { timezone: CONFIG.fuso }, error: null });
        if (table === "ai_agents") return Promise.resolve({ data: { published_version_id: "v1" }, error: null });
        if (table === "ai_agent_versions") return Promise.resolve({ data: { followup: CONFIG.followup }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then: (r: (v: unknown) => unknown) => {
        if (table === "job_queue" && !chain._upd) {
          return Promise.resolve({ data: [JOB], error: null }).then(r);
        }
        // A contagem do dia é `head: true`: volta `count`, nunca linha.
        if (table === "pacing_ledger") {
          return Promise.resolve({ data: null, count: CONFIG.ritmo.doDia, error: null }).then(r);
        }
        return Promise.resolve({ data: null, error: null }).then(r);
      },
    };
    return chain;
  };
  return { from: (t: string) => make(t), rpc: async (name:string,args:Record<string,unknown>) => {
    if(name==="fn_autonomous_turn_revoked") { return {data:revogado,error:falhaDeLeitura}; }
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
  ledgerInserts.length = 0;
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


it.each([true, false])("fronteira obsoleta consulta a revogação canônica: %s", async revogado => {
  decidir.mockResolvedValue({ permite: true });
  sendMessageHandler.mockRejectedValueOnce(new StaleServiceBoundaryError());
  const db = admin(revogado);
  const rpc = vi.spyOn(db as {rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>}, "rpc");
  expect(await enviarTextoFixoPendente(db)).toBe(0);
  expect(rpc).toHaveBeenCalledWith("fn_autonomous_turn_revoked", { p_org: "org-1", p_job: "job-1" });
  expect(statusUpdates.some(s => s.startsWith("descartado"))).toBe(revogado);
  expect(statusUpdates.at(-1)).toBe("done");
  expect(completeTurnForEnrollment).not.toHaveBeenCalled();
});
it("falha ao consultar revogação não inventa fato nem settle", async () => {
  decidir.mockResolvedValue({ permite: true });
  sendMessageHandler.mockRejectedValueOnce(new StaleServiceBoundaryError());
  await expect(enviarTextoFixoPendente(admin(false, new Error("rpc indisponível")))).rejects.toThrow("rpc indisponível");
  expect(statusUpdates).toEqual(["running"]);
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
      // Número FORMADO: estes casos medem a janela de horário, e o degrau de
      // warm-up (teto de 20/dia na idade 0) vetaria por outro motivo.
      number_activated_at: '2026-01-01T00:00:00Z',
    };
    CONFIG.followup = FAIXA_SEG_A_SEX;
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

/**
 * O FREIO ANTI-BAN DO TEXTO FIXO.
 *
 * O atalho inline chama `sendMessageHandler` direto e, com isso, passa por fora
 * da cadeia `before_send` — onde mora `decidePacing`. O passo de IA tinha
 * espaçamento, jitter, warm-up e teto diário; o de texto fixo não tinha nenhum
 * dos quatro, e os envios dele nem entravam no `pacing_ledger` — então o agente
 * do próprio CRM seguia achando o número folgado.
 *
 * A janela de horário fica ABERTA nestes casos (canal 0h–24h, sem faixa) de
 * propósito: o que está sob medição aqui é o ritmo, e um veto de janela
 * esconderia o resultado.
 */
describe("enviarTextoFixoPendente · ritmo do canal", () => {
  it("envio há 200 ms: adia por pacing_throttle, não manda e não gasta tentativa", async () => {
    decidir.mockResolvedValue({ permite: true, motivo: "autorizado" });
    CONFIG.ritmo.ultimoEnvioIso = "2026-10-15T15:00:00.000Z";

    const enviados = await comRelogoEm("2026-10-15T15:00:00.200Z", () =>
      enviarTextoFixoPendente(admin()),
    );

    expect(enviados).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(completeTurnForEnrollment.mock.calls[0]![4]).toMatchObject({
      kind: "deferred",
      reason: "pacing_throttle",
    });
    // `hold` = o job volta para `pending` sem consumir tentativa; o envio sai
    // sozinho na liberação.
    expect(settleCalls.at(-1)!.p_done).toBe(false);
    expect(statusUpdates).toContain("pending");
    expect(ledgerInserts).toHaveLength(0);
  });

  it("número novo que já bateu o teto de 20/dia: adia por daily_cap", async () => {
    decidir.mockResolvedValue({ permite: true, motivo: "autorizado" });
    // `number_activated_at` nulo = idade 0 = o degrau mais conservador.
    CONFIG.ritmo.doDia = 20;

    const enviados = await comRelogoEm("2026-10-15T15:00:00Z", () =>
      enviarTextoFixoPendente(admin()),
    );

    expect(enviados).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(completeTurnForEnrollment.mock.calls[0]![4]).toMatchObject({
      kind: "deferred",
      reason: "daily_cap",
    });
  });

  it("número formado, espaçado e dentro do teto: envia E CONTABILIZA no ledger", async () => {
    decidir.mockResolvedValue({ permite: true, motivo: "autorizado" });
    CONFIG.knobs.number_activated_at = "2026-01-01T00:00:00Z";
    CONFIG.ritmo.ultimoEnvioIso = "2026-10-15T14:00:00.000Z";
    CONFIG.ritmo.doDia = 3;

    const enviados = await comRelogoEm("2026-10-15T15:00:00Z", () =>
      enviarTextoFixoPendente(admin()),
    );

    expect(enviados).toBe(1);
    expect(sendMessageHandler).toHaveBeenCalledOnce();
    // A linha no ledger é o que faltava: sem ela o teto protegia metade do número.
    expect(ledgerInserts).toHaveLength(1);
    expect(ledgerInserts[0]).toMatchObject({ channel_session_id: "sess-1" });
  });

  it("conversa sem canal: o ritmo não tem o que consultar e o envio segue", async () => {
    decidir.mockResolvedValue({ permite: true, motivo: "autorizado" });
    CONFIG.sessao = null;

    const enviados = await comRelogoEm("2026-10-15T15:00:00Z", () =>
      enviarTextoFixoPendente(admin()),
    );

    expect(enviados).toBe(1);
    expect(ledgerInserts).toHaveLength(0);
  });
});

/**
 * #2734 — o passo de texto fixo com MÍDIA, no atalho inline. Este é um dos dois
 * caminhos que mandam o texto fixo do follow-up (o outro é `runFlowDrivenTurn`,
 * em `tests/unit/fluxo-envia-modelo-aprovado.test.ts`), e a mídia tem de valer
 * nos dois: sair como imagem com o texto de legenda, ser recusada quando não é
 * imagem nem PDF e, em canal com janela de 24 h fechada, não sair — nem a mídia,
 * nem o texto sozinho. A recusa VOLTA para o enrollment como `skipped`, como no
 * worker; fechar só o job deixava o nó em recheck até o dead-man.
 *
 * Sabotagem prevista: apagar o bloco `if (midia) { recusaDeMidiaForaDaJanela … }`
 * de `enviar-texto-fixo.ts` deixa vermelho o caso da janela fechada (o envio sai);
 * apagar o `completeTurnForEnrollment` das recusas deixa vermelhos os dois casos
 * de recusa.
 */
describe("enviarTextoFixoPendente · mídia com legenda (#2734)", () => {
  const HORA = 3_600_000;
  // Um canal que só aceita mensagem livre dentro da janela de 24 h, pela CAPACIDADE, não pelo nome.
  const CANAL_COM_JANELA = PROVIDERS_DE_MENSAGEM.find((p) => !CHANNEL_CAPABILITIES[p].freeformOutsideWindow)!;
  const comMidia = (url: string) => {
    (JOB.payload as Record<string, unknown>).fixed_media_url = url;
  };

  /**
   * O CRUZAMENTO QUE O MERGE CRIOU, e que nenhum dos dois lados media sozinho.
   *
   * A mídia (#2734) e o freio de ritmo entraram pelo mesmo caminho e no mesmo
   * `sendWithLedger`: o freio fica ANTES dele e a contagem DEPOIS, então a
   * imagem tem de obedecer ao espaçamento e ao teto como o texto obedece, e
   * tem de gastar a cota do número como qualquer outra mensagem. Sem estes
   * dois casos, um envio de mídia poderia escapar do freio numa refatoração e
   * nada ficaria vermelho.
   */
  it("imagem fora do espaçamento: NÃO sai, adia por pacing_throttle e não conta no ledger", async () => {
    decidir.mockResolvedValue({ permite: true, motivo: "autorizado" });
    comMidia("https://cdn.exemplo.com/oferta.png");
    CONFIG.ritmo.ultimoEnvioIso = "2026-10-15T15:00:00.000Z";

    const enviados = await comRelogoEm("2026-10-15T15:00:00.200Z", () =>
      enviarTextoFixoPendente(admin()),
    );

    expect(enviados).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(completeTurnForEnrollment.mock.calls[0]![4]).toMatchObject({
      kind: "deferred",
      reason: "pacing_throttle",
    });
    expect(ledgerInserts).toHaveLength(0);
  });

  it("imagem com o número no teto diário: NÃO sai, adia por daily_cap", async () => {
    decidir.mockResolvedValue({ permite: true, motivo: "autorizado" });
    comMidia("https://cdn.exemplo.com/oferta.png");
    // `number_activated_at` nulo = idade 0 = o degrau mais conservador (20/dia).
    CONFIG.ritmo.doDia = 20;

    const enviados = await comRelogoEm("2026-10-15T15:00:00Z", () =>
      enviarTextoFixoPendente(admin()),
    );

    expect(enviados).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(completeTurnForEnrollment.mock.calls[0]![4]).toMatchObject({
      kind: "deferred",
      reason: "daily_cap",
    });
  });

  it("imagem enviada CONTABILIZA no ledger — mídia gasta a cota do número como o texto", async () => {
    decidir.mockResolvedValue({ permite: true, motivo: "autorizado" });
    comMidia("https://cdn.exemplo.com/oferta.png");
    CONFIG.knobs.number_activated_at = "2026-01-01T00:00:00Z";
    CONFIG.ritmo.ultimoEnvioIso = "2026-10-15T14:00:00.000Z";
    CONFIG.ritmo.doDia = 3;

    const enviados = await comRelogoEm("2026-10-15T15:00:00Z", () =>
      enviarTextoFixoPendente(admin()),
    );

    expect(enviados).toBe(1);
    expect(sendMessageHandler.mock.calls[0]![2]).toMatchObject({ type: "image" });
    expect(ledgerInserts).toHaveLength(1);
    expect(ledgerInserts[0]).toMatchObject({ channel_session_id: "sess-1" });
  });

  it("imagem: sai como `image`, com a URL, o MIME e o texto como LEGENDA", async () => {
    decidir.mockResolvedValue({ permite: true });
    comMidia("https://cdn.exemplo.com/oferta.png");

    expect(await enviarTextoFixoPendente(admin())).toBe(1);
    expect(sendMessageHandler).toHaveBeenCalledOnce();
    expect(sendMessageHandler.mock.calls[0]![2]).toMatchObject({
      conversation_id: "conv-1",
      type: "image",
      body: "Oi, tudo bem?",
      media_url: "https://cdn.exemplo.com/oferta.png",
      media_mime: "image/png",
    });
  });

  it("URL sem tipo identificável: recusada com o motivo, nada sai, e o passo volta como `skipped`", async () => {
    decidir.mockResolvedValue({ permite: true });
    comMidia("https://cdn.exemplo.com/arquivo-sem-tipo");

    expect(await enviarTextoFixoPendente(admin())).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    const settle = settleCalls.at(-1)!;
    expect(settle.p_done).toBe(true);
    expect(String(settle.p_error)).toContain("imagem");
    expect(completeTurnForEnrollment.mock.calls[0]![4]).toEqual({ kind: "skipped", reason: settle.p_error });
  });

  it("canal oficial com a janela de 24 h FECHADA: nem a mídia nem o texto saem", async () => {
    decidir.mockResolvedValue({ permite: true });
    CONFIG.provider = CANAL_COM_JANELA;
    CONFIG.ultimoInbound = new Date(Date.now() - 30 * HORA).toISOString();
    comMidia("https://cdn.exemplo.com/oferta.png");

    expect(await enviarTextoFixoPendente(admin())).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    const settle = settleCalls.at(-1)!;
    expect(settle.p_done).toBe(true);
    expect(String(settle.p_error)).toContain("janela de 24 horas");
    expect(completeTurnForEnrollment.mock.calls[0]![4]).toEqual({ kind: "skipped", reason: settle.p_error });
  });

  it("controle: o mesmo canal com a janela ABERTA manda a imagem", async () => {
    decidir.mockResolvedValue({ permite: true });
    CONFIG.provider = CANAL_COM_JANELA;
    CONFIG.ultimoInbound = new Date(Date.now() - 2 * HORA).toISOString();
    comMidia("https://cdn.exemplo.com/oferta.png");

    expect(await enviarTextoFixoPendente(admin())).toBe(1);
    expect(sendMessageHandler.mock.calls[0]![2]).toMatchObject({ type: "image" });
  });

  it("controle: sem mídia, a janela fechada não muda nada — o texto sai como sempre saiu", async () => {
    decidir.mockResolvedValue({ permite: true });
    CONFIG.provider = CANAL_COM_JANELA;
    CONFIG.ultimoInbound = new Date(Date.now() - 30 * HORA).toISOString();

    expect(await enviarTextoFixoPendente(admin())).toBe(1);
    expect(sendMessageHandler.mock.calls[0]![2]).toMatchObject({ type: "text", body: "Oi, tudo bem?" });
  });
});

// #2877 / #3270 — o atalho inline manda o mesmo `fixed_body` que o worker manda
// pela cadeia; sem a régua aqui, quem pegasse o job primeiro entregava o preço.
describe("enviarTextoFixoPendente · restrição comercial", () => {
  beforeEach(() => {
    decidir.mockResolvedValue({ permite: true, motivo: "autorizado", bloqueioPorAllowlist: false });
    JOB.payload.fixed_body = "Consigo fazer por 1.800 se fechar hoje";
  });

  it("camada ligada → o preço NÃO sai, passo skipped e job done", async () => {
    CONFIG.camadaComercial = true;
    expect(await enviarTextoFixoPendente(admin())).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(completeTurnForEnrollment).toHaveBeenCalledWith(
      expect.anything(), "org-1", "enr-1", "node-1",
      { kind: "skipped", reason: "O envio foi recusado pelas regras do atendimento." },
      undefined, "job-1", expect.anything(),
    );
    expect(settleCalls).toEqual([expect.objectContaining({ p_done: true, p_error: "commercial_requires_human", p_retry_at: null })]);
  });

  it("camada desligada → sai normalmente", async () => {
    CONFIG.camadaComercial = false;
    expect(await enviarTextoFixoPendente(admin())).toBe(1);
    expect(sendMessageHandler).toHaveBeenCalledOnce();
  });

  it("leitura da camada falha → NÃO sai (falha fechada)", async () => {
    CONFIG.camadaComercial = "falha";
    expect(await enviarTextoFixoPendente(admin())).toBe(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });

  it("corpo sem cara de preço sai mesmo com a camada ligada", async () => {
    CONFIG.camadaComercial = true;
    JOB.payload.fixed_body = "Oi, tudo bem?";
    expect(await enviarTextoFixoPendente(admin())).toBe(1);
  });
});
