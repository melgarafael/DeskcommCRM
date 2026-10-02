import { describe, expect, it } from "vitest";

import { createSupabaseSilenceSweepDb } from "./silence-sweep";

/**
 * `loadContatosComInscricaoViva` — a query REAL contra o PostgREST (produção),
 * não o fake em memória (`silence-sweep-inscricao-viva.test.ts`) nem a cópia em
 * SQL cru do invariante (`tests/invariants/followup-silence-sweep.test.ts`).
 * Mesmo desenho de `silence-sweep-cooldown-query.test.ts`: o fake grava a
 * cadeia de chamadas em vez de filtrar (filtrar é trabalho do Postgres).
 *
 * O que se prova: a pergunta é a do índice único
 * `idx_followup_enrollments_one_live` — organização + contato, status VIVOS,
 * QUALQUER fluxo (sem filtro de pointer) — e a lista de contatos vai em lotes,
 * porque o `in(...)` viaja na URL.
 */
function fakeAdmin(respostas: Array<Array<{ contact_id: string }>>) {
  const consultas: Array<Array<{ metodo: string; args: unknown[] }>> = [];
  const from = (tabela: string) => {
    const chamadas: Array<{ metodo: string; args: unknown[] }> = [{ metodo: "from", args: [tabela] }];
    const rows = respostas[consultas.length] ?? [];
    consultas.push(chamadas);
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            return (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: null });
          }
          return (...args: unknown[]) => {
            chamadas.push({ metodo: String(prop), args });
            return chain;
          };
        },
      },
    );
    return chain;
  };
  return { admin: { from } as never, consultas };
}

describe("createSupabaseSilenceSweepDb().loadContatosComInscricaoViva — a query de produção", () => {
  it("pergunta o que o índice único pergunta: organização + status VIVOS, em qualquer fluxo (sem pointer_id)", async () => {
    const { admin, consultas } = fakeAdmin([[]]);
    await createSupabaseSilenceSweepDb(admin).loadContatosComInscricaoViva("org-1", ["c-1"]);

    expect(consultas).toHaveLength(1);
    const chamadas = consultas[0]!;
    expect(chamadas[0]).toEqual({ metodo: "from", args: ["followup_enrollments"] });
    expect(chamadas).toContainEqual({ metodo: "eq", args: ["organization_id", "org-1"] });
    expect(chamadas).toContainEqual({
      metodo: "in",
      args: ["status", ["active", "waiting_reply", "paused_handoff", "paused_manual"]],
    });
    expect(chamadas).toContainEqual({ metodo: "in", args: ["contact_id", ["c-1"]] });
    expect(chamadas.some((c) => c.args[0] === "pointer_id")).toBe(false);
  });

  it("consulta em lotes de 100 contatos e junta as respostas num Set", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `c-${i}`);
    const { admin, consultas } = fakeAdmin([[{ contact_id: "c-3" }], [{ contact_id: "c-150" }], [{ contact_id: "c-249" }]]);

    const vivos = await createSupabaseSilenceSweepDb(admin).loadContatosComInscricaoViva("org-1", ids);

    const lotes = consultas.map(
      (chamadas) => (chamadas.find((c) => c.metodo === "in" && c.args[0] === "contact_id")?.args[1] as string[]).length,
    );
    expect(lotes).toEqual([100, 100, 50]);
    expect(vivos).toEqual(new Set(["c-3", "c-150", "c-249"]));
  });

  it("lista vazia não bate no banco", async () => {
    const { admin, consultas } = fakeAdmin([[{ contact_id: "não deveria aparecer" }]]);
    const vivos = await createSupabaseSilenceSweepDb(admin).loadContatosComInscricaoViva("org-1", []);

    expect(vivos).toEqual(new Set());
    expect(consultas).toHaveLength(0);
  });
});
