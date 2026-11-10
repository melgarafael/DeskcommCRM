/**
 * O menu e a trava do Inbox (#3012) dividem `organizations.interface_settings`.
 * O que se prova: cada cartão grava só a SUA parte, e o retrato que o outro
 * cartão leu na montagem da página não desfaz o que foi salvo depois.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: mocks.loadAuthUser,
  resolveActiveOrg: mocks.resolveActiveOrg,
  mfaEmDivida: async () => false,
}));
vi.mock("@/lib/auth/pode-administrar-empresa", () => ({ podeAdministrarEmpresa: () => true }));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));

import { combinarInterfaces } from "@/lib/navigation/interface";

import { atualizarBloqueioAteAssumir, atualizarInterfaceDaEmpresa } from "./atualizarInterfaceDaEmpresa";

const ORG = "11111111-1111-4111-8111-111111111111";

function adminCom(gravado: unknown) {
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
      b.eq = (col: string, id: unknown) => {
        expect([col, id]).toEqual(["id", ORG]);
        if (payload === null) return b;
        updates.push(payload);
        return Promise.resolve({ error: null });
      };
      b.maybeSingle = async () => ({ data: { interface_settings: structuredClone(gravado) }, error: null });
      return b;
    },
    rpc: () => Promise.resolve({ error: null }),
  };
  mocks.createAdminClient.mockReturnValue(admin);
  return updates;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadAuthUser.mockResolvedValue({ id: "u1", support: null });
  mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG, role: "admin" });
});

describe("atualizarInterfaceDaEmpresa (cartão Menu)", () => {
  it("trocar o menu mantém a trava que já está gravada", async () => {
    const updates = adminCom({ preset: "completa", bloquearAteAssumir: true });
    expect(await atualizarInterfaceDaEmpresa({ preset: "simplificada" })).toEqual({ ok: true });
    expect(updates).toEqual([{ interface_settings: { preset: "simplificada", bloquearAteAssumir: true } }]);
  });

  it("o `true` velho da montagem não religa a trava desligada depois", async () => {
    const updates = adminCom({ preset: "completa" });
    await atualizarInterfaceDaEmpresa({ preset: "simplificada", bloquearAteAssumir: true });
    expect(updates).toEqual([{ interface_settings: { preset: "simplificada" } }]);
  });
});

describe("atualizarBloqueioAteAssumir (cartão Inbox)", () => {
  it("ligar a trava preserva os destinos gravados depois da montagem", async () => {
    const updates = adminCom({ preset: "completa", destinos: ["/app/inbox"] });
    expect(await atualizarBloqueioAteAssumir(true)).toEqual({ ok: true });
    expect(updates).toEqual([
      { interface_settings: { preset: "completa", destinos: ["/app/inbox"], bloquearAteAssumir: true } },
    ]);
  });

  it("desligar remove a chave e deixa o menu como está", async () => {
    const updates = adminCom({ preset: "simplificada", bloquearAteAssumir: true });
    await atualizarBloqueioAteAssumir(false);
    expect(updates).toEqual([{ interface_settings: { preset: "simplificada" } }]);
  });

  it("entrada que não é booleano é recusada antes de qualquer leitura", async () => {
    expect(await atualizarBloqueioAteAssumir("true" as never)).toEqual({ ok: false, error: "validation_failed" });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });
});

/**
 * `compras_campos` (#3179, cartão Menu) e `bloquearAteAssumir` (#3012, cartão
 * Inbox) moram no MESMO jsonb e chegaram por PRs paralelos. Salvar um cartão não
 * pode apagar a chave do outro — nem na gravação, nem na leitura combinada que
 * alimenta `ActiveOrg.interface_settings`.
 */
describe("as duas chaves do mesmo campo (#3012 × #3179)", () => {
  it("ligar a trava no cartão Inbox não apaga os campos de compra", async () => {
    const updates = adminCom({ preset: "completa", compras_campos: ["destino"] });
    await atualizarBloqueioAteAssumir(true);
    expect(updates).toEqual([
      { interface_settings: { preset: "completa", compras_campos: ["destino"], bloquearAteAssumir: true } },
    ]);
  });

  it("salvar os campos de compra no cartão Menu não apaga a trava", async () => {
    const updates = adminCom({ preset: "completa", bloquearAteAssumir: true });
    await atualizarInterfaceDaEmpresa({ preset: "completa", compras_campos: ["destino", "hospedagem"] });
    expect(updates).toEqual([
      {
        interface_settings: {
          preset: "completa",
          compras_campos: ["destino", "hospedagem"],
          bloquearAteAssumir: true,
        },
      },
    ]);
  });

  it("a interface combinada carrega as duas chaves da empresa", () => {
    const daEmpresa = { preset: "completa", compras_campos: ["destino"], bloquearAteAssumir: true };
    expect(combinarInterfaces(daEmpresa, null)).toMatchObject({
      compras_campos: ["destino"],
      bloquearAteAssumir: true,
    });
    expect(combinarInterfaces(daEmpresa, { preset: "simplificada" })).toMatchObject({
      compras_campos: ["destino"],
      bloquearAteAssumir: true,
    });
  });
});
