/**
 * BOAS-VINDAS GRAVAM NA ORGANIZAÇÃO DA ABA, NÃO NA ORG ATIVA DO SUBMIT.
 *
 * ─── O DEFEITO (#2068) ───────────────────────────────────────────────────
 * A aba `/onboarding/welcome` é aberta para UMA organização (a que estava
 * ativa naquele render). Quem preenche e deixa a aba aberta, e em OUTRA aba
 * troca para outra organização ativa, ao enviar a etapa via `acceptWelcome`
 * vê o nome/descrição gravados na organização que o cookie `active_org`
 * aponta NO MOMENTO DO SUBMIT — não naquela para a qual a aba foi aberta.
 *
 * O `requireOnboardingCtx` resolvia a org ativa a cada chamada. O conserto
 * acopla a org da própria aba ao submit (campo `organization_id` no form),
 * VALIDADA contra as memberships reais do usuário — um id arbitrário do corpo
 * jamais alcança o `.eq("id", …)` do UPDATE.
 *
 * ─── O QUE ESTE ARQUIVO MEDE ─────────────────────────────────────────────
 * - A discriminação pedida na issue: aba aberta para A, org ativa B no
 *   submit → grava em A, não em B (é o caso que fica vermelho sem o fix).
 * - O controle de segurança: id do corpo que não é membership é RECUSADO —
 *   nem UPDATE com id arbitrário, nem queda silenciosa na org ativa.
 * - O caso identidade: aba para B, org ativa B → grava em B (normal).
 * - Vínculo perdido: a aba de A ficou aberta, a pessoa saiu de A, B está
 *   ativa → recusa, nada gravado (cair em B seria o #2068 por outra porta).
 * - Org da aba SUSPENSA (vínculo real): a mesma régua do `resolveActiveOrg`
 *   — redireciona para `/account-suspended`, nada gravado.
 * - Acompanhamento (suporte, sem vínculo): recusado. Hoje o layout do
 *   onboarding já expulsa essas sessões; o caso mostra a interação se não.
 *
 * Não mede o layout real (mock de `redirect`), nem E2E (sem Docker nesta VPS; o CI
 * roda `test:db`/`test:e2e`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** A org da ABA (a que o render resolveu) — é a que o submit deve atingir. */
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** A org que se tornou ATIVA depois (cookie `active_org` no momento do submit). */
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** Uma org que o usuário NÃO pertence — id arbitrário que o corpo não pode alcançar. */
const FORA = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const USER = "11111111-1111-4111-8111-111111111111";

interface Consulta {
  table: string;
  op: "select" | "update";
  payload: Record<string, unknown> | null;
  filtros: Record<string, unknown>;
}
type ErroDb = { code?: string; message: string } | null;
interface Resposta {
  data: unknown;
  error: ErroDb;
}

let responder: (c: Consulta) => Resposta;
/** O org id que cada UPDATE de `organizations` recebeu no `.eq("id", …)`. */
let updates: string[] = [];

interface Membro {
  organization_id: string;
  organization_name: string;
  role: string;
  org_status: string;
}
const mA: Membro = { organization_id: ORG_A, organization_name: "Org A", role: "admin", org_status: "active" };
const mB: Membro = { organization_id: ORG_B, organization_name: "Org B", role: "admin", org_status: "active" };

/** O mundo de cada caso: quem o usuário é, e o destino de cada `redirect`. */
const mundo = vi.hoisted(() => ({
  membros: [] as unknown[],
  support: null as unknown,
  redirects: [] as string[],
}));

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    mundo.redirects.push(destino);
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => clienteFalso() }));
/**
 * O client de SESSÃO não pode escrever: a única policy de escrita de
 * `organizations` é `orgs_write_platform_admin`. Se o passo migrasse para o
 * client de sessão, este dublê lança em vez de deixar verde por vacuidade.
 */
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => {
    throw new Error(
      "o passo NÃO pode gravar em `organizations` pelo client de sessão (policy orgs_write_platform_admin)",
    );
  },
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({
    id: USER,
    email: "dono@qa.local",
    full_name: "Dona",
    organizations: mundo.membros,
    support: mundo.support,
  })),
  // A org ATIVA no momento do submit — o cookie foi trocado por OUTRA aba.
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG_B, name: "Org B", role: "admin" })),
}));

import { acceptWelcome } from "@/app/actions/onboarding/acceptWelcome";

/**
 * `acceptWelcome` grava e então `redirect("/onboarding")` — o redirect LANÇA,
 * então o caminho de sucesso não retorna. O que se mede é a ESCRITA, que
 * acontece antes do redirect; este helper engole só o sinal terminal.
 */
async function executar(formData: FormData): Promise<void> {
  try {
    await acceptWelcome(formData);
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") return;
    throw err;
  }
}

/** Construtor de consulta no formato do PostgREST: encadeável, thenable. */
function clienteFalso() {
  const abrir = (table: string) => {
    const c: Consulta = { table, op: "select", payload: null, filtros: {} };
    const resolver = () => Promise.resolve(responder(c));
    const b = {
      select: () => b,
      update: (payload: Record<string, unknown>) => {
        c.op = "update";
        c.payload = payload;
        return b;
      },
      eq: (coluna: string, valor: unknown) => {
        c.filtros[coluna] = valor;
        return b;
      },
      is: (coluna: string, valor: unknown) => {
        c.filtros[`is:${coluna}`] = valor;
        return b;
      },
      limit: () => b,
      single: () => resolver(),
      maybeSingle: () => resolver(),
      then: (ok: (r: Resposta) => unknown, no?: (e: unknown) => unknown) => resolver().then(ok, no),
    };
    return b;
  };
  return { from: abrir } as never;
}

function montarBanco(mundo: { jaOnboarded?: boolean } = {}) {
  responder = (c) => {
    if (c.table === "organizations") {
      if (c.op === "select") {
        // `patchOnboardingState` relê estado antes de gravar (merge consciente).
        return {
          data: {
            onboarding_state: {},
            onboarded_at: mundo.jaOnboarded ? "2026-01-01T00:00:00.000Z" : null,
          },
          error: null,
        };
      }
      updates.push(String(c.filtros.id ?? ""));
      return { data: null, error: null };
    }
    throw new Error(`tabela não dublada no teste: ${c.table}`);
  };
}

function formulario(orgId: string, nome = "Clinica A"): FormData {
  const fd = new FormData();
  fd.set("display_name", nome);
  fd.set("timezone", "America/Sao_Paulo");
  fd.set("organization_id", orgId);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  updates = [];
  mundo.membros = [mA, mB];
  mundo.support = null;
  mundo.redirects = [];
});

describe("onboarding/welcome: boas-vindas gravam na organização da aba, não na ativa", () => {
  it("#2068: aba aberta p/ A, org ativa trocada p/ B no submit → grava em A, não em B", async () => {
    montarBanco();

    // A aba foi renderizada com A; outra aba trocou o cookie para B. O submit
    // carrega o id da própria aba (`organization_id` = A).
    await executar(formulario(ORG_A));

    expect(updates).toHaveLength(1);
    // ⚠️ A discriminação: SEM o fix, `requireOnboardingCtx` resolvia a org
    // ATIVA (B) e este `updates[0]` ficaria `ORG_B` — o caso fica VERMELHO.
    expect(updates[0]).toBe(ORG_A);
    expect(updates[0]).not.toBe(ORG_B);
  });

  it("id do corpo que NÃO é membership é recusado: não grava em lugar nenhum, nem na org ativa", async () => {
    montarBanco();

    // Cair na org ativa seria o próprio #2068 por outra porta: a aba era de
    // uma org que o usuário perdeu (ou de um id forjado), e o nome dela
    // sobrescreveria a org que outra aba deixou ativa.
    const r = await acceptWelcome(formulario(FORA));

    expect(r).toEqual({ ok: false, error: "forbidden" });
    expect(updates).toEqual([]);
  });

  it("aba para B e org ativa B: grava em B (caso identidade, nada muda)", async () => {
    montarBanco();

    await executar(formulario(ORG_B, "Clinica B"));

    expect(updates).toEqual([ORG_B]);
  });

  it("perdeu o vínculo com A, aba de A aberta, B ativa: recusa e não grava em B", async () => {
    mundo.membros = [mB];
    montarBanco();

    const r = await acceptWelcome(formulario(ORG_A));

    expect(r).toEqual({ ok: false, error: "forbidden" });
    expect(updates).toEqual([]);
  });

  it("org da aba SUSPENSA (vínculo real), B ativa: vai para /account-suspended e não grava", async () => {
    mundo.membros = [{ ...mA, org_status: "suspended" }, mB];
    montarBanco();

    await executar(formulario(ORG_A));

    expect(mundo.redirects).toEqual(["/account-suspended"]);
    expect(updates).toEqual([]);
  });

  it("acompanhamento (suporte full, sem vínculo) na aba da org acompanhada é recusado", async () => {
    // Hoje o layout do onboarding expulsa a sessão de suporte antes desta
    // tela; se aquele redirect sair, este caso mostra que o envio é recusado.
    mundo.membros = [];
    mundo.support = { organization_id: ORG_A, name: "Org A", status: "active", access_mode: "full" };
    montarBanco();

    const r = await acceptWelcome(formulario(ORG_A));

    expect(r).toEqual({ ok: false, error: "forbidden" });
    expect(updates).toEqual([]);
  });
});
