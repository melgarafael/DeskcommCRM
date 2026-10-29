import { once } from "node:events";
import { describe, expect, it } from "vitest";

import { iniciarFilhoDoTurno } from "../e2e/helpers/filho-do-turno-local";

async function terminouAte(promessa: Promise<unknown>, prazo: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promessa.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), prazo);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("turno isolado da prova: deadline e junção antes da limpeza", () => {
  it("encerra pelo prazo um filho parado, com streams fechados e PID ausente", async () => {
    const filho = iniciarFilhoDoTurno(
      ["-e", 'process.stdout.write("PARADO\\n"); process.kill(process.pid, "SIGSTOP");'],
      1500,
    );
    const fechado = once(filho.processo, "close");
    const resultado = filho.resultado.then(
      () => "ok",
      () => "erro",
    );
    try {
      if (!filho.processo.stdout) throw new Error("O filho não abriu stdout.");
      const [saida] = await once(filho.processo.stdout, "data");
      expect(String(saida)).toBe("PARADO\n");
      expect(await terminouAte(resultado, 3000)).toBe(true);
      expect(await resultado).toBe("erro");
      expect(filho.processo.signalCode).toBe("SIGKILL");
      expect(filho.processo.stdout.closed).toBe(true);
      const pid = filho.processo.pid;
      if (pid === undefined) throw new Error("O filho não recebeu PID.");
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    } finally {
      // Fallback restrito ao próprio filho também limpa uma sabotagem do helper.
      if (filho.processo.exitCode === null && filho.processo.signalCode === null)
        filho.processo.kill("SIGKILL");
      await fechado;
      await resultado;
    }
  });

  it("cleanup interrompe e junta o filho ativo antes do prazo dele", async () => {
    const filho = iniciarFilhoDoTurno(
      ["-e", 'process.stdout.write("ATIVO\\n"); setInterval(() => {}, 1000);'],
      30_000,
    );
    const fechado = once(filho.processo, "close");
    const resultado = filho.resultado.then(
      () => "ok",
      () => "erro",
    );
    try {
      if (!filho.processo.stdout) throw new Error("O filho não abriu stdout.");
      await once(filho.processo.stdout, "data");
      expect(await terminouAte(filho.encerrar(), 1000)).toBe(true);
      expect(filho.processo.signalCode).toBe("SIGKILL");
      expect(filho.processo.stdout.closed).toBe(true);
      const pid = filho.processo.pid;
      if (pid === undefined) throw new Error("O filho não recebeu PID.");
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
      expect(await resultado).toBe("erro");
    } finally {
      if (filho.processo.exitCode === null && filho.processo.signalCode === null)
        filho.processo.kill("SIGKILL");
      await fechado;
      await resultado;
    }
  });
});
