/**
 * A VARREDURA DO `event_log` NÃO CARREGA O CORPO DO EVENTO (#3878, item 3).
 *
 * O dreno lia 50 linhas por tique com `payload` e `metadata` — o JSONB gordo de
 * cada evento — para decidir QUAIS reclamar. Quem chega ao handler é uma linha
 * por vez, então o corpo só precisa existir depois do claim.
 *
 * O que este arquivo mede, e por que cada caso existe:
 *
 * 1. **O lote não pede o corpo** e o claim pede. É a asserção literal contra a
 *    string de colunas do PostgREST — antes da mudança ela reprova, porque o
 *    lote trazia `payload, metadata, created_at`.
 * 2. **O handler continua recebendo o corpo** — e do claim, não do lote. Sem
 *    isto, cortar o egress seria trocar bytes por evento perdido: o `payload` é
 *    o que diz qual material derivar, qual conversa rotear.
 * 3. **Fila vazia não faz leitura extra**: um `select`, zero `update`.
 * 4. **Erro não deixa o item preso em `processing`**: o estado final continua
 *    saindo como antes (`pending` com backoff, `dead` no teto).
 * 5. **Claim atômico**: quem perde a corrida não processa e não paga corpo.
 * 6. **Organização parada e ordem da fila intactas**.
 *
 * O dublê registra as colunas pedidas e responde pelo que está na fila — é o
 * SQL que o dreno pede que está sob teste, não o PostgREST.
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
  op: "select" | "update" | "insert";
  colunas?: string;
  dados?: Record<string, unknown>;
  filtros: Array<[string, unknown]>;
  ordem?: string;
  limite?: number;
}

function colunasDe(chamada: Chamada): string[] {
  return (chamada.colunas ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

interface Corpo {
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at?: string;
}

function dublarAdmin(opcoes: {
  /** O que a varredura devolve — linha SEM `payload`/`metadata`, como o select pede. */
  lote?: Array<Record<string, unknown>>;
  /** O corpo que o claim devolve, por id. É o "banco" do teste. */
  corpos?: Record<string, Corpo>;
  orgs?: Array<{ id: string; status: string | null }>;
  /** `true` = outro worker reclamou a linha primeiro: o claim volta vazio. */
  claimPerdido?: boolean;
}) {
  const chamadas: Chamada[] = [];

  const responder = (registro: Chamada) => {
    if (registro.op === "insert") return { data: null, error: null };
    if (registro.op === "update") {
      const ehClaim = registro.dados?.status === "processing";
      if (!ehClaim) return { data: [{ id: "tocado" }], error: null };
      if (opcoes.claimPerdido) return { data: [], error: null };
      const id = registro.filtros.find(([c]) => c === "id")?.[1] as string;
      const corpo = opcoes.corpos?.[id] ?? { payload: {}, metadata: {} };
      // O claim devolve a linha COMO ELA ESTÁ no banco — inclusive `attempts` e
      // `consumed_by`, que o dreno usa dali e não da leitura do lote.
      const daFila = (opcoes.lote ?? []).find((l) => l.id === id) ?? {};
      return {
        data: [
          {
            id,
            consumed_by: daFila.consumed_by ?? [],
            attempts: daFila.attempts ?? 0,
            payload: corpo.payload,
            metadata: corpo.metadata,
            created_at: corpo.created_at ?? new Date().toISOString(),
          },
        ],
        error: null,
      };
    }
    if (registro.tabela === "organizations") return { data: opcoes.orgs ?? [], error: null };
    const pedePresos = registro.filtros.some(([c, v]) => c === "status" && v === "processing");
    if (pedePresos) return { data: [], error: null };
    return { data: opcoes.lote ?? [], error: null };
  };

  function cadeia(tabela: string) {
    const registro: Chamada = { tabela, op: "select", filtros: [] };
    const self: Record<string, unknown> = {
      select: (cols?: string) => {
        registro.colunas = cols ?? "*";
        // `.select()` depois de `.update()` é o RETURNING do update.
        if (registro.op === "select") chamadas.push(registro);
        return self;
      },
      update: (dados: Record<string, unknown>) => {
        registro.op = "update";
        registro.dados = dados;
        chamadas.push(registro);
        return self;
      },
      insert: () => {
        registro.op = "insert";
        chamadas.push(registro);
        return self;
      },
      eq: (c: string, v: unknown) => {
        registro.filtros.push([c, v]);
        return self;
      },
      neq: () => self,
      lt: () => self,
      or: () => self,
      in: () => self,
      order: (col: string) => {
        registro.ordem = col;
        return self;
      },
      limit: (n: number) => {
        registro.limite = n;
        return self;
      },
      maybeSingle: () => self,
      then: (resolve: (r: unknown) => void) => {
        resolve(responder(registro));
      },
    };
    return self;
  }

  return { admin: { from: (t: string) => cadeia(t) }, chamadas };
}

function varredura(chamadas: Chamada[]): Chamada {
  const achada = chamadas.find(
    (c) =>
      c.tabela === "event_log" &&
      c.op === "select" &&
      c.filtros.some(([campo, valor]) => campo === "status" && valor === "pending"),
  );
  if (!achada) throw new Error("o dreno não varreu a fila");
  return achada;
}

function claims(chamadas: Chamada[]): Chamada[] {
  return chamadas.filter(
    (c) => c.tabela === "event_log" && c.op === "update" && c.dados?.status === "processing",
  );
}

function ultimoUpdateDeEvento(chamadas: Chamada[]): Chamada {
  const updates = chamadas.filter(
    (c) => c.tabela === "event_log" && c.op === "update" && c.dados?.status !== "processing",
  );
  const ultimo = updates[updates.length - 1];
  if (!ultimo) throw new Error("o dreno não fechou o estado do evento");
  return ultimo;
}

const LINHA_DA_FILA = {
  id: "e1",
  organization_id: "org-1",
  event_type: "knowledge_source.updated",
  entity_kind: "ai_knowledge_source",
  entity_id: "ks-1",
  consumed_by: [],
  attempts: 0,
};

const CORPO: Corpo = {
  payload: { source_id: "ks-1", operacao: "reindexar" },
  metadata: { enfileirado_por: "tela" },
};

beforeEach(() => {
  handlers.mockReset();
  dispatch.mockReset();
  handlers.mockReturnValue([{ key: "k", events: ["knowledge_source.updated"] }]);
  dispatch.mockResolvedValue([{ consumer_key: "k", status: "ok" }]);
});

describe("varredura do event_log — o corpo só do item processado (#3878)", () => {
  it("o lote pede colunas mínimas e o claim é quem pede payload/metadata", async () => {
    const { admin, chamadas } = dublarAdmin({ lote: [LINHA_DA_FILA], corpos: { e1: CORPO } });

    await drainEventLog(admin as never);

    const lote = colunasDe(varredura(chamadas));
    expect(lote, "a varredura ainda pede o corpo do evento").not.toContain("payload");
    expect(lote, "a varredura ainda pede o corpo do evento").not.toContain("metadata");
    expect(lote, "a varredura ainda pede created_at de 50 linhas").not.toContain("created_at");
    // O que a decisão do lote precisa continua vindo: sem `organization_id` não
    // há como consultar org parada, sem `consumed_by` não há como respeitar o
    // escopo, sem `attempts` não há backoff.
    for (const coluna of ["id", "organization_id", "event_type", "consumed_by", "attempts"]) {
      expect(lote, `a varredura perdeu ${coluna}`).toContain(coluna);
    }

    const [claim] = claims(chamadas);
    expect(claim, "o dreno não reclamou a linha").toBeDefined();
    const doClaim = colunasDe(claim!);
    for (const coluna of ["payload", "metadata", "created_at", "consumed_by", "attempts"]) {
      expect(doClaim, `o claim não traz ${coluna} — o handler ficaria sem o corpo`).toContain(
        coluna,
      );
    }
  });

  it("o handler recebe o corpo que veio do claim, e não uma casca vazia", async () => {
    const { admin } = dublarAdmin({ lote: [LINHA_DA_FILA], corpos: { e1: CORPO } });

    const resumo = await drainEventLog(admin as never);

    expect(dispatch).toHaveBeenCalledTimes(1);
    const [linha] = dispatch.mock.calls[0]!;
    expect(linha).toMatchObject({
      id: "e1",
      payload: CORPO.payload,
      metadata: CORPO.metadata,
      event_type: "knowledge_source.updated",
    });
    expect(resumo.done).toBe(1);
    expect(resumo.failed).toBe(0);
  });

  it("fila vazia não faz leitura extra: uma varredura, zero claim", async () => {
    const { admin, chamadas } = dublarAdmin({ lote: [], corpos: {} });

    const resumo = await drainEventLog(admin as never);

    expect(resumo.scanned).toBe(0);
    // As duas leituras de sempre: a varredura de presos (janela de 10 min) e a
    // da fila. Nenhuma terceira, nenhum claim — fila vazia não paga corpo.
    const leituras = chamadas.filter((c) => c.tabela === "event_log" && c.op === "select");
    expect(leituras).toHaveLength(2);
    expect(leituras.some((c) => !c.colunas)).toBe(false);
    expect(claims(chamadas)).toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("erro no item não deixa preso em processing: volta a pending com backoff", async () => {
    dispatch.mockResolvedValue([{ consumer_key: "k", status: "error", detail: "boom" }]);
    const { admin, chamadas } = dublarAdmin({ lote: [LINHA_DA_FILA], corpos: { e1: CORPO } });

    await drainEventLog(admin as never);

    const fim = ultimoUpdateDeEvento(chamadas);
    expect(fim.dados?.status).toBe("pending");
    expect(fim.dados?.attempts).toBe(1);
    expect(fim.dados?.next_attempt_at, "sem backoff o evento volta no próximo tique").toBeTruthy();
  });

  it("no teto de tentativas, o erro continua matando o evento como antes", async () => {
    dispatch.mockResolvedValue([{ consumer_key: "k", status: "error", detail: "boom" }]);
    const { admin, chamadas } = dublarAdmin({
      lote: [{ ...LINHA_DA_FILA, attempts: 4 }],
      corpos: { e1: CORPO },
    });

    await drainEventLog(admin as never);

    const fim = ultimoUpdateDeEvento(chamadas);
    expect(fim.dados?.status).toBe("dead");
    expect(fim.dados?.attempts).toBe(5);
  });

  it("quem perde o claim não processa e não recebe corpo", async () => {
    const { admin, chamadas } = dublarAdmin({
      lote: [LINHA_DA_FILA],
      corpos: { e1: CORPO },
      claimPerdido: true,
    });

    const resumo = await drainEventLog(admin as never);

    expect(dispatch).not.toHaveBeenCalled();
    expect(resumo.scanned).toBe(1);
    expect(resumo.done).toBe(0);
    // O claim continua sendo um CAS: só pega quem ainda está `pending`, e é
    // isso que impede dois workers de processarem o mesmo evento.
    const [claim] = claims(chamadas);
    expect(claim!.filtros).toContainEqual(["status", "pending"]);
    // Nada fecha estado: quem perdeu a corrida não toca na linha.
    expect(
      chamadas.filter(
        (c) => c.tabela === "event_log" && c.op === "update" && c.dados?.status !== "processing",
      ),
    ).toHaveLength(0);
  });

  it("organização parada continua chegando ao handler, e o evento fecha", async () => {
    const { admin } = dublarAdmin({
      lote: [LINHA_DA_FILA],
      corpos: { e1: CORPO },
      orgs: [{ id: "org-1", status: "suspensa" }],
    });

    await drainEventLog(admin as never);

    const [, opcoes] = dispatch.mock.calls[0]!;
    expect(opcoes).toMatchObject({ orgParada: true });
  });

  it("a ordem da fila e o limite não mudam", async () => {
    const { admin, chamadas } = dublarAdmin({ lote: [], corpos: {} });

    await drainEventLog(admin as never);

    const lote = varredura(chamadas);
    expect(lote.ordem).toBe("created_at");
    expect(lote.limite).toBe(50);
  });
});
