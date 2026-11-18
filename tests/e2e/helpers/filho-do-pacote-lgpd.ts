import { execFile } from "node:child_process";

/** Só o filho criado aqui é encerrado; o chamador junta-o antes de limpar fixtures. */
export function iniciarFilhoDoPacote(args: string[], prazoMs: number) {
  if (!Number.isSafeInteger(prazoMs) || prazoMs <= 0)
    throw new Error("O filho do pacote exige um prazo positivo.");
  let fechar!: () => void;
  const fechado = new Promise<void>((resolve) => {
    fechar = resolve;
  });
  let resolver!: (stdout: string) => void;
  let rejeitar!: (erro: Error) => void;
  const resultado = new Promise<string>((resolve, reject) => {
    resolver = resolve;
    rejeitar = reject;
  });
  const processo = execFile(
    process.execPath,
    args,
    {
      env: { ...process.env },
      timeout: prazoMs,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    },
    (erro, stdout) => {
      // Erro de execFile inclui stdout/stderr; não propaga esse conteúdo.
      if (erro) rejeitar(new Error("O filho do pacote falhou ou excedeu o prazo."));
      else resolver(stdout);
    },
  );
  processo.once("close", fechar);
  const encerrar = async () => {
    if (processo.pid !== undefined && processo.exitCode === null && processo.signalCode === null)
      processo.kill("SIGKILL");
    await fechado;
  };
  return { processo, resultado, encerrar };
}
