/**
 * QUEM APARECE NA LISTA DE AGENTES — a régua da busca.
 *
 * ═══ O defeito que ela conserta (#4165) ═══
 *
 * A lista de Agentes de IA filtrava com `a.name.toLowerCase().includes(q)`.
 * Isso ignora caixa, mas não ignora acento: quem digita `pos-venda` não acha
 * "Atendimento Pós-venda" e fica com a lista vazia achando que o agente não
 * existe.
 *
 * ═══ A regra ═══
 *
 * Os DOIS lados passam por `termoSemAcento` (`lib/inbox/termo-de-busca.ts`):
 * a mesma régua que a busca do Inbox manda ao banco, que a janela Encaminhar
 * já usa (`lib/inbox/filtrar-destinos.ts`, #4078) e que
 * `tests/invariants/busca-do-inbox-ignora-acento.test.ts` mantém igual ao
 * `f_unaccent` do Postgres. Uma régua própria aqui seria mais uma cópia, e
 * divergiria no primeiro ajuste.
 *
 * ═══ Por que função pura e exportada ═══
 *
 * A filtragem morava dentro de um `useMemo` de um componente cliente. Fora do
 * componente, ela é testável sem DOM nem rede.
 */
import { termoSemAcento } from "@/lib/inbox/termo-de-busca";

/** O que a lista oferece: o agente e o nome que a busca inspeciona. */
export interface AgenteBuscavel {
  id: string;
  name: string;
}

/**
 * Filtra os agentes pelo termo digitado, preservando a ordem recebida.
 *
 * Termo vazio (ou só espaços) devolve a lista inteira: a lista abre sem filtro.
 */
export function filtrarAgentes<Agente extends AgenteBuscavel>(
  agentes: Agente[],
  busca: string,
): Agente[] {
  const termo = termoSemAcento(busca.trim());
  if (!termo) return agentes;
  return agentes.filter((agente) => termoSemAcento(agente.name).includes(termo));
}
