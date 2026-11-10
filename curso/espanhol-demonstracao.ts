/** Texto fictício das fotografias, separado dos rótulos traduzidos pelo produto.
 * O catálogo copia apenas as traduções necessárias ao CRM: as correspondências
 * exatas já publicadas no curso em espanhol foram reaproveitadas, e as mensagens
 * dos personagens foram traduzidas aqui. Nenhum arquivo do site é lido em runtime.
 */
import catalogo from "./espanhol-demonstracao.json";
import { idiomaDaCaptura } from "./configuracao";

/** Consulta independente do idioma para seletores de dados semeados. */
export function traducaoDaDemonstracao(texto: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(catalogo, texto)
    ? (catalogo as Readonly<Record<string, string>>)[texto]
    : undefined;
}

/** Em ES, uma frase nova precisa de tradução explícita antes de aparecer na foto. */
export function textoDaDemonstracao(texto: string): string {
  if (idiomaDaCaptura() === "pt-BR") return texto;
  const traduzido = traducaoDaDemonstracao(texto);
  if (traduzido !== undefined) return traduzido;
  // Nomes próprios já estão declarados no catálogo; só números e códigos puros
  // podem passar sem entrada. Prosa desconhecida nunca cai silenciosamente em PT.
  if (
    !texto.trim() ||
    /^[\d\s.,:/+()—–%-]+$/u.test(texto) ||
    /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/u.test(texto) ||
    /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(texto)
  )
    return texto;
  throw new Error(
    // o texto vai junto: sem ele, quem falha (às vezes um `limpar` de outro módulo) não aparece no erro
    `texto demonstrativo sem tradução em espanhol; acrescente a entrada no catálogo do curso: ${JSON.stringify(texto.slice(0, 120))}`,
  );
}
