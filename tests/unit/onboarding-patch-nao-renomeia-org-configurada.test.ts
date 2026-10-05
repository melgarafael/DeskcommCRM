/**
 * BOAS-VINDAS NÃO RENOMEIAM ORGANIZAÇÃO JÁ CONFIGURADA (#2113).
 *
 * ─── O DEFEITO ────────────────────────────────────────────────────────────
 * `patchOnboardingState` (`app/actions/onboarding/_shared.ts`) fazia
 * `update(...).eq("id", orgId)` SEM condição sobre `onboarded_at`. Uma aba
 * `/onboarding/welcome` aberta antes de o onboarding terminar (por exemplo,
 * concluído em OUTRA aba) ainda regravava `display_name` e
 * `onboarding_state` depois que a organização já estava configurada — o
 * nome que a pessoa deu no wizard sumia e o estado do onboarding voltava
 * atrás.
 *
 * ─── O CONSORTE ───────────────────────────────────────────────────────────
 * A cadeia do update ganhou `.is("onboarded_at", null)` (grava só em org que
 * ainda está no wizard) e `.select("id")` (PostgREST devolve as linhas
 * afetadas). ZERO linhas → `OnboardingError("org_ja_configurada",
 * "Organização já configurada.")` e nada é gravado.
 *
 * ─── O QUE ESTE ARQUIVO MEDE ─────────────────────────────────────────────
 * - Org com `onboarded_at` preenchido: a escrita LANÇA `org_ja_configurada`
 *   e `display_name`/`onboarding_state` ficam intactos (o caso que fica
 *   VERMELHO sem a guarda).
 * - Controle: org com `onboarded_at` nulo segue gravando normalmente.
 * - O mesmo caminho visto pela action `acceptWelcome`: o submit de uma aba
 *   antiga recebe recusa e NÃO escreve. O mapeamento do erro é o da própria
 *   action; o #2146 trocou esse mapeamento por um redirect para
 *   `/app/inbox` (o caso abaixo), medido em
 *   `tests/unit/onboarding-aviso-org-ja-configurada.test.ts`.
 *
 * O dublê do client simula o PostgREST de verdade: filtro `.is` que não bate
 * = ZERO linhas = `data: []`. Não mede o banco real (sem Docker nesta VPS;
 * o CI roda `test:db`/`test:e2e`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** A organização que a aba de boas-vindas aponta. */
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";

interface Linha {
  id: string;
  display_name: string;
  onboarding_state: Record<string, unknown>;
  onboarded_at: string | null;
}

/** A "linha" da tabela `organizations` — é ela que precisa sobreviver à recusa. */
let linha: Linha;
/** Payloads que o dublê efetivamente aplicou (a prova de que NADA foi gravado). */
let escritas: Record<string, unknown>[] = [];

interface Consulta {
  table: string;
  op: "select" | "update";
  payload: Record<string, unknown> | null;
  filtros: Record<string, unknown>;
  colunas: string;
}
type ErroDb = { code?: string; message: string } | null;
interface Resposta {
  data: unknown;
  error: ErroDb;
}

let responder: (c: Consulta) => Resposta;

/** Mundo compartilhado entre os mocks (o `vi.mock` é içado para o topo). */
const mundo = vi.hoisted(() => ({
  membros: [] as unknown[],
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
/** O client de SESSÃO não escreve em `organizations` (policy de platform admin). */
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => {
    throw new Error("o submit não pode gravar em `organizations` pelo client de sessão");
  },
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({
    id: USER,
    email: "dono@qa.local",
    full_name: "Dona",
    organizations: mundo.membros,
    support: null,
  })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "Org Antiga", role: "admin" })),
}));

import { acceptWelcome } from "@/app/actions/onboarding/acceptWelcome";
import { OnboardingError, patchOnboardingState } from "@/app/actions/onboarding/_shared";

/** Construtor de consulta no formato do PostgREST: encadeável, thenable. */
function clienteFalso() {
  const abrir = (table: string) => {
    const c: Consulta = { table, op: "select", payload: null, filtros: {}, colunas: "" };
    const resolver = () => Promise.resolve(responder(c));
    const b = {
      select: (colunas?: string) => {
        if (typeof colunas === "string") c.colunas = colunas;
        return b;
      },
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
      maybeSingle: () =>
        resolver().then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data })),
      then: (ok: (r: Resposta) => unknown, no?: (e: unknown) => unknown) => resolver().then(ok, no),
    };
    return b;
  };
  return { from: abrir } as never;
}

/**
 * Sem `.is("onboarded_at", null)` a escrita bate na linha (é o defeito);
 * com ele, a linha NÃO bate e o PostgREST devolve `data: []` — é o contrato
 * que a guarda lê.
 */
function montarBanco(opts: { onboardedAt: string | null }) {
  linha = {
    id: ORG,
    display_name: "Nome Antigo",
    onboarding_state: {
      welcome: {
        accepted_at: "2026-01-01T00:00:00.000Z",
        timezone: "America/Sao_Paulo",
        display_name: "Nome Antigo",
      },
    },
    onboarded_at: opts.onboardedAt,
  };
  escritas = [];
  responder = (c) => {
    if (c.table !== "organizations") throw new Error(`tabela não dublada no teste: ${c.table}`);
    if (c.op === "select") {
      return { data: { onboarding_state: linha.onboarding_state, onboarded_at: linha.onboarded_at }, error: null };
    }
    const idBate = String(c.filtros.id ?? "") === linha.id;
    const filtroOnboarded = c.filtros["is:onboarded_at"];
    const onboardedBate =
      !("is:onboarded_at" in c.filtros) || (filtroOnboarded === null && linha.onboarded_at === null);
    if (!idBate || !onboardedBate) return { data: [], error: null };
    escritas.push({ ...(c.payload ?? {}) });
    linha = { ...linha, ...(c.payload as Partial<Linha>) };
    // Com `.select("id")` o PostgREST devolve as linhas afetadas.
    return { data: [{ id: linha.id }], error: null };
  };
}

function formulario(nome = "Clínica Nova"): FormData {
  const fd = new FormData();
  fd.set("display_name", nome);
  fd.set("timezone", "America/Sao_Paulo");
  fd.set("organization_id", ORG);
  return fd;
}

/** Engole só o sinal terminal do `redirect` — o caminho de sucesso não retorna. */
async function executar(formData: FormData) {
  try {
    return await acceptWelcome(formData);
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") return "REDIRECT" as const;
    throw err;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mundo.membros = [{ organization_id: ORG, organization_name: "Org Antiga", role: "admin", org_status: "active" }];
  mundo.redirects = [];
});

describe("patchOnboardingState: organização já configurada não é regravada", () => {
  it("org com onboarded_at: lança org_ja_configurada e display_name/onboarding_state ficam intactos", async () => {
    montarBanco({ onboardedAt: "2026-01-01T00:00:00.000Z" });
    const estadoAntes = structuredClone(linha.onboarding_state);

    const erro = await patchOnboardingState(
      ORG,
      { welcome: { accepted_at: "2026-02-02T00:00:00.000Z", timezone: "America/Sao_Paulo", display_name: "Clínica Nova" } },
      { display_name: "Clínica Nova", timezone: "America/Sao_Paulo" },
      { soNoWizard: true },
    ).then(
      () => null,
      (e: unknown) => e,
    );

    // SEM a guarda nada é lançado e a linha é regravada — este caso é o VERMELHO.
    expect(erro).toBeInstanceOf(OnboardingError);
    expect((erro as OnboardingError).code).toBe("org_ja_configurada");
    expect((erro as OnboardingError).message).toBe("Organização já configurada.");
    expect(linha.display_name).toBe("Nome Antigo");
    expect(linha.onboarding_state).toEqual(estadoAntes);
    expect(escritas).toEqual([]);
  });

  it("controle: org com onboarded_at nulo segue gravando normalmente", async () => {
    montarBanco({ onboardedAt: null });

    await patchOnboardingState(
      ORG,
      { welcome: { accepted_at: "2026-02-02T00:00:00.000Z", timezone: "America/Sao_Paulo", display_name: "Clínica Nova" } },
      { display_name: "Clínica Nova", timezone: "America/Sao_Paulo" },
      { soNoWizard: true },
    );

    expect(escritas).toHaveLength(1);
    expect(linha.display_name).toBe("Clínica Nova");
    expect(linha.onboarding_state).toEqual({
      welcome: {
        accepted_at: "2026-02-02T00:00:00.000Z",
        timezone: "America/Sao_Paulo",
        display_name: "Clínica Nova",
      },
    });
    expect(linha.onboarded_at).toBeNull();
  });

  it("sem soNoWizard (os outros passos) a org configurada segue gravando, como antes do #2113", async () => {
    // A guarda é das boas-vindas. Os passos de IA, convites e quadro chamam
    // `patchOnboardingState` DEPOIS de o efeito já ter acontecido (agente
    // publicado, e-mail enviado); recusar aqui deixaria esse efeito sem
    // estado, auditoria nem evento.
    montarBanco({ onboardedAt: "2026-01-01T00:00:00.000Z" });

    await patchOnboardingState(ORG, { teste: { skipped: true } });

    expect(escritas).toHaveLength(1);
    expect(linha.onboarding_state).toMatchObject({ teste: { skipped: true } });
  });

  it("aba antiga enviando as boas-vindas depois do fim: sai para /app/inbox e nada é gravado", async () => {
    montarBanco({ onboardedAt: "2026-01-01T00:00:00.000Z" });

    const r = await executar(formulario("Clínica Nova"));

    // A RECUSA é o essencial deste teste do #2113: nada é gravado. Como a
    // action resolve (#2146) o submit sai para a caixa de entrada em vez de
    // devolver `db_error` — o código de recusa foi o defeito do #2146.
    expect(r).toBe("REDIRECT");
    expect(mundo.redirects).toEqual(["/app/inbox"]);
    expect(linha.display_name).toBe("Nome Antigo");
    expect(escritas).toEqual([]);
  });
});
