/**
 * O PRIMEIRO ACESSO QUE FALHOU GANHA SAÍDA — E SÓ ELE.
 *
 * ─── O beco, medido em 2005aea6 ─────────────────────────────────────────────
 *
 * `app/auth/confirm/route.ts` firma a SESSÃO e só depois provisiona. Quando o
 * provisionamento levanta, ele auditava e mandava para `/login` — com a pessoa
 * já logada e sem organização. Daí para frente todo caminho fechava:
 *
 *     /login      → `signInWithPassword.ts:110` → /app/inbox
 *     /app/inbox  → "Aceite um convite ou contate o admin"
 *     /onboarding → `layout.tsx` sem org → redirect("/login")   ← o laço
 *
 * As duas saídas oferecidas não existem para quem INSTALOU o sistema: não há
 * convite e o admin é ele. O desbloqueio pedia SQL na mão.
 *
 * ─── Por que a metade "e só ele" pesa igual ─────────────────────────────────
 *
 * Uma tela que CRIA organização a partir de uma sessão qualquer é uma porta
 * nova. Três casos existem só para prová-la fechada: quem já tem organização
 * não cria outra, quem tem convite pendente não vira dono de empresa própria, e
 * o teto por identidade entra antes da escrita. Sem eles o arquivo provaria
 * apenas que a saída existe — que é a metade fácil.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ensureTenantForUser } from "@/lib/auth/provision";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  // O `redirect()` do Next LANÇA. Reproduzir isso é o que permite distinguir
  // "saiu pela porta" de "seguiu adiante e provisionou assim mesmo".
  redirect: vi.fn((destino: string) => {
    throw new Error(`NEXT_REDIRECT:${destino}`);
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ requireAuth: vi.fn(), resolveActiveOrg: vi.fn() }));
vi.mock("@/lib/auth/provision", () => ({ ensureTenantForUser: vi.fn() }));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
}));

const USUARIO = { id: "11111111-1111-4111-8111-111111111111", email: "dono@exemplo.com.br" };

function comUsuario(user_metadata: Record<string, unknown> = {}) {
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { ...USUARIO, user_metadata } } })) },
  } as never);
}

describe("recoverOrganization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(headers).mockResolvedValue({
      // IP diferente por caso não é possível aqui, então o teto por IP (5) é
      // maior que o número de escritas de qualquer caso isolado.
      get: (k: string) => (k === "x-forwarded-for" ? "203.0.113.42" : null),
    } as never);
    vi.mocked(requireAuth).mockResolvedValue({ id: USUARIO.id } as never);
    vi.mocked(resolveActiveOrg).mockResolvedValue(null);
    vi.mocked(ensureTenantForUser).mockResolvedValue({
      provisioned: true,
      organizationId: "22222222-2222-4222-8222-222222222222",
    } as never);
    comUsuario();
  });

  it("⭐ conta sem organização: provisiona e sai para o onboarding", async () => {
    const { recoverOrganization } = await import("./recoverOrganization");

    await expect(recoverOrganization("Clínica Boa Vista")).rejects.toThrow(
      "NEXT_REDIRECT:/onboarding/welcome",
    );
    expect(ensureTenantForUser).toHaveBeenCalledTimes(1);

    // O NOME é o único dado do cliente que atravessa — e chega pelo mesmo campo
    // que o signup usa. `organization_id` e papel nunca vêm de fora.
    const [usuario, opcoes] = vi.mocked(ensureTenantForUser).mock.calls[0]!;
    expect(usuario.user_metadata?.org_name).toBe("Clínica Boa Vista");
    expect(opcoes?.source).toBe("recovery");
  });

  it("⭐ quem JÁ tem organização não ganha uma segunda", async () => {
    // Sem esta guarda, a tela viraria "abra quantas empresas quiser" para
    // qualquer sessão válida que digitasse a URL.
    vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: "existente" } as never);
    const { recoverOrganization } = await import("./recoverOrganization");

    await expect(recoverOrganization("Empresa Nova")).rejects.toThrow("NEXT_REDIRECT:/app/inbox");
    expect(ensureTenantForUser).not.toHaveBeenCalled();
  });

  it("⭐ quem tem convite pendente não vira dono de empresa própria", async () => {
    // A mesma bifurcação de `app/auth/confirm/route.ts`: convidado entra na
    // organização de quem convidou. Um token que não decodifica cai em
    // `recusar`, que também não provisiona — falha FECHADA.
    comUsuario({ invite_token: "token-que-nao-decodifica" });
    const { recoverOrganization } = await import("./recoverOrganization");

    await expect(recoverOrganization("Empresa Nova")).resolves.toEqual({
      ok: false,
      error: "invite_pending",
    });
    expect(ensureTenantForUser).not.toHaveBeenCalled();
  });

  it("o nome passa por Zod antes de qualquer coisa", async () => {
    const { recoverOrganization } = await import("./recoverOrganization");

    await expect(recoverOrganization("x")).resolves.toEqual({
      ok: false,
      error: "validation_error",
    });
    await expect(recoverOrganization("n".repeat(121))).resolves.toEqual({
      ok: false,
      error: "validation_error",
    });
    expect(requireAuth, "o Zod ficou DEPOIS da sessão — inverta").not.toHaveBeenCalled();
    expect(ensureTenantForUser).not.toHaveBeenCalled();
  });

  it("⭐ o teto por identidade entra ANTES da escrita", async () => {
    // `AUTH_LIMITS.org_recovery.id = 3`. Cada acerto CRIA uma organização, e o
    // caminho legítimo é usado uma vez na vida de uma conta.
    const { recoverOrganization } = await import("./recoverOrganization");

    const desfechos: string[] = [];
    for (let i = 0; i < 4; i++) {
      try {
        await recoverOrganization(`Empresa ${i}`);
        desfechos.push("ok");
      } catch (e) {
        desfechos.push(e instanceof Error && e.message.includes("NEXT_REDIRECT") ? "ok" : "erro");
      }
    }
    // A 4ª volta como valor (não redireciona), então o loop acima a registra
    // via o `resolves` do próprio retorno — conferido aqui pela contagem.
    expect(
      vi.mocked(ensureTenantForUser).mock.calls.length,
      "o teto não segurou: houve mais escritas que o limite por identidade",
    ).toBeLessThanOrEqual(3);
  });

  it("provisionamento que levanta vira erro tratado, não tela branca", async () => {
    vi.mocked(ensureTenantForUser).mockRejectedValue(new Error("banco fora do ar"));
    const { recoverOrganization } = await import("./recoverOrganization");

    await expect(recoverOrganization("Clínica Boa Vista")).resolves.toEqual({
      ok: false,
      error: "provision_failed",
    });
  });
});

describe("o laço está cortado nos três pontos que o formavam", () => {
  /**
   * Guarda de CLASSE. Os casos acima provam que a SAÍDA funciona; estes provam
   * que ela é ALCANÇÁVEL — e é a alcançabilidade que o defeito quebrava. Um
   * conserto que devolvesse qualquer um destes três para `/login` recriaria o
   * laço inteiro com a action nova intacta e todos os casos acima verdes.
   */
  const PONTOS: Array<[string, string]> = [
    ["app/onboarding/layout.tsx", 'if (!activeOrg) redirect("/get-started")'],
    ["app/onboarding/page.tsx", 'if (!activeOrg) redirect("/get-started")'],
    ["app/auth/confirm/route.ts", 'return redirectTo("/get-started")'],
  ];

  it.each(PONTOS)("%s manda para a saída, não de volta para o login", async (arquivo, esperado) => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const fonte = readFileSync(join(process.cwd(), arquivo), "utf8");
    expect(fonte).toContain(esperado);
  });

  it("o estado vazio do Inbox oferece a porta, e não só a frase", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const fonte = readFileSync(join(process.cwd(), "app/app/inbox/page.tsx"), "utf8");
    expect(fonte).toContain('href="/get-started"');
  });
});
