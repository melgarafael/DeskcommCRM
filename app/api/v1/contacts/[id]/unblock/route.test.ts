import { beforeEach, describe, expect, it, vi } from "vitest";
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

const org = "11111111-1111-4111-8111-111111111111";
const contato = "22222222-2222-4222-8222-222222222222";
const outroContato = "33333333-3333-4333-8333-333333333333";

const filters: Record<string, unknown> = {};
/** O UPDATE que a rota mandou — é o que prova que ela limpa os três campos. */
let patchEnviado: Record<string, unknown> | null = null;
let resultRow: Record<string, unknown> | null = null;
let updateError: { message: string } | null = null;

const contexto = (id = contato) => ({ params: Promise.resolve({ id }) });
const req = () =>
  new NextRequest(`http://localhost/api/v1/contacts/${contato}/unblock`, { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(filters)) delete filters[k];
  patchEnviado = null;
  resultRow = { id: contato, display_name: "Mello", phone_number: "+5541999953255", is_blocked: false, blocked_reason: null, blocked_at: null };
  updateError = null;
  vi.mocked(loadAuthUser).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: org },
    org: { orgId: org, role: "admin" },
  } as Awaited<ReturnType<typeof requireRole>>);

  const query = {
    update: (valores: Record<string, unknown>) => {
      patchEnviado = valores;
      return query;
    },
    eq: (k: string, v: unknown) => {
      filters[k] = v;
      return query;
    },
    select: () => query,
    maybeSingle: async () => {
      if (updateError) return { data: null, error: updateError };
      // O recorte por organização e por id é o que impede um id de OUTRA
      // organização de ser desbloqueado — e o falso banco precisa cobrá-lo.
      const casa = filters["id"] === contato && filters["organization_id"] === org;
      return { data: casa ? resultRow : null, error: null };
    },
  };
  vi.mocked(createAdminClient).mockReturnValue({
    from: () => query,
  } as unknown as ReturnType<typeof createAdminClient>);
});

describe("desbloquear contato (override da regra W-02)", () => {
  it("exige ADMIN — não é edição de cadastro, é reabrir um canal fechado", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden", "Acesso negado.", 403),
    });
    const resposta = await POST(req(), contexto());
    expect(resposta.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("admin", expect.objectContaining({ resource: "contacts" }));
    // Negado não toca o banco nem audita: a ordem importa.
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("suporte readonly nega antes de service role e auditoria", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue({
      id: org,
      is_platform_admin: true,
      support: { organization_id: org, status: "active", access_mode: "support_readonly" },
    } as Awaited<ReturnType<typeof loadAuthUser>>);
    const resposta = await POST(req(), contexto());
    expect(resposta.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("limpa os TRÊS campos — sobrar `blocked_reason` deixaria o selo mentindo", async () => {
    const resposta = await POST(req(), contexto());
    expect(resposta.status).toBe(200);
    expect(patchEnviado).toEqual({ is_blocked: false, blocked_reason: null, blocked_at: null });
  });

  it("filtra por organização ALÉM do id — id de outra org não desbloqueia", async () => {
    const resposta = await POST(req(), contexto(outroContato));
    expect(resposta.status).toBe(404);
    expect(filters["organization_id"]).toBe(org);
    // O UPDATE foi montado, mas o recorte não casou: ninguém foi tocado.
    expect(patchEnviado).toEqual({ is_blocked: false, blocked_reason: null, blocked_at: null });
  });

  it("audita `contact.unblocked` com ator, organização e contato — e SEM telefone", async () => {
    await POST(req(), contexto());
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact.unblocked",
        actorUserId: org,
        organizationId: org,
        resourceType: "contact",
        resourceId: contato,
      }),
    );
    // Auditoria não é lugar de dado pessoal: o telefone já circula em outra
    // tabela, e o `contact_id` identifica sem expor.
    const metadata = vi.mocked(audit).mock.calls[0]?.[0]?.metadata ?? {};
    expect(JSON.stringify(metadata)).not.toContain("+5541999953255");
  });

  it("id fora do formato de uuid morre em 422, sem tocar o banco", async () => {
    const resposta = await POST(req(), contexto("nao-e-uuid"));
    expect(resposta.status).toBe(422);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("falha do banco vira 500 e NÃO audita sucesso", async () => {
    updateError = { message: "boom" };
    const resposta = await POST(req(), contexto());
    expect(resposta.status).toBe(500);
    expect(audit).not.toHaveBeenCalled();
  });
});
