import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Quais módulos de dados mostram ficha NA tela de uma entidade do núcleo.
 *
 * Duas propriedades, e as duas vêm da doutrina:
 *
 * 1. **Módulo removido não aparece.** Remover é lógico e preserva dados (não-negociável 7): as
 *    tabelas ficam, as telas saem. Um painel que continuasse aparecendo mostraria dado de um módulo
 *    que o administrador desinstalou.
 * 2. **Só o objeto que DECLAROU a referência àquela entidade.** Um objeto sem `refs` de contato não
 *    tem recorte por contato — mostrá-lo na ficha exibiria a lista inteira da organização ali.
 */

const mocks = vi.hoisted(() => ({ rows: vi.fn(), contagem: vi.fn(), orgsPedidas: [] as unknown[] }));

/**
 * O dublê distingue a TABELA consultada, e isso não é detalhe: a função faz duas leituras com
 * semânticas diferentes — as instalações (da instalação inteira) e a tabela do módulo (recortada
 * pela organização). Um dublê que respondesse o mesmo para as duas deixaria o recorte por
 * organização invisível ao teste, que é exatamente o defeito que estes casos existem para pegar.
 */
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "is", "order", "limit"]) chain[m] = vi.fn(() => chain);
      chain.eq = vi.fn((coluna: string, valor: unknown) => {
        if (coluna === "organization_id") mocks.orgsPedidas.push(valor);
        return chain;
      });
      chain.then = (r: (v: unknown) => unknown) =>
        r(tabela === "extension_installations" ? mocks.rows() : mocks.contagem());
      return chain;
    },
  }),
}));

function instalacao(over: Record<string, unknown> = {}) {
  return {
    publisher: "clinica",
    name: "odontograma",
    removed_at: null,
    extension_artifacts: {
      manifest: {
        profile: "data",
        publisher: "clinica",
        name: "odontograma",
        data: {
          mode: "declarado",
          objetos: [
            {
              slug: "marcacao",
              rotulo: { "pt-BR": "Odontograma" },
              campos: [{ slug: "dente", tipo: "inteiro" }],
              refs: [{ slug: "paciente", entidade: "contato" }],
            },
          ],
        },
      },
    },
    ...over,
  };
}

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const OUTRA = "bbbbbbbb-0000-4000-8000-000000000002";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.orgsPedidas.length = 0;
  // Padrão: a organização TEM ficha. Os casos que medem o recorte sobrescrevem.
  mocks.contagem.mockReturnValue({ count: 1, error: null });
});

describe("paineisDaEntidade", () => {
  it("devolve o painel do objeto que declara referência ao contato", async () => {
    mocks.rows.mockReturnValue({ data: [instalacao()], error: null });
    const { paineisDaEntidade } = await import("./paineis");

    expect(await paineisDaEntidade("contato", ORG)).toEqual([
      { modulo: "odontograma", objeto: "marcacao" },
    ]);
  });

  it("objeto SEM referência ao contato não vira painel na ficha do contato", async () => {
    const semRef = instalacao();
    (
      semRef.extension_artifacts.manifest.data.objetos[0] as unknown as Record<string, unknown>
    ).refs = [];
    mocks.rows.mockReturnValue({ data: [semRef], error: null });
    const { paineisDaEntidade } = await import("./paineis");

    expect(await paineisDaEntidade("contato", ORG)).toEqual([]);
  });

  it("pacote declarativo (sem dados) não contribui painel nenhum", async () => {
    const declarativo = instalacao();
    (declarativo.extension_artifacts.manifest as Record<string, unknown>).profile = "declarative";
    mocks.rows.mockReturnValue({ data: [declarativo], error: null });
    const { paineisDaEntidade } = await import("./paineis");

    expect(await paineisDaEntidade("contato", ORG)).toEqual([]);
  });

  /**
   * ⚠️ O RECORTE POR ORGANIZAÇÃO, e por que a ausência do painel na TELA não bastava.
   *
   * A primeira versão desta frente escondia o painel vazio no componente. Um cético mostrou que
   * isso é cosmético: sem recorte aqui, o NOME do módulo chega ao navegador de toda empresa da
   * instalação por três caminhos — o payload da página (o destino é `"use client"`), a URL do
   * `fetch` na aba de rede, e a resposta 200 da rota com `rotulo` e `campos`. Numa instalação de
   * revendedor, isso conta a uma empresa quais módulos as OUTRAS usam.
   *
   * O corte do módulo é por instalação (ADR-0002 D3) e continua sendo; o que passa a ser por
   * organização é o que a TELA de uma empresa chega a saber. A régua: painel existe para esta
   * empresa só se ela tem ao menos uma linha na tabela do módulo.
   */
  it("⭐ empresa SEM nenhuma ficha não recebe painel — nem o nome do módulo", async () => {
    mocks.rows.mockReturnValue({ data: [instalacao()], error: null });
    const { paineisDaEntidade } = await import("./paineis");
    mocks.contagem.mockReturnValue({ count: 0, error: null });

    expect(await paineisDaEntidade("contato", OUTRA)).toEqual([]);
  });

  it("⭐ e a empresa COM ficha recebe — senão o caso de cima seria vacuidade", async () => {
    mocks.rows.mockReturnValue({ data: [instalacao()], error: null });
    const { paineisDaEntidade } = await import("./paineis");
    mocks.contagem.mockReturnValue({ count: 3, error: null });

    expect(await paineisDaEntidade("contato", ORG)).toEqual([
      { modulo: "odontograma", objeto: "marcacao" },
    ]);
  });

  it("a contagem é pedida com a organização DADA, e nunca sem filtro", async () => {
    // Sem este caso, uma consulta que esquecesse o `.eq("organization_id", …)` contaria as linhas
    // de TODAS as empresas e devolveria painel para quem não tem nada — o vazamento de volta,
    // com os dois casos acima verdes.
    mocks.rows.mockReturnValue({ data: [instalacao()], error: null });
    const { paineisDaEntidade } = await import("./paineis");
    await paineisDaEntidade("contato", OUTRA);
    expect(mocks.orgsPedidas).toEqual([OUTRA]);
  });

  it("contagem que FALHA não vira painel — falha fechada, como o resto", async () => {
    mocks.rows.mockReturnValue({ data: [instalacao()], error: null });
    const { paineisDaEntidade } = await import("./paineis");
    mocks.contagem.mockReturnValue({ count: null, error: { code: "42P01", message: "sem tabela" } });

    expect(await paineisDaEntidade("contato", ORG)).toEqual([]);
  });

  it("falha de leitura devolve lista vazia — a ficha do contato não depende disto", async () => {
    mocks.rows.mockReturnValue({ data: null, error: { message: "fora do ar" } });
    const { paineisDaEntidade } = await import("./paineis");

    expect(await paineisDaEntidade("contato", ORG)).toEqual([]);
  });
});
