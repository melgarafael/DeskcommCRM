import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

import { POST } from "./route";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const OUTRO = "33333333-3333-4333-8333-333333333333";
const NEGOCIO = "44444444-4444-4444-8444-444444444444";
const FUNIL = "55555555-5555-4555-8555-555555555555";

/**
 * Banco falso mínimo: contatos num mapa, leads/pipeline configuráveis por
 * teste, atividades capturadas. O `await` direto no builder (sem terminal) é
 * o que `negocioAbertoDoContato` faz — por isso o fake é thenable.
 *
 * ─── SABOTAGEM (prova no CI) ───────────────────────────────────────────────
 * - Trocar `"manager"` por `"agent"` na rota: atendente marcaria e o caso
 *   "atendente recebe 403" acusaria.
 * - Reutilizar `contact.blocked` na auditoria: o caso "nomes exatos" acusa
 *   (critério 9 — evento novo de propósito, nunca o de descadastro).
 * - Auditar antes de filtrar por organização: o caso "id de outra org" acusa.
 * Linha para reverter: `app/api/v1/contacts/[id]/personal/route.ts`.
 */

interface LinhaContato {
  id: string;
  organization_id: string;
  display_name: string | null;
  is_personal: boolean;
}

let contatos: Record<string, LinhaContato>;
let leadsAbertos: Array<Record<string, unknown>>;
let funilPadrao: { id: string } | null;
let atividades: Array<Record<string, unknown>>;
let falharUpdate = false;

const contexto = (id = CONTATO) => ({ params: Promise.resolve({ id }) });
const req = () => new NextRequest(`http://localhost/api/v1/contacts/${CONTATO}/personal`, { method: "POST" });

function fakeQuery(tabela: string) {
  const estado = {
    op: "select" as "select" | "update" | "insert",
    patch: {} as Record<string, unknown>,
    filtros: {} as Record<string, unknown>,
  };
  const resultado = () => {
    if (tabela === "contacts" && estado.op === "update") {
      const linha = Object.values(contatos).find(
        (c) => c.id === estado.filtros["id"] && c.organization_id === estado.filtros["organization_id"],
      );
      if (falharUpdate) return { data: null, error: { message: "boom" } };
      if (!linha) return { data: null, error: null };
      Object.assign(linha, estado.patch);
      return { data: { ...linha }, error: null };
    }
    if (tabela === "contacts") {
      const linha = Object.values(contatos).find(
        (c) => c.id === estado.filtros["id"] && c.organization_id === estado.filtros["organization_id"],
      );
      return { data: linha ? { ...linha } : null, error: null };
    }
    if (tabela === "crm_leads") return { data: leadsAbertos, error: null };
    if (tabela === "crm_pipelines") return { data: funilPadrao, error: null };
    if (tabela === "crm_lead_activities" && estado.op === "insert") return { data: null, error: null };
    return { data: [], error: null };
  };
  const q = {
    select: () => q,
    update: (p: Record<string, unknown>) => {
      estado.op = "update";
      estado.patch = p;
      return q;
    },
    insert: (linha: Record<string, unknown>) => {
      estado.op = "insert";
      atividades.push(linha);
      return q;
    },
    eq: (k: string, v: unknown) => {
      estado.filtros[k] = v;
      return q;
    },
    in: () => q,
    is: () => q,
    order: () => q,
    limit: () => q,
    maybeSingle: async () => resultado(),
    single: async () => resultado(),
    then: (res: (v: unknown) => unknown) => Promise.resolve(resultado()).then(res),
  };
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  contatos = {
    [CONTATO]: { id: CONTATO, organization_id: ORG, display_name: "Mello", is_personal: false },
  };
  leadsAbertos = [];
  funilPadrao = null;
  atividades = [];
  falharUpdate = false;
  vi.mocked(loadAuthUser).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ORG, idioma: "pt-BR" },
    org: { orgId: ORG, role: "manager" },
  } as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => fakeQuery(tabela),
    // A remoção dos trechos de RAG (#2394) devolve a contagem; sem trechos, 0.
    rpc: async () => ({ data: 0, error: null }),
  } as unknown as ReturnType<typeof createAdminClient>);
  vi.mocked(audit).mockResolvedValue(undefined);
});

describe("marcar contato como pessoal (spec 21, etapa 3)", () => {
  it("só gerente e dono marcam — atendente recebe 403", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden", "Acesso negado.", 403),
    });
    const resposta = await POST(req(), contexto());
    expect(resposta.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "contacts" }));
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("suporte readonly nega antes de service role e auditoria", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue({
      id: ORG,
      is_platform_admin: true,
      support: { organization_id: ORG, status: "active", access_mode: "support_readonly" },
    } as Awaited<ReturnType<typeof loadAuthUser>>);
    const resposta = await POST(req(), contexto());
    expect(resposta.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("id fora do formato de uuid morre em 422, sem tocar o banco", async () => {
    const resposta = await POST(req(), contexto("nao-e-uuid"));
    expect(resposta.status).toBe(422);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("id de outra org não marca — 404", async () => {
    const resposta = await POST(req(), contexto(OUTRO));
    expect(resposta.status).toBe(404);
    expect(contatos[CONTATO]!.is_personal).toBe(false);
  });

  it("manager marca: liga a coluna e audita o evento NOVO, sem telefone", async () => {
    const resposta = await POST(req(), contexto());
    expect(resposta.status).toBe(200);
    expect(contatos[CONTATO]!.is_personal).toBe(true);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact.marked_personal",
        actorUserId: ORG,
        organizationId: ORG,
        resourceType: "contact",
        resourceId: CONTATO,
      }),
    );
    const metadata = vi.mocked(audit).mock.calls[0]?.[0]?.metadata ?? {};
    expect(JSON.stringify(metadata)).not.toContain("+55");
    expect(JSON.stringify(metadata)).toContain(CONTATO);
  });

  it("nomes exatos: nunca reutiliza evento de bloqueio (critério 9)", async () => {
    await POST(req(), contexto());
    const acao = vi.mocked(audit).mock.calls[0]?.[0]?.action;
    expect(acao).toBe("contact.marked_personal");
    expect(acao).not.toBe("contact.blocked");
  });

  it("já pessoal é idempotente: não reaudita nem relinha a timeline", async () => {
    contatos[CONTATO]!.is_personal = true;
    const resposta = await POST(req(), contexto());
    expect(resposta.status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
    expect(atividades).toHaveLength(0);
  });

  it("sem negócio aberto: só auditoria, timeline pulada em silêncio (D6)", async () => {
    await POST(req(), contexto());
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "contact.marked_personal" }));
    expect(atividades).toHaveLength(0);
  });

  it("com negócio aberto: timeline com o tipo novo e o negócio certo", async () => {
    leadsAbertos = [
      { id: NEGOCIO, organization_id: ORG, pipeline_id: FUNIL, status: "open", last_activity_at: null, created_at: "2026-01-01T00:00:00Z" },
    ];
    funilPadrao = { id: FUNIL };
    await POST(req(), contexto());
    expect(atividades).toHaveLength(1);
    expect(atividades[0]).toMatchObject({
      organization_id: ORG,
      lead_id: NEGOCIO,
      contact_id: CONTATO,
      type: "contact_marked_personal",
    });
  });

  it("falha do banco vira 500 e NÃO audita sucesso", async () => {
    falharUpdate = true;
    const resposta = await POST(req(), contexto());
    expect(resposta.status).toBe(500);
    expect(audit).not.toHaveBeenCalled();
  });
});
