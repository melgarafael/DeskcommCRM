/**
 * A BUSCA DA LISTA DE FLUXOS DE FOLLOW-UP — função pura, fora do componente (#4593).
 *
 * ═══ O defeito ═══
 *
 * Quem tem treze fluxos de retomada, um por nicho, com nomes parecidos
 * («Kelly · retomada (oficinas mecânica)», «Kelly · retomada (clínicas)»), não
 * achava o que queria sem rolar a lista inteira — e o cartão corta o nome com
 * reticências, então dois fluxos diferentes ficavam com o MESMO rótulo visível.
 *
 * ═══ A regra ═══
 *
 * O termo digitado e o nome do fluxo passam por `termoSemAcento`
 * (`lib/inbox/termo-de-busca.ts`), a régua única de busca do produto. Normalizar
 * só o termo não bastaria: `"Oficinas Mecânica".includes("mecanica")` continua
 * falso, e é esse o erro clássico deste defeito.
 *
 * ═══ Por que função pura e exportada ═══
 *
 * A filtragem nasce aqui, e não num `useMemo` do componente, para ser testável
 * sem DOM — o padrão que `lib/inbox/filtrar-destinos.ts` (#4078) fixou e que
 * `lib/ai/agents/filtrar-agentes.ts` (#4165) seguiu.
 */
import { termoSemAcento } from "@/lib/inbox/termo-de-busca";

/** O mínimo que a busca enxerga do fluxo: o nome do cartão. */
export interface FluxoBuscavel {
  name: string;
}

/**
 * Filtra os fluxos pelo termo digitado, preservando a ordem recebida.
 *
 * Termo vazio (ou só espaços) devolve a lista inteira, na MESMA referência: a
 * tela abre sem filtro, e não há cópia para o React comparar à toa.
 */
export function filtrarFluxos<T extends FluxoBuscavel>(fluxos: T[], busca: string): T[] {
  const termo = termoSemAcento(busca.trim());
  if (!termo) return fluxos;
  return fluxos.filter((fluxo) => termoSemAcento(fluxo.name).includes(termo));
}
