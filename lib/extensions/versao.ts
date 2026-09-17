/**
 * Ordem entre duas versões `x.y.z`, a única forma que o contrato admite (o catálogo e o manifesto
 * recusam qualquer outra, sem zeros à esquerda). Negativo quando `a` é menor, zero quando iguais,
 * positivo quando maior. É o que separa "Atualizar para" de "Trocar para" uma versão menor.
 *
 * Compara cada parte como texto de dígitos, pelo comprimento e depois pela ordem: `Number` iguala
 * partes diferentes acima de 2^53, e a expressão de versão aceita partes desse tamanho.
 */
export function compararVersoes(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let indice = 0; indice < 3; indice += 1) {
    const x = pa[indice] ?? "0";
    const y = pb[indice] ?? "0";
    if (x.length !== y.length) return x.length - y.length;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Um pedido de atualização para versão menor é troca de versão, e todo texto diz isso. O destino é
 * `to_version` depois de concluído e `version` enquanto prepara, quando falha ou é cancelado.
 */
export function ehTrocaParaVersaoMenor(recibo: {
  from_version: string | null;
  to_version: string | null;
  version: string | null;
}): boolean {
  const destino = recibo.to_version ?? recibo.version;
  return Boolean(destino && recibo.from_version && compararVersoes(destino, recibo.from_version) < 0);
}
