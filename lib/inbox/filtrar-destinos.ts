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
 * Os DOIS lados passam pela mesma chave: separar a letra do sinal diacrítico
 * (`NFD`) e descartar a faixa U+0300–U+036F. É a mesma conta de
 * `chaveDeComparacaoDeEtiqueta` (`lib/contacts/etiquetas.ts`), sem o
 * `\p{Diacritic}` — que exige `u` e nem toda plataforma de destino tem.
 *
 * ═══ Por que função pura e exportada ═══
 *
 * A janela não tinha teste próprio: a filtragem morava dentro de um `useMemo`
 * de um componente que abre diálogo, depende de i18n e de rede. Fora do
 * componente, a regra da busca é testável sem DOM — e continua sendo UMA regra,
 * não uma cópia por tela.
 */

/** O que a lista oferece: a conversa e o rótulo já resolvido por `rotuloDoContato`. */
export interface DestinoDeEncaminhamento {
  id: string;
  rotulo: string;
}

/**
 * A chave de comparação: sem caixa e sem acento.
 *
 * `NFC` no fim devolve a string ao formato composto; o `includes` funciona nos
 * dois formatos, mas manter a saída em NFC evita comparar maçã com maçã
 * decomposta em qualquer uso futuro.
 */
export function chaveDeBuscaDeDestino(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .normalize("NFC")
    .toLowerCase();
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
  const termo = chaveDeBuscaDeDestino(busca.trim());
  if (!termo) return destinos;
  return destinos.filter((destino) => chaveDeBuscaDeDestino(destino.rotulo).includes(termo));
}
