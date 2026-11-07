/**
 * O SERVIÇO NA BUSCA DO AGENTE — o que o módulo `catalogo_servicos` muda no
 * `crm_search_products`, e só quando está ligado.
 *
 * Puro: recebe as linhas que a busca já varreu e os detalhes do módulo, e diz
 *
 *   - quem a IA PODE oferecer (`visiveis`): sai o item com `ia_oferece = false`,
 *     e sai a variação cujo principal está desligado, inativo ou fora da
 *     varredura. O corte acontece ANTES da pontuação, então o nome de uma
 *     variação escondida também não traz a família de volta;
 *   - quem responde no lugar de uma variação que casou o termo: o principal,
 *     com as variações dentro;
 *   - o bloco `servico` de cada principal, com a família que a varredura viu.
 *
 * Com o módulo desligado, nada disto roda e a busca é a de sempre.
 */
import {
  descreverServicoParaIA,
  linhaDoCatalogo,
  montarServicos,
  type DetalheDoServico,
  type ItemDoServico,
} from "@/lib/catalogo/servicos";

/** O que a busca entrega ao modelo junto com o primeiro serviço da resposta. */
export const INSTRUCOES_DE_SERVICO =
  "Item com `servico` é SERVIÇO (consultoria, projeto, plano mensal): responda com o " +
  "`preco_a_partir`, as `variacoes` e o `sinal` que estiverem ali, e com o `prazo_dias_uteis` " +
  "quando houver — não invente esses valores. O campo " +
  "`instrucoes_internas_nao_repita_ao_cliente` é instrução PARA VOCÊ: nunca cite esse texto ao " +
  "cliente. Se vier `variacoes_podem_estar_incompletas`, diga que vai confirmar as opções com a equipe.";

export interface VitrineDeServicos<T extends ItemDoServico> {
  visiveis: T[];
  ehServico: (id: string) => boolean;
  /** Troca a variação que casou pelo principal dela; o mesmo principal fica uma vez. */
  principalNoLugar: <A extends { produto: T }>(achados: A[]) => A[];
  /** O bloco `servico` do principal, ou `null` para produto comum. */
  descricao: (id: string) => Record<string, unknown> | null;
}

export function vitrineDeServicos<T extends ItemDoServico>(
  linhas: readonly T[],
  detalhes: ReadonlyMap<string, DetalheDoServico>,
  opcoes: { familiaParcial: boolean },
): VitrineDeServicos<T> {
  const porId = new Map(linhas.map((l) => [l.id, l]));

  const oferecivel = (linha: T): boolean => {
    const d = detalhes.get(linha.id);
    if (!d) return true; // produto comum: o módulo não decide nada sobre ele
    if (!d.ia_oferece) return false;
    if (d.pai_product_id === null) return true;
    const pai = detalhes.get(d.pai_product_id);
    return pai !== undefined && pai.ia_oferece && porId.has(d.pai_product_id);
  };

  const visiveis = linhas.filter(oferecivel);
  const montados = new Map(
    montarServicos(
      visiveis.flatMap((l) => {
        const d = detalhes.get(l.id);
        return d ? [linhaDoCatalogo(l, d)] : [];
      }),
    ).map((s) => [s.id, s]),
  );

  return {
    visiveis,
    ehServico: (id) => detalhes.has(id),
    principalNoLugar: (achados) => {
      const vistos = new Set<string>();
      const saida: typeof achados = [];
      for (const achado of achados) {
        const pai = detalhes.get(achado.produto.id)?.pai_product_id;
        const produto = pai ? porId.get(pai) : achado.produto;
        if (!produto || vistos.has(produto.id)) continue;
        vistos.add(produto.id);
        saida.push(produto === achado.produto ? achado : ({ ...achado, produto } as typeof achado));
      }
      return saida;
    },
    descricao: (id) => {
      const servico = montados.get(id);
      return servico ? descreverServicoParaIA(servico, opcoes) : null;
    },
  };
}
