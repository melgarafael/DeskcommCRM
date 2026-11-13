// O ITEM DA REFERÊNCIA EXISTE? (Spec 25, R5 — prova de 10/11/2026: o agente
// inventou o código do item em 2 de 2 turnos reais e o negócio nasceu assim).
//
// O que cada caso guarda, e a linha que o deixa vermelho se for revertida:
//  1. Linha achada → ok; nenhuma linha → item_inexistente
//     → trocar o `if (resultado.linhas.length > 0)` por `return { ok: true }`.
//  2. A consulta é presa no id do item, nas três receitas, com o `?` na posição do
//     valor → tirar o `idDoItem` de qualquer `montar`.
//  3. A busca das conexões é da ORGANIZAÇÃO de quem chama e só das ativas
//     → tirar `.eq("organization_id", ...)` ou `.eq("enabled", true)`.
//  4. Instância desligada ou de outra receita não é consultada
//     → tirar o filtro `i.ativa && i.receita === receitaId`.
//  5. Banco fora (acesso negado ou consulta que lança) → indisponivel, nunca
//     "não existe" → tirar o `if (tentou && !consultou)`.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ abrirAcesso: vi.fn(), executarReceita: vi.fn() }));
vi.mock("@/lib/external-db/acesso", () => ({ abrirAcesso: mocks.abrirAcesso }));

import { conferirItemDaReferencia } from "./item-da-referencia";
import { receitaDe } from "./registro";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONEXAO = "11111111-1111-4111-8111-111111111111";

const instancia = (extra: Record<string, unknown> = {}) => ({
  id: "22222222-2222-4222-8222-222222222222",
  receita: "wordpress-conteudo",
  rotulo: "Imóveis",
  descricao: "",
  fixos: { prefixo: "wp_", post_type: "imovel", campos: [], categorias: [] },
  ativa: true,
  ...extra,
});

function supabaseCom(receitas: unknown[], erro = false) {
  const filtros: [string, unknown][] = [];
  const q: Record<string, unknown> = {
    select: () => q,
    eq: (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return q;
    },
    then: (resolve: (v: unknown) => unknown) =>
      resolve(
        erro
          ? { data: null, error: { message: "boom" } }
          : { data: [{ id: CONEXAO, db_type: "mysql", receitas }], error: null },
      ),
  };
  return { cliente: { from: () => q } as never, filtros };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.abrirAcesso.mockResolvedValue({ ok: true, dialeto: { executarReceita: mocks.executarReceita } });
});

describe("conferirItemDaReferencia", () => {
  it("o item existe: ok, e a consulta é presa no id dele", async () => {
    mocks.executarReceita.mockResolvedValue({ colunas: ["id"], linhas: [[1]], truncado: false });
    const { cliente } = supabaseCom([instancia()]);

    const r = await conferirItemDaReferencia(cliente, ORG, "wordpress-conteudo:1");

    expect(r).toEqual({ ok: true });
    const [consulta, opcoes] = mocks.executarReceita.mock.calls[0]!;
    expect(consulta.sql).toContain("p.ID = ?");
    expect(consulta.valores).toContain("1");
    expect(opcoes).toEqual({ limiteMax: 1 });
  });

  it("o item NÃO existe: item_inexistente, e a mensagem não traz número de exemplo", async () => {
    mocks.executarReceita.mockResolvedValue({ colunas: ["id"], linhas: [], truncado: false });
    const { cliente } = supabaseCom([instancia()]);

    const r = await conferirItemDaReferencia(cliente, ORG, "wordpress-conteudo:1234");

    expect(r).toMatchObject({ ok: false, motivo: "item_inexistente" });
    const mensagem = (r as { mensagem: string }).mensagem.replace("wordpress-conteudo:1234", "");
    expect(mensagem).not.toMatch(/\d/);
  });

  it("lê só as conexões ativas da organização de quem chama", async () => {
    mocks.executarReceita.mockResolvedValue({ colunas: ["id"], linhas: [[1]], truncado: false });
    const { cliente, filtros } = supabaseCom([instancia()]);

    await conferirItemDaReferencia(cliente, ORG, "wordpress-conteudo:1");

    expect(filtros).toEqual(expect.arrayContaining([["organization_id", ORG], ["enabled", true]]));
    expect(mocks.abrirAcesso).toHaveBeenCalledWith(cliente, ORG, CONEXAO);
  });

  it("instância desligada ou de outra receita não conta: inexistente sem consultar", async () => {
    const { cliente } = supabaseCom([
      instancia({ ativa: false }),
      instancia({ receita: "woocommerce-produtos", fixos: { prefixo: "wp_" } }),
    ]);

    const r = await conferirItemDaReferencia(cliente, ORG, "wordpress-conteudo:1");

    expect(r).toMatchObject({ ok: false, motivo: "item_inexistente" });
    expect(mocks.executarReceita).not.toHaveBeenCalled();
  });

  it("receita desconhecida ou referência fora do formato: inexistente sem ler o banco", async () => {
    const from = vi.fn();

    expect(await conferirItemDaReferencia({ from } as never, ORG, "receita-que-nao-existe:1")).toMatchObject({
      motivo: "item_inexistente",
    });
    expect(await conferirItemDaReferencia({ from } as never, ORG, "sem-dois-pontos")).toMatchObject({
      motivo: "item_inexistente",
    });
    expect(from).not.toHaveBeenCalled();
  });

  it("banco de origem fora: indisponivel, nunca 'não existe'", async () => {
    const { cliente } = supabaseCom([instancia()]);

    mocks.abrirAcesso.mockResolvedValueOnce({ ok: false, motivo: "host_bloqueado" });
    expect(await conferirItemDaReferencia(cliente, ORG, "wordpress-conteudo:1")).toMatchObject({
      motivo: "indisponivel",
    });

    mocks.executarReceita.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await conferirItemDaReferencia(cliente, ORG, "wordpress-conteudo:1")).toMatchObject({
      motivo: "indisponivel",
    });
  });

  it("erro ao ler as conexões: indisponivel", async () => {
    const { cliente } = supabaseCom([], true);

    expect(await conferirItemDaReferencia(cliente, ORG, "wordpress-conteudo:1")).toMatchObject({
      motivo: "indisponivel",
    });
  });
});

describe("montar com idDoItem — as três receitas", () => {
  const FIXOS: Record<string, unknown> = {
    "wordpress-conteudo": { prefixo: "wp_", post_type: "imovel", campos: [], categorias: [] },
    "woocommerce-produtos": { prefixo: "wp_" },
    "tabela-direta": {
      tabela: "imoveis",
      coluna_id: "codigo",
      coluna_titulo: "nome",
      campos: [],
      so_mostrar_quando: { coluna: "status", valor: "ativo" },
      esconder_quando: { coluna: "situacao", valores: ["vendido"] },
    },
  };
  const PRESO: Record<string, string> = {
    "wordpress-conteudo": "p.ID = ?",
    "woocommerce-produtos": "`wp_posts`.ID = ?",
    "tabela-direta": "`codigo` = ?",
  };

  for (const id of Object.keys(FIXOS)) {
    it(`${id}: a consulta é presa no id, e o valor ocupa a posição do seu ?`, () => {
      const receita = receitaDe(id)!;
      const { sql, valores } = receita.montar(FIXOS[id], receita.parametrosDaBusca.parse({}), 1, "ID-DO-ITEM");

      const posicao = sql.indexOf(PRESO[id]!);
      expect(posicao).toBeGreaterThan(-1);
      const marcadoresAntes = (sql.slice(0, posicao).match(/\?/g) ?? []).length;
      expect(valores[marcadoresAntes]).toBe("ID-DO-ITEM");
      expect((sql.match(/\?/g) ?? []).length).toBe(valores.length);
    });

    it(`${id}: sem idDoItem, a consulta não é presa`, () => {
      const receita = receitaDe(id)!;
      const { valores } = receita.montar(FIXOS[id], receita.parametrosDaBusca.parse({}), 1);

      expect(valores).not.toContain("ID-DO-ITEM");
    });
  }
});
