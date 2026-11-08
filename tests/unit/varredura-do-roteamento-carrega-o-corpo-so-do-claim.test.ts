/**
 * A VARREDURA DO ROTEAMENTO NÃO CARREGA O CORPO DO EVENTO (#3878, item 3).
 *
 * `runRoutingWorker` puxa até 100 eventos `conversation.routing_requested` por
 * tique com `payload` e `metadata` só para decidir QUAIS reclamar — e o
 * `payload` é o que diz QUAL conversa rotear. O corpo passa a vir do claim, que
 * já existia (`update ... select`), e portanto de uma linha por evento
 * processado, não de 100 por tique.
 *
 * O caso que dá o desfecho é o discriminante: com `payload` o evento cai em
 * `skipped_manual`; sem ele, `skipped_invalid_payload`. Se o corte tivesse
 * deixado o handler sem corpo, o teste veria o segundo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: {} }));

const admin = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin() }));

import { runRoutingWorker } from "@/lib/routing/worker";

interface Chamada {
  tabela: string;
  op: "select" | "update";
  colunas?: string;
  dados?: Record<string, unknown>;
  filtros: Array<[string, unknown]>;
  limite?: number;
}

function colunasDe(chamada: Chamada): string[] {
  return (chamada.colunas ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

const CONVERSA = "11111111-1111-4111-8111-111111111111";

function dublarAdmin(opcoes: {
  /** A fila como a varredura a vê: SEM `payload`/`metadata`. */
  lote?: Array<Record<string, unknown>>;
  /** O corpo que o claim devolve. */
  corpos?: Record<string, { payload: Record<string, unknown>; metadata: Record<string, unknown> }>;
  /** `true` = outro worker reclamou a linha primeiro. */
  claimPerdido?: boolean;
}) {
  const chamadas: Chamada[] = [];

  function responder(registro: Chamada) {
    if (registro.op === "update") {
      const ehClaim = registro.dados?.status === "processing";
      if (!ehClaim) return { data: null, error: null };
      if (opcoes.claimPerdido) return { data: null, error: null };
      const id = registro.filtros.find(([c]) => c === "id")?.[1] as string;
      const corpo = opcoes.corpos?.[id] ?? { payload: {}, metadata: {} };
      return {
        data: {
          id,
          updated_at: new Date().toISOString(),
          payload: corpo.payload,
          metadata: corpo.metadata,
        },
        error: null,
      };
    }
    if (registro.tabela === "event_log") {
      const pedePresos = registro.filtros.some(([c, v]) => c === "status" && v === "processing");
      if (pedePresos) return { data: [], error: null };
      return { data: opcoes.lote ?? [], error: null };
    }
    if (registro.tabela === "conversations") {
      return {
        data: {
          id: CONVERSA,
          organization_id: "org-1",
          contact_id: "contato-1",
          channel_session_id: null,
          assigned_to_user_id: null,
          status: "open",
          metadata: {},
          last_inbound_at: null,
          sector_id: null,
        },
        error: null,
      };
    }
    if (registro.tabela === "organizations") return { data: { settings: {} }, error: null };
    // contacts (contato pessoal/fornecedor) e agent_cases (caso da conversa).
    return { data: null, error: null };
  }

  function cadeia(tabela: string) {
    const registro: Chamada = { tabela, op: "select", filtros: [] };
    const self: Record<string, unknown> = {
      select: (cols?: string) => {
        registro.colunas = cols ?? "*";
        if (registro.op === "select") chamadas.push(registro);
        return self;
      },
      update: (dados: Record<string, unknown>) => {
        registro.op = "update";
        registro.dados = dados;
        chamadas.push(registro);
        return self;
      },
      eq: (c: string, v: unknown) => {
        registro.filtros.push([c, v]);
        return self;
      },
      lte: () => self,
      or: () => self,
      in: () => self,
      order: () => self,
      limit: (n: number) => {
        registro.limite = n;
        return self;
      },
      maybeSingle: () => self,
      single: () => self,
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
  if (!achada) throw new Error("o worker não varreu a fila de roteamento");
  return achada;
}

function claims(chamadas: Chamada[]): Chamada[] {
  return chamadas.filter(
    (c) => c.tabela === "event_log" && c.op === "update" && c.dados?.status === "processing",
  );
}

function fechamento(chamadas: Chamada[]): Chamada {
  const updates = chamadas.filter(
    (c) => c.tabela === "event_log" && c.op === "update" && c.dados?.status !== "processing",
  );
  const ultimo = updates[updates.length - 1];
  if (!ultimo) throw new Error("o worker não fechou o estado do evento");
  return ultimo;
}

const NA_FILA = {
  id: "e1",
  organization_id: "org-1",
  consumed_by: [],
  attempts: 0,
};

const CORPO = {
  payload: { organization_id: "org-1", conversation_id: CONVERSA },
  metadata: { enfileirado_por: "trigger" },
};

beforeEach(() => {
  admin.mockReset();
});

describe("varredura do roteamento — o corpo só do claim (#3878)", () => {
  it("o lote pede colunas mínimas e o claim é quem pede payload/metadata", async () => {
    const duble = dublarAdmin({ lote: [NA_FILA], corpos: { e1: CORPO } });
    admin.mockReturnValue(duble.admin);

    await runRoutingWorker({ now: new Date() });

    const lote = colunasDe(varredura(duble.chamadas));
    expect(lote, "a varredura ainda pede o corpo do evento").not.toContain("payload");
    expect(lote, "a varredura ainda pede o corpo do evento").not.toContain("metadata");
    for (const coluna of ["id", "organization_id", "consumed_by", "attempts"]) {
      expect(lote, `a varredura perdeu ${coluna}`).toContain(coluna);
    }

    const [claim] = claims(duble.chamadas);
    expect(claim, "o worker não reclamou a linha").toBeDefined();
    const doClaim = colunasDe(claim!);
    for (const coluna of ["payload", "metadata"]) {
      expect(
        doClaim,
        `o claim não traz ${coluna} — o worker ficaria sem saber qual conversa rotear`,
      ).toContain(coluna);
    }
  });

  it("com o corpo vindo do claim, o evento roteia como antes", async () => {
    const duble = dublarAdmin({ lote: [NA_FILA], corpos: { e1: CORPO } });
    admin.mockReturnValue(duble.admin);

    const resumo = await runRoutingWorker({ now: new Date() });

    // `manual` (a org sem `settings.routing`) ⇒ skip manual — e só se chega ali
    // com `payload.conversation_id`; sem corpo o desfecho seria
    // `skipped_invalid_payload`.
    expect(resumo.outcomes.skipped_manual).toBe(1);
    expect(resumo.outcomes.skipped_invalid_payload).toBe(0);
    expect(duble.chamadas.some((c) => c.tabela === "conversations")).toBe(true);

    const fim = fechamento(duble.chamadas);
    expect(fim.dados?.status).toBe("done");
    // O `metadata` do evento é o do claim, mesclado com o desfecho: o que o
    // trigger escreveu não se perde no caminho.
    expect(fim.dados?.metadata).toMatchObject({
      enfileirado_por: "trigger",
      outcome: "skipped_manual",
    });
  });

  it("quem perde o claim não processa e não lê a conversa", async () => {
    const duble = dublarAdmin({ lote: [NA_FILA], corpos: { e1: CORPO }, claimPerdido: true });
    admin.mockReturnValue(duble.admin);

    const resumo = await runRoutingWorker({ now: new Date() });

    expect(resumo.batch_size).toBe(0);
    expect(duble.chamadas.some((c) => c.tabela === "conversations")).toBe(false);
    expect(
      duble.chamadas.filter(
        (c) => c.tabela === "event_log" && c.op === "update" && c.dados?.status !== "processing",
      ),
    ).toHaveLength(0);
  });

  it("o claim continua atômico: só pega `pending`, e da organização do evento", async () => {
    const duble = dublarAdmin({ lote: [NA_FILA], corpos: { e1: CORPO } });
    admin.mockReturnValue(duble.admin);

    await runRoutingWorker({ now: new Date() });

    const [claim] = claims(duble.chamadas);
    expect(claim!.filtros).toContainEqual(["status", "pending"]);
    expect(claim!.filtros).toContainEqual(["id", "e1"]);
    expect(claim!.filtros).toContainEqual(["organization_id", "org-1"]);
  });

  it("fila vazia não faz claim nem leitura de conversa", async () => {
    const duble = dublarAdmin({ lote: [], corpos: {} });
    admin.mockReturnValue(duble.admin);

    const resumo = await runRoutingWorker({ now: new Date() });

    expect(resumo.batch_size).toBe(0);
    expect(claims(duble.chamadas)).toHaveLength(0);
    expect(duble.chamadas.filter((c) => c.tabela !== "event_log")).toHaveLength(0);
  });

  it("evento já consumido por este worker não é reclamado nem paga corpo", async () => {
    const duble = dublarAdmin({
      lote: [{ ...NA_FILA, consumed_by: ["worker.routing.v1"] }],
      corpos: { e1: CORPO },
    });
    admin.mockReturnValue(duble.admin);

    const resumo = await runRoutingWorker({ now: new Date() });

    expect(resumo.batch_size).toBe(0);
    expect(claims(duble.chamadas)).toHaveLength(0);
  });
});
