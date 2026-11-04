/**
 * AS FILAS DE MINUTO E DE 5 MINUTOS SAEM CEDO (#3731, parte 1 — segunda fatia).
 *
 * O piso ocioso do #3753/#3707 desligou as rotas de PROSPECÇÃO, CAMPANHA,
 * HISTÓRICO e AGENDA. Ficaram fora dele as rotas de FILA — soneca vencida,
 * mensagem presa, fila de redação de objeto, handoff, rodízio, saúde de canal,
 * revogação de MCP, lembrete de tarefa e de agenda —, cada uma batendo no
 * PostgREST a cada 5 minutos só para descobrir que a fila está vazia: medido em
 * 2,4 requisições/min (144/h) numa instalação parada, mais que a metade do que
 * sobrou do crontab depois do #3753.
 *
 * Cada rota, dois lados:
 *
 *   desligado → ZERO `from()`/`rpc()` ao PostgREST e o trabalho não roda;
 *   ligado    → o trabalho roda como sempre (sem este lado, "economizar" poderia
 *               ser só "desligar o cron" e o teste passaria feliz).
 *
 * O portão é o REAL (`lib/cron/piso-ocioso.ts`), semeado com `semearRetrato` —
 * mock de módulo do portão vaza entre arquivos da suíte. O TTL, a invalidação e
 * a regra de falha ("não sei" = roda) estão em `lib/cron/piso-ocioso.test.ts`;
 * aqui se mede a DECISÃO DE CADA ROTA.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { esquecerRetrato, RECURSOS_DO_CRON, type RecursoDoCron, semearRetrato } from "@/lib/cron/piso-ocioso";

const estado = vi.hoisted(() => ({
  /** Toda tabela tocada por `from()` — a prova de "não tocou o PostgREST". */
  consultas: {} as Record<string, number>,
  rpcs: [] as string[],
  /** Trabalho dublado que mora em módulo próprio (prova do caminho normal). */
  podaDaFilaDeRedacao: 0,
  revogacaoDeMcp: 0,
}));

function cadeia(tabela: string): Record<string, unknown> {
  estado.consultas[tabela] = (estado.consultas[tabela] ?? 0) + 1;
  const passo: Record<string, unknown> = {};
  for (const verbo of [
    "select",
    "eq",
    "neq",
    "in",
    "is",
    "not",
    "or",
    "lt",
    "lte",
    "gt",
    "gte",
    "order",
    "limit",
    "update",
    "delete",
  ]) {
    passo[verbo] = () => cadeia(tabela);
  }
  passo.maybeSingle = async () => ({ data: null, error: null });
  passo.single = async () => ({ data: null, error: null });
  passo.insert = async () => ({ data: null, error: null });
  passo.upsert = async () => ({ data: null, error: null });
  // Cadeia "aguardável": qualquer `await` sobre ela resolve com o vazio.
  passo.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null, count: 0 }).then(resolve);
  return passo;
}

const clienteFalso = {
  from: (tabela: string) => cadeia(tabela),
  rpc: (fn: string) => {
    estado.rpcs.push(fn);
    return Promise.resolve({ data: [], error: null });
  },
};

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/logger", () => ({ logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => clienteFalso }));
vi.mock("@/lib/lgpd/storage-redaction-queue", () => ({
  drainStorageRedactionQueue: async () => {
    estado.podaDaFilaDeRedacao += 1;
    return { processados: 0 };
  },
}));
vi.mock("@/lib/mcp/servidor-externo/do-agente/revogacao", () => ({
  revogarVencidas: async () => {
    estado.revogacaoDeMcp += 1;
    return { revogadas: 0, apagadas: 0, pedidosPodados: 0 };
  },
}));

async function chamar(rota: string): Promise<{ status: number; body: { data?: { pulado?: string } } }> {
  const mod = (await import(`@/app/api/v1/cron/${rota}/route`)) as {
    GET: (r: NextRequest) => Promise<Response>;
  };
  const res = await mod.GET(
    new NextRequest(`http://localhost/api/v1/cron/${rota}`, { headers: { authorization: "Bearer teste" } }),
  );
  return { status: res.status, body: (await res.json()) as { data?: { pulado?: string } } };
}

const todos = (valor: boolean) =>
  Object.fromEntries(RECURSOS_DO_CRON.map((r) => [r, valor])) as Record<RecursoDoCron, boolean>;

/** Semeia o retrato: tudo com trabalho, menos o recurso que o caso desligar. */
function retrato(desligados: Partial<Record<RecursoDoCron, false>> = {}): void {
  semearRetrato({ ...todos(true), ...desligados });
}

interface Caso {
  rota: string;
  recurso: RecursoDoCron;
  /** Prova de que a rodada de verdade aconteceu (o lado do "recurso ligado"). */
  prova: () => number;
}

const CASOS: Caso[] = [
  { rota: "snooze-watcher", recurso: "fila_de_soneca", prova: () => estado.consultas.conversations ?? 0 },
  { rota: "recover-stuck-messages", recurso: "mensagem_presa", prova: () => estado.consultas.messages ?? 0 },
  { rota: "storage-redaction", recurso: "redacao_de_storage", prova: () => estado.podaDaFilaDeRedacao },
  { rota: "handoff-devolucao", recurso: "devolucao_de_handoff", prova: () => estado.consultas.organizations ?? 0 },
  { rota: "rodizio-devolucao", recurso: "devolucao_ao_rodizio", prova: () => estado.consultas.organizations ?? 0 },
  { rota: "channel-health", recurso: "canal_vigiado", prova: () => estado.consultas.channel_sessions ?? 0 },
  { rota: "mcp-oauth-revogacao", recurso: "mcp_a_revogar", prova: () => estado.revogacaoDeMcp },
  { rota: "task-reminder", recurso: "lembrete_de_tarefa", prova: () => estado.consultas.crm_tasks ?? 0 },
  { rota: "agenda-reminder", recurso: "lembrete_de_agenda", prova: () => estado.consultas.calendar_appointments ?? 0 },
];

beforeEach(() => {
  esquecerRetrato();
  estado.consultas = {};
  estado.rpcs = [];
  estado.podaDaFilaDeRedacao = 0;
  estado.revogacaoDeMcp = 0;
});

// O retrato é estado de módulo: deixar um semeado para trás mudaria a próxima
// rota da suíte (a saída antecipada é silenciosa).
afterEach(() => {
  esquecerRetrato();
});

describe.each(CASOS)("cron $rota", ({ rota, recurso, prova }) => {
  it("recurso desligado: sai cedo, sem NENHUM from()/rpc() ao PostgREST", async () => {
    retrato({ [recurso]: false });
    const res = await chamar(rota);

    expect(res.status).toBe(200);
    expect(res.body.data?.pulado).toBe("recurso_ocioso");
    expect(estado.consultas).toEqual({});
    expect(estado.rpcs).toEqual([]);
    expect(prova()).toBe(0);
  });

  it("recurso ligado: a rodada roda (controle positivo)", async () => {
    retrato();
    const res = await chamar(rota);

    expect(res.status).toBe(200);
    expect(res.body.data?.pulado).toBeUndefined();
    expect(prova()).toBeGreaterThan(0);
  });
});

describe("⭐ o recurso que passa a ser usado volta no ciclo seguinte", () => {
  it("a rodada lê o retrato de novo depois do TTL — nada de flag congelada", async () => {
    // 1ª batida: fila vazia, a rota sai.
    retrato({ fila_de_soneca: false });
    expect((await chamar("snooze-watcher")).body.data?.pulado).toBe("recurso_ocioso");

    // O relógio anda além da janela do retrato e a conversa é sonecada fora daqui
    // (gatilho/RPC em outro processo). A batida seguinte relê e RODA — sem nenhuma
    // invalidação explícita, que é o caso do trabalho que nasce no banco.
    semearRetrato(todos(true), Date.now() - 1);
    const res = await chamar("snooze-watcher");
    expect(res.body.data?.pulado).toBeUndefined();
    expect(estado.consultas.conversations ?? 0).toBeGreaterThan(0);
  });

  it("desligar um recurso não desliga os vizinhos", async () => {
    retrato({ fila_de_soneca: false });
    const snooze = await chamar("snooze-watcher");
    const presa = await chamar("recover-stuck-messages");

    expect(snooze.body.data?.pulado).toBe("recurso_ocioso");
    expect(presa.body.data?.pulado).toBeUndefined();
    expect(estado.consultas.messages ?? 0).toBeGreaterThan(0);
  });
});
