/**
 * A gravação do interruptor POR EMPRESA do `ai_decide` (#2367).
 *
 * O que se prova: quem pode gravar (manager+), DE ONDE vem o org (da sessão,
 * nunca do argumento), que o merge do jsonb preserva o que não é desta chave
 * — nos dois níveis — e que a troca entra no audit log.
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

import { definirAiDecideDaEmpresa } from "./definirAiDecideDaEmpresa";

const USER = { id: "00000000-0000-4000-8000-000000000001", support: null };
const ORG_DA_SESSAO = "11111111-1111-4111-8111-111111111111";

/** O `settings` que já estava gravado: tem de sobreviver à troca da chave. */
const SETTINGS_ATUAL = {
  branding: { accent_hex: "#123456" },
  automacoes: { outra_chave: 7 },
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
  mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG_DA_SESSAO, role: "manager" });
  mocks.mfaEmDivida.mockResolvedValue(false);
});

describe("definirAiDecideDaEmpresa", () => {
  it.each(["viewer", "agent"])("%s é recusado e nada é gravado", async (role) => {
    mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG_DA_SESSAO, role });

    expect(await definirAiDecideDaEmpresa(false)).toEqual({ ok: false, error: "forbidden_role" });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("entrada que não é booleano é recusada antes de qualquer leitura", async () => {
    expect(await definirAiDecideDaEmpresa("false" as never)).toEqual({ ok: false, error: "validation_failed" });
    expect(mocks.loadAuthUser).not.toHaveBeenCalled();
  });

  it("manager grava no org DA SESSÃO, preservando as outras chaves nos dois níveis", async () => {
    expect(await definirAiDecideDaEmpresa(false)).toEqual({ ok: true });

    expect(fake.gravado.leituras).toEqual([ORG_DA_SESSAO]);
    expect(fake.gravado.updates).toEqual([
      {
        id: ORG_DA_SESSAO,
        payload: {
          settings: {
            branding: { accent_hex: "#123456" },
            automacoes: { outra_chave: 7, ai_decide: false },
          },
        },
      },
    ]);
  });

  it("a troca entra no audit log, com o valor gravado", async () => {
    await definirAiDecideDaEmpresa(true);

    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settings.automation_ai_decide_updated",
        actorUserId: USER.id,
        organizationId: ORG_DA_SESSAO,
        resourceId: ORG_DA_SESSAO,
        metadata: { ligado: true },
      }),
    );
  });
});
