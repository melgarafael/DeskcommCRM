/**
 * O dossiê nomeia quem interveio — e só nomeia membro da organização da
 * sessão, com o `full_name` e nada mais (a regra de `nomesDosAtendentes`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({ role: vi.fn(), client: vi.fn(), admin: vi.fn() }));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/supabase/server", () => ({ createClient: deps.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.admin }));
vi.mock("@/lib/audit", () => ({ isServiceRoleConfigured: () => true }));

import { GET } from "./route";

const ID = "11111111-1111-4111-8111-111111111111";
const ORG = "org-da-sessao";
const MEMBRO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBRO_SEM_NOME = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FORA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const USUARIOS: Record<string, { email: string; user_metadata: Record<string, unknown> }> = {
  [MEMBRO]: { email: "ana@exemplo.com", user_metadata: { full_name: "Ana" } },
  [MEMBRO_SEM_NOME]: { email: "bia@exemplo.com", user_metadata: {} },
  [FORA]: { email: "carol@exemplo.com", user_metadata: { full_name: "Carol" } },
};

function cadeia(fim: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = {
    select: () => c,
    eq: () => c,
    order: () => c,
    limit: () => c,
    maybeSingle: async () => fim,
    then: (res: (v: unknown) => unknown) => Promise.resolve(fim).then(res),
  };
  return c;
}

function clienteDaSessao() {
  const linha = {
    id: ID,
    status: "active",
    contact_id: "ct",
    pointer_id: "pt",
    version_id: "vs",
    current_node_id: "n1",
    next_eval_at: null,
    claimed_until: null,
    started_at: "2026-11-01T00:00:00Z",
    completed_at: null,
    updated_at: "2026-11-01T00:00:00Z",
    outcome: null,
    cancel_reason: null,
    last_error: null,
    attempts: 0,
    max_attempts: 3,
    steps_taken: 1,
    timing_plan: null,
    contacts: { id: "ct", name: "Cliente", display_name: null, phone_number: null },
    followup_flow_pointers: { name: "Fluxo" },
    ai_agents: null,
    followup_flow_versions: null,
  };
  const eventos = [MEMBRO, MEMBRO_SEM_NOME, FORA].map((actor, i) => ({
    id: `ev${i}`,
    node_id: "n1",
    event_type: "manual_skip",
    payload: { actor_user_id: actor },
    created_at: "2026-11-01T00:00:00Z",
  }));
  return {
    from: (tabela: string) =>
      tabela === "followup_enrollments"
        ? cadeia({ data: linha, error: null })
        : cadeia({ data: eventos, error: null }),
  };
}

function adminDaInstalacao() {
  let org: unknown = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vinculos: any = {
    select: () => vinculos,
    eq: (_col: string, v: unknown) => ((org = v), vinculos),
    in: async () => ({
      data: org === ORG ? [{ user_id: MEMBRO }, { user_id: MEMBRO_SEM_NOME }] : [],
      error: null,
    }),
  };
  return {
    from: () => vinculos,
    auth: {
      admin: {
        getUserById: async (id: string) => ({ data: { user: USUARIOS[id] ?? null }, error: null }),
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.role.mockResolvedValue({ ok: true, user: { id: "eu", idioma: "pt-BR" }, org: { orgId: ORG, role: "viewer" } });
  deps.client.mockResolvedValue(clienteDaSessao());
  deps.admin.mockImplementation(adminDaInstalacao);
});

describe("GET /api/v1/ai/followups/enrollments/:id — autores", () => {
  it("só membro da organização ganha nome, e só o full_name (nunca e-mail)", async () => {
    const res = await GET(new NextRequest(`http://localhost/x/${ID}`), {
      params: Promise.resolve({ id: ID }),
    } as never);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { autores: Record<string, string> } };

    expect(data.autores).toEqual({ [MEMBRO]: "Ana" });
    expect(JSON.stringify(data.autores)).not.toContain("@");
  });
});
