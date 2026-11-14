import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O PORTÃO DA INSTALAÇÃO (adaptação do #4536 para módulo opcional, #4376).
 *
 * Aqui roda o `lib/instalacao/modulos.ts` de verdade; só o cliente de serviço é
 * dublê. O que se prova: só `ligado` liga, e qualquer outra coisa — linha
 * ausente, valor estranho, erro do banco, ambiente sem cliente — é DESLIGADO.
 */
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { esquecerMemoDosModulos } from "@/lib/instalacao/modulos";
import { revisaoPorKmLigada, revisaoPorKmLigadaComMemo } from "@/lib/revisao-por-km/modulo";

type Resposta = { data: unknown; error: { code: string; message: string } | null };

/** Dublê do supabase-js: `from(t).select().in()[.eq()]` resolve na resposta da tabela. */
function clienteCom(platformConfig: Resposta | (() => never)) {
  const leituras: string[] = [];
  const cadeia = (tabela: string) => {
    const resolver = () => {
      if (tabela === "platform_config") {
        if (typeof platformConfig === "function") platformConfig();
        return platformConfig as Resposta;
      }
      return { data: [], error: null };
    };
    const no: Record<string, unknown> = {};
    for (const metodo of ["select", "in", "eq"]) no[metodo] = () => no;
    no.then = (ok: (v: Resposta) => unknown, falha: (e: unknown) => unknown) => {
      try {
        return Promise.resolve(resolver()).then(ok, falha);
      } catch (erro) {
        return Promise.reject(erro).then(ok, falha);
      }
    };
    return no;
  };
  return {
    leituras,
    cliente: {
      from: (tabela: string) => {
        leituras.push(tabela);
        return cadeia(tabela);
      },
    },
  };
}

beforeEach(() => {
  esquecerMemoDosModulos();
  vi.mocked(createAdminClient).mockReset();
});
afterEach(() => esquecerMemoDosModulos());

describe("revisaoPorKmLigada — só `ligado` liga", () => {
  it("linha ausente em platform_config (o padrão de fábrica) = desligado", async () => {
    const { cliente } = clienteCom({ data: [], error: null });
    vi.mocked(createAdminClient).mockReturnValue(cliente as never);
    expect(await revisaoPorKmLigada()).toBe(false);
  });

  it("MODULO_REVISAO_POR_KM = ligado = ligado", async () => {
    const { cliente } = clienteCom({ data: [{ chave: "MODULO_REVISAO_POR_KM", valor: "ligado" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue(cliente as never);
    expect(await revisaoPorKmLigada()).toBe(true);
  });

  it("valor estranho (`sim`, `true`, `desligado`) = desligado", async () => {
    for (const valor of ["sim", "true", "desligado", null]) {
      const { cliente } = clienteCom({ data: [{ chave: "MODULO_REVISAO_POR_KM", valor }], error: null });
      vi.mocked(createAdminClient).mockReturnValue(cliente as never);
      expect(await revisaoPorKmLigada()).toBe(false);
    }
  });

  it("outro módulo ligado não liga este", async () => {
    const { cliente } = clienteCom({ data: [{ chave: "MODULO_COLD_CALL", valor: "ligado" }], error: null });
    vi.mocked(createAdminClient).mockReturnValue(cliente as never);
    expect(await revisaoPorKmLigada()).toBe(false);
  });

  it("platform_config recusada pelo banco = desligado (falha fechada)", async () => {
    const { cliente } = clienteCom({ data: null, error: { code: "42501", message: "permission denied" } });
    vi.mocked(createAdminClient).mockReturnValue(cliente as never);
    expect(await revisaoPorKmLigada()).toBe(false);
  });

  it("banco fora (a leitura lança) = desligado, sem lançar", async () => {
    const { cliente } = clienteCom(() => {
      throw new Error("ECONNREFUSED");
    });
    vi.mocked(createAdminClient).mockReturnValue(cliente as never);
    await expect(revisaoPorKmLigada()).resolves.toBe(false);
    await expect(revisaoPorKmLigadaComMemo()).resolves.toBe(false);
  });

  it("ambiente sem cliente de serviço (createAdminClient lança) = desligado, sem lançar", async () => {
    vi.mocked(createAdminClient).mockImplementation(() => {
      throw new Error("Variáveis de ambiente inválidas");
    });
    await expect(revisaoPorKmLigada()).resolves.toBe(false);
    await expect(revisaoPorKmLigadaComMemo()).resolves.toBe(false);
  });
});

describe("revisaoPorKmLigadaComMemo — o caminho quente lê a chave uma vez por janela", () => {
  it("dez respostas de roteiro seguidas = uma leitura de platform_config", async () => {
    const { cliente, leituras } = clienteCom({ data: [], error: null });
    vi.mocked(createAdminClient).mockReturnValue(cliente as never);
    for (let i = 0; i < 10; i++) expect(await revisaoPorKmLigadaComMemo()).toBe(false);
    expect(leituras.filter((t) => t === "platform_config")).toHaveLength(1);
  });
});
