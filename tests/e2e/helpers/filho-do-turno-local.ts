import { execFile } from "node:child_process";

/** Processo exclusivo da prova; o chamador encerra e junta antes do cleanup. */
export function iniciarFilhoDoTurno(
  args: string[],
  prazoMs: number,
  ambiente: { E2E_TURNO_DB_URL?: string } = {},
) {
  if (!Number.isSafeInteger(prazoMs) || prazoMs <= 0)
    throw new Error("A preparação do turno exige um prazo positivo.");
  let fechar!: () => void;
  const fechado = new Promise<void>((resolve) => {
    fechar = resolve;
  });
  let resolver!: () => void;
  let rejeitar!: (erro: Error) => void;
  const resultado = new Promise<void>((resolve, reject) => {
    resolver = resolve;
    rejeitar = reject;
  });
  const processo = execFile(
    process.execPath,
    args,
    {
      env: { ...process.env, ...ambiente },
      timeout: prazoMs,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    },
    (erro) => {
      // O erro de execFile contém stdout/stderr; a borda da prova é técnica.
      if (erro) rejeitar(new Error("O filho do turno falhou ou excedeu o prazo."));
      else resolver();
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
