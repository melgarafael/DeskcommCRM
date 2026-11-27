/**
 * O que as rotas públicas do chat no site (spec 36, F1) têm em comum na entrada: o teto do
 * corpo e a descrição de um erro para o log. As duas são de quem chama sem sessão, então
 * nenhuma delas pode deixar passar corpo grande nem devolver ou registrar o que o visitante
 * mandou.
 */

/** Teto do corpo de qualquer pedido público do chat. Mensagem de 2.000 caracteres cabe folgada. */
export const TAMANHO_MAXIMO_DO_CORPO = 8192;

export type LeituraDoCorpo =
  | { ok: true; valor: unknown }
  | { ok: false; motivo: "grande" | "invalido" };

/**
 * Lê o corpo como JSON, com teto de bytes. Corpo maior que o teto dá `grande` (e a leitura
 * para no meio, sem ler o resto). JSON que não lê dá `invalido`. O `content-length` declarado
 * acima do teto recusa antes de qualquer leitura.
 */
export async function lerCorpoJson(req: Request): Promise<LeituraDoCorpo> {
  const declarado = req.headers.get("content-length");
  if (declarado !== null && Number(declarado) > TAMANHO_MAXIMO_DO_CORPO) {
    return { ok: false, motivo: "grande" };
  }
  const bytes = await lerAteOLimite(req.body, TAMANHO_MAXIMO_DO_CORPO);
  if (bytes === null) return { ok: false, motivo: "grande" };
  try {
    return { ok: true, valor: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, motivo: "invalido" };
  }
}

/**
 * Lê o fluxo até `limite` bytes. Passou do limite: cancela a leitura e devolve `null`.
 * O corte precisa ser pelo fluxo: `req.text()` lê tudo antes de qualquer conferência.
 */
async function lerAteOLimite(
  corpo: ReadableStream<Uint8Array> | null,
  limite: number,
): Promise<Uint8Array | null> {
  if (!corpo) return new Uint8Array(0);
  const leitor = corpo.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > limite) {
      await leitor.cancel().catch(() => undefined);
      return null;
    }
    partes.push(value);
  }
  const todo = new Uint8Array(total);
  let posicao = 0;
  for (const parte of partes) {
    todo.set(parte, posicao);
    posicao += parte.byteLength;
  }
  return todo;
}

/**
 * Código e mensagem de um erro, para o log. Nunca o texto do visitante nem o token: quem
 * chama não passa esses valores para cá, e a mensagem é cortada.
 */
export function descreverErro(erro: unknown): { codigo: string | null; mensagem: string } {
  const codigo = (erro as { code?: unknown } | null)?.code;
  return {
    codigo: typeof codigo === "string" ? codigo : null,
    mensagem: erro instanceof Error ? erro.message.slice(0, 300) : "erro desconhecido",
  };
}
