/**
 * O RESPONSÁVEL DE UMA TAREFA É DA MESMA EQUIPE — e quem garante é a ROTA.
 *
 * `lib/tarefas/responsavel.test.ts` prova a régua (`conferirResponsavel`). Este
 * arquivo prova que `POST /api/v1/tasks` e `PATCH /api/v1/tasks/[id]` a CHAMAM,
 * com a organização da SESSÃO, antes de tocar `crm_tasks`. Sem ele, apagar o
 * bloco de conferência das duas rotas deixava a suíte inteira verde (medido na
 * triagem do PR #2760: 5 arquivos, 49 casos, zero vermelho) — e
 * `crm_tasks.assigned_to` só tem chave estrangeira para `auth.users`: o banco
 * aceita um usuário de QUALQUER organização da instalação.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => true,
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const DE_FORA = "66666666-6666-4666-8666-666666666666";
const TAREFA = "55555555-5555-4555-8555-555555555555";

function sessao(papel: Role = "agent") {
  const user: AuthUser = {
    id: ANA,
    email: "ana@example.com",
    full_name: "Ana",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: papel }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) =>
    ROLE_RANK[papel] >= ROLE_RANK[min]
      ? { ok: true, user, org: { orgId: ORG, name: "Org", role: papel } }
      : { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) },
  );
}

const LINHA = {
  id: TAREFA,
  organization_id: ORG,
  title: "Ligar de volta",
  description: null,
  due_date: null,
  priority: "medium",
  status: "pending",
  lead_id: null,
  contact_id: null,
  assigned_to: ANA,
  created_by: ANA,
  created_at: "2026-10-11T10:00:00.000Z",
  updated_at: "2026-10-11T10:00:00.000Z",
};

interface Resposta {
  data?: unknown;
  error?: { message: string } | null;
}

/** Dublê que anota, por client, as tabelas tocadas e os filtros `eq`. */
function duble(respostas: Resposta[]) {
  const tabelas: string[] = [];
  const filtros: Array<[string, unknown]> = [];
  let i = 0;
  const from = (tabela: string) => {
    tabelas.push(tabela);
    const r = respostas[Math.min(i++, respostas.length - 1)] ?? {};
    const devolve = () => Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    const elo: Record<string, unknown> = {};
    for (const m of ["select", "insert", "update", "delete", "order", "limit", "in", "is", "neq"]) {
      elo[m] = () => elo;
    }
    elo.eq = (coluna: string, valor: unknown) => (filtros.push([coluna, valor]), elo);
    elo.single = devolve;
    elo.maybeSingle = devolve;
    elo.then = (res: (v: unknown) => unknown) => devolve().then(res);
    return elo;
  };
  return { client: { from }, tabelas, filtros };
}

/** A equipe (admin client) e as tarefas (client da sessão), cada uma com o seu duble. */
function montar(equipe: Resposta, tarefas: Resposta[]) {
  const e = duble([equipe]);
  const t = duble(tarefas);
  vi.mocked(createAdminClient).mockReturnValue(e.client as never);
  vi.mocked(createClient).mockResolvedValue(t.client as never);
  return { equipe: e, tarefas: t };
}

function post(corpo: Record<string, unknown>) {
  return new NextRequest("http://x/api/v1/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

function patch(corpo: Record<string, unknown>) {
  return new NextRequest(`http://x/api/v1/tasks/${TAREFA}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

const ctx = { params: Promise.resolve({ id: TAREFA }) };

beforeEach(() => {
  vi.clearAllMocks();
  sessao();
});

describe("POST /api/v1/tasks — responsável", () => {
  it("⭐ responsável fora da equipe é 422, e a tarefa NÃO é gravada", async () => {
    const m = montar({ data: null }, [{ data: LINHA }]);
    const { POST } = await import("@/app/api/v1/tasks/route");

    const res = await POST(post({ title: "Ligar de volta", assigned_to: DE_FORA }));

    expect(res.status).toBe(422);
    expect(m.tarefas.tabelas).toEqual([]);
  });

  it("a equipe consultada é a da SESSÃO, e o membro é aceito", async () => {
    const m = montar({ data: { user_id: ANA } }, [{ data: LINHA }]);
    const { POST } = await import("@/app/api/v1/tasks/route");

    const res = await POST(post({ title: "Ligar de volta", assigned_to: ANA }));

    expect(res.status).toBe(201);
    expect(m.equipe.tabelas).toEqual(["user_organizations"]);
    expect(m.equipe.filtros).toContainEqual(["organization_id", ORG]);
    expect(m.equipe.filtros).toContainEqual(["user_id", ANA]);
  });

  it("erro ao consultar a equipe é 500, nunca aceite", async () => {
    const m = montar({ error: { message: "timeout" } }, [{ data: LINHA }]);
    const { POST } = await import("@/app/api/v1/tasks/route");

    const res = await POST(post({ title: "Ligar de volta", assigned_to: ANA }));

    expect(res.status).toBe(500);
    expect(m.tarefas.tabelas).toEqual([]);
  });

  it("sem responsável, a equipe nem é consultada", async () => {
    const m = montar({ data: null }, [{ data: { ...LINHA, assigned_to: null } }]);
    const { POST } = await import("@/app/api/v1/tasks/route");

    const res = await POST(post({ title: "Ligar de volta" }));

    expect(res.status).toBe(201);
    expect(m.equipe.tabelas).toEqual([]);
  });
});

describe("PATCH /api/v1/tasks/[id] — responsável", () => {
  it("⭐ trocar para alguém fora da equipe é 422, e a tarefa NÃO é tocada", async () => {
    const m = montar({ data: null }, [{ data: { status: "pending" } }, { data: LINHA }]);
    const { PATCH } = await import("@/app/api/v1/tasks/[id]/route");

    const res = await PATCH(patch({ assigned_to: DE_FORA }), ctx);

    expect(res.status).toBe(422);
    expect(m.tarefas.tabelas).toEqual([]);
  });

  it("editar só o título não consulta a equipe", async () => {
    const m = montar({ data: null }, [{ data: { status: "pending" } }, { data: LINHA }]);
    const { PATCH } = await import("@/app/api/v1/tasks/[id]/route");

    const res = await PATCH(patch({ title: "Ligar na sexta" }), ctx);

    expect(res.status).toBe(200);
    expect(m.equipe.tabelas).toEqual([]);
  });
});
