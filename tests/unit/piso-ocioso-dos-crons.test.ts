/**
 * O PISO OCIOSO, ROTA POR ROTA (#3731, parte 1) — a saída antecipada e o
 * caminho normal, na mesma régua.
 *
 * Para cada uma das cinco rotas que ganharam o portão:
 *
 * - recurso DESLIGADO (fila vazia): responde `pulado: recurso_ocioso`, NÃO chama
 *   o trabalho e — o ponto do defeito — NÃO faz uma única requisição ao
 *   Supabase (`from`/`rpc` do cliente admin, contados no dublê);
 * - recurso LIGADO: o trabalho roda como sempre. Sem este lado, "economizar"
 *   poderia ser só "desligar o cron", e o teste passaria feliz.
 *
 * O portão em si (quantas consultas, quando vence, o que faz na falha) tem teste
 * próprio em lib/cron/piso-ocioso.test.ts.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { esquecerRetrato, semearRetrato } from "@/lib/cron/piso-ocioso";

const h = vi.hoisted(() => ({
  reqs: [] as string[],
  tickProspecting: vi.fn(async () => ({ rodada: "prospeccao" })),
  rodadaDeCampanha: vi.fn(async () => ({ enviadas: 0, pulados: 0, concluidas: 0, promovidas: 0 })),
  rodadaDeHistorico: vi.fn(async () => ({ status: "concluida", gravadas: 0 })),
  candidatos: vi.fn(async () => ({ data: [], error: null })),
}));

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      h.reqs.push(`from:${tabela}`);
      return encadeavel();
    },
    rpc: (nome: string) => {
      h.reqs.push(`rpc:${nome}`);
      return encadeavel();
    },
  }),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
vi.mock("@/lib/prospecting/worker", () => ({ tickProspecting: h.tickProspecting }));
vi.mock("@/lib/campanhas/rodada", () => ({ rodarUmaRodadaDeCampanha: h.rodadaDeCampanha }));
vi.mock("@/lib/channels/historico/rodada", () => ({
  rodarUmaRodada: h.rodadaDeHistorico,
  TETO_PADRAO: {},
}));
vi.mock("@/lib/agenda/google/calendar-executor", () => ({
  refreshCatalog: vi.fn(async () => undefined),
  syncCalendar: vi.fn(async () => undefined),
}));
vi.mock("@/lib/agenda/google/membros", () => ({ apenasDeMembrosAtivos: async () => [] }));
vi.mock("@/lib/agenda/google/candidates", () => ({ googlePushCandidates: h.candidatos }));
vi.mock("@/lib/agenda/google/sync-executor", () => ({ reconcileAppointment: vi.fn() }));

/** Cliente supabase-js de mentira: toda cadeia resolve vazia e NÃO faz rede. */
function encadeavel(): unknown {
  const alvo: Record<string, unknown> = {};
  const proxy: unknown = new Proxy(alvo, {
    get(_t, prop: string) {
      if (prop === "then")
        return (resolve: (v: unknown) => unknown) =>
          resolve({ data: [], error: null, count: 0, status: 200, statusText: "OK" });
      if (prop === "maybeSingle" || prop === "single") return async () => ({ data: null, error: null });
      return () => proxy;
    },
  });
  return proxy;
}

interface Caso {
  rota: string;
  /** Quantas vezes o trabalho da rota foi chamado (lado do "recurso ligado"). */
  trabalho: () => number;
  /** Requisições ao Supabase no caminho normal — o lado do "recurso ligado". */
  exigeBanco: boolean;
  /** O que só existe no caminho normal, para o controle positivo de cada rota. */
  provaDoCaminhoNormal: () => number;
}

const CASOS: Caso[] = [
  {
    rota: "prospecting",
    trabalho: () => h.tickProspecting.mock.calls.length,
    exigeBanco: false,
    // A rodada da prospecção fala com o Postgres direto (pool), não com o
    // PostgREST: o trabalho é a prova de que ela rodou.
    provaDoCaminhoNormal: () => h.tickProspecting.mock.calls.length,
  },
  {
    rota: "campaign-worker",
    trabalho: () => h.rodadaDeCampanha.mock.calls.length,
    exigeBanco: false,
    // O trabalho é dublado: quem prova o caminho normal é a chamada dele.
    provaDoCaminhoNormal: () => h.rodadaDeCampanha.mock.calls.length,
  },
  {
    rota: "historico-import",
    trabalho: () => h.rodadaDeHistorico.mock.calls.length,
    exigeBanco: true,
    // Sem importação `rodando` o trabalho não roda — quem prova o caminho
    // normal é a LEITURA da fila, que é o que o portão economiza.
    provaDoCaminhoNormal: () => h.reqs.length,
  },
  {
    rota: "agenda-google-sync",
    trabalho: () => h.candidatos.mock.calls.length,
    exigeBanco: true,
    provaDoCaminhoNormal: () => h.reqs.length,
  },
  {
    rota: "agenda-google-push",
    trabalho: () => h.candidatos.mock.calls.length,
    exigeBanco: false,
    provaDoCaminhoNormal: () => h.candidatos.mock.calls.length,
  },
];

async function chamar(rota: string): Promise<{ status: number; body: { data?: { pulado?: string } } }> {
  const mod = (await import(`@/app/api/v1/cron/${rota}/route`)) as {
    GET: (r: NextRequest) => Promise<Response>;
  };
  const res = await mod.GET(new NextRequest(`http://localhost/api/v1/cron/${rota}`));
  return { status: res.status, body: (await res.json()) as { data?: { pulado?: string } } };
}

const TODOS_DESLIGADOS = {
  prospeccao: false,
  campanhas: false,
  historico: false,
  agenda_google: false,
  agenda_google_push: false,
};
const TODOS_LIGADOS = {
  prospeccao: true,
  campanhas: true,
  historico: true,
  agenda_google: true,
  agenda_google_push: true,
};

beforeEach(() => {
  h.reqs = [];
  vi.clearAllMocks();
  esquecerRetrato();
});

// O retrato é estado de módulo: deixar um semeado para trás mudaria a próxima
// rota da suíte (a saída antecipada é silenciosa, então o estrago apareceria
// como um teste alheio "sem fazer nada").
afterEach(() => {
  esquecerRetrato();
});

describe.each(CASOS)("cron $rota", ({ rota, trabalho, exigeBanco, provaDoCaminhoNormal }) => {
  it("recurso desligado: sai cedo, sem tocar o Supabase e sem rodar o trabalho", async () => {
    semearRetrato(TODOS_DESLIGADOS);
    const res = await chamar(rota);

    expect(res.status).toBe(200);
    expect(res.body.data?.pulado).toBe("recurso_ocioso");
    expect(h.reqs).toEqual([]);
    expect(trabalho()).toBe(0);
  });

  it("recurso ligado: o cron continua rodando (controle positivo)", async () => {
    semearRetrato(TODOS_LIGADOS);
    const res = await chamar(rota);

    expect(res.status).toBe(200);
    expect(res.body.data?.pulado).toBeUndefined();
    expect(provaDoCaminhoNormal()).toBeGreaterThan(0);
    if (exigeBanco) expect(h.reqs.length).toBeGreaterThan(0);
  });
});

describe("cron agenda-google-push: o portão é o da rota, não o da conexão saudável", () => {
  it("sem conexão saudável, mas com compromisso a empurrar: o push RODA", async () => {
    // A rota não filtra o status da conexão: o compromisso de uma conexão que
    // precisa de atenção ainda passa pelo executor e recebe o aviso "Confira a
    // conexão". Um portão por `healthy` o deixaria pendente sem aviso.
    semearRetrato({ ...TODOS_DESLIGADOS, agenda_google_push: true });
    const res = await chamar("agenda-google-push");

    expect(res.status).toBe(200);
    expect(res.body.data?.pulado).toBeUndefined();
    expect(h.candidatos).toHaveBeenCalledOnce();
  });

  it("com conexão saudável, mas sem compromisso a empurrar: o push sai cedo", async () => {
    semearRetrato({ ...TODOS_LIGADOS, agenda_google_push: false });
    const res = await chamar("agenda-google-push");

    expect(res.body.data?.pulado).toBe("recurso_ocioso");
    expect(h.candidatos).not.toHaveBeenCalled();
  });
});
