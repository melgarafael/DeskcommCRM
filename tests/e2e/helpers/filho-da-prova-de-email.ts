import { execFile, type ChildProcess } from "node:child_process";

const ativos = new Map<ChildProcess, Promise<void>>();

/** Também cobre encerramento do caso pelo Playwright antes do prazo do runner. */
export async function encerrarFilhosDaProvaDeEmail(): Promise<void> {
  const atuais = [...ativos];
  for (const [child] of atuais) child.kill("SIGKILL");
  await Promise.all(atuais.map(([, closed]) => closed));
}

/** Callback de execFile só ocorre após fechar o filho: não há Promise.race que o abandone. */
export async function executarFilhoDaProvaDeEmail(
  args: string[],
  input: Record<string, unknown>,
  prazoMs = 20_000,
): Promise<{ result: Record<string, unknown>; pid: number; closed_before_cleanup: true }> {
  return new Promise((resolve, reject) => {
    let closed!: () => void;
    const fim = new Promise<void>((resolveClosed) => {
      closed = resolveClosed;
    });
    // node --import tsx executa o runner no próprio PID, sem o launcher da CLI.
    const child = execFile(
      process.execPath,
      args,
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: prazoMs,
        killSignal: "SIGKILL",
        maxBuffer: 128 * 1_024,
      },
      (error, stdout) => {
        ativos.delete(child);
        closed();
        if (error) {
          // Não incluir error.message, stderr, stdout, credenciais ou dados de transporte.
          const failure = new Error(
            "O filho próprio da prova de e-mail falhou e já foi encerrado.",
          );
          Object.assign(failure, { pid: child.pid, closed_before_cleanup: true });
          reject(failure);
          return;
        }
        try {
          if (!child.pid) throw new Error();
          const line = stdout.trim().split("\n").at(-1) ?? "";
          const result = JSON.parse(line) as Record<string, unknown>;
          if (result === null || typeof result !== "object" || Array.isArray(result))
            throw new Error();
          resolve({ result, pid: child.pid, closed_before_cleanup: true });
        } catch {
          reject(new Error("O filho encerrado não devolveu um recibo JSON válido."));
        }
      },
    );
    ativos.set(child, fim);
    child.stdin?.on("error", () => {
      /* EPIPE é comunicado pelo callback de fechamento. */
    });
    child.stdin?.end(JSON.stringify(input));
  });
}
