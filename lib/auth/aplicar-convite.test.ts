/**
 * CONVITE REVOGADO NÃO VIRA VÍNCULO — a porta onde a LINHA é consultada.
 *
 * ## Por que esta cerca existe
 *
 * Revogar um convite é um ato de segurança: alguém que ia entrar não vai mais.
 * O token, porém, continua na caixa de e-mail da pessoa, e ele é um HMAC com
 * validade — `verifyInviteToken` confere ASSINATURA e `exp`, e mais nada
 * (`lib/auth/invite-token.ts`). Nenhuma verificação de token sabe que o convite
 * morreu: quem sabe é a linha em `team_invites`.
 *
 * Esta casa já pagou uma vez por isso. O cabeçalho do módulo conta: a checagem
 * nasceu no BOTÃO de aceite (PR #664), e quem chegasse pelo OUTRO caminho —
 * confirmar o e-mail — passava por cima dela. Era o caminho de quem ainda não
 * tem conta, ou seja, o caso comum.
 *
 * Medido em 2026-09-14: o módulo não tinha arquivo de teste nenhum. É a peça de
 * que a segurança de `/auth/confirm` inteiramente depende — a cerca de lá
 * (`tests/unit/convite-revogado-nao-da-acesso.test.ts`) precisa mockar este
 * módulo para medir o degradê, então só este arquivo prova que a recusa existe.
 *
 * ## Comando
 *
 *     npx vitest run lib/auth/aplicar-convite.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "33333333-3333-4333-8333-333333333333";
const CONVITE = "22222222-2222-4222-8222-222222222222";
const USUARIO_ID = "11111111-1111-4111-8111-111111111111";

const PAYLOAD = {
  invite_id: CONVITE,
  email: "revogada@example.com",
  organization_id: ORG,
  role: "manager" as const,
  exp: Math.floor(Date.now() / 1000) + 3600,
};

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: vi.fn() })),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/cookie-secure", () => ({ cookieSecure: () => false }));

/** A RPC que efetiva o vínculo — o ato que um revogado não pode alcançar. */
const rpcDoAceite = vi.fn(async () => ({ data: { id: "m1", changed: true }, error: null }));

/**
 * Dublê do admin client. `select` devolve a linha de `team_invites` pedida;
 * `update` (o fechamento do convite) aceita e não diz nada.
 */
function adminComConvite(linha: { revoked_at: string | null } | null) {
  const cadeiaDeUpdate = () => {
    const c: Record<string, unknown> = {};
    for (const m of ["eq", "is"]) c[m] = () => c;
    c.then = (r: (v: unknown) => unknown) => r({ data: null, error: null });
    return c;
  };
  return {
    from: () => ({
      select: () => {
        const c: Record<string, unknown> = {};
        for (const m of ["eq", "is"]) c[m] = () => c;
        c.maybeSingle = async () => ({ data: linha, error: null });
        return c;
      },
      update: cadeiaDeUpdate,
    }),
    rpc: rpcDoAceite,
  };
}

async function aplicar(linha: { revoked_at: string | null } | null) {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  vi.mocked(createAdminClient).mockReturnValue(adminComConvite(linha) as never);
  const { aplicarConvite } = await import("@/lib/auth/aplicar-convite");
  return aplicarConvite({ userId: USUARIO_ID, payload: PAYLOAD });
}

describe("aplicarConvite consulta a LINHA, não só o token", () => {
  beforeEach(() => vi.clearAllMocks());

  it("⭐ convite REVOGADO é recusado, e o vínculo nunca chega a ser tentado", async () => {
    const r = await aplicar({ revoked_at: "2026-09-13T10:00:00Z" });

    expect(
      r,
      "um convite revogado virou vínculo: quem foi desconvidado entra na organização assim mesmo, com o papel que o token carrega",
    ).toEqual({ ok: false, motivo: "invalid_or_expired" });
    expect(
      rpcDoAceite,
      "`fn_accept_team_invite` foi chamada para um convite revogado — a recusa passou a depender inteiramente da função do banco, e a checagem deste módulo não está fazendo nada",
    ).not.toHaveBeenCalled();
  });

  it("convite VIVO passa — o par de vacuidade, senão o caso acima não prova nada", async () => {
    const r = await aplicar({ revoked_at: null });

    expect(
      r.ok,
      "nem o convite vivo passa: a sonda recusa tudo, e o caso da revogação está verde pelo motivo errado",
    ).toBe(true);
    expect(rpcDoAceite).toHaveBeenCalled();
  });

  it("convite SEM linha segue o fluxo — emitido antes da migration 0238", async () => {
    // Congela a decisão que o cabeçalho do módulo documenta: ausência de linha
    // NÃO é revogação. Sem este caso, alguém "endureceria" a guarda para
    // `!linha || linha.revoked_at` e quebraria todo convite antigo, numa
    // instalação que não tem como reemitir o que já foi enviado.
    expect((await aplicar(null)).ok).toBe(true);
  });

  it("a recusa da própria função do banco (42501) também não é vínculo", async () => {
    // Segunda linha de defesa: mesmo que a linha diga que o convite vive, a
    // `fn_accept_team_invite` recusa quem foi revogado DEPOIS da emissão. O
    // código 42501 é recusa de política, e não pode virar 500.
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = adminComConvite({ revoked_at: null });
    admin.rpc = vi.fn(async () => ({ data: null, error: { code: "42501" } })) as never;
    vi.mocked(createAdminClient).mockReturnValue(admin as never);

    const { aplicarConvite } = await import("@/lib/auth/aplicar-convite");
    expect(await aplicarConvite({ userId: USUARIO_ID, payload: PAYLOAD })).toEqual({
      ok: false,
      motivo: "invalid_or_expired",
    });
  });
});
