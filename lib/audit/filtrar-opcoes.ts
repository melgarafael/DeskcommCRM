/**
 * A BUSCA DOS FILTROS DA AUDITORIA — função pura, fora do componente (#4168).
 *
 * ═══ O defeito ═══
 *
 * O popover de múltipla escolha filtrava com
 * `o.label.toLowerCase().includes(search.toLowerCase())`. Os rótulos de AÇÃO
 * são códigos ASCII (`lgpd.exportacao`), mas o mesmo popover lista EMPRESAS, e
 * o nome delas tem acento: digitar `exclusao` não achava "Exclusão Fiscal".
 *
 * ═══ A regra ═══
 *
 * Os DOIS lados por `termoSemAcento` (`lib/inbox/termo-de-busca.ts`), a mesma
 * régua do Inbox — nada de `normalize` solto na tela.
 */
import { termoSemAcento } from "@/lib/inbox/termo-de-busca";

/** O mínimo que a busca enxerga da opção: o rótulo que aparece no menu. */
export interface OpcaoBuscavel {
  label: string;
}

/**
 * Filtra as opções do popover pelo termo digitado, preservando a ordem.
 *
 * Termo vazio devolve a lista inteira, na mesma referência: o menu abre com
 * tudo marcável.
 */
export function filtrarOpcoes<T extends OpcaoBuscavel>(opcoes: T[], busca: string): T[] {
  const termo = termoSemAcento(busca.trim());
  if (!termo) return opcoes;
  return opcoes.filter((opcao) => termoSemAcento(opcao.label).includes(termo));
}
