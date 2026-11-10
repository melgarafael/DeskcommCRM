// @vitest-environment node
/**
 * O PRAZO DO DESLIGAMENTO COMEÇA NO SINAL (#2823).
 *
 * ─── O defeito, medido pelo autor da issue ──────────────────────────────────
 *
 * O `shutdown` do worker fazia `await Promise.all([drainLoop, eventLogLoop, …])`
 * e `await workerLoop` ANTES de armar o `graceTimer`. O prazo só começava a
 * correr DEPOIS disso — e o que corria antes ficava por fora de qualquer prazo.
 * Numa parada ociosa sem PostgREST, o laço do `event_log` preso numa chamada de
 * rede levou a parada a 19,6 s; o `SHUTDOWN_GRACE_MS` (30 s) nunca foi
 * consultado sobre esses 19,6 s.
 *
 * E havia a segunda metade: nem `docker-compose.prod.yml` nem o
 * `hostgator-setup-kit/` declaravam `stop_grace_period`, então o Docker usava o
 * PADRÃO DE 10 s e mandava SIGKILL — abaixo dos 30 s do worker, matando o
 * contêiner no meio do drain.
 *
 * ─── O que este arquivo tranca ──────────────────────────────────────────────
 *
 *   1. o relógio arma no SINAL e cobre laços, `workerLoop`, drain e `pool.end()`
 *      (unidade do módulo + ensaio de PROCESSO com SIGTERM de verdade);
 *   2. o par de números fecha: o prazo do kit é maior que o interno.
 *
 * O ensaio de processo sobe um filho com o launcher do `Dockerfile.worker`
 * (`node --import tsx`, o mesmo do #2826) importando o MESMO módulo que a
 * produção usa: o número medido não é de um probe paralelo, é do código do PR.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { desligarNoPrazo } from "./desligamento-no-prazo";

const RAIZ = path.resolve(__dirname, "../..");
const MODULO = path.join(__dirname, "desligamento-no-prazo.ts");
const COMPOSE = path.join(RAIZ, "docker-compose.prod.yml");
const EXEMPLO_HOSTGATOR = path.join(RAIZ, ".env.hostgator.example");
const INSTALL_KIT = path.join(RAIZ, "hostgator-setup-kit/install.sh");
const ENV_DO_WORKER = path.join(RAIZ, "lib/agent-engine/env.ts");
const MAIN = path.join(__dirname, "main.ts");

const logMudo = { info: () => undefined, warn: () => undefined, error: () => undefined };

let pasta: string | null = null;
afterEach(() => {
  if (pasta) rmSync(pasta, { recursive: true, force: true });
  pasta = null;
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. O relógio cobre cada etapa que hoje ficava FORA dele
// ─────────────────────────────────────────────────────────────────────────────

/**
 * O prazo tem de cobrir as TRÊS coisas que a issue nomeia. Cada etapa é um caso
 * porque hoje cada uma delas ficava fora da contagem por um motivo diferente:
 * os laços e o `workerLoop` eram aguardados ANTES de o timer existir, e o
 * `pool.end()` era aguardado DEPOIS do `Promise.race` — nem o caminho de sucesso
 * o cobria.
 */
const ETAPAS = [
  { nome: "laço preso (o `event_log` numa chamada de rede)", pendurar: "lacos" },
  { nome: "workerLoop (claim iniciado que precisa terminar)", pendurar: "workerLoop" },
  { nome: "pool.end()", pendurar: "pool" },
] as const;

describe.each(ETAPAS)("o prazo cobre $nome", ({ pendurar }) => {
  it("o prazo VENCE e o desligamento fecha dentro dele — a etapa não fica por fora", async () => {
    const pendurado = new Promise<void>(() => undefined);
    const prazoMs = 300;
    const t0 = Date.now();
    const fim = await desligarNoPrazo({
      prazoMs,
      sinal: "SIGTERM",
      emVoo: () => 2,
      aoSinal: () => undefined,
      encerrar: async () => {
        await Promise.resolve(); // laços fecharam
        if (pendurar === "lacos") await pendurado;
        await Promise.resolve(); // workerLoop fechou
        if (pendurar === "workerLoop") await pendurado;
        await Promise.resolve(); // drain em voo fechou
        if (pendurar === "pool") await pendurado;
      },
      log: logMudo as never,
    });
    const decorrido = Date.now() - t0;

    expect(
      fim,
      "o desligamento não fechou no prazo: a etapa pendurada ficou FORA da contagem",
    ).toBe("prazo-estourado");
    expect(
      decorrido,
      `saiu em ${decorrido} ms com prazo de ${prazoMs} ms — o prazo não governou a etapa`,
    ).toBeGreaterThanOrEqual(prazoMs - 50);
    expect(
      decorrido,
      `levou ${decorrido} ms para um prazo de ${prazoMs} ms — quem cortou foi outra coisa`,
    ).toBeLessThan(prazoMs + 1_500);
  }, 15_000);
});

describe("o prazo é TETO, não piso (#2823)", () => {
  it("sem etapa pendurada, sai assim que o trabalho termina — não espera o prazo inteiro", async () => {
    const prazoMs = 5_000;
    const t0 = Date.now();
    const fim = await desligarNoPrazo({
      prazoMs,
      sinal: "SIGTERM",
      emVoo: () => 1,
      aoSinal: () => undefined,
      encerrar: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
      },
      log: logMudo as never,
    });
    const decorrido = Date.now() - t0;

    expect(fim).toBe("encerrado");
    expect(
      decorrido,
      `levou ${decorrido} ms: o prazo virou piso, e o docker stop paga a espera inteira`,
    ).toBeLessThan(1_000);
  }, 15_000);
});

describe("o relógio arma no sinal, não depois (#2823)", () => {
  it("o efeito síncrono do sinal já roda com o prazo correndo — `aoSinal` pode bloquear sem esticar o total", async () => {
    // `aoSinal` bloqueia 400 ms de forma SÍNCRONA (server.close() e afins podem
    // demorar). Se o timer fosse armado DEPOIS dele, o total medido seria
    // 400 ms + o prazo. Armado antes (abaixo de `aoSinal`), o prazo já venceu
    // quando o bloqueio termina — e o total fica no prazo, não na soma.
    const prazoMs = 250;
    const t0 = Date.now();
    const fim = await desligarNoPrazo({
      prazoMs,
      sinal: "SIGTERM",
      emVoo: () => 0,
      aoSinal: () => {
        const fimDoBloqueio = Date.now() + 400;
        while (Date.now() < fimDoBloqueio) {
          // bloqueio deliberado
        }
      },
      encerrar: async () => {
        await new Promise<void>(() => undefined);
      },
      log: logMudo as never,
    });
    const decorrido = Date.now() - t0;

    expect(fim).toBe("prazo-estourado");
    expect(
      decorrido,
      `levou ${decorrido} ms: o relógio armou DEPOIS do efeito do sinal (prazo de ${prazoMs} ms)`,
    ).toBeLessThan(prazoMs + 400);
  }, 15_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. O ensaio de PROCESSO — SIGTERM de verdade, tempo medido de ponta a ponta
// ─────────────────────────────────────────────────────────────────────────────

interface Ensaio {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** ms entre o SIGTERM e o exit — o número que a evidência da issue registra. */
  ms: number;
  saida: string;
}

/**
 * Sobe um filho com o launcher LIDO do `Dockerfile.worker` e o módulo REAL do
 * desligamento, espera o handshake e manda SIGTERM — como o `docker stop`.
 *
 * `ordemAtual = true` replica o comportamento de HOJE (o defeito): aguardar os
 * laços SEM prazo correndo. É contra esse desfecho que o conserto é comparado —
 * e, como não há prazo nenhum para vencer, quem mata o filho é o SIGKILL de
 * `limiteMs`, que é justamente o desfecho do `stop_grace_period` no Docker.
 */
async function ensaioDeSigterm(prazoMs: number, ordemAtual: boolean): Promise<Ensaio> {
  const cmd = readFileSync(path.join(RAIZ, "Dockerfile.worker"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("CMD "));
  if (!cmd) throw new Error("Dockerfile.worker sem linha CMD");
  const launcher = (JSON.parse(cmd.slice("CMD ".length)) as string[]).slice(0, -1);

  pasta = mkdtempSync(path.join(os.tmpdir(), "probe-prazo-2823-"));
  const probe = path.join(pasta, "probe.ts");
  writeFileSync(
    probe,
    `
import { desligarNoPrazo } from ${JSON.stringify(MODULO)};
const prazoMs = Number(process.argv[2]);
const ordemAtual = process.argv[3] === "hoje";
const log = {
  info: () => {},
  warn: () => {},
  // O decorrido sai por aqui: é o número MEDIDO pelo próprio módulo.
  error: (msg, fields) => process.stdout.write("medido " + msg + " " + JSON.stringify(fields) + "\\n"),
};
const lacoPreso = new Promise(() => {});
process.on("SIGTERM", () => {
  ${
    ordemAtual
      ? // O comportamento de HOJE: os laços são aguardados e NENHUM prazo corre.
        `void (async () => { await lacoPreso; process.exit(0); })();`
      : `void desligarNoPrazo({
    prazoMs,
    sinal: "SIGTERM",
    emVoo: () => 1,
    aoSinal: () => {},
    encerrar: async () => { await lacoPreso; },
    log,
  }).then((fim) => process.exit(fim === "prazo-estourado" ? 1 : 0));`
  }
});
process.stdout.write("pronto\\n");
setInterval(() => undefined, 1000);
`,
  );

  const filho = spawn(
    launcher[0]!,
    [...launcher.slice(1), probe, String(prazoMs), ordemAtual ? "hoje" : "atual"],
    // A tupla `as const` é o que faz o TypeScript escolher a sobrecarga de
    // `stdio` POR POSIÇÃO — sem ela, `stdout` sai possivelmente nulo e o
    // typecheck reprova o teste (mesmo que ele passe).
    { cwd: RAIZ, stdio: ["ignore", "pipe", "pipe"] as const },
  );
  let saida = "";
  filho.stdout.on("data", (d: Buffer) => {
    saida += d.toString();
  });
  filho.stderr.on("data", (d: Buffer) => {
    saida += d.toString();
  });

  await new Promise<void>((resolve, reject) => {
    const ver = (): void => {
      if (saida.includes("pronto")) resolve();
    };
    filho.stdout.on("data", ver);
    filho.once("error", reject);
    filho.once("exit", () => reject(new Error(`o probe morreu antes do handshake: ${saida}`)));
  });

  return new Promise<Ensaio>((resolve) => {
    const t0 = Date.now();
    // Quem observa é o "Docker": passado o limite, SIGKILL. Sem isto, o ensaio
    // do caso de HOJE nunca resolveria — que é exatamente o defeito.
    const assassino = setTimeout(() => filho.kill("SIGKILL"), prazoMs + 3_000);
    filho.once("exit", (code, signal) => {
      clearTimeout(assassino);
      resolve({ code, signal, ms: Date.now() - t0, saida });
    });
    filho.kill("SIGTERM");
  });
}

describe("ensaio: SIGTERM com laço preso (#2823)", () => {
  it("o conserto fecha o desligamento no prazo, com o tempo MEDIDO de SIGTERM ao exit", async () => {
    const prazoMs = 1_500;
    const ensaio = await ensaioDeSigterm(prazoMs, false);
    const medido = /"decorrido_ms":(\d+)/.exec(ensaio.saida)?.[1];

    // Evidência crua no log da lane — o número vai para evidencias-dk/2823.md.
    console.info(
      `[2823] SIGTERM→exit COM o conserto: ${ensaio.ms} ms ` +
        `(code=${ensaio.code}, decorrido_ms=${medido}, prazo=${prazoMs})`,
    );

    expect(ensaio.code, `saiu como ${ensaio.signal ?? ensaio.code}`).toBe(1);
    expect(
      ensaio.ms,
      `levou ${ensaio.ms} ms para um prazo de ${prazoMs} ms — o laço preso ficou FORA da contagem`,
    ).toBeLessThan(prazoMs + 2_500);
  }, 30_000);

  it("CONTROLE: com o prazo voltando a começar depois dos laços (hoje), o SIGTERM NÃO fecha no prazo", async () => {
    const prazoMs = 1_500;
    const ensaio = await ensaioDeSigterm(prazoMs, true);

    console.info(
      `[2823] SIGTERM→exit SEM o conserto (hoje): ${ensaio.ms} ms ` +
        `(code=${ensaio.code}, signal=${ensaio.signal}) — quem mata é o SIGKILL`,
    );

    expect(
      ensaio.ms,
      `o desligamento de HOJE fechou em ${ensaio.ms} ms — se isso aconteceu, o defeito não está reproduzido`,
    ).toBeGreaterThan(prazoMs + 2_000);
    expect(ensaio.code, "o processo não pôde escolher o próprio exit: foi morto").toBeNull();
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. O par de números do kit fecha (#2823)
// ─────────────────────────────────────────────────────────────────────────────

/** Segundos de `stop_grace_period` do serviço `worker` do compose de produção. */
function prazoDoKit(): { valor: string; segundos: number } {
  const linhas = readFileSync(COMPOSE, "utf8").split("\n");
  const inicio = linhas.findIndex((l) => /^ {2}worker:/.test(l));
  if (inicio < 0) throw new Error("docker-compose.prod.yml sem serviço `worker`");
  for (let i = inicio + 1; i < linhas.length; i++) {
    const linha = linhas[i]!;
    if (/^ {2}\S/.test(linha) && !/^ {4}/.test(linha)) break; // começou o próximo serviço
    const m = /^ {4}stop_grace_period:\s*(\S+)/.exec(linha);
    if (m) {
      // `${WORKER_STOP_GRACE_PERIOD:-40s}` → o default interessa: é o valor que
      // uma instalação sem o .env ajustado recebe.
      const comDefault = /\$\{[A-Z_0-9]+:-([^}]+)\}/.exec(m[1]!)?.[1] ?? m[1]!;
      const segundos = /^(\d+)s$/.exec(comDefault)?.[1];
      if (!segundos) throw new Error(`stop_grace_period ilegível: ${m[1]}`);
      return { valor: m[1]!, segundos: Number(segundos) };
    }
  }
  throw new Error(
    "o serviço `worker` do docker-compose.prod.yml não define `stop_grace_period` — " +
      "sem ele o Docker usa o padrão de 10 s e manda SIGKILL abaixo do prazo do worker",
  );
}

function valorDoEnv(caminho: string, chave: string): string {
  const m = new RegExp(`^${chave}=(.*)$`, "m").exec(readFileSync(caminho, "utf8"));
  if (!m) throw new Error(`${chave} ausente em ${caminho}`);
  return m[1]!.trim();
}

describe("o kit declara `stop_grace_period` coerente com o prazo interno (#2823)", () => {
  it("o compose define o prazo, e ele é MAIOR que o `SHUTDOWN_GRACE_MS` do worker", () => {
    const kit = prazoDoKit();
    const internoDoKit = Number(valorDoEnv(EXEMPLO_HOSTGATOR, "SHUTDOWN_GRACE_MS"));
    const bruto = /SHUTDOWN_GRACE_MS:[^,]*default\(([\d_]+)\)/.exec(readFileSync(ENV_DO_WORKER, "utf8"))?.[1];
    const defaultDoCodigo = Number(bruto?.replace(/_/g, ""));

    console.info(
      `[2823] stop_grace_period=${kit.valor} (${kit.segundos} s) · ` +
        `SHUTDOWN_GRACE_MS do kit=${internoDoKit} ms · default do worker=${defaultDoCodigo} ms`,
    );

    expect(
      kit.segundos,
      `o kit dá ${kit.segundos} s ao docker stop e o worker se dá ${internoDoKit} ms — o SIGKILL chega antes do drain`,
    ).toBeGreaterThan(internoDoKit / 1_000);
    // O número do kit e o default do CÓDIGO têm de fechar: um .env que só repete
    // o default do binário não pode divergir dele.
    expect(
      internoDoKit,
      "o `SHUTDOWN_GRACE_MS` que o kit grava divergiu do default do worker",
    ).toBe(defaultDoCodigo);
    expect(
      Number(valorDoEnv(EXEMPLO_HOSTGATOR, "WORKER_STOP_GRACE_PERIOD").replace(/s$/, "")),
      "o par do .env do kit não fecha",
    ).toBe(kit.segundos);
  });

  it("o install.sh GRAVA os dois números — chave que ele não escreve se perde no próximo install", () => {
    const install = readFileSync(INSTALL_KIT, "utf8");
    expect(install).toMatch(/envq WORKER_STOP_GRACE_PERIOD /);
    expect(install).toMatch(/envq SHUTDOWN_GRACE_MS /);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. A LIGAÇÃO no main.ts — o relógio arma ANTES de qualquer await
// ─────────────────────────────────────────────────────────────────────────────

describe("main.ts liga o prazo no sinal (#2823)", () => {
  /** O corpo do `shutdown`, do `const shutdown = async` até o `};` que o fecha. */
  function corpoDoShutdown(): string {
    const linhas = readFileSync(MAIN, "utf8").split("\n");
    const inicio = linhas.findIndex((l) => /const shutdown = async/.test(l));
    if (inicio < 0) throw new Error("main.ts sem `const shutdown = async`");
    const fim = linhas.findIndex((l, i) => i > inicio && /^ {2}\};$/.test(l));
    return linhas.slice(inicio, fim + 1).join("\n");
  }

  it("não há `await` entre o sinal e a chamada que arma o prazo", () => {
    const corpo = corpoDoShutdown();
    const chamada = corpo.indexOf("desligarNoPrazo(");
    expect(chamada, "o shutdown não usa o módulo do prazo").toBeGreaterThan(-1);
    // A PARTIR do começo da LINHA da chamada: o `await` que está na própria
    // linha (`const fim = await desligarNoPrazo({`) é o que arma o prazo, e não
    // vale como "esperou antes". Comentário também não é código: o `await`
    // citado num comentário explicativo não pode acusar o inocente.
    const antes = corpo
      .slice(0, corpo.lastIndexOf("\n", chamada))
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(
      /\bawait\b/.test(antes),
      `o shutdown aguarda algo ANTES de o prazo existir — é exatamente o defeito da issue:\n${antes}`,
    ).toBe(false);
  });

  it("os laços, o `workerLoop`, o drain e o `pool.end()` estão DENTRO do prazo", () => {
    const corpo = corpoDoShutdown();
    const encerrar = corpo.slice(corpo.indexOf("encerrar:"));
    for (const etapa of ["Promise.all([", "await workerLoop", "[...inFlight]", "pool.end()"]) {
      expect(encerrar, `${etapa} fora do que o prazo cobre`).toContain(etapa);
    }
  });
});
