import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

import { DELETE, POST } from "./route";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const OUTRO = "33333333-3333-4333-8333-333333333333";

/**
 * Contato "sempre atendimento humano" (issue 2379) — a rota usa o admin client,
 * então quem prova o filtro por organização é este arquivo.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Trocar `"manager"` por `"agent"`: o caso do 403 acusa.
 * - Tirar `.eq("organization_id", orgId)` da leitura e do update: o caso
 *   "id de outra org" acusa (o contato da outra org seria marcado).
 * - Pôr `display_name` no metadata da auditoria: o caso "sem nome" acusa.
 * - Fazer o desmarcar limpar `force_human`: o caso do DELETE acusa.
 */

interface LinhaContato {
  id: string;
  organization_id: string;
  display_name: string | null;
  ai_opt_out: boolean;
  force_human: boolean;
}

let contatos: LinhaContato[];
let falharUpdate = false;

const contexto = (id = CONTATO) => ({ params: Promise.resolve({ id }) });
const req = (method: "POST" | "DELETE") =>
  new NextRequest(`http://localhost/api/v1/contacts/${CONTATO}/always-human`, { method });

function fakeQuery() {
  let patch: Record<string, unknown> | null = null;
  const filtros: Record<string, unknown> = {};
  // Sem filtro de organização, o fake casa só pelo id — é o que deixa a
  // sabotagem do filtro aparecer como contato de outra org alterado.
  const casa = (c: LinhaContato) =>
    c.id === filtros["id"] && (!("organization_id" in filtros) || c.organization_id === filtros["organization_id"]);
  const q = {
    select: () => q,
    update: (p: Record<string, unknown>) => {
      patch = p;
      return q;
    },
    eq: (k: string, v: unknown) => {
      filtros[k] = v;
      return q;
    },
    maybeSingle: async () => {
      const linha = contatos.find(casa);
      if (patch) {
        if (falharUpdate) return { data: null, error: { message: "boom" } };
        if (!linha) return { data: null, error: null };
        Object.assign(linha, patch);
      }
      return { data: linha ? { ...linha } : null, error: null };
    },
  };
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  contatos = [
    { id: CONTATO, organization_id: ORG, display_name: "Mello", ai_opt_out: false, force_human: false },
    { id: OUTRO, organization_id: "99999999-9999-4999-8999-999999999999", display_name: "Alheio", ai_opt_out: false, force_human: false },
  ];
  falharUpdate = false;
  vi.mocked(loadAuthUser).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ORG, idioma: "pt-BR" },
    org: { orgId: ORG, role: "manager" },
  } as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(createAdminClient).mockReturnValue({
    from: () => fakeQuery(),
  } as unknown as ReturnType<typeof createAdminClient>);
  vi.mocked(audit).mockResolvedValue(undefined);
});

const meu = () => contatos[0]!;

describe("contato sempre atendimento humano (issue 2379)", () => {
  it("só gerente e dono marcam — atendente recebe 403 sem tocar o banco", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: fail("forbidden", "Acesso negado.", 403) });
    const resposta = await POST(req("POST"), contexto());
    expect(resposta.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "contacts" }));
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("suporte readonly nega o POST e o DELETE antes do service role", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue({
      id: ORG,
      is_platform_admin: true,
      support: { organization_id: ORG, status: "active", access_mode: "support_readonly" },
    } as Awaited<ReturnType<typeof loadAuthUser>>);
    expect((await POST(req("POST"), contexto())).status).toBe(403);
    expect((await DELETE(req("DELETE"), contexto())).status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("id fora do formato de uuid morre em 422, sem tocar o banco", async () => {
    expect((await POST(req("POST"), contexto("nao-e-uuid"))).status).toBe(422);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("id de outra org não marca — 404, nada alterado, nada auditado", async () => {
    const resposta = await POST(req("POST"), contexto(OUTRO));
    expect(resposta.status).toBe(404);
    expect(contatos[1]).toMatchObject({ ai_opt_out: false, force_human: false });
    expect(audit).not.toHaveBeenCalled();
  });

  it("marcar liga a marca E a trava, e audita sem o nome do contato", async () => {
    const resposta = await POST(req("POST"), contexto());
    expect(resposta.status).toBe(200);
    expect(meu()).toMatchObject({ ai_opt_out: true, force_human: true });
    expect(audit).toHaveBeenCalledTimes(1);
    const chamada = vi.mocked(audit).mock.calls[0]![0];
    expect(chamada).toMatchObject({
      action: "contacts.always_human_marked",
      organizationId: ORG,
      resourceType: "contact",
      resourceId: CONTATO,
    });
    expect(JSON.stringify(chamada.metadata)).toContain(CONTATO);
    expect(JSON.stringify(chamada.metadata)).not.toContain("Mello");
  });

  it("marcar de novo não reaudita, mas cura a marca pela metade (trava solta)", async () => {
    meu().ai_opt_out = true;
    const resposta = await POST(req("POST"), contexto());
    expect(resposta.status).toBe(200);
    expect(meu().force_human).toBe(true);
    expect(audit).not.toHaveBeenCalled();
  });

  it("desmarcar limpa só a marca: NÃO devolve o atendimento", async () => {
    Object.assign(meu(), { ai_opt_out: true, force_human: true });
    const resposta = await DELETE(req("DELETE"), contexto());
    expect(resposta.status).toBe(200);
    expect(meu()).toMatchObject({ ai_opt_out: false, force_human: true });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "contacts.always_human_unmarked" }));
  });

  it("desmarcar quem não estava marcado não audita", async () => {
    expect((await DELETE(req("DELETE"), contexto())).status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });

  it("falha do banco vira 500 e NÃO audita sucesso", async () => {
    falharUpdate = true;
    expect((await POST(req("POST"), contexto())).status).toBe(500);
    expect(audit).not.toHaveBeenCalled();
  });
});
