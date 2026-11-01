import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/v1/admin/incidents/[id] — detalhe do incidente.
 *
 * `ok()` já embrulha em `{ data }`. A rota passava `{ data: shaped }`, o corpo
 * saía `{ data: { data: shaped } }`, e a tela lia `body.data` como o incidente:
 * `created_at` vinha undefined e `formatDistanceToNow(new Date(undefined))`
 * derrubava a página no error boundary em 100% dos casos.
 */

vi.mock("@/lib/auth/requirePlatformAdmin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/requirePlatformAdmin")>()),
  requirePlatformAdmin: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const INCIDENT_ID = "44444444-4444-4444-8444-444444444444";

const INCIDENT = {
  id: INCIDENT_ID,
  organization_id: ORG_ID,
  // Tipo genérico de propósito: nenhum caso aqui inspeciona `type`, e nomear o
  // provider num arquivo fora de lib/channels/ reprova o `lint:channels`
  // (doutrina restrição-de-canal, invariante 1) — gate obrigatório do CI.
  type: "channel.session_failed",
  severity: "critical",
  status: "open",
  payload: { session: "default" },
  resolution_note: null,
  resolved_at: null,
  created_at: "2026-08-01T10:00:00Z",
  organizations: {
    id: ORG_ID,
    display_name: "Org",
    slug: "org",
    status: "active",
  },
};

function makeAdminStub() {
  return {
    from: (table: string) => {
      if (table === "incidents") {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: INCIDENT, error: null }),
        };
        return builder;
      }
      if (table === "api_audit_log") {
        const builder = {
          select: () => builder,
          contains: () => builder,
          order: () => builder,
          limit: async () => ({ data: [], error: null }),
        };
        return builder;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePlatformAdmin).mockResolvedValue({
    user: { id: ADMIN_ID },
    platformAdmin: { user_id: ADMIN_ID, scope: "full", mfa_required: true },
  } as never);
  vi.mocked(createAdminClient).mockReturnValue(makeAdminStub() as never);
});

describe("GET /api/v1/admin/incidents/[id]", () => {
  it("o incidente está direto em body.data, não em body.data.data", async () => {
    const { GET } = await import("./route");
    const res = await GET(
      new NextRequest(`http://localhost/api/v1/admin/incidents/${INCIDENT_ID}`),
      { params: Promise.resolve({ id: INCIDENT_ID }) },
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { id: string; created_at: string; tenant: { slug: string } | null };
    };
    expect(body.data).not.toHaveProperty("data");
    expect(body.data.id).toBe(INCIDENT_ID);
    // `created_at` definido é o que separa a tela renderizada do error boundary:
    // é o que `formatDistanceToNow(new Date(...))` recebe.
    expect(body.data.created_at).toBe(INCIDENT.created_at);
    expect(Number.isNaN(new Date(body.data.created_at).getTime())).toBe(false);
    expect(body.data.tenant?.slug).toBe("org");
  });
});
