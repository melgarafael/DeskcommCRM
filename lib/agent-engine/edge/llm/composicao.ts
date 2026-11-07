/**
 * De que é feito o pedido de uma chamada — só TAMANHOS e o hash do prefixo,
 * nunca conteúdo. Vai para `llm_calls` (colunas da migration 9105) e é a régua
 * de "antes e depois" de toda economia de tokens: sistema, ferramentas e
 * mensagens pesam quanto, e quantas partes de mídia a entrada teve.
 *
 * Fica FORA de `stable-prefix.ts` porque aquele módulo proíbe material volátil
 * por doutrina, e as mensagens são voláteis. Usa a MESMA `serializeStablePrefix`,
 * então `prefixoHash` é igual ao de `stablePrefixHash` e `charsFerramentas` sai
 * por subtração, sem serializar duas vezes.
 */
import { createHash } from 'node:crypto';

import type { ModelMessage, ToolSet } from 'ai';

import { serializeStablePrefix } from './stable-prefix';

export interface ComposicaoDoPedido {
  charsSistema: number;
  /** Prefixo serializado menos o sistema: ferramentas + rótulos `=== tool:x ===`. */
  charsFerramentas: number;
  /** Texto, raciocínio e JSON de chamada e de resultado de ferramenta. Mídia não conta. */
  charsMensagens: number;
  /** Partes `file`/`image`: tokens de mídia que nenhum `chars*` explica. */
  partesDeMidia: number;
  /** sha256 de `serializeStablePrefix(system, tools, esquemaSemPadrao)`, o mesmo de `stablePrefixHash`. */
  prefixoHash: string;
}

export async function medirComposicao(input: {
  system?: string | undefined;
  tools?: ToolSet | undefined;
  /**
   * O MESMO valor que o seam passou a `buildStablePrefix`. Sem ele, com o knob
   * LLM_TOOL_SCHEMA_SEM_PADRAO ligado, as colunas descreveriam um esquema que não
   * foi ao fio, e a comparação off×on mediria a régua, não a economia.
   */
  esquemaSemPadrao?: boolean | undefined;
  messages: ModelMessage[];
}): Promise<ComposicaoDoPedido> {
  const prefixo = await serializeStablePrefix({
    system: input.system,
    tools: input.tools,
    esquemaSemPadrao: input.esquemaSemPadrao,
  });
  const charsSistema = input.system?.length ?? 0;
  const temFerramentas = input.tools !== undefined && Object.keys(input.tools).length > 0;

  let charsMensagens = 0;
  let partesDeMidia = 0;
  for (const m of input.messages) {
    if (typeof m.content === 'string') {
      charsMensagens += m.content.length;
      continue;
    }
    for (const parte of m.content) {
      if (parte.type === 'text' || parte.type === 'reasoning') charsMensagens += parte.text.length;
      else if (parte.type === 'tool-call') charsMensagens += JSON.stringify(parte.input ?? null).length;
      else if (parte.type === 'tool-result') charsMensagens += JSON.stringify(parte.output ?? null).length;
      else if (parte.type === 'file' || parte.type === 'image') partesDeMidia += 1;
    }
  }

  return {
    charsSistema,
    charsFerramentas: temFerramentas ? prefixo.length - charsSistema : 0,
    charsMensagens,
    partesDeMidia,
    prefixoHash: createHash('sha256').update(prefixo, 'utf8').digest('hex'),
  };
}
