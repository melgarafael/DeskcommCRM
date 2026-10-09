/**
 * O DRENO ESCOPADO DO WEBHOOK NÃO É DONO DO EVENTO.
 *
 * Com worker drenando o `event_log`, o webhook de mensagem roda só os gatilhos
 * que inscrevem o contato num fluxo (`lib/dev/kick-local-pipeline.ts`) — e só
 * da organização da mensagem. O resto do evento (sentimento, push, automações,
 * métrica de campanha) é do laço do worker. Três coisas precisam valer para
 * isso não perder trabalho:
 *
 *   1. a consulta filtra a organização e só os tipos dos handlers escopados;
 *   2. o evento volta a `pending` com o `consumed_by` acrescido enquanto falta
 *      handler — marcar `done` apagaria os outros consumidores;
 *   3. falha de um handler escopado NÃO conta tentativa nem empurra backoff: o
 *      worker roda o que faltou no próximo tique, e é ele quem conta.
 *
 * E a varredura de órfãos em `processing` (de TODAS as organizações) não roda
 * dentro da requisição.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: {} }));

const handlers = vi.fn();
const dispatch = vi.fn();
vi.mock("@/lib/event-log/dispatcher", () => ({
  getRegisteredHandlers: () => handlers(),
  dispatchEvent: (row: unknown, opts: unknown) => dispatch(row, opts),
}));

import { drainEventLog } from "@/lib/event-log/drain";

interface Chamada {
  tabela: string;
  op: string;
  payload?: Record<string, unknown>;
  filtros: Array<[string, string, unknown]>;
}

function dublarAdmin(linhas: Array<Record<string, unknown>>) {
  const chamadas: Chamada[] = [];
  function cadeia(tabela: string) {
    const registro: Chamada = { tabela, op: "select", filtros: [] };
    const self: Record<string, unknown> = {
      select: () => {
        if (registro.op === "select") chamadas.push(registro);
        return self;
      },
      update: (payload: Record<string, unknown>) => {
        registro.op = "update";
        registro.payload = payload;
        chamadas.push(registro);
        return self;
      },
      eq: (c: string, v: unknown) => {
        registro.filtros.push(["eq", c, v]);
        return self;
      },
      lt: (c: string, v: unknown) => {
        registro.filtros.push(["lt", c, v]);
        return self;
      },
      or: (v: unknown) => {
        registro.filtros.push(["or", "", v]);
        return self;
      },
      in: (c: string, v: unknown) => {
        registro.filtros.push(["in", c, v]);
        return self;
      },
      order: (c: string, o: unknown) => {
        registro.filtros.push(["order", c, o]);
        return self;
      },
      limit: () => self,
      then: (resolve: (r: unknown) => void) => {
        if (registro.op === "update") return resolve({ data: [{ id: "e1" }], error: null });
        if (tabela === "organizations") {
          return resolve({ data: [{ id: "org-1", status: "active" }], error: null });
        }
        resolve({ data: linhas, error: null });
      },
    };
    return self;
  }
  return { admin: { from: (t: string) => cadeia(t) }, chamadas };
}

const LINHA = {
  id: "e1",
  organization_id: "org-1",
  event_type: "message.received",
  entity_kind: "message",
  entity_id: "msg-1",
  payload: { contact_id: "contato-1" },
  metadata: {},
  consumed_by: [],
  attempts: 0,
  created_at: new Date().toISOString(),
};

const ESCOPO = { organizationId: "org-1", handlers: ["followup-gatilho-retorno.v1"] };

function escritaFinal(chamadas: Chamada[]) {
  return chamadas.filter(
    (c) => c.tabela === "event_log" && c.op === "update" && c.payload?.status !== "processing",
  );
}

beforeEach(() => {
  handlers.mockReset();
  dispatch.mockReset();
  handlers.mockReturnValue([
    { key: "followup-gatilho-retorno.v1", events: ["message.received"] },
    { key: "ai-sentiment.v1", events: ["message.received"] },
    { key: "rag-indexer.v1", events: ["knowledge_source.updated"] },
  ]);
});

describe("drainEventLog com escopo", () => {
  it("consulta só a organização e os tipos dos handlers escopados, sem varrer órfãos", async () => {
    dispatch.mockResolvedValue([{ consumer_key: "followup-gatilho-retorno.v1", status: "ok" }]);
    const { admin, chamadas } = dublarAdmin([LINHA]);

    await drainEventLog(admin as never, { escopo: ESCOPO });

    const selects = chamadas.filter((c) => c.tabela === "event_log" && c.op === "select");
    expect(
      selects.some((c) => c.filtros.some(([t, col, v]) => t === "eq" && col === "status" && v === "processing")),
      "o dreno da requisição varreu órfãos de todas as organizações",
    ).toBe(false);
    const [busca] = selects;
    expect(busca!.filtros).toContainEqual(["eq", "organization_id", "org-1"]);
    expect(busca!.filtros).toContainEqual(["in", "event_type", ["message.received"]]);
    expect(dispatch.mock.calls[0]![1]).toMatchObject({ soHandlers: ESCOPO.handlers });
  });

  it("devolve o evento a `pending` com o consumed_by acrescido enquanto falta handler", async () => {
    dispatch.mockResolvedValue([{ consumer_key: "followup-gatilho-retorno.v1", status: "ok" }]);
    const { admin, chamadas } = dublarAdmin([LINHA]);

    const resumo = await drainEventLog(admin as never, { escopo: ESCOPO });

    const [final] = escritaFinal(chamadas);
    expect(final!.payload).toMatchObject({
      status: "pending",
      consumed_by: ["followup-gatilho-retorno.v1"],
    });
    expect(resumo.done).toBe(0);
    expect(resumo.retried, "concluir a parte do escopo não é tentativa de novo").toBe(0);
    expect(resumo.deixados_ao_worker).toBe(1);
  });

  it("lê do mais novo: a mensagem desta requisição não fica atrás do acúmulo da organização", async () => {
    dispatch.mockResolvedValue([]);
    const { admin, chamadas } = dublarAdmin([]);

    await drainEventLog(admin as never, { escopo: ESCOPO });

    const [busca] = chamadas.filter((c) => c.tabela === "event_log" && c.op === "select");
    expect(busca!.filtros).toContainEqual(["order", "created_at", { ascending: false }]);
  });

  it("não reclama a linha em que o escopo já fez a sua parte", async () => {
    dispatch.mockResolvedValue([{ consumer_key: "followup-gatilho-retorno.v1", status: "ok" }]);
    const antigas = Array.from({ length: 10 }, (_, i) => ({
      ...LINHA,
      id: `antiga-${i}`,
      consumed_by: ["followup-gatilho-retorno.v1"],
    }));
    const { admin, chamadas } = dublarAdmin([...antigas, { ...LINHA, id: "atual" }]);

    const resumo = await drainEventLog(admin as never, { escopo: ESCOPO });

    const reclamadas = chamadas
      .filter((c) => c.tabela === "event_log" && c.op === "update" && c.payload?.status === "processing")
      .map((c) => c.filtros.find(([, col]) => col === "id")?.[2]);
    expect(reclamadas).toEqual(["atual"]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(resumo.retried).toBe(0);
  });

  it("marca `done` quando o escopado era o último que faltava", async () => {
    dispatch.mockResolvedValue([{ consumer_key: "followup-gatilho-retorno.v1", status: "ok" }]);
    const { admin, chamadas } = dublarAdmin([{ ...LINHA, consumed_by: ["ai-sentiment.v1"] }]);

    await drainEventLog(admin as never, { escopo: ESCOPO });

    expect(escritaFinal(chamadas)[0]!.payload?.status).toBe("done");
  });

  it("falha do handler escopado não conta tentativa nem adia o evento para o worker", async () => {
    dispatch.mockResolvedValue([
      { consumer_key: "followup-gatilho-retorno.v1", status: "error", detail: "timeout" },
    ]);
    const { admin, chamadas } = dublarAdmin([LINHA]);

    await drainEventLog(admin as never, { escopo: ESCOPO });

    const [final] = escritaFinal(chamadas);
    expect(final!.payload?.status).toBe("pending");
    expect(final!.payload).not.toHaveProperty("attempts");
    expect(final!.payload).not.toHaveProperty("next_attempt_at");
    expect(final!.payload?.consumed_by).toEqual([]);
  });

  it("sem escopo, o dreno continua global: varre órfãos e não filtra organização", async () => {
    dispatch.mockResolvedValue([]);
    const { admin, chamadas } = dublarAdmin([]);

    await drainEventLog(admin as never);

    const selects = chamadas.filter((c) => c.tabela === "event_log" && c.op === "select");
    expect(
      selects.some((c) => c.filtros.some(([t, col, v]) => t === "eq" && col === "status" && v === "processing")),
    ).toBe(true);
    expect(selects.some((c) => c.filtros.some(([, col]) => col === "organization_id"))).toBe(false);
  });
});

describe("dispatchEvent com soHandlers", () => {
  it("roda só os handlers pedidos; os outros do mesmo evento ficam intocados", async () => {
    const real = await vi.importActual<typeof import("@/lib/event-log/dispatcher")>(
      "@/lib/event-log/dispatcher",
    );
    const rodou: string[] = [];
    for (const key of ["escopado.v1", "outro.v1"]) {
      real.registerHandler({
        key,
        naOrgParada: "roda",
        events: ["teste.so_handlers"],
        async handle() {
          rodou.push(key);
          return { consumer_key: key, status: "ok" };
        },
      });
    }

    const resultados = await real.dispatchEvent(
      { ...LINHA, event_type: "teste.so_handlers" } as never,
      { orgParada: false, soHandlers: ["escopado.v1"] },
    );

    expect(rodou).toEqual(["escopado.v1"]);
    expect(resultados.map((r) => r.consumer_key)).toEqual(["escopado.v1"]);
  });
});
