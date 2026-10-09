/**
 * Quem administra o servidor liga e desliga os módulos opcionais aqui. A
 * cobrança do revendedor (spec 2026-09-29) acrescenta duas regras: nesta versão
 * ela ainda não liga, e desligá-la libera toda empresa suspensa por falta de
 * pagamento (§7h), com a contagem no audit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ upsert: vi.fn(), audit: vi.fn(), rpc: vi.fn(), escrita: vi.fn() }));

// A action passa por escritaDeAdminOuRecusa (regra D), que chama este helper.
vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdminEscrita: () => deps.escrita() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ in: async () => ({ data: [], error: null }) }),
      upsert: deps.upsert,
    }),
    rpc: deps.rpc,
  }),
}));

import { EscritaDePlatformAdminNegada } from "@/lib/auth/recusa-de-escrita-de-admin";
import { updateModuloDaInstalacao } from "./updateModuloDaInstalacao";

const acoes = () => deps.audit.mock.calls.map((c) => (c[0] as { action: string }).action);

beforeEach(() => {
  vi.clearAllMocks();
  deps.upsert.mockResolvedValue({ error: null });
  // A primeira liberação solta 3; a segunda (depois de gravar) não acha mais nenhuma.
  // `mockReset`: o `clearAllMocks` não esvazia a fila de `mockResolvedValueOnce`.
  deps.rpc.mockReset().mockResolvedValueOnce({ data: 3, error: null }).mockResolvedValue({ data: 0, error: null });
  deps.escrita.mockResolvedValue({ user: { id: "eu" } });
});

describe("updateModuloDaInstalacao", () => {
  it("com as telas, os roteiros de atendimento LIGAM", async () => {
    expect(await updateModuloDaInstalacao({ modulo: "fluxos_atendimento", ligado: true })).toEqual({ ok: true });
    expect(deps.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ chave: "MODULO_FLUXOS_DE_ATENDIMENTO", valor: "ligado" }),
      expect.anything(),
    );
  });

  it("desligar os roteiros continua permitido, e não chama a liberação da cobrança", async () => {
    expect(await updateModuloDaInstalacao({ modulo: "fluxos_atendimento", ligado: false })).toEqual({ ok: true });
    expect(deps.rpc).not.toHaveBeenCalled();
  });

  it("o banco externo liga como sempre", async () => {
    expect(await updateModuloDaInstalacao({ modulo: "banco_externo", ligado: true })).toEqual({ ok: true });
    expect(deps.upsert).toHaveBeenCalledTimes(1);
  });

  it.each(["forbidden_scope", "mfa_required"] as const)(
    "recusa de escrita (%s) VOLTA como resultado — não lança ao error boundary — e nada é gravado nem liberado",
    async (codigo) => {
      deps.escrita.mockRejectedValue(new EscritaDePlatformAdminNegada(codigo));
      expect(await updateModuloDaInstalacao({ modulo: "cobranca", ligado: false })).toEqual({ ok: false, error: codigo });
      expect(deps.upsert).not.toHaveBeenCalled();
      expect(deps.rpc).not.toHaveBeenCalled();
      expect(deps.audit).not.toHaveBeenCalled();
    },
  );
});

describe("a chave da cobrança", () => {
  it("ligar grava a chave e não libera nada (a liberação é só do desligar)", async () => {
    expect(await updateModuloDaInstalacao({ modulo: "cobranca", ligado: true })).toEqual({ ok: true });
    expect(deps.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ chave: "MODULO_COBRANCA", valor: "ligado" }),
      expect.anything(),
    );
    expect(deps.rpc).not.toHaveBeenCalled();
  });

  it("desligar libera as suspensas ANTES de gravar a chave, e audita quantas", async () => {
    expect(await updateModuloDaInstalacao({ modulo: "cobranca", ligado: false })).toEqual({ ok: true });
    expect(deps.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ chave: "MODULO_COBRANCA", valor: "desligado" }),
      expect.anything(),
    );
    expect(deps.rpc).toHaveBeenCalledWith("fn_cobranca_liberar_suspensoes", { p_ator: "eu" });
    expect(deps.rpc.mock.invocationCallOrder[0]).toBeLessThan(deps.upsert.mock.invocationCallOrder[0]!);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cobranca.modulo_desligado", actorUserId: "eu", metadata: { liberadas: 3 } }),
    );
    expect(acoes()).toEqual(["platform.modulo_updated", "cobranca.modulo_desligado"]);
  });

  // Entre a liberação e a gravação, uma chamada de LLM ainda vê a cobrança
  // ligada e pode reabrir o aviso do teto do plano. Depois de gravar, ninguém
  // mais o fecharia (o gate não lê o teto com a chave desligada): a liberação
  // roda de novo, e a contagem auditada soma as duas.
  it("⭐ desligar libera de novo DEPOIS de gravar a chave, e audita a soma", async () => {
    deps.rpc.mockReset().mockResolvedValueOnce({ data: 3, error: null }).mockResolvedValueOnce({ data: 1, error: null });
    expect(await updateModuloDaInstalacao({ modulo: "cobranca", ligado: false })).toEqual({ ok: true });
    expect(deps.rpc).toHaveBeenCalledTimes(2);
    expect(deps.rpc.mock.invocationCallOrder[1]).toBeGreaterThan(deps.upsert.mock.invocationCallOrder[0]!);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cobranca.modulo_desligado", metadata: { liberadas: 4 } }),
    );
  });

  it("a segunda liberação falhando não desfaz o desligamento: a chave já gravou", async () => {
    deps.rpc
      .mockReset()
      .mockResolvedValueOnce({ data: 3, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: "57014", message: "timeout" } });
    expect(await updateModuloDaInstalacao({ modulo: "cobranca", ligado: false })).toEqual({ ok: true });
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cobranca.modulo_desligado", metadata: { liberadas: 3 } }),
    );
  });

  it("⭐ liberação que falha deixa a chave INTACTA: nada gravado, nada auditado, e a linha segue na tela para tentar de novo", async () => {
    // Com a chave gravada antes, a linha sumia de /admin/sistema (travada e
    // desligada = escondida) e as suspensas por cobrança ficavam sem saída:
    // /reactivate recusa esse tipo, e prazo/isenção dão 404 com a chave desligada.
    deps.rpc.mockReset().mockResolvedValue({ data: null, error: { code: "42501", message: "negado" } });
    expect(await updateModuloDaInstalacao({ modulo: "cobranca", ligado: false })).toEqual({
      ok: false,
      error: "liberacao_falhou",
    });
    expect(deps.upsert).not.toHaveBeenCalled();
    expect(acoes()).toEqual([]);
  });

  it("chave que não grava depois da liberação: write_failed, e o desligamento não é auditado", async () => {
    deps.upsert.mockResolvedValue({ error: { code: "57014", message: "timeout" } });
    expect(await updateModuloDaInstalacao({ modulo: "cobranca", ligado: false })).toEqual({
      ok: false,
      error: "write_failed",
    });
    expect(deps.rpc).toHaveBeenCalledTimes(1);
    expect(acoes()).toEqual([]);
  });
});
