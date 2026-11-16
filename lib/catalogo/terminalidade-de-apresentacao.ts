import type { ToolSet } from "ai";

/** Uma seleção recusada no preflight devolve o turno ao modelo. */
export function apresentacaoEncerraTurno(result: unknown): boolean {
  return !(
    typeof result === "object" &&
    result !== null &&
    "ok" in result &&
    result.ok === false &&
    (!("code" in result) || result.code !== "catalog_presentation_agent_paused")
  );
}

/**
 * O SDK pode executar várias tools do mesmo passo em paralelo. Serializar as
 * execuções preserva a ordem em que ele as iniciou e impede qualquer efeito
 * de uma chamada irmã depois que a apresentação assume o turno.
 */
export function terminalizarApresentacaoNoTurno(
  tools: ToolSet,
  name: string,
  activated: () => void,
  terminalOnResult: (result: unknown) => boolean = () => true,
): ToolSet {
  let tail: Promise<unknown> = Promise.resolve();
  let terminal = false;
  return Object.fromEntries(
    Object.entries(tools).map(([toolName, definition]) => {
      if (typeof definition.execute !== "function") return [toolName, definition];
      const execute = definition.execute.bind(definition);
      return [
        toolName,
        {
          ...definition,
          execute: (input: never, options: never) => {
            const run = tail.then(async () => {
              if (terminal) {
                return {
                  ok: false,
                  error: { code: "catalog_presentation_terminal", message: "O turno terminou." },
                };
              }
              if (toolName === name) {
                try {
                  const result = await execute(input, options);
                  if (terminalOnResult(result)) {
                    terminal = true;
                    activated();
                  }
                  return result;
                } catch (error) {
                  // Depois de uma falha inesperada, o estado do envio pode ser
                  // incerto. O retry do job e o ledger preservam a idempotência.
                  terminal = true;
                  activated();
                  throw error;
                }
              }
              return execute(input, options);
            });
            tail = run.catch(() => undefined);
            return run;
          },
        },
      ];
    }),
  );
}
