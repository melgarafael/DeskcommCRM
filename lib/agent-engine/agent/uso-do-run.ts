/**
 * Contabilização do ensaio: tokens e custo somam TODAS as `llm_calls` do run
 * uma vez. Latência de relógio (parede) não é a soma das chamadas — o
 * classificador de promessa roda DENTRO de `send_message`, então somar as
 * duas `latency_ms` contaria o mesmo intervalo duas vezes.
 *
 * Contrato:
 * - `tokens_in` / `tokens_out` / `cost_cents` = soma das chamadas (sem dupla contagem)
 * - `llm_latency_ms` = soma das `latency_ms` das chamadas (pode superar o relógio)
 * - `latency_ms` do ensaio = tempo de parede, nomeado à parte
 */
export interface UsoDaChamada {
  callId?: string | null;
  purpose?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  costCents?: number | null;
  latencyMs?: number;
}

export interface UsoDoRun {
  tokens_in: number;
  tokens_out: number;
  cost_cents: number;
  /** Soma das latências gravadas em cada chamada. Pode ser maior que o relógio. */
  llm_latency_ms: number;
  llm_purposes: string[];
  llm_call_ids: string[];
}

export function usoDoRunVazio(): UsoDoRun {
  return {
    tokens_in: 0,
    tokens_out: 0,
    cost_cents: 0,
    llm_latency_ms: 0,
    llm_purposes: [],
    llm_call_ids: [],
  };
}

export function somarUsoDasChamadas(chamadas: readonly UsoDaChamada[]): UsoDoRun {
  const acc = usoDoRunVazio();
  for (const chamada of chamadas) aplicarUsoDaChamada(acc, chamada);
  return acc;
}

export function aplicarUsoDaChamada(acc: UsoDoRun, chamada: UsoDaChamada): void {
  const id = chamada.callId;
  if (typeof id === "string" && id !== "") {
    if (acc.llm_call_ids.includes(id)) return;
    acc.llm_call_ids.push(id);
  }
  acc.tokens_in += chamada.usage?.inputTokens ?? 0;
  acc.tokens_out += chamada.usage?.outputTokens ?? 0;
  acc.cost_cents += chamada.costCents ?? 0;
  acc.llm_latency_ms += chamada.latencyMs ?? 0;
  if (chamada.purpose) acc.llm_purposes.push(chamada.purpose);
}

export interface PassoSanitizado {
  index: number;
  tools: string[];
  finish_reason: string;
}

export interface ObservacaoDoGenerateText {
  steps_count: number;
  tools_called: string[];
  steps: PassoSanitizado[];
}

function nomeDaTool(item: { toolName?: string }): string | undefined {
  const n = item.toolName;
  return typeof n === "string" && n !== "" ? n : undefined;
}

function nomesUnicos(items: ReadonlyArray<{ toolName?: string }> | undefined): string[] {
  const nomes: string[] = [];
  const visto = new Set<string>();
  for (const item of items ?? []) {
    const n = nomeDaTool(item);
    if (!n || visto.has(n)) continue;
    visto.add(n);
    nomes.push(n);
  }
  return nomes;
}

/** Nomes de ferramentas chamadas no `generateText` — nunca argumentos. */
export function nomesChamadosDoGenerateText(result: {
  steps?: ReadonlyArray<{
    toolCalls?: ReadonlyArray<{ toolName?: string }>;
  }>;
  toolCalls?: ReadonlyArray<{ toolName?: string }>;
}): string[] {
  const dosPassos = (result.steps ?? []).flatMap((s) => nomesUnicos(s.toolCalls));
  if (dosPassos.length > 0) return [...new Set(dosPassos)];
  return nomesUnicos(result.toolCalls);
}

/**
 * Contagem real de `GenerateTextResult.steps` do AI SDK 7. Sem `steps` no
 * resultado, devolve 0 — não estima por tokens.
 */
export function contarPassosDoGenerateText(result: { steps?: ReadonlyArray<unknown> }): number {
  return Array.isArray(result.steps) ? result.steps.length : 0;
}

export function observarGenerateText(
  result: {
    steps?: ReadonlyArray<{
      stepNumber?: number;
      finishReason?: string;
      toolCalls?: ReadonlyArray<{ toolName?: string }>;
    }>;
    toolCalls?: ReadonlyArray<{ toolName?: string }>;
    finishReason?: string;
  },
  stepsDoSeam?: ReadonlyArray<{
    stepNumber?: number;
    finishReason?: string;
    toolCalls?: ReadonlyArray<{ toolName?: string }>;
  }> | null,
): ObservacaoDoGenerateText {
  const origem = Array.isArray(stepsDoSeam) && stepsDoSeam.length > 0 ? stepsDoSeam : result.steps;
  if (!Array.isArray(origem) || origem.length === 0) {
    return {
      steps_count: 0,
      tools_called: nomesChamadosDoGenerateText(result),
      steps: [],
    };
  }
  const steps: PassoSanitizado[] = origem.map((passo, i) => ({
    index: typeof passo.stepNumber === "number" ? passo.stepNumber : i,
    tools: nomesUnicos(passo.toolCalls),
    finish_reason: typeof passo.finishReason === "string" ? passo.finishReason : "unknown",
  }));
  return {
    steps_count: steps.length,
    tools_called: nomesChamadosDoGenerateText({ steps: origem, toolCalls: result.toolCalls }),
    steps,
  };
}
