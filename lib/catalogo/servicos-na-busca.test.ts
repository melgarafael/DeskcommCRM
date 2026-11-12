import { describe, expect, it } from "vitest";

import type { DetalheDoServico, ItemDoServico } from "./servicos";
import { vitrineDeServicos } from "./servicos-na-busca";

/**
 * O QUE A IA PODE OFERECER — `ia_oferece` decide, e decide ANTES da pontuação.
 *
 * Na versão anterior o campo era só selecionado e copiado: `ia_oferece = false`
 * não tirava nem o principal nem a variação da busca. Estes casos medem o corte.
 */

const item = (id: string, nome: string, preco_cents: number): ItemDoServico => ({
  id,
  codigo: nome.toUpperCase(),
  nome,
  descricao: null,
  preco_cents,
  moeda: "BRL",
  ativo: true,
  fotos: null,
});

const detalhe = (product_id: string, extra: Partial<DetalheDoServico> = {}): DetalheDoServico => ({
  product_id,
  pai_product_id: null,
  tipo: "recorrente",
  unidade: "mes",
  prazo_dias_uteis: null,
  sinal_tipo: null,
  sinal_percentual: null,
  sinal_cents: null,
  instrucoes_ia: null,
  ia_oferece: true,
  revision: 1,
  ...extra,
});

const variacao = (product_id: string, pai: string, extra: Partial<DetalheDoServico> = {}) =>
  detalhe(product_id, { pai_product_id: pai, tipo: null, unidade: null, ...extra });

const SOCIAL = item("p1", "Social media", 120_000);
const SOCIAL_20 = item("v1", "Social media 20 posts", 190_000);
const CAMISETA = item("c1", "Camiseta", 5_000);

describe("vitrineDeServicos", () => {
  it("principal com ia_oferece=false some com a família inteira", () => {
    const v = vitrineDeServicos(
      [SOCIAL, SOCIAL_20, CAMISETA],
      new Map([
        ["p1", detalhe("p1", { ia_oferece: false })],
        ["v1", variacao("v1", "p1")],
      ]),
      { familiaParcial: false },
    );
    expect(v.visiveis.map((l) => l.id)).toEqual(["c1"]);
  });

  it("variação com ia_oferece=false some sozinha, e sai da família do principal", () => {
    const v = vitrineDeServicos(
      [SOCIAL, SOCIAL_20],
      new Map([
        ["p1", detalhe("p1")],
        ["v1", variacao("v1", "p1", { ia_oferece: false })],
      ]),
      { familiaParcial: false },
    );
    expect(v.visiveis.map((l) => l.id)).toEqual(["p1"]);
    expect(v.descricao("p1")?.variacoes).toBeUndefined();
  });

  it("variação cujo principal não veio (inativo ou fora da varredura) não é oferecida", () => {
    const v = vitrineDeServicos([SOCIAL_20], new Map([["p1", detalhe("p1")], ["v1", variacao("v1", "p1")]]), {
      familiaParcial: false,
    });
    expect(v.visiveis).toEqual([]);
  });

  it("a variação que casou o termo cede o lugar ao principal, uma vez só", () => {
    const v = vitrineDeServicos([SOCIAL, SOCIAL_20], new Map([["p1", detalhe("p1")], ["v1", variacao("v1", "p1")]]), {
      familiaParcial: false,
    });
    const achados = v.principalNoLugar([
      { produto: SOCIAL_20, nota: 3 },
      { produto: SOCIAL, nota: 2 },
    ]);
    expect(achados).toEqual([{ produto: SOCIAL, nota: 3 }]);
  });

  it("produto sem detalhe passa intocado e não ganha bloco de serviço", () => {
    const v = vitrineDeServicos([CAMISETA], new Map(), { familiaParcial: false });
    expect(v.visiveis).toEqual([CAMISETA]);
    expect(v.ehServico("c1")).toBe(false);
    expect(v.descricao("c1")).toBeNull();
  });

  it("varredura parcial marca a família como possivelmente incompleta", () => {
    const v = vitrineDeServicos([SOCIAL], new Map([["p1", detalhe("p1")]]), { familiaParcial: true });
    expect(v.descricao("p1")?.variacoes_podem_estar_incompletas).toBe(true);
  });
});
