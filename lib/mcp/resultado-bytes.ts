/**
 * O tamanho, em bytes, do JSON que uma ferramenta devolve ao modelo.
 *
 * É o tamanho que custa token: o que a ferramenta devolve é o que o modelo lê.
 * Só o NÚMERO sai daqui — o conteúdo de uma ferramenta de banco externo pode ter
 * dado pessoal de terceiros e não pode ir para o log.
 *
 * Nunca lança: resultado circular ou com `BigInt` não se mede, e medir não pode
 * derrubar a chamada da ferramenta. Quem chama trata `undefined` como "sem número".
 */
export function tamanhoDoResultado(resultado: unknown): number | undefined {
  try {
    const texto = JSON.stringify(resultado);
    return texto === undefined ? undefined : Buffer.byteLength(texto, "utf8");
  } catch {
    return undefined;
  }
}
