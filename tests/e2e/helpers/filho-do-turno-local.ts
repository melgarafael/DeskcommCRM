import { execFile } from "node:child_process";

const LIMITE_DO_STDERR = 2000;

/**
 * Sem isto a falha no CI só dizia "falhou", e a causa (que o filho escreve no
 * stderr) morria com o processo. Corta pelo FIM (a mensagem final do filho fica
 * por último) e redige o que tem forma de credencial antes de ir ao log público.
 */
export function diagnosticoDoFilho(
  erro: { code?: unknown; signal?: unknown; killed?: unknown },
  stderr: string,
): string {
  const redigido = stderr
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s@]+@/gi, "<url-com-senha>@")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<jwt>")
    .replace(/\b(sk|tok|rk|pk)[-_][\w-]{8,}/gi, "<chave>")
    .trim();
  const cauda = redigido.length > LIMITE_DO_STDERR ? `…${redigido.slice(-LIMITE_DO_STDERR)}` : redigido;
  const saida = `código=${String(erro.code ?? "?")} sinal=${String(erro.signal ?? "nenhum")} morto_pelo_prazo=${erro.killed === true}`;
  return `${saida} stderr=${cauda || "(vazio)"}`;
}

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
    (erro, _stdout, stderr) => {
      if (erro) rejeitar(new Error(`O filho do turno falhou ou excedeu o prazo. ${diagnosticoDoFilho(erro, String(stderr))}`));
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
