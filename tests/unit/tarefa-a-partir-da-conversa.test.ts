/**
 * A TAREFA CRIADA DE DENTRO DO ATENDIMENTO (#2818).
 *
 * O que a rota precisa provar, no nível dela (não no da tela):
 *
 *   (a) criar a partir da conversa GRAVA o vínculo com a demanda — o id que
 *       veio no corpo vai para o insert e para a linha devolvida;
 *   (b) `GET ?demanda_id=` filtra SÓ as tarefas daquela demanda, e o filtro
 *       chega ao banco (não é descartado no caminho);
 *   (c) o caminho ANTIGO continua funcionando: sem `demanda_id` a tarefa nasce
 *       avulsa (ou presa só ao negócio/contato), sem inventar vínculo.
 *
 * O instrumento é um dublê do PostgREST que ANOTA o que foi tocado — o payload
 * do insert e os `.eq`. Sem ele, "gravou o vínculo" seria uma afirmação sobre o
 * que eu li no fonte, não sobre o que a rota fez.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
// Este teste isola o handler; a autoridade de suporte é exercitada na suíte
// própria (mesmo recorte de `tarefas-rota-nao-tem-porta-dos-fundos`).
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const DEMANDA = "66666666-6666-4666-8666-666666666666";
const CONTATO = "77777777-7777-4777-8777-777777777777";
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
 * Dublê do PostgREST. `inseridas` guarda o payload de cada insert; `filtros` os
 * `.eq`. `tabelas` fica de fora de propósito — aqui o alvo é o CONTEÚDO, e o
 * "só toca crm_tasks" já é vigiado por `tarefas-rota-nao-tem-porta-dos-fundos`.
 */
function fazerSupabase(respostas: Resposta[]) {
  const inseridas: Array<Record<string, unknown>> = [];
  const filtros: Array<[string, unknown]> = [];
  let i = 0;
  const proxima = (): Resposta => respostas[Math.min(i++, respostas.length - 1)] ?? { data: null };

  const from = () => {
    const elo: Record<string, unknown> = {};
    const devolve = () => {
      const r = proxima();
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    };
    for (const metodo of ["select", "update", "delete", "order", "limit", "in", "gte", "lte"]) {
      elo[metodo] = () => elo;
    }
    elo.insert = (linha: Record<string, unknown>) => {
      inseridas.push(linha);
      return elo;
    };
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
  return { inseridas, filtros };
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
  contact_id: CONTATO,
  demanda_id: DEMANDA,
  assigned_to: null,
  created_by: ANA,
  created_at: "2026-10-13T10:00:00.000Z",
  updated_at: "2026-10-13T10:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  sessao("agent");
});
describe("POST /api/v1/tasks — criar a partir da conversa (#2818)", () => {
  function pedido(corpo: Record<string, unknown>) {
    return new NextRequest("http://x/api/v1/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
  }

  it("⭐ grava o vínculo com a demanda e o contato da conversa", async () => {
    const espiao = fazerSupabase([{ data: { id: DEMANDA } }, { data: LINHA }]);
    const { POST } = await import("@/app/api/v1/tasks/route");

    const res = await POST(
      pedido({
        title: "Confirmar o orçamento amanhã",
        demanda_id: DEMANDA,
        contact_id: CONTATO,
      }),
    );

    expect(res.status).toBe(201);
    expect(espiao.inseridas).toHaveLength(1);
    expect(espiao.inseridas[0]).toMatchObject({
      title: "Confirmar o orçamento amanhã",
      demanda_id: DEMANDA,
      contact_id: CONTATO,
      organization_id: ORG,
      created_by: ANA,
    });
  });

  it("aceita a criação com a demanda (a coluna chegou ao insert, não ficou de fora)", async () => {
    const espiao = fazerSupabase([{ data: { id: DEMANDA } }, { data: LINHA }]);
    const { POST } = await import("@/app/api/v1/tasks/route");

    await POST(pedido({ title: "Verificar o orçamento", demanda_id: DEMANDA }));

    expect(Object.keys(espiao.inseridas[0] ?? {})).toContain("demanda_id");
  });

  it("(c) o caminho antigo continua: sem demanda_id a tarefa nasce avulsa", async () => {
    const espiao = fazerSupabase([{ data: { ...LINHA, demanda_id: null } }]);
    const { POST } = await import("@/app/api/v1/tasks/route");

    const res = await POST(pedido({ title: "Revisar os textos do agente" }));

    expect(res.status).toBe(201);
    expect(espiao.inseridas[0]?.demanda_id).toBeUndefined();
  });

  it("⭐ demanda de OUTRA organização é recusada com 422, e nada é gravado", async () => {
    // A conferência não acha a demanda na organização da sessão (maybeSingle →
    // null): a chave estrangeira sozinha aceitaria, porque não passa pela RLS.
    const espiao = fazerSupabase([{ data: null }, { data: LINHA }]);
    const { POST } = await import("@/app/api/v1/tasks/route");

    const res = await POST(pedido({ title: "Ligar", demanda_id: DEMANDA }));

    expect(res.status).toBe(422);
    expect(espiao.inseridas).toHaveLength(0);
    // A régua é a organização ATIVA da sessão, nunca algo vindo do corpo.
    expect(espiao.filtros).toContainEqual(["organization_id", ORG]);
    expect(espiao.filtros).toContainEqual(["id", DEMANDA]);
  });

  it("⭐ demanda ENCERRADA é recusada com 409, e nada é gravado (#2842)", async () => {
    // `current_demanda_id` segue apontando a demanda depois de "Encerrar demanda":
    // a tela antiga oferecia "Nova tarefa" e a tarefa nascia presa a um atendimento
    // que já acabou. A tela agora esconde a seção — e a rota recusa por si.
    const espiao = fazerSupabase([
      { data: { id: DEMANDA, fechada_em: "2026-10-13T18:00:00.000Z" } },
      { data: LINHA },
    ]);
    const { POST } = await import("@/app/api/v1/tasks/route");

    const res = await POST(pedido({ title: "Ligar", demanda_id: DEMANDA }));

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("state_conflict");
    expect(espiao.inseridas).toHaveLength(0);
  });

  it("falha ao conferir a demanda é 500, e nada é gravado (falha fechada)", async () => {
    const espiao = fazerSupabase([{ error: { message: "boom" } }, { data: LINHA }]);
    const { POST } = await import("@/app/api/v1/tasks/route");

    const res = await POST(pedido({ title: "Ligar", demanda_id: DEMANDA }));

    expect(res.status).toBe(500);
    expect(espiao.inseridas).toHaveLength(0);
  });

  it("demanda_id que não é uuid é recusado com 422, não gravado", async () => {
    const espiao = fazerSupabase([{ data: LINHA }]);
    const { POST } = await import("@/app/api/v1/tasks/route");

    const res = await POST(pedido({ title: "Ligar", demanda_id: "nao-e-uuid" }));

    expect(res.status).toBe(422);
    expect(espiao.inseridas).toHaveLength(0);
  });
});

describe("GET /api/v1/tasks?demanda_id= — a seção do inbox (#2818)", () => {
  it("⭐ filtra as tarefas de UMA demanda, e o filtro chega ao banco", async () => {
    const espiao = fazerSupabase([{ data: [LINHA] }]);
    const { GET } = await import("@/app/api/v1/tasks/route");

    const res = await GET(new NextRequest(`http://x/api/v1/tasks?demanda_id=${DEMANDA}`));

    expect(res.status).toBe(200);
    expect(espiao.filtros).toContainEqual(["demanda_id", DEMANDA]);
    // E a organização da SESSÃO segue junto: a RLS da demanda nova não substitui
    // o isolamento por organização que o CLAUDE.md exige à mão.
    expect(espiao.filtros).toContainEqual(["organization_id", ORG]);
  });

  it("sem demanda_id não filtra por demanda (a lista da tela continua inteira)", async () => {
    const espiao = fazerSupabase([{ data: [LINHA] }]);
    const { GET } = await import("@/app/api/v1/tasks/route");

    await GET(new NextRequest("http://x/api/v1/tasks"));

    expect(espiao.filtros.map(([coluna]) => coluna)).not.toContain("demanda_id");
  });

  it("demanda_id ilegível é 422, nunca uma lista que parece vazia", async () => {
    fazerSupabase([{ data: [] }]);
    const { GET } = await import("@/app/api/v1/tasks/route");

    const res = await GET(new NextRequest("http://x/api/v1/tasks?demanda_id=xxx"));

    expect(res.status).toBe(422);
  });
});

describe("PATCH /api/v1/tasks/[id] — vincular e desvincular (#2818)", () => {
  const ctx = { params: Promise.resolve({ id: TAREFA }) };
  function patch(corpo: Record<string, unknown>) {
    return new NextRequest(`http://x/api/v1/tasks/${TAREFA}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
  }

  it("vincular a demanda pela edição grava o id", async () => {
    fazerSupabase([{ data: { id: DEMANDA } }, { data: { status: "pending" } }, { data: LINHA }]);
    const { PATCH } = await import("@/app/api/v1/tasks/[id]/route");

    const res = await PATCH(patch({ demanda_id: DEMANDA }), ctx);

    expect(res.status).toBe(200);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { campos: ["demanda_id"] } }),
    );
  });

  it("⭐ vincular pela edição a demanda de OUTRA organização é 422, e a tarefa não muda", async () => {
    const espiao = fazerSupabase([{ data: null }, { data: { status: "pending" } }, { data: LINHA }]);
    const { PATCH } = await import("@/app/api/v1/tasks/[id]/route");

    const res = await PATCH(patch({ demanda_id: DEMANDA }), ctx);

    expect(res.status).toBe(422);
    expect(espiao.filtros).toContainEqual(["organization_id", ORG]);
    expect(espiao.filtros).toContainEqual(["id", DEMANDA]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("vincular pela edição a demanda ENCERRADA é 409, e a tarefa não muda (#2842)", async () => {
    fazerSupabase([
      { data: { id: DEMANDA, fechada_em: "2026-10-13T18:00:00.000Z" } },
      { data: { status: "pending" } },
      { data: LINHA },
    ]);
    const { PATCH } = await import("@/app/api/v1/tasks/[id]/route");

    const res = await PATCH(patch({ demanda_id: DEMANDA }), ctx);

    expect(res.status).toBe(409);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("desvincular (null) não consulta demanda nenhuma", async () => {
    const espiaoNulo = fazerSupabase([{ data: { status: "pending" } }, { data: { ...LINHA, demanda_id: null } }]);
    const { PATCH } = await import("@/app/api/v1/tasks/[id]/route");

    const res = await PATCH(patch({ demanda_id: null }), ctx);

    expect(res.status).toBe(200);
    expect(espiaoNulo.filtros).not.toContainEqual(["id", DEMANDA]);
  });
});
