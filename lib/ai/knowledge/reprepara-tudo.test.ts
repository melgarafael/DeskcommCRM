// @vitest-environment node
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { enfileirarTodosOsMateriais } from "./reprepara-tudo";

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function world(count: number, maxRows = 1000, failPage?: number) {
  const sources = Array.from({ length: count }, (_, i) => ({
    id: id(i + 1),
    agent_id: null,
    source_type: "faq",
    last_index_status: i === count - 1 ? "failed" : "success",
    organization_id: ORG_ID,
    status: "active",
  }));
  const rows = [
    ...sources,
    { ...sources[0], id: id(count + 1), organization_id: "other-org", status: "active" },
    { ...sources[0], id: id(count + 2), organization_id: ORG_ID, status: "archived" },
  ];
  const requests: URL[] = [];
  const fetchPage = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    requests.push(url);
    if (requests.length > count + 2) throw new Error("Pagination did not advance");
    if (requests.length === failPage) {
      return new Response(JSON.stringify({ code: "57014", message: "statement timeout" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    const after = url.searchParams.get("id")?.replace(/^gt\./, "");
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? maxRows), maxRows);
    const visible = rows.filter(
      (row) =>
        (!url.searchParams.has("organization_id") ||
          url.searchParams.get("organization_id") === `eq.${row.organization_id}`) &&
        (!url.searchParams.has("status") || row.status !== "archived") &&
        (!after || row.id > after),
    );
    return new Response(JSON.stringify(visible.slice(offset, offset + limit)), {
      headers: { "content-type": "application/json" },
    });
  });

  // Keep the installed SDK and its query serialization; replace only transport.
  const leitura = createClient("https://knowledge.test", "test-key", {
    global: { fetch: fetchPage },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const clear = vi.fn(async () => ({ error: null }));
  const write = { eq: () => write, neq: clear };
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
    error: null as { message: string } | null,
  }));
  const admin = { from: () => ({ update: () => write }), rpc };
  return { sources, requests, leitura, admin: admin as never, rpc, clear };
}

function enqueue(
  w: ReturnType<typeof world>,
  motivo: "manual_reindex_all" | "troca_de_provedor" = "manual_reindex_all",
) {
  return enfileirarTodosOsMateriais({
    leitura: w.leitura,
    admin: w.admin,
    organizationId: ORG_ID,
    requestId: "reindex-test",
    motivo,
  });
}

describe("enqueue all knowledge sources beyond the API row cap", () => {
  it.each(["manual_reindex_all", "troca_de_provedor"] as const)(
    "queues all 1,001 sources for %s, prioritizing a failure on a later page",
    async (reason) => {
      const w = world(1001);
      const result = await enqueue(w, reason);
      expect(result).toEqual({ total: 1001, prioridade1: 1, prioridade2: 1000, emitidos: 1001 });
      const events = w.rpc.mock.calls.map(([, args]) => args);
      expect(events).toHaveLength(1001);
      expect(events[0]?.p_entity_id).toBe(id(1001));
      expect(new Set(events.map((event) => event.p_entity_id))).toEqual(
        new Set(w.sources.map((source) => source.id)),
      );
      expect(events.every((event) => event.p_organization_id === ORG_ID)).toBe(true);
      expect(
        events.every(
          (event) => (event.p_payload as Record<string, unknown>).triggered_by === reason,
        ),
      ).toBe(true);
      expect(
        w.requests.every((url) => url.searchParams.get("organization_id") === `eq.${ORG_ID}`),
      ).toBe(true);
      expect(w.requests.every((url) => url.searchParams.get("status") === "neq.archived")).toBe(
        true,
      );
      expect(w.requests.every((url) => url.searchParams.get("order") === "id.asc")).toBe(true);
    },
  );

  it("does not stop at a short page when the server cap is lower than the requested page size", async () => {
    const w = world(7, 2);
    expect(await enqueue(w)).toEqual({ total: 7, prioridade1: 1, prioridade2: 6, emitidos: 7 });
    expect(new Set(w.rpc.mock.calls.map(([, args]) => args.p_entity_id)).size).toBe(7);
  });

  it("does not clear errors or enqueue a partial list when a later page fails", async () => {
    const w = world(5, 2, 2);
    await expect(enqueue(w)).rejects.toThrow("listar_materiais_falhou");
    expect(w.clear).not.toHaveBeenCalled();
    expect(w.rpc).not.toHaveBeenCalled();
  });

  it("leaves an empty organization unchanged", async () => {
    const w = world(0);
    expect(await enqueue(w)).toEqual({ total: 0, prioridade1: 0, prioridade2: 0, emitidos: 0 });
    expect(w.clear).not.toHaveBeenCalled();
    expect(w.rpc).not.toHaveBeenCalled();
  });

  it("still counts only successful events when one source cannot be queued", async () => {
    const w = world(4);
    w.rpc.mockResolvedValueOnce({ error: { message: "event failed" } });
    expect(await enqueue(w)).toEqual({ total: 4, prioridade1: 1, prioridade2: 3, emitidos: 3 });
    expect(w.rpc).toHaveBeenCalledTimes(4);
  });
});
