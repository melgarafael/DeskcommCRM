/**
 * Mensagem que a pessoa pode ver quando a API não devolveu o envelope JSON.
 *
 * O `apiClient` antigo punha o body inteiro em `ApiError.message`. Um 404 de
 * página Next (`<!DOCTYPE html>...`) ia parar no toast. Aqui o body nunca vira
 * texto de UI: só status e um rótulo curto.
 */

const LIMITE_MENSAGEM = 280;

export function corpoPareceHtml(texto: string): boolean {
  const inicio = texto.trimStart().slice(0, 32).toLowerCase();
  return (
    inicio.startsWith("<!doctype") ||
    inicio.startsWith("<html") ||
    inicio.startsWith("<?xml")
  );
}

export function mensagemEhSeguraParaToast(texto: string): boolean {
  if (!texto || texto.length > LIMITE_MENSAGEM) return false;
  if (corpoPareceHtml(texto)) return false;
  if (texto.includes("<")) return false;
  if (/cookie|authorization|set-cookie|sk-|api[_-]?key|bearer\s/i.test(texto)) {
    return false;
  }
  return true;
}

export function mensagemSeguraDeHttp(status: number, acao: string): string {
  return `Não foi possível ${acao} (HTTP ${status}).`;
}

export function diagnosticoDeCorpoNaoJson(texto: string | null): {
  kind: "html" | "text" | "empty";
  length: number;
} {
  if (!texto) return { kind: "empty", length: 0 };
  if (corpoPareceHtml(texto)) return { kind: "html", length: texto.length };
  return { kind: "text", length: texto.length };
}

export function mensagemVisivelDeApiError(
  err: { status: number; message: string },
  acao: string,
): string {
  if (mensagemEhSeguraParaToast(err.message)) return err.message;
  return mensagemSeguraDeHttp(err.status, acao);
}

/**
 * Timeout do `apiClient`: `AbortController.abort(new DOMException(..., "TimeoutError"))`.
 * Não cobre `AbortError` de navegação/cancelamento — esse não é timeout.
 */
export function ehTimeoutDeRequisicao(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if (!("name" in err) || (err as { name: unknown }).name !== "TimeoutError") {
    return false;
  }
  if (typeof DOMException !== "undefined" && err instanceof DOMException) return true;
  return true;
}
