/**
 * O DUBLÊ DO JEV OBEDECE A `DUBLE_JEV_RESPOSTAS` — e só nas perguntas que ele nomeia.
 *
 * A spec do CI prova discordância e cascata forçando a resposta de UMA pergunta
 * (`scripts/duble-jev-e2e.mjs`). Se o mapa fosse ignorado, a spec provaria o
 * padrão achando que provou a discordância; se ele vazasse para as outras
 * perguntas, a de controle mudaria junto. Mapa ilegível derruba o dublê na
 * subida, em vez de seguir com o padrão em silêncio.
 *
 * Processo de verdade, como na spec: o dublê é um servidor, e importá-lo aqui
 * o subiria dentro do vitest.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts/duble-jev-e2e.mjs");
const CHAVE = "apikey_teste_do_duble_0123456789abcdef";

let vivo: ChildProcess | null = null;
let pasta: string | null = null;

afterEach(() => {
  vivo?.kill("SIGTERM");
  vivo = null;
  if (pasta) rmSync(pasta, { recursive: true, force: true });
  pasta = null;
});

async function portaLivre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const endereco = s.address();
      s.close(() => (typeof endereco === "object" && endereco ? resolve(endereco.port) : reject(new Error("sem porta"))));
    });
  });
}

function ambiente(porta: number, extra: Record<string, string>): NodeJS.ProcessEnv {
  pasta = mkdtempSync(path.join(os.tmpdir(), "duble-jev-"));
  return {
    ...process.env,
    DUBLE_JEV_PORTA: String(porta),
    DUBLE_JEV_HOST: "127.0.0.1",
    DUBLE_JEV_CHAVE: CHAVE,
    DUBLE_JEV_ARQUIVO: path.join(pasta, "chamadas.json"),
    ...extra,
  };
}

async function subir(extra: Record<string, string>): Promise<string> {
  const porta = await portaLivre();
  vivo = spawn(process.execPath, [SCRIPT], { env: ambiente(porta, extra), stdio: "ignore" });
  const base = `http://127.0.0.1:${porta}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/__duble/saude`)).ok) return base;
    } catch {
      // ainda subindo
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("o dublê não subiu");
}

async function perguntar(base: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/v1/systemone`, {
    method: "POST",
    headers: { authorization: `Bearer ${CHAVE}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-1.13.0",
      state: "quero cancelar",
      questions: {
        clima: { type: "score", criteria: ["a", "b", "c", "d", "e"] },
        manipulacao: { type: "choice", criteria: { none: "nada", high: "tentou" } },
      },
    }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { answers: Record<string, unknown> }).answers;
}

describe("dublê do Jev: DUBLE_JEV_RESPOSTAS", () => {
  it("sem o mapa, o padrão de sempre (controle)", async () => {
    const respostas = await perguntar(await subir({}));
    expect(respostas.manipulacao).toMatchObject({ type: "choice", choice: "none" });
    expect(respostas.clima).toMatchObject({ type: "score", score: 3 });
  });

  it("a pergunta nomeada recebe a resposta forçada; a outra segue o padrão", async () => {
    const forcada = { type: "choice", choice: "high", confidence: 0.8, probabilities: { none: 0.2, high: 0.8 } };
    const respostas = await perguntar(await subir({ DUBLE_JEV_RESPOSTAS: JSON.stringify({ manipulacao: forcada }) }));
    expect(respostas.manipulacao).toEqual(forcada);
    expect(respostas.clima).toMatchObject({ type: "score", score: 3 });
  });

  it.each([["não é JSON", "{manipulacao"], ["é uma lista", "[]"], ["é um número", "7"]])(
    "mapa ilegível (%s) derruba o dublê na subida",
    async (_caso, valor) => {
      const porta = await portaLivre();
      const r = spawnSync(process.execPath, [SCRIPT], {
        env: ambiente(porta, { DUBLE_JEV_RESPOSTAS: valor }),
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("DUBLE_JEV_RESPOSTAS");
    },
  );
});
