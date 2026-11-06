/**
 * Nome da cópia de uma linha que tem `unique (organization_id, name)` — o
 * ponteiro de fluxo de follow-up (`followup_flow_pointers`, teto 80) e o agente
 * (`ai_agents`, teto 120). Duplicar "Foo" duas vezes não pode tentar gravar
 * "Foo (cópia)" de novo: o INSERT bate no índice e o chamador devolve 500.
 *
 * Régua:
 * - o primeiro sufixo LIVRE vence — `1` é " (cópia)", `2` em diante é
 *   " (cópia N)". Número ocupado é pulado, não saltado: com "(cópia)" e
 *   "(cópia 3)" ocupados a próxima é "(cópia 2)".
 * - nome que JÁ é cópia continua a mesma linhagem: duplicar "Y (cópia)" dá
 *   "Y (cópia 2)", nunca "Y (cópia) (cópia)". O sufixo que esta função gera é
 *   reconhecido e removido da raiz antes de numerar.
 * - teto: o sufixo come o FINAL do nome, não estoura a coluna. Se o original
 *   já está no limite, o nome da cópia continua válido (<= teto) e não vazio.
 */
export const MAX_FOLLOWUP_FLOW_NAME = 80;

/** O sufixo que ESTA função gera. Nome que termina nele está no meio da linhagem. */
const SUFIXO_DE_COPIA = / \(cópia(?: \d+)?\)$/;

export type OpcoesDeNomeDaCopia = {
  /** Teto da coluna `name`. 80 no fluxo de follow-up; 120 no agente. */
  teto?: number;
  /** Raiz quando o original é vazio: "Fluxo" (o padrão, do follow-up); "Agente" no agente. */
  raizVazia?: string;
};

/**
 * `slice` corta em unidade UTF-16: no limite, um emoji vira meia letra (um
 * surrogate sozinho), que o Postgres recusa no INSERT — o mesmo 500 por outra
 * porta. Corta a metade órfã, e o nome fica uma unidade mais curto.
 */
function semMetadeDeEmoji(texto: string): string {
  return /[\uD800-\uDBFF]$/.test(texto) ? texto.slice(0, -1) : texto;
}

export function nomeDaCopia(
  original: string,
  ocupados: Iterable<string>,
  opcoes: OpcoesDeNomeDaCopia = {},
): string {
  const teto = opcoes.teto ?? MAX_FOLLOWUP_FLOW_NAME;
  const taken = new Set(ocupados);
  const raiz = original.trim().replace(SUFIXO_DE_COPIA, "").trim() || opcoes.raizVazia || "Fluxo";
  for (let n = 1; n < 1000; n++) {
    const sufixo = n === 1 ? " (cópia)" : ` (cópia ${n})`;
    const nome =
      raiz.length + sufixo.length <= teto
        ? raiz + sufixo
        : semMetadeDeEmoji(raiz.slice(0, Math.max(0, teto - sufixo.length))) + sufixo;
    if (!taken.has(nome)) return nome;
  }
  // ponytail: 1000 cópias do mesmo nome é o teto; UUID no sufixo é o upgrade.
  return `${semMetadeDeEmoji(raiz.slice(0, Math.max(0, teto - 9)))} ${crypto.randomUUID().slice(0, 8)}`.slice(
    0,
    teto,
  );
}
