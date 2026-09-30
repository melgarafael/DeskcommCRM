/**
 * PATCH .../members/[userId]/email — o admin da plataforma corrige o e-mail de
 * login de um membro.
 *
 * O que não pode regredir:
 *  - a troca vai ao GoTrue com `email_confirm: true` (sem SMTP, a confirmação
 *    no endereço novo nunca chegaria);
 *  - e-mail já usado por outro login vira 409 com mensagem clara, não 500;
 *  - o alvo precisa pertencer ao tenant do path;
 *  - admin da plataforma não tem o e-mail trocado por outro admin (tomada de conta);
 *  - a auditoria guarda só HASH, nunca o endereço em claro.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/requirePlatformAdminWrite", () => ({ requirePlatformAdminWrite: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  hashEmail: (e: string) => `h${e.length}`,
}));

import { audit } from "@/lib/audit";
import { requirePlatformAdminWrite } from "@/lib/auth/requirePlatformAdminWrite";
import { createAdminClient } from "@/lib/supabase/admin";

import { PATCH } from "./route";

const ORG = "22222222-2222-4222-8222-222222222222";
const ALVO = "33333333-3333-4333-8333-333333333333";
const ADMIN = "11111111-1111-4111-8111-111111111111";

function adminFalso(opts: {
  membro?: boolean;
  ehAdminDaPlataforma?: boolean;
  emailAtual?: string;
  erroNoUpdate?: { code?: string; message: string } | null;
}) {
  const updateUserById = vi.fn(async () => ({ data: {}, error: opts.erroNoUpdate ?? null }));
  const leitura = (data: unknown) => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.is = () => b;
    b.maybeSingle = async () => ({ data, error: null });
    return b;
  };
  const admin = {
    from: (t: string) =>
      t === "user_organizations"
        ? leitura(opts.membro === false ? null : { user_id: ALVO })
        : leitura(opts.ehAdminDaPlataforma ? { user_id: ALVO } : null),
    auth: {
      admin: {
        getUserById: vi.fn(async () => ({
          data: { user: { id: ALVO, email: opts.emailAtual ?? "errado@exemplo.com" } },
          error: null,
        })),
        updateUserById,
      },
    },
  };
  vi.mocked(createAdminClient).mockReturnValue(admin as never);
  return { updateUserById };
}

function pedir(email: unknown) {
  return PATCH(
    new NextRequest(`http://x/api/v1/admin/tenants/${ORG}/members/${ALVO}/email`, {
      method: "PATCH",
      body: JSON.stringify({ email }),
    }),
    { params: Promise.resolve({ id: ORG, userId: ALVO }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePlatformAdminWrite).mockResolvedValue({
    ok: true,
    ctx: {
      user: { id: ADMIN },
      platformAdmin: { user_id: ADMIN, scope: "full", mfa_required: false },
    },
  } as never);
});

describe("troca de e-mail de membro", () => {
  it("troca no GoTrue com email_confirm e normaliza para minúsculas", async () => {
    const { updateUserById } = adminFalso({});
    const res = await pedir("  Certo@Exemplo.COM ");
    expect(res.status).toBe(200);
    expect(updateUserById).toHaveBeenCalledWith(ALVO, {
      email: "certo@exemplo.com",
      email_confirm: true,
    });
  });

  it("audita só hashes — o e-mail em claro não entra no registro", async () => {
    adminFalso({});
    await pedir("certo@exemplo.com");
    const chamada = vi.mocked(audit).mock.calls[0]![0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(chamada.action).toBe("member.email_changed");
    expect(JSON.stringify(chamada.metadata)).not.toContain("certo@exemplo.com");
    expect(chamada.metadata.email_hash_novo).toBe(`h${"certo@exemplo.com".length}`);
  });

  it("e-mail já usado por outro login: 409, sem 500", async () => {
    adminFalso({
      erroNoUpdate: {
        code: "email_exists",
        message: "A user with this email address has already been registered",
      },
    });
    const res = await pedir("ocupado@exemplo.com");
    expect(res.status).toBe(409);
  });

  it("mesmo e-mail de hoje: 409 e nenhuma chamada ao GoTrue", async () => {
    const { updateUserById } = adminFalso({ emailAtual: "igual@exemplo.com" });
    const res = await pedir("IGUAL@exemplo.com");
    expect(res.status).toBe(409);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("formato inválido: 400", async () => {
    adminFalso({});
    expect((await pedir("nao-e-email")).status).toBe(400);
  });

  it("quem não é membro deste tenant: 404", async () => {
    const { updateUserById } = adminFalso({ membro: false });
    expect((await pedir("certo@exemplo.com")).status).toBe(404);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("admin da plataforma: 403 — não se toma a conta de outro admin por aqui", async () => {
    const { updateUserById } = adminFalso({ ehAdminDaPlataforma: true });
    expect((await pedir("certo@exemplo.com")).status).toBe(403);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("sem escopo full / MFA: a guarda de escrita barra antes de tudo", async () => {
    const { updateUserById } = adminFalso({});
    vi.mocked(requirePlatformAdminWrite).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    expect((await pedir("certo@exemplo.com")).status).toBe(403);
    expect(updateUserById).not.toHaveBeenCalled();
  });
});
