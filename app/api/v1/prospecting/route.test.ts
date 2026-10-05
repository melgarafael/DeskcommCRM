/**
 * Token `dsk_` na prospecção (#1875, #2028): só configurar, pesquisar e pausar
 * passam por token (lista de permissão); iniciar e retomar campanha seguem
 * exigindo a tela, porque enviam.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({
  validateBearerToken: vi.fn(),
  checkRateLimit: vi.fn(),
  pool: vi.fn(),
  activate: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: deps.pool }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: deps.checkRateLimit }));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: deps.validateBearerToken };
});
vi.mock("@/lib/prospecting/store", () => ({
  activateCampaign: deps.activate,
  configureCredential: vi.fn(),
  createSearch: vi.fn(),
  validateConfig: vi.fn(),
  withProspectingLock: vi.fn(),
}));

import { POST } from "./route";

const ID = "11111111-1111-4111-8111-111111111111";

function tokenPost(body: unknown) {
  return new NextRequest("http://localhost/api/v1/prospecting", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer dsk_abc" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.checkRateLimit.mockResolvedValue({ allowed: true });
  deps.pool.mockReturnValue({ query: vi.fn(async () => ({ rows: [{ id: ID }] })) });
  deps.validateBearerToken.mockResolvedValue({
    organizationId: "99999999-9999-4999-8999-999999999999",
    scopes: ["mcp:read", "mcp:write"],
    role: "admin",
    actor: { type: "api_token", id: "tok-1" },
    apiTokenId: "tok-1",
  });
});

describe("POST /api/v1/prospecting por token", () => {
  const CONFIG = {
    agent_id: ID,
    channel_session_id: ID,
    pipeline_id: ID,
    stage_id: ID,
    qualified_stage_id: ID,
    instruction: "Apresente a clínica com educação.",
    qualification: "Tem interesse em agendar avaliação.",
    legal_basis_ref: "legítimo interesse, registro 1",
  };

  it.each([
    ["start", { action: "start", id: ID, config: CONFIG }],
    ["resume", { action: "resume", id: ID }],
  ])("%s responde 403 sem tocar no banco", async (_nome, body) => {
    const res = await POST(tokenPost(body));
    expect(res.status).toBe(403);
    expect(deps.pool).not.toHaveBeenCalled();
    expect(deps.activate).not.toHaveBeenCalled();
  });

  it("pause segue aberto ao token", async () => {
    const res = await POST(tokenPost({ action: "pause", id: ID }));
    expect(res.status).toBe(200);
  });
});
