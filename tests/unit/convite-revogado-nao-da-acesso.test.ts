/**
 * CONVITE REVOGADO NÃO DÁ ACESSO — NEM COMO MEMBRO, NEM COMO DONO DE UM TENANT.
 *
 * ## A propriedade, em uma frase
 *
 * Quem teve o convite (ou o vínculo) revogado não entra na organização E não
 * ganha uma empresa própria. As duas metades importam: recusar o vínculo e
 * deixar a pessoa cair no provisionamento normal seria trocar "entrou na
 * empresa errada" por "ganhou uma empresa só dela dentro da instalação" —
 * pior, e silencioso.
 *
 * ## Por que agora, e por que este arquivo não é de nenhum dos dois PRs
 *
 * O token de convite é um HMAC com validade: `verifyInviteToken` confere
 * assinatura e `exp`, e mais nada. Um convite revogado continua com token
 * perfeitamente válido — quem sabe que ele morreu é a linha em `team_invites`.
 *
 * O PR #682 acrescenta a política `so_convite`, que muda o SIGNIFICADO de ter
 * um convite: numa instalação fechada, o convite deixa de ser um atalho e passa
 * a ser a única porta. Isso aumenta o prêmio de um token revogado. A main, por
 * seu lado, trouxe as guardas (`aplicarConvite` lendo `revoked_at`,
 * `acessoFoiRevogado` na recuperação). Nenhum dos dois lados, sozinho, tinha
 * motivo para medir o ENCONTRO — e é o encontro que esta cerca fecha.
 *
 * ## O que foi medido antes de escrever (2026-09-14)
 *
 *  - `/auth/confirm` tinha um caso de "vínculo falhou → degrada para a tela de
 *    aceite", mas ele não afirmava o que mais importa: que `ensureTenantForUser`
 *    NÃO é chamado. O degradê estava guardado; a troca silenciosa, não.
 *  - `recoverOrganization` — a guarda `acessoFoiRevogado` entrou na main sem
 *    teste algum (`git show origin/main:app/actions/auth/recoverOrganization.test.ts`
 *    não menciona revogação em lugar nenhum).
 *
 * A terceira porta (`aplicarConvite`, onde a linha é lida) tem cerca própria em
 * `lib/auth/aplicar-convite.test.ts` — aqui o módulo precisa ser mockado para
 * medir o que a ROTA faz com a recusa dele.
 *
 * ## Comando
 *
 *     npx vitest run tests/unit/convite-revogado-nao-da-acesso.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ORG = "33333333-3333-4333-8333-333333333333";
const USUARIO = { id: "11111111-1111-4111-8111-111111111111", email: "revogada@example.com" };

const PAYLOAD = {
  invite_id: "22222222-2222-4222-8222-222222222222",
  email: USUARIO.email,
  organization_id: ORG,
  role: "manager" as const,
  exp: Math.floor(Date.now() / 1000) + 3600,
};

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "http://localhost:3000" } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/aplicar-convite", () => ({ aplicarConvite: vi.fn() }));
vi.mock("@/lib/auth/convite-no-signup", () => ({ decidirConviteDoSignup: vi.fn() }));
vi.mock("@/lib/auth/provision", () => ({ ensureTenantForUser: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/politica-de-cadastro", () => ({ modoDeCadastro: vi.fn(async () => "aberto") }));
vi.mock("@/lib/auth/vinculo-revogado", () => ({ acessoFoiRevogado: vi.fn(async () => false) }));
vi.mock("@/lib/auth/rate-limit", () => ({
  authRateLimited: vi.fn(async () => false),
  AUTH_LIMITS: { org_recovery: { tokens: 3, window: "1 h" } },
}));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: vi.fn(async () => USUARIO),
  resolveActiveOrg: vi.fn(async () => null),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  }),
}));

/** O destino do redirect da rota, sem o host — é o que o teste afirma. */
function destino(res: Response): string {
  const u = new URL(res.headers.get("location") ?? "");
  return u.pathname + u.search;
}

// ───────────────────────────────────────────────────────────────────────────
// PORTA 2 — `/auth/confirm`: o caminho de quem ainda NÃO tem conta, e que
// justamente por isso foi o que escapou da primeira versão da guarda.
// ───────────────────────────────────────────────────────────────────────────

describe("porta 2 — /auth/confirm não transforma revogado em dono de tenant", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const { createClient } = await import("@/lib/supabase/server");
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        verifyOtp: vi.fn(async () => ({ data: { user: USUARIO }, error: null })),
        exchangeCodeForSession: vi.fn(async () => ({ data: { user: USUARIO }, error: null })),
        getUser: vi.fn(async () => ({ data: { user: null } })),
      },
    } as never);
    const { decidirConviteDoSignup } = await import("@/lib/auth/convite-no-signup");
    vi.mocked(decidirConviteDoSignup).mockReturnValue({
      tipo: "convite",
      token: "tok-revogado",
      payload: PAYLOAD,
    } as never);
    const { modoDeCadastro } = await import("@/lib/auth/politica-de-cadastro");
    vi.mocked(modoDeCadastro).mockResolvedValue("aberto" as never);
  });

  async function confirmar() {
    const { GET } = await import("@/app/auth/confirm/route");
    return GET(new NextRequest("http://localhost:3000/auth/confirm?type=signup&token_hash=abc"));
  }

  it("⭐ convite revogado NÃO vira organização própria — a troca silenciosa", async () => {
    const { aplicarConvite } = await import("@/lib/auth/aplicar-convite");
    vi.mocked(aplicarConvite).mockResolvedValue({ ok: false, motivo: "invalid_or_expired" });
    const { ensureTenantForUser } = await import("@/lib/auth/provision");

    const res = await confirmar();

    expect(
      ensureTenantForUser,
      "o convite revogado caiu no provisionamento normal: em vez de barrado, quem foi desconvidado ganhou uma EMPRESA PRÓPRIA dentro da instalação",
    ).not.toHaveBeenCalled();
    expect(destino(res)).toBe("/team/accept-invite/tok-revogado");
  });

  it("⭐ nem numa instalação FECHADA o revogado escapa por outra saída", async () => {
    // A política `so_convite` é avaliada DEPOIS da bifurcação do convite: quem
    // tem token (ainda que revogado) sai antes dela. Logo a recusa do revogado
    // não pode depender da política — tem de vir da porta 1. Este caso prende
    // essa ordem: se alguém mover a guarda de política para antes, ou remover a
    // checagem da porta 1, é aqui que aparece.
    const { modoDeCadastro } = await import("@/lib/auth/politica-de-cadastro");
    vi.mocked(modoDeCadastro).mockResolvedValue("so_convite" as never);
    const { aplicarConvite } = await import("@/lib/auth/aplicar-convite");
    vi.mocked(aplicarConvite).mockResolvedValue({ ok: false, motivo: "invalid_or_expired" });
    const { ensureTenantForUser } = await import("@/lib/auth/provision");

    const res = await confirmar();

    expect(ensureTenantForUser).not.toHaveBeenCalled();
    expect(destino(res)).toBe("/team/accept-invite/tok-revogado");
  });

  it("convite vivo entra na organização — vacuidade da porta 2", async () => {
    const { aplicarConvite } = await import("@/lib/auth/aplicar-convite");
    vi.mocked(aplicarConvite).mockResolvedValue({ ok: true, membershipId: "m1", mudou: true });

    expect(destino(await confirmar())).toBe("/app");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PORTA 3 — `recoverOrganization`: a saída de emergência, que provisiona.
// ───────────────────────────────────────────────────────────────────────────

describe("porta 3 — recoverOrganization recusa quem teve o acesso revogado", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const { createClient } = await import("@/lib/supabase/server");
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: USUARIO } })) },
    } as never);
    const { decidirConviteDoSignup } = await import("@/lib/auth/convite-no-signup");
    vi.mocked(decidirConviteDoSignup).mockReturnValue({ tipo: "provisionar" } as never);
    const { modoDeCadastro } = await import("@/lib/auth/politica-de-cadastro");
    vi.mocked(modoDeCadastro).mockResolvedValue("aberto" as never);
    // `clearAllMocks` zera CHAMADAS, não implementações: sem estes dois, o
    // `mockResolvedValue` de um caso vaza para o seguinte e o arquivo mede a
    // ordem em que os casos rodam em vez de medir o código.
    const { acessoFoiRevogado } = await import("@/lib/auth/vinculo-revogado");
    vi.mocked(acessoFoiRevogado).mockResolvedValue(false);
    const { ensureTenantForUser } = await import("@/lib/auth/provision");
    vi.mocked(ensureTenantForUser).mockResolvedValue({ organizationId: ORG } as never);
  });

  it("⭐ vínculo revogado não vira tenant novo pela tela de recuperação", async () => {
    // Sem esta guarda, revogar alguém lhe dava, na prática, um tenant próprio
    // dentro da mesma instalação: bastava chegar sem organização e pedir a
    // recuperação, que é uma tela pública para quem tem sessão.
    const { acessoFoiRevogado } = await import("@/lib/auth/vinculo-revogado");
    vi.mocked(acessoFoiRevogado).mockResolvedValue(true);
    const { ensureTenantForUser } = await import("@/lib/auth/provision");

    const { recoverOrganization } = await import("@/app/actions/auth/recoverOrganization");
    const r = await recoverOrganization("Empresa da Revogada");

    expect(
      r,
      "quem teve o vínculo retirado por um administrador conseguiu abrir a própria empresa pela tela de recuperação",
    ).toEqual({ ok: false, error: "access_revoked" });
    expect(ensureTenantForUser).not.toHaveBeenCalled();
  });

  it("⭐ instalação fechada também recusa a recuperação — a QUARTA porta", async () => {
    // O #682 chama isto de "a quarta porta, que não estava no desenho original".
    // Numa instalação `so_convite`, esta action seria a saída de emergência que
    // reabre o que as outras três fecharam.
    const { modoDeCadastro } = await import("@/lib/auth/politica-de-cadastro");
    vi.mocked(modoDeCadastro).mockResolvedValue("so_convite" as never);
    const { ensureTenantForUser } = await import("@/lib/auth/provision");

    const { recoverOrganization } = await import("@/app/actions/auth/recoverOrganization");
    const r = await recoverOrganization("Empresa de Quem Não Foi Convidado");

    expect(r).toEqual({ ok: false, error: "somente_convite" });
    expect(ensureTenantForUser).not.toHaveBeenCalled();
  });

  it("instalação aberta e acesso íntegro: provisiona — vacuidade da porta 3", async () => {
    // Sem este caso, as duas recusas acima ficariam verdes num código que
    // recusasse TUDO, e a tela de recuperação estaria quebrada sem ninguém ver.
    const { ensureTenantForUser } = await import("@/lib/auth/provision");
    vi.mocked(ensureTenantForUser).mockResolvedValue({ organizationId: ORG } as never);

    const { recoverOrganization } = await import("@/app/actions/auth/recoverOrganization");
    await expect(recoverOrganization("Empresa Legítima")).rejects.toThrow(
      "REDIRECT:/onboarding/welcome",
    );
    expect(ensureTenantForUser).toHaveBeenCalled();
  });
});
