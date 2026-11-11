/**
 * Quem administra o servidor escolhe aqui a empresa cuja IA as empresas NOVAS
 * copiam ao nascer (migration 9096). A cópia é do banco; esta action só grava a
 * escolha — e recusa o que a tela não oferece (empresa inativa, id torto), com a
 * trilha na auditoria e nada gravado quando recusa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  upsert: vi.fn(),
  audit: vi.fn(),
  escrita: vi.fn(),
  revalidar: vi.fn(),
  /** As linhas que cada tabela devolve, por `.eq("id", …)`/`.eq("organization_id", …)`. */
  orgs: new Map<string, { id: string; status: string; settings?: unknown }>(),
  bindings: [] as Array<Record<string, unknown>>,
  moldeAtual: null as string | null,
}));

// A action passa por escritaDeAdminOuRecusa, que chama este helper.
vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdminEscrita: () => deps.escrita() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: deps.revalidar }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela === "platform_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { molde_de_ia_org_id: deps.moldeAtual }, error: null }),
            }),
          }),
          upsert: deps.upsert,
        };
      }
      if (tabela === "organizations") {
        return {
          select: () => ({
            eq: (_c: string, id: string) => ({
              maybeSingle: async () => ({ data: deps.orgs.get(id) ?? null, error: null }),
            }),
          }),
        };
      }
      if (tabela === "ai_purpose_bindings") {
        return { select: () => ({ eq: async () => ({ data: deps.bindings, error: null }) }) };
      }
      throw new Error(`tabela inesperada: ${tabela}`);
    },
  }),
}));

import { EscritaDePlatformAdminNegada } from "@/lib/auth/recusa-de-escrita-de-admin";
import { updateMoldeDeIa } from "./updateMoldeDeIa";

const MOLDE = "5727bccd-60cc-4a2c-8979-9378cb204904";
const SUSPENSA = "11111111-1111-4111-8111-111111111111";
const ANTERIOR = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  deps.upsert.mockResolvedValue({ error: null });
  deps.escrita.mockResolvedValue({ user: { id: "eu" } });
  deps.moldeAtual = ANTERIOR;
  deps.orgs.clear();
  deps.orgs.set(MOLDE, {
    id: MOLDE,
    status: "active",
    settings: { llm: { provider: "anthropic", default_model: "claude-sonnet-5" } },
  });
  deps.orgs.set(SUSPENSA, { id: SUSPENSA, status: "suspended" });
  deps.bindings = [
    { purpose: "stage_classifier", provider: "anthropic", model_id: "claude-haiku-5-5", base_url: null, is_enabled: true },
    { purpose: "compaction", provider: "openai", model_id: "gpt-5.6-luna", base_url: null, is_enabled: true },
    { purpose: "flush", provider: "openai", model_id: "gpt-x", base_url: "https://gw.exemplo.test", is_enabled: true },
  ];
});

describe("updateMoldeDeIa", () => {
  it("escolher uma empresa ativa grava SÓ a coluna do molde e devolve o que vai ser copiado", async () => {
    const r = await updateMoldeDeIa({ molde_de_ia_org_id: MOLDE });
    expect(r).toEqual({
      ok: true,
      resumo: {
        funcoes: 2,
        deixadas: 1,
        modelos: [
          { provider: "anthropic", model_id: "claude-haiku-5-5", funcoes: 1 },
          { provider: "openai", model_id: "gpt-5.6-luna", funcoes: 1 },
        ],
        padrao: { provider: "anthropic", default_model: "claude-sonnet-5" },
      },
    });
    // Só a coluna do molde (e o autor): as outras escolhas da instalação na
    // mesma linha não podem ser sobrescritas por esta tela.
    expect(deps.upsert).toHaveBeenCalledWith(
      { id: 1, molde_de_ia_org_id: MOLDE, updated_by: "eu" },
      { onConflict: "id" },
    );
  });

  it("audita o molde anterior, o novo e quantas funções ele copia", async () => {
    await updateMoldeDeIa({ molde_de_ia_org_id: MOLDE });
    expect(deps.audit).toHaveBeenCalledTimes(1);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "platform.molde_de_ia_updated",
        actorUserId: "eu",
        resourceType: "platform_settings",
        metadata: {
          de: ANTERIOR,
          para: MOLDE,
          funcoes: 2,
          padrao: { provider: "anthropic", default_model: "claude-sonnet-5" },
        },
      }),
    );
    expect(deps.revalidar).toHaveBeenCalledWith("/admin/sistema");
  });

  it("'Nenhuma' grava nulo — o comportamento de antes — e audita a troca", async () => {
    expect(await updateMoldeDeIa({ molde_de_ia_org_id: null })).toEqual({ ok: true, resumo: null });
    expect(deps.upsert).toHaveBeenCalledWith(
      { id: 1, molde_de_ia_org_id: null, updated_by: "eu" },
      { onConflict: "id" },
    );
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { de: ANTERIOR, para: null, funcoes: 0, padrao: null } }),
    );
  });

  it.each([
    ["empresa suspensa", SUSPENSA],
    ["empresa que não existe", "33333333-3333-4333-8333-333333333333"],
  ])("recusa %s como molde, sem gravar nem auditar", async (_caso, id) => {
    expect(await updateMoldeDeIa({ molde_de_ia_org_id: id })).toEqual({ ok: false, error: "molde_invalido" });
    expect(deps.upsert).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("recusa id que não é uuid (Zod), sem gravar", async () => {
    expect(await updateMoldeDeIa({ molde_de_ia_org_id: "nao-e-uuid" })).toEqual({ ok: false, error: "invalid_input" });
    expect(deps.upsert).not.toHaveBeenCalled();
  });

  it("o banco recusou a gravação: devolve write_failed e não audita uma troca que não houve", async () => {
    deps.upsert.mockResolvedValue({ error: { code: "42703", message: "column does not exist" } });
    expect(await updateMoldeDeIa({ molde_de_ia_org_id: MOLDE })).toEqual({ ok: false, error: "write_failed" });
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it.each(["forbidden_scope", "mfa_required"] as const)(
    "recusa de escrita (%s) VOLTA como resultado e nada é lido, gravado nem auditado",
    async (codigo) => {
      deps.escrita.mockRejectedValue(new EscritaDePlatformAdminNegada(codigo));
      expect(await updateMoldeDeIa({ molde_de_ia_org_id: MOLDE })).toEqual({ ok: false, error: codigo });
      expect(deps.upsert).not.toHaveBeenCalled();
      expect(deps.audit).not.toHaveBeenCalled();
    },
  );
});
