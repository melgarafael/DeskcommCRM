/**
 * A SUGESTÃO DE ETIQUETA DO LOTE — função pura, fora do componente (#4166).
 *
 * ═══ O defeito ═══
 *
 * `BulkActionBar` sugeria as etiquetas existentes com
 * `tag.toLowerCase().includes(tagInput.trim().toLowerCase())`. Quem digita
 * `promocao` não via "Promoção" e criava a duplicada sem acento ao lado —
 * defeito que se multiplica a cada uso, porque a lista de etiquetas é
 * compartilhada pelo funil inteiro.
 *
 * ═══ A regra ═══
 *
 * Os DOIS lados por `termoSemAcento` (`lib/inbox/termo-de-busca.ts`): a mesma
 * régua da busca do Inbox, e nenhuma nova.
 */
import { termoSemAcento } from "@/lib/inbox/termo-de-busca";

/**
 * Filtra as etiquetas existentes pelo que está sendo digitado no campo.
 *
 * Termo vazio devolve a lista inteira: o menu abre mostrando o que já existe.
 * O limite de sugestões (`slice(0, 10)`) é do componente, não da busca.
 */
export function filtrarEtiquetas(etiquetas: string[], busca: string): string[] {
  const termo = termoSemAcento(busca.trim());
  if (!termo) return etiquetas;
  return etiquetas.filter((etiqueta) => termoSemAcento(etiqueta).includes(termo));
}
