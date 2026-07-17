/**
 * Pruning de tool results antigos (F3-10; blueprint achado 1.5 — o TERÇO que fecha a
 * tríade anti-context-rot: pruning + compaction (F3-07) + flush (F3-07)). Determinístico,
 * SEM LLM: tool results além de uma janela de N rodadas (turnos) do run são podados do
 * contexto e trocados por um STUB curto e referenciável — {tool, resumo dos args, 1 linha
 * de resultado}. O conteúdo DURÁVEL já foi para lead_notes pelo flush pré-compaction, então
 * nada de valor se perde: a informação segue recuperável via recall (F3-06).
 *
 * Onde opera: nas responseMessages do run do agente (a fita de tool-call/tool-result que o
 * AI SDK acumula) ANTES de serem reenviadas na chamada de fechamento (checkpoint) — é o
 * único ponto onde a fita inteira é re-serializada num prompt. Poda aqui = orçamento do
 * prompt de fechamento cai (achado do pruning: o histórico de tool results é o que mais
 * incha em runs com muitas leituras).
 *
 * Cache (regra dura 15/F2-17): opera SÓ no sufixo por-lead (as responseMessages do run),
 * NUNCA no prefixo estável (system/tools) — não invalida o cache org-wide.
 *
 * PII: o stub carrega dados do lead (é contexto pro modelo, o ponto), mas NUNCA vai a log —
 * esta função não loga; quem a chama também não ecoa o stub.
 */
import type { ModelMessage } from '../edge/llm/run-model-call';
import { countPayloadTokens } from '../edge/crm/get-lead-context';

/** Knobs do pruning (env PRUNE_TOOL_RESULTS_*; defaults conservadores no .env.example). */
export interface PruneToolResultsKnobs {
  /**
   * Janela de rodadas (turnos) de tool-result mantidas ÍNTEGRAS, contadas do fim. As
   * rodadas ANTERIORES a ela viram stub. ≥1 sempre (a rodada CORRENTE nunca é podada —
   * F3-10 acceptance 3); o Zod garante positivo.
   */
  windowTurns: number;
  /**
   * Política: só poda o tool result cujo output serializado excede este nº de tokens
   * (heurística chars/3,5 do resto do harness). Resultados pequenos (ex.: ack de envio)
   * não valem o churn do stub — ficam íntegros mesmo além da janela.
   */
  minResultTokens: number;
}

// Comprimentos do stub — cosméticos (não são knobs de anti-ban/ritmo/janela). O stub é
// curto e referenciável por construção; a informação completa está em lead_notes.
const STUB_ARGS_MAX_CHARS = 120;
const STUB_RESULT_MAX_CHARS = 160;

function truncateOneLine(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

function buildStub(toolName: string, args: unknown, resultText: string): string {
  const argsSummary = args === undefined ? '—' : truncateOneLine(JSON.stringify(args), STUB_ARGS_MAX_CHARS);
  return `[resultado podado — tool=${toolName} args=${argsSummary} → ${truncateOneLine(resultText, STUB_RESULT_MAX_CHARS)}]`;
}

/**
 * Poda tool results além da janela de N rodadas, trocando-os por stub. Função PURA e
 * determinística. Cada mensagem `role:'tool'` é uma rodada; as últimas `windowTurns`
 * rodadas ficam intactas. Os args do stub vêm do tool-call correspondente (por toolCallId).
 */
export function pruneToolResults(messages: ModelMessage[], knobs: PruneToolResultsKnobs): ModelMessage[] {
  // toolCallId → args (dos tool-call parts das mensagens do assistant), p/ o resumo do stub.
  const argsById = new Map<string, unknown>();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'tool-call') {
          argsById.set(part.toolCallId, part.input);
        }
      }
    }
  }

  const totalToolMsgs = messages.reduce((n, m) => (m.role === 'tool' ? n + 1 : n), 0);
  const firstKeptRound = totalToolMsgs - knobs.windowTurns; // rodadas com índice < isto são podadas
  let roundIndex = 0;

  return messages.map((m) => {
    if (m.role !== 'tool') {
      return m;
    }
    const thisRound = roundIndex;
    roundIndex += 1;
    if (thisRound >= firstKeptRound) {
      return m; // dentro da janela → íntegra (inclui a rodada corrente)
    }
    const content = m.content.map((part) => {
      if (part.type !== 'tool-result') {
        return part;
      }
      const output = part.output;
      let resultText: string;
      switch (output.type) {
        case 'text':
        case 'error-text':
          resultText = output.value;
          break;
        case 'json':
        case 'error-json':
          resultText = JSON.stringify(output.value);
          break;
        default:
          resultText = JSON.stringify(output);
      }
      if (countPayloadTokens(resultText) <= knobs.minResultTokens) {
        return part; // política: pequeno demais para valer o stub
      }
      return {
        ...part,
        output: { type: 'text' as const, value: buildStub(part.toolName, argsById.get(part.toolCallId), resultText) },
      };
    });
    return { ...m, content };
  });
}
