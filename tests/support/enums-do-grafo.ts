/**
 * A lista de valores de wire do follow-up, DERIVADA do schema — nunca escrita à
 * mão. Vive aqui, e não dentro de um arquivo de teste, porque duas provas
 * dependem dela: o invariante de cobertura do dicionário
 * (`lib/followup/vocabulario.test.ts`) e a varredura da tela
 * (`tests/e2e/followup-linguagem.spec.ts`). Duas cópias envelheceriam separado,
 * e a que envelhecesse primeiro passaria verde sem medir nada.
 */
import { triggerConfigSchema } from "@/lib/followup/api-schemas";
import { flowNodeSchema } from "@/lib/followup/graph-schema";

export interface EnumDoGrafo {
  /** Onde ele mora, para a mensagem de falha apontar o dedo. */
  caminho: string;
  valores: string[];
}

/* eslint-disable @typescript-eslint/no-explicit-any -- ler o schema como DADO é
   o ponto: confiar no tipo exportado seria confiar justamente no que muda. */

/**
 * Todo `z.enum` alcançável a partir de um schema, descendo por objeto, array,
 * optional/default e união.
 *
 * Literais (`z.literal`) ficam de fora de propósito: são o discriminante
 * estrutural da união (`mode`, `kind`, `type`), não vocabulário que a tela
 * mostra — e o rótulo deles já é escolhido pelo formulário do próprio tipo.
 */
export function enumsAlcancaveis(raiz: unknown, prefixo = ""): EnumDoGrafo[] {
  const achados: EnumDoGrafo[] = [];
  const vistos = new Set<unknown>();

  const desce = (no: any, caminho: string): void => {
    if (!no || typeof no !== "object" || vistos.has(no)) return;
    vistos.add(no);

    const def = no.def ?? no._def;
    if (Array.isArray(no.options) && no.options.every((o: unknown) => typeof o === "string")) {
      achados.push({ caminho, valores: no.options as string[] });
      return;
    }
    if (Array.isArray(no.options)) {
      no.options.forEach((membro: unknown, i: number) => desce(membro, `${caminho}|${i}`));
    }
    if (typeof no.unwrap === "function") desce(no.unwrap(), caminho);
    if (def?.innerType) desce(def.innerType, caminho);
    if (def?.element) desce(def.element, `${caminho}[]`);
    if (no.element) desce(no.element, `${caminho}[]`);
    const shape = no.shape ?? def?.shape;
    if (shape && typeof shape === "object") {
      for (const [chave, filho] of Object.entries(shape)) desce(filho, `${caminho}.${chave}`);
    }
  };

  desce(raiz, prefixo);
  return achados;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/** Todo enum do grafo de follow-up mais o do gatilho, com o caminho de origem. */
export function enumsDoFollowup(): EnumDoGrafo[] {
  return [...enumsAlcancaveis(flowNodeSchema, "flowNode"), ...enumsAlcancaveis(triggerConfigSchema, "trigger")];
}

/**
 * Só os valores, sem repetição — a lista que a tela NÃO pode mostrar.
 *
 * `custom` fica de fora: é o único valor de wire que também é uma palavra que o
 * usuário pode ter digitado no nome do fluxo ou numa etiqueta, e barrá-lo
 * transformaria a varredura num gerador de falso vermelho. Ele é coberto pelo
 * invariante de tradução, que é onde a pergunta certa é feita.
 *
 * `contato` (#3363) entra na mesma classe de razão e com a mesma prova: a
 * palavra já é português corrente nos rótulos do construtor — o PRÓPRIO painel
 * do gatilho escreve "por contato" (`TriggerConfigControl`, "Quantas vezes no
 * máximo, por contato"), e barrá-lo fazia a varredura apontar aquele rótulo
 * como vazamento de wire. O valor `contato` do enum não escapa cru: a tela o
 * mostra como "Ficha do contato" (`CollectForm`) e o invariante
 * `lib/followup/vocabulario.test.ts` cobre a tradução — e aqui, como em
 * `custom`, a pergunta certa é a de tradução, não a de palavra isolada.
 */
export const VALORES_DE_WIRE_NA_TELA_PROIBIDOS = [
  ...new Set(enumsDoFollowup().flatMap((e) => e.valores)),
].filter((v) => v !== "custom" && v !== "contato");
