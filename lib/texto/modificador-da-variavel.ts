/**
 * O MODIFICADOR de uma variável: `{{campo|data}}` e `{{campo|data:dd/mm/aaaa}}`.
 *
 * ─── Por que SEM aspas, e por que isso não pode quebrar o que existe ────────
 *
 * A reserva de valor padrão já ocupou a forma com aspas: `{{campo|"aluno"}}`
 * (`lib/texto/reserva-da-variavel.ts`). Ela é TEXTO do operador e troca o valor
 * vazio. O modificador é outra coisa: ele pede uma TRANSFORMAÇÃO do valor que
 * existe. Como a reserva exige aspas e este fragmento não as aceita, os dois são
 * distinguíveis na mesma posição da marcação — e nada que hoje casa com a
 * reserva muda de sentido.
 *
 * ─── O que ele NÃO aceita, de propósito ────────────────────────────────────
 *
 * Só o modificador que o produto conhece: `data`. Um `{{campo|xyz}}` continua
 * FORA do render, saindo cru como sai hoje — quem escreveu algo que o
 * interpolador não entende precisa VER isso, e não receber o valor sem a
 * transformação que pediu, achando que pediu certo.
 *
 * Grupo de captura: o CONTEÚDO do modificador (grupo 3 em `MARCACAO`, DEPOIS do
 * caminho e da reserva — a ordem importa para quem já lê os grupos 1 e 2).
 * Ausente quando não há modificador.
 */
export const MODIFICADOR_DA_VARIAVEL = String.raw`(?:\|\s*(data(?::[^"“”{}\s|]+)?)\s*)?`;

/** O nome do modificador de data — o único que existe hoje. */
export const MODIFICADOR_DE_DATA = "data";
