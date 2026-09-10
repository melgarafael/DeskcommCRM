/**
 * Leitura do SSE do backend do Codex (compartilhada).
 *
 * O backend responde SEMPRE em SSE (`text/event-stream`), mesmo para quem
 * pediu sem streaming: o evento terminal (`response.completed`/`incomplete`/
 * `failed`) carrega o Response inteiro. Quem precisa de JSON (doGenerate) ou
 * do objeto (modelo-responses) lê daqui.
 */
export async function lerRespostaSSE(sse: Response): Promise<unknown> {
  const leitor = sse.body!.getReader();
  const decodificador = new TextDecoder();
  let buffer = "";
  let carga: unknown = null;
  try {
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      buffer += decodificador.decode(value, { stream: true });
      const linhas = buffer.split("\n");
      buffer = linhas.pop() ?? "";
      for (const linha of linhas) {
        if (!linha.startsWith("data: ")) continue;
        const dado = linha.slice(6);
        if (dado === "[DONE]") continue;
        try {
          const evt = JSON.parse(dado) as Record<string, unknown>;
          const tipo = evt["type"];
          if (tipo === "response.completed" || tipo === "response.incomplete" || tipo === "response.failed") {
            carga = evt["response"];
          }
        } catch {
          // Chunk malformado: ignora.
        }
      }
    }
  } finally {
    leitor.releaseLock();
  }
  return carga;
}
