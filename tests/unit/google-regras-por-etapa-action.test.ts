import { beforeEach, describe, expect, it, vi } from "vitest";
import { salvarRegrasDeConversaoGoogle } from "@/app/actions/settings/salvarRegrasDeConversaoGoogle";

const mock = vi.hoisted(() => ({
  user: vi.fn(),
  org: vi.fn(),
  mfa: vi.fn(),
  support: vi.fn(),
  admin: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: mock.user,
  resolveActiveOrg: mock.org,
  mfaEmDivida: mock.mfa,
}));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: mock.support }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mock.admin }));
vi.mock("@/lib/audit", () => ({ audit: mock.audit }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const LEGADA = "33333333-3333-4333-8333-333333333333";
const REGRA_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REGRA_LEGADA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REGRA_OUTRA_CONTA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const regra = (stage_id: string, over: Record<string, unknown> = {}) => ({
  stage_id,
  enabled: true,
  label: "Lead qualificado",
  google_action_id: "42",
  category: "QUALIFIED_LEAD" as const,
  included_in_conversions: true,
  channel: "todos" as const,
  ...over,
});

let etapasValidas: string[];
let existentes: Array<Record<string, unknown>>;
let upserts: Array<{ linhas: Array<Record<string, unknown>>; onConflict: string }>;
let updates: Array<{ valores: Record<string, unknown>; filtros: Array<[string, unknown]> }>;
let filtrosDeLeitura: Array<[string, unknown]>;

beforeEach(() => {
  vi.clearAllMocks();
  etapasValidas = [A, B];
  existentes = [];
  upserts = [];
  updates = [];
  filtrosDeLeitura = [];
  mock.user.mockResolvedValue({ id: "u", is_platform_admin: false });
  mock.org.mockResolvedValue({ orgId: "org-autenticada", role: "admin" });
  mock.support.mockReturnValue(false);
  mock.mfa.mockResolvedValue(false);
  mock.admin.mockReturnValue({
    from: (tabela: string) => {
      const filtros: Array<[string, unknown]> = [];
      let atualizando: Record<string, unknown> | null = null;
      const resolver = () => {
        if (atualizando) {
          updates.push({ valores: atualizando, filtros });
          return { data: null, error: null };
        }
        filtrosDeLeitura.push(...filtros);
        if (tabela === "crm_stages") {
          const pedidas = (filtros.find(([k]) => k === "id:in")?.[1] ?? []) as string[];
          return {
            data: pedidas.filter((id) => etapasValidas.includes(id)).map((id) => ({ id })),
            error: null,
          };
        }
        return { data: existentes, error: null };
      };
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => {
          filtros.push([k, v]);
          return q;
        },
        in: (k: string, v: unknown) => {
          filtros.push([`${k}:in`, v]);
          return q;
        },
        update: (v: Record<string, unknown>) => {
          atualizando = v;
          return q;
        },
        upsert: async (linhas: Array<Record<string, unknown>>, opcoes: { onConflict: string }) => {
          upserts.push({ linhas, onConflict: opcoes.onConflict });
          return { error: null };
        },
        then: (ok: (v: unknown) => unknown) => Promise.resolve(resolver()).then(ok),
      };
      return q;
    },
  });
});

describe("salvar regras de conversão por etapa", () => {
  it("regra nova ganha evento Etapa:<uuid>, na organização autenticada, e é auditada", async () => {
    expect(await salvarRegrasDeConversaoGoogle([regra(A), regra(B, { enabled: false })])).toEqual({
      ok: true,
    });
    expect(filtrosDeLeitura).toContainEqual(["organization_id", "org-autenticada"]);
    expect(filtrosDeLeitura).toContainEqual(["is_won", false]);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.onConflict).toBe("organization_id,stage_id,google_customer_id");
    // B desligada e nunca existiu: não vira linha.
    expect(upserts[0]!.linhas).toHaveLength(1);
    expect(upserts[0]!.linhas[0]).toMatchObject({
      organization_id: "org-autenticada",
      stage_id: A,
      event_name: `Etapa:${A}`,
      google_action_id: "42",
      google_customer_id: null,
      google_login_customer_id: null,
    });
    expect(mock.audit).toHaveBeenCalledOnce();
  });
  it("a qualificação migrada mantém o nome QualifiedLead e a que some da lista é desligada, não apagada", async () => {
    existentes = [
      {
        id: REGRA_A,
        stage_id: A,
        event_name: "QualifiedLead",
        label: "Antiga",
        google_action_id: "9",
        google_customer_id: null,
      },
      {
        id: REGRA_LEGADA,
        stage_id: LEGADA,
        event_name: `Etapa:${LEGADA}`,
        label: "X",
        google_action_id: "8",
        google_customer_id: null,
      },
    ];
    expect(await salvarRegrasDeConversaoGoogle([regra(A)])).toEqual({ ok: true });
    expect(upserts[0]!.linhas[0]).toMatchObject({ stage_id: A, event_name: "QualifiedLead" });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.valores).toMatchObject({ enabled: false });
    expect(updates[0]!.filtros).toContainEqual(["organization_id", "org-autenticada"]);
    expect(updates[0]!.filtros).toContainEqual(["id:in", [REGRA_LEGADA]]);
    expect(updates[0]!.filtros).not.toContainEqual(["id:in", [REGRA_A]]);
  });
  it("retirar uma conta da etapa desliga só a regra ausente, preservando a outra conta e o evento", async () => {
    existentes = [
      {
        id: REGRA_A,
        stage_id: A,
        event_name: "QualifiedLead",
        label: "Global",
        google_action_id: "9",
        google_customer_id: null,
      },
      {
        id: REGRA_OUTRA_CONTA,
        stage_id: A,
        event_name: "QualifiedLead",
        label: "Outra conta",
        google_action_id: "8",
        google_customer_id: "1112223333",
      },
    ];
    expect(await salvarRegrasDeConversaoGoogle([regra(A)])).toEqual({ ok: true });
    expect(upserts[0]!.linhas).toEqual([
      expect.objectContaining({
        organization_id: "org-autenticada",
        stage_id: A,
        event_name: "QualifiedLead",
        google_customer_id: null,
      }),
    ]);
    expect(updates).toEqual([
      {
        valores: expect.objectContaining({ enabled: false }),
        filtros: [
          ["organization_id", "org-autenticada"],
          ["id:in", [REGRA_OUTRA_CONTA]],
        ],
      },
    ]);
    expect(mock.audit).toHaveBeenCalledOnce();
  });
  it("desligar uma regra existente sem ação preserva a ação gravada (colunas NOT NULL)", async () => {
    existentes = [
      {
        id: REGRA_A,
        stage_id: A,
        event_name: `Etapa:${A}`,
        label: "Antiga",
        google_action_id: "9",
        google_customer_id: null,
      },
    ];
    await salvarRegrasDeConversaoGoogle([
      regra(A, { enabled: false, google_action_id: "", label: "" }),
    ]);
    expect(upserts[0]!.linhas[0]).toMatchObject({
      enabled: false,
      google_action_id: "9",
      label: "Antiga",
    });
  });
  it("etapa de outra organização ou fechada é recusada sem escrever", async () => {
    etapasValidas = [A];
    expect(await salvarRegrasDeConversaoGoogle([regra(A), regra(B)])).toMatchObject({
      error: "etapa_invalida",
    });
    expect(upserts).toHaveLength(0);
  });
  it("regra ligada sem ação, etapa repetida e categoria desconhecida são recusadas", async () => {
    expect(await salvarRegrasDeConversaoGoogle([regra(A, { google_action_id: "" })])).toMatchObject(
      {
        error: "validation_failed",
      },
    );
    expect(await salvarRegrasDeConversaoGoogle([regra(A), regra(A)])).toMatchObject({
      error: "validation_failed",
    });
    expect(
      await salvarRegrasDeConversaoGoogle([regra(A, { category: "VENDA" as never })]),
    ).toMatchObject({ error: "validation_failed" });
    expect(mock.admin).not.toHaveBeenCalled();
  });
  it.each(["agent", "viewer", "manager"])("papel %s não altera regras", async (role) => {
    mock.org.mockResolvedValue({ orgId: "org-autenticada", role });
    expect(await salvarRegrasDeConversaoGoogle([regra(A)])).toMatchObject({
      error: "forbidden_role",
    });
    expect(mock.admin).not.toHaveBeenCalled();
  });
  it("suporte somente leitura e MFA pendente bloqueiam", async () => {
    mock.support.mockReturnValue(true);
    expect(await salvarRegrasDeConversaoGoogle([regra(A)])).toMatchObject({
      error: "forbidden_role",
    });
    mock.support.mockReturnValue(false);
    mock.mfa.mockResolvedValue(true);
    expect(await salvarRegrasDeConversaoGoogle([regra(A)])).toMatchObject({
      error: "mfa_required",
    });
    expect(upserts).toHaveLength(0);
  });
});

it("administrador de plataforma em suporte não ultrapassa o papel do tenant", async () => {
  mock.user.mockResolvedValue({ id: "u", is_platform_admin: true, support: {} });
  mock.org.mockResolvedValue({ orgId: "org-autenticada", role: "viewer" });
  expect(await salvarRegrasDeConversaoGoogle([regra(A)])).toEqual({
    ok: false,
    error: "forbidden_role",
  });
  expect(mock.admin).not.toHaveBeenCalled();
});
