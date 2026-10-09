/**
 * O link de pagamento vem do banco (gravado a partir da resposta do provedor) e
 * vai para um `href`. Só `https:` passa: `javascript:`, `data:` e `http:` viram
 * null e o botão não renderiza. Exceção única: `http:` no próprio computador
 * (loopback), onde roda o dublê de teste do provedor — nenhum provedor de verdade
 * devolve esse endereço, e ele não executa nada. Puro de propósito: telas de
 * cliente o importam, e `url.ts` lê o env do servidor.
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function linkDePagamentoSeguro(link: string | null | undefined): string | null {
  if (!link || !URL.canParse(link)) return null;
  const url = new URL(link);
  if (url.protocol === "https:") return link;
  return url.protocol === "http:" && LOOPBACK.has(url.hostname) ? link : null;
}
