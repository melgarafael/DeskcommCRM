/** Controlled provider for the existing INTERNAL_AGENT_RUN_STUB QA switch.
 * Only substitutes the provider seam: tools, retrieval, gates and closing remain real.
 */
import { randomUUID } from 'node:crypto';
import { createFakeRegistry } from '../edge/llm/providers';
import { MARCA_DA_CONSULTA_INTERNA } from './conversa-do-caso/contexto';
import { INSTRUCAO_DO_PEDIDO_HUMANO } from './proposta-sob-pedido';

/** Cenário sintético exclusivo da jornada3281; só existe no provider de QA. */
export const CENARIO_DE_SILENCIO_ASSISTIDO = '[cenario-ui-silencio-3281]';
export function previewFixtureRegistry() {
  return createFakeRegistry(async (options) => {
    const text = JSON.stringify(options.prompt);
    const toolResults = options.prompt.filter((m) => m.role === 'tool').flatMap((m) => m.content);
    const saw = (name: string) => toolResults.some((r) => 'toolName' in r && r.toolName === name);
    const content: Array<
      | { type: 'text'; text: string }
      | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
    > = [];
    if (options.tools?.length && text.includes(CENARIO_DE_SILENCIO_ASSISTIDO)) {
      // A mesma conversa só ganha texto quando o motor inclui o pedido humano.
      // Não há contador global de chamadas nem alteração do cenário comum.
      const pedido = JSON.stringify(INSTRUCAO_DO_PEDIDO_HUMANO).slice(1, -1);
      if (text.includes(pedido)) {
        content.push({
          type: 'tool-call',
          toolCallId: randomUUID(),
          toolName: 'send_message',
          input: JSON.stringify({ body: 'Bom dia! Posso ajudar com o seu pedido?' }),
        });
      } else {
        content.push({ type: 'text', text: '' });
      }
    } else if (!options.tools?.length) {
      // A CONSULTA INTERNA DO CASO vem ANTES dos ramos de JSON.
      //
      // Os ramos abaixo devolvem JSON (memória, compactação, checkpoint) porque
      // é isso que o turno espera de uma chamada sem tools. O chat do caso
      // espera PROSA — e sem este ramo o e2e mostraria o JSON de compactação
      // dentro da bolha da IA, na tela, para quem está avaliando o produto.
      //
      // A marca é IMPORTADA do módulo do prompt, nunca um literal duplicado:
      // literal duplicado é a divergência que este repositório já pagou várias
      // vezes — o prompt muda de um lado e o dublê segue casando o texto velho.
      const value = text.includes(MARCA_DA_CONSULTA_INTERNA)
        ? 'Pelo que está registrado, o cliente pediu um desconto acima da política. ' +
          'A IA travou porque a política permite até 10%.'
        : text.includes('Turno interno de memória')
        ? {
            notes: [
              { headline: 'Preferência do cenário', body: 'Atendimento com confirmação humana.' },
            ],
          }
        : text.includes('Compacte a conversa')
          ? {
              commitments: [],
              objections: [],
              personal_data: [],
              stage: null,
              rolling_summary: 'Cenário resumido para revisão.',
            }
          : {
              commitments: [],
              objections: [],
              next_action: null,
              rolling_summary: 'Resposta proposta para revisão humana.',
              declaracao: { promessas: [] },
            };
      // Prosa sai como prosa; os ramos de JSON continuam serializados. Um
      // `JSON.stringify` cego poria a resposta do chat entre aspas na tela.
      content.push({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) });
    } else {
      const has = (name: string) =>
        options.tools?.some((t) => t.type === 'function' && t.name === name);
      const name =
        has('search_knowledge') && !saw('search_knowledge')
          ? 'search_knowledge'
          : !saw('send_message')
            ? 'send_message'
            : null;
      if (name)
        content.push({
          type: 'tool-call',
          toolCallId: randomUUID(),
          toolName: name,
          input: JSON.stringify(
            name === 'search_knowledge'
              ? { query: 'informações de atendimento' }
              : {
                  body: 'Olá! Posso ajudar com as informações do atendimento. O que você gostaria de saber?',
                },
          ),
        });
      else content.push({ type: 'text', text: 'Sugestão registrada.' });
    }
    return {
      content,
      finishReason: {
        unified: content[0]?.type === 'tool-call' ? 'tool-calls' : 'stop',
        raw: undefined,
      },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    };
  });
}
