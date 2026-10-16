// @vitest-environment node
/**
 * O #2823 na camada de PROCESSO: o `CMD` do `Dockerfile.worker` decide quem é o
 * PID 1 do container, e o PID 1 é o único que recebe o SIGTERM do `docker stop`.
 *
 * Medido neste repo (pnpm 9.15.9 — a mesma versão fixada no Dockerfile — e node
 * v22.23.1) com um probe que só grava o "recibo" DEPOIS de drenar 6 s, mandando
 * o SIGTERM para o launcher LIDO DO PRÓPRIO Dockerfile:
 *
 *   ["pnpm","exec","tsx"]        → o PID 1 mora em 0,02 s com sinal 15; o filho
 *                                  fica órfão e o recibo só sai 6 s depois,
 *                                  quando o container já foi encerrado junto
 *                                  com o PID 1.
 *   ["node","--import","tsx"]    → drena os 6 s, sai com 0 e o recibo está
 *                                  gravado no instante em que o processo sai.
 *
 * Por isso os dois casos aqui leem o CMD do arquivo em vez de fixar o launcher
 * na mão: revertendo o CMD, os dois caem juntos.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const RAIZ = path.resolve(__dirname, "../..");
const DOCKERFILE = path.join(RAIZ, "Dockerfile.worker");

/** O CMD na forma de exec (array JSON), como o Docker Runtime o executa. */
function cmdDoWorker(): string[] {
  const linha = readFileSync(DOCKERFILE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("CMD "));
  if (!linha) throw new Error("Dockerfile.worker sem linha CMD");
  return JSON.parse(linha.slice("CMD ".length)) as string[];
}

/**
 * O envio em voo: instala o handler de SIGTERM, anuncia "pronto" e só grava o
 * recibo 6 s depois — o mesmo formato de prazo que a drenagem do worker tem
 * (SHUTDOWN_GRACE_MS default: 30 s; o ensaio da issue reteve o envio por 8 s).
 */
const PROBE = `
import { writeFileSync } from "node:fs";
const inicio = Date.now();
process.on("SIGTERM", () => {
  process.stdout.write("drenando\\n");
  setTimeout(() => {
    writeFileSync(process.env.PROBE_RECEIPT as string, JSON.stringify({ ms: Date.now() - inicio }));
    process.exit(0);
  }, 6000);
});
process.stdout.write("pronto\\n");
setInterval(() => undefined, 1000);
`;

let pasta: string | null = null;

afterEach(() => {
  if (pasta) rmSync(pasta, { recursive: true, force: true });
  pasta = null;
});

interface Ensaio {
  code: number | null;
  signal: NodeJS.Signals | null;
  ms: number;
  recibo: boolean;
}

/** Sobe o launcher do CMD, espera o handshake e manda SIGTERM nele — como o `docker stop`. */
async function sigtermComEnvioEmVoo(): Promise<Ensaio> {
  const cmd = cmdDoWorker();
  const launcher = cmd.slice(0, -1); // tudo menos o entrypoint: é a camada que vira PID 1
  pasta = mkdtempSync(path.join(os.tmpdir(), "probe-2823-"));
  const probe = path.join(pasta, "envio-em-voo.ts");
  const recibo = path.join(pasta, "recibo.json");
  writeFileSync(probe, PROBE);

  const filho = spawn(launcher[0]!, [...launcher.slice(1), probe], {
    cwd: RAIZ,
    env: { ...process.env, PROBE_RECEIPT: recibo },
    stdio: ["ignore", "pipe", "pipe"],
  });
  filho.stderr?.resume(); // órfão do sabotagem cospe erro ao escrever recibo em pasta apagada

  await new Promise<void>((resolve, reject) => {
    let buf = "";
    filho.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      if (buf.includes("pronto")) resolve();
    });
    filho.once("error", reject);
    filho.once("exit", () => reject(new Error(`o probe morreu antes do handshake: ${buf}`)));
  });

  return new Promise<Ensaio>((resolve) => {
    const t0 = Date.now();
    filho.once("exit", (code, signal) => {
      resolve({ code, signal, ms: Date.now() - t0, recibo: existsSync(recibo) });
    });
    filho.kill("SIGTERM");
  });
}

describe("o PID 1 do worker drena o envio em voo (#2823)", () => {
  it("o CMD é node --import tsx — sem pnpm/execa entre o supervisor e o worker", () => {
    // A regressão central da issue: uma camada de processo entre quem recebe o
    // sinal e quem tem de terminar o envio. Fixar a forma exata também pega um
    // "conserto" que troque o CMD por outro launcher com a mesma camada.
    expect(cmdDoWorker()).toEqual(["node", "--import", "tsx", "workers/agent-worker/main.ts"]);
  });

  it(
    "SIGTERM com envio em voo: o PID 1 termina a drenagem, sai 0 e o recibo está gravado",
    async () => {
      const ensaio = await sigtermComEnvioEmVoo();
      expect(
        ensaio.code,
        `o PID 1 saiu como ${ensaio.signal ?? ensaio.code} depois de ${ensaio.ms} ms`,
      ).toBe(0);
      expect(
        ensaio.ms,
        "o PID 1 morreu antes da drenagem terminar — o envio em voo perde o dono",
      ).toBeGreaterThanOrEqual(5_500);
      expect(
        ensaio.recibo,
        "no instante em que o PID 1 sai, o recibo já tem de estar no disco",
      ).toBe(true);
    },
    30_000,
  );
});
