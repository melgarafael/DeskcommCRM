/**
 * AVISO DE ORGANIZAÇÃO JÁ CONFIGURADA NO ENVIO DAS BOAS-VINDAS (#2146).
 *
 * ─── O DEFEITO ────────────────────────────────────────────────────────────
 * `acceptWelcome` (`app/actions/onboarding/acceptWelcome.ts`) transformava
 * QUALQUER `OnboardingError` em `db_error`. A aba `/onboarding/welcome` que
 * ficou aberta depois de o onboarding terminar em OUTRA aba é recusada com
 * `org_ja_configurada` — a recusa está certa, nada é gravado —, mas a tela
 * mostrava "Falha: db_error", com o detalhe "Organização já configurada.":
 * um erro de banco que não aconteceu.
 *
 * ─── O CONSORTE ───────────────────────────────────────────────────────────
 * O `catch` de `patchOnboardingState` reconhece `org_ja_configurada` e
 * redireciona para `/app/inbox` (era para onde o onboarding levaria a pessoa
 * em seguida). Todos os OUTROS códigos seguem exatamente o de antes:
 * `db_error` com o mesmo `details`.
 *
 * ─── O QUE ESTE ARQUIVO MEDE ──────────────────────────────────────────────
 * - org já configurada → o submit SAI para `/app/inbox` e jamais devolve
 *   `db_error` (este é o caso VERMELHO sem a mudança).
 * - controle: erro de banco de verdade continua `db_error` com o mesmo
 *   `details` de hoje, sem redirect.
 * - controle: entrada inválida continua `invalid_input` com o `flatten()`
 *   do zod, sem redirect.
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

/** A "linha" da tabela `organizations`. */
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
 * Sem `.is("onboarded_at", null)` a escrita bate na linha (é o defeito do
 * #2113); com ele, a linha NÃO bate e o PostgREST devolve `data: []` — é o
 * contrato que lê `org_ja_configurada`. `falhaDb` simula erro REAL do banco
 * (outro caminho: o `db_error` de sempre).
 */
function montarBanco(opts: { onboardedAt: string | null; falhaDb?: string }) {
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
    if (opts.falhaDb) return { data: null, error: { message: opts.falhaDb } };
    const idBate = String(c.filtros.id ?? "") === linha.id;
    const filtroOnboarded = c.filtros["is:onboarded_at"];
    const onboardedBate =
      !("is:onboarded_at" in c.filtros) || (filtroOnboarded === null && linha.onboarded_at === null);
    if (!idBate || !onboardedBate) return { data: [], error: null };
    escritas.push({ ...(c.payload ?? {}) });
    linha = { ...linha, ...(c.payload as Partial<Linha>) };
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

describe("acceptWelcome: organização já configurada não vira db_error na tela (#2146)", () => {
  it("org já configurada: o submit sai para /app/inbox e nunca devolve db_error", async () => {
    montarBanco({ onboardedAt: "2026-01-01T00:00:00.000Z" });

    const r = await executar(formulario("Clínica Nova"));

    // SEM a mudança o catch devolve { ok: false, error: "db_error",
    // details: "Organização já configurada." } e nenhum redirect acontece —
    // é exatamente o VERMELHO deste caso.
    expect(r).toBe("REDIRECT");
    expect(mundo.redirects).toEqual(["/app/inbox"]);
    // A recusa continua certa: nada foi gravado.
    expect(escritas).toEqual([]);
    expect(linha.display_name).toBe("Nome Antigo");
  });

  it("controle: erro de banco de verdade continua db_error com o mesmo details de hoje", async () => {
    montarBanco({ onboardedAt: null, falhaDb: "permission denied for table organizations" });

    const r = await executar(formulario("Clínica Nova"));

    expect(r).toEqual({
      ok: false,
      error: "db_error",
      details: "permission denied for table organizations",
    });
    expect(mundo.redirects).toEqual([]);
    expect(escritas).toEqual([]);
  });

  it("controle: entrada inválida continua invalid_input com o flatten do zod", async () => {
    montarBanco({ onboardedAt: null });

    // display_name com 1 caractere: `welcomeSchema` exige `.min(2)`.
    const r = await executar(formulario("x"));

    expect(r).toMatchObject({ ok: false, error: "invalid_input" });
    const detalhes = (r as { details?: { fieldErrors?: Record<string, string[]> } }).details;
    expect(detalhes?.fieldErrors?.display_name).toEqual([
      "Too small: expected string to have >=2 characters",
    ]);
    expect(mundo.redirects).toEqual([]);
    // A validação acontece ANTES da escrita: nada chegou ao banco.
    expect(escritas).toEqual([]);
  });
});
