/**
 * Filtra as opções de um popover de multiseleção do painel de auditoria.
 *
 * ═══ O defeito que ela conserta (#4168) ═══
 *
 * O filtro era `label.toLowerCase().includes(busca.toLowerCase())`. Isso ignora
 * caixa, mas não acento: quem digita `clinica` não acha "Clínica" — e os rótulos
 * de empresa (`display_name`) têm acento com frequência.
 *
 * ═══ A regra ═══
 *
 * Os DOIS lados passam por `termoSemAcento` (`lib/inbox/termo-de-busca.ts`), a
 * mesma régua da busca do Inbox e da janela Encaminhar. Régua própria aqui seria
 * a terceira cópia.
 *
 * Função pura e exportada, sem import de componente: testável sem DOM.
 */
import { termoSemAcento } from "@/lib/inbox/termo-de-busca";

/**
 * Devolve as opções cujo rótulo contém o termo, preservando a ordem recebida.
 *
 * Termo vazio (ou só espaços) devolve a lista inteira.
 */
export function filtrarOpcoes<T extends { label: string }>(
  opcoes: T[],
  busca: string,
): T[] {
  const termo = termoSemAcento(busca.trim());
  if (!termo) return opcoes;
  return opcoes.filter((opcao) => termoSemAcento(opcao.label).includes(termo));
}
