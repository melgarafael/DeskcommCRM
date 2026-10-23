/**
 * StepResult → tool_calls jsonb serializer for ai_agent_runs (S-13.08).
 *
 * Stores a slim trace renderable by the agent test UI. Args are redacted using
 * the same allowlist as `lib/mcp/audit.ts`; long strings are truncated.
 */

const REDACT_KEYS = new Set([
  "authorization",
  "api_key",
  "token",
  "password",
  "cpf",
]);

/** Nomes de tool cujo resultado `linhas` deve ser RESUMIDO no rastro (D8), nunca o conteúdo.
 *
 * Regra de escopo da D8 (Spec 25, R1): o rastro de `crm_consultar_receita` guarda
 * os argumentos sem os valores dos parâmetros de busca (só os nomes) e o resultado
 * SÓ como contagem de linhas + colunas + `truncado`. Nenhuma linha da origem vai
 * para o rastro.
 *
 * A regra é POR NOME DE TOOL (não por chave genérica), para não mudar o rastro de
 * outras tools que não são desta fatia. */
const TOOL_RESULTADO_RESUMIDO = new Set(["crm_consultar_receita"]);

/** Chaves de resultado que, para as tools acima, são resumidas (nunca o array inteiro). */
const RESULTADO_RESUMIDO = new Set(["linhas"]);

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}...[truncated]` : value;
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k.toLowerCase()) ? "[redacted]" : redactValue(v);
    }
    return out;
  }
  return value;
}

/** Redige os argumentos de `crm_consultar_receita`: guarda os NOMES dos parâmetros
 * de busca, nunca os valores. Serve ao rastro e à auditoria da tool (os dois
 * ingressos), para a regra ser uma só. Uma `busca` que não é objeto não tem nome
 * de chave a guardar: sai como marcador, nunca como o valor. */
export function redigirArgsReceita(args: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k !== "busca") out[k] = redactValue(v);
    else out[k] = v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : "[omitido]";
  }
  return out;
}

/** Resume o resultado de `crm_consultar_receita`: `linhas` vira contagem, o resto segue redação normal. */
function resumirResultadoReceita(result: unknown): unknown {
  if (result && typeof result === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
      if (RESULTADO_RESUMIDO.has(k) && Array.isArray(v)) {
        out[k] = `[${v.length} itens resumidos pelo rastro]`;
      } else {
        out[k] = redactValue(v);
      }
    }
    return out;
  }
  return redactValue(result);
}

interface MinimalStep {
  stepNumber?: number;
  text?: string;
  finishReason?: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
  toolCalls?: Array<{ toolName?: string; input?: unknown }>;
  toolResults?: Array<{ toolName?: string; output?: unknown; result?: unknown }>;
}

export interface SerializedStep {
  step: number;
  text?: string;
  finish_reason?: string;
  tokens_in?: number;
  tokens_out?: number;
  tool_calls: Array<{
    tool_name: string;
    args: unknown;
    result?: unknown;
  }>;
}

export function serializeSteps(steps: ReadonlyArray<MinimalStep>): SerializedStep[] {
  return steps.map((step, idx) => {
    const calls = step.toolCalls ?? [];
    const results = step.toolResults ?? [];
    const toolEntries = calls.map((call, i) => {
      const match = results[i];
      const result = match?.output ?? match?.result;
      const toolName = String(call.toolName ?? "unknown");
      const resumido = TOOL_RESULTADO_RESUMIDO.has(toolName);
      return {
        tool_name: toolName,
        args: resumido
          ? typeof call.input === "object" && call.input !== null
            ? redigirArgsReceita(call.input)
            : "[omitido]"
          : redactValue(call.input ?? {}),
        result: result === undefined ? undefined : (resumido ? resumirResultadoReceita(result) : redactValue(result)),
      };
    });
    return {
      step: step.stepNumber ?? idx,
      text: step.text && step.text.length > 0 ? step.text.slice(0, 4000) : undefined,
      finish_reason:
        typeof step.finishReason === "string" ? step.finishReason : undefined,
      tokens_in: step.usage?.inputTokens,
      tokens_out: step.usage?.outputTokens,
      tool_calls: toolEntries,
    };
  });
}
