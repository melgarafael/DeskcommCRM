/**
 * Paginação e ordenação da lista de contatos — comportamento do handler.
 */
import { describe, expect, it } from "vitest";

import { listContactsHandler } from "@/app/api/v1/contacts/_handler";

const ORG = "11111111-1111-4111-8111-111111111111";

interface Captura {
  orders: Array<{ col: string; asc: boolean }>;
  orFilters: string[];
  isFilters: Array<{ col: string }>;
  ltGt: Array<{ col: string; op: string; val: string }>;
}

function supabaseEspiao() {
  const cap: Captura = { orders: [], orFilters: [], isFilters: [], ltGt: [] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    order: (col: string, opts?: { ascending?: boolean }) => {
      cap.orders.push({ col, asc: opts?.ascending ?? true });
      return chain;
    },
    limit: () => chain,
    contains: () => chain,
    or: (expr: string) => {
      cap.orFilters.push(expr);
      return chain;
    },
    is: (col: string) => {
      cap.isFilters.push({ col });
      return chain;
    },
    gt: (col: string, val: string) => {
      cap.ltGt.push({ col, op: "gt", val });
      return chain;
    },
    lt: (col: string, val: string) => {
      cap.ltGt.push({ col, op: "lt", val });
      return chain;
    },
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res),
  };
  return { client: { from: () => chain } as never, cap };
}

function encodeCursor(sort: string | null, id: string): string {
  return Buffer.from(JSON.stringify({ sort, id }), "utf8").toString("base64url");
}

describe("lista de contatos — ordenação e cursor", () => {
  it("ordena pela coluna pedida + id como desempate", async () => {
    const { client, cap } = supabaseEspiao();
    await listContactsHandler(
      client,
      { organization_id: ORG, actor: { type: "user", id: "u-1" }, requestId: "req" },
      { order_by: "email", order_dir: "asc", limit: 25 },
    );
    expect(cap.orders.map((o) => o.col)).toEqual(["email", "id"]);
    expect(cap.orders[0]?.asc).toBe(true);
  });

  it("cursor pagina pela coluna de ordenação (desc)", async () => {
    const { client, cap } = supabaseEspiao();
    await listContactsHandler(
      client,
      { organization_id: ORG, actor: { type: "user", id: "u-1" }, requestId: "req" },
      {
        order_by: "last_activity_at",
        order_dir: "desc",
        cursor: encodeCursor("2026-01-15T12:00:00.000Z", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
        limit: 25,
      },
    );
    expect(cap.orFilters[0]).toContain("last_activity_at.lt.2026-01-15T12:00:00.000Z");
    expect(cap.orFilters[0]).toContain("id.lt.cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  });

  it("cursor na região de NULL pagina só por id (asc)", async () => {
    const { client, cap } = supabaseEspiao();
    await listContactsHandler(
      client,
      { organization_id: ORG, actor: { type: "user", id: "u-1" }, requestId: "req" },
      {
        order_by: "last_activity_at",
        order_dir: "asc",
        cursor: encodeCursor(null, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        limit: 25,
      },
    );
    // ⚠️ NÃO é `isFilters[0]`: a listagem faz um `.is()` ANTES deste, para tirar
    // a lápide de fusão (`is_merged_into is null`). Ancorar na POSIÇÃO fazia o
    // teste medir o filtro errado no dia em que a consulta ganhou outro `.is()`
    // — e o vermelho apontava para a paginação, que não tinha mudado. Ancorar
    // na COLUNA sobrevive a qualquer filtro novo.
    expect(cap.isFilters.map((f) => f.col)).toContain("last_activity_at");
    expect(cap.isFilters.map((f) => f.col)).toContain("is_merged_into");
    expect(cap.ltGt[0]).toMatchObject({
      col: "id",
      op: "gt",
      val: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
  });
});
