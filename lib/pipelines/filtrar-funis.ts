/**
 * A BUSCA DA LISTA DE FUNIS EM CONFIGURAÇÕES — função pura (#4593).
 *
 * Com muitos funis a tela «Etapas do funil» já nasce recolhida (#4083), mas
 * achar um funil ainda pedia ler a lista inteira. A tela ganha a mesma caixa de
 * busca da lista de Agentes, e esta função é a régua dela.
 *
 * ═══ A régua ═══
 *
 * A mesma de `filtrarAgentes` (`lib/ai/agents/filtrar-agentes.ts`): os DOIS
 * lados passam por `termoSemAcento` (`lib/inbox/termo-de-busca.ts`).
 *
 * O termo casa com o NOME ou com o ENDEREÇO (`slug`): são os dois textos que o
 * cartão do funil mostra, e quem copia o `/endereço` de um link espera achar o
 * funil por ele. Desde o que o #4693 deixou aberto, casa também com os nomes das
 * ETAPAS que a tela entrega (só as vivas: a arquivada não recebe card, e achar
 * o funil por ela faria parecer que ainda está em uso).
 *
 * Por palavra, não por trecho (`casaTodasAsPalavras`): cada palavra digitada
 * precisa aparecer em algum desses textos, em qualquer ordem — «prospeccao
 * site» acha «Prospecção (Site)».
 *
 * ═══ Por que devolve ids, e não a lista filtrada ═══
 *
 * A tela NÃO desmonta o cartão que a busca esconde: o editor do funil guarda
 * rascunho não salvo, e desmontar o apagaria em silêncio (o mesmo motivo de
 * «recolher só esconde», #3176/#4083). Por isso a tela pergunta QUEM casa e
 * esconde o resto com `hidden`.
 */
import { casaTodasAsPalavras, palavrasDaBusca } from "@/lib/inbox/termo-de-busca";

/** O mínimo que a busca enxerga do funil: o nome e o endereço do cartão. */
export interface FunilBuscavel {
  id: string;
  name: string;
  slug: string;
  /** Nomes das etapas que a busca também enxerga. Ausente = só nome e endereço. */
  etapas?: readonly string[];
}

/**
 * Os ids dos funis que casam com o termo digitado.
 *
 * Termo vazio (ou só espaços) devolve `null`: não há busca, todos aparecem.
 */
export function funisQueCasam(funis: FunilBuscavel[], busca: string): Set<string> | null {
  const palavras = palavrasDaBusca(busca);
  if (palavras.length === 0) return null;
  return new Set(
    funis
      .filter((funil) => casaTodasAsPalavras(palavras, [funil.name, funil.slug, ...(funil.etapas ?? [])]))
      .map((funil) => funil.id),
  );
}
