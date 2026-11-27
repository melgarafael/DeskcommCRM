/**
 * O módulo `canal_webchat` (chat no site) é OPCIONAL da instalação e nasce DESLIGADO.
 *
 * `chatNoSiteLigado` é a porta que o resto do canal vai consultar. Estes casos fixam a régua
 * que a Task 6 do plano "Chat no site, parte 1" exige:
 *   - sem linha em `platform_config`, desligado;
 *   - `ligado` na instalação, ligado;
 *   - `ligado` na instalação e desligado na empresa, desligado (a empresa tira o módulo).
 *
 * O cliente é um dublê do Supabase que responde só o que `moduloLigado` lê: `platform_config`
 * (chaves por flag), `organization_modules` (exceção por empresa) e `modulos_instalados`
 * (módulos de tabela, sempre vazio aqui).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { chatNoSiteLigado } from "@/lib/channels/webchat/modulo";

const ORG = "11111111-1111-4111-8111-111111111111";

type Linha = Record<string, string | null>;

/** Dublê mínimo: cada consulta do `moduloLigado` resolve com as linhas do fixture. */
function clienteComFixture(opcoes: {
  platformConfig: Linha[];
  organizationModules?: Linha[];
}): SupabaseClient {
  const tabelas: Record<string, Linha[]> = {
    platform_config: opcoes.platformConfig,
    organization_modules: opcoes.organizationModules ?? [],
    modulos_instalados: [],
  };
  const construtor = (tabela: string) => {
    const consulta = {
      select: () => consulta,
      in: () => consulta,
      eq: () => consulta,
      then: (
        resolve: (valor: { data: Linha[]; error: null }) => unknown,
        rejeitar?: (motivo: unknown) => unknown,
      ) => Promise.resolve({ data: tabelas[tabela] ?? [], error: null }).then(resolve, rejeitar),
    };
    return consulta;
  };
  return { from: (tabela: string) => construtor(tabela) } as unknown as SupabaseClient;
}

describe("chatNoSiteLigado — o módulo canal_webchat nasce desligado", () => {
  it("sem linha em platform_config, o chat no site está desligado", async () => {
    const admin = clienteComFixture({ platformConfig: [] });
    expect(await chatNoSiteLigado(admin, ORG)).toBe(false);
  });

  it("com o módulo ligado na instalação, o chat no site está ligado", async () => {
    const admin = clienteComFixture({
      platformConfig: [{ chave: "MODULO_CANAL_WEBCHAT", valor: "ligado" }],
    });
    expect(await chatNoSiteLigado(admin, ORG)).toBe(true);
  });

  it("ligado na instalação e desligado na empresa, o chat no site está desligado", async () => {
    const admin = clienteComFixture({
      platformConfig: [{ chave: "MODULO_CANAL_WEBCHAT", valor: "ligado" }],
      organizationModules: [{ modulo: "canal_webchat", estado: "desligado" }],
    });
    expect(await chatNoSiteLigado(admin, ORG)).toBe(false);
  });

  it("valor que não é `ligado` na instalação conta como desligado (falha fechada)", async () => {
    const admin = clienteComFixture({
      platformConfig: [{ chave: "MODULO_CANAL_WEBCHAT", valor: "sim" }],
    });
    expect(await chatNoSiteLigado(admin, ORG)).toBe(false);
  });
});
