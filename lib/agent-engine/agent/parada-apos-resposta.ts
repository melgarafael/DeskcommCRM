/**
 * Parada semântica do loop de `generateText` (AI SDK 7: `stopWhen`).
 *
 * O default do SDK (`isStepCount(1)` sem `stopWhen`, ou só `stepCountIs(maxSteps)`)
 * deixa o modelo fazer mais uma ida paga só para comentar o resultado de
 * `send_message`. Essa ida não chega ao cliente: o runtime descarta texto fora
 * da tool. Consulta/preparação podem continuar; `send_message` autorizada é o
 * fim do turno, salvo o modo de várias mensagens curtas.
 *
 * `hasToolCall('send_message')` do SDK NÃO serve: para no *pedido*, inclusive
 * quando o guardrail recusou e o modelo ainda precisa corrigir.
 */
export const FERRAMENTA_DE_RESPOSTA = "send_message";

export interface PassoDeTool {
  toolCalls?: ReadonlyArray<{ toolName?: string }>;
  toolResults?: ReadonlyArray<{ toolName?: string; output?: unknown }>;
}

export function envioFoiAutorizado(output: unknown): boolean {
  if (output === null || typeof output !== "object") return false;
  const o = output as { ok?: unknown };
  return o.ok === true;
}

function resultadosDeEnvio(
  passo: PassoDeTool,
): ReadonlyArray<{ toolName?: string; output?: unknown }> {
  return (passo.toolResults ?? []).filter((r) => r.toolName === FERRAMENTA_DE_RESPOSTA);
}

export function contarEnviosAutorizados(steps: readonly PassoDeTool[]): number {
  let n = 0;
  for (const passo of steps) {
    for (const r of resultadosDeEnvio(passo)) {
      if (envioFoiAutorizado(r.output)) n += 1;
    }
  }
  return n;
}

export function ultimoPassoTeveEnvio(steps: readonly PassoDeTool[]): boolean {
  const last = steps.at(-1);
  if (!last) return false;
  if (resultadosDeEnvio(last).length > 0) return true;
  return (last.toolCalls ?? []).some((c) => c.toolName === FERRAMENTA_DE_RESPOSTA);
}

/**
 * Quantas `send_message` autorizadas o turno admite antes de encerrar o loop.
 * Sem várias mensagens curtas, a primeira autorizada é terminal. Com o modo
 * ligado, vale o teto físico já existente (`MAX_SENDS_PER_TURN`).
 */
export function maxEnviosDoTurno(opts: {
  splitMessages: boolean;
  maxSendsPerTurn: number;
}): number {
  if (!opts.splitMessages) return 1;
  return Math.max(1, opts.maxSendsPerTurn);
}

/**
 * Condição de `stopWhen` do AI SDK 7: recebe `{ steps }` já com tool results.
 * Não lê argumentos, prompt nem corpo da mensagem.
 */
export function pararAposRespostaTerminal(opts: { maxEnviosAutorizados: number }): (input: {
  steps: Array<PassoDeTool>;
}) => boolean {
  const teto = Math.max(1, opts.maxEnviosAutorizados);
  return ({ steps }) => {
    if (contarEnviosAutorizados(steps) < teto) return false;
    return ultimoPassoTeveEnvio(steps);
  };
}
