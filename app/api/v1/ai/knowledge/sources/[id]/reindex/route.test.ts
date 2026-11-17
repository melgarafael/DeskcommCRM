// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { POST } from "./route";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "66666666-6666-4666-8666-666666666666";
const fetchSource = vi.fn();
const clearError = vi.fn();
const emitEvent = vi.fn();

function authorize(idioma = "pt-BR") {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma },
    org: { orgId: ORG_ID, role: "manager" },
  } as never);
}

function reindex() {
  return POST(
    new NextRequest(`http://localhost/api/v1/ai/knowledge/sources/${SOURCE_ID}/reindex`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id: SOURCE_ID }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authorize();
  vi.mocked(requireSupportWrite).mockResolvedValue(null as never);
  fetchSource.mockResolvedValue({
    data: { id: SOURCE_ID, agent_id: null, source_type: "faq" },
    error: null,
  });
  clearError.mockResolvedValue({ error: null });
  emitEvent.mockResolvedValue({ error: null });
  const read = { select: vi.fn(), eq: vi.fn(), maybeSingle: fetchSource };
  read.select.mockReturnValue(read);
  read.eq.mockReturnValue(read);
  vi.mocked(createClient).mockResolvedValue({ from: () => read } as never);
  const write = {
    eq: vi.fn(),
    then: (resolve: (value: unknown) => unknown) => clearError().then(resolve),
  };
  write.eq.mockReturnValue(write);
  vi.mocked(createAdminClient).mockReturnValue({
    from: () => ({ update: () => write }),
    rpc: emitEvent,
  } as never);
});

describe("manual knowledge reindexing", () => {
  it("confirms the durable event and audits a successful request", async () => {
    const response = await reindex();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { id: SOURCE_ID, queued: true, agent_id: null },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      "emit_event",
      expect.objectContaining({
        p_event_type: "knowledge_source.updated",
        p_entity_id: SOURCE_ID,
        p_organization_id: ORG_ID,
        p_payload: {
          knowledge_source_id: SOURCE_ID,
          agent_id: null,
          source_type: "faq",
          triggered_by: "manual_reindex",
        },
      }),
    );
    expect(audit).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.knowledge_source_reindexed",
        actorUserId: USER_ID,
        organizationId: ORG_ID,
        resourceId: SOURCE_ID,
        requestId: response.headers.get("x-request-id"),
      }),
    );
  });

  it.each([
    ["pt-BR", "Não foi possível solicitar a preparação do material. Tente novamente."],
    ["es", "No se pudo solicitar la preparación del material. Inténtalo de nuevo."],
  ])(
    "reports a rejected event in %s without auditing success, and allows a retry",
    async (idioma, message) => {
      authorize(idioma);
      emitEvent.mockResolvedValueOnce({ error: { code: "57014", message: "statement timeout" } });
      const failed = await reindex();
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: { code: "internal_error", message } });
      expect(failed.headers.get("x-request-id")).toBeTruthy();
      expect(audit).not.toHaveBeenCalled();

      const retried = await reindex();
      expect(retried.status).toBe(200);
      expect(await retried.json()).toMatchObject({ data: { queued: true } });
      expect(audit).toHaveBeenCalledOnce();
    },
  );

  it("still queues when clearing the previous indexing error fails", async () => {
    clearError.mockResolvedValue({ error: { message: "clear failed" } });
    expect((await reindex()).status).toBe(200);
    expect(emitEvent).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledOnce();
  });

  it("does not queue an absent source", async () => {
    fetchSource.mockResolvedValue({ data: null, error: null });
    expect((await reindex()).status).toBe(404);
    expect(emitEvent).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("does not queue when the source cannot be read", async () => {
    fetchSource.mockResolvedValue({ data: null, error: { message: "read failed" } });
    expect((await reindex()).status).toBe(500);
    expect(emitEvent).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("preserves the role refusal", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    expect((await reindex()).status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("preserves the support write refusal", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(new Response(null, { status: 403 }) as never);
    expect((await reindex()).status).toBe(403);
    expect(requireRole).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });
});
