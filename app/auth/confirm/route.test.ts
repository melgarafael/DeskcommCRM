import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { aplicarConvite } from "@/lib/auth/aplicar-convite";
import { decidirConviteDoSignup } from "@/lib/auth/convite-no-signup";
import { ensureTenantForUser } from "@/lib/auth/provision";
import { modoDeCadastro } from "@/lib/auth/politica-de-cadastro";
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
 *
 * 3. ABRIR o link não pode gastar o token. Medido numa instalação real em
 *    2026-10-03 (Supabase Auth logs): ~12 s depois de cada e-mail de
 *    recuperação para um endereço Hotmail, um `verify` com 200 consumia o
 *    token — o verificador de links da Microsoft visitando o link antes da
 *    pessoa — e o clique de verdade, segundos depois, caía em
 *    `One-time token not found` → `/login?error=link_invalido`. Por isso o
 *    GET com `token_hash` só leva à tela de confirmação, e quem gasta o token
 *    é o POST do botão "Continuar", que nenhum verificador aperta.
 */

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/aplicar-convite", () => ({ aplicarConvite: vi.fn() }));
vi.mock("@/lib/auth/convite-no-signup", () => ({ decidirConviteDoSignup: vi.fn() }));
vi.mock("@/lib/auth/provision", () => ({ ensureTenantForUser: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/politica-de-cadastro", () => ({ modoDeCadastro: vi.fn(async () => "aberto") }));
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

/** O POST do botão "Continuar" da tela de confirmação — quem de fato gasta o token. */
function envio(qs: string) {
  return new NextRequest("http://localhost:3000/auth/confirm", {
    method: "POST",
    body: new URLSearchParams(qs),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}

/** O destino do redirect, sem o host — é o que o teste realmente afirma. */
function destino(res: Response): string {
  return new URL(res.headers.get("location") ?? "").pathname + new URL(res.headers.get("location") ?? "").search;
}

describe("GET /auth/confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aplicarConvite).mockResolvedValue({ ok: true, membershipId: "m1", mudou: true });
    vi.mocked(modoDeCadastro).mockResolvedValue("aberto");
  });

  function comSupabase(c: Cenario) {
    vi.mocked(createClient).mockResolvedValue(
      stubSupabase(c) as unknown as Awaited<ReturnType<typeof createClient>>,
    );
  }

  it("abrir o link (GET com token_hash) NÃO gasta o token: leva à tela de confirmação", async () => {
    const supabase = stubSupabase({
      verifyOtp: { data: { user: USUARIO }, error: null },
      getUser: { data: { user: null } },
    });
    vi.mocked(createClient).mockResolvedValue(supabase as unknown as Awaited<ReturnType<typeof createClient>>);

    const { GET } = await import("./route");
    const res = await GET(requisicao("type=recovery&token_hash=pkce_abc"));

    // Quem abre o link sem apertar nada — o verificador do Hotmail — não chega
    // ao provedor de auth: o token continua vivo para o clique da pessoa.
    expect(supabase.auth.verifyOtp).not.toHaveBeenCalled();
    const alvo = new URL(res.headers.get("location") ?? "");
    expect(alvo.pathname).toBe("/login/continuar");
    expect(alvo.searchParams.get("type")).toBe("recovery");
    expect(alvo.searchParams.get("token_hash")).toBe("pkce_abc");
  });

  it("o botão Continuar (POST) gasta o token e redireciona com 303, nunca reenviando o POST", async () => {
    comSupabase({ verifyOtp: { data: { user: USUARIO }, error: null }, getUser: { data: { user: null } } });

    const { POST } = await import("./route");
    const res = await POST(envio("type=recovery&token_hash=pkce_abc"));

    // 307/308 repetiriam o POST no destino; 303 vira GET, que é o que /login/reset espera.
    expect(res.status).toBe(303);
    expect(destino(res)).toBe("/login/reset");
  });

  it("GET sem token nenhum: continua recusando", async () => {
    const { GET } = await import("./route");
    const res = await GET(requisicao(""));

    expect(destino(res)).toBe("/login?error=link_invalido");
  });

  it("POST sem token nenhum: recusa, não chama o provedor", async () => {
    const supabase = stubSupabase({
      verifyOtp: { data: { user: null }, error: null },
      getUser: { data: { user: null } },
    });
    vi.mocked(createClient).mockResolvedValue(supabase as unknown as Awaited<ReturnType<typeof createClient>>);

    const { POST } = await import("./route");
    const res = await POST(envio(""));

    expect(supabase.auth.verifyOtp).not.toHaveBeenCalled();
    expect(destino(res)).toBe("/login?error=link_invalido");
  });

  it("convite válido: grava o vínculo e entra no app, sem tela intermediária", async () => {
    comSupabase({ verifyOtp: { data: { user: USUARIO }, error: null }, getUser: { data: { user: null } } });
    vi.mocked(decidirConviteDoSignup).mockReturnValue({
      tipo: "convite",
      token: "tok",
      payload: PAYLOAD,
    } as ReturnType<typeof decidirConviteDoSignup>);

    const { POST } = await import("./route");
    const res = await POST(envio("type=signup&token_hash=abc"));

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

    const { POST } = await import("./route");
    const res = await POST(envio("type=signup&token_hash=ja-usado"));

    expect(destino(res)).toBe("/app");
    expect(destino(res)).not.toContain("/login");
  });

  it("link inválido E sem sessão: continua sendo recusa", async () => {
    comSupabase({
      verifyOtp: { data: { user: null }, error: { message: "Email link is invalid or has expired" } },
      getUser: { data: { user: null } },
    });

    const { POST } = await import("./route");
    const res = await POST(envio("type=signup&token_hash=lixo"));

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

    const { POST } = await import("./route");
    const res = await POST(envio("type=signup&token_hash=abc"));

    expect(destino(res)).toBe("/team/accept-invite/tok-123");
  });

  it("sem convite: segue provisionando a própria organização, como antes", async () => {
    comSupabase({ verifyOtp: { data: { user: USUARIO }, error: null }, getUser: { data: { user: null } } });
    vi.mocked(decidirConviteDoSignup).mockReturnValue({ tipo: "provisionar" });

    const { POST } = await import("./route");
    const res = await POST(envio("type=signup&token_hash=abc"));

    expect(vi.mocked(ensureTenantForUser)).toHaveBeenCalledWith(USUARIO);
    expect(vi.mocked(aplicarConvite)).not.toHaveBeenCalled();
    expect(destino(res)).toBe("/onboarding/welcome");
  });

  it("sem convite em instalação com_aprovacao: e-mail confirmado, mas a empresa espera o pedido", async () => {
    // Recorte do PR #714 (migration 0383). O e-mail acabou de ser provado pelo
    // `verifyOtp` do provedor; a empresa só nasce na aprovação do administrador.
    comSupabase({ verifyOtp: { data: { user: USUARIO }, error: null }, getUser: { data: { user: null } } });
    vi.mocked(decidirConviteDoSignup).mockReturnValue({ tipo: "provisionar" });
    vi.mocked(modoDeCadastro).mockResolvedValue("com_aprovacao");

    const { POST } = await import("./route");
    const res = await POST(envio("type=signup&token_hash=abc"));

    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
    expect(destino(res)).toBe("/get-started");
  });

  it("convite válido em instalação com_aprovacao: entra direto, o convite já é a aprovação", async () => {
    comSupabase({ verifyOtp: { data: { user: USUARIO }, error: null }, getUser: { data: { user: null } } });
    vi.mocked(decidirConviteDoSignup).mockReturnValue({
      tipo: "convite",
      token: "tok",
      payload: PAYLOAD,
    } as ReturnType<typeof decidirConviteDoSignup>);
    vi.mocked(modoDeCadastro).mockResolvedValue("com_aprovacao");

    const { POST } = await import("./route");
    const res = await POST(envio("type=signup&token_hash=abc"));

    expect(destino(res)).toBe("/app");
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
  });
});
