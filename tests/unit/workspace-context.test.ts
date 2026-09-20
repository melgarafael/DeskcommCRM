import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadWorkspaceContext } from "@/lib/workspace/context";
import { workspaceQuestionSchema } from "@/lib/workspace/schema";
function database(rows: Record<string, unknown[]>, failure?: string) {
  const queries: Array<{ table: string; calls: unknown[][] }> = [];
  const db = {
    from(table: string) {
      const record = { table, calls: [] as unknown[][] };
      queries.push(record);
      const query: Record<string, unknown> = {
        then: (resolve: (v: unknown) => void) =>
          resolve({
            data: rows[table] ?? [],
            error: table === failure ? { message: "db failed" } : null,
          }),
      };
      for (const name of ["select", "eq", "not", "order", "limit", "in", "is", "or", "neq"])
        query[name] = (...args: unknown[]) => {
          record.calls.push([name, ...args]);
          return query;
        };
      return query;
    },
  };
  return { db: db as unknown as SupabaseClient, queries };
}
describe("consulta do espaço", () => {
  it("escopa todas as consultas ao tenant e remove conteúdo revogado/anonimizado na fonte", async () => {
    const { db, queries } = database({
      conversations: [
        { id: "conv1", contacts: { display_name: "Ana" }, channel: "instagram", status: "open" },
      ],
      messages: [{ conversation_id: "conv1", body: "Olá", direction: "inbound" }],
    });
    const result = await loadWorkspaceContext(db, "org-session", "agent", "all", "resuma");
    expect(result.sources[0]?.href).toBe("/app/inbox?id=conv1");
    expect(result.sources[0]?.text).toContain("Olá");
    for (const query of queries)
      expect(query.calls).toContainEqual(["eq", "organization_id", "org-session"]);
    expect(queries.find((q) => q.table === "conversations")?.calls).toContainEqual([
      "eq",
      "contacts.is_anonymized",
      false,
    ]);
    expect(queries.find((q) => q.table === "messages")?.calls).toContainEqual([
      "is",
      "revoked_at",
      null,
    ]);
    expect(queries.some((q) => q.table === "ai_knowledge_sources")).toBe(false);
  });
  it("nega conhecimento a atendente sem consultar tabela", async () => {
    const { db, queries } = database({});
    await expect(loadWorkspaceContext(db, "org", "agent", "knowledge", "preços")).rejects.toThrow(
      "perfil",
    );
    expect(queries).toEqual([]);
  });
  it("só lê versões ativas e higieniza os termos da busca", async () => {
    const { db, queries } = database({
      ai_knowledge_sources: [{ id: "source", name: "Serviços", active_kb_version_id: "active" }],
      ai_chunks: [{ id: "chunk", knowledge_source_id: "source", content: "Informação" }],
    });
    const result = await loadWorkspaceContext(
      db,
      "org",
      "manager",
      "knowledge",
      "preços),content.neq.secret%",
    );
    expect(result.sources[0]?.title).toBe("Serviços");
    const materials = queries.find((q) => q.table === "ai_knowledge_sources");
    expect(materials?.calls).toContainEqual(["eq", "is_active", true]);
    expect(materials?.calls).toContainEqual(["neq", "status", "archived"]);
    const chunks = queries.find((q) => q.table === "ai_chunks");
    expect(chunks?.calls).toContainEqual(["in", "kb_version_id", ["active"]]);
    expect(JSON.stringify(chunks?.calls)).not.toContain("neq.secret%");
  });
  it("falha de banco não se apresenta como ausência de conteúdo", async () => {
    const { db } = database({}, "crm_leads");
    await expect(loadWorkspaceContext(db, "org", "manager", "leads", "funil")).rejects.toThrow(
      "funil",
    );
  });
  it("não aceita tenant nem histórico sem limite vindos do cliente", () => {
    expect(
      workspaceQuestionSchema.safeParse({
        question: "Oi",
        scope: "all",
        history: [],
        orgId: "outra",
      }).success,
    ).toBe(false);
    expect(
      workspaceQuestionSchema.safeParse({
        question: "Oi",
        scope: "all",
        history: Array(9).fill({ role: "user", content: "Oi" }),
      }).success,
    ).toBe(false);
  });
});
