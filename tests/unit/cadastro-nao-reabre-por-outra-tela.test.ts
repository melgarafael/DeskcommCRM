/**
 * Salvar OUTRA configuração da instalação não reabre o cadastro.
 *
 * `platform_settings` é singleton: o comportamento da instalação, o molde de IA
 * e os destinos internos gravam na mesma linha 1 que guarda `signup_mode`
 * (#4244). Quando a linha
 * ainda não existia, a primeira dessas gravações a criava com o default da
 * coluna (`'aberto'`), e linha presente vence o `SIGNUP_MODE` do `.env` —
 * medido em produção em 2026-11-03: `SIGNUP_MODE=so_convite` e `/signup`
 * aberto. O banco abaixo reproduz o default da coluna e o `on conflict`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { envMock, banco } = vi.hoisted(() => ({
  envMock: { SIGNUP_MODE: "so_convite" } as Record<string, string | undefined>,
  banco: { linha: null as Record<string, unknown> | null, falharSemente: false },
}));

vi.mock("@/lib/env", () => ({ env: envMock }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const leitura = {
        select: () => leitura,
        eq: () => leitura,
        abortSignal: () => leitura,
        maybeSingle: async () => ({ data: banco.linha, error: null }),
      };
      return {
        ...leitura,
        upsert: async (valores: Record<string, unknown>, opcoes?: { ignoreDuplicates?: boolean }) => {
          if (opcoes?.ignoreDuplicates && banco.falharSemente) {
            return { error: { code: "XX000", message: "fora do ar" } };
          }
          if (banco.linha === null) {
            // O default da coluna: é ele que reabria o cadastro.
            banco.linha = { signup_mode: "aberto", ...valores };
          } else if (!opcoes?.ignoreDuplicates) {
            banco.linha = { ...banco.linha, ...valores };
          }
          return { error: null };
        },
      };
    },
  }),
}));

import { esquecerModoDeCadastro, modoDeCadastro } from "@/lib/auth/politica-de-cadastro";
import { gravarComportamentoDaInstalacao } from "@/lib/instalacao/comportamento-servidor";
import { gravarDestinosInternos } from "@/lib/automation/destinos-internos-autorizados";
import { gravarMoldeDeIa } from "@/lib/instalacao/molde-de-ia-servidor";
import { createAdminClient } from "@/lib/supabase/admin";

const COMPORTAMENTO = {
  orcamento_de_ia: "on",
  exigir_assinatura_no_webhook: false,
  divulgacao_de_pagamento: "inject",
  promessa_semantica: true,
} as const;

beforeEach(() => {
  banco.linha = null;
  banco.falharSemente = false;
  envMock.SIGNUP_MODE = "so_convite";
  esquecerModoDeCadastro();
});

describe("a linha da instalação nasce com o modo em vigor", () => {
  it("salvar o comportamento numa instalação sem linha mantém `so_convite`", async () => {
    expect(await gravarComportamentoDaInstalacao(COMPORTAMENTO, "u-1")).toBe(true);
    expect(banco.linha?.signup_mode).toBe("so_convite");
    esquecerModoDeCadastro();
    expect(await modoDeCadastro()).toBe("so_convite");
  });

  it("salvar os destinos internos numa instalação sem linha mantém `so_convite`", async () => {
    expect(await gravarDestinosInternos(["10.0.0.5"], "u-1")).toBe(true);
    expect(banco.linha?.signup_mode).toBe("so_convite");
  });

  it("salvar o molde de IA numa instalação sem linha mantém `so_convite`", async () => {
    // O action passa o cliente de serviço; o dublê é o mesmo banco singleton.
    const db = createAdminClient() as unknown as Parameters<typeof gravarMoldeDeIa>[0];
    expect(await gravarMoldeDeIa(db, null, "u-1")).toBe(true);
    expect(banco.linha?.signup_mode).toBe("so_convite");
  });

  it("linha que já existe não tem o modo trocado pela semente", async () => {
    banco.linha = { signup_mode: "aberto" };
    expect(await gravarComportamentoDaInstalacao(COMPORTAMENTO, "u-1")).toBe(true);
    expect(banco.linha?.signup_mode).toBe("aberto");
  });

  it("sem `SIGNUP_MODE`, a instalação continua `aberto` como antes", async () => {
    envMock.SIGNUP_MODE = undefined;
    expect(await gravarComportamentoDaInstalacao(COMPORTAMENTO, "u-1")).toBe(true);
    expect(banco.linha?.signup_mode).toBe("aberto");
  });

  it("semente recusada pelo banco: não grava, em vez de criar a linha aberta", async () => {
    banco.falharSemente = true;
    expect(await gravarComportamentoDaInstalacao(COMPORTAMENTO, "u-1")).toBe(false);
    expect(banco.linha).toBeNull();
  });
});
