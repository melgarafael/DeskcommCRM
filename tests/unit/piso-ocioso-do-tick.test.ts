/**
 * O TICK INTEIRO DO CRON SOB O PISO OCIOSO (#3731, parte 1) — as cinco perguntas
 * que a entrega tem de responder, no nível da ROTA:
 *
 *   (a) recurso DESLIGADO: nenhuma leitura e nenhuma escrita no banco;
 *   (b) recurso LIGADO: a rota faz exatamente o que fazia (caracterização);
 *   (c) várias rotas no MESMO tick: uma única consulta de estado, não uma por rota;
 *   (d) cron de NÚCLEO roda independentemente do retrato — fila de envio e
 *       dispatcher não podem parar porque um recurso opcional está desligado;
 *   (e) falha ao descobrir o estado: o tick não cai, o erro é registrado e a
 *       falha não inventa trabalho (não marca a rota como ociosa).
 *
 * O portão é o REAL (`lib/cron/piso-ocioso.ts`). Aqui ele é exercitado por dois
 * caminhos: semeado (`semearRetrato`, o lado determinístico de a/b/d) e SEM
 * semear, com o pool dublado contando `query` (c/e — o caminho de produção).
 *
 * `cadencia-worker` é a rota que esta fatia acrescenta ao portão: módulo de
 * TABELA, desligado por padrão, e a pergunta "está instalado?" custava DUAS
 * leituras ao PostgREST por minuto (`lib/instalacao/modulos.ts` lê
 * `platform_config` e `modulos_instalados`) = 120 idas/h.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { esquecerRetrato, RECURSOS_DO_CRON, type RecursoDoCron, semearRetrato } from "@/lib/cron/piso-ocioso";

const h = vi.hoisted(() => ({
  /** Toda ida ao PostgREST: `from:tabela` / `rpc:fn`. */
  reqs: [] as string[],
  /** Leitura do retrato pelo pool `pg` — o que o portão conta. */
  consultasDoRetrato: 0,
  retratoFalha: false,
  avisos: [] as string[],
  cadencia: vi.fn(async () => ({ processadas: 2, emailsEnviados: 1, concluidas: 1, paradas: 0, falhas: 0 })),
  prospeccao: vi.fn(async () => ({ rodada: "prospeccao" })),
  campanha: vi.fn(async () => ({ enviadas: 0, pulados: 0, concluidas: 0, promovidas: 0 })),
  historico: vi.fn(async () => ({ status: "concluida", gravadas: 0 })),
  auditar: vi.fn(async (_entrada: Record<string, unknown>) => undefined),
  enviarAgendadas: vi.fn(async () => ({ processadas: 0, encaminhadas: 0, falhas: 0, canceladas: 0, esperando: 0 })),
}));

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/audit", () => ({ audit: h.auditar }));
vi.mock("@/lib/logger", () => ({
  logger: {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (mensagem: string) => {
      h.avisos.push(mensagem);
    },
  },
}));
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
  getRequestPool: () => ({
    query: async () => {
      h.consultasDoRetrato += 1;
      if (h.retratoFalha) throw new Error("relation \"prospecting_campaigns\" does not exist");
      return { rows: [], rowCount: 0 };
    },
  }),
}));
vi.mock("@/lib/cadencias/worker", () => ({ processarCadencias: h.cadencia }));
vi.mock("@/lib/prospecting/worker", () => ({ tickProspecting: h.prospeccao }));
vi.mock("@/lib/campanhas/rodada", () => ({ rodarUmaRodadaDeCampanha: h.campanha }));
vi.mock("@/lib/channels/historico/rodada", () => ({ rodarUmaRodada: h.historico, TETO_PADRAO: {} }));
vi.mock("@/lib/agenda/google/calendar-executor", () => ({
  refreshCatalog: async () => undefined,
  syncCalendar: async () => undefined,
}));
vi.mock("@/lib/agenda/google/membros", () => ({ apenasDeMembrosAtivos: async () => [] }));
vi.mock("@/lib/agenda/google/candidates", () => ({ googlePushCandidates: async () => ({ data: [], error: null }) }));
vi.mock("@/lib/agenda/google/sync-executor", () => ({ reconcileAppointment: vi.fn() }));
vi.mock("@/lib/organizacao/operante", () => ({ idsDeOrgsParadas: async () => [], ehOperante: () => true }));
vi.mock("@/lib/agendamento-mensagem/envio", () => ({
  autorAindaTemAcesso: async () => true,
  encaminharAgendamento: h.enviarAgendadas,
  sessaoEstaConectada: async () => true,
}));

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

async function chamar(rota: string): Promise<{ status: number; body: { data?: Record<string, unknown> } }> {
  const mod = (await import(`@/app/api/v1/cron/${rota}/route`)) as {
    GET: (r: NextRequest) => Promise<Response>;
  };
  const res = await mod.GET(new NextRequest(`http://localhost/api/v1/cron/${rota}`));
  return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown> } };
}

const todos = (valor: boolean) =>
  Object.fromEntries(RECURSOS_DO_CRON.map((r) => [r, valor])) as Record<RecursoDoCron, boolean>;
const TODOS_DESLIGADOS = todos(false);

beforeEach(() => {
  h.reqs = [];
  h.consultasDoRetrato = 0;
  h.retratoFalha = false;
  h.avisos = [];
  vi.clearAllMocks();
  esquecerRetrato();
});

afterEach(() => {
  esquecerRetrato();
});

describe("(a) recurso desligado: nenhuma leitura e nenhuma escrita", () => {
  it("cadencia desligada: sai cedo, sem from()/rpc() e sem rodar a rodada", async () => {
    semearRetrato(TODOS_DESLIGADOS);
    const res = await chamar("cadencia-worker");

    expect(res.status).toBe(200);
    expect(res.body.data?.pulado).toBe("recurso_ocioso");
    expect(h.reqs).toEqual([]);
    expect(h.cadencia).not.toHaveBeenCalled();
  });
});

describe("(b) recurso ligado: caracterização — a rota faz exatamente o que fazia", () => {
  it("cadencia ligada: a rodada roda, a resposta é o resultado dela e o efeito é auditado", async () => {
    semearRetrato(todos(true));
    const res = await chamar("cadencia-worker");

    expect(res.status).toBe(200);
    expect(res.body.data?.pulado).toBeUndefined();
    expect(h.cadencia).toHaveBeenCalledOnce();
    // O caminho normal não mudou: o corpo é o `ResultadoDoTick` do worker e a
    // rodada que mexeu em inscrição continua auditando (não é mutação silenciosa).
    expect(res.body.data).toMatchObject({ processadas: 2, emailsEnviados: 1, concluidas: 1 });
    expect(h.auditar).toHaveBeenCalledOnce();
    expect(h.auditar.mock.calls[0]?.[0]).toMatchObject({ action: "cron.cadencia_worker", bypassedRls: true });
  });

  it("cadencia ligada e rodada vazia: responde 200 e não audita (mesmo critério de antes)", async () => {
    h.cadencia.mockResolvedValueOnce({ processadas: 0, emailsEnviados: 0, concluidas: 0, paradas: 0, falhas: 0 });
    semearRetrato(todos(true));
    const res = await chamar("cadencia-worker");

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ processadas: 0 });
    expect(h.auditar).not.toHaveBeenCalled();
  });
});

describe("(c) várias rotas no MESMO tick: uma consulta de estado", () => {
  it("quatro rotas do mesmo segundo dividem o retrato: UMA leitura de pool, zero PostgREST", async () => {
    // Sem semear: é o caminho de produção. O crond dispara tudo no segundo 0, e
    // o retrato só existe depois do primeiro `await` — sem a promessa dividida,
    // cada rota abriria a própria consulta.
    const respostas = await Promise.all([
      chamar("prospecting"),
      chamar("campaign-worker"),
      chamar("historico-import"),
      chamar("cadencia-worker"),
    ]);

    for (const res of respostas) {
      expect(res.status).toBe(200);
      expect(res.body.data?.pulado).toBe("recurso_ocioso");
    }
    expect(h.consultasDoRetrato).toBe(1);
    expect(h.reqs).toEqual([]);
  });
});

describe("(d) cron de NÚCLEO roda independentemente do retrato", () => {
  it("fila de envio (mensagens-agendadas) roda com TODOS os recursos desligados", async () => {
    // Não há portão nesta rota e não pode passar a haver: mensagem agendada é
    // compromisso com o cliente, não recurso opcional. O retrato vazio é o
    // cenário mais hostil — qualquer saída precoce global apareceria aqui.
    semearRetrato(TODOS_DESLIGADOS);
    const res = await chamar("mensagens-agendadas");

    expect(res.status).toBe(200);
    expect(res.body.data?.pulado).toBeUndefined();
    expect(h.reqs.some((r) => r.startsWith("from:mensagens_agendadas"))).toBe(true);
  });

  it("agent-dispatcher responde mesmo com o retrato todo desligado", async () => {
    semearRetrato(TODOS_DESLIGADOS);
    const res = await chamar("agent-dispatcher");

    expect(res.status).toBe(200);
    expect(res.body.data?.pulado).toBeUndefined();
  });
});

describe("(e) falha ao descobrir o estado: não derruba o tick e não inventa trabalho", () => {
  it("leitura quebrada: 200, aviso registrado, nenhuma rota marcada como ociosa e uma tentativa por tick", async () => {
    h.retratoFalha = true;

    const respostas = await Promise.all([chamar("prospecting"), chamar("campaign-worker")]);

    for (const res of respostas) {
      expect(res.status).toBe(200);
      // "Não sei" NÃO vira "desligado": marcar `pulado` aqui apagaria a prospecção
      // de quem tem campanha rodando, e o sintoma só apareceria dias depois.
      expect(res.body.data?.pulado).toBeUndefined();
    }
    expect(h.avisos.some((m) => m.includes("leitura do retrato falhou"))).toBe(true);
    // A falha também fica no retrato: uma tentativa por tick, não uma por rota.
    expect(h.consultasDoRetrato).toBe(1);
  });
});
