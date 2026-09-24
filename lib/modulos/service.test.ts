import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };

function fakeAdmin(
  modulosInstalados: Row[],
  rpcs: Record<string, (args: Row) => RpcResult> = {},
) {
  return {
    rpcCalls: [] as Array<{ name: string; args: Row }>,
    from(table: string) {
      if (table !== "modulos_instalados") throw new Error(`tabela inesperada: ${table}`);
      const rows = [...modulosInstalados];
      const builder = {
        select: () => builder,
        order: () => Promise.resolve({ data: rows, error: null }),
      };
      return builder;
    },
    rpc(this: { rpcCalls: Array<{ name: string; args: Row }> }, name: string, args: Row) {
      this.rpcCalls.push({ name, args });
      return Promise.resolve(rpcs[name]?.(args) ?? { data: null, error: null });
    },
  };
}

const mocks = vi.hoisted(() => ({ admin: null as unknown, audit: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.admin }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/logger", () => ({ logger: { warn: mocks.warn, error: vi.fn(), info: vi.fn() } }));

import { instalarModulo, listarModulos } from "./service";

const ACTOR = randomUUID();
const OPERATION = randomUUID();

beforeEach(() => {
  mocks.audit.mockClear();
  mocks.warn.mockClear();
});

describe("listarModulos", () => {
  it("cruza o catálogo fixo com o que está instalado nesta instância", async () => {
    mocks.admin = fakeAdmin([
      {
        modulo: "honorarios",
        estado: "ativo",
        instalado_em: "2026-01-01T00:00:00Z",
        reaplicado_em: null,
        motivo_suspensao: null,
      },
    ]);

    const resultado = await listarModulos();

    expect(resultado.disponiveis.map((m) => m.slug)).toContain("honorarios");
    expect(resultado.instalados).toHaveLength(1);
    expect(resultado.instalados[0]!.estado).toBe("ativo");
  });
});

describe("instalarModulo", () => {
  it("recusa um módulo fora do catálogo antes de chamar o banco", async () => {
    mocks.admin = fakeAdmin([]);

    await expect(instalarModulo(ACTOR, OPERATION, "nao_existe")).rejects.toMatchObject({
      code: "extension_module_unknown",
    });
    expect((mocks.admin as ReturnType<typeof fakeAdmin>).rpcCalls).toHaveLength(0);
  });

  it("instala e audita quando a chamada aplicou de verdade", async () => {
    mocks.admin = fakeAdmin([], {
      fn_modulo_instalar: () => ({
        data: {
          id: OPERATION,
          kind: "module_install",
          status: "completed",
          actor_id: ACTOR,
          name: "honorarios",
          result: { modulo: "honorarios" },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          applied_now: true,
        },
        error: null,
      }),
    });

    const resultado = await instalarModulo(ACTOR, OPERATION, "honorarios");

    expect(resultado).toEqual({ operationId: OPERATION, appliedNow: true });
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "modulo.instalado",
        actorUserId: ACTOR,
        actingAsPlatformAdmin: true,
        metadata: { modulo: "honorarios", operation_id: OPERATION },
      }),
    );
  });

  it("repetir a mesma chave de operação NÃO audita de novo (idempotência)", async () => {
    mocks.admin = fakeAdmin([], {
      fn_modulo_instalar: () => ({
        data: {
          id: OPERATION,
          kind: "module_install",
          status: "completed",
          actor_id: ACTOR,
          name: "honorarios",
          result: { modulo: "honorarios" },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          applied_now: false,
        },
        error: null,
      }),
    });

    const resultado = await instalarModulo(ACTOR, OPERATION, "honorarios");

    expect(resultado.appliedNow).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("traduz um erro de banco conhecido (P0001) em vez de um 503 genérico", async () => {
    mocks.admin = fakeAdmin([], {
      fn_modulo_instalar: () => ({
        data: null,
        error: { code: "P0001", message: "extension_core_update_in_progress" },
      }),
    });

    await expect(instalarModulo(ACTOR, OPERATION, "honorarios")).rejects.toMatchObject({
      code: "extension_core_update_in_progress",
    });
  });
});
