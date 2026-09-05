/**
 * A ROTA DE TAREFAS NÃO TEM PORTA DOS FUNDOS.
 *
 * Este arquivo guarda o que a EXTRAÇÃO do PR #418 tirou, e por isso ele existe:
 * um teste que só exercitasse o caminho feliz ficaria verde com o fallback de
 * volta.
 *
 * ─── O que o original fazia ────────────────────────────────────────────────
 *
 * `GET`, `POST`, `PATCH` e `DELETE` capturavam `42P01`/`PGRST205` — "a tabela
 * não existe" — e passavam a ler e gravar as tarefas dentro de
 * `crm_leads.custom_fields.tasks`. Lá aquilo era rede de verdade: a tabela
 * vivia só no `baseline.sql`, sem arquivo de migration, então quem aplicasse
 * `migrations/` não a teria. Aqui a 0210 fecha a lacuna, e a mesma rede vira o
 * pior tipo de silêncio — ela transforma "o banco desta instalação está
 * desatualizado" em 200 OK, com o dado indo para um jsonb que nenhuma lista,
 * índice ou policy alcança. Um mês depois, a tarefa some e ninguém sabe por quê.
 *
 * ─── E o que ele MISTURAVA ─────────────────────────────────────────────────
 *
 * O `GET` também varria `crm_leads` procurando `agendamento_data`,
 * `agendamento_hora` e `procedimento` para sintetizar "agendamentos". Isso é
 * vocabulário de um nicho, e uma segunda verdade ao lado de
 * `calendar_appointments` (migration 0177). O caso `só toca crm_tasks` prende
 * as duas ausências de uma vez: qualquer volta a `crm_leads` reprova.
 */
import { NextRequest } from "next/server";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const ANA = "11111111-1111-4111-8111-111111111111";
const LEAD = "44444444-4444-4444-8444-444444444444";
const TAREFA = "55555555-5555-4555-8555-555555555555";

function sessao(papel: Role) {
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

interface Resposta {
  data?: unknown;
  error?: { code?: string; message: string } | null;
}

/**
 * Dublê do PostgREST que ANOTA o que foi tocado.
 *
 * `tabelas` é o instrumento: sem ele, "não caiu no fallback" seria uma
 * afirmação sobre o que eu li no fonte, e não sobre o que a rota fez.
 */
function fazerSupabase(respostas: Resposta[]) {
  const tabelas: string[] = [];
  const filtros: Array<[string, unknown]> = [];
  let i = 0;
  const proxima = (): Resposta => respostas[Math.min(i++, respostas.length - 1)] ?? { data: null };

  const from = (tabela: string) => {
    tabelas.push(tabela);
    const elo: Record<string, unknown> = {};
    const devolve = () => {
      const r = proxima();
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    };
    for (const metodo of ["select", "insert", "update", "delete", "order", "limit", "in", "gte", "lte"]) {
      elo[metodo] = () => elo;
    }
    elo.eq = (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return elo;
    };
    elo.single = devolve;
    elo.maybeSingle = devolve;
    elo.then = (res: (v: unknown) => unknown) => devolve().then(res);
    return elo;
  };
  vi.mocked(createClient).mockResolvedValue({ from } as never);
  return { tabelas, filtros };
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
  assigned_to: null,
  created_by: ANA,
  created_at: "2026-09-02T10:00:00.000Z",
  updated_at: "2026-09-02T10:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  sessao("agent");
});

describe("GET /api/v1/tasks", () => {
  it("filtra pela org da SESSÃO, mesmo com outra org na query", async () => {
    const espiao = fazerSupabase([{ data: [LINHA] }]);
    const { GET } = await import("@/app/api/v1/tasks/route");

    const res = await GET(
      new NextRequest(`http://x/api/v1/tasks?organization_id=${OUTRA_ORG}`),
    );

    expect(res.status).toBe(200);
    expect(espiao.filtros).toContainEqual(["organization_id", ORG]);
    expect(espiao.filtros.flat()).not.toContain(OUTRA_ORG);
  });

  it("só toca crm_tasks — nada de agendamento derivado de custom_fields", async () => {
    const espiao = fazerSupabase([{ data: [LINHA] }]);
    const { GET } = await import("@/app/api/v1/tasks/route");

    await GET(new NextRequest("http://x/api/v1/tasks"));

    expect(espiao.tabelas).toEqual(["crm_tasks"]);
  });

  it('"a tabela não existe" vira 500, nunca 200 com o dado em outro lugar', async () => {
    const espiao = fazerSupabase([
      { error: { code: "42P01", message: 'relation "crm_tasks" does not exist' } },
    ]);
    const { GET } = await import("@/app/api/v1/tasks/route");

    const res = await GET(new NextRequest("http://x/api/v1/tasks"));

    expect(res.status).toBe(500);
    expect(espiao.tabelas).toEqual(["crm_tasks"]);
  });
});

describe("POST /api/v1/tasks", () => {
  function pedido(corpo: Record<string, unknown>) {
    return new NextRequest("http://x/api/v1/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
  }

  it("grava com a org e o autor da sessão, audita e devolve 201", async () => {
    const espiao = fazerSupabase([{ data: LINHA }]);
    const { POST } = await import("@/app/api/v1/tasks/route");

    const res = await POST(pedido({ title: "Ligar de volta" }));

    expect(res.status).toBe(201);
    expect(espiao.tabelas).toEqual(["crm_tasks"]);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "crm_task.created",
        organizationId: ORG,
        actorUserId: ANA,
      }),
    );
  });

  it("tarefa presa a um negócio deixa linha na timeline dele", async () => {
    fazerSupabase([{ data: { ...LINHA, lead_id: LEAD } }]);
    const { POST } = await import("@/app/api/v1/tasks/route");

    await POST(pedido({ title: "Ligar de volta", lead_id: LEAD }));

    expect(vi.mocked(emitLeadActivity)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ leadId: LEAD, type: "task_created" }),
    );
  });

  it("tarefa SOLTA não inventa timeline — lead_id é not null lá", async () => {
    fazerSupabase([{ data: LINHA }]);
    const { POST } = await import("@/app/api/v1/tasks/route");

    await POST(pedido({ title: "Revisar os textos do agente" }));

    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("título vazio é recusado com 422, não gravado como espaço", async () => {
    fazerSupabase([{ data: LINHA }]);
    const { POST } = await import("@/app/api/v1/tasks/route");

    const res = await POST(pedido({ title: "   " }));

    expect(res.status).toBe(422);
  });

  it("viewer não cria tarefa", async () => {
    sessao("viewer");
    fazerSupabase([{ data: LINHA }]);
    const { POST } = await import("@/app/api/v1/tasks/route");

    const res = await POST(pedido({ title: "Ligar de volta" }));

    expect(res.status).toBe(403);
  });
});

describe("PATCH e DELETE /api/v1/tasks/[id]", () => {
  const ctx = { params: Promise.resolve({ id: TAREFA }) };

  function patch(corpo: Record<string, unknown>) {
    return new NextRequest(`http://x/api/v1/tasks/${TAREFA}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
  }

  it("concluir uma tarefa aberta deixa UMA linha de conclusão na timeline", async () => {
    // 1ª resposta: o status ANTES. 2ª: a linha depois do update.
    fazerSupabase([
      { data: { status: "pending" } },
      { data: { ...LINHA, lead_id: LEAD, status: "done" } },
    ]);
    const { PATCH } = await import("@/app/api/v1/tasks/[id]/route");

    const res = await PATCH(patch({ status: "done" }), ctx);

    expect(res.status).toBe(200);
    expect(vi.mocked(emitLeadActivity)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(emitLeadActivity)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "task_completed" }),
    );
  });

  it("salvar de novo uma tarefa JÁ concluída não repete a linha", async () => {
    // Sem a leitura do estado anterior, cada PATCH numa tarefa fechada escreveria
    // "concluída" outra vez — e a timeline passaria a contar um fato que não
    // aconteceu.
    fazerSupabase([
      { data: { status: "done" } },
      { data: { ...LINHA, lead_id: LEAD, status: "done" } },
    ]);
    const { PATCH } = await import("@/app/api/v1/tasks/[id]/route");

    await PATCH(patch({ status: "done" }), ctx);

    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("PATCH vazio é 422 — a tela não pode dizer 'salvo' sobre nada", async () => {
    fazerSupabase([{ data: LINHA }]);
    const { PATCH } = await import("@/app/api/v1/tasks/[id]/route");

    const res = await PATCH(patch({}), ctx);

    expect(res.status).toBe(422);
  });

  it("apagar tarefa de outra organização é 404, não 200", async () => {
    // O `.eq(organization_id)` casa zero linhas. Sem o `.select()` no delete,
    // isso devolveria 200 e a tela sumiria com uma linha que ninguém apagou.
    const espiao = fazerSupabase([{ data: [] }]);
    const { DELETE } = await import("@/app/api/v1/tasks/[id]/route");

    const res = await DELETE(new NextRequest(`http://x/api/v1/tasks/${TAREFA}`), ctx);

    expect(res.status).toBe(404);
    expect(espiao.filtros).toContainEqual(["organization_id", ORG]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});
