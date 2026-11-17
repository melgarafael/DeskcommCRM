// @vitest-environment node
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  admin: null as SupabaseClient | null,
  idle: false,
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.admin }));
vi.mock("@/lib/cron/piso-ocioso", () => ({ recursoOcioso: async () => h.idle }));
vi.mock("@/lib/env", () => ({ env: { INTERNAL_CRON_SECRET: "synthetic-cron-secret" } }));
vi.mock("@/lib/logger", () => ({ logger: { error: h.error, warn: h.warn } }));

import { GET } from "./route";
import { drainStorageRedactionQueue } from "@/lib/lgpd/storage-redaction-queue";

const ORG = "11111111-1111-4111-8111-111111111111";
const MEDIA_PATH = `${ORG}/avatars/contact.jpg`;
const EMPTY_STATS = { attempted: 0, deleted: 0, failed: 0, skipped: 0 };
const READ_ERROR = { code: "57014", message: "statement timeout: private database detail" };

function world(withPending = false) {
  const row = {
    id: "22222222-2222-4222-8222-222222222222",
    organization_id: ORG,
    bucket: "whatsapp-media",
    object_path: MEDIA_PATH,
    attempts: 0,
    status: withPending ? "pending" : "deleted",
  };
  const state = { readError: null as typeof READ_ERROR | null };
  const requests: { url: URL; method: string; body: unknown }[] = [];
  const removed: string[] = [];
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ url, method, body });
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/rest/v1/storage_redaction_queue" && method === "GET") {
      if (state.readError) return json(state.readError, 500);
      return json(url.searchParams.get("status") === `eq.${row.status}` ? [row] : []);
    }
    if (url.pathname === "/rest/v1/storage_redaction_queue" && method === "PATCH") {
      if (url.searchParams.get("id") === `eq.${row.id}`) Object.assign(row, body);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/storage/v1/object/whatsapp-media" && method === "DELETE") {
      removed.push(...(body as { prefixes: string[] }).prefixes);
      return json([{ name: MEDIA_PATH }]);
    }
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  });
  // Exercise the installed SDK and real route/worker; replace only HTTP transport.
  h.admin = createClient("https://storage-cleanup.test", "synthetic-service-key", {
    global: { fetch: transport },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { row, state, requests, removed };
}

function request(authorized = true) {
  return new NextRequest("https://app.test/api/v1/cron/storage-redaction", {
    headers: authorized ? { authorization: "Bearer synthetic-cron-secret" } : {},
  });
}

beforeEach(() => {
  h.idle = false;
  h.error.mockClear();
  h.warn.mockClear();
});

describe("storage-redaction queue read failures", () => {
  it("rejects an unknown queue state instead of reporting an empty successful batch", async () => {
    const w = world(true);
    w.state.readError = READ_ERROR;

    await expect(drainStorageRedactionQueue()).rejects.toThrow(
      "storage_redaction_queue_read_failed",
    );
    expect(w.removed).toEqual([]);
    expect(w.row).toMatchObject({ status: "pending", attempts: 0 });
    expect(w.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("returns a correlated HTTP 500 without exposing database details", async () => {
    const w = world(true);
    w.state.readError = READ_ERROR;

    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "internal_error", message: "storage_redaction_failed" },
    });
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toBeTruthy();
    expect(h.error).toHaveBeenCalledWith(
      "[storage-redaction] queue drain failed",
      expect.objectContaining({
        requestId,
        error_message: expect.stringContaining(READ_ERROR.message),
      }),
    );
    expect(w.removed).toEqual([]);
    expect(w.row).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("leaves pending work untouched and removes it on a later successful tick", async () => {
    const w = world(true);
    w.state.readError = READ_ERROR;
    const failed = await GET(request());
    expect(failed.status).toBe(500);
    expect(w.row).toMatchObject({ status: "pending", attempts: 0 });
    expect(w.removed).toEqual([]);

    w.state.readError = null;
    const recovered = await GET(request());
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({
      data: { attempted: 1, deleted: 1, failed: 0, skipped: 0 },
    });
    expect(w.removed).toEqual([MEDIA_PATH]);
    expect(w.row).toMatchObject({ status: "deleted", attempts: 1 });
  });

  it("still removes a pending object and persists its successful outcome", async () => {
    const w = world(true);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { attempted: 1, deleted: 1, failed: 0, skipped: 0 },
    });
    expect(w.removed).toEqual([MEDIA_PATH]);
    expect(w.row).toMatchObject({ status: "deleted", attempts: 1 });
  });

  it("still reports a genuinely empty queue as a successful zero-sized batch", async () => {
    const w = world();
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: EMPTY_STATS });
    expect(w.removed).toEqual([]);
  });

  it("rejects unauthenticated cron requests before querying or deleting", async () => {
    const w = world(true);
    const response = await GET(request(false));
    expect(response.status).toBe(403);
    expect(w.requests).toEqual([]);
  });

  it("keeps the idle shortcut free of queue queries and removals", async () => {
    const w = world(true);
    h.idle = true;
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { pulado: "recurso_ocioso" } });
    expect(w.requests).toEqual([]);
  });
});
