/**
 * O controlador dos dados que a janela pública do chat mostra ao visitante.
 *
 * A janela é aberta por quem não tem sessão, então a leitura usa o cliente admin
 * e confia só no `organizationId` que a rota recebe da fonte confiável (a conexão
 * pela chave), nunca de algo que o visitante mande. O teste prova que a consulta
 * filtra `id` à mão, que a URL de política passa pela mesma guarda de saída do
 * documento legal, e que falha de banco não derruba a janela.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn() } }));

import { lerControladorDoChat } from "./controlador-do-chat";

const ORG = "11111111-2222-4333-8444-555555555555";

/**
 * Dublê do encadeamento `from().select().eq().maybeSingle()`. `resposta` é o que
 * o banco devolve; um `Error` faz a promessa rejeitar, que é a falha de rede.
 */
function clienteQueDevolve(resposta: { data: unknown; error: unknown } | Error) {
  // Os mocks são criados antes de ligar o encadeamento: um objeto que se
  // referencia no próprio inicializador não tem tipo inferível pelo TypeScript.
  const consulta = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
  };
  consulta.select.mockReturnValue(consulta);
  consulta.eq.mockReturnValue(consulta);
  consulta.maybeSingle.mockImplementation(async () => {
    if (resposta instanceof Error) throw resposta;
    return resposta;
  });
  const from = vi.fn(() => consulta);
  const cliente = { from } as unknown as SupabaseClient;
  return { cliente, from, consulta };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("lerControladorDoChat", () => {
  it("devolve a razão social e a política quando a organização publicou as duas", async () => {
    const { cliente } = clienteQueDevolve({
      data: {
        legal_name: "  Clínica Exemplo Ltda  ",
        privacy_policy_url: "https://clinica.example.test/privacidade",
      },
      error: null,
    });

    expect(await lerControladorDoChat(cliente, ORG)).toEqual({
      razaoSocial: "Clínica Exemplo Ltda",
      politicaUrl: "https://clinica.example.test/privacidade",
    });
  });

  it("consulta a tabela organizations filtrando id pelo organizationId recebido", async () => {
    const { cliente, from, consulta } = clienteQueDevolve({ data: null, error: null });

    await lerControladorDoChat(cliente, ORG);

    expect(from).toHaveBeenCalledWith("organizations");
    expect(consulta.eq).toHaveBeenCalledTimes(1);
    expect(consulta.eq).toHaveBeenCalledWith("id", ORG);
  });

  it("devolve política http como está: a régua única (urlDePoliticaSegura) aceita http e https", async () => {
    const { cliente } = clienteQueDevolve({
      data: { legal_name: "Empresa", privacy_policy_url: "http://exemplo.test/privacidade" },
      error: null,
    });

    expect(await lerControladorDoChat(cliente, ORG)).toEqual({
      razaoSocial: "Empresa",
      politicaUrl: "http://exemplo.test/privacidade",
    });
  });

  it("RECUSA javascript: como política, mesmo que o banco a devolva", async () => {
    const { cliente } = clienteQueDevolve({
      data: { legal_name: "Empresa", privacy_policy_url: "javascript:alert(1)" },
      error: null,
    });

    const controlador = await lerControladorDoChat(cliente, ORG);

    expect(controlador.razaoSocial).toBe("Empresa");
    expect(controlador.politicaUrl).toBeNull();
  });

  it("RECUSA data:, que não é página", async () => {
    const { cliente } = clienteQueDevolve({
      data: { legal_name: null, privacy_policy_url: "data:text/html,<script>alert(1)</script>" },
      error: null,
    });

    expect(await lerControladorDoChat(cliente, ORG)).toEqual({
      razaoSocial: null,
      politicaUrl: null,
    });
  });

  it("organização inexistente devolve os dois null, sem lançar", async () => {
    const { cliente } = clienteQueDevolve({ data: null, error: null });

    expect(await lerControladorDoChat(cliente, ORG)).toEqual({
      razaoSocial: null,
      politicaUrl: null,
    });
  });

  it("erro devolvido pelo banco não lança, devolve null e registra um aviso sem o detalhe", async () => {
    const { cliente } = clienteQueDevolve({
      data: null,
      error: { message: "segredo@example.test" },
    });

    const controlador = await lerControladorDoChat(cliente, ORG);

    expect(controlador).toEqual({ razaoSocial: null, politicaUrl: null });
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.warn.mock.calls)).toContain(ORG);
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("segredo@example.test");
  });

  it("consulta que rejeita a promessa não lança, devolve null e registra um aviso", async () => {
    const { cliente } = clienteQueDevolve(new Error("conexão recusada pelo banco"));

    const controlador = await lerControladorDoChat(cliente, ORG);

    expect(controlador).toEqual({ razaoSocial: null, politicaUrl: null });
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("conexão recusada");
  });

  it("razão social vazia ou só com espaços vira null, não string vazia", async () => {
    const { cliente } = clienteQueDevolve({
      data: { legal_name: "   ", privacy_policy_url: null },
      error: null,
    });

    expect(await lerControladorDoChat(cliente, ORG)).toEqual({
      razaoSocial: null,
      politicaUrl: null,
    });
  });
});
