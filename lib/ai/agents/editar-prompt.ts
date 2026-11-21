/**
 * Editar o texto de instruções de um agente por PEDAÇO — puro, sem banco.
 *
 * Quem corrige uma resposta errada pelo ChatGPT quase nunca quer reescrever o
 * prompt inteiro: quer trocar uma frase, acrescentar uma regra. Mandar o texto
 * inteiro de volta multiplica o risco (o modelo "resume" o que não devia tocar).
 * Por isso a edição é por substituição exata, e é RECUSADA — sem gravar nada —
 * quando o trecho não existe ou aparece mais de uma vez sem `todas`: uma troca
 * no lugar errado num prompt de atendimento é pior que troca nenhuma.
 *
 * Os limites de tamanho são os de `versionCreateSchema` (10 a 20.000
 * caracteres): conferidos aqui para a recusa dizer o motivo antes de o schema
 * devolver um erro genérico.
 */
export const PROMPT_MIN = 10;
export const PROMPT_MAX = 20000;

export interface Substituicao {
  procurar: string;
  substituir_por: string;
  /** Troca todas as ocorrências. Sem isto, o trecho tem de aparecer exatamente uma vez. */
  todas?: boolean;
}

export interface PedidoDeEdicao {
  /** O texto inteiro novo. Exclui `substituicoes` e `anexar_ao_final`. */
  novo_prompt?: string;
  substituicoes?: Substituicao[];
  /** Acrescentado no fim, separado por uma linha em branco. */
  anexar_ao_final?: string;
}

export type RecusaDaEdicao =
  | { motivo: "pedido_vazio" }
  | { motivo: "modos_misturados" }
  | { motivo: "trecho_nao_encontrado"; procurar: string }
  | { motivo: "trecho_repetido"; procurar: string; ocorrencias: number }
  | { motivo: "sem_mudanca" }
  | { motivo: "tamanho_invalido"; tamanho: number };

export type ResultadoDaEdicaoDoTexto =
  | { ok: true; texto: string; aplicadas: Array<{ procurar: string; ocorrencias: number }> }
  | ({ ok: false } & RecusaDaEdicao);

function contar(texto: string, trecho: string): number {
  if (!trecho) return 0;
  let n = 0;
  let i = texto.indexOf(trecho);
  while (i !== -1) {
    n++;
    i = texto.indexOf(trecho, i + trecho.length);
  }
  return n;
}

export function aplicarEdicaoNoPrompt(atual: string, pedido: PedidoDeEdicao): ResultadoDaEdicaoDoTexto {
  const temNovo = pedido.novo_prompt !== undefined;
  const temPedacos = (pedido.substituicoes?.length ?? 0) > 0 || pedido.anexar_ao_final !== undefined;
  if (!temNovo && !temPedacos) return { ok: false, motivo: "pedido_vazio" };
  if (temNovo && temPedacos) return { ok: false, motivo: "modos_misturados" };

  let texto = temNovo ? pedido.novo_prompt! : atual;
  const aplicadas: Array<{ procurar: string; ocorrencias: number }> = [];

  for (const s of pedido.substituicoes ?? []) {
    const n = contar(texto, s.procurar);
    if (n === 0) return { ok: false, motivo: "trecho_nao_encontrado", procurar: s.procurar };
    if (n > 1 && !s.todas) return { ok: false, motivo: "trecho_repetido", procurar: s.procurar, ocorrencias: n };
    texto = s.todas ? texto.split(s.procurar).join(s.substituir_por) : texto.replace(s.procurar, () => s.substituir_por);
    aplicadas.push({ procurar: s.procurar, ocorrencias: s.todas ? n : 1 });
  }

  if (pedido.anexar_ao_final !== undefined) {
    texto = `${texto.trimEnd()}\n\n${pedido.anexar_ao_final.trim()}`;
  }

  const tamanho = texto.trim().length;
  if (tamanho < PROMPT_MIN || tamanho > PROMPT_MAX) return { ok: false, motivo: "tamanho_invalido", tamanho };
  if (texto === atual) return { ok: false, motivo: "sem_mudanca" };
  return { ok: true, texto, aplicadas };
}

/** A recusa em uma frase para quem pediu a edição (o modelo, que repassa à pessoa). */
export function explicarRecusa(r: RecusaDaEdicao): string {
  switch (r.motivo) {
    case "pedido_vazio":
      return "Nothing to change: send novo_prompt, or substituicoes and/or anexar_ao_final.";
    case "modos_misturados":
      return "Send either novo_prompt (the whole new text) OR substituicoes/anexar_ao_final (targeted edits), not both.";
    case "trecho_nao_encontrado":
      return `The text to replace was not found in the current instructions: "${r.procurar.slice(0, 120)}". Read the current version with crm_get_ai_agent_version and copy the exact text.`;
    case "trecho_repetido":
      return `The text to replace appears ${r.ocorrencias} times: "${r.procurar.slice(0, 120)}". Use a longer, unique excerpt, or set todas=true to replace all of them.`;
    case "sem_mudanca":
      return "The edit would not change the instructions.";
    case "tamanho_invalido":
      return `The resulting instructions would have ${r.tamanho} characters; the allowed range is ${PROMPT_MIN} to ${PROMPT_MAX}.`;
  }
}
