/**
 * A gravação da lista de perfis que podem revelar o texto retido (#4500).
 *
 * O que se prova, e é o desenho da issue:
 *   1. só ADMINISTRADOR grava — conceder leitura de conteúdo retido não é
 *      decisão de manager;
 *   2. a organização vem da SESSÃO (`resolveActiveOrg`), nunca do argumento —
 *      não existe caminho para gravar na lista de outra empresa;
 *   3. o merge do jsonb preserva o que não é desta chave (branding, llm…);
 *   4. a mudança entra no audit log com `de` e `para`, e sem conteúdo;
 *   5. a lista começa vazia e aceita só papéis humanos.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
  mfaEmDivida: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: mocks.loadAuthUser,
  resolveActiveOrg: mocks.resolveActiveOrg,
  mfaEmDivida: mocks.mfaEmDivida,
}));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));

import { definirPerfisDoTextoRetido } from "./definirPerfisDoTextoRetido";

const USER = { id: "00000000-0000-4000-8000-000000000001", support: null };
const ORG_DA_SESSAO = "11111111-1111-4111-8111-111111111111";

/** O `settings` que já estava gravado: tem de sobreviver à troca da chave. */
const SETTINGS_ATUAL = {
  branding: { accent_hex: "#123456" },
  llm: { default_model: "modelo-x" },
};

function adminQueGrava() {
  const gravado = { updates: [] as Array<{ payload: unknown; id: unknown }>, leituras: [] as unknown[] };
  const admin = {
    from(table: string) {
      expect(table).toBe("organizations");
      let payload: unknown = null;
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.update = (p: unknown) => {
        payload = p;
        return b;
      };
      b.eq = (_col: string, id: unknown) => {
        if (payload !== null) {
          gravado.updates.push({ payload, id });
          return Promise.resolve({ error: null });
        }
        gravado.leituras.push(id);
        return b;
      };
      b.maybeSingle = async () => ({ data: { settings: structuredClone(SETTINGS_ATUAL) }, error: null });
      return b;
    },
  };
  return { admin, gravado };
}

let fake: ReturnType<typeof adminQueGrava>;

beforeEach(() => {
  vi.clearAllMocks();
  fake = adminQueGrava();
  mocks.createAdminClient.mockReturnValue(fake.admin);
  mocks.loadAuthUser.mockResolvedValue(USER);
  mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG_DA_SESSAO, role: "admin" });
  mocks.mfaEmDivida.mockResolvedValue(false);
});

describe("definirPerfisDoTextoRetido", () => {
  it.each(["viewer", "agent", "manager"])("%s é recusado e nada é gravado", async (role) => {
    mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG_DA_SESSAO, role });

    const r = await definirPerfisDoTextoRetido(["admin"]);

    expect(r).toEqual({ ok: false, error: "forbidden_role" });
    expect(fake.gravado.updates).toHaveLength(0);
  });

  it("admin grava na organização DA SESSÃO, preservando as outras chaves", async () => {
    const r = await definirPerfisDoTextoRetido(["manager", "admin"]);

    expect(r).toEqual({ ok: true });
    expect(fake.gravado.leituras).toEqual([ORG_DA_SESSAO]);
    expect(fake.gravado.updates).toHaveLength(1);
    expect(fake.gravado.updates[0]!.id).toBe(ORG_DA_SESSAO);
    expect(fake.gravado.updates[0]!.payload).toEqual({
      settings: {
        branding: { accent_hex: "#123456" },
        llm: { default_model: "modelo-x" },
        texto_retido: { perfis: ["manager", "admin"] },
      },
    });
  });

  it("a lista vazia é um valor legítimo — é o padrão de fábrica", async () => {
    const r = await definirPerfisDoTextoRetido([]);

    expect(r).toEqual({ ok: true });
    expect(fake.gravado.updates[0]!.payload).toMatchObject({ settings: { texto_retido: { perfis: [] } } });
  });

  it("%s e valor fora da lista são recusados na validação", async () => {
    await expect(definirPerfisDoTextoRetido(["super_admin"])).resolves.toEqual({
      ok: false,
      error: "validation_failed",
    });
    await expect(definirPerfisDoTextoRetido("admin" as unknown as string[])).resolves.toEqual({
      ok: false,
      error: "validation_failed",
    });
    expect(fake.gravado.updates).toHaveLength(0);
  });

  it("audita a mudança com de/para, só papéis", async () => {
    await definirPerfisDoTextoRetido(["manager"]);

    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settings.retained_text_profiles_updated",
        actorUserId: USER.id,
        organizationId: ORG_DA_SESSAO,
        metadata: { de: [], para: ["manager"] },
      }),
    );
  });

  it("sem MFA em dia, não grava", async () => {
    mocks.mfaEmDivida.mockResolvedValue(true);

    const r = await definirPerfisDoTextoRetido(["manager"]);

    expect(r).toEqual({ ok: false, error: "mfa_required" });
    expect(fake.gravado.updates).toHaveLength(0);
  });
});
