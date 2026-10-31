import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import { esquecerLeituraDosRecursos, recursoLigado } from "@/lib/cron/recursos-ligados";

import { enrollFollowupFlow } from "./enroll";
import { flowGraphSchema } from "./graph-schema";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const POINTER = "33333333-3333-4333-8333-333333333333";
const CONTACT = "44444444-4444-4444-8444-444444444444";
const VERSION = "55555555-5555-4555-8555-555555555555";

const GRAPH = flowGraphSchema.parse({
  nodes: [
    { id: "t1", type: "trigger", label: "t1", position: { x: 0, y: 0 }, config: {} },
    { id: "e1", type: "end", label: "e1", position: { x: 0, y: 0 }, config: { outcome: "exhausted" } },
  ],
  edges: [{ id: "edge1", source: "t1", target: "e1", priority: 0, condition: { type: "always" } }],
});

type Row = Record<string, unknown>;

function fakeDb(pointer: Row) {
  const tables: Record<string, Row[]> = {
    followup_flow_pointers: [pointer],
    contacts: [{ id: CONTACT, organization_id: ORG }],
    followup_flow_versions: [{ id: VERSION, organization_id: ORG, graph: GRAPH }],
    followup_enrollments: [],
    ai_agents: [],
    ai_agent_versions: [],
  };
  return {
    rpc: async () => ({ data: { organization_id: ORG, contact_id: CONTACT, conversation_id: "conv-1", service_revision: 1, demanda_id: null, demanda_revision: null, status: "open", demanda_fechada_em: null }, error: null }),
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let mode: "select" | "insert" = "select";
      let payload: Row | undefined;
      const b = {
        select() {
          return b;
        },
        insert(obj: Row) {
          mode = "insert";
          payload = obj;
          expect(obj).not.toHaveProperty("next_eval_at");
          return b;
        },
        eq(col: string, val: unknown) {
          filters.push([col, val]);
          return b;
        },
        async maybeSingle() {
          const list = tables[table]!.filter((row) => filters.every(([k, v]) => row[k] === v));
          return { data: list[0] ?? null, error: null };
        },
        async single() {
          if (mode === "insert") {
            const row = { id: randomUUID(), ...payload };
            tables[table]!.push(row);
            return { data: row, error: null };
          }
          const list = tables[table]!.filter((row) => filters.every(([k, v]) => row[k] === v));
          return { data: list[0] ?? null, error: null };
        },
      };
      return b;
    },
  };
}

describe("enrollFollowupFlow", () => {
  it("inscreve contato em fluxo ativo publicado", async () => {
    const db = fakeDb({
      id: POINTER,
      organization_id: ORG,
      status: "active",
      active_version_id: VERSION,
    });
    const result = await enrollFollowupFlow(db as never, {
      organizationId: ORG,
      pointerId: POINTER,
      contactId: CONTACT,
      actorUserId: null,
      requestId: "r1",
    });
    expect(result.ok).toBe(true);
  });

  it("recusa fluxo que não está publicado", async () => {
    const db = fakeDb({
      id: POINTER,
      organization_id: ORG,
      status: "draft",
      active_version_id: null,
    });
    const result = await enrollFollowupFlow(db as never, {
      organizationId: ORG,
      pointerId: POINTER,
      contactId: CONTACT,
      actorUserId: null,
      requestId: "r1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("flow_not_active");
  });

  it("inscrição invalida a leitura dos recursos do cron — quem inscreve espera o fluxo começar agora (#3694)", async () => {
    // O cron do follow-up sai cedo quando não há inscrição vencida, e a leitura
    // vale 45 s. Se a inscrição não avisasse, o contato recém-inscrito ficaria
    // parado no nó trigger até a janela vencer — até 45 s de espera que o
    // operador vê como "inscrevi e nada aconteceu".
    esquecerLeituraDosRecursos();
    let leituras = 0;
    const db = {
      rpc: () => {
        leituras += 1;
        return Promise.resolve({ data: {}, error: null });
      },
    } as never;

    // Primeira leitura: instalação sem inscrição vencida.
    expect(await recursoLigado(db, "followup", 0)).toBe(true); // corpo vazio = ligado (fail-open)
    expect(leituras).toBe(1);

    const supabase = fakeDb({
      id: POINTER,
      organization_id: ORG,
      status: "active",
      active_version_id: VERSION,
    });
    const result = await enrollFollowupFlow(supabase as never, {
      organizationId: ORG,
      pointerId: POINTER,
      contactId: CONTACT,
      actorUserId: null,
      requestId: "r1",
    });
    expect(result.ok).toBe(true);

    // Mesma janela de 45 s: sem a invalidação, a leitura seria servida pelo
    // retrato de antes da inscrição (uma ida ao banco, não duas).
    await recursoLigado(db, "followup", 1);
    expect(leituras).toBe(2);
  });

  it("recusa roteiro de atendimento — ele começa na conversa, não por inscrição", async () => {
    const db = fakeDb({
      id: POINTER,
      organization_id: ORG,
      status: "active",
      active_version_id: VERSION,
      surface: "atendimento",
    });
    const result = await enrollFollowupFlow(db as never, {
      organizationId: ORG,
      pointerId: POINTER,
      contactId: CONTACT,
      actorUserId: null,
      requestId: "r1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("flow_not_enrollable");
  });
});
