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
   * O RECORTE POR ORGANIZAÇÃO: painel existe para esta empresa só se ela tem ao menos uma linha
   * na tabela do módulo.
   *
   * O corte do MÓDULO continua por instalação (ADR-0002 D3) — a existência de um módulo instalado
   * é informação da instalação, e `GET /api/v1/extensions` já a lista para qualquer `viewer`. O
   * que estes casos medem é se vale DESENHAR o painel: sem linha da empresa, ele não tem o que
   * mostrar, e montá-lo descia o caminho junto (o destino é `"use client"`, então `{ modulo,
   * objeto }` ia no payload, e o componente ainda buscava a rota).
   *
   * ⚠️ A primeira versão deste bloco justificava o recorte como proteção contra uma empresa saber
   * os módulos das OUTRAS. É falso, e um cético derrubou medindo a listagem de extensões. Fica
   * registrado porque razão errada num comentário envelhece pior que razão nenhuma.
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
