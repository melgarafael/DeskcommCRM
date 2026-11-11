/**
 * A BUSCA DA LISTA DE AGENTES — função pura, fora do componente (#4165).
 *
 * ═══ O defeito ═══
 *
 * `AgentsList` filtrava com `a.name.toLowerCase().includes(q)`. Isso dobra a
 * CAIXA e não dobra o ACENTO: quem digita `pos-venda` — o gesto de quem digita
 * rápido — fica com a lista vazia e conclui que o agente não existe.
 *
 * ═══ A regra ═══
 *
 * Os DOIS lados passam por `termoSemAcento` (`lib/inbox/termo-de-busca.ts`), a
 * mesma régua da busca do Inbox. Normalizar só o termo não bastaria:
 * `"São João".includes("sao joao")` continua falso, e é esse o erro clássico
 * deste defeito.
 *
 * ═══ Por que função pura e exportada ═══
 *
 * A filtragem morava num `useMemo` de um componente que depende de i18n e de
 * rede. Aqui ela é testável sem DOM, no padrão que o #4078 fixou para
 * `lib/inbox/filtrar-destinos.ts`.
 */
import { termoSemAcento } from "@/lib/inbox/termo-de-busca";

/** O mínimo que a busca enxerga do agente: o nome que aparece no cartão. */
export interface AgenteBuscavel {
  name: string;
}

/**
 * Filtra os agentes pelo termo digitado, preservando a ordem recebida.
 *
 * Termo vazio (ou só espaços) devolve a lista inteira, na mesma referência: o
 * filtro por status e por arquivados continua sendo do componente.
 */
export function filtrarAgentes<T extends AgenteBuscavel>(agentes: T[], busca: string): T[] {
  const termo = termoSemAcento(busca.trim());
  if (!termo) return agentes;
  return agentes.filter((agente) => termoSemAcento(agente.name).includes(termo));
}
