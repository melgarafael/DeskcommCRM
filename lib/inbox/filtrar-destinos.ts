/**
 * QUEM APARECE NA LISTA DE DESTINOS DO ENCAMINHAMENTO — a régua da busca.
 *
 * ═══ O defeito que ela conserta (#4072) ═══
 *
 * A janela "Encaminhar" filtra pelo rótulo do contato, e filtrava com
 * `rotulo.toLowerCase().includes(termo)`. Isso ignora caixa, mas não ignora
 * acento: quem digita `joao` não acha "João" e acaba rolando a lista inteira
 * atrás do contato — exatamente o gesto que a busca existia para evitar.
 *
 * ═══ A regra ═══
 *
 * Os DOIS lados passam por `termoSemAcento` (`lib/inbox/termo-de-busca.ts`):
 * a mesma régua que a busca do Inbox manda ao banco e que
 * `tests/invariants/busca-do-inbox-ignora-acento.test.ts` mantém igual ao
 * `f_unaccent` do Postgres. Uma régua própria aqui seria a terceira cópia, e
 * divergiria no primeiro ajuste — já divergia em "Øyvind", que o NFD sozinho
 * não decompõe.
 *
 * ═══ Por que função pura e exportada ═══
 *
 * A filtragem morava dentro de um `useMemo` de um componente que abre diálogo,
 * depende de i18n e de rede. Fora do componente, ela é testável sem DOM.
 */
import { termoSemAcento } from "@/lib/inbox/termo-de-busca";

/** O que a lista oferece: a conversa e o rótulo já resolvido por `rotuloDoContato`. */
export interface DestinoDeEncaminhamento {
  id: string;
  rotulo: string;
}

/**
 * Filtra os destinos pelo termo digitado, preservando a ordem recebida.
 *
 * Termo vazio (ou só espaços) devolve a lista inteira: a janela abre sem filtro.
 */
export function filtrarDestinos(
  destinos: DestinoDeEncaminhamento[],
  busca: string,
): DestinoDeEncaminhamento[] {
  const termo = termoSemAcento(busca.trim());
  if (!termo) return destinos;
  return destinos.filter((destino) => termoSemAcento(destino.rotulo).includes(termo));
}
