import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A PORTA 3 DO ROTEAMENTO (#3916) — A ROTA, COM DUBLÊ DO POOL `pg`.
 *
 * ─── O defeito que este arquivo prende ──────────────────────────────────────
 *
 * A jornada de um atendente (e a da fila) é DERIVADA na leitura: `estaDePlantao`
 * e `isWithinSchedule` calculam "está aberto AGORA?" a cada consulta, e ninguém
 * escreve nada quando a janela vira. Consequência medida: uma conversa que
 * espera a fila abrir volta para o `event_log` com backoff
 * (`requeued_no_eligible`) e só é tentada de novo quando o backoff vence (até
 * 15 minutos, ou mais com `backoff_seconds` alto). Numa fila que ABRIU agora
 * não chega evento nenhum — a conversa espera a próxima tentativa com o
 * atendente de plantão do outro lado, e a tela mostra os dois disponíveis.
 *
 * Os quatro chamadores de `fn_wake_channel_routing` na `main` eram todos de
 * ESCRITA (salvar a política do número, revogar membro): nenhum olhava para o
 * relógio. E o cron que poderia olhar (`attendant-heartbeat`) foi removido.
 *
 * ─── O que a rota passou a fazer ────────────────────────────────────────────
 *
 * Antes do portão do piso ocioso — e isto é a decisão, não detalhe de ordem —
 * uma leitura de `attendant_availability` e uma de `attendant_sectors` dizem
 * quais organizações têm uma jornada que ABRIU neste tick; cada uma delas
 * recebe UM `fn_wake_channel_routing(org)`, que reenfileira as conversas sem
 * dono daquela organização. O tick que acorda é o mesmo que drena, porque a
 * rodada vem logo abaixo.
 *
 * ANTES do portão de propósito: atrás dele o passo só rodaria quando a fila já
 * tivesse trabalho — e o caso desta porta é justamente o de fila VAZIA, onde a
 * abertura da jornada é o único trabalho do minuto. É o caso 4 abaixo, o que
 * mais importa neste arquivo.
 *
 * ─── Por que dublê do POOL, e não do módulo do acorde ───────────────────────
 *
 * O acorde custa o que custa: 2 SELECT + 1 ida por organização aberta, por
 * tick. Um dublê do módulo provaria que a rota chama a função, não que ela lê
 * o banco certo, uma vez por tick, sem escrever. O dossiê vai pelo pool porque
 * é por ele que o custo existe (fora da cota do PostgREST).
 */

const SEGREDO = "segredo-do-cron";
const ORG = "22222222-2222-4222-8222-222222222222";
const ORG_DA_FILA = "33333333-3333-4333-8333-333333333333";
const ORG_24H = "55555555-5555-4555-8555-555555555555";

/** Segunda 2026-07-13 08:00 em São Paulo (UTC-03). */
const SEG_0800_BRT = new Date("2026-07-13T11:00:00Z");
/** O tick seguinte: 08:01. */
const SEG_0801_BRT = new Date("2026-07-13T11:01:00Z");

const JORNADA_8_AS_18 = {
  timezone: "America/Sao_Paulo",
  windows: [{ dow: 1, start: "08:00", end: "18:00" }],
};
const JORNADA_24H = { timezone: "America/Sao_Paulo", windows: [] };

// --- dublês -----------------------------------------------------------------

type Consulta = { texto: string; valores: unknown[] };

let consultas: Consulta[];
let jornadas: { disponibilidade: unknown[]; filas: unknown[] };
/** Faz a leitura do acorde estourar (o banco fora, a tabela ausente). */
let leituraQuebrada: string | null;

const pool = {
  query: (texto: string, valores: unknown[] = []) => {
    consultas.push({ texto, valores });
    const normalizado = texto.replace(/\s+/g, " ").trim().toLowerCase();
    if (leituraQuebrada && /attendant_(availability|sectors)/.test(normalizado)) {
      return Promise.reject(new Error(leituraQuebrada));
    }
    if (normalizado.includes("attendant_availability")) {
      return Promise.resolve({ rows: jornadas.disponibilidade });
    }
    if (normalizado.includes("attendant_sectors")) {
      return Promise.resolve({ rows: jornadas.filas });
    }
    if (normalizado.includes("fn_wake_channel_routing")) {
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  },
};

const rodada = vi.fn();
const auditar = vi.fn();

// Literais dentro da fábrica: `vi.mock` é içado para o topo do arquivo e uma
// `const` do módulo estaria em TDZ quando a fábrica roda.
vi.mock("@/lib/env", () => ({ env: { INTERNAL_CRON_SECRET: "segredo-do-cron", INTERNAL_SECRET: "" } }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => pool }));
vi.mock("@/lib/routing/worker", () => ({ runRoutingWorker: (...a: unknown[]) => rodada(...a) }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditar(...a) }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { GET } from "@/app/api/v1/cron/routing-worker/route";
import { RECURSOS_DO_CRON, esquecerRetrato, semearRetrato } from "@/lib/cron/piso-ocioso";

function chamar(segredo = SEGREDO): Promise<Response> {
  return GET(
    new NextRequest("http://local/api/v1/cron/routing-worker", {
      headers: segredo ? { authorization: `Bearer ${segredo}` } : {},
    }),
  );
}

const corpoDe = async (res: Response) =>
  ((await res.json()) as { data: Record<string, unknown> }).data;

/** O portão como o crond encontra: `true` = tem trabalho na fila. */
function semearPortao(temTrabalho: boolean): void {
  semearRetrato(
    Object.fromEntries(RECURSOS_DO_CRON.map((r) => [r, r === "roteamento" ? temTrabalho : false])) as
      Record<(typeof RECURSOS_DO_CRON)[number], boolean>,
  );
}

const acordes = () => consultas.filter((c) => /fn_wake_channel_routing/i.test(c.texto));
const leiturasDe = (tabela: string) =>
  consultas.filter((c) => new RegExp(`attendant_${tabela}`, "i").test(c.texto));
/** Nenhuma escrita nas duas tabelas de jornada: o acorde é só chamada de TS. */
const escritas = () =>
  consultas.filter(
    (c) =>
      /attendant_(availability|sectors)/i.test(c.texto) &&
      !/^\s*(select|with)\b/i.test(c.texto),
  );

beforeEach(() => {
  consultas = [];
  jornadas = { disponibilidade: [], filas: [] };
  leituraQuebrada = null;
  rodada.mockReset();
  rodada.mockResolvedValue({ batch_size: 0, outcomes: {}, errors: [] });
  auditar.mockReset();
  esquecerRetrato();
  // Só o relógio é falso: as promessas da rota continuam com o timer real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SEG_0800_BRT);
});

afterEach(() => {
  vi.useRealTimers();
  esquecerRetrato();
});

describe("GET /api/v1/cron/routing-worker — a jornada que abre acorda o canal", () => {
  it("sem o segredo: 403, e nem o pool é aberto", async () => {
    const res = await chamar("");
    expect(res.status).toBe(403);
    expect(consultas).toEqual([]);
    expect(rodada).not.toHaveBeenCalled();
  });

  /**
   * O CASO CENTRAL. Uma organização com jornada segunda 08:00–18:00, no tick das
   * 08:00: UM acorde, e ele vai pelo pool (fora da cota do PostgREST), por
   * ORGANIZAÇÃO — não por canal. No mesmo tick a rodada abaixo drena o que o
   * acorde enfileirou: é a razão de o passo estar antes da rodada.
   */
  it("abertura das 08:00: um acorde para a organização, e a rodada drena no MESMO tick", async () => {
    semearPortao(true);
    jornadas.disponibilidade = [{ organization_id: ORG, schedule: JORNADA_8_AS_18 }];

    const res = await chamar();

    expect(res.status).toBe(200);
    expect(await corpoDe(res)).toMatchObject({ batch_size: 0, errors: [] });
    expect(acordes()).toEqual([
      expect.objectContaining({ valores: [ORG], texto: expect.stringMatching(/fn_wake_channel_routing/i) }),
    ]);
    expect(rodada).toHaveBeenCalledTimes(1);
    // O custo declarado no corpo do PR: 2 SELECT por tick, uma leitura de cada
    // tabela de jornada — nunca uma por organização nem por atendente.
    expect(leiturasDe("availability")).toHaveLength(1);
    expect(leiturasDe("sectors")).toHaveLength(1);
    expect(escritas()).toEqual([]);
  });

  /**
   * IDEMPOTENTE SEM COLUNA DE ESTADO: o tick seguinte (08:01) tem a mesma linha
   * no banco e NÃO acorda nada, porque 08:00 já estava dentro da janela. Nada
   * foi gravado para lembrar disso — é a conta, duas vezes.
   */
  it("o tick seguinte (08:01) não repete o acorde — a janela já estava aberta um minuto atrás", async () => {
    // O relógio ANTES do retrato: `semearRetrato` grava validade a partir de
    // `Date.now()`, e semear às 08:00 para perguntar às 08:01 venceria o retrato
    // — o portão releria o banco e o caso mediria outra coisa.
    vi.setSystemTime(SEG_0801_BRT);
    semearPortao(true);
    jornadas.disponibilidade = [{ organization_id: ORG, schedule: JORNADA_8_AS_18 }];

    const res = await chamar();

    expect(res.status).toBe(200);
    expect(acordes()).toEqual([]);
    // As duas leituras continuam acontecendo: o custo por tick é fixo e não
    // depende de haver abertura.
    expect(leiturasDe("availability")).toHaveLength(1);
    expect(leiturasDe("sectors")).toHaveLength(1);
    expect(rodada).toHaveBeenCalledTimes(1);
  });

  /**
   * A ORDEM DO PASSO — o caso que justifica "antes do portão". Com a fila vazia
   * o portão sai da rota inteira, e é exatamente a instalação em que a abertura
   * da jornada é o único trabalho do minuto: se o acorde estivesse atrás dele,
   * nunca rodaria aqui.
   */
  it("portão ocioso (recursoOcioso ativo): o acorde acontece assim mesmo, e a rota sai sem drenar", async () => {
    semearPortao(false);
    jornadas.disponibilidade = [{ organization_id: ORG, schedule: JORNADA_8_AS_18 }];

    const res = await chamar();

    expect(res.status).toBe(200);
    expect(await corpoDe(res)).toEqual({ pulado: "recurso_ocioso" });
    expect(acordes()).toEqual([expect.objectContaining({ valores: [ORG] })]);
    expect(rodada).not.toHaveBeenCalled();
  });

  /**
   * O CONTROLE NEGATIVO, com o portão ABERTO (fila com trabalho): jornada 24/7
   * não tem virada para avisar, e jornada fechada não abriu. Sem este caso, uma
   * rota que acordasse toda organização em todo tick passaria nos de cima.
   */
  it("jornada 24/7 e jornada fechada não acordam nada, nem com o portão aberto", async () => {
    semearPortao(true);
    jornadas.disponibilidade = [
      { organization_id: ORG_24H, schedule: JORNADA_24H },
      { organization_id: ORG, schedule: { ...JORNADA_8_AS_18, windows: [{ dow: 2, start: "08:00", end: "18:00" }] } },
    ];

    const res = await chamar();

    expect(res.status).toBe(200);
    expect(acordes()).toEqual([]);
    expect(rodada).toHaveBeenCalledTimes(1);
  });

  /**
   * A FILA TAMBÉM TEM JORNADA (`attendant_sectors.schedule`, migration 9062):
   * `loadEligibleAttendants` devolve vazio quando a fila está fechada, e a
   * conversa fica no backoff. Se o acorde só olhasse `attendant_availability`, a
   * abertura de uma FILA sem ninguém de plantão individual nunca acordaria.
   */
  it("a abertura da FILA (attendant_sectors) acorda o canal da organização", async () => {
    semearPortao(false);
    jornadas.filas = [{ organization_id: ORG_DA_FILA, schedule: JORNADA_8_AS_18 }];

    const res = await chamar();

    expect(res.status).toBe(200);
    expect(acordes()).toEqual([expect.objectContaining({ valores: [ORG_DA_FILA] })]);
  });

  /**
   * O acorde não pode derrubar o tick: banco fora, tabela ausente numa instalação
   * antiga, RLS que recusa. A rodada é o trabalho; o acorde é a promoção dele.
   */
  it("leitura do acorde que falha não derruba o tick (200, sem acorde, rodada roda)", async () => {
    semearPortao(true);
    leituraQuebrada = "relation \"attendant_sectors\" does not exist";

    const res = await chamar();

    expect(res.status).toBe(200);
    expect(acordes()).toEqual([]);
    expect(rodada).toHaveBeenCalledTimes(1);
  });
});
