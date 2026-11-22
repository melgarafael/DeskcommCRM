import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  vetoDoContatoAntesDaVaga: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/agent-engine/pacing/store", () => ({
  loadChannelKnobs: mocks.knobs,
  loadPacingState: vi.fn().mockResolvedValue({ sentToday: 0 }),
  recordSend: vi.fn().mockResolvedValue(undefined),
}));
// O motor do PACING é dublê (a janela do NÚMERO não é o que este teste mede). A
// janela da CAMPANHA vem do módulo real: é ela que está sob prova.
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
vi.mock("@/lib/prospecting/store", () => ({
  withProspectingLock: vi.fn(),
  synchronizeSearch: vi.fn(),
  validateConfig: vi.fn().mockResolvedValue(undefined),
  prepararCandidatoNoEnvio: mocks.prepare,
}));
vi.mock("@/lib/prospecting/preparo", () => ({ prepararCandidatos: mocks.preparo }));

import {
  janelaDaCampanhaAberta,
  janelaDaCampanhaSchema,
  proximaAberturaDaJanelaDaCampanha,
  MOTIVO_DA_ESPERA_PELO_NUMERO,
  MOTIVO_DA_PAUSA_PELA_JANELA,
  pausarCampanhasForaDaJanela,
  retomarCampanhasNaJanela,
} from "@/lib/prospecting/janela-da-campanha";
import { withProspectingLock, type Campaign } from "@/lib/prospecting/store";
import { sendNextCandidate, tickProspecting } from "@/lib/prospecting/worker";

const ORG = "10000000-0000-4000-8000-000000000001";
const CANAL = "20000000-0000-4000-8000-00000000000a";
const CAMPANHA_A = "30000000-0000-4000-8000-00000000000a";
const CAMPANHA_B = "30000000-0000-4000-8000-00000000000b";
const FUSO = "America/Sao_Paulo";

/** Manhã de terça (17/11/2026), 13h em São Paulo: fora da janela 7h–12h. */
const TERCA_13H = new Date("2026-11-17T13:00:00-03:00");
/** Terça, 9h em São Paulo: dentro da janela 7h–12h. */
const TERCA_9H = new Date("2026-11-17T09:00:00-03:00");

const janelaManha = { dias: [1, 2, 3, 4, 5], inicio: 7, fim: 12 };

const campanha = (over: Partial<Campaign> = {}): Campaign =>
  ({
    id: CAMPANHA_A,
    organization_id: ORG,
    name: "Manhã — clínicas",
    next_send_at: new Date(0),
    status: "running",
    search_status: "succeeded",
    channel_session_id: CANAL,
    channel_down_since: null,
    pausada_pela_janela: false,
    config: {
      agent_id: ORG,
      channel_session_id: CANAL,
      pipeline_id: ORG,
      stage_id: ORG,
      qualified_stage_id: "10000000-0000-4000-8000-000000000002",
      instruction: "Oferta definida pelo operador",
      qualification: "Critério definido pelo operador",
      daily_limit: 10,
      interval_minutes: 15,
      legal_basis_ref: "LIA-example",
      janela: janelaManha,
    },
    ...over,
  }) as Campaign;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TERCA_13H);
  vi.clearAllMocks();
  mocks.knobs.mockResolvedValue({ knobs: { timezone: FUSO }, numberActivatedAt: null });
  mocks.open.mockReturnValue(true);
  mocks.prospeccaoAberta.mockReturnValue(true);
  mocks.pacing.mockReturnValue({ allow: true, waitMs: 0 });
  mocks.preflight.mockResolvedValue({ permite: true });
  mocks.guard.mockResolvedValue(undefined);
  mocks.continuation.mockResolvedValue(undefined);
  mocks.boundary.mockResolvedValue(undefined);
  mocks.authorize.mockResolvedValue({ permitido: true });
  mocks.generate.mockResolvedValue({ mensagem: "Olá", oferta: "site" });
  mocks.send.mockResolvedValue({ id: "m1" });
  mocks.prepare.mockResolvedValue({});
  mocks.preparo.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a régua da janela da campanha (#4830)", () => {
  it("abre só nos dias e horas configurados, no fuso da ORGANIZAÇÃO", () => {
    expect(janelaDaCampanhaAberta(TERCA_9H, janelaManha, FUSO)).toBe(true);
    expect(janelaDaCampanhaAberta(TERCA_13H, janelaManha, FUSO)).toBe(false);
    // Sábado 9h em São Paulo: o dia está fora da lista, a hora dentro.
    expect(
      janelaDaCampanhaAberta(new Date("2026-11-21T09:00:00-03:00"), janelaManha, FUSO),
    ).toBe(false);
  });

  it("o FUSO muda a resposta: 13h em São Paulo ainda é 9h da manhã em Manaus?", () => {
    // 12h UTC = 9h em São Paulo (dentro) e 11h em Manaus (dentro também) — o
    // que importa é que a régua seja a da ORGANIZAÇÃO, não a do servidor.
    const meioDiaUtc = new Date("2026-11-17T15:00:00Z"); // 12h SP, 11h Manaus
    expect(janelaDaCampanhaAberta(meioDiaUtc, { ...janelaManha, fim: 12 }, FUSO)).toBe(false);
    expect(janelaDaCampanhaAberta(meioDiaUtc, { ...janelaManha, fim: 12 }, "America/Manaus")).toBe(
      true,
    );
  });

  it("a próxima abertura é a do PRÓXIMO dia permitido, não 'daqui a uma hora'", () => {
    // Terça 13h05, janela seg-sex 7-12 → quarta 7h em São Paulo (10h UTC).
    const proxima = proximaAberturaDaJanelaDaCampanha(
      new Date("2026-11-17T13:05:00-03:00"),
      janelaManha,
      FUSO,
    );
    expect(proxima.toISOString()).toBe("2026-11-18T10:00:00.000Z");
    // Sexta 13h → segunda 7h (o fim de semana fica fora).
    const segunda = proximaAberturaDaJanelaDaCampanha(
      new Date("2026-11-20T13:00:00-03:00"),
      janelaManha,
      FUSO,
    );
    expect(segunda.toISOString()).toBe("2026-11-23T10:00:00.000Z");
  });

  it("recusa janela impossível: dia vazio e fim antes do início", () => {
    expect(janelaDaCampanhaSchema.safeParse({ dias: [], inicio: 7, fim: 12 }).success).toBe(false);
    expect(janelaDaCampanhaSchema.safeParse({ dias: [1], inicio: 12, fim: 7 }).success).toBe(false);
    expect(janelaDaCampanhaSchema.safeParse({ dias: [1], inicio: 7, fim: 7 }).success).toBe(false);
    // Repetido e fora de ordem é normalizado: a mesma janela não vira duas.
    const lida = janelaDaCampanhaSchema.parse({ dias: [3, 1, 3], inicio: 7, fim: 12 });
    expect(lida.dias).toEqual([1, 3]);
  });
});

describe("fora da janela a campanha NÃO dispara — nem continua (#4830)", () => {
  function bancoDoEnvio() {
    const writes: Array<[string, unknown[] | undefined]> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      writes.push([sql, params]);
      if (sql.startsWith("select timezone from organizations")) return { rows: [{ timezone: FUSO }] };
      if (sql.startsWith("select daily_message_limit")) return { rows: [{ daily_message_limit: 50 }] };
      if (sql.includes("count(*) filter"))
        return { rows: [{ campaign: 0, total: 0, retry_at: null, last_attempt: null }] };
      return { rows: [] };
    });
    return { query, writes };
  }

  it("(c) com o número aberto e a janela fechada, nada é enviado e a fila espera a abertura", async () => {
    const db = bancoDoEnvio();
    await sendNextCandidate({} as never, db as never, {} as never, campanha(), async () => {});

    // Nada saiu: sem handler de envio, sem candidato preparado.
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    // A única escrita é o adiamento, e ele aponta para a abertura da janela.
    const adiamento = db.writes.find(([sql]) => sql.includes("set next_send_at=$3"));
    expect(adiamento).toBeTruthy();
    expect((adiamento![1] as Date[])[2]!.toISOString()).toBe("2026-11-18T10:00:00.000Z");
  });

  it("(c) dentro da janela a régua da campanha não barra o envio", async () => {
    vi.setSystemTime(TERCA_9H);
    const db = bancoDoEnvio();
    // Sem candidato na fila o worker encerra o tick; o que importa é que o
    // caminho passou da janela da campanha e chegou ao ritmo do número.
    await sendNextCandidate({} as never, db as never, {} as never, campanha(), async () => {}).catch(
      () => undefined,
    );
    expect(db.writes.some(([sql]) => sql.includes("select timezone from organizations"))).toBe(true);
    expect(db.writes.some(([sql]) => sql.includes("set next_send_at=$3"))).toBe(false);
  });

  it("campanha SEM janela continua exatamente como hoje (nem consulta o fuso)", async () => {
    const db = bancoDoEnvio();
    const config = { ...(campanha().config as Record<string, unknown>) };
    delete config.janela;
    await sendNextCandidate(
      {} as never,
      db as never,
      {} as never,
      campanha({ config } as never),
      async () => {},
    ).catch(() => undefined);
    expect(db.writes.some(([sql]) => sql.includes("select timezone from organizations"))).toBe(
      false,
    );
  });
});

describe("pausa e retomada automáticas pelo caminho que já existe (#4830)", () => {
  function bancoCom(estado: {
    rodando?: Campaign[];
    pausadas?: Campaign[];
    ocupante?: { id: string; name: string };
    organizacoes?: boolean;
  }) {
    const writes: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      writes.push({ sql, params });
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (sql.includes("pg_advisory_unlock")) return { rows: [] };
      if (sql.startsWith("select pc.organization_id"))
        return { rows: estado.organizacoes === false ? [] : [{ organization_id: ORG }] };
      if (sql.startsWith("select timezone from organizations")) return { rows: [{ timezone: FUSO }] };
      // A varredura da pausa: campanhas running com janela.
      if (sql.includes("status='running' and config ? 'janela'"))
        return { rows: estado.rodando ?? [] };
      // A varredura da retomada: pausadas PELA janela.
      if (sql.includes("pausada_pela_janela and coalesce(config->>'arquivada_em'"))
        return { rows: estado.pausadas ?? [] };
      // `assertCanalLivre` — a trava de uma campanha por número.
      if (sql.includes("status='running' and id<>$3"))
        return { rows: estado.ocupante ? [estado.ocupante] : [] };
      if (sql.includes("order by next_send_at,id")) return { rows: [] };
      return { rows: [] };
    });
    return { db: { query, release: vi.fn() }, writes };
  }

  function montarTick(db: { query: unknown }) {
    (withProspectingLock as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (_p: unknown, _o: unknown, fn: (d: unknown) => Promise<unknown>) => fn(db),
    );
    return tickProspecting({ query: db.query, connect: async () => db } as never, {} as never);
  }

  it("(b) o tick PAUSA a campanha cuja janela fechou, com o motivo no cartão", async () => {
    const { db, writes } = bancoCom({ rodando: [campanha()] });
    await montarTick(db);

    const pausa = writes.find((w) => w.sql.includes("pausada_pela_janela=true"));
    expect(pausa).toBeTruthy();
    expect(pausa!.params).toEqual([ORG, CAMPANHA_A, MOTIVO_DA_PAUSA_PELA_JANELA]);
    // E não retomou nada: a mesma campanha não volta no mesmo tick, fora da janela.
    expect(writes.some((w) => w.sql.includes("status='running',pausada_pela_janela=false"))).toBe(
      false,
    );
  });

  it("(b) o tick RETOMA sozinho quando a janela abre — pelo caminho da rota (assertCanalLivre)", async () => {
    vi.setSystemTime(TERCA_9H);
    const { db, writes } = bancoCom({
      pausadas: [campanha({ status: "paused", pausada_pela_janela: true })],
    });
    await montarTick(db);

    // A trava foi consultada ANTES de voltar (a régua do #3896 continua valendo).
    const trava = writes.findIndex((w) => w.sql.includes("status='running' and id<>$3"));
    const retomada = writes.findIndex((w) =>
      w.sql.includes("status='running',pausada_pela_janela=false"),
    );
    expect(trava).toBeGreaterThanOrEqual(0);
    expect(retomada).toBeGreaterThan(trava);
    expect(writes[retomada]!.params).toEqual([ORG, CAMPANHA_A]);
  });

  it("(d) a janela abriu com OUTRA campanha running no mesmo número: a trava decide e a espera é NOMEADA", async () => {
    vi.setSystemTime(TERCA_9H);
    const { db, writes } = bancoCom({
      pausadas: [campanha({ status: "paused", pausada_pela_janela: true })],
      ocupante: { id: CAMPANHA_B, name: "Tarde — estética" },
    });
    const resumo = await (async () => {
      await montarTick(db);
      return writes;
    })();

    // Não voltou a rodar...
    expect(resumo.some((w) => w.sql.includes("status='running',pausada_pela_janela=false"))).toBe(
      false,
    );
    // ...e o motivo da espera foi gravado na campanha (nada de silêncio).
    const espera = resumo.find((w) => w.params?.includes(MOTIVO_DA_ESPERA_PELO_NUMERO));
    expect(espera).toBeTruthy();
    // A escrita é na campanha que continua pausada — a marca é o sujeito.
    expect(espera!.sql).toMatch(/and pausada_pela_janela/);
  });

  it("(b) a varredura direta: retomada num número livre devolve o id; ocupado devolve a espera", async () => {
    const livre = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pausada_pela_janela and coalesce(config->>'arquivada_em'"))
          return { rows: [{ ...campanha(), status: "paused", pausada_pela_janela: true }] };
        if (sql.includes("status='running' and id<>$3")) return { rows: [] };
        if (sql.includes("set status='running',pausada_pela_janela=false"))
          return { rows: [{ id: CAMPANHA_A }] };
        return { rows: [] };
      }),
    };
    await expect(
      retomarCampanhasNaJanela(livre as never, ORG, TERCA_9H, FUSO),
    ).resolves.toEqual({ retomadas: [CAMPANHA_A], esperando: [] });

    const ocupado = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pausada_pela_janela and coalesce(config->>'arquivada_em'"))
          return { rows: [{ ...campanha(), status: "paused", pausada_pela_janela: true }] };
        if (sql.includes("status='running' and id<>$3"))
          return { rows: [{ id: CAMPANHA_B, name: "Tarde — estética" }] };
        return { rows: [] };
      }),
    };
    await expect(
      retomarCampanhasNaJanela(ocupado as never, ORG, TERCA_9H, FUSO),
    ).resolves.toEqual({ retomadas: [], esperando: [CAMPANHA_A] });
  });

  it("#4847: a pausa da pessoa que chega entre a leitura e a escrita do tick NÃO é desfeita", async () => {
    // A rota `pause` não espera o bloqueio do tick. A corrida: o SELECT da
    // varredura vê a campanha com a marca; antes do UPDATE, a pessoa aperta
    // Pausar (marca vira false, status segue 'paused'). O UPDATE precisa
    // conferir a marca de novo — senão a campanha volta a rodar sozinha.
    const linha = { status: "paused", pausada_pela_janela: true };
    const banco = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pausada_pela_janela and coalesce(config->>'arquivada_em'"))
          return { rows: [{ ...campanha(), ...linha }] };
        if (sql.includes("status='running' and id<>$3")) {
          linha.pausada_pela_janela = false; // a pausa manual chega aqui
          return { rows: [] };
        }
        if (sql.startsWith("update prospecting_campaigns set status='running'")) {
          const comMarca = /and pausada_pela_janela/.test(sql.slice(sql.indexOf(" where ")));
          if (linha.status !== "paused" || (comMarca && !linha.pausada_pela_janela))
            return { rows: [] };
          linha.status = "running";
          return { rows: [{ id: CAMPANHA_A }] };
        }
        return { rows: [] };
      }),
    };
    await expect(
      retomarCampanhasNaJanela(banco as never, ORG, TERCA_9H, FUSO),
    ).resolves.toEqual({ retomadas: [], esperando: [] });
    expect(linha.status).toBe("paused");
  });

  it("(b) fora da janela a varredura de pausa não pausa quem está dentro", async () => {
    const dentro = {
      query: vi.fn(async () => ({ rows: [campanha()] })),
    };
    await expect(
      pausarCampanhasForaDaJanela(dentro as never, ORG, TERCA_9H, FUSO),
    ).resolves.toEqual([]);
  });

  it("#4847: à noite, o tick ENXERGA a organização cujo único item é campanha pausada pela janela", async () => {
    // Terça 21h — o caso da noite, com as duas campanhas do número fora do
    // horário: nenhuma `running`, nenhuma busca em andamento, só uma `paused`
    // com a marca da janela. A seleção de organizações do tick precisa ter o
    // `or pc.pausada_pela_janela`; sem ele o tick nunca entra na organização
    // e a pausa da janela vira congelamento permanente — ninguém retoma.
    vi.setSystemTime(new Date("2026-11-17T21:00:00-03:00"));
    const writes: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      writes.push({ sql, params });
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (sql.includes("pg_advisory_unlock")) return { rows: [] };
      if (sql.startsWith("select pc.organization_id")) {
        // A linha da organização: o ÚNICO item é a pausada pela janela. O
        // simulador só devolve a organização quando o SQL enxerga a marca —
        // é isso que torna o teste vermelho se a cláusula sumir.
        return { rows: /pausada_pela_janela/.test(sql) ? [{ organization_id: ORG }] : [] };
      }
      if (sql.startsWith("select timezone from organizations"))
        return { rows: [{ timezone: FUSO }] };
      if (sql.includes("status='running' and config ? 'janela'")) return { rows: [] };
      if (sql.includes("pausada_pela_janela and coalesce(config->>'arquivada_em'"))
        return { rows: [campanha({ status: "paused", pausada_pela_janela: true })] };
      return { rows: [] };
    });
    await montarTick({ query });

    // O tick entrou na organização: a varredura de retomada foi consultada…
    expect(
      writes.some((w) =>
        w.sql.includes("pausada_pela_janela and coalesce(config->>'arquivada_em'"),
      ),
    ).toBe(true);
    // …mas às 21h a janela está FECHADA e nada voltou a rodar.
    expect(writes.some((w) => w.sql.includes("status='running',pausada_pela_janela=false"))).toBe(
      false,
    );
  });
});
