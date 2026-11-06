/**
 * A MEDIANA da 1ª resposta humana e o RECORTE por ETIQUETA DO CONTATO (issue #3212).
 *
 * ─── O que mora aqui e o que fica no SQL ─────────────────────────────────────
 *
 * A conta é da RPC `fn_attendant_metrics` (0037/0235/0266/0596), que ganha a
 * mediana e o recorte por etiqueta na migration 0754. Reimplementar a média aqui
 * seria uma SEGUNDA versão da verdade — a mesma razão escrita em
 * `lib/metrics/canais.ts`. Este módulo guarda a RÉGUA, em código puro, e faz o
 * que o SQL sozinho não faz:
 *
 *   1. `mediana()` é a DEFINIÇÃO legível do que o `percentile_cont(0.5)` do banco
 *      tem de devolver — `tests/invariants/mediana-e-recorte-por-etiqueta.test.ts`
 *      põe as duas lado a lado sobre a MESMA amostra, no banco de verdade.
 *   2. `contatoCarregaEtiqueta()` é o predicado do recorte, com a MESMA
 *      normalização do `lower(btrim(...))` da RPC.
 *   3. `normalizarEtiqueta()` é a porta da rota: `""` e `"   "` não são etiqueta
 *      nenhuma e viram `null` — e `null` significa "não recorta".
 *
 * ─── As três regras que a tela e a conta não podem furar ─────────────────────
 *
 * 1. **`null` ≠ `0`.** Amostra vazia (nenhuma conversa com par válido) devolve
 *    `null` — "não medida". Trocar por `0` transformaria "ninguém respondeu" na
 *    leitura mais gentil possível: "respondeu na hora zero".
 * 2. **A média NÃO muda.** A mediana entra AO LADO dela, como campo novo. Nada
 *    neste módulo calcula média — e nada no SQL a recalcula.
 * 3. **Etiqueta se compara normalizada** (espaços das pontas fora, caixa baixa):
 *    `Fornecedor ` e `fornecedor` são a MESMA etiqueta para quem digita na tela
 *    de contatos. O `trim` é o mesmo do `btrim` da RPC — comparar cru faria o
 *    recorte depender de como o operador digitou.
 */

/**
 * A etiqueta como o recorte a entende: sem espaços nas pontas e sem a string
 * vazia. `null` = sem recorte (nenhuma conversa sai da conta).
 */
export function normalizarEtiqueta(bruta: string | null | undefined): string | null {
  if (typeof bruta !== "string") return null;
  const limpa = bruta.trim();
  return limpa === "" ? null : limpa;
}

/**
 * O contato carrega a etiqueta pedida? O par TS do `exists (... lower(btrim(t)) =
 * lower(btrim(p_excluir_etiqueta)))` da RPC — inclusive no não-caso: sem etiqueta
 * pedida (`null`), ninguém é excluído.
 */
export function contatoCarregaEtiqueta(
  tags: readonly string[] | null | undefined,
  etiqueta: string | null | undefined,
): boolean {
  const alvo = normalizarEtiqueta(etiqueta);
  if (alvo === null || !Array.isArray(tags)) return false;
  const procurada = alvo.toLowerCase();
  return tags.some(
    (tag) => typeof tag === "string" && tag.trim().toLowerCase() === procurada,
  );
}

/**
 * A MEDIANA de uma amostra de durações em segundos.
 *
 * Ordena uma cópia (nunca a amostra de quem chama), devolve o elemento do meio
 * quando o tamanho é ímpar e a MÉDIA dos dois do meio quando é par — o mesmo que
 * o `percentile_cont(0.5)` do Postgres, que interpola linearmente. Amostra vazia
 * devolve `null` (não medida), nunca `0`.
 */
export function mediana(amostra: readonly number[]): number | null {
  if (!Array.isArray(amostra) || amostra.length === 0) return null;
  const ordenada = [...amostra].sort((a, b) => a - b);
  const meio = Math.floor(ordenada.length / 2);
  if (ordenada.length % 2 === 1) return ordenada[meio]!;
  return (ordenada[meio - 1]! + ordenada[meio]!) / 2;
}
