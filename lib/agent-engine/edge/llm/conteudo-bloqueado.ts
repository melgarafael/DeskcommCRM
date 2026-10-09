/** Falha do provedor, separada dos vetos locais; não altera sua proteção. */
const MOTIVOS = new Set(['PROHIBITED_CONTENT', 'SAFETY', 'BLOCKLIST', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'SPII', 'RECITATION']);

export class LlmConteudoBloqueadoError extends Error {
  override readonly name = 'llm_conteudo_bloqueado';
  readonly statusCode: number | undefined;
  constructor(readonly motivo: string, status: number | undefined) {
    super(`O provedor de IA bloqueou o conteúdo (${motivo}); isso não é veto do revisor de promessas nem falta de saldo. A causa específica do bloqueio não foi informada. A resposta não foi gerada; revise esta execução antes de tentar novamente.`);
    this.statusCode = status;
  }
}

/** Lê só metadados conhecidos, sem expor corpo, prompt, chave ou erro cru. */
export function identificarConteudoBloqueado(err: unknown): LlmConteudoBloqueadoError | null {
  if (err instanceof LlmConteudoBloqueadoError) return err;
  if (!err || typeof err !== 'object') return null;
  const root = err as Record<string, unknown>;
  const status = typeof root.statusCode === 'number' ? root.statusCode : typeof root.status === 'number' ? root.status : undefined;
  if (status === 401 || status === 403) return null;
  const seen = new Set<object>();
  const pending: Array<{ value: unknown; depth: number }> = [{ value: err, depth: 0 }];
  while (pending.length) {
    const next = pending.shift();
    if (!next || next.depth > 5) continue;
    let value = next.value;
    if (typeof value === 'string' && value.length <= 250000 && value.trim().startsWith('{')) {
      try { value = JSON.parse(value); } catch { continue; }
    }
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const obj = value as Record<string, unknown>;
    const feedback = obj.promptFeedback;
    if (feedback && typeof feedback === 'object') {
      const reason = (feedback as Record<string, unknown>).blockReason;
      if (typeof reason === 'string' && MOTIVOS.has(reason)) return new LlmConteudoBloqueadoError(reason, status);
    }
    for (const key of ['cause', 'value', 'responseBody', 'response', 'data', 'body']) {
      if (obj[key] !== undefined) pending.push({ value: obj[key], depth: next.depth + 1 });
    }
  }
  return null;
}
