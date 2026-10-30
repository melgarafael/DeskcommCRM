import { once } from "node:events";
import { describe, expect, it } from "vitest";

import { iniciarFilhoDoPacote } from "../e2e/helpers/filho-do-pacote-lgpd";

describe("runner do pacote manual: somente filho próprio, unido antes da limpeza", () => {
  it("o deadline encerra até um filho parado e só devolve após fechar seus streams", async () => {
    const filho = iniciarFilhoDoPacote(
      ["-e", 'process.stdout.write("PARADO\\n"); process.kill(process.pid, "SIGSTOP");'],
      1500,
    );
    const falha = expect(filho.resultado).rejects.toThrow("excedeu o prazo");
    try {
      if (!filho.processo.stdout) throw new Error("O filho não abriu stdout.");
      const [saida] = await once(filho.processo.stdout, "data");
      expect(String(saida)).toBe("PARADO\n");
      await falha;
    } finally {
      await filho.encerrar();
    }
    expect(filho.processo.signalCode).toBe("SIGKILL");
    expect(filho.processo.stdout?.closed).toBe(true);
    const pid = filho.processo.pid;
    if (pid === undefined) throw new Error("O filho não recebeu PID.");
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });

  it("a limpeza também encerra e junta um filho ativo antes de seu deadline", async () => {
    const filho = iniciarFilhoDoPacote(
      ["-e", 'process.stdout.write("ATIVO\\n"); setInterval(() => {}, 1000);'],
      30_000,
    );
    const falha = expect(filho.resultado).rejects.toThrow("filho do pacote");
    try {
      if (!filho.processo.stdout) throw new Error("O filho não abriu stdout.");
      await once(filho.processo.stdout, "data");
    } finally {
      await filho.encerrar();
    }
    await falha;
    expect(filho.processo.signalCode).toBe("SIGKILL");
    const pid = filho.processo.pid;
    if (pid === undefined) throw new Error("O filho não recebeu PID.");
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });
});
