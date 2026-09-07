import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { fail } from "@/lib/api/wrappers";
import type { AuthUser } from "@/lib/auth/types";

/**
 * Épico Operação Visível (F1, Task 4) — memória geral da org:
 *  - GET sem auth repassa authz.response;
 *  - GET com org vazia retorna document null + versions/entries [];
 *  - POST publica versão incrementada + upsert do pointer + audit;
 *  - POST body inválido (content vazio) → 422 validation_failed.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

interface VersionsCfg {
  version?: { id: string; version_number: number; content: string; created_at: string } | null;
  versions?: Array<Record<string, unknown>>;
  versionsError?: unknown;
  maxVersionRow?: { version_number: number } | null;
  insertVersion?: { id: string; version_number: number } | null;
  insertVersionError?: unknown;
}

function makeVersionsBuilder(cfg: VersionsCfg) {
  let hasId = false;
  let hasLimit = false;
  let isInsert = false;
  const b = {
    select() {
      return b;
    },
    insert() {
      isInsert = true;
      return b;
    },
    eq(col: string) {
      if (col === "id") hasId = true;
      return b;
    },
    order() {
      return b;
    },
    limit() {
      hasLimit = true;
      return b;
    },
    maybeSingle() {
      if (hasId) return Promise.resolve({ data: cfg.version ?? null, error: null });
      if (hasLimit) return Promise.resolve({ data: cfg.maxVersionRow ?? null, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    single() {
      return Promise.resolve({ data: cfg.insertVersion ?? null, error: cfg.insertVersionError ?? null });
    },
    then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
      if (isInsert) {
        return Promise.resolve({ data: cfg.insertVersion ?? null, error: cfg.insertVersionError ?? null }).then(
          onF,
          onR,
        );
      }
      return Promise.resolve({ data: cfg.versions ?? [], error: cfg.versionsError ?? null }).then(onF, onR);
    },
  };
  return b;
}

interface PointersCfg {
  pointer?: { version_id: string } | null;
  upsertError?: unknown;
}
interface PointersState {
  upsertCalled: boolean;
  upsertPayload: Record<string, unknown> | null;
}

function makePointersBuilder(cfg: PointersCfg, state: PointersState) {
  const b = {
    select() {
      return b;
    },
    eq() {
      return b;
    },
    maybeSingle() {
      return Promise.resolve({ data: cfg.pointer ?? null, error: null });
    },
    upsert(payload: Record<string, unknown>) {
      state.upsertCalled = true;
      state.upsertPayload = payload;
      return Promise.resolve({ error: cfg.upsertError ?? null });
    },
  };
  return b;
}

interface EntriesCfg {
  entries?: Array<Record<string, unknown>>;
  entriesError?: unknown;
}

function makeEntriesBuilder(cfg: EntriesCfg) {
  const b = {
    select() {
      return b;
    },
    eq() {
      return b;
    },
    neq() {
      return b;
    },
    order() {
      return b;
    },
    then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
      return Promise.resolve({ data: cfg.entries ?? [], error: cfg.entriesError ?? null }).then(onF, onR);
    },
  };
  return b;
}

function makeAdminStub(
  cfg: VersionsCfg & PointersCfg & EntriesCfg,
  state: PointersState = { upsertCalled: false, upsertPayload: null },
) {
  return {
    from(table: string) {
      if (table === "org_memory_pointers") return makePointersBuilder(cfg, state);
      if (table === "org_memory_versions") return makeVersionsBuilder(cfg);
      if (table === "org_memory_entries") return makeEntriesBuilder(cfg);
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function mockAuthzOk(role: "agent" | "admin") {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role },
  });
}

function getReq() {
  return new NextRequest("http://localhost/api/v1/ai/memory");
}
function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/v1/ai/memory", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/ai/memory", () => {
  it("sem auth → repassa authz.response", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    });
    const { GET } = await import("./route");
    const res = await GET(getReq());
    expect(res.status).toBe(401);
  });

  it("com org vazia: document null + versions/entries []", async () => {
    mockAuthzOk("agent");
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub({ pointer: null, versions: [], entries: [] }) as never,
    );
    const { GET } = await import("./route");
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { document: unknown; versions: unknown[]; entries: unknown[] };
    };
    expect(body.data.document).toBeNull();
    expect(body.data.versions).toEqual([]);
    expect(body.data.entries).toEqual([]);
  });
});

describe("POST /api/v1/ai/memory", () => {
  it("publica versão incrementada, upsert do pointer e audit", async () => {
    mockAuthzOk("admin");
    const state: PointersState = { upsertCalled: false, upsertPayload: null };
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub(
        { maxVersionRow: { version_number: 3 }, insertVersion: { id: "ver-4", version_number: 4 } },
        state,
      ) as never,
    );
    const { POST } = await import("./route");
    const res = await POST(postReq({ content: "novo conteúdo da memória" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { version_id: string; version_number: number } };
    expect(body.data).toEqual({ version_id: "ver-4", version_number: 4 });
    expect(state.upsertCalled).toBe(true);
    expect(state.upsertPayload).toMatchObject({ organization_id: ORG_ID, version_id: "ver-4" });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai.org_memory_published", organizationId: ORG_ID }),
    );
  });

  it("body inválido (content vazio) → 422 validation_failed", async () => {
    mockAuthzOk("admin");
    const { POST } = await import("./route");
    const res = await POST(postReq({ content: "" }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));
