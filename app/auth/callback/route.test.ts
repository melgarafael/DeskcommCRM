import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { aplicarConvite } from "@/lib/auth/aplicar-convite";
import { decidirConviteDoSignup } from "@/lib/auth/convite-no-signup";
import { ensureTenantForUser, vinculoAtivo } from "@/lib/auth/provision";
import { modoDeCadastro } from "@/lib/auth/politica-de-cadastro";
import { acessoFoiRevogado } from "@/lib/auth/vinculo-revogado";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /auth/callback — a volta da entrada com Google (issue #1388).
 *
 * O defeito que este arquivo existe para não deixar voltar: a volta do OAuth é
 * o ÚNICO ponto em que "entrar" e "criar conta" chegam juntos, sem e-mail no
 * meio para dizer qual é qual. Tratar todo mundo como cadastro novo tranca do
 * lado de fora quem já é de casa numa instalação `so_convite`; tratar todo mundo
 * como entrada abre organização para quem chegou sem convite. A bifurcação é o
 * VÍNCULO, e é ela que estes casos prendem.
 */

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/aplicar-convite", () => ({ aplicarConvite: vi.fn() }));
vi.mock("@/lib/auth/convite-no-signup", () => ({ decidirConviteDoSignup: vi.fn() }));
vi.mock("@/lib/auth/provision", () => ({
  ensureTenantForUser: vi.fn(async () => ({ provisioned: true })),
  vinculoAtivo: vi.fn(async () => null),
}));
vi.mock("@/lib/auth/politica-de-cadastro", () => ({ modoDeCadastro: vi.fn(async () => "aberto") }));
vi.mock("@/lib/auth/vinculo-revogado", () => ({ acessoFoiRevogado: vi.fn(async () => false) }));
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
  /** o que `exchangeCodeForSession` devolve */
  troca: { data: { user: unknown } | null; error: { message: string } | null };
  /** fatores TOTP que a conta já tem verificados */
  fatores?: { id: string; status: string }[];
}

function stubSupabase(c: Cenario) {
  return {
    auth: {
      exchangeCodeForSession: vi.fn(async () => c.troca),
      mfa: {
        listFactors: vi.fn(async () => ({ data: { totp: c.fatores ?? [] } })),
      },
    },
  };
}

function requisicao(qs: string) {
  return new NextRequest(`http://localhost:3000/auth/callback?${qs}`);
}

/** O destino do redirect, sem o host — é o que o teste realmente afirma. */
function destino(res: Response): string {
  const location = new URL(res.headers.get("location") ?? "");
  return location.pathname + location.search;
}

async function comSupabase(c: Cenario) {
  vi.mocked(createClient).mockResolvedValue(
    stubSupabase(c) as unknown as Awaited<ReturnType<typeof createClient>>,
  );
  return await import("./route");
}

describe("GET /auth/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aplicarConvite).mockResolvedValue({ ok: true, membershipId: "m1", mudou: true });
    vi.mocked(decidirConviteDoSignup).mockReturnValue({ tipo: "provisionar" });
    vi.mocked(vinculoAtivo).mockResolvedValue(null);
    vi.mocked(modoDeCadastro).mockResolvedValue("aberto");
    vi.mocked(acessoFoiRevogado).mockResolvedValue(false);
  });

  it("conta nova com convite na URL: grava o vínculo e entra no app, sem empresa nova", async () => {
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });
    vi.mocked(decidirConviteDoSignup).mockReturnValue({
      tipo: "convite",
      token: "tok",
      payload: PAYLOAD,
    } as ReturnType<typeof decidirConviteDoSignup>);

    const res = await GET(requisicao("code=abc&convite=tok"));

    // O convite da URL precisa CHEGAR à decisão: sem isto, quem foi convidado
    // e entrou com Google ganha uma organização própria.
    expect(vi.mocked(decidirConviteDoSignup)).toHaveBeenCalledWith(USUARIO, "tok");
    expect(vi.mocked(aplicarConvite)).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USUARIO.id, payload: PAYLOAD }),
    );
    expect(destino(res)).toBe("/app");
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
  });

  it("quem JÁ tem vínculo entra: vai para o destino pedido, e a política de cadastro não o alcança", async () => {
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });
    vi.mocked(vinculoAtivo).mockResolvedValue("org-existente");
    // Instalação fechada: quem já é de casa continua entrando.
    vi.mocked(modoDeCadastro).mockResolvedValue("so_convite");

    const res = await GET(requisicao("code=abc&next=%2Fapp%2Finbox"));

    expect(destino(res)).toBe("/app/inbox");
    expect(vi.mocked(decidirConviteDoSignup)).not.toHaveBeenCalled();
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
  });

  it("conta nova sem convite em instalação so_convite: recusa pela política, sem provisionar", async () => {
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });
    vi.mocked(modoDeCadastro).mockResolvedValue("so_convite");

    const res = await GET(requisicao("code=abc"));

    expect(destino(res)).toBe("/login?error=cadastro_por_convite");
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
  });

  it("conta nova sem convite em instalação com_aprovacao: vai pedir a empresa, sem provisionar", async () => {
    // Recorte do PR #714 (migration 0383). A empresa nasce só na aprovação do
    // administrador da instalação; a volta do Google não pode ser o atalho.
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });
    vi.mocked(modoDeCadastro).mockResolvedValue("com_aprovacao");

    const res = await GET(requisicao("code=abc"));

    expect(destino(res)).toBe("/get-started");
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
  });

  it("convite que não vale: falha FECHADA — não provisiona e diz o motivo", async () => {
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });
    vi.mocked(decidirConviteDoSignup).mockReturnValue({
      tipo: "recusar",
      motivo: "email_divergente",
    });

    const res = await GET(requisicao("code=abc&convite=de-outra-pessoa"));

    expect(destino(res)).toBe("/login?error=convite_invalido");
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
  });

  it("conta nova sem convite em instalação aberta: provisiona e entra no onboarding", async () => {
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });

    const res = await GET(requisicao("code=abc"));

    expect(vi.mocked(ensureTenantForUser)).toHaveBeenCalledWith(USUARIO, { source: "signup" });
    expect(destino(res)).toBe("/onboarding/welcome");
  });

  it("quem tem TOTP verificado não entra sem o segundo fator", async () => {
    const { GET } = await comSupabase({
      troca: { data: { user: USUARIO }, error: null },
      fatores: [{ id: "factor-1", status: "verified" }],
    });

    const res = await GET(requisicao("code=abc&next=%2Fapp%2Finbox"));

    expect(destino(res)).toBe("/login/mfa?factor=factor-1&next=%2Fapp%2Finbox");
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
  });

  it("code que não vira sessão: nenhum provisionamento, e a tela de login explica", async () => {
    const { GET } = await comSupabase({
      troca: { data: null, error: { message: "PKCE code verifier not found in storage" } },
    });

    const res = await GET(requisicao("code=abc"));

    expect(destino(res)).toBe("/login?error=entrada_com_google");
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
    expect(vi.mocked(vinculoAtivo)).not.toHaveBeenCalled();
  });

  it("desistência no Google: mensagem própria, e não se troca code nenhum", async () => {
    const { GET } = await comSupabase({ troca: { data: null, error: null } });

    const res = await GET(requisicao("error=access_denied&error_description=denied"));

    expect(destino(res)).toBe("/login?error=entrada_com_google_cancelada");
    expect(vi.mocked(createClient)).not.toHaveBeenCalled();
  });

  it("sem code nenhum: recusa em vez de tela em branco", async () => {
    const { GET } = await comSupabase({ troca: { data: null, error: null } });

    const res = await GET(requisicao(""));

    expect(destino(res)).toBe("/login?error=entrada_com_google");
    expect(vi.mocked(createClient)).not.toHaveBeenCalled();
  });

  it("banco fora no provisionamento: a sessão JÁ está firme, então manda pro /get-started", async () => {
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });
    vi.mocked(ensureTenantForUser).mockRejectedValueOnce(new Error("sem banco"));

    const res = await GET(requisicao("code=abc"));

    expect(destino(res)).toBe("/get-started");
  });

  it("membro com acesso revogado não vira admin de tenant novo: para na porta e diz o motivo", async () => {
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });
    vi.mocked(acessoFoiRevogado).mockResolvedValue(true);

    const res = await GET(requisicao("code=abc"));

    // `vinculoAtivo` não distingue "nunca pertenceu" de "teve o acesso
    // retirado" — e é essa diferença que impede a revogação de virar
    // organização nova com `role: "admin"`.
    expect(destino(res)).toBe("/login?error=acesso_revogado");
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
    expect(vi.mocked(aplicarConvite)).not.toHaveBeenCalled();
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.signup_provision_recusado",
        actorUserId: USUARIO.id,
        metadata: expect.objectContaining({ motivo: "acesso_revogado" }),
      }),
    );
  });

  it("a guarda do revogado vem ANTES da decisão de convite: o motivo auditado é o verdadeiro", async () => {
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });
    vi.mocked(acessoFoiRevogado).mockResolvedValue(true);

    const res = await GET(requisicao("code=abc&convite=de-outra-pessoa"));

    // Fora desta ordem a rota auditaria `convite_invalido` — motivo que não é a
    // verdade sobre o que aconteceu com quem foi revogado.
    expect(vi.mocked(decidirConviteDoSignup)).not.toHaveBeenCalled();
    expect(destino(res)).toBe("/login?error=acesso_revogado");
  });

  it("leitura do vínculo falhou: FALHA FECHADA — não provisiona e a tela diz o motivo", async () => {
    const { GET } = await comSupabase({ troca: { data: { user: USUARIO }, error: null } });
    vi.mocked(vinculoAtivo).mockRejectedValueOnce(new Error("sem banco"));

    const res = await GET(requisicao("code=abc"));

    // "não consegui ler" não é "não há vínculo": a rota não pode seguir para o
    // provisionamento por causa de um tropeço de leitura.
    expect(destino(res)).toBe("/login?error=entrada_com_google");
    expect(vi.mocked(ensureTenantForUser)).not.toHaveBeenCalled();
    expect(vi.mocked(decidirConviteDoSignup)).not.toHaveBeenCalled();
  });

  it("ramo anônimo não escreve no rastro: sem `code` não há linha de auditoria", async () => {
    const { GET } = await comSupabase({ troca: { data: null, error: null } });

    const res = await GET(requisicao(""));

    // Rota pública: um GET por requisição de qualquer anônimo não pode virar
    // escrita em `api_audit_log`.
    expect(destino(res)).toBe("/login?error=entrada_com_google");
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("desistência no Google também não escreve no rastro, mesmo com texto cru gigante na URL", async () => {
    const { GET } = await comSupabase({ troca: { data: null, error: null } });

    const res = await GET(requisicao(`error=access_denied&error_description=${"x".repeat(4000)}`));

    expect(destino(res)).toBe("/login?error=entrada_com_google_cancelada");
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});
