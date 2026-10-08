import type { Lead } from "@/lib/types/leads";

/** O que a conta precisa de um card: identidade e posição na etapa. */
type CardNaEtapa = Pick<Lead, "id" | "position_in_stage">;

/**
 * O vizinho de baixo do card solto, contado na etapa INTEIRA (sem o filtro da
 * página).
 *
 * O quadro monta o `before`/`after` a partir da lista VISÍVEL — é ela que o
 * operador vê e é dela que sai o card em que ele soltou. Mas a etapa inteira é
 * maior que a visível assim que um filtro liga, e `midpoint` só continua
 * produzindo uma posição que ninguém tem se os dois vizinhos forem os
 * vizinhos REAIS: com o de baixo tirado de lista filtrada, soltar no fim dá
 * `último + 1000`, que é a posição nascida do card que o filtro escondeu, e a
 * média entre dois visíveis cai em cima do escondido do meio (issue #2545).
 *
 * Sem filtro a etapa inteira e a lista visível coincidem, e o resultado é o
 * mesmo `after` de antes.
 *
 * - `acima` nulo (solto no topo): o primeiro card da etapa inteira.
 * - Card escondido EMPATADO com o de cima (empate já gravado no banco): é
 *   pulado, senão o `midpoint` daria NaN. Empate entre dois VISÍVEIS fica como
 *   hoje (cancela).
 * - Sem o cache do quadro, ou com o de cima fora dele: o `after` visível.
 *
 * Ordena uma CÓPIA (`filter` já devolve array novo): a lista do cache é
 * compartilhada por todo o quadro e reordená-la aqui embaralharia a coluna na
 * hora do arrasto.
 */
export function proximoNaEtapaInteira<C extends CardNaEtapa>(
  acima: C | null,
  abaixoVisivel: C | null,
  etapaInteira: readonly C[] | null,
  arrastadoId: string,
): C | null {
  if (!etapaInteira) return abaixoVisivel;
  const todos = etapaInteira
    .filter((l) => l.id !== arrastadoId)
    .sort((a, b) => a.position_in_stage - b.position_in_stage);
  if (!acima) return todos[0] ?? null;
  const i = todos.findIndex((l) => l.id === acima.id);
  if (i < 0) return abaixoVisivel;
  const empatado = (l: C) => l.position_in_stage === acima.position_in_stage;
  return todos.slice(i + 1).find((l) => l.id === abaixoVisivel?.id || !empatado(l)) ?? null;
}
