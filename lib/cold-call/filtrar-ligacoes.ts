/**
 * A BUSCA DA LISTA DO COLD CALL — função pura, fora do componente (#4167).
 *
 * ═══ O defeito ═══
 *
 * `Fila` filtrava com `l.titulo.toLowerCase().includes(termo)`: dobra a caixa e
 * não dobra o acento, então `sao joao` não achava "Padaria São João". A busca
 * por TELEFONE já funcionava — é dígito, não tem acento — e continua igual.
 *
 * ═══ A regra ═══
 *
 * Os DOIS lados por `termoSemAcento` (`lib/inbox/termo-de-busca.ts`), a mesma
 * régua do Inbox. O telefone segue cru: a régua não mexe em dígito, e passar o
 * número por ela só gastaria uma normalização por linha da lista.
 */
import { termoSemAcento } from "@/lib/inbox/termo-de-busca";

/** O mínimo que a busca enxerga do lead: o título do negócio e o telefone. */
export interface LigacaoBuscavel {
  titulo: string;
  telefone: string | null;
}

/**
 * Filtra os leads pelo termo digitado, preservando a ordem recebida.
 *
 * Casa pelo título do negócio (sem acento, sem caixa) ou por um trecho do
 * telefone. Termo vazio devolve a lista inteira, na mesma referência.
 */
export function filtrarLigacoes<T extends LigacaoBuscavel>(ligacoes: T[], busca: string): T[] {
  const termo = termoSemAcento(busca.trim());
  if (!termo) return ligacoes;
  return ligacoes.filter(
    (ligacao) =>
      termoSemAcento(ligacao.titulo).includes(termo) || (ligacao.telefone ?? "").includes(termo),
  );
}
