/**
 * A opção `mcp_externo_no_atendimento` (#2147, opção A) só é ligada por quem é
 * ADMIN. É ela que faz o servidor MCP externo da organização receber a
 * identidade do cliente da conversa — uma decisão de quem administra, não de
 * quem opera o dia a dia.
 *
 * O gate é o `role: "admin"` que a rota pede a `requireRole`. O mock abaixo
 * aplica o ranking de papéis de verdade: se a rota passar a pedir `manager`,
 * o caso do manager fica verde no 200 e este arquivo reprova.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { agentPatchSchema, AGENT_CONFIG_DEFAULTS } from "@/lib/ai/guardrails-schema";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
}));

const ORG = "44444444-4444-4444-8444-444444444444";
const AGENT = "66666666-6666-4666-8666-666666666666";
const RANK = { viewer: 1, agent: 2, manager: 3, admin: 4 } as const;
type Papel = keyof typeof RANK;

let gravado: Record<string, unknown> | null;

const linha = {
  id: AGENT,
  organization_id: ORG,
  name: "Atendente",
  description: null,
  model: "anthropic/claude-sonnet-4-6",
  system_prompt: "Você é a atendente da loja. Responda com clareza.",
  is_active: true,
  is_default: true,
  kind: "mcp_agent",
  priority: 0,
  published_version_id: null,
  archived_at: null,
  config: { rag_top_k: 7 },
  guardrails: [],
  active_kb_version_id: null,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T10:00:00Z",
};

function admin() {
  const q = (op: "select" | "update", patch?: Record<string, unknown>) => {
    const enc = {
      select: () => enc,
      eq: () => enc,
      is: () => enc,
      maybeSingle: async () => ({ data: linha, error: null }),
      single: async () => {
        if (op === "update") gravado = patch ?? {};
        return { data: { ...linha, ...patch }, error: null };
      },
    };
    return enc;
  };
  return {
    from: () => ({
      select: () => q("select"),
      update: (patch: Record<string, unknown>) => q("update", patch),
    }),
  };
}

async function ligarComo(papel: Papel) {
  vi.mocked(requireRole).mockImplementation(async (minimo) =>
    RANK[papel] >= RANK[minimo as Papel]
      ? ({
          ok: true,
          user: { id: "11111111-1111-4111-8111-111111111111" },
          org: { orgId: ORG, name: "Org", role: papel },
        } as never)
      : ({ ok: false, response: fail("forbidden", "Papel insuficiente.", 403) } as never),
  );
  vi.mocked(createAdminClient).mockReturnValue(admin() as never);
  const { PATCH } = await import("@/app/api/v1/ai/agents/[id]/route");
  const req = new NextRequest(`http://localhost/api/v1/ai/agents/${AGENT}`, {
    method: "PATCH",
    body: JSON.stringify({ config: { mcp_externo_no_atendimento: true } }),
    headers: { "content-type": "application/json" },
  });
  const res = await PATCH(req, { params: Promise.resolve({ id: AGENT }) } as never);
  return res.status;
}

beforeEach(() => {
  vi.clearAllMocks();
  gravado = null;
});

describe("opção do servidor externo no atendimento — só admin liga (#2147)", () => {
  it("desligada de fábrica", () => {
    expect(AGENT_CONFIG_DEFAULTS.mcp_externo_no_atendimento).toBe(false);
    // O PATCH não inventa a chave para quem não a mandou.
    expect(agentPatchSchema.parse({ config: { rag_top_k: 3 } }).config).toEqual({ rag_top_k: 3 });
  });

  it.each(["manager", "agent", "viewer"] as const)("%s recebe 403 e nada é gravado", async (papel) => {
    expect(await ligarComo(papel)).toBe(403);
    expect(gravado).toBeNull();
  });

  it("admin liga, e o resto da config atravessa intacto", async () => {
    expect(await ligarComo("admin")).toBe(200);
    expect(gravado?.config).toMatchObject({ mcp_externo_no_atendimento: true, rag_top_k: 7 });
  });
});
