/**
 * O CADASTRO PRECISA DIZER QUANDO NÃO VAI EXISTIR E-MAIL PARA CLICAR.
 *
 * ─── O defeito, medido pela tela ────────────────────────────────────────────
 *
 * Provedor de auth com "Confirm email" DESLIGADO faz `signUp()` devolver uma
 * SESSÃO junto do usuário: a pessoa já entrou. Como a action devolvia só
 * `{ ok: true }`, a tela mostrava "Enviamos um link de confirmação para … abra
 * o e-mail e clique no link para ativar sua conta" — uma instrução impossível
 * de cumprir, porque e-mail nenhum foi enviado.
 *
 * Medido na `origin/main` @ `4d50f63f`, com `GOTRUE_MAILER_AUTOCONFIRM=true`,
 * dirigindo a tela: o texto acima aparecia, o cookie de sessão `sb-deskcomm-auth`
 * estava no browser, e `user_organizations` do usuário novo vinha `[]`. A pessoa
 * ficava esperando para sempre, autenticada e sem organização, sem motivo para
 * descobrir que a saída existe. Achado de @KIRAzinx566, com cliente real preso.
 *
 * ─── O que este arquivo guarda ──────────────────────────────────────────────
 *
 * Que `sessao_ativa` reflita a SESSÃO que o provedor devolveu — nos dois
 * sentidos. Guardar só o caso "com sessão" deixaria verde um `sessao_ativa: true`
 * constante, que mandaria para `/get-started` quem de fato precisa confirmar o
 * e-mail: pessoa sem sessão nenhuma, que cairia no `requireAuth()` e voltaria
 * para o login sem nunca ler que um e-mail a espera.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { modoDeCadastro } from "@/lib/auth/politica-de-cadastro";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
// Mockada aqui em vez de deixar bater no banco: a política é lida em TODO
// cadastro, e sem o mock cada caso deste arquivo tentaria uma conexão real.
vi.mock("@/lib/auth/politica-de-cadastro", () => ({
  modoDeCadastro: vi.fn(async () => "aberto"),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
}));

const signUpDoProvedor = vi.fn();

/** Um e-mail novo por caso: o teto de `signup` é por IP e por janela. */
let n = 0;
const entrada = () => ({
  org_name: "Plata Iphones",
  email: `cadastro-${++n}-${Date.now()}@exemplo.test`,
  password: "SenhaForte!2026",
  password_confirm: "SenhaForte!2026",
});

describe("signUp — a tela precisa saber se a sessão já veio aberta", () => {
  beforeEach(() => {
    vi.resetModules();
    signUpDoProvedor.mockReset();
    vi.mocked(headers).mockResolvedValue({
      // IP diferente a cada caso, pelo mesmo motivo do e-mail.
      get: (k: string) => (k === "x-forwarded-for" ? `198.51.100.${n % 250}` : null),
    } as never);
    vi.mocked(createClient).mockResolvedValue({
      auth: { signUp: signUpDoProvedor },
    } as never);
    vi.mocked(modoDeCadastro).mockResolvedValue("aberto");
  });

  it('"Confirm email" DESLIGADO: o provedor devolve sessão → sessao_ativa', async () => {
    // A forma exata que o GoTrue devolve com MAILER_AUTOCONFIRM=true.
    signUpDoProvedor.mockResolvedValue({
      data: { user: { id: "u-1" }, session: { access_token: "tok", refresh_token: "ref" } },
      error: null,
    });

    const { signUp } = await import("./signUp");
    const res = await signUp(entrada());

    expect(res).toEqual({ ok: true, sessao_ativa: true });
  });

  it("CONTROLE — confirmação LIGADA: sem sessão, a tela do e-mail continua certa", async () => {
    // Sem este caso, `sessao_ativa: true` fixo passaria — e mandaria para a
    // recuperação quem ainda nem tem sessão.
    signUpDoProvedor.mockResolvedValue({
      data: { user: { id: "u-2" }, session: null },
      error: null,
    });

    const { signUp } = await import("./signUp");
    const res = await signUp(entrada());

    expect(res).toEqual({ ok: true, sessao_ativa: false });
  });

  it("CONTROLE — o provedor recusar continua sendo erro, não sessão", async () => {
    signUpDoProvedor.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "signup disabled", status: 422 },
    });

    const { signUp } = await import("./signUp");
    const res = await signUp(entrada());

    expect(res).toEqual({ ok: false, error: "signup_failed" });
  });
});

/**
 * A instalação em `so_convite` (migration 0233).
 *
 * A tela de `/signup` também recusa, mas a tela é adulterável e esta action é
 * chamável direto — sem os casos abaixo, o modo fechado seria decoração.
 */
describe("signUp — instalação que só aceita convidados", () => {
  beforeEach(() => {
    vi.resetModules();
    signUpDoProvedor.mockReset();
    vi.mocked(headers).mockResolvedValue({
      get: (k: string) => (k === "x-forwarded-for" ? `203.0.113.${n % 250}` : null),
    } as never);
    vi.mocked(createClient).mockResolvedValue({
      auth: { signUp: signUpDoProvedor },
    } as never);
    vi.mocked(modoDeCadastro).mockResolvedValue("so_convite");
  });

  it("sem convite: recusa, e NÃO cria conta no provedor", async () => {
    const { signUp } = await import("./signUp");
    const res = await signUp(entrada());

    expect(res).toEqual({ ok: false, error: "somente_convite" });
    // A parte que importa: a recusa acontece ANTES do provedor. Se a conta
    // nascesse e só o provisionamento fosse barrado depois, a instalação
    // acumularia contas órfãs de quem nunca poderia entrar.
    expect(signUpDoProvedor).not.toHaveBeenCalled();
  });

  it("CONTROLE — com convite VÁLIDO, o modo fechado não atrapalha", async () => {
    // Sem este caso, uma recusa que ignorasse o convite passaria — e o modo
    // fechado trancaria justamente quem ele existe para deixar entrar. É o
    // mesmo erro que a regra de nginx cometeu na instalação real.
    const { signInviteToken, INVITE_TTL_SECONDS } = await import("@/lib/auth/invite-token");
    const dados = entrada();
    const token = signInviteToken({
      invite_id: "00000000-0000-4000-8000-000000000003",
      email: dados.email,
      organization_id: "00000000-0000-4000-8000-000000000001",
      role: "agent",
      exp: Math.floor(Date.now() / 1000) + INVITE_TTL_SECONDS,
    });
    signUpDoProvedor.mockResolvedValue({
      data: { user: { id: "u-3" }, session: null },
      error: null,
    });

    const { signUp } = await import("./signUp");
    const res = await signUp(
      { email: dados.email, password: dados.password, password_confirm: dados.password_confirm },
      token,
    );

    expect(res).toEqual({ ok: true, sessao_ativa: false });
    expect(signUpDoProvedor).toHaveBeenCalled();
  });
});
