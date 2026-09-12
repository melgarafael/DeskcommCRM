import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { aplicarConvite } from "@/lib/auth/aplicar-convite";
import { decidirConviteDoSignup } from "@/lib/auth/convite-no-signup";
import { ensureTenantForUser } from "@/lib/auth/provision";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /auth/confirm — a rota tem de TERMINAR O SERVIÇO.
 *
 * Dois defeitos medidos numa instalação real em 2026-09-10, com o mesmo
 * convidado, nas duas tentativas:
 *
 * 1. Quem confirmava o e-mail vindo de um convite era redirecionado para uma
 *    tela com um botão "Aceitar convite". Ninguém chegava a apertá-lo, e a
 *    pessoa terminava autenticada, SEM organização e SEM menu — porque o
 *    vínculo (`user_organizations`) é o que dá as duas coisas.
 *
 * 2. Clicar duas vezes no link do e-mail mandava para `/login?error=...`
 *    alguém que ESTAVA LOGADO: o token é de uso único, o segundo clique falha,
 *    mas o `@supabase/ssr` não apaga o cookie de sessão (medido em rig). A
 *    pessoa reentrava pela senha e perdia o fio do convite.
 *
 * O que NÃO pode regredir: sem token válido E sem sessão, a recusa continua
 * sendo recusa — senão a rota vira porta aberta.
 */

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/aplicar-convite", () => ({ aplicarConvite: vi.fn() }));
vi.mock("@/lib/auth/convite-no-signup", () => ({ decidirConviteDoSignup: vi.fn() }));
vi.mock("@/lib/auth/provision", () => ({ ensureTenantForUser: vi.fn(async () => undefined) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "http://localhost:3000" } }));

const USUARIO = { id: "11111111-1111-4111-8111-111111111111", email: "convidado@example.com" };
const PAYLOAD = {
  invite_id: "22222222-2222-4222-8222-222222222222",
  email: "convidado@example.com",
  organization_id: "33333333-3333-4333-8333-333333333333",
  role: "manager",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

interface Cenario {
  /** o que `verifyOtp` devolve — o `null` simula token de uso único já gasto */
  verifyOtp: { data: { user: unknown }; error: { message: string } | null };
  /** o que `getUser()` devolve depois — a sessão que o 1º clique deixou */
  getUser: { data: { user: unknown } };
}

function stubSupabase(c: Cenario) {
  return {
    auth: {
      verifyOtp: vi.fn(async () => c.verifyOtp),
      exchangeCodeForSession: vi.fn(async () => c.verifyOtp),
      getUser: vi.fn(async () => c.getUser),
    },
  };
}

function requisicao(qs: string) {
  return new NextRequest(`http://localhost:3000/auth/confirm?${qs}`);
}

/** O destino do redirect, sem o host — é o que o teste realmente afirma. */
function destino(res: Response): string {
  return new URL(res.headers.get("location") ?? "").pathname + new URL(res.headers.get("location") ?? "").search;
}

describe("GET /auth/confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aplicarConvite).mockResolvedValue({ ok: true, membershipId: "m1", mudou: true });
  });

  function comSupabase(c: Cenario) {
    vi.mocked(createClient).mockResolvedValue(
      stubSupabase(c) as unknown as Awaited<ReturnType<typeof createClient>>,
    );
  }

  it("convite válido: grava o vínculo e entra no app, sem tela intermediária", async () => {
    comSupabase({ verifyOtp: { data: { user: USUARIO }, error: null }, getUser: { data: { user: null } } });
    vi.mocked(decidirConviteDoSignup).mockReturnValue({
      tipo: "convite",
      token: "tok",
      payload: PAYLOAD,
    } as ReturnType<typeof decidirConviteDoSignup>);

    const { GET } = await import("./route");
    const res = await GET(requisicao("type=signup&token_hash=abc"));

    expect(vi.mocked(aplicarConvite)).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USUARIO.id, payload: PAYLOAD }),
    );
    expect(destino(res)).toBe("/app");
    // Quem foi convidado NÃO ganha organização própria.
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
  });

  it("segundo clique no mesmo link: mantém quem já está logado, não manda pro login", async () => {
    comSupabase({
      verifyOtp: { data: { user: null }, error: { message: "Email link is invalid or has expired" } },
      getUser: { data: { user: USUARIO } },
    });
    vi.mocked(decidirConviteDoSignup).mockReturnValue({
      tipo: "convite",
      token: "tok",
      payload: PAYLOAD,
    } as ReturnType<typeof decidirConviteDoSignup>);

    const { GET } = await import("./route");
    const res = await GET(requisicao("type=signup&token_hash=ja-usado"));

    expect(destino(res)).toBe("/app");
    expect(destino(res)).not.toContain("/login");
  });

  it("link inválido E sem sessão: continua sendo recusa", async () => {
    comSupabase({
      verifyOtp: { data: { user: null }, error: { message: "Email link is invalid or has expired" } },
      getUser: { data: { user: null } },
    });

    const { GET } = await import("./route");
    const res = await GET(requisicao("type=signup&token_hash=lixo"));

    expect(destino(res)).toBe("/login?error=link_invalido");
    expect(vi.mocked(aplicarConvite)).not.toHaveBeenCalled();
  });

  it("template padrão (formato code) sem sessão: mantém o diagnóstico próprio", async () => {
    comSupabase({
      verifyOtp: { data: { user: null }, error: { message: "PKCE code verifier not found in storage" } },
      getUser: { data: { user: null } },
    });

    const { GET } = await import("./route");
    const res = await GET(requisicao("code=abc"));

    expect(destino(res)).toBe("/login?error=template_padrao");
  });

  it("vínculo falhou: degrada para a tela de aceite, nunca deixa sem saída", async () => {
    comSupabase({ verifyOtp: { data: { user: USUARIO }, error: null }, getUser: { data: { user: null } } });
    vi.mocked(decidirConviteDoSignup).mockReturnValue({
      tipo: "convite",
      token: "tok-123",
      payload: PAYLOAD,
    } as ReturnType<typeof decidirConviteDoSignup>);
    vi.mocked(aplicarConvite).mockResolvedValue({ ok: false, motivo: "invalid_or_expired" });

    const { GET } = await import("./route");
    const res = await GET(requisicao("type=signup&token_hash=abc"));

    expect(destino(res)).toBe("/team/accept-invite/tok-123");
  });

  it("sem convite: segue provisionando a própria organização, como antes", async () => {
    comSupabase({ verifyOtp: { data: { user: USUARIO }, error: null }, getUser: { data: { user: null } } });
    vi.mocked(decidirConviteDoSignup).mockReturnValue({ tipo: "provisionar" });

    const { GET } = await import("./route");
    const res = await GET(requisicao("type=signup&token_hash=abc"));

    expect(vi.mocked(ensureTenantForUser)).toHaveBeenCalledWith(USUARIO);
    expect(vi.mocked(aplicarConvite)).not.toHaveBeenCalled();
    expect(destino(res)).toBe("/onboarding/welcome");
  });
});
