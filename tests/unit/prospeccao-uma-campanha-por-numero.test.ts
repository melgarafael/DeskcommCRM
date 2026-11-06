import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  send: vi.fn(),
  audit: vi.fn(),
  guard: vi.fn(),
  continuation: vi.fn(),
  boundary: vi.fn(),
  preflight: vi.fn(),
  authorize: vi.fn(),
  knobs: vi.fn(),
  open: vi.fn(),
  prospeccaoAberta: vi.fn(),
  pacing: vi.fn(),
  prepare: vi.fn(),
  preparo: vi.fn(),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: mocks.send }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/agent-engine/agent/abordagem-de-formulario", () => ({
  gerarAbordagemDeFormulario: mocks.generate,
}));
vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({ llmEdgeConfigFromEnv: () => ({}) }));
vi.mock("@/lib/atendimento/origem", () => ({
  assertServiceBoundarySupabase: mocks.boundary,
  beginServiceAtOrigin: vi.fn(),
}));
vi.mock("@/lib/atendimento/fronteira", () => ({ parseServiceBoundary: (x: unknown) => x }));
vi.mock("@/lib/ai/elegibilidade/autorizacao", () => ({ autorizarContatoParaIA: mocks.authorize }));
vi.mock("@/lib/ai/elegibilidade/consulta-pre-go-live", () => ({
  decidirPreGoLiveDoCanalViaSupabase: mocks.preflight,
}));
vi.mock("@/lib/prospecting/guard", () => ({
  assertProspectingDelivery: mocks.guard,
  assertProspectingContinuation: mocks.continuation,
}));
vi.mock("@/lib/agent-engine/pacing/store", () => ({
  loadChannelKnobs: mocks.knobs,
  loadPacingState: vi.fn().mockResolvedValue({ sentToday: 0 }),
  recordSend: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/agent-engine/pacing/engine", () => ({
  janelaDeEnvioAberta: mocks.open,
  janelaDeProspeccaoAberta: mocks.prospeccaoAberta,
  decidePacing: mocks.pacing,
  proximaAberturaDaJanela: () => new Date(Date.now() + 3600000),
  proximaAberturaDaProspeccao: () => new Date(Date.now() + 3600000),
  warmupCapFor: (_idade: number, degraus: Array<{ minAgeDays: number; cap: number | null }>) => {
    let cap: number | null = degraus[0]?.cap ?? null;
    for (const d of degraus) if (_idade >= d.minAgeDays) cap = d.cap;
    return cap;
  },
}));
vi.mock("@/lib/env", () => ({ env: {} }));
// A LOJA é dublê inteira (é o que o worker importa). A trava `assertCanalLivre`
// e `canalDaCampanha` moram em `canal-da-campanha.ts`, FORA deste módulo, de
// propósito: assim o dublê não reimplementa a regra que o teste mede.
vi.mock("@/lib/prospecting/store", () => ({
  withProspectingLock: vi.fn(),
  synchronizeSearch: vi.fn(),
  validateConfig: vi.fn().mockResolvedValue(undefined),
  prepararCandidatoNoEnvio: mocks.prepare,
}));
vi.mock("@/lib/prospecting/preparo", () => ({ prepararCandidatos: mocks.preparo }));

import { recordSend } from "@/lib/agent-engine/pacing/store";
import { assertCanalLivre } from "@/lib/prospecting/canal-da-campanha";
import { withProspectingLock, type Campaign } from "@/lib/prospecting/store";
import { ProspectingError } from "@/lib/prospecting/provider";
import { tickProspecting } from "@/lib/prospecting/worker";

const ORG = "10000000-0000-4000-8000-000000000001";
const CANAL_A = "20000000-0000-4000-8000-00000000000a";
const CANAL_B = "20000000-0000-4000-8000-00000000000b";
const CAMPANHA_A = "30000000-0000-4000-8000-00000000000a";
const CAMPANHA_B = "30000000-0000-4000-8000-00000000000b";

/** Uma campanha `running` no molde real: coluna e `config` com o MESMO número. */
function campanha(id: string, canal: string, extra: Partial<Campaign> = {}): Campaign {
  return {
    id,
    organization_id: ORG,
    name: `Campanha ${id.slice(-1)}`,
    search: { niche: "n", location: "l" } as Campaign["search"],
    config: {
      agent_id: id,
      channel_session_id: canal,
      pipeline_id: id,
      stage_id: id,
      qualified_stage_id: "10000000-0000-4000-8000-000000000002",
      instruction: "Oferta definida pelo operador",
      qualification: "Necessidade confirmada pela pessoa",
      ofertas: ["site"],
      daily_limit: 10,
      interval_minutes: 15,
      legal_basis_ref: "LIA-example",
    } as unknown as Campaign["config"],
    status: "running",
    search_status: "succeeded",
    run_id: null,
    dataset_id: null,
    next_send_at: new Date(0),
    created_at: new Date(0),
    error: null,
    channel_session_id: canal,
    channel_down_since: null,
    ...extra,
  };
}

const candidato = (id: string) => ({
  id: `cand-${id.slice(-1)}`,
  organization_id: ORG,
  campaign_id: id,
  contact_id: id,
  conversation_id: id,
  message_id: `msg-${id.slice(-1)}`,
  phone: "+551****0000",
  service_boundary: { conversation_id: id },
  status: "queued",
  selected: true,
  lead_id: null,
  data: { name: "Example", socials: [] },
});

/**
 * BANCO DE MENTIRA do tick, com o suficiente para o envio rodar de ponta a
 * ponta. `contagens` é consultada pelo CANAL (é isso que o teste de teto mede),
 * e `relidas` permite simular a campanha pausada entre a seleção e a vez dela.
 */
function banco(opts: {
  rodando: Campaign[];
  relidas?: Record<string, Campaign | null>;
  contagens?: (canal: string) => { campaign: number; total: number; last_attempt?: Date | null };
  canalSumiu?: boolean;
}) {
  const chamadas: Array<[string, unknown[] | undefined]> = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    chamadas.push([sql, params]);
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
    if (sql.includes("pg_advisory_unlock")) return { rows: [] };
    if (sql.startsWith("select pc.organization_id")) return { rows: [{ organization_id: ORG }] };
    if (sql.includes("order by next_send_at,id")) return { rows: opts.rodando };
    if (
      sql.startsWith(
        "select * from prospecting_campaigns where organization_id=$1 and status='running' and id=$2",
      )
    ) {
      const id = String(params?.[1]);
      // `relidas` só manda nas campanhas que ele DECLARA: a outra continua
      // vindo de `rodando`, que é o estado normal entre a seleção e o envio.
      const c =
        opts.relidas && id in opts.relidas
          ? opts.relidas[id]
          : (opts.rodando.find((x) => x.id === id) ?? null);
      return { rows: c && c.status === "running" ? [c] : [] };
    }
    if (sql.includes("count(*) filter")) {
      const canal = String(params?.[2]);
      const c = opts.contagens?.(canal) ?? { campaign: 0, total: 0 };
      return { rows: [{ retry_at: null, last_attempt: null, ...c }] };
    }
    if (sql.startsWith("select daily_message_limit"))
      return { rows: opts.canalSumiu ? [] : [{ daily_message_limit: 50 }] };
    if (sql.startsWith("select * from prospecting_candidates"))
      return { rows: [candidato(String(params?.[1]))] };
    if (/^select (a\.)?published_version_id/.test(sql))
      return { rows: [{ published_version_id: ORG, operation_revision: 1 }] };
    return { rows: [] };
  });
  return { query, release: vi.fn(), chamadas };
}

function montarTick(db: ReturnType<typeof banco>) {
  (withProspectingLock as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (_p: unknown, _o: unknown, fn: (d: unknown) => Promise<unknown>) => fn(db),
  );
  return tickProspecting({ query: db.query, connect: async () => db } as never, {} as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.knobs.mockResolvedValue({ knobs: {}, numberActivatedAt: null });
  mocks.open.mockReturnValue(true);
  mocks.prospeccaoAberta.mockReturnValue(true);
  mocks.pacing.mockReturnValue({ allow: true, waitMs: 0 });
  mocks.preflight.mockResolvedValue({ permite: true });
  mocks.guard.mockResolvedValue(undefined);
  mocks.continuation.mockResolvedValue(undefined);
  mocks.boundary.mockResolvedValue(undefined);
  mocks.generate.mockResolvedValue({
    ok: true,
    texto: "Olá. Posso entender como vocês atendem hoje?",
  });
  mocks.authorize.mockResolvedValue({ ok: true });
  mocks.send.mockResolvedValue({ status: "sent" });
});

describe("tick da prospecção: uma campanha por NÚMERO (#3896)", () => {
  it("GREEN: duas campanhas rodando em números diferentes ENVIAM as duas na mesma rodada", async () => {
    const a = campanha(CAMPANHA_A, CANAL_A);
    const b = campanha(CAMPANHA_B, CANAL_B);
    await montarTick(banco({ rodando: [a, b] }));
    expect(mocks.send).toHaveBeenCalledTimes(2);
    const canais = vi.mocked(recordSend).mock.calls.map((c) => c[2]);
    expect(canais).toEqual([CANAL_A, CANAL_B]);
  });

  it("a ordem do claim é determinística: `order by next_send_at,id` (sem ele, qual das duas enviava variava)", async () => {
    const db = banco({ rodando: [campanha(CAMPANHA_A, CANAL_A)] });
    await montarTick(db);
    const claim = db.chamadas.find(([sql]) => sql.includes("order by next_send_at,id"))?.[0];
    expect(claim).toBeDefined();
    expect(claim).toMatch(/organization_id=\$1/);
    expect(claim).toMatch(/status='running'/);
  });

  it("LADO OPOSTO (b/e): campanha pausada entre a seleção e a vez dela NÃO envia — a releitura antes do envio é a cerca", async () => {
    const a = campanha(CAMPANHA_A, CANAL_A);
    const b = campanha(CAMPANHA_B, CANAL_B);
    await montarTick(
      banco({ rodando: [a, b], relidas: { [CAMPANHA_A]: { ...a, status: "paused" } } }),
    );
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]?.[1]).toMatchObject({
      agentOperation: { agentId: CAMPANHA_B },
    });
  });

  it("LADO OPOSTO (e): o que ficou preso em `sending` depois de um restart vira `failed`, nunca volta para a fila", async () => {
    const db = banco({ rodando: [] });
    await montarTick(db);
    const recuperacao = db.chamadas.find(([sql]) =>
      sql.includes("status='sending' and attempted_at"),
    )?.[0];
    expect(recuperacao).toBeDefined();
    expect(recuperacao).toMatch(/status='failed'/);
    expect(recuperacao).not.toMatch(/status='queued'/);
  });

  it("LADO OPOSTO (f): conexão que sumiu/foi arquivada não recebe envio", async () => {
    await montarTick(banco({ rodando: [campanha(CAMPANHA_A, CANAL_A)], canalSumiu: true }));
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("o prazo de 180 s do tick vale ENTRE as campanhas da mesma organização, não só entre organizações", async () => {
    // Uma org com muitos números roda N campanhas sob o MESMO bloqueio; sem a
    // conferência dentro do laço, ela sozinha estoura o prazo do tick.
    let agora = 1_000_000_000_000;
    const relogio = vi.spyOn(Date, "now").mockImplementation(() => agora);
    mocks.send.mockImplementation(async () => {
      agora += 181_000;
      return { status: "sent" };
    });
    try {
      await montarTick(
        banco({ rodando: [campanha(CAMPANHA_A, CANAL_A), campanha(CAMPANHA_B, CANAL_B)] }),
      );
    } finally {
      relogio.mockRestore();
    }
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});

describe("teto e intervalos são POR NÚMERO (#3896)", () => {
  it("a contagem é feita pelo canal da campanha, não pela organização", async () => {
    const db = banco({ rodando: [campanha(CAMPANHA_A, CANAL_A)] });
    await montarTick(db);
    const contagem = db.chamadas.find(([sql]) => sql.includes("count(*) filter"));
    expect(contagem?.[0]).toMatch(/pc\.channel_session_id=\$3/);
    expect(contagem?.[1]).toEqual([ORG, CAMPANHA_A, CANAL_A]);
  });

  it("LADO OPOSTO (d): canal A no teto de 50 NÃO impede o canal B de enviar", async () => {
    const a = campanha(CAMPANHA_A, CANAL_A);
    const b = campanha(CAMPANHA_B, CANAL_B);
    await montarTick(
      banco({
        rodando: [a, b],
        contagens: (canal) =>
          canal === CANAL_A ? { campaign: 50, total: 50 } : { campaign: 0, total: 0 },
      }),
    );
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]?.[1]).toMatchObject({
      agentOperation: { agentId: CAMPANHA_B },
    });
  });

  it("LADO OPOSTO (d): a tentativa recente do número A segura A — e NÃO segura B", async () => {
    const a = campanha(CAMPANHA_A, CANAL_A);
    const b = campanha(CAMPANHA_B, CANAL_B);
    const agora = new Date();
    await montarTick(
      banco({
        rodando: [a, b],
        // A acabou de tentar (dentro dos 15 min do intervalo); B, não.
        contagens: (canal) =>
          canal === CANAL_A
            ? { campaign: 1, total: 1, last_attempt: agora }
            : { campaign: 0, total: 0, last_attempt: null },
      }),
    );
    // Antes da #3896 a contagem era da ORGANIZAÇÃO: a tentativa de A segurava
    // B também, e os dois números andavam no passo de um só.
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]?.[1]).toMatchObject({
      agentOperation: { agentId: CAMPANHA_B },
    });
  });
});

describe("`assertCanalLivre`: a trava é do número, com nome de quem ocupa", () => {
  function cliente(ocupada: { id: string; name: string } | null) {
    return {
      query: vi.fn(async () => ({ rows: ocupada ? [ocupada] : [] })),
    } as never;
  }

  it("LADO OPOSTO (a): mesmo número continua bloqueado, com 409 e `prospecting_channel_busy`", async () => {
    const erro = await assertCanalLivre(
      cliente({ id: CAMPANHA_A, name: "Campanha A" }),
      ORG,
      CAMPANHA_B,
      CANAL_A,
    ).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ProspectingError);
    expect((erro as ProspectingError).status).toBe(409);
    expect((erro as ProspectingError).codigo).toBe("prospecting_channel_busy");
    expect((erro as ProspectingError).detalhes).toEqual({
      campaign_id: CAMPANHA_A,
      campaign_name: "Campanha A",
    });
    expect((erro as ProspectingError).message).toContain("Campanha A");
  });

  it("GREEN: número diferente passa", async () => {
    await expect(
      assertCanalLivre(cliente(null), ORG, CAMPANHA_B, CANAL_B),
    ).resolves.toBeUndefined();
  });

  it("LADO OPOSTO (b): pausada/encerrada não ocupa — a consulta só olha `running`", async () => {
    const db = cliente(null);
    await assertCanalLivre(db, ORG, CAMPANHA_B, CANAL_A);
    const [sql, params] = (db as unknown as { query: { mock: { calls: [string, unknown[]][] } } })
      .query.mock.calls[0]!;
    expect(sql).toMatch(/status='running'/);
    expect(params).toEqual([ORG, CANAL_A, CAMPANHA_B]);
  });

  it("LADO OPOSTO (c): a consulta é da ORGANIZAÇÃO — campanha de outra org nunca ocupa este número", async () => {
    const db = cliente(null);
    await assertCanalLivre(db, ORG, CAMPANHA_B, CANAL_A);
    const [sql] = (db as unknown as { query: { mock: { calls: [string, unknown[]][] } } }).query
      .mock.calls[0]!;
    expect(sql).toMatch(/organization_id=\$1/);
    expect(sql).toMatch(/id<>\$3/);
  });

  it("campanha sem número (rascunho nunca iniciado) não é travada por engano", async () => {
    const db = cliente({ id: CAMPANHA_A, name: "A" });
    await expect(assertCanalLivre(db, ORG, CAMPANHA_B, null)).resolves.toBeUndefined();
  });
});
