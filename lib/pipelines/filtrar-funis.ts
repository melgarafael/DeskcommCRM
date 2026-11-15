/**
 * A BUSCA DA LISTA DE FUNIS — função pura, fora do componente (#4593).
 *
 * ═══ O defeito ═══
 *
 * Configurações › Funis desenha todos os funis da empresa num rolo de cartões
 * abertos. Com oito ou dez funis, achar «Prospecção (Site)» era rolar a tela
 * inteira — não havia campo de busca nenhum, ao contrário da lista de Agentes.
 *
 * ═══ A regra ═══
 *
 * O termo e o nome do funil passam por `termoSemAcento`
 * (`lib/inbox/termo-de-busca.ts`), a mesma régua de `filtrarFluxos` e de
 * `filtrarAgentes`. Quem digita `prospeccao site` acha «Prospecção (Site)».
 *
 * Slug e nomes de etapa ficam de fora DE PROPÓSITO: são campos de outra fatia
 * da issue (busca em mais campos) e mudariam o resultado desta lista sem que
 * nenhuma tela mostrasse o porquê do casamento.
 */
import { termoSemAcento } from "@/lib/inbox/termo-de-busca";

/** O mínimo que a busca enxerga do funil: o nome do cartão. */
export interface FunilBuscavel {
  name: string;
}

/**
 * Filtra os funis pelo termo digitado, preservando a ordem recebida.
 *
 * Termo vazio (ou só espaços) devolve a lista inteira, na MESMA referência.
 */
export function filtrarFunis<T extends FunilBuscavel>(funis: T[], busca: string): T[] {
  const termo = termoSemAcento(busca.trim());
  if (!termo) return funis;
  return funis.filter((funil) => termoSemAcento(funil.name).includes(termo));
}
