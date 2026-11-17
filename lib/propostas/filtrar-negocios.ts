/**
 * QUEM APARECE NA BUSCA DE NEGÓCIO DA NOVA PROPOSTA: a régua da busca.
 *
 * ═══ O defeito que ela conserta (#4413) ═══
 *
 * Em Propostas → Nova proposta, a lista de negócios filtrava com
 * `toLowerCase().includes(termo)`. Isso ignora caixa, mas não ignora acento:
 * quem digita `joao` não acha o negócio de "João Conceição", nem `instalacao`
 * acha "Instalação elétrica", e fica sem o negócio para montar a proposta.
 *
 * ═══ A regra ═══
 *
 * O termo, o título do negócio e o rótulo do contato passam por
 * `termoSemAcento` (`lib/inbox/termo-de-busca.ts`), a mesma régua de
 * `filtrarDestinos`. O telefone continua comparado como antes: dígito não tem
 * acento.
 *
 * ═══ Por que função pura e exportada ═══
 *
 * A filtragem morava dentro de um `useMemo` do componente da tela. Fora dele,
 * ela é testável sem DOM, como `lib/inbox/filtrar-destinos.ts` (#4078).
 */
import { rotuloDoContato, type ContatoNomeavel } from "@/lib/contacts/rotulo-do-contato";
import { termoSemAcento } from "@/lib/inbox/termo-de-busca";

/** O que a busca lê de cada negócio: o título e o contato. */
export interface NegocioBuscavel {
  title: string | null;
  contact: ContatoNomeavel | null;
}

/**
 * Filtra os negócios pelo termo digitado, preservando a ordem recebida.
 *
 * Termo vazio (ou só espaços) devolve a lista inteira: a tela abre sem filtro.
 */
export function filtrarNegocios<T extends NegocioBuscavel>(negocios: T[], busca: string): T[] {
  const termo = termoSemAcento(busca.trim());
  if (!termo) return negocios;
  return negocios.filter(
    (negocio) =>
      termoSemAcento(negocio.title ?? "").includes(termo) ||
      // Nome único da função central: remontar a cadeia aqui vira mais uma cópia.
      termoSemAcento(rotuloDoContato(negocio.contact)).includes(termo) ||
      (negocio.contact?.phone_number ?? "").toLowerCase().includes(termo),
  );
}
