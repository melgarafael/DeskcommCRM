/**
 * O aviso de entrega do WhatsApp só faz o status andar para a frente (spec 28,
 * fatias 1 e 2).
 *
 * O defeito medido em produção (26/10/2026): avisos antigos reenviados numa
 * reconexão sobrescreviam o status — lida voltava a "entregue", entregue voltava
 * a "enviada" — e um aviso de erro (`ack = -1`) devolvia a mensagem a "enviando",
 * que cinco minutos depois virava o alerta "não chegou ao cliente".
 *
 * Os testes passam pelo ponto de entrada real (`dispatchWahaEvent`, evento
 * `message.ack`) com um banco de dublê que aplica os filtros de verdade: a
 * condição de avanço e os `is null` das horas são lidos do próprio UPDATE, então
 * tirar a linha do conserto deixa o teste vermelho.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { FRASES_DE_FALHA } from "@/lib/channels/frases-de-falha";
import { dispatchWahaEvent, type WahaEnvelope } from "@/lib/waha/ingest";
import { ackToStatus } from "@/lib/types/messaging";

interface Linha {
  id: string;
  organization_id: string;
  external_id: string | null;
  status: string;
  ack?: number | null;
  delivered_at?: string | null;
  read_at?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  updated_at?: string | null;
  conversation_id?: string | null;
  contact_id?: string | null;
  sent_via?: string | null;
  [coluna: string]: unknown;
}

interface Emitido {
  p_event_type: string;
  p_organization_id: string;
  p_payload: { message_id: string; erro: { codigo: string } };
}

const ORG_A = "org-a";
const ORG_B = "org-b";
const EXTERNO = "3EB0AAA";
const T1 = "2026-10-20T10:00:00.000Z";
const T2 = "2026-10-20T10:01:00.000Z";

/**
 * Dublê de `messages` com o mínimo do builder que o ingest usa: `update`,
 * `select`, `eq`, `in`, `is`. A escrita aplica-se às linhas que casam TODOS os
 * filtros no momento do `await` — o que é a semântica do UPDATE condicional.
 */
function banco(linhas: Linha[]) {
  const emitidos: Emitido[] = [];

  class Consulta {
    private readonly filtros: Array<(l: Linha) => boolean> = [];
    private valores: Record<string, unknown> | null = null;

    update(valores: Record<string, unknown>) {
      this.valores = valores;
      return this;
    }
    select(_colunas?: string) {
      return this;
    }
    eq(coluna: string, valor: unknown) {
      this.filtros.push((l) => l[coluna] === valor);
      return this;
    }
    in(coluna: string, valores: unknown[]) {
      this.filtros.push((l) => valores.includes(l[coluna]));
      return this;
    }
    neq(coluna: string, valor: unknown) {
      this.filtros.push((l) => l[coluna] !== valor);
      return this;
    }
    is(coluna: string, valor: null) {
      this.filtros.push((l) => (valor === null ? l[coluna] == null : l[coluna] === valor));
      return this;
    }
    then(ok?: (r: unknown) => unknown, falha?: (e: unknown) => unknown): Promise<unknown> {
      const alvo = linhas.filter((l) => this.filtros.every((f) => f(l)));
      if (this.valores) for (const l of alvo) Object.assign(l, this.valores);
      const resultado = { data: alvo.map((l) => ({ ...l })), error: null };
      return Promise.resolve(resultado).then(ok, falha);
    }
  }

  const admin = {
    from: (tabela: string) => {
      if (tabela !== "messages") throw new Error(`tabela inesperada no dublê: ${tabela}`);
      return new Consulta();
    },
    rpc: async (nome: string, args: Record<string, unknown>) => {
      if (nome === "emit_event") emitidos.push(args as unknown as Emitido);
      return { data: null, error: null };
    },
  };
  return { admin, emitidos };
}

const SESSAO = { id: "sessao-1", organization_id: ORG_A, is_warmup_complete: true, warmup_started_at: null };

function aviso(ack: number, id = EXTERNO): WahaEnvelope {
  return { event: "message.ack", session: "default", payload: { id, ack } } as WahaEnvelope;
}

async function chegarAviso(
  admin: ReturnType<typeof banco>["admin"],
  ack: number,
  sessao: typeof SESSAO = SESSAO,
) {
  await dispatchWahaEvent(admin as never, sessao as never, aviso(ack), "req-ack");
}

function linha(extra: Partial<Linha> = {}): Linha {
  return {
    id: "m1",
    organization_id: ORG_A,
    external_id: EXTERNO,
    status: "sent",
    ack: 1,
    delivered_at: null,
    read_at: null,
    ...extra,
  };
}

describe("aviso positivo nunca faz o status voltar (fatia 1)", () => {
  it("lida + aviso 2 atrasado: continua lida, e as duas horas não mudam", async () => {
    const filas = [linha({ status: "read", ack: 3, delivered_at: T1, read_at: T2 })];
    const { admin } = banco(filas);
    await chegarAviso(admin, 2);
    expect(filas[0]).toMatchObject({ status: "read", ack: 3, delivered_at: T1, read_at: T2 });
  });

  it("entregue + aviso 1 atrasado: continua entregue", async () => {
    const filas = [linha({ status: "delivered", ack: 2, delivered_at: T1 })];
    const { admin } = banco(filas);
    await chegarAviso(admin, 1);
    expect(filas[0]).toMatchObject({ status: "delivered", ack: 2, delivered_at: T1 });
  });

  it("entregue + aviso 2 repetido: a hora de entrega é a primeira, não a do reenvio", async () => {
    const filas = [linha({ status: "delivered", ack: 2, delivered_at: T1 })];
    const { admin } = banco(filas);
    await chegarAviso(admin, 2);
    expect(filas[0]?.delivered_at).toBe(T1);
  });

  it("enviada + aviso 1: anda para enviada (o aviso de servidor), com ack gravado", async () => {
    const filas = [linha({ status: "sending", ack: null })];
    const { admin } = banco(filas);
    await chegarAviso(admin, 1);
    expect(filas[0]).toMatchObject({ status: "sent", ack: 1 });
  });

  it("aviso 0 (pendente) não mexe em nada", async () => {
    const filas = [linha({ status: "sent", ack: 1 })];
    const { admin } = banco(filas);
    await chegarAviso(admin, 0);
    expect(filas[0]).toMatchObject({ status: "sent", ack: 1 });
  });

  it("lida sem entregue antes: as duas horas são gravadas com o MESMO instante", async () => {
    const filas = [linha({ status: "sending", ack: null, delivered_at: null, read_at: null })];
    const { admin } = banco(filas);
    await chegarAviso(admin, 3);
    expect(filas[0]?.status).toBe("read");
    expect(filas[0]?.delivered_at).not.toBeNull();
    expect(filas[0]?.delivered_at).toBe(filas[0]?.read_at);
  });

  it("entregue sem hora de entrega (legado) e aviso 2: a hora entra uma vez", async () => {
    const filas = [linha({ status: "sent", ack: 1, delivered_at: null })];
    const { admin } = banco(filas);
    await chegarAviso(admin, 2);
    expect(filas[0]?.status).toBe("delivered");
    expect(typeof filas[0]?.delivered_at).toBe("string");
  });
});

describe("entrega confirmada recupera uma falha anterior", () => {
  // A main já recuperava failed quando o aparelho confirmava a entrega. A
  // versão inicial desta fatia congelava o erro oposto: manter failed com ACK
  // 2/3 permite oferecer reenvio de algo que chegou. ACK 0/1 não confirma isso.
  it.each(["send_timeout", "ack_error"])("%s + ack 2 e 3 → entregue e lida", async (errorCode) => {
    const filas = [linha({ status: "failed", ack: -1, error_code: errorCode })];
    const { admin } = banco(filas);
    await chegarAviso(admin, 2);
    expect(filas[0]).toMatchObject({ status: "delivered", ack: 2, read_at: null });
    expect(filas[0]?.delivered_at).toEqual(expect.any(String));
    const entregueEm = filas[0]?.delivered_at;
    await chegarAviso(admin, 3);
    expect(filas[0]).toMatchObject({ status: "read", ack: 3, delivered_at: entregueEm });
    expect(filas[0]?.read_at).toEqual(expect.any(String));
  });

  it.each([0, 1])("failed + ack %s não prova entrega nem recupera o status", async (ack) => {
    const filas = [linha({ status: "failed", ack: -1, error_code: "send_timeout" })];
    const { admin } = banco(filas);
    await chegarAviso(admin, ack);
    expect(filas[0]).toMatchObject({ status: "failed", delivered_at: null, read_at: null });
  });

  it("erro, confirmação de leitura e erro atrasado: a prova do aparelho prevalece nas duas ordens", async () => {
    const filas = [linha()];
    const { admin, emitidos } = banco(filas);
    await chegarAviso(admin, -1);
    expect(filas[0]?.status).toBe("failed");
    expect(emitidos).toHaveLength(1);

    await chegarAviso(admin, 3);
    expect(filas[0]).toMatchObject({ status: "read", ack: 3 });
    const entregueEm = filas[0]?.delivered_at;
    const lidaEm = filas[0]?.read_at;
    expect(entregueEm).toEqual(expect.any(String));
    expect(lidaEm).toEqual(expect.any(String));

    await chegarAviso(admin, -1);
    expect(filas[0]).toMatchObject({ status: "read", ack: 3, delivered_at: entregueEm, read_at: lidaEm });
    expect(emitidos).toHaveLength(1);
  });
});

describe("aviso de erro, ack = -1 (fatia 2)", () => {
  it("enviada + ack -1: vira failed/ack_error com a frase, e emite message.failed", async () => {
    const filas = [linha({ status: "sent", ack: 1, conversation_id: "c1", contact_id: "k1", sent_via: "ai" })];
    const { admin, emitidos } = banco(filas);
    await chegarAviso(admin, -1);
    expect(filas[0]).toMatchObject({
      status: "failed",
      ack: -1,
      error_code: "ack_error",
      error_message: FRASES_DE_FALHA.ack_error,
    });
    expect(emitidos).toHaveLength(1);
    expect(emitidos[0]).toMatchObject({
      p_event_type: "message.failed",
      p_organization_id: ORG_A,
      p_payload: { message_id: "m1", erro: { codigo: "ack_error" } },
    });
  });

  it("enviando + ack -1: nunca volta para sending", async () => {
    const filas = [linha({ status: "sending", ack: null })];
    const { admin } = banco(filas);
    await chegarAviso(admin, -1);
    expect(filas[0]?.status).toBe("failed");
    expect(filas[0]?.status).not.toBe("sending");
  });

  it("entregue + ack -1: continua entregue e não emite message.failed", async () => {
    const filas = [linha({ status: "delivered", ack: 2, delivered_at: T1 })];
    const { admin, emitidos } = banco(filas);
    await chegarAviso(admin, -1);
    expect(filas[0]).toMatchObject({ status: "delivered", ack: 2, delivered_at: T1 });
    expect(emitidos).toHaveLength(0);
  });

  it("lida + ack -1: continua lida e não emite nada", async () => {
    const filas = [linha({ status: "read", ack: 3, delivered_at: T1, read_at: T2 })];
    const { admin, emitidos } = banco(filas);
    await chegarAviso(admin, -1);
    expect(filas[0]?.status).toBe("read");
    expect(emitidos).toHaveLength(0);
  });

  it("falha já registrada (send_timeout) + ack -1: não é reescrita nem emite de novo", async () => {
    const filas = [linha({ status: "failed", ack: null, error_code: "send_timeout" })];
    const { admin, emitidos } = banco(filas);
    await chegarAviso(admin, -1);
    expect(filas[0]).toMatchObject({ status: "failed", error_code: "send_timeout" });
    expect(emitidos).toHaveLength(0);
  });
});

describe("ackToStatus (fatia 1)", () => {
  it("-1 e 0 não mudam o status: nada de 'sending' de reserva", () => {
    expect(ackToStatus(-1)).toBeNull();
    expect(ackToStatus(-7)).toBeNull();
    expect(ackToStatus(0)).toBeNull();
    expect(ackToStatus(null)).toBeNull();
    expect(ackToStatus(undefined)).toBeNull();
  });

  it("1 servidor, 2 aparelho, 3 e 4 lido/ouvido", () => {
    expect(ackToStatus(1)).toBe("sent");
    expect(ackToStatus(2)).toBe("delivered");
    expect(ackToStatus(3)).toBe("read");
    expect(ackToStatus(4)).toBe("read");
  });
});

describe("isolamento por organização (fatia 1)", () => {
  it("o mesmo external_id em duas organizações: o aviso da A não toca a linha da B", async () => {
    const filas = [
      linha({ id: "da-a", organization_id: ORG_A, status: "sent", ack: 1 }),
      linha({ id: "da-b", organization_id: ORG_B, status: "sent", ack: 1 }),
    ];
    const { admin } = banco(filas);
    await chegarAviso(admin, 2);
    expect(filas.find((f) => f.id === "da-a")).toMatchObject({ status: "delivered" });
    expect(filas.find((f) => f.id === "da-b")).toMatchObject({ status: "sent", ack: 1, delivered_at: null });
  });

  it("o ack -1 da organização A não marca a mensagem da B como falha", async () => {
    const filas = [
      linha({ id: "da-a", organization_id: ORG_A, status: "sent", ack: 1 }),
      linha({ id: "da-b", organization_id: ORG_B, status: "sent", ack: 1 }),
    ];
    const { admin, emitidos } = banco(filas);
    await chegarAviso(admin, -1);
    expect(filas.find((f) => f.id === "da-a")?.status).toBe("failed");
    expect(filas.find((f) => f.id === "da-b")?.status).toBe("sent");
    expect(emitidos.map((e) => e.p_payload.message_id)).toEqual(["da-a"]);
  });
});
