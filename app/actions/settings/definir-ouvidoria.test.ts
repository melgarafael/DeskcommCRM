/**
 * LIGAR A OUVIDORIA EXIGE O MÓDULO INSTALADO (#3611, fatia 1, PR #3625).
 *
 * Sem `fn_ouvidoria_provisionar` a tabela não existe: gravar `ativa: true` seria
 * uma promessa sem efeito, e cada relato viraria erro de banco. Desligar segue
 * livre, para nenhuma empresa ficar presa com a chave ligada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
  mfaEmDivida: vi.fn(),
  createAdminClient: vi.fn(),
  moduloLigado: vi.fn(),
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
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: mocks.moduloLigado }));

import { definirOuvidoriaDaEmpresa } from "./definir-ouvidoria";

const ORG = "11111111-1111-4111-8111-111111111111";

function adminQueGrava() {
  const updates: unknown[] = [];
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
      b.eq = () => {
        if (payload !== null) {
          updates.push(payload);
          return Promise.resolve({ error: null });
        }
        return b;
      };
      b.maybeSingle = async () => ({ data: { settings: { crm: { x: 1 } } }, error: null });
      return b;
    },
  };
  return { admin, updates };
}

let fake: ReturnType<typeof adminQueGrava>;

beforeEach(() => {
  vi.clearAllMocks();
  fake = adminQueGrava();
  mocks.createAdminClient.mockReturnValue(fake.admin);
  mocks.loadAuthUser.mockResolvedValue({ id: "00000000-0000-4000-8000-000000000001", support: null });
  mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG, role: "admin" });
  mocks.mfaEmDivida.mockResolvedValue(false);
  mocks.moduloLigado.mockResolvedValue(true);
});

describe("definirOuvidoriaDaEmpresa — o módulo da instalação", () => {
  it("⭐ ligar sem o módulo instalado é recusado, e nada é gravado", async () => {
    mocks.moduloLigado.mockResolvedValue(false);

    expect(await definirOuvidoriaDaEmpresa({ ativa: true })).toEqual({
      ok: false,
      error: "modulo_nao_instalado",
    });
    expect(mocks.moduloLigado).toHaveBeenCalledWith(fake.admin, "ouvidoria");
    expect(fake.updates).toHaveLength(0);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("desligar sem o módulo instalado segue livre", async () => {
    mocks.moduloLigado.mockResolvedValue(false);

    expect(await definirOuvidoriaDaEmpresa({ ativa: false })).toEqual({ ok: true });
    expect(fake.updates).toEqual([{ settings: { crm: { x: 1 }, ouvidoria: { ativa: false } } }]);
  });

  it("ligar com o módulo instalado grava, preservando o resto do settings (controle)", async () => {
    expect(await definirOuvidoriaDaEmpresa({ ativa: true })).toEqual({ ok: true });
    expect(fake.updates).toEqual([{ settings: { crm: { x: 1 }, ouvidoria: { ativa: true } } }]);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "settings.ouvidoria_updated", metadata: { ativa: true } }),
    );
  });
});
