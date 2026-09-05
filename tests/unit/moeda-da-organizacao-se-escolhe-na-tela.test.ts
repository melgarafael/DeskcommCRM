import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A MOEDA DA ORGANIZAÇÃO SE ESCOLHE NA TELA, E O QUE SE ESCOLHE É O QUE GRAVA.
 *
 * A migration 0208 criou `organizations.currency`. Coluna sem superfície é
 * configuração morta — o invariante 6 de `docs/doctrine/sistema-vivo.md` ("toda
 * configuração tem superfície") existe para isso, e o produto já pagou essa
 * conta: o seletor de idioma do perfil ficou meses salvando um campo que
 * NINGUÉM lia, e escolher "English (US)" não mudava uma letra.
 *
 * Este arquivo guarda as três coisas que fazem a escolha ser real:
 *
 *  1. o que a pessoa escolheu chega ao UPDATE (e não o padrão);
 *  2. moeda fora da lista servida é recusada ANTES do banco;
 *  3. a lista servida é UMA — a mesma para o schema e para o seletor.
 *
 * O ponto 3 é o mesmo cuidado que `lib/schemas/settings.ts` já toma com
 * `LOCALES = IDIOMAS`: duas listas divergem, e uma moeda aceita na validação e
 * desconhecida na tela vira um valor que ninguém consegue mais escolher de
 * volta.
 */

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { MOEDAS_SERVIDAS } from "@/lib/money";
import { tenantSchema } from "@/lib/schemas/settings";

const ORG_ID = "22222222-2222-4222-8222-222222222222";

/** O que a action mandou para o UPDATE — é sobre isto que as asserções falam. */
let atualizado: Record<string, unknown> | null = null;
/** O org id que o `.eq()` do UPDATE recebeu — admin client bypassa RLS, então este `.eq()` É a única cerca. */
let orgIdAtualizado: string | null = null;

function adminFalso() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { settings: {} }, error: null }) }),
      }),
      update: (linha: Record<string, unknown>) => {
        atualizado = linha;
        return {
          eq: async (_coluna: string, valor: string) => {
            orgIdAtualizado = valor;
            return { error: null };
          },
        };
      },
    }),
    rpc: () => Promise.resolve({ error: null }),
  };
}

function entrada(over: Record<string, unknown> = {}) {
  return {
    display_name: "Loja",
    legal_name: "Loja SA",
    cnpj: null,
    timezone: "America/Sao_Paulo",
    locale: "es",
    currency: "MXN",
    media_retention_days: 365,
    dpo_email: null,
    privacy_policy_url: null,
    lost_reasons_extra: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  atualizado = null;
  orgIdAtualizado = null;
  vi.mocked(loadAuthUser).mockResolvedValue({
    id: "u1",
    is_platform_admin: false,
  } as never);
  vi.mocked(resolveActiveOrg).mockResolvedValue({
    orgId: ORG_ID,
    role: "admin",
  } as never);
  vi.mocked(createAdminClient).mockReturnValue(adminFalso() as never);
});

describe("a moeda da organização", () => {
  it("grava a moeda escolhida, não o padrão", async () => {
    const { updateTenant } = await import("@/app/actions/settings/updateTenant");

    const r = await updateTenant(entrada() as never);

    expect(r).toEqual({ ok: true });
    // ⚠️ MXN e não BRL: com o padrão chumbado este caso passaria verde e a
    // escolha da tela seria decorativa.
    expect(atualizado).toMatchObject({ currency: "MXN" });
    // ⚠️ O admin client BYPASSA RLS por desenho (única policy de escrita de
    // `organizations` é `orgs_write_platform_admin`) — o `.eq("id", orgId)`
    // é a ÚNICA cerca entre "salvei a moeda da minha org" e "salvei a moeda
    // de toda organização da instalação". Um `.eq()` esquecido escreveria em
    // todo mundo e este teste continuaria verde sem esta linha.
    expect(orgIdAtualizado).toBe(ORG_ID);
  });

  it("recusa moeda que o produto não serve, antes do banco", () => {
    const r = tenantSchema.safeParse(entrada({ currency: "XXX" }));

    expect(r.success).toBe(false);
  });

  it("aceita cada moeda da lista servida", () => {
    for (const moeda of MOEDAS_SERVIDAS) {
      expect(tenantSchema.safeParse(entrada({ currency: moeda })).success).toBe(true);
    }
  });

  /**
   * A lista que o schema valida e a que o seletor oferece têm de ser a MESMA
   * constante. Se o seletor ganhar uma moeda que o schema recusa, a tela salva
   * e o servidor devolve `validation_failed` sem explicar; se o schema aceitar
   * uma que o seletor não mostra, ninguém consegue voltar para ela.
   */
  it("o seletor da tela lê a mesma lista que o schema", async () => {
    const fonte = await import("node:fs").then((fs) =>
      fs.readFileSync("app/app/settings/tenant/_form.tsx", "utf-8"),
    );

    expect(fonte).toContain("MOEDAS_SERVIDAS");
    // Nenhuma lista de moedas escrita à mão dentro do formulário.
    for (const moeda of MOEDAS_SERVIDAS) {
      expect(fonte).not.toContain(`"${moeda}"`);
    }
  });
});
